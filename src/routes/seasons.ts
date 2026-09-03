import { Elysia } from 'elysia';
import {
  listSeasons,
  findSeason,
  activeSeason,
  seasonConfig,
  archiveActiveAndOpenNext,
  updateSeasonConfig,
} from '../repo.js';
import { authUser, requireUser } from '../auth.js';
import { validateSeasonConfig } from '../lib/seasonConfig.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';
import type { SeasonRow, SeasonConfig, UserRow } from '../types.js';

/** 是否管理员以上 */
function isStaff(u: UserRow | null): boolean {
  return !!u && (u.role === 'admin' || u.role === 'su');
}

/** 赛季元数据（按角色裁剪）：普通用户不暴露表达式 */
function seasonMeta(s: SeasonRow, u: UserRow | null, full: boolean) {
  const cfg = seasonConfig(s);
  const staff = isStaff(u);
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    createdAt: s.createdAt,
    archivedAt: s.archivedAt,
    items: cfg.items,
    expressions: staff || full ? cfg.expressions : undefined,
    visibility: cfg.visibility,
  };
}

export const seasonRoutes = new Elysia({ prefix: '/api' })
  // ---------- 赛季列表（登录用户可见） ----------
  .get('/seasons', ({ headers }: any) => {
    const u = authUser(headers);
    return { ok: true, seasons: listSeasons().map((s) => seasonMeta(s, u, false)) };
  })

  .get('/seasons/active', ({ headers }: any) => {
    const u = authUser(headers);
    const s = activeSeason();
    if (!s) return { ok: true, season: null };
    return { ok: true, season: seasonMeta(s, u, false) };
  })

  // ---------- 赛季详情 ----------
  .get('/seasons/:id', ({ params, headers }: any) => {
    const u = authUser(headers);
    const s = findSeason(Number(params.id));
    if (!s) throw notFound('赛季不存在');
    return { ok: true, season: seasonMeta(s, u, false) };
  });

// ===========================================================================
// 管理员：查看/编辑赛季详情（含表达式）
// ===========================================================================
export const staffSeasonRoutes = new Elysia({ prefix: '/api/staff' })
  .get('/seasons', ({ headers }: any) => {
    const u = requireUser(authUser(headers));
    if (!isStaff(u)) throw forbidden();
    return { ok: true, seasons: listSeasons().map((s) => seasonMeta(s, u, true)) };
  })
  .get('/seasons/:id', ({ params, headers }: any) => {
    const u = requireUser(authUser(headers));
    if (!isStaff(u)) throw forbidden();
    const s = findSeason(Number(params.id));
    if (!s) throw notFound('赛季不存在');
    return { ok: true, season: seasonMeta(s, u, true) };
  });

// ===========================================================================
// 超级管理员：排行管理（封存并开启下一期 / 编辑配置）
// ===========================================================================
export const suSeasonRoutes = new Elysia({ prefix: '/api/su' })
  // ---------- 封存当前期并开启下一期 ----------
  .post('/seasons/next', async ({ body, headers }: any) => {
    const u = requireUser(authUser(headers));
    if (u.role !== 'su') throw forbidden('需要超级管理员权限');
    const name = String((body ?? {}).name ?? '').trim();
    if (!name || name.length > 64) throw badRequest('请输入赛季名称');
    const config = validateSeasonConfig((body ?? {}).config);
    const s = archiveActiveAndOpenNext(name, config);
    return { ok: true, season: seasonMeta(s, u, true) };
  })

  // ---------- 修改某期配置（仅 active；表达式/可见性可中途修改，已有投稿时 raw 结构锁定） ----------
  // body: { config: 部分或完整的 SeasonConfig } —— 缺失字段沿用原值
  .put('/seasons/:id/config', async ({ params, body, headers }: any) => {
    const u = requireUser(authUser(headers));
    if (u.role !== 'su') throw forbidden('需要超级管理员权限');
    const s = findSeason(Number(params.id));
    if (!s) throw notFound('赛季不存在');
    if (s.status !== 'active') throw forbidden('只有进行中的赛季可以修改规则配置');

    const oldCfg = seasonConfig(s);
    const patch = ((body ?? {}).config ?? {}) as Partial<SeasonConfig>;
    const merged: SeasonConfig = {
      items: patch.items ?? oldCfg.items,
      expressions: patch.expressions ?? oldCfg.expressions,
      visibility: patch.visibility ?? oldCfg.visibility,
    };
    const incoming = validateSeasonConfig(merged);

    // 说明信息：哪些变了
    const changed: string[] = [];
    if (JSON.stringify(oldCfg.expressions) !== JSON.stringify(incoming.expressions)) {
      changed.push('表达式');
    }
    if (JSON.stringify(oldCfg.visibility) !== JSON.stringify(incoming.visibility)) {
      changed.push('可见性');
    }
    if (
      JSON.stringify(oldCfg.items.map((i) => [i.key, i.label, i.unit ?? ''])) !==
      JSON.stringify(incoming.items.map((i) => [i.key, i.label, i.unit ?? '']))
    ) {
      changed.push('字段定义');
    }

    updateSeasonConfig(s.id, incoming);
    const message =
      changed.length === 0
        ? '赛季配置无变化'
        : `赛季配置已更新（${changed.join('、')}）` +
          (changed.includes('表达式') ? '；已刊登成绩将按新公式即时重算' : '');
    return { ok: true, message, season: seasonMeta(findSeason(s.id)!, u, true) };
  });
