import { Elysia } from 'elysia';
import {
  findSeason,
  seasonConfig,
  activeSeason,
  findSubmission,
  listPendingSubmissions,
  upsertReview,
  listReviews,
  countDistinctReviewers,
  publishSubmission,
  findUserByQq,
  countActiveStaff,
  markRejected,
  subFiles,
} from '../repo.js';
import { authUser, requireUser } from '../auth.js';
import { badRequest, notFound, forbidden, conflict } from '../lib/errors.js';
import { AggregateError } from '../lib/aggregate.js';
import { deleteVideoFile } from '../lib/files.js';
import type { UserRow, SubmissionRow, SubFiles } from '../types.js';

function isStaff(u: UserRow | null): boolean {
  return !!u && (u.role === 'admin' || u.role === 'su');
}

/** 该视频需要几位管理员审核才刊登：有效管理员≥3 → 3 人；不足 3 → 1 人完成即通过 */
function publishThreshold(): number {
  const staff = countActiveStaff();
  return staff >= 3 ? 3 : 1;
}

/** 文件元数据视图（key → 摘要） */
function filesView(files: SubFiles) {
  const out: Record<string, { originalName: string | null; sizeBytes: number; available: boolean }> = {};
  for (const [key, f] of Object.entries(files)) {
    out[key] = {
      originalName: f.originalName ?? null,
      sizeBytes: f.sizeBytes ?? 0,
      available: !!f.storedName,
    };
  }
  return out;
}

function subMeta(sub: SubmissionRow, seasonName?: string | null) {
  const files = subFiles(sub);
  return {
    id: sub.id,
    seasonId: sub.seasonId,
    seasonName: seasonName ?? null,
    status: sub.status,
    complete: sub.complete === 1,
    files: filesView(files),
    videoAvailable: Object.values(files).some((f) => f.storedName),
    values: sub.valuesJson ? JSON.parse(sub.valuesJson) : null,
    createdAt: sub.createdAt,
    publishedAt: sub.publishedAt,
    rejectedAt: sub.rejectedAt,
    rejectedBy: sub.rejectedBy,
    rejectReason: sub.rejectReason,
  };
}

export const reviewRoutes = new Elysia({ prefix: '/api/staff' })
  // ---------- 审核队列（管理员；仅展示视频齐全的待审） ----------
  .get('/reviews', ({ query, headers }: any) => {
    const u = requireUser(authUser(headers));
    if (!isStaff(u)) throw forbidden('需要管理员权限');
    const seasonId = Number(query?.seasonId ?? 0);
    const season = seasonId ? findSeason(seasonId) : activeSeason();
    if (!season) return { ok: true, season: null, items: [], threshold: 1 };
    const cfg = seasonConfig(season);
    const threshold = publishThreshold();
    const subs = listPendingSubmissions(season.id);
    const items = subs.map((sub) => {
      const reviews = listReviews(sub.id);
      const myReview = reviews.find((r) => r.reviewerQq === u.qq);
      return {
        id: sub.id,
        userQq: sub.userQq,
        gameId: findUserByQq(sub.userQq)?.gameId ?? null,
        originalName:
          Object.values(subFiles(sub))[0]?.originalName ?? '（多视频）',
        sizeBytes: Object.values(subFiles(sub)).reduce((a, f) => a + (f.sizeBytes ?? 0), 0),
        createdAt: sub.createdAt,
        videoAvailable: Object.values(subFiles(sub)).some((f) => f.storedName),
        reviewCount: countDistinctReviewers(sub.id),
        threshold,
        myReview: myReview
          ? { values: JSON.parse(myReview.valuesJson), comment: myReview.comment }
          : null,
        items: cfg.items,
      };
    });
    return {
      ok: true,
      season: { id: season.id, name: season.name, status: season.status },
      threshold,
      total: items.length,
      items,
    };
  })

  // ---------- 提交 / 更新自己的审核（达到刊登阈值后自动刊登） ----------
  .post('/reviews/:submissionId', async ({ params, headers, body }: any) => {
    const u = requireUser(authUser(headers));
    if (!isStaff(u)) throw forbidden('需要管理员权限');
    const sub = findSubmission(Number(params.submissionId));
    if (!sub) throw notFound('投稿不存在');
    if (sub.status !== 'pending') throw conflict('该投稿未处于待审核状态，无法审核');
    if (sub.userQq === u.qq) throw forbidden('不能审核自己的投稿');
    if (sub.complete !== 1) throw conflict('该投稿的视频尚未传齐，无法审核');

    const season = findSeason(sub.seasonId);
    if (!season) throw notFound('赛季不存在');
    const cfg = seasonConfig(season);

    const valuesRaw = (body ?? {}).values as Record<string, unknown> | undefined;
    if (!valuesRaw || typeof valuesRaw !== 'object') throw badRequest('请填写审核数据');
    const values: Record<string, number> = {};
    for (const item of cfg.items) {
      const v = valuesRaw[item.key];
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw badRequest(`请填写有效的「${item.label}」数值`);
      }
      values[item.key] = n;
    }

    const comment = typeof body?.comment === 'string' && body.comment ? String(body.comment) : null;

    const { created } = upsertReview({
      submissionId: sub.id,
      reviewerQq: u.qq,
      values,
      comment,
    });

    // 达到刊登阈值时自动刊登：有效管理员≥3 需 3 人；不足 3 人则 1 人完成即通过
    const threshold = publishThreshold();
    const distinct = countDistinctReviewers(sub.id);
    let publishedValues: Record<string, number> | null = null;
    if (distinct >= threshold) {
      try {
        publishedValues = publishSubmission(sub.id);
      } catch (e) {
        if (e instanceof AggregateError) throw badRequest(`无法刊登：${e.message}`);
        throw e;
      }
    }
    return {
      ok: true,
      created,
      reviewCount: distinct,
      threshold,
      published: publishedValues !== null,
      publishedValues,
    };
  })

  // ---------- 打回（判定作弊/无效，视频作废并删除文件） ----------
  .post('/submissions/:submissionId/reject', async ({ params, headers, body }: any) => {
    const u = requireUser(authUser(headers));
    if (!isStaff(u)) throw forbidden('需要管理员权限');
    const sub = findSubmission(Number(params.submissionId));
    if (!sub) throw notFound('投稿不存在');
    if (sub.status !== 'pending') throw conflict('只有待审核的投稿可以被打回');
    if (sub.userQq === u.qq) throw forbidden('不能打回自己上传的视频');

    const reason =
      typeof body?.reason === 'string' && body.reason.trim()
        ? String(body.reason).trim().slice(0, 500)
        : null;

    // 先删除全部视频文件
    const files = subFiles(sub);
    for (const f of Object.values(files)) {
      if (f?.storedName) deleteVideoFile(sub.seasonId, f.storedName);
    }
    const rejected = markRejected({ submissionId: sub.id, by: u.qq, reason });
    return {
      ok: true,
      submission: subMeta(rejected),
      message: `已打回 #${sub.id}${reason ? `（原因：${reason}）` : ''}`,
    };
  });
