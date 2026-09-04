import { Elysia } from 'elysia';
import { node } from '@elysia/node';
import { env } from './env.js';
import { runCleanup } from './cron.js';
import { runTranscodeTick } from './transcodeWorker.js';
import { HttpError } from './lib/errors.js';
import { authRoutes, meRoutes } from './routes/auth.js';
import { seasonRoutes, staffSeasonRoutes, suSeasonRoutes } from './routes/seasons.js';
import { submissionRoutes } from './routes/submissions.js';
import { reviewRoutes } from './routes/reviews.js';
import { userAdminRoutes } from './routes/users.js';
import { botRoutes } from './routes/bot.js';
import { leaderboardRoutes } from './routes/leaderboard.js';

function corsHeaders(origin: string | undefined | null): Record<string, string> {
  const allow =
    env.corsOrigins.includes('*') || (origin && env.corsOrigins.includes(origin))
      ? origin ?? '*'
      : env.corsOrigins[0] ?? '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Filename, X-Bot-Secret, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const app = new Elysia({ adapter: node() })
  .onRequest(({ request, set }: any) => {
    const origin = request.headers.get('origin');
    // 预检：必须显式携带 CORS 头（不能依赖 set.headers —— 显式返回 Response 时它不生效）
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }
  })
  .onAfterHandle(({ request, set }: any) => {
    const origin = request.headers.get('origin');
    const cors = corsHeaders(origin);
    for (const [k, v] of Object.entries(cors)) set.headers[k] = v;
  })
  .onError(({ code, error, request, set }: any) => {
    // 错误响应也要带 CORS 头，否则浏览器把错误吞成 "Failed to fetch"
    const origin = request?.headers?.get?.('origin');
    const cors = corsHeaders(origin);
    for (const [k, v] of Object.entries(cors)) set.headers[k] = v;
    // 自定义业务错误
    if (error instanceof HttpError) {
      set.status = error.status;
      return { ok: false, error: error.message };
    }
    // 规则/配置类错误：用户提交的表达式等不合法，应返回 400 且前端可见
    if (error?.name === 'ConfigError' || error?.name === 'ScoringError') {
      set.status = 400;
      return { ok: false, error: error.message };
    }
    // Elysia 路由未匹配
    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { ok: false, error: '接口不存在' };
    }
    if (code === 'VALIDATION') {
      set.status = 400;
      return { ok: false, error: '请求参数不合法' };
    }
    // 其它（500）
    console.error('[server error]', error);
    set.status = 500;
    return { ok: false, error: '服务器内部错误' };
  })

  // 业务路由
  .use(authRoutes)
  .use(meRoutes)
  .use(seasonRoutes)
  .use(staffSeasonRoutes)
  .use(suSeasonRoutes)
  .use(submissionRoutes)
  .use(reviewRoutes)
  .use(userAdminRoutes)
  .use(leaderboardRoutes)

  // 机器人内部接口
  .use(botRoutes)

  // 健康检查
  .get('/healthz', () => ({ ok: true, time: Date.now() }));

// 周期任务：清理未验证账号 / 过期会话 / 过期视频文件
setInterval(() => {
  runCleanup().catch((e) => console.error('[cleanup error]', e));
}, 60_000);

// 周期任务：后台视频转码（压制 + HLS 切片），单实例执行
setInterval(() => {
  runTranscodeTick().catch((e) => console.error('[transcode error]', e));
}, 10_000);

app.listen({ port: env.port, hostname: env.host }, () => {
  console.log(`Q-Singularis backend listening on http://${env.host}:${env.port}`);
});
