import { categories, icon } from './display'
import { goalStatusLabels, noteStatusLabels } from '../labels'
import { button, el } from '../dom'
import { clock, playerText } from '../format'
import { createDetails } from './details'
import type {
  NotebookCategory,
  NotebookDetail,
  NotebookEntry,
  NotebookQuery,
  NotebookSection,
  NotebookView,
} from './protocol'

interface Actions {
  navigate(category: NotebookCategory, offset?: number, focus?: string, paging?: boolean): void
  clearSearch(): void
  load(entry: NotebookEntry, section: NotebookSection, offset: number): Promise<NotebookDetail>
}

/** 分类表是本地常量；查不到说明分类 id 与表不一致，退回第一项 */
const categoryOf = (id: NotebookCategory) => categories.find((c) => c.id === id) ?? categories[0]

/** 正文重画的依据：这些字段没变就不动正文，免得打断滚动 */
const bodySignature = (view: NotebookView, query: NotebookQuery) =>
  JSON.stringify([
    query.category,
    query.search,
    view.entries,
    view.offset,
    view.total,
    view.next_offset,
    view.recent_updates,
    view.pending_events,
  ])

export function createNotebookView(page: HTMLElement, actions: Actions) {
  const details = createDetails(actions.load)
  const layout = el('div', '', 'nb-layout')
  const side = el('aside', '', 'nb-sidebar')
  const nav = el('nav', '', 'nb-nav')
  nav.setAttribute('aria-label', '记忆分类')
  const progress = el('div', '', 'nb-progress')
  side.append(el('p', '记住了什么', 'nb-nav-label'), nav, progress)
  const content = el('section', '', 'nb-content')
  const heading = el('div', '', 'nb-heading')
  const intro = el('div')
  const title = el('h2')
  title.id = 'memory-section-title'
  const description = el('p', '', 'nb-description')
  intro.append(title, description)
  const now = el('span', '', 'nb-clock')
  heading.append(intro, now)
  const body = el('div', '', 'nb-body')
  body.id = 'memory-content'
  content.append(heading, body)
  layout.append(side, content)
  let bodyKey = '',
    navKey = ''
  let current: NotebookView | null = null

  function mount() {
    page.className = 'notebook-page'
    if (!page.contains(layout)) page.replaceChildren(layout)
  }
  function navigation(query: NotebookQuery) {
    const key = JSON.stringify([query.category, query.search, current?.counts])
    if (key === navKey) return
    navKey = key
    nav.replaceChildren()
    categories.forEach((category, i) => {
      if (i === 5) nav.append(el('div', '', 'nb-nav-divider'))
      const b = button('', () => actions.navigate(category.id), 'nb-nav-button')
      b.dataset.category = category.id
      b.setAttribute('aria-controls', 'memory-content')
      if (query.category === category.id && !query.search.trim())
        b.setAttribute('aria-current', 'page')
      const count = current?.counts.find((c) => c.category === category.id)?.count
      b.append(
        icon(category.icon),
        el('span', category.label),
        el('span', count === undefined ? '' : String(count), 'nb-count')
      )
      nav.append(b)
    })
  }
  function empty(query: NotebookQuery, view: NotebookView) {
    const category = categoryOf(query.category)
    const box = el('div', '', 'nb-empty')
    const eventCount = view.counts.find((c) => c.category === 'events')?.count ?? 0
    let label = category.empty,
      reason = '先保留已经发生的经历；有了实际整理出的内容，再放到这个分类里。'
    if (query.category === 'recent') {
      label = eventCount ? category.empty : '还没有记忆记录'
      reason = eventCount
        ? `已有 ${eventCount} 条原始记录，尚未形成每日摘要。`
        : '之后发生的经历会先记录下来，再由居民整理成摘要和认识。'
    }
    if (query.category === 'goals') reason = '之后记下的目标和承诺，会在这里保留。'
    if (query.category === 'events') reason = '还没有可追溯的经历。'
    if (query.search.trim()) {
      label = '没有找到相关记录'
      reason = '试试人物、地点或具体事情的关键词。'
    }
    box.append(icon(category.icon), el('h3', label), el('p', reason))
    if (query.search.trim()) box.append(button('清除搜索', actions.clearSearch, 'nb-primary'))
    else if (eventCount && query.category !== 'events')
      box.append(button('查看已记录的经历', () => actions.navigate('events'), 'nb-primary'))
    return box
  }
  function card(entry: NotebookEntry) {
    const article = el('article', '', entry.category === 'events' ? 'nb-card nb-event' : 'nb-card')
    article.dataset.entryKey = entry.key
    const meta = el('div', '', 'nb-card-top')
    if (entry.category === 'recent')
      meta.append(
        el('span', entry.day === null ? '经历摘要' : `第 ${entry.day} 天`, 'nb-day'),
        el('span', '经历摘要')
      )
    else if (entry.goal_status)
      meta.append(el('span', goalStatusLabels[entry.goal_status], `nb-tag ${entry.goal_status}`))
    else if (entry.note_status)
      meta.append(el('span', noteStatusLabels[entry.note_status], `nb-tag ${entry.note_status}`))
    if (entry.history_count && entry.category !== 'recent')
      meta.append(el('span', '有过修正', 'nb-tag'))
    if (entry.pending) meta.append(el('span', '尚未整理', 'nb-tag'))
    meta.append(
      el('span', `${clock(entry.at)}${entry.category === 'events' ? '' : ' 更新'}`, 'nb-updated')
    )
    article.append(meta, el('h3', playerText(entry.title)), details.readable(entry))
    if (entry.reason) article.append(el('p', playerText(entry.reason), 'nb-reason'))
    if (entry.next_steps.length)
      article.append(el('p', `下一步：${playerText(entry.next_steps.join('；'))}`, 'nb-next'))
    if (entry.related.length) {
      const related = el('div', '', 'nb-related')
      related.append(el('span', '相关认识', 'nb-tag'))
      for (const link of entry.related)
        related.append(
          button(link.title, () => actions.navigate(link.category, 0, link.key), 'nb-text-button')
        )
      article.append(related)
    }
    if (entry.source_count) article.append(details.disclosure(entry, 'sources'))
    if (entry.history_count) article.append(details.disclosure(entry, 'history'))
    return article
  }
  function recent(view: NotebookView) {
    if (view.recent_updates.length) {
      body.append(el('h3', '最近更新的认识', 'nb-section-title'))
      for (const link of view.recent_updates) {
        const category = categoryOf(link.category)
        const b = button('', () => actions.navigate(link.category, 0, link.key), 'nb-update-row')
        b.append(
          icon(category.icon),
          el('span', link.title),
          el('small', category.label),
          el('span', '↗', 'nb-update-arrow')
        )
        body.append(b)
      }
    }
    if (view.pending_events) {
      const row = el('div', '', 'nb-waiting')
      row.append(
        icon('clock'),
        el('p', `还有 ${view.pending_events} 条新记录尚未整理，保留在原始经历里。`),
        button('查看原始经历', () => actions.navigate('events'), 'nb-text-button')
      )
      body.append(row)
    }
  }
  /** 标题、说明、时钟：每次都写，不看签名 */
  function writeHeading(view: NotebookView, query: NotebookQuery) {
    const category = categoryOf(query.category)
    title.textContent = query.search.trim() ? '搜索结果' : category.label
    description.textContent = query.search.trim()
      ? `“${query.search}” · 共 ${view.total} 条记录`
      : category.description
    now.textContent = clock(view.sim_minutes)
  }
  /** 侧栏的整理进度 */
  function reflection(view: NotebookView) {
    progress.replaceChildren(
      el(
        'strong',
        view.last_reflection_at === null
          ? '还没有整理过记忆'
          : `上次整理：${clock(view.last_reflection_at)}`
      )
    )
    if (view.reflecting) progress.append(el('p', '正在整理新增经历…'))
    else if (view.retry_after !== null)
      progress.append(
        el(
          'p',
          view.retry_after > view.sim_minutes
            ? `整理暂缓，${clock(view.retry_after)} 后重试`
            : '等待重新整理'
        )
      )
    progress.append(
      el('p', `${view.pending_events} 条新记录尚未整理`),
      el('p', '认识和摘要来自居民自己的整理。')
    )
  }
  function pager(view: NotebookView, query: NotebookQuery) {
    const box = el('nav', '', 'nb-pager')
    box.setAttribute('aria-label', '记忆分页')
    const previous = button(
      '上一页',
      () => actions.navigate(query.category, Math.max(0, view.offset - 12), undefined, true),
      'nb-page-button'
    )
    previous.disabled = view.offset === 0
    const next = button(
      '下一页',
      () => {
        if (view.next_offset !== null)
          actions.navigate(query.category, view.next_offset, undefined, true)
      },
      'nb-page-button'
    )
    next.disabled = view.next_offset === null
    box.append(
      previous,
      el('span', `${view.offset + 1}—${view.offset + view.entries.length} / ${view.total}`),
      next
    )
    return box
  }
  /** 条目列表；有翻页时带分页条 */
  function entries(view: NotebookView, query: NotebookQuery) {
    const list = el('div', '', 'nb-memory-list')
    view.entries.forEach((entry) => list.append(card(entry)))
    body.append(list)
    if (view.offset || view.next_offset !== null) body.append(pager(view, query))
  }
  function render(view: NotebookView, query: NotebookQuery) {
    mount()
    current = view
    navigation(query)
    writeHeading(view, query)
    reflection(view)
    const signature = bodySignature(view, query)
    if (signature === bodyKey) return
    bodyKey = signature
    const scroll = page.scrollTop
    body.replaceChildren()
    if (!view.entries.length) body.append(empty(query, view))
    else entries(view, query)
    if (!query.search.trim() && query.category === 'recent' && view.offset === 0) recent(view)
    if (query.category === 'self_knowledge' && !query.search.trim())
      body.append(
        el('p', '这里展示经历之后形成的自我认识；最初的人设仍在居民设定中查看。', 'nb-note')
      )
    page.scrollTop = scroll
  }
  return {
    render,
    loading(query: NotebookQuery) {
      mount()
      navigation(query)
      title.textContent = query.search.trim() ? '搜索结果' : categoryOf(query.category).label
      description.textContent = '正在读取记忆…'
      bodyKey = ''
      body.replaceChildren()
      page.scrollTop = 0
    },
    error(message: string) {
      description.textContent = message
    },
    reset() {
      details.reset()
      bodyKey = ''
      navKey = ''
      current = null
      body.replaceChildren()
      progress.replaceChildren()
      now.textContent = ''
    },
  }
}
