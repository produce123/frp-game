// 游戏页用到的小镇接口：世界进程没了时重新打开（换新地址接着连），离开时保存并关闭。
import type { MapEntry } from './mapDocument'

/** 自动重开时发现这个小镇是被另一个页面进的小镇挤掉的：不抢回来，由玩家决定回不回来 */
export class TownDisplaced extends Error {}

// 相对路径：游戏页在 /ai-town/ 下 → /ai-town/api/towns；上游 dev（站点根）→ /api/towns。
const API_BASE = 'api/towns'

async function post<T>(id: string, action: string, body: unknown, keepalive = false): Promise<T> {
  const response = await fetch(`${API_BASE}/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Town-Client': '1' },
    body: JSON.stringify(body),
    keepalive,
  })
  const data = await response.json().catch(() => null)
  if (response.ok) return data as T
  const message = data?.error ?? `小镇服务返回 ${response.status}`
  throw response.status === 409 && action === 'open' ? new TownDisplaced(message) : Error(message)
}

/** 重新打开小镇：世界进程不在了，管理服务就从存档把它拉起来。返回新的连接地址和打开凭证。
 *  automatic 是断线后自动重开：被另一个页面进的小镇挤掉时不抢回来，抛 TownDisplaced */
export function reopenTown(id: string, automatic = true) {
  return post<MapEntry>(id, 'open', { automatic })
}

/**
 * 保存并关闭小镇（管理服务的 close 接口）。同时只运行一个小镇，退出就关；
 * keepalive 让关掉网页时发出的这一下也能送到。lease 是打开时拿到的凭证：刷新时旧页面的关闭
 * 可能比新页面的打开晚到，带着凭证，管理服务就知道这一下已经过时，不会关掉新页面刚打开的小镇。
 */
export async function closeTown(id: string, lease?: string, keepalive = false): Promise<void> {
  await post(id, 'close', { lease }, keepalive)
}
