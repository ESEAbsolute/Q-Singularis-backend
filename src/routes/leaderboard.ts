import { Elysia } from 'elysia';
import { findSeason, activeSeason, seasonConfig } from '../repo.js';
import { authUser, requireUser } from '../auth.js';
import { forbidden } from '../lib/errors.js';
import { buildBoard } from '../lib/board.js';

export const leaderboardRoutes = new Elysia({ prefix: '/api' })
  // ---------- 指定期排行榜 ----------
  .get('/leaderboard', ({ query, headers }: any) => {
    const u = requireUser(authUser(headers));
    if (u.status !== 'verified') throw forbidden('请先完成 QQ 验证');
    const seasonId = Number(query?.seasonId ?? 0);
    const season = seasonId ? findSeason(seasonId) : activeSeason();
    if (!season) return { ok: true, season: null, rows: [] };
    const rows = buildBoard(season.id, u);
    const cfg = seasonConfig(season);
    return {
      ok: true,
      season: {
        id: season.id,
        name: season.name,
        status: season.status,
        archivedAt: season.archivedAt,
        items: cfg.items,
      },
      me: u.qq,
      rows,
    };
  })

  // ---------- 我的成绩（各期） ----------
  .get('/leaderboard/mine', ({ headers }: any) => {
    const u = requireUser(authUser(headers));
    if (u.status !== 'verified') throw forbidden('请先完成 QQ 验证');
    return { ok: true };
  });
