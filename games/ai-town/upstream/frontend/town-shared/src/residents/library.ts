// 村民库：人物卡片可以一次勾选几位，底部托盘写明用哪个模型，点一下就住进来；以及模板详情。
import { button, el } from '../dom'
import { namesOf } from '../holds'
import { newId } from '../ids'
import { templateStatusLabels } from '../labels'
import { templateKey, villagerArt } from '../portraits'
import type { LibraryKind, ResidentTemplate, TemplateCard, TemplateFields } from '../protocol'
import { caption, input, marker, personaDetails } from './form'
import { modelLine } from './modelLine'
import { peopleCount } from './recommend'
import type { ResidentsContext, ViewHandle } from './state'

/** 搜索框停止输入这么久之后才向服务器要结果 */
const SEARCH_DELAY_MS = 250
const KINDS: [LibraryKind, string][] = [
  ['all', '全部'],
  ['builtin', '自带的'],
  ['custom', '自己建的'],
]

/** 搜索框：改了就记下，停止输入一会儿再请求，列表回来时只重画结果 */
function searchBox(ctx: ResidentsContext) {
  const { filter } = ctx.state
  const search = input(filter.query, '搜索姓名、介绍或标签', 60)
  search.type = 'search'
  let timer: number | undefined
  search.oninput = () => {
    filter.query = search.value
    window.clearTimeout(timer)
    timer = window.setTimeout(ctx.requestLibrary, SEARCH_DELAY_MS)
  }
  return search
}

function plainToolbar(ctx: ResidentsContext) {
  const { filter } = ctx.state
  const bar = el('div', '', 'rv-toolbar')
  const kind = el('select')
  kind.setAttribute('aria-label', '村民类型')
  for (const [v, label] of KINDS) kind.append(new Option(label, v, false, filter.kind === v))
  kind.onchange = () => {
    filter.kind = KINDS.find(([v]) => v === kind.value)?.[0] ?? 'all'
    ctx.requestLibrary()
  }
  const archived = el('label', '', 'dim')
  const archivedBox = el('input')
  archivedBox.type = 'checkbox'
  archivedBox.checked = filter.include_archived
  archivedBox.onchange = () => {
    filter.include_archived = archivedBox.checked
    ctx.requestLibrary()
  }
  archived.append(archivedBox, document.createTextNode(' 含收起的'))
  bar.append(
    searchBox(ctx),
    kind,
    archived,
    button('＋ 新建村民', () => ctx.newVillager('library'), 'primary')
  )
  return bar
}

/** 空着的住宅数；场景里没有住宅时不限人数 */
function freeHomes(ctx: ResidentsContext): number | null {
  const homes = ctx.state.population?.homes ?? []
  return homes.length ? homes.filter((h) => !h.occupant).length : null
}

function plainCard(ctx: ResidentsContext, c: TemplateCard, onPick: (id: string) => void) {
  const picked = ctx.state.picks.includes(c.template_id)
  const card = el('article', '', `rv-card${picked ? ' on' : ''}`)
  card.dataset.templateId = c.template_id
  const head = el('div', '', 'rv-head')
  head.append(marker(templateKey(c), c.appearance.marker), el('strong', c.name))
  // 能请的不再标「可加入」，只标已经住进来的和归档的
  if (c.status !== 'available') head.append(el('span', templateStatusLabels[c.status], 'rv-status'))
  card.append(head, el('p', c.intro))
  if (c.tags.length) card.append(el('p', c.tags.join(' · '), 'dim'))
  const actions = el('div', '', 'row')
  if (c.status === 'available') {
    const pick = button(picked ? '已选 ✓' : '选这位', () => onPick(c.template_id))
    pick.className = picked ? 'primary' : ''
    pick.setAttribute('aria-pressed', String(picked))
    actions.append(pick)
  }
  actions.append(button('详情', () => ctx.showTemplate(c.template_id)))
  if (c.status === 'joined' && c.resident_id) actions.append(ctx.locateButton(c.resident_id))
  card.append(actions)
  return card
}

/** 底部托盘：选了谁、用哪个模型（连了几个服务时能换），一次请进来 */
function tray(ctx: ResidentsContext, rerender: () => void) {
  const { state, deps } = ctx
  const box = el('div', '', 'rv-tray')
  box.hidden = !state.picks.length && !state.inviting
  if (box.hidden) return box
  const names = state.picks.map((id) => state.cards.find((c) => c.template_id === id)?.name ?? id)
  const free = freeHomes(ctx)
  const words = el('div', '', 'rv-tray-words')
  words.append(el('b', `已选 ${state.picks.length} 位：${namesOf(names)}`))
  words.append(
    modelLine({
      options: deps.modelOptions(),
      current: ctx.joinModel(),
      choose: (o) => {
        state.joinModel = { provider: o.provider, model: o.model }
        rerender()
      },
      connect: deps.connectModel,
    })
  )
  if (free !== null && state.picks.length > free)
    words.append(el('span', `住宅只剩 ${free} 间，先少选几位`, 'drop'))
  const go = button(
    state.inviting ? '正在请…' : `请${peopleCount(state.picks.length)}住进来`,
    () => void ctx.invite([...state.picks]),
    'primary'
  )
  go.disabled = state.inviting || (free !== null && state.picks.length > free)
  const clear = button('清空', () => {
    state.picks = []
    rerender()
  })
  clear.disabled = state.inviting
  const actions = el('div', '', 'row')
  actions.append(clear, go)
  box.append(words, actions)
  return box
}

/** 工具栏建一次；村民库列表回来时只重画卡片和托盘，搜索框保持输入和焦点 */
export function renderLibrary(ctx: ResidentsContext): ViewHandle {
  const box = el('div', '', 'rv-library')
  const grid = el('div', '', 'rv-cards')
  let bottom = el('div')
  box.append(plainToolbar(ctx), grid, bottom)
  const onPick = (id: string) => {
    const { picks } = ctx.state
    ctx.state.picks = picks.includes(id) ? picks.filter((x) => x !== id) : [...picks, id]
    update()
  }
  function update() {
    const { cards } = ctx.state
    grid.replaceChildren(
      ...(cards.length ? [] : [el('p', '没有符合条件的人物', 'dim')]),
      ...cards.map((c) => plainCard(ctx, c, onPick))
    )
    const next = tray(ctx, update)
    bottom.replaceWith(next)
    bottom = next
  }
  update()
  return { root: box, update }
}

function templateActions(
  ctx: ResidentsContext,
  id: string,
  t: ResidentTemplate,
  card: TemplateCard | undefined
) {
  const actions = el('div', '', 'row')
  if (card?.status === 'available')
    actions.append(button('加入小镇', () => ctx.startJoin(id), 'primary'))
  if (card?.status === 'joined' && card.resident_id)
    actions.append(ctx.locateButton(card.resident_id))
  actions.append(
    button('复制并修改', () => {
      // 副本先照原来的样子长：没捏过的模板按它自己的编号出长相，换了编号也不变样
      const look = t.fields.appearance.look ?? villagerArt()?.lookOf(t.template_id)
      ctx.state.view = {
        kind: 'editor',
        copyFrom: {
          ...t.fields,
          name: `${t.fields.name}（副本）`,
          appearance: { ...t.fields.appearance, ...(look ? { look } : {}) },
        },
      }
      ctx.render()
    })
  )
  if (!t.builtin)
    actions.append(
      button('编辑', () => {
        ctx.state.view = { kind: 'editor', template: t }
        ctx.render()
      })
    )
  actions.append(
    button(t.archived ? '放回列表' : '收起', () =>
      ctx.deps.send({
        type: 'archive_resident_template',
        request_id: newId(),
        template_id: id,
        expected_version: t.version,
        archived: !t.archived,
      })
    )
  )
  return actions
}

function templateSections(f: TemplateFields): [string, string][] {
  return [
    [
      '介绍',
      [f.intro, f.age && `年龄 ${f.age}`, f.gender && `性别/称谓 ${f.gender}`]
        .filter(Boolean)
        .join(' · '),
    ],
    ['性格与说话习惯', [f.tags.join('、'), f.personality, f.speech].filter(Boolean).join('\n')],
    ['背景', f.background],
    [
      '驱动力与兴趣',
      [f.drives, f.interests, f.occupation && `职业背景：${f.occupation}`]
        .filter(Boolean)
        .join('\n'),
    ],
  ]
}

/** 一张模板的详情：左边分段写设定，右边是人设全文 */
export function renderTemplate(ctx: ResidentsContext, id: string): ViewHandle {
  const { detail } = ctx.state
  const box = el('div', '', 'rv-detail')
  box.append(button('← 返回村民库', () => ctx.setTab('library')))
  if (!detail) {
    box.append(el('p', '读取中…', 'dim'))
    return { root: box }
  }
  if (!detail.template) {
    box.append(el('p', detail.error ?? '模板不存在', 'drop'))
    return { root: box }
  }
  const t = detail.template
  const f = t.fields
  const card = ctx.state.cards.find((c) => c.template_id === id)
  const head = el('div', '', 'rv-head')
  head.append(
    marker(
      templateKey({ template_id: t.template_id, appearance: f.appearance }),
      f.appearance.marker
    ),
    el('h2', f.name)
  )
  const status = card ? templateStatusLabels[card.status] : t.archived ? '已收起' : ''
  box.append(head, ...(status ? [el('p', status, 'dim')] : []), templateActions(ctx, id, t, card))
  const split = el('div', '', 'rv-split')
  const left = el('div')
  for (const [title, text] of templateSections(f)) {
    if (!text) continue
    left.append(caption(title), el('p', text, 'rv-pre'))
  }
  const right = el('div', '', 'rv-sticky')
  right.append(personaDetails(detail.persona).details)
  split.append(left, right)
  box.append(split)
  return { root: box }
}
