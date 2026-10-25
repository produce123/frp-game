import { spawn } from 'node:child_process'
import path from 'node:path'
const STDOUT_LIMIT = 4_000_000
const STDERR_TAIL = 2000
// 运行 town-map 子进程：parse / options / validate，以及模型服务的读、存、测试。stdin 送 JSON，stdout 收 JSON。
export function worker(source, config, mode, input, { signal, timeout = 100000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.TOWN_MAP_BINARY ?? path.join(source, 'target/debug/town-map'),
      [mode],
      {
        cwd: source,
        // 隐藏管理服务的窗口不会传递给子进程；后台校验和状态轮询也要显式隐藏控制台。
        windowsHide: true,
        env: { ...process.env, AI_TOWN_CONFIG: config },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )
    let stdout = '',
      stderr = '',
      finished = false
    // 只保留 stderr 末尾，panic 信息在末尾。
    const withStderr = (message) => {
      const tail = stderr.trim().slice(-STDERR_TAIL)
      return tail ? `${message}：${tail}` : message
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(
        Error(['parse', 'test-model'].includes(mode) ? '模型请求超时，请稍后重试' : '地图校验超时')
      )
    }, timeout)
    const abort = () => {
      child.kill('SIGKILL')
      done(Error('操作已取消'))
    }
    function done(error, value) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(value)
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout.on('data', (data) => {
      stdout += data
      if (stdout.length > STDOUT_LIMIT) {
        child.kill()
        done(Error('模型结果超过限制'))
      }
    })
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-STDERR_TAIL * 2)
    })
    child.on('error', () => done(Error('找不到地图服务，请先构建 host 与 town-map')))
    child.on('exit', (code) => {
      let result
      try {
        result = JSON.parse(stdout)
      } catch {
        done(Error(withStderr(`地图进程未返回有效结果（退出码 ${code}）`)))
        return
      }
      if (code || result.error) done(Error(withStderr(result.error ?? '地图操作失败')))
      else done(null, result)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(input))
  })
}
