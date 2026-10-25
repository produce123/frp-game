/*
 * 手机端按键布局（只在平台里用；桌面/上游自己的 dev 不受影响）。
 *
 * 需求：手机只留背包键，位置/大小由玩家自己挪、改；
 * 布局按**平台账号**存在服务器（换手机/清缓存都还在），不是 localStorage。
 * 旧账号存过的四个控件布局仍保留格式，但这里只应用/调整背包，其他三个忽略。
 * 服务端接口见 server/ai-town/index.mjs：GET/POST /ai-town/api/platform/layout。
 *
 * 坐标是视口归一化中心点（0..1），尺寸是 CSS 像素（44..160，服务端同样会夹）。
 * 这里不做整套 UI，只做一个贴边的小面板：拖动背包、拉动滑杆改大小、完成即保存。
 */

export type LayoutControl = 'stick' | 'act' | 'bag' | 'cycle'

export type LayoutItem = { x: number; y: number; size: number }
export type Layout = { v: 1; controls: Record<LayoutControl, LayoutItem> }

/** 默认按 844×390 横屏算；竖屏也能用，玩家可自己调。 */
const DEFAULT: Layout = {
  v: 1,
  controls: {
    stick: { x: 0.1, y: 0.805, size: 128 },
    act: { x: 0.927, y: 0.851, size: 84 },
    bag: { x: 0.831, y: 0.91, size: 54 },
    cycle: { x: 0.835, y: 0.751, size: 54 },
  },
}

const NAMES: LayoutControl[] = ['stick', 'act', 'bag', 'cycle']
const MIN = 44
const MAX = 160

function clamp(value: number, low: number, high: number) {
  return Math.min(high, Math.max(low, value))
}

function normalize(raw: unknown): Layout | null {
  if (!raw || typeof raw !== 'object') return null
  const src = (raw as { controls?: Record<string, unknown> }).controls
  if (!src) return null
  const out = { v: 1 as const, controls: {} as Record<LayoutControl, LayoutItem> }
  for (const name of NAMES) {
    const item = src[name] as Partial<LayoutItem> | undefined
    if (!item || typeof item.x !== 'number' || typeof item.y !== 'number' || typeof item.size !== 'number')
      return null
    out.controls[name] = {
      x: clamp(item.x, 0, 1),
      y: clamp(item.y, 0, 1),
      size: Math.round(clamp(item.size, MIN, MAX)),
    }
  }
  return out
}

async function read(): Promise<Layout | null> {
  try {
    const response = await fetch('./api/platform/layout', { credentials: 'same-origin' })
    if (!response.ok) return null
    const data = (await response.json()) as { layout?: unknown }
    return normalize(data.layout)
  } catch {
    return null
  }
}

async function write(layout: Layout): Promise<boolean> {
  try {
    const response = await fetch('./api/platform/layout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * 接管实际存在的控件（现在只有背包）。`parts` 里的元素已经由 touch.ts 建好。
 * 返回的 `isEditing()` 让背包在编辑时不要真的打开。
 */
export function createControlLayout(parts: Partial<Record<LayoutControl, HTMLElement>>) {
  let layout: Layout = structuredClone(DEFAULT)
  let editing = false
  let selected: LayoutControl = 'bag'
  let mounted = false
  const names = NAMES.filter((name) => Boolean(parts[name]))
  if (!names.length) throw new Error('布局至少需要一个控件')
  const box = parts[names[0]]?.parentElement
  if (!box) throw new Error('布局控件还没有挂到页面上')
  box.classList.add('frp-layout-host')
  // 默认 .avatar-touch 是贴底的一条；改成整屏，归一化坐标才和视口一致
  box.style.position = 'fixed'
  box.style.inset = '0'
  box.style.height = 'auto'
  box.style.bottom = '0'

  const buttonEl = document.createElement('button')
  buttonEl.type = 'button'
  buttonEl.className = 'frp-layout-button'
  buttonEl.textContent = '布局'
  buttonEl.title = '调整背包的位置和大小'
  box.append(buttonEl)

  const panel = document.createElement('div')
  panel.className = 'frp-layout-panel'
  panel.hidden = true
  const title = document.createElement('span')
  title.textContent = '拖动背包；滑杆调大小'
  const range = document.createElement('input')
  range.type = 'range'
  range.min = String(MIN)
  range.max = String(MAX)
  range.step = '2'
  const value = document.createElement('b')
  const done = document.createElement('button')
  done.type = 'button'
  done.textContent = '完成'
  const reset = document.createElement('button')
  reset.type = 'button'
  reset.className = 'frp-layout-ghost'
  reset.textContent = '恢复默认'
  panel.append(title, range, value, reset, done)
  box.append(panel)

  const applyOne = (name: LayoutControl) => {
    const item = layout.controls[name]
    const node = parts[name]
    if (!node) return
    // 归一化坐标在竖屏/小屏上也要落得进视口，不能只按 844×390 横屏算。
    const shown = Math.min(item.size, window.innerWidth, window.innerHeight)
    const cx = clamp(
      item.x * window.innerWidth,
      shown / 2,
      Math.max(shown / 2, window.innerWidth - shown / 2)
    )
    const cy = clamp(
      item.y * window.innerHeight,
      shown / 2,
      Math.max(shown / 2, window.innerHeight - shown / 2)
    )
    node.style.position = 'absolute'
    node.style.left = `${cx}px`
    node.style.top = `${cy}px`
    node.style.right = 'auto'
    node.style.bottom = 'auto'
    node.style.transform = 'translate(-50%, -50%)'
    node.style.width = `${shown}px`
    node.style.height = `${shown}px`
  }

  const apply = () => {
    for (const name of names) applyOne(name)
    value.textContent = `${layout.controls[selected].size}px`
    range.value = String(layout.controls[selected].size)
  }
  // 转屏/地址栏收起会改变视口；重新按当前尺寸夹一次，别让按键跑出屏幕。
  window.addEventListener('resize', () => {
    if (!box.hidden) apply()
  })

  const select = (name: LayoutControl) => {
    selected = name
    for (const key of names) parts[key]?.classList.toggle('frp-layout-selected', key === name)
    apply()
  }

  const place = (name: LayoutControl, clientX: number, clientY: number) => {
    const item = layout.controls[name]
    item.x = clamp(clientX / Math.max(1, window.innerWidth), 0, 1)
    item.y = clamp(clientY / Math.max(1, window.innerHeight), 0, 1)
    applyOne(name)
  }

  const drag = (name: LayoutControl) => (event: PointerEvent) => {
    if (!editing) return
    event.preventDefault()
    event.stopPropagation()
    select(name)
    const node = parts[name]
    try {
      node?.setPointerCapture(event.pointerId)
    } catch {
      // 指针已经抬起
    }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return
      place(name, e.clientX, e.clientY)
    }
    const end = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', end, true)
      try {
        node?.releasePointerCapture(event.pointerId)
      } catch {
        // 已经释放
      }
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', end, true)
  }

  for (const name of names) {
    const node = parts[name]
    if (!node) continue
    node.addEventListener('pointerdown', drag(name), true)
    node.addEventListener('click', (event) => {
      if (editing) {
        event.preventDefault()
        event.stopPropagation()
        select(name)
      }
    }, true)
  }

  const setEditing = (next: boolean) => {
    editing = next
    box.classList.toggle('frp-layout-editing', next)
    panel.hidden = !next
    buttonEl.textContent = next ? '完成' : '布局'
    if (next) select(selected)
  }

  buttonEl.onclick = () => {
    if (!editing) {
      setEditing(true)
      return
    }
    setEditing(false)
    void write(layout)
  }
  done.onclick = () => {
    setEditing(false)
    void write(layout)
  }
  reset.onclick = () => {
    layout = structuredClone(DEFAULT)
    apply()
    void write(layout)
  }
  range.oninput = () => {
    const size = Number(range.value)
    layout.controls[selected].size = size
    value.textContent = `${size}px`
    applyOne(selected)
  }
  for (const name of names) {
    const node = parts[name]
    if (!node) continue
    node.addEventListener('focus', () => {
      if (editing) select(name)
    })
  }

  const ready = read().then((saved) => {
    if (saved) layout = saved
    apply()
    mounted = true
  })
  // 先按默认摆好，服务器布局回来后再归位；网络慢时控件也不会叠在左下角
  apply()

  return {
    editing: () => editing,
    /** 布局读回来之前先别把控件显示出来，免得先跳一下再归位 */
    ready: () => ready,
    isMounted: () => mounted,
    apply,
    open: () => setEditing(true),
  }
}