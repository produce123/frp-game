/** 极简 markdown：标题 / 列表 / 段落。先转义 HTML，不引入依赖。 */
export function renderMarkdown(src: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const out: string[] = []
  let listOpen = false
  let para: string[] = []
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(esc).join('<br>')}</p>`)
      para = []
    }
  }
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>')
      listOpen = false
    }
  }
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd()
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flushPara()
      closeList()
      out.push(`<h${h[1].length}>${esc(h[2])}</h${h[1].length}>`)
      continue
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line)
    if (li) {
      flushPara()
      if (!listOpen) {
        out.push('<ul>')
        listOpen = true
      }
      out.push(`<li>${esc(li[1])}</li>`)
      continue
    }
    if (line.trim() === '') {
      flushPara()
      closeList()
      continue
    }
    closeList()
    para.push(line)
  }
  flushPara()
  closeList()
  return out.join('')
}
