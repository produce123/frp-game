import type { ResidentContext } from './application'
import type { ClientMsg, ServerMsg } from './protocol'
import { observationPage } from './observationPage'
import { createNotebookView } from './memory/view'
import type { NotebookDetail, NotebookQuery } from './memory/protocol'
import { $, query as find } from './dom'
import { nextRequestId } from './ids'
import { iconLabel } from './game/icons'
import './memory/style.css'
import { portraitOf } from './portraits'

interface MemoryDeps {
  send: (obj: ClientMsg) => void
  onBack: () => void
  /** 游戏界面 */
  game: boolean
}

export function initMemory(deps: MemoryDeps) {
  const game = deps.game
  const page = $('memory-page'),
    search = find<HTMLInputElement>(document, '#memory-search')
  let listRequest = '',
    waitingSince = 0
  let resident: ResidentContext | null = null
  let query: NotebookQuery = { category: 'recent', search: '', offset: 0 }
  let debounce: number | undefined
  const pending = new Map<
    string,
    { resolve(value: NotebookDetail): void; reject(error: Error): void; timer: number }
  >()
  function request(force = false) {
    if (!resident) return
    if (!force && waitingSince && Date.now() - waitingSince < 6000) return
    if (waitingSince) view.error('读取记忆暂未回应，正在重试…')
    listRequest = nextRequestId()
    waitingSince = Date.now()
    deps.send({ type: 'get_notebook', resident: resident.id, request_id: listRequest, query })
  }
  const lifecycle = observationPage($('memory-view'), $('obs-view'), request, 2000, game)
  const view = createNotebookView(page, {
    navigate(category, offset = 0, focus, paging = false) {
      query = { category, offset, focus, search: paging ? query.search : '' }
      search.value = query.search
      $('memory-clear-search').hidden = !query.search
      listRequest = ''
      waitingSince = 0
      window.clearTimeout(debounce)
      view.loading(query)
      request(true)
    },
    clearSearch() {
      search.value = ''
      searchChanged()
    },
    load(entry, section, offset) {
      return new Promise((resolve, reject) => {
        if (!resident || !lifecycle.isOpen()) {
          reject(new Error('页面已关闭'))
          return
        }
        const request_id = nextRequestId()
        const timer = window.setTimeout(() => {
          pending.delete(request_id)
          reject(new Error('读取超时，请检查连接'))
        }, 8000)
        pending.set(request_id, { resolve, reject, timer })
        deps.send({
          type: 'get_notebook_detail',
          resident: resident.id,
          request_id,
          query: { key: entry.key, version: entry.version, section, offset },
        })
      })
    },
  })
  function searchChanged() {
    window.clearTimeout(debounce)
    query = { ...query, search: search.value, offset: 0, focus: undefined }
    $('memory-clear-search').hidden = !search.value
    listRequest = ''
    waitingSince = 0
    view.loading(query)
    debounce = window.setTimeout(() => request(true), 220)
  }
  search.addEventListener('input', searchChanged)
  $('memory-clear-search').onclick = () => {
    search.value = ''
    searchChanged()
    search.focus()
  }
  $('memory-back').onclick = () => deps.onBack()
  if (game) iconLabel($('memory-back'), 'close', '关闭')
  function reset() {
    listRequest = ''
    waitingSince = 0
    window.clearTimeout(debounce)
    pending.forEach((p) => {
      window.clearTimeout(p.timer)
      p.reject(new Error('页面已切换'))
    })
    pending.clear()
    query = { category: 'recent', search: '', offset: 0 }
    search.value = ''
    $('memory-clear-search').hidden = true
    $('memory-search-wrap').hidden = false
    view.reset()
  }
  return {
    isOpen: lifecycle.isOpen,
    open(selected: ResidentContext) {
      if (lifecycle.isOpen()) lifecycle.close()
      reset()
      resident = selected
      $('memory-title').textContent = `${selected.name}的记忆`
      $('memory-avatar').replaceChildren(
        portraitOf(selected.id, selected.name, 'rv-portrait') ?? ''
      )
      $('memory-hint').textContent = '经历、认识，以及它们的来处'
      view.loading(query)
      lifecycle.open()
    },
    close() {
      lifecycle.close()
      reset()
    },
    onReset() {
      reset()
      if (lifecycle.isOpen()) {
        view.loading(query)
        request(true)
      }
    },
    handleMsg(msg: ServerMsg): boolean {
      if (msg.type === 'notebook') {
        if (!lifecycle.isOpen() || msg.resident !== resident?.id || msg.request_id !== listRequest)
          return true
        waitingSince = 0
        if (msg.error) {
          view.error(msg.error)
          return true
        }
        if (!msg.notebook) {
          view.error('该村民没有记忆会话')
          return true
        }
        const focus = query.focus
        query = { ...query, offset: msg.notebook.offset, focus: undefined }
        view.render(msg.notebook, query)
        if (focus) {
          const entry = Array.from(page.querySelectorAll<HTMLElement>('.nb-card')).find(
            (e) => e.dataset.entryKey === focus
          )
          if (entry) {
            entry.tabIndex = -1
            entry.scrollIntoView({ block: 'center' })
            entry.focus({ preventScroll: true })
          }
        }
        return true
      }
      if (msg.type === 'notebook_detail') {
        const request = pending.get(msg.request_id)
        if (!request || msg.resident !== resident?.id) return true
        pending.delete(msg.request_id)
        window.clearTimeout(request.timer)
        if (msg.detail) request.resolve(msg.detail)
        else request.reject(new Error(msg.error ?? '没有读到这条记录'))
        return true
      }
      return false
    },
  }
}
