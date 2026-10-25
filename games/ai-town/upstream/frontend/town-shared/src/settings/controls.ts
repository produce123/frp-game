import { el, button } from '../dom'
import './controls.css'

// 设定页共用的三种控件：一行设置（名称、说明、右侧控件）、拨动开关、分段按钮。
// 各面板共用，颜色只取两套主题都有的 --line / --dim / --accent。

/** 一行设置：左边名称和一句说明，右边放控件 */
export function settingRow(label: string, description: string, control: HTMLElement) {
  const row = el('div', '', 'set-row')
  const text = el('div', '', 'set-row-text')
  text.append(el('span', label, 'set-row-label'))
  if (description) text.append(el('span', description, 'set-row-desc'))
  row.append(text, control)
  return row
}

/** 拨动开关；onChange 里决定是否真的切换，之后由调用方用 set 同步显示 */
export function switchControl(label: string, onChange: (on: boolean) => void) {
  const input = el('input', '', 'set-switch')
  input.type = 'checkbox'
  input.setAttribute('role', 'switch')
  input.setAttribute('aria-label', label)
  input.onchange = () => onChange(input.checked)
  return {
    el: input,
    set(on: boolean) {
      input.checked = on
    },
  }
}

/** 分段按钮：一组互斥选项，选中的一项 aria-pressed="true" */
export function segmented(
  label: string,
  options: { value: string; label: string }[],
  onPick: (value: string) => void
) {
  const group = el('div', '', 'ui-seg')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', label)
  const buttons = options.map((option) => {
    const b = button(option.label, () => onPick(option.value))
    b.dataset.value = option.value
    group.append(b)
    return b
  })
  return {
    el: group,
    set(value: string) {
      for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === value))
    },
    /** 选项文字随数据变化时（如「全部 3」）更新 */
    relabel(value: string, text: string) {
      const b = buttons.find((item) => item.dataset.value === value)
      if (b) b.textContent = text
    },
  }
}
