import type { AvatarState } from './types'
import { button, el } from '../dom'
import { clock, playerText } from '../format'
import { createBodyView } from '../info/body'
// 状态面板：最近的动作结果、读完的书、形象表单与离开。化身没有身体状态，这里不画需求条。

export function renderStatus(
  root: HTMLElement,
  state: AvatarState,
  profile: HTMLElement,
  leave: () => void
) {
  const a = state.actor
  if (!a) return
  if (state.mode === 'possession') {
    root.append(el('h4', '身体状态'))
    for (const n of a.needs) root.append(el('p', `${n.need}：${n.value.toFixed(0)} / 100`))
    const body = el('div')
    root.append(body)
    createBodyView(body).render(a.body ?? undefined)
    root.append(el('h4', '当前目标'))
    const goals = state.goals ?? []
    if (!goals.length) root.append(el('p', '当前没有已记录目标。'))
    for (const g of goals) root.append(el('p', g.text))
    root.append(el('h4', '本人近期经历'))
    for (const e of state.recent ?? [])
      root.append(el('p', `${clock(e.at)} · ${playerText(e.text)}`))
  }
  root.append(el('h4', '最近动作结果'))
  const recent = el('div')
  recent.className = 'avatar-recent'
  const lines = state.feedback ?? []
  if (!lines.length) {
    const p = el('p', '还没有动作结果。')
    p.className = 'dim'
    recent.append(p)
  }
  for (const text of lines) recent.append(el('p', playerText(text)))
  root.append(recent)
  if (state.reading) {
    const r = el('div')
    r.className = 'avatar-reading'
    r.append(
      el('b', `最近读完 · ${state.reading.title}`),
      el('small', state.reading.author),
      el('p', state.reading.text)
    )
    root.append(r)
  }
  if (state.mode !== 'possession') root.append(profile)
  const foot = el('div')
  foot.className = 'avatar-textacts'
  const out = button(state.mode === 'possession' ? '交还 AI' : '退出化身', leave)
  out.className = 'avatar-danger'
  foot.append(out)
  root.append(foot)
}
