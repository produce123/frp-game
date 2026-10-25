// 统一下拉框：页面里照常写原生 <select>（取值、change 事件、表单校验都不变），点开时不弹系统列表，
// 换成游戏样式的列表——宽屏是贴着下拉框的浮层，手机竖屏是从底部升起的列表。拦截装在 document 上，
// 各界面不用各自改造；样式在 components.css 的「下拉框」一节。
import { el } from '../dom'
import { gameIcon } from '../game/icons'
import { isCompact, onBack } from '../platform'

/** 浮层和下拉框之间、和屏幕边缘之间留的空 */
const GAP = 6
const EDGE = 8
/** 浮层最高多少，再多就在里面滚动 */
const MENU_MAX = 380

interface Item {
  option: HTMLOptionElement
  element: HTMLElement
  disabled: boolean
}

interface Opened {
  select: HTMLSelectElement
  layer: HTMLElement
  list: HTMLElement
  items: Item[]
  active: number
  /** 用过键盘：收起后回到下拉框时才画焦点框，手指和鼠标点完不画 */
  keyboard: boolean
  release: () => void
}

let opened: Opened | null = null
let serial = 0

/** 接管的下拉框：单选、可用、只显示一行的 */
function dropdown(target: EventTarget | null) {
  return target instanceof HTMLSelectElement &&
    !target.multiple &&
    target.size <= 1 &&
    !target.disabled
    ? target
    : null
}

/** 下拉框叫什么：aria-label，或关联的 <label> 去掉控件以后的文字；手机列表的标题写「选择××」 */
function labelOf(select: HTMLSelectElement) {
  const aria = select.getAttribute('aria-label')
  if (aria) return aria.trim()
  const label = select.labels?.[0]
  if (!label) return ''
  const copy = label.cloneNode(true) as HTMLElement
  copy.querySelectorAll('select, input, textarea, button').forEach((node) => node.remove())
  return (copy.textContent ?? '').trim().replace(/[：:]$/, '')
}

/** 按 <option> / <optgroup> 排出列表；藏起来的项（「请选择」这类提示）不进列表 */
function fill(select: HTMLSelectElement, list: HTMLElement) {
  const items: Item[] = []
  const item = (option: HTMLOptionElement, disabled: boolean) => {
    const element = el('div', '', 'ui-select-option')
    element.id = `ui-select-${++serial}`
    element.setAttribute('role', 'option')
    element.setAttribute('aria-selected', String(option.selected))
    if (disabled) element.setAttribute('aria-disabled', 'true')
    element.append(el('span', option.label))
    if (option.selected) element.append(gameIcon('check', true))
    items.push({ option, element, disabled })
    return element
  }
  for (const child of select.children) {
    if (child instanceof HTMLOptionElement && !child.hidden)
      list.append(item(child, child.disabled))
    if (!(child instanceof HTMLOptGroupElement) || child.hidden) continue
    const options = [...child.children].filter(
      (o): o is HTMLOptionElement => o instanceof HTMLOptionElement && !o.hidden
    )
    if (!options.length) continue
    const group = el('div', '', 'ui-select-group')
    group.setAttribute('role', 'group')
    const head = el('div', child.label, 'ui-select-group-label')
    head.id = `ui-select-${++serial}`
    group.setAttribute('aria-labelledby', head.id)
    group.append(head, ...options.map((o) => item(o, o.disabled || child.disabled)))
    list.append(group)
  }
  return items
}

/** 浮层贴在下拉框下面；下面放不下而上面更宽敞就翻到上面，左右不出屏 */
function place(select: HTMLSelectElement, list: HTMLElement) {
  const r = select.getBoundingClientRect()
  const width = document.documentElement.clientWidth
  list.style.minWidth = `${Math.min(r.width, width - 2 * EDGE)}px`
  list.style.maxWidth = `${width - 2 * EDGE}px`
  list.style.maxHeight = ''
  const below = innerHeight - r.bottom - GAP - EDGE
  const above = r.top - GAP - EDGE
  const up = list.scrollHeight > below && above > below
  list.style.maxHeight = `${Math.max(0, Math.min(MENU_MAX, up ? above : below))}px`
  const box = list.getBoundingClientRect()
  list.style.top = `${up ? r.top - GAP - box.height : r.bottom + GAP}px`
  list.style.left = `${Math.max(EDGE, Math.min(r.left, width - EDGE - box.width))}px`
}

/** 从 from 往 dir 方向数 count 个能选的项；到头就停在最后一个能选的 */
function stepFrom(from: number, dir: 1 | -1, count: number) {
  const items = opened?.items ?? []
  let found = from
  for (let i = from + dir, left = count; left > 0 && i >= 0 && i < items.length; i += dir) {
    if (items[i].disabled) continue
    found = i
    left--
  }
  return found
}

function setActive(index: number, reveal = false) {
  const o = opened
  if (!o) return
  o.items[o.active]?.element.classList.remove('active')
  o.active = index
  const item = o.items[index]
  if (!item) return o.list.removeAttribute('aria-activedescendant')
  item.element.classList.add('active')
  o.list.setAttribute('aria-activedescendant', item.element.id)
  if (!reveal) return
  // 滚到能看见；分组的第一项连组名一起露出来
  const e = item.element
  const top = e.previousElementSibling?.classList.contains('ui-select-group-label')
    ? (e.parentElement?.offsetTop ?? e.offsetTop)
    : e.offsetTop
  if (top < o.list.scrollTop) o.list.scrollTop = top
  else if (e.offsetTop + e.offsetHeight > o.list.scrollTop + o.list.clientHeight)
    o.list.scrollTop = e.offsetTop + e.offsetHeight - o.list.clientHeight
}

function choose(index: number) {
  const o = opened
  const item = o?.items[index]
  if (!o || !item || item.disabled) return
  close()
  if (item.option.selected) return
  item.option.selected = true
  o.select.dispatchEvent(new Event('input', { bubbles: true }))
  o.select.dispatchEvent(new Event('change', { bubbles: true }))
}

function close() {
  const o = opened
  if (!o) return
  opened = null
  o.release()
  const hadFocus = o.layer.contains(document.activeElement)
  o.layer.remove()
  o.select.classList.remove('ui-select-open')
  // focusVisible 还不在 TypeScript 的 DOM 类型里，安卓 WebView 和 Chrome 都认
  if (hadFocus && o.select.isConnected)
    o.select.focus({ preventScroll: true, focusVisible: o.keyboard } as FocusOptions)
}

function onKey(e: KeyboardEvent) {
  const o = opened
  if (!o) return
  o.keyboard = true
  let next = -1
  switch (e.key) {
    case 'ArrowDown':
      next = stepFrom(o.active, 1, 1)
      break
    case 'ArrowUp':
      next = stepFrom(o.active, -1, 1)
      break
    case 'PageDown':
      next = stepFrom(o.active, 1, 8)
      break
    case 'PageUp':
      next = stepFrom(o.active, -1, 8)
      break
    case 'Home':
      next = stepFrom(-1, 1, 1)
      break
    case 'End':
      next = stepFrom(o.items.length, -1, 1)
      break
    case 'Enter':
    case ' ':
      choose(o.active)
      break
    // 在模态对话框里也只关列表，不连对话框一起关
    case 'Escape':
      close()
      break
    case 'Tab':
      close()
      return
    default:
      return
  }
  e.preventDefault()
  e.stopPropagation()
  if (next >= 0) setActive(next, true)
}

function show(select: HTMLSelectElement, keyboard = false) {
  close()
  const sheet = isCompact()
  const layer = el('div', '', sheet ? 'ui-select-layer sheet' : 'ui-select-layer')
  const tier = select.closest('[data-tier]')?.getAttribute('data-tier')
  if (tier) layer.dataset.tier = tier
  const list = el('div', '', 'ui-select-list')
  list.setAttribute('role', 'listbox')
  list.tabIndex = -1
  const label = labelOf(select)
  if (label) list.setAttribute('aria-label', label)
  const items = fill(select, list)
  if (sheet) {
    const panel = el('div', '', 'ui-select-sheet')
    panel.append(el('div', '', 'ui-select-grip'))
    if (label) panel.append(el('h2', label.startsWith('选择') ? label : `选择${label}`))
    panel.append(list)
    layer.append(panel)
  } else layer.append(list)
  // 模态对话框（天气面板）打开时，对话框以外的部分点不到，列表得挂在对话框里面
  ;(select.closest('dialog[open]') ?? document.body).append(layer)
  // 放进最顶层：盖得住模态对话框，也不受祖先的 overflow 与 transform 影响
  if (typeof layer.showPopover === 'function') {
    layer.popover = 'manual'
    layer.showPopover()
  }
  select.classList.add('ui-select-open')

  // 列表上按下不挪焦点：焦点留在列表上，方向键一直有效
  layer.addEventListener('mousedown', (e) => e.preventDefault())
  // 点在列表外（透明层或手机的遮罩）就收起，这一下不会点到下面的东西
  layer.addEventListener('click', (e) => {
    if (e.target === layer) close()
  })
  const indexOf = (target: EventTarget | null) => {
    const option = target instanceof Element ? target.closest('.ui-select-option') : null
    return items.findIndex((i) => i.element === option)
  }
  // 鼠标移到哪项就高亮哪项；手指滑动列表时不跟着亮
  list.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return
    const i = indexOf(e.target)
    if (i >= 0 && !items[i].disabled && i !== opened?.active) setActive(i)
  })
  list.addEventListener('click', (e) => choose(indexOf(e.target)))
  list.addEventListener('keydown', onKey)

  let width = innerWidth
  const onResize = () => {
    // 只有宽度变了（转屏、折叠屏开合）才收起；键盘收起这类只变高度的不算
    if (innerWidth !== width) close()
    else if (!sheet) place(select, list)
    width = innerWidth
  }
  // 浮层贴着下拉框：下拉框所在的页面滚动了就收起；别处自己滚的（事件流）不算。
  // 手机的列表在底部，和下拉框的位置无关
  const onScroll = (e: Event) => {
    if (e.target instanceof Node && e.target.contains(select)) close()
  }
  const onWheel = (e: WheelEvent) => {
    if (!(e.target instanceof Node && list.contains(e.target))) close()
  }
  addEventListener('resize', onResize)
  if (!sheet) {
    document.addEventListener('scroll', onScroll, true)
    layer.addEventListener('wheel', onWheel, { passive: true })
  }
  const unregisterBack = onBack(() => {
    close()
    return true
  })
  // 页面重画把下拉框换掉、藏起、禁用或重建了选项，列表跟着收起
  const watch = window.setInterval(() => {
    if (
      !select.isConnected ||
      select.disabled ||
      !select.getClientRects().length ||
      items.some((i) => !select.contains(i.option))
    )
      close()
  }, 300)
  opened = {
    select,
    layer,
    list,
    items,
    active: -1,
    keyboard,
    release() {
      removeEventListener('resize', onResize)
      document.removeEventListener('scroll', onScroll, true)
      unregisterBack()
      window.clearInterval(watch)
    },
  }

  if (!sheet) place(select, list)
  const chosen = items.findIndex((i) => i.option.selected)
  setActive(chosen >= 0 ? chosen : stepFrom(-1, 1, 1))
  // 选中的一项排在列表中间
  const current = items[chosen]?.element
  if (current) list.scrollTop = current.offsetTop - (list.clientHeight - current.offsetHeight) / 2
  list.focus({ preventScroll: true })
}

/** 每页启动时调用一次 */
export function installSelects() {
  // 系统列表在 mousedown 的默认处理里弹出（安卓 WebView 的点按也一样），在这里拦下
  document.addEventListener(
    'mousedown',
    (e) => {
      if (dropdown(e.target) && e.button === 0) e.preventDefault()
    },
    true
  )
  // 鼠标和手指都等 click 再打开：按下就开的话，手指滑动页面时会误开；
  // 松开落在新盖上的透明层上，click 还会派给共同的上层元素
  document.addEventListener(
    'click',
    (e) => {
      const select = dropdown(e.target)
      if (!select) return
      e.preventDefault()
      show(select)
    },
    true
  )
  document.addEventListener(
    'keydown',
    (e) => {
      const select = dropdown(e.target)
      if (!select || e.ctrlKey || e.metaKey || (e.altKey && e.key !== 'ArrowDown')) return
      if (!['Enter', ' ', 'ArrowDown', 'ArrowUp', 'F4'].includes(e.key)) return
      e.preventDefault()
      show(select, true)
    },
    true
  )
}
