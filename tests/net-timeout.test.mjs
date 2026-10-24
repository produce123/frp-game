/*
 * 建连超时（shared/net/net.js）的确定性回归线。
 *
 *   node --test tests/net-timeout.test.mjs      （也在 npm test 里）
 *
 * 【为什么要有这条】
 * 公网实测过一件事：新建 WebSocket 有约 12% 会**卡死 60 秒**
 * （66 次新建失败 8 次；本机直连 127.0.0.1:7891 九次零失败）。原始时间线：
 *
 *   +1965ms  webSocketCreated
 *   +2481ms  握手请求真的发出
 *   （60 秒毫无响应）
 *   +62450ms frame-error: Connection closed before receiving a handshake response
 *   +62954ms 页面自动重连
 *   +63998ms 101 Switching Protocols（成功）
 *
 * 卡的是「浏览器 → Cloudflare → 隧道节点」那一段（升级请求根本进不了
 * data/server.log），我们修不了。能修的是：**别让用户干等那一分钟**。
 *
 * 【这条用例的形状】
 * 起一个只收 TCP、收到 HTTP upgrade 之后**一个字都不回**的极简 node:http 服务器
 * （随机端口），把 GameNet 指过去。两个断言：
 *   · 对照组：把超时设成 60 秒（= 浏览器自己那套）→ 3 秒后它**还挂在半空**，
 *     服务器只收到 1 个 upgrade。这就是用户看到的症状。
 *   · 实验组：把超时设成 0.7 秒 → 到点就主动放弃（真的调了 socket.close()），
 *     并**重新发起连接**（服务器收到第 2 个 upgrade）。用现成的退避重连，不干等。
 *
 * ⚠️ 全程不碰 127.0.0.1:7891（本机正在跑的服务）：服务器一律 listen(0)，随机端口。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const NET_SRC = readFileSync(new URL('../shared/net/net.js', import.meta.url), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 「永远不回应升级请求」的服务器。
 *
 * 收 upgrade 事件之后**什么都不做**：不写 101、不回任何字节、也不关 socket。
 * 这就是公网那次卡死的形状 —— TCP 连上了，HTTP 响应永远不来。
 */
async function silentUpgradeServer() {
  const upgrades = [];
  /** 服务器往这条连接上写过的字节（应该永远是 0 —— 这是"沉默"的结构性证据） */
  const writes = [];
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('upgrade', (req, socket) => {
    // ⚠️ 故意什么都不发。顺手把 write 记下来，好断言"真的一字未回"。
    const realWrite = socket.write.bind(socket);
    socket.write = (...args) => {
      writes.push(args[0]);
      return realWrite(...args);
    };
    upgrades.push({ url: req.url, at: Date.now() });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    port: server.address().port,
    upgrades,
    writes,
    /** 收尾：必须把连接全掐掉，否则 node:test 会因为句柄没关而不退出 */
    async close() {
      for (const s of sockets) s.destroy();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

/** 记录 close() 有没有被调用过的 WebSocket —— 证明我们真的主动放弃了那条连接。 */
class TrackedWebSocket extends WebSocket {
  static instances = [];
  constructor(url) {
    super(url);
    this.closeCalled = false;
    TrackedWebSocket.instances.push(this);
  }
  close(code, reason) {
    this.closeCalled = true;
    return super.close(code, reason);
  }
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * 一个"真的会握手、能收发文本帧"的极简 WebSocket 服务端。
 *
 * 为什么要自己写这一小段：心跳（`{t:'ping'}` → `{t:'pong'}`）只能对着一个会回话的
 * 对端才测得出来，而"沉默服务器"那条路（上面那个）永远不回任何东西。
 * 这里只要够用就行：握手 + 解析客户端帧（带掩码）+ 发不带掩码的文本帧。
 */
async function talkingWsServer({ skipFirstUpgrade = false, answerPings = true } = {}) {
  const upgrades = [];
  const sockets = new Set();
  const received = [];
  /** 用例中途可以把它翻成 false（模拟"对端不理我们了"，验心跳判死） */
  const state = { answerPings: answerPings };

  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  server.on('upgrade', (req, socket) => {
    upgrades.push({ url: req.url, at: Date.now() });
    // 竞速用例要的形状：**第一条升级请求被吞掉**，第二条才通
    if (skipFirstUpgrade && upgrades.length === 1) return;

    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const st = { buf: Buffer.alloc(0) };
    socket.on('data', (chunk) => {
      st.buf = Buffer.concat([st.buf, chunk]);
      for (;;) {
        const frame = readFrame(st);
        if (!frame) break;
        if (frame.opcode === 0x8) { socket.end(); return; }
        if (frame.opcode !== 0x1) continue;
        let msg;
        try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
        received.push(msg);
        if (state.answerPings && msg.t === 'ping') writeText(socket, { t: 'pong', ts: msg.ts });
      }
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    port: server.address().port,
    upgrades,
    received,
    state,
    async close() {
      for (const s of sockets) s.destroy();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
    /** 用例中途**掐断所有连接**：模拟掉线 / 服务器重启（客户端那边会走到 ws.onclose）。 */
    killAll() {
      for (const s of sockets) s.destroy();
    },
  };
}

/** 从缓冲区里读一个客户端帧（带掩码）；数据不够返回 null。 */
function readFrame(st) {
  const buf = st.buf;
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) === 0x80;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    len = Number(buf.readBigUInt64BE(off));
    off += 8;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  const mask = masked ? buf.subarray(off, off + 4) : null;
  off += maskLen;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  st.buf = buf.subarray(off + len);
  return { opcode, payload };
}

/** 发一个不带掩码的文本帧（服务端 → 客户端）。 */
function writeText(socket, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = body.length < 126
    ? Buffer.from([0x81, body.length])
    : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(body.length); return b; })()]);
  socket.write(Buffer.concat([head, body]));
}

/**
 * 把 shared/net/net.js 加载进一个隔离的 vm 上下文（不污染本进程的 globalThis），
 * 并把它指向 `127.0.0.1:<port>`。
 */
function loadGameNet(port) {
  const sandbox = {
    WebSocket: TrackedWebSocket,
    location: { protocol: 'http:', host: `127.0.0.1:${port}` },
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(NET_SRC, sandbox, { filename: 'shared/net/net.js' });
  return sandbox.GameNet;
}

/** 等一个条件成立；超时就返回 false（不抛 —— 由调用方断言）。 */
async function until(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(25);
  }
  return fn();
}

test('对照组：不做建连超时，就正是"挂在半空"的样子（浏览器那套 = 60 秒）', async () => {
  const srv = await silentUpgradeServer();
  const net = loadGameNet(srv.port);
  TrackedWebSocket.instances = [];

  const seen = [];
  net.on('connecting', () => seen.push('connecting'));
  net.on('open', () => seen.push('open'));
  net.on('timeout', () => seen.push('timeout'));

  // 60 秒 ≈ 浏览器自己的握手超时。这里只等 3 秒，够看出"它还挂着"。
  net.connectTimeoutMs = 60_000;
  // 这一组要的是"浏览器原生那套"的形状，所以把**我们自己加的**建连竞速关掉：
  // 竞速会在 2.5 秒时并行再开一条，那正是下面「竞速组」要验的东西。
  net.raceDelayMs = 0;

  try {
    const t0 = Date.now();
    net.connect();
    await sleep(3000);

    assert.deepEqual(seen, ['connecting'], `3 秒内不该有别的动静，实际：${JSON.stringify(seen)}`);
    assert.equal(net.connected, false, '不该连上');
    assert.equal(net.connecting, true, '应该还挂在"正在连接"上（这就是用户看到的症状）');
    assert.equal(srv.upgrades.length, 1, `只该发出过 1 次升级请求，实际 ${srv.upgrades.length} 次`);
    assert.equal(
      TrackedWebSocket.instances[0].closeCalled,
      false,
      '这一段里没人会去关它 —— 只能干等'
    );
    console.log(
      `  [对照] 安静链路 + 60 秒超时：${Date.now() - t0}ms 后仍 connecting=${net.connecting}，` +
        `服务器收到 ${srv.upgrades.length} 次 upgrade，服务器写出的字节数 = ${srv.writes.length}`
    );
  } finally {
    net.close();
    await srv.close();
  }
});

test('实验组：升级请求被吞掉时，到点就放弃并退避重试（不学浏览器干等 60 秒）', async () => {
  const srv = await silentUpgradeServer();
  const net = loadGameNet(srv.port);
  TrackedWebSocket.instances = [];

  const seen = [];
  net.on('connecting', () => seen.push('connecting'));
  net.on('open', () => seen.push('open'));
  net.on('close', () => seen.push('close'));
  net.on('timeout', (msg) => seen.push('timeout:' + msg.ms));

  const TIMEOUT = 700; // 把默认的 9 秒压到 0.7 秒，用例才跑得快（走的是同一条代码路径）
  net.connectTimeoutMs = TIMEOUT;

  try {
    const t0 = Date.now();
    net.connect();

    // 等第 2 次 upgrade = 真的重试了（退避第一档 500ms）
    const retried = await until(() => srv.upgrades.length >= 2, 5000);
    const elapsed = Date.now() - t0;

    assert.ok(retried, `超时之后应该重新发起连接，实际只有 ${srv.upgrades.length} 次 upgrade`);
    assert.ok(
      elapsed >= TIMEOUT,
      `不该早于超时就放弃（${TIMEOUT}ms），实际 ${elapsed}ms`
    );
    assert.ok(
      elapsed < 4000,
      `不该拖到浏览器的 60 秒，实际 ${elapsed}ms（目标：${TIMEOUT}ms + 一档退避）`
    );

    assert.equal(seen.includes('open'), false, '这条链路永远连不上，不该有 open');
    assert.ok(seen.includes('timeout:' + TIMEOUT), `应该发过超时事件，实际：${JSON.stringify(seen)}`);
    assert.deepEqual(
      seen.slice(0, 3),
      ['connecting', 'timeout:' + TIMEOUT, 'connecting'],
      `事件顺序应该是 发起 → 超时 → 重新发起，实际：${JSON.stringify(seen)}`
    );

    // 真的把那条卡住的连接 close() 掉了，而且换了一条新的
    assert.equal(
      TrackedWebSocket.instances[0].closeCalled,
      true,
      '卡住的那条连接必须被主动 close()，不能留着'
    );
    assert.ok(TrackedWebSocket.instances.length >= 2, '必须换一条新的 WebSocket 重试');

    // 状态：没连上、但正在重试（界面靠这个显示「正在连接服务器…」）
    assert.equal(net.connected, false, '不该连上');
    assert.equal(net.connecting, true, '重试期间应该处在"正在连接"状态');

    // 顺带钉住"这条链路确实是沉默的"：服务器一个字都没回过
    assert.equal(srv.writes.length, 0, '服务器不该写过任何字节（这是被测场景的前提）');

    console.log(
      `  [实验] 安静链路 + ${TIMEOUT}ms 超时：${elapsed}ms 后已放弃并重试，` +
        `服务器收到 ${srv.upgrades.length} 次 upgrade，事件序列 = ${JSON.stringify(seen.slice(0, 3))}`
    );
  } finally {
    net.close();
    await srv.close();
  }
});

test('默认建连超时是 9 秒（8~10 秒这个量级：远小于浏览器的 60 秒，又不误杀慢连接）', () => {
  const srv = { port: 1 }; // 只是要个对象，不会真连
  const net = loadGameNet(srv.port);
  assert.equal(net.connectTimeoutMs, 9000, '默认值被改了？公网那次是 60 秒才超时，9 秒才是我们要的');
  assert.ok(net.connectTimeoutMs >= 8000 && net.connectTimeoutMs <= 10_000, '应该在 8~10 秒之间');
});

test('连上之后就不再计时（超时不会把一条好连接误杀）', async () => {
  // 真的起一个会好好回 101 的服务端：手写握手，最省事
  const crypto = await import('node:crypto');
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('upgrade', (req, socket) => {
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const net = loadGameNet(port);
  const seen = [];
  net.on('open', () => seen.push('open'));
  net.on('timeout', () => seen.push('timeout'));
  net.connectTimeoutMs = 400; // 故意比建连还短，验证 open 之后计时真的被清掉了
  net.connect();

  try {
    assert.equal(await until(() => net.connected === true, 3000), true, '应该能连上这个会回 101 的服务器');
    await sleep(900); // 远超过 400ms
    assert.deepEqual(seen, ['open'], `连上之后不该再触发超时，实际：${JSON.stringify(seen)}`);
    assert.equal(net.connecting, false, '连上之后 connecting 应该归位');
    console.log('  [对照] 会回 101 的服务器：连上之后 400ms 的超时没有误杀它');
  } finally {
    net.close();
    for (const s of sockets) s.destroy();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

/*
 * 下面两条是"让用户无感知"那套网络优化的回归线：
 *   · 竞速：公网约 12% 的新建连接会被链路吞掉。等 9 秒再重试，用户就是"点了没反应"；
 *     2.5 秒并行再开一条，绝大多数情况下第二条 1 秒内就通了。
 *   · 心跳：TCP 还开着、对面已经不理（手机切网、隧道掉节点）时，界面会一直停在
 *     "看起来连着"的状态。心跳能在一个宽限期内发现并重连。
 */

test('竞速：第一条升级请求被吞掉时，短时间后就并行再开一条，谁先通用谁', async () => {
  const srv = await talkingWsServer({ skipFirstUpgrade: true });
  const net = loadGameNet(srv.port);
  TrackedWebSocket.instances = [];

  const seen = [];
  net.on('open', () => seen.push('open'));
  net.on('timeout', (msg) => seen.push('timeout:' + msg.ms));
  net.connectTimeoutMs = 30_000;   // 远大于竞速等待：赢的必须是"竞速"，不是"超时"
  net.raceDelayMs = 300;           // 用例跑快
  net.pingEveryMs = 0;

  try {
    const t0 = Date.now();
    net.connect();
    const connected = await until(() => net.connected === true, 4000);
    const elapsed = Date.now() - t0;

    assert.equal(connected, true, '第二条候选应该连上');
    assert.ok(elapsed >= 300, `不该早于竞速等待就通（实际 ${elapsed}ms）`);
    assert.ok(elapsed < 2500, `应该靠竞速救回来，不该拖到超时（实际 ${elapsed}ms）`);
    assert.ok(srv.upgrades.length >= 2, `应该发出过至少 2 次升级请求，实际 ${srv.upgrades.length}`);
    assert.equal(TrackedWebSocket.instances[0].closeCalled, true, '输掉的那条候选必须被关掉');
    assert.equal(seen.some((s) => s.startsWith('timeout')), false, '竞速成功时不该有超时事件');
    assert.equal(net.connecting, false, '连上之后 connecting 应该归位');

    console.log(`  [竞速] 第一条被吞：${elapsed}ms 就通了（并行发过 ${srv.upgrades.length} 次升级请求）`);
  } finally {
    net.close();
    await srv.close();
  }
});

test('心跳：有人应就测出延迟；没人应就在宽限期内判定连接已死、走重连', async () => {
  const srv = await talkingWsServer({ answerPings: true });
  const net = loadGameNet(srv.port);

  const seen = [];
  net.on('open', () => seen.push('open'));
  net.on('close', () => seen.push('close'));
  net.connectTimeoutMs = 30_000;
  net.raceDelayMs = 0;
  net.pingEveryMs = 200;    // 用例跑快（默认 25 秒）
  net.pongGraceMs = 400;    // 用例跑快（默认 15 秒）

  try {
    net.connect();
    assert.equal(await until(() => net.connected === true, 3000), true, '先得连上');

    assert.equal(await until(() => net.latencyMs !== null, 3000), true, '应该测出一次往返延迟');
    assert.ok(
      Number.isFinite(net.latencyMs) && net.latencyMs >= 0 && net.latencyMs < 1000,
      `延迟应该是个合理的小数字，实际 ${net.latencyMs}`
    );
    assert.ok(srv.received.some((m) => m.t === 'ping'), '客户端应该真的发过 ping（浏览器发不出 WS 控制帧）');

    // 从这一刻起对端不理我们了（TCP 还开着，就像隧道掉了节点）
    srv.state.answerPings = false;
    assert.equal(await until(() => seen.includes('close'), 4000), true, '心跳没人应就该判定这条连接已死');
    assert.equal(net.connected, false, '判定已死之后 connected 必须是 false');

    console.log(
      `  [心跳] 延迟 ${net.latencyMs}ms；对端不回话之后 4 秒内判定连接已死并重连`
    );
  } finally {
    net.close();
    await srv.close();
  }
});

/*
 * ============================================================================
 * 掉线之后必须自动重连
 * ============================================================================
 *
 * 【为什么单独立这一条】`ws.onclose` 里曾经有一句手误写成了裸 `connected`
 * （一个不存在的变量），于是**每次断开都在这句话上抛 ReferenceError**，
 * 后面的三件事一件都不会做：标记 `net.connected = false`、广播 `close` 事件、
 * `scheduleReconnect()` 安排重连。症状是"掉线之后再也不自动重连，界面还一直显示
 * 已连接，只能刷新页面"——而且它**不会出现在任何测试里**，因为之前没有哪条用例
 * 让一条**已经连上**的连接被动断开（心跳那条是"对端装死"，走的是另一条路）。
 *
 * 这条用例就是那次手误的回归防线：连上 → 服务端掐断 → 必须广播 close、
 * 必须把 connected 置 false、必须在退避之后**真的再开一条新连接**。
 */
test('掉线（服务端掐断）之后必须广播 close、置 false，并且真的自动重连', async () => {
  const srv = await talkingWsServer();
  const net = loadGameNet(srv.port);
  TrackedWebSocket.instances = [];

  const seen = [];
  net.on('open', () => seen.push('open'));
  net.on('close', () => seen.push('close'));
  net.connectTimeoutMs = 30_000;
  net.raceDelayMs = 0;

  try {
    net.connect();
    assert.equal(await until(() => net.connected === true, 3000), true, '第一步得先真的连上');
    const upgradesBefore = srv.upgrades.length;
    const socketsBefore = TrackedWebSocket.instances.length;

    // 服务端掐断（掉线 / 重启 / 隧道断）
    srv.killAll();

    assert.equal(
      await until(() => seen.includes('close'), 4000),
      true,
      `掉线时必须广播 close 事件（实际事件序列：${JSON.stringify(seen)}）—— ` +
        '没有它的话，界面会一直显示"已连接"，用户只能刷新页面'
    );
    assert.equal(net.connected, false, '掉线之后 net.connected 必须是 false');
    assert.equal(seen.includes('close'), true, 'close 事件里必须带着"这条连接已经没了"这件事');

    // 关键：退避之后必须**真的再开一条新连接**（这是"自动重连"的硬证据）
    assert.equal(
      await until(() => srv.upgrades.length > upgradesBefore, 6000),
      true,
      `掉线之后必须自动重连：服务器只收到 ${srv.upgrades.length} 次 upgrade（掉线前 ${upgradesBefore} 次）`
    );
    assert.ok(
      TrackedWebSocket.instances.length > socketsBefore,
      `必须真的新建了一条 WebSocket（掉线前 ${socketsBefore} 条，现在 ${TrackedWebSocket.instances.length} 条）`
    );

    console.log(
      `  [掉线重连] 事件序列 ${JSON.stringify(seen)}；` +
        `服务器共收到 ${srv.upgrades.length} 次 upgrade（掉线前 ${upgradesBefore} 次）= 真的自己连回来了`
    );
  } finally {
    net.close();
    await srv.close();
  }
});