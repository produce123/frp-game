import type { AgentLimitRanges, AgentLimits, AgentUsage, ServerMsg } from '../protocol'
import { statusLine } from '../dom'
import type { SettingsPage } from '../settingsCenter'
import { displayClock } from '../format'
import { $, htmlText, type PageDeps } from './page'
import { formatLimit, parseLimit, roughCount } from './limitsNumbers'
import { blendedPerMillion, costOf, yuan, type Price } from '../pricing'
import './limits.css'

// 花费上限页：先问「最多花多少钱」，按小镇默认模型公布的价格换算成 token 额度；调用次数、token 和
// 出错时的几项收在「高级设置」里。价格没收录时只能按 token 设，高级设置默认展开。
// 显示今天的用量与暂停原因，修改即时生效并随存档保存。额度用尽会让全镇暂停；改完回地图点开始才继续。
// 各项的取值范围随额度一起由后端给出，这里不另抄一份。

interface Field {
  key: keyof AgentLimits
  label: string
  unit: string
  hint: string
}

/** prefix 写在校验提示里的名字前面，如「每人每天 token」 */
const GROUPS: { caption: string; prefix: string; fields: Field[] }[] = [
  {
    caption: '每人每天',
    prefix: '每人每天 ',
    fields: [
      { key: 'calls_per_day', label: '调用次数', unit: '次', hint: '' },
      {
        key: 'tokens_per_day',
        label: 'token',
        unit: 'token',
        hint: '含在途预留；不能小于上下文窗口加单次输出上限',
      },
    ],
  },
  {
    caption: '整个存档（重置世界时清零）',
    prefix: '整个存档 ',
    fields: [
      { key: 'total_calls', label: '调用次数', unit: '次', hint: '' },
      { key: 'total_tokens', label: 'token', unit: 'token', hint: '不能小于每人每天 token' },
    ],
  },
  {
    caption: '出错时',
    prefix: '',
    fields: [
      {
        key: 'calls_per_wake',
        label: '一次唤醒最多调用',
        unit: '次',
        hint: '达到后等 30 分钟再唤醒这个人，世界不停',
      },
      {
        key: 'stale_replies_before_pause',
        label: '连续过时回复',
        unit: '次',
        hint: '达到后只停这个人的请求，世界不停',
      },
      {
        key: 'model_failures_before_pause',
        label: '连续模型出错',
        unit: '次',
        hint: '达到后按故障暂停全镇',
      },
    ],
  },
]
const FIELDS = GROUPS.flatMap(({ prefix, fields }) =>
  fields.map((f) => ({ ...f, full: prefix + f.label }))
)

/** 取值不合规时的说明；合规返回空串 */
function outOfRange(value: number, range: AgentLimitRanges[keyof AgentLimits], name: string) {
  const inside =
    Number.isSafeInteger(value) && value >= range.min && (range.max === null || value <= range.max)
  if (inside) return ''
  return range.max === null
    ? `「${name}」须是不小于 ${formatLimit(range.min)} 的整数`
    : `「${name}」须是 ${formatLimit(range.min)} 到 ${formatLimit(range.max)} 之间的整数`
}

/** 用钱设的两项：每人每天、整个存档的 token 额度 */
const MONEY: { key: 'tokens_per_day' | 'total_tokens'; label: string }[] = [
  { key: 'tokens_per_day', label: '每位村民每个游戏日最多花' },
  { key: 'total_tokens', label: '这个存档一共最多花' },
]

export function createLimitsPage(
  deps: PageDeps,
  /** 小镇默认模型的价格；价格没收录时为 null */
  townPrice: () => Price | null
): SettingsPage {
  const el = document.createElement('section')
  el.className = 'spage limits-page'
  el.innerHTML = `
    <h2>花费上限</h2>
    <p class="hint">到了上限全镇先暂停，人、东西和用量都原样留着；改完上限回地图点「开始」接着跑。记忆整理不够额度时只推迟整理。</p>
    <p class="lim-usage"><span class="lim-today dim">今天已用：尚未读取</span>
      <button type="button" class="lim-open-usage">在「消耗」页看明细</button></p>
    <div class="lim-paused"></div>
    <div class="lim-money">${MONEY.map(
      (m) => `<label class="lim-field" for="lim-money-${m.key}"><span>${htmlText(m.label)}</span>
        <span class="lim-input"><span class="lim-unit">¥</span><input id="lim-money-${m.key}" data-money="${m.key}" type="text" inputmode="decimal" spellcheck="false"></span></label>`
    ).join('')}
      <p class="lim-hint lim-money-hint"></p></div>
    <details class="lim-advanced"><summary>高级设置：调用次数、token、出错时</summary>
    ${GROUPS.map(
      (group) => `<h3 class="section-caption">${htmlText(group.caption)}</h3>
      <div class="lim-grid">${group.fields
        .map(
          (f) => `<label class="lim-field" for="lim-${f.key}"><span>${htmlText(f.label)}</span>
          <span class="lim-input"><input id="lim-${f.key}" data-k="${f.key}" type="text" inputmode="numeric" spellcheck="false"><span class="lim-unit">${htmlText(f.unit)}</span></span>
          ${f.hint ? `<span class="lim-hint">${htmlText(f.hint)}</span>` : ''}</label>`
        )
        .join('')}</div>`
    ).join('')}
    <p class="hint">并发请求数和上下文窗口不在这里改，它们需要重启后生效。</p></details>
    <div class="page-status" role="status"></div>`
  const status = $<HTMLElement>(el, '.page-status')
  const today = $<HTMLElement>(el, '.lim-today')
  const paused = $<HTMLElement>(el, '.lim-paused')
  // 离开设定中心再打开「消耗」页；有未保存修改时由外壳先问
  $<HTMLButtonElement>(el, '.lim-open-usage').onclick = deps.openUsage
  const inputs = new Map<keyof AgentLimits, HTMLInputElement>()
  for (const inp of el.querySelectorAll<HTMLInputElement>('input[data-k]'))
    inputs.set(inp.dataset.k as keyof AgentLimits, inp)
  const money = new Map<'tokens_per_day' | 'total_tokens', HTMLInputElement>()
  for (const inp of el.querySelectorAll<HTMLInputElement>('input[data-money]'))
    money.set(inp.dataset.money as 'tokens_per_day' | 'total_tokens', inp)
  const moneyBox = $<HTMLElement>(el, '.lim-money')
  const moneyHint = $<HTMLElement>(el, '.lim-money-hint')
  const advanced = $<HTMLDetailsElement>(el, '.lim-advanced')
  /** 钱框里上次填进去的数（元，两位小数的文字）：没改过就按 token 框的值保存 */
  const shownMoney = new Map<string, string>()
  const toYuan = (tokens: number, price: Price) =>
    ((tokens * blendedPerMillion(price)) / 1e6).toFixed(2)
  const toTokens = (value: string, price: Price) =>
    Math.round((Number(value) / blendedPerMillion(price)) * 1e6)

  let saved: AgentLimits | null = null
  let ranges: AgentLimitRanges | null = null
  let dirty = false
  const setStatus = statusLine(status)

  function fill(l: AgentLimits) {
    for (const [k, inp] of inputs) inp.value = formatLimit(l[k])
    for (const inp of inputs.values()) inp.classList.remove('err')
    const price = townPrice()
    moneyBox.hidden = !price
    // 价格没收录：只能按 token 设，把高级设置打开
    if (!price) advanced.open = true
    if (!price) return
    for (const [k, inp] of money) {
      inp.value = toYuan(l[k], price)
      shownMoney.set(k, inp.value)
      inp.classList.remove('err')
    }
    moneyHint.textContent =
      '按小镇默认模型公布的价格估算，换算成 token 额度保存；实际花费以服务商的账单为准。'
  }
  function renderUsage(u: AgentUsage) {
    const calls = u.residents.reduce((sum, r) => sum + r.daily_calls, 0)
    const tokens = u.residents.reduce((sum, r) => sum + r.daily_tokens, 0)
    const price = townPrice()
    const spent =
      price &&
      u.residents.reduce(
        (sum, r) =>
          sum +
          costOf(price, {
            input: r.daily_input_tokens ?? 0,
            hit: r.daily_cache_hit_tokens ?? 0,
            total: r.daily_tokens,
          }),
        0
      )
    today.textContent =
      spent === null
        ? `今天已用：${calls.toLocaleString('en-US')} 次 · ${roughCount(tokens)} token`
        : `这个游戏日全镇大约花了 ${yuan(spent)}`
    paused.replaceChildren(
      ...u.residents.flatMap((r) => {
        if (!r.paused) return []
        const line = document.createElement('p')
        line.className = 'drop'
        line.textContent = displayClock(`${r.name} 已停止：${r.paused}`)
        return [line]
      })
    )
  }
  const changed = () => {
    const s = saved
    dirty =
      s !== null &&
      ([...inputs.entries()].some(([k, i]) => parseLimit(i.value) !== s[k]) ||
        [...money.entries()].some(([k, i]) => i.value.trim() !== shownMoney.get(k)))
    deps.onDirty()
  }
  for (const inp of [...inputs.values(), ...money.values()]) inp.addEventListener('input', changed)

  return {
    id: 'limits',
    group: 'model',
    navLabel: '花费上限',
    title: '花费上限',
    el,
    isDirty: () => dirty,
    save() {
      if (!saved || !ranges) {
        setStatus('额度尚未加载，稍后再试', 'drop')
        return
      }
      const next = { ...saved }
      // 改过的钱框换算成 token 额度，写回高级设置里对应的框，再一起校验
      const price = townPrice()
      if (price)
        for (const [k, inp] of money) {
          if (inp.value.trim() === shownMoney.get(k)) continue
          const value = Number(inp.value.trim())
          inp.classList.remove('err')
          if (!Number.isFinite(value) || value <= 0) {
            inp.classList.add('err')
            setStatus('金额要填大于 0 的数字', 'drop')
            return
          }
          inputs.get(k)!.value = formatLimit(toTokens(inp.value.trim(), price))
        }
      for (const f of FIELDS) {
        const inp = inputs.get(f.key)
        if (!inp) continue
        const x = parseLimit(inp.value)
        inp.classList.remove('err')
        const problem = outOfRange(x, ranges[f.key], f.full)
        if (problem) {
          inp.classList.add('err')
          setStatus(problem, 'drop')
          return
        }
        next[f.key] = x
      }
      // 先写「保存中…」：没连上时回执立刻回来，结果不能被它盖掉
      setStatus('保存中…')
      deps.save({ type: 'set_agent_limits', limits: next }, (ok, message) => {
        if (ok) {
          saved = next
          dirty = false
          fill(next)
          deps.onDirty()
        }
        setStatus((ok ? '✓ ' : '✗ ') + message, ok ? 'ok' : 'drop')
      })
    },
    discard() {
      if (!saved) return
      dirty = false
      fill(saved)
      setStatus('已放弃修改，恢复为当前生效的额度')
      deps.onDirty()
    },
    onShow() {
      deps.send({ type: 'get_agent_limits' })
    },
    handleMsg(msg: ServerMsg) {
      if (msg.type !== 'agent_limits') return
      saved = msg.limits
      ranges = msg.ranges
      renderUsage(msg.usage)
      if (!dirty) fill(saved)
    },
  }
}
