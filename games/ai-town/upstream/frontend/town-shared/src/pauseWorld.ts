import { newId } from './ids'
import type { ClientMsg } from './protocol'

/** 一次暂停请求；等后端报告速度为 0 后关闭连接，不在选择页保留游戏连接。 */
export function pauseWorld(endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint)
    let settled = false
    let sent = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      window.removeEventListener('pagehide', leave)
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null
      socket.close()
      if (error) reject(error)
      else resolve()
    }
    const leave = () => finish(new Error('页面已离开'))
    const timeout = setTimeout(() => finish(new Error('暂停确认超时')), 5000)
    window.addEventListener('pagehide', leave, { once: true })
    socket.onopen = () => {
      const pause: ClientMsg = { type: 'set_speed', request_id: newId(), speed: 0 }
      socket.send(JSON.stringify(pause))
      sent = true
    }
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (sent && message.type === 'roster' && message.speed === 0) finish()
      } catch {
        /* 等待有效的后端状态，不能把解析失败当成暂停成功。 */
      }
    }
    socket.onerror = socket.onclose = () => finish(new Error('无法连接游戏服务'))
  })
}
