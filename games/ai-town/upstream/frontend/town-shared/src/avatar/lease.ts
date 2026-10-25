import type { AvatarCommand } from './types'

/** 刷新页面后恢复上次的控制：令牌按世界存在本标签页的会话存储里；
 *  每次连上只试一次，恢复失败就删掉令牌。 */
export function resumeLease(
  world: () => string,
  execute: (command: AvatarCommand) => Promise<boolean>
) {
  const key = () => `town-avatar:${world()}`
  let attempted = false
  function store(token?: string) {
    try {
      if (token) sessionStorage.setItem(key(), token)
      else sessionStorage.removeItem(key())
    } catch {
      /* 控制仍可用，只是不自动恢复 */
    }
  }
  function read() {
    try {
      return sessionStorage.getItem(key())
    } catch {
      return null
    }
  }
  return {
    store,
    /** 重新连上或世界重置后，允许再试一次 */
    allowRetry() {
      attempted = false
    },
    /** 还没在控制时试一次恢复 */
    attempt(controlled: boolean, supported: boolean) {
      const token = read()
      if (!token || attempted || controlled || !supported) return
      attempted = true
      void execute({ kind: 'resume', token }).then((ok) => {
        if (!ok) store()
      })
    },
  }
}
