/*
 * 莲花广麻 · 平台集成测试（真 HTTP + 真 WebSocket + **真的上游 Python 后端**）。
 *
 *   npm run test:mahjong        # = node --test tests/mahjong.test.mjs
 *
 * 这一版是**整份上游项目搬进服务器**（D43）：
 *   · 界面 = 上游 Vue3 + Three.js 构建产物（`games/mahjong/web/`）；
 *   · 规则/联机 = 上游 FastAPI 后端（`games/mahjong/backend/`，127.0.0.1:8123）；
 *   · 账号 = 平台账号（Node 网关注入 `x-frp-user-*`，**页面里没有登录框**）；
 *   · 好友 / 邀请 / 「正在玩」= 平台 hub + presence。
 *
 * 所以这里测的是**接线**，不是麻将规则：
 *   · 登录门 / 301 补斜杠 / 资源不拦；
 *   · `window.__FRP_ME__` 注入且与平台账号一致；
 *   · 伪造 `x-frp-user-*` 头不能冒充别人（Node 必须覆盖）；
 *   · REST 反代（未登录 401、登录后能建房/加入/准备/开局）；
 *   · `/mahjong/ws/...` 反代（未登录升不上来、带 rejoin_code 能收 `rejoin_ok`）；
 *   · presence 上报后好友列表显示「正在玩 莲花广麻」，邀请卡片带对 game/code。
 *
 * ⚠️ 需要 `games/mahjong/backend/.venv`（见 games/mahjong/README.md）。
 *    后端起不来时本文件的用例会 skip，不会把整个 `npm test` 拖红。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { startServer } from '../server/server.mjs';
import { wsConnect } from './ws-client.mjs';

let app;
let tmpDir;
let backendReady = false;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'frp-mahjong-test-'));
  app = await startServer({
    port: 0,
    dbPath: join(tmpDir, 'mahjong.db'),
    statePath: join(tmpDir, 'server.json'),
    // 这个文件是唯一真正启动 Python 后端的；用独立端口 + 独立 SQLite，
    // 免得和正在运行的真实服务（8123）互相复用/污染。
    mahjongBackend: true,
    mahjongBackendPort: 8199,
    mahjongDbPath: join(tmpDir, 'mahjong-backend.db'),
  });
  backendReady = Boolean(app.mahjong?.ready);
});

after(async () => {
  if (app) await app.close();
  // Windows 上 Python 子进程刚退出时还会短暂占着 .db 文件，重试几次再删
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
});

/* ============================== 工具 ============================== */

async function call(path, { body, cookie, method, headers } = {}) {
  const res = await fetch(new URL(path, app.url), {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...(headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  const sid = (res.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('sid=') && c.length > 4);
  return { status: res.status, data, cookie: sid, location: res.headers.get('location'), text };
}

async function registerUser(name, password = 'secret123') {
  const res = await call('/api/register', { body: { name, password } });
  assert.equal(res.status, 200, `注册失败：${JSON.stringify(res.data)}`);
  assert.ok(res.cookie, '注册应该返回会话 cookie');
  return { cookie: res.cookie, me: res.data.me };
}

async function platformWs(cookie) {
  const client = await wsConnect({ port: app.port, cookie });
  client.me = (await client.waitFor('ready')).me;
  await client.waitFor('friends');
  return client;
}

const skipIfNoBackend = (t) => {
  if (!backendReady) {
    t.skip('麻将后端没起来（缺 .venv？见 games/mahjong/README.md）');
    return true;
  }
  return false;
};

/* ============================== 测试 ============================== */

describe('莲花广麻 · 登录门与静态文件', () => {
  it('未登录打开游戏页/手机外壳 → 302 回平台登录页并带回跳（含 ?join）', async () => {
    for (const path of ['/mahjong/', '/mahjong/index.html', '/play/mahjong', '/mahjong/?join=AB12CD']) {
      const res = await call(path);
      assert.equal(res.status, 302, `${path} 应该被登录门拦住`);
      assert.match(res.location, /^\/\?return=/, `${path} 的 location 要带 return`);
      assert.equal(
        decodeURIComponent(res.location.slice('/?return='.length)),
        path,
        `${path} 的回跳地址要原样保留（邀请房号不能丢）`
      );
    }
  });

  it('/mahjong 少了尾斜杠要 301 且保留查询串（Vite base 是相对路径）', async () => {
    const res = await call('/mahjong?join=AB12CD');
    assert.equal(res.status, 301);
    assert.equal(res.location, '/mahjong/?join=AB12CD');
  });

  it('未登录仍能取资源（避免已登录页面加载中途 302 成白屏）', async () => {
    const page = await call('/mahjong/');
    assert.equal(page.status, 302);
    const asset = await call('/mahjong/favicon.svg');
    assert.equal(asset.status, 200);
  });

  it('音频有无扩展名出口（防 IDM 抓取），原 .mp3 地址仍兼容', async () => {
    // 页面会把 /mahjong/audio/1m.mp3 改写成 /mahjong/audio/1m
    const extless = await fetch(new URL('/mahjong/audio/1m', app.url));
    assert.equal(extless.status, 200, '无扩展名音频要能取到（映射回 1m.mp3）');
    assert.equal(extless.headers.get('content-type'), 'audio/mpeg', 'MIME 要按真实文件发，<audio> 才能播');
    assert.equal(extless.headers.get('content-disposition'), 'inline', '音频不该被当附件下载');
    assert.ok((await extless.arrayBuffer()).byteLength > 1000, '无扩展名出口要发真的音频字节');

    // 老地址不能坏：上游代码/缓存里仍可能有带扩展名的 URL
    const legacy = await fetch(new URL('/mahjong/audio/1m.mp3', app.url));
    assert.equal(legacy.status, 200);

    const missing = await fetch(new URL('/mahjong/audio/not-a-file', app.url));
    assert.equal(missing.status, 404);
  });
});

describe('莲花广麻 · 账号就是平台账号', () => {
  it('入口页注入 window.__FRP_ME__（id/名字/头像）并带上全屏按钮', async () => {
    const alice = await registerUser('红中');
    const page = await call('/mahjong/', { cookie: alice.cookie });
    assert.equal(page.status, 200);
    assert.match(page.text, /window\.__FRP_ME__=/);
    assert.ok(page.text.includes(alice.me.name), '注入的名字要跟平台账号一致');
    assert.ok(page.text.includes(alice.me.id), '注入的 id 要跟平台账号一致');
    assert.match(page.text, /\/avatar\//);
    assert.match(page.text, /shared\/ui\/fullscreen\.js/);
    // 音频 URL 去扩展名（防 IDM / 迅雷自动抓取）
    assert.match(page.text, /shared\/ui\/no-idm\.js/);
    // 上游自己的 OAuth 登录不再出现（补丁见 useWakuDemoAuth.ts）
    assert.ok(!page.text.includes('googletagmanager'), '不要带上游的第三方统计');
  });

  it('后端会话与平台会话是同一人', async (t) => {
    const alice = await registerUser('白板');
    const session = await call('/mahjong/api/login/session', { cookie: alice.cookie });
    assert.equal(session.status, 200, JSON.stringify(session.data));
    assert.equal(session.data.authenticated, true);
    assert.equal(session.data.account.id, alice.me.id);
    assert.equal(session.data.account.displayName, alice.me.name);

    const anon = await call('/mahjong/api/login/session');
    // 网关先挡：没登录平台的请求根本到不了后端（避免上游 OAuth 的登录入口复活）
    assert.equal(anon.status, 401);
    assert.equal(anon.data?.detail?.code, 'AUTH_REQUIRED');
  });

  it('浏览器伪造 x-frp-user-* 头不能冒充别人（网关必须覆盖）', async () => {
    const alice = await registerUser('东风');
    const bob = await registerUser('南风');
    const res = await call('/mahjong/api/login/session', {
      cookie: alice.cookie,
      headers: {
        'x-frp-user-id': bob.me.id,
        'x-frp-user-name': encodeURIComponent(bob.me.name),
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.account.id, alice.me.id, '身份只能来自平台会话');
    assert.equal(res.data.account.displayName, alice.me.name);
  });

  it('未登录调麻将 REST → 401（不是后端自己的登录页）', async () => {
    for (const [method, path, body] of [
      ['POST', '/mahjong/api/rooms', { mode: 'east', capacity: 4, rulesetId: 'lotus-classic' }],
      ['GET', '/mahjong/api/rooms/ABCDEF', undefined],
    ]) {
      const res = await call(path, { method, body });
      assert.equal(res.status, 401, `${method} ${path} 应该 401`);
      assert.equal(res.data?.detail?.code, 'AUTH_REQUIRED');
    }
  });
});

describe('莲花广麻 · 房间与 WebSocket（真上游后端）', () => {
  it('两人建房/加入/准备/开局，WS 反代能收到 rejoin_ok 与快照', async (t) => {
    if (skipIfNoBackend(t)) return;

    const alice = await registerUser('庄家');
    const bob = await registerUser('闲家');

    const created = await call('/mahjong/api/rooms', {
      cookie: alice.cookie,
      body: { mode: 'east', capacity: 4, rulesetId: 'lotus-classic' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const roomId = created.data.roomId;
    assert.match(roomId, /^[A-Z0-9]{6}$/, '房号是上游的 6 位大写短码');

    const bobJoined = await call(`/mahjong/api/rooms/${roomId}/join`, {
      cookie: bob.cookie,
      body: { nickname: bob.me.name, playerId: bob.me.id },
    });
    assert.equal(bobJoined.status, 200, JSON.stringify(bobJoined.data));
    const aliceJoined = await call(`/mahjong/api/rooms/${roomId}/join`, {
      cookie: alice.cookie,
      body: { nickname: alice.me.name, playerId: alice.me.id },
    });
    assert.equal(aliceJoined.status, 200, JSON.stringify(aliceJoined.data));

    // 未登录不能升级 WS（否则等于绕过平台账号）
    await assert.rejects(
      () => wsConnect({
        port: app.port,
        path: `/mahjong/ws/room/${roomId}?rejoin_code=${encodeURIComponent(bobJoined.data.rejoinCode)}`,
      }),
      (err) => err.statusCode === 401,
      '没登录的 WebSocket 升级必须被拒'
    );

    const ws = await wsConnect({
      port: app.port,
      path: `/mahjong/ws/room/${roomId}?rejoin_code=${encodeURIComponent(bobJoined.data.rejoinCode)}`,
      cookie: bob.cookie,
    });
    const rejoin = await ws.waitFor((m) => m.kind === 'rejoin_ok');
    assert.equal(rejoin.roomId, roomId);
    assert.equal(rejoin.nickname, bob.me.name);
    // 开局前的快照是空桌子（manager 还没建）
    const empty = await ws.waitFor((m) => m.kind === 'state_snapshot');
    assert.equal(empty.roomId, roomId);

    for (const [user, joined] of [[alice, aliceJoined], [bob, bobJoined]]) {
      const res = await call(`/mahjong/api/rooms/${roomId}/ready`, {
        cookie: user.cookie,
        body: { seat: joined.data.seat, rejoinCode: joined.data.rejoinCode, ready: true },
      });
      assert.equal(res.status, 200, JSON.stringify(res.data));
    }
    const started = await call(`/mahjong/api/rooms/${roomId}/start`, {
      cookie: alice.cookie,
      body: { seat: aliceJoined.data.seat, rejoinCode: aliceJoined.data.rejoinCode },
    });
    assert.equal(started.status, 200, JSON.stringify(started.data));
    assert.equal(started.data.status, 'playing');

    // 开局后服务端广播新快照：四个座位（2 真人 + 2 AI）、自己的手牌可见、别家隐藏
    const dealt = await ws.waitFor(
      (m) => m.kind === 'state_snapshot' && Array.isArray(m.players) && m.players.length === 4,
      10_000,
    );
    const me = dealt.players.find((p) => p.seat === rejoin.seat);
    assert.ok(me, '快照里要有自己的座位');
    assert.ok(me.hand.length === 13 || me.hand.length === 14, '自己应有 13/14 张手牌');
    assert.ok(me.hand.every((tile) => tile !== null), '自己的手牌必须可见');
    for (const other of dealt.players.filter((p) => p.seat !== rejoin.seat)) {
      assert.ok(other.hand.every((tile) => tile === null), '不能把别家手牌发给客户端');
    }

    const status = await call(`/mahjong/api/rooms/${roomId}`, { cookie: bob.cookie });
    assert.equal(status.status, 200);
    assert.equal(status.data.status, 'playing');
    assert.equal(status.data.capacity, 4);
    // 房间层只有真人座位（2 个）；空位由开局时 AI 补足（见上面的快照断言）
    assert.equal(status.data.seats.filter(Boolean).length, 2);

    ws.close();
  });
});

describe('莲花广麻 · 好友 / 正在玩 / 邀请', () => {
  it('心跳上报后好友看到「正在玩 莲花广麻」，邀请卡片带 game=mahjong 与房号', async (t) => {
    if (skipIfNoBackend(t)) return;

    const alice = await registerUser('邀请人');
    const bob = await registerUser('被邀请');
    const aliceWs = await platformWs(alice.cookie);
    const bobWs = await platformWs(bob.cookie);

    aliceWs.send({ t: 'friend.add', id: bob.me.id });
    await bobWs.waitFor((m) => m.t === 'friends' && m.incoming.some((f) => f.id === alice.me.id));
    bobWs.send({ t: 'friend.accept', id: alice.me.id });
    await aliceWs.waitFor((m) => m.t === 'friends' && m.list.some((f) => f.id === bob.me.id));

    const created = await call('/mahjong/api/rooms', {
      cookie: alice.cookie,
      body: { mode: 'east', capacity: 4, rulesetId: 'lotus-classic' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const roomId = created.data.roomId;

    const state = await call('/api/mahjong/state', {
      cookie: bob.cookie,
      body: { room: roomId, game: 'mahjong', started: false, count: 1, joinable: true },
    });
    assert.equal(state.status, 200, JSON.stringify(state.data));

    const friends = await call('/api/mahjong/friends', { cookie: alice.cookie });
    assert.equal(friends.status, 200);
    const bobFriend = friends.data.friends.find((f) => f.id === bob.me.id);
    assert.ok(bobFriend, '好友列表里要有 bob');
    assert.equal(bobFriend.playing?.game, 'mahjong');
    assert.equal(bobFriend.playing?.code, roomId);
    assert.equal(bobFriend.playing?.joinable, true);

    const invite = await call('/api/mahjong/invite', {
      cookie: alice.cookie,
      body: { room: roomId, to: [bob.me.id] },
    });
    assert.equal(invite.status, 200, JSON.stringify(invite.data));
    assert.deepEqual(invite.data.delivered, [bob.me.id]);

    const card = await bobWs.waitFor('invite');
    assert.equal(card.game, 'mahjong');
    assert.equal(card.code, roomId);
    assert.equal(card.from.id, alice.me.id);

    // 不接受邀请的人也不能被硬塞进房
    const notFriend = await registerUser('路人');
    const refused = await call('/api/mahjong/invite', {
      cookie: alice.cookie,
      body: { room: roomId, to: [notFriend.me.id] },
    });
    assert.equal(refused.status, 200);
    assert.equal(refused.data.delivered.length, 0);
    assert.equal(refused.data.failed[0].id, notFriend.me.id);

    // 房号格式不对 → 400
    const bad = await call('/api/mahjong/invite', {
      cookie: alice.cookie,
      body: { room: 'abc', to: [bob.me.id] },
    });
    assert.equal(bad.status, 400);

    // 清心跳后好友列表回到离线/不在玩
    await call('/api/mahjong/state', {
      cookie: bob.cookie,
      body: { room: '', game: 'mahjong' },
    });
    const afterLeave = await call('/api/mahjong/friends', { cookie: alice.cookie });
    const bobAfter = afterLeave.data.friends.find((f) => f.id === bob.me.id);
    assert.equal(bobAfter.playing, null);

    aliceWs.close();
    bobWs.close();
  });

  it('未登录不能读好友/发邀请', async () => {
    for (const [path, body] of [
      ['/api/mahjong/friends', undefined],
      ['/api/mahjong/invite', { room: 'AB12CD', to: [] }],
      ['/api/mahjong/state', { room: 'AB12CD' }],
    ]) {
      const res = await call(path, { body });
      assert.equal(res.status, 401, `${path} 应该 401`);
    }
  });
});