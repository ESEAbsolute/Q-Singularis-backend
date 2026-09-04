// ===========================================================================
// 后台转码 worker：把上传的原视频压制（CRF）并切片为 HLS
// - 由 index.ts 周期调用（busy 保护，单实例执行）
// - 转码成功：本地模式删除原文件只留 HLS；R2 模式把 HLS 推上 R2 后删除本地副本
// - 失败：保留原文件（播放回退原文件），条目记 failed 与原因
// - ffmpeg 不可用（auto 探测失败 / off）：上传时直接标 off，本 worker 不启动
// ===========================================================================
import { unlinkSync } from 'node:fs';
import { findNextTranscodeFile, setFileTranscode } from './repo.js';
import { ffmpegAvailable, transcodeToHls, removeDirIfExists } from './lib/ffmpeg.js';
import {
  originalPath,
  originalExists,
  hlsLocalDir,
  hlsLocalExists,
  r2Enabled,
  pushHlsToR2,
} from './lib/mediaStore.js';

let busy = false;

/** 处理一个待转码视频（无任务 / ffmpeg 不可用 / 正在处理时立即返回） */
export async function runTranscodeTick(): Promise<void> {
  if (busy) return;
  if (!ffmpegAvailable()) return;
  const job = findNextTranscodeFile();
  if (!job) return;
  busy = true;
  const { sub, key, file } = job;
  try {
    setFileTranscode({ submissionId: sub.id, key, transcode: 'processing' });
    const input = originalPath(sub.seasonId, file.storedName);
    if (!originalExists(sub.seasonId, file.storedName)) {
      throw new Error('原文件缺失（可能已被清理），跳过转码');
    }
    await transcodeToHls(input, hlsLocalDir(sub.seasonId, file.storedName));
    if (!hlsLocalExists(sub.seasonId, file.storedName)) {
      throw new Error('ffmpeg 未生成 HLS 产物');
    }
    if (r2Enabled()) {
      await pushHlsToR2(sub.seasonId, file.storedName);
      // 远端确认后删除本地 HLS 与原始文件
      removeDirIfExists(hlsLocalDir(sub.seasonId, file.storedName));
    }
    try {
      unlinkSync(input); // 转码完成：原文件不再保留（HLS 已足够播放）
    } catch {
      /* ignore：文件可能已被并发清理 */
    }
    setFileTranscode({ submissionId: sub.id, key, transcode: 'done' });
    console.log(`[media] 转码完成 #${sub.id}/${key}（${r2Enabled() ? 'R2' : '本地'}）`);
  } catch (e: any) {
    console.error(`[media] 转码失败 #${sub.id}/${key}:`, e?.message ?? e);
    try {
      setFileTranscode({
        submissionId: sub.id,
        key,
        transcode: 'failed',
        error: e?.message ?? '转码失败',
      });
    } catch {
      /* 投稿可能已被删除 */
    }
  } finally {
    busy = false;
  }
}
