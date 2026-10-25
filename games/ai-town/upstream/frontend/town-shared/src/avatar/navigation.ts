import type { GameMap, WalkStep, WalkTarget } from '../gameMap'
import type { AvatarCommand, AvatarState } from './types'
import type { ClientMsg, WorldHold } from '../protocol'
import type { AvatarTarget } from './ui-types'
import { createWalkingInput } from './input'
import { createWalkTo } from './walkTo'
interface AvatarNavigationDeps {
  map: GameMap
  signal: AbortSignal
  getState: () => AvatarState | null
  getWorld: () => string
  getHolds: () => WorldHold[]
  owned: () => boolean
  mapVisible: () => boolean
  send: (msg: ClientMsg) => void
  execute: (cmd: AvatarCommand) => Promise<boolean>
  targets: () => AvatarTarget[]
  /** Tab 换当前对象；没有可换的返回 false */
  cycleTarget?: (step: 1 | -1) => boolean
  toggleBag: () => void
  showToast: (message: string, sticky?: boolean) => void
  /** 化身方向变化（已按能否行走归零），供脚步声使用 */
  onDirection?: (direction: [number, number]) => void
}

/** 行走输入、点击目标的路线与到达后的互动。 */
export function createAvatarNavigation(deps: AvatarNavigationDeps) {
  const { map, signal, getState, getWorld, getHolds, owned, mapVisible, send, execute } = deps
  const { targets, cycleTarget, toggleBag, showToast, onDirection } = deps
  // 化身输入的序号：换租约时从头计
  let inputSequence = 0
  const canWalk = () => {
    const state = getState()
    return (
      owned() &&
      mapVisible() &&
      !!map.avatarSupported &&
      !!state?.speed &&
      !state?.actor?.busy &&
      (state?.mode !== 'possession' || !!state?.actor?.body?.can_move)
    )
  }
  const emitDirection = (direction: [number, number]) => {
    const state = getState()
    if (!owned()) return
    if (!canWalk()) direction = [0, 0]
    onDirection?.(direction)
    // 还没拿到租约时不发
    if (!state?.epoch) return
    send({
      type: 'avatar_input',
      world_id: getWorld(),
      epoch: state.epoch,
      sequence: ++inputSequence,
      navigation_revision: state.navigation_revision ?? 1,
      direction,
    })
  }
  const emitManualDirection = (direction: [number, number]) =>
    emitDirection(map.walkDirection?.(direction) ?? direction)
  const primaryAction = () => {
    if (owned())
      targets()
        .find((t) => t.prompt.key)
        ?.run()
  }
  const bagAction = () => {
    if (owned() && mapVisible()) toggleBag()
  }
  /** 化身此刻的米制位置；自由位置最准，站在落脚点时退回地图上的坐标 */
  const herePoint = (): WalkTarget | undefined => {
    const state = getState()
    const a = state?.actor
    if (!a) return undefined
    const at = a.locus.at
    if (at.kind === 'free') return { space: at.space, position: at.position }
    return map.walkTargetOf?.('person', a.id)
  }
  // 走到目标后要做的那件事（提示编号）；只是走过去时为空
  let arriveAction: string | null = null
  /** 正在走向的人：他走开（出门、进屋、换地方）时路线跟着改，不扑空到他原来站的地方 */
  let chasing: { id: string; at: WalkTarget; checked: number } | null = null
  // 路线经过门时化身自己发开门命令，这一下不算用户改主意，不该清掉路线
  let autoPortal = false
  /** 选一条绕开障碍的路线；地图没有选路能力时退回直线 */
  function planRoute(to: WalkTarget): WalkStep[] | null {
    const here = herePoint()
    if (!here) return null
    if (!map.walkRoute) return [{ point: to }]
    return map.walkRoute(here, to)
  }
  const walk = createWalkTo({
    here: herePoint,
    speed: () => getState()?.speed ?? 0,
    canWalk,
    emit: emitDirection,
    portal: async (id) => {
      autoPortal = true
      try {
        return await execute({ kind: 'portal', id })
      } finally {
        autoPortal = false
      }
    },
    replan: planRoute,
    end: (reason) => {
      map.setAvatarDestination?.(null)
      const object = arriveAction
      arriveAction = null
      chasing = null
      if (reason === 'arrived' && object) runOnArrival(object)
      else if (reason === 'blocked')
        showToast(object ? '走不过去，先靠近一点再点' : '走不过去，换个位置试试')
    },
  })
  /** 走到了：这时的状态就是后端按同一位置算出来的，能做就直接做 */
  function runOnArrival(id: string) {
    const target = targets().find((t) => t.prompt.id === id)
    if (target && !target.prompt.muted) target.run()
    else showToast(target ? target.prompt.label : '走到了，但现在够不着')
  }
  const input = createWalkingInput(
    canWalk,
    (direction) => {
      // 按方向键就放弃点击的目标；松键和失焦发的零向量不算
      if (direction[0] || direction[1]) walk.clear()
      emitManualDirection(direction)
    },
    primaryAction,
    signal,
    { KeyB: bagAction },
    cycleTarget
  )
  // 触屏摇杆：按住时每 100 毫秒重发一次方向（后端的输入会过期），松手发零向量
  let stickDirection: [number, number] | null = null
  let stickTimer = 0
  function stick(direction: [number, number] | null) {
    if (!direction) {
      if (!stickDirection) return
      stickDirection = null
      clearInterval(stickTimer)
      emitDirection([0, 0])
      return
    }
    if (!stickDirection) {
      walk.clear()
      stickTimer = window.setInterval(() => {
        if (stickDirection) emitManualDirection(stickDirection)
      }, 100)
    }
    stickDirection = direction
    emitManualDirection(direction)
  }
  signal.addEventListener('abort', () => clearInterval(stickTimer))
  /** 停下：方向键、摇杆和点击目标一起清掉。化身自己开门那一下除外，那是路线的一部分。 */
  function stopMoving() {
    input.stop()
    stick(null)
    if (!autoPortal) walk.clear()
  }
  /** 设一个新的点击目标；走不了就说明原因 */
  function startWalk(target: WalkTarget, radius: number, object: string | null): boolean {
    const state = getState(),
      holds = getHolds()
    if (!owned()) return false
    if (!state?.speed) {
      showToast(holds.length ? '世界因故暂停，请查看交谈面板中的原因' : '世界已暂停，请先继续运行')
      return false
    }
    if (state.actor?.busy) {
      showToast(`正在${state.actor.activity}，停下来才能走动`, true)
      return false
    }
    if (!canWalk()) {
      showToast('现在的身体状况走不动', true)
      return false
    }
    if (!herePoint()) {
      showToast('位置还没同步，请稍候再点', true)
      return false
    }
    const route = planRoute(target)
    if (!route?.length) {
      showToast('找不到能走过去的路')
      return false
    }
    arriveAction = object
    walk.set(route, radius)
    map.setAvatarDestination?.(target)
    return true
  }
  /** 点地图上的人或道具：够得着就直接做，够不着就走过去，到了再做一次。
   *  点自己或对象不在图上时交回观察界面。 */
  function reachFor(kind: 'person' | 'prop', id: string): boolean {
    const state = getState()
    if (kind === 'person' && id === state?.actor?.id) return false
    const object = `${kind}:${id}`
    const ready = targets().find((t) => t.prompt.id === object)
    if (ready && !ready.prompt.muted && state?.speed && !state.actor?.busy) {
      ready.run()
      return true
    }
    const target = map.walkTargetOf?.(kind, id)
    if (!target) return false
    // 停在伸手可及的距离外（后端道具 1.6 米、交谈 3 米），不踩到对象身上
    if (startWalk(target, kind === 'person' ? 1.4 : 1.2, object) && kind === 'person')
      chasing = { id, at: target, checked: performance.now() }
    return true
  }
  /** 每收到一次化身状态：要找的人挪开两米以上（或进了别的屋子），按他现在的位置重新选路 */
  function followChased() {
    if (!chasing || !arriveAction) return
    const now = performance.now()
    if (now - chasing.checked < 800) return
    chasing.checked = now
    const there = map.walkTargetOf?.('person', chasing.id)
    if (!there) return
    const moved =
      there.space !== chasing.at.space ||
      Math.hypot(
        there.position[0] - chasing.at.position[0],
        there.position[1] - chasing.at.position[1]
      ) > 2
    if (!moved) return
    const route = planRoute(there)
    if (!route?.length) return
    chasing.at = there
    walk.set(route, 1.4)
    map.setAvatarDestination?.(there)
  }
  map.onAvatarWalkTo = (target) => {
    if (owned() && startWalk(target, 0.5, null)) chasing = null
  }
  signal.addEventListener('abort', () => {
    map.onAvatarWalkTo = null
    map.setAvatarDestination?.(null)
  })
  return {
    canWalk,
    walk,
    followChased,
    stopMoving,
    reachFor,
    stick,
    /** 和按 E 一样：做当前对象的主动作 */
    primary: primaryAction,
    /** 换了租约：输入序号从头计 */
    restartSequence() {
      inputSequence = 0
    },
  }
}
