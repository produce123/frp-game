import type { NeedKind, NeedStateView, NeedsTuning, PhysiologySwitches } from '../protocol'

import { NEED_BANDS } from '../needsRules'
import { gameIcon } from '../game/icons'
const BAND_CLASS: Record<string, string> = Object.fromEntries(
  Object.entries(NEED_BANDS).map(([id, band]) => [id, band.class])
)
const BAND_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(NEED_BANDS).map(([id, band]) => [id, band.label])
)
const BAND_SEVERITY: Record<string, number> = Object.fromEntries(
  Object.entries(NEED_BANDS).map(([id, band]) => [id, band.severity])
)
/** 显示顺序固定；世界设定关掉的项后端不再发送，这里按需求种类补一行灰条。 */
const NEED_ORDER: NeedKind[] = ['fullness', 'energy', 'water', 'health']
/** 关掉的项没有后端数据，灰条上写的名字 */
const NEED_NAMES: Record<NeedKind, string> = {
  fullness: '饱腹',
  energy: '精力',
  water: '水分',
  health: '健康',
}
/** 游戏界面需求名前的图标 */
const NEED_ICONS: Record<NeedKind, string> = {
  fullness: 'food',
  energy: 'energy',
  water: 'water',
  health: 'heart',
}

interface NeedEls {
  root: HTMLElement
  /** 数值条：读屏按 meter 读 */
  track: HTMLElement
  fill: HTMLElement
  value: HTMLElement
  state: HTMLElement
  kind: NeedKind
  ticks: HTMLElement[]
  /** 分界线的说明，放进整行的悬停提示 */
  marks: string
}

export function createNeedsView(
  container: HTMLElement,
  residentName: string,
  onChange: (text: string, warning: boolean) => void,
  /** 游戏界面 */
  game: boolean
) {
  let tuning: NeedsTuning | null = null
  /** 健康的分界不随人调整，随村民设定一起由后端给出 */
  let healthMarks: number[] = []
  let switches: PhysiologySwitches | null = null
  const lastText = new Map<NeedKind, string>()
  const lastBand = new Map<NeedKind, string>()
  const needEls = new Map<NeedKind, NeedEls>()
  // 2D 在四条需求下面写一句总结：都正常，或列出不正常的状态文字
  const note = game ? null : document.createElement('p')
  if (note) note.className = 'needs-note'
  // ---- 需求状态条（分界线来自 agent_config.tuning，不写死默认值） ----
  function buildNeed(n: NeedStateView): NeedEls {
    const root = document.createElement('div')
    root.className = 'need'
    root.dataset.need = n.kind // 游戏皮肤按需求分色（原型 c1-c4）
    const head = document.createElement('div')
    head.className = 'need-head'
    const label = document.createElement('span')
    label.className = 'need-label'
    label.textContent = n.need
    if (game) label.prepend(gameIcon(NEED_ICONS[n.kind]))
    const value = document.createElement('span')
    value.className = 'need-value'
    const state = document.createElement('span')
    state.className = 'need-state'
    head.append(label, value, state)
    const track = document.createElement('div')
    track.className = 'need-track'
    const fill = document.createElement('div')
    fill.className = 'need-fill'
    track.appendChild(fill)
    const ticks: HTMLElement[] = []
    for (let i = 0; i < 3; i++) {
      const tick = document.createElement('div')
      tick.className = 'need-tick'
      tick.style.display = 'none' // tuning 未到前不显示，避免堆在 0%
      track.appendChild(tick)
      ticks.push(tick)
    }
    root.append(head, track)
    container.appendChild(root)
    root.addEventListener('animationend', () => root.classList.remove('flash'))
    const els: NeedEls = { kind: n.kind, root, track, fill, value, state, ticks, marks: '' }
    placeTicks(els)
    return els
  }

  function placeTicks(els: NeedEls) {
    if (!tuning) return
    // 三个分界：撑不住(collapse) / 重新考虑(ring) / 出现不适(voiced)
    const marks =
      els.kind === 'health' ? healthMarks : [tuning.collapse, tuning.ring, tuning.voiced]
    els.ticks.forEach((t, i) => {
      t.style.left = `${marks[i]}%`
      t.style.display = ''
    })
    els.marks = `分界线：${marks.join(' / ')}`
  }

  function row(n: NeedStateView) {
    let els = needEls.get(n.kind)
    if (!els) {
      els = buildNeed(n)
      needEls.set(n.kind, els)
      for (const kind of NEED_ORDER) {
        const root = needEls.get(kind)?.root
        if (root) container.appendChild(root)
      }
    }
    return els
  }

  /** 世界设定关掉的项：没有数值，也不参与跨级提示 */
  function renderOff(kind: NeedKind) {
    const name = NEED_NAMES[kind]
    const els = row({ kind, need: name, value: 0, band: 'steady', text: '' })
    els.root.className = 'need need-off'
    els.value.textContent = '—'
    els.state.textContent = '已关闭'
    els.root.title = `${name}已在世界设定中关闭，数值保留，不参与生活与决策`
    els.track.removeAttribute('aria-valuenow')
    lastBand.delete(kind)
    lastText.delete(kind)
  }

  /** 一次名册更新：开着的项按后端数值画，关掉的项画灰条 */
  function renderAll(list: NeedStateView[]) {
    for (const n of list) renderNeed(n)
    if (switches) {
      const sent = new Set(list.map((n) => n.kind))
      for (const kind of NEED_ORDER) if (!switches[kind] && !sent.has(kind)) renderOff(kind)
    }
    if (!note || !list.length) return
    const off = list.filter((n) => n.band !== 'steady')
    note.classList.toggle('needs-note-warn', off.length > 0)
    note.textContent = off.length
      ? off.map((n) => n.text || BAND_LABEL[n.band] || n.band).join(' · ')
      : '都正常'
    container.appendChild(note)
  }

  function renderNeed(n: NeedStateView) {
    const els = row(n)
    const cls = BAND_CLASS[n.band] ?? 'steady'
    els.root.className = `need band-${cls}`
    els.fill.style.width = `${Math.min(Math.max(n.value, 0), 100)}%`
    els.value.textContent = String(Math.round(n.value))
    els.root.title = `${n.need} · ${Math.round(n.value)} · ${n.text || BAND_LABEL[n.band] || n.band}${els.marks ? '\n' + els.marks : ''}`
    els.track.setAttribute('role', 'meter')
    els.track.setAttribute('aria-label', n.need)
    els.track.setAttribute('aria-valuemin', '0')
    els.track.setAttribute('aria-valuemax', '100')
    els.track.setAttribute('aria-valuenow', String(Math.round(n.value)))
    els.state.textContent = n.text || BAND_LABEL[n.band] || n.band

    // 跨级检测：首次出现只记录，不强调
    const prev = lastBand.get(n.kind)
    if (prev !== undefined && prev !== n.band) {
      els.root.classList.remove('flash')
      void els.root.offsetWidth // 重启动画
      els.root.classList.add('flash')
      const worse = (BAND_SEVERITY[n.band] ?? 0) > (BAND_SEVERITY[prev] ?? 0)
      onChange(
        `${residentName}${n.need} ${Math.round(n.value)}：${lastText.get(n.kind) ?? prev} → ${n.text || BAND_LABEL[n.band] || n.band}`,
        worse
      )
    }
    lastBand.set(n.kind, n.band)
    lastText.set(n.kind, n.text || n.band)
  }

  return {
    setResidentName(name: string) {
      residentName = name
    },
    render: renderAll,
    setSwitches(value: PhysiologySwitches) {
      switches = value
    },
    tune(value: NeedsTuning, health: number[]) {
      tuning = value
      healthMarks = health
      for (const els of needEls.values()) placeTicks(els)
    },
    reset() {
      lastBand.clear()
      lastText.clear()
    },
    clear() {
      container.replaceChildren()
      needEls.clear()
      lastBand.clear()
      lastText.clear()
      tuning = null
    },
  }
}
