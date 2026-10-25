// 推荐先请的几位：开局向导和空镇卡片用同一份。人选固定，不是随机；不在库里或已入住时按库里的顺序补。
import type { PopulationView, TemplateCard } from '../protocol'

/** 默认先请这三位：三个都爱说话，凑在一起很快就会聊起来 */
export const PICKS = ['builtin_alan', 'builtin_ashu', 'builtin_finn']

/** 能请的人（没入住、没归档）里先挑默认的几位，不够再按库里的顺序补 */
export function recommended(cards: TemplateCard[], count = PICKS.length): TemplateCard[] {
  const free = cards.filter((c) => c.status === 'available' && !c.archived)
  const picks = PICKS.map((id) => free.find((c) => c.template_id === id)).filter(
    (c): c is TemplateCard => !!c
  )
  for (const c of free) if (picks.length < count && !picks.includes(c)) picks.push(c)
  return picks.slice(0, count)
}

/** 为什么推荐这几位；正好是默认三位时才说他们爱聊天 */
export function recommendReason(picks: TemplateCard[]): string {
  const defaults =
    picks.length === PICKS.length && picks.every((c) => PICKS.includes(c.template_id))
  return defaults
    ? '三个都爱说话，凑在一起很快就会聊起来。'
    : '几个人住在一起，很快就会互相串门、聊天。'
}

/** 还能请几位：一处住宅只住一个人（host 的入住规则）；没有住宅的小镇人都住在活动区域里，不限 */
export function roomLeft(population: PopulationView | null): number {
  if (!population?.homes.length) return Infinity
  return population.homes.filter((h) => !h.occupant).length
}

/** 「三位」「两位」：按钮上的人数用汉字 */
export function peopleCount(n: number): string {
  return `${['', '一', '两', '三', '四', '五'][n] ?? n}位`
}
