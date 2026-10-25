// mac 应用图标：与安卓启动图标同一张像素图（android/.../ic_launcher_foreground.xml），
// 放进 macOS 的圆角底板（1024 画布里 824 见方，带一点投影），按 iconset 的各个尺寸直接画，再用 iconutil 打包。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const res = (root) => path.join(root, 'android/app/src/main/res')

/** 安卓矢量图里的格子：每个 path 是同一颜色的若干矩形「Mx,yhWvHh-Wz」 */
export function readArt(root) {
  const xml = fs.readFileSync(path.join(res(root), 'drawable/ic_launcher_foreground.xml'), 'utf8')
  const rects = []
  for (const [, color, data] of xml.matchAll(
    /fillColor="#([0-9A-Fa-f]{6})"\s+android:pathData="([^"]+)"/g
  )) {
    const rgb = [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16))
    for (const [, x, y, w, h] of data.matchAll(/M([\d.]+),([\d.]+)h([\d.]+)v([\d.]+)h-[\d.]+z/g))
      rects.push({ x: +x, y: +y, w: +w, h: +h, rgb })
  }
  if (!rects.length) throw Error('没有从安卓图标里读出像素格')
  const colors = fs.readFileSync(path.join(res(root), 'values/colors.xml'), 'utf8')
  const green = /name="town_green">#FF([0-9A-Fa-f]{6})</.exec(colors)?.[1]
  if (!green) throw Error('colors.xml 里没有 town_green')
  return { rects, background: [0, 2, 4].map((i) => parseInt(green.slice(i, i + 2), 16)) }
}

/** macOS 的底板：1024 画布里 824 见方，带一点投影 */
const MAC_PLATE = { side: 824, radius: 185, shadow: true }

/** 画一张 size 见方的 RGBA：底板（plate，按 1024 画布量）用距离场抗锯齿，像素图每像素 4×4 采样 */
export function draw(size, art, plate = MAC_PLATE) {
  const k = size / 1024
  const inset = ((1024 - plate.side) / 2) * k
  const side = plate.side * k
  const radius = plate.radius * k
  // 安卓自适应图标 108 见方，遮罩露出中间约 72；把露出的部分放满底板
  const unit = side / 72
  const toPx = (u) => inset + (u - 18) * unit
  // 先把像素格画进采样网格（0 = 底色，n = 第 n 种颜色）
  const n = size * 4
  const samples = new Uint8Array(n * n)
  const palette = [art.background]
  for (const r of art.rects) {
    let index = palette.indexOf(r.rgb)
    if (index < 0) index = palette.push(r.rgb) - 1
    const [i0, i1] = [toPx(r.x), toPx(r.x + r.w)].map((p) => Math.ceil(4 * p - 0.5))
    const [j0, j1] = [toPx(r.y), toPx(r.y + r.h)].map((p) => Math.ceil(4 * p - 0.5))
    for (let j = Math.max(j0, 0); j < Math.min(j1, n); j++)
      samples.fill(index, j * n + Math.max(i0, 0), j * n + Math.min(i1, n))
  }
  const half = side / 2
  const center = inset + half
  const distance = (x, y) => {
    const qx = Math.abs(x - center) - (half - radius)
    const qy = Math.abs(y - center) - (half - radius)
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
  }
  const shadowBlur = 24 * k
  const shadowDrop = 10 * k
  const pixels = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const cover = Math.min(Math.max(0.5 - distance(px + 0.5, py + 0.5), 0), 1)
      const rgb = [0, 0, 0]
      if (cover > 0)
        for (let sy = 0; sy < 4; sy++)
          for (let sx = 0; sx < 4; sx++) {
            const c = palette[samples[(py * 4 + sy) * n + px * 4 + sx]]
            for (let i = 0; i < 3; i++) rgb[i] += c[i] / 16
          }
      // 底板下方的柔和投影
      const d = distance(px + 0.5, py + 0.5 - shadowDrop)
      const shadow = !plate.shadow ? 0 : d <= 0 ? 0.28 : 0.28 * Math.max(0, 1 - d / shadowBlur) ** 2
      const alpha = cover + shadow * (1 - cover)
      const at = (py * size + px) * 4
      for (let i = 0; i < 3; i++) pixels[at + i] = alpha ? Math.round((rgb[i] * cover) / alpha) : 0
      pixels[at + 3] = Math.round(alpha * 255)
    }
  return pixels
}

export function png(size, rgba) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++)
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 生成 out（.icns）；work 是临时目录 */
export function makeIcon(root, out, work) {
  const art = readArt(root)
  const set = path.join(work, 'AppIcon.iconset')
  fs.rmSync(set, { recursive: true, force: true })
  fs.mkdirSync(set, { recursive: true })
  const drawn = new Map()
  for (const base of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      const size = base * scale
      if (!drawn.has(size)) drawn.set(size, png(size, draw(size, art)))
      const name = `icon_${base}x${base}${scale === 2 ? '@2x' : ''}.png`
      fs.writeFileSync(path.join(set, name), drawn.get(size))
    }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', out])
}
