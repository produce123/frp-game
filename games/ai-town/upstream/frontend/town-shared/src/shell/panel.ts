// 外壳与各面板之间的统一接口：面板先登记，外壳再按登记顺序把消息和事件逐个交给它们。
import type { ResidentEntry } from '../gameMap'
import type { ServerMsg } from '../protocol'

export type RosterMsg = Extract<ServerMsg, { type: 'roster' }>

/** 一拍名册：entries 含化身，residents 只含居民 */
export interface RosterFrame {
  msg: RosterMsg
  entries: ResidentEntry[]
  residents: ResidentEntry[]
}

export function rosterFrame(msg: RosterMsg): RosterFrame {
  const entries = msg.locales.flatMap((l) =>
    l.members.map((member) => ({ locale: l.locale, member }))
  )
  return { msg, entries, residents: entries.filter((e) => e.member.kind !== 'avatar') }
}

/**
 * 登记到外壳的面板。handleMsg 按登记顺序收到服务端消息，返回 true 表示已经处理完，
 * 不再交给后面的面板；其余方法在名册到达、连接变化、世界重置和卸载时按登记顺序调用。
 */
export interface ShellPanel {
  handleMsg?(message: ServerMsg): boolean | void
  roster?(frame: RosterFrame): void
  connected?(): void
  disconnected?(): void
  onReset?(): void
  dispose?(): void
}

export function createPanelRegistry() {
  const panels: ShellPanel[] = []
  return {
    add(...list: (ShellPanel | null)[]) {
      for (const panel of list) if (panel) panels.push(panel)
    },
    /** 排到最前面：开局向导要先看到它自己请求的回复 */
    first(panel: ShellPanel) {
      panels.unshift(panel)
    },
    dispatch(message: ServerMsg) {
      for (const panel of panels) if (panel.handleMsg?.(message)) return
    },
    roster(frame: RosterFrame) {
      for (const panel of panels) panel.roster?.(frame)
    },
    connected() {
      for (const panel of panels) panel.connected?.()
    },
    disconnected() {
      for (const panel of panels) panel.disconnected?.()
    },
    reset() {
      for (const panel of panels) panel.onReset?.()
    },
    dispose() {
      for (const panel of panels) panel.dispose?.()
    },
  }
}
