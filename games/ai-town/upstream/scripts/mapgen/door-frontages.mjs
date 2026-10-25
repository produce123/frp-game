import { entranceBounds } from './oriented-parcel.mjs'
import { dist } from './geometry.mjs'

// The original door determines position and orientation together. Rotate the
// complete asset; never invent a door on its bounding rectangle.
export function doorFrontages(plan, p, road, q, tangent) {
  const footprint =
    plan.budget.caps.lab?.footprints?.[p.ref] ??
    plan.budget.caps.lab?.footprints?.[`${p.kind}/${p.size}`]
  const entry = footprint && plan.budget.caps.lab?.realEntrances?.[footprint.assetId]
  if (!entry) return null
  const result = []
  for (const side of [-1, 1]) {
    const outside = [-tangent[1] * side, tangent[0] * side],
      n = outside.map((v) => -v)
    const desiredYaw = Math.atan2(n[0], n[1])
    for (const yaw of new Set([
      desiredYaw,
      (Math.round(desiredYaw / (Math.PI / 2)) * Math.PI) / 2,
    ])) {
      const angle = yaw + Math.PI,
        c = Math.cos(angle),
        s = Math.sin(angle)
      const e = [(entry[0] * c + entry[1] * s) * 60, (-entry[0] * s + entry[1] * c) * 60]
      const plotWidth = footprint.width * 60,
        plotDepth = footprint.depth * 60
      const w = Math.abs(c) * plotWidth + Math.abs(s) * plotDepth,
        h = Math.abs(s) * plotWidth + Math.abs(c) * plotDepth
      const recess = Math.max(0, footprint.depth / 2 + entry[1])
      const publicForecourt = [
        'ferris',
        'carousel',
        'temple',
        'theatre',
        'fountain',
        'obelisk',
      ].includes(p.kind)
      for (const extra of publicForecourt ? [2.4, 3.2, 4] : [0.6, 1.2, 1.8]) {
        const doorstep = Math.max(0.6, recess + extra),
          door = q.map((v, i) => v + outside[i] * (road.width / 2 + doorstep * 60))
        const face =
          Math.abs(n[0]) > Math.abs(n[1])
            ? n[0] > 0
              ? 'east'
              : 'west'
            : n[1] > 0
              ? 'south'
              : 'north'
        const candidate = {
          ...p,
          w,
          h,
          plotWidth,
          plotDepth,
          assetYaw: yaw,
          x: door[0] - e[0],
          y: door[1] - e[1],
          frontage: road.id,
          setback: extra * 60,
          frontageDoor: door,
          frontageTarget: q,
          frontageFace: face,
        }
        candidate.interiorRect = entranceBounds(candidate, door, face)
        result.push({
          ...candidate,
          cost: dist([candidate.x, candidate.y], p.intended) ** 2 / plan.L ** 2 + extra * 0.2,
        })
      }
    }
  }
  return result
}
