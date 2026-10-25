import { GenerationError } from './budget.mjs'
import { dist } from './geometry.mjs'

export const targets = (places, ref) => places.filter((p) => p.ref === ref || p.kind === ref)
export function center(places, ref) {
  const ps = targets(places, ref)
  return [ps.reduce((s, p) => s + p.x, 0) / ps.length, ps.reduce((s, p) => s + p.y, 0) / ps.length]
}
const axes = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
export function measureConstraints(spec, places, L) {
  return spec.constraints.map((c, index) => {
    const a = center(places, c.subject),
      b = center(places, c.relative_to)
    const expected = (c.kind === 'near' ? 2 : 0.5) * L
    const measured =
      c.kind === 'near'
        ? dist(a, b)
        : (a[0] - b[0]) * axes[c.value][0] + (a[1] - b[1]) * axes[c.value][1]
    const violation = Math.max(0, c.kind === 'near' ? measured - expected : expected - measured)
    return {
      ...c,
      constraint_index: index,
      expected,
      measured: Math.round(measured * 100) / 100,
      unit: 'world_units',
      penalty: violation / L,
      satisfied: violation <= 1,
    }
  })
}
export function checkConflicts(spec, places, L) {
  const constraints = spec.constraints.filter((c) => c.required)
  for (const c of constraints) {
    const a = targets(places, c.subject),
      b = targets(places, c.relative_to)
    if (a.length === b.length && a.every((p) => b.includes(p)))
      throw new GenerationError('CONSTRAINT_CONFLICT', '无法对同一组地点指定相对关系', {
        stage: 'constraints',
        place_refs: [c.subject, c.relative_to],
      })
  }
  for (let axis = 0; axis < 2; axis++) {
    const edges = []
    for (const c of constraints.filter((c) => c.kind === 'direction' && axes[c.value][axis])) {
      const a = targets(places, c.subject),
        b = targets(places, c.relative_to)
      if (a.length !== 1 || b.length !== 1) continue
      edges.push(axes[c.value][axis] > 0 ? [b[0].id, a[0].id] : [a[0].id, b[0].id])
    }
    const values = new Map(places.map((p) => [p.id, 0]))
    for (let i = 0; i < places.length; i++) {
      let changed = false
      for (const [a, b] of edges)
        if (values.get(b) < values.get(a) + L * 0.5) {
          values.set(b, values.get(a) + L * 0.5)
          changed = true
        }
      if (!changed) break
      if (i === places.length - 1)
        throw new GenerationError('CONSTRAINT_CONFLICT', '无法同时满足循环矛盾的必须方位要求', {
          stage: 'constraints',
          place_refs: edges.flat(),
        })
    }
  }
}
// Shared instances use combined coefficients, including partially overlapping group references.
export function projectConstraints(plan, strength = 1, includePreferences = false) {
  for (const c of plan.spec.constraints.filter((c) => c.required || includePreferences)) {
    const a = targets(plan.places, c.subject),
      b = targets(plan.places, c.relative_to)
    const ca = center(plan.places, c.subject),
      cb = center(plan.places, c.relative_to)
    let direction, error
    if (c.kind === 'near') {
      const d = dist(ca, cb)
      error = d - plan.L * 1.96
      direction = d ? [(cb[0] - ca[0]) / d, (cb[1] - ca[1]) / d] : [1, 0]
    } else {
      direction = axes[c.value]
      error = plan.L * 0.54 - ((ca[0] - cb[0]) * direction[0] + (ca[1] - cb[1]) * direction[1])
    }
    if (error <= 0) continue
    const coefficients = new Map()
    for (const p of a) coefficients.set(p, (coefficients.get(p) || 0) + 1 / a.length)
    for (const p of b) coefficients.set(p, (coefficients.get(p) || 0) - 1 / b.length)
    const norm = [...coefficients.values()].reduce((s, k) => s + k * k, 0)
    if (!norm) continue
    for (const [p, k] of coefficients) {
      const shift =
        Math.max(-0.2 * plan.L, Math.min(0.2 * plan.L, (error * k) / norm)) *
        strength *
        (c.required ? 1 : 0.2)
      p.x += shift * direction[0]
      p.y += shift * direction[1]
    }
  }
}
