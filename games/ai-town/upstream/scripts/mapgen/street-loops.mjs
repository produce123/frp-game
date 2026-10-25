import { dist, intersection, length, pointInPolygon, project } from './geometry.mjs'
import { parcelSegmentAabb } from './oriented-parcel.mjs'

/** 公共街道：主路与街道，不含属于某个地点的入口通道。 */
export const street = (edge) => !edge.owner && ['main', 'street'].includes(edge.road_class)
const otherEnd = (edge, id) => (edge.from_node === id ? edge.to_node : edge.from_node)

function shortestReturn(start, goal, omitted, incident) {
  const pending = [{ node: start, path: [], cost: 0 }],
    best = new Map()
  while (pending.length) {
    pending.sort((a, b) => a.cost - b.cost)
    const current = pending.shift()
    if (current.cost >= (best.get(current.node) ?? Infinity)) continue
    best.set(current.node, current.cost)
    if (current.node === goal) return current.path
    if (current.path.length >= 7 || current.cost > 7200) continue
    for (const edge of incident.get(current.node) ?? []) {
      if (edge === omitted) continue
      pending.push({
        node: otherEnd(edge, current.node),
        path: [...current.path, edge],
        cost: current.cost + length(edge.polyline),
      })
    }
  }
  return null
}

function cyclePolygon(start, edges) {
  const nodes = [start],
    polygon = []
  let here = start
  for (const edge of edges) {
    const points = edge.from_node === here ? edge.polyline : [...edge.polyline].reverse()
    polygon.push(...points.slice(0, -1))
    here = otherEnd(edge, here)
    nodes.push(here)
  }
  return here === start ? { nodes: nodes.slice(0, -1), polygon } : null
}

function arc(cycle, start, end) {
  const edges = [],
    interior = []
  for (let i = start; i !== end; i = (i + 1) % cycle.nodes.length) {
    edges.push(cycle.edges[i])
    const next = (i + 1) % cycle.nodes.length
    if (next !== end) interior.push(cycle.nodes[next])
  }
  return { edges, interior, length: edges.reduce((sum, edge) => sum + length(edge.polyline), 0) }
}

function nearestOn(point, edges) {
  let nearest = null
  for (const edge of edges)
    for (let i = 1; i < edge.polyline.length; i++) {
      const hit = project(point, edge.polyline[i - 1], edge.polyline[i])
      if (!nearest || hit.distance < nearest.hit.distance) nearest = { edge, index: i, hit }
    }
  return nearest
}

function safeFootpath(a, b, access, arrivalId, graph, dropped, target, plan) {
  const placeId = arrivalId.slice('arrival_'.length)
  if (
    plan.places.some(
      (place) =>
        place.placed &&
        place.id !== placeId &&
        parcelSegmentAabb(place, a, b, access.width / 2 + 25)
    )
  )
    return false
  return !graph.edges.some((edge) => {
    if (edge === target || dropped.has(edge) || edge === access || !street(edge)) return false
    return edge.polyline.slice(1).some((end, i) => {
      const hit = intersection(a, b, edge.polyline[i], end)
      return hit && dist(hit.point, a) > 20 && dist(hit.point, b) > 20
    })
  })
}

/**
 * Collapse a short empty street ring only when its removable side carries one
 * direct entrance and the other side continues to serve the street network.
 * The entrance becomes a narrow path to a split point on the retained street.
 * If that path fails terrain, parcel or crossing checks, keep the whole ring.
 */
export function collapseEmptyServiceLoop(graph, plan) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node])),
    incident = new Map(graph.nodes.map((node) => [node.id, []])),
    streets = graph.edges.filter(street),
    streetIncident = new Map(graph.nodes.map((node) => [node.id, []]))
  for (const edge of graph.edges)
    for (const id of [edge.from_node, edge.to_node]) {
      incident.get(id).push(edge)
      if (street(edge)) streetIncident.get(id).push(edge)
    }
  const seen = new Set()
  for (const closing of streets) {
    const path = shortestReturn(closing.from_node, closing.to_node, closing, streetIncident)
    if (!path) continue
    const edges = [...path, closing],
      key = edges
        .map((edge) => edge.id)
        .sort()
        .join('|')
    if (seen.has(key)) continue
    seen.add(key)
    if (edges.reduce((sum, edge) => sum + length(edge.polyline), 0) > 7200) continue
    const geometry = cyclePolygon(closing.from_node, edges)
    if (!geometry) continue
    const cycle = { ...geometry, edges }
    if (
      plan.places.some(
        (place) =>
          place.placed &&
          (pointInPolygon([place.x, place.y], cycle.polygon) ||
            (place.door && pointInPolygon(place.door, cycle.polygon)))
      )
    )
      continue
    for (let i = 0; i < cycle.nodes.length; i++)
      for (let j = 0; j < cycle.nodes.length; j++) {
        if (i === j) continue
        const removed = arc(cycle, i, j),
          kept = arc(cycle, j, i),
          cycleEdges = new Set(edges)
        if (removed.length > 3000 || !kept.interior.length) continue
        if (
          ![cycle.nodes[i], cycle.nodes[j]].every((id) =>
            streetIncident.get(id).some((edge) => !cycleEdges.has(edge))
          )
        )
          continue
        if (
          !kept.interior.some((id) =>
            streetIncident.get(id).some((edge) => !cycleEdges.has(edge))
          ) ||
          removed.interior.some((id) =>
            streetIncident.get(id).some((edge) => !cycleEdges.has(edge))
          )
        )
          continue
        const sideEdges = removed.interior.flatMap((id) =>
          incident.get(id).filter((edge) => !cycleEdges.has(edge))
        )
        if (sideEdges.length !== 1 || sideEdges[0].road_class !== 'access') continue
        const access = sideEdges[0],
          oldJunction = removed.interior.find((id) => incident.get(id).includes(access)),
          arrivalId = otherEnd(access, oldJunction)
        if (!arrivalId.startsWith('arrival_') || nodes.get(arrivalId)?.kind !== 'place_arrival')
          continue
        const arrival = nodes.get(arrivalId),
          nearest = nearestOn([arrival.x, arrival.y], kept.edges)
        if (!nearest || nearest.hit.distance > 1080) continue
        const point = nearest.hit.point.map(Math.round),
          dropped = new Set(removed.edges)
        if (
          !safeFootpath(
            point,
            [arrival.x, arrival.y],
            access,
            arrivalId,
            graph,
            dropped,
            nearest.edge,
            plan
          )
        )
          continue
        const junctionId = `junction_${point[0]}_${point[1]}`
        if (nodes.has(junctionId)) continue
        const line = nearest.edge.polyline,
          left = [...line.slice(0, nearest.index), point],
          right = [point, ...line.slice(nearest.index)],
          splitId = `${nearest.edge.id}_loop_split`
        if (left.length < 2 || right.length < 2 || graph.edges.some((edge) => edge.id === splitId))
          continue
        const first = { ...nearest.edge, to_node: junctionId, to_locale: 'roads', polyline: left },
          second = {
            ...nearest.edge,
            id: splitId,
            from_node: junctionId,
            from_locale: 'roads',
            polyline: right,
          },
          footpath =
            access.from_node === oldJunction
              ? {
                  ...access,
                  from_node: junctionId,
                  from_locale: 'roads',
                  polyline: [point, [arrival.x, arrival.y]],
                }
              : {
                  ...access,
                  to_node: junctionId,
                  to_locale: 'roads',
                  polyline: [[arrival.x, arrival.y], point],
                }
        return {
          nodes: [
            ...graph.nodes.filter((node) => !removed.interior.includes(node.id)),
            {
              id: junctionId,
              x: point[0],
              y: point[1],
              kind: 'junction',
              space: 'town_outdoor',
              locale: 'roads',
            },
          ],
          edges: [
            ...graph.edges
              .filter((edge) => !dropped.has(edge) && edge !== nearest.edge)
              .map((edge) => (edge === access ? footpath : edge)),
            first,
            second,
          ],
        }
      }
  }
  return graph
}
