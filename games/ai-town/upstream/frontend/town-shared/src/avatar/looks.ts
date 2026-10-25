import type { AvatarCommand, AvatarLook } from './types'
import { colorPicker, PRESET_COLORS } from './view'
import { el } from '../dom'
// 化身外观：地图给出几套像素小人，玩家挑一套。协议里只有颜色，每套外观对应一个固定颜色。

const STORAGE_KEY = 'town.avatar.look-color'

function rgb(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}

/** 颜色对应哪一套：同色直接对上；其余（旧存档、手选的颜色）取 RGB 最接近的一套 */
export function closestColor(colors: readonly string[], color: string): number {
  const target = rgb(color)
  if (!target) return 0
  let best = 0,
    bestDistance = Infinity
  colors.forEach((c, i) => {
    const v = rgb(c)
    if (!v) return
    const d = (v[0] - target[0]) ** 2 + (v[1] - target[1]) ** 2 + (v[2] - target[2]) ** 2
    if (d < bestDistance) {
      best = i
      bestDistance = d
    }
  })
  return best
}

/** 上次挑的外观颜色；存储不可用时返回 null */
function rememberedLookColor(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}
function rememberLookColor(color: string) {
  try {
    localStorage.setItem(STORAGE_KEY, color)
  } catch {
    // 存不了就下次从第一套开始
  }
}

/** 头像按钮一排，选中的高亮；接口和色板相同，value 是所选外观的颜色 */
function lookPicker(
  looks: readonly AvatarLook[],
  initial: string,
  onChange: (color: string) => void
) {
  const root = el('div')
  root.className = 'avatar-looks'
  root.setAttribute('role', 'radiogroup')
  root.setAttribute('aria-label', '外观')
  const colors = looks.map((l) => l.color)
  let value = colors[closestColor(colors, initial)]
  const buttons = looks.map((look, i) => {
    const b = el('button')
    b.type = 'button'
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-label', `外观 ${i + 1}`)
    const img = el('img')
    img.src = look.portrait
    img.alt = ''
    b.append(img)
    b.onclick = () => set(look.color, true)
    root.append(b)
    return b
  })
  const mark = () =>
    buttons.forEach((b, i) => {
      const on = colors[i] === value
      b.classList.toggle('on', on)
      b.setAttribute('aria-checked', String(on))
    })
  function set(color: string, notify: boolean) {
    value = colors[closestColor(colors, color)]
    mark()
    if (notify) onChange(value)
  }
  mark()
  return {
    root,
    get value() {
      return value
    },
    set(color: string) {
      set(color, false)
    },
  }
}

/** 操作条和入口按钮上的小圆点：有外观时换成所选小人的头像 */
function paintLookDot(dot: HTMLElement, looks: readonly AvatarLook[] | null, color: string) {
  dot.style.setProperty('--avatar-color', color)
  if (!looks?.length) return
  const colors = looks.map((l) => l.color)
  const look = looks[closestColor(colors, color)]
  dot.classList.add('avatar-look-dot')
  dot.style.setProperty('--avatar-portrait', `url("${look.portrait}")`)
}

/** 化身挑样子的方式：优先挑像素外观，没有可选外观时挑颜色 */
export function lookChoice(looks: readonly AvatarLook[] | null) {
  const hasLooks = !!looks?.length
  return {
    hasLooks,
    caption: hasLooks ? '外观' : '颜色',
    /** 进入对话框的初始颜色：上次挑的外观、第一套外观或默认色 */
    initial: (hasLooks && rememberedLookColor()) || looks?.[0]?.color || PRESET_COLORS[0],
    picker: (initial: string, onChange: (color: string) => void) =>
      hasLooks && looks ? lookPicker(looks, initial, onChange) : colorPicker(initial, onChange),
    /** 进入小镇或保存形象的命令；挑的是外观时记住它，下次默认选中 */
    command(kind: 'enter' | 'profile', name: string, color: string): AvatarCommand {
      if (hasLooks) rememberLookColor(color)
      return { kind, name: name.trim() || '旅人', appearance: { marker: '我', color } }
    },
    paintDot: (dot: HTMLElement, color: string) => paintLookDot(dot, looks, color),
  }
}
export type LookChoice = ReturnType<typeof lookChoice>
