import { prose } from './display'
import { goalStatusLabels, noteStatusLabels } from '../labels'
import { button, el } from '../dom'
import { clock } from '../format'
import type { NotebookDetail, NotebookEntry, NotebookSection } from './protocol'

type Load = (
  entry: NotebookEntry,
  section: NotebookSection,
  offset: number
) => Promise<NotebookDetail>
interface Cached {
  text: string
  entries: NotebookEntry[]
  next: number | null
  total: number
}

/** 详情按条目版本缓存。轮询更新列表时保留展开位置；换居民、重置和关闭时清空。 */
export function createDetails(load: Load) {
  const cached = new Map<string, Cached>()
  const pending = new Map<string, Promise<Cached>>()
  const opened = new Set<string>()
  let generation = 0
  const keyFor = (entry: NotebookEntry, section: NotebookSection) =>
    `${entry.key}|${entry.version}|${section}`
  function get(entry: NotebookEntry, section: NotebookSection, more = false) {
    const key = keyFor(entry, section)
    const value = cached.get(key)
    const inflight = pending.get(key)
    if (inflight) return inflight
    if (value && (!more || value.next === null)) return Promise.resolve(value)
    const offset = value?.next ?? (section === 'text' ? Array.from(entry.text).length : 0)
    const current = generation
    const request = load(entry, section, offset)
      .then((result) => {
        if (current !== generation) throw new Error('页面已切换')
        if (
          result.key !== entry.key ||
          result.version !== entry.version ||
          result.section !== section ||
          result.offset !== offset
        )
          throw new Error('记录已变化，请重新打开这一页')
        const next: Cached = {
          text: (value?.text ?? (section === 'text' ? entry.text : '')) + result.text,
          entries: [...(value?.entries ?? []), ...result.entries],
          next: result.next_offset,
          total: result.total,
        }
        cached.set(key, next)
        return next
      })
      .finally(() => {
        if (current === generation) pending.delete(key)
      })
    pending.set(key, request)
    return request
  }
  function readable(entry: NotebookEntry, small = false) {
    const box = el('div', '', small ? 'nb-source-text' : '')
    const key = keyFor(entry, 'text')
    function draw() {
      const value = cached.get(key)
      box.replaceChildren(prose(value?.text ?? entry.text, small ? 'nb-source-prose' : 'nb-prose'))
      if (value ? value.next !== null : Array.from(entry.text).length < entry.text_chars) {
        const more = button(
          value ? '继续读取正文' : '展开全文',
          () => {
            more.disabled = true
            more.textContent = '正在读取…'
            get(entry, 'text', true)
              .then(draw)
              .catch((error) => {
                more.disabled = false
                more.textContent = `${error.message} · 重试`
              })
          },
          'nb-text-button'
        )
        box.append(more)
      }
    }
    draw()
    return box
  }
  function disclosure(entry: NotebookEntry, section: 'sources' | 'history') {
    const key = keyFor(entry, section)
    const details = el('details', '', `nb-details nb-${section}`)
    details.dataset.detailKey = key
    const label =
      section === 'sources'
        ? `查看依据 · ${entry.source_count} 条来源记录`
        : `查看以前的记录 · ${entry.history_count} 次更新`
    details.append(el('summary', label))
    const contents = el('div', '', 'nb-source-list')
    details.append(contents)
    function draw(value: Cached) {
      contents.replaceChildren()
      if (section === 'history')
        contents.append(el('p', '下面保留修改前的原文；现在的认识见上方正文。', 'nb-history-note'))
      for (const source of value.entries) {
        const row = el('article', '', 'nb-source-item')
        row.dataset.entryKey = source.key
        const label = source.goal_status
          ? goalStatusLabels[source.goal_status]
          : source.note_status
            ? noteStatusLabels[source.note_status]
            : ''
        const status = label ? ` · ${label}` : ''
        row.append(
          el('p', `${clock(source.at)} · ${source.title}${status}`, 'nb-source-meta'),
          readable(source, true)
        )
        if (section === 'history' && source.source_count) row.append(disclosure(source, 'sources'))
        contents.append(row)
      }
      if (!value.entries.length) contents.append(el('p', '没有可读取的来源记录。', 'nb-note'))
      if (value.next !== null)
        contents.append(
          button(
            `继续读取（已显示 ${value.entries.length}/${value.total}）`,
            () => fill(true),
            'nb-text-button'
          )
        )
    }
    function fill(more = false) {
      const value = cached.get(key)
      if (!more && value) {
        draw(value)
        return
      }
      const status = el('p', '正在读取…', 'nb-note')
      if (!more) contents.replaceChildren(status)
      else contents.append(status)
      get(entry, section, more)
        .then(draw)
        .catch((error) => {
          status.textContent = error.message
          contents.append(button('重试', () => fill(more), 'nb-text-button'))
        })
    }
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return
      if (details.open) {
        opened.add(key)
        fill()
      } else opened.delete(key)
    })
    if (opened.has(key)) {
      details.open = true
      fill()
    }
    return details
  }
  return {
    readable,
    disclosure,
    reset() {
      generation++
      cached.clear()
      pending.clear()
      opened.clear()
    },
  }
}
