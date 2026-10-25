// 协议枚举的展示文案。线上传枚举值，中文只在这里；任何页面都不拿中文做分支条件。
import type {
  AgentState,
  EvidenceSource,
  GoalStatus,
  InteractionStatus,
  MemoryKind,
  MemoryStatus,
  NoteStatus,
  PauseKind,
  RequestKind,
  RequestStatus,
  TemplateStatus,
} from './protocol'

export const agentStateLabels: Record<AgentState, string> = {
  dead: '已死亡',
  fault: '故障暂停',
  budget: '额度用尽',
  stale: '回复过时',
  rescue: '需要救助',
  chatting: '交谈中',
  interacting: '互动中',
  reflecting: '整理记忆',
  thinking: '思考中',
  acting: '行动中',
  waiting: '等待中',
  undecided: '待决定',
  manual: '附身中',
  unconfigured: '待设置',
  no_model: '等模型',
}

export const pauseKindLabels: Record<PauseKind, string> = {
  fault: '故障暂停',
  budget: '额度用尽',
  stale: '回复过时',
  no_model: '等模型',
}

export const requestKindLabels: Record<RequestKind, string> = {
  life: '生活决策',
  reflection: '记忆整理',
  chat: '交谈发言',
}

export const requestStatusLabels: Record<RequestStatus, string> = {
  in_flight: '进行中',
  adopted: '采纳',
  format_retry: '格式重发',
  outdated: '过时退回',
  failed: '失败',
  dropped: '重启丢弃',
  controlled: '受控操作取消',
}

export const templateStatusLabels: Record<TemplateStatus, string> = {
  available: '可以请',
  joined: '已住在镇上',
  archived: '已收起',
}

export const goalStatusLabels: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  abandoned: '已放弃',
  failed: '失败',
}

export const noteStatusLabels: Record<NoteStatus, string> = {
  candidate: '暂时的判断',
  supported: '有多次经历支持',
  rejected: '已被新证据否定',
}

export const memoryKindLabels: Record<MemoryKind, string> = {
  episode: '经历',
  recognition: '认识',
  experience: '经验',
}

export const memorySourceLabels: Record<EvidenceSource, string> = {
  observed: '亲眼看到',
  reported: '听别人说的',
  inferred: '自己推测的',
}

export const memoryStatusLabels: Record<MemoryStatus, string> = {
  active: '记着',
  candidate: '还没确定',
  superseded: '后来改了看法',
}

export const interactionStatusLabels: Record<InteractionStatus, string> = {
  offered: '等待回应',
  running: '进行中',
  succeeded: '完成',
  declined: '已拒绝',
  cancelled: '已取消',
  expired: '已过期',
  interrupted: '已中断',
}
