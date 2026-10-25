import type { RosterMember } from 'town-shared/protocol'
import { BubbleTracker } from 'town-shared/bubbles'
import { el } from 'town-shared/svg'

/** SVG 布局单位；实际显示按屏幕缩放为 14px，最多三行。 */
const BUBBLE_FONT = 56
const BUBBLE_LINE_H = 70
const BUBBLE_CHARS_PER_LINE = 12
/** 心声只在缩到 100% 以下时收起（文档写的是道具显示倍率，单人地图在 100% 观察，那阈值太高） */
const BUBBLE_MIN_ZOOM = 0.9

/** 气泡里显示的字：最多 36 字，多出的截成 35 字加省略号 */
function shownChars(line: string) {
  const all = Array.from(line)
  return all.length > 36 ? [...all.slice(0, 35), '…'] : all
}

/** 2D 地图的心声泡：什么时候冒、留多久、挤掉谁按 town-shared 的气泡规则，这里只画 SVG 并让它跟着人走 */
export class ThoughtBubbles {
  readonly layer = el('g', { class: 'bubbles' })
  private groups = new Map<string, SVGGElement>()
  /** 每个心声泡的宽高（SVG 布局单位） */
  private widths = new Map<string, number>()
  private heights = new Map<string, number>()
  /** 按名册算好的位置与缩放；立牌落后的距离另外加上（见 follow） */
  private places = new Map<string, { left: number; bottom: number; sx: number; sy: number }>()
  private lags = new Map<string, [number, number]>()
  private tracker = new BubbleTracker({
    speech: false,
    shown: (line) => shownChars(line).join(''),
    onSpawn: (id, line) => this.draw(id, line),
    onDrop: (id) => {
      this.groups.get(id)?.remove()
      this.groups.delete(id)
      this.widths.delete(id)
      this.heights.delete(id)
      this.places.delete(id)
      this.lags.delete(id)
    },
  })
  setSelected(id: string | null) {
    this.tracker.selected = id
  }
  setZoom(zoom: number) {
    this.layer.classList.toggle('hidden-far', zoom < BUBBLE_MIN_ZOOM)
  }
  /** 世界重置：撤掉气泡与「见过的想法」记录，新世界的第一句想法当新想法冒泡 */
  onReset() {
    this.tracker.reset()
  }

  /** 模拟速度（气泡寿命只在运行时流逝；×0 冻结） */
  setSpeed(speed: number) {
    this.tracker.setSpeed(speed)
  }

  /** 新想法到达 → 冒一个心声泡；已有的泡跟着人走 */
  syncThoughtBubble(member: RosterMember, x: number, y: number) {
    this.tracker.observe(member)
    const g = this.groups.get(member.id)
    if (!g) return
    // 横竖各取一个屏幕像素的地图单位：地面倾斜时视口纵向被压扁，气泡按比例拉回
    const screen = this.layer.getScreenCTM()
    const pixel = 1 / Math.abs(screen?.a || 1),
      pixelY = 1 / Math.abs(screen?.d || 1)
    const F = BUBBLE_FONT
    const row = [...this.groups.keys()].indexOf(member.id)
    // 默认挂在人的右上方；人靠近画面右边时整个泡往左挪，不被屏幕边切掉（左边同理）。
    // 边按地图在屏幕上露出来的范围算：竖屏时 SVG 的视框比看得见的宽，按视框算会出屏
    const width = ((this.widths.get(member.id) ?? 0) * 14 * pixel) / F
    const height = ((this.heights.get(member.id) ?? 0) * 14 * pixelY) / F
    const bottom = y - (150 + row * 90) * pixelY
    let left = x + 28 * pixel
    const edges = screen && this.edges(screen, bottom - height, bottom)
    if (edges) {
      left = Math.min(left, edges.right - width)
      left = Math.max(left, edges.left)
    }
    this.places.set(member.id, { left, bottom, sx: (14 * pixel) / F, sy: (14 * pixelY) / F })
    this.place(member.id)
  }

  /** 立体场景的立牌比名册晚一点走：心声泡跟着立牌平移 */
  follow(id: string, lag: [number, number] | undefined) {
    if (!this.groups.has(id)) return
    if (lag) this.lags.set(id, lag)
    else this.lags.delete(id)
    this.place(id)
  }

  private place(id: string) {
    const g = this.groups.get(id),
      at = this.places.get(id)
    if (!g || !at) return
    const [dx, dy] = this.lags.get(id) ?? [0, 0]
    g.setAttribute(
      'transform',
      `translate(${(at.left + dx).toFixed(2)},${(at.bottom + dy).toFixed(2)}) scale(${at.sx},${at.sy})`
    )
  }

  /** 心声泡能放的左右边（图层单位）：地图露出来的范围留 8 像素，和右上角圆钮同高时让开它们 */
  private edges(screen: DOMMatrix, top: number, bottom: number) {
    const svg = this.layer.ownerSVGElement
    const area = (svg?.closest<HTMLElement>('#map') ?? svg)?.getBoundingClientRect()
    if (!area?.width) return null
    const inverse = screen.inverse()
    const toLayer = (sx: number) => new DOMPoint(sx, 0).matrixTransform(inverse).x
    let right = area.right - 8
    const fabs = document.getElementById('map-fabs')
    if (fabs?.offsetParent) {
      const r = fabs.getBoundingClientRect()
      const y0 = new DOMPoint(0, top).matrixTransform(screen).y
      const y1 = new DOMPoint(0, bottom).matrixTransform(screen).y
      if (Math.max(y0, y1) > r.top && Math.min(y0, y1) < r.bottom)
        right = Math.min(right, r.left - 8)
    }
    return { left: toLayer(area.left + 8), right: toLayer(right) }
  }

  private draw(id: string, line: string) {
    const F = BUBBLE_FONT,
      LH = BUBBLE_LINE_H
    const chars = shownChars(line)
    const lines: string[] = []
    for (let i = 0; i < chars.length; i += BUBBLE_CHARS_PER_LINE) {
      lines.push(chars.slice(i, i + BUBBLE_CHARS_PER_LINE).join(''))
    }
    const widest = Math.max(...lines.map((l) => Array.from(l).length), 1)
    const w = widest * F + 60,
      h = lines.length * LH + 40
    const g = el('g', { class: 'bubble cloud' })
    g.appendChild(el('title', {}, line))
    g.appendChild(el('rect', { x: 0, y: -h, width: w, height: h, rx: 22 }))
    // 云尾：两个小圆朝人头方向递减
    g.appendChild(el('circle', { cx: -6, cy: 16, r: 11 }))
    g.appendChild(el('circle', { cx: -26, cy: 40, r: 6 }))
    const text = el('text', { x: 30, y: -h + 20 })
    lines.forEach((l, i) => {
      text.appendChild(el('tspan', { x: 30, y: -h + 20 + LH * (i + 0.85) }, l))
    })
    g.appendChild(text)
    this.layer.appendChild(g)
    this.groups.set(id, g)
    this.widths.set(id, w)
    this.heights.set(id, h)
  }

  dropBubble(id: string) {
    this.tracker.drop(id)
  }

  /** 寿命只在运行时流逝：暂停（×0）冻结 */
  tickBubbles() {
    this.tracker.tick()
  }
}
