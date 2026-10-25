import type { PlanView, BodyView, ResidentAgentView } from '../protocol'
import { agentStateLabels } from '../labels'
import { playerText } from '../format'

export function createPlanView(
  box: HTMLElement,
  /** 游戏界面 */
  game: boolean
) {
  let lastPlanKey: string | null = ''
  function renderPlan(
    plan?: PlanView,
    body?: BodyView,
    agent?: ResidentAgentView,
    activity?: string
  ) {
    const waiting = game && activity === 'placeholder'
    const key = JSON.stringify([plan, body?.can_decide, waiting, agent?.state, agent?.reason])
    if (key === lastPlanKey) return
    lastPlanKey = key
    box.replaceChildren()
    box.className = ''

    if (!plan) {
      box.className = 'dim'
      box.textContent = '计划数据暂不可用'
      return
    }

    const current = document.createElement('div')
    current.className = 'plan-current'
    const marker = document.createElement('span')
    marker.className = 'plan-current-marker'
    marker.setAttribute('aria-hidden', 'true')
    const currentBody = document.createElement('div')
    const currentLabel = document.createElement('div')
    currentLabel.className = 'plan-caption'
    currentLabel.textContent = waiting || (body && !body.can_decide) ? '当前状态' : '正在执行'
    const currentText = document.createElement('div')
    currentText.className = 'plan-current-text'
    currentText.textContent = playerText(
      waiting && agent
        ? `${agentStateLabels[agent.state]}${agent.reason ? ' · ' + agent.reason : ''}`
        : plan.current
    )
    currentBody.append(currentLabel, currentText)
    current.append(marker, currentBody)
    box.appendChild(current)

    const nextHead = document.createElement('div')
    nextHead.className = 'plan-next-head'
    nextHead.textContent = `接下来 · ${plan.upcoming.length} 项`
    box.appendChild(nextHead)

    if (plan.upcoming.length > 0) {
      const list = document.createElement('ol')
      list.className = 'plan-list'
      for (const text of plan.upcoming) {
        const item = document.createElement('li')
        item.textContent = playerText(text)
        list.appendChild(item)
      }
      box.appendChild(list)
    } else {
      const empty = document.createElement('div')
      empty.className = 'plan-empty'
      empty.textContent = '暂无后续计划'
      box.appendChild(empty)
    }

    if (body && !body.can_decide) {
      const note = document.createElement('div')
      note.className = 'plan-note'
      note.textContent = '重新获得自主能力后，才会重新观察并安排活动。'
      box.appendChild(note)
    }
  }

  return {
    render: renderPlan,
    reset() {
      lastPlanKey = null
    },
    clear() {
      lastPlanKey = ''
      box.textContent = '计划数据暂不可用'
    },
  }
}
