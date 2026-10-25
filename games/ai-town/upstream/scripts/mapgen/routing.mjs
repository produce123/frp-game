import {
  Heap,
  clamp,
  contains,
  dist,
  lerp,
  quantize,
  resample,
  simplify,
  smooth,
} from './geometry.mjs'
import { stream } from './document.mjs'
import { parcelSegmentAabb } from './oriented-parcel.mjs'
import { debug } from './debug.mjs'

const MOVES = [
  [1, 0],
  [2, 1],
  [1, 1],
  [1, 2],
  [0, 1],
  [-1, 2],
  [-1, 1],
  [-2, 1],
  [-1, 0],
  [-2, -1],
  [-1, -1],
  [-1, -2],
  [0, -1],
  [1, -2],
  [1, -1],
  [2, -1],
]
function preferredAxis(plan, p) {
  let x = 0,
    y = 0
  for (const d of plan.districts) {
    const w = Math.exp(-((dist(p, d.center) / d.radius) ** 2))
    x += w * Math.cos(2 * d.axis)
    y += w * Math.sin(2 * d.axis)
  }
  return Math.hypot(x, y) < 1e-8 ? plan.districts[0].axis : Math.atan2(y, x) / 2
}
function routeContext(plan, width, ignore, clearanceOverride) {
  const clearance = clearanceOverride ?? width / 2 + 25,
    ignored = new Set(Array.isArray(ignore) ? ignore : ignore ? [ignore] : []),
    obstacleParcels = plan.places.filter((p) => p.placed && !ignored.has(p.id))
  const bounds = {
    x: width / 2 + 4,
    y: width / 2 + 4,
    w: plan.width - width - 8,
    h: plan.height - width - 8,
  }
  const free = (a, b) =>
    contains(bounds, a) &&
    contains(bounds, b) &&
    // Keep route clearance consistent with parcel placement. Authored 3D
    // buildings can be rotated, so their axis-aligned bounding rectangles
    // contain empty corner space. Treating those corners as solid made valid
    // doorways look blocked.
    !obstacleParcels.some((p) => parcelSegmentAabb(p, a, b, clearance))
  return { free, bounds }
}
export function freePoint(plan, p, width = 100) {
  const { free } = routeContext(plan, width + 8)
  if (free(quantize(p), quantize(p))) return quantize(p)
  for (let ring = 1; ring <= 16; ring++)
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8,
        q = quantize([p[0] + Math.cos(a) * ring * 80, p[1] + Math.sin(a) * ring * 80])
      if (free(q, q)) return q
    }
  return null
}
function astar(plan, start, goal, context, grid, cap = 50000) {
  const { free } = context
  if (free(start, goal)) return [start, goal]
  const open = new Heap(),
    costs = new Map(),
    parents = new Map(),
    points = new Map()
  const gx = Math.round(start[0] / grid),
    gy = Math.round(start[1] / grid)
  const entry = []
  for (let dx = -2; dx <= 2; dx++)
    for (let dy = -2; dy <= 2; dy++) {
      const point = [(gx + dx) * grid, (gy + dy) * grid]
      if (free(start, point))
        entry.push({
          point,
          gx: gx + dx,
          gy: gy + dy,
          distance: dist(start, point),
        })
    }
  entry.sort((a, b) => a.distance - b.distance || a.gx - b.gx || a.gy - b.gy)
  for (const p of entry.slice(0, 4)) {
    const id = `${p.gx},${p.gy},16`
    costs.set(id, p.distance)
    points.set(id, p.point)
    parents.set(id, null)
    open.push({ id, x: p.gx, y: p.gy, dir: 16, g: p.distance }, p.distance + dist(p.point, goal))
  }
  let expanded = 0
  // 单次搜索上限就是预算表的 route_states（3 万）：一条连不上的边不能
  // 烧光全镇的路网预算。全局闸门是 budget.caps.total_route_states。
  const perCallCap = Math.min(plan.budget.caps.route_states, cap)
  while (open.size && expanded++ < perCallCap) {
    plan.budget.route('roads')
    const state = open.pop()
    if (state.g !== costs.get(state.id)) continue
    const p = points.get(state.id)
    if (dist(p, goal) <= grid * 2.5 && free(p, goal)) {
      const path = [goal]
      for (let id = state.id; id; id = parents.get(id)) path.push(points.get(id))
      path.push(start)
      return path.reverse()
    }
    const axis = preferredAxis(plan, p)
    for (let dir = 0; dir < MOVES.length; dir++) {
      const [dx, dy] = MOVES[dir],
        q = [(state.x + dx) * grid, (state.y + dy) * grid]
      if (!free(p, q)) continue
      const angle = Math.atan2(dy, dx)
      let turn = 0
      if (state.dir < 16) {
        const prev = MOVES[state.dir]
        turn =
          Math.acos(
            clamp((prev[0] * dx + prev[1] * dy) / (Math.hypot(...prev) * Math.hypot(dx, dy)), -1, 1)
          ) / Math.PI
      }
      const g =
        state.g +
        dist(p, q) *
          (1 + 0.2 * plan.roadNoise(...q) + 0.35 * Math.sin(angle - axis) ** 2 + 0.8 * turn * turn)
      const id = `${state.x + dx},${state.y + dy},${dir}`
      if (g >= (costs.get(id) ?? Infinity)) continue
      costs.set(id, g)
      parents.set(id, state.id)
      points.set(id, q)
      open.push({ id, x: state.x + dx, y: state.y + dy, dir, g }, g + dist(q, goal))
    }
  }
  return null
}
export function route(
  plan,
  a,
  b,
  { id, width = 80, ignore, curved = true, via, clearance, snapEndpoints } = {}
) {
  plan.budget.check('roads')
  const context = routeContext(plan, width + 4, ignore, clearance == null ? null : clearance + 2),
    finalContext = routeContext(plan, width, ignore, clearance)
  // 人行入口的建筑侧端点可以沿门面滑动几米：门口被邻居的轴对齐包盒角部
  // 压住时，把落点挪到旁边 4m 内的净空点，而不是整条路判死。
  // 只动 b（门口侧）：a 是街道侧端点，必须精确压在线网上，挪了图就断。
  const snapFree = (p) => {
    if (context.free(p, p)) return p
    for (let ring = 1; ring <= 4; ring++)
      for (let i = 0; i < 16; i++) {
        const angle = (i * Math.PI) / 8,
          q = quantize([p[0] + Math.cos(angle) * ring * 60, p[1] + Math.sin(angle) * ring * 60])
        if (context.free(q, q)) return q
      }
    return null
  }
  if (snapEndpoints) {
    const snappedB = snapFree(b)
    if (snappedB) b = snappedB
  }
  if (!context.free(a, a) || !context.free(b, b)) {
    plan.routeFailures.push({ id, reason: 'endpoint', a, b })
    debug?.(
      `[route] ${id} 端点不可用：${[a, b]
        .filter((point) => !context.free(point, point))
        .map((point) => {
          const blocker = plan.places.find(
            (place) =>
              place.placed &&
              parcelSegmentAabb(
                place,
                point,
                point,
                clearance == null ? (width + 4) / 2 + 25 : clearance + 2
              )
          )
          return `[${point.map(Math.round)}] ${blocker ? '被 ' + blocker.ref + ' 占住' : '出界'}`
        })
        .join('；')}`
    )
    return null
  }
  const rng = stream(plan.spec.seed, 'road', id),
    checkpoints = [a],
    d = dist(a, b)
  // 途经点（via）：调用方指定的分段目标（外圈环路用它把路推向镇外），
  // 每段单独做一次 A*。
  const viaPoints = (via ?? []).filter((p) => context.free(p, p))
  if (viaPoints.length) checkpoints.push(...viaPoints)
  else if (curved && d > plan.L * 1.4) {
    const n = Math.min(3, Math.max(1, Math.floor(d / (plan.L * 1.4)))),
      side = rng() < 0.5 ? -1 : 1
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1),
        q = lerp(a, b, t),
        bend = plan.L * (0.08 + plan.roadNoise(...q) * 0.17) * Math.sin(t * Math.PI) * side
      const p = quantize([q[0] - ((b[1] - a[1]) / d) * bend, q[1] + ((b[0] - a[0]) / d) * bend])
      if (context.free(p, p)) checkpoints.push(p)
    }
  }
  checkpoints.push(b)
  const line = []
  for (let i = 1; i < checkpoints.length; i++) {
    const grid = plan.budget.caps.route_grid,
      statesBefore = plan.budget.counts.route_states,
      callCap = plan.budget.caps.route_states
    let part = astar(plan, checkpoints[i - 1], checkpoints[i], context, grid, callCap)
    if (!part) part = astar(plan, checkpoints[i - 1], checkpoints[i], context, grid / 2, callCap)
    if (plan.budget.counts.route_states - statesBefore > 20000)
      debug?.(
        `[route] ${id} 一段搜索用了 ${plan.budget.counts.route_states - statesBefore} 个状态，${part ? '找到' : '没找到'}路`
      )
    if (!part) {
      plan.routeFailures.push({
        id,
        reason: 'search',
        a: checkpoints[i - 1],
        b: checkpoints[i],
        states: plan.budget.counts.route_states,
      })
      return null
    }
    line.push(...simplify(part, context.free).slice(i === 1 ? 0 : 1))
  }
  let result = line
  const softened = smooth(line)
  if (softened.every((p, i) => !i || context.free(softened[i - 1], p))) result = softened
  result = resample(result)
  if (!result.every((p, i) => !i || finalContext.free(result[i - 1], p))) result = resample(line)
  let ok = result.every((p, i) => !i || finalContext.free(result[i - 1], p))
  // Quantizing densely resampled points can move a safe bend a few units into
  // a parcel corner. Keep the already validated A* polyline in that rare case;
  // the shared street-shaping pass will round it with the full road graph.
  if (!ok && line.every((p, i) => !i || finalContext.free(line[i - 1], p))) {
    result = line
    ok = true
  }
  if (!ok) plan.routeFailures.push({ id, reason: 'quantization', a, b })
  return ok ? result : null
}
