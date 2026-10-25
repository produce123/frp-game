import { noise, stream } from './document.mjs'
import { clamp, dist, rect, overlaps } from './geometry.mjs'
import { checkConflicts, projectConstraints, measureConstraints, targets } from './constraints.mjs'
import { GenerationError, LAYOUT } from './budget.mjs'

/**
 * 户外空间跟哪类建筑配对。广场该是图书馆、镇公所、剧院门前的集散地，花园该
 * 挨着酒店与社交俱乐部，市场该靠货栈与港口——它们不是独立的地点，而是某栋
 * 建筑的前庭后院。布局时按这张表把两者放在一起。
 */
export const OUTDOOR_COMPANIONS = Object.freeze({
  plaza: ['library', 'townhall', 'theatre', 'colonnade', 'market'],
  garden: ['hotel', 'club', 'cafe', 'inn'],
  park: ['club', 'colonnade', 'cafe', 'theatre'],
  market: ['warehouse', 'harbor', 'canteen'],
  harbor: ['warehouse', 'market'],
  area: ['ferris', 'home', 'plaza'],
})

/** 2D 小镇是四面环海的孤岛，这几种地点要放在镇子外圈，前端把海岸线收到它们旁边 */
export const COASTAL_KINDS = Object.freeze(['harbor', 'lighthouse'])

/**
 * 生成过程中的一处地点。坐标是 SVG 单位，x/y 是地块中心。
 * 模板字段（kind、name、outdoor、contour 等）由 templates.json 展开而来。
 * @typedef {object} Place
 * @property {string} kind 地点种类
 * @property {string} name 显示名称
 * @property {boolean} outdoor 是否为室外区域
 * @property {string} [contour] 室外轮廓样式，缺省取 kind
 * @property {string} ref 用户可引用的稳定编号，如 home:3
 * @property {string} id 文档内部编号，如 home_3
 * @property {'small'|'medium'|'large'} size
 * @property {number} w 地块宽
 * @property {number} h 地块高
 * @property {string[]} props 道具定义引用
 * @property {boolean} placed 是否已经落到最终位置
 * @property {boolean} anchor 是否为锚点：中心由约束投影决定，不再沿街重排
 * @property {number} x 中心（placeDistricts 之后有值）
 * @property {number} y
 * @property {[number, number]|null} intended 投影阶段得到的意向中心
 * @property {string|null} district 所属街区编号
 * @property {string|null} frontage 沿街放置时所依的道路编号
 * @property {number|null} setback 建筑到道路边缘的退距
 * @property {{x:number,y:number,frontage:string}|null} branchHint 支路为它开出的候选位置
 * @property {[number, number]|null} door 到达点：室内为门外的位置，室外为区域内入口
 * @property {'north'|'east'|'south'|'west'|null} doorFace 门所在的墙面
 * @property {[number, number]|null} boundaryDoor 门在地块边界上的位置
 * @property {object|null} surface 室外区域的单元轮廓（layout.mjs contour 的结果）
 * @property {[number, number][]} propPositions 每个道具的显示坐标；室内为局部坐标
 */
/**
 * @typedef {object} District
 * @property {string} id
 * @property {[number, number]} center
 * @property {number} radius
 * @property {number} axis 主街方向（弧度）
 * @property {number} aspect
 * @property {number} density 目标建筑密度
 * @property {number} targetArea
 * @property {number} usedArea
 * @property {number} branches 已尝试开出的支路数
 * @property {[number, number]|null} hub 主街起点（mainRoads 之后有值）
 */
/**
 * @typedef {object} Road
 * @property {string} id
 * @property {[number, number][]} polyline
 * @property {number} width
 * @property {'main'|'street'|'access'|'interior'} class
 * @property {string|undefined} owner 入户道所属地点编号
 */
/**
 * 一次生成的全部中间状态。除注明外，字段在 expandPlan 中创建后不再增删。
 * @typedef {object} Plan
 * @property {object} spec 规范化后的输入
 * @property {Place[]} places
 * @property {number} L 参考长度：地块宽度中位数加留白
 * @property {number} phi 目标占地比例
 * @property {number} area 画布面积估算
 * @property {number} width 画布宽（expandBoundary 可能放大一次）
 * @property {number} height
 * @property {number} initialWidth
 * @property {number} initialHeight
 * @property {District[]} districts
 * @property {Road[]} roads
 * @property {object} budget budget() 返回的预算对象
 * @property {Map<string, object>} defs 道具定义表，键为 id@version
 * @property {object[]} repairs 已执行的修正记录
 * @property {boolean} expanded 画布是否已放大
 * @property {(x:number,y:number)=>number} roadNoise 道路弯曲用的噪声场
 * @property {object[]} routeFailures 寻路失败的诊断记录
 */

export const sizes = {
  small: [540, 380],
  medium: [650, 460],
  large: [740, 530],
}
// 一处地点连同周围留白所占的面积，用于估算画布和街区容量。
export const footprint = (p) => (p.w + LAYOUT.parcel_pad_x) * (p.h + LAYOUT.parcel_pad_y)
// 把候选中心夹到画布内，四周留出街区阶段的边距。
export function withinCanvas(plan, p, x, y) {
  return [
    clamp(x, p.w / 2 + LAYOUT.canvas_margin_x, plan.width - p.w / 2 - LAYOUT.canvas_margin_x),
    clamp(
      y,
      p.h / 2 + LAYOUT.canvas_margin_top,
      plan.height - p.h / 2 - LAYOUT.canvas_margin_bottom
    ),
  ]
}

/**
 * 地点名：单独起的名字（kind:序号）优先，其次这一种共用的名字（多处时编号），都没有或和前面的
 * 地点重名时用模板名。同一张图上不出现两个同名的地点，村民靠名字认地方。
 */
function placeName(names, template, index, total, used) {
  const numbered = (base) => base + (total > 1 ? ` ${index}` : '')
  const own = names?.[`${template.kind}:${index}`],
    shared = names?.[template.kind]
  const name = [own, shared && numbered(shared)].find((n) => n && !used.has(n))
  return name ?? numbered(template.name)
}

/** @returns {Plan} */
export function expandPlan(spec, library, definitions, budget) {
  const defs = new Map(definitions.map((d) => [`${d.id}@${d.version}`, d]))
  const used = new Set()
  const totals = new Map(),
    nextIndex = new Map()
  for (const p of spec.places) totals.set(p.kind, (totals.get(p.kind) ?? 0) + p.count)
  const places = spec.places.flatMap((input) =>
    Array.from({ length: input.count }, () => {
      // validateSpec sorts size groups; numbering continues across all sizes of a kind.
      const index = (nextIndex.get(input.kind) ?? 0) + 1
      nextIndex.set(input.kind, index)
      const template = library.templates.find((t) => t.kind === input.kind),
        ref = `${input.kind}:${index}`
      const rng = stream(spec.seed, 'place-size', ref),
        [bw, bh] = sizes[input.size],
        area = 0.92 + rng() * 0.16,
        ratio = 0.9 + rng() * 0.2
      const measured =
        budget.caps.lab?.footprints?.[ref] ??
        budget.caps.lab?.footprints?.[`${input.kind}/${input.size}`]
      const w = measured
          ? Math.ceil((measured.width * 60) / 2) * 2
          : 2 * Math.round((bw * Math.sqrt(area * ratio)) / 2),
        h = measured
          ? Math.ceil((measured.depth * 60) / 2) * 2
          : 2 * Math.round((bh * Math.sqrt(area / ratio)) / 2)
      let props = template.props.filter((reference) => {
        const d = defs.get(reference)
        if (!d)
          throw new GenerationError('INVALID_SPEC', `模板道具定义不存在：${reference}`, {
            stage: 'templates',
          })
        const need = {
          'no-food': 'fullness',
          'no-water': 'water',
          'no-rest': 'energy',
        }[spec.resources]
        return (
          !need ||
          !d.actions.some((a) =>
            [...(a.during || []), ...(a.on_complete || [])].some((e) => e.need === need)
          )
        )
      })
      if (spec.resources === 'poisoned-food')
        props = props.map((r) => (r.startsWith('core:rations@') ? 'core:poisoned_food@1' : r))
      for (const reference of props)
        if (!defs.has(reference))
          throw new GenerationError('INVALID_SPEC', `缺少道具版本：${reference}`, {
            stage: 'templates',
          })
      /** @type {Place} */
      const place = {
        ...template,
        ref,
        id: `${input.kind}_${index}`,
        name: placeName(spec.names, template, index, totals.get(input.kind), used),
        size: input.size,
        ...(measured ? { assetId: measured.assetId } : {}),
        w,
        h,
        props,
        placed: false,
        anchor: false,
        x: 0,
        y: 0,
        intended: null,
        district: null,
        frontage: null,
        setback: null,
        branchHint: null,
        door: null,
        doorFace: null,
        boundaryDoor: null,
        surface: null,
        propPositions: [],
      }
      used.add(place.name)
      return place
    })
  )
  const widths = places
    .map((p) => (budget.caps.lab?.footprints ? Math.max(p.w, p.h) : Math.max(...sizes[p.size])))
    .sort((a, b) => a - b)
  const L = widths[Math.floor(widths.length / 2)] + 120,
    rng = stream(spec.seed, 'district', 'envelope')
  const phi = (0.34 + rng() * 0.1) * (budget.caps.lab?.compactness ?? 1)
  let area = places.reduce((s, p) => s + footprint(p), 0) / phi,
    aspect = 1 + rng() * 0.75
  if (places.length <= 5) {
    const minSide = Math.max(...places.map((p) => Math.min(p.w, p.h))) * 2 + 600
    area = Math.max(area, minSide * minSide)
    aspect = Math.min(aspect, area / (minSide * minSide))
  }
  const width = Math.ceil(Math.sqrt(area * aspect)),
    height = Math.ceil(Math.sqrt(area / aspect))
  /** @type {Plan} */
  const plan = {
    spec,
    places,
    L,
    phi,
    area,
    width,
    height,
    initialWidth: width,
    initialHeight: height,
    districts: [],
    roads: [],
    budget,
    defs,
    repairs: [],
    expanded: false,
    roadNoise: noise(spec.seed, 'road-field', L * 3),
    routeFailures: [],
  }
  checkConflicts(spec, places, L)
  return plan
}

export function placeDistricts(plan) {
  const { spec, places, L } = plan,
    rng = stream(spec.seed, 'district', 'centers')
  // 街区数决定镇子的「颗粒度」。原先上限 4，27 处地点只切 4 个半径 27 米的
  // 圆，而地点又只落在圆半径的一半处——四个小簇撒在一张两百多米宽的画布
  // 上，簇与簇之间六七十米全空：「莫名的大分支」「无意义的距离」就是这么来的。
  // 现在按每三到四处地点一个街区来切，让街区尺度回到 60~90 米。
  const count =
    places.length <= 5
      ? 1
      : clamp(
          Math.round(places.length / 7) + Math.floor(rng() * 3) - 1,
          1,
          Math.min(4, Math.floor(places.length / 2))
        )
  // 落点分布要跟街区数匹配。五处以内只有一个街区，落点铺满就会顶到画布
  // 边缘、排不下（实测两处地点的小镇直接失败），所以维持原来的收紧分布；
  // 规模上来之后街区多、画布大，落点必须铺满各自的街区——不然地点全挤在
  // 街区中心，簇与簇之间留出大片空地，正是「莫名的大分支」的来源。
  const spreadFalloff = places.length <= 5 ? 0.7 : 0.5,
    spreadScale = places.length <= 5 ? 0.8 : 1
  const weights = Array.from({ length: count }, () => 0.8 + rng() * 0.4),
    total = weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < count; i++) {
    const targetArea = (plan.area * weights[i]) / total,
      radius = Math.sqrt(targetArea / Math.PI)
    let center,
      best = -Infinity
    for (let j = 0; j < 32; j++) {
      const p = [plan.width * (0.18 + rng() * 0.64), plan.height * (0.18 + rng() * 0.64)]
      const score = i
        ? Math.min(...plan.districts.map((d) => dist(p, d.center) / (radius + d.radius)))
        : -dist(p, [plan.width / 2, plan.height / 2])
      if (score > best) {
        center = p
        best = score
      }
    }
    /** @type {District} */
    const district = {
      id: `district_${i + 1}`,
      center,
      radius,
      axis: rng() * Math.PI,
      aspect: 1 + rng() * 0.8,
      density: clamp(plan.phi + (rng() - 0.5) * 0.16, 0.4, 0.68),
      targetArea,
      usedArea: 0,
      branches: 0,
      hub: null,
    }
    plan.districts.push(district)
  }
  const involved = new Set(
    spec.constraints
      .filter((c) => c.required)
      .flatMap((c) =>
        [...targets(places, c.subject), ...targets(places, c.relative_to)].map((p) => p.id)
      )
  )
  // 户外空间（广场、花园、公园、市场、活动区域）排在最后分配：它们要贴着自己
  // 的配对建筑长，而配对关系只有等建筑落位之后才谈得上。以前它们排在最前，
  // 于是广场常常落在镇子另一头，孤零零一块大色块——正是「散放的垃圾地点」。
  const priority = (p) => (involved.has(p.id) ? 0 : p.outdoor ? 4 : p.kind === 'home' ? 2 : 1)
  const order = [...places].sort(
    (a, b) => priority(a) - priority(b) || b.w * b.h - a.w * a.h || a.id.localeCompare(b.id)
  )
  const districtsById = new Map(plan.districts.map((d) => [d.id, d]))
  const assigned = []
  for (const p of order) {
    plan.budget.check('districts')
    let best = null,
      bestScore = Infinity
    for (const d of plan.districts) {
      const r = stream(spec.seed, 'district', p.id + ':' + d.id)
      for (let j = 0; j < 32; j++) {
        const radius = Math.pow(r(), spreadFalloff),
          angle = r() * Math.PI * 2
        const ex = radius * Math.cos(angle) * d.radius * Math.sqrt(d.aspect) * spreadScale,
          ey = ((radius * Math.sin(angle) * d.radius) / Math.sqrt(d.aspect)) * spreadScale
        const [x, y] = withinCanvas(
          plan,
          p,
          d.center[0] + Math.cos(d.axis) * ex - Math.sin(d.axis) * ey,
          d.center[1] + Math.sin(d.axis) * ex + Math.cos(d.axis) * ey
        )
        const candidate = { ...p, x, y },
          rct = rect(candidate, 70)
        let score = d.usedArea / (d.targetArea * d.density) + (dist([x, y], d.center) / L) * 1.0
        for (const other of assigned) if (overlaps(rct, rect(other, 40))) score += 10
        // 户外空间贴着配对建筑：图书馆或镇公所旁的广场、酒店与俱乐部旁的花园
        // 才成立；离得越远扣得越多，跨 district 再额外扣一笔，免得它绕到镇子
        // 另一头去。
        // 2D 靠海的地点离镇中心越远越好，压过配对建筑往里拉的力；3D 的海由地形决定，不管
        if (COASTAL_KINDS.includes(p.kind))
          score -= (dist([x, y], [plan.width / 2, plan.height / 2]) / L) * 1.0
        const companions = OUTDOOR_COMPANIONS[p.kind]
        if (companions?.length) {
          const mate = assigned.find((q) => companions.includes(q.kind))
          if (mate) {
            score += (dist([x, y], [mate.x, mate.y]) / L) * 1.0
            if (mate.district !== d.id) score += 12
          }
        }
        for (const c of spec.constraints) {
          const subject = p.ref === c.subject || p.kind === c.subject,
            relative = p.ref === c.relative_to || p.kind === c.relative_to
          const others = assigned.filter(
            (q) =>
              q.ref === (subject ? c.relative_to : c.subject) ||
              q.kind === (subject ? c.relative_to : c.subject)
          )
          if ((subject || relative) && others.length) {
            const all = [...assigned, candidate]
            const a = targets(all, c.subject),
              b = targets(all, c.relative_to)
            if (a.length && b.length)
              score +=
                measureConstraints({ constraints: [c] }, all, L)[0].penalty * (c.required ? 8 : 1)
          }
        }
        if (score < bestScore) {
          bestScore = score
          best = { x, y, district: d.id }
        }
      }
    }
    Object.assign(p, best)
    districtsById.get(p.district).usedArea += footprint(p)
    assigned.push(p)
  }
  for (let step = 0; step < plan.budget.caps.projection_steps; step++) {
    plan.budget.check('projection')
    plan.budget.counts.projections++
    projectConstraints(plan, 1, step < 120)
    let moved = false
    for (let i = 0; i < places.length; i++)
      for (let j = 0; j < i; j++) {
        const a = places[i],
          b = places[j],
          dx = a.x - b.x,
          dy = a.y - b.y
        const ox = (a.w + b.w) / 2 + LAYOUT.separation_x - Math.abs(dx),
          oy = (a.h + b.h) / 2 + LAYOUT.separation_y - Math.abs(dy)
        if (ox <= 0 || oy <= 0) continue
        const axis = ox < oy ? 'x' : 'y',
          sign = (axis === 'x' ? dx : dy) >= 0 ? 1 : -1,
          delta = Math.min(L * 0.18, (axis === 'x' ? ox : oy) / 2 + 1)
        a[axis] += sign * delta
        b[axis] -= sign * delta
        moved = true
      }
    for (const p of places) {
      p.x = clamp(
        p.x,
        p.w / 2 + LAYOUT.projection_margin_x,
        plan.width - p.w / 2 - LAYOUT.projection_margin_x
      )
      p.y = clamp(
        p.y,
        p.h / 2 + LAYOUT.projection_margin_top,
        plan.height - p.h / 2 - LAYOUT.projection_margin_bottom
      )
    }
    if (
      !moved &&
      step >= 120 &&
      measureConstraints(spec, places, L).every((c) => !c.required || c.satisfied)
    )
      break
  }
  // Required groups retain their solved centers; this also handles overlapping group references.
  for (const p of places) if (involved.has(p.id)) p.anchor = true
  // An outdoor-only scene keeps the solved public areas; roads connect those reservations.
  if (places.every((p) => p.outdoor)) for (const p of places) p.anchor = true
  for (const d of plan.districts) {
    const publicPlaces = places
      .filter((p) => p.district === d.id && p.kind !== 'home')
      .sort(
        (a, b) =>
          Number(b.outdoor) - Number(a.outdoor) ||
          dist([a.x, a.y], d.center) - dist([b.x, b.y], d.center)
      )
    // 空白画布上，第一个公共地点直接占住街区中心。
    if (publicPlaces[0]) publicPlaces[0].anchor = true
  }
  for (const p of places) {
    p.x = Math.round(p.x)
    p.y = Math.round(p.y)
    p.intended = [p.x, p.y]
    p.placed = p.anchor
  }
  // Public/required reservations must already be physically feasible before routing.
  const anchors = places.filter((p) => p.anchor)
  for (let i = 0; i < anchors.length; i++)
    for (let j = 0; j < i; j++)
      if (overlaps(rect(anchors[i], 30), rect(anchors[j], 30)))
        throw new GenerationError('LAYOUT_UNRESOLVED', '必须关系涉及的地点暂时无法同时留出空间', {
          stage: 'districts',
          place_refs: [anchors[i].ref, anchors[j].ref],
        })
}

export function expandBoundary(plan) {
  if (plan.expanded) return false
  plan.expanded = true
  plan.width = Math.floor(plan.initialWidth * Math.sqrt(1.25))
  plan.height = Math.floor(plan.initialHeight * Math.sqrt(1.25))
  plan.repairs.push({ kind: 'expand_boundary', factor: 1.25 })
  return true
}
