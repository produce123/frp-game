import { hash, hexRgb, mixHex, noise } from '../pixel/noise'
import { SNOW, SNOW_SHADE } from '../palette'

// 像素立牌的画布工具：地标、船、散落物都用它画。一个贴图像素对应一个地图像素，光从左上来。

export type Paint = {
  px(x: number, y: number, c: string): void
  rect(x: number, y: number, w: number, h: number, c: string): void
  line(x0: number, y0: number, x1: number, y1: number, c: string): void
}

export function sprite(w: number, h: number, draw: (p: Paint) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const rect = (x: number, y: number, rw: number, rh: number, c: string) => {
    ctx.fillStyle = c
    ctx.fillRect(Math.round(x), Math.round(y), rw, rh)
  }
  const px = (x: number, y: number, c: string) => rect(x, y, 1, 1, c)
  const line = (x0: number, y0: number, x1: number, y1: number, c: string) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let i = 0; i <= n; i++) px(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, c)
  }
  draw({ px, rect, line })
  return canvas
}

/** 横向渐变的石料：左亮右暗，t 是 0～1 的横向位置 */
export const stone = (t: number, base = '#c9c1b1') =>
  t < 0.3 ? mixHex(base, '#fff6e6', 0.25) : t > 0.75 ? mixHex(base, '#3a3440', 0.25) : base

/** 把一张立牌做旧：颜色褪一半、往土色靠，成片的锈斑，零星暗点，外沿掉几块（底下三行不掉，立牌还站得住） */
export function wear(canvas: HTMLCanvasElement, seed: number) {
  const { width: w, height: h } = canvas
  const ctx = canvas.getContext('2d')!
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const solid = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 0
  const holes: number[] = []
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (!d[o + 3]) continue
      const edge = !solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1)
      if (edge && y < h - 3 && hash(x, y, seed + 1) < 0.18) holes.push(o)
      let [r, g, b] = [d[o], d[o + 1], d[o + 2]]
      const l = r * 0.3 + g * 0.59 + b * 0.11
      r += (l - r) * 0.5
      g += (l - g) * 0.5
      b += (l - b) * 0.5
      r += (150 - r) * 0.22
      g += (128 - g) * 0.22
      b += (98 - b) * 0.22
      if (noise(x / 3, y / 3, seed) > 0.68) {
        r += (138 - r) * 0.6
        g += (74 - g) * 0.6
        b += (36 - b) * 0.6
      }
      const dark = hash(x, y, seed + 2) < 0.12 ? 0.82 : 1
      d[o] = r * dark
      d[o + 1] = g * dark
      d[o + 2] = b * dark
    }
  for (const o of holes) d[o + 3] = 0
  ctx.putImageData(img, 0, 0)
  return canvas
}

/** 给立牌压一层雪：每个朝上的外沿（上面一格是空的）铺一到两格雪，左半边白、右半边发蓝 */
export function snowCap(canvas: HTMLCanvasElement, seed: number) {
  const { width: w, height: h } = canvas
  const ctx = canvas.getContext('2d')!
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const solid = (x: number, y: number) => y >= 0 && d[(y * w + x) * 4 + 3] > 0
  const caps: [number, number][] = []
  for (let y = 0; y < h - 2; y++)
    for (let x = 0; x < w; x++) if (solid(x, y) && !solid(x, y - 1)) caps.push([x, y])
  for (const [x, y] of caps) {
    const deep = hash(x, y, seed) < 0.55 ? 2 : 1
    for (let k = 0; k < deep && y + k < h - 2; k++) {
      if (!solid(x, y + k)) break
      const o = ((y + k) * w + x) * 4
      const [r, g, b] = hexRgb(x < w / 2 ? SNOW : SNOW_SHADE)
      d.set([r, g, b, 255], o)
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}
