import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt 密码哈希，格式: salt:hash (hex) */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const idx = stored.indexOf(':');
  if (idx < 0) return false;
  const salt = Buffer.from(stored.slice(0, idx), 'hex');
  const expected = Buffer.from(stored.slice(idx + 1), 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function randomUuid(): string {
  return randomBytes(16).toString('hex');
}
