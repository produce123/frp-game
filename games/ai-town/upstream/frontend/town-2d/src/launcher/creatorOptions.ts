import { button, el } from 'town-shared/dom'
import { errorText } from 'town-shared/format'
import { type CreatorContext } from './creatorContext'
import { createPlacePicker } from './creatorPicker'
import { invalidate, setBusy } from './creatorPreview'
import { stepStatus } from './creatorSteps'
import type { Options } from './creatorTypes'

// 地点模板、上限和模型信息：第一次打开建镇页时向管理服务要一次，拿到后建地点选择器；
// 模型状态每次打开都重新问，在首页设定里刚连好的模型这里马上能用。

/** 新建小镇时预先点好的地点 */
const defaultCounts: Record<string, number> = {
  home: 4,
  plaza: 1,
  library: 1,
  canteen: 1,
  park: 1,
  clinic: 1,
}

async function loadOptions(c: CreatorContext) {
  if (c.options) return c.options
  const loaded = await c.request<Options>('/options')
  c.options = loaded
  c.el<HTMLTextAreaElement>('town-description').maxLength = loaded.limits.max_description
  c.picker = createPlacePicker(
    c.el('town-places'),
    c.el('town-selected'),
    c.el('town-counts'),
    [...loaded.templates].sort((a, b) => Number(a.kind === 'area') - Number(b.kind === 'area')),
    loaded.limits,
    () => invalidate(c),
    (text) => c.status(text)
  )
  c.picker.set(
    loaded.templates.flatMap((t) =>
      defaultCounts[t.kind] ? [{ kind: t.kind, size: 'medium', count: defaultCounts[t.kind] }] : []
    )
  )
  c.panel.querySelector<HTMLButtonElement>('[data-place-filter][aria-selected="true"]')?.click()
  setBusy(c, false)
  renderModel(c)
  return loaded
}

/** 一句话规划用哪个模型；没连上时在原处放「连接模型」，连好当场能用，写好的描述不丢 */
export function renderModel(c: CreatorContext) {
  const model = c.options?.model
  const line = c.el('generation-model')
  if (!model) {
    line.replaceChildren()
    return
  }
  if (model.available)
    line.replaceChildren(
      el('span', `用 ${model.provider} · ${model.model} 理解你的描述，点生成时调用一次。`)
    )
  else
    line.replaceChildren(
      el('span', '还没连接模型：连上一个模型服务，就能用一句话建镇。'),
      ...(c.connectModel ? [button('连接模型', () => void connect(c))] : [])
    )
  for (const id of ['parse-town', 'refine-town', 'reparse-town'])
    c.el<HTMLButtonElement>(id).disabled = c.busy || !model.available
  if (c.currentStep === 'basics' && !c.busy) c.status(stepStatus(c))
}

async function connect(c: CreatorContext) {
  if ((await c.connectModel?.()) === 'connected') await refreshModel(c)
}

/** 再问一次模型状态；还没读过选项就整套读 */
export async function refreshModel(c: CreatorContext) {
  if (!c.options) return ensureOptions(c)
  try {
    const latest = await c.request<Pick<Options, 'model'>>('/options')
    if (c.options) c.options.model = latest.model
  } catch {
    // 读不到就沿用上一次的
  }
  renderModel(c)
}

/** 还没有地点模板就去要；失败原因写在地点区域，状态栏一切步骤就会被步骤说明覆盖 */
export function ensureOptions(c: CreatorContext) {
  if (c.options) return
  c.optionsRequest ??= loadOptions(c)
    .catch((error) => {
      const message = document.createElement('p')
      message.className = 'creator-hint'
      message.textContent = `地点列表没有加载出来：${errorText(error)}`
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.textContent = '重试'
      retry.onclick = () => ensureOptions(c)
      c.el('town-places').replaceChildren(message, retry)
      c.status(message.textContent)
    })
    .finally(() => (c.optionsRequest = undefined))
}
