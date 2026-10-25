// 设定里内置模型的几行：版本和下载进度、有新版本时自动下载、占用空间（可以删掉）。
// 首页「设定」和小镇里「模型服务」那一行点开后都用这一份，状态见 builtin.ts。
import { button, el } from '../dom'
import { isCompact } from '../platform'
import { settingRow, switchControl } from '../settings/controls'
import {
  builtinStatus,
  builtinView,
  deleteBuiltin,
  megabytes,
  onBuiltin,
  setBuiltinAuto,
} from './builtin'

export interface BuiltinRowsOptions {
  /** 删除前写进提示里的村民：小镇里写名字，首页写「用内置模型的村民」 */
  users?: () => string[]
  /** 小镇里：新版是小镇开着时下好的，可以「现在换上」 */
  swap?: () => { restart: () => void; restarting: boolean } | null
}

export function createBuiltinRows(o: BuiltinRowsOptions = {}) {
  const root = el('div', '', 'set-rows builtin-rows')

  const status = el('div', '', 'set-row builtin-status')
  const dot = el('i', '', 'builtin-dot')
  const text = el('div', '', 'set-row-text')
  const label = el('span', '小镇村民', 'set-row-label')
  const free = el('span', '免费', 'ui-chip ok')
  const desc = el('span', '', 'set-row-desc')
  const meter = el('div', '', 'ui-meter builtin-meter')
  const fill = el('span')
  meter.append(fill)
  const extra = el('span', '', 'set-row-desc')
  text.append(label, desc, meter, extra)
  const action = button('', () => view?.action?.run())
  status.append(dot, text, action)

  const auto = switchControl('有新版本时自动下载', (on) => {
    auto.set(!on)
    void setBuiltinAuto(on)
  })
  const autoRow = settingRow(
    '有新版本时自动下载',
    isCompact() ? '只在连着 Wi-Fi 时下，不打断正在玩的小镇' : '在后台下，不打断正在玩的小镇',
    auto.el
  )

  let confirming = false
  const remove = button('删除', () => {
    confirming = true
    render()
  })
  remove.className = 'ui-btn danger'
  // 说明先占个位，大小在 render 里写
  const spaceRow = settingRow('占用空间', '…', remove)
  const spaceDesc = spaceRow.querySelector<HTMLElement>('.set-row-desc')
  const confirm = el('div', '', 'set-row builtin-confirm')
  const confirmText = el('div', '', 'set-row-text')
  const confirmDesc = el('span', '', 'set-row-desc')
  confirmText.append(el('span', '删除内置模型？', 'set-row-label'), confirmDesc)
  const yes = button(
    '删除',
    () => {
      confirming = false
      void deleteBuiltin()
    },
    'builtin-delete'
  )
  confirm.append(
    confirmText,
    button('取消', () => {
      confirming = false
      render()
    }),
    yes
  )

  let view: ReturnType<typeof builtinView> = null

  function render() {
    const s = builtinStatus()
    view = builtinView(o.swap?.() ?? undefined)
    root.hidden = !view
    if (!s || !view) return
    dot.className = `builtin-dot ${view.dot}`
    if (s.installed) free.remove()
    else label.append(free)
    desc.textContent = view.desc
    desc.className = `set-row-desc${view.tone ? ' ' + view.tone : ''}`
    meter.hidden = view.meter === undefined
    fill.style.setProperty('--v', String(view.meter ?? 0))
    extra.textContent = view.extra ?? ''
    extra.hidden = !view.extra
    action.hidden = !view.action
    action.textContent = view.action?.label ?? ''
    action.disabled = !!view.action?.disabled
    const rows: HTMLElement[] = [status]
    if (s.installed) {
      auto.set(s.auto)
      const users = o.users?.() ?? []
      confirmDesc.textContent = `${users.length ? users.join('、') : '用内置模型的村民'}会停下，直到重新下载。`
      if (spaceDesc)
        spaceDesc.textContent =
          megabytes(s.installed.size) + (s.download ? ' · 换上新版之前会临时多占一份' : '')
      // 正在下载、换新版时不能删
      remove.disabled = !!s.download || !!o.swap?.()
      rows.push(autoRow, confirming ? confirm : spaceRow)
    } else confirming = false
    root.replaceChildren(...rows)
  }

  const off = onBuiltin(render)
  render()
  return { el: root, render, dispose: off }
}
