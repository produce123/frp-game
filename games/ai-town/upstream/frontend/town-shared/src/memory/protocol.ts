import type { GoalStatus, NoteStatus } from '../protocol'

export type NotebookCategory =
  'recent' | 'people' | 'places' | 'lessons' | 'self_knowledge' | 'goals' | 'events'
export type NotebookSection = 'text' | 'sources' | 'history'
export interface NotebookQuery {
  category: NotebookCategory
  search: string
  offset: number
  focus?: string
}
export interface NotebookDetailQuery {
  key: string
  version: string
  section: NotebookSection
  offset: number
}
interface NotebookLink {
  key: string
  title: string
  category: NotebookCategory
}
export interface NotebookEntry extends NotebookLink {
  version: string
  text: string
  text_chars: number
  at: number
  day: number | null
  /** 主题页的可信状态；其他条目没有 */
  note_status?: NoteStatus
  /** 目标条目的状态；其他条目没有 */
  goal_status?: GoalStatus
  source_count: number
  history_count: number
  pending: boolean
  next_steps: string[]
  reason: string
  related: NotebookLink[]
}
export interface NotebookView {
  sim_minutes: number
  last_reflection_at: number | null
  reflecting: boolean
  retry_after: number | null
  pending_events: number
  counts: { category: NotebookCategory; count: number }[]
  offset: number
  total: number
  next_offset: number | null
  entries: NotebookEntry[]
  recent_updates: NotebookLink[]
}
export interface NotebookDetail {
  key: string
  version: string
  section: NotebookSection
  offset: number
  total: number
  next_offset: number | null
  text: string
  entries: NotebookEntry[]
}
