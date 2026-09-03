import {
  mkdirSync,
  existsSync,
  statSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { env } from '../env.js';

const ALLOWED_EXT = [
  '.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.flv', '.wmv', '.ts', '.mpg', '.mpeg',
];

export function sanitizeExt(originalName: string): string {
  const ext = extname(originalName).toLowerCase();
  return ALLOWED_EXT.includes(ext) ? ext : '.mp4';
}

/** 生成新存储文件名（不落盘） */
export function genStoredName(originalName: string): string {
  return `${Date.now()}-${randomBytes(6).toString('hex')}${sanitizeExt(originalName)}`;
}

/** 实际存储路径 */
export function videoPath(seasonId: number, storedName: string): string {
  return join(env.uploadDir, String(seasonId), storedName);
}

export function ensureUploadDir(seasonId: number): string {
  const dir = join(env.uploadDir, String(seasonId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeVideoFile(seasonId: number, storedName: string, data: Uint8Array): void {
  const dir = ensureUploadDir(seasonId);
  writeFileSync(join(dir, storedName), data);
}

export function readVideoBuffer(seasonId: number, storedName: string): Buffer | null {
  const p = videoPath(seasonId, storedName);
  if (!existsSync(p)) return null;
  return readFileSync(p);
}

export function videoExists(seasonId: number, storedName: string): boolean {
  return existsSync(videoPath(seasonId, storedName));
}

export function videoSizeBytes(seasonId: number, storedName: string): number | null {
  const p = videoPath(seasonId, storedName);
  if (!existsSync(p)) return null;
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}

export function deleteVideoFile(seasonId: number, storedName: string | null): void {
  if (!storedName) return;
  const p = videoPath(seasonId, storedName);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // 文件可能已被删除，忽略
  }
}

export function videoContentType(storedName: string): string {
  const map: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.flv': 'video/x-flv',
    '.wmv': 'video/x-ms-wmv',
    '.ts': 'video/mp2t',
    '.mpg': 'video/mpeg',
    '.mpeg': 'video/mpeg',
  };
  const ext = extname(storedName).toLowerCase();
  return map[ext] ?? 'application/octet-stream';
}
