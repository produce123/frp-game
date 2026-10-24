/**
 * Avatar Configuration
 *
 * 头像资源（2026-09-10 改造）：
 * - 之前使用 DiceBear notionists 外网 API（api.dicebear.com），该服务在国内常常无法直连，
 *   会导致玩家/AI 默认头像破图。
 * - 改为本地静态资源（public/avatars/），由 scripts/generate-avatars.mjs 在构建期预生成
 *   16 张 SVG，每个头像附带 idle/t1/t2 三个嘴型变体，嘴型切换与组件保持兼容。
 *
 * 资源结构：
 *   /avatars/bg/avatar-{NN}-{idle|t1|t2}.svg      带柔和底色（普通圆头像）
 *   /avatars/clear/avatar-{NN}-{idle|t1|t2}.svg   透明背景（大立绘/说话头像）
 */

import type { ModelRef } from "@/types/game";
import type { Gender } from "./character-generator";
import { getModelLogoPath } from "./model-logo";

// ============================================
// 发型配置 (Hair)（保留以兼容旧导入，本地头像不再使用）
// ============================================

// 长发变量 - 仅供女性使用
const FEMALE_ONLY_HAIR: readonly string[] = [
  "variant02",
  "variant04",
  "variant10",
  "variant20",
  "variant23",
  "variant28",
  "variant30",
  "variant36",
  "variant37",
  "variant45",
  "variant46",
  "variant47",
  "variant41"
] as const;

// 生成所有发型变量 (1-63)
const ALL_HAIR_VARIANTS: string[] = Array.from(
  { length: 63 },
  (_, i) => `variant${String(i + 1).padStart(2, "0")}`
);

// 非长发变量 - 供男性/非二元使用
const NON_FEMALE_HAIR: string[] = ALL_HAIR_VARIANTS.filter(
  (v) => !FEMALE_ONLY_HAIR.includes(v)
);

// ============================================
// 嘴型配置 (Lips)
// ============================================

// 禁止使用的嘴型
const FORBIDDEN_LIPS: readonly string[] = [
  "variant01",
  "variant02",
  "variant05",
] as const;

// 说话动画时切换的嘴型
const TALKING_LIPS: readonly string[] = ["variant04", "variant11"] as const;

// 生成所有嘴型变量 (1-30)
const ALL_LIPS_VARIANTS: string[] = Array.from(
  { length: 30 },
  (_, i) => `variant${String(i + 1).padStart(2, "0")}`
);

// 静止状态可用的嘴型 (排除禁止的和说话专用的)
const IDLE_LIPS: string[] = ALL_LIPS_VARIANTS.filter(
  (v) => !FORBIDDEN_LIPS.includes(v) && !TALKING_LIPS.includes(v)
);

const ALL_EYES_VARIANTS: readonly string[] = [
  "variant01",
  "variant02",
  "variant03",
  "variant04",
  "variant05",
] as const;

const FORBIDDEN_EYES: readonly string[] = ["variant03"] as const;

const DAY_EYES: string[] = ALL_EYES_VARIANTS.filter((v) => !FORBIDDEN_EYES.includes(v));

export function getDayEyesForSeed(seed: string): string {
  return DAY_EYES[hashString(seed) % DAY_EYES.length];
}

// ============================================
// 头像背景色
// ============================================

const AVATAR_BG_COLORS: readonly string[] = [
  "e8d5c4", "d4e5d7", "d5dce8", "e8d4d9", "ddd4e8",
  "d4e8e5", "e8e4d4", "d4d8e8", "e5d4d4", "dae8d4",
] as const;

// ============================================
// 工具函数
// ============================================

/**
 * 根据 seed 生成稳定的哈希值
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash);
}

/**
 * 根据 seed 获取背景色
 */
export function getAvatarBgColor(seed: string): string {
  return AVATAR_BG_COLORS[hashString(seed) % AVATAR_BG_COLORS.length];
}

/**
 * 根据性别获取可用的发型列表
 */
export function getHairVariantsForGender(gender: Gender): string[] {
  if (gender === "female") {
    // 女性只使用长发发型
    return [...FEMALE_ONLY_HAIR];
  }
  // 男性/非二元只使用非长发发型
  return [...NON_FEMALE_HAIR];
}

/**
 * 根据 seed 和性别获取稳定的发型
 */
export function getHairForSeed(seed: string, gender: Gender): string {
  const variants = getHairVariantsForGender(gender);
  return variants[hashString(seed) % variants.length];
}

/**
 * 获取静止状态的嘴型
 */
export function getIdleLipsForSeed(seed: string): string {
  return IDLE_LIPS[hashString(seed) % IDLE_LIPS.length];
}

/**
 * 获取说话动画的嘴型列表
 */
export function getTalkingLips(): readonly string[] {
  return TALKING_LIPS;
}

/**
 * 获取默认的静止嘴型 (用于不需要个性化的场景)
 */
export function getDefaultIdleLips(): string {
  // 使用 variant03 作为默认静止嘴型
  return "variant03";
}

// ============================================
// 本地默认头像（替代 DiceBear 外网）
// ============================================

/**
 * 头像 URL 选项（签名兼容旧版本；gender/hair/eyes/scale/translateY 在本地头像中不再使用）。
 */
export interface AvatarUrlOptions {
  seed: string;
  gender?: Gender;
  eyes?: string;
  lips?: string;
  hair?: string;
  scale?: number;
  translateY?: number;
  backgroundColor?: string | "transparent";
}

/** 本地默认头像数量：public/avatars/{bg,clear}/avatar-{00..COUNT-1}-{idle|t1|t2}.svg */
export const LOCAL_AVATAR_COUNT = 16;

/** 根据 seed 稳定映射到 0..LOCAL_AVATAR_COUNT-1。 */
export function getLocalAvatarIndex(seed: string): number {
  return hashString(seed) % LOCAL_AVATAR_COUNT;
}

/** 嘴型 → 本地文件名后缀。TALKING_LIPS[0]/[1] 对应 t1/t2，其余（含默认闭合嘴）→ idle。 */
type MouthKey = "idle" | "t1" | "t2";
function resolveMouthKey(lips: string | undefined): MouthKey {
  if (lips === TALKING_LIPS[0]) return "t1";
  if (lips === TALKING_LIPS[1]) return "t2";
  return "idle";
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 构建本地头像资源 URL（替代原 DiceBear 外链）。
 *
 * 资源选择规则：
 *   - backgroundColor === "transparent"  → /avatars/clear/... （大立绘/说话头像，叠加渐变光晕）
 *   - 其余（含未传）                       → /avatars/bg/...   （普通圆头像，自带柔和底色）
 *   - seed → 稳定映射到 16 张之一
 *   - lips → 选 idle/t1/t2 之一
 *
 * 旧字段（gender/hair/eyes/scale/translateY/beardProbability）参数签名保留以兼容调用方，
 * 本地资源已预生成固定外观，这些字段不再影响结果。
 */
export function buildAvatarUrl(options: AvatarUrlOptions): string {
  // 平台账号已经有头像（`/avatar/<id>`）：直接用那张，不要再套本地像素头像。
  const seed = String(options.seed || "");
  if (seed.startsWith("/") || seed.startsWith("http") || seed.startsWith("data:")) return seed;

  const idx = getLocalAvatarIndex(seed);
  const mouth = resolveMouthKey(options.lips);
  const transparent = options.backgroundColor === "transparent";
  const dir = transparent ? "clear" : "bg";
  return `${assetBase()}/avatars/${dir}/avatar-${pad2(idx)}-${mouth}.svg`;
}

/** 静态资源前缀：页面挂在 `/werewolf/` 下，public 里的东西也要跟着走。 */
export function assetBase(): string {
  return process.env.NEXT_PUBLIC_BASE_PATH || "";
}

/**
 * 简化版 URL 构建（兼容旧代码）：seed + 可选 backgroundColor / gender（gender 仅签名兼容）。
 */
export function buildSimpleAvatarUrl(
  seed: string,
  backgroundColorOrOptions?:
    | string
    | {
        backgroundColor?: string | "transparent";
        gender?: Gender;
        eyes?: string;
      }
): string {
  const backgroundColor =
    typeof backgroundColorOrOptions === "string"
      ? backgroundColorOrOptions
      : backgroundColorOrOptions?.backgroundColor;

  const gender =
    typeof backgroundColorOrOptions === "string" ? undefined : backgroundColorOrOptions?.gender;

  return buildAvatarUrl({
    seed,
    gender,
    backgroundColor,
  });
}

export const getModelLogoUrl = (modelRef?: ModelRef): string => getModelLogoPath(modelRef);

// ============================================
// 导出常量供外部使用
// ============================================

export const AvatarConfig = {
  FEMALE_ONLY_HAIR,
  NON_FEMALE_HAIR,
  ALL_HAIR_VARIANTS,
  TALKING_LIPS,
  IDLE_LIPS,
  FORBIDDEN_LIPS,
  AVATAR_BG_COLORS,
} as const;
