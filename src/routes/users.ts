import { Elysia } from 'elysia';
import {
  findUserByQq,
  listUsers,
  deleteUser,
  setUserRole,
  findSeason,
  seasonConfig,
  upsertManualScore,
  deleteManualScore,
  listSubmissionsByUser,
  subFiles,
} from '../repo.js';
import { authUser, requireUser, roleRank } from '../auth.js';
import { badRequest, notFound, forbidden, conflict } from '../lib/errors.js';
import { toPublicUser } from '../auth.js';
import { deleteVideoFile } from '../lib/files.js';

function isStaff(u: import('../types.js').UserRow | null): boolean {
  return !!u && (u.role === 'admin' || u.role === 'su');
}

export const userAdminRoutes = new Elysia({ prefix: '/api/staff' })
  // ---------- 用户列表（管理员） ----------
  .get('/users', ({ query, headers }: any) => {
    const u = requireUser(authUser(headers));
    if (!isStaff(u)) throw forbidden('需要管理员权限');
    const q = String(query?.q ?? '').trim();
    return {
      ok: true,
      users: listUsers(q).map((user) => ({
        ...toPublicUser(user),
        // 附带：若该用户有 manual score 显示在哪个赛季
      })),
    };
  })

  // ---------- 任命 / 卸任管理员（仅 SU） ----------
  .patch('/users/:qq/role', async ({ params, body, headers }: any) => {
    const u = requireUser(authUser(headers));
    if (u.role !== 'su') throw forbidden('需要超级管理员权限');
    const target = findUserByQq(String(params.qq));
    if (!target) throw notFound('用户不存在');
    const role = String((body ?? {}).role ?? '');
    if (role !== 'admin' && role !== 'user') throw badRequest('角色只能是 admin 或 user');
    if (target.role === 'su') throw forbidden('不能修改超级管理员的角色');
    if (target.qq === u.qq) throw badRequest('不能修改自己的角色');
    setUserRole(target.qq, role as 'admin' | 'user');
    return { ok: true, user: toPublicUser(findUserByQq(target.qq)!) };
  })

  // ---------- 注销非管理员账号（管理员/SU） ----------
  .delete('/users/:qq', async ({ params, headers }: any) => {
    const u = requireUser(authUser(headers));
    if (!isStaff(u)) throw forbidden('需要管理员权限');
    const target = findUserByQq(String(params.qq));
    if (!target) throw notFound('用户不存在');
    if (roleRank(target.role) >= roleRank('admin')) throw forbidden('不能注销管理员账号');
    if (target.qq === u.qq) throw badRequest('不能注销自己的账号');

    // 清理其视频文件（多文件遍历）
    const subs = listSubmissionsByUser(target.qq);
    for (const s of subs) {
      const files = subFiles(s);
      for (const f of Object.values(files)) {
        if (f?.storedName) deleteVideoFile(s.seasonId, f.storedName);
      }
    }

    deleteUser(target.qq);
    return { ok: true };
  })

  // ---------- 手动更新用户分数（管理员/SU，只允许 active 赛季） ----------
  .put('/users/:qq/manual-score', async ({ params, body, headers }: any) => {
    const u = requireUser(authUser(headers));
    if (!isStaff(u)) throw forbidden('需要管理员权限');
    const target = findUserByQq(String(params.qq));
    if (!target) throw notFound('用户不存在');

    const seasonId = Number((body ?? {}).seasonId ?? 0);
    const season = findSeason(seasonId);
    if (!season) throw notFound('赛季不存在');
    if (season.status !== 'active') throw conflict('只能为进行中的赛季手动改分');

    const cfg = seasonConfig(season);
    const valuesRaw = (body ?? {}).values as Record<string, unknown> | undefined;
    if (!valuesRaw || typeof valuesRaw !== 'object') throw badRequest('请填写成绩数据');
    const values: Record<string, number> = {};
    for (const item of cfg.items) {
      const v = valuesRaw[item.key];
      const n = typeof v === 'string' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw badRequest(`请填写有效的「${item.label}」数值`);
      }
      values[item.key] = n;
    }

    upsertManualScore({
      seasonId: season.id,
      userQq: target.qq,
      values,
      note: typeof body?.note === 'string' && body.note ? String(body.note) : null,
      updatedBy: u.qq,
    });
    return { ok: true, seasonId: season.id, userQq: target.qq, values };
  })

  // ---------- 清除手动改分（恢复为审核数据） ----------
  .delete('/users/:qq/manual-score/:seasonId', async ({ params, headers }: any) => {
    const u = requireUser(authUser(headers));
    if (!isStaff(u)) throw forbidden('需要管理员权限');
    const target = findUserByQq(String(params.qq));
    if (!target) throw notFound('用户不存在');
    deleteManualScore(Number(params.seasonId), target.qq);
    return { ok: true };
  })

  // ---------- 查看某用户所有投稿（管理员辅助） ----------
  .get('/users/:qq/submissions', async ({ params, headers }: any) => {
    const u = requireUser(authUser(headers));
    if (!isStaff(u)) throw forbidden('需要管理员权限');
    const target = findUserByQq(String(params.qq));
    if (!target) throw notFound('用户不存在');
    const subs = listSubmissionsByUser(target.qq);
    return {
      ok: true,
      submissions: subs.map((s) => {
        const season = findSeason(s.seasonId);
        const files = subFiles(s);
        return {
          id: s.id,
          seasonId: s.seasonId,
          seasonName: season?.name ?? null,
          status: s.status,
          complete: s.complete === 1,
          files: Object.fromEntries(
            Object.entries(files).map(([k, f]) => [
              k,
              { originalName: f.originalName, sizeBytes: f.sizeBytes, available: !!f.storedName },
            ])
          ),
          values: s.valuesJson ? JSON.parse(s.valuesJson) : null,
          createdAt: s.createdAt,
          publishedAt: s.publishedAt,
          rejectedAt: s.rejectedAt,
          rejectReason: s.rejectReason,
          videoAvailable: Object.values(files).some((f) => f.storedName),
        };
      }),
    };
  });
