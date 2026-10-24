/*
 * 极简 WebSocket **客户端** —— 只给测试用。
 *
 * 为什么不用 Node 内置的全局 WebSocket（undici）：它不支持自定义请求头，
 * 而本项目的鉴权完全依赖握手时自动携带的 HttpOnly cookie
 * （见 docs/ARCHITECTURE.md「认证」）。所以这里用 node:http 手工发升级请求，
 * 顺便也成了对手写服务端的一次**独立**验证 —— 客户端加掩码、服务端不加，
 * 两边各自实现，谁写错了另一方就会炸。
 */

import { randomBytes } from 'node:crypto';
import { request } from 'node:http';

const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** 发一个客户端帧：**必须加掩码**（RFC 6455 §5.1）。 */
function encodeFrame(opcode, payload) {
  const mask = randomBytes(4);
  const length = payload.length;

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;

  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];

  return Buffer.concat([header, mask, masked]);
}

class TestClient {
  constructor(socket, head) {
    this.socket = socket;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.received = [];
    this.waiters = [];
    this.closed = false;
    this.closeCode = null;

    if (this.buf.length) this._drain();
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this._drain();
    });
    socket.on('close', () => this._markClosed());
    socket.on('error', () => this._markClosed());
  }

  _markClosed() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('连接已关闭'));
  }

  _drain() {
    for (;;) {
      const frame = this._parse();
      if (!frame) return;

      if (frame.opcode === OP_PING) { this._write(OP_PONG, frame.payload); continue; }
      if (frame.opcode === OP_PONG) continue;
      if (frame.opcode === OP_CLOSE) {
        this.closeCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        this._markClosed();
        return;
      }
      if (frame.opcode !== OP_TEXT) continue;

      const text = frame.payload.toString('utf8');
      let msg;
      try { msg = JSON.parse(text); } catch { msg = { t: '<非 JSON>', raw: text }; }

      // **等待即消费**：有等待者就直接给它，不留在 received 里。
      // 否则第二次 waitFor 同类型消息会拿到上一条旧的，测试就会假失败。
      // 等待者可以按类型等，也可以传一个判断函数等（见 waitFor）。
      const index = this.waiters.findIndex((w) => w.match(msg));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter.resolve(msg);
      } else {
        this.received.push(msg);
      }
    }
  }

  _parse() {
    const b = this.buf;
    if (b.length < 2) return null;

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
      length = Number(b.readBigUInt64BE(offset));
      offset += 8;
    }

    let mask = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      mask = b.subarray(offset, offset + 4);
      offset += 4;
    }
    if (b.length < offset + length) return null;

    const payload = Buffer.from(b.subarray(offset, offset + length));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    this.buf = b.subarray(offset + length);
    return { opcode, payload };
  }

  _write(opcode, payload) {
    if (this.closed) return false;
    try { this.socket.write(encodeFrame(opcode, payload)); return true; } catch { return false; }
  }

  /** 发一条 JSON 消息（也可以直接传字符串，用来测"非法 JSON"）。 */
  send(message) {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    return this._write(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  /** 发一个**不加掩码**的帧 —— 服务端应该用 1002 关掉我们。 */
  sendUnmasked(message) {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    this.socket.write(Buffer.concat([Buffer.from([0x80 | OP_TEXT, payload.length]), payload]));
  }

  /**
   * 等一条消息。已经收到过就取出来返回（等待即消费，见上面的注释）。
   *
   * ⚠️ 第一个参数可以传**类型字符串**，也可以传**判断函数**：
   *   await c.waitFor('room.state');
   *   await c.waitFor((m) => m.t === 'room.state' && m.members.length === 1);
   * 判断函数这个口子以前是不支持的（只比 `m.t === type`），
   * 传函数进去会永远等不到、还看不出来为什么 —— 已修。
   */
  waitFor(type, timeoutMs = 3000) {
    const match = typeof type === 'function'
      ? (m) => { try { return Boolean(type(m)); } catch { return false; } }
      : (m) => m.t === type;
    const label = typeof type === 'function' ? String(type) : type;

    const found = this.received.findIndex(match);
    if (found >= 0) return Promise.resolve(this.received.splice(found, 1)[0]);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.reject === reject);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`等 ${label} 超时；已收到 ${JSON.stringify(this.received.map((m) => m.t))}`));
      }, timeoutMs);
      this.waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); }, reject });
    });
  }

  /** 等连接被关闭，返回 close 码。 */
  waitClose(timeoutMs = 3000) {
    if (this.closed) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等连接关闭超时')), timeoutMs);
      this.socket.once('close', () => { clearTimeout(timer); resolve(this.closeCode); });
    });
  }

  /** 清掉已收到的消息记录，用来断言"接下来不该有新消息"。 */
  clear() { this.received.length = 0; }

  close() {
    if (this.closed) return;
    // 一定要带 1000（正常关闭）：裸两字节 0x0000 是**非法状态码**，
    // 严格的实现对它直接抛错 —— 无名杀的中继（ws 包）就因为收过我们这种帧而崩过。
    const body = Buffer.alloc(2);
    body.writeUInt16BE(1000, 0);
    this._write(OP_CLOSE, body);
    this._markClosed();
    try { this.socket.end(); } catch { /* 已经断了 */ }
  }
}

/**
 * 连一个 WebSocket。
 * @param {{port:number, host?:string, path?:string, cookie?:string}} options
 */
export function wsConnect({ port, host = '127.0.0.1', path = '/ws', cookie } = {}) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const req = request({
      host,
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });

    req.on('upgrade', (res, socket, head) => {
      resolve(new TestClient(socket, head));
    });
    req.on('response', (res) => {
      res.resume();
      const err = new Error(`握手被拒：HTTP ${res.statusCode}`);
      err.statusCode = res.statusCode;
      reject(err);
    });
    req.on('error', reject);
    req.end();
  });
}

export { TestClient };