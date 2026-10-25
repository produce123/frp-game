// 将 HD-2D 界面部件放进 gameShell.html 的骨架，不替换已建好的地图容器。
import plainParts from './plain.html?raw'
import { decorateIcons } from '../game/icons'
import { $ } from '../dom'

export function installLayout() {
  const parts = document.createElement('template')
  parts.innerHTML = plainParts
  const slot = (name: string) => {
    const template = parts.content.querySelector<HTMLTemplateElement>(
      `template[data-slot="${name}"]`
    )
    if (!template) return null
    const fragment = document.importNode(template.content, true)
    decorateIcons(fragment)
    return fragment
  }
  $('topbar').replaceChildren(slot('topbar') ?? '')
  $('info-panel').replaceChildren(slot('info-panel') ?? '')
  const mapButtons = slot('map')
  if (mapButtons) $('map').prepend(mapButtons)
  const dock = slot('obs-view')
  if (dock) $('obs-view').append(dock)
  const dialogs = slot('body')
  if (dialogs) document.body.append(dialogs)
}
