import { segmentRect, rect } from './geometry.mjs'
export function localPoint(p, q) {
  const yaw = p.assetYaw ?? 0,
    c = Math.cos(yaw),
    s = Math.sin(yaw),
    x = q[0] - p.x,
    z = q[1] - p.y
  return [x * c - z * s, x * s + z * c]
}
export function parcelPoint(p, x, z) {
  const yaw = p.assetYaw ?? 0,
    c = Math.cos(yaw),
    s = Math.sin(yaw)
  return [p.x + x * c + z * s, p.y - x * s + z * c]
}
// 后端（crates/host spatial.rs）用每个室内空间的轴对齐矩形校验路线穿插。
// 旋转建筑的世界轴对齐矩形在角部大于朝向矩形，道路净空必须用同一个
// 轴对齐矩形，否则规划器放行的路会被后端权威校验拒绝。
export function parcelSegmentAabb(p, a, b, gap = 0) {
  return segmentRect(a, b, rect(p, gap))
}

// 真实门口坐标：有实测入口（realEntrances）时按资产朝向推出，否则退回中心。
export function fixedDoor(plan, place) {
  const footprint =
      plan.budget.caps.lab?.footprints?.[place.ref] ??
      plan.budget.caps.lab?.footprints?.[`${place.kind}/${place.size}`],
    entry = footprint?.assetId && plan.budget.caps.lab?.realEntrances?.[footprint.assetId]
  if (!entry) return [place.x, place.y]
  const angle = (place.assetYaw ?? 0) + Math.PI,
    c = Math.cos(angle),
    s = Math.sin(angle)
  return [
    place.x + (entry[0] * c + entry[1] * s) * 60,
    place.y + (-entry[0] * s + entry[1] * c) * 60,
  ]
}

export function entranceBounds(p, door, face) {
  const r = rect(p)
  if (face === 'north') {
    r.h -= door[1] - r.y
    r.y = door[1]
  }
  if (face === 'south') r.h = door[1] - r.y
  if (face === 'west') {
    r.w -= door[0] - r.x
    r.x = door[0]
  }
  if (face === 'east') r.w = door[0] - r.x
  return r
}
