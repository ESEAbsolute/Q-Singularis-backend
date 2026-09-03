import { findSeason, seasonConfig, assembleBoard, rankBoard, findUserByQq } from '../repo.js';
import { fmt1 } from './scoring.js';
import type { SeasonConfig, SeasonRow, UserRow } from '../types.js';

export interface BoardDetailItem {
  key: string;
  label: string;
  unit?: string;
  /** raw 值（对普通用户仅当可见才返回） */
  raw: number | null;
  /** sc_i 分（对普通用户仅当可见才返回） */
  score: number | null;
  rawVisible: boolean;
  scoreVisible: boolean;
}

export interface BoardRow {
  rank: number;
  qq: string;
  gameId: string | null;
  total: number; // 精确总分
  totalDisplay: string; // 保留一位小数展示
  manual: boolean;
  /** 分项明细（raw 与 score 是否给出取决于可见性） */
  detail: BoardDetailItem[];
}

function buildRow(
  rank: number,
  qq: string,
  gameId: string | null,
  total: number,
  manual: boolean,
  cfg: SeasonConfig,
  rawValues: Record<string, number>,
  scores: number[],
  fullVisible: boolean,
  publicRaw: Set<string>,
  publicScores: Set<string>
): BoardRow {
  const detail: BoardDetailItem[] = cfg.items.map((item, i) => {
    const rawVisible = fullVisible || publicRaw.has(item.key);
    const scoreVisible = fullVisible || publicScores.has(item.key);
    return {
      key: item.key,
      label: item.label,
      unit: item.unit,
      raw: rawVisible ? (rawValues[item.key] ?? null) : null,
      score: scoreVisible ? (scores[i] ?? null) : null,
      rawVisible,
      scoreVisible,
    };
  });
  return {
    rank,
    qq,
    gameId,
    total,
    totalDisplay: fmt1(total),
    manual,
    detail,
  };
}

/**
 * 组织榜单。
 * archived 期对普通用户全量公开；active 期按赛季 visibility 裁剪。
 * admin/su 始终全量。
 */
export function buildBoard(seasonId: number, viewer: UserRow | null): BoardRow[] {
  const season = findSeason(seasonId);
  if (!season) throw new Error('赛季不存在');
  const cfg = seasonConfig(season);
  const isStaff = !!viewer && (viewer.role === 'admin' || viewer.role === 'su');
  const archived = season.status === 'archived';

  const candidates = assembleBoard(seasonId);
  const ranked = rankBoard(candidates);

  const publicRaw = new Set(cfg.visibility.publicRaw);
  const publicScores = new Set(cfg.visibility.publicScores);
  const fullVisible = isStaff || archived;

  return ranked.map((r) => {
    const user = findUserByQq(r.userQq);
    return buildRow(
      r.rank,
      r.userQq,
      user?.gameId ?? null,
      r.total,
      r.manual,
      cfg,
      r.values,
      r.scores,
      fullVisible,
      publicRaw,
      publicScores
    );
  });
}
