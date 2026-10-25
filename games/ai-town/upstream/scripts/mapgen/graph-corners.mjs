import { dist, project, resample, smooth } from './geometry.mjs'
import { parcelSegmentAabb } from './oriented-parcel.mjs'
import { roundRoadCorners } from './road-corners.mjs'
import { shapeStreetGraph } from './street-curves.mjs'

// Keep all junction coordinates fixed. Only soften a street inside its own
// surface: at this sampling distance Chaikin's maximum corner displacement is
// smaller than half of a normal street width.
function simplifyWithin(points, tolerance) {
  if (points.length < 3) return points
  const keep = new Set([0, points.length - 1])
  const visit = (start, end) => {
    let farthest = tolerance,
      index = -1
    for (let i = start + 1; i < end; i++) {
      const distance = project(points[i], points[start], points[end]).distance
      if (distance > farthest) {
        farthest = distance
        index = i
      }
    }
    if (index < 0) return
    keep.add(index)
    visit(start, index)
    visit(index, end)
  }
  visit(0, points.length - 1)
  return points.filter((_, index) => keep.has(index))
}

export function softenStreetCorners(graph, maxPoints) {
  return {
    ...graph,
    edges: graph.edges.map((edge) => {
      if (edge.owner || !['main', 'street'].includes(edge.road_class)) return edge
      const controls = simplifyWithin(edge.polyline, 6)
      if (controls.length < 3) return edge
      const sampleStep = Math.min(100, edge.width * 0.8)
      const sampled = resample(controls, sampleStep)
      const curved = smooth(sampled, 2)
      if (
        curved.length > maxPoints ||
        dist(curved[0], edge.polyline[0]) > 0.01 ||
        dist(curved.at(-1), edge.polyline.at(-1)) > 0.01
      )
        return edge
      return { ...edge, polyline: curved }
    }),
  }
}

// Round approaches through a shared street junction as one network. The
// junction itself stays fixed, so the semantic graph and door connections do
// not drift apart. Reject a curve if it leaves the original road corridor or
// clips terrain or a placed parcel.
export function softenConnectedStreetTurns(graph, plan, maxPoints) {
  const streets = graph.edges.filter(
    (edge) => !edge.owner && ['main', 'street'].includes(edge.road_class)
  )
  if (!streets.length) return graph
  const nodeIndex = new Map(graph.nodes.map((node, index) => [node.id, index]))
  const shaped = shapeStreetGraph(
    graph.nodes.map((node, id) => ({ id, p: [node.x / 60, node.y / 60] })),
    streets.map((edge, id) => ({
      id,
      a: nodeIndex.get(edge.from_node),
      b: nodeIndex.get(edge.to_node),
      authoredPoints: simplifyWithin(edge.polyline, 12).map((point) =>
        point.map((value) => value / 60)
      ),
    })),
    Math.max(plan.width ?? 0, plan.height ?? 0, 60) / 60,
    'continuous',
    plan.spec?.seed ?? 0
  )
  const replacement = new Map()
  for (let index = 0; index < streets.length; index++) {
    const edge = streets[index],
      polyline = shaped.edges[index].points.map((point) => point.map((value) => value * 60)),
      limit = Math.min(edge.width * 0.8, 96)
    if (
      polyline.length > maxPoints ||
      polyline.some((point) => point.some((value) => !Number.isFinite(value))) ||
      dist(polyline[0], edge.polyline[0]) > 0.01 ||
      dist(polyline.at(-1), edge.polyline.at(-1)) > 0.01 ||
      polyline.some(
        (point) =>
          Math.min(
            ...edge.polyline
              .slice(1)
              .map((end, i) => project(point, edge.polyline[i], end).distance)
          ) > limit
      ) ||
      polyline.slice(1).some((point, i) => {
        const previous = polyline[i]
        return plan.places.some(
          (place) => place.placed && parcelSegmentAabb(place, previous, point, edge.width / 2 + 25)
        )
      })
    )
      continue
    replacement.set(edge, { ...edge, polyline })
  }
  return { ...graph, edges: graph.edges.map((edge) => replacement.get(edge) ?? edge) }
}

// A blocked part of a long street must not prevent a safe corner elsewhere on
// that street from rounding. Only replace bends that pass the final parcel
// clearance check.
export function roundSafeStreetCorners(graph, plan, maxPoints) {
  const passable = (edge, a, b) =>
    !plan.places.some(
      (place) => place.placed && parcelSegmentAabb(place, a, b, edge.width / 2 + 25)
    )
  return {
    ...graph,
    edges: graph.edges.map((edge) => {
      if (edge.owner || !['main', 'street'].includes(edge.road_class)) return edge
      const controls = simplifyWithin(edge.polyline, 12)
      if (controls.length < 3) return edge
      const result = [controls[0]]
      let changed = false
      for (let i = 1; i < controls.length - 1; i++) {
        const arc = roundRoadCorners([controls[i - 1], controls[i], controls[i + 1]], 300).slice(
          1,
          -1
        )
        const candidate = [result.at(-1), ...arc, controls[i + 1]]
        if (
          arc.length < 3 ||
          candidate.slice(1).some((point, j) => !passable(edge, candidate[j], point))
        ) {
          result.push(controls[i])
          continue
        }
        result.push(...arc)
        changed = true
      }
      result.push(controls.at(-1))
      return changed && result.length <= maxPoints ? { ...edge, polyline: result } : edge
    }),
  }
}
