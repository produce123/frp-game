import path from 'node:path'
import { readJson, atomicJson } from './storage.mjs'
const MAX_INSTANCES = 4096
const MAX_ID_LENGTH = 150
const ROOM_GRID = 12 // 房间内候选位置按 12×12 网格取
/**
 * 一个道具在二维图上的位置。
 * @typedef {{ id: string, space: string, x: number, y: number }} Position
 */
// Positions live beside the world, never in the immutable generated map or browser storage.
/** @returns {Promise<Position[]>} */
export async function positions(storage, id, document, instances) {
  if (!Array.isArray(instances) || instances.length > MAX_INSTANCES) throw Error('道具列表超过限制')
  const file = path.join(storage.town(id), 'prop-layout.json')
  let saved = {}
  try {
    saved = await readJson(file)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const fixed = new Map(
    document.layout.props.map((p) => [p.id, { id: p.id, space: p.space, x: p.x, y: p.y }])
  )
  const rooms = new Map(document.layout.spaces.map((s) => [s.id, s])),
    regions = new Map(document.layout.regions.map((r) => [r.id, r]))
  let changed = false
  for (const p of instances) {
    if (typeof p.id !== 'string' || p.id.length > MAX_ID_LENGTH || typeof p.locale !== 'string')
      throw Error('道具编号无效')
    if (fixed.has(p.id) || saved[p.id]) continue
    const room = rooms.get(p.locale),
      region = regions.get(p.locale)
    if (!room && !region) throw Error('道具所在地点不存在')
    const space = room ? p.locale : 'town_outdoor',
      occupied = [...fixed.values(), ...Object.values(saved)].filter((m) => m.space === space)
    let candidates = []
    if (room) {
      const { x, y, width, height } = room.bounds
      for (let row = 0; row < ROOM_GRID; row++)
        for (let col = 0; col < ROOM_GRID; col++)
          candidates.push([
            x + (width * (col + 1)) / (ROOM_GRID + 1),
            y + (height * (row + 1)) / (ROOM_GRID + 1),
          ])
    } else
      candidates = region.cells.map(([x, y]) => [
        (x + 0.5) * region.cell_size,
        (y + 0.5) * region.cell_size,
      ])
    // 取离已有道具最远的候选位置。
    let best = candidates[0],
      bestDistance = -1
    for (const p of candidates) {
      const distance = Math.min(10000, ...occupied.map((q) => Math.hypot(p[0] - q.x, p[1] - q.y)))
      if (distance > bestDistance) {
        best = p
        bestDistance = distance
      }
    }
    if (!best) throw Error('没有可用道具位置')
    saved[p.id] = { id: p.id, space, x: best[0], y: best[1] }
    changed = true
  }
  if (changed) await atomicJson(file, saved)
  return instances.map((p) => fixed.get(p.id) ?? saved[p.id]).filter(Boolean)
}
