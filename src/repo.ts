import { db, now, parseConfig } from './db.js';
import type {
  UserRow,
  SeasonRow,
  SubmissionRow,
  ReviewRow,
  ManualScoreRow,
  SeasonConfig,
} from './types.js';
import { computeScores, fmt1, round1 } from './lib/scoring.js';
import { aggregateReviews, AggregateError } from './lib/aggregate.js';
import { notFound, forbidden, conflict } from './lib/errors.js';
import { deleteVideoFile } from './lib/files.js';
import { env } from './env.js';
import { hashPassword, randomToken, randomUuid } from './lib/crypto.js';

// ---------------------------------------------------------------------------
// 列别名（snake_case 列名 -> camelCase 行对象）
// ---------------------------------------------------------------------------
const USER_COLS =
  'qq, password_hash AS passwordHash, role, status, game_id AS gameId, auth_uuid AS authUuid, created_at AS createdAt, verified_at AS verifiedAt';
const SEASON_COLS = 'id, name, status, config, created_at AS createdAt, archived_at AS archivedAt';
const SUB_COLS =
  'id, season_id AS seasonId, user_qq AS userQq, status, files_json AS filesJson, complete, values_json AS valuesJson, notes_json AS notesJson, created_at AS createdAt, published_at AS publishedAt, rejected_at AS rejectedAt, rejected_by AS rejectedBy, reject_reason AS rejectReason';
const REVIEW_COLS =
  'id, submission_id AS submissionId, reviewer_qq AS reviewerQq, values_json AS valuesJson, comment, created_at AS createdAt, updated_at AS updatedAt';
const MANUAL_COLS =
  'season_id AS seasonId, user_qq AS userQq, values_json AS valuesJson, note, updated_by AS updatedBy, updated_at AS updatedAt';

type Row = Record<string, unknown>;

function one<T>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}
function many<T>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
export function findUserByQq(qq: string): UserRow | null {
  return one<UserRow>(`SELECT ${USER_COLS} FROM users WHERE qq = ?`, qq) ?? null;
}

export function findUserByAuthUuid(uuid: string): UserRow | null {
  return (
    one<UserRow>(
      `SELECT ${USER_COLS} FROM users WHERE auth_uuid = ? AND status = 'unverified'`,
      uuid
    ) ?? null
  );
}

export function createUser(qq: string, password: string): UserRow {
  const uuid = randomUuid();
  const row = {
    qq,
    passwordHash: hashPassword(password),
    role: 'user' as const,
    status: 'unverified' as const,
    gameId: null,
    authUuid: uuid,
    createdAt: now(),
    verifiedAt: null,
  };
  db.prepare(
    `INSERT INTO users (qq, password_hash, role, status, game_id, auth_uuid, created_at, verified_at)
     VALUES (@qq, @passwordHash, @role, @status, @gameId, @authUuid, @createdAt, @verifiedAt)`
  ).run(row);
  return row;
}

/** 注销（删除）账号 */
export function deleteUser(qq: string): void {
  const res = db.prepare('DELETE FROM users WHERE qq = ?').run(qq);
  if (res.changes === 0) throw notFound('用户不存在');
}

export function setUserRole(qq: string, role: UserRow['role']): void {
  db.prepare('UPDATE users SET role = ? WHERE qq = ?').run(role, qq);
}

export function setUserVerified(qq: string): void {
  db.prepare(
    "UPDATE users SET status = 'verified', verified_at = ?, auth_uuid = NULL WHERE qq = ?"
  ).run(now(), qq);
}

export function setUserGameId(qq: string, gameId: string): void {
  db.prepare('UPDATE users SET game_id = ? WHERE qq = ?').run(gameId, qq);
}

export function listUsers(q: string): UserRow[] {
  if (q) {
    return many<UserRow>(
      `SELECT ${USER_COLS} FROM users WHERE qq LIKE ? OR game_id LIKE ? ORDER BY created_at`,
      `%${q}%`,
      `%${q}%`
    );
  }
  return many<UserRow>(`SELECT ${USER_COLS} FROM users ORDER BY created_at`);
}

export function publicUser(u: UserRow) {
  return {
    qq: u.qq,
    role: u.role,
    status: u.status,
    gameId: u.gameId,
    createdAt: u.createdAt,
    verifiedAt: u.verifiedAt,
  };
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------
export function createSession(qq: string): string {
  const token = randomToken();
  const t = now();
  db.prepare(
    'INSERT INTO sessions (token, qq, created_at, expires_at) VALUES (?,?,?,?)'
  ).run(token, qq, t, t + env.sessionTtlMs);
  return token;
}

export function findSession(token: string): { qq: string } | null {
  const row = one<{ qq: string; expiresAt: number }>(
    'SELECT qq, expires_at AS expiresAt FROM sessions WHERE token = ?',
    token
  );
  if (!row) return null;
  if (row.expiresAt < now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { qq: row.qq };
}

export function deleteSession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ---------------------------------------------------------------------------
// seasons
// ---------------------------------------------------------------------------
export function listSeasons(): SeasonRow[] {
  return many<SeasonRow>(`SELECT ${SEASON_COLS} FROM seasons ORDER BY id`);
}

export function findSeason(id: number): SeasonRow | null {
  return one<SeasonRow>(`SELECT ${SEASON_COLS} FROM seasons WHERE id = ?`, id) ?? null;
}

export function activeSeason(): SeasonRow | null {
  return (
    one<SeasonRow>(`SELECT ${SEASON_COLS} FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1`) ??
    null
  );
}

export function seasonConfig(season: SeasonRow): SeasonConfig {
  return parseConfig(season.config);
}

/** 封存当前期并开启下一期（SU 操作）。返回新一期。 */
export function archiveActiveAndOpenNext(name: string, config: SeasonConfig): SeasonRow {
  const act = activeSeason();
  const t = now();
  if (act) {
    db.prepare("UPDATE seasons SET status = 'archived', archived_at = ? WHERE id = ?").run(t, act.id);
  }
  const info = db
    .prepare(
      'INSERT INTO seasons (name, status, config, created_at, archived_at) VALUES (?,?,?,?,NULL)'
    )
    .run(name, 'active', JSON.stringify(config), t);
  const id = Number(info.lastInsertRowid);
  const season = findSeason(id);
  if (!season) throw new Error('创建赛季失败');
  return season;
}

/**
 * 修改赛季配置（仅 active）。
 *
 * 中途修改规则是允许的（数据驱动）：表达式、可见性、字段的 label/unit 可随时更新，
 * 排行榜会按新公式即时重算。字段结构（items 的 key 与顺序）一旦该赛季已有投稿即锁定。
 *
 * @returns 更新后的赛季
 */
export function updateSeasonConfig(seasonId: number, config: SeasonConfig): SeasonRow {
  const season = findSeason(seasonId);
  if (!season) throw notFound('赛季不存在');
  if (season.status !== 'active') throw forbidden('只有 active 赛季可以修改配置');

  const hasAny = one<{ c: number }>(
    'SELECT COUNT(*) AS c FROM submissions WHERE season_id = ?',
    seasonId
  )!;
  if (hasAny.c > 0) {
    const old = seasonConfig(season);
    const oldKeys = old.items.map((i) => i.key).join('\u0000');
    const newKeys = config.items.map((i) => i.key).join('\u0000');
    if (oldKeys !== newKeys) {
      throw conflict(
        '该赛季已有投稿，raw 字段结构（key/顺序）已锁定；可修改表达式与可见性'
      );
    }
  }
  db.prepare('UPDATE seasons SET config = ? WHERE id = ?').run(JSON.stringify(config), seasonId);
  const updated = findSeason(seasonId);
  if (!updated) throw new Error('赛季不存在');
  return updated;
}

// ---------------------------------------------------------------------------
// submissions & reviews
//
// v2 模型：一次投稿（submission）携带多个视频，每个 raw 项（key）对应一个视频。
// filesJson: { "<rawKey>": {originalName, storedName, sizeBytes} }
//   旧版(v1)单视频迁移数据使用 "*" key。
// complete: 1=已上传齐全部 raw 项视频（可进入审核池），0=上传中。
// ---------------------------------------------------------------------------

/** 读取 submission 的文件映射（key → SubFileInfo） */
export function subFiles(sub: SubmissionRow): import('./types.js').SubFiles {
  try {
    return sub.filesJson ? (JSON.parse(sub.filesJson) as import('./types.js').SubFiles) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// notes（玩家提交说明：文本 + 截图，供审核员参考）
//   notesJson: { "<rawKey>": { text: string, images: SubFile[] } }
// 图片文件与视频同存 uploads/<seasonId>/；图片在审核完成（定格/打回/撤销）后即时删除，
// 未完成审核期间一直保留。
// ---------------------------------------------------------------------------

/** 读取 submission 的提交说明映射 */
export function subNotes(sub: SubmissionRow): import('./types.js').SubNotes {
  try {
    return sub.notesJson ? (JSON.parse(sub.notesJson) as import('./types.js').SubNotes) : {};
  } catch {
    return {};
  }
}

function updateNotes(submissionId: number, notes: import('./types.js').SubNotes): void {
  db.prepare('UPDATE submissions SET notes_json = ? WHERE id = ?').run(
    JSON.stringify(notes),
    submissionId
  );
}

/** 写某 raw 项的说明文本（空串 = 清除） */
export function setSubmissionNoteText(
  submissionId: number,
  key: string,
  text: string
): SubmissionRow {
  const sub = findSubmission(submissionId);
  if (!sub) throw notFound('投稿不存在');
  const notes = subNotes(sub);
  const note = notes[key] ?? { text: '', images: [] };
  note.text = text;
  notes[key] = note;
  updateNotes(sub.id, notes);
  return findSubmission(sub.id)!;
}

/** 追加一张截图（上限由路由层校验） */
export function addSubmissionNoteImage(
  submissionId: number,
  key: string,
  file: { originalName: string; storedName: string; sizeBytes: number }
): SubmissionRow {
  const sub = findSubmission(submissionId);
  if (!sub) throw notFound('投稿不存在');
  const notes = subNotes(sub);
  const note = notes[key] ?? { text: '', images: [] };
  note.images.push(file);
  notes[key] = note;
  updateNotes(sub.id, notes);
  return findSubmission(sub.id)!;
}

/** 删除某 raw 项的一张截图（磁盘文件一并删除） */
export function deleteSubmissionNoteImage(
  submissionId: number,
  key: string,
  storedName: string
): SubmissionRow {
  const sub = findSubmission(submissionId);
  if (!sub) throw notFound('投稿不存在');
  const notes = subNotes(sub);
  const note = notes[key];
  const idx = note?.images.findIndex((f) => f.storedName === storedName) ?? -1;
  if (!note || idx < 0) throw notFound('截图不存在');
  const [removed] = note.images.splice(idx, 1);
  deleteVideoFile(sub.seasonId, removed?.storedName ?? null);
  updateNotes(sub.id, notes);
  return findSubmission(sub.id)!;
}

/** 清除投稿全部截图（磁盘文件删除，文本保留）——定格 / 打回 / 撤销时调用 */
export function purgeSubmissionNoteImages(sub: SubmissionRow): void {
  const notes = subNotes(sub);
  let changed = false;
  for (const note of Object.values(notes)) {
    if (!note?.images?.length) continue;
    for (const img of note.images) deleteVideoFile(sub.seasonId, img.storedName);
    note.images = [];
    changed = true;
  }
  if (changed) updateNotes(sub.id, notes);
}

/** 创建一份空投稿（随后逐 raw key 上传视频，直至 complete） */
export function createSubmission(params: {
  seasonId: number;
  userQq: string;
}): SubmissionRow {
  const info = db
    .prepare(
      `INSERT INTO submissions (season_id, user_qq, status, files_json, complete, values_json, created_at, published_at, rejected_at, rejected_by, reject_reason)
       VALUES (?,?,?,?,?,NULL,?,NULL,NULL,NULL,NULL)`
    )
    .run(params.seasonId, params.userQq, 'pending', '{}', 0, now());
  const id = Number(info.lastInsertRowid);
  const row = findSubmission(id);
  if (!row) throw new Error('创建投稿失败');
  return row;
}

/** 向投稿追加/覆盖某 raw key 的视频；若该 key 已有文件返回旧文件信息供调用方删除 */
export function attachSubmissionFile(params: {
  submissionId: number;
  key: string;
  file: { originalName: string; storedName: string; sizeBytes: number };
}): { sub: SubmissionRow; previous: import('./types.js').SubFile | null } {
  const sub = findSubmission(params.submissionId);
  if (!sub) throw notFound('投稿不存在');
  const files = subFiles(sub);
  const previous = files[params.key] ?? null;
  files[params.key] = params.file;
  db.prepare('UPDATE submissions SET files_json = ? WHERE id = ?').run(
    JSON.stringify(files),
    params.submissionId
  );
  return { sub: findSubmission(params.submissionId)!, previous };
}

/** 依据赛季 raw 项重新计算 complete，并同步字段 */
export function recomputeComplete(submissionId: number): SubmissionRow {
  const sub = findSubmission(submissionId);
  if (!sub) throw notFound('投稿不存在');
  const season = findSeason(sub.seasonId);
  const cfg = season ? seasonConfig(season) : null;
  const files = subFiles(sub);
  const keys = cfg ? cfg.items.map((i) => i.key) : [];
  const complete = keys.length > 0 && keys.every((k) => files[k] !== undefined) ? 1 : 0;
  db.prepare('UPDATE submissions SET complete = ? WHERE id = ?').run(complete, submissionId);
  return findSubmission(submissionId)!;
}

export function findSubmission(id: number): SubmissionRow | null {
  return one<SubmissionRow>(`SELECT ${SUB_COLS} FROM submissions WHERE id = ?`, id) ?? null;
}

/** 某玩家在该赛季「0 审」的待审投稿（未开始审核、尚未刊登，占用上传名额） */
export function findPendingSubmission(seasonId: number, userQq: string): SubmissionRow | null {
  return (
    one<SubmissionRow>(
      `SELECT ${SUB_COLS} FROM submissions
        WHERE season_id = ? AND user_qq = ? AND status = 'pending' AND complete = 1
          AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.submission_id = submissions.id)
        LIMIT 1`,
      seasonId,
      userQq
    ) ?? null
  );
}

/** 某玩家在该赛季 0 审的任意待审投稿（含上传中草稿） */
export function findAnyPendingSubmission(
  seasonId: number,
  userQq: string
): SubmissionRow | null {
  return (
    one<SubmissionRow>(
      `SELECT ${SUB_COLS} FROM submissions
        WHERE season_id = ? AND user_qq = ? AND status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.submission_id = submissions.id)
        LIMIT 1`,
      seasonId,
      userQq
    ) ?? null
  );
}

export function listSubmissionsByUser(userQq: string): SubmissionRow[] {
  return many<SubmissionRow>(
    `SELECT ${SUB_COLS} FROM submissions WHERE user_qq = ? ORDER BY id DESC`,
    userQq
  );
}

/** 审核队列：该赛季所有已齐全的 pending（0~2 审，含快照刊登等待补审的投稿） */
export function listPendingSubmissions(seasonId: number): SubmissionRow[] {
  return many<SubmissionRow>(
    `SELECT ${SUB_COLS} FROM submissions WHERE season_id = ? AND status = 'pending' AND complete = 1 ORDER BY id`,
    seasonId
  );
}

/** 榜单数据源：pending(已刊登未满3审) 与 published(满3审) 都参与 */
export function listRankedSubmissions(seasonId: number): SubmissionRow[] {
  return many<SubmissionRow>(
    `SELECT ${SUB_COLS} FROM submissions
      WHERE season_id = ? AND complete = 1 AND values_json IS NOT NULL
        AND status IN ('pending','published')
      ORDER BY id`,
    seasonId
  );
}

export function deleteSubmissionRow(id: number): void {
  db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
}

/** 打回：判定作弊/无效，视频作废（视频文件删除由调用方处理；截图在本函数内清） */
export function markRejected(params: {
  submissionId: number;
  by: string;
  reason: string | null;
}): SubmissionRow {
  const sub = findSubmission(params.submissionId);
  if (!sub) throw notFound('投稿不存在');
  if (sub.status !== 'pending') throw conflict('只有待审核的投稿可以打回');
  purgeSubmissionNoteImages(sub); // 打回后截图不再保留
  const t = now();
  db.prepare(
    `UPDATE submissions SET status = 'rejected', files_json = '{}', values_json = NULL, complete = 0,
       published_at = NULL, rejected_at = ?, rejected_by = ?, reject_reason = ? WHERE id = ?`
  ).run(t, params.by, params.reason ?? null, params.submissionId);
  return findSubmission(params.submissionId)!;
}

/** 审核提交/更新。备注字段已废弃：审核员备注仅本人可见无意义，一律不写（历史列保留） */
export function upsertReview(params: {
  submissionId: number;
  reviewerQq: string;
  values: Record<string, number>;
}): { created: boolean } {
  const t = now();
  const existing = one<{ id: number }>(
    'SELECT id FROM reviews WHERE submission_id = ? AND reviewer_qq = ?',
    params.submissionId,
    params.reviewerQq
  );
  if (existing) {
    db.prepare(
      'UPDATE reviews SET values_json = ?, comment = NULL, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(params.values), t, existing.id);
    return { created: false };
  }
  db.prepare(
    `INSERT INTO reviews (submission_id, reviewer_qq, values_json, comment, created_at, updated_at)
     VALUES (?,?,?,NULL,?,?)`
  ).run(params.submissionId, params.reviewerQq, JSON.stringify(params.values), t, t);
  return { created: true };
}

export function listReviews(submissionId: number): ReviewRow[] {
  return many<ReviewRow>(
    `SELECT ${REVIEW_COLS} FROM reviews WHERE submission_id = ? ORDER BY id`,
    submissionId
  );
}

export function countDistinctReviewers(submissionId: number): number {
  return (
    one<{ c: number }>(
      'SELECT COUNT(DISTINCT reviewer_qq) AS c FROM reviews WHERE submission_id = ?',
      submissionId
    )?.c ?? 0
  );
}

/**
 * 快照刊登（每次有审核提交/更新后都会执行）：
 * - 聚合当前全部审核（1 人直取 / 2 人平均 / 3 人众数或最近平均），立即写入 values_json
 *   （投稿随即出现在榜单，标注「审核 X/3」）；
 * - 审满 3 份（强制目标）→ status='published'（终态定格，从审核池移除）；
 * - 不足 3 份 → 保持 'pending'，留在审核池等待更多审核。
 * @returns 聚合出的 raw 值 + 当前审核数 + 是否已满 3 审定格
 */
export function publishSubmission(submissionId: number): {
  values: Record<string, number>;
  reviewCount: number;
  locked: boolean;
} {
  const sub = findSubmission(submissionId);
  if (!sub) throw notFound('投稿不存在');
  if (sub.status !== 'pending') throw conflict('只有待审核的投稿可以刊登');
  const season = findSeason(sub.seasonId);
  if (!season) throw notFound('赛季不存在');
  const cfg = seasonConfig(season);

  const reviews = listReviews(submissionId);
  if (reviews.length === 0) throw new AggregateError('还没有审核记录，无法刊登');
  const reviewValues = reviews.map((r) => JSON.parse(r.valuesJson) as Record<string, number>);
  const keys = cfg.items.map((it) => it.key);
  const aggregated = aggregateReviews(reviewValues, keys);

  const reviewCount = reviews.length; // 每人一条（UNIQUE submission+reviewer），即不同审核人数
  const locked = reviewCount >= 3;
  const t = now();
  db.prepare(
    `UPDATE submissions SET status = ?, values_json = ?, published_at = COALESCE(published_at, ?) WHERE id = ?`
  ).run(locked ? 'published' : 'pending', JSON.stringify(aggregated), t, submissionId);
  if (locked) purgeSubmissionNoteImages(sub); // 审核通过（定格）后截图立即删除
  return { values: aggregated, reviewCount, locked };
}

// ---------------------------------------------------------------------------
// manual scores（手动更新用户分数）
// ---------------------------------------------------------------------------
export function upsertManualScore(params: {
  seasonId: number;
  userQq: string;
  values: Record<string, number>;
  note: string | null;
  updatedBy: string;
}): void {
  const t = now();
  db.prepare(
    `INSERT INTO manual_scores (season_id, user_qq, values_json, note, updated_by, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(season_id, user_qq) DO UPDATE SET
       values_json = excluded.values_json,
       note = excluded.note,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  ).run(
    params.seasonId,
    params.userQq,
    JSON.stringify(params.values),
    params.note,
    params.updatedBy,
    t
  );
}

export function findManualScore(seasonId: number, userQq: string): ManualScoreRow | null {
  return (
    one<ManualScoreRow>(
      `SELECT ${MANUAL_COLS} FROM manual_scores WHERE season_id = ? AND user_qq = ?`,
      seasonId,
      userQq
    ) ?? null
  );
}

export function deleteManualScore(seasonId: number, userQq: string): void {
  db.prepare('DELETE FROM manual_scores WHERE season_id = ? AND user_qq = ?').run(seasonId, userQq);
}

// ---------------------------------------------------------------------------
// 分数计算 + 榜单
// ---------------------------------------------------------------------------
export interface BoardCandidate {
  userQq: string;
  values: Record<string, number>;
  scores: number[];
  total: number;
  manual: boolean;
  submissionId: number | null;
  publishedAt: number | null;
  /** 该成绩经过几位管理员审核（manual 为 0） */
  reviewCount: number;
}

/** 依据赛季配置，从 raw 值计算 sc_i 与总分 */
export function computeFromValues(cfg: SeasonConfig, values: Record<string, number>) {
  const raw = cfg.items.map((it) => values[it.key] ?? NaN);
  return computeScores(cfg.expressions, raw, cfg.items.map((it) => it.key));
}

/**
 * 组装某一期榜单：
 * - 若存在 manual_scores（手动改分）→ 以手动值为准（覆盖审核成绩）；
 * - 否则取该用户得分最高的投稿（含 1-2 审快照刊登与满 3 审定格成绩，每用户仅一条上榜）。
 */
export function assembleBoard(seasonId: number): BoardCandidate[] {
  const season = findSeason(seasonId);
  if (!season) throw notFound('赛季不存在');
  const cfg = seasonConfig(season);

  const published = listRankedSubmissions(seasonId);
  const manualRows = many<ManualScoreRow>(
    `SELECT ${MANUAL_COLS} FROM manual_scores WHERE season_id = ?`,
    seasonId
  );

  const bestByUser = new Map<string, BoardCandidate>();

  // 先收录每个用户的最佳审核成绩
  for (const sub of published) {
    if (!sub.valuesJson) continue;
    const values = JSON.parse(sub.valuesJson) as Record<string, number>;
    const { scores, total } = computeFromValues(cfg, values);
    const reviewCount = countDistinctReviewers(sub.id);
    const prev = bestByUser.get(sub.userQq);
    // 分数更高优先；同分时选审核份数更多、且更早刊登的一条
    const better =
      !prev ||
      total > prev.total ||
      (total === prev.total &&
        (reviewCount > prev.reviewCount ||
          (reviewCount === prev.reviewCount &&
            (sub.publishedAt ?? 0) < (prev.publishedAt ?? 0))));
    if (better) {
      bestByUser.set(sub.userQq, {
        userQq: sub.userQq,
        values,
        scores,
        total,
        manual: false,
        submissionId: sub.id,
        publishedAt: sub.publishedAt,
        reviewCount,
      });
    }
  }
  // 手动改分优先
  for (const m of manualRows) {
    const values = JSON.parse(m.valuesJson) as Record<string, number>;
    const { scores, total } = computeFromValues(cfg, values);
    bestByUser.set(m.userQq, {
      userQq: m.userQq,
      values,
      scores,
      total,
      manual: true,
      submissionId: null,
      publishedAt: null,
      reviewCount: 0,
    });
  }
  return [...bestByUser.values()];
}

/** 排序并编号（总分精确降序；同分按 qq 升序保证稳定） */
export function rankBoard(rows: BoardCandidate[]) {
  const sorted = [...rows].sort((a, b) => b.total - a.total || a.userQq.localeCompare(b.userQq));
  return sorted.map((r, i) => ({ rank: i + 1, ...r }));
}

export function fmtScores(scores: number[]): string[] {
  return scores.map((s) => fmt1(s));
}

export function roundTotal(total: number): number {
  return round1(total);
}
