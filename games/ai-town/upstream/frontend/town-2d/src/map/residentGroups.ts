import type { LabelRect } from './labelLayout'
import { el } from 'town-shared/svg'
// 多人标签：名字在屏幕上挨得太近的村民合成一个「南入口 · 8 人」，前面叠几个小头像；
// 点开是名单（头像、名字、状态），点名单里的人等于在地图上点了他。
// 分组按名字框算：名字框在世界坐标里的大小就是它在屏幕上的大小换算过来的，拉近镜头名字间距变大，组自然分开。

/** 标签按屏幕像素设计，渲染时按缩放倍率换算成世界单位 */
const HEIGHT = 24,
  FACE = 18,
  FACE_STEP = 12,
  MAX_FACES = 4,
  PAD = 3,
  TEXT_GAP = 6,
  TEXT_PAD = 10,
  /** 名字框之间空不出这么多屏幕像素就算挨着 */
  NEAR = 24

export interface GroupMember {
  id: string
  name: string
  status: string
  place: string
  portrait?: string
}

interface NameBox extends LabelRect {
  id: string
}

/** 名字框互相挨着的人连成一组（传递：甲挨乙、乙挨丙，三人一组）；只返回两人及以上的组 */
export function clusterNames(boxes: NameBox[], unit: number): string[][] {
  const gap = NEAR * unit
  const root = boxes.map((_, i) => i)
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])))
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i],
        b = boxes[j]
      if (
        a.x < b.x + b.width + gap &&
        b.x < a.x + a.width + gap &&
        a.y < b.y + b.height + gap &&
        b.y < a.y + a.height + gap
      )
        root[find(i)] = find(j)
    }
  const groups = new Map<number, string[]>()
  boxes.forEach((box, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), box.id]))
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort())
}

export class ResidentGroups {
  readonly layer = el('g', { class: 'vgroups' })
  private readonly list = document.createElement('div')
  /** 名单里列的人；名单关着时为空 */
  private listed: string[] = []
  private listSignature = ''
  private groups = new Map<string, string[]>()
  private closeListeners: AbortController | null = null

  constructor(
    private describe: (id: string) => GroupMember | undefined,
    private onPick: (id: string) => void
  ) {
    this.layer.append(faceClip())
    this.list.className = 'vgroup-list'
    this.list.hidden = true
    this.list.setAttribute('role', 'menu')
    // 名单上的按下、双击、滚轮不能漏给地图，否则会被当成拖动或缩放
    for (const type of ['pointerdown', 'dblclick', 'wheel'] as const)
      this.list.addEventListener(type, (ev) => ev.stopPropagation())
  }

  /** 按名字框分组并画组标签。boxes 是可以合并的人的名字框（世界坐标）；
   *  返回被合并的人和组标签占的区域，名字避让时要绕开 */
  update(boxes: NameBox[], upright: number): { grouped: Set<string>; occupied: LabelRect[] } {
    this.layer.querySelectorAll('.vgroup').forEach((g) => g.remove())
    const screen = this.layer.getScreenCTM()
    const k = screen?.a ? 1 / Math.abs(screen.a) : 1
    const ky = k * upright
    const byId = new Map(boxes.map((b) => [b.id, b]))
    const grouped = new Set<string>()
    const occupied: LabelRect[] = []
    this.groups.clear()
    for (const ids of clusterNames(boxes, k)) {
      const key = ids.join('|')
      this.groups.set(key, ids)
      for (const id of ids) grouped.add(id)
      const members = ids.map((id) => this.describe(id)).filter((m) => !!m)
      const own = ids.map((id) => byId.get(id)!)
      const x = own.reduce((sum, b) => sum + b.x + b.width / 2, 0) / own.length
      const bottom = Math.min(...own.map((b) => b.y + b.height))
      occupied.push(this.drawLabel(key, members, x, bottom, k, ky))
    }
    this.refreshList()
    return { grouped, occupied }
  }

  private drawLabel(
    key: string,
    members: GroupMember[],
    x: number,
    bottom: number,
    k: number,
    ky: number
  ): LabelRect {
    const g = el('g', { class: 'vgroup', 'data-group': key })
    const box = el('rect', { class: 'vgroup-box', rx: HEIGHT / 2, height: HEIGHT })
    g.appendChild(box)
    this.layer.appendChild(g)
    let cx = PAD
    for (const m of members.slice(0, MAX_FACES)) {
      g.append(
        el('circle', {
          class: 'vgroup-face-ring',
          cx: cx + FACE / 2,
          cy: HEIGHT / 2,
          r: FACE / 2 + 1,
        })
      )
      if (m.portrait)
        g.append(
          el('image', {
            class: 'vgroup-face',
            href: m.portrait,
            x: cx,
            y: (HEIGHT - FACE) / 2,
            width: FACE,
            height: FACE,
            'clip-path': 'url(#vgroup-face-clip)',
          })
        )
      cx += FACE_STEP
    }
    cx += FACE - FACE_STEP + TEXT_GAP
    const places = new Set(members.map((m) => m.place))
    const label = `${places.size === 1 ? `${[...places][0]} · ` : ''}${members.length} 人 ▾`
    const text = el('text', { class: 'vgroup-text', x: cx, y: HEIGHT / 2 }, label) as SVGTextElement
    g.appendChild(text)
    const width = cx + text.getComputedTextLength() + TEXT_PAD
    box.setAttribute('width', String(width))
    const left = x - (width * k) / 2,
      top = bottom - HEIGHT * ky
    g.setAttribute('transform', `translate(${left},${top}) scale(${k},${ky})`)
    return { x: left, y: top, width: width * k, height: HEIGHT * ky }
  }

  /** 点了组标签：在点击处弹出名单 */
  open(key: string, client: [number, number]) {
    const ids = this.groups.get(key)
    const container = this.layer.ownerSVGElement?.parentElement
    if (!ids || !container) return
    if (this.list.parentElement !== container) container.append(this.list)
    this.listed = ids
    this.listSignature = ''
    this.refreshList()
    this.list.hidden = false
    const rect = container.getBoundingClientRect()
    const width = this.list.offsetWidth,
      height = this.list.offsetHeight
    const left = Math.min(client[0] - rect.left + 12, rect.width - width - 8)
    const top = Math.min(Math.max(8, client[1] - rect.top - height / 2), rect.height - height - 8)
    this.list.style.left = `${Math.max(8, left)}px`
    this.list.style.top = `${Math.max(8, top)}px`
    // 点名单以外的地方、按 Esc、滚轮缩放都关掉
    this.closeListeners?.abort()
    this.closeListeners = new AbortController()
    const signal = this.closeListeners.signal
    const outside = (ev: Event) => {
      if (!this.list.contains(ev.target as Node)) this.close()
    }
    document.addEventListener('pointerdown', outside, { capture: true, signal })
    container.addEventListener('wheel', () => this.close(), { signal })
    document.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key === 'Escape') this.close()
      },
      { signal }
    )
  }

  close() {
    this.closeListeners?.abort()
    this.closeListeners = null
    this.list.hidden = true
    this.listed = []
  }

  dispose() {
    this.close()
    this.list.remove()
  }

  /** 名单开着时跟着名册更新状态；内容没变不重画 */
  private refreshList() {
    if (!this.listed.length) return
    const members = this.listed.map((id) => this.describe(id)).filter((m) => !!m)
    const signature = JSON.stringify(members)
    if (signature === this.listSignature) return
    this.listSignature = signature
    this.list.replaceChildren(
      ...members.map((m) => {
        const row = document.createElement('button')
        row.type = 'button'
        row.setAttribute('role', 'menuitem')
        const face = document.createElement('img')
        face.alt = ''
        if (m.portrait) face.src = m.portrait
        else face.hidden = true
        const name = document.createElement('span')
        name.className = 'vgroup-name'
        name.textContent = m.name
        const status = document.createElement('span')
        status.className = 'vgroup-status'
        status.textContent = m.status
        row.append(face, name, status)
        row.onclick = () => {
          this.close()
          this.onPick(m.id)
        }
        return row
      })
    )
  }
}

/** 头像裁成圆形 */
function faceClip() {
  const defs = el('defs')
  const clip = el('clipPath', { id: 'vgroup-face-clip', clipPathUnits: 'objectBoundingBox' })
  clip.append(el('circle', { cx: 0.5, cy: 0.5, r: 0.5 }))
  defs.append(clip)
  return defs
}
