import { dist, intersection, length, project, quantize } from './geometry.mjs'
import { softenStreetCorners } from './graph-corners.mjs'

const street = (edge) => !edge.owner && ['main', 'street'].includes(edge.road_class)

// Source roads are split at every authored endpoint. Joining a degree-two
// continuation lets the corner pass see both sides of a bend; actual junctions
// and all arrival nodes remain fixed.
export function joinStreetContinuations(graph, maxPoints) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node])),
    edges = [...graph.edges]
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes.values()) {
      if (node.kind !== 'junction') continue
      const incident = edges.filter(
        (edge) => edge.from_node === node.id || edge.to_node === node.id
      )
      if (incident.length !== 2 || incident.some((edge) => !street(edge))) continue
      const [first, second] = incident
      if (first.road_class !== second.road_class || Math.abs(first.width - second.width) > 12)
        continue
      const start = first.from_node === node.id ? first.to_node : first.from_node,
        end = second.from_node === node.id ? second.to_node : second.from_node
      if (start === end) continue
      const left = first.to_node === node.id ? first.polyline : [...first.polyline].reverse(),
        right = second.from_node === node.id ? second.polyline : [...second.polyline].reverse(),
        candidate = {
          ...first,
          from_node: start,
          to_node: end,
          from_locale: nodes.get(start).locale,
          to_locale: nodes.get(end).locale,
          polyline: [...left, ...right.slice(1)],
        },
        rounded = softenStreetCorners({ nodes: [], edges: [candidate] }, maxPoints).edges[0]
      if (rounded.polyline.length > maxPoints) continue
      edges.splice(edges.indexOf(first), 1, rounded)
      edges.splice(edges.indexOf(second), 1)
      nodes.delete(node.id)
      changed = true
      break
    }
  }
  return { nodes: [...nodes.values()], edges }
}

// A short street that serves only one front door should read as a footpath,
// while the longer through streets and public-space approaches keep their width.
export function narrowDoorSpurs(graph, places) {
  const outdoor = new Set(places.filter((place) => place.outdoor).map((place) => place.id)),
    incident = new Map(graph.nodes.map((node) => [node.id, []]))
  for (const edge of graph.edges)
    for (const id of [edge.from_node, edge.to_node]) incident.get(id).push(edge)
  const narrow = new Set()
  for (const node of graph.nodes) {
    if (node.kind !== 'junction') continue
    const attached = incident.get(node.id),
      streets = attached.filter(street),
      accesses = attached.filter((edge) => edge.road_class === 'access')
    if (streets.length !== 1 || accesses.length !== 1 || length(streets[0].polyline) > 600) continue
    const arrival = accesses[0].from_node === node.id ? accesses[0].to_node : accesses[0].from_node
    if (!arrival.startsWith('arrival_') || outdoor.has(arrival.slice('arrival_'.length))) continue
    narrow.add(streets[0])
  }
  return {
    ...graph,
    edges: graph.edges.map((edge) =>
      narrow.has(edge) ? { ...edge, width: Math.min(edge.width, 72), road_class: 'access' } : edge
    ),
  }
}

function parallelRun(a, b) {
  const reach = Math.max(45, (a.width + b.width) / 2 - 35)
  let run = 0,
    longest = 0
  for (let i = 1; i < a.polyline.length; i++) {
    const p = a.polyline[i - 1],
      q = a.polyline[i],
      vector = [q[0] - p[0], q[1] - p[1]],
      segmentLength = dist(p, q),
      middle = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
    let matching = false
    for (let j = 1; j < b.polyline.length; j++) {
      const u = b.polyline[j - 1],
        v = b.polyline[j],
        candidate = [v[0] - u[0], v[1] - u[1]],
        candidateLength = dist(u, v)
      if (!segmentLength || !candidateLength) continue
      const alignment = Math.abs(
        (vector[0] * candidate[0] + vector[1] * candidate[1]) / segmentLength / candidateLength
      )
      if (alignment >= 0.9 && project(middle, u, v).distance < reach) {
        matching = true
        break
      }
    }
    run = matching ? run + segmentLength : 0
    longest = Math.max(longest, run)
  }
  return longest
}

function alternateDistance(edges, removed, start, goal) {
  const adjacent = new Map()
  for (const edge of edges) {
    if (edge === removed) continue
    const cost = length(edge.polyline)
    for (const [a, b] of [
      [edge.from_node, edge.to_node],
      [edge.to_node, edge.from_node],
    ]) {
      if (!adjacent.has(a)) adjacent.set(a, [])
      adjacent.get(a).push([b, cost])
    }
  }
  const cost = new Map([[start, 0]]),
    pending = new Set([start])
  while (pending.size) {
    const node = [...pending].sort((a, b) => cost.get(a) - cost.get(b))[0]
    pending.delete(node)
    if (node === goal) return cost.get(node)
    for (const [next, distance] of adjacent.get(node) ?? [])
      if (cost.get(node) + distance < (cost.get(next) ?? Infinity)) {
        cost.set(next, cost.get(node) + distance)
        pending.add(next)
      }
  }
  return Infinity
}

export function removeParallelDetours(graph) {
  let result = graph
  for (const candidate of [...graph.edges].filter(street).sort((a, b) => a.width - b.width)) {
    if (!result.edges.includes(candidate)) continue
    const span = length(candidate.polyline)
    if (span < 600) continue
    const overlaps = result.edges.some(
      (other) =>
        other !== candidate &&
        street(other) &&
        other.width >= candidate.width + 10 &&
        ![candidate.from_node, candidate.to_node].includes(other.from_node) &&
        ![candidate.from_node, candidate.to_node].includes(other.to_node) &&
        parallelRun(candidate, other) >= Math.max(180, span * 0.14)
    )
    if (
      !overlaps ||
      alternateDistance(result.edges, candidate, candidate.from_node, candidate.to_node) >
        span * 2.5
    )
      continue
    result = {
      nodes: result.nodes,
      edges: result.edges.filter((edge) => edge !== candidate),
    }
  }
  return result
}

// A split just beside a junction can leave a degree-two tip and a tiny
// triangle. If its direct side is shorter than the two sides through the tip,
// remove the redundant bypass without changing any arrival or junction that
// serves another road.
export function removeTinyBypassTriangles(graph) {
  const incident = new Map(graph.nodes.map((node) => [node.id, []]))
  for (const edge of graph.edges)
    for (const id of [edge.from_node, edge.to_node]) incident.get(id).push(edge)
  const droppedNodes = new Set(),
    droppedEdges = new Set()
  for (const node of graph.nodes) {
    const branches = incident.get(node.id)
    if (node.kind !== 'junction' || branches.length !== 2 || branches.some((edge) => !street(edge)))
      continue
    const [left, right] = branches,
      a = left.from_node === node.id ? left.to_node : left.from_node,
      b = right.from_node === node.id ? right.to_node : right.from_node
    if (a === b) continue
    if (incident.get(a).length < 3 || incident.get(b).length < 3) continue
    const direct = incident
      .get(a)
      .find(
        (edge) =>
          street(edge) &&
          ((edge.from_node === a && edge.to_node === b) ||
            (edge.from_node === b && edge.to_node === a))
      )
    if (!direct) continue
    const bypass = length(left.polyline) + length(right.polyline),
      directLength = length(direct.polyline)
    if (bypass + directLength > 2400 || directLength > bypass * 1.15) continue
    droppedNodes.add(node.id)
    droppedEdges.add(left)
    droppedEdges.add(right)
  }
  return {
    nodes: graph.nodes.filter((node) => !droppedNodes.has(node.id)),
    edges: graph.edges.filter((edge) => !droppedEdges.has(edge)),
  }
}

// A three-way junction at every corner used to protect even a tiny empty
// triangular road island. The other two sides still connect all three nodes,
// so the narrowest side can be removed without losing a doorstep or a route.
export function removeTinyStreetTriangles(graph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node])),
    byPair = new Map(),
    incident = new Map(graph.nodes.map((node) => [node.id, []])),
    dropped = new Set()
  for (const edge of graph.edges) {
    incident.get(edge.from_node)?.push(edge)
    incident.get(edge.to_node)?.push(edge)
    if (!street(edge)) continue
    const pair = [edge.from_node, edge.to_node].sort().join('|')
    if (!byPair.has(pair)) byPair.set(pair, edge)
  }
  for (const edge of graph.edges) {
    if (!street(edge) || dropped.has(edge)) continue
    const a = edge.from_node,
      b = edge.to_node
    if (nodes.get(a)?.kind !== 'junction' || nodes.get(b)?.kind !== 'junction') continue
    for (const tip of graph.nodes) {
      if (tip.kind !== 'junction' || tip.id === a || tip.id === b) continue
      const left = byPair.get([a, tip.id].sort().join('|')),
        right = byPair.get([b, tip.id].sort().join('|'))
      if (!left || !right || dropped.has(left) || dropped.has(right)) continue
      if (
        [a, b, tip.id].some((id) => incident.get(id).some((side) => side.road_class === 'access'))
      )
        continue
      const pa = nodes.get(a),
        pb = nodes.get(b),
        area = Math.abs((pb.x - pa.x) * (tip.y - pa.y) - (pb.y - pa.y) * (tip.x - pa.x)) / 2,
        ring = [edge, left, right]
      if (area > 30000 || ring.reduce((sum, side) => sum + length(side.polyline), 0) > 1200)
        continue
      const redundant = [...ring].sort(
        (first, second) =>
          first.width - second.width || length(second.polyline) - length(first.polyline)
      )[0]
      dropped.add(redundant)
      break
    }
  }
  return { ...graph, edges: graph.edges.filter((edge) => !dropped.has(edge)) }
}

// Judge the exported centre lines as a player sees them. A long parallel pair
// with only a narrow strip between its surfaces is a visible double road even
// when both lanes are reachable and one happens to serve an entrance.
export function auditStreetVisualQuality(graph) {
  const roads = graph.edges.filter(street),
    issues = [],
    widthTransitions = []
  const incident = new Map(graph.nodes.map((node) => [node.id, []]))
  for (const road of roads) {
    incident.get(road.from_node)?.push(road)
    incident.get(road.to_node)?.push(road)
  }
  for (const node of graph.nodes) {
    const pair = incident.get(node.id)
    if (node.kind !== 'junction' || pair?.length !== 2) continue
    // Access and interior paths are intentionally narrower. This check only
    // covers a continuous public street that abruptly changes its full width.
    if (
      graph.edges.some(
        (edge) => !street(edge) && (edge.from_node === node.id || edge.to_node === node.id)
      )
    )
      continue
    if (Math.abs(pair[0].width - pair[1].width) >= 20) {
      const transition = {
        code: 'STREET_WIDTH_TAPER',
        node: node.id,
        roads: pair.map((road) => road.id),
        widths: pair.map((road) => road.width),
      }
      if (length([...pair].sort((a, b) => b.width - a.width)[0].polyline) < 100)
        issues.push({ ...transition, code: 'ABRUPT_STREET_WIDTH_STEP' })
      else widthTransitions.push(transition)
    }
  }
  for (let i = 0; i < roads.length; i++)
    for (let j = i + 1; j < roads.length; j++) {
      const a = roads[i],
        b = roads[j]
      if (
        a.from_node === b.from_node ||
        a.from_node === b.to_node ||
        a.to_node === b.from_node ||
        a.to_node === b.to_node
      )
        continue
      const limit = Math.min(350, Math.max(a.width, b.width) * 3.5),
        minimum = (a.width + b.width) / 2 + 25
      let longest = 0
      for (const [source, target] of [
        [a, b],
        [b, a],
      ]) {
        let run = 0
        for (let k = 1; k < source.polyline.length; k++) {
          const p = source.polyline[k - 1],
            q = source.polyline[k],
            span = dist(p, q),
            middle = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
          let matching = false
          for (let m = 1; m < target.polyline.length; m++) {
            const u = target.polyline[m - 1],
              v = target.polyline[m],
              otherSpan = dist(u, v)
            if (!span || !otherSpan) continue
            const gap = project(middle, u, v).distance,
              alignment = Math.abs(
                ((q[0] - p[0]) * (v[0] - u[0]) + (q[1] - p[1]) * (v[1] - u[1])) / span / otherSpan
              )
            if (gap >= minimum && gap <= limit && alignment >= 0.9) {
              matching = true
              break
            }
          }
          run = matching ? run + span : 0
          longest = Math.max(longest, run)
        }
      }
      if (longest >= 600)
        issues.push({
          code: 'CLOSE_PARALLEL_STREETS',
          roads: [a.id, b.id],
          parallel_length: Math.round(longest),
        })
    }
  return { ok: issues.length === 0, issues, width_transitions: widthTransitions }
}

// If a narrow side lane exists only to reach one front door, attach that door
// to the nearby main road and remove the two redundant side links. Check the
// real parcel/terrain corridor before changing the graph; other parallel
// layouts stay visible as quality issues for local repair.
export function mergeParallelDoorLanes(graph, plan, clearRoute) {
  let result = graph
  for (let attempt = 0; attempt < 8; attempt++) {
    const closePairs = auditStreetVisualQuality(result).issues.filter(
        (issue) => issue.code === 'CLOSE_PARALLEL_STREETS'
      ),
      sideIds = new Set(
        closePairs.flatMap((issue) =>
          issue.roads.filter(
            (id) => result.edges.find((edge) => edge.id === id)?.road_class === 'street'
          )
        )
      ),
      incident = new Map(result.nodes.map((node) => [node.id, []]))
    for (const edge of result.edges) {
      incident.get(edge.from_node)?.push(edge)
      incident.get(edge.to_node)?.push(edge)
    }
    let repaired = false
    for (const hub of result.nodes) {
      const attached = incident.get(hub.id),
        sides = attached?.filter((edge) => sideIds.has(edge.id)),
        access = attached?.filter((edge) => edge.road_class === 'access')
      if (
        hub.kind !== 'junction' ||
        attached.length !== 3 ||
        sides.length !== 2 ||
        access.length !== 1
      )
        continue
      const door = access[0].from_node === hub.id ? access[0].to_node : access[0].from_node,
        place = plan.places.find((item) => `arrival_${item.id}` === door)
      if (!place || place.outdoor || !place.door || !door.startsWith('arrival_')) continue
      let best = null
      for (const main of result.edges.filter(
        (edge) => street(edge) && edge.road_class === 'main'
      )) {
        if (sides.includes(main)) continue
        for (let k = 1; k < main.polyline.length; k++) {
          const hit = project([hub.x, hub.y], main.polyline[k - 1], main.polyline[k])
          if (!best || hit.distance < best.hit.distance) best = { main, k, hit }
        }
      }
      if (!best || best.hit.distance > 400 || best.hit.distance < 80) continue
      const mainPoint = quantize(best.hit.point),
        arrival = result.nodes.find((node) => node.id === door),
        line = [place.door, mainPoint]
      if (!arrival || !clearRoute(plan, ...line, access[0].width, [place.id])) continue
      if (
        result.edges.some((edge) => {
          if (edge === best.main || edge === access[0] || sides.includes(edge)) return false
          for (let k = 1; k < edge.polyline.length; k++) {
            const hit = intersection(...line, edge.polyline[k - 1], edge.polyline[k])
            if (hit && hit.t > 0.01 && hit.t < 0.99 && hit.u > 0.01 && hit.u < 0.99) return true
          }
          return false
        })
      )
        continue
      const first = best.main.polyline[0],
        last = best.main.polyline.at(-1),
        existing =
          dist(first, mainPoint) <= 2
            ? best.main.from_node
            : dist(last, mainPoint) <= 2
              ? best.main.to_node
              : null,
        joinId = existing ?? `merge_${hub.id}`,
        join = existing
          ? result.nodes.find((node) => node.id === existing)
          : {
              id: joinId,
              x: mainPoint[0],
              y: mainPoint[1],
              kind: 'junction',
              locale: 'roads',
              space: 'town_outdoor',
            },
        mainEdges = existing
          ? [best.main]
          : [
              {
                ...best.main,
                id: `${best.main.id}_merge_a`,
                to_node: joinId,
                to_locale: 'roads',
                polyline: [...best.main.polyline.slice(0, best.k), mainPoint],
              },
              {
                ...best.main,
                id: `${best.main.id}_merge_b`,
                from_node: joinId,
                from_locale: 'roads',
                polyline: [mainPoint, ...best.main.polyline.slice(best.k)],
              },
            ],
        newAccess = {
          ...access[0],
          from_node: access[0].from_node === hub.id ? joinId : door,
          to_node: access[0].to_node === hub.id ? joinId : door,
          from_locale: access[0].from_node === hub.id ? 'roads' : place.id,
          to_locale: access[0].to_node === hub.id ? 'roads' : place.id,
          polyline: access[0].from_node === hub.id ? [...line].reverse() : line,
        },
        candidate = {
          nodes: [
            ...result.nodes.filter((node) => node.id !== hub.id),
            ...(existing ? [] : [join]),
          ],
          edges: [
            ...result.edges.filter(
              (edge) => !sides.includes(edge) && edge !== access[0] && edge !== best.main
            ),
            ...mainEdges,
            newAccess,
          ],
        }
      const reachable = new Set([door]),
        queue = [door]
      for (let k = 0; k < queue.length; k++)
        for (const edge of candidate.edges) {
          const next =
            edge.from_node === queue[k]
              ? edge.to_node
              : edge.to_node === queue[k]
                ? edge.from_node
                : null
          if (next && !reachable.has(next)) {
            reachable.add(next)
            queue.push(next)
          }
        }
      if (candidate.nodes.some((node) => node.kind === 'place_arrival' && !reachable.has(node.id)))
        continue
      result = candidate
      repaired = true
      break
    }
    if (!repaired) break
  }
  return result
}

// A door may sit on the tip of a narrow triangular street loop. Keep the
// shorter approach as its footpath and the through road between the other two
// junctions; the longer side of that triangle serves no additional place.
export function simplifyServicedTriangles(graph) {
  const incident = new Map(graph.nodes.map((node) => [node.id, []])),
    nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  for (const edge of graph.edges)
    for (const id of [edge.from_node, edge.to_node]) incident.get(id).push(edge)
  const dropped = new Set(),
    narrowed = new Set()
  const privateArrival = (start, first) => {
    let here = start,
      current = first
    for (let step = 0; step < 3; step++) {
      const next = current.from_node === here ? current.to_node : current.from_node,
        node = nodes.get(next)
      if (node?.kind === 'place_arrival') return true
      const edges = incident.get(next)
      if (
        node?.kind !== 'junction' ||
        edges.length !== 2 ||
        edges.some((edge) => edge.road_class !== 'access')
      )
        return false
      here = next
      current = edges.find((edge) => edge !== current)
    }
    return false
  }
  for (const node of graph.nodes) {
    const branches = incident.get(node.id)
    if (node.kind !== 'junction' || branches.length !== 3) continue
    const access = branches.filter((edge) => edge.road_class === 'access'),
      streets = branches.filter(street)
    if (
      access.length !== 1 ||
      streets.length !== 2 ||
      dropped.has(streets[0]) ||
      dropped.has(streets[1])
    )
      continue
    if (!privateArrival(node.id, access[0])) continue
    const [short, long] = [...streets].sort((a, b) => length(a.polyline) - length(b.polyline)),
      a = short.from_node === node.id ? short.to_node : short.from_node,
      b = long.from_node === node.id ? long.to_node : long.from_node,
      direct = incident
        .get(a)
        .find(
          (edge) =>
            street(edge) &&
            ((edge.from_node === a && edge.to_node === b) ||
              (edge.from_node === b && edge.to_node === a))
        )
    if (!direct) continue
    const shortLength = length(short.polyline),
      longLength = length(long.polyline),
      directLength = length(direct.polyline)
    if (
      shortLength > 480 ||
      longLength < shortLength * 2 ||
      shortLength + longLength + directLength > 3600 ||
      shortLength + directLength > longLength * 1.5
    )
      continue
    dropped.add(long)
    narrowed.add(short)
  }
  return {
    ...graph,
    edges: graph.edges
      .filter((edge) => !dropped.has(edge))
      .map((edge) =>
        narrowed.has(edge)
          ? { ...edge, width: Math.min(edge.width, 72), road_class: 'access' }
          : edge
      ),
  }
}

// Two narrow sides can make a lens alongside a two-segment main road. If the
// narrow tip has no service connection, the main road already carries that
// journey and the extra sides only draw an unused loop.
export function removeUnusedParallelLenses(graph) {
  const incident = new Map(graph.nodes.map((node) => [node.id, []])),
    removedNodes = new Set(),
    removedEdges = new Set()
  for (const edge of graph.edges)
    for (const id of [edge.from_node, edge.to_node]) incident.get(id).push(edge)
  for (const node of graph.nodes) {
    const sides = incident.get(node.id)
    if (node.kind !== 'junction' || sides.length !== 2 || sides.some((edge) => !street(edge)))
      continue
    const [left, right] = sides,
      a = left.from_node === node.id ? left.to_node : left.from_node,
      b = right.from_node === node.id ? right.to_node : right.from_node,
      narrowLength = length(left.polyline) + length(right.polyline),
      minimumWidth = Math.max(left.width, right.width) + 10
    if (a === b || narrowLength > 2250 || removedEdges.has(left) || removedEdges.has(right))
      continue
    const wider = incident.get(a).filter((edge) => street(edge) && edge.width >= minimumWidth)
    const alternative = wider.some((first) => {
      const middle = first.from_node === a ? first.to_node : first.from_node
      return incident
        .get(middle)
        .some(
          (second) =>
            second !== first &&
            street(second) &&
            second.width >= minimumWidth &&
            ((second.from_node === middle && second.to_node === b) ||
              (second.to_node === middle && second.from_node === b)) &&
            narrowLength + length(first.polyline) + length(second.polyline) <= 4500 &&
            length(first.polyline) + length(second.polyline) <= narrowLength * 1.15
        )
    })
    if (!alternative) continue
    removedNodes.add(node.id)
    removedEdges.add(left)
    removedEdges.add(right)
  }
  return {
    nodes: graph.nodes.filter((node) => !removedNodes.has(node.id)),
    edges: graph.edges.filter((edge) => !removedEdges.has(edge)),
  }
}

function maximumSeparation(a, b) {
  let maximum = 0
  for (const point of a.polyline) {
    let nearest = Infinity
    for (let i = 1; i < b.polyline.length; i++)
      nearest = Math.min(nearest, project(point, b.polyline[i - 1], b.polyline[i]).distance)
    maximum = Math.max(maximum, nearest)
  }
  return maximum
}

// Joining consecutive source segments can reveal two near-identical ways
// between the same pair of junctions. Keep one physical road surface.
export function dedupeCloseStreetPairs(graph) {
  const byPair = new Map(),
    dropped = new Set()
  for (const edge of graph.edges) {
    if (!street(edge)) continue
    const pair = [edge.from_node, edge.to_node].sort().join('|')
    const previous = byPair.get(pair)
    if (!previous) {
      byPair.set(pair, edge)
      continue
    }
    const reach = Math.min(previous.width, edge.width) * 0.5
    if (maximumSeparation(previous, edge) > reach || maximumSeparation(edge, previous) > reach)
      continue
    const keep =
      edge.width > previous.width ||
      (edge.width === previous.width && length(edge.polyline) < length(previous.polyline))
        ? edge
        : previous
    dropped.add(keep === edge ? previous : edge)
    byPair.set(pair, keep)
  }
  return { ...graph, edges: graph.edges.filter((edge) => !dropped.has(edge)) }
}
