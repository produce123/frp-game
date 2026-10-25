// 村民表单里可点的词：点一下把一句话写进框里，再点一次删掉；框里的字照样能手改。
// 词库只是起头，按下与否看框里有没有这句话，所以手写、模型生成的内容也一样能对上。
import { button, el } from '../dom'
import './picks.css'

/** 按钮上的字；写进框里的话不一样时写成 [按钮上的字, 写进去的话] */
type Word = string | [label: string, text: string]
interface Group {
  caption: string
  words: Word[]
}
/** 同一栏里几句话之间用什么隔开：性格、说话、驱动力是并列的倾向，背景是一句一句的经历，兴趣是一串名词 */
type Sep = '；' | '。' | '、'
type Control = HTMLInputElement | HTMLTextAreaElement

/** 与 host 的 library.rs 一致：标签最多 8 个，每个不超过 12 字 */
const TAGS_MAX = 8
const TAG_MAX_CHARS = 12

/** 性格标签分三组；选了标签，性格框里补上那句倾向 */
const TAG_GROUPS: Group[] = [
  {
    caption: '性子',
    words: [
      ['温和', '待人温和，很少跟人红脸'],
      ['直率', '有话直说，不太会拐弯抹角'],
      ['慢性子', '做事不紧不慢，催也没用'],
      ['急性子', '性子急，事情不办完心里不踏实'],
      ['乐天', '遇到糟心事也先往好处想'],
      ['爱操心', '总替别人操心，闲不下来'],
    ],
  },
  {
    caption: '待人',
    words: [
      ['热心肠', '谁有难处都愿意搭把手'],
      ['内向', '人多时话少，熟了才放得开'],
      ['健谈', '跟谁都能聊上半天'],
      ['嘴硬心软', '嘴上不饶人，心里其实软'],
      ['爱面子', '很在意别人怎么看自己'],
      ['讲义气', '朋友的事当自己的事办'],
    ],
  },
  {
    caption: '做事',
    words: [
      ['细心', '做事细，小地方都留意得到'],
      ['马虎', '大大咧咧，常丢三落四'],
      ['固执', '认定的事很难被说动'],
      ['务实', '先看能不能做成，再谈喜不喜欢'],
      ['好奇', '看到新鲜事就想凑过去问问'],
      ['念旧', '舍不得旧东西和老习惯'],
    ],
  },
]
const TAG_SENTENCES = new Map(TAG_GROUPS.flatMap((g) => g.words).map((w) => [label(w), text(w)]))

const SPEECH: Word[] = [
  ['慢条斯理', '慢条斯理，不急着把话说完'],
  ['话少', '话少，能一个字说完不用两个'],
  ['话多', '话多，一开口就停不下来'],
  '爱打比方',
  ['爱讲从前', '聊着聊着就讲起从前的事'],
  ['客客气气', '客客气气，常把「劳驾」「多谢」挂在嘴边'],
  ['爱开玩笑', '爱开玩笑，冷场时总是先接话'],
  ['爱反问', '习惯用反问句'],
  ['喊人小名', '开口先喊人小名'],
]
/** 背景是来小镇之前的事：人设里写明这是入村第一天，所以不写「在本镇长大」 */
const BACKGROUND: Word[] = [
  ['城里来的', '在城里住了很多年，想换个慢一点的地方过日子'],
  ['海边长大', '在海边长大，从小跟着船出海'],
  ['手艺人家', '家里几代都做手艺活，从小在作坊里打下手'],
  ['走南闯北', '年轻时走南闯北，去过不少地方'],
  ['刚念完书', '刚念完书，想找个地方试试自己的本事'],
  ['刚退休', '干了一辈子本行，去年退休'],
  ['开过小店', '以前开过一家小店，后来关了'],
  ['带大孩子', '一个人把孩子拉扯大，孩子成家后自己搬了出来'],
  ['重新开始', '前些年遇到些不顺，想换个地方重新开始'],
]
const DRIVES: Word[] = [
  ['开自己的店', '想开一家属于自己的店'],
  ['传手艺', '想把手艺传给愿意学的人'],
  ['交朋友', '想交到几个能说心里话的朋友'],
  ['被人认可', '想被大家当回事、认真对待'],
  ['做出好东西', '想做出一件让自己挑不出毛病的东西'],
  ['让人吃好', '想让身边的人都吃得好一点'],
  ['攒钱远行', '想攒够钱去远方看看'],
  ['安稳过日子', '只想安安稳稳过日子'],
]
const HOBBIES: Word[] = [
  '钓鱼',
  '下棋',
  '看书',
  '散步',
  '侍弄花草',
  '做点心',
  '画画',
  '唱歌',
  '喝茶聊天',
  '修修补补',
]
const OCCUPATIONS = [
  '木匠',
  '渔夫',
  '厨师',
  '面包师',
  '花匠',
  '裁缝',
  '邮差',
  '老师',
  '店主',
  '咖啡师',
  '学徒',
]

function label(w: Word) {
  return typeof w === 'string' ? w : w[0]
}
function text(w: Word) {
  return typeof w === 'string' ? w : w[1]
}

/** 话前后得是句读或开头结尾才算，免得「河边钓鱼」里的「钓鱼」也被当成按下 */
const BOUNDARY = /[；;，,、。.！!？?…\s]/
function locate(value: string, phrase: string) {
  for (let i = value.indexOf(phrase); i >= 0; i = value.indexOf(phrase, i + 1)) {
    const before = value[i - 1]
    const after = value[i + phrase.length]
    const open = before === undefined || BOUNDARY.test(before)
    if (open && (after === undefined || BOUNDARY.test(after))) return i
  }
  return -1
}
const has = (value: string, phrase: string) => locate(value, phrase) >= 0

/** 接在已有的话后面，整段以句号收尾 */
function addPhrase(value: string, phrase: string, sep: Sep) {
  let t = value.trimEnd()
  if (!t) return phrase + '。'
  if (/[；;，,、]$/.test(t)) t = t.slice(0, -1)
  if (/[。.]$/.test(t)) t = sep === '。' ? t : t.slice(0, -1) + sep
  else if (!/[！!？?…]$/.test(t)) t += sep
  return t + phrase + '。'
}
/** 连同后面的分隔一起删；删的是最后一句时，前一句末尾的分隔换回句号 */
function removePhrase(value: string, phrase: string) {
  const i = locate(value, phrase)
  if (i < 0) return value
  let before = value.slice(0, i)
  let after = value.slice(i + phrase.length)
  const mark = /^[；;，,、。.]/.exec(after)?.[0]
  if (mark) after = after.slice(1)
  if (!after.trim()) {
    before = before.trimEnd()
    if (/[；;，,、]$/.test(before)) before = before.slice(0, -1) + (mark ? '。' : '')
  }
  return (before + after).trim()
}
/** 改框里的字并发 input 事件：人设预览和按钮的按下状态都跟着走 */
function setPhrase(control: Control, phrase: string, on: boolean, sep: Sep) {
  if (has(control.value, phrase) === on) return
  control.value = on ? addPhrase(control.value, phrase, sep) : removePhrase(control.value, phrase)
  control.dispatchEvent(new Event('input'))
}

function chip(name: string, onClick: () => void) {
  const b = button(name, onClick, 'rv-pick')
  b.setAttribute('aria-pressed', 'false')
  return b
}
/** 一组一行，组名在左边单占一列，词多了在右边折行 */
function rows(groups: Group[], make: (w: Word) => HTMLButtonElement) {
  const root = el('div', '', 'rv-picks')
  for (const g of groups) {
    if (!g.words.length) continue
    const words = el('div', '', 'rv-pick-row')
    words.setAttribute('role', 'group')
    words.append(...g.words.map(make))
    if (!g.caption) {
      root.append(words)
      continue
    }
    words.setAttribute('aria-label', g.caption)
    const row = el('div', '', 'rv-pick-group')
    row.append(el('span', g.caption, 'rv-pick-caption'), words)
    root.append(row)
  }
  return root
}

/** 多选：每个词对应框里的一句话 */
function phrasePicks(control: Control, groups: Group[], sep: Sep) {
  const chips: [HTMLButtonElement, string][] = []
  const root = rows(groups, (w) => {
    const b = chip(label(w), () => setPhrase(control, text(w), !has(control.value, text(w)), sep))
    chips.push([b, text(w)])
    return b
  })
  const paint = () => {
    for (const [b, t] of chips) b.setAttribute('aria-pressed', String(has(control.value, t)))
  }
  control.addEventListener('input', paint)
  paint()
  return root
}
/** 单选：点一下把框换成这个词，再点清空 */
function choicePicks(control: Control, words: string[]) {
  const chips: [HTMLButtonElement, string][] = []
  const root = rows([{ caption: '', words }], (w) => {
    const b = chip(label(w), () => {
      control.value = control.value.trim() === label(w) ? '' : label(w)
      control.dispatchEvent(new Event('input'))
    })
    chips.push([b, label(w)])
    return b
  })
  const paint = () => {
    for (const [b, w] of chips) b.setAttribute('aria-pressed', String(control.value.trim() === w))
  }
  control.addEventListener('input', paint)
  paint()
  return root
}

/** 各栏框上方的词；兴趣里的地方用这个小镇的，所以要在建表单时给 */
export function fieldPicks(places: string[]): Partial<Record<string, (c: Control) => HTMLElement>> {
  return {
    speech: (c) => phrasePicks(c, [{ caption: '', words: SPEECH }], '；'),
    background: (c) => phrasePicks(c, [{ caption: '', words: BACKGROUND }], '。'),
    drives: (c) => phrasePicks(c, [{ caption: '', words: DRIVES }], '；'),
    interests: (c) =>
      phrasePicks(
        c,
        [
          { caption: '常去', words: places },
          { caption: '爱做', words: HOBBIES },
        ],
        '、'
      ),
    occupation: (c) => choicePicks(c, OCCUPATIONS),
  }
}

const splitTags = (value: string) =>
  value
    .split(/[、,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)

/** 性格标签：上面是已选的（点一下去掉，末尾能自己写），下面三组词。
 *  词库里的标签选上时在性格框里补一句倾向，去掉时删掉没改过的那句。 */
export function tagPicker(personality: Control | undefined, onChange: () => void) {
  let tags: string[] = []
  const count = el('span', '', 'rv-pick-count')
  const list = el('span', '', 'rv-pick-list')
  const own = el('input', '', 'rv-pick-own')
  own.maxLength = TAG_MAX_CHARS
  const box = el('div', '', 'rv-pick-chosen')
  box.append(list, own)
  // 点框里空白处也能接着写
  box.addEventListener('click', (e) => {
    if (e.target === box) own.focus()
  })
  const pool: [HTMLButtonElement, string][] = []
  const groups = rows(TAG_GROUPS, (w) => {
    const b = chip(label(w), () => toggle(label(w)))
    pool.push([b, label(w)])
    return b
  })
  const paint = () => {
    list.replaceChildren(
      ...tags.map((t) => {
        const b = chip(t, () => toggle(t))
        b.classList.add('chosen')
        b.setAttribute('aria-pressed', 'true')
        b.setAttribute('aria-label', `去掉 ${t}`)
        return b
      })
    )
    const full = tags.length >= TAGS_MAX
    for (const [b, t] of pool) {
      const on = tags.includes(t)
      b.setAttribute('aria-pressed', String(on))
      b.disabled = full && !on
    }
    own.disabled = full
    own.placeholder = full ? `最多 ${TAGS_MAX} 个` : tags.length ? '自己写' : '点下面的词，或自己写'
    count.textContent = `${tags.length} / ${TAGS_MAX}`
  }
  const toggle = (t: string) => {
    const on = !tags.includes(t)
    if (on && tags.length >= TAGS_MAX) return
    tags = on ? [...tags, t] : tags.filter((x) => x !== t)
    const sentence = TAG_SENTENCES.get(t)
    if (sentence && personality) setPhrase(personality, sentence, on, '；')
    paint()
    onChange()
  }
  const pending = () =>
    splitTags(own.value)
      .map((t) => t.slice(0, TAG_MAX_CHARS))
      .filter((t) => !tags.includes(t))
  const commit = () => {
    for (const t of pending()) if (tags.length < TAGS_MAX && !tags.includes(t)) toggle(t)
    own.value = ''
  }
  own.addEventListener('keydown', (e) => {
    // 输入法选字时的回车不算
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Backspace' && !own.value && tags.length) toggle(tags[tags.length - 1])
  })
  own.addEventListener('input', (e) => {
    if (!(e as InputEvent).isComposing && /[、,，\s]/.test(own.value)) commit()
  })
  own.addEventListener('blur', commit)
  paint()
  return {
    count,
    box,
    groups,
    own,
    /** 还没按回车的那个也算上，保存时不丢 */
    value: () => [...new Set([...tags, ...pending()])].slice(0, TAGS_MAX),
    set(next: string[]) {
      tags = [...new Set(next)].slice(0, TAGS_MAX)
      own.value = ''
      paint()
    },
  }
}
