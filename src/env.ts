import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * backend 包根目录：无论从哪个 cwd 启动（systemd/pm2/docker/npm run），
 * 都以本模块位置推导，保证 DB / uploads / .env 落在正确位置（跨平台，Linux 适配）。
 * - src 运行时: <root>/src/env.ts  → 根 = 上一级
 * - dist 运行时: <root>/dist/env.js → 根 = 上一级
 */
export const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 若 env 值为相对路径，则以 backendRoot 解析；绝对路径原样使用 */
function pathOf(v: string | undefined, def: string): string {
  if (!v) return resolve(backendRoot, def);
  return resolve(backendRoot, v);
}

/** Load .env（优先 backend 根目录；其次 cwd） */
function loadDotEnv(): void {
  const candidates = [resolve(backendRoot, '.env'), resolve(process.cwd(), '.env')];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}

loadDotEnv();

function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export const env = {
  host: process.env.HOST ?? '0.0.0.0',
  port: num('PORT', 8787),
  dbPath: pathOf(process.env.DB_PATH, 'data/qs.db'),
  uploadDir: pathOf(process.env.UPLOAD_DIR, 'data/uploads'),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  botSecret: process.env.BOT_SECRET ?? 'change-me-bot-secret',
  verifyTtlMs: num('VERIFY_TTL_MS', 10 * 60 * 1000),
  videoKeepDays: num('VIDEO_KEEP_DAYS', 7),
  maxUploadBytes: num('MAX_UPLOAD_BYTES', 100 * 1024 * 1024),
  noteImageMaxBytes: num('MAX_NOTE_IMAGE_BYTES', 10 * 1024 * 1024),
  sessionTtlMs: num('SESSION_TTL_MS', 30 * 24 * 3600 * 1000),
};
