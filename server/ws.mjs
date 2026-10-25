/*
 * 手写的 WebSocket 服务端（RFC 6455 的必要子集）
 *
 * 为什么要自己写：Node 24 只有 WebSocket **客户端**（全局 WebSocket 是 undici 的），
 * 没有服务端。而本项目约定不引入任何第三方运行时依赖（见 docs/DECISIONS.md D6），
 * 所以这里按项目家族的老办法手写 —— Cannon Goblin 的 tests/browser/broker.mjs
 * 已经手写过一遍同样的东西，本文件是它的工程化版本。
 *
 * 支持：
 *   · 握手（Sec-WebSocket-Accept 计算、版本校验、握手期鉴权钩子）
 *   · 文本/二进制帧、分片续帧（0x0）、控制帧（ping / pong / close）
 *   · 客户端帧强制校验掩码、RSV 位强制为 0
 *   · 心跳：定期 ping，两个周期没收到任何数据就断开
 *   · 报文大小上限，防止一条连接把内存吃光
 *
 * 不支持（本项目用不到，刻意不做）：
 *   · 扩展协商（permessage-deflate 等）—— 所以 RSV 必须为 0
 *   · 服务端主动发起分片
 */

import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MAX_PAYLOAD = 1 << 20;      // 1 MiB，单帧上限
const HEARTBEAT_MS = 30_000;      // 心跳间隔
const HEARTBEAT_GRACE_MS = 65_000; // 超过这个时间没收到任何数据就判死

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** 一条 WebSocket 连接。业务侧只管 send / onMessage / onClose，不用碰字节。 */
export class WsConnection {
  constructor(socket, req, data) {
    this.id = randomUUID();
    this.socket = socket;
    this.req = req;
    /** 握手期鉴权的结果，业务侧往里挂东西（通常是 { user }）。 */
    this.data = data || {};
    this.closed = false;

    this._buf = Buffer.alloc(0);
    this._frag = null;          // { opcode, chunks } 分片累积
    this._lastSeen = Date.now();
    this._finished = false;
    this._onMessage = null;
    this._onClose = null;
    this._timer = null;

    socket.on('data', (chunk) => this._feed(chunk));
    socket.on('error', () => this._finish());
    socket.on('close', () => this._finish());

    this._timer = setInterval(() => this._beat(), HEARTBEAT_MS);
    // 别让心跳定时器拖住进程退出（测试里很重要）
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  /** 收到一帧完整消息时回调，参数是字符串（文本帧）。 */
  onMessage(fn) { this._onMessage = fn; return this; }

  /** 连接结束时回调，只调一次。 */
  onClose(fn) { this._onClose = fn; return this; }

  /** 发一条消息。传对象会自动 JSON 序列化。 */
  send(payload) {
    if (this.closed) return false;
    if (Buffer.isBuffer(payload)) return this._write(OP_BINARY, payload);
    return this._write(OP_TEXT, Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8'));
  }

  /** 发一条 JSON 消息，且只发一份文本帧。 */
  sendJSON(obj) { return this.send(obj); }

  /** 优雅关闭：发 close 帧再关 socket。 */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2, 'utf8');
    this._write(OP_CLOSE, body);
    this.closed = true;
    this._finish();
    try { this.socket.end(); } catch { /* 已经断了 */ }
  }

  /* ------------------------------------------------------------------ */

  _beat() {
    if (this.closed) return;
    if (Date.now() - this._lastSeen > HEARTBEAT_GRACE_MS) {
      this.close(1001, '心跳超时');
      return;
    }
    this._write(OP_PING, Buffer.alloc(0));
  }

  _feed(chunk) {
    if (this.closed) return;
    this._lastSeen = Date.now();
    this._buf = Buffer.concat([this._buf, chunk]);

    try {
      for (;;) {
        const frame = this._parse();
        if (!frame) return;
        this._handle(frame);
        if (this.closed) return;
      }
    } catch (err) {
      // 协议错误：按 RFC 回 1002 再断，别让一条坏连接影响别人
      this.close(1002, String(err && err.message || err).slice(0, 100));
    }
  }

  /** 从缓冲区里切出一帧；数据不够返回 null；协议错误抛异常。 */
  _parse() {
    const b = this._buf;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    if ((b[0] & 0x70) !== 0) throw new Error('RSV 位非零（本项目不协商扩展）');
    const opcode = b[0] & 0x0f;

    const masked = (b[1] & 0x80) !== 0;
    let length = b[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (b.length < offset + 2) return null;
      length = b.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (b.length < offset + 8) return null;
      const big = b.readBigUInt64BE(offset);
      offset += 8;
      if (big > BigInt(MAX_PAYLOAD)) throw new Error('报文超过上限');
      length = Number(big);
    }
    if (length > MAX_PAYLOAD) throw new Error('报文超过上限');

    // 控制帧必须 FIN=1 且载荷 <= 125
    if (opcode >= 0x8 && (!fin || length > 125)) throw new Error('控制帧非法');

    // 客户端发来的帧必须加掩码（RFC 6455 §5.1）
    if (!masked) throw new Error('客户端帧必须加掩码');

    if (b.length < offset + 4) return null;
    const mask = b.subarray(offset, offset + 4);
    offset += 4;

    if (b.length < offset + length) return null;

    const payload = Buffer.from(b.subarray(offset, offset + length));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    this._buf = b.subarray(offset + length);
    return { fin, opcode, payload };
  }

  _handle({ fin, opcode, payload }) {
    if (opcode === OP_CLOSE) {
      this.closed = true;
      this._finish();
      try { this.socket.end(); } catch { /* 已经断了 */ }
      return;
    }
    if (opcode === OP_PING) { this._write(OP_PONG, payload); return; }
    if (opcode === OP_PONG) return;

    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this._frag) throw new Error('上一个分片消息还没结束');
      if (fin) { this._deliver(opcode, payload); return; }
      this._frag = { opcode, chunks: [payload] };
      return;
    }

    if (opcode === OP_CONT) {
      if (!this._frag) throw new Error('没有可续的分片消息');
      this._frag.chunks.push(payload);
      if (!fin) return;
      const frag = this._frag;
      this._frag = null;
      this._deliver(frag.opcode, Buffer.concat(frag.chunks));
      return;
    }

    throw new Error('未知操作码 0x' + opcode.toString(16));
  }

  _deliver(opcode, payload) {
    /*
     * 文本帧按字符串交给业务侧；二进制帧原样交给业务侧（第二个参数 isBinary=true）。
     *
     * 平台主 WS 只收发 JSON，二进制帧仍然按原来的方式当 UTF-8 解读，行为不变；
     * 大富翁中转要用二进制搬地图分块（64KB 一块），不能经过 UTF-8 解码。
     */
    if (opcode === OP_BINARY) {
      if (payload.length === 0) return;
      try { this._onMessage?.(payload, true); } catch { /* 业务侧自己抛的错不该拖垮连接 */ }
      return;
    }
    const text = payload.toString('utf8');
    if (text.length === 0) return;
    try { this._onMessage?.(text, false); } catch { /* 业务侧自己抛的错不该拖垮连接 */ }
  }

  _write(opcode, payload) {
    if (this._finished) return false;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;   // FIN=1，服务端帧不加掩码
    try {
      this.socket.write(Buffer.concat([header, payload]));
      return true;
    } catch {
      this._finish();
      return false;
    }
  }

  _finish() {
    if (this._finished) return;
    this._finished = true;
    this.closed = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    try { this._onClose?.(this); } catch { /* 业务侧清理失败不该冒泡 */ }
  }
}

/**
 * 把一个 WebSocket upgrade **原样**转给本地另一个服务（裸 TCP，双向搬字节）。
 *
 * 为什么不解析：无名杀的联机中继用的是上游自己的协议（JSON 数组、它自己定的字段）。
 * 我们只负责让公网玩家能从 7891 连到它 —— 一旦开始解析帧，就得跟着上游改协议，
 * 连 `Sec-WebSocket-Key` 校验也变成我们的事了。搬字节最省事，也最不容易坏。
 */
function pipeUpgrade(req, socket, {
  port, host = '127.0.0.1', stripPrefix = '', extraHeaders = {}, path = '', headers = {}, onPipe = null,
}) {
  const upstream = net.connect({ host, port });
  let closed = false;

  const destroy = () => {
    if (closed) return;
    closed = true;
    try { upstream.destroy(); } catch { /* 已经断了 */ }
    try { if (!socket.destroyed) socket.destroy(); } catch { /* 已经断了 */ }
  };

  const fail = (status = '502 Bad Gateway') => {
    try {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    } catch { /* 已经断了 */ }
    destroy();
  };

  let forget = null;
  if (typeof onPipe === 'function') {
    try { forget = onPipe(destroy); } catch { fail('503 Service Unavailable'); return; }
  }

  upstream.on('error', () => fail());
  socket.on('error', () => { try { upstream.destroy(); } catch { /* 已经断了 */ } });

  upstream.on('connect', () => {
    // 把客户端的握手请求**逐字**重放给上游（含 Sec-WebSocket-Key / Origin / Cookie）。
    // 默认只切掉公开路径前缀（`/mahjong`），其余一个字节都不改。
    // path 是显式改写（AI 小镇要把 `/?session=`/身份参数替换掉）；
    // headers 是**覆盖**（同名不重复，Host 必须改成本机端口，否则上游会按 Host 判本机）。
    const target = path || (stripPrefix && req.url.startsWith(stripPrefix)
      ? (req.url.slice(stripPrefix.length) || '/')
      : req.url);
    const overrides = new Map();
    for (const [key, value] of Object.entries(headers || {})) overrides.set(key.toLowerCase(), String(value));
    let head = `${req.method} ${target} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      if (overrides.has(key.toLowerCase())) continue;
      head += `${key}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    for (const [key, value] of overrides) head += `${key}: ${value}\r\n`;
    for (const [key, value] of Object.entries(extraHeaders || {})) {
      head += `${key}: ${value}\r\n`;
    }
    upstream.write(`${head}\r\n`);
    socket.setNoDelay(true);
    upstream.setNoDelay(true);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  // 关一头就得关另一头，否则半死的连接会一直挂着
  upstream.on('close', () => { if (!socket.destroyed) socket.destroy(); });
  socket.on('close', () => {
    upstream.destroy();
    if (forget) { try { forget(); } catch { /* 已清 */ } }
  });
  return { destroy };
}

/**
 * 把 WebSocket 挂到一个 http.Server 上。
 *
 * @param {import('node:http').Server} server
 * @param {object} options
 * @param {string} [options.path='/ws']        接受的路径，其它路径的 upgrade 直接断
 * @param {(req) => {ok: boolean, data?: any, code?: number}} [options.verify]
 *        握手期鉴权。返回 ok:false 就不升级（比升级后再踢更省事，也更难绕）。
 * @param {(conn: WsConnection) => void} [options.onConnection]
 * @param {{path: string, port: number, host?: string}} [options.proxy]
 *        **不解析、只搬字节**地把这条路径的 upgrade 转给本地另一个 WS 服务。
 *        用途：无名杀自己的联机中继（见 server/noname.mjs）。这样隧道只用一个端口，
 *        而中继协议是对方的东西 —— 我们没资格改它，也不该懂它。
 * @param {Array<{prefix: string, port: number, host?: string, verify?: Function}>} [options.proxies]
 *        **按前缀**转发给本地另一个 WS 服务（莲花广麻的 Python 后端 `/mahjong/ws/*`）。
 *        和 proxy 的区别：那边要 stripPrefix，这里只切掉公开前缀，其余原样透传。
 * @param {Array<{path: string, verify?: Function, onConnection?: Function}>} [options.extra]
 *        同一个 HTTP server 上的**额外的** WS 端点（大富翁中转 `/monopoly-relay`）。
 *        每条端点可以有自己的鉴权和 onConnection；共用一个连接集合，停机时一起关。
 */
export function attachWebSocket(server, { path = '/ws', verify, onConnection, proxy, proxies = [], extra = [] } = {}) {
  const connections = new Set();
  const pipes = new Set();
  const routes = [
    { path, verify, onConnection },
    ...(Array.isArray(extra) ? extra : []),
  ];
  const prefixProxies = Array.isArray(proxies) ? proxies.filter((p) => p && p.prefix) : [];

  const reject = (socket, code = 401, reason = 'Unauthorized') => {
    try {
      socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
    } catch { /* 已经断了 */ }
    socket.destroy();
  };

  server.on('upgrade', (req, socket) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      socket.destroy();
      return;
    }
    if (proxy && url.pathname === proxy.path) {
      pipeUpgrade(req, socket, proxy);
      return;
    }
    // 前缀转发（莲花广麻 `/mahjong/ws/room/...` → Python 的 `/ws/room/...`；
    // AI 小镇 `/ai-town/ws?room=&sid=` → host 的随机端口 `/?session=…`）。
    // 升级前也要过一遍平台登录校验：没登录的人不该能连到游戏后端。
    for (const route of prefixProxies) {
      if (!url.pathname.startsWith(route.prefix)) continue;
      let verdict = { ok: true };
      if (route.verify) {
        try {
          verdict = route.verify(req) || { ok: false };
        } catch {
          verdict = { ok: false };
        }
        if (!verdict.ok) {
          reject(socket, verdict.code || 401, verdict.reason || 'Unauthorized');
          return;
        }
      }
      // target 是这个路由的"现场查表"钩子：AI 小镇的端口每次 open 都会变。
      // 它是异步的（可能要重新 open 一次），所以这里 async 包一层。
      const finish = (target) => {
        if (!target || !target.port) {
          reject(socket, 502, 'Bad Gateway');
          return;
        }
        pipeUpgrade(req, socket, {
          ...route,
          ...target,
          stripPrefix: target.path ? '' : (route.stripPrefix || route.prefix),
          onPipe: (destroy) => {
            const record = { destroy };
            pipes.add(record);
            let inner = null;
            if (typeof target.onPipe === 'function') {
              try { inner = target.onPipe(destroy); } catch { /* 忽略 */ }
            }
            return () => {
              pipes.delete(record);
              if (inner) { try { inner(); } catch { /* 已清 */ } }
            };
          },
        });
      };
      if (typeof route.target === 'function') {
        Promise.resolve()
          .then(() => route.target(req, verdict))
          .then(finish)
          .catch((err) => {
            console.error(`[ws 代理] ${route.prefix} 失败：${err && err.message ? err.message : err}`);
            reject(socket, err?.code || 502, err?.code === 410 ? 'Gone' : 'Bad Gateway');
          });
        return;
      }
      finish(route);
      return;
    }
    const route = routes.find((r) => r && r.path === url.pathname);
    if (!route) {
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers['sec-websocket-version'] !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    let verdict = { ok: true };
    if (route.verify) {
      try {
        verdict = route.verify(req) || { ok: false };
      } catch {
        verdict = { ok: false };
      }
    }
    if (!verdict.ok) {
      reject(socket, verdict.code || 401, verdict.reason || 'Unauthorized');
      return;
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept,
      '', ''
    ].join('\r\n'));
    socket.setNoDelay(true);
    socket.setTimeout(0);

    const conn = new WsConnection(socket, req, verdict.data);
    connections.add(conn);
    conn.onClose(() => connections.delete(conn));

    try {
      route.onConnection?.(conn);
    } catch {
      conn.close(1011, '服务端初始化失败');
    }
  });

  return {
    get size() { return connections.size; },
    connections,
    /** 关掉所有连接（停机时用）。 */
    closeAll(code = 1001, reason = '服务端关闭') {
      for (const conn of [...connections]) conn.close(code, reason);
      // 裸管道也必须收掉，否则 server.close() 会一直等它们（无名杀/麻将遗留的洞）。
      for (const pipe of [...pipes]) {
        try { pipe.destroy(); } catch { /* 已经断了 */ }
      }
      pipes.clear();
    }
  };
}