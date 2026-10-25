import { createAssetRoutes } from './towns/asset-routes.mjs'
import { createCreation } from './towns/creation.mjs'
import { createModelRoutes } from './towns/models.mjs'
import { createBuiltinModelRoutes } from './towns/builtin-model.mjs'
import { createTownRoutes } from './towns/town-routes.mjs'
import { Raw, HttpError, readBody, describe } from './towns/http.mjs'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Storage, readJson, atomicJson, dataRoot, setupConfig } from './towns/storage.mjs'
import { Hosts } from './towns/hosts.mjs'
const source = fileURLToPath(new URL('../', import.meta.url))

// 一个数据目录只允许一个管理服务；上一个进程已退出时接管它留下的锁。
async function acquireLock(root) {
  const lock = path.join(root, 'manager.lock')
  try {
    await fs.mkdir(lock)
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    let stale = false
    try {
      const old = await readJson(path.join(lock, 'owner.json'))
      try {
        process.kill(old.pid, 0)
      } catch (e2) {
        if (e2.code === 'ESRCH') stale = true
      }
    } catch {}
    if (!stale) throw Error('此数据目录已有小镇管理服务，请先关闭该服务')
    await fs.rm(lock, { recursive: true })
    await fs.mkdir(lock)
  }
  await atomicJson(path.join(lock, 'owner.json'), { pid: process.pid, source })
  return () => fs.rm(lock, { recursive: true, force: true })
}

// mockLlm：所有 host 用固定回复模型启动，供测试使用。
export async function createManager({
  root = dataRoot(),
  configPath,
  port = Number(process.env.TOWN_MANAGER_PORT ?? 8788),
  mockLlm = false,
  maxRunning,
} = {}) {
  const storage = new Storage(root, source)
  await storage.init()
  const releaseLock = await acquireLock(root)
  const config = configPath ?? (await setupConfig(root, source)),
    hosts = new Hosts(source, storage, config, { mockLlm, maxRunning })
  const [library, contours, definitions] = await Promise.all(
    [
      'data/mapgen/templates.json',
      'data/mapgen/contours.json',
      'data/props/core/definitions.json',
    ].map((p) => readJson(path.join(source, p)))
  )
  const queues = new Map()
  let stopping = false
  const active = new Set()
  // 同一把钥匙下的操作串行执行。
  const serial = (key, fn) => {
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
    queues.set(key, next)
    return next.finally(() => {
      if (queues.get(key) === next) queues.delete(key)
    })
  }
  const assets = createAssetRoutes({ source, storage }),
    creation = createCreation({
      source,
      root,
      config,
      storage,
      library,
      contours,
      definitions,
      serial,
    })
  const builtinModel = createBuiltinModelRoutes({ source, config })
  const routes = [
    ...createModelRoutes({ source, config, serial }),
    ...builtinModel.routes,
    ...creation.routes,
    ...assets.routes,
    ...createTownRoutes({ source, storage, hosts, serial }),
  ]
  async function dispatch(req, signal) {
    if (stopping) throw new HttpError(503, '应用正在退出')
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? ''))
      throw new HttpError(403, '仅提供本机服务')
    const url = new URL(req.url, 'http://127.0.0.1'),
      route = url.pathname.replace(/\/$/, '')
    const found = routes.find(([method, pattern]) => method === req.method && pattern.test(route))
    if (!found) throw new HttpError(404, '操作不存在')
    const [, pattern, handler] = found
    const params = route.match(pattern).slice(1)
    const body = req.method === 'POST' ? await readBody(req) : {}
    return handler({ url, params, body, signal, headers: req.headers })
  }
  const server = http.createServer(async (req, res) => {
    const controller = new AbortController()
    active.add(controller)
    res.on('close', () => {
      active.delete(controller)
      if (!res.writableEnded) controller.abort()
    })
    const send = (code, headers, body) => {
      if (res.destroyed) return
      res.writeHead(code, { 'X-Content-Type-Options': 'nosniff', ...headers })
      res.end(body)
    }
    const json = (code, value) =>
      send(
        code,
        { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        JSON.stringify(value)
      )
    try {
      const value = await dispatch(req, controller.signal)
      if (value instanceof Raw) send(value.status, value.headers, value.body)
      else json(200, value)
    } catch (e) {
      const [code, payload] = describe(e)
      if (code >= 500) console.error('[town-manager]', e)
      json(code, payload)
    }
  })
  server.requestTimeout = 120000
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  } catch (e) {
    await releaseLock()
    throw e
  }
  console.log(`[town-manager] http://127.0.0.1:${server.address().port} · ${root}`)
  async function stop() {
    if (stopping) return
    stopping = true
    for (const c of active) c.abort()
    builtinModel.stop()
    try {
      await hosts.stop()
    } finally {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
      await releaseLock()
    }
  }
  return { server, storage, hosts, stop }
}

// 未捕获的错误：记录后退出；process 'exit' 处理器会结束所有 host。
export function exitOnCrash() {
  for (const event of ['uncaughtException', 'unhandledRejection'])
    process.on(event, (e) => {
      console.error(`[town-manager] ${event}:`, e)
      process.exit(1)
    })
}
// 第一次 Ctrl+C 正常关闭并等待各世界保存；第二次直接退出。
export function stopOnSignal(stop) {
  let asked = false
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (asked) process.exit(130)
      asked = true
      stop().catch((e) => {
        console.error(e.message)
        process.exitCode = 1
      })
    })
}
if (process.argv[1] && (await fs.realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  exitOnCrash()
  const manager = await createManager({ mockLlm: process.env.TOWN_MOCK_LLM === '1' })
  stopOnSignal(() => manager.stop())
}
