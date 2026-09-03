import { Elysia } from 'elysia';
import {
  findUserByQq,
  findUserByAuthUuid,
  setUserVerified,
  setUserRole,
} from '../repo.js';
import { checkBotSecret } from '../auth.js';
import { env } from '../env.js';
import { now, db } from '../db.js';
import { badRequest } from '../lib/errors.js';

/**
 * QQ 机器人回调接口。
 * 所有请求需带请求头 X-Bot-Secret（与后端 BOT_SECRET 一致）。
 *
 * 任命类指令（#FCSU / #FCAdmin）权限模型：
 *   - 消息发送者 == 机器人自身 QQ（机器人已用 get_login_info/BOT_SELF_QQ 确认，
 *     请求里带 self: true）→ 视为运营主控，可任命任意角色；
 *   - 否则发送者必须是已认证的 SU（operator 字段）→ 可任命他人为 SU / Admin；
 *   - Admin 无任何任命权限（后端会拒绝）。
 */
export const botRoutes = new Elysia({ prefix: '/internal/bot' })
  // ---------- #QSAuth uuid：验证注册账号 ----------
  // 机器人收到群内 #QSAuth <uuid> 后调用；sender 即发送者 QQ。
  // 语义：
  //   - 找到该 uuid 的待验证账号，且发送者 QQ == 注册 QQ → 验证成功
  //   - 否则不响应（机器人应保持沉默，防枚举）
  .post('/verify', async ({ body, headers }: any) => {
    checkBotSecret(headers, env.botSecret);
    const { qq, uuid } = (body ?? {}) as { qq?: string; uuid?: string };
    if (!qq || !uuid) throw badRequest('缺少参数');

    const user = findUserByAuthUuid(uuid);
    if (!user) {
      return { ok: false, code: 'not_found', reply: null };
    }
    if (user.qq !== qq) {
      return { ok: false, code: 'qq_mismatch', reply: null };
    }
    if (user.createdAt + env.verifyTtlMs < now()) {
      // 过期但清理任务尚未删除：删除并当作不存在
      db.prepare('DELETE FROM users WHERE qq = ?').run(user.qq);
      return { ok: false, code: 'expired', reply: '验证码已过期，请重新注册' };
    }
    setUserVerified(user.qq);
    return { ok: true, code: 'verified', reply: 'QQ 验证成功！欢迎加入 Q-Singularis 🎀' };
  })

  // ---------- #FCSU <QQ>：任命超级管理员 ----------
  // 来源可为：机器人自身消息（self: true）或现任 SU（operator 字段）
  .post('/fcsu', async ({ body, headers }: any) => {
    checkBotSecret(headers, env.botSecret);
    const { qq, self, operator } = (body ?? {}) as {
      qq?: string;
      self?: boolean;
      operator?: string;
    };
    if (!qq) throw badRequest('缺少参数');

    // 校验操作者：机器人自身消息 → 放行；否则必须为已认证 SU
    if (!self) {
      if (!operator) throw badRequest('缺少 operator（非自身消息必须由 SU 发送）');
      const op = findUserByQq(operator);
      if (!op || op.role !== 'su' || op.status !== 'verified') {
        return { ok: false, reply: '仅超级管理员（或机器人自身）可以任命超级管理员' };
      }
    }

    const target = findUserByQq(qq);
    if (!target) {
      return { ok: false, reply: `该 QQ（${qq}）尚未在网站注册，无法任命为超级管理员` };
    }
    setUserRole(qq, 'su');
    return { ok: true, reply: `已将 ${qq} 任命为超级管理员 🎀` };
  })

  // ---------- #FCAdmin <QQ>：任命管理员 ----------
  // 来源可为：机器人自身消息（self: true）或现任 SU（operator 字段）
  .post('/fcadmin', async ({ body, headers }: any) => {
    checkBotSecret(headers, env.botSecret);
    const { qq, self, operator } = (body ?? {}) as {
      qq?: string;
      self?: boolean;
      operator?: string;
    };
    if (!qq) throw badRequest('缺少参数');

    if (!self) {
      if (!operator) throw badRequest('缺少 operator（非自身消息必须由 SU 发送）');
      const op = findUserByQq(operator);
      if (!op || op.role !== 'su' || op.status !== 'verified') {
        return { ok: false, reply: '仅超级管理员（或机器人自身）可以任命管理员' };
      }
    }

    const target = findUserByQq(qq);
    if (!target) {
      return { ok: false, reply: `该 QQ（${qq}）尚未在网站注册，无法任命为管理员` };
    }
    setUserRole(qq, 'admin');
    return { ok: true, reply: `已将 ${qq} 任命为管理员 🎀` };
  });
