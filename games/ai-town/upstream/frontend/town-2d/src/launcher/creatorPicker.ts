import { PLACE_GROUPS } from './placeGroups'

/** 点选只记录地点种类和数量；尺寸由具体建筑资源和用途自动确定。 */
type Size = 'small' | 'medium' | 'large'
type Place = { kind: string; size: Size; count: number }
type PlaceInput = { kind: string; size?: Size; count: number }
type Selection = { kind: string; count: number }
type Template = { kind: string; name: string }
/** HD-2D 地点、住宅和每种建筑的数量上限。 */
export type CreatorLimits = {
  min_places: number
  max_places: number
  max_homes: number
  max_same_kind: number
  max_by_kind: Record<string, number>
  max_constraints: number
  max_description: number
  capacity_mode: 'count'
}
const largeOutdoorKinds = new Set(['area', 'plaza', 'garden', 'park', 'harbor'])

export function creatorSelectionUsage(selections: Selection[]) {
  return selections.reduce(
    (usage, place) => {
      usage.places += place.count
      if (place.kind === 'home') usage.homes += place.count
      return usage
    },
    { places: 0, homes: 0 }
  )
}

/**
 * TownSpec 暂时仍需要 size 字段。这里只生成内部兼容值：
 * 真实建筑使用资源实测宽深，住宅数量超过一栋时自动混排不同户型。
 */
function automaticPlaces(selections: Selection[]): Place[] {
  return selections.flatMap(({ kind, count }) => {
    if (kind !== 'home')
      return [{ kind, count, size: largeOutdoorKinds.has(kind) ? 'large' : 'medium' }]
    const counts: Record<Size, number> = { small: 0, medium: 0, large: 0 }
    const sequence: Size[] = ['medium', 'small', 'large']
    for (let i = 0; i < count; i++) counts[sequence[i % sequence.length]]++
    return sequence
      .filter((size) => counts[size])
      .map((size) => ({ kind, size, count: counts[size] }))
  })
}
const icons: Record<string, string> = {
  inn: 'M3 21V9l9-6 9 6v12M7 21v-7h10v7M7 10h2m6 0h2',
  hotel: 'M5 21V3h14v18M9 7h1m4 0h1M9 11h1m4 0h1M10 21v-6h4v6',
  club: 'M3 21h18M5 21V9l7-6 7 6v12M8 14a2 2 0 1 0 4 0m1 4h4',
  theatre: 'M3 5h18v16H3zM3 5l5 8-5 4m18-12-5 8 5 4M9 21v-6h6v6',
  colonnade: 'm2 8 10-5 10 5H2M5 10v9m5-9v9m4-9v9m5-9v9M2 21h20',
  lighthouse: 'M7 21 9 8h6l2 13M8 8V5l4-3 4 3v3M3 5l3 1m12 0 3-1M8 15h8M10 21v-3h4v3',
  temple: 'm2 7 10-5 10 5H2M5 9v9m5-9v9m4-9v9m5-9v9M3 18h18M2 21h20',
  court: 'M3 7a9 9 0 0 0 18 0M5 7a7 7 0 0 0 14 0M8 7a4 4 0 0 0 8 0M3 19h18m-15 3h12',
  ferris:
    'M12 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 2v16M4 10h16M6 4l12 12M18 4 6 16M12 10 7 22m5-12 5 12M5 22h14',
  carousel: 'm3 9 9-6 9 6H3M5 9v11m14-11v11M12 3V1m0 2v17M3 21h18M7 15h3m4 0h3',
  obelisk: 'M9 18 10 5l2-3 2 3 1 13M7 18h10v3H7zM4 22h16',
  fountain:
    'M3 18h18l-2 4H5zM12 18V5m-6 8h12l-2 3H8zm0-4c0-6 6-6 6-1m0 0c0-5 6-5 6 1M9 6c0-5 6-5 6 0',
  tree: 'm12 2-5 7h3l-5 7h6v6h2v-6h6l-5-7h3L12 2',
  bed: 'M3 21V5m0 11h18v5M3 9h6v7m0-7h10a2 2 0 0 1 2 2v5',
  food: 'M3 11h18a9 9 0 0 1-18 0M3 3l18 18',
  water: 'M12 3C9 7 5 11 5 15a7 7 0 0 0 14 0c0-4-4-8-7-12M3 3l18 18',
  rest: 'M3 21V5m0 11h18v5M3 9h6v7m0-7h10a2 2 0 0 1 2 2v5M3 3l18 18',
  poison: 'M3 8h18v12H3zM8 12h1m6 0h1m-7 5 3-2 3 2',
  home: 'M3 11 12 3l9 8M5 10v11h5v-7h4v7h5V10',
  townhall: 'M3 21V8l9-5 9 5v13M7 11h10M8 21v-6h8v6M12 3v5',
  warehouse: 'M3 21V8l9-5 9 5v13M7 21v-8h10v8M9 16h2m2 0h2',
  plaza: 'M4 4h16v16H4zM12 7v4m-3 3a3 3 0 1 0 6 0 3 3 0 0 0-6 0',
  library: 'm3 8 9-5 9 5H3m3 2v9m4-9v9m4-9v9m4-9v9M3 21h18',
  canteen: 'M3 11h18a9 9 0 0 1-18 0m4-7v3m5-3v3m5-3v3',
  clinic: 'M4 4h16v16H4zM12 8v8m-4-4h8',
  workshop: 'm3 20 9-9m-3-7a6 6 0 0 0 8 8l4-4-5 1-1-5-6 0',
  cafe: 'M4 8h12v7a6 6 0 0 1-12 0V8m12 1h3a3 3 0 0 1 0 6h-3M3 22h16M8 3v2m4-2v2',
  garden: 'M12 21V9m0 8c-6 0-9-3-9-7 6 0 9 3 9 7m0-4c6 0 9-3 9-7-6 0-9 3-9 7',
  park: 'm9 3-6 9h4l-4 5h12l-4-5h4L9 3m0 14v5m9-9v9m-2-5h6',
  market: 'M4 10v11h16V10M3 10l2-7h14l2 7H3m6-7-1 7m7-7 1 7M9 21v-7h6v7',
  harbor: 'M12 6v15m-7-9H2c0 6 5 9 10 9s10-3 10-9h-3M7 10h10M10 4a2 2 0 1 0 4 0 2 2 0 0 0-4 0',
  area: 'M3 9V3h6m6 0h6v6m0 6v6h-6m-6 0H3v-6M9 12h6m-3-3v6',
}
function icon(kind: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = `<path d="${icons[kind] ?? icons.home}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
  return svg
}
export function mountChoiceCards(panel: HTMLElement) {
  panel.querySelectorAll<HTMLElement>('[data-choice-for]').forEach((group) => {
    const select = panel.querySelector<HTMLSelectElement>(`#${group.dataset.choiceFor}`)!
    group.querySelectorAll<HTMLButtonElement>('button[data-value]').forEach((button) => {
      const glyph = button.querySelector('span')
      const resourceIcons: Record<string, string> = {
        'normal-life': 'bed',
        'no-food': 'food',
        'no-water': 'water',
        'no-rest': 'rest',
        'poisoned-food': 'poison',
      }
      if (glyph && group.dataset.choiceFor === 'town-resources')
        glyph.replaceChildren(icon(resourceIcons[button.dataset.value!] ?? 'home'))
      if (glyph && group.dataset.choiceFor === 'town-vegetation') {
        const count =
          button.dataset.value === 'dense' ? 3 : button.dataset.value === 'medium' ? 2 : 1
        glyph.replaceChildren(...Array.from({ length: count }, () => icon('tree')))
      }
      button.onclick = () => {
        select.value = button.dataset.value!
        group
          .querySelectorAll('button[data-value]')
          .forEach((b) => b.setAttribute('aria-pressed', String(b === button)))
        select.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
  })
}
type Usage = ReturnType<typeof creatorSelectionUsage>
type PlaceButton = {
  button: HTMLButtonElement
  badge: HTMLElement
  kind: string
}

/** 现在不能再加这种地点的原因；能加返回空字符串 */
function limitReason(limits: CreatorLimits, kind: string, kindCount: number, usage: Usage) {
  if (usage.places >= limits.max_places) return `地点已达 ${limits.max_places} 处上限`
  if (kind === 'home' && usage.homes >= limits.max_homes)
    return `住宅已达 ${limits.max_homes} 处上限`
  const maximum = limits.max_by_kind[kind] ?? limits.max_same_kind
  if (kindCount >= maximum) return `该地点已达 ${maximum} 处上限`
  return ''
}

/** 已选地点数量与上限。 */
function capacityMeter(counts: HTMLElement) {
  const header = document.createElement('div')
  header.className = 'creator-capacity-header'
  const label = document.createElement('span')
  const value = document.createElement('strong')
  header.append(label, value)
  const track = document.createElement('div')
  track.className = 'creator-capacity-track'
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-valuemin', '0')
  const fill = document.createElement('i')
  track.append(fill)
  const detail = document.createElement('small')
  counts.replaceChildren(header, track, detail)
  return (usage: Usage, limits: CreatorLimits) => {
    const state = usage.places >= limits.max_places ? 'full' : 'normal'
    counts.dataset.state = state
    label.textContent = '地点'
    value.textContent = `${usage.places} / ${limits.max_places}${state === 'full' ? ' · 已满' : ''}`
    track.setAttribute('aria-valuemax', String(limits.max_places))
    track.setAttribute('aria-valuenow', String(usage.places))
    fill.style.width = `${Math.min(100, (usage.places / limits.max_places) * 100)}%`
    detail.textContent = `住宅 ${usage.homes} / ${limits.max_homes} · 可住 ${usage.homes} 人`
  }
}

/** 每种地点一张卡片，点一下加一处 */
function placeButton(template: Template, add: () => void): PlaceButton {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'creator-place-card'
  button.setAttribute('aria-label', `加一处${template.name}`)
  const name = document.createElement('span')
  name.textContent = template.name
  const badge = document.createElement('b')
  button.append(icon(template.kind), name, badge)
  button.onclick = add
  return { button, badge, kind: template.kind }
}

/** 按分组排出卡片，每组前面一个标题。 */
function layoutGroups(grid: HTMLElement, buttons: PlaceButton[]) {
  grid.replaceChildren()
  for (const group of PLACE_GROUPS) {
    const heading = document.createElement('div')
    heading.className = 'creator-place-heading'
    heading.dataset.placeGroup = group.id
    const title = document.createElement('h4')
    title.textContent = group.name
    const hint = document.createElement('small')
    hint.textContent = group.hint
    heading.append(title, hint)
    const kinds: readonly string[] = group.kinds
    const groupButtons = buttons.filter((b) => kinds.includes(b.kind)).map((b) => b.button)
    groupButtons.forEach((button) => (button.dataset.placeGroup = group.id))
    grid.append(heading, ...groupButtons)
  }
}

/** 卡片上的数量与可添加状态。 */
function renderButton({ button, badge }: PlaceButton, name: string, count: number, reason: string) {
  badge.textContent = String(count)
  badge.hidden = count === 0
  button.classList.toggle('has-places', count > 0)
  button.disabled = Boolean(reason)
  button.title = reason || `加一处${name}`
  button.setAttribute('aria-label', reason ? `${name}：${reason}` : `加一处${name}`)
}

/** 已选地点：每种一个标签，点减号去掉一处 */
function selectedTokens(
  selections: Selection[],
  nameOf: (kind: string) => string,
  removeOne: (place: Selection) => void
) {
  return selections.map((place) => {
    const name = nameOf(place.kind)
    const token = document.createElement('span')
    token.className = 'creator-place-token'
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '−'
    remove.setAttribute('aria-label', `去掉一处${name}`)
    remove.onclick = () => removeOne(place)
    token.append(`${name} ×${place.count}`, remove)
    return token
  })
}

export function createPlacePicker(
  grid: HTMLElement,
  selected: HTMLElement,
  counts: HTMLElement,
  templates: Template[],
  initialLimits: CreatorLimits,
  changed: () => void,
  status: (text: string) => void
) {
  let selections: Selection[] = []
  let limits = initialLimits
  const nameOf = (kind: string) => templates.find((t) => t.kind === kind)?.name ?? kind
  const meter = capacityMeter(counts)
  const buttons = templates.map((template) =>
    placeButton(template, () => {
      const usage = creatorSelectionUsage(selections)
      const place = selections.find((p) => p.kind === template.kind)
      const reason = limitReason(limits, template.kind, place?.count ?? 0, usage)
      if (reason) {
        status(`${reason}，请先减掉一处。`)
        return
      }
      if (place) place.count++
      else selections.push({ kind: template.kind, count: 1 })
      render()
      changed()
    })
  )
  layoutGroups(grid, buttons)
  const removeOne = (place: Selection) => {
    place.count--
    selections = selections.filter((p) => p.count > 0)
    render()
    changed()
  }
  function render() {
    const usage = creatorSelectionUsage(selections)
    meter(usage, limits)
    for (const b of buttons) {
      const count = selections.find((p) => p.kind === b.kind)?.count ?? 0
      renderButton(b, nameOf(b.kind), count, limitReason(limits, b.kind, count, usage))
    }
    selected.replaceChildren(...selectedTokens(selections, nameOf, removeOne))
    if (!usage.places) selected.textContent = '还没有地点，点上面的图标添加。'
  }
  return {
    value: () => automaticPlaces(selections),
    selection: () => selections.map((p) => ({ ...p })),
    setLimits: (next: CreatorLimits) => {
      limits = next
      render()
    },
    set: (value: PlaceInput[]) => {
      const merged = new Map<string, number>()
      for (const place of value) merged.set(place.kind, (merged.get(place.kind) ?? 0) + place.count)
      selections = [...merged].map(([kind, count]) => ({ kind, count }))
      render()
    },
  }
}
