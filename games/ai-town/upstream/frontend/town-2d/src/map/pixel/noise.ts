// 像素画用的确定性随机：同样的输入永远得到同样的像素。

export function hash(x: number, y: number, s: number) {
  let h =
    (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** 数值噪声，0..1 */
export function noise(x: number, y: number, s: number) {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    fx = x - xi,
    fy = y - yi
  const u = fx * fx * (3 - 2 * fx),
    v = fy * fy * (3 - 2 * fy)
  const a = hash(xi, yi, s),
    b = hash(xi + 1, yi, s),
    c = hash(xi, yi + 1, s),
    d = hash(xi + 1, yi + 1, s)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/** 三层噪声叠加 */
export function fbm(x: number, y: number, s: number) {
  return (
    (noise(x / 40, y / 40, s) * 4 + noise(x / 17, y / 17, s + 1) * 2 + noise(x / 7, y / 7, s + 2)) /
    7
  )
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
/** 4×4 有序抖动阈值，0..1 */
export const bayer = (x: number, y: number) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16

/** 把 0..1 的值按有序抖动落到调色板的一档 */
export function pick<T>(palette: readonly T[], v: number, x: number, y: number, spread = 1): T {
  const t = v * palette.length + (bayer(x, y) - 0.5) * spread
  return palette[Math.max(0, Math.min(palette.length - 1, Math.floor(t)))]
}

/** '#rrggbb' → [r, g, b]（0～255） */
export function hexRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}
export function mixHex(a: string, b: string, t: number) {
  const A = hexRgb(a),
    B = hexRgb(b)
  return (
    '#' +
    A.map((v, i) =>
      Math.round(v + (B[i] - v) * t)
        .toString(16)
        .padStart(2, '0')
    ).join('')
  )
}

/** 字符串哈希（FNV-1a），给房间、区域、村民按编号挑外观和随机种子 */
export function hashString(text: string) {
  let h = 2166136261
  for (const c of text) {
    h ^= c.codePointAt(0)!
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 可复现的随机数序列（mulberry32） */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 泰森多边形裂纹：size 像素一格，每格一个随机点；返回到最近两点的距离差，越接近 0 越在裂缝上 */
export function crack(x: number, y: number, size: number, s: number) {
  const gx = Math.floor(x / size),
    gy = Math.floor(y / size)
  let f1 = Infinity,
    f2 = Infinity
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const px = (gx + i + hash(gx + i, gy + j, s)) * size,
        py = (gy + j + hash(gx + i, gy + j, s + 1)) * size
      const d = Math.hypot(x - px, y - py)
      if (d < f1) {
        f2 = f1
        f1 = d
      } else if (d < f2) f2 = d
    }
  return f2 - f1
}
