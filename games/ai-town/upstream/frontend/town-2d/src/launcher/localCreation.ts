// 手机应用的建镇：应用里的管理服务（Rust）跑不了生成器，/options 回答 generation: 'client'。
// 这时生成在网页的工作线程里做，管理服务只负责理解描述（调模型）、校验成品地图、暂存草稿和保存。
// 对建镇页来说接口不变：还是 /options、/parse、/preview、/generation/编号、/save。
import { APPEARANCE_SET, PARAMETERS } from '../../../../scripts/mapgen/budget.mjs'
import { limits, resources } from '../../../../scripts/mapgen/spec.mjs'
import { plannerKinds, tidyPlan } from '../../../../scripts/mapgen/plan.mjs'
import library from '../../../../data/mapgen/templates.json'
import { api, TownApiError } from './api'
import type { ParseResult } from './creatorTypes'

type Request = typeof api
type Generated = { document: { content_hash: string }; report: unknown }
type Stage = string | { stage?: string }

/** 在工作线程里生成一版；取消或超时就结束线程 */
function generateInWorker(
  spec: unknown,
  signal: AbortSignal | undefined,
  onStage: (s: Stage) => void
) {
  return new Promise<Generated>((resolve, reject) => {
    const worker = new Worker(new URL('./generator.worker.ts', import.meta.url), { type: 'module' })
    const done = (error?: Error, result?: Generated) => {
      worker.terminate()
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = () => done(new TownApiError('生成已取消', 'GENERATION_CANCELLED'))
    // 生成器自己按 max_ms 计时；这里再兜一层，线程卡住时也能结束
    const timer = setTimeout(
      () =>
        done(new TownApiError('地图生成超过计算时间，请减少地点或空间要求', 'GENERATION_TIMEOUT')),
      PARAMETERS.max_ms + 5000
    )
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = ({ data }) => {
      if (data.stage) return onStage(data.stage)
      if (data.error)
        return done(new TownApiError(data.error.message, data.error.code, data.error.details))
      done(undefined, data.result)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      done(new TownApiError(event.message || '地图计算出错', 'GENERATION_FAILED'))
    }
    if (signal?.aborted) abort()
    else worker.postMessage({ spec })
  })
}

/** 建镇页用的请求：管理服务说要在网页里生成时接管 /preview 和进度查询，其余照常转给服务 */
export function creationRequest(base: Request = api): Request {
  let client = false
  const tasks = new Map<string, { stage: string; started: number }>()
  return async function request<T>(path: string, body?: unknown, signal?: AbortSignal) {
    if (path === '/options') {
      const remote = await base<Record<string, unknown>>(path, undefined, signal)
      client = remote.generation === 'client'
      if (!client) return remote as T
      return {
        templates: library.templates.map(({ kind, name, outdoor }) => ({ kind, name, outdoor })),
        limits,
        resources,
        styles: [{ id: APPEARANCE_SET, name: '海岸乡镇' }],
        model: remote.model,
        uncompleted_drafts: '草稿保留两小时；重新打开创建页时需重新预览，已保存小镇不受影响',
      } as T
    }
    if (!client) return base<T>(path, body, signal)
    if (path === '/parse') {
      // 生成器在页面里：模型能用哪些地点由这边告诉管理服务
      const request = { ...(body as { seed: number }), templates: plannerKinds(library.templates) }
      const result = await base<ParseResult>(path, request, signal)
      try {
        return tidyPlan(result, library.templates, request.seed) as T
      } catch (error) {
        throw new TownApiError((error as Error).message, 'INVALID_SPEC')
      }
    }
    if (path === '/preview') {
      const { spec, request_id } = body as { spec: unknown; request_id: string }
      const task = { stage: 'districts', started: performance.now() }
      tasks.set(request_id, task)
      try {
        const result = await generateInWorker(spec, signal, (s) => {
          task.stage = typeof s === 'string' ? s : (s.stage ?? task.stage)
        })
        task.stage = 'runtime_validation'
        const draft = await base<Record<string, unknown>>(
          '/drafts',
          { request_id, document: result.document },
          signal
        )
        task.stage = 'complete'
        return { ...draft, ...result } as T
      } catch (error) {
        task.stage = 'failed'
        throw error
      } finally {
        setTimeout(() => tasks.delete(request_id), 30000)
      }
    }
    const progress = /^\/generation\/(.+)$/.exec(path)
    if (progress) {
      const task = tasks.get(progress[1])
      return {
        stage: task?.stage ?? 'pending',
        elapsed_ms: task ? performance.now() - task.started : 0,
        limit_ms: PARAMETERS.max_ms,
      } as T
    }
    return base<T>(path, body, signal)
  } as Request
}
