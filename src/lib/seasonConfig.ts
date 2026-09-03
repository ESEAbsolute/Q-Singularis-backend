import { validateExpressions } from './scoring.js';
import type { SeasonConfig, RawItemDef } from '../types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const RAW_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

/** 校验 season config 结构 */
export function validateSeasonConfig(cfg: unknown): SeasonConfig {
  if (!cfg || typeof cfg !== 'object') throw new ConfigError('配置必须是对象');
  const c = cfg as Partial<SeasonConfig>;

  if (!Array.isArray(c.items) || c.items.length < 1) throw new ConfigError('raw data 项不能为空');
  if (!Array.isArray(c.expressions) || c.expressions.length !== c.items.length) {
    throw new ConfigError('表达式数量必须与 raw data 项数量一致');
  }

  const seen = new Set<string>();
  const items: RawItemDef[] = (c.items as unknown[]).map((it, i) => {
    if (!it || typeof it !== 'object') throw new ConfigError(`第 ${i + 1} 项定义无效`);
    const key = String((it as RawItemDef).key ?? '');
    if (!RAW_KEY.test(key)) throw new ConfigError(`第 ${i + 1} 项 key 非法: "${key}"`);
    if (seen.has(key)) throw new ConfigError(`raw data key 重复: "${key}"`);
    seen.add(key);
    return {
      key,
      label: String((it as RawItemDef).label ?? key),
      unit: (it as RawItemDef).unit != null ? String((it as RawItemDef).unit) : undefined,
    };
  });

  const expressions = (c.expressions as unknown[]).map((e, i) => {
    if (typeof e !== 'string' || e.trim() === '')
      throw new ConfigError(`第 ${i + 1} 个表达式为空`);
    return e.trim();
  });

  // 通过引擎预检语法 / 循环 / 越界引用（raw key 可被表达式直接引用，如 max(T, 50)）
  try {
    validateExpressions(expressions, items.length, items.map((it) => it.key));
  } catch (e) {
    throw new ConfigError(`表达式不合法: ${(e as Error).message}`);
  }

  const vis = (c.visibility ?? {}) as Partial<SeasonConfig['visibility']>;
  const publicScores = Array.isArray(vis.publicScores) ? vis.publicScores.map(String) : [];
  const publicRaw = Array.isArray(vis.publicRaw) ? vis.publicRaw.map(String) : [];
  for (const k of [...publicScores, ...publicRaw]) {
    if (!seen.has(k)) throw new ConfigError(`可见性引用了不存在的字段 "${k}"`);
  }

  return { items, expressions, visibility: { publicScores, publicRaw } };
}

/** 生成一个带基本校验的赛季配置对象（供界面回填） */
export function normalizeSeasonConfig(cfg: SeasonConfig): SeasonConfig {
  return validateSeasonConfig(cfg);
}
