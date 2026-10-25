// 底部抽屉：手机布局里村民卡贴底，分露头、半屏、全屏三档。拖把手或头部换档，往下拖到底收起；
// 在头部左右滑动换人。只在手机布局下生效，宽屏时清掉内联高度，交回原来的样式。
import { isCompact } from '../platform'

export type Snap = 'peek' | 'half' | 'full'
const SNAPS: Snap[] = ['peek', 'half', 'full']

interface SheetOptions {
  panel: HTMLElement
  /** 拖它（和把手）换档；里面的按钮、下拉框照常点 */
  head: HTMLElement
  /** 露头档的高度：头部加上紧跟的一小段 */
  peekHeight: () => number
  /** 抽屉能占的最大高度（地图区高度） */
  maxHeight: () => number
  /** 拖到露头以下松手：收起 */
  onClose: () => void
  /** 在头部左右滑动：1 下一位，-1 上一位 */
  onSwipe?: (step: 1 | -1) => void
  /** 档位变了（地图据此把选中的人挪到抽屉上方） */
  onSnap?: (snap: Snap, height: number) => void
}

export function bottomSheet(o: SheetOptions) {
  const handle = document.createElement('div')
  handle.className = 'm-sheet-handle'
  handle.setAttribute('aria-hidden', 'true')
  o.panel.prepend(handle)
  let snap: Snap = 'peek'

  const heightOf = (s: Snap) => {
    const max = o.maxHeight()
    if (s === 'peek') return Math.min(max, o.peekHeight())
    if (s === 'half') return Math.min(max, Math.max(o.peekHeight() + 80, Math.round(max * 0.56)))
    return max
  }
  function apply(next: Snap, notify = true) {
    snap = next
    if (!isCompact()) {
      o.panel.style.removeProperty('height')
      return
    }
    const h = heightOf(next)
    o.panel.style.height = `${h}px`
    o.panel.dataset.snap = next
    if (notify) o.onSnap?.(next, h)
  }

  // 拖动：记下起点与起始高度，松手按速度和最近的档位定
  let drag: { id: number; x: number; y: number; h: number; t: number; axis?: 'x' | 'y' } | null =
    null
  const start = (e: PointerEvent) => {
    if (!isCompact() || e.button > 0) return
    if (e.target instanceof Element && e.target.closest('button, select, input, a, summary')) return
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, h: o.panel.offsetHeight, t: e.timeStamp }
    // 一按下就捕获：手指很快离开把手时，后续移动仍然交到这里
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y
    if (!drag.axis) {
      if (Math.hypot(dx, dy) < 8) return
      drag.axis = Math.abs(dx) > Math.abs(dy) * 1.4 && o.onSwipe ? 'x' : 'y'
      o.panel.classList.add('dragging')
    }
    if (drag.axis === 'y') {
      const h = Math.max(48, Math.min(o.maxHeight(), drag.h - dy))
      o.panel.style.height = `${h}px`
    }
  }
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return
    const d = drag
    drag = null
    o.panel.classList.remove('dragging')
    if (!d.axis) return
    const dx = e.clientX - d.x,
      dy = e.clientY - d.y
    if (d.axis === 'x') {
      if (Math.abs(dx) > 56) o.onSwipe?.(dx < 0 ? 1 : -1)
      return
    }
    const h = o.panel.offsetHeight
    const speed = dy / Math.max(1, e.timeStamp - d.t)
    const i = SNAPS.indexOf(snap)
    if (h < heightOf('peek') * 0.6 || (speed > 0.6 && i === 0)) return o.onClose()
    let next: Snap
    if (speed > 0.6) next = SNAPS[i - 1]
    else if (speed < -0.6) next = SNAPS[Math.min(SNAPS.length - 1, i + 1)]
    else
      next = SNAPS.reduce((best, s) =>
        Math.abs(heightOf(s) - h) < Math.abs(heightOf(best) - h) ? s : best
      )
    apply(next)
  }
  for (const target of [handle, o.head]) {
    target.addEventListener('pointerdown', start)
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', () => {
      drag = null
      o.panel.classList.remove('dragging')
    })
  }

  return {
    snap: () => snap,
    /** 刚打开：回到露头档，从头看起 */
    open(next: Snap = 'peek') {
      o.panel.scrollTop = 0
      apply(next)
    },
    set: apply,
    /** 窗口或布局变化：按当前档位重算高度 */
    refresh() {
      apply(snap, false)
    },
  }
}
