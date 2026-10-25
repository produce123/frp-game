/** 客户端生成的标识：请求编号、实例编号。非安全上下文没有 randomUUID，退回时间戳加随机数。 */
export function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const clientId = newId()
let serial = 0

/** 本页面内唯一的请求编号；服务端原样回传，用来丢弃过时回包。 */
export function nextRequestId(): string {
  return `${clientId}:${++serial}`
}
