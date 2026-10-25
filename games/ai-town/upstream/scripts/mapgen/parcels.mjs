import { parcelSegmentAabb } from './oriented-parcel.mjs'
import { doorFrontages } from './door-frontages.mjs'
import { stream } from './document.mjs'
import { clamp, dist, inflate, lerp, overlaps, rect, segmentRect } from './geometry.mjs'
import { measureConstraints } from './constraints.mjs'
import { branch } from './roads.mjs'
import { expandBoundary } from './districts.mjs'
import { GenerationError, LAYOUT } from './budget.mjs'
import { debug } from './debug.mjs'

const envelope = (p) => {
  const r = rect(p, LAYOUT.envelope_gap)
  return { ...r, y: r.y - LAYOUT.envelope_front, h: r.h + LAYOUT.envelope_front }
}
// Match routeContext's access-lane obstacle clearance: half of the 72-unit
// lane plus the 27-unit walking shoulder. Reserving only 24 units here let a
// later building occupy space that the already-selected real door required.
const FRONTAGE_ACCESS_CLEARANCE = 63
const insideCanvas = (plan, box) =>
  box.x >= LAYOUT.canvas_edge &&
  box.y >= LAYOUT.canvas_edge &&
  box.x + box.w <= plan.width - LAYOUT.canvas_edge &&
  box.y + box.h <= plan.height - LAYOUT.canvas_edge
function parcelFree(plan, p) {
  const box = envelope(p)
  if (!insideCanvas(plan, box)) return false
  for (const other of plan.places) {
    if (!other.placed || other.id === p.id) continue
    if (overlaps(box, envelope(other))) return false
    if (
      p.frontageDoor &&
      p.frontageTarget &&
      parcelSegmentAabb(other, p.frontageTarget, p.frontageDoor, FRONTAGE_ACCESS_CLEARANCE)
    )
      return false
    if (
      other.frontageDoor &&
      other.frontageTarget &&
      parcelSegmentAabb(p, other.frontageTarget, other.frontageDoor, FRONTAGE_ACCESS_CLEARANCE)
    )
      return false
  }
  for (const road of plan.roads) {
    if (road.owner === p.id) continue
    for (let i = 1; i < road.polyline.length; i++)
      if (
        (!p.outdoor &&
          p.interiorRect &&
          segmentRect(road.polyline[i - 1], road.polyline[i], inflate(p.interiorRect, 1))) ||
        parcelSegmentAabb(
          p,
          road.polyline[i - 1],
          road.polyline[i],
          road.width / 2 + LAYOUT.road_clearance
        )
      )
        return false
  }
  return true
}
function frontages(plan, p, round) {
  const result = [],
    d = plan.districts.find((d) => d.id === p.district),
    footprint =
      plan.budget.caps.lab?.footprints?.[p.ref] ??
      plan.budget.caps.lab?.footprints?.[`${p.kind}/${p.size}`],
    hasOriginalEntrance = footprint && plan.budget.caps.lab?.realEntrances?.[footprint.assetId]
  for (const road of plan.roads.filter((r) => r.class !== 'access')) {
    const rng = stream(plan.spec.seed, 'frontage', `${p.id}:${road.id}:${round}`)
    const step = plan.L * 0.25,
      offset = rng() * step,
      setback = plan.plannedNetwork
        ? 55
        : LAYOUT.setback_min + (1 - d.density) * LAYOUT.setback_range
    let walked = 0,
      next = offset
    for (let i = 1; i < road.polyline.length; i++) {
      const a = road.polyline[i - 1],
        b = road.polyline[i],
        length = dist(a, b)
      if (!length) continue
      while (next <= walked + length) {
        const t = clamp((next - walked) / length, 0, 1),
          q = lerp(a, b, t),
          n = [-(b[1] - a[1]) / length, (b[0] - a[0]) / length]
        const frontage = doorFrontages(plan, p, road, q, [
          (b[0] - a[0]) / length,
          (b[1] - a[1]) / length,
        ])
        if (frontage) result.push(...frontage)
        else
          for (const side of [-1, 1])
            for (const swapped of [false, true]) {
              const w = swapped ? p.h : p.w,
                h = swapped ? p.w : p.h
              const halfN = (Math.abs(n[0]) * w + Math.abs(n[1]) * h) / 2
              const gap = road.width / 2 + setback + (rng() - 0.5) * 25 + halfN
              const candidate = {
                ...p,
                w,
                h,
                x: Math.round(q[0] + n[0] * side * gap),
                y: Math.round(q[1] + n[1] * side * gap),
              }
              result.push({
                ...candidate,
                frontage: road.id,
                setback: gap - halfN - road.width / 2,
                cost: dist([candidate.x, candidate.y], p.intended) ** 2 / plan.L ** 2,
              })
            }
        next += step
      }
      walked += length
    }
  }
  if (
    !hasOriginalEntrance &&
    p.branchHint &&
    plan.roads.some((r) => r.id === p.branchHint.frontage)
  )
    result.push({
      ...p,
      ...p.branchHint,
      cost: dist([p.branchHint.x, p.branchHint.y], p.intended) ** 2 / plan.L ** 2,
    })
  result.sort((a, b) => a.cost - b.cost || a.x - b.x || a.y - b.y || a.w - b.w)
  return result
}

function placementScore(plan, p) {
  const constraints = measureConstraints(
    plan.spec,
    plan.places.map((q) => (q.id === p.id ? p : q)),
    plan.L
  )
  const neighbors = plan.places
    .filter((q) => q.placed && q.id !== p.id)
    .map((q) => ({ q, distance: dist([q.x, q.y], [p.x, p.y]) }))
    .sort((a, b) => a.distance - b.distance || a.q.id.localeCompare(b.q.id))
  const radius = plan.L * 1.5
  const occupied = neighbors.reduce(
    (sum, { q, distance }) => sum + (distance <= radius ? q.w * q.h : 0),
    p.w * p.h
  )
  const density = Math.abs(
    occupied / (Math.PI * radius ** 2) - plan.districts.find((d) => d.id === p.district).density
  )
  const sameFront = neighbors.filter(({ q }) => q.frontage === p.frontage).slice(0, 2)
  const similar = (a, b) =>
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 0.05
  let repetition = 0
  for (const { q, distance } of sameFront) {
    const previous = neighbors
      .filter(({ q: other }) => other.id !== q.id && other.frontage === q.frontage)
      .map(({ q: other }) => dist([other.x, other.y], [q.x, q.y]))
      .sort((a, b) => a - b)[0]
    if (
      similar(p.w * p.h, q.w * q.h) &&
      similar(p.setback, q.setback) &&
      similar(distance, previous)
    )
      repetition++
  }
  return (
    // 落点仍然要有约束：地点得留在自己那个街区、贴着配对建筑。
    dist([p.x, p.y], p.intended) ** 2 / plan.L ** 2 +
    constraints.reduce((sum, c) => sum + c.penalty * (c.required ? 4 : 2), 0) +
    0.5 * density +
    0.25 * repetition
  )
}

function fitOne(plan, p, round = 0) {
  let best = null,
    bestScore = Infinity,
    checked = 0
  const candidates = frontages(plan, p, round)
  const budget = plan.plannedNetwork ? 192 + round * 160 : 64
  // 诊断用：候选各因什么被排除（越界、与已落位地块重叠、压到道路或别家入口）。
  const tally = debug ? { outside: 0, overlap: 0, blocked: 0 } : null
  for (const c of candidates) {
    // Cheap bounds/occupancy filtering precedes the bounded detailed road checks.
    const box = envelope(c)
    if (!insideCanvas(plan, box)) {
      if (tally) tally.outside++
      continue
    }
    if (plan.places.some((o) => o.placed && o.id !== p.id && overlaps(box, envelope(o)))) {
      if (tally) tally.overlap++
      continue
    }
    if (++checked > budget) break
    if (!parcelFree(plan, c)) {
      if (tally) tally.blocked++
      continue
    }
    const score = placementScore(plan, c)
    if (score < bestScore) {
      best = c
      bestScore = score
    }
  }
  if (!best) {
    debug?.(
      `[parcels] ${p.ref} 第 ${round} 轮放不下：${candidates.length} 个候选，越界 ${tally.outside}，重叠 ${tally.overlap}，压到道路或入口 ${tally.blocked}，细查 ${Math.min(checked, budget)}/${budget}`
    )
    return false
  }
  Object.assign(p, best, { placed: true })
  return true
}
const districtBranchLimit = (plan, districtId) =>
  Math.min(
    12,
    Math.max(4, Math.ceil(plan.places.filter((p) => p.district === districtId).length / 2))
  )
export function fitParcels(plan) {
  const order = plan.places
    .filter((p) => !p.anchor)
    .sort((a, b) => b.w * b.h - a.w * a.h || a.id.localeCompare(b.id))
  for (let round = 0; round <= plan.budget.caps.repairs; round++) {
    plan.budget.check('parcels')
    for (const p of order.filter((p) => !p.placed)) {
      if (fitOne(plan, p, round)) continue
      const d = plan.districts.find((d) => d.id === p.district)
      const branchLimit = districtBranchLimit(plan, d.id)
      while (d.branches < (round === 0 ? Math.min(2, branchLimit) : branchLimit)) {
        const before = plan.roads.length
        if (!branch(plan, p, parcelFree)) continue
        if (fitOne(plan, p, round)) break
        plan.roads.splice(before)
        p.branchHint = null
      }
    }
    if (order.every((p) => p.placed)) break
    // 规划路网（原拓扑）原先在这里第一轮放不下就直接报错：路网是原生成器排
    // 好的，补一条支路就被当成破坏原样。结果是「地点一处不肯减」这条要求根
    // 本做不到——27 处地点沿街放不下时没有任何补救，直接失败。现在让它也走
    // 补街、换位的修复轮：新增的是 district 限额内的小支路，不是甩出去的死
    // 胡同，排完整轮还放不下才报错。
    if (round === plan.budget.caps.repairs)
      throw new GenerationError(
        'INSUFFICIENT_SPACE',
        '部分地点无法同时容纳建筑、入口和通道，请减少地点或调整尺寸',
        {
          stage: 'parcels',
          place_refs: order.filter((p) => !p.placed).map((p) => p.ref),
          expected: plan.places.length,
          measured: plan.places.filter((p) => p.placed).length,
        }
      )
    plan.budget.counts.repairs++
    // 规划路网（原拓扑）的街道是排好的，放大边界不会多出任何临街面，只会把
    // 镇子摊得更空，所以跳过。
    if (!plan.plannedNetwork) expandBoundary(plan)
    // Move at most two neighbors transactionally; keep the move only if every displaced place fits.
    for (const p of order.filter((p) => !p.placed)) {
      const neighbors = order
        .filter((q) => q.placed && q.district === p.district)
        .sort((a, b) => dist([a.x, a.y], p.intended) - dist([b.x, b.y], p.intended))
        .slice(0, 2)
      const snapshot = [p, ...neighbors].map((q) => [q, { ...q }])
      for (const q of neighbors) q.placed = false
      const improved =
        fitOne(plan, p, round + 1) && neighbors.every((q) => fitOne(plan, q, round + 1))
      if (!improved) for (const [q, before] of snapshot) Object.assign(q, before)
    }
  }
  for (let pass = 0; pass < plan.budget.caps.improvements; pass++)
    for (const p of order) {
      const before = { ...p },
        score = placementScore(plan, p)
      if (fitOne(plan, p, pass) && placementScore(plan, p) >= score) Object.assign(p, before)
    }
}

// Joint layout repair: relocate an otherwise valid parcel when its authored
// doorway cannot reach a street. A failed move never leaves an extra access road.
export function fitEntrances(plan, connect) {
  const order = [...plan.places].sort(
    (a, b) =>
      Number(a.kind === 'home') - Number(b.kind === 'home') ||
      Number(!b.outdoor) - Number(!a.outdoor) ||
      b.w * b.h - a.w * a.h ||
      a.id.localeCompare(b.id)
  )
  // Keep the accepted physical layout intact. Access planning may relocate
  // only the one parcel whose real authored door cannot reach its frontage;
  // repacking every parcel here discarded a valid layout and made later homes
  // fail after the landmark entrances had been reserved.
  plan.roads = plan.roads.filter((road) => road.class !== 'access')
  for (const p of order) {
    p.door = null
    p.boundaryDoor = null
  }
  for (const p of order) {
    const before = { ...p },
      roadCount = plan.roads.length
    if (connect(plan, p)) continue
    let fitted = false
    const candidates = frontages(plan, p, 7).slice(0, 360)
    for (const c of candidates) {
      Object.assign(p, c, { placed: true })
      if (!parcelFree(plan, c)) continue
      if (connect(plan, p)) {
        fitted = true
        break
      }
      plan.roads.splice(roadCount)
      Object.assign(p, before)
    }
    if (!fitted) {
      const d = plan.districts.find((district) => district.id === p.district),
        branchLimit = districtBranchLimit(plan, p.district)
      while (d && d.branches < branchLimit && !fitted) {
        const beforeBranch = plan.roads.length
        if (!branch(plan, p, parcelFree)) continue
        for (const c of frontages(plan, p, 8).slice(0, 180)) {
          Object.assign(p, c, { placed: true })
          if (!parcelFree(plan, c)) continue
          if (connect(plan, p)) {
            fitted = true
            break
          }
          plan.roads.splice(beforeBranch + 2)
          Object.assign(p, before)
        }
        if (!fitted) {
          plan.roads.splice(beforeBranch)
          p.branchHint = null
        }
      }
    }
    if (!fitted) {
      Object.assign(p, before)
      plan.roads.splice(roadCount)
      p.entranceFailure = {
        frontageCandidates: candidates.length,
        districtBranches: plan.districts.find((district) => district.id === p.district)?.branches,
        branchLimit: districtBranchLimit(plan, p.district),
        routeFailures: plan.routeFailures.slice(-12),
      }
      return p
    }
  }
  return null
}
