/**
 * Q-Singularis 后端端到端冒烟测试
 *
 * 启动后端后运行：npm run smoke
 * 会新建一套测试账号（qq: 随机），完成后不清理（便于人工复查）。
 */
// @ts-nocheck
const base = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const secret = process.env.BOT_SECRET ?? 'change-me-bot-secret';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    console.error(`  ✘ ${name}`, extra ?? '');
  }
}

async function api(
  path: string,
  opts: {
    method?: string;
    token?: string;
    body?: unknown;
    raw?: BodyInit;
    headers?: Record<string, string>;
  } = {}
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(base + path, { method: opts.method ?? 'GET', headers, body });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** 上传指定 raw 项视频 */
async function uploadVideo(token: string, key: string, bytes: Uint8Array, name = `${key}.mp4`) {
  return api(`/api/submissions/upload?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    token,
    raw: new Blob([bytes]),
    headers: { 'x-filename': encodeURIComponent(name) },
  });
}

async function main() {
  const rnd = Math.floor(Math.random() * 90000) + 10000;
  const owner = String(rnd); // 玩家 + 将成为 su
  const adminA = String(rnd + 1);
  const adminB = String(rnd + 2);
  const pw = 'pass123456';

  console.log('== 注册与验证 ==');
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { qq: owner, password: pw },
  });
  check('注册返回 authUuid', !!reg.json?.authUuid, reg.json);
  const ownerToken = reg.json.token;
  const uuid = reg.json.authUuid;

  const me0 = await api('/api/auth/me', { token: ownerToken });
  check('注册后为 unverified', me0.json.user.status === 'unverified', me0.json);

  const ver = await api('/internal/bot/verify', {
    method: 'POST',
    headers: { 'x-bot-secret': secret },
    body: { qq: owner, uuid },
  });
  check('机器人验证成功', ver.json.code === 'verified', ver.json);

  const me1 = await api('/api/auth/me', { token: ownerToken });
  check('验证后为 verified', me1.json.user.status === 'verified', me1.json);

  const mismatch = await api('/internal/bot/verify', {
    method: 'POST',
    headers: { 'x-bot-secret': secret },
    body: { qq: String(Number(owner) + 999), uuid },
  });
  check('QQ 不匹配/未知 uuid 时机器人静默(reply=null)', mismatch.json.reply === null, mismatch.json);

  const bind = await api('/api/me/game-id', {
    method: 'PATCH',
    token: ownerToken,
    body: { gameId: '测试者A' },
  });
  check('绑定游戏ID', bind.json.ok === true, bind.json);

  console.log('== 管理员任命 ==');
  const mkUser = async (qq: string) => {
    const r = await api('/api/auth/register', {
      method: 'POST',
      body: { qq, password: pw },
    });
    await api('/internal/bot/verify', {
      method: 'POST',
      headers: { 'x-bot-secret': secret },
      body: { qq, uuid: r.json.authUuid },
    });
    const l = await api('/api/auth/login', { method: 'POST', body: { qq, password: pw } });
    return { token: l.json.token, qq };
  };
  const suLogin = await mkUser(adminA);
  check('管理员A注册', suLogin.token?.length > 0, suLogin);
  const fcsu = await api('/internal/bot/fcsu', {
    method: 'POST',
    headers: { 'x-bot-secret': secret },
    body: { qq: adminA, self: true },
  });
  check('机器人自身任命 adminA 为 SU', fcsu.json.ok === true, fcsu.json);
  const fcsuDenied = await api('/internal/bot/fcsu', {
    method: 'POST',
    headers: { 'x-bot-secret': secret },
    body: { qq: adminA, operator: String(Number(adminA) + 1) },
  });
  check('非 SU 任命 SU 被拒', fcsuDenied.json.ok === false, fcsuDenied.json);

  const adminBUser = await mkUser(adminB);
  const fcadmin = await api('/internal/bot/fcadmin', {
    method: 'POST',
    headers: { 'x-bot-secret': secret },
    body: { operator: adminA, qq: adminB },
  });
  check('SU 任命 adminB 为管理员', fcadmin.json.ok === true, fcadmin.json);

  const adminCUser = await mkUser(String(rnd + 3));
  const fcadminDenied = await api('/internal/bot/fcadmin', {
    method: 'POST',
    headers: { 'x-bot-secret': secret },
    body: { operator: adminB, qq: adminCUser.qq },
  });
  check('Admin 任命被拒（无任命权限）', fcadminDenied.json.ok === false, fcadminDenied.json);

  const adminDUser = await mkUser(String(rnd + 4));
  const fcsuBySu = await api('/internal/bot/fcsu', {
    method: 'POST',
    headers: { 'x-bot-secret': secret },
    body: { operator: adminA, qq: adminDUser.qq },
  });
  check('SU 任命他人为 SU 成功', fcsuBySu.json.ok === true, fcsuBySu.json);

  console.log('== 多视频上传 / 审核 / 刊登 ==');
  const v1 = new TextEncoder().encode('fakedamage-video-0001');
  const v2 = new TextEncoder().encode('faketime-video-0002');

  const up1 = await uploadVideo(ownerToken, 'damage', v1, '伤害视频.mp4');
  check('上传 damage 视频（未齐）', up1.json.complete === false, up1.json);
  const up2 = await uploadVideo(ownerToken, 'time', v2, '耗时视频.mp4');
  check('上传 time 视频后 complete', up2.json.complete === true, up2.json);
  const sid = up2.json.submission?.id;

  // 再次尝试上传任意项 -> 应被 409 拦截（已有完整 pending）
  const dup = await uploadVideo(ownerToken, 'damage', v1, 'dup.mp4');
  check('已齐全时再传被拒(409)', dup.status === 409, dup);

  // 视频数量/可播放检查
  const detail = await api(`/api/submissions/${sid}`, { token: ownerToken });
  const files = detail.json?.submission?.files ?? {};
  check(
    '投稿详情含两个 raw 视频',
    !!files['damage'] && !!files['time'],
    detail.json?.submission
  );
  check(
    '视频条目带 transcode 状态（测试环境无 ffmpeg → off 原文件模式）',
    detail.json?.submission?.files?.damage?.transcode === 'off' &&
      detail.json?.submission?.files?.time?.transcode === 'off',
    detail.json?.submission?.files
  );
  const stream = await fetch(`${base}/api/submissions/${sid}/video/damage`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  check('damage 视频可读取', stream.status === 200, stream.status);

  const queue = await api('/api/staff/reviews', { token: suLogin.token });
  check('审核队列包含该投稿', queue.json.items?.some((x: { id: number }) => x.id === sid), queue.json);

  const rev1 = await api(`/api/staff/reviews/${sid}`, {
    method: 'POST',
    token: suLogin.token,
    body: { values: { damage: 220, time: 40 } },
  });
  check('第 1 审后 reviewCount=1', rev1.json.reviewCount === 1, rev1.json);
  check(
    '第 1 审即刊登快照（1 人直取 220/40）',
    rev1.json.snapshot?.damage === 220 && rev1.json.snapshot?.time === 40 && rev1.json.locked === false,
    rev1.json
  );
  // 1 审后投稿仍留在审核池（等补审），但已出现在榜单
  const queue1 = await api('/api/staff/reviews', { token: suLogin.token });
  const inQueue1 = queue1.json.items?.some(
    (x: { id: number; snapshot: unknown }) => x.id === sid && x.snapshot !== null
  );
  check('1 审后仍在审核池且带快照（等待补审）', inQueue1 === true, queue1.json);

  const rev2 = await api(`/api/staff/reviews/${sid}`, {
    method: 'POST',
    token: adminBUser.token,
    body: { values: { damage: 220, time: 41 } },
  });
  check('第 2 审', rev2.json.reviewCount === 2, rev2.json);
  check(
    '第 2 审后快照刷新（2 人相同则同值 / 平均）',
    rev2.json.snapshot?.damage === 220 && rev2.json.locked === false,
    rev2.json
  );

  const adminC = await mkUser(String(rnd + 5));
  await api('/internal/bot/fcadmin', {
    method: 'POST',
    headers: { 'x-bot-secret': secret },
    body: { operator: adminA, qq: adminC.qq },
  });
  const rev3 = await api(`/api/staff/reviews/${sid}`, {
    method: 'POST',
    token: adminC.token,
    body: { values: { damage: 219, time: 40 } },
  });
  check('第 3 审后定格（locked）', rev3.json.locked === true, rev3.json);
  check(
    '聚合结果为 220/40（众数）',
    rev3.json.snapshot?.damage === 220 && rev3.json.snapshot?.time === 40,
    rev3.json
  );

  const subInfo = await api(`/api/submissions/${sid}`, { token: ownerToken });
  check('投稿状态 published（满 3 审移出审核池）', subInfo.json.submission?.status === 'published', subInfo.json);

  const queueAfter = await api('/api/staff/reviews', { token: suLogin.token });
  check('满 3 审后从审核池移除', !queueAfter.json.items?.some((x: { id: number }) => x.id === sid), queueAfter.json);

  console.log('== 排行榜 ==');
  const board = await api('/api/leaderboard', { token: ownerToken });
  check('榜单有 1 条', board.json.rows?.length === 1, board.json);
  const row = board.json.rows?.[0];
  check('榜单第一名是玩家', row?.qq === owner, row);
  const d0 = row?.detail?.[0];
  check(
    '普通用户默认隐藏分项（detail 的 raw/score 为 null 且不可见）',
    d0 && d0.raw === null && d0.score === null && d0.rawVisible === false && d0.scoreVisible === false,
    row
  );
  const boardAdmin = await api('/api/leaderboard', { token: suLogin.token });
  const ad0 = boardAdmin.json.rows?.[0]?.detail?.[0];
  check('管理员可看全部 raw/scores', ad0 && ad0.raw !== null && ad0.score !== null, boardAdmin.json);
  check(
    '榜单标注 审核 3/3（三审刊登）',
    boardAdmin.json.rows?.[0]?.manual === false &&
      boardAdmin.json.rows?.[0]?.reviewCount === 3,
    boardAdmin.json.rows?.[0]
  );

  console.log('== 排行管理（SU）==');
  const nextCfg = {
    items: [
      { key: 'damage', label: '伤害量' },
      { key: 'time', label: '耗时', unit: '秒' },
    ],
    expressions: ['ln(d_1 + 1)', '-ln(d_2)'],
    visibility: { publicScores: [], publicRaw: [] },
  };
  const next = await api('/api/su/seasons/next', {
    method: 'POST',
    token: suLogin.token,
    body: { name: '第 2 期', config: nextCfg },
  });
  check('开启第 2 期（第 0 期被封存）', next.json.season?.status === 'active' && next.json.ok, next.json);

  const arch = await api('/api/leaderboard?seasonId=1', { token: ownerToken });
  const ar0 = arch.json.rows?.[0]?.detail?.[0];
  check(
    '封存期对普通用户全量公开 raw（detail raw/score 可见）',
    ar0 && ar0.raw !== null && ar0.rawVisible === true,
    arch.json
  );

  console.log('== 表达式扩展：raw key + max/min ==');
  const exprSeason = await api('/api/su/seasons/next', {
    method: 'POST',
    token: suLogin.token,
    body: {
      name: '第 3 期(表达式测试)',
      config: {
        items: [{ key: 'T', label: '耗时', unit: '秒' }],
        expressions: [
          '17378.01 * max(T, 50)^(-1.12) + 217.35 * (50 / min(T, 50))^1.01 - 188.70',
        ],
        visibility: { publicScores: [], publicRaw: [] },
      },
    },
  });
  check('含 raw key/max/min 的表达式建期成功', exprSeason.json.ok === true, exprSeason.json);
  check('第 3 期为 active', exprSeason.json.season?.status === 'active', exprSeason.json);

  console.log('== 管理员只有 2 人：仍以 3 审为目标，1/2 审也立即刊登快照 ==');
  // 有效管理员只剩 adminA(su) + adminDUser(su)：把 adminB/adminC 卸任
  const demoteB = await api(`/api/staff/users/${adminB}/role`, {
    method: 'PATCH',
    token: suLogin.token,
    body: { role: 'user' },
  });
  const demoteC = await api(`/api/staff/users/${adminC.qq}/role`, {
    method: 'PATCH',
    token: suLogin.token,
    body: { role: 'user' },
  });
  check('卸任两名管理员成功', demoteB.json.ok === true && demoteC.json.ok === true, demoteB.json);

  const upT = await uploadVideo(ownerToken, 'T', new TextEncoder().encode('video-t'), 'T.mp4');
  const sid3 = upT.json.submission?.id;
  check('第 3 期上传成功', !!sid3, upT.json);

  // 第 1 审：1 人就刊登快照（58），但未满 3 审不入终态
  const revA = await api(`/api/staff/reviews/${sid3}`, {
    method: 'POST',
    token: suLogin.token,
    body: { values: { T: 58 } },
  });
  check(
    '第 1 审即刊登（1 人直取 58，threshold=3）',
    revA.json.reviewCount === 1 &&
      revA.json.threshold === 3 &&
      revA.json.locked === false &&
      revA.json.snapshot?.T === 58,
    revA.json
  );
  // 第 2 审：adminDUser 审 62 → 平均 (58+62)/2 = 60，快照刷新
  const revD = await api(`/api/staff/reviews/${sid3}`, {
    method: 'POST',
    token: adminDUser.token,
    body: { values: { T: 62 } },
  });
  check('第 2 审后仍未定格（locked=false）', revD.json.locked === false && revD.json.reviewCount === 2, revD.json);
  check('两人审核取平均为 60', revD.json.snapshot?.T === 60, revD.json);

  const exprSeasonId = exprSeason.json.season?.id;
  const board2 = await api(`/api/leaderboard?seasonId=${exprSeasonId}`, { token: ownerToken });
  const row2 = board2.json.rows?.find((r: any) => r.qq === owner);
  check(
    '不足 3 审也刊登上榜，标注 审核 2/3',
    row2 && row2.reviewCount === 2 && row2.manual === false,
    row2
  );

  // 仍留在审核池等第 3 审
  const qMid = await api('/api/staff/reviews', { token: suLogin.token });
  const sid3InQueue = qMid.json.items?.some((x: { id: number; reviewCount: number }) => x.id === sid3 && x.reviewCount === 2);
  check('2/3 投稿仍在审核池等待补审', sid3InQueue === true, qMid.json);

  const q1 = await api('/api/staff/reviews', { token: suLogin.token });
  check('队列 threshold 恒为 3（不再按管理员数缩减）', q1.json.threshold === 3, q1.json);

  console.log('== 打回（作弊/无效） ==');
  // 再传一份：管理员 adminA 打回
  const upT2 = await uploadVideo(ownerToken, 'T', new TextEncoder().encode('cheat-video'), 'cheat.mp4');
  const sidRej = upT2.json.submission?.id;
  check('第 3 期再次上传成功', !!sidRej, upT2.json);
  // 作弊稿也带截图，验证打回时截图一并清除
  await api('/api/submissions/note-images?key=T', {
    method: 'POST',
    token: ownerToken,
    raw: new Blob([new TextEncoder().encode('fake-png-bytes-002')]),
    headers: { 'x-filename': encodeURIComponent('作弊截图.png') },
  });
  const rejectRes = await api(`/api/staff/submissions/${sidRej}/reject`, {
    method: 'POST',
    token: suLogin.token,
    body: { reason: '视频检测到剪辑，作弊无效' },
  });
  check('打回成功', rejectRes.json.ok === true, rejectRes.json);

  const mineAfter = await api('/api/submissions/mine', { token: ownerToken });
  const rej = mineAfter.json.submissions?.find((s: { id: number }) => s.id === sidRej);
  check(
    '我的投稿中该条状态为 rejected 且带原因',
    rej && rej.status === 'rejected' && String(rej.rejectReason).includes('作弊'),
    rej
  );
  check('打回后截图已清除', rej && rej.notes?.T?.images?.length === 0, rej?.notes);
  // 打回后（文件已删）可再次上传新视频
  const upT3 = await uploadVideo(ownerToken, 'T', new TextEncoder().encode('again-video'), 'again.mp4');
  check('打回后可以重新上传', upT3.json.complete === true, upT3.json);

  console.log('== 提交说明（可选文本 + 截图，仅审核员可见） ==');
  const sidNote = upT3.json.submission?.id;

  const noteText = await api('/api/submissions/note-text?key=T', {
    method: 'POST',
    token: ownerToken,
    body: { text: '测试说明：连续三刀命中，无剪辑' },
  });
  check('填写提交说明文本', noteText.json.ok === true && noteText.json.note?.text === '测试说明：连续三刀命中，无剪辑', noteText.json);

  const fakePng = new TextEncoder().encode('fake-png-bytes-001');
  const img1 = await api('/api/submissions/note-images?key=T', {
    method: 'POST',
    token: ownerToken,
    raw: new Blob([fakePng]),
    headers: { 'x-filename': encodeURIComponent('战斗截图1.png') },
  });
  check('上传提交截图（1 张）', img1.json.ok === true && img1.json.submission?.notes?.T?.images?.length === 1, img1.json);

  const badImg = await api('/api/submissions/note-images?key=T', {
    method: 'POST',
    token: ownerToken,
    raw: new Blob([fakePng]),
    headers: { 'x-filename': encodeURIComponent('evil.exe') },
  });
  check('非图片扩展名被拒', badImg.status === 400, badImg.json);

  const mineNote = await api('/api/submissions/mine', { token: ownerToken });
  const noteSub = mineNote.json.submissions?.find((s: { id: number }) => s.id === sidNote);
  check(
    'mine 返回提交说明（文本+截图摘要）',
    noteSub?.notes?.T?.text?.includes('三刀') && noteSub?.notes?.T?.images?.length === 1,
    noteSub?.notes
  );

  // 查看截图：本人 / 管理员
  const noteGetOwner = await fetch(`${base}/api/submissions/${sidNote}/note-images/T/0`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  check(
    '本人可查看截图',
    noteGetOwner.status === 200 && (noteGetOwner.headers.get('content-type') ?? '').includes('image/png'),
    noteGetOwner.status
  );
  const noteGetStaff = await fetch(`${base}/api/submissions/${sidNote}/note-images/T/0`, {
    headers: { authorization: `Bearer ${suLogin.token}` },
  });
  check('管理员可查看截图', noteGetStaff.status === 200, noteGetStaff.status);

  // 审核开始前可删除截图
  const delImg = await api(`/api/submissions/${sidNote}/note-images?key=T&index=0`, {
    method: 'DELETE',
    token: ownerToken,
  });
  check('审核前可删除截图', delImg.json.ok === true && delImg.json.submission?.notes?.T?.images?.length === 0, delImg.json);
  const img2 = await api('/api/submissions/note-images?key=T', {
    method: 'POST',
    token: ownerToken,
    raw: new Blob([fakePng]),
    headers: { 'x-filename': encodeURIComponent('战斗截图2.png') },
  });
  check('重新上传截图', img2.json.submission?.notes?.T?.images?.length === 1, img2.json);

  // 开始审核后：说明锁定（截图不可删），成绩不足 3 审仍刊登
  const revN1 = await api(`/api/staff/reviews/${sidNote}`, {
    method: 'POST',
    token: suLogin.token,
    body: { values: { T: 60 } },
  });
  check('投稿进入审核（1/3）', revN1.json.reviewCount === 1 && revN1.json.locked === false, revN1.json);
  const delLocked = await api(`/api/submissions/${sidNote}/note-images?key=T&index=0`, {
    method: 'DELETE',
    token: ownerToken,
  });
  check('审核开始后截图锁定不可删', delLocked.status === 409, delLocked.json);

  // 满 3 审后：截图即时删除、文本保留
  const restoreB = await api('/internal/bot/fcadmin', {
    method: 'POST',
    headers: { 'x-bot-secret': secret },
    body: { operator: adminA, qq: adminB },
  });
  check('恢复 adminB 管理员资格', restoreB.json.ok === true, restoreB.json);
  const revN2 = await api(`/api/staff/reviews/${sidNote}`, {
    method: 'POST',
    token: adminBUser.token,
    body: { values: { T: 62 } },
  });
  check('第 2 审（2/3）', revN2.json.reviewCount === 2 && revN2.json.locked === false, revN2.json);
  const revN3 = await api(`/api/staff/reviews/${sidNote}`, {
    method: 'POST',
    token: adminDUser.token,
    body: { values: { T: 61 } },
  });
  check(
    '第 3 审后定格（三值不同取最接近平均向下取整：60,61,62 等距 → 60）',
    revN3.json.locked === true && revN3.json.snapshot?.T === 60,
    revN3.json
  );

  const noteAfterPub = await api(`/api/submissions/${sidNote}`, { token: ownerToken });
  const noteAfter = noteAfterPub.json?.submission?.notes?.T;
  check(
    '定格后截图已删除、文本保留',
    noteAfter && noteAfter.images?.length === 0 && noteAfter.text?.includes('三刀'),
    noteAfter
  );
  const noteGone = await fetch(`${base}/api/submissions/${sidNote}/note-images/T/0`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  check('定格后截图文件已删除（404）', noteGone.status === 404, noteGone.status);

  console.log('== 视频查看模块（staff/media） ==');
  const media = await api(`/api/staff/media?seasonId=${exprSeasonId}`, { token: suLogin.token });
  const mediaIds = media.json.items?.map((x: { id: number }) => x.id) ?? [];
  check('staff 可读取视频查看列表', media.json.ok === true, media.json);
  const mPublished = media.json.items?.find((x: { id: number }) => x.id === sidNote);
  check(
    '含已刊登(3 审)投稿且视频可用',
    mPublished && mPublished.status === 'published' && mPublished.videoAvailable === true,
    mPublished
  );
  const mPending = media.json.items?.find((x: { id: number }) => x.id === sid3);
  check(
    '含审核中(2/3)投稿且视频可用',
    mPending && mPending.status === 'pending' && mPending.videoAvailable === true,
    mPending
  );
  check('打回稿件不出现在视频查看列表', !mediaIds.includes(sidRej), mediaIds);
  check(
    '视频条目带 transcode 标记（off）',
    mPublished?.files?.T?.transcode === 'off' && mPending?.files?.T?.transcode === 'off',
    mPending?.files
  );
  // 未转码时 /video/:key 仍可直读（原文件模式）
  const mediaStream = await fetch(`${base}/api/submissions/${sid3}/video/T`, {
    headers: { authorization: `Bearer ${suLogin.token}` },
  });
  check('原文件模式视频可读取', mediaStream.status === 200, mediaStream.status);
  const m3u8 = await fetch(`${base}/api/submissions/${sid3}/video/T/index.m3u8`, {
    headers: { authorization: `Bearer ${suLogin.token}` },
  });
  check('未转码时 HLS 播放列表返回 404', m3u8.status === 404, m3u8.status);

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
