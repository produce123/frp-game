// 点地图上的道具弹出的对象卡片：挂在地图容器里、停靠右上角，地图保持可见；要翻全部物品再进整页。
import { button, el } from './dom'

export function createPropCard(onClose: () => void) {
  const root = el('aside', '', 'prop-card ui-float')
  root.hidden = true
  root.setAttribute('aria-label', '物品详情')
  const content = el('div', '', 'prop-card-body')
  const close = button('✕', onClose, 'ui-close prop-card-close')
  close.setAttribute('aria-label', '关闭')
  root.append(close, content)
  // 卡片在地图容器里：按下、双击和滚轮不能漏给地图，否则会被当成拖拽、放大和缩放
  for (const type of ['pointerdown', 'dblclick', 'wheel'] as const)
    root.addEventListener(type, (e) => e.stopPropagation())
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }
  return {
    root,
    content,
    isOpen: () => !root.hidden,
    open() {
      root.hidden = false
      document.addEventListener('keydown', onKey)
    },
    close() {
      root.hidden = true
      document.removeEventListener('keydown', onKey)
    },
  }
}
