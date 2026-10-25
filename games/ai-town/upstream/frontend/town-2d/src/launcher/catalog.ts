import type { MapEntry } from 'town-shared/mapDocument'
import { api } from './api'
export type { MapEntry }
export async function listMaps(): Promise<MapEntry[]> {
  return (await api<{ towns: MapEntry[] }>('')).towns
}
/** 打开（或启动）小镇运行服务，返回带连接地址的条目；调用方自己保管它。 */
export async function openMap(id: string): Promise<MapEntry> {
  const entry = await api<MapEntry>(`/${encodeURIComponent(id)}/open`, {})
  if (entry.id !== id || !entry.mapHash || !entry.endpoint) throw new Error('小镇身份不一致')
  return entry
}
export function gameUrl(map: MapEntry) {
  return `./game.html?map=${encodeURIComponent(map.id)}`
}
