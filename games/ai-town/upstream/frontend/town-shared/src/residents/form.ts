// 村民模板表单与村民页共用的小部件：字段、输入框、外观标记。
import { el } from '../dom'
import type { TemplateFields } from '../protocol'
import { portraitFor } from '../portraits'
import { createLookEditor, FALLBACK_LOOK } from './look'
import { fieldPicks, tagPicker } from './picks'

const DEFAULT_COLOR = '#b4691e'
export const EMPTY_FIELDS: TemplateFields = {
  name: '',
  age: '',
  gender: '',
  intro: '',
  tags: [],
  personality: '',
  speech: '',
  background: '',
  drives: '',
  interests: '',
  occupation: '',
  appearance: { marker: 'dot', color: DEFAULT_COLOR },
}
/** 模板表单的文字字段：一张表决定建控件、读值、写值三件事；性格标签是一组可点的词，单独处理 */
type TextKey = Exclude<keyof TemplateFields, 'tags' | 'appearance'>
type TextField =
  | { key: 'tags'; label: string; wide: true }
  | {
      key: TextKey
      label: string
      kind: 'input' | 'textarea'
      placeholder?: string
      maxLength?: number
      rows?: number
      wide?: boolean
    }
const TEXT_FIELDS: TextField[] = [
  { key: 'name', label: '姓名', kind: 'input', placeholder: '必填，1–20 字', maxLength: 20 },
  {
    key: 'intro',
    label: '一句话介绍',
    kind: 'input',
    placeholder: '供卡片浏览，不超过 80 字',
    maxLength: 80,
  },
  { key: 'age', label: '年龄', kind: 'input', placeholder: '可选', maxLength: 12 },
  { key: 'gender', label: '性别/称谓', kind: 'input', placeholder: '可选', maxLength: 12 },
  { key: 'tags', label: '性格标签', wide: true },
  {
    key: 'personality',
    label: '性格',
    kind: 'textarea',
    placeholder: '行为倾向，不保证每次决定都符合',
    // 选标签会往这里补句子，留高一点
    rows: 3,
    wide: true,
  },
  { key: 'speech', label: '说话方式', kind: 'textarea', wide: true },
  {
    key: 'background',
    label: '背景',
    kind: 'textarea',
    placeholder: '入村前的自述设定，不写其他村民的私事',
    rows: 4,
    wide: true,
  },
  {
    key: 'drives',
    label: '驱动力',
    kind: 'textarea',
    placeholder: '长期倾向，不是已完成的目标',
    wide: true,
  },
  {
    key: 'interests',
    label: '兴趣与生活偏好',
    kind: 'textarea',
    placeholder: '常去哪里、闲下来做什么',
    wide: true,
  },
  {
    key: 'occupation',
    label: '职业背景',
    kind: 'input',
    placeholder: '可选；不会自动获得资源、职位或技能',
    maxLength: 40,
    wide: true,
  },
]

let fieldSeq = 0
function labelFor(text: string, control: HTMLElement) {
  const name = el('label', text, 'rv-label')
  name.htmlFor = control.id = `rv-field-${++fieldSeq}`
  return name
}
/** 框上方带一排词的栏：外层不能用 label 包，不然点栏名会按到第一个词 */
function pickField(label: string, picks: HTMLElement, control: HTMLElement, wide = false) {
  const wrap = el('div', '', wide ? 'rv-field wide' : 'rv-field')
  wrap.append(labelFor(label, control), picks, control)
  return wrap
}

export function field(label: string, input: HTMLElement, hint = '', wide = false) {
  const wrap = el('label', '', wide ? 'rv-field wide' : 'rv-field')
  wrap.append(el('span', label, 'rv-label'), input)
  if (hint) wrap.append(el('span', hint, 'dim'))
  return wrap
}
export function input(value = '', placeholder = '', maxLength = 200) {
  const i = el('input')
  i.value = value
  i.placeholder = placeholder
  i.maxLength = maxLength
  return i
}
export function textarea(value = '', rows = 3, placeholder = '') {
  const t = el('textarea')
  t.value = value
  t.rows = rows
  t.placeholder = placeholder
  return t
}
/** 前端注册了头像就画头像，否则画外观标记的色点 */
export function marker(key: string, m: string) {
  const url = portraitFor(key)
  if (!url) return el('span', '', `rv-marker m-${m || 'dot'}`)
  const img = el('img', '', 'rv-portrait')
  img.src = url
  img.alt = ''
  return img
}
export function caption(text: string) {
  return el('h3', text, 'section-caption')
}

/** 人设里写给模型的固定说明（host 的 library.rs 生成人设时加的）：玩家不用看 */
const MODEL_NOTES = [
  '以上是来到小镇之前的自述设定，不是小镇里发生过的事。这是本人来到小镇的第一天，具体日期以入村记录为准。',
  '这只是背景，不自动拥有资源、职位、收入或专属权限。',
]
export function personaForPlayer(text: string) {
  return MODEL_NOTES.reduce((t, note) => t.split(note).join(''), text)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 给 AI 看的人设原文：收在折叠里，左边整理好的设定才是给人看的。set 换内容（实时预览） */
export function personaDetails(text: string) {
  const details = el('details', '', 'rv-persona-details')
  const body = el('pre', personaForPlayer(text), 'rv-persona')
  details.append(el('summary', '给 AI 看的人设原文'), body)
  return {
    details,
    set: (next: string) => (body.textContent = personaForPlayer(next)),
  }
}
/** 模板表单：按 TEXT_FIELDS 建控件；collect 读回、fill 写入都走同一张表。长相用捏人编辑器，
 *  排在称谓之后。地图标记、颜色和旧模板里的形象编号像素地图用不上，原样保留不给改。
 *  places 是这个小镇的去处，兴趣栏上方列出来点选。 */
export function templateForm(initial: TemplateFields, onInput: () => void, places: string[]) {
  const form = el('div', '', 'rv-form')
  const controls = new Map<TextKey, HTMLInputElement | HTMLTextAreaElement>()
  // 长相不进人设全文，改了不用重新预览人设
  const looks = createLookEditor(initial.appearance.look ?? FALLBACK_LOOK, () => {})
  for (const f of TEXT_FIELDS) {
    if (f.key === 'tags') continue
    controls.set(
      f.key,
      f.kind === 'input'
        ? input(initial[f.key], f.placeholder, f.maxLength)
        : textarea(initial[f.key], f.rows ?? 2, f.placeholder)
    )
  }
  // 选标签时往性格框里补一句，所以要等性格框建好
  const tags = tagPicker(controls.get('personality'), onInput)
  tags.set(initial.tags)
  const picks = fieldPicks(places)
  for (const f of TEXT_FIELDS) {
    if (f.key === 'tags') {
      const head = el('div', '', 'rv-pick-head')
      head.append(labelFor(f.label, tags.own), tags.count)
      const wrap = el('div', '', 'rv-field wide')
      wrap.append(head, tags.box, tags.groups)
      form.append(wrap)
      continue
    }
    const control = controls.get(f.key)
    if (!control) continue
    const pick = picks[f.key]?.(control)
    form.append(
      pick ? pickField(f.label, pick, control, f.wide) : field(f.label, control, '', f.wide)
    )
    if (f.key === 'gender') {
      const look = el('div', '', 'rv-field wide')
      look.append(el('span', '长相', 'rv-label'), looks.root)
      form.append(look)
    }
  }
  let kept = initial.appearance
  const read = (key: TextKey) => controls.get(key)?.value.trim() ?? ''
  const collect = (): TemplateFields => ({
    name: read('name'),
    age: read('age'),
    gender: read('gender'),
    intro: read('intro'),
    tags: tags.value(),
    personality: read('personality'),
    speech: read('speech'),
    background: read('background'),
    drives: read('drives'),
    interests: read('interests'),
    occupation: read('occupation'),
    appearance: {
      marker: kept.marker || 'dot',
      color: kept.color || DEFAULT_COLOR,
      ...(kept.profile ? { profile: kept.profile } : {}),
      look: looks.value(),
    },
  })
  /** 模型生成的字段填进来；没挑长相时保留现在的。发 input 让各栏的词跟着按下或抬起 */
  const fill = (f: TemplateFields) => {
    for (const [key, control] of controls) {
      control.value = f[key]
      control.dispatchEvent(new Event('input'))
    }
    tags.set(f.tags)
    kept = f.appearance
    if (f.appearance.look) looks.set(f.appearance.look)
  }
  for (const control of controls.values()) control.addEventListener('input', onInput)
  const nameInput = controls.get('name')
  return { form, collect, fill, focusName: () => nameInput?.focus() }
}
