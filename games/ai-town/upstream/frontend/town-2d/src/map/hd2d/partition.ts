// 屋里的隔墙：按落脚点和家具的分布，在最宽的一道空当上砌一面墙，把屋子分成两间。
// 村民在屋里是在落脚点之间直线走的，所以隔墙上的门洞要让开所有穿过这面墙的走法：
// 两边的落脚点（和屋门）两两连线，和墙线的交点落在哪一段，门洞就开多宽；门洞两边剩下的才砌墙。
// 坐标都以屋子中心为原点，x 东西、z 南北，单位是世界单位。

/** 两边的东西至少隔这么远才砌墙，墙两边各留半个家具的位置 */
const MIN_GAP = 60
/** 隔墙只砌在屋子中间这一段（离中心不超过边长的这个比例），贴着外墙的不算隔间 */
const CENTRAL = 0.22
/** 门洞比走动路线两边各宽出这么多，人不擦着墙过 */
const CLEARANCE = 20
/** 比这短的墙段不砌 */
const MIN_SEGMENT = 30

export interface Partition {
  /** true：墙沿东西方向，在 z = at；false：墙沿南北方向，在 x = at */
  alongX: boolean
  at: number
  /** 砌墙的几段，沿墙方向的起止 */
  segments: [number, number][]
  /** 门洞的起止 */
  opening: [number, number]
  /** 墙北侧（或西侧）是不是比另一侧大 */
  firstLarger: boolean
}

/**
 * w、h 是屋子东西、南北的长度，inset 是外墙厚度；points 是落脚点和家具，door 是屋门。
 * 找不到合适的空当，或者门洞要占满整面墙，就不砌。
 */
export function planPartition(
  w: number,
  h: number,
  inset: number,
  points: [number, number][],
  door?: [number, number]
): Partition | undefined {
  if (points.length < 2) return undefined
  let best: { axis: 0 | 1; at: number; gap: number } | undefined
  for (const axis of [0, 1] as const) {
    const extent = axis ? h : w
    const coords = points.map((p) => p[axis]).sort((a, b) => a - b)
    for (let i = 1; i < coords.length; i++) {
      const gap = coords[i] - coords[i - 1],
        at = (coords[i] + coords[i - 1]) / 2
      if (gap < MIN_GAP || Math.abs(at) > extent * CENTRAL) continue
      if (!best || gap > best.gap) best = { axis, at, gap }
    }
  }
  if (!best) return undefined
  const { axis, at } = best
  const other = axis ? 0 : 1
  const first = points.filter((p) => p[axis] < at),
    second = points.filter((p) => p[axis] >= at)
  if (door) (door[axis] < at ? first : second).push(door)
  let lo = Infinity,
    hi = -Infinity
  for (const p of first)
    for (const q of second) {
      const t = (at - p[axis]) / (q[axis] - p[axis])
      const cross = p[other] + (q[other] - p[other]) * t
      lo = Math.min(lo, cross)
      hi = Math.max(hi, cross)
    }
  const span = (axis ? w : h) / 2 - inset
  const opening: [number, number] = [
    Math.max(-span, lo - CLEARANCE),
    Math.min(span, hi + CLEARANCE),
  ]
  const segments = (
    [
      [-span, opening[0]],
      [opening[1], span],
    ] as [number, number][]
  ).filter(([a, b]) => b - a >= MIN_SEGMENT)
  if (!segments.length) return undefined
  return { alongX: axis === 1, at, segments, opening, firstLarger: at > 0 }
}
