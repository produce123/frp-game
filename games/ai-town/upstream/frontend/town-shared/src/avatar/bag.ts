import { gameIcon } from '../game/icons'
import type { InventorySlot } from '../protocol'
import type {
  AvatarCommand,
  AvatarProp,
  AvatarState,
  InteractionCommand,
  InventoryOperation,
  PlayerAction,
} from './types'
import { panelButton } from './view'
import { isPostAction } from './bulletin'
import type { BulletinTargets } from './ui-types'
import { el } from '../dom'
import { isTouch } from '../platform'
// 背包面板：自己的东西按格子摆，点开一格出动作单；附近的东西单列，主动作同时画在地图上。

type Execute = (c: AvatarCommand) => Promise<boolean>
type Actor = NonNullable<AvatarState['actor']>
interface BagSelection {
  readOnly?: boolean
  selected: string | null
  select(id: string | null): void
}
const verbs = { pick_up: '拾取', drop: '放下', store: '存放', retrieve: '取回', take: '领取' }

/** 一次重绘里各部分共用的东西 */
interface BagView {
  root: HTMLElement
  state: AvatarState
  actor: Actor
  ui: BagSelection
  /** 游戏界面：物品格画背包图标 */
  game: boolean
  /** 控制中、世界在走、也不在忙：可以做动作 */
  idle: boolean
  /** 做不了时按钮下的说明 */
  blocked: string
  act: (draft: PlayerAction) => void
  inventory: (op: InventoryOperation) => void
  interact: (command: InteractionCommand) => void
  /** 跟前能张贴公告的地方 */
  bulletin?: BulletinTargets | null
}

/** 一个物品格；没有 onClick 的是空格 */
function tile(bag: BagView, key: string, name: string, note: string, onClick?: () => void) {
  const t = el('button')
  t.type = 'button'
  t.className = `avatar-tile${key && key === bag.ui.selected ? ' on' : ''}${onClick ? '' : ' empty'}`
  if (key && bag.game) t.append(gameIcon('bag'))
  t.append(el('span', name))
  if (note) t.append(el('small', note))
  t.disabled = !onClick
  if (onClick) t.onclick = onClick
  return t
}
const toggle = (ui: BagSelection, key: string) => () => ui.select(ui.selected === key ? null : key)
function dim(root: HTMLElement, text: string) {
  const p = el('p', text)
  p.className = 'dim'
  root.append(p)
}
/** 在面板里加一张动作单，返回往单子上加一项的函数；第一项是主动作 */
function sheet(bag: BagView) {
  const s = el('div')
  s.className = 'avatar-sheet'
  bag.root.append(s)
  let first = true
  return (label: string, note: string, run: () => void, enabled: boolean) => {
    const b = panelButton(label, run, !enabled)
    if (first) b.className = 'main'
    first = false
    b.append(el('small', !enabled && !note ? bag.blocked : note))
    s.append(b)
  }
}

/** 自己的东西摆成格子；只读时只给查看说明，返回 false 表示不再往下画 */
function myTiles(bag: BagView) {
  const { root, actor: a, ui } = bag
  const mine = el('div')
  mine.className = 'avatar-tiles'
  for (const slot of a.inventory.slots) {
    const key = `slot:${slot.items[0]}`
    const open = ui.readOnly ? undefined : toggle(ui, key)
    mine.append(tile(bag, key, slot.name, `×${slot.quantity}`, open))
  }
  const empties = Math.min(Math.max(a.inventory.capacity - a.inventory.used, 0), 8)
  for (let i = 0; i < empties; i++) mine.append(tile(bag, '', '空', ''))
  root.append(mine)
  if (ui.readOnly) {
    if (!a.inventory.slots.length) {
      const empty = el('div')
      empty.className = 'avatar-bag-empty'
      empty.append(gameIcon('bag'), el('p', '背包是空的'))
      root.append(empty)
    } else dim(root, '随身物品 · 当前可查看')
    return false
  }
  if (!a.inventory.slots.length)
    dim(
      root,
      isTouch()
        ? '还没有东西。走近地上的物品，点右下角的按钮拾取。'
        : '还没有东西。走近地上的物品按 E 拾取。'
    )
  return true
}

/** 选中自己的一格：它自带的动作、放下、存进附近的容器、送给附近的人 */
function slotSheet(bag: BagView, slot: InventorySlot) {
  const { state, idle, inventory } = bag
  const id = slot.items[0]
  const add = sheet(bag)
  for (const action of slot.actions)
    add(
      action.label,
      action.minutes ? `约 ${action.minutes} 分钟` : '',
      () => bag.act({ intent: { verb: action.id }, prop_id: id }),
      idle
    )
  add(
    '放下',
    state.can_drop ? '' : '需靠近落脚点',
    () => inventory({ operation: 'drop', items: [id] }),
    idle && !!state.can_drop
  )
  for (const p of state.props ?? [])
    if (p.storage_slots && !p.carried)
      add(
        `存进${p.name}`,
        '',
        () => inventory({ operation: 'store', items: [id], container: p.id }),
        idle
      )
  for (const n of state.nearby ?? [])
    add(
      `送给${n.name}`,
      n.available ? '需对方同意' : '对方正忙',
      () =>
        bag.interact({
          operation: 'offer',
          partner_id: n.id,
          interaction: { kind: 'give', items: [id] },
          message: `这份${slot.name}送给你，要吗？`,
        }),
      idle && n.available
    )
}

/** 选中附近的一件：拾取、它的动作、领取一份、取回存在里面的东西 */
function propSheet(bag: BagView, prop: AvatarProp) {
  const { idle, inventory } = bag
  const add = sheet(bag)
  let any = false
  const item = (label: string, note: string, run: () => void, enabled: boolean) => {
    any = true
    add(label, note, run, enabled)
  }
  if (prop.portable)
    item('拾取', '', () => inventory({ operation: 'pick_up', items: [prop.id] }), idle)
  // 公告栏和张贴处：「张贴公告」打开写公告的对话框，不是站十分钟
  const bulletin = bag.bulletin
  const posting = !!bulletin && (prop.bulletin_board || bulletin.spots.posts.has(prop.id))
  if (bulletin && posting)
    item('张贴公告', '署你的名字', () => bulletin.open(bulletin.spots.board), true)
  for (const action of prop.actions) {
    if (posting && isPostAction(action.label)) continue
    item(
      action.label,
      action.minutes ? `约 ${action.minutes} 分钟` : '',
      () => bag.act({ intent: { verb: action.id }, prop_id: prop.id }),
      idle
    )
    if (action.portion_name && action.supply)
      item(
        `领取${action.portion_name}`,
        '带走一份',
        () => inventory({ operation: 'take', source: prop.id, action: action.id, quantity: 1 }),
        idle
      )
  }
  for (const c of prop.contents ?? [])
    item(
      `取回${c.name}`,
      '',
      () => inventory({ operation: 'retrieve', container: prop.id, items: [c.id] }),
      idle
    )
  if (!any) dim(bag.root, '这件东西现在没有可做的事。')
}

/** 附近的东西摆成格子，选中一件时出动作单 */
function nearbyTiles(bag: BagView) {
  const { root, state, ui } = bag
  root.append(el('h4', '附近的东西'))
  const near = (state.props ?? []).filter((p) => !p.carried)
  if (!near.length) {
    dim(
      root,
      isTouch()
        ? '走近东西，它会在地图上出现标签；点标签或右下角的按钮拾取、使用。'
        : '走近东西，它会在地图上出现标签；按 E 拾取或使用。'
    )
    return
  }
  const grid = el('div')
  grid.className = 'avatar-tiles'
  for (const p of near) {
    const key = `prop:${p.id}`
    const note = p.portable ? '可拾取' : p.storage_slots ? '可存放' : (p.actions[0]?.label ?? '')
    grid.append(tile(bag, key, p.name, note, toggle(ui, key)))
  }
  root.append(grid)
  const prop = near.find((p) => `prop:${p.id}` === ui.selected)
  if (prop) propSheet(bag, prop)
}

export function renderBag(
  root: HTMLElement,
  state: AvatarState,
  execute: Execute,
  ui: BagSelection,
  /** 游戏界面：物品格画背包图标 */
  game: boolean,
  bulletin?: BulletinTargets | null
) {
  const a = state.actor
  if (!a) return
  const active = state.controlled && state.speed > 0
  const act = (draft: PlayerAction) =>
    void execute({ kind: 'action', revision: a.revision, action: draft })
  const bag: BagView = {
    root,
    state,
    actor: a,
    ui,
    game,
    idle: active && !a.busy,
    blocked: !state.speed ? '世界已暂停' : a.busy ? '正在做别的事' : '',
    act,
    inventory: (op) => act({ intent: { verb: verbs[op.operation] }, inventory: op }),
    interact: (command) => void execute({ kind: 'interact', revision: a.revision, command }),
    bulletin,
  }
  if (!myTiles(bag)) return
  const slot = a.inventory.slots.find((s) => `slot:${s.items[0]}` === ui.selected)
  if (slot) slotSheet(bag, slot)
  nearbyTiles(bag)
}
