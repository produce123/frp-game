import { playerText } from '../format'
import type { NotebookCategory } from './protocol'
import { el } from '../dom'

export const categories: {
  id: NotebookCategory
  label: string
  icon: string
  description: string
  empty: string
}[] = [
  {
    id: 'recent',
    label: '最近记住的事',
    icon: 'book',
    description: '按天整理的重要经历，以及当时的想法。',
    empty: '经历已经记下，还没整理成摘要',
  },
  {
    id: 'people',
    label: '对人的认识',
    icon: 'person',
    description: '从相处中留下的印象；认识可能随着新经历改变。',
    empty: '还没有对某个人形成认识',
  },
  {
    id: 'places',
    label: '对地方的认识',
    icon: 'place',
    description: '记住的地点信息，保留它们的来源和适用范围。',
    empty: '还没有整理出地点信息',
  },
  {
    id: 'lessons',
    label: '知识与经验',
    icon: 'leaf',
    description: '从阅读和实践中学到的具体内容。',
    empty: '还没有提炼出知识或经验',
  },
  {
    id: 'self_knowledge',
    label: '对自己的认识',
    icon: 'self',
    description: '经历之后形成的自我判断，与最初的人设分开记录。',
    empty: '还没有从经历中形成自我认识',
  },
  {
    id: 'goals',
    label: '还惦记的事',
    icon: 'goal',
    description: '当前目标与承诺；已结束的事项留在后面。',
    empty: '还没有记下目标或承诺',
  },
  {
    id: 'events',
    label: '原始经历',
    icon: 'clock',
    description: '事情发生时的记录。摘要和认识都可以回到这里查依据。',
    empty: '还没有记录经历',
  },
]

const paths: Record<string, string> = {
  book: 'M3 4h6c2 0 3 1 3 3v14c0-2-1-3-3-3H3zM21 4h-6c-2 0-3 1-3 3v14c0-2 1-3 3-3h6z',
  person: 'M8.5 7a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M5 21v-3a7 7 0 0 1 14 0v3',
  place: 'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0zM10 10a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  leaf: 'M20 3C8 3 3 6 4 13s13 11 16-10zM4 21l10-12',
  self: 'M12 21s-9-5-9-12a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 7-9 12-9 12z',
  goal: 'M6 22V3m0 1c4-4 8 4 13 0v10c-5 4-9-4-13 0',
  clock: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7v6l4 2',
}
export function icon(name: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', paths[name] ?? paths.book)
  svg.append(path)
  return svg
}
/** 仅排版已有正文，不生成摘要、修正原因或新认识；所有文本通过 textContent 写入。
 *  模型写记忆时照抄的内部编号和分钟数先按 playerText 收拾掉 */
export function prose(value: string, className = 'nb-prose') {
  const box = el('div', '', className)
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) box.append(el('p', paragraph.join('\n')))
    paragraph = []
  }
  for (const line of playerText(value).split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading) {
      flush()
      box.append(el('h4', heading[1]))
    } else if (!line.trim()) flush()
    else paragraph.push(line)
  }
  flush()
  return box
}
