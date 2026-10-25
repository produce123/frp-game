import {
  entranceBounds,
  parcelSegmentAabb,
  fixedDoor,
  localPoint,
  parcelPoint,
} from './oriented-parcel.mjs'
import {
  dist,
  length,
  nearestRoad,
  project,
  quantize,
  clamp,
  rect,
  segmentRect,
} from './geometry.mjs'
import { route, freePoint } from './routing.mjs'
import { roundRoadCorners } from './road-corners.mjs'
import { stream } from './document.mjs'
import { GenerationError, LAYOUT } from './budget.mjs'
import { withinCanvas } from './districts.mjs'
import { debug } from './debug.mjs'

const WIDTH = LAYOUT.road_width
// 空地建镇先造自然尺度的骨架再整体放大；放大后的候选带 roadScale，
// 后补的街道/支路必须与同步放大的骨架路同宽。access 是贴门人行道，
// 宽度与 rust 校验的净空约定绑定，不参与缩放。宽度保持整数（SVG
// 单位粒度 1/60 米）：nativeStableDocument 会把文档统一到 6 位小数，
// 放大产生的长浮点会让前后投影哈希不一致。
const roadWidth = (plan, kind) => {
  const base = WIDTH[kind]
  return kind === 'access' ? base : Math.round(base * (plan.roadScale ?? 1))
}

// 旋转资产的轴对齐包盒角部是空空气，但 rust 权威校验（crates/host
// geometry.rs crossed_by，矩形四边内缩 EPS=0.06 单位）按这个包盒判定
// 路线穿房。入口路由完全忽略业主自身占地，贴墙走时会切进包盒 0.1m。
// 把沿途点投影到地板矩形外 margin 处，最后一段再从矩形外落到门口
// （门口在边界上，crossed_by 内缩语义不判贴边穿越）。
function escapeRectPoint(point, r, margin) {
  const [x, y] = point
  if (x <= r.x - margin || x >= r.x + r.w + margin || y <= r.y - margin || y >= r.y + r.h + margin)
    return point
  const moves = [
    [x - (r.x - margin), [r.x - margin, y]],
    [r.x + r.w + margin - x, [r.x + r.w + margin, y]],
    [y - (r.y - margin), [x, r.y - margin]],
    [r.y + r.h + margin - y, [x, r.y + r.h + margin]],
  ]
  moves.sort((a, b) => a[0] - b[0])
  return moves[0][1]
}

// rust crossed_by 同款语义（inset=0，比 EPS 内缩更严）：线段进入矩形内部。
function segmentCrossesRect(a, b, r) {
  let lo = 0,
    hi = 1
  for (const [axis, start, size] of [
    [0, r.x, r.w],
    [1, r.y, r.h],
  ]) {
    const delta = b[axis] - a[axis]
    if (Math.abs(delta) < 1e-9) {
      if (a[axis] <= start || a[axis] >= start + size) return false
    } else {
      const u = (start - a[axis]) / delta,
        v = (start + size - a[axis]) / delta
      lo = Math.max(lo, Math.min(u, v))
      hi = Math.min(hi, Math.max(u, v))
      if (lo >= hi) return false
    }
  }
  return hi > 0 && lo < 1
}

export function directRoadClear(plan, a, b, width, ignore = []) {
  const ignored = new Set(ignore)
  return !plan.places.some(
    (place) =>
      place.placed && !ignored.has(place.id) && parcelSegmentAabb(place, a, b, width / 2 + 25)
  )
}

export function addRoad(plan, a, b, options) {
  const width = options.width ?? roadWidth(plan, 'street')
  const polyline = route(plan, a, b, { ...options, width })
  if (!polyline || polyline.length < 2) return null
  const road = {
    id: options.id,
    polyline,
    width,
    class: options.class ?? 'street',
    owner: options.ignore,
  }
  plan.roads.push(road)
  return road
}
export function mainRoads(plan, { deferConnections = false } = {}) {
  for (const d of plan.districts) {
    const members = plan.places.filter((p) => p.district === d.id),
      rng = stream(plan.spec.seed, 'road', d.id)
    const demand = members
      .filter((p) => !p.anchor)
      .reduce((s, p) => s + Math.max(p.w, p.h) + 150, 0)
    const len = Math.max(
      plan.L * 0.9,
      Math.min(demand * 0.57, Math.max(plan.width, plan.height) * 0.65)
    )
    const hub = freePoint(plan, d.center, roadWidth(plan, 'main'))
    if (!hub)
      throw new GenerationError('ROUTE_UNRESOLVED', '街区没有可接入道路的位置', { stage: 'roads' })
    d.hub = hub
    let successful = 0,
      bestRoads = [],
      bestAxis = d.axis
    // Keep the backend district and graph, but let its street axis respond to
    // the selected terrain. One fixed bearing can point both spine halves into
    // the same lake or cliff even when the district has ample connected land.
    const axisOffsets = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI / 2]
    for (const offset of axisOffsets) {
      const firstRoad = plan.roads.length,
        axis = d.axis + offset
      let count = 0
      for (let side = 0; side < 2; side++) {
        const a = axis + (side ? Math.PI : 0) + (rng() - 0.5) * 0.25
        const target = [
          clamp(hub[0] + (Math.cos(a) * len) / 2, 100, plan.width - 100),
          clamp(hub[1] + (Math.sin(a) * len) / 2, 100, plan.height - 100),
        ]
        const end = freePoint(plan, target, roadWidth(plan, 'main'))
        if (
          end &&
          dist(end, hub) > 100 &&
          addRoad(plan, hub, end, {
            id: `spine_${d.id}_${side}`,
            width: roadWidth(plan, 'main'),
            class: 'main',
          })
        )
          count++
      }
      const candidateRoads = plan.roads.splice(firstRoad)
      if (count > successful) {
        successful = count
        bestRoads = candidateRoads
        bestAxis = axis
      }
      if (successful === 2) break
    }
    d.axis = bestAxis
    plan.roads.push(...bestRoads)
    if (!successful)
      throw new GenerationError('ROUTE_UNRESOLVED', '无法建立街区的起始道路', {
        stage: 'roads',
        place_refs: members.map((p) => p.ref),
        district: d.id,
        center: d.center,
        hub,
        axis: d.axis,
        requested_length: len,
        route_failures: plan.routeFailures
          .slice(-24)
          .map(({ id, reason, a, b }) => `${id}:${reason}:${a.join(',')}->${b.join(',')}`),
      })
  }
  // 空地建镇先落位、修剪脊柱，再显式调 connectDistricts；传统路径就地连接。
  if (deferConnections) return
  connectDistricts(plan)
}

// 街区之间的连接路：hub→hub 直连（Kruskal 并查集 + 绕行比超标的补环）。
// 试过贴街道端点相连——脊柱端点朝外辐射，端点连端点会绕到镇子外圈，
// 画出更长的空路，实测裸段翻倍，已否决。
export function connectDistricts(plan) {
  const ds = plan.districts,
    parents = ds.map((_, i) => i),
    find = (i) => (parents[i] === i ? i : (parents[i] = find(parents[i])))
  const candidates = []
  for (let i = 0; i < ds.length; i++)
    for (let j = 0; j < i; j++) candidates.push({ i, j, d: dist(ds[i].hub, ds[j].hub) })
  candidates.sort((a, b) => a.d - b.d || a.i - b.i || a.j - b.j)
  // At most four districts: the complete candidate graph is bounded to six connections.
  const matrix = ds.map((_, i) => ds.map((_, j) => (i === j ? 0 : Infinity)))
  for (const c of candidates)
    if (find(c.i) !== find(c.j)) {
      const road = addRoad(plan, ds[c.i].hub, ds[c.j].hub, {
        id: `main_${c.i}_${c.j}`,
        width: roadWidth(plan, 'main'),
        class: 'main',
      })
      if (road) {
        parents[find(c.i)] = find(c.j)
        matrix[c.i][c.j] = matrix[c.j][c.i] = length(road.polyline)
      }
    }
  if (new Set(ds.map((_, i) => find(i))).size > 1)
    throw new GenerationError('ROUTE_UNRESOLVED', '暂时无法连接所有街区', {
      stage: 'roads',
      districts: ds.map((district, index) => ({
        id: district.id,
        hub: district.hub,
        component: find(index),
      })),
      route_failures: plan.routeFailures.slice(-32),
    })
  const floyd = () => {
    for (let k = 0; k < ds.length; k++)
      for (let i = 0; i < ds.length; i++)
        for (let j = 0; j < ds.length; j++)
          matrix[i][j] = Math.min(matrix[i][j], matrix[i][k] + matrix[k][j])
  }
  floyd()
  let added = 0
  for (const c of candidates)
    if (matrix[c.i][c.j] / Math.max(1, c.d) > 1.8 && added < Math.ceil(ds.length / 3)) {
      const road = addRoad(plan, ds[c.i].hub, ds[c.j].hub, {
        id: `loop_${c.i}_${c.j}`,
        width: roadWidth(plan, 'street'),
        class: 'street',
      })
      if (road) {
        const len = length(road.polyline)
        if (len < matrix[c.i][c.j] / 1.2) {
          matrix[c.i][c.j] = matrix[c.j][c.i] = len
          floyd()
          added++
        } else plan.roads.pop()
      }
    }
}

// 落位之后回头修剪脊柱：末端步行范围内没有已落位建筑的主路，就是伸
// 进空地的死路——「超绝长路」的另一半。剪到最后一家门前再多留一小
// 段；别的路接在这条脊柱上时，剪到接口之后，避免剪出悬空路。
export function trimSpineEnds(plan, reach = 900, margin = 300) {
  const placed = plan.places.filter((place) => place.placed)
  if (!placed.length) return
  const pointRect = ([x, y], r) =>
    Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.w)), Math.max(r.y - y, 0, y - (r.y + r.h)))
  for (const road of plan.roads.filter(
    (candidate) => candidate.id.startsWith('spine_') && candidate.polyline.length > 1
  )) {
    const pts = road.polyline,
      end = pts.at(-1)
    // 端点被其他路借用时不能剪，否则那条路会悬空
    if (
      plan.roads.some(
        (other) =>
          other !== road &&
          [other.polyline[0], other.polyline.at(-1)].some((point) => dist(point, end) < 10)
      )
    )
      continue
    const cum = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]))
    const total = cum.at(-1)
    let served = 0
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1],
        b = pts[i],
        seg = cum[i] - cum[i - 1]
      for (let s = 0; s <= seg; s += 60) {
        const k = seg ? s / seg : 0,
          x = a[0] + (b[0] - a[0]) * k,
          y = a[1] + (b[1] - a[1]) * k
        if (placed.some((place) => pointRect([x, y], rect(place)) <= reach)) served = cum[i - 1] + s
      }
    }
    let keep = Math.min(total, served + margin)
    // 其他路的端点投影落在这条脊柱上时，剪到接口之后，别把人家的接口剪掉
    for (const other of plan.roads) {
      if (other === road) continue
      for (const point of [other.polyline[0], other.polyline.at(-1)]) {
        for (let i = 1; i < pts.length; i++) {
          const hit = project(point, pts[i - 1], pts[i])
          if (hit.distance < 10)
            keep = Math.max(keep, cum[i - 1] + hit.t * (cum[i] - cum[i - 1]) + 120)
        }
      }
    }
    if (keep >= total - 1) continue
    const trimmed = [pts[0]]
    for (let i = 1; i < pts.length; i++) {
      if (cum[i] <= keep) trimmed.push(pts[i])
      else {
        const seg = cum[i] - cum[i - 1],
          k = seg ? (keep - cum[i - 1]) / seg : 0
        trimmed.push(
          quantize([
            pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k,
            pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k,
          ])
        )
        break
      }
    }
    road.polyline = trimmed
  }
}

const LONG_ACCESS_KINDS = new Set([
  'theatre',
  'hotel',
  'colonnade',
  'lighthouse',
  'ferris',
  'townhall',
  'warehouse',
])

function entranceReach(place) {
  // 下限必须覆盖门前锚点的最大距离：锚点 setback 上限 780，加上可建网格
  // 吸附（6m 格，对角误差 ~255）后门口到路网可能达 1035；960 的下限会把
  // 合法的大建筑入口整体判死（曾差 10 单位卡死图书馆）。无实测门口的
  // 露天场地（公园/广场）门口就是地块中心，锚点合法距离是半对角线 +
  // setback + 吸附余量，中心到路网天然就有二三十米。
  const base = Math.max(1200, Math.hypot(place.w, place.h) / 2 + 1080)
  return LONG_ACCESS_KINDS.has(place.kind)
    ? Math.max(1800, Math.min(2400, Math.max(base, Math.max(place.w, place.h) * 1.25)))
    : base
}

export function branch(plan, p, testParcel) {
  const d = plan.districts.find((d) => d.id === p.district)
  const memberCount = plan.places.filter((place) => place.district === d.id).length,
    branchLimit = Math.min(12, Math.max(4, Math.ceil(memberCount / 2)))
  if (d.branches >= branchLimit) return false
  const attempt = d.branches++,
    rng = stream(plan.spec.seed, 'road', `${d.id}:branch:${attempt}`)
  plan.budget.counts.branches++
  const candidates = []
  for (let i = 0; i < 32; i++) {
    const angle = (i * Math.PI) / 4 + (rng() - 0.5) * 0.3,
      span = plan.L * (0.35 + Math.floor(i / 8) * 0.5)
    const [x, y] = withinCanvas(
      plan,
      p,
      p.intended[0] + Math.cos(angle) * span,
      p.intended[1] + Math.sin(angle) * span
    )
    const c = { ...p, x: Math.round(x), y: Math.round(y) }
    if (testParcel(plan, c)) candidates.push(c)
  }
  for (const other of plan.places.filter((q) => q.placed))
    for (const side of [-1, 1]) {
      for (const c of [
        {
          ...p,
          x: Math.round(other.x + side * ((other.w + p.w) / 2 + LAYOUT.neighbour_gap_x)),
          y: Math.round(other.y),
        },
        {
          ...p,
          x: Math.round(other.x),
          y: Math.round(other.y + side * ((other.h + p.h) / 2 + LAYOUT.neighbour_gap_y)),
        },
      ])
        if (testParcel(plan, c)) candidates.push(c)
    }
  candidates.sort((a, b) => dist([a.x, a.y], p.intended) - dist([b.x, b.y], p.intended))
  for (const c of candidates.slice(0, 8))
    for (const side of [-1, 1]) {
      const axis = d.axis + attempt * 0.35,
        t = [Math.cos(axis), Math.sin(axis)],
        n = [-t[1] * side, t[0] * side]
      const gap = (Math.abs(n[0]) * p.w + Math.abs(n[1]) * p.h) / 2 + LAYOUT.branch_offset
      const q = quantize([c.x - n[0] * gap, c.y - n[1] * gap]),
        half = Math.min(
          plan.L * 0.3,
          (Math.abs(t[0]) * p.w + Math.abs(t[1]) * p.h) / 2 + LAYOUT.branch_half_extra
        )
      const a = quantize([q[0] - t[0] * half, q[1] - t[1] * half]),
        b = quantize([q[0] + t[0] * half, q[1] + t[1] * half])
      const old = { x: p.x, y: p.y, placed: p.placed },
        before = plan.roads.length
      Object.assign(p, { x: c.x, y: c.y, placed: true })
      try {
        const base = nearestRoad(
          q,
          plan.roads.filter((r) => r.class !== 'access')
        )[0]
        if (!base) continue
        const join = addRoad(plan, quantize(base.point), q, {
          id: `branch_${d.id}_${attempt}_join`,
          width: roadWidth(plan, 'street'),
          class: 'street',
          curved: false,
        })
        if (!join) continue
        const front = addRoad(plan, a, b, {
          id: `branch_${d.id}_${attempt}_front`,
          width: roadWidth(plan, 'street'),
          class: 'street',
          curved: false,
        })
        if (front) {
          p.branchHint = { x: c.x, y: c.y, frontage: front.id }
          return true
        }
      } finally {
        Object.assign(p, old)
        if (plan.roads.length !== before + 2) plan.roads.splice(before)
      }
    }
  return false
}

function connectOriginalEntrance(plan, p) {
  const choices = [],
    maximumReach = entranceReach(p)
  if (!p.frontageDoor || !p.frontageTarget) {
    const door = fixedDoor(plan, p),
      // 每条街取离门口最近的一点，按距离取最近的 8 条街作候选。
      nearestTargets = plan.roads
        .filter((road) => road.class !== 'access')
        .map((road) => nearestRoad(door, [road])[0])
        .filter(Boolean)
        .sort((a, b) => dist(door, a.point) - dist(door, b.point))
        .slice(0, 8)
    if (!nearestTargets.length || dist(door, nearestTargets[0].point) > maximumReach) {
      debug?.(
        `[entrance] ${p.ref} 门口够不到街：最近 ${nearestTargets.length ? Math.round(dist(door, nearestTargets[0].point)) : '无'}，上限 ${Math.round(maximumReach)}`
      )
      return false
    }
    const dx = door[0] - p.x,
      dy = door[1] - p.y,
      face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : dy > 0 ? 'south' : 'north'
    p.frontageDoor = door
    p.frontageFace = face
    const n = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[face]
    for (const target of nearestTargets)
      choices.push({
        side: face,
        n,
        door: quantize(door),
        lead: quantize(door),
        target: quantize(target.point),
        score: dist(target.point, door),
      })
    p.frontageTarget = choices[0].target
  } else {
    const n = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[p.frontageFace]
    choices.push({
      side: p.frontageFace,
      n,
      door: quantize(p.frontageDoor),
      lead: quantize(p.frontageDoor),
      target: quantize(p.frontageTarget),
      score: dist(p.frontageTarget, p.frontageDoor),
    })
  }
  for (const c of choices.filter((c) => c.score <= maximumReach).slice(0, 6)) {
    const line = [c.target, c.door]
    // 先算出该候选的室内地板矩形（与导出 spatial.floors 同一几何），
    // 让入口通道除终点门口外全程待在矩形外——rust 权威校验按这个
    // 轴对齐矩形判穿房，旋转资产的包盒角被切入 0.1m 也会判死。
    const r = entranceBounds(p, c.door, c.side)
    const escaped = line.map((point) => escapeRectPoint(point, r, 24))
    if (dist(escaped.at(-1), c.door) > 2) escaped.push(c.door)
    // 旋转资产的真实屋角会探出地板雕刻条（门口在包盒边上、屋角比门
    // 更靠外）：只躲地板矩形会让入口通道从屋角下面穿过去——既压地基
    // （grading 把路肩压到地基高程，路面悬空 0.5m+）又视觉穿模。再把
    // 中途点逃出业主的旋转精确占地（plot 口径），终点门口豁免。
    if (!p.outdoor) {
      const plotW = p.plotWidth ?? p.w,
        plotH = p.plotDepth ?? p.h,
        hw = plotW / 2 + 24,
        hh = plotH / 2 + 24,
        trueRect = { x: -plotW / 2, y: -plotH / 2, w: plotW, h: plotH }
      for (let index = 0; index < escaped.length - 1; index++) {
        const [lx, lz] = localPoint(p, escaped[index])
        if (Math.abs(lx) > hw || Math.abs(lz) > hh) continue
        const pushX = hw - Math.abs(lx),
          pushZ = hh - Math.abs(lz)
        escaped[index] =
          pushX < pushZ
            ? parcelPoint(p, Math.sign(lx || 1) * hw, lz)
            : parcelPoint(p, lx, Math.sign(lz || 1) * hh)
      }
      // 转角补角点：相邻点分别落在相邻两个面上时，直线连线会切进真实
      // 占地角（扩张面上的弦穿过原矩形的角）。插入扩张角点让路径贴角
      // 绕行。最后一段是门龛进入段，豁免（合法性由地板口径兜底）。
      const hugged = [escaped[0]]
      for (let index = 1; index < escaped.length; index++) {
        const a = localPoint(p, hugged.at(-1)),
          b = localPoint(p, escaped[index])
        if (index < escaped.length - 1 && segmentCrossesRect(a, b, trueRect)) {
          const corner = [-1, 1]
            .flatMap((sx) => [-1, 1].map((sz) => [sx * hw, sz * hh]))
            .find(
              (corner) =>
                !segmentCrossesRect(a, corner, trueRect) && !segmentCrossesRect(corner, b, trueRect)
            )
          // 找不到干净角点时保留原段，最终复核会拒绝该候选。
          if (corner) hugged.push(parcelPoint(p, corner[0], corner[1]))
        }
        hugged.push(escaped[index])
      }
      escaped.length = 0
      escaped.push(...hugged)
      // 复核：逃逸+补角后的线段不得穿入真实占地内部（贴边不算）。
      // 最后一段豁免：实测门口可能是凹进占地矩形的入口龛（剧院门在
      // 界内 1.7m），进入段本来就要沿门龛走进来——它的合法性由地板
      // 矩形口径兜底（从非门侧进入会穿未雕刻的地板，下面已拒）。
      const crossing = escaped
        .slice(1, -1)
        .findIndex((point, index) =>
          segmentCrossesRect(localPoint(p, escaped[index]), localPoint(p, point), trueRect)
        )
      if (crossing >= 0) {
        debug?.(`[entrance] ${p.ref} 入口通道第 ${crossing + 1} 段穿过自家占地，换下一个候选`)
        continue
      }
      // 占地逃逸可能把点推回地板矩形里（两个矩形在门侧相交），地板
      // 口径是 rust 权威，必须复核。
      if (escaped.slice(1).some((point, index) => segmentCrossesRect(escaped[index], point, r))) {
        debug?.(`[entrance] ${p.ref} 入口通道穿过地板矩形，换下一个候选`)
        continue
      }
    } else if (
      // 投影到相邻两个面的点之间，连线仍可能扫过矩形角；逐段复核，
      // 过不去就放弃该候选，换下一个门前路点。
      escaped.slice(1).some((point, index) => segmentCrossesRect(escaped[index], point, r))
    ) {
      debug?.(`[entrance] ${p.ref} 入口通道穿过地板矩形，换下一个候选`)
      continue
    }
    line.length = 0
    line.push(...escaped)
    const blocker = plan.places.find(
      (other) =>
        other.placed &&
        other.id !== p.id &&
        line
          .slice(1)
          .some(
            (point, index) =>
              parcelSegmentAabb(other, line[index], point, 24) ||
              (!other.outdoor &&
                other.interiorRect &&
                segmentRect(line[index], point, other.interiorRect))
          )
    )
    if (blocker) {
      debug?.(`[entrance] ${p.ref} 入口通道被 ${blocker.ref} 挡住，换下一个候选`)
      continue
    }
    // Route finding must be conservative around the real asset footprint.
    // Once the safe points are known, soften only bends that remain inside the
    // same free corridor; keep the true door and street attachment fixed.
    if (plan.preserveOriginalTopology && line.length > 2) {
      const controls = [line[0]]
      for (let i = 1; i < line.length - 1; i++)
        if (project(line[i], controls.at(-1), line[i + 1]).distance > 3) controls.push(line[i])
      controls.push(line.at(-1))
      const rounded = roundRoadCorners(controls, 90),
        ownPlot = {
          x: -(p.plotWidth ?? p.w) / 2,
          y: -(p.plotDepth ?? p.h) / 2,
          w: p.plotWidth ?? p.w,
          h: p.plotDepth ?? p.h,
        },
        clear =
          rounded.length <= plan.budget.caps.edge_points &&
          rounded.slice(1).every((point, index) => {
            const previous = rounded[index],
              last = index === rounded.length - 2
            return (
              (last ||
                (!segmentCrossesRect(previous, point, r) &&
                  !segmentCrossesRect(localPoint(p, previous), localPoint(p, point), ownPlot))) &&
              !plan.places.some(
                (other) =>
                  other.placed && other.id !== p.id && parcelSegmentAabb(other, previous, point, 24)
              )
            )
          })
      if (clear) line.splice(0, line.length, ...rounded)
    }
    p.door = c.door
    p.boundaryDoor = c.door
    p.doorFace = c.side
    p.frontageTarget = c.target
    p.interiorRect = r
    p.entranceSource = 'original-asset'
    plan.roads.push({
      id: `access_${p.id}`,
      polyline: line,
      width: 72,
      class: 'access',
      owner: p.id,
    })
    return true
  }
  return false
}
export function connectEntrance(plan, p) {
  const footprint =
    plan.budget.caps.lab?.footprints?.[p.ref] ??
    plan.budget.caps.lab?.footprints?.[`${p.kind}/${p.size}`]
  const entry = footprint && plan.budget.caps.lab?.realEntrances?.[footprint.assetId]
  if (entry) {
    if (connectOriginalEntrance(plan, p)) return true
    // Open plazas and outdoor landmarks do not have a sealed doorway. Keep
    // the authored front for orientation, but allow their arrival point to use
    // another street-facing boundary when that marker is obstructed.
    if (!p.outdoor) return false
  }
  const r = rect(p),
    choices = [],
    maximumReach = entranceReach(p)
  for (const road of plan.roads.filter((r) => r.class !== 'access')) {
    const closest = nearestRoad([p.x, p.y], [road])[0]
    if (!closest) continue
    for (const [side, n] of [
      ['north', [0, -1]],
      ['east', [1, 0]],
      ['south', [0, 1]],
      ['west', [-1, 0]],
    ]) {
      const inset = LAYOUT.door_inset,
        lead_ = LAYOUT.door_lead
      const door = n[0]
        ? [p.x + (n[0] * p.w) / 2, clamp(closest.point[1], r.y + inset, r.y + r.h - inset)]
        : [clamp(closest.point[0], r.x + inset, r.x + r.w - inset), p.y + (n[1] * p.h) / 2]
      const lead = quantize([door[0] + n[0] * lead_, door[1] + n[1] * lead_])
      const target = closest.point
      choices.push({
        side,
        n,
        door: quantize(door),
        lead,
        road,
        score: dist(lead, target),
        target: quantize(target),
      })
    }
  }
  choices.sort(
    (a, b) =>
      a.score - b.score || a.side.localeCompare(b.side) || a.road.id.localeCompare(b.road.id)
  )
  for (const c of choices.filter((c) => c.score <= maximumReach).slice(0, 6)) {
    const line = route(plan, c.target, c.lead, {
      id: `access_${p.id}`,
      width: roadWidth(plan, 'access'),
      ignore: p.id,
      curved: false,
      // 人行入口通道用 0.6m 净空（理由同 connectOriginalEntrance）。
      clearance: 36,
      snapEndpoints: true,
    })
    if (!line || line.some((q, i) => i && segmentRect(line[i - 1], q, rect(p, 30)))) continue
    // The last segment approaches the selected face from outside, never through the room.
    const arrival = p.outdoor
      ? quantize([c.door[0] - c.n[0] * LAYOUT.door_lead, c.door[1] - c.n[1] * LAYOUT.door_lead])
      : c.door
    const polyline = [...line, c.door, ...(p.outdoor ? [arrival] : [])]
    p.door = arrival
    p.doorFace = c.side
    p.boundaryDoor = c.door
    plan.roads.push({
      id: `access_${p.id}`,
      polyline,
      width: roadWidth(plan, 'access'),
      class: 'access',
      owner: p.id,
    })
    return true
  }
  return false
}
