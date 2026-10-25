import type { Atlas } from 'town-shared/mapDocument'
import { PIXEL } from '../grid'
import type { Dock } from '../pixel/island'
import { hash, mixHex } from '../pixel/noise'
import { sprite, stone } from './sprite'

// 户外地点的立体标志物：摩天轮、旋转亭、方尖碑、喷泉、神庙遗迹、弧形阶台这些地标，
// 以及市场的摊位、港口栈桥边的船、花园的花拱门、公园的凉亭。都是竖在地上的像素立牌，
// 和树、路灯一样按俯角转向镜头；光从左上来，左边亮右边暗。一个贴图像素对应一个地图像素。

export interface LandmarkSprite {
  /** 立牌底边中点（地图坐标） */
  x: number
  y: number
  canvas: HTMLCanvasElement
}

/** 一种风格的户外立牌：各类地点放什么、栈桥边停什么船、野地和外圈散落什么 */
export interface LandmarkSet {
  /** 一种户外地点在自己的区域里放哪些立牌：[贴图, 相对区域中心的偏移（地图像素）] */
  plans: Record<string, (seed: number) => [HTMLCanvasElement, number, number][]>
  boat: (seed: number) => HTMLCanvasElement
  /** 散落物：每个地图像素放一件的概率，野地（land）和外圈（outer）分开算；sprite 给出一件的贴图 */
  scatter?: {
    land: number
    outer: number
    sprite(where: 'land' | 'outer', seed: number): HTMLCanvasElement
  }
}

/** broken 为 true 时是废弃的：吊厢掉了一半，轮缘断一截，轮辐缺两根 */
export function ferrisWheel(broken = false) {
  return sprite(64, 78, ({ px, rect, line }) => {
    const cx = 32,
      cy = 30,
      r = 26
    // 支架：两条斜腿、一道横撑、底座
    for (const d of [-1, 1]) {
      line(cx, cy, cx + d * 15, 74, '#6c7280')
      line(cx + d, cy, cx + d * 16, 74, d < 0 ? '#9aa0ac' : '#555b68')
    }
    line(cx - 9, 56, cx + 9, 56, '#6c7280')
    rect(10, 74, 44, 4, '#8a7a66')
    rect(10, 74, 44, 1, '#a8987e')
    rect(10, 77, 44, 1, '#5e5142')
    // 轮辐和两圈轮缘
    for (let k = 0; k < 12; k++) {
      if (broken && (k === 3 || k === 8)) continue
      const a = (k / 12) * Math.PI * 2
      line(cx, cy, cx + Math.cos(a) * r, cy + Math.sin(a) * r, '#a3a9b4')
    }
    for (let k = 0; k < 360; k++) {
      if (broken && k > 60 && k < 88) continue
      const a = (k / 360) * Math.PI * 2
      const lit = Math.cos(a + 2.4) > 0
      px(cx + Math.cos(a) * r, cy + Math.sin(a) * r, lit ? '#e6e9ee' : '#8d939e')
      px(cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2), '#7a808c')
    }
    rect(cx - 3, cy - 3, 6, 6, '#5a606c')
    rect(cx - 2, cy - 2, 2, 2, '#9aa0ac')
    // 吊厢挂在轮缘外面，四种颜色轮流
    const cabins = ['#e05a4a', '#f0c040', '#4a9ad8', '#5ab870']
    for (let k = 0; k < 12; k++) {
      if (broken && hash(k, 5, 11) < 0.5) continue
      const a = (k / 12) * Math.PI * 2 + 0.26
      const x = Math.round(cx + Math.cos(a) * r),
        y = Math.round(cy + Math.sin(a) * r)
      const c = cabins[k % 4]
      px(x, y + 1, '#555b68')
      rect(x - 2, y + 2, 5, 4, c)
      rect(x - 2, y + 2, 5, 1, mixHex(c, '#ffffff', 0.35))
      rect(x - 1, y + 3, 3, 1, '#dff0f8')
      rect(x + 2, y + 3, 1, 3, mixHex(c, '#2a2230', 0.3))
    }
  })
}

/** torn 为 true 时顶篷破了洞 */
export function carousel(torn = false) {
  return sprite(50, 48, ({ px, rect, line }) => {
    // 尖顶：红白相间的扇面，顶上一面小旗
    line(25, 0, 25, 3, '#6a5040')
    rect(26, 0, 4, 2, '#e05a4a')
    for (let y = 4; y <= 18; y++) {
      const half = Math.round(((y - 3) / 15) * 23)
      for (let x = 25 - half; x <= 25 + half; x++) {
        const band = Math.floor(((x - 25) / (half + 1)) * 4 + 4)
        let c = band % 2 ? '#e8e0cc' : '#d0473c'
        if (x > 25 + half * 0.4) c = mixHex(c, '#2a2230', 0.2)
        if (x < 25 - half * 0.5) c = mixHex(c, '#fff6e6', 0.15)
        if (torn && y > 8 && Math.hypot(x - 33, y - 13) < 4 + hash(x, y, 4) * 2) continue
        px(x, y, c)
      }
    }
    // 檐口一圈金色花边
    for (let x = 2; x <= 48; x++) {
      px(x, 19, '#d8a840')
      if ((x - 2) % 4 < 3) px(x, 20, '#d8a840')
      if ((x - 2) % 4 === 1) px(x, 21, '#b8862c')
    }
    // 立柱和木马
    for (const x of [5, 15, 25, 35, 45]) rect(x, 21, 1, 18, '#e0b850')
    rect(23, 21, 5, 18, '#e8d8b0')
    rect(26, 21, 2, 18, '#c8b890')
    const horses = [
      [8, 27],
      [17, 31],
      [30, 28],
      [38, 31],
    ]
    for (const [x, y] of horses) {
      rect(x, y + 2, 6, 3, '#f4efe4')
      rect(x + 4, y, 3, 3, '#f4efe4')
      px(x + 6, y + 1, '#2a2230')
      rect(x, y + 5, 1, 2, '#d8d0c0')
      rect(x + 5, y + 5, 1, 2, '#d8d0c0')
      rect(x + 1, y + 1, 3, 1, '#c8453b')
    }
    // 底盘
    for (let y = 39; y <= 45; y++) {
      const half = Math.round(Math.sqrt(1 - ((y - 42) / 4.5) ** 2) * 24)
      for (let x = 25 - half; x <= 25 + half; x++)
        px(x, y, y < 41 ? '#c8a878' : y < 44 ? '#a68a64' : '#7a6448')
    }
  })
}

export function obelisk() {
  return sprite(20, 72, ({ px, rect }) => {
    rect(0, 66, 20, 6, '#9a9488')
    rect(0, 66, 20, 1, '#c8c2b4')
    rect(2, 60, 16, 6, '#aaa496')
    rect(2, 60, 16, 1, '#d6d0c2')
    // 碑身往上收窄，左边亮右边暗，中间一列刻字
    for (let y = 12; y < 60; y++) {
      const half = 3 + Math.round(((y - 12) / 48) * 2.5)
      for (let x = 10 - half; x < 10 + half; x++)
        px(x, y, stone((x - (10 - half)) / (2 * half), '#cfc8b8'))
    }
    for (let y = 18; y < 54; y += 3) rect(9, y, 2, 1, '#9a9282')
    // 塔尖镀金
    for (let y = 4; y < 12; y++) {
      const half = Math.round(((y - 3) / 8) * 3)
      for (let x = 10 - half; x < 10 + half; x++) px(x, y, x < 10 ? '#f0d070' : '#c8a040')
    }
  })
}

function fountain() {
  return sprite(58, 46, ({ px, rect, line }) => {
    const ellipse = (cx: number, cy: number, rx: number, ry: number, c: (t: number) => string) => {
      for (let y = -ry; y <= ry; y++) {
        const half = Math.round(rx * Math.sqrt(1 - (y / ry) ** 2))
        for (let x = -half; x <= half; x++) px(cx + x, cy + y, c((x + half) / (2 * half + 1)))
      }
    }
    // 水池：石沿、水面、朝前的池壁
    rect(3, 36, 52, 8, '#aca494')
    rect(3, 36, 52, 1, '#c8c0b0')
    rect(3, 43, 52, 1, '#7c7466')
    for (let x = 3; x < 55; x += 7) rect(x, 37, 1, 6, '#948c7e')
    ellipse(29, 35, 26, 6, (t) => stone(t, '#c2baa9'))
    ellipse(29, 35, 23, 4, () => '#4f88a6')
    for (let k = 0; k < 14; k++)
      rect(10 + Math.floor(hash(k, 3, 9) * 36), 33 + Math.floor(hash(k, 4, 9) * 4), 2, 1, '#9cc6d2')
    // 中间的柱子、上层小盆和雕像
    rect(26, 18, 6, 17, '#c8c0b0')
    rect(26, 18, 2, 17, '#e0d8c8')
    rect(30, 18, 2, 17, '#a09888')
    ellipse(29, 18, 10, 2, (t) => stone(t, '#c2baa9'))
    rect(21, 18, 17, 1, '#5c93ad')
    rect(27, 6, 4, 11, '#e4e0d8')
    rect(26, 9, 6, 4, '#e4e0d8')
    rect(28, 3, 3, 3, '#e4e0d8')
    rect(30, 6, 1, 11, '#b8b2a8')
    // 从上层盆边落下的水
    for (const d of [-1, 1]) {
      line(29 + d * 10, 19, 29 + d * 14, 33, '#9cc6d2')
      line(29 + d * 9, 20, 29 + d * 12, 33, '#cfe6ee')
    }
  })
}

export function temple() {
  return sprite(82, 56, ({ px, rect }) => {
    // 三级台基
    const steps: [number, number, number][] = [
      [0, 50, 82],
      [3, 45, 76],
      [6, 41, 70],
    ]
    for (const [x, y, w] of steps) {
      rect(x, y, w, 6, '#bdb4a2')
      rect(x, y, w, 1, '#ddd5c4')
      rect(x, y + 5, w, 1, '#8c8474')
    }
    // 七根柱子，两根断了
    for (let k = 0; k < 7; k++) {
      const x = 9 + k * 10
      const top = k === 2 ? 26 : k === 5 ? 31 : 13
      for (let y = top; y < 41; y++) {
        rect(x, y, 6, 1, '#d6cebc')
        px(x, y, '#ece6d8')
        px(x + 2, y, '#bcb4a2')
        px(x + 5, y, '#a49c8a')
      }
      if (top === 13) rect(x - 1, 11, 8, 2, '#c8c0ae')
      else for (let i = 0; i < 6; i += 2) px(x + i, top - 1, '#d6cebc')
    }
    // 左边还剩一段檐和半个山花
    rect(7, 7, 38, 4, '#c8c0ae')
    rect(7, 10, 38, 1, '#9c9482')
    for (let y = 0; y < 7; y++) {
      const half = Math.round((y / 7) * 19)
      for (let x = 26 - half; x <= Math.min(26 + half, 44); x++)
        px(x, y, x - 26 > half - 2 || y === 6 ? '#a8a08e' : '#d0c8b6')
    }
    // 散落的石块和青苔
    rect(62, 46, 7, 4, '#b0a896')
    rect(70, 44, 5, 6, '#a49c8a')
    rect(56, 47, 4, 3, '#c0b8a6')
    for (let k = 0; k < 30; k++)
      px(Math.floor(hash(k, 1, 7) * 80), 12 + Math.floor(hash(k, 2, 7) * 42), '#6f8a4e')
  })
}

export function court() {
  return sprite(92, 32, ({ px, rect }) => {
    // 半圆形的几级石阶，越往后越高；前面是一块表演用的平台
    const cx = 46
    for (let t = 3; t >= 0; t--) {
      const rx = 22 + t * 8,
        ry = 8 + t * 6,
        base = 30 - t * 2
      for (let y = base - ry; y <= base; y++) {
        const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - ((base - y) / ry) ** 2)))
        for (let x = cx - half; x <= cx + half; x++) {
          const edge = y === base - ry || Math.abs(x - cx) >= half - 1
          px(x, y, edge ? '#8c8270' : t % 2 ? '#c8bca6' : '#b4a890')
        }
      }
    }
    for (let y = 26; y <= 31; y++) {
      const half = Math.round(20 * Math.sqrt(1 - ((y - 28.5) / 3.5) ** 2))
      rect(cx - half, y, 2 * half + 1, 1, y === 26 ? '#e8dec8' : '#d4c8b0')
    }
  })
}

const AWNINGS: [string, string][] = [
  ['#d0473c', '#f1ead8'],
  ['#3f7a9a', '#f1ead8'],
  ['#d8a840', '#f1ead8'],
  ['#5a9a5a', '#f1ead8'],
]
const GOODS = ['#e05a4a', '#f0c040', '#7ab050', '#e89040', '#b86ab0']

export function stall(k: number) {
  const [a, b] = AWNINGS[k % AWNINGS.length]
  return sprite(28, 26, ({ px, rect }) => {
    rect(1, 7, 2, 19, '#6a4a30')
    rect(25, 7, 2, 19, '#4e3624')
    for (let x = 0; x < 28; x++) for (let y = 1; y < 7; y++) px(x, y, (x >> 2) & 1 ? b : a)
    rect(0, 0, 28, 1, mixHex(a, '#2a2230', 0.3))
    for (let x = 0; x < 28; x++)
      if ((x >> 2) % 2 === 0 || x % 4 === 1) px(x, 7, (x >> 2) & 1 ? b : a)
    rect(0, 17, 28, 7, '#8a6a44')
    rect(0, 17, 28, 1, '#a88660')
    rect(0, 23, 28, 1, '#5e4630')
    for (let i = 0; i < 9; i++) {
      const c = GOODS[(i + k) % GOODS.length]
      rect(2 + i * 3, 15, 2, 2, c)
      px(2 + i * 3, 15, mixHex(c, '#ffffff', 0.4))
    }
  })
}

function boat() {
  return sprite(36, 28, ({ px, rect, line }) => {
    rect(17, 0, 1, 18, '#5a4030')
    for (let y = 1; y < 15; y++) {
      const w = Math.round(((y - 1) / 14) * 13)
      for (let x = 18; x <= 18 + w; x++) px(x, y, x > 18 + w - 3 ? '#cfc6b2' : '#efe8d8')
    }
    for (let y = 18; y < 26; y++) {
      const inset = Math.round(((y - 18) / 8) * 5)
      for (let x = inset; x < 36 - inset; x++)
        px(
          x,
          y,
          y === 18 ? '#a0724a' : y === 21 ? '#e0dccc' : x > 28 - inset ? '#5e3e28' : '#7a5236'
        )
    }
    line(0, 18, 3, 16, '#7a5236')
    line(35, 18, 33, 16, '#5e3e28')
    rect(6, 26, 24, 2, '#3e6f89')
  })
}

/** dead 为 true 时藤蔓枯了，没有花 */
export function roseArch(dead = false) {
  return sprite(30, 32, ({ px, rect }) => {
    for (const x of [2, 25]) {
      rect(x, 8, 3, 24, '#e8e0d0')
      rect(x + 2, 8, 1, 24, '#c0b8a8')
      for (let y = 10; y < 32; y += 4) rect(x, y, 3, 1, '#b8b0a0')
    }
    for (let k = 0; k <= 40; k++) {
      const a = Math.PI - (k / 40) * Math.PI
      const x = 15 + Math.cos(a) * 12,
        y = 10 - Math.sin(a) * 8
      px(x, y, '#e8e0d0')
      px(x, y + 1, '#c0b8a8')
    }
    for (let k = 0; k < 40; k++) {
      const a = Math.PI - hash(k, 1, 5) * Math.PI
      const r = 11 + hash(k, 2, 5) * 3
      const x = 15 + Math.cos(a) * r,
        y = 10 - Math.sin(a) * (r - 4)
      px(x, y, dead ? (k % 3 ? '#6a5a3a' : '#8a7448') : k % 3 ? '#4d7a45' : '#6b9a52')
      if (k % 2 && !dead) px(x + 1, y, k % 4 === 1 ? '#e05a6a' : '#f4a0b0')
    }
    for (let k = 0; k < 16; k++) {
      const x = k % 2 ? 1 + Math.floor(hash(k, 3, 5) * 5) : 24 + Math.floor(hash(k, 3, 5) * 5)
      px(x, 12 + Math.floor(hash(k, 4, 5) * 18), dead ? '#6a5a3a' : k % 3 ? '#4d7a45' : '#e05a6a')
    }
  })
}

/** broken 为 true 时顶棚塌了一块 */
export function gazebo(broken = false) {
  return sprite(42, 42, ({ px, rect }) => {
    for (let y = 2; y <= 14; y++) {
      const half = Math.round(((y - 1) / 13) * 20)
      for (let x = 21 - half; x <= 21 + half; x++) {
        if (broken && y > 5 && Math.hypot(x - 27, y - 10) < 5 + hash(x, y, 6) * 2) continue
        px(x, y, x > 21 + half * 0.4 ? '#3f6a5e' : x < 21 - half * 0.5 ? '#6a9a86' : '#4f7f6e')
      }
    }
    rect(20, 0, 2, 2, '#c8a040')
    rect(0, 15, 42, 2, '#e8e0d0')
    for (const x of [3, 14, 26, 37]) {
      rect(x, 17, 3, 18, '#f0ece2')
      rect(x + 2, 17, 1, 18, '#c8c2b4')
    }
    rect(3, 27, 37, 1, '#d8d0c0')
    for (let x = 4; x < 40; x += 3) rect(x, 28, 1, 5, '#d8d0c0')
    rect(1, 35, 40, 4, '#b8a888')
    rect(1, 35, 40, 1, '#d0c0a0')
    rect(1, 38, 40, 1, '#8a7a60')
  })
}

export const VILLAGE_LANDMARKS: LandmarkSet = {
  boat,
  plans: {
    ferris: () => [[ferrisWheel(), 0, -6]],
    carousel: () => [[carousel(), 0, -4]],
    obelisk: () => [[obelisk(), 0, -6]],
    fountain: () => [[fountain(), 0, -4]],
    temple: () => [[temple(), 0, -6]],
    court: () => [[court(), 0, -8]],
    market: (seed) => [
      [stall(seed), -30, -10],
      [stall(seed + 1), 0, -14],
      [stall(seed + 2), 30, -10],
    ],
    garden: () => [[roseArch(), 0, -8]],
    park: () => [[gazebo(), 0, -6]],
  },
}

/** 第一条船停在栈桥外段的一侧（东西向停北边，立着的船身往上伸不挡住栈桥；南北向停东边），
 *  其余的停在栈桥尽头外面 */
function mooredBoat(dock: Dock, k: number, set: LandmarkSet, seed: number): LandmarkSprite {
  const along = k ? dock.length + 8 * PIXEL : dock.length * 0.7
  const x = dock.x + dock.dx * along + (!k && dock.dy ? 16 * PIXEL : 0),
    y = dock.y + dock.dy * along + (!k && dock.dx ? -3 * PIXEL : 0)
  return { x, y, canvas: set.boat(seed + k) }
}

/** 按区域摆出所有户外标志物；docks 是港口栈桥（世界坐标），每条旁边停一条船 */
export function landmarkSprites(
  atlas: Atlas,
  seed: number,
  docks: Dock[],
  set: LandmarkSet
): LandmarkSprite[] {
  const out: LandmarkSprite[] = docks.map((d, k) => mooredBoat(d, k, set, seed))
  for (const r of atlas.regions) {
    if (!r.cells.length) continue
    const xs = r.cells.map(([x]) => x * r.cell_size),
      ys = r.cells.map(([, y]) => y * r.cell_size)
    const box = {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs) + r.cell_size,
      y1: Math.max(...ys) + r.cell_size,
    }
    const plan = set.plans[r.kind]
    if (!plan) continue
    const cx = (box.x0 + box.x1) / 2,
      cy = (box.y0 + box.y1) / 2
    for (const [canvas, dx, dy] of plan(seed + out.length))
      out.push({ x: cx + dx * PIXEL, y: cy + dy * PIXEL, canvas })
  }
  return out
}
