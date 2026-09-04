// ===========================================================================
// FFmpeg 转码：上传的原视频压制（AV1/H.265/H.264 + CRF）并切片为 HLS
//
// 模式（env.TRANSCODE_ENABLED）：
//   auto —— 启动时探测 ffmpeg；探测不到则整个系统退避为「原文件直传」模式
//   on   —— 强制开启（命令缺失时转码任务记 failed，播放回退原文件）
//   off  —— 关闭压制（永不转码）
// 编码器（env.TRANSCODE_ENCODER）：libx265 / libsvtav1 / libx264
//   优先使用配置值；若 ffmpeg 不支持则按 [配置值, libx265, libx264] 回退。
// ===========================================================================
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../env.js';

let ffmpegOk: boolean | null = null;
let encodersCache: string[] | null = null;

function probeBin(cmd: string): boolean {
  try {
    const r = spawnSync(cmd, ['-version'], { stdio: 'ignore', timeout: 15_000 });
    return r.status === 0 && !r.error;
  } catch {
    return false;
  }
}

/** ffmpeg 是否可用（TRANSCODE_ENABLED=off 恒为 false） */
export function ffmpegAvailable(): boolean {
  if (env.transcodeEnabled === 'off') return false;
  if (ffmpegOk !== null) return ffmpegOk;
  const ok =
    env.transcodeEnabled === 'on' ||
    (probeBin(env.ffmpegPath) && probeBin(env.ffprobePath));
  ffmpegOk = ok;
  if (ok) {
    console.log(
      `[media] ffmpeg 可用（encoder=${pickEncoder()} crf=${env.transcodeCrf} preset=${env.transcodePreset}）`
    );
  } else {
    console.log('[media] 未检测到 ffmpeg → 保持原文件直传模式（如需压制请安装 ffmpeg）');
  }
  return ok;
}

/** 读取 ffmpeg 支持的编码器名列表（缓存在内存） */
function supportedEncoders(): string[] {
  if (encodersCache !== null) return encodersCache;
  try {
    const r = spawnSync(env.ffmpegPath, ['-encoders'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 });
    const out = String(r.stdout ?? '');
    encodersCache = out
      .split('\n')
      .map((l) => /\s([A-Za-z0-9_]+)\s/.exec(l)?.[1])
      .filter((x): x is string => !!x);
  } catch {
    encodersCache = [];
  }
  return encodersCache;
}

/** 选定实际使用的编码器 */
export function pickEncoder(): string {
  const supported = new Set(supportedEncoders());
  const wanted = env.transcodeEncoder === 'off' ? '' : env.transcodeEncoder;
  const chain = [wanted, 'libx265', 'libx264'].filter(Boolean) as string[];
  for (const c of chain) if (supported.has(c)) return c;
  return 'libx264'; // 最后兜底：即使探测列表为空也交给 ffmpeg 自己报错
}

/** 用 ffmpeg 把一段视频压制并切片为 HLS；成功后 outDir 内含 index.m3u8 + seg_*.ts */
export function transcodeToHls(input: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(outDir, { recursive: true });
    const segPat = join(outDir, 'seg_%05d.ts');
    const playlist = join(outDir, 'index.m3u8');
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-i', input,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-sn', '-dn',
      '-c:v', pickEncoder(),
      '-preset', env.transcodePreset,
      '-crf', String(env.transcodeCrf),
      '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
      '-hls_time', String(env.hlsSegmentSeconds),
      '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', segPat,
      playlist,
    ];
    const child = spawn(env.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errBuf = '';
    child.stderr?.on('data', (d) => {
      errBuf = (errBuf + String(d)).slice(-4000);
    });
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 40 * 60 * 1000); // 单个文件最长压制 40 分钟
    child.on('error', (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}: ${errBuf.trim().slice(0, 800)}`));
    });
  });
}

/** 删除转码产物目录（递归、仅用于 uploads 下生成的目录） */
export function removeDirIfExists(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
