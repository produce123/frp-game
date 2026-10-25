/** Choose a supported precompressed variant without violating q=0 exclusions. */
export function preferredEncoding(header = '') {
  const values = new Map(
    String(header)
      .toLowerCase()
      .split(',')
      .map((part) => {
        const [name, ...parameters] = part.trim().split(';')
        const quality = parameters.find((p) => p.trim().startsWith('q='))
        const q = quality ? Number(quality.trim().slice(2)) : 1
        return [name, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0]
      })
  )
  const q = (name) => values.get(name) ?? values.get('*') ?? 0
  if (q('br') > 0 && q('br') >= q('gzip')) return 'br'
  return q('gzip') > 0 ? 'gzip' : null
}
