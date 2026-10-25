import type { GameMap, ScreenBox } from '../gameMap'
import { mapControlRects, visibleMapRect } from '../mapView'
import type { RosterFrame } from '../shell/panel'
import { personRect, placeBubble, type Rect } from './placement'
import type { Speech } from './types'
import './style.css'
type Line = { actor: string; name: string; speech: Speech }
type Bubble = { line: Line; button: HTMLButtonElement; left: number; choice?: number }
/** 显示实际台词，连续发言时保留最新一句，完整顺序见历史；暂停后保留最后一句。 */
export class ChatBubbles {
  private seen = new Map<string, string>()
  private queue: Line[] = []
  private active = new Map<string, Bubble>()
  private last = performance.now()
  private frame = 0
  private speed = 0
  /** 名册里的所有人，气泡据此躲开旁人 */
  private people: string[] = []
  constructor(
    private map: GameMap,
    private container: HTMLElement,
    private open: (actor: string, chat: string) => void
  ) {
    this.frame = requestAnimationFrame((t) => this.tick(t))
  }
  roster({ entries, msg }: RosterFrame) {
    const minutes = msg.sim_minutes
    this.speed = msg.speed
    this.people = entries.map((e) => e.member.id)
    const added: Line[] = []
    for (const { member: m } of entries) {
      const s = m.speech
      if (!s) continue
      const key = `${s.chat_id}:${s.seq}`
      if (this.seen.get(m.id) === key) continue
      this.seen.set(m.id, key)
      if (minutes - s.at <= 2 || m.chat) added.push({ actor: m.id, name: m.name, speech: s })
    }
    added.sort((a, b) => a.speech.at - b.speech.at || a.speech.seq - b.speech.seq)
    for (const line of added) {
      const id = line.speech.chat_id
      this.queue = this.queue.filter((v) => v.speech.chat_id !== id)
      this.queue.push(line)
      const current = this.active.get(id)
      if (current) current.left = Math.min(current.left, 1800)
    }
  }
  private tick(now: number) {
    const dt = Math.min(250, now - this.last)
    this.last = now
    // 只在地图露出来的地方放气泡：底部抽屉、右侧面板、化身操作区盖住的部分不算
    const rect = visibleMapRect(this.container)
    const showing = rect.right - rect.left > 40 && rect.bottom - rect.top > 40
    const occupied: Rect[] = []
    let controls: Rect[] | null = null
    const others = new Map<string, Rect>()
    const boxOf = (actor: string): ScreenBox | undefined => {
      const box = this.map.getScreenBox?.(actor)
      if (box) return box
      const pos = this.map.getScreenPos?.(actor)
      return pos && { x: pos[0], feet: pos[1], top: pos[1] - 40, half: 20 }
    }
    for (const [id, bubble] of this.active) {
      // 暂停时先显示已经收到的最后一句，再冻结阅读，避免停在积压的旧台词上。
      if (showing && (this.speed > 0 || this.queue.some((v) => v.speech.chat_id === id)))
        bubble.left -= dt
      if (bubble.left <= 0) {
        bubble.button.remove()
        this.active.delete(id)
        continue
      }
      const actor = bubble.line.actor
      const box = boxOf(actor)
      bubble.button.hidden =
        !showing ||
        !box ||
        box.x < rect.left ||
        box.x > rect.right ||
        box.feet < rect.top ||
        box.feet > rect.bottom
      if (bubble.button.hidden || !box) continue
      if (!others.size)
        for (const person of this.people) {
          const other = boxOf(person)
          if (other) others.set(person, personRect(other))
        }
      // 地图上的按钮和提示也躲开，气泡是可以点的，不能挡住它们
      controls ??= mapControlRects(this.container).map((r) => ({
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
      }))
      const avoid = [...others].filter(([person]) => person !== actor).map(([, r]) => r)
      avoid.push(...controls, ...controls)
      const size = { w: bubble.button.offsetWidth, h: bubble.button.offsetHeight }
      const place = placeBubble(box, size, rect, [...avoid, ...occupied], bubble.choice)
      bubble.choice = place.choice
      bubble.button.dataset.side = place.side
      bubble.button.style.left = `${place.x}px`
      bubble.button.style.top = `${place.y}px`
      bubble.button.style.setProperty('--chat-tail', `${place.tail}px`)
      occupied.push({ x: place.x, y: place.y, ...size })
    }
    if (showing)
      for (let i = 0; i < this.queue.length && this.active.size < 4;) {
        const line = this.queue[i],
          id = line.speech.chat_id
        if (this.active.has(id)) {
          i++
          continue
        }
        this.queue.splice(i, 1)
        const button = document.createElement('button')
        button.hidden = true
        button.className = 'chat-bubble'
        button.dataset.chatId = id
        button.dataset.actor = line.actor
        const name = document.createElement('strong')
        name.textContent = line.name
        const text = document.createElement('span')
        text.textContent = line.speech.text
        button.append(name, text)
        button.title = '查看这场聊天记录'
        button.setAttribute('aria-label', `${line.name}说：${line.speech.text}。查看聊天记录`)
        button.onclick = (e) => {
          e.stopPropagation()
          this.open(line.actor, id)
        }
        document.body.append(button)
        this.active.set(id, {
          line,
          button,
          left: Math.max(3500, Math.min(6000, 1800 + [...line.speech.text].length * 65)),
        })
      }
    this.frame = requestAnimationFrame((t) => this.tick(t))
  }
  onReset() {
    this.active.forEach((b) => b.button.remove())
    this.active.clear()
    this.seen.clear()
    this.queue = []
  }
  dispose() {
    cancelAnimationFrame(this.frame)
    this.onReset()
  }
}
