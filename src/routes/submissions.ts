import { Elysia } from 'elysia';
import {
  findSeason,
  seasonConfig,
  activeSeason,
  findUserByQq,
  createSubmission,
  findSubmission,
  findPendingSubmission,
  findAnyPendingSubmission,
  listSubmissionsByUser,
  deleteSubmissionRow,
  listReviews,
  countDistinctReviewers,
  attachSubmissionFile,
  recomputeComplete,
  subFiles,
} from '../repo.js';
import { authUser, requireUser } from '../auth.js';
import { badRequest, notFound, forbidden, conflict } from '../lib/errors.js';
import { env } from '../env.js';
import {
  genStoredName,
  writeVideoFile,
  videoExists,
  videoContentType,
  videoSizeBytes,
  deleteVideoFile,
} from '../lib/files.js';
import type { UserRow, SubmissionRow, SubFiles, SubFile } from '../types.js';
import { readFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

function isStaff(u: UserRow | null): boolean {
  return !!u && (u.role === 'admin' || u.role === 'su');
}

function fileMeta(files: SubFiles) {
  const out: Record<string, { originalName: string | null; sizeBytes: number; available: boolean }> =
    {};
  for (const [key, f] of Object.entries(files)) {
    out[key] = {
      originalName: f.originalName ?? null,
      sizeBytes: f.sizeBytes ?? 0,
      available: !!f.storedName,
    };
  }
  return out;
}

function subMeta(sub: SubmissionRow, seasonName?: string | null, seasonStatus?: string | null) {
  const files = subFiles(sub);
  return {
    id: sub.id,
    seasonId: sub.seasonId,
    seasonName: seasonName ?? null,
    seasonStatus: seasonStatus ?? null,
    status: sub.status,
    complete: sub.complete === 1,
    files: fileMeta(files),
    videoAvailable: Object.values(files).some((f) => f.storedName),
    values: sub.valuesJson ? JSON.parse(sub.valuesJson) : null,
    createdAt: sub.createdAt,
    publishedAt: sub.publishedAt,
    rejectedAt: sub.rejectedAt,
    rejectedBy: sub.rejectedBy,
    rejectReason: sub.rejectReason,
  };
}

export const submissionRoutes = new Elysia({ prefix: '/api' })
  // ---------- 我的投稿 ----------
  .get('/submissions/mine', ({ headers }: any) => {
    const u = requireUser(authUser(headers));
    if (u.status !== 'verified') throw forbidden('请先完成 QQ 验证');
    return {
      ok: true,
      submissions: listSubmissionsByUser(u.qq).map((s) => {
        const season = findSeason(s.seasonId);
        return {
          ...subMeta(s, season?.name, season?.status),
          reviewCount: countDistinctReviewers(s.id),
        };
      }),
    };
  })

  // ---------- 上传单个 raw 项的视频（一次一个文件；全部 raw key 传完即进入待审） ----------
  // 请求：POST /api/submissions/upload?key=<rawKey>，body=原始字节，X-Filename=原文件名
  .post('/submissions/upload', async ({ query, headers, request }: any) => {
    const u = requireUser(authUser(headers));
    if (u.status !== 'verified') throw forbidden('请先完成 QQ 验证');
    if (!u.gameId) throw badRequest('请先在个人中心绑定游戏ID再上传');

    const season = activeSeason();
    if (!season) throw conflict('当前没有进行中的赛季，无法上传');
    const cfg = seasonConfig(season);

    const key = String(query?.key ?? '');
    if (!cfg.items.some((i) => i.key === key)) {
      throw badRequest(`未知测试项 "${key}"（本期为：${cfg.items.map((i) => i.key).join(' / ')}）`);
    }

    // 若已存在“齐全”的待审：不自动替代，由前端询问保留哪一份
    const completePending = findPendingSubmission(season.id, u.qq);
    if (completePending) {
      throw conflict(`已有待审核视频 #${completePending.id}，请先决定保留哪一份`);
    }

    // 复用上传到一半的草稿，否则新建
    let sub = findAnyPendingSubmission(season.id, u.qq);
    if (!sub) sub = createSubmission({ seasonId: season.id, userQq: u.qq });

    let rawName = String(
      headers['x-filename'] ?? headers['X-Filename'] ?? headers['x-file-name'] ?? 'video.mp4'
    );
    try {
      rawName = decodeURIComponent(rawName);
    } catch {
      /* keep as-is */
    }
    const originalName =
      rawName.split('\\').pop()!.split('/').pop()!.slice(0, 200) || 'video.mp4';
    const storedName = genStoredName(originalName);

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) throw badRequest('上传内容为空');
    if (bytes.byteLength > env.maxUploadBytes) {
      throw badRequest(
        `单个视频不能超过 ${Math.floor(env.maxUploadBytes / 1024 / 1024)}MB`
      );
    }

    writeVideoFile(season.id, storedName, bytes);
    const { previous } = attachSubmissionFile({
      submissionId: sub.id,
      key,
      file: { originalName, storedName, sizeBytes: bytes.byteLength },
    });
    // 若该 key 之前有旧文件（替换重传），删除之
    if (previous) deleteVideoFile(season.id, previous.storedName);

    const finalSub = recomputeComplete(sub.id);
    const files = subFiles(finalSub);
    const missing = cfg.items.map((i) => i.key).filter((k) => !files[k]);

    return {
      ok: true,
      complete: finalSub.complete === 1,
      missing,
      submission: subMeta(finalSub, season.name, season.status),
    };
  })

  // ---------- 投稿详情（本人 / 管理员） ----------
  .get('/submissions/:id', ({ params, headers }: any) => {
    const u = requireUser(authUser(headers));
    const sub = findSubmission(Number(params.id));
    if (!sub) throw notFound('投稿不存在');
    const isOwner = sub.userQq === u.qq;
    if (!isOwner && !isStaff(u)) throw forbidden('无权查看该投稿');

    const season = findSeason(sub.seasonId);
    const fullCfg = season ? seasonConfig(season) : null;
    // 普通用户不暴露表达式
    const cfgOut =
      fullCfg && isStaff(u)
        ? fullCfg
        : fullCfg
          ? { ...fullCfg, expressions: [] }
          : null;

    const reviews = listReviews(sub.id);
    const reviewers = reviews.map((r) => ({
      reviewerQq: r.reviewerQq,
      reviewerName: findUserByQq(r.reviewerQq)?.gameId ?? r.reviewerQq,
      values: JSON.parse(r.valuesJson),
      comment: r.comment,
      updatedAt: r.updatedAt,
    }));
    return {
      ok: true,
      submission: subMeta(sub, season?.name, season?.status),
      season: season
        ? { id: season.id, name: season.name, status: season.status, config: cfgOut }
        : null,
      reviewCount: reviewers.length,
      reviewers,
    };
  })

  // ---------- 视频文件（本人 / 管理员；Range 支持；:key = raw 项 key 或 *） ----------
  .get('/submissions/:id/video/:key', async ({ params, headers, request }: any) => {
    const u = requireUser(authUser(headers));
    const sub = findSubmission(Number(params.id));
    if (!sub) throw notFound('投稿不存在');
    const isOwner = sub.userQq === u.qq;
    if (!isOwner && !isStaff(u)) throw forbidden('无权查看该视频');

    const files = subFiles(sub);
    const key = String(params.key ?? '');
    let file: SubFile | undefined = files[key];
    // 旧版单视频数据存于 "*"：未按项匹配时回退到它
    if (!file && files['*'] && Object.keys(files).length === 1) file = files['*'];
    if (!file) throw notFound('该测试项没有对应视频');
    if (!file.storedName) throw notFound('视频文件不存在');
    if (!videoExists(sub.seasonId, file.storedName)) throw notFound('视频文件不存在');

    const size = videoSizeBytes(sub.seasonId, file.storedName)!;
    const contentType = videoContentType(file.storedName);
    const filePath = join(env.uploadDir, String(sub.seasonId), file.storedName);
    const rangeHeader = request.headers.get('range');

    if (!rangeHeader) {
      const data = readFileSync(filePath);
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
        },
      });
    }

    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!m) return new Response('非法 Range', { status: 416 });
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return new Response('范围越界', {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }
    end = Math.min(end, size - 1);
    const stream = createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream) as never, {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
      },
    } as never);
  })

  // ---------- 撤销自己的投稿（上传中草稿或未刊登的待审均可；已刊登/打回后不可） ----------
  .delete('/submissions/:id', async ({ params, headers }: any) => {
    const u = requireUser(authUser(headers));
    const sub = findSubmission(Number(params.id));
    if (!sub) throw notFound('投稿不存在');
    if (sub.userQq !== u.qq) throw forbidden('只能撤销自己的投稿');
    if (sub.status !== 'pending') throw conflict('只有待审核或上传中的投稿可以被撤销');
    if (sub.valuesJson) throw conflict('该投稿已刊登，无法撤销（如有问题请联系管理员）');

    const files = subFiles(sub);
    for (const f of Object.values(files)) {
      if (f?.storedName) deleteVideoFile(sub.seasonId, f.storedName);
    }
    deleteSubmissionRow(sub.id);
    return { ok: true };
  });
