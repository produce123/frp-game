/*
 * 无名杀（原版）的**文件后端** + 静态托管辅助。
 *
 * 为什么需要这个文件：
 * 上游打包出来的网页端（`games/noname-web/dist`）在启动时要探测一个**文件读写后端**
 * （`noname/init/browser.js` 的 `browserReady`：`fetch("/checkFile?fileName=noname.js")`），
 * 探测失败就 `return` —— 于是 `game.checkFile` 根本没被装上，紧接着
 * `loadConfig` 调它直接抛 `TypeError`，整页白屏。
 * 上游的网页端本来是靠 `@noname/fs`（一个 Fastify 服务，`pnpm serve`）同时
 * 「发静态文件 + 提供这 9 个接口」的。我们**不另起一个进程、也不多开端口**，
 * 而是在自己的 HTTP 服务里按同样的协议实现这 9 个接口 —— 这样隧道只用一个端口。
 *
 * ⚠️ **和上游的一处刻意偏离（安全）**：
 * 上游的后端把 dist 目录**读写同一份**（谁都能 POST /writeFile 覆盖 index.html）。
 * 我们把**写**关到一个独立目录 `data/noname/`（不进 git、也不在原版的静态目录里），
 * 读则"先 data、再 dist"（上传的东西盖住同名的自带文件）。
 *   · 正常玩（含导入扩展、换背景图/背景音）行为一致 —— 客户端读回来的是同一份内容；
 *   · 但**没有任何请求能覆盖掉 dist 里自带的文件**（大不了多出几个文件）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 无名杀打包产物（`cd games/noname-web && pnpm build` 的结果）。 */
export const NONAME_DIST = 'games/noname-web/dist';
/**
 * 网页端"写"落到这里：上传的扩展 / 背景图 / 背景音 / noname.config.txt。
 * 可以用环境变量 `FRP_NONAME_DATA` 换掉 —— `tools/check-noname.mjs` 靠它把
 * 写接口的往返测在一个临时目录里跑，**不碰真实数据**。
 */
export const NONAME_DATA = process.env.FRP_NONAME_DATA || 'data/noname';

/**
 * 无名杀**自己的联机中继**（上游 `packages/server`，`@noname/server`）。
 *
 * 上游联机是"客户端 ↔ 中继服务器 ↔ 客户端"：中继只负责登记房间、转发报文，
 * **不跑规则**（规则在房主浏览器里）。上游默认听 8082，客户端在「联机」里填地址连过去。
 *
 * 我们把它在本进程里起成 **127.0.0.1:8231**（⚠️ 不用上游默认的 8082：
 * 这台机器上 **QQ 正占着 8082**，而且绑的是 0.0.0.0 —— 撞上就会把公网流量转给 QQ），
 * 然后在**自己的 7891 端口**上用 `/noname-online` 这个路径做**裸 TCP 转发**
 * （见 `server/ws.mjs` 的 `proxy` 选项）。这样：
 *   · 隧道还是只映射 7891 —— 不用让用户再去面板加一条隧道；
 *   · 中继只监听回环地址，公网只能从我们这条路径进来；
 *   · 中继的代码**一个字没改**，上游更新时跟着一起更新。
 */
export const NONAME_RELAY_PORT = Number(process.env.FRP_NONAME_RELAY_PORT) || 8231;
/** 客户端要连的路径（挂在 7891 上）。 */
export const NONAME_RELAY_PATH = '/noname-online';

/** 工程根目录（`server/` 的上一级）。相对路径一律以它为基准，不吃启动时的 cwd。 */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_ROOT = resolve(ROOT, NONAME_DATA);
const DIST_ROOT = resolve(ROOT, NONAME_DIST);

/** 写请求的体积上限（背景图/扩展包都可能几 MB；上游给的是 10GB，我们收紧）。 */
const MAX_WRITE_BODY = 64 * 1024 * 1024;

/** 允许"写"的顶层目录/文件。别的路径一律拒绝 —— 见文件头的安全说明。 */
const WRITABLE = ['extension/', 'image/', 'audio/', 'noname.config.txt', 'config.txt'];

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const ok = (res, data) => json(res, 200, { success: true, code: 200, data });
const fail = (res, message) => json(res, 200, { success: false, code: 400, errorMsg: String(message) });

/** 把客户端传来的路径归一化成"相对 dist/data 的 posix 路径"；非法返回 null。 */
export function normalizePath(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let p = raw.replace(/\\/g, '/').trim();
  p = p.replace(/^\.\//, '').replace(/^\/+/, '');
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (!p || p === '.') return null;
  const parts = p.split('/');
  if (parts.some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  if (/^[a-zA-Z]:/.test(p) || p.includes('\0')) return null;
  return p;
}

function inside(root, relPath) {
  const full = resolve(root, relPath);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(prefix)) return null;
  return full;
}

/** 读的时候先看上传目录，再看打包产物（上传的东西盖住自带的同名文件）。 */
function dataPath(relPath) {
  return inside(DATA_ROOT, relPath);
}

function distPath(relPath) {
  return inside(DIST_ROOT, relPath);
}

function statOf(relPath) {
  for (const candidate of [dataPath(relPath), distPath(relPath)]) {
    if (!candidate) continue;
    try {
      const s = statSync(candidate);
      return { full: candidate, stat: s };
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

function listDir(relPath) {
  const folders = new Set();
  const files = new Set();
  for (const root of [DATA_ROOT, DIST_ROOT]) {
    const full = inside(root, relPath);
    if (!full) continue;
    let entries;
    try {
      entries = readdirSync(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
      if (entry.isDirectory()) folders.add(entry.name);
      else files.add(entry.name);
    }
  }
  return { folders: [...folders].sort(), files: [...files].sort() };
}

function canWrite(relPath) {
  const lower = relPath.toLowerCase();
  return WRITABLE.some((prefix) => lower === prefix.replace(/\/$/, '') || lower.startsWith(prefix));
}

function readBody(req, limit = MAX_WRITE_BODY) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 处理无名杀的文件后端请求。
 *
 * @returns {Promise<boolean>} true = 这条请求归我处理（响应已经发出），false = 不是我的路径
 */
export async function handleNonameRequest(req, res, pathname, searchParams) {
  /* ---------------------------- 读（先 data 再 dist） ---------------------------- */

  if (pathname === '/checkFile' || pathname === '/checkDir') {
    const key = pathname === '/checkFile' ? 'fileName' : 'dir';
    const relPath = normalizePath(searchParams.get(key));
    if (!relPath) return ok(res, {}), true;
    const found = statOf(relPath);
    if (!found) return ok(res, {}), true;
    return ok(res, found.stat.isDirectory() ? 'directory' : 'file'), true;
  }

  if (pathname === '/readFile') {
    const relPath = normalizePath(searchParams.get('fileName'));
    if (!relPath) return fail(res, '路径不合法'), true;
    const found = statOf(relPath);
    if (!found || found.stat.isDirectory()) return fail(res, `读不到文件：${relPath}`), true;
    return ok(res, [...readFileSync(found.full)]), true;
  }

  if (pathname === '/readFileAsText') {
    const relPath = normalizePath(searchParams.get('fileName'));
    if (!relPath) return fail(res, '路径不合法'), true;
    const found = statOf(relPath);
    if (!found || found.stat.isDirectory()) return fail(res, `读不到文件：${relPath}`), true;
    return ok(res, readFileSync(found.full, 'utf8')), true;
  }

  if (pathname === '/getFileList') {
    const relPath = normalizePath(searchParams.get('dir'));
    if (!relPath) return fail(res, '路径不合法'), true;
    const found = statOf(relPath);
    if (found && !found.stat.isDirectory()) return fail(res, '路径不是文件夹'), true;
    return ok(res, listDir(relPath)), true;
  }

  /* ------------------------------- 写（只进 data） ------------------------------- */

  if (pathname === '/writeFile' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return fail(res, err.message), true;
    }
    const relPath = normalizePath(body && body.path);
    if (!relPath) return fail(res, '路径不合法'), true;
    if (!canWrite(relPath)) return fail(res, `不允许写入这个位置：${relPath}`), true;
    const full = dataPath(relPath);
    if (!full) return fail(res, '路径不合法'), true;
    try {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, Buffer.from(Array.isArray(body.data) ? body.data : []));
      return ok(res, true), true;
    } catch (err) {
      return fail(res, err.message), true;
    }
  }

  if (pathname === '/removeFile') {
    const relPath = normalizePath(searchParams.get('fileName'));
    if (!relPath) return fail(res, '路径不合法'), true;
    const full = dataPath(relPath);
    if (!full) return fail(res, '路径不合法'), true;
    if (!existsSync(full)) return fail(res, `文件不存在：${relPath}`), true;
    try {
      if (statSync(full).isDirectory()) return fail(res, '不能删除文件夹'), true;
      rmSync(full, { force: true });
      return ok(res, true), true;
    } catch (err) {
      return fail(res, err.message), true;
    }
  }

  if (pathname === '/removeDir') {
    const relPath = normalizePath(searchParams.get('dir'));
    if (!relPath) return fail(res, '路径不合法'), true;
    const full = dataPath(relPath);
    if (!full) return fail(res, '路径不合法'), true;
    try {
      const s = statSync(full);
      if (!s.isDirectory()) return fail(res, `${relPath} 不是文件夹`), true;
      rmSync(full, { recursive: true, force: true });
      return ok(res, true), true;
    } catch (err) {
      return fail(res, err.message), true;
    }
  }

  if (pathname === '/createDir') {
    const relPath = normalizePath(searchParams.get('dir'));
    if (!relPath) return fail(res, '路径不合法'), true;
    if (!canWrite(`${relPath}/`)) return fail(res, `不允许在这个位置建目录：${relPath}`), true;
    const full = dataPath(relPath);
    if (!full) return fail(res, '路径不合法'), true;
    try {
      mkdirSync(full, { recursive: true });
      return ok(res, true), true;
    } catch (err) {
      return fail(res, err.message), true;
    }
  }

  return false;
}

/**
 * 给静态文件兜底用：无名杀的根绝对路径在 `data/noname` 里有的话优先发它。
 * 返回绝对路径或 null。
 */
export function uploadedFile(relPath) {
  const full = dataPath(relPath);
  if (!full) return null;
  try {
    return statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

/**
 * 起无名杀自己的联机中继（见文件头 NONAME_RELAY_PORT 的说明）。
 *
 * 产物是 `pnpm -F @noname/server build` 出来的（跟 dist 一起由
 * `node tools/noname-update.mjs` 负责重建）。**没构建就没有联机** ——
 * 这时返回 null 并且只打一行提示，不拖垮整个服务端（网页端照样能玩单机）。
 *
 * @returns {Promise<{port: number, stop: () => Promise<void>} | null>}
 */
export async function startNonameRelay({ port = NONAME_RELAY_PORT, host = '127.0.0.1' } = {}) {
  const entry = resolve(ROOT, 'games/noname-web/packages/server/dist/index.js');
  if (!existsSync(entry)) {
    // console.log（不是 warn）：启动器的 stdio 是 ['ignore', log, log]，两种都进日志，
    // 但 log 里混着访问日志，用 log 更容易被 grep 到。
    console.log(
      '⚠️  无名杀的联机中继还没构建（games/noname-web/packages/server/dist 不存在），' +
        '这轮先不给联机。构建方法：cd games/noname-web && pnpm -F @noname/server build'
    );
    return null;
  }
  try {
    // 动态 import：中继是上游的包（自带 ws 依赖），只有真要开联机时才加载它。
    const { createServer } = await import(pathToFileURL(entry).href);
    const relay = createServer({ port, host });
    await relay.start();
    return {
      port,
      host,
      stop: () => relay.stop(),
    };
  } catch (err) {
    console.log(
      `⚠️  无名杀的联机中继起不来（${host}:${port} 被占？），这轮先不给联机：${err.message}`
    );
    return null;
  }
}