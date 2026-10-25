import type { Atlas } from 'town-shared/mapDocument'

// 2D 地图的几种坐标和它们之间的换算，平面图、SVG 层和立体场景共用。
// - 房间坐标：房间自己的坐标，摊开（unfold）后才落到地图上；室外的东西直接用地图坐标。
// - 地图坐标：SVG 用的坐标，立体场景里 x 同它、z 是它的 y。
// - 地面像素：地面画布上的一格，PIXEL 个地图单位；画布比地图四周多出 MARGIN。

/** 室外空间的编号；不在任何房间里的东西都属于它 */
export const OUTDOOR_SPACE = 'town_outdoor'
/** 地面画布一个像素 = PIXEL 个地图单位，镜头只按整数倍放大它 */
export const PIXEL = 6
/** 画布比地图四周多出的地图单位，取 PIXEL 的整数倍；要留够海岸和海，岛的外形才算得出来 */
export const MARGIN = 600
/** 没有三维数据的旧二维地图按 12 个地图单位一米烘焙，同 crates/host/src/maps/walk.rs */
export const LEGACY_UNITS_PER_METRE = 12

/** 地图坐标 → 地面像素 */
export const toPx = (v: number) => Math.round((v + MARGIN) / PIXEL)
/** 地面像素 → 地图坐标（像素左上角） */
export const fromPx = (p: number) => p * PIXEL - MARGIN
/** 地图上一点在宽 pw 的地面画布里的像素下标 */
export const pxIndex = (x: number, y: number, pw: number) => toPx(y) * pw + toPx(x)

type Unfold = Atlas['spaces'][number]['unfold']

/** 房间坐标 → 地图坐标 */
export function roomPoint(unfold: Unfold, x: number, y: number): [number, number] {
  return [unfold.offset_x + unfold.scale * x, unfold.offset_y + unfold.scale * y]
}

/** 摊开后的房间在地图上占的矩形：左上角 (x, y)、宽高 (w, h)、右下角 (x1, y1) */
export function roomRect({ bounds: b, unfold: u }: Atlas['spaces'][number]) {
  return {
    x: u.offset_x + u.scale * b.x,
    y: u.offset_y + u.scale * b.y,
    w: u.scale * b.width,
    h: u.scale * b.height,
    x1: u.offset_x + u.scale * (b.x + b.width),
    y1: u.offset_y + u.scale * (b.y + b.height),
  }
}
