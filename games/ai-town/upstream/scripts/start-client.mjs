// One app manager, on-demand worlds, one shared browser client.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createManager, exitOnCrash, stopOnSignal } from './town-manager.mjs'
import { verifyClientBuild } from './client-build-state.mjs'
const root = fileURLToPath(new URL('../', import.meta.url)),
  mode = process.argv[2] ?? 'dev'
if (!['dev', 'preview'].includes(mode)) throw Error('Expected dev or preview')
let client
let port = Number(process.env.TOWN_MANAGER_PORT ?? 8788)
if (mode === 'preview') {
  const args = process.argv.slice(3),
    i = args.indexOf('--port')
  port = i >= 0 ? Number(args[i + 1]) : 5174
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('应用端口无效')
}
exitOnCrash()
if (mode === 'preview') await verifyClientBuild(root)
console.log(`[town-client] ${mode} · ${root}`)
const manager = await createManager({ port })
if (mode === 'dev')
  client = spawn(
    process.execPath,
    [path.join(root, 'frontend/town-2d/node_modules/vite/bin/vite.js'), ...process.argv.slice(3)],
    { cwd: path.join(root, 'frontend/town-2d'), windowsHide: true, stdio: 'inherit' }
  )
let stopping = false
async function stop(code = 0) {
  if (stopping) return
  stopping = true
  client?.kill('SIGTERM')
  process.exitCode = code
  await manager.stop()
}
client?.once('error', (e) => {
  console.error(e.message)
  void stop(1)
})
client?.once('exit', (code) => {
  void stop(code ?? 0)
})
stopOnSignal(stop)
