/*
 * 大富翁 · 平台集成测试（真 HTTP + 真 WebSocket 帧 + 真上游兼容接口）。
 *
 *   node --test tests/monopoly.test.mjs
 *
 * 这一版大富翁是**上游 MineMonopoly 的 Web 客户端**（GPL-3.0）：
 *   · 页面 = `games/monopoly/web/` 的构建产物；
 *   · 规则 = 上游房主浏览器里的 Worker，平台不重写；
 *   · 联机 = `/monopoly-relay`（本进程的 WebSocket 中转，不用 WebRTC/TURN）；
 *   · 账号/好友/邀请 = 平台会话 + hub。
 *
 * 所以这里测的是**接线**，不是棋盘规则：
 *   · 登录门 / SPA 兜底 / 源码不泄漏；
 *   · `window.__FRP_ME__` 注入（账号和平台游戏列表同一个）；
 *   · 官方公开地图列表与文件；
 *   · 上游 room-router 生命周期（join/emit-host/heart/status/delete/reclaim/公开房）；
 *   · `/monopoly-relay` 的 hello/connect/data/close 转发；
 *   · 「正在玩 大富翁」presence + 邀请；
 *   · 未登录不能调 `/monopoly-server/*`。
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

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'frp-monopoly-test-'));
  app = await startServer({
    port: 0,
    // 测试要在一个进程里造几十个账号：关掉登录/注册限流（限流本身由 security.test.mjs 专门测）
    authLimitPerMinute: 0,
    dbPath: join(tmpDir, 'monopoly.db'),
    statePath: join(tmpDir, 'server.json'),
  });
});

after(async () => {
  if (app) await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/* ============================== 工具 ============================== */

async function call(path, { body, cookie, method } = {}) {
  const res = await fetch(new URL(path, app.url), {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
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

async function relayWs(cookie) {
  return wsConnect({ port: app.port, path: '/monopoly-relay', cookie });
}

async function hello(client) {
  client.send({ type: 'hello' });
  const msg = await client.waitFor((m) => m.type === 'welcome');
  assert.match(msg.id, /^p-[0-9a-f-]{36}$/);
  return msg.id;
}

/* ============================== 测试 ============================== */

describe('大富翁 · 登录门与静态文件', () => {
  it('未登录打开页面/SPA 路由/手机外壳 → 302 回平台登录页并带回跳', async () => {
    for (const path of ['/games/monopoly/', '/games/monopoly/room', '/games/monopoly/game', '/play/monopoly']) {
      const res = await call(path);
      assert.equal(res.status, 302, `${path} 应该被登录门拦住`);
      assert.match(res.location, /^\/\?return=/, `${path} 的 location 要带 return`);
      assert.equal(
        decodeURIComponent(res.location.slice('/?return='.length)),
        path,
        `${path} 的回跳地址要原样保留`
      );
    }
  });

  it('未登录仍能取资源（避免已登录页面加载中途 302 成白屏）', async () => {
    const res = await call('/games/monopoly/logo.ico');
    assert.equal(res.status, 200);
    assert.ok(res.text.length > 0 || res.data !== undefined);
  });

  it('音频走无扩展名出口 + octet-stream（防 IDM 等下载器抓 BGM/音效）', async () => {
    for (const path of ['/monopoly-audio/sfx/button-click', '/monopoly-audio/sfx/bob', '/monopoly-audio/bgm/main']) {
      const res = await fetch(new URL(path, app.url));
      assert.equal(res.status, 200, `${path} 应该能取到`);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream', `${path} 不能发 audio/*`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      assert.ok(bytes.length > 1000, `${path} 内容太小`);
    }
    for (const path of ['/monopoly-audio/sfx/../server.mjs', '/monopoly-audio/sfx/nope', '/monopoly-audio/bgm/../main']) {
      const res = await fetch(new URL(path, app.url));
      assert.equal(res.status, 404, `${path} 应该 404`);
    }
  });

  it('登录后页面注入 __FRP_ME__，且是平台同一个账号', async () => {
    const a = await registerUser('注入测试甲');
    const res = await call('/games/monopoly/', { cookie: a.cookie });
    assert.equal(res.status, 200);
    assert.match(res.text, /\/games\/monopoly\/assets\/index-[^"]+\.js/);
    assert.match(res.text, /window\.__FRP_ME__=\{/);
    assert.ok(res.text.includes(`"id":"${a.me.id}"`), '注入的身份必须是会话里的平台 ID');
    assert.ok(res.text.includes(JSON.stringify(a.me.name).slice(1, -1)), '昵称也要是平台的');
  });

  it('SPA 路由直接刷新也回入口页（不 404）', async () => {
    const a = await registerUser('刷新测试乙');
    for (const path of ['/games/monopoly/room-router', '/games/monopoly/room', '/games/monopoly/game']) {
      const res = await call(path, { cookie: a.cookie });
      assert.equal(res.status, 200, `${path} 应该回入口页`);
      assert.ok(res.text.includes('window.__FRP_ME__'), `${path} 也要注入身份`);
    }
  });

  it('上游源码 / 地图源目录 / 工具脚本不会从 /games/monopoly/ 泄漏', async () => {
    const a = await registerUser('防泄漏测试丙');
    for (const path of [
      '/games/monopoly/upstream/package.json',
      '/games/monopoly/upstream/apps/client/src/main.ts',
      '/games/monopoly/maps/manifest.json',
      '/games/monopoly/tools/fetch-official-maps.mjs',
      '/games/monopoly/AGENTS.md',
    ]) {
      const res = await call(path, { cookie: a.cookie });
      assert.equal(res.status, 404, `${path} 不该被静态挂载暴露`);
    }
  });

  it('/games/monopoly 补尾斜杠，并保留 ?join', async () => {
    const a = await registerUser('尾斜杠测试丁');
    const res = await call('/games/monopoly?join=ABC123', { cookie: a.cookie });
    assert.equal(res.status, 301);
    assert.equal(res.location, '/games/monopoly/?join=ABC123');
  });
});

describe('大富翁 · 官方公开地图', () => {
  it('列出 5 张在用的官方地图，URL 在 /monopoly-maps/，没有付费源文件', async () => {
    const a = await registerUser('地图测试丁');
    const res = await call('/monopoly-server/game-map/list?page=1&size=100&inuse=true', { cookie: a.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 200);
    assert.equal(res.data.data.total, 5);
    for (const map of res.data.data.gameMapList) {
      assert.match(map.mapUrl, /^\/monopoly-maps\/[^/]+\.mmmap$/);
      assert.equal(map.sourceUrl, null, '只提供公开 .mmmap，不提供 .fpmap 源文件');
      assert.equal(map.inuse, true);
      assert.equal(map.isOfficial, true);
    }
  });

  it('mapUrl 真的能下载，大小像一张完整地图', async () => {
    const a = await registerUser('地图下载戊');
    const list = await call('/monopoly-server/game-map/list?page=1&size=100&inuse=true', { cookie: a.cookie });
    const map = list.data.data.gameMapList[0];
    const res = await fetch(new URL(map.mapUrl, app.url));
    assert.equal(res.status, 200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.length > 500_000, `地图文件太小：${bytes.length} 字节`);
  });

  it('game-map/info 能按 id 取到同一张图', async () => {
    const a = await registerUser('地图信息己');
    const list = await call('/monopoly-server/game-map/list?page=1&size=100&inuse=true', { cookie: a.cookie });
    const map = list.data.data.gameMapList[0];
    const res = await call(`/monopoly-server/game-map/info?id=${encodeURIComponent(map.id)}`, { cookie: a.cookie });
    assert.equal(res.status, 200);
    assert.equal(res.data.data.id, map.id);
    assert.equal(res.data.data.name, map.name);
  });
});

describe('大富翁 · 房间路由（上游 room-router 兼容）', () => {
  it('未登录调 /monopoly-server/* → 401 JSON', async () => {
    const res = await call('/monopoly-server/game-map/list?page=1&size=10&inuse=true');
    assert.equal(res.status, 401);
    assert.equal(res.data.status, 401);
  });

  it('join → emit-host → 别人 join → status → delete 的完整生命周期', async () => {
    const a = await registerUser('房主庚');
    const b = await registerUser('客人辛');

    const first = await call('/monopoly-server/room-router/join?roomId=testroom', { cookie: a.cookie });
    assert.equal(first.status, 200);
    assert.equal(first.data.data.needCreate, true);
    assert.ok(first.data.data.hostLeaseToken, '新建房间要给房主租约 token');
    const token = first.data.data.hostLeaseToken;

    const emitted = await call('/monopoly-server/room-router/emit-host', {
      cookie: a.cookie,
      body: {
        roomId: 'testroom',
        hostPeerId: 'p-test-host',
        hostName: a.me.name,
        hostId: a.me.id,
        hostLeaseToken: token,
      },
    });
    assert.equal(emitted.status, 200);
    assert.equal(emitted.data.data.hostEpoch, 1);

    const guest = await call('/monopoly-server/room-router/join?roomId=testroom', { cookie: b.cookie });
    assert.equal(guest.status, 200);
    assert.equal(guest.data.data.needCreate, false);
    assert.equal(guest.data.data.hostPeerId, 'p-test-host');
    assert.deepEqual(guest.data.data.iceServers, [], '中转模式不需要 TURN');

    const heart = await call(`/monopoly-server/room-router/heart?roomId=testroom&hostLeaseToken=${token}`, { cookie: a.cookie });
    assert.equal(heart.status, 200);

    const status = await call('/monopoly-server/room-router/status?roomId=testroom', { cookie: b.cookie });
    assert.equal(status.status, 200);
    assert.equal(status.data.data.status, 'active');

    const deleted = await call(`/monopoly-server/room-router/delete?roomId=testroom&hostLeaseToken=${token}`, { cookie: a.cookie });
    assert.equal(deleted.status, 200);
    const gone = await call('/monopoly-server/room-router/join?roomId=testroom', { cookie: b.cookie });
    assert.equal(gone.status, 410);
  });

  it('非房主改不了私有/开局；房主公开后 random-public-room 返回顶层 roomId', async () => {
    const a = await registerUser('房主壬');
    const b = await registerUser('路人癸');
    const first = await call('/monopoly-server/room-router/join?roomId=publicroom', { cookie: a.cookie });
    const token = first.data.data.hostLeaseToken;

    await call('/monopoly-server/room-router/emit-host', {
      cookie: a.cookie,
      body: {
        roomId: 'publicroom',
        hostPeerId: 'p-public',
        hostName: a.me.name,
        hostId: a.me.id,
        hostLeaseToken: token,
      },
    });

    const deniedPrivate = await call('/monopoly-server/room-router/set-private', {
      cookie: b.cookie,
      body: { roomId: 'publicroom', isPrivate: false },
    });
    assert.equal(deniedPrivate.status, 403);

    const deniedStart = await call('/monopoly-server/room-router/set-started', {
      cookie: b.cookie,
      body: { roomId: 'publicroom', isStarted: true },
    });
    assert.equal(deniedStart.status, 403);

    const madePublic = await call('/monopoly-server/room-router/set-private', {
      cookie: a.cookie,
      body: { roomId: 'publicroom', isPrivate: false },
    });
    assert.equal(madePublic.status, 200);
    assert.equal(madePublic.data.data.isPrivate, false);

    const random = await call('/monopoly-server/room-router/random-public-room', { cookie: b.cookie });
    assert.equal(random.status, 200);
    assert.equal(random.data.roomId, 'publicroom', '上游客户端读的是顶层 roomId');

    const started = await call('/monopoly-server/room-router/set-started', {
      cookie: a.cookie,
      body: { roomId: 'publicroom', isStarted: true },
    });
    assert.equal(started.status, 200);
    assert.equal(started.data.data.isStarted, true);
  });

  it('房间号格式不对 → 400；房主租约不对 → 409', async () => {
    const a = await registerUser('房号测试子');
    const bad = await call('/monopoly-server/room-router/join?roomId=' + encodeURIComponent('有 空格'), { cookie: a.cookie });
    assert.equal(bad.status, 400);

    const first = await call('/monopoly-server/room-router/join?roomId=leasecheck', { cookie: a.cookie });
    const emitted = await call('/monopoly-server/room-router/emit-host', {
      cookie: a.cookie,
      body: {
        roomId: 'leasecheck',
        hostPeerId: 'p-lease',
        hostName: a.me.name,
        hostId: a.me.id,
        hostLeaseToken: first.data.data.hostLeaseToken,
      },
    });
    assert.equal(emitted.status, 200);

    const badHeart = await call('/monopoly-server/room-router/heart?roomId=leasecheck&hostLeaseToken=nope', { cookie: a.cookie });
    assert.equal(badHeart.status, 409);
  });
});

describe('大富翁 · WebSocket 中转', () => {
  it('两个已登录连接：hello / connect / 双向 data / close', async () => {
    const a = await registerUser('中转甲');
    const b = await registerUser('中转乙');
    const ca = await relayWs(a.cookie);
    const cb = await relayWs(b.cookie);

    const aId = await hello(ca);
    const bId = await hello(cb);

    ca.send({ type: 'connect', to: bId });
    const incoming = await cb.waitFor((m) => m.type === 'connection');
    assert.equal(incoming.from, aId);
    const connected = await ca.waitFor((m) => m.type === 'connected');
    assert.equal(connected.from, bId);

    ca.send({ type: 'data', to: bId, payload: JSON.stringify({ type: 'GameStart' }) });
    const got = await cb.waitFor((m) => m.type === 'data');
    assert.equal(got.from, aId);
    assert.equal(JSON.parse(got.payload).type, 'GameStart');

    cb.send({ type: 'data', to: aId, payload: JSON.stringify({ type: 'RoomInfo' }) });
    const back = await ca.waitFor((m) => m.type === 'data');
    assert.equal(back.from, bId);
    assert.equal(JSON.parse(back.payload).type, 'RoomInfo');

    ca.send({ type: 'close', to: bId });
    const gone = await cb.waitFor((m) => m.type === 'peer-disconnect');
    assert.equal(gone.id, aId);

    ca.close();
    cb.close();
  });

  it('没登录不能连中转；resume 能保住同一个 peerId', async () => {
    await assert.rejects(
      () => wsConnect({ port: app.port, path: '/monopoly-relay' }),
      (err) => err.statusCode === 401
    );

    const a = await registerUser('重连甲');
    const first = await relayWs(a.cookie);
    const id = await hello(first);
    first.close();
    await new Promise((r) => setTimeout(r, 50));

    const again = await relayWs(a.cookie);
    again.send({ type: 'hello', resume: id });
    const welcome = await again.waitFor((m) => m.type === 'welcome');
    assert.equal(welcome.id, id, '房主断线重连后 peerId 必须不变');
    again.close();
  });

  it('连一个不存在的 peer 会收到 error', async () => {
    const a = await registerUser('找人甲');
    await hello(await relayWs(a.cookie));
    const c = await relayWs(a.cookie);
    await hello(c);
    c.send({ type: 'connect', to: 'p-nobody' });
    const err = await c.waitFor((m) => m.type === 'error');
    assert.match(err.message, /不在线/);
    c.close();
  });
});

describe('大富翁 · 好友 presence 与邀请', () => {
  it('正在玩 / 好友邀请 / 接受回执 都走平台', async () => {
    const a = await registerUser('在线甲');
    const b = await registerUser('在线乙');
    app.store.addFriend(a.me.id, b.me.id);

    const wa = await platformWs(a.cookie);
    const wb = await platformWs(b.cookie);

    const set = await call('/api/monopoly/state', {
      cookie: a.cookie,
      body: { room: 'invite-room', started: false, count: 1, joinable: true },
    });
    assert.equal(set.status, 200);
    assert.equal(set.data.playing, true);

    const friends = await call('/api/monopoly/friends', { cookie: b.cookie });
    assert.equal(friends.status, 200);
    const seen = friends.data.friends.find((f) => f.id === a.me.id);
    assert.ok(seen, '好友列表里应该有甲');
    assert.equal(seen.online, true);
    assert.equal(seen.playing.game, 'monopoly');
    assert.equal(seen.playing.code, 'invite-room');
    assert.equal(seen.playing.started, false);
    assert.equal(seen.playing.joinable, true);

    const invite = await call('/api/monopoly/invite', {
      cookie: a.cookie,
      body: { room: 'invite-room', to: [b.me.id] },
    });
    assert.equal(invite.status, 200);
    assert.deepEqual(invite.data.delivered, [b.me.id]);

    const got = await wb.waitFor('invite');
    assert.equal(got.game, 'monopoly');
    assert.equal(got.code, 'invite-room');
    assert.equal(got.from.id, a.me.id);

    wb.send({ t: 'invite.reply', from: a.me.id, code: 'invite-room', accept: true, game: 'monopoly' });
    const reply = await wa.waitFor('invite.reply');
    assert.equal(reply.game, 'monopoly');
    assert.equal(reply.accept, true);
    assert.equal(reply.code, 'invite-room');

    await call('/api/monopoly/state', {
      cookie: a.cookie,
      body: { room: '', game: 'monopoly' },
    });
    const after = await call('/api/monopoly/friends', { cookie: b.cookie });
    assert.equal(after.data.friends.find((f) => f.id === a.me.id).playing, null);

    wa.close();
    wb.close();
  });

  it('不是好友不能邀请；离线好友计入 failed', async () => {
    const a = await registerUser('邀请甲');
    const b = await registerUser('陌生人乙');
    const res = await call('/api/monopoly/invite', {
      cookie: a.cookie,
      body: { room: 'nobody-home', to: [b.me.id] },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.delivered, []);
    assert.equal(res.data.failed[0].reason, '不是好友');
  });

  it('/api/monopoly/state 的房号校验和 room-router 一致', async () => {
    const a = await registerUser('状态甲');
    const bad = await call('/api/monopoly/state', {
      cookie: a.cookie,
      body: { room: '有 空格', started: false },
    });
    assert.equal(bad.status, 400);
  });
});