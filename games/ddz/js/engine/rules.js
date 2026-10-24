/*
 * 斗地主 —— 牌型识别与比大小（**照上游 GODOT-DouDiZhu 搬的**）。
 *
 * 上游：`games/ddz/upstream/脚本/扑克牌类.gd`（判断牌型 / 是顺子 / 是连对 / 是飞机 /
 * 比较牌型大小 / 扑克牌堆生成）。这里逐条对过去，牌型名字直接用中文 ——
 * 不是为了好看，是因为**客户端按这个名字去找语音文件**：
 * `音频/牌型语音/<牌型>/<牌型>_<头点数>[_<尾点数>].mp3`。
 *
 * 【和上游不一样的地方，只有一处】
 *   `比较牌型大小()` 在上游只比头点数、不看牌型也不看张数（它本来就是单机打弱 AI，
 *   玩家出什么都不会被拒）。三家真人这么玩就没法打了：
 *   - 这里要求**同牌型 + 同张数**才能压；
 *   - 炸弹压普通牌型、炸弹之间比点数、王炸最大（上游没写这条）。
 *   其余（顺子只到 A、连对 ≥3 对、飞机不带翅膀、四带一/四带二）**照搬**。
 *
 * 【纯逻辑】不碰任何宿主 API。
 */

import { MAX_RUN_RANK } from './cards.js';

/** 牌型名字 = 上游 `牌型列表` 的键，也是语音目录名。 */
export const TYPE = {
  无牌型: '无牌型',
  单张: '单张',
  对子: '对子',
  三张: '三张',
  三带一: '三带一',
  三带二: '三带二',
  顺子: '顺子',
  连对: '连对',
  飞机: '飞机',
  炸弹: '炸弹',
  四带一: '四带一',
  四带二: '四带二',
  王炸: '王炸',
};

/** 有头/尾点数、会念"顺子 3 到 10"的那几种。 */
export const RUN_TYPES = new Set([TYPE.顺子, TYPE.连对, TYPE.飞机]);

/** 点数计数：返回 Map<点数, 张数>。 */
function countRanks(ranks) {
  const map = new Map();
  for (const r of ranks) map.set(r, (map.get(r) || 0) + 1);
  return map;
}

/** 上游 `是顺子()`：5~12 张、不重复、连续、最大到 A。 */
export function isRun(ranks) {
  if (ranks.length < 5 || ranks.length > 12) return false;
  const sorted = ranks.slice().sort((a, b) => a - b);
  if (sorted[sorted.length - 1] > MAX_RUN_RANK) return false;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] !== 1) return false;
  }
  return true;
}

/** 上游 `是连对()`：≥3 对、每点数恰好 2 张、连续、最大到 A。 */
export function isPairRun(ranks) {
  if (ranks.length < 6 || ranks.length % 2 !== 0) return false;
  if (ranks.some((r) => r > MAX_RUN_RANK)) return false;
  const map = countRanks(ranks);
  const keys = [...map.keys()].sort((a, b) => a - b);
  for (const r of keys) if (map.get(r) !== 2) return false;
  for (let i = 1; i < keys.length; i += 1) {
    if (keys[i] - keys[i - 1] !== 1) return false;
  }
  return true;
}

/** 上游 `是飞机()`：6/9/12 张、每点数 3 张、连续 —— **不带翅膀**。 */
export function isTripleRun(ranks) {
  if (ranks.length < 6 || ranks.length % 3 !== 0) return false;
  const sorted = ranks.slice().sort((a, b) => a - b);
  if (sorted[sorted.length - 1] > MAX_RUN_RANK) return false;
  for (let i = 0; i < sorted.length; i += 3) {
    if (sorted[i] !== sorted[i + 1] || sorted[i] !== sorted[i + 2]) return false;
    if (i + 3 < sorted.length && sorted[i + 3] - sorted[i] !== 1) return false;
  }
  return true;
}

/**
 * 认出这几张牌是什么牌型。
 *
 * 判定顺序照上游 `判断牌型()`：单 → 对 → 三 → 三带一 → 三带二 → 顺子 →
 * 连对 → 飞机 → 炸弹 → 四带一 → 四带二 → 王炸（王炸提前判，结果一样）。
 *
 * @param {Array<{r:number,s:number}>} cards
 * @returns {{type:string, rank:number, tail:number|null, len:number}|null}
 *          认不出来（凑不成任何牌型）返回 null —— 上游叫"无牌型"。
 */
export function classify(cards) {
  const len = cards.length;
  if (!len) return null;

  const ranks = cards.map((c) => c.r);
  const map = countRanks(ranks);
  const keys = [...map.keys()];
  /** 每种张数出现几次：{3:1, 1:1} 表示"一个三张 + 一个单张" */
  const shape = new Map();
  for (const r of keys) shape.set(map.get(r), (shape.get(map.get(r)) || 0) + 1);

  const one = (type, rank, tail = null) => ({ type, rank, tail, len });

  if (len === 1) return one(TYPE.单张, ranks[0]);
  if (map.has(16) && map.has(17) && len === 2) return one(TYPE.王炸, 17);
  if (len === 2 && map.size === 1) return one(TYPE.对子, keys[0]);
  if (len === 3 && map.size === 1) return one(TYPE.三张, keys[0]);
  if (len === 4 && shape.size === 2 && shape.get(3) === 1 && shape.get(1) === 1) {
    return one(TYPE.三带一, keys.find((r) => map.get(r) === 3));
  }
  if (len === 4 && map.size === 1) return one(TYPE.炸弹, keys[0]);
  if (len === 5 && shape.size === 2 && shape.get(3) === 1 && shape.get(2) === 1) {
    return one(TYPE.三带二, keys.find((r) => map.get(r) === 3));
  }

  if (len >= 5 && map.size === len && isRun(ranks)) {
    const sorted = ranks.slice().sort((a, b) => a - b);
    return one(TYPE.顺子, sorted[0], sorted[sorted.length - 1]);
  }
  if (len >= 6 && len % 2 === 0 && isPairRun(ranks)) {
    const sorted = keys.slice().sort((a, b) => a - b);
    return one(TYPE.连对, sorted[0], sorted[sorted.length - 1]);
  }
  if (len >= 6 && len % 3 === 0 && isTripleRun(ranks)) {
    const sorted = keys.slice().sort((a, b) => a - b);
    return one(TYPE.飞机, sorted[0], sorted[sorted.length - 1]);
  }

  if (len === 5 && shape.size === 2 && shape.get(4) === 1 && shape.get(1) === 1) {
    return one(TYPE.四带一, keys.find((r) => map.get(r) === 4));
  }
  if (len === 6 && shape.size === 2 && shape.get(4) === 1 && shape.get(2) === 1) {
    return one(TYPE.四带二, keys.find((r) => map.get(r) === 4));
  }

  return null;
}

/**
 * `info` 这一手能不能压过 `last`。
 *
 * 口径（见文件头）：同牌型同张数比点数；炸弹压普通；炸弹之间比点数；王炸最大。
 *
 * @param {{type:string,rank:number,len:number}|null} last 上家那手
 * @param {{type:string,rank:number,len:number}|null} info 要出的这手
 */
export function canBeat(last, info) {
  if (!last || !last.type || last.type === TYPE.无牌型) return true;
  if (!info || !info.type || info.type === TYPE.无牌型) return false;

  if (info.type === TYPE.王炸) return last.type !== TYPE.王炸;
  if (last.type === TYPE.王炸) return false;
  if (info.type === TYPE.炸弹 && last.type !== TYPE.炸弹) return true;
  if (info.type === TYPE.炸弹 && last.type === TYPE.炸弹) return info.rank > last.rank;
  if (last.type === TYPE.炸弹) return false;

  if (info.type !== last.type) return false;
  if (info.len !== last.len) return false;
  return info.rank > last.rank;
}

export const ALL_TYPES = Object.values(TYPE);