// 角色与状态的常量定义
export const ROLES = ['user', 'admin', 'su'] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUS = ['unverified', 'verified'] as const;
export type UserStatus = (typeof USER_STATUS)[number];

export const SEASON_STATUS = ['active', 'archived'] as const;
export type SeasonStatus = (typeof SEASON_STATUS)[number];

export const SUB_STATUS = ['pending', 'published', 'replaced', 'rejected'] as const;
export type SubStatus = (typeof SUB_STATUS)[number];

/** submission 中的一个视频文件 */
export interface SubFile {
  originalName: string | null;
  storedName: string;
  sizeBytes: number;
}

/** files_json：rawKey → 视频文件；旧版迁移数据使用 "*" key */
export type SubFiles = Record<string, SubFile>;

/** 一个 raw data 字段定义（本期两个：伤害量、耗时） */
export interface RawItemDef {
  key: string;
  label: string;
  unit?: string;
}

export interface SeasonVisibility {
  /** 对普通用户可见的 sc 分项 key 列表 */
  publicScores: string[];
  /** 对普通用户可见的 raw 值 key 列表 */
  publicRaw: string[];
}

/** 赛季规则配置（数据驱动） */
export interface SeasonConfig {
  /** raw data 项，顺序即 d_1..d_N */
  items: RawItemDef[];
  /** 每项对应的分数表达式，sc_1..sc_N；可引用任意 d_n/sc_n */
  expressions: string[];
  /** 普通用户可见性配置（仅 active 期生效；archived 期全量公开） */
  visibility: SeasonVisibility;
}

export interface SeasonRow {
  id: number;
  name: string;
  status: SeasonStatus;
  config: string; // JSON
  createdAt: number;
  archivedAt: number | null;
}

export interface UserRow {
  qq: string;
  passwordHash: string;
  role: Role;
  status: UserStatus;
  gameId: string | null;
  authUuid: string | null;
  createdAt: number;
  verifiedAt: number | null;
}

export interface SubmissionRow {
  id: number;
  seasonId: number;
  userQq: string;
  status: SubStatus;
  complete: number; // 0/1：全部 raw 项的视频是否已传齐
  filesJson: string | null; // {"rawKey": {originalName,storedName,sizeBytes}}
  valuesJson: string | null; // 发布后聚合的 raw 值 {key: number}
  createdAt: number;
  publishedAt: number | null;
  rejectedAt: number | null;
  rejectedBy: string | null;
  rejectReason: string | null;
}

export interface ReviewRow {
  id: number;
  submissionId: number;
  reviewerQq: string;
  valuesJson: string;
  comment: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ManualScoreRow {
  seasonId: number;
  userQq: string;
  valuesJson: string;
  note: string | null;
  updatedBy: string;
  updatedAt: number;
}

export interface SessionRow {
  token: string;
  qq: string;
  createdAt: number;
  expiresAt: number;
}
