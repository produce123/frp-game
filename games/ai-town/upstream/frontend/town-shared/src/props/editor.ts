import { bodyEffects } from './bodyEffects'
import { propGlyph } from './glyph'
import { el as svgElement } from '../svg'
import type { Action, Appearance, Definition, PropCatalog, BodyNeed, Effect } from './types'
import { defaultAppearance, validateAppearance } from './appearances'
import { el, button, field, input, select } from './dom'
import { newId } from '../ids'
import { errorText } from '../format'
// 道具编辑器：先给简单的——名字、说明、样子、拿来做什么；编号、版本、携带、作品内容收在「更多设置」里。
// 各块建自己的表单，保存时读回自己的字段。

type Submit = (
  kind: 'validate_prop' | 'save_prop',
  definition: Definition,
  appearance: Appearance
) => void

const newActionId = (index: number) => `use_${index}`
function newAction(index: number): Action {
  return {
    id: newActionId(index),
    label: index === 1 ? '使用' : '新动作',
    duration_minutes: 30,
    during: [],
    completion: 'activity',
    conditions: [],
  }
}
function newDefinition(): Definition {
  return {
    id: `player:prop_${newId().slice(0, 8)}`,
    version: 1,
    name: '我的道具',
    description: '',
    actions: [newAction(1)],
    bulletin_board: false,
  }
}
function numberInput(value: number | string, name: string, min: string, max?: string, step = '1') {
  const element = input(String(value), name, 'number')
  element.min = min
  if (max !== undefined) element.max = max
  element.step = step
  return element
}
function checkbox(name: string, checked: boolean) {
  const element = input('', name, 'checkbox')
  element.checked = checked
  return element
}

/** 名称、说明在上面；编号和版本放进「更多设置」 */
function basicFields(d: Definition) {
  const fields = el('div', '', 'prop-form-grid')
  const idFields = el('div', '', 'prop-form-grid')
  const name = input(d.name, 'prop-name'),
    id = input(d.id, 'prop-id'),
    version = numberInput(d.version, 'prop-version', '1'),
    description = el('textarea')
  name.maxLength = 80
  id.maxLength = 120
  description.value = d.description
  description.name = 'prop-description'
  description.maxLength = 1000
  fields.append(field('道具名称', name), field('说明', description))
  idFields.append(field('编号（英文和数字，比如 player:my_lamp）', id), field('版本', version))
  return {
    fields,
    idFields,
    read: () => ({
      id: id.value.trim(),
      version: Number(version.value),
      name: name.value.trim(),
      description: description.value,
    }),
  }
}

/** 可携带、堆叠、容器格数 */
function carryingFields(d: Definition) {
  const portable = checkbox('prop-portable', d.portable ?? false)
  const stack = numberInput(d.stack_limit ?? 1, 'prop-stack-limit', '1', '5')
  const storage = numberInput(d.storage_slots ?? 0, 'prop-storage-slots', '0', '80')
  const fields = el('fieldset')
  fields.append(
    el('legend', '携带与存放'),
    field('可放入背包', portable),
    field('每格最多几件（1–5）', stack),
    field('能存放几格东西（0 表示不能存放）', storage),
    el(
      'p',
      '花、手工制品等可以只携带，没有使用动作。容器、公告栏及公告不能携带；有内部余量的物品单独占格。',
      'prop-muted'
    )
  )
  return {
    fields,
    read: () => ({
      portable: portable.checked,
      stack_limit: Number(stack.value),
      storage_slots: Number(storage.value),
    }),
  }
}

/** 书籍或公告正文、公告栏标记 */
function contentFields(d: Definition) {
  const kind = select(
    [
      { id: '', label: '无正文' },
      { id: 'book', label: '书籍' },
      { id: 'bulletin', label: '公告' },
    ],
    d.readable?.kind ?? '',
    'definition-content-kind'
  )
  const title = input(d.readable?.title ?? d.name, 'definition-content-title'),
    author = input(d.readable?.author ?? '', 'definition-content-author'),
    text = el('textarea')
  title.maxLength = 80
  author.maxLength = 80
  text.maxLength = 4000
  text.rows = 8
  text.name = 'definition-content-text'
  text.value = d.readable?.text ?? ''
  const board = checkbox('definition-board', d.bulletin_board ?? false)
  const fields = el('fieldset')
  fields.append(
    el('legend', '作品内容与公告栏'),
    field('内容类型', kind),
    field('书名 / 公告标题', title),
    field('作者显示名', author),
    field('正文（最多 4000 字）', text),
    field('此道具是公告栏', board)
  )
  const note = el(
    'p',
    '选了书籍或公告，还要在下面的动作里选对应的阅读结果。写作动作要村民自己动笔，写完才成书。',
    'prop-muted'
  )
  return {
    fields,
    note,
    read: (id: string, version: number): Pick<Definition, 'readable' | 'bulletin_board'> => ({
      bulletin_board: board.checked,
      readable:
        kind.value === 'book' || kind.value === 'bulletin'
          ? {
              work_id: d.readable?.work_id ?? id,
              version,
              kind: kind.value,
              title: title.value.trim(),
              author: author.value.trim(),
              text: text.value,
              origin: { kind: 'player' },
            }
          : undefined,
    }),
  }
}

/** 每项身体需求一行：是否恢复、每分钟点数、是否暂停自然消耗 */
function needEffectRows(catalog: PropCatalog, a: Action, grid: HTMLElement) {
  const rows = catalog.capabilities.needs.map((need) => {
    const previous = a.during.find(
      (e): e is Extract<Effect, { kind: 'restore_need' }> =>
        e.kind === 'restore_need' && e.need === need.id
    )
    const enabled = checkbox('restore-' + need.id, !!previous)
    const rate = numberInput(
      previous?.per_minute ?? 0.25,
      need.id + '-rate',
      String(catalog.capabilities.rate.min),
      String(catalog.capabilities.rate.max),
      'any'
    )
    rate.disabled = !enabled.checked
    enabled.onchange = () => (rate.disabled = !enabled.checked)
    const pause = checkbox('pause-' + need.id, previous?.pause_decay ?? need.id === 'energy')
    const row = el('div', '', 'prop-effect-row')
    row.append(
      field('恢复' + need.label, enabled),
      field('每分钟恢复点数', rate),
      field('暂停自然消耗', pause)
    )
    grid.append(row)
    return { need: need.id, enabled, rate, pause }
  })
  return (): Effect[] =>
    rows
      .filter((r) => r.enabled.checked)
      .map((r) => ({
        kind: 'restore_need',
        need: r.need,
        per_minute: Number(r.rate.value),
        pause_decay: r.pause.checked,
      }))
}

/** 一个动作的编辑块：名字、时长、用完怎样、恢复什么放在外面；编号、使用条件、消耗与领取、
 *  完成时身体效果收在这个动作自己的「更多」里 */
function actionEditor(catalog: PropCatalog, a: Action, index: number, remove: () => void) {
  const block = el('fieldset', '', 'prop-action-editor')
  block.append(el('legend', `用法 ${index + 1}`))
  const grid = el('div', '', 'prop-form-grid')
  const extra = el('div', '', 'prop-form-grid')
  const actionId = input(a.id, 'action-id'),
    label = input(a.label, 'action-label'),
    duration = numberInput(
      a.duration_minutes,
      'duration',
      String(catalog.capabilities.duration.min),
      String(catalog.capabilities.duration.max),
      'any'
    )
  const completion = select(catalog.capabilities.completions, a.completion, 'completion')
  grid.append(
    field('叫什么（比如「喝水」）', label),
    field('用一次要多久（游戏里的分钟）', duration),
    field('用完会怎样', completion)
  )
  const readNeeds = needEffectRows(catalog, a, grid)
  extra.append(field('编号', actionId))
  const labor = checkbox(
    'labor',
    a.during.some((e) => e.kind === 'labor')
  )
  extra.append(field('劳作时额外消耗精力', labor))
  const conditions = catalog.capabilities.conditions.map((c) => {
    const check = checkbox(c.id, a.conditions.includes(c.id))
    extra.append(field(c.label, check))
    return { id: c.id, check }
  })
  completion.onchange = () => {
    if (completion.value !== 'meal') return
    const c = conditions.find((c) => c.id === 'meal_window')
    if (c) c.check.checked = true
  }
  const consume = checkbox('consumes-item', a.consumes_item ?? false)
  const portion = input(a.portion_name ?? '', 'portion-name')
  extra.append(
    field('用完这件东西就没了（要能放进背包、有完成效果）', consume),
    field('可以领走一份，叫什么（留空不能领）', portion)
  )
  const readBody = bodyEffects(extra, a)
  const more = el('details', '', 'prop-action-more')
  more.append(el('summary', '更多：编号、使用条件、消耗和领取、身体效果'), extra)
  block.append(grid, more, button('去掉这个用法', remove))
  const read = (): Action => ({
    ...readBody(),
    consumes_item: consume.checked,
    portion_name: portion.value.trim() || undefined,
    id: actionId.value.trim(),
    label: label.value.trim(),
    duration_minutes: Number(duration.value),
    completion:
      catalog.capabilities.completions.find((c) => c.id === completion.value)?.id ?? a.completion,
    conditions: conditions.filter((c) => c.check.checked).map((c) => c.id),
    during: [...readNeeds(), ...(labor.checked ? [{ kind: 'labor' as const }] : [])],
  })
  return { block, read }
}

/** 动作列表：增删动作时先把当前表单读回，再整体重画 */
function actionsEditor(catalog: PropCatalog, initial: Action[]) {
  let actions = initial
  const host = el('div', '', 'prop-action-editors')
  let readers: (() => Action)[] = []
  function render() {
    host.replaceChildren()
    readers = actions.map((a, index) => {
      const editor = actionEditor(catalog, a, index, () => {
        actions = readers.map((read) => read())
        actions.splice(index, 1)
        render()
      })
      host.append(editor.block)
      return editor.read
    })
  }
  render()
  const add = button('再加一个用法', () => {
    if (actions.length >= catalog.capabilities.max_actions) return
    actions = readers.map((read) => read())
    actions.push(newAction(actions.length + 1))
    render()
  })
  return { host, add, read: () => readers.map((read) => read()) }
}

/** 外观：预设图形、颜色或自定义图片；只在客户端保存 */
function visualEditor(initial: Appearance) {
  let appearance = structuredClone(initial)
  const visual = el('fieldset', '', 'prop-visual-editor')
  visual.append(el('legend', '样子（只影响画面）'))
  const glyph = select(
    [
      { id: 'box', label: '通用箱体' },
      { id: 'bed', label: '床' },
      { id: 'book', label: '书桌' },
      { id: 'plant', label: '植物' },
      { id: 'machine', label: '机器' },
    ],
    appearance.glyph,
    'appearance-glyph'
  )
  const color = input(appearance.color, 'appearance-color', 'color'),
    image = input('', 'appearance-image', 'file')
  image.accept = 'image/png,image/jpeg,image/webp'
  const preview = svgElement('svg', {
    viewBox: '-35 -30 70 60',
    width: 120,
    height: 100,
    class: 'zoom-detail',
    'aria-label': '外观预览',
    role: 'img',
  })
  const current = (): Appearance =>
    validateAppearance({ ...appearance, glyph: glyph.value, color: color.value })
  const refresh = () => {
    const g = propGlyph('preview', 0, 0, {
      ...appearance,
      glyph: glyph.value as Appearance['glyph'],
      color: color.value,
    })
    g.removeAttribute('role')
    g.removeAttribute('tabindex')
    preview.replaceChildren(g)
  }
  glyph.onchange = refresh
  color.oninput = refresh
  refresh()
  const imageStatus = el(
    'p',
    appearance.image ? '已包含自定义图片' : '可以使用预设图形，也可以导入图片。',
    'prop-muted'
  )
  image.onchange = async () => {
    try {
      const f = image.files?.[0]
      if (!f) return
      if (f.size > 1000000) throw new Error('图片不能超过 1 MB')
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = reject
        r.readAsDataURL(f)
      })
      appearance = validateAppearance({ ...appearance, image: data })
      imageStatus.textContent = '图片已载入'
      refresh()
    } catch (e) {
      imageStatus.textContent = errorText(e)
    }
  }
  visual.append(
    preview,
    field('图形', glyph),
    field('颜色', color),
    field('自定义图片', image),
    imageStatus,
    button('移除图片', () => {
      delete appearance.image
      image.value = ''
      imageStatus.textContent = '使用预设图形'
      refresh()
    })
  )
  return { visual, read: current }
}

export function createEditor(
  host: HTMLElement,
  catalog: PropCatalog,
  source: Definition | null,
  initialAppearance: Appearance | null,
  submit: Submit,
  close: () => void
) {
  host.replaceChildren()
  host.hidden = false
  const form = el('form', '', 'prop-editor-form')
  form.onsubmit = (event) => event.preventDefault()
  const header = el('div', '', 'prop-editor-head')
  header.append(el('h2', source ? '改一改这件道具' : '做一件道具'), button('关闭', close))
  const isCustom = !!source && !source.id.startsWith('core:')
  const d: Definition = source ? structuredClone(source) : newDefinition()
  d.id = isCustom ? d.id : `player:prop_${newId().slice(0, 8)}`
  d.version = isCustom ? d.version + 1 : 1
  const basic = basicFields(d),
    carrying = carryingFields(d),
    content = contentFields(d),
    actions = actionsEditor(catalog, d.actions),
    visual = visualEditor(initialAppearance ?? defaultAppearance)
  const preview = el('div', '点「预览实际效果」，看看村民用它时会发生什么。', 'prop-preview')
  preview.id = 'prop-editor-preview'
  preview.setAttribute('aria-live', 'polite')
  function read() {
    if (!form.reportValidity()) return
    const base = basic.read()
    const definition: Definition = {
      ...d,
      ...base,
      ...carrying.read(),
      actions: actions.read(),
      ...content.read(base.id, base.version),
    }
    return { definition, look: visual.read() }
  }
  const controls = el('div', '', 'prop-editor-controls')
  controls.append(
    button('预览实际效果', () => {
      const v = read()
      if (v) submit('validate_prop', v.definition, v.look)
    }),
    button(
      '保存',
      () => {
        const v = read()
        if (v) submit('save_prop', v.definition, v.look)
      },
      'prop-primary'
    )
  )
  // 按钮条单独占卡片的最后一行，贴着屏幕底边常驻；表单内容都在它上面的 body 里
  const body = el('div', '', 'prop-editor-body')
  const more = el('details', '', 'prop-advanced')
  more.append(
    el('summary', '更多设置：编号、携带、书和公告'),
    basic.idFields,
    carrying.fields,
    content.fields,
    content.note
  )
  body.append(
    header,
    el(
      'p',
      '保存后放进道具库。已经摆在镇上的这件道具不变，新摆出去的才用改过的样子。',
      'prop-muted'
    ),
    basic.fields,
    visual.visual,
    actions.host,
    actions.add,
    more,
    preview
  )
  form.append(body, controls)
  host.append(form)
}
