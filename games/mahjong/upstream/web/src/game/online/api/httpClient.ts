// 远程 REST 基础设施：统一服务地址、JSON 编解码与错误模型。
const PAGE_ORIGIN = typeof location !== 'undefined' ? location.origin : 'http://localhost'

/*
 * frp-game 补丁：平台把页面托管在 `/mahjong/` 下，REST 与 WebSocket 都走同目录前缀
 * （Node 网关再转给本机的 Python 后端）。
 *
 * 为什么用**运行时目录**而不是构建时的 `VITE_API_BASE`：隧道域名/端口随时会变，
 * 写死地址等于换域名就白屏。页面在 `/mahjong/` 时它就是 `/mahjong`
 * （fetch → `/mahjong/api/...`，WebSocket → `ws(s)://host/mahjong/ws/...`）。
 * 上游自己的 `VITE_API_BASE`（独立域名部署）仍然优先。
 */
function pageDirBase(): string {
  try {
    return new URL('.', location.href).href.replace(/\/$/, '')
  } catch {
    return PAGE_ORIGIN
  }
}

export const API_BASE = import.meta.env.VITE_API_BASE || pageDirBase()

export class RemoteApiError extends Error {
  code: string
  status: number

  constructor(code: string, status: number) {
    super(code)
    this.name = 'RemoteApiError'
    this.code = code
    this.status = status
  }
}

export const AUTH_REQUIRED_EVENT = 'wakudemo-auth-required'

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!response.ok) {
    let code = `HTTP_${response.status}`
    try {
      const body = await response.json()
      if (body?.detail?.code) code = body.detail.code
    } catch {
      // 非 JSON 错误体，保留 HTTP 状态码。
    }
    if (response.status === 401 && code === 'AUTH_REQUIRED') {
      // 联机接口要求登录：通知应用层引导登录。
      window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))
    }
    throw new RemoteApiError(code, response.status)
  }
  return response.json() as Promise<T>
}
