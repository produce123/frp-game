import { dist, project } from './geometry.mjs'

// A rounded perimeter inside the usable floor, in metres. The entry point is
// inserted into the loop itself so the visible path and navigation share it.
export function publicSpaceLoop(bounds, arrival) {
  const inset = 1.5,
    cx = bounds.x + bounds.w / 2,
    cy = bounds.y + bounds.h / 2,
    rx = bounds.w / 2 - inset,
    ry = bounds.h / 2 - inset,
    count = 48,
    points = Array.from({ length: count }, (_, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / count
      return [cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry]
    })
  let closest = null
  for (let i = 0; i < points.length; i++) {
    const hit = project(arrival, points[i], points[(i + 1) % points.length])
    if (!closest || hit.distance < closest.distance) closest = { index: i, ...hit }
  }
  // A loop point within 0.05 m of the arrival becomes the arrival node itself,
  // so it takes the exact arrival coordinates and route endpoints match it.
  const existing = points.findIndex((point) => dist(point, arrival) < 0.05)
  const entry = existing >= 0 ? existing : closest.index + 1
  if (existing >= 0) points[existing] = [...arrival]
  else points.splice(entry, 0, dist(closest.point, arrival) < 0.05 ? [...arrival] : closest.point)
  const anchors = [
    ...new Set(
      [0, 12, 24, 36]
        .map((index) => (index >= entry && existing < 0 ? index + 1 : index))
        .concat(entry)
    ),
  ].sort((a, b) => a - b)
  return { points, anchors, entryIndex: anchors.indexOf(entry) }
}
