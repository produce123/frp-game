const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function generateShortId(prefix: string, length = 6): string {
  let id = ''
  for (let i = 0; i < length; i++) {
    id += CHARS[Math.floor(Math.random() * CHARS.length)]
  }
  return `${prefix}-${id}`
}
