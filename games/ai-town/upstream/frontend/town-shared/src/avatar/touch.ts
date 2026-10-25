// 手机只保留背包：移动、交谈/使用、换目标都直接点地图，不再额外造摇杆和按钮。
// 背包的位置/大小仍由玩家自己调（layout.ts，按平台账号存在服务器）。
import { button, el } from '../dom'
import { gameIcon } from '../game/icons'
import type { AvatarPrompt } from '../gameMap'
import { createControlLayout } from './layout'

interface TouchDeps {
  stick(direction: [number, number] | null): void
  act(): void
  bag(): void
  cycle(): void
}

export function createAvatarTouch(root: HTMLElement, d: TouchDeps, signal: AbortSignal) {
  const box = el('div', '', 'avatar-touch')
  box.hidden = true
  const bag = button('', () => { if (!layout.editing()) d.bag() }, 'avatar-act-small avatar-act-bag')
  bag.append(gameIcon('bag', true), el('span', '背包'))
  box.append(bag)
  root.append(box)
  const layout = createControlLayout({ bag })

  return {
    /** 控制中才显示；prompts 仍由地图自己画，不需要额外按键。 */
    render(controlling: boolean, _prompts: AvatarPrompt[]) {
      box.hidden = !controlling
    },
  }
}