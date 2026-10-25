export class TownApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public details?: Record<string, unknown>
  ) {
    super(message)
  }
}
// 平台把游戏挂在 /ai-town/ 下，接口也走同一前缀（见 server/ai-town/index.mjs）。
// 用**相对路径**而不是绝对 `/api/towns`：页面在 /ai-town/ 下就自动落到
// /ai-town/api/towns，上游自己的 `pnpm dev`（站点根）也照常工作。
const API_BASE = 'api/towns'

export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(API_BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Town-Client': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ?? AbortSignal.timeout(120000),
  })
  const isJson = response.headers.get('content-type')?.includes('application/json') ?? false
  const data: Partial<{ error: string; code: string; details: Record<string, unknown> }> | null =
    isJson ? await response.json() : null
  if (!response.ok)
    throw new TownApiError(
      data?.error ??
        `小镇服务返回 ${response.status}${response.statusText ? ' ' + response.statusText : ''}`,
      data?.code,
      data?.details
    )
  if (!isJson) throw new TownApiError('小镇服务返回了非 JSON 内容')
  return data as T
}
