import type { RosterMember } from '../protocol'
import { el, button } from '../props/dom'
import './inventory.css'
import { gameIcon } from '../game/icons'
export function createInventoryView(
  root: HTMLDetailsElement,
  open: (id: string) => void,
  /** 游戏界面画成物品格 */
  game: boolean
) {
  const summary = el('summary', '随身物品'),
    body = el('div')
  root.append(summary, body)
  let previous = ''
  return {
    clear() {
      previous = ''
      summary.textContent = '随身物品'
      body.replaceChildren()
      root.open = false
    },
    render(value: RosterMember['inventory']) {
      const key = JSON.stringify(value)
      if (key === previous) return
      previous = key
      summary.textContent = value
        ? `随身物品 · ${value.used} / ${value.capacity} 格`
        : '随身物品 · 等待数据'
      body.replaceChildren()
      if (!value) return
      if (game) {
        body.className = 'resident-item-grid'
        for (const slot of value.slots) {
          const row = button('', () => open(slot.items[0]), 'resident-item-slot')
          const icon = /书/.test(slot.name)
            ? 'book'
            : /水|饮/.test(slot.name)
              ? 'water'
              : /包|饭|食|果/.test(slot.name)
                ? 'food'
                : 'bag'
          row.append(gameIcon(icon), el('span', slot.name), el('small', String(slot.quantity)))
          row.title = `${slot.name} ×${slot.quantity} · 查看用途`
          body.append(row)
        }
        for (let i = value.slots.length; i < Math.min(value.capacity, 48); i++) {
          const empty = el('span', '', 'resident-item-slot empty')
          empty.setAttribute('aria-label', '空物品格')
          body.append(empty)
        }
        return
      }
      if (!value.slots.length) {
        body.append(el('p', '背包是空的。', 'prop-muted'))
        return
      }
      for (const slot of value.slots) {
        const row = button('', () => open(slot.items[0]), 'inventory-item')
        row.append(
          el('strong', `${slot.name} ×${slot.quantity}`),
          el('span', slot.actions.map((a) => a.label).join('、') || '可携带、赠予或放下')
        )
        row.title = '查看物品用途与说明'
        body.append(row)
      }
    },
  }
}
