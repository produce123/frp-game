import { LAYOUT } from './budget.mjs'
import { dist, length } from './geometry.mjs'
import { buildGraph, distances } from './graph.mjs'
import { addRoad } from './roads.mjs'

/** Add the ordinary generator's bounded detour repairs to an already placed town. */
export function addStreetShortcuts(plan, initialGraph = buildGraph(plan)) {
  let graph = initialGraph
  for (let pass = 0; pass < 2; pass++) {
    let best = null
    for (const p of plan.places) {
      const paths = distances(graph, `arrival_${p.id}`)
      for (const q of plan.places)
        if (p.id < q.id) {
          const direct = dist(p.door, q.door),
            walk = paths.get(`arrival_${q.id}`) ?? Infinity
          if (
            direct < plan.L * 2 &&
            walk / Math.max(plan.L * 0.25, direct) > 2.5 &&
            (!best || walk / Math.max(plan.L * 0.25, direct) > best.ratio)
          )
            best = { p, q, walk, ratio: walk / Math.max(plan.L * 0.25, direct) }
        }
    }
    if (!best) break
    const a = plan.roads.find((road) => road.id === `access_${best.p.id}`).polyline[0],
      b = plan.roads.find((road) => road.id === `access_${best.q.id}`).polyline[0],
      road = addRoad(plan, a, b, {
        id: `shortcut_${pass}`,
        width: LAYOUT.road_width.street,
        class: 'street',
      })
    if (!road) break
    if (length(road.polyline) > best.walk * 0.7) {
      plan.roads.pop()
      break
    }
    graph = buildGraph(plan)
  }
  return graph
}
