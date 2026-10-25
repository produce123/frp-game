// Round changes of direction with a bounded radius; endpoints stay authoritative.
export function roundRoadCorners(points, radius) {
  if (points.length < 3) return points
  const result = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1]
    const before = Math.hypot(b[0] - a[0], b[1] - a[1]),
      after = Math.hypot(c[0] - b[0], c[1] - b[1])
    const cut = Math.min(radius, before * 0.35, after * 0.35)
    if (cut < 1) {
      result.push(b)
      continue
    }
    const start = b.map((v, k) => v + ((a[k] - v) * cut) / before)
    const end = b.map((v, k) => v + ((c[k] - v) * cut) / after)
    for (let step = 0; step <= 8; step++) {
      const t = step / 8,
        u = 1 - t
      result.push(b.map((v, k) => u * u * start[k] + 2 * u * t * v + t * t * end[k]))
    }
  }
  result.push(points.at(-1))
  return result
}

// Keep safe bends even if another corner cannot be rounded on steep terrain.
export function roundNavigableCorners(points, radius, free) {
  if (points.length < 3) return points
  const result = [points[0]]
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1]
    let chosen = [b]
    for (const scale of [1, 0.5, 0.25]) {
      const rounded = roundRoadCorners([a, b, c], radius * scale).slice(1, -1)
      if (!rounded.length) continue
      const candidate = [result.at(-1), ...rounded, c]
      if (candidate.every((p, j) => !j || free(candidate[j - 1], p))) {
        chosen = rounded
        break
      }
    }
    result.push(...chosen)
  }
  result.push(points.at(-1))
  return result
}
