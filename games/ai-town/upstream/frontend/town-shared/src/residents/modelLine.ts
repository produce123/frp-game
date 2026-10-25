// 请人入住时写明用哪个模型：「用 DeepSeek · deepseek-chat 思考」。连了几个服务时能换，
// 一个都没连时说明会先住下，并给「连接模型」。村民库托盘、空镇卡片共用。
import { button, el } from '../dom'
import type { ModelOption } from '../models/session'

export function modelLine(o: {
  options: ModelOption[]
  current: ModelOption | null
  choose: (option: ModelOption) => void
  connect: () => void
}): HTMLElement {
  const line = el('span', '', 'model-line')
  if (!o.current) {
    line.append(
      '还没连模型：他们会先住下，连上后才开始行动。',
      button('连接模型', o.connect, 'ui-link')
    )
    return line
  }
  line.append(`用 ${o.current.name} · ${o.current.model} 思考，以后可以给每个人单独换。`)
  if (o.options.length > 1) {
    const pick = el('select')
    pick.setAttribute('aria-label', '换一个模型')
    o.options.forEach((option, i) =>
      pick.append(
        new Option(`${option.name} · ${option.model}`, String(i), false, option === o.current)
      )
    )
    pick.onchange = () => {
      const option = o.options[Number(pick.value)]
      if (option) o.choose(option)
    }
    line.append(pick)
  }
  return line
}
