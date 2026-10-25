export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
// 非 JSON 响应（页面、脚本、模型文件）。
export class Raw {
  constructor(body, headers, status = 200) {
    this.body = body
    this.headers = headers
    this.status = status
  }
}
// 错误到状态码：标注了状态的照用；文件不存在是 404；其他系统错误是 500，且不把路径发给客户端；
// 剩下的都是输入或当前状态不允许，400，带上生成错误的 code 和 details。
export function describe(e) {
  if (e instanceof HttpError) return [e.status, { error: e.message }]
  if (e.code === 'ENOENT') return [404, { error: '请求的小镇或文件不存在' }]
  if (typeof e.errno === 'number' || e.syscall)
    return [500, { error: '服务内部错误', ...(e.code ? { code: e.code } : {}) }]
  return [
    400,
    {
      error: e.message ?? '操作失败',
      ...(e.code ? { code: e.code } : {}),
      ...(e.details ? { details: e.details } : {}),
    },
  ]
}
export async function readBody(req) {
  if (
    req.headers['x-town-client'] !== '1' ||
    !req.headers['content-type']?.startsWith('application/json')
  )
    throw new HttpError(403, '无效的应用请求')
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (text.length > 1_000_000) throw new HttpError(413, '请求过大')
  }
  return JSON.parse(text)
}
