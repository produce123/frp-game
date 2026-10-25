// 地图下方的一句话结果提示（「阿岚、阿树搬进来了」）：几秒后自己收起，点一下也收起。
import { el } from './dom'

export function createMapToast(map: HTMLElement) {
  const box = el('div', '', 'map-toast')
  box.hidden = true
  box.setAttribute('role', 'status')
  box.onclick = () => (box.hidden = true)
  map.append(box)
  let timer = 0
  return {
    show(text: string, ms = 7000) {
      box.textContent = text
      box.hidden = false
      clearTimeout(timer)
      timer = window.setTimeout(() => (box.hidden = true), ms)
    },
  }
}
