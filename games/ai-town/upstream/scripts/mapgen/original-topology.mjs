import { expandPlan, placeDistricts } from './districts.mjs'
import { fitEntrances, fitParcels } from './parcels.mjs'
import { connectDistricts, connectEntrance, mainRoads, trimSpineEnds } from './roads.mjs'
import { buildGraph } from './graph.mjs'
import { addStreetShortcuts } from './street-shortcuts.mjs'
import { GenerationError } from './budget.mjs'
import { debug } from './debug.mjs'

const scaledPoint = (point, scale) => point.map((value) => value * scale)

function scaledCandidate(plan, skeleton, sourceGraph, scale) {
  const sourcePlaces = new Map(skeleton.places.map((place) => [place.id, place]))
  return {
    ...plan,
    width: Math.ceil(skeleton.width * scale),
    height: Math.ceil(skeleton.height * scale),
    initialWidth: Math.ceil(skeleton.width * scale),
    initialHeight: Math.ceil(skeleton.height * scale),
    area: skeleton.area * scale ** 2,
    L: skeleton.L * scale,
    // 落位阶段补的支路/街道按同一倍数取宽（见 roads.mjs roadWidth）。
    roadScale: scale,
    plannedNetwork: true,
    preserveOriginalTopology: true,
    roads: sourceGraph.edges
      .filter((edge) => edge.road_class === 'main' || edge.road_class === 'street')
      .map((edge) => ({
        id: `source_${edge.id}`,
        polyline: edge.polyline.map((point) => scaledPoint(point, scale)),
        // 坐标放大时路宽必须同步放大，否则 2 倍尺度的镇子里街道只有
        // 1.3m 宽，3D 里像田埂。门后的人行引道（access）不参与缩放：
        // 它是贴门的步道，宽度与 rust 校验的净空约定绑定。
        // 取整保持 svg 单位整数精度，见 roads.mjs roadWidth 注释。
        width: Math.round(edge.width * scale),
        class: edge.road_class,
        sourceTopology: true,
      })),
    districts: skeleton.districts.map((district) => ({
      ...district,
      center: scaledPoint(district.center, scale),
      hub: district.hub ? scaledPoint(district.hub, scale) : null,
      radius: district.radius * scale,
      targetArea: district.targetArea * scale ** 2,
      usedArea: 0,
      // The complete source road network is already present. Do not add a
      // different branch merely because the selected 3D assets are larger.
      branches: 4,
    })),
    places: plan.places.map((place) => {
      const source = sourcePlaces.get(place.id)
      return {
        ...place,
        district: source.district,
        intended: scaledPoint([source.x, source.y], scale),
        x: source.x * scale,
        y: source.y * scale,
        anchor: false,
        placed: false,
      }
    }),
    repairs: [...skeleton.repairs],
    expanded: false,
  }
}

/**
 * Generate the ordinary 2D street topology first, then enlarge its coordinates
 * enough to fit the selected 3D assets. Main roads, streets, loops and branches
 * come from the unmodified generator; building dimensions only choose the scale
 * and frontage positions.
 */
export function fitOriginalTopology(plan, library, definitions) {
  const lab = plan.budget.caps.lab
  if (!lab?.footprints || plan.spec.constraints.length) return false

  // 骨架直接按真实资产足迹排：以前骨架用模板小地块（7.7m 深）排完再整体
  // 放大 ~2 倍去装 15~22m 的真实房子，所有街道间隙跟着放大 2 倍——房子
  // 之间凭空多出十几米，路网密度掉到 4 m/ha。现在骨架与最终画布同尺寸
  // （scale≈1），街道间距一开始就匹配真实房子，排不下仍由 attempt 循环
  // 按 +0.12 一档放松。
  const skeleton = expandPlan(plan.spec, library, definitions, plan.budget)
  placeDistricts(skeleton)
  // 街区之间的连接路推迟到落位之后：先让建筑长在脊柱两侧、剪掉没有
  // 建筑服务的脊柱末端，再缝合街区，连接路就不会穿过大片空地。
  mainRoads(skeleton, { deferConnections: true })
  fitParcels(skeleton)
  trimSpineEnds(skeleton)
  connectDistricts(skeleton)
  for (const place of skeleton.places)
    if (!connectEntrance(skeleton, place))
      throw new GenerationError('ROUTE_UNRESOLVED', `${place.name}暂时没有可行的入口通道`, {
        stage: 'entrances',
        place_refs: [place.ref],
      })
  const sourceGraph = addStreetShortcuts(skeleton, buildGraph(skeleton))

  const initialScale = Math.max(
    1,
    plan.width / Math.max(1, skeleton.width),
    plan.height / Math.max(1, skeleton.height)
  )
  debug?.(
    `[topology] 骨架 ${skeleton.places.length} 处地点、${skeleton.districts.length} 个街区、${skeleton.roads.length} 条路，画布 ${Math.round(skeleton.width)}×${Math.round(skeleton.height)}，放大起点 ${initialScale.toFixed(3)}`
  )
  let lastError
  for (let attempt = 0; attempt < 10; attempt++) {
    plan.budget.check('original-topology-fit')
    const scale = initialScale + attempt * 0.12,
      candidate = scaledCandidate(plan, skeleton, sourceGraph, scale)
    try {
      fitParcels(candidate)
      const missing = fitEntrances(candidate, connectEntrance)
      if (missing) continue
      for (const key of [
        'width',
        'height',
        'initialWidth',
        'initialHeight',
        'area',
        'L',
        'roadScale',
        'districts',
        'roads',
        'places',
        'expanded',
        'plannedNetwork',
        'preserveOriginalTopology',
      ])
        plan[key] = candidate[key]
      plan.repairs = [
        ...candidate.repairs,
        {
          kind: 'scale_original_topology',
          factor: Number(scale.toFixed(4)),
          source_roads: sourceGraph.edges.filter(
            (edge) => edge.road_class === 'main' || edge.road_class === 'street'
          ).length,
        },
      ]
      return true
    } catch (error) {
      if (!['INSUFFICIENT_SPACE', 'ROUTE_UNRESOLVED'].includes(error.code)) throw error
      lastError = error
    }
  }
  if (lastError) throw lastError
  return false
}
