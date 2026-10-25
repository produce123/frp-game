import { errorText } from 'town-shared/format'
import { TownApiError, type api } from './api'
import type { CreatorContext } from './creatorContext'
import type { ReportConstraint } from './creatorTypes'

// 生成进度和结果说明：生成期间轮询进度，失败时把后端给的细节拼成一句话。

const directions: Record<string, string> = {
  north: '在北面',
  south: '在南面',
  east: '在东面',
  west: '在西面',
}
const stageNames: Record<string, string> = {
  preparing: '正在读取建筑与地形…',
  terrain_synthesis: '正在合成四周地貌…',
  terrain_selection: '正在检查候选地块…',
  terrain_fallback: '这种地貌没通过验收，换一种重试…',
  layout_fallback: '这个种子排不出通路，换布局种子重试…',
  topology: '正在生成路网…',
  districts: '正在安排街区…',
  roads: '正在连接道路…',
  parcels: '正在安排建筑和入口…',
  surfaces: '正在生成区域和道具位置…',
  geometry_validation: '正在检查地图几何与通路…',
  spatial: '正在安排地形、建筑、室内通道和树丛…',
  runtime_validation: '正在校验地图能否运行…',
}
type GenerationProgress = {
  stage: string
  elapsed_ms: number
  limit_ms: number | null
  candidate?: number
  candidate_total?: number
  inner?: number
  topology_attempt?: number
  topology_total?: number
  last_failure?: string
}
const generationFailureNames: Record<string, string> = {
  ROUTE_UNRESOLVED: '这张地块无法容纳完整路网',
  INSUFFICIENT_SPACE: '这张地块放不下全部建筑',
  TERRAIN_EARTHWORK_EXCESS: '道路整形量过大',
  TERRAIN_ROAD_CROSS_SLOPE: '道路横坡过大',
  TERRAIN_FOUNDATION_DEVIATION: '建筑地基高差过大',
  HARBOR_UNRESOLVED: '港区没有可用岸线',
}

/** 后端报告里的一条位置要求，结果写成人话：「图书馆在广场北边 ✓」「住宅没能都挨着广场，可以换一张布局再试」 */
export function constraintSummary(c: ReportConstraint, nameOf: (kind: string) => string) {
  const subject = nameOf(c.subject),
    other = nameOf(c.relative_to)
  const side = (directions[c.value ?? ''] ?? c.value ?? '').replace(/^在|面$/g, '')
  if (c.kind === 'near')
    return c.satisfied
      ? `${subject}挨着${other} ✓`
      : `${subject}没能都挨着${other}，可以换一张布局再试`
  return c.satisfied
    ? `${subject}在${other}${side}边 ✓`
    : `${subject}没能排在${other}${side}边，可以换一张布局再试`
}

/** 失败原因：TownApiError 的 details 里带地点与度量时，一并拼进提示 */
export function failureMessage(error: unknown, nameOf: (kind: string) => string): string {
  const message = errorText(error)
  if (!(error instanceof TownApiError) || !error.details) return message
  const d = error.details
  const name = (ref: unknown) => {
    if (typeof ref !== 'string') return ''
    const [kind, index] = ref.split(':')
    return `${nameOf(kind)}${index ? ` ${index}` : ''}`
  }
  const details: string[] = []
  if (Array.isArray(d.place_refs)) details.push(`涉及地点：${d.place_refs.map(name).join('、')}`)
  // 位置关系写成人话：哪处没放到哪处的哪一面、哪两处没挨近
  const sides: Record<string, string> = { north: '北', south: '南', east: '东', west: '西' }
  if (Array.isArray(d.constraints))
    for (const c of d.constraints) {
      if (!c || typeof c !== 'object') continue
      if (c.kind === 'direction')
        details.push(
          `${name(c.subject)}没能排在${name(c.relative_to)}的${sides[c.value] ?? c.value}面`
        )
      else if (c.kind === 'near') details.push(`${name(c.subject)}没能挨着${name(c.relative_to)}`)
      else if (typeof c.measured === 'number' && typeof c.expected === 'number')
        details.push(
          `${name(c.subject)}与${name(c.relative_to)}：实际 ${Math.round(c.measured)}，要求 ${Math.round(c.expected)}`
        )
    }
  if (typeof d.measured === 'number' && typeof d.expected === 'number')
    details.push(
      `实际 ${Math.round(d.measured * 100) / 100}，要求 ${Math.round(d.expected * 100) / 100}`
    )
  if (typeof d.reason === 'string') details.push(d.reason)
  return [message, ...details].join('；')
}

/** 进度条下面的一行：第几张地块、第几次路网、上一张为什么没过、用了几秒 */
function progressDetail(task: GenerationProgress, elapsed: number, limit: number) {
  const limited = Number.isFinite(limit) && limit > 0
  const candidate = task.candidate
    ? `第 ${task.candidate}${task.candidate_total ? ` / ${task.candidate_total}` : ''} 张地块`
    : ''
  const topology = task.topology_attempt
    ? `路网 ${task.topology_attempt}${task.topology_total ? ` / ${task.topology_total}` : ''}`
    : ''
  const failure = task.last_failure
    ? (generationFailureNames[task.last_failure] ?? task.last_failure)
    : ''
  return [
    candidate,
    topology,
    task.inner ? `${task.inner} 米地块` : '',
    failure ? `上一张：${failure}` : '',
    limited
      ? `${(elapsed / 1000).toFixed(1)} / ${(limit / 1000).toFixed(1)} 秒`
      : `已用 ${(elapsed / 1000).toFixed(1)} 秒`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** 生成期间每 300 ms 问一次进度；current 是这次生成的 revision。返回停止函数 */
export function trackProgress(
  c: CreatorContext,
  request: typeof api,
  taskId: string,
  current: number,
  signal: AbortSignal
) {
  let tracking = true
  const timer = window.setInterval(() => {
    void request<GenerationProgress>(`/generation/${taskId}`, undefined, signal)
      .then((task) => {
        if (!tracking || current !== c.revision) return
        const elapsed = Math.max(0, task.elapsed_ms ?? 0),
          limit = Number(task.limit_ms),
          bar = c.el<HTMLProgressElement>('generation-progress-bar')
        if (Number.isFinite(limit) && limit > 0) {
          bar.max = limit
          bar.value = Math.min(elapsed, limit)
        } else {
          bar.removeAttribute('value')
        }
        c.el('generation-progress-detail').textContent = progressDetail(task, elapsed, limit)
        c.status(stageNames[task.stage] ?? '正在生成小镇…')
      })
      .catch(() => {
        // 进度查询失败不影响生成本身；真正的错误由 /preview 请求报告
      })
  }, 300)
  return () => {
    tracking = false
    window.clearInterval(timer)
  }
}
