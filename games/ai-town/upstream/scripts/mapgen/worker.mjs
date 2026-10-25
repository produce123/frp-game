import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { generate } from './generate.mjs'
import { GenerationError, PARAMETERS } from './budget.mjs'
import { flushDebug } from './debug.mjs'

if (!isMainThread) {
  let message
  try {
    const { spec, library, contours, definitions, options } = workerData
    const result = generate(spec, library, contours, definitions, {
      ...options,
      onStage: (stage) => parentPort.postMessage({ stage }),
    })
    message = { result }
  } catch (e) {
    message = {
      error: {
        message: e.message,
        code: e.code ?? 'GENERATION_FAILED',
        details: e.details ?? {},
      },
    }
  }
  // 主线程收到结果就结束本线程，先把诊断行写完。
  await flushDebug()
  parentPort.postMessage(message)
}

export function runGeneration(
  spec,
  library,
  contours,
  definitions,
  { signal, onStage, options = {} } = {}
) {
  if (signal?.aborted)
    return Promise.reject(
      new GenerationError('GENERATION_CANCELLED', '生成已取消', {
        stage: 'worker',
      })
    )
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { spec, library, contours, definitions, options },
      execArgv: [],
    })
    let finished = false,
      lastStage = 'worker'
    const done = async (error, result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      await worker.terminate().catch(() => {})
      if (error) reject(error)
      else resolve(result)
    }
    const abort = () =>
      void done(
        new GenerationError('GENERATION_CANCELLED', '生成已取消', {
          stage: 'worker',
        })
      )
    const timer = setTimeout(
      () =>
        void done(
          new GenerationError('GENERATION_TIMEOUT', '地图生成超过计算时间，请减少地点或空间要求', {
            stage: lastStage,
          })
        ),
      options.max_ms ?? PARAMETERS.max_ms
    )
    signal?.addEventListener('abort', abort, { once: true })
    worker.on('message', (message) => {
      if (finished) return
      if (message.stage) {
        lastStage = typeof message.stage === 'string' ? message.stage : message.stage.stage
        onStage?.(message.stage)
        return
      }
      const e = message.error
      void done(e ? new GenerationError(e.code, e.message, e.details) : null, message.result)
    })
    worker.on(
      'error',
      (e) =>
        void done(
          new GenerationError('GENERATION_FAILED', e.message, {
            stage: 'worker',
          })
        )
    )
    worker.on('exit', (code) => {
      if (!finished)
        void done(
          new GenerationError('GENERATION_FAILED', `地图计算进程提前退出（${code}）`, {
            stage: 'worker',
          })
        )
    })
    if (signal?.aborted) abort()
  })
}
