// Shape the entire street skeleton in one continuous field. Shared junctions
// and through-street tangents are solved before sampling individual surfaces.
const unit = (v) => {
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
}
const smooth = (t) => {
  t = Math.max(0, Math.min(1, t))
  return t * t * (3 - 2 * t)
}
export function shapeStreetGraph(nodes, edges, span, style, seed = 0) {
  if (style === 'straight')
    return { nodes, edges: edges.map((e) => ({ ...e, points: e.authoredPoints })) }
  const pinned = edges.filter((e) => e.bridge).flatMap((e) => [nodes[e.a].p, nodes[e.b].p])
  const organic = style === 'organic',
    continuous = style === 'continuous'
  const amplitude = organic
      ? Math.min(11, span * 0.06)
      : continuous
        ? 0
        : Math.min(style === 'winding' ? 8 : 3, span * 0.025),
    wavelength = organic ? Math.max(28, span * 0.17) : Math.max(45, span * 0.25),
    phase = (((seed >>> 0) % 997) / 997) * Math.PI * 2
  const warp = (p) => {
    const pinDistance = pinned.length
      ? Math.min(...pinned.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))
      : Infinity
    const weight = smooth(pinDistance / 28)
    if (organic)
      return [
        p[0] +
          amplitude *
            weight *
            (0.8 * Math.sin(p[1] / wavelength + phase) +
              0.2 * Math.sin((p[0] + p[1]) / (wavelength * 1.7) + 0.7)),
        p[1] +
          amplitude *
            weight *
            (0.8 * Math.sin(p[0] / wavelength + phase + 1.4) +
              0.2 * Math.sin((p[1] - p[0]) / (wavelength * 1.7) - 0.5)),
      ]
    return [
      p[0] + amplitude * weight * Math.sin(p[1] / wavelength + 0.7),
      p[1] + amplitude * weight * Math.sin(p[0] / wavelength - 0.5),
    ]
  }
  const directions = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges) {
    const ps = e.authoredPoints
    directions.get(e.a).push({ edge: e, v: unit([ps[1][0] - ps[0][0], ps[1][1] - ps[0][1]]) })
    directions
      .get(e.b)
      .push({ edge: e, v: unit([ps.at(-2)[0] - ps.at(-1)[0], ps.at(-2)[1] - ps.at(-1)[1]]) })
  }
  const tangent = (id, edge) => {
    const list = directions.get(id),
      own = list.find((d) => d.edge === edge).v
    let partner = null,
      best = -0.35
    for (const d of list) {
      if (d.edge === edge) continue
      const dot = own[0] * d.v[0] + own[1] * d.v[1]
      if (dot < best) {
        best = dot
        partner = d.v
      }
    }
    return partner ? unit([own[0] - partner[0], own[1] - partner[1]]) : own
  }
  const shapedEdges = edges.map((e) => {
    if (e.bridge) return { ...e, points: e.authoredPoints, authoredPoints: e.authoredPoints }
    const controls = e.authoredPoints,
      dense = []
    for (let i = 1; i < controls.length; i++) {
      const p = controls[i - 1],
        q = controls[i],
        len = Math.hypot(q[0] - p[0], q[1] - p[1])
      const t0 =
        i === 1 ? tangent(e.a, e) : unit([q[0] - controls[i - 2][0], q[1] - controls[i - 2][1]])
      const t1 =
        i === controls.length - 1
          ? tangent(e.b, e)
          : unit([p[0] - controls[i + 1][0], p[1] - controls[i + 1][1]])
      const handle = Math.min(len * 0.32, 30)
      const c = p.map((v, k) => v + t0[k] * handle),
        d = q.map((v, k) => v + t1[k] * handle)
      for (let j = 0; j < 12; j++) {
        const t = j / 12,
          u = 1 - t
        dense.push(
          warp(
            p.map(
              (v, k) =>
                u * u * u * v + 3 * u * u * t * c[k] + 3 * u * t * t * d[k] + t * t * t * q[k]
            )
          )
        )
      }
    }
    dense.push(warp(controls.at(-1)))
    const points = Array.from(
      { length: Math.min(20, dense.length) },
      (_, i) => dense[Math.round((i * (dense.length - 1)) / (Math.min(20, dense.length) - 1))]
    )
    return { ...e, points, authoredPoints: controls.map(warp) }
  })
  return { nodes: nodes.map((n) => ({ ...n, p: warp(n.p) })), edges: shapedEdges }
}
