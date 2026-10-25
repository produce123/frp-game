export const EPS = 1e-6
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const dot = (a, b) => a[0] * b[0] + a[1] * b[1]
const cross = (a, b) => a[0] * b[1] - a[1] * b[0]
// c 在有向线段 ab 左侧为正、右侧为负、共线为零。
export const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
export const quantize = (p) => p.map(Math.round)
export const key = (p) => p.join(',')
export const length = (ps) => ps.slice(1).reduce((s, p, i) => s + dist(ps[i], p), 0)
// 三维折线长度，供空间路线使用。
export const length3 = (ps) =>
  ps
    .slice(1)
    .reduce((s, p, i) => s + Math.hypot(p[0] - ps[i][0], p[1] - ps[i][1], p[2] - ps[i][2]), 0)
export const rect = (p, gap = 0) => ({
  id: p.id,
  x: p.x - p.w / 2 - gap,
  y: p.y - p.h / 2 - gap,
  w: p.w + gap * 2,
  h: p.h + gap * 2,
})
export const inflate = (r, gap) => ({
  ...r,
  x: r.x - gap,
  y: r.y - gap,
  w: r.w + gap * 2,
  h: r.h + gap * 2,
})
export const contains = (r, p, eps = 0) =>
  p[0] >= r.x - eps && p[0] <= r.x + r.w + eps && p[1] >= r.y - eps && p[1] <= r.y + r.h + eps
export const overlaps = (a, b, eps = EPS) =>
  a.x < b.x + b.w - eps && a.x + a.w > b.x + eps && a.y < b.y + b.h - eps && a.y + a.h > b.y + eps
export function segmentRect(a, b, r) {
  let lo = 0,
    hi = 1
  for (let axis = 0; axis < 2; axis++) {
    const start = axis ? r.y : r.x,
      size = axis ? r.h : r.w,
      delta = b[axis] - a[axis]
    if (Math.abs(delta) < EPS) {
      if (a[axis] <= start + EPS || a[axis] >= start + size - EPS) return false
    } else {
      const t1 = (start + EPS - a[axis]) / delta,
        t2 = (start + size - EPS - a[axis]) / delta
      lo = Math.max(lo, Math.min(t1, t2))
      hi = Math.min(hi, Math.max(t1, t2))
      if (lo >= hi) return false
    }
  }
  return hi > 0 && lo < 1
}
export function project(p, a, b) {
  const d = sub(b, a),
    dd = dot(d, d)
  const t = dd ? clamp(dot(sub(p, a), d) / dd, 0, 1) : 0
  const q = lerp(a, b, t)
  return { point: q, t, distance: dist(p, q) }
}
/** 射线法判断点是否在多边形内。 */
export function pointInPolygon(point, polygon) {
  let contained = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j]
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      contained = !contained
  }
  return contained
}
export function intersection(a, b, c, d) {
  const r = sub(b, a),
    s = sub(d, c),
    denom = cross(r, s)
  if (Math.abs(denom) < EPS) return null
  const t = cross(sub(c, a), s) / denom,
    u = cross(sub(c, a), r) / denom
  return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS
    ? {
        point: lerp(a, b, clamp(t, 0, 1)),
        t: clamp(t, 0, 1),
        u: clamp(u, 0, 1),
      }
    : null
}
export function nearestRoad(p, roads) {
  const choices = []
  for (const road of roads)
    for (let i = 1; i < road.polyline.length; i++) {
      const q = project(p, road.polyline[i - 1], road.polyline[i])
      choices.push({ ...q, road, index: i })
    }
  return choices.sort(
    (a, b) => a.distance - b.distance || a.road.id.localeCompare(b.road.id) || a.index - b.index
  )
}
function cleanLine(ps) {
  return ps.filter((p, i) => !i || dist(p, ps[i - 1]) > EPS)
}
export function resample(ps, step = 20) {
  const out = [ps[0]]
  for (let i = 1; i < ps.length; i++) {
    const n = Math.ceil(dist(ps[i - 1], ps[i]) / step)
    for (let j = 1; j <= n; j++) out.push(lerp(ps[i - 1], ps[i], j / n))
  }
  return cleanLine(out.map(quantize))
}
export function smooth(ps, rounds = 2) {
  for (let round = 0; round < rounds && ps.length > 2; round++) {
    const next = [ps[0]]
    for (let i = 1; i < ps.length; i++)
      next.push(lerp(ps[i - 1], ps[i], 0.25), lerp(ps[i - 1], ps[i], 0.75))
    next.push(ps.at(-1))
    ps = next
  }
  return ps
}
export function simplify(ps, free) {
  const out = [ps[0]]
  for (let i = 0; i < ps.length - 1;) {
    let j = Math.min(ps.length - 1, i + 12)
    while (j > i + 1 && !free(ps[i], ps[j])) j--
    out.push(ps[j])
    i = j
  }
  return out
}
export class Heap {
  items = []
  order = 0
  push(value, priority) {
    const item = { value, priority, order: this.order++ },
      a = this.items
    a.push(item)
    let i = a.length - 1
    while (i) {
      const p = (i - 1) >> 1
      if (!this.less(item, a[p])) break
      a[i] = a[p]
      i = p
    }
    a[i] = item
  }
  less(a, b) {
    return a.priority < b.priority || (a.priority === b.priority && a.order < b.order)
  }
  pop() {
    const a = this.items,
      first = a[0],
      last = a.pop()
    if (a.length) {
      let i = 0
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1
        if (c + 1 < a.length && this.less(a[c + 1], a[c])) c++
        if (!this.less(a[c], last)) break
        a[i] = a[c]
        i = c
      }
      a[i] = last
    }
    return first?.value
  }
  get size() {
    return this.items.length
  }
}
export function components(cells) {
  const left = new Set(cells.map(key)),
    groups = []
  while (left.size) {
    const first = left.values().next().value,
      q = [first],
      group = []
    left.delete(first)
    for (let i = 0; i < q.length; i++) {
      const p = q[i].split(',').map(Number)
      group.push(p)
      for (const v of [
        [p[0] - 1, p[1]],
        [p[0] + 1, p[1]],
        [p[0], p[1] - 1],
        [p[0], p[1] + 1],
      ])
        if (left.delete(key(v))) q.push(key(v))
    }
    groups.push(group)
  }
  return groups
}
export function boundaryDistances(cells) {
  const set = new Set(cells.map(key)),
    distances = new Map(),
    q = []
  for (const p of cells)
    if (
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([x, y]) => !set.has(key([p[0] + x, p[1] + y])))
    ) {
      distances.set(key(p), 0)
      q.push(p)
    }
  for (let i = 0; i < q.length; i++) {
    const p = q[i],
      next = distances.get(key(p)) + 1
    for (const [x, y] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const v = [p[0] + x, p[1] + y],
        k = key(v)
      if (set.has(k) && !distances.has(k)) {
        distances.set(k, next)
        q.push(v)
      }
    }
  }
  return distances
}
