import type { RosterMember, TriggerInfo } from './protocol'

/** 标签只依赖明确的原因类型；纯文字来源直接显示原文。 */
export function triggerLabel(info: TriggerInfo): string {
  switch (info.kind) {
    case 'queue_low':
      return '接着安排'
    case 'activity_failed':
      return `${info.action}失败`
    default:
      // 旧存档里的想法来源写的是「Agent 决策」，玩家看不懂
      return info.text === 'Agent 决策' ? '想法' : info.text
  }
}

/** Agent 自己停下、要玩家处理才会再动的状态：回复接连过时、故障、额度用尽、没选模型 */
export const STOPPED_AGENT_STATES = ['stale', 'fault', 'budget', 'unconfigured'] as const
export function agentStopped(m: RosterMember): boolean {
  const state = m.resident_agent?.state
  return !!state && (STOPPED_AGENT_STATES as readonly string[]).includes(state)
}

/** 「…」判定：队尾停留且 Agent 正在思考 —— 他在等模型；没有 Agent 会话的个体不会等 */
export function isWaiting(m: RosterMember): boolean {
  if (m.body && !m.body.can_decide) return false
  if (!m.resident_agent) return false
  return m.activity === 'placeholder' && m.resident_agent.state === 'thinking'
}
