/*
 * 地平线赛车的服务器测试：平台房间层 + `/horizon-relay`。
 *
 * 不测 3D/物理（那是浏览器里的事，见 tests/browser*.mjs 的做法）。
 * 这里钉死的是"联机能不能真的接上"：
 *   · 游戏模块被自动发现，meta 的座位数/人机数正确；
 *   · 建房/加入/开局后，view 里有地图和全部车手；
 *   · `/horizon-relay` 握手期要平台登录，hello 还要核对房号/座位/阶段；
 *   · 两个客户端 ready → go；pos 只转给别人；finish 按到达顺序排名；
 *   · 开局后不能中途加入；房间重置后中继拒绝。
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

async function call(path, { body, cookie } = {}) {
  const res = await fetch(new URL(path, app.url), {
    method: body === undefined ? 'GET' : 'POST',
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
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const sid = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('sid=') && c.length > 4);
  return { status: res.status, data, cookie: sid, location: res.headers.get('location') };
}

async function registerUser(name) {
  const res = await call('/api/register', { body: { name, password: 'secret123' } });
  assert.equal(res.status, 200, `注册失败：${JSON.stringify(res.data)}`);
  assert.ok(res.cookie);
  return { cookie: res.cookie, me: res.data.me };
}

async function connect(cookie) {
  const client = await wsConnect({ port: app.port, cookie });
  await client.waitFor('ready');
  return client;
}

async function connectRelay(cookie) {
  const client = await wsConnect({ port: app.port, path: '/horizon-relay', cookie });
  return client;
}

/** 等一条 room.state，并按 phase / 成员数筛。 */
function waitState(client, check) {
  return client.waitFor((m) => m.t === 'room.state' && check(m), 5000);
}

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'frp-horizon-test-'));
  app = await startServer({
    port: 0,
    dbPath: join(tmpDir, 'test.db'),
  });
});

after(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('地平线赛车：平台游戏模块', () => {
  it('被服务器自动发现，meta 是 2–8 人、没有电脑', () => {
    const game = app.games.get('horizon');
    assert.ok(game, 'server/games/horizon.mjs 应该被自动发现');
    assert.equal(game.meta.title, '地平线赛车');
    assert.equal(game.meta.minPlayers, 2);
    assert.equal(game.meta.minSeats, 1);
    assert.equal(game.meta.maxPlayers, 8);
    assert.equal(game.meta.maxBots, 0);
  });

  it('建房/加入/开局：view 里有地图和全部车手', async () => {
    const a = await registerUser('赛车甲');
    const b = await registerUser('赛车乙');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.send({ t: 'room.create', game: 'horizon', options: { map: 'city2' } });
    const created = await waitState(ca, (m) => m.phase === 'waiting' && m.members.length === 1);
    const code = created.code;
    assert.equal(created.game, 'horizon');

    cb.send({ t: 'room.join', code });
    await waitState(cb, (m) => m.phase === 'waiting' && m.members.length === 2);

    ca.send({ t: 'room.start', options: { map: 'city2' } });
    const started = await waitState(ca, (m) => m.phase === 'playing');
    assert.equal(started.view.map, 'city2');
    assert.equal(started.view.racers.length, 2);
    assert.deepEqual(started.view.racers.map((r) => r.name).sort(), ['赛车乙', '赛车甲'].sort());

    // 中途加入被拒绝（物理对不齐，比赛模块 addPlayer 返回 false）
    const c = await registerUser('赛车丙');
    const cc = await connect(c.cookie);
    cc.send({ t: 'room.join', code });
    const err = await cc.waitFor('error');
    assert.match(err.message, /已经开始/);

    // 收尾：离开房间，别把状态留给下一个用例
    ca.send({ t: 'room.leave', code });
    cb.send({ t: 'room.leave', code });
    cc.close();
    ca.close();
    cb.close();
  });

  it('地图参数会被白名单收口（乱填回 alpine）', async () => {
    const a = await registerUser('赛车图');
    const ca = await connect(a.cookie);
    ca.send({ t: 'room.create', game: 'horizon', options: { map: 'not-a-map' } });
    const created = await waitState(ca, (m) => m.phase === 'waiting');
    ca.send({ t: 'room.start', options: { map: 'not-a-map' } });
    const started = await waitState(ca, (m) => m.phase === 'playing');
    assert.equal(started.view.map, 'alpine');
    ca.send({ t: 'room.leave' });
    ca.close();
  });

  it('页面必须登录；资源不拦；/games/horizon 301 保留 ?join', async () => {
    // 未登录：游戏页和手机外壳都回平台登录页，并带上回跳地址。
    const anon = await call('/games/horizon/');
    assert.equal(anon.status, 302);
    assert.match(anon.location, /^\/\?return=/);
    const anonShell = await call('/play/horizon');
    assert.equal(anonShell.status, 302);
    assert.match(anonShell.location, /^\/\?return=/);

    // 资源（css/js/lib/assets）不拦，否则登录后的页面会在加载中途 302 成白屏。
    const css = await call('/games/horizon/css/frp-horizon.css');
    assert.equal(css.status, 200);

    const a = await registerUser('页面甲');
    const doc = await call('/games/horizon/', { cookie: a.cookie });
    assert.equal(doc.status, 200);
    assert.match(doc.data, /js\/frp-horizon\.js/);
    assert.match(doc.data, /联机竞速/);

    const shell = await call('/play/horizon', { cookie: a.cookie });
    assert.equal(shell.status, 200);
    assert.match(shell.data, /\/games\/horizon\//);

    // 没有尾斜杠时相对路径会解析到站点根；301 必须保留邀请房号。
    const bare = await call('/games/horizon?join=ABC234', { cookie: a.cookie });
    assert.equal(bare.status, 301);
    assert.equal(bare.location, '/games/horizon/?join=ABC234');
  });
});

describe('地平线赛车：/horizon-relay', () => {
  it('握手期要登录；hello 要核对房间/座位/阶段；ready 后发 go；pos 转发；finish 排名', async () => {
    const a = await registerUser('联机甲');
    const b = await registerUser('联机乙');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.send({ t: 'room.create', game: 'horizon', options: { map: 'alpine' } });
    const created = await waitState(ca, (m) => m.phase === 'waiting');
    const code = created.code;
    cb.send({ t: 'room.join', code });
    await waitState(cb, (m) => m.phase === 'waiting' && m.members.length === 2);

    // 没登录的连接：握手期就该被拒（HTTP 401，升级不成功）
    await assert.rejects(
      () => wsConnect({ port: app.port, path: '/horizon-relay' }),
      /401/
    );

    ca.send({ t: 'room.start', options: { map: 'alpine' } });
    await waitState(ca, (m) => m.phase === 'playing');
    await waitState(cb, (m) => m.phase === 'playing');

    // 登录了但不在房里：hello 之后收到 error
    const outsider = await registerUser('路人');
    const co = await connectRelay(outsider.cookie);
    co.send({ t: 'hello', code, map: 'alpine', car: 'gt' });
    const denied = await co.waitFor('error');
    assert.match(denied.message, /不在这个房间/);
    co.close();

    const ra = await connectRelay(a.cookie);
    ra.send({ t: 'hello', code, map: 'alpine', car: 'gt' });
    const wa = await ra.waitFor('welcome');
    assert.equal(wa.code, code);
    assert.equal(wa.started, false);

    const rb = await connectRelay(b.cookie);
    rb.send({ t: 'hello', code, map: 'alpine', car: 'p918' });
    const wb = await rb.waitFor('welcome');
    assert.equal(wb.peers.length, 1);
    assert.equal(wb.peers[0].name, '联机甲');
    // A 收到 B 进来的 peer 通知
    const peer = await ra.waitFor('peer');
    assert.equal(peer.name, '联机乙');

    // 两个都 ready → go（5 秒倒计时）
    ra.send({ t: 'ready' });
    rb.send({ t: 'ready' });
    const ga = await ra.waitFor('go');
    const gb = await rb.waitFor('go');
    assert.ok(ga.delayMs >= 4000 && ga.delayMs <= 6000, `倒计时应该是 5 秒左右，实际 ${ga.delayMs}`);
    assert.equal(gb.delayMs, ga.delayMs);

    // 位置只转给别人，不回给自己
    ra.send({ t: 'pos', x: 10, y: 2, z: 30, yaw: 0.5, vx: 1, vz: 2, speed: 50, progress: 0.2 });
    const pos = await rb.waitFor('pos');
    assert.equal(pos.id, a.me.id);
    assert.equal(pos.x, 10);
    assert.equal(pos.progress, 0.2);
    ra.clear();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(ra.received.filter((m) => m.t === 'pos').length, 0, 'pos 不该回给发送者');

    // 完赛顺序
    ra.send({ t: 'finish', time: 42.5 });
    const fa = await rb.waitFor('finish');
    assert.equal(fa.order, 1);
    assert.equal(fa.id, a.me.id);
    rb.send({ t: 'finish', time: 45.1 });
    const fb = await ra.waitFor((m) => m.t === 'finish' && m.id === b.me.id);
    assert.equal(fb.order, 2);

    // 平台房间层的完赛 act：两边都报完，match 自动 over
    ca.send({ t: 'room.act', act: { type: 'finish', time: 42.5 } });
    cb.send({ t: 'room.act', act: { type: 'finish', time: 45.1 } });
    const over = await waitState(ca, (m) => m.phase === 'over');
    assert.equal(over.view.phase, 'over');
    assert.equal(over.view.results.length, 2);
    assert.deepEqual(over.view.results.map((r) => r.order), [1, 2]);

    // 再来一局：房间回 waiting；中继拒绝新 hello
    ca.send({ t: 'room.reset' });
    await waitState(ca, (m) => m.phase === 'waiting');

    const late = await connectRelay(b.cookie);
    late.send({ t: 'hello', code, map: 'alpine', car: 'gt' });
    const lateErr = await late.waitFor('error');
    assert.match(lateErr.message, /比赛还没开始/);

    ra.close();
    rb.close();
    late.close();
    ca.send({ t: 'room.leave' });
    cb.send({ t: 'room.leave' });
    ca.close();
    cb.close();
  });
});