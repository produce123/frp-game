import * as THREE from 'three'
import { PIXEL } from '../grid'
import { hash } from '../pixel/noise'
import { WALL_TEXEL, type House } from './layout'

// 屋顶几何：双坡、四坡、山墙朝街（屋脊南北向的双坡），十字脊和老虎窗是在双坡南坡上再叠一个朝南的小山墙。
// 原点在房屋中心的地面上，x 向东、z 向南。斜面过墙顶边线，出檐部分顺坡往下压。
// 斜面的贴图坐标：u 沿屋檐，v 从屋檐量到屋脊，都按主屋面的长度归一，所有斜面共用一张瓦面贴图、瓦片一样大。

/** 出檐 */
export const OVERHANG = 2 * PIXEL
/** 老虎窗：宽（地图像素）、窗墙高出墙顶多少、小屋脊再高出多少（贴图像素） */
const DORMER_WIDTH = 9
const DORMER_WALL = 6
const DORMER_RISE = 3

type V3 = [number, number, number]

/** 一片斜面：多边形顶点，屋檐上的起点、沿屋檐的单位向量、从屋檐到屋脊的向量 */
interface Slope {
  pts: V3[]
  eave: V3
  along: V3
  up: V3
}

/** 朝南的山墙面（十字脊和老虎窗正面）：多边形在 z 平面上，贴图铺满 [x0, x1] × [y0, y1] */
export interface Gable {
  pts: V3[]
  x0: number
  x1: number
  y0: number
  y1: number
  /** 顶上三角部分的高度：十字脊整个是三角；老虎窗下半截是一段矩形墙，开一扇小窗 */
  peak: number
  dormer: boolean
}

export interface RoofParts {
  /** 所有斜面合成的几何，用主屋面的瓦面贴图 */
  slopes: THREE.BufferGeometry
  /** 主屋面贴图的长（沿屋檐）和坡长（世界单位） */
  length: number
  slope: number
  /** 双坡两头的山墙三角，用墙面颜色 */
  ends: THREE.BufferGeometry | null
  /** 南坡上叠的小山墙正面 */
  gables: Gable[]
}

/** 屋脊方向的局部坐标 (u 沿屋脊, y, v 横过屋脊) 换到房屋坐标；屋脊南北向时 u 对 z、v 对 x */
function frame(alongX: boolean) {
  return ([u, y, v]: V3): V3 => (alongX ? [u, y, v] : [v, y, u])
}

/** 主屋面：沿屋脊的墙长 L、横过屋脊的进深 D、墙高 H、屋脊高出墙顶 r */
function mainSlopes(house: House): { slopes: Slope[]; L: number; D: number } {
  const { w, h, wallH: H, ridge: r, alongX, shape } = house
  const [L, D] = alongX ? [w, h] : [h, w]
  const o = OVERHANG
  const R = H + r,
    yE = H - (o * r) / (D / 2)
  const U0 = -L / 2 - o,
    U1 = L / 2 + o,
    V0 = -D / 2 - o,
    V1 = D / 2 + o
  const side = (v: number): Slope => ({
    pts: [],
    eave: [U0, yE, v],
    along: [1, 0, 0],
    up: [0, R - yE, -v],
  })
  const south = side(V1),
    north = side(V0)
  if (shape !== 'hip') {
    south.pts = [
      [U0, yE, V1],
      [U1, yE, V1],
      [U1, R, 0],
      [U0, R, 0],
    ]
    north.pts = [
      [U1, yE, V0],
      [U0, yE, V0],
      [U0, R, 0],
      [U1, R, 0],
    ]
    return { slopes: [north, south], L, D }
  }
  // 四坡：两头的斜面和两侧同样陡，屋脊两端各缩进半个进深；方形占地缩成一点就是攒尖
  const ua = Math.min(0, -L / 2 + D / 2),
    ub = Math.max(0, L / 2 - D / 2)
  south.pts = [
    [U0, yE, V1],
    [U1, yE, V1],
    [ub, R, 0],
    [ua, R, 0],
  ]
  north.pts = [
    [U1, yE, V0],
    [U0, yE, V0],
    [ua, R, 0],
    [ub, R, 0],
  ]
  const west: Slope = {
    pts: [
      [U0, yE, V0],
      [U0, yE, V1],
      [ua, R, 0],
    ],
    eave: [U0, yE, V0],
    along: [0, 0, 1],
    up: [ua - U0, R - yE, 0],
  }
  const east: Slope = {
    pts: [
      [U1, yE, V1],
      [U1, yE, V0],
      [ub, R, 0],
    ],
    eave: [U1, yE, V0],
    along: [0, 0, 1],
    up: [ub - U1, R - yE, 0],
  }
  return { slopes: [north, west, east, south], L, D }
}

/** 南坡上的小山墙：十字脊一个、老虎窗一到两个，放在屋顶上的位置按编号定（只用在屋脊东西向的房子上） */
function southGables(house: House): { slopes: Slope[]; gables: Gable[] } {
  const { w, h, wallH: H, ridge: r, shape, seed } = house
  if (shape !== 'cross' && shape !== 'dormer') return { slopes: [], gables: [] }
  const k = r / (h / 2)
  // 主屋南坡上高度 y 处离房屋中心线的距离
  const zAt = (y: number) => (h / 2) * (1 - (y - H) / r)
  const spans: [number, number][] = []
  if (shape === 'cross') {
    const cw = Math.min(w * 0.36, h * 0.85)
    const a = hash(seed, 8, 7) < 0.5 ? -w / 2 + w * 0.1 : w / 2 - w * 0.1 - cw
    spans.push([a, a + cw])
  } else {
    const half = (DORMER_WIDTH * PIXEL) / 2
    const centers = w / PIXEL > 44 ? [-w * 0.2, w * 0.2] : [0]
    for (const c of centers) spans.push([c - half, c + half])
  }
  const slopes: Slope[] = [],
    gables: Gable[] = []
  for (const [a, b] of spans) {
    const dormer = shape === 'dormer'
    const cc = (a + b) / 2,
      half = (b - a) / 2
    const Yw = H + (dormer ? DORMER_WALL * WALL_TEXEL : 0)
    const rise = dormer ? DORMER_RISE * WALL_TEXEL : k * half
    const R2 = Yw + rise
    const o = dormer ? PIXEL : OVERHANG
    const yE = Yw - (o * rise) / half
    const zF = h / 2 + o
    const back = zAt(yE),
      top = zAt(R2)
    // 斜面的屋檐从正面伸到碰上主屋面为止；十字脊和主屋同坡度，屋檐那头收成一点
    const westPts: V3[] = [
      [a - o, yE, zF],
      [cc, R2, zF],
      [cc, R2, top],
    ]
    const eastPts: V3[] = [
      [b + o, yE, zF],
      [b + o, yE, back],
      [cc, R2, top],
      [cc, R2, zF],
    ]
    if (back < zF - 0.01) westPts.push([a - o, yE, back])
    else eastPts.splice(1, 1)
    slopes.push(
      { pts: westPts, eave: [a - o, yE, zF], along: [0, 0, -1], up: [cc - (a - o), R2 - yE, 0] },
      { pts: eastPts, eave: [b + o, yE, zF], along: [0, 0, -1], up: [cc - (b + o), R2 - yE, 0] }
    )
    // 正面贴在墙面外一点，底边压进墙顶一个贴图像素
    const zw = h / 2 + PIXEL / 4,
      y0 = H - WALL_TEXEL
    const pts: V3[] = dormer
      ? [
          [a, y0, zw],
          [b, y0, zw],
          [b, Yw, zw],
          [cc, R2, zw],
          [a, Yw, zw],
        ]
      : [
          [a, y0, zw],
          [b, y0, zw],
          [cc, R2, zw],
        ]
    gables.push({ pts, x0: a, x1: b, y0, y1: R2, peak: R2 - (dormer ? Yw : y0), dormer })
  }
  return { slopes, gables }
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** 斜面按扇形拆三角；uv 按主屋面的长和坡长归一 */
function slopeGeometry(slopes: Slope[], length: number, slope: number) {
  const pos: number[] = [],
    uv: number[] = []
  for (const s of slopes) {
    const upLen = Math.hypot(...s.up)
    const vertex = (p: V3) => {
      const d = sub(p, s.eave)
      pos.push(...p)
      uv.push(dot(d, s.along) / length, dot(d, s.up) / upLen / slope)
    }
    for (let i = 1; i + 1 < s.pts.length; i++) {
      vertex(s.pts[0])
      vertex(s.pts[i])
      vertex(s.pts[i + 1])
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  g.computeVertexNormals()
  return g
}

/** 屋顶的各个部分，都在房屋坐标里 */
export function roofParts(house: House): RoofParts {
  const { wallH: H, ridge: r, alongX, shape } = house
  const toHouse = frame(alongX)
  const main = mainSlopes(house)
  const { L, D } = main
  const turned = main.slopes.map((s) => ({
    pts: s.pts.map(toHouse),
    eave: toHouse(s.eave),
    along: toHouse(s.along),
    up: toHouse(s.up),
  }))
  const extra = southGables(house)
  const length = L + 2 * OVERHANG
  const slope = Math.hypot(D / 2 + OVERHANG, r + (OVERHANG * r) / (D / 2))
  let ends: THREE.BufferGeometry | null = null
  if (shape !== 'hip') {
    // 两头山墙：贴图横向铺满进深、纵向从墙顶到屋脊
    const pos: number[] = [],
      uv: number[] = []
    for (const u of [-L / 2, L / 2])
      for (const [v, y] of [
        [-D / 2, H],
        [D / 2, H],
        [0, H + r],
      ]) {
        pos.push(...toHouse([u, y, v]))
        uv.push((v + D / 2) / D, (y - H) / r)
      }
    ends = new THREE.BufferGeometry()
    ends.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    ends.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    ends.computeVertexNormals()
  }
  return {
    slopes: slopeGeometry([...turned, ...extra.slopes], length, slope),
    length,
    slope,
    ends,
    gables: extra.gables,
  }
}

/** 小山墙正面的几何，贴图铺满它的外框 */
export function gableGeometry(g: Gable) {
  const pos: number[] = [],
    uv: number[] = []
  const vertex = (p: V3) => {
    pos.push(...p)
    uv.push((p[0] - g.x0) / (g.x1 - g.x0), (p[1] - g.y0) / (g.y1 - g.y0))
  }
  for (let i = 1; i + 1 < g.pts.length; i++) {
    vertex(g.pts[0])
    vertex(g.pts[i])
    vertex(g.pts[i + 1])
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geometry.computeVertexNormals()
  return geometry
}

/** 房屋坐标 (x, z) 处主屋面的高度，烟囱从这里立起来 */
export function roofHeight(house: House, x: number, z: number) {
  const { w, h, wallH: H, ridge: r, alongX, shape } = house
  const [u, v] = alongX ? [x, z] : [z, x]
  const [L, D] = alongX ? [w, h] : [h, w]
  let drop = Math.abs(v)
  if (shape === 'hip') drop = Math.max(drop, Math.abs(u) - (L / 2 - D / 2))
  return H + r * (1 - drop / (D / 2))
}

/** 烟囱的位置：立在朝镜头的南坡上，整面看得见（放在北坡会被屋脊挡掉大半）。
 *  屋脊东西向时偏到一边，十字脊在哪边就放另一边；屋脊南北向时立在屋脊上偏南 */
export function chimneySpot(house: House): [number, number] {
  const { w, h, alongX, shape, seed } = house
  if (!alongX) return [0, h * 0.25]
  // 和 southGables 同一个挑法：十字脊在西边时烟囱放东边
  const east = shape === 'cross' ? hash(seed, 8, 7) < 0.5 : seed % 2 === 0
  // 两个老虎窗在 ±0.2 个房宽处，烟囱再往外挪一点
  return [(east ? 1 : -1) * w * (shape === 'dormer' ? 0.42 : 0.36), h * 0.2]
}
