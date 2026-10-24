/*
 * 莲花广麻（上游 BestGuo2020/lianhuaguangdongmahjong + lianhua-mahjong-backend）
 * 的**平台接入层**。
 *
 * 边界（和 docs/ARCHITECTURE.md 的"上游缝合"一致）：
 *   · 界面 = 上游 Vue3 + Three.js 的构建产物（`games/mahjong/web/`），**不自己画 UI**；
 *   · 规则 = 上游自己的 Python 后端（FastAPI + WebSocket），跑在 127.0.0.1 的**内部端口**，
 *     本进程只做反向代理（HTTP + WebSocket），**不解析、不重写它的协议**；
 *   · 账号 = 平台账号：Node 是唯一网关，把已登录的平台身份写进 `x-frp-user-*` 头，
 *     后端开了 `FRP_TRUSTED_HEADERS=1` 就认这个身份（见 backend/app/api/deps.py 的补丁）；
 *   · 好友 / 邀请 / "正在玩" = 平台的（见 server/hub.mjs、server/mahjong-presence.mjs）。
 *
 * 公网只有 7891 一条隧道：麻将页面的 `/mahjong/api/*` 与 `/mahjong/ws/*`
 * 都在同一个端口上，由这里转发到内部 Python 端口。Python 只监听 127.0.0.1，公网摸不到。
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

export const MAHJONG_API_PREFIX = '/mahjong/api';
export const MAHJONG_WS_PREFIX = '/mahjong/ws';

/** 内部端口。不要写进隧道配置 —— 公网只认 7891。 */
export const MAHJONG_BACKEND_PORT = Number(process.env.MAHJONG_BACKEND_PORT) || 8123;

/** 后端启动最长等多久（首次 import 要装模型类，慢一点）。 */
const START_TIMEOUT_MS = 45_000;
/** HTTP 转发超时（开局请求偶尔要算几张牌，给足）。 */
const PROXY_TIMEOUT_MS = 30_000;

/** 找 Python：先看环境变量，再看后端目录里的 venv，最后退回系统 python。 */
export function findPython(backendDir, env = process.env) {
  if (env.MAHJONG_PYTHON && existsSync(env.MAHJONG_PYTHON)) return env.MAHJONG_PYTHON;
  const candidates = process.platform === 'win32'
    ? [join(backendDir, '.venv', 'Scripts', 'python.exe'), 'py']
    : [join(backendDir, '.venv', 'bin', 'python'), 'python3'];
  for (const candidate of candidates) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
    } else {
      return candidate;
    }
  }
  return '';
}

function healthOk(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/health',
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 && JSON.parse(text).status === 'ok');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** 把 http 请求头里的 hop-by-hop 项去掉（转发时不能原样带）。 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function cleanHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/** 公网 origin（头像绝对地址用）。隧道是 HTTPS，本机调试是 HTTP。 */
function originOf(req) {
  const host = String(req.headers.host || '127.0.0.1');
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const local = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
  const scheme = forwarded || (local ? 'http' : 'https');
  return `${scheme}://${host}`;
}

/**
 * @param {object} options
 * @param {string} options.root             仓库根目录
 * @param {number} [options.port]           内部端口
 * @param {boolean} [options.enabled=true]  要不要真的起 Python（测试可以关掉）
 * @param {string} [options.python]         指定解释器（默认找 venv）
 * @param {string} [options.dbPath]         后端 SQLite 路径（默认上游的 data/mahjong.db）
 */
export function createMahjong({
  root,
  port = MAHJONG_BACKEND_PORT,
  enabled = true,
  python = '',
  dbPath = '',
  logDir = join(root, 'data'),
} = {}) {
  const backendDir = join(root, 'games', 'mahjong', 'backend');
  const pythonPath = (python || findPython(backendDir)).trim();
  /** 后端进程（没有就是 null）。 */
  let child = null;
  let ready = false;
  let starting = null;
  let stopped = false;
  let logStream = null;

  function log(message) {
    console.log(`[麻将后端] ${message}`);
  }

  function logFile() {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    return join(logDir, 'mahjong-backend.log');
  }

  async function start() {
    if (!enabled) {
      log('未启用（测试/静态托管模式）');
      return false;
    }
    if (ready) return true;
    if (starting) return starting;

    starting = (async () => {
      // 已经有一个健康的实例（比如上次 Node 被强杀、子进程活了下来）→ 直接复用。
      if (await healthOk(port)) {
        ready = true;
        log(`复用已在运行的实例（127.0.0.1:${port}）`);
        return true;
      }
      if (!pythonPath) {
        log('找不到 Python。先在 games/mahjong/backend 建 venv（见 games/mahjong/README.md）');
        return false;
      }
      if (!existsSync(join(backendDir, 'app', 'main.py'))) {
        log(`后端源码不在 ${backendDir}`);
        return false;
      }
      if (!existsSync(logFile())) mkdirSync(logDir, { recursive: true });
      const stream = createWriteStream(logFile(), { flags: 'a' });
      logStream = stream;
      stream.write(`\n===== ${new Date().toISOString()} 启动麻将后端 =====\n`);

      const args = ['-m', 'uvicorn', 'app.main:app',
        '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'];
      child = spawn(pythonPath, args, {
        cwd: backendDir,
        env: {
          ...process.env,
          FRP_TRUSTED_HEADERS: 'True',
          ...(dbPath ? { MAHJONG_DB_PATH: dbPath } : {}),
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8',
          // 不想让上游的 TTS/大模型去连外网：没配 key 时它们本来就降级，
          // 这里再把日志关小声一点（法务/隐私上也更干净）。
          LOGURU_LEVEL: process.env.LOGURU_LEVEL || 'INFO',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', (chunk) => stream.write(chunk));
      child.stderr.on('data', (chunk) => stream.write(chunk));
      child.on('exit', (code, signal) => {
        ready = false;
        child = null;
        stream.write(`\n===== 麻将后端退出 code=${code} signal=${signal} =====\n`);
        if (!stopped) log(`后端进程退出了（code=${code}）。日志：${logFile()}`);
      });
      child.on('error', (err) => {
        ready = false;
        log(`后端进程起不来：${err.message}`);
      });

      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await healthOk(port)) {
          ready = true;
          log(`已启动（127.0.0.1:${port}，Python=${pythonPath}）`);
          return true;
        }
        if (!child) break; // 进程已经退出，没必要再等
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      log(`等了 ${START_TIMEOUT_MS / 1000} 秒后端还没就绪，日志：${logFile()}`);
      return false;
    })().finally(() => { starting = null; });

    return starting;
  }

  async function stop() {
    stopped = true;
    ready = false;
    const proc = child;
    child = null;
    if (proc) {
      try { proc.kill(); } catch { /* 已经退出 */ }
      // 给它 4 秒优雅退出，再强杀（Windows 上 uvicorn 会自己收尾）。
      await new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { proc.kill('SIGKILL'); } catch { /* 已经退出 */ }
          resolve();
        }, 4000);
        proc.once('exit', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        });
      });
    }
    try { logStream?.end(); } catch { /* 已经被关掉 */ }
    logStream = null;
  }

  /** 平台身份头。名字是 UTF-8，HTTP 头只允许 ASCII → 百分号编码，后端 unquote 回来。 */
  function identityHeaders(req, user) {
    if (!user) return {};
    // currentUser() 给的是 publicUser()：avatar 已经是 `/avatar/<id>?v=<版本>`。
    const avatarPath = typeof user.avatar === 'string' && user.avatar.startsWith('/')
      ? user.avatar
      : `/avatar/${encodeURIComponent(user.id)}`;
    return {
      'x-frp-user-id': String(user.id || ''),
      'x-frp-user-name': encodeURIComponent(String(user.name || '')),
      'x-frp-user-avatar': `${originOf(req)}${avatarPath}`,
    };
  }

  /** 转发 `/mahjong/api/...` → Python 的 `/api/...`。返回 true 表示已处理。 */
  function proxyHttp(req, res, user, pathname) {
    if (!ready) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(JSON.stringify({ detail: { code: 'MAHJONG_BACKEND_DOWN' } }));
      return true;
    }
    const targetPath = req.url.replace(/^\/mahjong/, '') || '/api';
    const headers = {
      ...cleanHeaders(req.headers),
      host: `127.0.0.1:${port}`,
      ...identityHeaders(req, user),
    };
    const upstream = httpRequest({
      host: '127.0.0.1',
      port,
      method: req.method,
      path: targetPath,
      headers,
      timeout: PROXY_TIMEOUT_MS,
      // 不要复用 Node 全局 agent 的 keep-alive 连接：uvicorn 会按自己的空闲超时
      // 关连接，池子里留下半关的 socket 时，下一个请求会卡到 30 秒超时（502）。
      agent: false,
    }, (upstreamRes) => {
      const outHeaders = cleanHeaders(upstreamRes.headers);
      // 后端的响应默认不压缩；Node 这边的静态 gzip 只作用于静态文件。
      res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('麻将后端响应超时')));
    upstream.on('error', (err) => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(JSON.stringify({ detail: { code: 'MAHJONG_BACKEND_ERROR', message: err.message } }));
    });
    req.pipe(upstream);
    return true;
  }

  return {
    start,
    stop,
    get ready() { return ready; },
    get port() { return port; },
    get backendDir() { return backendDir; },
    get pythonPath() { return pythonPath; },
    proxyHttp,
    /** ws.mjs 转发 upgrade 时用（只搬字节，不解析）。 */
    get proxyTarget() { return { prefix: MAHJONG_WS_PREFIX, port, host: '127.0.0.1' }; },
  };
}