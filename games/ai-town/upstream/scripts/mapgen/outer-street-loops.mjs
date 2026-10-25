import { dist, intersection, length, pointInPolygon } from './geometry.mjs'
import { street } from './street-loops.mjs'
import { parcelSegmentAabb } from './oriented-parcel.mjs'
import { roundNavigableCorners } from './road-corners.mjs'
import { debug } from './debug.mjs'

function existingStreetPath(graph, start, end) {
  const incident = new Map(graph.nodes.map((node) => [node.id, []]))
  for (const edge of graph.edges.filter(street)) {
    incident.get(edge.from_node)?.push(edge)
    incident.get(edge.to_node)?.push(edge)
  }
  const pending = [{ id: start, cost: 0, points: [] }],
    best = new Map()
  while (pending.length) {
    pending.sort((a, b) => a.cost - b.cost)
    const current = pending.shift()
    if (current.cost >= (best.get(current.id) ?? Infinity)) continue
    best.set(current.id, current.cost)
    if (current.id === end) return current.points
    for (const edge of incident.get(current.id) ?? []) {
      const forward = edge.from_node === current.id,
        points = forward ? edge.polyline : [...edge.polyline].reverse(),
        next = forward ? edge.to_node : edge.from_node
      pending.push({
        id: next,
        cost: current.cost + length(points),
        points: [...current.points, ...points.slice(current.points.length ? 1 : 0)],
      })
    }
  }
  return null
}

function crossingRoad(line, edges, start, end) {
  for (const edge of edges)
    for (let j = 1; j < edge.polyline.length; j++)
      for (let i = 1; i < line.length; i++) {
        const b = edge.polyline[j],
          d = line[i]
        const hit = intersection(edge.polyline[j - 1], b, line[i - 1], d)
        if (hit && dist(hit.point, start) > 30 && dist(hit.point, end) > 30)
          return { edge: edge.id, point: hit.point }
      }
  return null
}

function cleanPerimeter(plan, road, graph) {
  const start = road.polyline[0],
    end = road.polyline.at(-1),
    free = (a, b) =>
      !plan.places.some(
        (place) => place.placed && parcelSegmentAabb(place, a, b, road.width / 2 + 25)
      ) && !crossingRoad([a, b], graph.edges, start, end),
    points = road.polyline,
    controls = [points[0]]
  for (let i = 0; i < points.length - 1;) {
    let next = points.length - 1
    while (next > i + 1 && !free(points[i], points[next])) next--
    controls.push(points[next])
    i = next
  }
  const curved = roundNavigableCorners(controls, 360, free)
  return curved.slice(1).every((point, index) => free(curved[index], point)) ? curved : controls
}

/** Join nearby outer street ends into a few useful perimeter circuits. */
export function connectOuterStreetEnds(plan, graph, addRoad, maximum = 3) {
  const incident = new Map(graph.nodes.map((node) => [node.id, []]))
  for (const edge of graph.edges.filter(street)) {
    incident.get(edge.from_node)?.push(edge)
    incident.get(edge.to_node)?.push(edge)
  }
  const ends = graph.nodes.filter(
    (node) => node.kind === 'junction' && incident.get(node.id)?.length === 1
  )
  if (ends.length < 2) return 0
  const centre = [
    plan.places.reduce((sum, place) => sum + place.x, 0) / plan.places.length,
    plan.places.reduce((sum, place) => sum + place.y, 0) / plan.places.length,
  ]
  const radial = (node) => dist([node.x, node.y], centre)
  const outerReach = Math.max(...ends.map(radial)) * 0.45
  const outer = ends.filter((node) => radial(node) >= outerReach)
  const candidates = []
  for (let i = 0; i < outer.length; i++)
    for (let j = i + 1; j < outer.length; j++) {
      const a = outer[i],
        b = outer[j],
        direct = dist([a.x, a.y], [b.x, b.y]),
        midpoint = [(a.x + b.x) / 2, (a.y + b.y) / 2]
      if (
        direct < 3600 ||
        direct > 9000 ||
        dist(midpoint, centre) < Math.min(radial(a), radial(b)) * 0.68
      )
        continue
      candidates.push({ a, b, direct })
    }
  candidates.sort((a, b) => a.direct - b.direct || a.a.id.localeCompare(b.a.id))
  const used = new Set(),
    newEdges = [],
    width = Math.min(90, Math.max(72, plan.roadScale ? 80 * plan.roadScale : 80))
  let added = 0,
    attempted = 0
  for (const { a, b, direct } of candidates) {
    if (added >= maximum || attempted >= 7) break
    if (used.has(a.id) || used.has(b.id)) continue
    attempted++
    const start = [a.x, a.y],
      end = [b.x, b.y],
      midpoint = [(a.x + b.x) / 2, (a.y + b.y) / 2],
      outward = [midpoint[0] - centre[0], midpoint[1] - centre[1]],
      outwardLength = Math.hypot(...outward),
      via = outwardLength
        ? (direct > 6000 ? [0.25, 0.75] : [0.5]).map((t) =>
            start.map(
              (value, index) =>
                value + (end[index] - value) * t + (outward[index] / outwardLength) * direct * 0.3
            )
          )
        : [],
      road = addRoad(plan, start, end, {
        id: `perimeter_${a.id}_${b.id}`,
        width,
        class: 'street',
        curved: false,
        via,
      })
    if (!road) {
      debug?.(`[perimeter] ${a.id} 与 ${b.id} 之间找不到外圈路`)
      continue
    }
    road.polyline = cleanPerimeter(plan, road, graph)
    const tooLong = length(road.polyline) > direct * 1.35,
      crossing = crossingRoad(road.polyline, [...graph.edges, ...newEdges], start, end),
      oldPath = existingStreetPath(graph, a.id, b.id),
      servesPlace =
        oldPath &&
        plan.places.some((place) =>
          pointInPolygon([place.x, place.y], [...oldPath, ...[...road.polyline].reverse()])
        )
    if (tooLong || crossing || !servesPlace) {
      debug?.(
        `[perimeter] ${a.id} 与 ${b.id} 的外圈路不采用：${[tooLong && '绕得太远', crossing && '与已有道路交叉', !servesPlace && '圈内没有地点'].filter(Boolean).join('、')}`
      )
      plan.roads.pop()
      continue
    }
    newEdges.push(road)
    used.add(a.id)
    used.add(b.id)
    added++
  }
  return added
}
