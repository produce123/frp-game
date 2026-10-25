// 界面语言的 DOM 助手：样式在 components.css，这里只负责把状态、标签、物品图、数值条拼出来。
import { gameIcon } from '../game/icons'
import { el } from '../dom'

export type Tone = 'ok' | 'busy' | 'accent' | 'danger' | 'info'

/** 状态：小圆点加文字。ok 绿、busy 橙、danger 红，不给就是灰（不可用 / 未知） */
export function status(text: string, tone?: 'ok' | 'busy' | 'danger') {
  return el('span', text, tone ? `ui-status ${tone}` : 'ui-status')
}

/** 灰底小标签；icon 是 gameIcon 的名字 */
export function chip(text: string, tone?: Tone, options: { icon?: string } = {}) {
  const c = el('span', '', tone ? `ui-chip ${tone}` : 'ui-chip')
  if (options.icon) c.append(gameIcon(options.icon))
  c.append(document.createTextNode(text))
  return c
}

/** 小节标题 */
export function caption(text: string) {
  return el('h3', text, 'ui-caption')
}

/** 数值条：fraction 取 0 到 1 */
export function meter(fraction: number) {
  const bar = el('div', '', 'ui-meter')
  bar.setAttribute('role', 'presentation')
  bar.style.setProperty('--v', String(Math.max(0, Math.min(1, fraction))))
  bar.append(el('span'))
  return bar
}

/** 入口上的数字提醒：返回的函数更新数字，0 时藏起来，多于 99 写 99+；读屏读「名字，N 条新内容」 */
export function countBadge(host: HTMLElement, label: string) {
  const badge = el('span', '', 'ui-count')
  badge.hidden = true
  host.append(badge)
  return (count: number) => {
    badge.hidden = count <= 0
    badge.textContent = count <= 0 ? '' : count > 99 ? '99+' : String(count)
    host.setAttribute('aria-label', count > 0 ? `${label}，${count} 条新内容` : label)
  }
}

/** 物品图：浅灰底方块里放像素图（或图标）。size：sm 56 / 默认 64 / lg 96 */
export function slot(content: HTMLElement, size: 'sm' | 'md' | 'lg' = 'md') {
  const s = el('span', '', size === 'md' ? 'ui-slot' : `ui-slot ${size}`)
  s.append(content)
  return s
}
