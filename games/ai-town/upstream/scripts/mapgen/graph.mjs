import { dist, intersection, key, length, project, quantize, resample, Heap } from './geometry.mjs'
import { GenerationError } from './budget.mjs'
import {
  roundSafeStreetCorners,
  softenConnectedStreetTurns,
  softenStreetCorners,
} from './graph-corners.mjs'
import { collapseEmptyServiceLoop } from './street-loops.mjs'
import { directRoadClear } from './roads.mjs'
import {
  dedupeCloseStreetPairs,
  joinStreetContinuations,
  mergeParallelDoorLanes,
  narrowDoorSpurs,
  removeParallelDetours,
  removeTinyBypassTriangles,
  removeTinyStreetTriangles,
  removeUnusedParallelLenses,
  simplifyServicedTriangles,
} from './street-finish.mjs'

// Split crossings and near endpoint attachments before exporting the semantic navigation graph.
export function buildGraph(plan) {
  const segments = [],
    buckets = new Map(),
    protectedPoints = new Set(),
    arrivals = new Map(plan.places.map((p) => [key(p.door), p]))
  for (const road of plan.roads) {
    road.polyline = resample(road.polyline, 19)
    protectedPoints.add(key(road.polyline[0]))
    protectedPoints.add(key(road.polyline.at(-1)))
    for (let i = 1; i < road.polyline.length; i++) {
      const a = road.polyline[i - 1],
        b = road.polyline[i]
      if (dist(a, b) < 0.1) continue
      const s = {
          a,
          b,
          road,
          cuts: new Map([
            [key(a), { t: 0, p: a }],
            [key(b), { t: 1, p: b }],
          ]),
        },
        index = segments.length
      segments.push(s)
      for (
        let x = Math.floor((Math.min(a[0], b[0]) - 2) / 128);
        x <= Math.floor((Math.max(a[0], b[0]) + 2) / 128);
        x++
      )
        for (
          let y = Math.floor((Math.min(a[1], b[1]) - 2) / 128);
          y <= Math.floor((Math.max(a[1], b[1]) + 2) / 128);
          y++
        ) {
          const k = `${x},${y}`
          if (!buckets.has(k)) buckets.set(k, [])
          buckets.get(k).push(index)
        }
    }
  }
  const compared = new Set()
  const cut = (s, p, t) => s.cuts.set(key(p), { p, t })
  // A doorway may already lie exactly on a street. In that case the access
  // planner correctly emits no visible length, but the semantic graph still
  // needs to split the street at that arrival coordinate. Without this cut a
  // valid door became a one-point road that disappeared during export.
  for (const place of arrivals.values()) {
    const arrival = quantize(place.door)
    let best = null
    for (const segment of segments) {
      const hit = project(arrival, segment.a, segment.b)
      if (!best || hit.distance < best.hit.distance) best = { segment, hit }
    }
    if (best?.hit.distance <= 2) cut(best.segment, arrival, best.hit.t)
  }
  for (const indices of buckets.values())
    for (let a = 0; a < indices.length; a++)
      for (let b = 0; b < a; b++) {
        const ai = indices[a],
          bi = indices[b],
          pair = `${Math.min(ai, bi)}:${Math.max(ai, bi)}`
        if (compared.has(pair)) continue
        compared.add(pair)
        const s = segments[ai],
          t = segments[bi],
          hit = intersection(s.a, s.b, t.a, t.b)
        if (hit) {
          const p = quantize(hit.point)
          cut(s, p, hit.t)
          cut(t, p, hit.u)
        }
        for (const [source, target] of [
          [s, t],
          [t, s],
        ])
          for (const p of [source.a, source.b]) {
            const q = project(p, target.a, target.b)
            if (q.distance <= 2 && q.t > 1e-5 && q.t < 1 - 1e-5) cut(target, p, q.t)
          }
      }
  const links = new Map(),
    points = new Map(),
    adj = new Map()
  for (const s of segments) {
    const cuts = [...s.cuts.values()].sort(
      (a, b) => a.t - b.t || a.p[0] - b.p[0] || a.p[1] - b.p[1]
    )
    for (let i = 1; i < cuts.length; i++) {
      const a = key(cuts[i - 1].p),
        b = key(cuts[i].p)
      if (a === b) continue
      points.set(a, cuts[i - 1].p)
      points.set(b, cuts[i].p)
      const id = [a, b].sort().join('|'),
        old = links.get(id)
      if (old) {
        if (s.road.width > old.width)
          Object.assign(old, {
            width: s.road.width,
            class: s.road.class,
            owner: s.road.owner,
          })
        continue
      }
      const link = {
        id,
        a,
        b,
        width: s.road.width,
        class: s.road.class,
        owner: s.road.owner,
      }
      links.set(id, link)
      for (const endpoint of [a, b]) {
        if (!adj.has(endpoint)) adj.set(endpoint, [])
        adj.get(endpoint).push(link)
      }
    }
  }
  const nodes = new Map(),
    edges = [],
    visited = new Set()
  const forced = (k) =>
    protectedPoints.has(k) ||
    arrivals.has(k) ||
    adj.get(k).length !== 2 ||
    adj.get(k)[0].width !== adj.get(k)[1].width ||
    adj.get(k)[0].owner !== adj.get(k)[1].owner
  const node = (k) => {
    if (!nodes.has(k)) {
      const p = arrivals.get(k),
        [x, y] = points.get(k)
      nodes.set(k, {
        id: p ? `arrival_${p.id}` : `junction_${x}_${y}`,
        locale: p ? p.id : 'roads',
        x,
        y,
        kind: p ? 'place_arrival' : 'junction',
        space: 'town_outdoor',
      })
    }
    return nodes.get(k)
  }
  function walk(start, first) {
    let here = start,
      current = first,
      line = [points.get(start)],
      end = start
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      end = current.a === here ? current.b : current.a
      line.push(points.get(end))
      if (forced(end)) break
      here = end
      current = adj.get(end).find((e) => !visited.has(e.id))
    }
    // Long polylines retain their actual length by inserting real graph nodes.
    for (let offset = 0; offset < line.length - 1; offset += plan.budget.caps.edge_points - 1) {
      const ps = line.slice(offset, offset + plan.budget.caps.edge_points),
        a = node(key(ps[0])),
        b = node(key(ps.at(-1)))
      if (a.id === b.id && ps.length < 3) continue
      edges.push({
        id: `road_${String(edges.length + 1).padStart(4, '0')}`,
        from_node: a.id,
        to_node: b.id,
        from_locale: a.locale,
        to_locale: b.locale,
        polyline: ps,
        width: first.width,
        road_class: first.class,
        ...(first.owner ? { owner: first.owner } : {}),
      })
    }
  }
  for (const k of [...adj.keys()].sort())
    if (forced(k)) for (const edge of adj.get(k)) if (!visited.has(edge.id)) walk(k, edge)
  for (const edge of links.values()) if (!visited.has(edge.id)) walk(edge.a, edge)
  const connected = pruneUnusedEnds(
    collapseShortJunctionLinks({ nodes: [...nodes.values()], edges })
  )
  // The source skeleton has already placed parcels. Shape only the exported
  // full-size graph, keeping its chosen building positions and terrain crop.
  const graph = plan.preserveOriginalTopology
    ? roundSafeStreetCorners(
        softenConnectedStreetTurns(
          collapseEmptyServiceLoop(
            pruneUnusedEnds(
              dedupeCloseStreetPairs(
                mergeParallelDoorLanes(
                  removeUnusedParallelLenses(
                    simplifyServicedTriangles(
                      removeTinyStreetTriangles(
                        removeTinyBypassTriangles(
                          removeParallelDetours(
                            narrowDoorSpurs(
                              softenStreetCorners(
                                joinStreetContinuations(connected, plan.budget.caps.edge_points),
                                plan.budget.caps.edge_points
                              ),
                              plan.places
                            )
                          )
                        )
                      )
                    )
                  ),
                  plan,
                  directRoadClear
                )
              )
            ),
            plan
          ),
          plan,
          plan.budget.caps.edge_points
        ),
        plan,
        plan.budget.caps.edge_points
      )
    : connected
  if (
    graph.nodes.length > plan.budget.caps.max_nodes ||
    graph.edges.length > plan.budget.caps.max_edges
  )
    throw new GenerationError('GENERATION_BUDGET_EXCEEDED', '路网节点或路段达到上限', {
      stage: 'graph',
      measured: { nodes: graph.nodes.length, edges: graph.edges.length },
    })
  return graph
}

// A wide rendered intersection can create several graph cuts a few centimetres
// apart after integer resampling. Exporting those cuts as separate junctions
// produces zero-length roads and makes two visibly touching streets appear
// disconnected to the semantic graph. Collapse only junction-to-junction links
// shorter than the rendered intersection reach; building arrivals remain untouched.
export function collapseShortJunctionLinks(graph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node])),
    parent = new Map(graph.nodes.map((node) => [node.id, node.id]))
  const find = (id) => {
    const p = parent.get(id)
    if (p === id) return id
    const root = find(p)
    parent.set(id, root)
    return root
  }
  const join = (a, b) => {
    const left = find(a),
      right = find(b)
    if (left === right) return
    parent.set(left < right ? right : left, left < right ? left : right)
  }
  for (const edge of graph.edges) {
    const a = nodes.get(edge.from_node),
      b = nodes.get(edge.to_node)
    if (
      a?.kind === 'junction' &&
      b?.kind === 'junction' &&
      length(edge.polyline) <= Math.min(150, edge.width * 0.85)
    )
      join(a.id, b.id)
  }
  const groups = new Map()
  for (const node of graph.nodes) {
    const root = find(node.id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(node)
  }
  const collapsedNodes = new Map()
  for (const [root, members] of groups) {
    const source = nodes.get(root) ?? members[0]
    collapsedNodes.set(root, {
      ...source,
      x: Math.round(members.reduce((sum, node) => sum + node.x, 0) / members.length),
      y: Math.round(members.reduce((sum, node) => sum + node.y, 0) / members.length),
    })
  }
  const collapsedEdges = new Map()
  for (const edge of graph.edges) {
    const from = find(edge.from_node),
      to = find(edge.to_node)
    if (from === to) continue
    const polyline = edge.polyline.map((point) => [...point])
    polyline[0] = [collapsedNodes.get(from).x, collapsedNodes.get(from).y]
    polyline[polyline.length - 1] = [collapsedNodes.get(to).x, collapsedNodes.get(to).y]
    const candidate = { ...edge, from_node: from, to_node: to, polyline },
      pair = [from, to].sort().join('|'),
      previous = collapsedEdges.get(pair)
    // Collapsing a wide intersection can turn two nearby cuts into parallel
    // edges with identical endpoints. Rendering both creates the tiny lenses
    // and triangular road islands visible around junctions. Keep the wider
    // road, or the shorter geometry when both have the same width.
    if (
      !previous ||
      candidate.width > previous.width ||
      (candidate.width === previous.width && length(candidate.polyline) < length(previous.polyline))
    )
      collapsedEdges.set(pair, candidate)
  }
  return { nodes: [...collapsedNodes.values()], edges: [...collapsedEdges.values()] }
}

// A street is grown for capacity first. Remove its unused ends once all doors
// have connected, keeping every arrival and every route between arrivals.
function pruneUnusedEnds(graph) {
  const adjacent = new Map(graph.nodes.map((n) => [n.id, new Set()]))
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const active = new Set(graph.edges)
  for (const edge of graph.edges) {
    adjacent.get(edge.from_node).add(edge)
    adjacent.get(edge.to_node).add(edge)
  }
  const removable = (id) => byId.get(id).kind !== 'place_arrival' && adjacent.get(id).size === 1
  const queue = graph.nodes.filter((n) => removable(n.id)).map((n) => n.id)
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    if (!removable(id)) continue
    const edge = adjacent.get(id).values().next().value
    if (edge.from_node === edge.to_node) continue
    active.delete(edge)
    for (const endpoint of [edge.from_node, edge.to_node]) {
      adjacent.get(endpoint).delete(edge)
      if (removable(endpoint)) queue.push(endpoint)
    }
  }
  return {
    nodes: graph.nodes.filter((n) => n.kind === 'place_arrival' || adjacent.get(n.id).size),
    edges: graph.edges.filter((e) => active.has(e)),
  }
}

export function distances(graph, from) {
  const adjacent = new Map(graph.nodes.map((n) => [n.id, []]))
  for (const e of graph.edges) {
    const cost = length(e.polyline)
    adjacent.get(e.from_node).push([e.to_node, cost])
    adjacent.get(e.to_node).push([e.from_node, cost])
  }
  const values = new Map([[from, 0]]),
    heap = new Heap()
  heap.push(from, 0)
  while (heap.size) {
    const a = heap.pop(),
      base = values.get(a)
    for (const [b, cost] of adjacent.get(a) ?? [])
      if (base + cost < (values.get(b) ?? Infinity)) {
        values.set(b, base + cost)
        heap.push(b, base + cost)
      }
  }
  return values
}
