import type { ClientMsg, ServerMsg } from '../protocol'
import { $, el as node } from '../dom'
import { clock, playerText } from '../format'
import { nextRequestId } from '../ids'
import { interactionStatusLabels } from '../labels'
import './style.css'
import { iconLabel, gameIcon } from '../game/icons'
import { residentPortrait } from '../portraits'

/** 聊天记录可放在对话框或右栏页面中 */
interface Surface {
  root: HTMLElement
  show(): void
  hide(): void
  isOpen(): boolean
  /** 选中的村民换了人 */
  residentChanged?(): void
}

function dialogSurface(onClose: () => void): Surface {
  const dialog = document.createElement('dialog')
  dialog.className = 'chat-history'
  dialog.addEventListener('close', onClose)
  document.body.append(dialog)
  return {
    root: dialog,
    show: () => {
      if (!dialog.open) dialog.showModal()
    },
    hide: () => dialog.close(),
    isOpen: () => dialog.open,
  }
}

/** 2D：右栏里的一页；打开时右栏要展开 */
function panelSurface(onClose: () => void, showPanel: () => void): Surface {
  const panel = $('info-panel')
  const page = document.createElement('section')
  page.id = 'info-chat-page'
  page.hidden = true
  panel.append(page)
  const hide = () => {
    page.hidden = true
    panel.classList.remove('chat-open')
    onClose()
  }
  // 关掉村民卡就退回村民信息：再打开时从卡片看起，不停在上次的聊天记录
  new MutationObserver(() => {
    if (panel.hidden && !page.hidden) hide()
  }).observe(panel, { attributes: true, attributeFilter: ['hidden'] })
  return {
    root: page,
    show: () => {
      page.hidden = false
      panel.classList.add('chat-open')
      showPanel()
    },
    hide,
    // 右栏收起时不再轮询
    isOpen: () => !page.hidden && !panel.hidden,
    // 换了选中的村民就回到村民信息
    residentChanged: () => {
      if (!page.hidden) hide()
    },
  }
}

export function createChatHistory(
  send: (v: ClientMsg) => void,
  localeName: (v: string) => string,
  /** 游戏界面：居中对话框；平铺界面：右栏里的一页 */
  game: boolean,
  /** 平铺界面打开聊天记录时展开右栏 */
  showInfoPanel: () => void
) {
  let timer: number | null = null
  // 轮询只在打开期间进行
  const stop = () => {
    if (timer !== null) window.clearInterval(timer)
    timer = null
  }
  const surface = game ? dialogSurface(stop) : panelSurface(stop, showInfoPanel)
  const root = surface.root
  root.setAttribute('aria-label', '聊天记录')
  const head = node('header', ''),
    title = node('strong', '聊天记录'),
    back = node('button', '所有聊天'),
    close = node('button', '← 返回')
  const content = node('div', '', 'chat-history-content'),
    foot = node('footer', '')
  if (game) {
    iconLabel(close, 'back', '返回')
    iconLabel(back, 'back', '聊天列表')
  }
  head.append(close, title, back)
  root.append(head, content, foot)
  let resident = '',
    chatId: string | undefined,
    offset = 0,
    requestId = '',
    signature = '',
    total = 0
  close.onclick = () => surface.hide()
  /** 从一场交谈的记录退回聊天列表 */
  const backToList = () => {
    chatId = undefined
    offset = 0
    signature = ''
    refresh()
  }
  // 对话框里按 Esc：在一场交谈里时先退回列表
  root.addEventListener('cancel', (event) => {
    if (game && chatId) {
      event.preventDefault()
      backToList()
    }
  })
  back.onclick = backToList
  function refresh() {
    if (!surface.isOpen() || !resident) return
    requestId = nextRequestId()
    send({ type: 'get_chat_history', resident, request_id: requestId, chat_id: chatId, offset })
  }
  function open(id: string, chat?: string) {
    resident = id
    head.querySelector('.resident-portrait')?.remove()
    if (game) title.before(residentPortrait(id, '居民'))
    chatId = chat
    offset = 0
    signature = ''
    back.hidden = !chat
    content.replaceChildren(node('p', '正在读取聊天记录…'))
    foot.replaceChildren()
    surface.show()
    if (timer === null) timer = window.setInterval(refresh, 1500)
    refresh()
  }
  function handleMsg(msg: ServerMsg) {
    if (msg.type !== 'chat_history') return false
    if (!surface.isOpen() || msg.request_id !== requestId || msg.resident !== resident) return true
    total = msg.total
    back.hidden = !chatId
    title.textContent = chatId ? '交谈记录' : '聊天记录'
    const nextSignature = JSON.stringify([msg.chats, msg.entries, msg.total, msg.offset])
    if (signature === nextSignature) return true
    // 刚打开或换了一页：签名被清空过
    const first = !signature
    signature = nextSignature
    const nearBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 55
    const scrollTop = content.scrollTop
    content.replaceChildren()
    for (const chat of msg.chats) {
      const button = node('button', '', 'chat-history-item')
      button.append(
        node('strong', chat.participants.join('、')),
        node('span', `${localeName(chat.locale)} · ${clock(chat.created_at)}`),
        node('span', `${interactionStatusLabels[chat.status]} · ${chat.entries} 条记录`)
      )
      button.onclick = () => {
        chatId = chat.id
        offset = Math.max(0, Math.floor((chat.entries - 1) / 50) * 50)
        signature = ''
        refresh()
      }
      content.append(button)
    }
    for (const entry of msg.entries) {
      const row = node(
        'article',
        '',
        `chat-entry ${entry.kind === 'speech' ? 'chat-spoken' : 'chat-event'}`
      )
      row.dataset.seq = String(entry.seq)
      row.append(
        node('small', `${entry.name} · ${clock(entry.at)}`),
        node('p', playerText(entry.text))
      )
      content.append(row)
    }
    if (!total && game) {
      const empty = node('div', '', 'chat-history-empty')
      empty.append(gameIcon('chat'), node('p', '暂无聊天记录'))
      content.append(empty)
    } else if (!total) content.append(node('p', '还没有聊天记录', 'dim'))
    foot.replaceChildren()
    foot.hidden = game && total <= (chatId ? 50 : 20)
    const size = chatId ? 50 : 20
    const prev = node('button', '上一页'),
      next = node('button', '下一页')
    prev.disabled = offset === 0
    next.disabled = offset + size >= total
    prev.onclick = () => {
      offset = Math.max(0, offset - size)
      signature = ''
      refresh()
    }
    next.onclick = () => {
      offset += size
      signature = ''
      refresh()
    }
    foot.append(
      prev,
      node('span', total ? `${offset + 1}–${Math.min(offset + size, total)} / ${total}` : '0 条'),
      next
    )
    // 聊天列表最新的在最上面，从顶上看起；一场交谈从最后几句看起，停在底部时有新话跟着到底
    const transcript = msg.entries.length > 0
    content.scrollTop =
      transcript && (first || nearBottom) ? content.scrollHeight : first ? 0 : scrollTop
    return true
  }
  return {
    open,
    handleMsg,
    onReset() {
      surface.hide()
      resident = ''
      signature = ''
    },
    /** 选中的村民换了人：2D 右栏里的聊天记录页退回村民信息 */
    residentChanged() {
      surface.residentChanged?.()
    },
    /** 返回键：在一场交谈里先退回聊天列表，在列表里就关掉聊天记录，退回村民信息 */
    back() {
      if (!surface.isOpen()) return false
      if (chatId) backToList()
      else surface.hide()
      return true
    },
    dispose() {
      stop()
      root.remove()
    },
  }
}
