/*
 * 平台账号桥（AI 小镇侧）。
 *
 * 平台在入口页注入 `window.__FRP_ME__`（公开资料：id / name / avatar）。
 * 桌面壳、上游自己的 `pnpm dev` 里没有这个对象 —— 那时返回 null，页面照旧可用。
 *
 * 这里只做两件平台相关的事：
 *   · 读账号（给"进镇对话框"预填昵称+头像）；
 *   · `?room=` 深链进好友的小镇（先向平台登记成员，再让上游 open）。
 */

export type FrpMe = { id: string; name: string; avatar?: string }

export function frpMe(): FrpMe | null {
  try {
    const me = (window as unknown as { __FRP_ME__?: FrpMe }).__FRP_ME__
    if (!me || !me.id) return null
    return me
  } catch {
    return null
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok || !data?.ok) throw new Error(data?.message || `平台返回 ${response.status}`)
  return data as T
}

export type JoinedRoom = { ok: true; room: string; town: string; joinable: boolean; count: number }

/** 平台房间号 → 上游小镇 id。接受邀请/深链进镇时先走这一下。 */
export function joinRoom(room: string): Promise<JoinedRoom> {
  return post<JoinedRoom>('./api/platform/join', { room })
}

/** 页面心跳：告诉好友"我正在玩这个镇"，同时拿回房间号。 */
export function reportPlaying(room: string, joinable = true): Promise<{ ok: true; room: string; count: number }> {
  return post('./api/platform/state', { room, joinable })
}