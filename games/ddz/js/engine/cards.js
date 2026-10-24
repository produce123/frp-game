/*
 * 斗地主 —— 一副牌的表示、洗牌、排序。
 *
 * 【纯逻辑】这里没有浏览器宿主 API，也没有 Node 专属 API：
 *   同一份代码只被服务器 import（规则跑在服务器进程里，见 docs/ARCHITECTURE.md 的
 *   「游戏模块接口（服务器权威）」）。测试里有一条 grep 盯着这件事。
 *
 * 【牌的编码】
 *   r = 点数：3…10 = 3…10，11 = J，12 = Q，13 = K，14 = A，15 = 2，16 = 小王，17 = 大王
 *   s = 花色：0 黑桃 / 1 红桃 / 2 梅花 / 3 方片；大小王是 -1
 *   id = 花色字母 + 点数（'S3'），大小王是 'J16' / 'J17'
 *
 * 为什么点数把 2 放在 A 上面、大小王用 16/17：比较大小就是比 r，不用每次查表。
 * 顺子/连对/飞机只允许 3…A（r <= 14），2 和大小王不能进连牌 —— 这条在 rules.js 里判。
 */

/** 点数 → 显示文字 */
export const RANK_TEXT = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王',
};

/** 花色序号 → 符号（界面直接用） */
export const SUIT_TEXT = ['♠', '♥', '♣', '♦'];

/** 花色序号 → id 前缀 */
const SUIT_KEY = ['S', 'H', 'C', 'D'];

export const RANK_JOKER_SMALL = 16;
export const RANK_JOKER_BIG = 17;

/** 连牌（顺子/连对/飞机）允许的最大点数：A。2 与大小王不能连。 */
export const MAX_RUN_RANK = 14;

/**
 * 一副 54 张。
 * @returns {Array<{id:string, r:number, s:number}>}
 */
export function createDeck() {
  const deck = [];
  for (let r = 3; r <= 15; r += 1) {
    for (let s = 0; s < 4; s += 1) deck.push({ id: SUIT_KEY[s] + r, r, s });
  }
  deck.push({ id: 'J16', r: RANK_JOKER_SMALL, s: -1 });
  deck.push({ id: 'J17', r: RANK_JOKER_BIG, s: -1 });
  return deck;
}

/**
 * 洗牌（Fisher–Yates，不改原数组）。
 * rng 可注入：测试里给一个确定性的伪随机，线上默认 Math.random。
 * @param {Array} cards
 * @param {() => number} [rng]
 */
export function shuffle(cards, rng = Math.random) {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** 从大到小（同点数按花色），界面和服务器都按这个顺序发。 */
export function sortCards(cards) {
  return cards.slice().sort((a, b) => (b.r - a.r) || (a.s - b.s));
}

/** 这张牌的点数说明（"3" / "A" / "小王"）。 */
export function rankText(r) {
  return RANK_TEXT[r] || String(r);
}

/** 红牌（红桃、方片、大王）—— 只影响界面颜色。 */
export function isRed(card) {
  return card.s === 1 || card.s === 3 || card.r === RANK_JOKER_BIG;
}

/** 一张牌的完整显示名（"♠A" / "小王"）—— 只给日志和调试用。 */
export function cardText(card) {
  if (card.r >= RANK_JOKER_SMALL) return rankText(card.r);
  return SUIT_TEXT[card.s] + rankText(card.r);
}