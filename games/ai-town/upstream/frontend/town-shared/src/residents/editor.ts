// 创建与编辑人物模板：一句话描述让模型生成，表单里只有姓名必填，右侧实时预览人设全文。
import { button, el } from '../dom'
import { newId } from '../ids'
import type { ResidentTemplate, ServerMsg, TemplateFields } from '../protocol'
import { EMPTY_FIELDS, personaDetails, templateForm, textarea } from './form'
import { lookFor } from './look'
import type { ResidentsContext, ResidentsTab, ViewHandle } from './state'

/** 人设预览在停止输入这么久之后才请求 */
const PERSONA_DELAY_MS = 350

function aiBox(ctx: ResidentsContext) {
  const ai = el('div', '', 'rv-ai')
  const brief = textarea('', 2, '例如：一个爱钓鱼、话不多的老渔夫，早起晚归，喜欢在渔港待着')
  const aiStatus = el('span', '', 'dim')
  const gen = button(
    '用模型生成',
    () => {
      const editor = ctx.state.editor
      if (!brief.value.trim() || !editor) return
      const request_id = newId()
      editor.generating = request_id
      aiStatus.textContent = '正在生成，通常十几秒…'
      gen.disabled = true
      ctx.deps.send({ type: 'generate_resident_template', request_id, brief: brief.value.trim() })
    },
    'primary'
  )
  const aiRow = el('div', '', 'row')
  aiRow.append(gen, aiStatus)
  ai.append(
    el('strong', '用一句话描述这个人，让模型帮你填'),
    brief,
    aiRow,
    el(
      'span',
      '调用一次模型，不算进村民的花费上限；生成的内容只填进表单，保存前可以随意改。',
      'dim'
    )
  )
  return { ai, aiStatus, gen }
}

export function renderEditor(
  ctx: ResidentsContext,
  existing?: ResidentTemplate,
  copyFrom?: TemplateFields,
  from: ResidentsTab = 'library'
): ViewHandle {
  const { deps, state } = ctx
  const fields = existing?.fields ?? copyFrom ?? EMPTY_FIELDS
  // 长相从现在的样子起步：没捏过的模板按自己的编号出长相，新建的随机一套
  const base: TemplateFields = {
    ...fields,
    appearance: {
      ...fields.appearance,
      look: fields.appearance.look ?? lookFor(existing?.template_id ?? `new:${newId()}`),
    },
  }
  const box = el('div', '', 'rv-detail')
  box.append(button(from === 'roster' ? '← 返回村中居民' : '← 返回村民库', () => ctx.setTab(from)))
  box.append(
    el('h2', existing ? `编辑 ${existing.fields.name}` : copyFrom ? '复制并修改' : '新建村民')
  )
  box.append(el('p', '只有名字必填。可以先写一句话让模型把其余的都填好，再慢慢改。', 'dim'))
  const status = el('p', '', 'page-status')
  const { ai, aiStatus, gen } = aiBox(ctx)
  box.append(ai)
  let debounce: number | undefined
  const requestPersona = () => {
    window.clearTimeout(debounce)
    debounce = window.setTimeout(
      () => deps.send({ type: 'preview_template_persona', fields: form.collect() }),
      PERSONA_DELAY_MS
    )
  }
  const form = templateForm(base, requestPersona, deps.placeNames())
  const persona = personaDetails('填写姓名后，这里实时显示给 AI 看的人设')
  const save = (joinAfter: boolean) => {
    if (!state.editor) return
    const fields = form.collect()
    if (!fields.name) {
      ctx.setStatus(status, '姓名必填', true)
      form.focusName()
      return
    }
    state.editor.joinAfterSave = joinAfter
    state.editor.saving = newId()
    ctx.setStatus(status, '保存中…')
    deps.send({
      type: 'save_resident_template',
      request_id: state.editor.saving,
      template_id: existing?.template_id,
      expected_version: existing?.version,
      fields,
    })
  }
  const actions = el('div', '', 'row')
  // 从村中居民来新建：就是要请人进镇，「保存并加入小镇」做主按钮
  const joinFirst = from === 'roster' && !existing
  actions.append(
    joinFirst
      ? button('保存并加入小镇', () => save(true), 'primary')
      : button('保存到村民库', () => save(false), 'primary'),
    joinFirst
      ? button('只存进村民库', () => save(false))
      : button('保存并加入小镇', () => save(true)),
    button('取消', () => ctx.setTab(from))
  )
  // 保存按钮放在人设原文上面：原文很长，放下面会被挤出第一屏
  const right = el('div', '', 'rv-sticky')
  right.append(status, actions, persona.details)
  const split = el('div', '', 'rv-split')
  split.append(form.form, right)
  box.append(split)
  state.editor = {
    persona,
    status,
    aiStatus,
    gen,
    fill: (f) => {
      form.fill(f)
      requestPersona()
    },
    generating: null,
    saving: null,
    joinAfterSave: false,
  }
  if (base.name) requestPersona()
  return { root: box }
}

/** 编辑器相关的回包：保存结果、人设预览、模型生成的字段 */
export function handleEditorMsg(ctx: ResidentsContext, msg: ServerMsg): boolean {
  const { state, deps } = ctx
  const editor = state.editor
  // 编辑器的保存按请求编号认领；归档等其他保存的结果写进事件栏
  if (msg.type === 'template_saved') {
    const fromEditor = !!editor && editor.saving === msg.request_id
    if (editor && fromEditor) editor.saving = null
    if (msg.ok) {
      deps.events.pushLocal(msg.message)
      const joinAfter = fromEditor && (editor?.joinAfterSave ?? false)
      if (state.view.kind === 'editor' || state.view.kind === 'template') {
        if (msg.template && joinAfter) ctx.startJoin(msg.template.template_id)
        else if (msg.template) ctx.showTemplate(msg.template.template_id)
        else ctx.setTab('library')
      }
      ctx.requestLibrary()
    } else if (editor && fromEditor) ctx.setStatus(editor.status, `✗ ${msg.message}`, true)
    else deps.events.pushLocal(`✗ ${msg.message}`, true)
    return true
  }
  if (msg.type === 'error' && editor?.saving && msg.request_id === editor.saving) {
    editor.saving = null
    ctx.setStatus(editor.status, `✗ ${msg.message}`, true)
    return true
  }
  if (msg.type === 'template_persona') {
    if (!editor) return true
    editor.persona.set(msg.persona || '填写姓名后，这里实时显示给 AI 看的人设')
    if (msg.error) ctx.setStatus(editor.status, msg.error, true)
    else if (editor.status.className.includes('drop')) ctx.setStatus(editor.status, '')
    return true
  }
  if (msg.type === 'template_generated') {
    if (!editor || editor.generating !== msg.request_id) return true
    editor.generating = null
    editor.gen.disabled = false
    if (msg.ok && msg.fields) {
      editor.fill(msg.fields)
      editor.aiStatus.textContent = `✓ ${msg.message}`
    } else editor.aiStatus.textContent = `✗ ${msg.message}`
    return true
  }
  return false
}
