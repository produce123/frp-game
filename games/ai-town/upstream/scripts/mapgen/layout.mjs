import { boundaryDistances, clamp, contains, dist, Heap, key, project } from './geometry.mjs'
import { rect } from './geometry.mjs'
import { noise, stream } from './document.mjs'
import { GenerationError, PARAMETERS } from './budget.mjs'

const CELL = PARAMETERS.cell_size
export function contour(plan, p, motif) {
  plan.budget.check('contours')
  const box = rect(p),
    x0 = Math.ceil(box.x / CELL),
    y0 = Math.ceil(box.y / CELL),
    x1 = Math.floor((box.x + box.w) / CELL) - 1,
    y1 = Math.floor((box.y + box.h) / CELL) - 1
  const source = new Set(motif.cells.map(key)),
    rng = stream(plan.spec.seed, 'contour', p.id),
    flip = rng() < 0.5
  const fill = clamp(source.size / (motif.width * motif.height), 0.45, 0.9),
    target = Math.round((p.w * p.h * fill) / (CELL * CELL))
  const inside = (x, y) => x >= x0 + 2 && x <= x1 - 2 && y >= y0 + 2 && y <= y1 - 2
  const sourceMask = new Set(),
    all = []
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const sx = Math.floor(((flip ? x1 - x : x - x0) / (x1 - x0 + 1)) * motif.width),
        sy = Math.floor(((y - y0) / (y1 - y0 + 1)) * motif.height)
      const k = key([x, y])
      all.push([x, y])
      if (source.has(key([sx, sy]))) sourceMask.add(k)
    }
  const sd = new Map(),
    wave = []
  for (const v of all)
    if (
      [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([a, b]) => sourceMask.has(key([v[0] + a, v[1] + b])) !== sourceMask.has(key(v)))
    ) {
      sd.set(key(v), 0)
      wave.push(v)
    }
  for (let i = 0; i < wave.length; i++)
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const v = [wave[i][0] + dx, wave[i][1] + dy],
        k = key(v)
      if (v[0] >= x0 && v[0] <= x1 && v[1] >= y0 && v[1] <= y1 && !sd.has(k)) {
        sd.set(k, sd.get(key(wave[i])) + 1)
        wave.push(v)
      }
    }
  const core = [
    clamp(Math.floor(p.x / CELL), x0 + 2, x1 - 2),
    clamp(Math.floor(p.y / CELL), y0 + 2, y1 - 2),
  ]
  const door = [
    clamp(Math.floor(p.door[0] / CELL), x0 + 2, x1 - 2),
    clamp(Math.floor(p.door[1] / CELL), y0 + 2, y1 - 2),
  ]
  const selected = new Set(),
    paint = new Set(),
    queued = new Set(),
    heap = new Heap(),
    field = noise(plan.spec.seed, `contour:${p.id}`, plan.L * 2)
  const enqueue = (v) => {
    const k = key(v)
    if (!inside(...v) || queued.has(k)) return
    queued.add(k)
    const signed = ((sd.get(k) ?? 0) * (sourceMask.has(k) ? -1 : 1) * CELL) / plan.L
    heap.push(
      v,
      0.6 * signed + (0.3 * dist(v, core) * CELL) / plan.L + 0.1 * field(v[0] * CELL, v[1] * CELL)
    )
  }
  const add = (v) => {
    const k = key(v)
    if (selected.has(k)) return
    selected.add(k)
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) paint.add(key([v[0] + a, v[1] + b]))
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      enqueue([v[0] + dx, v[1] + dy])
  }
  add(core)
  const walk = [...core]
  while (walk[0] !== door[0]) {
    walk[0] += Math.sign(door[0] - walk[0])
    add([...walk])
  }
  while (walk[1] !== door[1]) {
    walk[1] += Math.sign(door[1] - walk[1])
    add([...walk])
  }
  while (heap.size && paint.size < target) add(heap.pop())
  const cells = [...paint]
    .map((k) => k.split(',').map(Number))
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
  if (cells.length < target * 0.85)
    throw new GenerationError('INSUFFICIENT_SPACE', `${p.name}的连续区域面积不足`, {
      stage: 'contours',
      place_refs: [p.ref],
      expected: target * 0.85,
      measured: cells.length,
    })
  const distances = boundaryDistances(cells)
  const anchors = [...cells].sort(
    (a, b) => distances.get(key(b)) - distances.get(key(a)) || dist(a, core) - dist(b, core)
  )
  const anchor = anchors[0].map((n) => n * CELL + CELL / 2)
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    cell_size: CELL,
    cells,
    bounds: { x: box.x, y: box.y, width: box.w, height: box.h },
    label_anchor: anchor,
    area_budget: target * CELL * CELL,
  }
}

/**
 * 室内家具沿西墙、北墙、东墙这三面均匀摆开，南墙和屋子中间留给进门和走动；
 * 门开在别的墙上时门口那段也让出来。排不下（相邻两件不到 100）返回 null。
 */
function alongWalls(p) {
  const M = 80,
    w = p.w,
    h = p.h
  const door = [p.door[0] - (p.x - w / 2), p.door[1] - (p.y - h / 2)]
  const onWall = Math.min(door[0], w - door[0], door[1], h - door[1]) < 40
  const bottom = Math.max(M, h - M - 60)
  const corners = [
    [M, bottom],
    [M, M],
    [w - M, M],
    [w - M, bottom],
  ]
  const slots = []
  for (let k = 0; k + 1 < corners.length; k++) {
    const [a, b] = [corners[k], corners[k + 1]]
    const steps = Math.max(1, Math.round(dist(a, b) / 10))
    for (let i = k ? 1 : 0; i <= steps; i++) {
      const q = [
        Math.round(a[0] + ((b[0] - a[0]) * i) / steps),
        Math.round(a[1] + ((b[1] - a[1]) * i) / steps),
      ]
      if (!onWall || dist(q, door) >= 120) slots.push(q)
    }
  }
  const n = p.props.length
  if (slots.length < n) return null
  const picked = p.props.map((_, i) => slots[Math.floor(((i + 0.5) * slots.length) / n)])
  for (let i = 0; i < n; i++)
    for (let j = 0; j < i; j++) if (dist(picked[i], picked[j]) < 100) return null
  return picked
}

export function placeProps(plan, p) {
  if (!p.outdoor) {
    const walls = alongWalls(p)
    if (walls) {
      p.propPositions = walls
      return
    }
    const columns = Math.max(1, Math.floor((p.w - 160) / 130) + 1),
      rows = Math.ceil(p.props.length / columns)
    if (rows > 1 && (p.h - 160) / (rows - 1) < 100)
      throw new GenerationError('INSUFFICIENT_SPACE', `${p.name}无法容纳道具`, {
        stage: 'props',
        place_refs: [p.ref],
      })
    p.propPositions = p.props.map((_, i) => [
      Math.round(80 + ((i % columns) * (p.w - 160)) / Math.max(1, columns - 1)),
      Math.round(80 + Math.floor(i / columns) * Math.min(140, (p.h - 160) / Math.max(1, rows - 1))),
    ])
    return
  }
  const distances = boundaryDistances(p.surface.cells),
    used = [],
    rng = stream(plan.spec.seed, 'prop-position', p.id)
  const candidates = p.surface.cells
    .filter((c) => distances.get(key(c)) >= 2)
    .map((c) => c.map((n) => n * CELL + CELL / 2))
  p.propPositions = p.props.map((_, i) => {
    const bias = [p.x + (rng() - 0.5) * p.w * 0.4, p.y + (rng() - 0.5) * p.h * 0.4]
    const valid = candidates.filter(
      (q) => dist(q, p.door) >= 90 && used.every((v) => dist(q, v) >= 100)
    )
    valid.sort((a, b) => dist(a, bias) - dist(b, bias) || a[1] - b[1] || a[0] - b[0])
    if (!valid.length)
      throw new GenerationError('INSUFFICIENT_SPACE', `${p.name}缺少道具使用空间`, {
        stage: 'props',
        place_refs: [p.ref],
        measured: i,
        expected: p.props.length,
      })
    used.push(valid[0])
    return valid[0]
  })
  const labelCandidates = candidates.filter(
    (q) => used.every((v) => dist(q, v) >= 100) && dist(q, p.door) > 120
  )
  if (labelCandidates.length) {
    labelCandidates.sort((a, b) => dist(a, [p.x, p.y]) - dist(b, [p.x, p.y]))
    p.surface.label_anchor = labelCandidates[0]
  }
}

export function roadCells(edges, rooms = []) {
  const cells = new Set()
  for (const road of edges)
    for (let i = 1; i < road.polyline.length; i++) {
      const a = road.polyline[i - 1],
        b = road.polyline[i],
        radius = road.width / 2
      for (
        let x = Math.floor((Math.min(a[0], b[0]) - radius) / CELL);
        x <= Math.floor((Math.max(a[0], b[0]) + radius) / CELL);
        x++
      )
        for (
          let y = Math.floor((Math.min(a[1], b[1]) - radius) / CELL);
          y <= Math.floor((Math.max(a[1], b[1]) + radius) / CELL);
          y++
        ) {
          const q = [(x + 0.5) * CELL, (y + 0.5) * CELL]
          if (project(q, a, b).distance <= radius + 2 && !rooms.some((r) => contains(r, q)))
            cells.add(key([x, y]))
        }
    }
  return {
    cell_size: CELL,
    cells: [...cells]
      .map((k) => k.split(',').map(Number))
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]),
  }
}
