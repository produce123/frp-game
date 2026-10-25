import { el } from 'town-shared/dom'
import type { CreatorContext } from './creatorContext'
import { constraintSummary } from './creatorProgress'
import type { Draft, Mention } from './creatorTypes'

// 预览旁的说明：你说的 → 地图上的、会住进来的人、写给村民的背景、做不到的事、布局检查、地点名单。
// 对照按地图上的地点写名字（模型只给指向），所以说明和地图不会对不上。

type Place = Draft['report']['places'][number]

/** 一处说到的地方在地图上叫什么；起了新名字的（住宅除外）后面小字写外观是哪种地点 */
function placesFor(c: CreatorContext, mention: Mention, places: Place[]) {
  const hits = places.filter((p) =>
    mention.refs.some((ref) => p.ref === ref || p.ref.startsWith(ref + ':'))
  )
  if (!hits.length) return el('span', '地图上没有这种地方', 'creator-missing')
  const kinds = [...new Set(hits.map((p) => p.ref.split(':')[0]))]
  const names = hits.map((p) => p.name)
  const shown =
    names.length > 3 ? `${names.slice(0, 2).join('、')}等 ${names.length} 处` : names.join('、')
  const span = el('span', shown)
  const renamed = kinds.filter(
    (kind) => kind !== 'home' && !hits.some((p) => p.name.startsWith(c.nameOf(kind)))
  )
  if (renamed.length)
    span.append(el('small', `外观是${renamed.map((k) => c.nameOf(k)).join('、')}`))
  return span
}

function section(title: string, ...body: HTMLElement[]) {
  const box = el('section', '', 'creator-plan-section')
  box.append(el('h3', title), ...body)
  return box
}

function list(lines: string[]) {
  const ul = el('ul')
  ul.append(...lines.map((line) => el('li', line)))
  return ul
}

export function clearReport(c: CreatorContext) {
  c.el('creator-plan').replaceChildren()
}

/** 草稿到手后写说明：一句话规划的几段只在一句话模式下有 */
export function renderReport(c: CreatorContext, draft: Draft) {
  const places = draft.report.places
  const sections: HTMLElement[] = []
  if (c.languageMode && c.mapping.length) {
    const ul = el('ul', '', 'creator-mapping')
    for (const mention of c.mapping) {
      const li = el('li')
      li.append(el('b', mention.said), el('i', '→'), placesFor(c, mention, places))
      ul.append(li)
    }
    sections.push(section('你说的 → 地图上的', ul))
  }
  if (c.languageMode && c.residents.length)
    sections.push(
      section(
        '会住进来的人',
        list(c.residents),
        el('p', '进镇时按这几句写好人设、请进来，每位多一次模型调用。', 'creator-hint')
      )
    )
  if (c.languageMode && c.worldview) sections.push(section('写给村民的背景', el('p', c.worldview)))
  if (c.languageMode && c.notes.length) sections.push(section('做不到的', list(c.notes)))
  const checks = [
    ...draft.report.warnings,
    ...draft.report.constraints.map((r) => constraintSummary(r, (kind) => c.nameOf(kind))),
  ]
  if (checks.length) sections.push(section('布局', list(checks)))
  sections.push(
    section(`地点 · ${places.length} 处`, el('p', places.map((p) => p.name).join(' · ')))
  )
  c.el('creator-plan').replaceChildren(...sections)
}
