import type { ResidentContext } from './application'
import { observationPage } from './observationPage'
import type { ClientMsg } from './protocol'
import { $ } from './dom'
import { gameIcon, iconLabel } from './game/icons'
// 日志页：整页替换地图页，按天看村民具体做了什么。
// 左栏按天（第 1 天、第 2 天…），右栏把世界的执行记录与村民自己的想法按时间穿插；
// 天头是次日早上村民自己写的「昨天」。数据全部来自服务端的 Diary 消息，
// 只有死亡记录换成平实写法，带数值的原文收进「详情」。

import { triggerLabel } from './display'
import { displayClock, playerText } from './format'
import { describeDeath, detailsOf } from './importantEvents'
import { type Alert, type DiaryDay, type ServerMsg } from './protocol'

interface DiaryDeps {
  send: (obj: ClientMsg) => void
  onBack: () => void
  /** 游戏模式：左栏村民列表（原型日记页）；切换村民等于换一本日志 */
  residents?: () => ResidentContext[]
  /** 游戏界面 */
  game: boolean
}

interface Row {
  minutes: number
  clock: string
  kind: 'receipt' | 'thought'
  text: string
  tag?: string
  /** 死亡这类生命记录的提示卡细节 */
  alert?: Alert
}

export function initDiary(deps: DiaryDeps) {
  const game = deps.game
  const nav = $('diary-nav')
  const page = $('diary-page')
  const title = $('diary-title')
  let resident: ResidentContext | null = null
  let received = false
  let opener: HTMLElement | null = null
  const lifecycle = observationPage(
    $('diary-view'),
    $('obs-view'),
    () => deps.send({ type: 'get_diary', resident: resident?.id }),
    2000,
    game
  )
  let days: DiaryDay[] = []
  let selected: string | null = null // 天的 label；null = 跟着最新一天

  $('diary-back').addEventListener('click', () => deps.onBack())
  if (game) {
    $('diary-back').setAttribute('aria-label', '返回居民详情')
    iconLabel($('diary-back'), 'close', '关闭')
    $('diary-view').setAttribute('role', 'region')
    $('diary-view').setAttribute('aria-labelledby', 'diary-title')
    page.setAttribute('aria-live', 'polite')
  }

  function emptyState(text: string) {
    const empty = document.createElement('div')
    empty.className = 'diary-empty'
    const label = document.createElement('p')
    label.textContent = text
    empty.append(gameIcon('book'), label)
    page.append(empty)
  }

  function rowsOf(d: DiaryDay): Row[] {
    const rows: Row[] = []
    for (const receipt of d.receipts) {
      rows.push({
        minutes: Math.floor(receipt.sim_minutes),
        clock: receipt.clock,
        kind: 'receipt',
        text: receipt.text,
        alert: receipt.alert,
      })
    }
    for (const thought of d.thoughts) {
      rows.push({
        minutes: Math.floor(thought.sim_minutes),
        clock: thought.clock,
        kind: 'thought',
        text: thought.text,
        tag: triggerLabel(thought.trigger_info),
      })
    }
    // 同一时刻：想法在执行记录前（先想后做）
    rows.sort(
      (a, b) => a.minutes - b.minutes || (a.kind === b.kind ? 0 : a.kind === 'thought' ? -1 : 1)
    )
    return rows
  }

  function renderNav() {
    nav.replaceChildren()
    // 游戏模式左栏 = 村民列表（原型）；2D 保持天列表
    if (game) {
      const list = deps.residents?.() ?? []
      nav.hidden = list.length === 0
      for (const r of list) {
        const b = document.createElement('button')
        b.className = 'nav-item' + (r.id === resident?.id ? ' on' : '')
        // 首字头像圆：与名册列表区分，原型日记页左栏为独立的人物切换栏
        const ava = document.createElement('span')
        ava.className = 'diary-ava'
        ava.textContent = r.name.slice(0, 1)
        b.append(ava, document.createTextNode(r.name))
        b.onclick = () => {
          if (r.id === resident?.id) return
          resident = r
          title.textContent = `${r.name}的日志`
          days = []
          received = false
          selected = null
          render()
          deps.send({ type: 'get_diary', resident: r.id })
        }
        nav.appendChild(b)
      }
      return
    }
    nav.hidden = false
    const cur = selected ?? days[days.length - 1]?.label
    for (const d of days) {
      const b = document.createElement('button')
      b.className = 'nav-item' + (d.label === cur ? ' on' : '')
      const count = d.receipts.length + d.thoughts.length
      b.textContent = `${displayClock(d.label)}${d.current ? '（今天）' : ''} · ${count}`
      b.onclick = () => {
        selected = d.label
        render()
      }
      nav.appendChild(b)
    }
  }

  function renderDay(d: DiaryDay) {
    const head = document.createElement('div')
    head.className = 'diary-head'
    const h = document.createElement('h2')
    h.textContent = `${displayClock(d.label)}${d.current ? ' · 进行中' : ''}`
    head.appendChild(h)
    const sum = document.createElement('div')
    sum.className = 'diary-summary' + (d.summary ? '' : ' dim')
    const who = resident?.name ?? '村民'
    sum.textContent = d.summary
      ? `${who}第二天早上写的：「${d.summary}」`
      : d.current
        ? '这一天还没过完'
        : `${who}没写这一天的「昨天」`
    head.appendChild(sum)
    page.appendChild(head)

    const rows = rowsOf(d)
    if (rows.length === 0) {
      if (game) emptyState('这一天暂无日志')
      else {
        const empty = document.createElement('div')
        empty.className = 'dim'
        empty.textContent = '这一天什么都没记下'
        page.appendChild(empty)
      }
      return
    }
    const list = document.createElement('div')
    list.className = 'diary-rows'
    for (const r of rows) {
      const death = r.alert?.kind === 'death' ? describeDeath(r.alert, r.text) : null
      const row = document.createElement('div')
      row.className = 'diary-row ' + r.kind + (death ? ' important' : '')
      const t = document.createElement('span')
      t.className = 'ev-clock'
      t.textContent = r.clock.replace(/^D\d+ /, '')
      const body = document.createElement('span')
      body.className = 'diary-text'
      body.textContent =
        r.kind === 'thought' ? `「${playerText(r.text)}」` : (death?.summary ?? playerText(r.text))
      if (death) body.append(detailsOf(death.detail))
      row.append(t, body)
      if (r.tag) {
        const tag = document.createElement('span')
        tag.className = 'ev-trigger'
        tag.textContent = r.tag
        row.appendChild(tag)
      }
      list.appendChild(row)
    }
    page.appendChild(list)
  }

  function renderPage() {
    page.replaceChildren()
    if (!days.length) {
      if (game) {
        page.className = 'diary-empty-page'
        emptyState(received ? '暂无日志' : '正在读取日志…')
      } else {
        page.className = 'dim'
        page.textContent = '还没有日志'
      }
      return
    }
    page.className = ''
    // 游戏模式：右栏按天分组整体堆叠，新的天在上（原型日记页）
    if (game) {
      for (const d of [...days].reverse()) renderDay(d)
      return
    }
    const label = selected ?? days[days.length - 1]?.label
    const d = days.find((x) => x.label === label)
    if (!d) return
    renderDay(d)
  }

  function render() {
    renderNav()
    renderPage()
  }

  return {
    isOpen: lifecycle.isOpen,
    onReset() {
      days = []
      received = false
      selected = null
      render()
      if (lifecycle.isOpen()) deps.send({ type: 'get_diary', resident: resident?.id })
    },
    open(selectedResident: ResidentContext) {
      const changed = resident?.id !== selectedResident.id
      if (game)
        opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      resident = selectedResident
      title.textContent = `${resident.name}的日志`
      if (changed) {
        days = []
        received = false
        selected = null
      }
      render()
      lifecycle.open()
      if (game) $('diary-back').focus()
    },
    close() {
      lifecycle.close()
      if (game) opener?.focus()
    },
    handleMsg(msg: ServerMsg): boolean {
      if (msg.type !== 'diary') return false
      if (msg.resident !== resident?.name) return true
      received = true
      // 用户正看着的某一天保持不动；没选过就跟着最新一天
      days = msg.days
      if (lifecycle.isOpen()) render()
      return true
    },
  }
}
