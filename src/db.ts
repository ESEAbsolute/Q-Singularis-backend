import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { env } from './env.js';

mkdirSync(dirname(env.dbPath), { recursive: true });

export const db = new DatabaseSync(env.dbPath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------------------
// submissions 表结构（v2）
//   files_json: {"<rawKey>": {originalName, storedName, sizeBytes}}，
//               旧版(v1)迁移的单视频以 "*" key 存放（历史数据无 rawKey 概念）
//   status: pending / published / replaced / rejected
//           pending   = 审核池中（complete=1 可审；有 ≥1 审且未满 3 审时
//                        values_json 已有快照，成绩已上榜单待补审）
//           published = 满 3 审后成绩定格（从审核池移除，不可再审/撤销）
//   complete: 0=素材未齐(上传中) 1=素材齐备(可进审核池)
//   values_json: 审核聚合快照 {key:number}；≥1 审时由每次审核提交后即时写入，
//                满 3 审时定格不再变化
// ---------------------------------------------------------------------------
const SUB_DDL = `
CREATE TABLE submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id     INTEGER NOT NULL REFERENCES seasons(id),
  user_qq       TEXT NOT NULL REFERENCES users(qq) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','replaced','rejected')),
  files_json    TEXT NOT NULL DEFAULT '{}',
  complete      INTEGER NOT NULL DEFAULT 0,
  values_json   TEXT,          -- 刊登后聚合的 raw 值 {key:number}
  notes_json    TEXT NOT NULL DEFAULT '{}',  -- 玩家提交说明 {key: {text, images[]}}（图片审核完成后即删）
  partial_base_id INTEGER,     -- 部分更新投稿的基底投稿 id（沿用其未更新项的视频）
  created_at    INTEGER NOT NULL,
  published_at  INTEGER,
  rejected_at   INTEGER,
  rejected_by   TEXT,
  reject_reason TEXT
);
CREATE INDEX idx_sub_season_user ON submissions(season_id, user_qq);
CREATE INDEX idx_sub_status ON submissions(status);
`;

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  qq            TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin','su')),
  status        TEXT NOT NULL DEFAULT 'unverified' CHECK(status IN ('unverified','verified')),
  game_id       TEXT,
  auth_uuid     TEXT,
  created_at    INTEGER NOT NULL,
  verified_at   INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  qq         TEXT NOT NULL REFERENCES users(qq) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_qq ON sessions(qq);

CREATE TABLE IF NOT EXISTS seasons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  config      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  reviewer_qq   TEXT NOT NULL,
  values_json   TEXT NOT NULL, -- 审核填写的 {key:number}
  comment       TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(submission_id, reviewer_qq)
);

CREATE TABLE IF NOT EXISTS manual_scores (
  season_id   INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  user_qq     TEXT NOT NULL REFERENCES users(qq) ON DELETE CASCADE,
  values_json TEXT NOT NULL,
  note        TEXT,
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (season_id, user_qq)
);

CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id     INTEGER NOT NULL REFERENCES seasons(id),
  user_qq       TEXT NOT NULL REFERENCES users(qq) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','replaced','rejected')),
  files_json    TEXT NOT NULL DEFAULT '{}',
  complete      INTEGER NOT NULL DEFAULT 0,
  values_json   TEXT,
  notes_json    TEXT NOT NULL DEFAULT '{}',
  partial_base_id INTEGER,
  created_at    INTEGER NOT NULL,
  published_at  INTEGER,
  rejected_at   INTEGER,
  rejected_by   TEXT,
  reject_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_sub_season_user ON submissions(season_id, user_qq);
CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions(status);
`);

/**
 * 旧库迁移：v1 submissions（单视频列 stored_name 等）→ v2（files_json 多视频 + rejected）。
 * 自动检测：存在 submissions 表但缺 files_json 列时执行。
 * 做法：读出旧行 → 删旧表 → 建 v2 表 → 回填（保持 id），单视频打包进 "*" key。
 */
function migrateSubmissionsV1(): void {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='submissions'")
    .get();
  if (!hasTable) return;
  const cols = new Set(
    (db.prepare('PRAGMA table_info(submissions)').all() as { name: string }[]).map((c) => c.name)
  );
  if (cols.has('files_json')) return; // 已是最新结构

  console.log('[db] 检测到旧版 submissions 表，正在迁移到 v2（多视频/打回）…');
  const t = Date.now();
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    const oldRows = db
      .prepare('SELECT * FROM submissions')
      .all() as Record<string, unknown>[];
    db.exec('DROP TABLE IF EXISTS submissions;');
    db.exec(SUB_DDL);
    const ins = db.prepare(
      `INSERT INTO submissions
         (id, season_id, user_qq, status, files_json, complete, values_json, created_at, published_at,
          rejected_at, rejected_by, reject_reason)
       VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)`
    );
    for (const r of oldRows) {
      const stored = (r.stored_name as string | null) ?? null;
      const files =
        stored && stored !== ''
          ? JSON.stringify({
              '*': {
                originalName: (r.original_name as string | null) ?? null,
                storedName: stored,
                sizeBytes: (r.size_bytes as number | null) ?? 0,
              },
            })
          : '{}';
      ins.run(
        r.id as never,
        r.season_id as never,
        r.user_qq as never,
        r.status as never,
        files as never,
        (stored ? 1 : 0) as never,
        (r.values_json ?? null) as never,
        r.created_at as never,
        (r.published_at ?? null) as never
      );
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
  console.log(`[db] submissions 迁移完成（耗时 ${Date.now() - t}ms）`);
}

migrateSubmissionsV1();

/**
 * v2.x 老库补列：submissions 缺 notes_json（玩家提交说明/截图）时 ALTER 追加。
 */
function migrateAddNotesColumn(): void {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='submissions'")
    .get();
  if (!hasTable) return;
  const cols = new Set(
    (db.prepare('PRAGMA table_info(submissions)').all() as { name: string }[]).map((c) => c.name)
  );
  if (cols.has('notes_json')) return;
  console.log('[db] 检测到 submissions 缺少 notes_json，正在补充列…');
  db.exec("ALTER TABLE submissions ADD COLUMN notes_json TEXT NOT NULL DEFAULT '{}';");
}

migrateAddNotesColumn();

/** v2.3 老库补列：submissions 缺 partial_base_id（部分更新基底）时 ALTER 追加 */
function migrateAddPartialBaseColumn(): void {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='submissions'")
    .get();
  if (!hasTable) return;
  const cols = new Set(
    (db.prepare('PRAGMA table_info(submissions)').all() as { name: string }[]).map((c) => c.name)
  );
  if (cols.has('partial_base_id')) return;
  console.log('[db] 检测到 submissions 缺少 partial_base_id，正在补充列…');
  db.exec('ALTER TABLE submissions ADD COLUMN partial_base_id INTEGER;');
}

migrateAddPartialBaseColumn();

// ---------------------------------------------------------------------------
// 种子赛季：若没有任何赛季，创建「第 0 期」演示配置
// ---------------------------------------------------------------------------
function seedSeasons(): void {
  const row = db.prepare('SELECT COUNT(*) AS c FROM seasons').get() as { c: number };
  if (row.c > 0) return;
  const now = Date.now();
  const config = JSON.stringify({
    items: [
      { key: 'damage', label: '伤害量', unit: '' },
      { key: 'time', label: '耗时', unit: '秒' },
    ],
    // 演示规则（占位，超级管理员可在「排行管理 - 编辑当前期/开启下一期」时改写）：
    //   sc_1 = ln(d_1 + 1)：伤害越大，得分越高
    //   sc_2 = -ln(d_2)：耗时越长（秒）扣分越多
    expressions: ['ln(d_1 + 1)', '-ln(d_2)'],
    visibility: { publicScores: [], publicRaw: [] },
  });
  db.prepare(
    'INSERT INTO seasons (name, status, config, created_at, archived_at) VALUES (?,?,?,?,NULL)'
  ).run('第 0 期', 'active', config, now);
}

seedSeasons();

export function now(): number {
  return Date.now();
}

export function parseConfig(raw: string): import('./types.js').SeasonConfig {
  return JSON.parse(raw);
}
