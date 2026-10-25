import type { EventsHandle } from '../events'
import { displayClock, playerText } from '../format'

export function createRecentView(box: HTMLElement, recent: EventsHandle['recent']) {
  let lastRecentId = 0
  function renderRecent() {
    const items = recent(3)
    if (items.length === 0) return
    if (items[0].id === lastRecentId) return
    lastRecentId = items[0].id
    box.replaceChildren()
    box.classList.remove('dim')
    for (const e of [...items].reverse()) {
      const div = document.createElement('div')
      const t = document.createElement('span')
      t.className = 'ev-clock'
      t.textContent = displayClock(e.clock)
      div.append(t, document.createTextNode(playerText(e.text)))
      if (e.alert) div.className = 'drop'
      box.appendChild(div)
    }
  }

  return {
    render: renderRecent,
    reset() {
      lastRecentId = 0
      box.replaceChildren()
      box.classList.add('dim')
      box.textContent = '—'
    },
  }
}
