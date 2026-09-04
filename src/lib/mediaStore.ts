// ===========================================================================
// 媒体存储抽象：本地磁盘（默认）或 Cloudflare R2（S3 兼容，环境变量切换）
//
// 本地布局（uploads/<seasonId>/ 下）：
//   原文件   uploads/<seasonId>/<storedName>
//   HLS 产物 uploads/<seasonId>/hls/<storedName>/index.m3u8 + seg_*.ts
// R2（bucket 内 key）：
//   HLS 产物 media/<seasonId>/<storedName>/index.m3u8 + seg_*.ts
// 说明：转码成功即删除原文件（HLS 播放已足够）；R2 模式仅存 HLS。
// ===========================================================================
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../env.js';
import { removeDirIfExists } from './ffmpeg.js';
import type { SubFile, TranscodeState } from '../types.js';

export function r2Enabled(): boolean {
  return (
    env.storage === 'r2' &&
    !!env.r2.endpoint &&
    !!env.r2.accessKeyId &&
    !!env.r2.secretAccessKey &&
    !!env.r2.bucket
  );
}

export function mediaStorageName(): 'local' | 'r2' {
  return r2Enabled() ? 'r2' : 'local';
}

// ---------------------------------------------------------------------------
// 本地路径工具
// ---------------------------------------------------------------------------
export function originalPath(seasonId: number, storedName: string): string {
  return join(env.uploadDir, String(seasonId), storedName);
}
export function hlsLocalDir(seasonId: number, storedName: string): string {
  return join(env.uploadDir, String(seasonId), 'hls', storedName);
}
export function hlsPlaylistPath(seasonId: number, storedName: string): string {
  return join(hlsLocalDir(seasonId, storedName), 'index.m3u8');
}
export function hlsLocalExists(seasonId: number, storedName: string): boolean {
  return existsSync(hlsPlaylistPath(seasonId, storedName));
}
export function hlsSegmentPath(seasonId: number, storedName: string, segName: string): string {
  return join(hlsLocalDir(seasonId, storedName), segName);
}
/** HLS 产物总字节（本地目录内 index.m3u8 + 全部段） */
export function hlsLocalBytes(seasonId: number, storedName: string): number {
  const dir = hlsLocalDir(seasonId, storedName);
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const f of readdirSync(dir)) {
    try {
      const p = join(dir, f);
      if (!existsSync(p)) continue;
      total += statSync(p).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// R2（S3 兼容）客户端（懒加载）
// ---------------------------------------------------------------------------
type S3 = import('@aws-sdk/client-s3').S3Client;
let s3: S3 | null = null;

async function getS3(): Promise<S3> {
  if (s3) return s3;
  const { S3Client } = await import('@aws-sdk/client-s3');
  s3 = new S3Client({
    region: 'auto',
    endpoint: env.r2.endpoint,
    credentials: {
      accessKeyId: env.r2.accessKeyId,
      secretAccessKey: env.r2.secretAccessKey,
    },
  });
  return s3;
}

function r2Key(seasonId: number, storedName: string, file: string): string {
  return `media/${seasonId}/${storedName}/${file}`;
}

async function r2List(prefix: string): Promise<string[]> {
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const client = await getS3();
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const out = await client.send(
      new ListObjectsV2Command({
        Bucket: env.r2.bucket,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function r2Get(key: string): Promise<Buffer | null> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3();
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: env.r2.bucket, Key: key }));
    return Buffer.from(await out.Body!.transformToByteArray());
  } catch (e: any) {
    if (e?.name === 'NoSuchKey') return null;
    throw e;
  }
}

async function r2Put(key: string, body: Buffer): Promise<void> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3();
  await client.send(
    new PutObjectCommand({ Bucket: env.r2.bucket, Key: key, Body: body })
  );
}

async function r2DeleteKeys(keys: string[]): Promise<void> {
  if (!keys.length) return;
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3();
  for (const key of keys) {
    await client.send(new DeleteObjectCommand({ Bucket: env.r2.bucket, Key: key }));
  }
}

// ---------------------------------------------------------------------------
// 统一接口
// ---------------------------------------------------------------------------

/** HLS playlist（index.m3u8）内容；不存在返回 null */
export async function readHlsPlaylist(
  seasonId: number,
  storedName: string
): Promise<Buffer | null> {
  if (r2Enabled()) return r2Get(r2Key(seasonId, storedName, 'index.m3u8'));
  const p = hlsPlaylistPath(seasonId, storedName);
  return existsSync(p) ? readFileSync(p) : null;
}

/** HLS 段文件内容（段名已由调用方白名单校验）；不存在返回 null */
export async function readHlsSegment(
  seasonId: number,
  storedName: string,
  segName: string
): Promise<Buffer | null> {
  if (r2Enabled()) return r2Get(r2Key(seasonId, storedName, segName));
  const p = hlsSegmentPath(seasonId, storedName, segName);
  return existsSync(p) ? readFileSync(p) : null;
}

/**
 * 将已生成的本地 HLS 目录推送到 R2（R2 模式下调用）；
 * 返回推送到远端前的本地总字节。
 */
export async function pushHlsToR2(seasonId: number, storedName: string): Promise<void> {
  if (!r2Enabled()) return;
  const dir = hlsLocalDir(seasonId, storedName);
  if (!existsSync(dir)) throw new Error('HLS 目录不存在，无法推送 R2');
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    await r2Put(r2Key(seasonId, storedName, f), readFileSync(p));
  }
}

/** HLS 总字节（local 统计本地；r2 无法在不通读时精确统计 → 0 占位，播放端不依赖） */
export function hlsBytes(seasonId: number, storedName: string): number {
  if (r2Enabled()) return 0;
  return hlsLocalBytes(seasonId, storedName);
}

/**
 * 彻底删除某个视频的全部存储：
 * 本地（原文件 + HLS 目录）与 R2（media/<season>/<name>/ 前缀）都会清理。
 */
export async function deleteMediaAll(seasonId: number, storedName: string): Promise<void> {
  const orig = originalPath(seasonId, storedName);
  try {
    if (existsSync(orig)) {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(orig);
    }
  } catch {
    /* ignore */
  }
  removeDirIfExists(hlsLocalDir(seasonId, storedName));
  if (r2Enabled()) {
    const prefix = `media/${seasonId}/${storedName}/`;
    const keys = await r2List(prefix);
    await r2DeleteKeys(keys);
  }
}

/** 原文件是否仍存在于本地（转码完成后即删除；用于失败回退判断） */
export function originalExists(seasonId: number, storedName: string): boolean {
  return existsSync(originalPath(seasonId, storedName));
}

// 供调用方展示与判断
export function transcodeStatusOf(f: SubFile): TranscodeState {
  const s = f?.transcode;
  if (s === 'pending' || s === 'processing' || s === 'done' || s === 'failed') return s;
  return 'off'; // 旧数据 / 截图：视为原文件模式
}
