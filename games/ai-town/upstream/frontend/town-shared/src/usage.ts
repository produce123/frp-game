import { observationPage } from './observationPage'
import type {
  ClientMsg,
  RequestKind,
  RequestStatus,
  RequestView,
  ResidentUsage,
  ServerMsg,
  UsageSummary,
} from './protocol'
import { $, el } from './dom'
import { iconLabel } from './game/icons'
import type { RosterFrame } from './shell/panel'
import { requestKindLabels, requestStatusLabels } from './labels'
import { displayClock } from './format'
import { blendedPerMillion, costOf, yuan, type Price } from './pricing'
// 消耗页：整页替换地图页，只读。先给钱：这个游戏日全镇大约花了多少、这个小镇一共多少、每人每天的上限，
// 再按村民列花费；调用次数、token 和最近请求台账（新的在前，可按人、类型、结果筛选）收在「详细数据」里。
// 金额按服务商公布的价格估算（pricing.ts），价格没收录的服务不算钱。
// 数据全部来自服务端的 usage 消息，每 2 秒拉一次；内容没变就不重画，免得打断滚动。

interface UsageDeps {
  send: (obj: ClientMsg) => void
  onBack: () => void
  /** 游戏界面：消耗页是地图上的小窗 */
  game: boolean
  /** 这位村民用的模型的价格；不给编号时是小镇默认模型的。价格没收录时为 null */
  price: (residentId?: string) => Price | null
}

type UsageMsg = Extract<ServerMsg, { type: 'usage' }>
interface Filter {
  resident: string
  kind: RequestKind | ''
  status: RequestStatus | ''
}

/** 村民 Agent 工具的中文名，与 crates/agent 的 ToolName 一一对应 */
const toolLabels: Record<string, string> = {
  context_read: '读取上下文来源',
  memory_search: '搜索记忆',
  memory_read: '读取记忆原文',
  reflect: '整理记忆',
  read_content: '回看读过的正文',
  observe: '观察',
  recall: '回想',
  inspect: '查看',
  set_goal: '记录目标',
  run_actions: '行动',
  interact: '聊天',
  offer_invitation: '发起邀请',
  reply_invitation: '回应邀请',
  wait_for: '等待',
}
/** 说明列里的工具名换成中文；不认识的词保留原样 */
const detailText = (text: string) => text.replace(/\b[a-z_]+\b/g, (w) => toolLabels[w] ?? w)

const n = (v: number | undefined) => (v === undefined ? '—' : v.toLocaleString())
const rate = (hit: number, input: number) =>
  input > 0 ? `${Math.round((hit / input) * 100)}%` : '—'
const wall = (unix: number) => {
  const d = new Date(unix * 1000)
  const two = (x: number) => String(x).padStart(2, '0')
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

function card(label: string, value: string, hint = '') {
  const c = el('div', '', 'us-card')
  c.append(el('div', label, 'dim'), el('strong', value))
  if (hint) c.append(el('div', hint, 'dim'))
  return c
}

function headerRow(labels: string[]) {
  const head = el('tr')
  for (const h of labels) head.append(el('th', h))
  return head
}

/** 下拉：第一项是「全部」，当前值对应的项选中；name 是手机上列表的标题 */
function select(name: string, all: string, options: [string, string][], current: string) {
  const s = el('select')
  s.setAttribute('aria-label', name)
  s.append(new Option(all, '', false, current === ''))
  for (const [v, label] of options) s.append(new Option(label, v, false, current === v))
  s.value = current
  return s
}

function summaryCards(s: UsageSummary) {
  const cards = el('div', '', 'us-cards')
  cards.append(
    card('今天调用', n(s.today_calls), `全镇合计；每人每日上限 ${n(s.calls_per_day)}`),
    card(
      '今天 token',
      n(s.today_tokens),
      `全镇合计；每人每日上限 ${n(s.tokens_per_day)} · 缓存命中 ${rate(s.today_cache_hit_tokens, s.today_input_tokens)}`
    ),
    card('累计调用', `${n(s.lifetime_calls)} / ${n(s.total_calls)}`, '本存档累计'),
    card(
      '累计 token',
      `${n(s.lifetime_tokens)} / ${n(s.total_tokens)}`,
      `缓存命中 ${rate(s.lifetime_cache_hit_tokens, s.lifetime_input_tokens)}`
    ),
    card('在途请求', String(s.in_flight), '正在等模型回复')
  )
  return cards
}

const residentCost = (r: ResidentUsage, price: Price) =>
  costOf(price, {
    input: r.daily_input_tokens ?? 0,
    hit: r.daily_cache_hit_tokens ?? 0,
    total: r.daily_tokens,
  })

/** 钱：这个游戏日全镇合计（各人按自己用的服务算）、小镇一共、每人每天的上限 */
function moneyCards(msg: UsageMsg, price: UsageDeps['price']) {
  const s = msg.summary
  let today = 0
  const unknown: string[] = []
  for (const r of msg.residents) {
    const p = price(r.id)
    if (p) today += residentCost(r, p)
    else if (r.daily_tokens) unknown.push(r.name)
  }
  const town = price()
  const lifetime =
    town &&
    costOf(town, {
      input: s.lifetime_input_tokens,
      hit: s.lifetime_cache_hit_tokens,
      total: s.lifetime_tokens,
    })
  const cap = town && (s.tokens_per_day * blendedPerMillion(town)) / 1e6
  const cards = el('div', '', 'us-cards us-money')
  cards.append(
    card('这个游戏日大约花了', yuan(today), '全镇合计'),
    card('这个小镇一共大约', lifetime === null ? '—' : yuan(lifetime), '从建镇或上次重置算起'),
    card(
      '每人每个游戏日最多',
      cap === null ? '—' : `约 ${yuan(cap)}`,
      '到了上限全镇先暂停，在「设定 · 花费上限」里改'
    )
  )
  const box = el('div')
  box.append(cards)
  if (unknown.length)
    box.append(el('p', `${unknown.join('、')}用的服务价格没有收录，没算进去。`, 'dim'))
  if (!town) box.append(el('p', '小镇默认用的服务价格没有收录，只能看下面的用量。', 'dim'))
  return box
}

/** 按村民：这个游戏日大约花了多少、现在怎样 */
function residentMoney(residents: ResidentUsage[], price: UsageDeps['price']) {
  if (!residents.length) return el('p', '还没有村民', 'dim')
  const table = el('table', '', 'us-table')
  table.append(headerRow(['村民', '这个游戏日大约花了', '现在']))
  for (const r of residents) {
    const p = price(r.id)
    const tr = el('tr')
    tr.append(
      el('td', r.name),
      el('td', p ? yuan(residentCost(r, p)) : '价格没有收录'),
      el('td', r.paused ?? (r.in_flight ? '等模型回复' : '正常'), r.paused ? 'drop' : '')
    )
    table.append(tr)
  }
  return table
}

function residentTable(residents: ResidentUsage[]) {
  if (!residents.length) return el('p', '还没有村民', 'dim')
  const table = el('table', '', 'us-table')
  table.append(headerRow(['村民', '今天调用', '今天 token', '缓存命中', '回复 / 过时', '状态']))
  for (const r of residents) {
    const tr = el('tr')
    tr.append(
      el('td', r.name),
      el('td', n(r.daily_calls)),
      el('td', n(r.daily_tokens)),
      el('td', rate(r.daily_cache_hit_tokens ?? 0, r.daily_input_tokens ?? 0)),
      el('td', `${n(r.replies)} / ${n(r.stale_replies)}`),
      el('td', r.paused ?? (r.in_flight ? '等模型回复' : '正常'), r.paused ? 'drop' : '')
    )
    table.append(tr)
  }
  return table
}

const matches = (r: RequestView, filter: Filter) =>
  (!filter.resident || r.resident_id === filter.resident) &&
  (!filter.kind || r.kind === filter.kind) &&
  (!filter.status || r.status === filter.status)

function requestTable(rows: RequestView[]) {
  if (!rows.length) return el('p', '没有符合条件的请求', 'dim')
  const table = el('table', '', 'us-table us-requests')
  table.append(
    headerRow([
      '#',
      '现实时间',
      '世界时间',
      '村民',
      '类型',
      '耗时',
      '输入 / 缓存 / 输出 token',
      '结果',
      '说明',
    ])
  )
  for (const r of rows) table.append(row(r))
  return table
}

function row(r: RequestView) {
  const tr = el('tr', '', `us-${r.status}`)
  const tokens =
    r.input_tokens === undefined
      ? `预留 ${n(r.reserved_tokens)}（估算 ${n(r.estimated_tokens)}）`
      : `${n(r.input_tokens)} / ${n(r.cache_hit_tokens)} / ${n(r.output_tokens)}`
  // 各格的类名供手机把一行排成一张小卡（mobile/style.css）
  tr.append(
    el('td', String(r.id), 'us-id'),
    el('td', wall(r.sent_at), 'us-wall'),
    el('td', displayClock(r.clock), 'us-clock'),
    el('td', r.resident, 'us-resident'),
    el('td', requestKindLabels[r.kind], 'us-kind'),
    el(
      'td',
      r.latency_ms === undefined ? '—' : `${(r.latency_ms / 1000).toFixed(2)}s`,
      'us-latency'
    ),
    el('td', tokens, r.input_tokens === undefined ? 'us-tokens reserved' : 'us-tokens'),
    el(
      'td',
      requestStatusLabels[r.status],
      `us-result ${r.status === 'failed' || r.status === 'outdated' ? 'drop' : r.status === 'adopted' ? 'ok' : ''}`
    ),
    el('td', detailText(r.detail), 'us-detail')
  )
  return tr
}

/** 下拉框选中的值对回标签表的键；「全部」的空值不是键，返回 undefined */
function labelKey<K extends string>(labels: Record<K, string>, value: string): K | undefined {
  const isKey = (candidate: string): candidate is K => Object.hasOwn(labels, candidate)
  return isKey(value) ? value : undefined
}

export function initUsage(deps: UsageDeps) {
  const page = $('usage-page')
  const lifecycle = observationPage(
    $('usage-view'),
    $('obs-view'),
    () => deps.send({ type: 'get_usage' }),
    2000,
    deps.game
  )
  let previous = ''
  let filter: Filter = { resident: '', kind: '', status: '' }
  let last: UsageMsg | null = null
  /** 筛选条留着不重建：页面每 2 秒拿一次用量，有新请求就整页重画，重建的话开着的下拉列表会被收起 */
  let bar: HTMLElement | null = null
  let barResidents = ''
  $('usage-back').addEventListener('click', () => deps.onBack())
  if (deps.game) iconLabel($('usage-back'), 'close', '关闭')

  /** 三个筛选下拉；改动即重画请求表 */
  function filterBar(residents: ResidentUsage[]) {
    const residentSel = select(
      '村民',
      '全部村民',
      residents.map((r): [string, string] => [r.id, r.name]),
      filter.resident
    )
    const kindSel = select('类型', '全部类型', Object.entries(requestKindLabels), filter.kind)
    const statusSel = select('结果', '全部结果', Object.entries(requestStatusLabels), filter.status)
    const refilter = () => {
      filter = {
        resident: residentSel.value,
        kind: labelKey(requestKindLabels, kindSel.value) ?? '',
        status: labelKey(requestStatusLabels, statusSel.value) ?? '',
      }
      previous = ''
      if (last) render(last)
    }
    residentSel.onchange = refilter
    kindSel.onchange = refilter
    statusSel.onchange = refilter
    const bar = el('div', '', 'rv-toolbar')
    bar.append(residentSel, kindSel, statusSel)
    return bar
  }

  function render(msg: UsageMsg) {
    page.className = ''
    const residents = JSON.stringify(msg.residents.map((r) => [r.id, r.name]))
    if (!bar || residents !== barResidents) {
      bar = filterBar(msg.residents)
      barResidents = residents
    }
    const root = el('div')
    // 详细数据开着时重画也保持开着
    const wasOpen = !!page.querySelector<HTMLDetailsElement>('details.us-details')?.open
    const details = el('details', '', 'us-details')
    details.open = wasOpen
    details.append(
      el('summary', '详细数据：调用次数、token 和最近请求'),
      el(
        'p',
        '只统计村民的生活决策与记忆整理；token 含还没回来的请求预留，回复到达后按服务商实际计量更正。',
        'dim'
      ),
      summaryCards(msg.summary),
      el('h3', '按村民', 'section-caption'),
      residentTable(msg.residents),
      el(
        'h3',
        `最近请求 · ${msg.requests.length} 条（最多保留 500 条，随存档保存）`,
        'section-caption'
      ),
      bar,
      requestTable(msg.requests.filter((r) => matches(r, filter)))
    )
    root.append(
      moneyCards(msg, deps.price),
      el('h3', '按村民', 'section-caption'),
      residentMoney(msg.residents, deps.price),
      details
    )
    page.replaceChildren(root)
  }

  return {
    open() {
      lifecycle.open()
    },
    isOpen: lifecycle.isOpen,
    close() {
      lifecycle.close()
    },
    roster({ msg }: RosterFrame) {
      $('usage-clock').textContent = displayClock(msg.clock)
    },
    onReset() {
      previous = ''
      last = null
    },
    handleMsg(msg: ServerMsg): boolean {
      if (msg.type !== 'usage') return false
      if (!lifecycle.isOpen()) return true
      last = msg
      const key = JSON.stringify(msg)
      if (key === previous) return true
      previous = key
      render(msg)
      return true
    },
  }
}
