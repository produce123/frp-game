/*
 * 服务端加固用例（2026-10-26 审计后补的）。
 *
 * 这些用例钉的是"公网兜底"这一类行为，**不是玩法**：
 *   1. 畸形 URL 不能把进程打挂。以前 `GET /%` 会抛 URIError 到 async handler 外面，
 *      Node 24 把它当进程级异常 → 整站退出。现在必须回 400 且之后照常服务。
 *   2. 登录 / 注册有频率上限（每来源 IP 每分钟 20 次），但**不能误伤**正常登录。
 *   3. 会话有 30 天空闲有效期；`pruneSessions()` 只删过期的，不碰在用的。
 *   4. WebSocket 每条连接收得太密要被断开（1008），不是静默丢消息。
 *   5. 同一账号最多 8 条连接，第 9 条踢掉最早那条（不是踢新的）。
 *   6. `ping` 的 `pong` 只回发起的那条连接（多标签页不会串）。
 *   7. 大富翁中转的 `owners` 不再只增不减。
 *
 * 全部用临时数据库 + 随机端口，不碰 127.0.0.1:7891 上正在跑的服务。
 */

import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { startServer } from '../server/server.mjs';
import { createMonopolyRelay } from '../server/monopoly/relay.mjs';
import { wsConnect } from './ws-client.mjs';

let app = null;
let tmpDir = '';

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'frp-game-sec-'));
  app = await startServer({ port: 0, dbPath: join(tmpDir, 'sec.db') });
});

after(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/** 发一个 HTTP 请求，返回 { status, data, headers }。 */
function call(path, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = request({
      host: '127.0.0.1',
      port: app.port,
      path,
      method,
      timeout: 10_000,
      headers: {
        connection: 'close',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let data = text;
        try { data = JSON.parse(text); } catch { /* 不是 JSON 就留原文 */ }
        resolve({ status: res.statusCode, data, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

/** 注册一个账号，返回 cookie 与公开身份。 */
async function register(name, headers = {}) {
  const res = await call('/api/register', { method: 'POST', body: { name, password: 'pw123456' }, headers });
  assert.equal(res.status, 200, `注册失败：${JSON.stringify(res.data)}`);
  return { cookie: String(res.headers['set-cookie']).split(';')[0], me: res.data.me };
}

/** 用 cookie 连上平台 WebSocket，并等 ready。 */
async function connect(cookie) {
  const client = await wsConnect({ port: app.port, cookie });
  await client.waitFor('ready');
  await client.waitFor('friends');
  return client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================ 地址解析 ============================ */

describe('地址解析：畸形 URL 不许打挂进程', () => {
  it('GET /% 回 400，之后服务照常可用', async () => {
    const bad = await call('/%');
    assert.equal(bad.status, 400, '畸形百分号编码要回 400');
    // 关键：上一条如果抛到 handler 外面，这个进程已经没了，这条请求根本发不出去。
    const alive = await call('/api/me');
    assert.equal(alive.status, 401, '畸形 URL 之后服务必须还活着');
  });

  it('别的畸形形状也不会崩（400 或 404 都算正常拒绝）', async () => {
    // `/%00` 解码出来是个合法字符串（NUL），路由找不到就是 404 —— 只要不是"进程没了"。
    for (const path of ['/%zz', '/%E0%A4%A', '/a/%', '/%00']) {
      const res = await call(path);
      assert.ok(res.status === 400 || res.status === 404, `${path} 应该是 400/404，实际 ${res.status}`);
    }
    assert.equal((await call('/api/me')).status, 401);
  });

  it('正常地址不受影响', async () => {
    const home = await call('/');
    assert.equal(home.status, 200);
    assert.match(String(home.data), /网页游戏平台/);
  });
});

/* ======================== 登录 / 注册频率上限 ======================== */

describe('账号接口的频率上限', () => {
  it('正常登录不会被误伤', async () => {
    const { cookie } = await register('频');
    const ip = { 'x-forwarded-for': '10.9.9.1' };
    for (let i = 0; i < 3; i++) {
      const res = await call('/api/login', { method: 'POST', body: { id: 'NOTEXIST', password: 'x' }, headers: ip });
      assert.equal(res.status, 401, '输错密码是 401');
    }
    const ok = await call('/api/me', { headers: { cookie } });
    assert.equal(ok.status, 200);
  });

  it('同一个来源 IP 一分钟内第 21 次登录回 429（带 retry-after）', async () => {
    const ip = { 'x-forwarded-for': '10.9.9.2' };
    for (let i = 0; i < 20; i++) {
      const res = await call('/api/login', { method: 'POST', body: { id: 'NOTEXIST', password: 'x' }, headers: ip });
      assert.equal(res.status, 401, `第 ${i + 1} 次不该被拦`);
    }
    const blocked = await call('/api/login', { method: 'POST', body: { id: 'NOTEXIST', password: 'x' }, headers: ip });
    assert.equal(blocked.status, 429, '第 21 次要被拦');
    assert.ok(Number(blocked.headers['retry-after']) > 0, '要告诉客户端多久后再试');
    assert.match(String(blocked.data.message), /频繁/);

    // 只拦登录：别的接口、别的来源 IP 都不受影响
    assert.equal((await call('/api/me', { headers: ip })).status, 401);
    const other = await call('/api/login', { method: 'POST', body: { id: 'NOTEXIST', password: 'x' }, headers: { 'x-forwarded-for': '10.9.9.3' } });
    assert.equal(other.status, 401, '换一个来源 IP 不该被上一条的记录影响');
  });

  it('注册也一样有限制', async () => {
    const ip = { 'x-forwarded-for': '10.9.9.4' };
    for (let i = 0; i < 20; i++) {
      const res = await call('/api/register', { method: 'POST', body: { name: '名字', password: '123' }, headers: ip });
      assert.equal(res.status, 400, '密码太短是 400');
    }
    const blocked = await call('/api/register', { method: 'POST', body: { name: '名字', password: '123456' }, headers: ip });
    assert.equal(blocked.status, 429);
  });
});

/* ============================ 会话有效期 ============================ */

describe('会话：30 天空闲有效期', () => {
  it('31 天没动静的会话失效并删行；在用的不受影响', async () => {
    const { me } = await register('会');
    const store = app.store;

    store.createSession({ sid: 'stale-sid', userId: me.id });
    store.db.prepare('UPDATE sessions SET seen_at = ? WHERE sid = ?')
      .run(Date.now() - 31 * 24 * 3600 * 1000, 'stale-sid');
    assert.equal(store.findSession('stale-sid'), null, '过期会话必须当没登录');
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get('stale-sid').n,
      0,
      '过期的那一行要删掉，别留在表里'
    );

    store.createSession({ sid: 'fresh-sid', userId: me.id });
    assert.ok(store.findSession('fresh-sid'), '新会话有效');
    store.pruneSessions();
    assert.ok(store.findSession('fresh-sid'), 'pruneSessions 不许误删在用的会话');
  });

  it('只把 seen_at 每分钟写一次（别按请求写盘）', async () => {
    const { me } = await register('写');
    const store = app.store;
    store.createSession({ sid: 'throttle-sid', userId: me.id });
    const beforeAt = store.db.prepare('SELECT seen_at FROM sessions WHERE sid = ?').get('throttle-sid').seen_at;
    // 连着查三次：一分钟内不许再写库
    for (let i = 0; i < 3; i++) assert.ok(store.findSession('throttle-sid'));
    const afterAt = store.db.prepare('SELECT seen_at FROM sessions WHERE sid = ?').get('throttle-sid').seen_at;
    assert.equal(afterAt, beforeAt, '一分钟内不该重复写 seen_at');
  });
});

/* ========================== WebSocket 限速 ========================== */

describe('WebSocket：收得太密要断开', () => {
  it('一条连接猛发消息会被 1008 关掉（不是静默丢）', async () => {
    const { cookie } = await register('猛');
    const client = await connect(cookie);
    try {
      for (let i = 0; i < 400; i++) client.send({ t: 'ping', ts: i });
      const code = await client.waitClose(5000);
      assert.equal(code, 1008, '应该是 1008（策略违规）断开');
    } finally {
      client.close();
    }
    // 断开只影响那一条连接：这个账号还能重新连上
    const again = await connect(cookie);
    try {
      again.send({ t: 'ping', ts: Date.now() });
      const pong = await again.waitFor('pong');
      assert.ok(pong, '被限速断开之后还能重连');
    } finally {
      again.close();
    }
  });

  it('正常频率下的 ping 不会被断（10 条很轻松）', async () => {
    const { cookie } = await register('常');
    const client = await connect(cookie);
    try {
      for (let i = 0; i < 10; i++) {
        client.send({ t: 'ping', ts: i });
        await client.waitFor('pong');
      }
    } finally {
      client.close();
    }
  });
});

describe('WebSocket：同一账号的连接数上限', () => {
  it('第 9 条连接踢掉最早那条，新的照常用', async () => {
    const { cookie } = await register('多');
    const clients = [];
    try {
      for (let i = 0; i < 9; i++) clients.push(await connect(cookie));
      const code = await clients[0].waitClose(3000);
      assert.equal(code, 1008, '最早那条要被踢掉');
      clients[8].send({ t: 'ping', ts: 1 });
      assert.ok(await clients[8].waitFor('pong'), '最新那条必须还能用');
    } finally {
      for (const c of clients) c.close();
    }
  });
});

describe('WebSocket：pong 只回发起连接', () => {
  it('同一账号的另一条连接收不到这条 pong', async () => {
    const { cookie } = await register('隐');
    const a = await connect(cookie);
    const b = await connect(cookie);
    try {
      a.clear();
      b.clear();
      a.send({ t: 'ping', ts: 12345 });
      const pong = await a.waitFor('pong');
      assert.equal(pong.ts, 12345);
      // b 不该收到 pong（多标签页串台会让"半死连接"被误判成还活着）
      await sleep(400);
      assert.deepEqual(b.received.filter((m) => m.t === 'pong'), [], '另一条连接不该收到 pong');
    } finally {
      a.close();
      b.close();
    }
  });
});

/* ==================== 大富翁中转：owners 不许只增不减 ==================== */

describe('大富翁中转的内存边界', () => {
  it('反复连/断之后 owners 有上限', () => {
    const relay = createMonopolyRelay();
    /** 假连接：只实现中转用到的几个方法。 */
    function fakeConn() {
      const handlers = {};
      return {
        id: Math.random().toString(36).slice(2),
        data: { user: { id: 'U1' } },
        send() { return true; },
        close() { /* 不用真的关 */ },
        onMessage(fn) { handlers.message = fn; },
        onClose(fn) { handlers.close = fn; },
        hello() { handlers.message(JSON.stringify({ type: 'hello' }), false); },
        gone() { handlers.close?.(); },
      };
    }

    for (let i = 0; i < 600; i++) {
      const conn = fakeConn();
      relay.onConnection(conn);
      conn.hello();
      conn.gone();      // 断线：peers 删掉，但 owners 以前会一直留着
    }
    assert.ok(
      relay._owners.size <= 256,
      `owners 应该有上限，实际 ${relay._owners.size}`
    );
    assert.ok(relay._peers.size === 0, '都断了，peers 应该是空的');
  });

  it('原主人还能用旧 peerId 认领（重连不换 id）', () => {
    const relay = createMonopolyRelay();
    const handlers = {};
    const mk = () => ({
      id: 'c' + Math.random(),
      data: { user: { id: 'U1' } },
      send(msg) { this.last = msg; return true; },
      close() {},
      onMessage(fn) { handlers.message = fn; },
      onClose(fn) { handlers.close = fn; },
    });
    const a = mk();
    relay.onConnection(a);
    handlers.message(JSON.stringify({ type: 'hello' }), false);
    const id = a.last.id;
    handlers.close?.();

    const b = mk();
    relay.onConnection(b);
    handlers.message(JSON.stringify({ type: 'hello', resume: id }), false);
    assert.equal(b.last.id, id, '房主重连要拿回同一个 peerId');
  });
});