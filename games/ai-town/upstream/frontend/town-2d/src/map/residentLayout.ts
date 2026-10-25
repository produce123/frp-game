import type { ResidentEntry } from 'town-shared/gameMap'

/** 同一站点的显示偏移（米），只影响人物和气泡落点，不修改世界位置。 */
export function residentOffsets(entries: ResidentEntry[]): Map<string, [number, number]> {
  const groups = new Map<string, string[]>(),
    offsets = new Map<string, [number, number]>()
  for (const { locale, member } of entries) {
    if (member.at.kind !== 'station') continue
    const key = `${locale}/${member.at.station}`
    const group = groups.get(key) ?? []
    group.push(member.id)
    groups.set(key, group)
  }
  for (const ids of groups.values()) {
    if (ids.length < 2) continue
    ids.sort()
    const radius = Math.max(1.3, ids.length * 0.38)
    ids.forEach((id, i) => {
      const angle = (i * 2 * Math.PI) / ids.length
      offsets.set(id, [Math.cos(angle) * radius, Math.sin(angle) * radius])
    })
  }
  return offsets
}
