import { db, now } from './db.js';
import { env } from './env.js';
import { deleteVideoFile } from './lib/files.js';
import type { SubFiles } from './types.js';

/** 周期清理任务（由 index.ts 注册定时器调用） */
export function runCleanup(): void {
  const t = now();

  // 1) 删除超过验证时限仍未验证的账号
  const deadline = t - env.verifyTtlMs;
  const expired = db
    .prepare("SELECT qq FROM users WHERE status = 'unverified' AND created_at < ?")
    .all(deadline) as { qq: string }[];
  const del = db.prepare('DELETE FROM users WHERE status = ? AND created_at < ?');
  for (const e of expired) del.run('unverified', deadline);

  // 2) 清理过期会话
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);

  // 3) 审核完成(published)超过 N 天的视频：删除文件，保留记录与数据
  const keepAfter = t - env.videoKeepDays * 24 * 3600 * 1000;
  const oldPublished = db
    .prepare(
      "SELECT id, season_id, files_json FROM submissions WHERE status = 'published' AND published_at IS NOT NULL AND published_at < ?"
    )
    .all(keepAfter) as { id: number; season_id: number; files_json: string }[];
  const upd = db.prepare("UPDATE submissions SET files_json = '{}', complete = 0 WHERE id = ?");
  for (const s of oldPublished) {
    const files = parseFiles(s.files_json);
    for (const f of Object.values(files)) {
      if (f?.storedName) deleteVideoFile(s.season_id, f.storedName);
    }
    upd.run(s.id);
  }

  // 4) 打回(rejected)的投稿文件已即时删除；此处兜底：rejected 且遗留文件的清理
  const rejectedRows = db
    .prepare(
      "SELECT id, season_id, files_json FROM submissions WHERE status = 'rejected' AND files_json != '{}'"
    )
    .all() as { id: number; season_id: number; files_json: string }[];
  const updRej = db.prepare(
    "UPDATE submissions SET files_json = '{}', complete = 0 WHERE id = ?"
  );
  for (const s of rejectedRows) {
    const files = parseFiles(s.files_json);
    for (const f of Object.values(files)) {
      if (f?.storedName) deleteVideoFile(s.season_id, f.storedName);
    }
    updRej.run(s.id);
  }
}

function parseFiles(raw: string): SubFiles {
  try {
    return JSON.parse(raw) as SubFiles;
  } catch {
    return {};
  }
}
