import type { UserRow } from './types.js';
import { findUserByQq, findSession, publicUser } from './repo.js';
import { HttpError, unauthorized, forbidden } from './lib/errors.js';
import { db } from './db.js';

export type Headers = Record<string, string | undefined>;

/** 从 Authorization: Bearer xxx 取 token */
export function bearerToken(headers: Headers): string | null {
  const h = headers['authorization'] ?? headers['Authorization'];
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

/** 读取当前用户（未登录返回 null） */
export function authUser(headers: Headers): UserRow | null {
  const token = bearerToken(headers);
  if (!token) return null;
  const sess = findSession(token);
  if (!sess) return null;
  return findUserByQq(sess.qq);
}

/** 必须已登录 */
export function requireUser(u: UserRow | null): UserRow {
  if (!u) throw unauthorized();
  return u;
}

/** 必须已通过 QQ 验证（能看任何内容的前提） */
export function requireVerifiedUser(u: UserRow | null): UserRow {
  const user = requireUser(u);
  if (user.status !== 'verified') throw forbidden('账号尚未完成 QQ 验证');
  return user;
}

/** 必须为 admin / su */
export function requireAdmin(u: UserRow | null): UserRow {
  const user = requireVerifiedUser(u);
  if (user.role !== 'admin' && user.role !== 'su') throw forbidden('需要管理员权限');
  return user;
}

/** 必须为 su */
export function requireSu(u: UserRow | null): UserRow {
  const user = requireVerifiedUser(u);
  if (user.role !== 'su') throw forbidden('需要超级管理员权限');
  return user;
}

/** role 比较：su > admin > user */
export function roleRank(role: UserRow['role']): number {
  if (role === 'su') return 3;
  if (role === 'admin') return 2;
  return 1;
}

/** 公开的用户信息（不含密码） */
export function toPublicUser(u: UserRow) {
  return publicUser(u);
}

/** 供内部机器人端点使用的共享密钥校验 */
export function checkBotSecret(headers: Headers, secret: string): void {
  const provided = headers['x-bot-secret'] ?? headers['x-qs-secret'] ?? headers['x-bot-token'];
  if (!secret || provided !== secret) {
    throw new HttpError(403, '机器人密钥无效');
  }
}

/** 数据库健康检查用的简单查询 */
export function dbHealth(): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}
