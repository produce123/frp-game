/** 建元素、建按钮、按 id 取元素：各页面共用，不再各写一份。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = '',
  className = ''
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  if (text) element.textContent = text
  if (className) element.className = className
  return element
}

export function button(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const b = el('button', label, className)
  b.type = 'button'
  b.onclick = onClick
  return b
}

/** 页面骨架里的固定元素：找不到说明 HTML 与代码不一致，直接报错比静默空指针好排查。 */
export function $(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`页面缺少元素 #${id}`)
  return element
}

/** 在某个根元素下按选择器取元素，找不到同样报错。 */
export function query<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`缺少元素 ${selector}`)
  return element
}

/** 页面底部的状态行（设定子页、村民页）；cls 是 ok（成功）、drop（失败）或空 */
export function statusLine(status: HTMLElement) {
  return (text: string, cls = '') => {
    status.textContent = text
    status.className = 'page-status ' + cls
  }
}
