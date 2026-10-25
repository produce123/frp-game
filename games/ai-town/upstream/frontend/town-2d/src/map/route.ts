import type { Atlas, Topology } from 'town-shared/mapDocument'
import type { WalkStep, WalkTarget } from 'town-shared/gameMap'
// 化身点击移动的选路。后端没有「走到某点」的命令，也不给化身寻路，所以路线在这里算。
// 可走面按 crates/host/src/maps/walk.rs 的规则从同一份地图文件重建：dwell 区域的格子、
// dwell 房间的矩形、道路走廊、门口的短通道。前端只负责挑路线，每一段仍然发方向，
// 真正的贴墙、滑动和阻挡由后端判定，所以这里的几何差一点也不会走错，只是路线略有出入。

/** 与 crates/kernel/src/avatar/geometry.rs 一致 */
const AVATAR_RADIUS = 0.24
/** 默认地图的道具图标是功能标记，后端给它一个固定的小占地 */
export const PROP_HALF: [number, number] = [0.3, 0.3]
/** 门口两侧各留一段短通道，宽度同后端 */
const DOOR_WIDTH = 1.2
/** 地图文件没写道路宽度时后端取 18 个单位 */
export const DEFAULT_EDGE_WIDTH = 18
/** 没有区域格子时的退路：2 米一格 */
const DEFAULT_CELL_METRES = 2
/** 起点或终点落在不可走格上时，最多往外找几圈 */
const NEAR_RINGS = 3

export interface RouteObstacle {
  space: string
  position: [number, number]
  half: [number, number]
}
interface Portal {
  id: string
  from: WalkTarget
  to: WalkTarget
}

const cellKey = (space: string, x: number, y: number) => `${space}|${x}|${y}`

/** 一张地图的可走格子图；道具变化时只重算被挡住的格子。 */
export class WalkRoutes {
  private readonly cell: number
  private readonly open = new Set<string>()
  /** 门口所在的格子 → 经过它的门，A* 据此跨空间 */
  private readonly doors = new Map<string, Portal[]>()
  private blocked = new Set<string>()

  constructor(
    atlas: Atlas,
    topology: Topology,
    private readonly units: number,
    /** 有三维数据时房间坐标要加摊开偏移，与 walk.rs 的 room_point 一致 */
    private readonly roomOffset: boolean
  ) {
    const dwell = new Set(topology.locales.filter((l) => l.kind === 'dwell').map((l) => l.id))
    this.cell =
      Math.min(
        ...atlas.regions.filter((r) => dwell.has(r.id)).map((r) => r.cell_size / units),
        DEFAULT_CELL_METRES
      ) || DEFAULT_CELL_METRES
    for (const r of atlas.regions) {
      if (!dwell.has(r.id)) continue
      const size = r.cell_size / units
      for (const [cx, cy] of r.cells) this.fillBox(OUTDOOR, [cx * size, cy * size], size, size)
    }
    for (const s of atlas.spaces) {
      if (!dwell.has(s.id)) continue
      const min = this.roomPoint(s, [s.bounds.x, s.bounds.y])
      const max = this.roomPoint(s, [s.bounds.x + s.bounds.width, s.bounds.y + s.bounds.height])
      this.fillBox(s.id, min, max[0] - min[0], max[1] - min[1])
    }
    for (const e of atlas.edges)
      this.fillCorridor(
        OUTDOOR,
        e.polyline.map((p) => this.metres(p)),
        (e.width ?? DEFAULT_EDGE_WIDTH) / units
      )
    for (const s of atlas.spaces) {
      // 图上画成门的装饰不能穿越：拓扑里必须有一条带「通行」的通道连着这个房间
      if (!s.door_outside || !s.door_inside_local || !dwell.has(s.id)) continue
      if (
        !(topology.passages ?? []).some(
          (p) => (p.a === s.id || p.b === s.id) && p.capabilities.includes('通行')
        )
      )
        continue
      const outside: WalkTarget = { space: OUTDOOR, position: this.metres(s.door_outside) }
      const inside: WalkTarget = { space: s.id, position: this.roomPoint(s, s.door_inside_local) }
      for (const spot of [outside, inside])
        this.fillCorridor(spot.space, [spot.position, spot.position], DOOR_WIDTH)
      this.addPortal({ id: `${s.id}:enter`, from: outside, to: inside })
      this.addPortal({ id: `${s.id}:exit`, from: inside, to: outside })
    }
  }

  /** 地上的道具会挡路；拿走或收起来的不算 */
  setObstacles(list: RouteObstacle[]) {
    const blocked = new Set<string>()
    for (const o of list) {
      const reach = [o.half[0] + AVATAR_RADIUS, o.half[1] + AVATAR_RADIUS]
      const [x0, y0] = this.cellOf(o.position[0] - reach[0], o.position[1] - reach[1])
      const [x1, y1] = this.cellOf(o.position[0] + reach[0], o.position[1] + reach[1])
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const c = this.centre(x, y)
          if (
            Math.abs(c[0] - o.position[0]) < reach[0] &&
            Math.abs(c[1] - o.position[1]) < reach[1]
          )
            blocked.add(cellKey(o.space, x, y))
        }
    }
    this.blocked = blocked
  }

  /** 从 from 走到 to 的路径点；走不到返回 null。带 portal 的一步表示走到门口再开门。 */
  find(from: WalkTarget, to: WalkTarget): WalkStep[] | null {
    const start = this.nearestOpen(from),
      goal = this.nearestOpen(to)
    if (!start || !goal) return null
    const came = new Map<string, { previous: string; portal?: Portal }>()
    const best = new Map<string, number>([[start, 0]])
    const queue = new Heap()
    queue.push(start, this.guess(start, goal))
    while (queue.size) {
      const here = queue.pop()!
      if (here === goal) return this.steps(came, here, to)
      const cost = best.get(here)!
      for (const [next, step, portal] of this.neighbours(here)) {
        const total = cost + step
        if ((best.get(next) ?? Infinity) <= total) continue
        best.set(next, total)
        came.set(next, { previous: here, portal })
        queue.push(next, total + this.guess(next, goal))
      }
    }
    return null
  }

  // ---- 内部 ----

  private addPortal(portal: Portal) {
    const [x, y] = this.cellOf(...portal.from.position)
    const key = cellKey(portal.from.space, x, y)
    this.doors.set(key, [...(this.doors.get(key) ?? []), portal])
  }
  private metres(p: [number, number]): [number, number] {
    return [p[0] / this.units, p[1] / this.units]
  }
  private roomPoint(space: Atlas['spaces'][number], p: [number, number]): [number, number] {
    return this.roomOffset
      ? this.metres([p[0] + space.unfold.offset_x, p[1] + space.unfold.offset_y])
      : this.metres(p)
  }
  private cellOf(x: number, y: number): [number, number] {
    return [Math.floor(x / this.cell), Math.floor(y / this.cell)]
  }
  private centre(x: number, y: number): [number, number] {
    return [(x + 0.5) * this.cell, (y + 0.5) * this.cell]
  }
  private parse(key: string): { space: string; x: number; y: number } {
    const i = key.indexOf('|'),
      j = key.lastIndexOf('|')
    return { space: key.slice(0, i), x: Number(key.slice(i + 1, j)), y: Number(key.slice(j + 1)) }
  }
  private point(key: string): [number, number] {
    const { x, y } = this.parse(key)
    return this.centre(x, y)
  }
  /** 格子中心落在矩形里就算可走 */
  private fillBox(space: string, min: [number, number], width: number, height: number) {
    const [x0, y0] = this.cellOf(min[0], min[1])
    const [x1, y1] = this.cellOf(min[0] + width, min[1] + height)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const c = this.centre(x, y)
        if (c[0] >= min[0] && c[0] <= min[0] + width && c[1] >= min[1] && c[1] <= min[1] + height)
          this.open.add(cellKey(space, x, y))
      }
  }
  /** 格子中心到折线的距离不超过半宽就算可走 */
  private fillCorridor(space: string, points: [number, number][], width: number) {
    const half = width / 2
    for (let i = 0; i < Math.max(1, points.length - 1); i++) {
      const a = points[i],
        b = points[i + 1] ?? points[i]
      const [x0, y0] = this.cellOf(Math.min(a[0], b[0]) - half, Math.min(a[1], b[1]) - half)
      const [x1, y1] = this.cellOf(Math.max(a[0], b[0]) + half, Math.max(a[1], b[1]) + half)
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          if (segmentDistance(this.centre(x, y), a, b) <= half) this.open.add(cellKey(space, x, y))
    }
  }
  private walkable(key: string) {
    return this.open.has(key) && !this.blocked.has(key)
  }
  /** 目标落在不可走格上时就近找一个能站的格子 */
  private nearestOpen(at: WalkTarget): string | null {
    const [cx, cy] = this.cellOf(...at.position)
    for (let ring = 0; ring <= NEAR_RINGS; ring++)
      for (let x = cx - ring; x <= cx + ring; x++)
        for (let y = cy - ring; y <= cy + ring; y++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== ring) continue
          const key = cellKey(at.space, x, y)
          if (this.walkable(key)) return key
        }
    return null
  }
  /** 四邻接不会切到格子的角；门是额外的一条跨空间的边 */
  private neighbours(key: string): [string, number, Portal?][] {
    const { space, x, y } = this.parse(key)
    const out: [string, number, Portal?][] = []
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const next = cellKey(space, x + dx, y + dy)
      if (this.walkable(next)) out.push([next, this.cell])
    }
    for (const portal of this.doors.get(key) ?? []) {
      const [tx, ty] = this.cellOf(...portal.to.position)
      const next = cellKey(portal.to.space, tx, ty)
      if (this.walkable(next)) out.push([next, this.cell, portal])
    }
    return out
  }
  private guess(from: string, to: string) {
    const a = this.parse(from),
      b = this.parse(to)
    // 跨空间时曼哈顿距离没有意义，给 0 退化成 Dijkstra，仍然找得到最短路
    if (a.space !== b.space) return 0
    return (Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) * this.cell
  }
  /** 回溯成路径点，再把同一空间内看得通的连续点并掉 */
  private steps(
    came: Map<string, { previous: string; portal?: Portal }>,
    goal: string,
    to: WalkTarget
  ): WalkStep[] {
    const chain: { key: string; portal?: Portal }[] = [{ key: goal }]
    for (let key = goal; came.has(key);) {
      const from = came.get(key)!
      chain[chain.length - 1].portal = from.portal
      chain.push({ key: from.previous })
      key = from.previous
    }
    chain.reverse()
    const raw: WalkStep[] = []
    for (let i = 0; i < chain.length; i++) {
      const { key, portal } = chain[i]
      const space = this.parse(key).space
      // 穿门要站到门口那一点上，后端要求离门 1.6 米内才开得了门
      if (portal) raw.push({ point: portal.from, portal: portal.id })
      else raw.push({ point: { space, position: this.point(key) } })
    }
    raw.push({ point: to })
    return this.smooth(raw)
  }
  /** 连续两点之间直线可走时去掉中间的点，走出来才不是锯齿 */
  private smooth(steps: WalkStep[]): WalkStep[] {
    const out: WalkStep[] = []
    for (let i = 0; i < steps.length;) {
      out.push(steps[i])
      if (steps[i].portal) {
        i++
        continue
      }
      let next = i + 1
      for (let j = i + 2; j < steps.length; j++) {
        if (steps[j - 1].portal || steps[j].portal) break
        if (steps[j].point.space !== steps[i].point.space) break
        if (!this.clearLine(steps[i].point, steps[j].point)) break
        next = j
      }
      i = next
    }
    return out.filter((s, i) => i === 0 || s.portal || !same(s.point, out[i - 1].point))
  }
  private clearLine(a: WalkTarget, b: WalkTarget) {
    const distance = Math.hypot(b.position[0] - a.position[0], b.position[1] - a.position[1])
    const steps = Math.ceil(distance / (this.cell / 2))
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const [x, y] = this.cellOf(
        a.position[0] + (b.position[0] - a.position[0]) * t,
        a.position[1] + (b.position[1] - a.position[1]) * t
      )
      if (!this.walkable(cellKey(a.space, x, y))) return false
    }
    return true
  }
}

/** 同 grid.ts 的 OUTDOOR_SPACE。scripts/tests/avatar-walk-to.test.mjs 把本文件单独编译后加载，
 *  本文件不能有运行时 import，所以这里另写一份 */
const OUTDOOR = 'town_outdoor'

function same(a: WalkTarget, b: WalkTarget) {
  return a.space === b.space && a.position[0] === b.position[0] && a.position[1] === b.position[1]
}

function segmentDistance(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1]
  const length = dx * dx + dy * dy
  const t = length
    ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    : 0
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t))
}

/** A* 的开放集合；地图一格 2 米，整张图约一万五千格，一次查询几毫秒 */
class Heap {
  private items: { key: string; rank: number }[] = []
  get size() {
    return this.items.length
  }
  push(key: string, rank: number) {
    this.items.push({ key, rank })
    for (let i = this.items.length - 1; i > 0;) {
      const parent = (i - 1) >> 1
      if (this.items[parent].rank <= this.items[i].rank) break
      ;[this.items[parent], this.items[i]] = [this.items[i], this.items[parent]]
      i = parent
    }
  }
  pop() {
    const top = this.items[0]
    const last = this.items.pop()!
    if (this.items.length) {
      this.items[0] = last
      for (let i = 0; ;) {
        const left = i * 2 + 1,
          right = left + 1
        let small = i
        if (left < this.items.length && this.items[left].rank < this.items[small].rank) small = left
        if (right < this.items.length && this.items[right].rank < this.items[small].rank)
          small = right
        if (small === i) break
        ;[this.items[small], this.items[i]] = [this.items[i], this.items[small]]
        i = small
      }
    }
    return top?.key
  }
}
