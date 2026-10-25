import { GENERATOR_VERSION } from './budget.mjs'
import { sha256Hex } from './sha256.mjs'
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}
export function hashDocument(document) {
  const { content_hash, ...content } = document
  return sha256Hex(canonical(content))
}
export function seal(document) {
  document.content_hash = hashDocument(document)
  return document
}
export function checkIdentity(document) {
  if (
    ![1, 2].includes(document.schema_version) ||
    document.style_id !== 'svg-town-v1' ||
    document.style_version !== 1
  )
    throw Error('不支持的地图或显示版本')
  if (document.content_hash !== hashDocument(document)) throw Error('地图内容摘要不一致')
}
function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function stream(seed, namespace, id = '') {
  // 摘要前 4 个字节按大端读成无符号整数，就是十六进制的前 8 位
  return random(
    parseInt(sha256Hex(canonical([GENERATOR_VERSION, seed, namespace, id])).slice(0, 8), 16)
  )
}
export function noise(seed, namespace, scale) {
  const cache = new Map()
  const value = (x, y) => {
    const k = `${x},${y}`
    if (!cache.has(k)) cache.set(k, stream(seed, namespace, k)())
    return cache.get(k)
  }
  return (x, y) => {
    x /= scale
    y /= scale
    const ix = Math.floor(x),
      iy = Math.floor(y)
    const fade = (t) => t * t * (3 - 2 * t),
      tx = fade(x - ix),
      ty = fade(y - iy)
    return (
      (value(ix, iy) * (1 - tx) + value(ix + 1, iy) * tx) * (1 - ty) +
      (value(ix, iy + 1) * (1 - tx) + value(ix + 1, iy + 1) * tx) * ty
    )
  }
}
