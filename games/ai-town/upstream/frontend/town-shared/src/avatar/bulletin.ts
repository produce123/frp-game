// 化身站在公告栏跟前直接张贴公告：写标题和正文，署化身（或附身的村民）的名字，贴在这块公告栏上。
// 和「书与公告」页走同一条 content 创建命令；回执按请求编号认领（AvatarController.handleMsg 先问这里）。
import type { ClientMsg, ServerMsg } from '../protocol'
import type { PropCatalog } from '../props/types'
import type { AvatarProp } from './types'
import { button, el } from '../dom'
import { newId } from '../ids'
import { isTouch } from '../platform'

/** 跟前的公告栏：编号、名字和所在地点（公告必须和公告栏在同一地点） */
export interface BulletinBoard {
  id: string
  name: string
  locale: string
}

/** 化身跟前能张贴的地方：贴到哪块公告栏，以及哪些道具的「张贴公告」改成打开写公告的对话框 */
export interface BulletinSpots {
  board: BulletinBoard
  /** 默认小镇的公告栏旁边另有一个「公告栏张贴处」，它的「张贴公告」本来只是站十分钟什么也不贴 */
  posts: Set<string>
}

const POST_LABEL = '张贴公告'

/** 化身所在处所里的公告栏和张贴处；道具目录还没到时退回化身够得着的道具 */
export function bulletinSpots(
  catalog: PropCatalog | null,
  reachable: AvatarProp[],
  locale: string
): BulletinSpots | null {
  const here = (catalog?.instances ?? []).filter((p) => p.locale === locale && !p.withdrawn)
  const board =
    here.find((p) => p.bulletin_board) ?? reachable.find((p) => p.bulletin_board && !p.carried)
  if (!board) return null
  const posts = new Set<string>()
  for (const p of [...here, ...reachable])
    if (!p.bulletin_board && p.actions.some((a) => a.label === POST_LABEL)) posts.add(p.id)
  return { board: { id: board.id, name: board.name, locale }, posts }
}

/** 这件道具的「张贴公告」：张贴处总是；公告栏本身只在这里没有张贴处时 */
export function postsHere(spots: BulletinSpots, prop: AvatarProp) {
  return !prop.carried && (spots.posts.has(prop.id) || (prop.bulletin_board && !spots.posts.size))
}

/** 张贴处、公告栏本身的动作里，这一个换成打开对话框 */
export const isPostAction = (label: string) => label === POST_LABEL

const MAX_TEXT = 4000
/** 这么久没回执就当没贴上，按钮恢复可点 */
const REPLY_MS = 8000

export function createBulletinComposer(deps: {
  send: (message: ClientMsg) => void
  world: () => string
  author: () => string
  /** 处所编号 → 名字（「贴在中心广场的公告栏」） */
  localeName: (id: string) => string
  showToast: (message: string, sticky?: boolean) => void
}) {
  const dialog = el('dialog', '', 'avatar-bulletin')
  const form = el('form')
  const heading = el('h2', '张贴公告')
  // 打开时焦点落在标题上：showModal 默认聚焦第一个输入框，手机上会立刻弹出键盘挡住半屏
  heading.tabIndex = -1
  heading.autofocus = true
  const byline = el('p', '', 'avatar-bulletin-by')
  const title = el('input')
  title.maxLength = 80
  title.placeholder = '标题'
  title.setAttribute('aria-label', '公告标题')
  const body = el('textarea')
  body.maxLength = MAX_TEXT
  body.rows = 7
  body.placeholder = '想告诉大家的事'
  body.setAttribute('aria-label', '公告正文')
  const counter = el('small', `0 / ${MAX_TEXT} 字`, 'avatar-bulletin-count')
  const notice = el('p', '', 'avatar-bulletin-notice')
  const post = button('贴上去', () => submit(), 'primary')
  const actions = el('div', '', 'avatar-bulletin-actions')
  actions.append(
    button('取消', () => dialog.close()),
    post
  )
  form.append(heading, byline, title, body, counter, notice, actions)
  form.onsubmit = (event) => {
    event.preventDefault()
    submit()
  }
  dialog.append(form)
  document.body.append(dialog)
  const count = () => (counter.textContent = `${[...body.value].length} / ${MAX_TEXT} 字`)
  body.oninput = count

  let board: BulletinBoard | null = null
  let pending = ''
  let timer = 0
  const say = (text: string, bad = false) => {
    notice.textContent = text
    notice.classList.toggle('error', bad)
  }

  function submit() {
    if (!board || pending) return
    const heading = title.value.trim(),
      text = body.value.trim()
    if (!heading || !text) return say('写上标题和正文再贴', true)
    const request = newId()
    pending = request
    post.disabled = true
    say('正在张贴…')
    deps.send({
      type: 'content',
      request_id: request,
      world_id: deps.world(),
      command: {
        operation: 'create',
        id: `user:${newId()}`,
        locale: board.locale,
        board: board.id,
        title: heading,
        author: deps.author(),
        text,
      },
    })
    timer = window.setTimeout(() => {
      if (pending === request) settle(false, '没有收到结果，请检查连接后再贴一次')
    }, REPLY_MS)
  }

  function settle(ok: boolean, message: string) {
    clearTimeout(timer)
    pending = ''
    post.disabled = false
    if (ok) {
      title.value = ''
      body.value = ''
      count()
      dialog.close()
      deps.showToast(`已贴到${board ? deps.localeName(board.locale) : ''}的公告栏`)
    } else if (dialog.open) say(message || '没贴上，请再试一次', true)
    else deps.showToast(message || '公告没贴上', true)
  }

  return {
    open(next: BulletinBoard) {
      board = next
      byline.textContent = `贴在${deps.localeName(next.locale)}的公告栏 · 署名：${deps.author()}`
      say('')
      if (!dialog.open) dialog.showModal()
      // 触屏上一打开就聚焦会弹出键盘挡住半屏，等玩家自己点输入框
      if (!isTouch()) title.focus()
    },
    /** 张贴的回执：是这里发出的请求才认领 */
    handleMsg(message: ServerMsg) {
      if (!pending) return false
      if (
        (message.type !== 'prop_result' && message.type !== 'error') ||
        message.request_id !== pending
      )
        return false
      settle(message.type === 'prop_result' && message.ok, message.message)
      return true
    },
    dispose() {
      clearTimeout(timer)
      dialog.remove()
    },
  }
}
