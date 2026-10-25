import type { WorldHold } from '../protocol'
import type { AvatarCommand, AvatarInteraction, AvatarState, InteractionCommand } from './types'
import { panelButton, pendingTalk, runningTalk } from './view'
import { button, el } from '../dom'
import { isTouch } from '../platform'
// 交谈面板：收到的邀请、进行中的对话、附近的人。发言输入框由控制器持有。

type Execute = (c: AvatarCommand) => Promise<boolean>
type Actor = NonNullable<AvatarState['actor']>

interface Notices {
  holds: WorldHold[]
  results: ReadonlyMap<string, string>
  dismiss: (id: string) => void
  usage: () => void
  settings: () => void
}

/** 一次重绘里各部分共用的东西 */
interface ChatView {
  state: AvatarState
  actor: Actor
  /** 控制中且世界在走：可以回应和发言 */
  active: boolean
  /** 另外还不在忙：可以发起邀请、加入交谈 */
  idle: boolean
  execute: Execute
  interact: (command: InteractionCommand) => void
  nameOf: (id: string) => string
  /** 在面板里加一段 */
  block: (className: string) => HTMLElement
}

function entryName(state: AvatarState, id: string) {
  for (const i of state.interactions ?? [])
    for (const e of i.entries ?? []) if (e.actor === id) return e.name
  return undefined
}

/** 世界暂停时的说明；因额度或故障暂停时给出原因和去处 */
function pauseNotice(notice: HTMLElement, notices: Notices) {
  notice.setAttribute('role', 'status')
  notice.append(
    el('strong', notices.holds.length ? '世界因故暂停，暂时无法交谈' : '世界已暂停，继续后可发言')
  )
  for (const hold of notices.holds) notice.append(el('p', `${hold.resident}：${hold.reason}`))
  if (notices.holds.length)
    notice.append(
      button('查看消耗', notices.usage),
      button('前往设定（将离开化身）', notices.settings)
    )
}

/** 一张邀请卡：别人邀请我时回应，我邀请别人时等待或取消 */
function inviteCard(v: ChatView, i: AvatarInteraction) {
  const { interact, nameOf } = v
  const card = v.block('avatar-invite')
  const row = el('div')
  row.className = 'avatar-row'
  if (i.partner === v.actor.id) {
    const what = i.kind.kind === 'talk' ? '和你聊聊' : '送你东西'
    card.append(el('p', `${nameOf(i.initiator)}想${what}${i.message ? `：${i.message}` : ''}`))
    const reply = (accept: boolean, message: string) =>
      interact({ operation: 'reply', interaction_id: i.id, accept, message })
    const yes = panelButton('好', () => reply(true, '好。'), !v.idle)
    yes.className = 'avatar-primary-small'
    row.append(
      yes,
      panelButton('这次先不了', () => reply(false, '这次先不了，谢谢。'), !v.active)
    )
  } else {
    const partner = nameOf(i.partner)
    card.append(el('p', i.response_error ? `${partner}回应失败` : `等待${partner}回应`))
    if (i.response_error) card.append(el('p', i.response_error))
    row.append(
      panelButton(
        '取消邀请',
        () => interact({ operation: 'cancel', interaction_id: i.id }),
        !v.active
      )
    )
  }
  card.append(row)
}

function turnText(state: AvatarState, talk: AvatarInteraction) {
  if (!state.speed) return '暂停期间不计发言等待时间'
  if (talk.can_speak) return '轮到你了 · 一分钟不说话会自动切到只听'
  return talk.can_request_turn ? '你在只听，想说话就点「我想说」' : '等对方说完'
}

/** 进行中的交谈：对白、轮到谁发言，以及只听、我想说、离开 */
function talkLog(v: ChatView, talk: AvatarInteraction) {
  const { actor: a, active, interact } = v
  const log = v.block('avatar-chatlog')
  for (const e of talk.entries ?? []) {
    if (e.kind === 'speech') {
      const b = el('div')
      b.className = e.actor === a.id ? 'avatar-bubble me' : 'avatar-bubble'
      b.append(el('small', e.actor === a.id ? '你' : e.name), document.createTextNode(e.text))
      log.append(b)
      continue
    }
    const ev = el(
      'p',
      e.kind === 'joined' ? `${e.name}加入了` : e.kind === 'left' ? `${e.name}离开了` : '交谈结束'
    )
    ev.className = 'avatar-chat-event'
    log.append(ev)
  }
  const turn = el('p', turnText(v.state, talk))
  turn.className = active && talk.can_speak ? 'avatar-turn on' : 'avatar-turn'
  log.append(turn)
  v.block('avatar-textacts').append(
    panelButton(
      '只听',
      () => interact({ operation: 'listen', interaction_id: talk.id }),
      !active || !talk.can_speak
    ),
    panelButton(
      '我想说',
      () => void v.execute({ kind: 'request_turn', chat_id: talk.id, revision: a.revision }),
      !active || !talk.can_request_turn
    ),
    panelButton(
      '离开交谈',
      () =>
        interact({ operation: 'leave', interaction_id: talk.id, message: '我先走了，回头聊。' }),
      !active
    )
  )
}

/** 没在交谈时：附近的人（可邀请）和附近正在进行、可以加入的交谈 */
function nearbyPeople(v: ChatView) {
  const { state, idle, interact } = v
  const people = v.block('avatar-people')
  people.append(el('h4', '附近的人'))
  const list = state.nearby ?? []
  if (!list.length) {
    const p = el(
      'p',
      isTouch()
        ? '走到村民身边，地图上会出现「和某某交谈」的标签；点右下角的「交谈」或点标签发出邀请。'
        : '走到村民身边，地图上会出现「和某某交谈」的标签；按 E 或点标签发出邀请。'
    )
    p.className = 'dim'
    people.append(p)
  }
  for (const n of list) {
    const invitation = pendingTalk(state, n.id)
    const available = n.can_talk ?? n.available
    const row = el('div')
    row.className = 'avatar-person'
    const offer = () =>
      interact({
        operation: 'offer',
        partner_id: n.id,
        interaction: { kind: 'talk' },
        message: '你好，方便聊一会儿吗？',
      })
    row.append(
      el('span', n.activity ? `${n.name} · ${n.activity}` : n.name),
      panelButton(
        invitation ? '等待回应' : available ? '邀请交谈' : '暂时无法交谈',
        offer,
        !idle || !available || !!invitation
      )
    )
    people.append(row)
  }
  for (const c of state.nearby_chats ?? [])
    if (!c.members.includes(v.actor.id))
      people.append(
        panelButton(
          `加入附近的交谈（${c.members.length} 人）`,
          () => interact({ operation: 'join', interaction_id: c.id, message: '我也想一起聊聊。' }),
          !idle
        )
      )
}

export function renderChat(
  root: HTMLElement,
  state: AvatarState,
  execute: Execute,
  openHistory: () => void,
  notices: Notices
) {
  const a = state.actor
  if (!a) return
  const active = state.controlled && state.speed > 0
  const view: ChatView = {
    state,
    actor: a,
    active,
    idle: active && !a.busy,
    execute,
    interact: (command) => void execute({ kind: 'interact', revision: a.revision, command }),
    nameOf: (id) =>
      id === a.id
        ? '你'
        : (state.nearby?.find((n) => n.id === id)?.name ?? entryName(state, id) ?? '对方'),
    block: (className) => {
      const s = el('section')
      s.className = className
      root.append(s)
      return s
    },
  }
  if (!state.speed) pauseNotice(view.block('avatar-pause-notice'), notices)
  for (const [id, text] of notices.results)
    view.block('avatar-invite-result').append(
      el('p', text),
      button('关闭这条结果', () => notices.dismiss(id))
    )
  for (const i of state.interactions ?? []) if (i.status === 'offered') inviteCard(view, i)
  const talk = runningTalk(state)
  if (talk) talkLog(view, talk)
  else nearbyPeople(view)
  view.block('avatar-textacts').append(button('完整交谈记录', openHistory))
}
