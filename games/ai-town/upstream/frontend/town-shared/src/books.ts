// 「书与公告」页：整页替换地图页。村民写的书、公告栏上的告示，玩家也能写书、贴公告；不暂停世界。
// 作品列表、正文和表单在 props/content.ts。入口（地图左下角、手机底部的「书报」）上的数字是
// 还没看过的新作品：作品在打开的列表里露过面或被点开就算看过，记在本机、按小镇分开；
// 第一次见到一个世界时，已有的作品都算看过；玩家自己写的、撤下的不算新。
import { $ } from './dom'
import { displayClock } from './format'
import { observationPage } from './observationPage'
import { createContentManager } from './props/content'
import type { PropCatalog, PropView } from './props/types'
import type { ClientMsg, ServerMsg } from './protocol'
import type { ShellPanel } from './shell/panel'

const SEEN_KEY = 'town:books-seen:'

/** 本机记着的「看过」：只认同一个世界，世界重置后重新算 */
interface Seen {
  world: string
  ids: string[]
}

function loadSeen(town: string): Seen | null {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY + town) ?? 'null') as Seen | null
    return typeof value?.world === 'string' && Array.isArray(value.ids) ? value : null
  } catch {
    return null
  }
}

function saveSeen(town: string, seen: Seen) {
  try {
    localStorage.setItem(SEEN_KEY + town, JSON.stringify(seen))
  } catch {
    // 存不下时只在这次打开里记着
  }
}

const counts = (p: PropView) => !!p.readable && !p.withdrawn && p.readable.origin.kind !== 'player'

export function initBooks(deps: {
  send: (m: ClientMsg) => void
  /** 小镇编号：看过的作品按小镇分开记 */
  town: string
  game: boolean
  /** 正文里的「在地图上定位」（本页先关上） */
  locate: (id: string, locale: string) => void
}) {
  let catalog: PropCatalog | null = null
  let world = ''
  let seen = new Set<string>()
  /** 这次打开时还没看过的：列表里标「新」，关页时清掉 */
  const fresh = new Set<string>()
  const watchers = new Set<(count: number) => void>()
  const lifecycle = observationPage(
    $('books-view'),
    $('obs-view'),
    () => deps.send({ type: 'get_props' }),
    null,
    deps.game
  )
  const content = createContentManager(deps.send, {
    locate: (id, locale) => {
      if (close()) deps.locate(id, locale)
    },
    isNew: (id) => fresh.has(id),
    seen(ids) {
      if (!lifecycle.isOpen() || ids.every((id) => seen.has(id))) return
      for (const id of ids) seen.add(id)
      saveSeen(deps.town, {
        world,
        ids: [...seen].filter((id) => catalog?.instances.some((p) => p.id === id)),
      })
      notify()
    },
  })
  $('books-page').append(content.el)
  $('books-back').addEventListener('click', () => close())

  const find = (id: string) => catalog?.instances.find((p) => p.id === id)
  const unseen = () => (catalog?.instances ?? []).filter((p) => counts(p) && !seen.has(p.id))
  function notify() {
    const count = unseen().length
    for (const watch of watchers) watch(count)
  }

  function onCatalog(next: PropCatalog) {
    catalog = next
    if (next.world_id !== world) {
      world = next.world_id
      fresh.clear()
      const stored = loadSeen(deps.town)
      if (stored?.world === world) seen = new Set(stored.ids)
      else {
        // 第一次见到这个世界：已有的作品都算看过，入口不会一进来就挂着一串数字
        seen = new Set(next.instances.filter((p) => p.readable).map((p) => p.id))
        saveSeen(deps.town, { world, ids: [...seen] })
      }
    }
    // 开着页时新来的作品也标「新」：要在列表重画、记成看过之前记下
    if (lifecycle.isOpen()) for (const p of unseen()) fresh.add(p.id)
  }

  function show() {
    fresh.clear()
    for (const p of unseen()) fresh.add(p.id)
    lifecycle.open()
  }

  /** 关页；写了一半的内容先问。返回是否关上了 */
  function close() {
    if (!lifecycle.isOpen()) return true
    if (content.isDirty()) {
      if (!window.confirm('写了一半的内容还没保存，离开就没有了。确定离开吗？')) return false
      content.discard()
    }
    lifecycle.close()
    fresh.clear()
    // 下次从别处点开一篇时，先露出来的是列表，不是上次那篇
    content.list()
    return true
  }

  const panel: ShellPanel = {
    // 只旁听，不认领：道具页和地图也要这份目录
    handleMsg(msg: ServerMsg) {
      if (msg.type === 'props') onCatalog(msg.catalog)
      content.handleMsg(msg)
      if (msg.type === 'props') notify()
    },
    roster({ msg }) {
      $('books-clock').textContent = displayClock(msg.clock)
    },
    disconnected: () => content.disconnected(),
  }

  return {
    panel,
    isOpen: lifecycle.isOpen,
    close,
    /** 打开整页，看全部作品 */
    open() {
      show()
      content.list()
    },
    /** 打开整页并点开这一篇 */
    read(id: string) {
      show()
      content.show(id)
    },
    /** 地图上点了一摞书：看这个地点的书 */
    place(id: string) {
      const locale = find(id)?.locale
      show()
      if (locale) content.scope({ kind: 'book', locale })
      else content.list()
    },
    /** 地图上点了公告栏：看这块栏上的公告 */
    board(id: string) {
      show()
      content.scope({ kind: 'bulletin', board: id })
    },
    isBoard: (id: string) => !!find(id)?.bulletin_board,
    isReadable: (id: string) => !!find(id)?.readable,
    /** 入口上的数字：现在就报一次，之后变了再报 */
    watch(update: (count: number) => void) {
      watchers.add(update)
      update(unseen().length)
    },
  }
}
