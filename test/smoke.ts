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
  check('第 1 审', rev1.json.reviewCount === 1, rev1.json);
  const rev2 = await api(`/api/staff/reviews/${sid}`, {
    method: 'POST',
    token: adminBUser.token,
    body: { values: { damage: 220, time: 41 } },
  });
  check('第 2 审', rev2.json.reviewCount === 2, rev2.json);

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
  check('第 3 审后刊登', rev3.json.published === true, rev3.json);
  check(
    '聚合结果为 220/40（众数）',
    rev3.json.publishedValues?.damage === 220 && rev3.json.publishedValues?.time === 40,
    rev3.json
  );

  const subInfo = await api(`/api/submissions/${sid}`, { token: ownerToken });
  check('投稿状态 published', subInfo.json.submission?.status === 'published', subInfo.json);

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

  console.log('== 有效管理员不足 3 人：1 审即刊登 ==');
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
  const soloReview = await api(`/api/staff/reviews/${sid3}`, {
    method: 'POST',
    token: suLogin.token,
    body: { values: { T: 60 } },
  });
  check('仅 1 名管理员审核即刊登(threshold=1)', soloReview.json.published === true && soloReview.json.threshold === 1, soloReview.json);
  check('刊登聚合值为 60', soloReview.json.publishedValues?.T === 60, soloReview.json);

  console.log('== 打回（作弊/无效） ==');
  // 再传一份：管理员 adminA 打回
  const upT2 = await uploadVideo(ownerToken, 'T', new TextEncoder().encode('cheat-video'), 'cheat.mp4');
  const sidRej = upT2.json.submission?.id;
  check('第 3 期再次上传成功', !!sidRej, upT2.json);
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
  // 打回后（文件已删）可再次上传新视频
  const upT3 = await uploadVideo(ownerToken, 'T', new TextEncoder().encode('again-video'), 'again.mp4');
  check('打回后可以重新上传', upT3.json.complete === true, upT3.json);

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
