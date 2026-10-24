/**
 * BladeSteed — 可复现随机数
 *
 * 引擎里所有随机（座位洗牌、超时代出）都走这里。
 * 传入种子就能复现整局，测试里出问题时可以直接把种子打出来重跑。
 */

/** mulberry32：32 位种子 → [0,1) 均匀分布，短小且质量足够 */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** [0,1) */
    next,
    /** [0,n) 整数 */
    int: (n) => Math.floor(next() * n),
    /** 从数组里随机取一个 */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** 原地洗牌（Fisher–Yates）后返回同一个数组 */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

/** 取一个当前时间做种子的随机源 */
export function seedFromNow() {
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}