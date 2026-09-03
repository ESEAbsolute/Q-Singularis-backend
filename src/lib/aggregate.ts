// ===========================================================================
// 审核聚合规则：同一视频被 3 位管理员审核后，按「出现最多的数据」刊登。
//   例：伤害 220 220 219 -> 220（众数）；耗时 40 41 40 -> 40
// 若某一项三个值都不同，则取「最接近的两者」的平均值并向下取整：
//   例：伤害 215 220 221 -> 最接近 220 与 221，平均 220.5 向下取整 = 220
//       耗时 40 45 39  -> 最接近 39 与 40，平均 39.5 向下取整 = 39
// 每个 raw 字段独立聚合。
// ===========================================================================

export class AggregateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AggregateError';
  }
}

/** 对一个字段的 3 个审核值做聚合（模式优先，否则最接近两值的平均向下取整） */
export function aggregateField(values: number[]): number {
  if (values.length === 0) throw new AggregateError('没有可用的审核值');
  if (values.length === 1) return values[0];
  if (values.length === 2) return values[0] === values[1] ? values[0] : Math.floor((values[0] + values[1]) / 2);

  // 出现次数统计（众数）
  const freq = new Map<number, number>();
  for (const v of values) freq.set(v, (freq.get(v) ?? 0) + 1);
  let modeVal: number | null = null;
  let modeCount = 0;
  for (const [v, c] of freq) {
    if (c > modeCount) {
      modeCount = c;
      modeVal = v;
    }
  }
  // 若存在众数且出现 >=2 次：直接采用
  if (modeCount >= 2 && modeVal !== null) return modeVal;

  // 全部不同：找差值最小的一对，平均后向下取整
  const sorted = [...values].sort((a, b) => a - b);
  let bestPair: [number, number] = [sorted[0], sorted[1]];
  let bestDiff = Math.abs(bestPair[0] - bestPair[1]);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const diff = Math.abs(sorted[i] - sorted[j]);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestPair = [sorted[i], sorted[j]];
      }
    }
  }
  return Math.floor((bestPair[0] + bestPair[1]) / 2);
}

/**
 * 按 raw 字段 key 聚合多份审核。
 * @param reviews 每份审核的 {key: number} 数据
 * @param keys    参与聚合的字段（通常为赛季 items 的 key）
 * @returns 聚合后的 {key: number}
 */
export function aggregateReviews(
  reviews: Record<string, number>[],
  keys: string[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) {
    const vals = reviews
      .map((r) => r[key])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (vals.length < 1) throw new AggregateError(`字段 "${key}" 缺少审核数值`);
    out[key] = aggregateField(vals);
  }
  return out;
}
