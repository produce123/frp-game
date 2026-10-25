export type Box = { x0: number; y0: number; x1: number; y1: number }

/** 顺序选择最少重叠的候选位置，并登记占用的区域。 */
export function placePropLabel(
  x: number,
  y: number,
  label: string,
  obstacles: Box[]
): [number, number] {
  const w = label.length * 33 + 26 // 两侧留白，免得相邻标签粘连成一句
  // 候选位：下、上、右、左、更下、更上、再下；全撞满时取重叠面积最小的
  const cands: [number, number][] = [
    [x, y + 58],
    [x, y - 42],
    [x + w / 2 + 36, y + 12],
    [x - w / 2 - 36, y + 12],
    [x, y + 96],
    [x, y - 80],
    [x, y + 134],
    [x + w / 2 + 36, y - 46],
    [x - w / 2 - 36, y - 46],
    [x + w / 2 + 36, y + 70],
    [x - w / 2 - 36, y + 70],
    [x, y + 172],
    [x, y - 118],
  ]
  const boxOf = (cx: number, cy: number): Box => ({
    x0: cx - w / 2,
    y0: cy - 34,
    x1: cx + w / 2,
    y1: cy + 10,
  })
  const overlapArea = (a: Box) =>
    obstacles.reduce((sum, b) => {
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
      const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
      return ox > 0 && oy > 0 ? sum + ox * oy : sum
    }, 0)
  let best = cands[0]
  let bestArea = Infinity
  for (const c of cands) {
    const area = overlapArea(boxOf(c[0], c[1]))
    if (area < bestArea) {
      best = c
      bestArea = area
    }
    if (area === 0) break
  }
  obstacles.push(boxOf(best[0], best[1]))
  return best
}
/** Choose an interior cell with room around it; a concave region's mean may lie outside it. */
export function regionLabelAnchor(cells: [number, number][], cellSize: number): [number, number] {
  if (!cells.length) return [0, 0]
  const key = (x: number, y: number) => `${x},${y}`
  const set = new Set(cells.map(([x, y]) => key(x, y)))
  const distance = new Map<string, number>(),
    queue: [number, number][] = []
  const moves = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]
  for (const p of cells)
    if (moves.some(([x, y]) => !set.has(key(p[0] + x, p[1] + y)))) {
      distance.set(key(...p), 0)
      queue.push(p)
    }
  for (let i = 0; i < queue.length; i++)
    for (const [x, y] of moves) {
      const p: [number, number] = [queue[i][0] + x, queue[i][1] + y],
        k = key(...p)
      if (set.has(k) && !distance.has(k)) {
        distance.set(k, distance.get(key(...queue[i]))! + 1)
        queue.push(p)
      }
    }
  const center = cells.reduce(
    (v, p) => [v[0] + p[0] / cells.length, v[1] + p[1] / cells.length],
    [0, 0]
  )
  const best = [...cells].sort(
    (a, b) =>
      distance.get(key(...b))! - distance.get(key(...a))! ||
      Math.hypot(a[0] - center[0], a[1] - center[1]) -
        Math.hypot(b[0] - center[0], b[1] - center[1])
  )[0]
  return [(best[0] + 0.5) * cellSize, (best[1] + 0.5) * cellSize]
}
