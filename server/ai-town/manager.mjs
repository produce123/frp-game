/*
 * 每个平台用户一个 town-manager 进程。
 *
 * 为什么一人一个进程：上游的 `--root`（存档根）和 `--max-running` 都是**进程级**参数，
 * 没有"同一进程里多个子根"的概念。用户要求"每个用户能保存自己的存档"且不改上游，
 * 那就只能一人一个 --root。两个平台用户同时开镇 = 两个 manager + 两个 host + 模型。
 *
 * 这个模块只负责：起进程、等就绪、发 HTTP、停进程。房间/成员/票据在 rooms.mjs。
 */

import { spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  FALLBACK_HOST_BIN,
  FALLBACK_MANAGER_BIN,
  HOST_BIN,
  LOG_DIR,
  MANAGER_BIN,
  PROXY_TIMEOUT_MS,
  SHARED_MODEL,
  START_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  UPSTREAM_DIR,
  WEB_DIR,
  managerLog,
  userRoot,
} from './config.mjs';

/** 上游 manager 的会话 Cookie 名（crates/manager/src/routes.rs）。 */
const SESSION_COOKIE = 'town_session';

/** 只保留能安全转发的头；Host / Cookie / X-Town-Client 一律由我们重写。 */
function cleanHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const k = key.toLowerCase();
    if (k === 'host' || k === 'cookie' || k === 'x-town-client' || k === 'connection'
      || k === 'accept-encoding' || k === 'content-length') continue;
    out[k] = value;
  }
  // 上游返回的是 JSON，压缩对我们没好处，反而让 open 的响应没法改写。
  out['accept-encoding'] = 'identity';
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 每个用户根里要有 builtin-model/model.gguf。
 * 同盘用硬链接：两个用户各一份路径、磁盘只占一份；跨盘/权限不允许时退回复制。
 */
function ensureModel(root) {
  if (!existsSync(SHARED_MODEL)) return false;
  const dir = join(root, 'builtin-model');
  const target = join(dir, 'model.gguf');
  if (existsSync(target)) return true;
  mkdirSync(dir, { recursive: true });
  try {
    linkSync(SHARED_MODEL, target);
  } catch {
    try { copyFileSync(SHARED_MODEL, target); } catch { return false; }
  }
  return true;
}

function httpJson({ port, secret, method, path, body, timeout = PROXY_TIMEOUT_MS }) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {
      host: `127.0.0.1:${port}`,
      'x-town-client': '1',
      'accept-encoding': 'identity',
    };
    if (secret) headers.cookie = `${SESSION_COOKIE}=${secret}`;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers,
      agent: false,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { /* 不是 JSON */ }
        resolvePromise({ status: res.statusCode || 502, headers: res.headers, raw, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('小镇服务响应超时')));
    req.on('error', reject);
    if (payload) req.end(payload); else req.end();
  });
}

export function createAiTownManagers({ log = console.log } = {}) {
  /** userId -> { child, port, secret, logStream, startedAt, lastUsedAt, stopping } */
  const entries = new Map();
  const starting = new Map();

  function managerPath() {
    return existsSync(MANAGER_BIN) ? MANAGER_BIN : FALLBACK_MANAGER_BIN;
  }

  function hostPath() {
    return existsSync(HOST_BIN) ? HOST_BIN : FALLBACK_HOST_BIN;
  }

  function binReady() {
    return existsSync(managerPath()) && existsSync(hostPath());
  }

  async function ensure(userId) {
    if (!binReady()) {
      throw new Error('AI 小镇后端还没编译好（见 docs/GAMES.md《AI 小镇》）');
    }
    const existing = entries.get(userId);
    if (existing && !existing.stopping && existing.port) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (starting.has(userId)) return starting.get(userId);

    const promise = (async () => {
      if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
      const root = userRoot(userId);
      mkdirSync(root, { recursive: true });
      if (!ensureModel(root)) {
        log(`AI 小镇内置模型还没准备（${SHARED_MODEL}）；村民会先等着，不影响进镇`);
      }

      const readyFile = join(root, 'town-manager-ready.json');
      try { rmSync(readyFile, { force: true }); } catch { /* 没有就算了 */ }

      const secret = randomBytes(16).toString('hex');
      const args = [
        '--root', root,
        '--app', UPSTREAM_DIR,
        '--web', WEB_DIR,
        '--host-bin', hostPath(),
        '--port', '0',
        '--ready-file', readyFile,
        '--session-secret', secret,
        '--max-running', '1',
        '--stop-on-stdin-close',
      ];
      // 测试 / 没模型时先跑起来：只影响聊天和思考，不影响建镇、存档、联机。
      if (process.env.AI_TOWN_MOCK_LLM === '1' || process.env.AI_TOWN_MOCK_LLM === 'true') {
        args.push('--mock-llm');
      }

      const stream = createWriteStream(managerLog(userId), { flags: 'a' });
      stream.write(`\n===== ${new Date().toISOString()} 启动 AI 小镇 manager（user=${userId}）=====\n`);
      const child = spawn(managerPath(), args, {
        cwd: UPSTREAM_DIR,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, RUST_BACKTRACE: '1' },
      });
      child.stdout.on('data', (c) => stream.write(c));
      child.stderr.on('data', (c) => stream.write(c));

      const entry = {
        child,
        port: 0,
        secret,
        logStream: stream,
        startedAt: Date.now(),
        lastUsedAt: Date.now(),
        stopping: false,
      };
      entries.set(userId, entry);

      child.on('exit', (code, signal) => {
        entry.stopping = true;
        entry.port = 0;
        entries.delete(userId);
        stream.write(`\n===== manager 退出 code=${code} signal=${signal} =====\n`);
        try { stream.end(); } catch { /* 已关 */ }
        log(`AI 小镇 manager 退出（user=${userId}, code=${code}）`);
      });
      child.on('error', (err) => {
        entry.stopping = true;
        entries.delete(userId);
        log(`AI 小镇 manager 起不来（user=${userId}）：${err.message}`);
      });

      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        const ready = readJson(readyFile);
        if (ready && ready.port && ready.pid === child.pid) {
          entry.port = Number(ready.port);
          // 等健康检查真正应答（ready 文件写出来时 listener 已经在跑，但再确认一次）
          try {
            const health = await httpJson({
              port: entry.port,
              secret,
              method: 'GET',
              path: '/api/towns/health',
              timeout: 2000,
            });
            if (health.status === 200) {
              log(`AI 小镇 manager 就绪（user=${userId}, 127.0.0.1:${entry.port}）`);
              return entry;
            }
          } catch { /* 还没起来 */ }
        }
        await new Promise((r) => setTimeout(r, 120));
      }

      // 起不来：别把死进程留在表里
      entry.stopping = true;
      try { child.stdin.end(); } catch { /* 已关 */ }
      try { child.kill(); } catch { /* 已退 */ }
      entries.delete(userId);
      throw new Error(`AI 小镇后端启动超时（日志：${managerLog(userId)}）`);
    })().finally(() => starting.delete(userId));

    starting.set(userId, promise);
    return promise;
  }

  async function stop(userId) {
    const entry = entries.get(userId);
    if (!entry) return;
    entry.stopping = true;
    entries.delete(userId);
    const child = entry.child;
    try { child.stdin.end(); } catch { /* 已关 */ }
    const exited = await new Promise((resolvePromise) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* 已退 */ }
        resolvePromise(false);
      }, STOP_TIMEOUT_MS);
      child.once('exit', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(true);
      });
    });
    if (!exited && child.pid) {
      // Windows 上 SIGKILL 依然是 TerminateProcess，/T 才能把 host、llama-server 一起收。
      try {
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
      } catch { /* 已经没了 */ }
    }
    try { entry.logStream.end(); } catch { /* 已关 */ }
    log(`AI 小镇 manager 已关闭（user=${userId}）`);
  }

  function get(userId) {
    return entries.get(userId) || null;
  }

  function activeCount() {
    return entries.size;
  }

  /** 挑一个最久没用的 manager 关掉，给新用户腾内存。 */
  async function evictOldest() {
    let oldest = null;
    for (const [id, entry] of entries) {
      if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) oldest = { id, lastUsedAt: entry.lastUsedAt };
    }
    if (oldest) await stop(oldest.id);
  }

  async function ensureWithCapacity(userId) {
    if (!entries.has(userId)) {
      const { MAX_MANAGERS } = await import('./config.mjs');
      while (entries.size >= MAX_MANAGERS) await evictOldest();
    }
    return ensure(userId);
  }

  /** 流式反代一个 HTTP 请求；transformJson 用来改写 open 的响应。 */
  async function proxyHttp(req, res, userId, targetPath, { transformJson = null } = {}) {
    let entry;
    try {
      entry = await ensureWithCapacity(userId);
    } catch (err) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
    entry.lastUsedAt = Date.now();

    const headers = cleanHeaders(req.headers);
    headers.host = `127.0.0.1:${entry.port}`;
    headers.cookie = `${SESSION_COOKIE}=${entry.secret}`;
    headers['x-town-client'] = '1';
    // 有请求体时保留长度，Node 才能正确决定 chunked / content-length。
    if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];

    const upstream = http.request({
      host: '127.0.0.1',
      port: entry.port,
      method: req.method,
      path: targetPath,
      headers,
      agent: false,
      timeout: PROXY_TIMEOUT_MS,
    }, (upstreamRes) => {
      const status = upstreamRes.statusCode || 502;
      const outHeaders = cleanHeaders(upstreamRes.headers);
      delete outHeaders['set-cookie'];

      const isJson = String(upstreamRes.headers['content-type'] || '').includes('application/json');
      if (transformJson && isJson && status >= 200 && status < 300) {
        const chunks = [];
        upstreamRes.on('data', (c) => chunks.push(c));
        upstreamRes.on('end', () => {
          let body;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            body = transformJson(body);
          } catch {
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              .end(JSON.stringify({ ok: false, error: '小镇服务返回了无法解析的内容' }));
            return;
          }
          const payload = Buffer.from(JSON.stringify(body), 'utf8');
          outHeaders['content-type'] = 'application/json; charset=utf-8';
          outHeaders['content-length'] = String(payload.length);
          outHeaders['cache-control'] = 'no-store';
          res.writeHead(status, outHeaders).end(payload);
        });
        return;
      }

      res.writeHead(status, outHeaders);
      upstreamRes.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('小镇服务响应超时')));
    upstream.on('error', (err) => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        .end(JSON.stringify({ ok: false, error: `小镇服务连不上：${err.message}` }));
    });
    req.pipe(upstream);
    return true;
  }

  /** 缓冲式 JSON 调用（房间层自己用，不经过浏览器）。 */
  async function call(userId, method, targetPath, body, { timeout = PROXY_TIMEOUT_MS } = {}) {
    const entry = await ensureWithCapacity(userId);
    entry.lastUsedAt = Date.now();
    return httpJson({ port: entry.port, secret: entry.secret, method, path: targetPath, body, timeout });
  }

  /** 读小镇列表（含存档）。 */
  async function list(userId) {
    const r = await call(userId, 'GET', '/api/towns');
    if (r.status !== 200 || !r.json) {
      throw new Error(r.json?.error || `小镇列表读取失败（${r.status}）`);
    }
    return r.json;
  }

  /** 开镇。返回上游原样的 entry：{ id, name, description, mapHash, endpoint, lease, ... }。 */
  async function open(userId, townId, { automatic = false } = {}) {
    const r = await call(userId, 'POST', `/api/towns/${encodeURIComponent(townId)}/open`, { automatic }, {
      timeout: 180_000,
    });
    if (r.status !== 200 || !r.json) {
      throw new Error(r.json?.error || `开镇失败（${r.status}）`);
    }
    return r.json;
  }

  /** 保存并关镇。lease 让刷新时"旧页面的关闭"不会关掉新页面刚开的镇。 */
  async function close(userId, townId, lease) {
    try {
      const r = await call(userId, 'POST', `/api/towns/${encodeURIComponent(townId)}/close`, {
        ...(lease ? { lease } : {}),
      }, { timeout: 30_000 });
      return r.status === 200;
    } catch {
      return false;
    }
  }

  async function closeAll() {
    const ids = [...entries.keys()];
    await Promise.allSettled(ids.map((id) => stop(id)));
  }

  function sweep() {
    const now = Date.now();
    for (const [id, entry] of entries) {
      if (now - entry.lastUsedAt > 10 * 60 * 1000) stop(id);
    }
  }

  return {
    binReady,
    ensure: ensureWithCapacity,
    stop,
    stopAll: closeAll,
    closeAll,
    get,
    list,
    open,
    close,
    proxyHttp,
    sweep,
    get activeCount() { return entries.size; },
  };
}