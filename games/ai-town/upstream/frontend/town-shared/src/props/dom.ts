import { el } from '../dom'
import { segmented } from '../settings/controls'
export { el, button } from '../dom'
/** 道具页表单控件：标签加输入框一组，样式类固定为 prop-field。 */
export function field(label: string, input: HTMLElement) {
  const wrap = el('label', '', 'prop-field')
  wrap.append(el('span', label), input)
  return wrap
}
export function input(value: string, name: string, type = 'text') {
  const element = el('input')
  element.type = type
  element.value = value
  element.name = name
  return element
}
export function select(options: { id: string; label: string }[], value: string, name: string) {
  const element = el('select')
  element.name = name
  for (const option of options) {
    const o = el('option', option.label)
    o.value = option.id
    element.append(o)
  }
  element.value = value
  return element
}

/** 道具页与书与公告页顶部的提示行；bad 时标成错误 */
export function announcer(status: HTMLElement) {
  return (text: string, bad = false) => {
    status.textContent = text
    status.classList.toggle('error', bad)
  }
}

/** 一组互斥选项（分段按钮）：读写 value，用户点选后调 onChange；道具页的模式与用途筛选用 */
export function choice(
  label: string,
  options: { value: string; label: string }[],
  initial: string,
  onChange: () => void
) {
  let current = initial
  const seg = segmented(label, options, (value) => {
    if (value === current) return
    current = value
    seg.set(value)
    onChange()
  })
  seg.set(initial)
  return {
    el: seg.el,
    get value() {
      return current
    },
    set value(value: string) {
      current = value
      seg.set(value)
    },
  }
}
