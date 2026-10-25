import type { SettingsPage } from '../settingsCenter'
import type { ServerMsg } from '../protocol'
import { newId } from '../ids'
import { $, htmlText, type PageDeps } from './page'

// 重置世界：破坏性操作单独一页，输入当前小镇名后按钮才可点；不进保存栏。
export function createResetPage(deps: PageDeps, townName: string): SettingsPage {
  const el = document.createElement('section')
  el.className = 'spage reset-page'
  const name = htmlText(townName)
  el.innerHTML = `
    <h2>重置世界</h2>
    <h3>会清空</h3>
    <p class="hint">所有村民，以及他们的行动、目标、记忆、对话和用量。时间回到第 1 天 07:00，世界保持暂停。</p>
    <h3>会保留</h3>
    <p class="hint">模型服务和密钥 · 花费上限 · 地图 · 村民库里的人物（重置后可以再邀请回来）</p>
    <div class="reset-zone">
      <p class="reset-zone-text"><b>这一步不能撤销。</b><br>输入小镇名「${name}」后才能点。</p>
      <input type="text" class="reset-input" autocomplete="off" spellcheck="false" placeholder="${name}" aria-label="输入小镇名确认">
      <button type="button" class="reset-btn" disabled>重置世界</button>
    </div>
    <div class="page-status" role="status"></div>`
  const btn = $<HTMLButtonElement>(el, '.reset-btn')
  const input = $<HTMLInputElement>(el, '.reset-input')
  const status = $<HTMLElement>(el, '.page-status')
  const clear = () => {
    input.value = ''
    btn.disabled = true
    status.textContent = ''
  }
  input.oninput = () => {
    btn.disabled = input.value.trim() !== townName
  }
  /** 已发出、还没有结果的重置请求编号 */
  let pending: string | null = null
  btn.onclick = () => {
    if (input.value.trim() !== townName) return
    input.value = ''
    btn.disabled = true
    status.textContent = '已发送重置'
    pending = newId()
    deps.send({ type: 'reset_world', request_id: pending })
  }
  return {
    id: 'reset',
    group: 'danger',
    navLabel: '重置世界…',
    title: '重置世界',
    el,
    isDirty: () => false,
    save: () => {},
    discard: clear,
    onShow: clear,
    onDisconnected() {
      if (pending === null) return
      pending = null
      status.textContent = '连接断开，没有收到重置结果；重新连接后请查看世界是否已回到第一天'
    },
    handleMsg(msg: ServerMsg) {
      if (pending === null) return
      if (msg.type === 'world_reset') {
        pending = null
        status.textContent = `已重置，回到 ${msg.clock}`
      } else if (msg.type === 'error' && msg.request_id === pending) {
        pending = null
        status.textContent = `✗ ${msg.message}`
      }
    },
  }
}
