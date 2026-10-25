// 右侧只读村民信息栏：地点 / 行为 / 在途进度 / 想法 / 计划 / 需求条 / 生理状态 / 随身物品 / 最近变化 / 模型设置。
// 只读纪律：本栏没有任何输入框、密钥或保存按钮。
// 跨级反馈：记录每项需求的上一个 band，变化时状态条一次性强调 + 追加本地事件。

import {
  type NeedsTuning,
  type PhysiologySwitches,
  type PopulationView,
  type ResidentRegistration,
  type RosterMember,
} from './protocol'
import { agentStopped } from './display'
import type { WaitLine } from './modelWait'
import type { GameMap, ResidentEntry } from './gameMap'
import type { RosterFrame } from './shell/panel'
import type { EventsHandle } from './events'
import { $, el, query } from './dom'
import { displayClock, playerText } from './format'
import { portraitFor, portraitKey, residentPortrait } from './portraits'
import { agentStateLabels } from './labels'

interface InfoPanelDeps {
  map: GameMap
  /** 游戏界面 */
  game: boolean
  events: EventsHandle
  localeName: (id: string) => string
  onPossess: (id: string) => void
  onEditResident: () => void
  onOpenDiary: () => void
  onOpenMemory: () => void
  onSelectResident: (id: string) => void
  /** 选中的村民换了人（2D 右栏里的聊天记录页要退回村民信息） */
  onSelectionChange: () => void
  /** 化身控制中：右栏收起、不选中村民 */
  avatarActive: () => boolean
  /** 这个世界开放了化身控制（游戏界面据此决定「控制」钮能不能用） */
  avatarAvailable: () => boolean
  onOpenItem: (id: string) => void
  /** 清掉居民的暂停原因让他继续：等于在顶栏点一次开始 */
  onResumeAgents: () => void
  /** 在等模型时右栏第一行写什么、按钮做什么（modelWait.ts） */
  waitLine: (m: RosterMember) => WaitLine | null
  /** 「和 X 说话」：进入化身、走过去搭话 */
  onTalk: (id: string) => void
}

import { installPanelWidth } from './info/width'
import { createBodyView } from './info/body'
import { createInventoryView } from './info/inventory'
import { iconLabel } from './game/icons'
import { createNeedsView } from './info/needs'
import { createThoughtView } from './info/thought'
import { createPlanView } from './info/plan'
import { createRecentView } from './info/recent'
import { createAgentView } from './info/agent'

/** 窄于 1024：右栏不再是地图旁边的一栏，而是盖在地图上（style.css 的响应式部分） */
const narrowLayout = matchMedia('(max-width: 1023px)')

export function initInfoPanel(deps: InfoPanelDeps) {
  const game = deps.game
  const panel = $('info-panel')
  const resizer = $('info-resizer')
  const obsMain = $('obs-main')
  const followBtn = $('info-follow')
  const possessBtn = query<HTMLButtonElement>(panel, '#info-possess')
  possessBtn.onclick = () => {
    if (selectedId) deps.onPossess(selectedId)
  }
  possessBtn.hidden = !deps.map.avatarSupported
  // 游戏界面：小卡是摘要，点「详情」展开成居中大窗
  const expandBtn = game ? $('info-expand') : null
  if (expandBtn)
    expandBtn.onclick = () => {
      const on = panel.classList.toggle('info-expanded')
      expandBtn.textContent = on ? '收起' : '详情'
    }
  /** 收起右栏，保留选中；游戏界面同时退出展开的详情窗 */
  function collapse() {
    setCollapsed(true)
    if (!expandBtn) return
    panel.classList.remove('info-expanded')
    expandBtn.textContent = '详情'
  }

  const residentSelect = query<HTMLSelectElement>(panel, '#resident-select')
  let residentChoices = ''
  /** 名册顺序，手机抽屉左右滑动按它换人 */
  let order: string[] = []
  residentSelect.onchange = () => select(residentSelect.value)

  let selectedId: string | null = null
  let physiology: PhysiologySwitches | undefined
  let following = false
  let registrations = new Map<string, ResidentRegistration>()
  const panelWidth = installPanelWidth(panel, resizer, obsMain)
  const inventory = createInventoryView(
    query<HTMLDetailsElement>(panel, '#info-inventory'),
    deps.onOpenItem,
    game
  )
  // 2D 右栏头部的像素头像；生理视图的两个折叠项放在「随身物品」之后
  const plainPortrait = game ? null : query<HTMLElement>(panel, '.info-portrait')
  const body = createBodyView(
    $('info-physiology'),
    game ? undefined : query<HTMLElement>(panel, '.info-body-folds')
  )
  const needs = createNeedsView(
    $('info-needs'),
    '',
    (text, warning) => deps.events.pushLocal(text, warning),
    game
  )
  const thought = createThoughtView($('info-thought'))
  const plan = createPlanView($('info-plan'), game)
  const agent = createAgentView($('info-agent'))
  const recent = createRecentView($('info-recent'), deps.events.recent)

  function setCollapsed(collapsed: boolean) {
    panel.hidden = collapsed
    resizer.hidden = collapsed
    panel.classList.toggle('collapsed', collapsed)
  }

  /** 2D 顶部的像素头像，和村民页用同一张 */
  function renderPortrait() {
    if (!plainPortrait) return
    const r = selectedId ? registrations.get(selectedId) : undefined
    const url = r ? portraitFor(portraitKey(r)) : undefined
    if (!url) {
      plainPortrait.replaceChildren()
      return
    }
    const img = el('img')
    img.src = url
    img.alt = ''
    plainPortrait.replaceChildren(img)
  }

  function select(id: string | null, expand = true) {
    if (selectedId !== id) {
      deps.onSelectionChange()
      needs.clear()
      body.clear()
      inventory.clear()
      plan.clear()
      thought.clear()
      agent.clear()
    }
    selectedId = id
    const oldPortrait = document.querySelector('#info-head .resident-portrait')
    oldPortrait?.remove()
    if (game && id) {
      $('info-head').prepend(residentPortrait(id, '居民'))
      const r = registrations.get(id)
    }
    renderPortrait()
    residentSelect.value = id ?? ''
    if (id) deps.onSelectResident(id)
    deps.map.setSelected(id)
    if (id && expand) setCollapsed(false)
    possessBtn.disabled = !id
    if (!id) {
      $('info-name').textContent = '未选中村民'
      $('info-place').textContent = '点击地图上的村民查看信息'
      $('info-activity').textContent = ''
      $('info-transit').textContent = ''
      $('info-home').textContent = ''
      needs.clear()
      body.clear()
      inventory.clear()
      plan.clear()
      thought.clear()
      agent.clear()
    }
  }

  function renderHome() {
    const r = selectedId ? registrations.get(selectedId) : undefined
    $('info-home').textContent = r
      ? `住宅：${r.home_name} · ${r.joined_clock ? `${displayClock(r.joined_clock)} 入村` : '原有居民'}`
      : ''
    // 游戏界面的详情卡：名字正下方的「住 X」副标题
    if (game) $('info-sub').textContent = r ? `住 ${r.home_name}` : ''
  }

  /** Agent 停下了或者在等模型：卡片顶上写明原因，给一个能马上处理的按钮（原因原本只在最底下的折叠项里） */
  function renderStop(m: RosterMember) {
    const box = $('info-stop')
    const agent = m.resident_agent
    const wait = deps.waitLine(m)
    box.hidden = !agent || (!wait && !agentStopped(m))
    if (box.hidden || !agent) return
    const reason = agent.reason ? playerText(agent.reason) : agentStateLabels[agent.state]
    // 在等的东西没有可点的（比如内置模型正在下载）时不放按钮
    const action = wait
      ? wait.label
        ? { label: wait.label, run: wait.run }
        : null
      : agent.state === 'budget' || agent.state === 'unconfigured'
        ? null
        : { label: '继续行动', run: deps.onResumeAgents }
    query<HTMLElement>(box, 'span').textContent = wait ? wait.text : `${m.name}停下了：${reason}`
    const button = query<HTMLButtonElement>(box, 'button')
    button.hidden = !action
    if (action) {
      button.textContent = action.label
      button.onclick = action.run
    }
  }

  /** 「和 X 说话」：化身开放、对方能回应时才有 */
  const talkBtn = query<HTMLButtonElement>(panel, '#info-talk')
  talkBtn.onclick = () => {
    if (selectedId) deps.onTalk(selectedId)
  }
  function renderTalk(m: RosterMember) {
    const row = $('info-talk-row')
    row.hidden =
      !deps.map.avatarSupported ||
      !deps.avatarAvailable() ||
      m.kind !== 'resident' ||
      !m.body?.can_decide ||
      m.resident_agent?.state === 'manual'
    if (row.hidden) return
    talkBtn.textContent = `和${m.name}说话`
    $('info-talk-hint').textContent = `你的化身会走过去，${m.name}会停下来等你`
  }

  function setFollowing(on: boolean) {
    following = on
    if (game && on && selectedId) {
      const p = deps.map.getMemberPos(selectedId)
      if (p) deps.map.panTo(p[0], p[1])
    }
    followBtn.classList.toggle('on', following)
    if (game) iconLabel(followBtn, 'eye', following ? '跟随中' : '跟随')
    else followBtn.textContent = following ? '跟随中' : '跟随'
  }
  followBtn.onclick = () => setFollowing(!following)
  $('info-edit').onclick = () => deps.onEditResident()
  $('info-diary').onclick = () => deps.onOpenDiary()
  $('info-memory').onclick = () => deps.onOpenMemory()
  $('info-collapse').onclick = collapse

  /** roster 驱动：信息刷新 + 跨级检测 + 跟随 */
  function render(entries: ResidentEntry[], minutes: number) {
    const choices = entries.map((e) => ({ id: e.member.id, name: e.member.name }))
    order = choices.map((c) => c.id)
    const choiceKey = JSON.stringify(choices)
    if (residentChoices !== choiceKey) {
      residentChoices = choiceKey
      residentSelect.replaceChildren(...choices.map((choice) => new Option(choice.name, choice.id)))
      residentSelect.hidden = choices.length < 2
      residentSelect.value = selectedId ?? ''
    }
    recent.render()
    if (!entries.length && !selectedId) {
      $('info-name').textContent = '还没有村民'
      $('info-place').textContent = '点顶栏的「邀请村民」请几位住进来'
    }
    const me = selectedId ? entries.find((e) => e.member.id === selectedId) : undefined
    if (!me) return
    const m = me.member
    possessBtn.hidden = !deps.map.avatarSupported
    const unavailableGameAvatar = game && !deps.avatarAvailable()
    possessBtn.disabled = !m.body?.can_decide || !m.body?.can_move || unavailableGameAvatar
    possessBtn.title = possessBtn.disabled
      ? unavailableGameAvatar
        ? '当前世界尚未开放角色控制'
        : (m.body?.limitation ?? '村民状态尚未就绪')
      : '直接接管这名村民；AI 暂停决策'

    needs.setResidentName(m.name)
    if (game) $('info-edit').textContent = `编辑${m.name}`
    else $('info-edit').title = `编辑${m.name}的设定`
    $('info-name').textContent = m.name
    const at = m.at
    $('info-place').textContent = deps.localeName(me.locale)
    $('info-activity').textContent = m.chat
      ? `正在交谈 · ${m.chat.participants.join('、')}`
      : !game || m.activity !== 'placeholder'
        ? m.verb
        : m.resident_agent
          ? `${agentStateLabels[m.resident_agent.state]}${m.resident_agent.reason ? ' · ' + playerText(m.resident_agent.reason) : ''}`
          : '当前没有进行中的动作，尚未收到决策状态'
    renderStop(m)
    renderTalk(m)
    $('info-transit').textContent =
      at.kind === 'transit'
        ? `在路上，去${deps.localeName(at.toward)}（还要约 ${Math.max(1, Math.round(at.total - at.elapsed))} 分钟）`
        : at.kind === 'station'
          ? `落脚点 ${deps.localeName(at.station)}`
          : at.kind === 'free'
            ? '在当前地点内'
            : '不在场'
    // 2D 顶部只在路上时多写一行进度
    $('info-transit').hidden = !game && at.kind !== 'transit'
    renderHome()
    if (m.kind === 'resident') needs.render(m.needs ?? [])
    body.render(m.body, physiology)
    inventory.render(m.inventory)
    thought.render(m.thought, minutes)
    agent.render(m.resident_agent)
    plan.render(m.plan, m.body, m.resident_agent, m.activity)
    // 跟随：每次 roster 更新，村民在视野外（带边距）才平移
    if (following) {
      const pos = deps.map.getMemberPos(m.id)
      if (pos) deps.map.panTo(pos[0], pos[1])
    }
  }

  return {
    select,
    dispose() {
      panelWidth.dispose()
    },
    follow: setFollowing,
    setCollapsed,
    collapse,
    /** 打开选中村民的日记（快捷栏「日记」与 2 键） */
    openDiary: () => deps.onOpenDiary(),
    isCollapsed: () => panel.hidden,
    /** 按名册顺序换到上一位或下一位 */
    cycle(step: 1 | -1) {
      if (order.length < 2) return
      const i = Math.max(0, order.indexOf(selectedId ?? ''))
      select(order[(i + step + order.length) % order.length])
    },
    selected: () => selectedId,
    /** 世界重置：清掉本地缓存与选中，下一帧 roster 全量重画（跟随保留） */
    onReset() {
      inventory.clear()
      needs.reset()
      plan.reset()
      thought.reset()
      agent.reset()
      recent.reset()
      select(null)
    },
    /** 世界生理开关：下一帧名册按它补画关掉的项 */
    onPhysiology(value: PhysiologySwitches) {
      physiology = value
      needs.setSwitches(value)
    },
    /** agent_config 到达后重画分界刻度 */
    onTuning(t: NeedsTuning, healthMarks: number[]) {
      needs.tune(t, healthMarks)
    },
    /** 人口登记：住宅与入村时间来自这里，不从 roster 猜 */
    onPopulation(view: PopulationView) {
      registrations = new Map(view.residents.map((r) => [r.id, r]))
      renderHome()
      renderPortrait()
    },
    /** 名册：先定选中谁，再刷新信息、跨级检测与跟随 */
    roster({ residents, msg }: RosterFrame) {
      // 首次名册自动选中第一位并展开右栏（游戏界面不自动选）；空村时右栏给出邀请提示。
      // 窄于 1024 时村民卡是盖在地图上的抽屉或浮层，只选中不展开，等玩家点人
      if (deps.avatarActive()) {
        setCollapsed(true)
        if (selectedId !== null) select(null)
      } else if (selectedId === null && residents.length && !game)
        select(residents[0].member.id, !narrowLayout.matches)
      else if (selectedId !== null && !residents.some((e) => e.member.id === selectedId))
        select(null)
      render(residents, msg.sim_minutes)
    },
  }
}
