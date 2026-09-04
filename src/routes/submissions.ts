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
  subNotes,
  setSubmissionNoteText,
  addSubmissionNoteImage,
  deleteSubmissionNoteImage,
  purgeSubmissionNoteImages,
} from '../repo.js';
import { authUser, requireUser } from '../auth.js';
import { badRequest, notFound, forbidden, conflict } from '../lib/errors.js';
import { env } from '../env.js';
import {
  genStoredName,
  genImageStoredName,
  imageExtOf,
  writeVideoFile,
  readVideoBuffer,
  videoExists,
  videoContentType,
  imageContentType,
  videoSizeBytes,
  deleteVideoFile,
} from '../lib/files.js';
import { ffmpegAvailable } from '../lib/ffmpeg.js';
import {
  transcodeStatusOf,
  readHlsPlaylist,
  readHlsSegment,
  deleteMediaAll,
} from '../lib/mediaStore.js';
import type { UserRow, SubmissionRow, SubFiles, SubFile } from '../types.js';
import { readFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';

function isStaff(u: UserRow | null): boolean {
  return !!u && (u.role === 'admin' || u.role === 'su');
}

/** 校验视频访问权限并定位条目（:key 支持旧数据 "*" 回退） */
function authVideoFile(params: any, headers: any): { sub: SubmissionRow; file: SubFile } {
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
  return { sub, file };
}

function fileMeta(files: SubFiles) {
  const out: Record<
    string,
    {
      originalName: string | null;
      sizeBytes: number;
      available: boolean;
      transcode: string;
      transcodeError: string | null;
    }
  > = {};
  for (const [key, f] of Object.entries(files)) {
    out[key] = {
      originalName: f.originalName ?? null,
      sizeBytes: f.sizeBytes ?? 0,
      available: !!f.storedName,
      transcode: transcodeStatusOf(f),
      transcodeError: f.transcodeError ?? null,
    };
  }
  return out;
}

/** notes 视图：文本 + 截图元数据（截图的 storedName 不暴露，读取走鉴权接口） */
function notesView(sub: SubmissionRow) {
  const notes = subNotes(sub);
  const out: Record<
    string,
    { text: string; images: { originalName: string | null; sizeBytes: number }[] }
  > = {};
  for (const [key, n] of Object.entries(notes)) {
    out[key] = {
      text: n?.text ?? '',
      images: (n?.images ?? []).map((f) => ({
        originalName: f.originalName ?? null,
        sizeBytes: f.sizeBytes ?? 0,
      })),
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
    notes: notesView(sub),
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
      file: {
        originalName,
        storedName,
        sizeBytes: bytes.byteLength,
        // ffmpeg 可用则标记待转码（后台压制 + HLS）；否则原文件模式
        transcode: ffmpegAvailable() ? 'pending' : 'off',
      },
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

  // ---------- 视频文件（本人 / 管理员） ----------
  // 转码完成后：/video/:key/index.m3u8 为 HLS 播放列表，/video/:key/seg_*.ts 为切片
  // 原文件模式（off/failed/pending 或历史数据）：/video/:key 直出原文件（Range 支持）
  .get('/submissions/:id/video/:key/index.m3u8', async ({ params, headers }: any) => {
    const { sub, file } = authVideoFile(params, headers);
    if (transcodeStatusOf(file) !== 'done') throw notFound('该视频尚未完成转码');
    const data = await readHlsPlaylist(sub.seasonId, file.storedName);
    if (!data) throw notFound('视频文件不存在');
    return new Response(data, {
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    } as never);
  })

  .get('/submissions/:id/video/:key/:segName', async ({ params, headers }: any) => {
    const segName = String(params.segName ?? '');
    // 白名单：ffmpeg 生成形如 seg_00000.ts 的切片名，杜绝路径穿越
    if (!/^seg_\d{5}\.ts$/.test(segName)) throw notFound('片段不存在');
    const { sub, file } = authVideoFile(params, headers);
    if (transcodeStatusOf(file) !== 'done') throw notFound('该视频尚未完成转码');
    const data = await readHlsSegment(sub.seasonId, file.storedName, segName);
    if (!data) throw notFound('片段不存在');
    return new Response(data, {
      headers: { 'Content-Type': 'video/mp2t' },
    } as never);
  })

  .get('/submissions/:id/video/:key', async ({ params, headers, request }: any) => {
    const { sub, file } = authVideoFile(params, headers);
    if (transcodeStatusOf(file) === 'done') {
      // 旧客户端访问原文件路径：301 到 HLS 播放列表
      return Response.redirect(
        `/api/submissions/${sub.id}/video/${encodeURIComponent(String(params.key))}/index.m3u8`,
        301
      );
    }
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
    purgeSubmissionNoteImages(sub); // 提交说明的截图文件一并删除
    const files = subFiles(sub);
    for (const f of Object.values(files)) {
      if (f?.storedName) await deleteMediaAll(sub.seasonId, f.storedName);
    }
    deleteSubmissionRow(sub.id);
    return { ok: true };
  })

  // ---------- 提交说明：文本（每 raw 项一条，可选） ----------
  // 仅本人、进行中投稿（0 审，含视频未传齐的草稿）；开始审核后锁定不可改
  .post('/submissions/note-text', async ({ headers, body, query }: any) => {
    const u = requireUser(authUser(headers));
    if (u.status !== 'verified') throw forbidden('请先完成 QQ 验证');
    const season = activeSeason();
    if (!season) throw conflict('当前没有进行中的赛季，无法填写提交说明');
    const cfg = seasonConfig(season);
    const key = String(query?.key ?? '');
    if (!cfg.items.some((i) => i.key === key)) {
      throw badRequest(`未知测试项 "${key}"`);
    }
    let sub = findAnyPendingSubmission(season.id, u.qq);
    if (!sub) sub = createSubmission({ seasonId: season.id, userQq: u.qq });
    const text =
      typeof body?.text === 'string' ? String(body.text).slice(0, 500).trim() : '';
    const updated = setSubmissionNoteText(sub.id, key, text);
    return {
      ok: true,
      submission: subMeta(updated, season.name, season.status),
      note: { key, text },
    };
  })

  // ---------- 提交说明：截图（每 raw 项最多 9 张，每张 ≤ MAX_NOTE_IMAGE_BYTES） ----------
  .post('/submissions/note-images', async ({ headers, query, request }: any) => {
    const u = requireUser(authUser(headers));
    if (u.status !== 'verified') throw forbidden('请先完成 QQ 验证');
    const season = activeSeason();
    if (!season) throw conflict('当前没有进行中的赛季，无法添加截图');
    const cfg = seasonConfig(season);
    const key = String(query?.key ?? '');
    if (!cfg.items.some((i) => i.key === key)) {
      throw badRequest(`未知测试项 "${key}"`);
    }
    let sub = findAnyPendingSubmission(season.id, u.qq);
    if (!sub) sub = createSubmission({ seasonId: season.id, userQq: u.qq });

    let rawName = String(
      headers['x-filename'] ?? headers['X-Filename'] ?? headers['x-file-name'] ?? 'shot.png'
    );
    try {
      rawName = decodeURIComponent(rawName);
    } catch {
      /* keep as-is */
    }
    const originalName =
      rawName.split('\\').pop()!.split('/').pop()!.slice(0, 200) || 'shot.png';
    if (!imageExtOf(originalName)) {
      throw badRequest('仅支持 png / jpg / jpeg / webp / gif 图片');
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) throw badRequest('图片内容为空');
    if (bytes.byteLength > env.noteImageMaxBytes) {
      throw badRequest(
        `单张截图不能超过 ${Math.floor(env.noteImageMaxBytes / 1024 / 1024)}MB`
      );
    }
    const notes = subNotes(sub);
    const count = notes[key]?.images?.length ?? 0;
    if (count >= 9) throw badRequest('每个测试项的截图最多 9 张');

    const storedName = genImageStoredName(originalName);
    writeVideoFile(sub.seasonId, storedName, bytes);
    const updated = addSubmissionNoteImage(sub.id, key, {
      originalName,
      storedName,
      sizeBytes: bytes.byteLength,
    });
    return {
      ok: true,
      submission: subMeta(updated, season.name, season.status),
    };
  })

  // ---------- 提交说明：查看截图（本人 / 管理员） ----------
  .get('/submissions/:id/note-images/:key/:index', ({ params, headers }: any) => {
    const u = requireUser(authUser(headers));
    const sub = findSubmission(Number(params.id));
    if (!sub) throw notFound('投稿不存在');
    const isOwner = sub.userQq === u.qq;
    if (!isOwner && !isStaff(u)) throw forbidden('无权查看该投稿');

    const key = String(params.key ?? '');
    const index = Number(params.index);
    const note = subNotes(sub)[key];
    const img = note?.images?.[index];
    if (!img?.storedName) throw notFound('截图不存在');
    const data = readVideoBuffer(sub.seasonId, img.storedName);
    if (!data) throw notFound('截图文件不存在');
    return new Response(data, {
      headers: { 'Content-Type': imageContentType(img.storedName) },
    } as never);
  })

  // ---------- 提交说明：删除一张截图（仅本人，审核开始前） ----------
  .delete('/submissions/:id/note-images', ({ params, headers, query }: any) => {
    const u = requireUser(authUser(headers));
    const sub = findSubmission(Number(params.id));
    if (!sub) throw notFound('投稿不存在');
    if (sub.userQq !== u.qq) throw forbidden('只能删除自己投稿的截图');
    if (sub.status !== 'pending') throw conflict('该投稿已不在审核流程中，无法修改');
    if (sub.valuesJson || countDistinctReviewers(sub.id) > 0) {
      throw conflict('投稿已开始审核，提交说明已锁定（如需修改请联系管理员）');
    }
    const key = String(query?.key ?? '');
    const index = Number(query?.index);
    const note = subNotes(sub)[key];
    const img = note?.images?.[index];
    if (!img?.storedName) throw notFound('截图不存在');
    const updated = deleteSubmissionNoteImage(sub.id, key, img.storedName);
    return { ok: true, submission: subMeta(updated) };
  });
