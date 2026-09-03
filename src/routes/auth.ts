import { Elysia } from 'elysia';
import {
  createUser,
  findUserByQq,
  createSession,
  deleteSession,
  setUserGameId,
} from '../repo.js';
import { verifyPassword, hashPassword } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { env } from '../env.js';
import { now, db } from '../db.js';
import { authUser, requireUser, toPublicUser } from '../auth.js';

const QQ_RE = /^[1-9]\d{4,11}$/;

export const authRoutes = new Elysia({ prefix: '/api/auth' })
  // ---------- 注册 ----------
  .post('/register', async ({ body }: any) => {
    const { qq, password } = (body ?? {}) as { qq?: string; password?: string };
    if (!QQ_RE.test(qq ?? '')) throw badRequest('QQ 号格式不正确');
    if (typeof password !== 'string' || password.length < 6 || password.length > 128)
      throw badRequest('密码长度需为 6-128 位');

    const existing = findUserByQq(qq!);
    if (existing) {
      if (existing.status === 'verified') throw conflict('该 QQ 已注册，请直接登录');
      // 未验证但还在有效期内：返回原 uuid 供再次展示
      if (existing.createdAt + env.verifyTtlMs > now()) {
        return {
          ok: true,
          registered: true,
          qq,
          authUuid: existing.authUuid,
          ttlMs: env.verifyTtlMs,
        };
      }
      // 过期未验证：先删除再重新注册
      db.prepare('DELETE FROM users WHERE qq = ?').run(qq!);
    }
    const user = createUser(qq!, password);
    const token = createSession(user.qq);
    return {
      ok: true,
      registered: false,
      token,
      authUuid: user.authUuid,
      ttlMs: env.verifyTtlMs,
      user: toPublicUser(user),
    };
  })

  // ---------- 登录 ----------
  .post('/login', async ({ body }: any) => {
    const { qq, password } = (body ?? {}) as { qq?: string; password?: string };
    if (!qq || typeof password !== 'string') throw badRequest('QQ 或密码未填写');
    const user = findUserByQq(qq);
    if (!user || !verifyPassword(password, user.passwordHash))
      throw unauthorized('QQ 或密码错误');
    const token = createSession(user.qq);
    return { ok: true, token, user: toPublicUser(user) };
  })

  // ---------- 当前用户 ----------
  .get('/me', ({ headers }: any) => {
    const u = authUser(headers);
    if (!u) throw unauthorized();
    return {
      ok: true,
      user: toPublicUser(u),
      authUuid: u.status === 'unverified' ? u.authUuid : null,
    };
  })

  // ---------- 登出 ----------
  .post('/logout', ({ headers }: any) => {
    const token = requireAuthToken(headers);
    if (token) deleteSession(token);
    return { ok: true };
  });

function requireAuthToken(headers: Record<string, string | undefined>): string | null {
  const h = headers['authorization'] ?? headers['Authorization'];
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

// ===========================================================================
// 个人资料 /api/me/*
// ===========================================================================
export const meRoutes = new Elysia({ prefix: '/api/me' })
  .patch('/game-id', async ({ headers, body }: any) => {
    const u = requireUser(authUser(headers));
    if (u.status !== 'verified') throw forbidden('请先完成 QQ 验证');
    const gameId = String((body ?? {}).gameId ?? '').trim();
    if (!gameId || gameId.length > 64) throw badRequest('游戏ID不能为空且不超过 64 字符');
    setUserGameId(u.qq, gameId);
    return { ok: true, user: toPublicUser(findUserByQq(u.qq)!) };
  })

  .patch('/password', async ({ headers, body }: any) => {
    const u = requireUser(authUser(headers));
    const { oldPassword, newPassword } = (body ?? {}) as { oldPassword?: string; newPassword?: string };
    if (!verifyPassword(String(oldPassword ?? ''), u.passwordHash))
      throw badRequest('旧密码错误');
    if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128)
      throw badRequest('新密码长度需为 6-128 位');
    db.prepare('UPDATE users SET password_hash = ? WHERE qq = ?').run(
      hashPassword(newPassword),
      u.qq
    );
    return { ok: true };
  });
