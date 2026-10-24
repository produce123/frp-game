/**
 * Shell Gambit — 可复现的伪随机数发生器
 *
 * 使用 mulberry32：32 位种子、速度快、分布足够好。
 * 引擎内所有随机（洗牌、装弹、发牌、AI 决策）都走同一个 rng 实例，
 * 因此给定种子即可完整复现一局，便于测试与复现 BUG。
 */

/**
 * @param {number} seed 32 位无符号整数种子
 */
export function makeRng(seed) {
  let a = seed >>> 0;

  /** 返回 [0, 1) 的浮点数 */
  function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    seed: seed >>> 0,
    next,
    /** 闭区间整数 [min, max] */
    int(min, max) {
      if (max < min) throw new Error(`rng.int: max(${max}) < min(${min})`);
      return min + Math.floor(next() * (max - min + 1));
    },
    /** 从数组随机取一个元素 */
    pick(arr) {
      if (!arr.length) return undefined;
      return arr[Math.floor(next() * arr.length)];
    },
    /** 原地 Fisher–Yates 洗牌并返回同一数组 */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
      }
      return arr;
    },
  };
}

/** 生成一个随机 32 位种子 */
export function randomSeed() {
  return (Math.floor(Math.random() * 0xffffffff) ^ Date.now()) >>> 0;
}