import type { ClientMsg } from '../protocol'
import type { AvatarCommand, AvatarState } from './types'
/** One connection owns request receipts, timeout and mutation admission. */
export function createAvatarCommands({
  context,
  nextSequence,
  stopMoving,
  showToast,
  send,
}: {
  context: () => { online: boolean; world: string; state: AvatarState | null }
  nextSequence: () => number
  stopMoving: () => void
  showToast: (message: string, sticky?: boolean) => void
  send: (message: ClientMsg) => void
}) {
  let pendingMutation = false
  // silent：自动发起的命令（恢复上次控制），失败不打扰用户
  const pending = new Map<
    string,
    { finish: (ok: boolean) => void; timer: number; silent: boolean }
  >()
  async function execute(command: AvatarCommand): Promise<boolean> {
    const { online, world, state } = context()
    if (!online || !world) {
      showToast('连接尚未就绪', true)
      return false
    }
    const mutation = !['view', 'heartbeat'].includes(command.kind)
    if (mutation && pendingMutation) return false
    if (mutation) {
      stopMoving()
      pendingMutation = true
    }
    const request_id = crypto.randomUUID()
    const result = new Promise<boolean>((finish) => {
      const timer = window.setTimeout(() => {
        pending.delete(request_id)
        showToast('尚未收到结果，请先检查连接；不会自动重复执行。', true)
        finish(false)
      }, 8000)
      pending.set(request_id, { finish, timer, silent: command.kind === 'resume' })
    })
    send({
      type: 'avatar',
      world_id: world,
      request_id,
      epoch: state?.epoch ?? '',
      sequence: nextSequence(),
      command,
    })
    const ok = await result
    if (mutation) pendingMutation = false
    return ok
  }

  function settle(requestId: string, ok: boolean) {
    const p = pending.get(requestId)
    if (p) {
      clearTimeout(p.timer)
      pending.delete(requestId)
      p.finish(ok)
    }
    return p
  }
  function clear() {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.finish(false)
    }
    pending.clear()
  }
  return {
    execute,
    settle,
    clear,
    get pendingMutation() {
      return pendingMutation
    },
  }
}
