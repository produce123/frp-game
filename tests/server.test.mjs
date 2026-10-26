/*
 * 服务器集成测试：真实 HTTP 请求 + 真实 WebSocket 帧（手工掩码）。
 *
 * 覆盖（对应 docs/ARCHITECTURE.md 的每一项承诺）：
 *   · 静态白名单：server/ data/ docs/ 必须不可达，穿越必须被挡
 *   · 账号：注册/重名/格式校验/登录/会话 cookie/未登录拦截
 *   · WebSocket：握手期鉴权、非法 JSON、未知类型、未加掩码帧、
 *     以及**客户端加掩码、服务端不加掩码**这两条 RFC 硬要求
 *   · 好友：申请-同意制（申请 / 同意 / 拒绝 / 撤回 / 互相申请 / 重复与非法申请）、
 *     上下线实时推送、删好友双向
 *   · 房间：建房/进房/开局/操作/满员/房主移交，以及**按人裁剪视图**
 *   · 人机座位：按一下加一个、真人顶掉人机、座位不够不给开局、只有房主能改
 *   · 互动：扔鸡蛋/送鲜花广播给房里每个人（含发起人，便于乐观播放去重）、垃圾输入被拒
 *   · 心跳：ping → 原样回的 pong（浏览器发不出协议层 ping，保活只能靠它）
 *   · 邀请：只能邀请好友、非好友邀请不出去、接受即入座、邀请人收到回执
 *   · 存储：老库（没有申请表）直接升级不清库
 *
 * 房间测试需要一个游戏。服务器上还没有真游戏（见 docs/GAMES.md），
 * 所以通过 startServer({ extraGames }) 注入一个假游戏 —— 这个参数只给测试用。
 *
 * 跑：node --test tests/
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import { startServer } from '../server/server.mjs';
import { openStore } from '../server/store.mjs';
import { wsConnect } from './ws-client.mjs';

/* ============================== 测试用假游戏 ============================== */

/**
 * 一个最小的"计数"游戏。它故意**不返回对手的明细**，
 * 好让测试能验证"客户端只拿得到自己的视图"这条硬要求。
 */
const fakeGame = {
  meta: { slug: 'fake-game', title: '假游戏', minPlayers: 2, maxPlayers: 2 },
  createMatch(players) {
    const counts = new Map(players.map((p) => [p.id, 0]));
    let over = false;

    return {
      viewFor(playerId) {
        let othersTotal = 0;
        for (const [id, n] of counts) if (id !== playerId) othersTotal += n;
        return { self: counts.get(playerId) ?? 0, othersTotal };
      },
      act(playerId, act) {
        if (!counts.has(playerId)) return { ok: false, message: '你不在这一局里' };
        if (!act || act.kind !== 'bump') return { ok: false, message: '不认识的操作' };
        counts.set(playerId, counts.get(playerId) + 1);
        if (counts.get(playerId) >= 3) over = true;
        return { ok: true };
      },
      addPlayer() { return false; },       // 中途不许加入
      removePlayer(playerId) { counts.delete(playerId); },
      isOver() { return over; },
      result() { return { counts: [...counts] }; },
    };
  },
};

/* ============================== 工具 ============================== */

let app;
let tmpDir;

/**
 * 发一个 HTTP 请求。cookie 要手动传（Node 的 fetch 不保存 cookie）。
 * @returns {Promise<{status:number, data:any, cookie?:string}>}
 */
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

  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const sid = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('sid=') && c.length > 4);

  return { status: res.status, data, cookie: sid, contentType: res.headers.get('content-type') };
}

/** 注册一个用户，返回 { cookie, me }。 */
async function registerUser(name, password = 'secret123') {
  const res = await call('/api/register', { body: { name, password } });
  assert.equal(res.status, 200, `注册失败：${JSON.stringify(res.data)}`);
  assert.ok(res.cookie, '注册应该返回会话 cookie');
  return { cookie: res.cookie, me: res.data.me };
}

/** 用 cookie 连上 WebSocket，并等 ready。 */
async function connect(cookie) {
  const client = await wsConnect({ port: app.port, cookie });
  await client.waitFor('ready');
  await client.waitFor('friends');
  return client;
}

/**
 * 让两个人成为好友：甲发申请 → 乙同意。
 *
 * 每一步都把**双方**的快照消费掉（申请和同意都是双向可见的），
 * 否则上一步残留的那条会被下一步的断言当成"新消息"读走，看着就像差一格。
 *
 * @returns {Promise<{a:any, b:any}>} 同意之后甲、乙各自收到的 friends 快照
 */
async function befriend(ca, cb, aId, bId) {
  ca.clear();
  cb.clear();
  ca.send({ t: 'friend.add', id: bId });
  await ca.waitFor('friends');            // 甲：outgoing 里多一条
  await cb.waitFor('friends');            // 乙：incoming 里多一条

  ca.clear();
  cb.clear();
  cb.send({ t: 'friend.accept', id: aId });
  return { a: await ca.waitFor('friends'), b: await cb.waitFor('friends') };
}

/** 断言某人收到的快照里，好友 / 来件 / 去件分别是哪几个 ID。 */
function expectIds(snapshot, { list = [], incoming = [], outgoing = [] } = {}) {
  assert.deepEqual(snapshot.list.map((f) => f.id), list, 'list 里的好友对不上');
  assert.deepEqual(snapshot.incoming.map((r) => r.id), incoming, 'incoming 里的申请对不上');
  assert.deepEqual(snapshot.outgoing.map((r) => r.id), outgoing, 'outgoing 里的申请对不上');
}

/* ============================== 生命周期 ============================== */

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'frp-game-test-'));
  app = await startServer({
    port: 0,
    // 测试要在一个进程里造几十个账号：关掉登录/注册限流（限流本身由 security.test.mjs 专门测）
    authLimitPerMinute: 0,
    dbPath: join(tmpDir, 'test.db'),
    extraGames: new Map([['fake-game', fakeGame]]),
  });
});

after(async () => {
  if (app) await app.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

/* ============================== 静态白名单 ============================== */

describe('静态文件与白名单', () => {
  it('首页能返回平台外壳', async () => {
    const res = await call('/');
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/html/);
    assert.match(res.data, /网页游戏平台/);
  });

  it('挂载目录能访问（/shared、/assets）', async () => {
    for (const path of ['/shared/net/net.js', '/assets/css/style.css', '/shared/ui/ui.css', '/shared/ui/fullscreen.js']) {
      const res = await call(path);
      assert.equal(res.status, 200, `${path} 应该可访问`);
    }
  });

  it('server/ data/ docs/ 一律不可达', async () => {
    for (const path of ['/server/server.mjs', '/server/store.mjs', '/docs/DECISIONS.md', '/package.json']) {
      const res = await call(path);
      assert.equal(res.status, 404, `${path} 不该被发出去`);
    }
  });

  it('路径穿越被挡（编码过的 ..）', async () => {
    // 注意必须用编码过的点：new URL() 会先把字面量 ../ 规范化掉，那样就测不到服务端了
    const res = await call('/assets/%2e%2e%2f%2e%2e%2fserver/store.mjs');
    assert.equal(res.status, 404);
  });

  it('非 GET/HEAD 的静态请求返回 405', async () => {
    const res = await call('/assets/css/style.css', { method: 'DELETE' });
    assert.equal(res.status, 405);
  });
});

/* ============================== 账号 ============================== */

describe('账号', () => {
  it('注册会发一个合规的玩家 ID', async () => {
    const { me } = await registerUser('刀');
    assert.match(me.id, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{7}$/);
    // 刻意排除易混字符
    assert.doesNotMatch(me.id, /[0O1IL]/);
    assert.equal(me.name, '刀');
  });

  it('允许重名，靠 ID 区分', async () => {
    const a = await registerUser('双');
    const b = await registerUser('双');
    assert.equal(a.me.name, b.me.name);
    assert.notEqual(a.me.id, b.me.id);
  });

  it('名字是 1–10 个字符，密码至少 6 位', async () => {
    // 10 个字（按码点算）正好是上限
    const ten = await call('/api/register', { body: { name: '一二三四五六七八九十', password: 'secret123' } });
    assert.equal(ten.status, 200, ten.data.message);
    assert.equal(ten.data.me.name, '一二三四五六七八九十');

    const longName = await call('/api/register', { body: { name: '一二三四五六七八九十一', password: 'secret123' } });
    assert.equal(longName.status, 400);
    assert.match(longName.data.message, /10 个字符/);

    const blank = await call('/api/register', { body: { name: '   ', password: 'secret123' } });
    assert.equal(blank.status, 400);
    assert.match(blank.data.message, /空的/);

    const spaces = await call('/api/register', { body: { name: '刀 马', password: 'secret123' } });
    assert.equal(spaces.status, 400);

    const shortPw = await call('/api/register', { body: { name: '甲', password: '123' } });
    assert.equal(shortPw.status, 400);
    assert.match(shortPw.data.message, /至少 6 位/);
  });

  it('注册就带上默认头像地址（不用上传也能当图片用）', async () => {
    const { me } = await registerUser('刀马江湖');
    assert.match(me.avatar, /^\/avatar\/[A-Z0-9]{7}\?v=\d+$/);
    const res = await call(me.avatar);
    assert.equal(res.status, 200);
    assert.match(res.contentType || '', /image\/svg\+xml/);
    assert.match(String(res.data), /<svg/);
  });

  it('emoji 也算一个字', async () => {
    const res = await call('/api/register', { body: { name: '🎮', password: 'secret123' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.me.name, '🎮');
  });

  it('登录后可以改名字：1–10 个字符，ID 不变', async () => {
    const { me } = await registerUser('旧名');
    const login = await call('/api/login', { body: { id: me.id, password: 'secret123' } });
    const cookie = login.cookie;
    assert.ok(cookie, '登录应该返回会话 cookie');
    const ok = await call('/api/name', { cookie, body: { name: '新名字🎮' } });
    assert.equal(ok.status, 200, ok.data.message);
    assert.equal(ok.data.me.name, '新名字🎮');
    assert.equal(ok.data.me.id, me.id, '改名字不能换 ID（好友认的是 ID）');

    const meAfter = await call('/api/me', { cookie });
    assert.equal(meAfter.data.me.name, '新名字🎮');

    const tooLong = await call('/api/name', { cookie, body: { name: '一二三四五六七八九十一' } });
    assert.equal(tooLong.status, 400);
    const anon = await call('/api/name', { body: { name: '路人' } });
    assert.equal(anon.status, 401);
  });

  it('登录成功后能凭 cookie 认出自己；密码错、ID 不存在都是 401', async () => {
    const { me } = await registerUser('剑');

    const ok = await call('/api/login', { body: { id: me.id, password: 'secret123' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.me.id, me.id);

    const meRes = await call('/api/me', { cookie: ok.cookie });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.me.id, me.id);

    const wrongPw = await call('/api/login', { body: { id: me.id, password: 'wrong-password' } });
    assert.equal(wrongPw.status, 401);

    const noSuchId = await call('/api/login', { body: { id: 'ZZZZZZZ', password: 'secret123' } });
    assert.equal(noSuchId.status, 401);
    // 两句提示必须一模一样，否则就成了枚举有效 ID 的工具
    assert.equal(wrongPw.data.message, noSuchId.data.message);
  });

  it('没登录拿不到 /api/me', async () => {
    const res = await call('/api/me');
    assert.equal(res.status, 401);
  });

  it('登出后 cookie 失效', async () => {
    const { cookie } = await registerUser('盾');
    const out = await call('/api/logout', { body: {}, cookie });
    assert.equal(out.status, 200);
    const meRes = await call('/api/me', { cookie });
    assert.equal(meRes.status, 401);
  });
});

/* ============================== WebSocket 硬要求 ============================== */

describe('WebSocket', () => {
  it('没登录的连接根本不会升级成功（握手期就拒）', async () => {
    await assert.rejects(
      () => wsConnect({ port: app.port }),
      (err) => err.statusCode === 401,
    );
  });

  it('连上先收到 ready + friends', async () => {
    const { cookie, me } = await registerUser('弓');
    const client = await wsConnect({ port: app.port, cookie });
    const ready = await client.waitFor('ready');
    assert.equal(ready.me.id, me.id);
    const friends = await client.waitFor('friends');
    assert.deepEqual(friends.list, []);
    client.close();
  });

  it('非法 JSON 与未知类型都会回中文错误', async () => {
    const { cookie } = await registerUser('矛');
    const client = await connect(cookie);

    client.clear();
    client.send('这不是 JSON');
    const bad = await client.waitFor('error');
    assert.match(bad.message, /JSON/);

    client.clear();
    client.send({ t: 'nonexistent.type' });
    const unknown = await client.waitFor('error');
    assert.match(unknown.message, /不认识的消息类型/);

    client.close();
  });

  it('未加掩码的帧会被 1002 关掉', async () => {
    const { cookie } = await registerUser('斧');
    const client = await connect(cookie);
    client.sendUnmasked({ t: 'friend.add', id: 'AAAAAAA' });
    const code = await client.waitClose();
    assert.equal(code, 1002);
  });

  it('服务端发来的帧不加掩码（否则浏览器会直接断）', async () => {
    const { cookie } = await registerUser('钩');
    const client = await connect(cookie);
    // 走一个完整的往返：能正确解析出服务端的回复，就说明两个方向的帧格式都对。
    // （客户端加掩码、服务端不加掩码 —— 两边各自实现，谁写错这里就会炸。）
    client.send({ t: 'friend.add', id: 'ZZZZZZZ' });
    const err = await client.waitFor('error');
    assert.match(err.message, /没有这个 ID/);
    client.close();
  });
});

/* ============================== 好友 ============================== */

describe('好友', () => {
  it('加好友只是发一条申请：双方都还不是好友，发起方看到 outgoing、接收方看到 incoming', async () => {
    const a = await registerUser('甲');
    const b = await registerUser('乙');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.clear();
    cb.clear();
    ca.send({ t: 'friend.add', id: b.me.id });

    // 发起方：没有多出好友，只是多了一条"我发出去的"
    const snapA = await ca.waitFor('friends');
    expectIds(snapA, { outgoing: [b.me.id] });
    assert.equal(snapA.outgoing[0].name, '乙', 'outgoing 里要带对方的名字，界面直接用');
    assert.match(snapA.outgoing[0].avatar, /^\/avatar\//, 'outgoing 里要带头像地址');

    // 接收方：也没有多出好友，只是多了一条"别人发给我的"
    const snapB = await cb.waitFor('friends');
    expectIds(snapB, { incoming: [a.me.id] });
    assert.equal(snapB.incoming[0].name, '甲');
    assert.match(snapB.incoming[0].avatar, /^\/avatar\//, 'incoming 里要带头像地址');

    ca.close();
    cb.close();
  });

  it('对方同意之后才互相成为好友', async () => {
    const a = await registerUser('承');
    const b = await registerUser('认');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    const after = await befriend(ca, cb, a.me.id, b.me.id);

    expectIds(after.a, { list: [b.me.id] });
    expectIds(after.b, { list: [a.me.id] });
    assert.equal(after.a.list[0].online, true, '同意之后对方应该是在线的');
    assert.equal(after.a.list[0].name, '认');

    ca.close();
    cb.close();
  });

  it('拒绝之后申请从两边消失，双方仍然不是好友', async () => {
    const a = await registerUser('拒');
    const b = await registerUser('绝');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.clear();
    cb.clear();
    ca.send({ t: 'friend.add', id: b.me.id });
    await ca.waitFor('friends');
    await cb.waitFor('friends');

    ca.clear();
    cb.clear();
    cb.send({ t: 'friend.decline', id: a.me.id });

    const afterB = await cb.waitFor('friends');
    const afterA = await ca.waitFor('friends');
    expectIds(afterB, {});
    expectIds(afterA, {});

    ca.close();
    cb.close();
  });

  it('撤回自己发出的申请：对方那边也不再挂着它', async () => {
    const a = await registerUser('撤');
    const b = await registerUser('回');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.clear();
    cb.clear();
    ca.send({ t: 'friend.add', id: b.me.id });
    await ca.waitFor('friends');
    await cb.waitFor('friends');

    ca.clear();
    cb.clear();
    ca.send({ t: 'friend.cancel', id: b.me.id });

    const afterA = await ca.waitFor('friends');
    const afterB = await cb.waitFor('friends');
    expectIds(afterA, {});
    expectIds(afterB, {}, '撤回之后对方的 incoming 里不该还留着它');

    // 已经撤回了，再撤一次 → 没有这条申请
    ca.clear();
    ca.send({ t: 'friend.cancel', id: b.me.id });
    assert.match((await ca.waitFor('error')).message, /没有这条申请/);

    // 别人的申请撤不掉：乙从来没给甲发过申请
    cb.clear();
    cb.send({ t: 'friend.cancel', id: a.me.id });
    assert.match((await cb.waitFor('error')).message, /没有这条申请/);

    // 没有的申请也同意不了
    cb.clear();
    cb.send({ t: 'friend.accept', id: a.me.id });
    assert.match((await cb.waitFor('error')).message, /没有这条申请/);

    ca.close();
    cb.close();
  });

  it('双方同时互相申请 = 直接成为好友（不卡住）', async () => {
    const a = await registerUser('碰');
    const b = await registerUser('撞');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.clear();
    cb.clear();
    ca.send({ t: 'friend.add', id: b.me.id });
    await ca.waitFor('friends');
    await cb.waitFor('friends');

    // 乙也按下"加好友" —— 两边都在等对方，服务端必须直接判成好友
    ca.clear();
    cb.clear();
    cb.send({ t: 'friend.add', id: a.me.id });

    const finalB = await cb.waitFor('friends');
    const finalA = await ca.waitFor('friends');
    expectIds(finalA, { list: [b.me.id] });
    expectIds(finalB, { list: [a.me.id] });
    assert.equal(finalA.list[0].online, true);
    assert.deepEqual(ca.received.filter((m) => m.t === 'error'), [], '互相申请不该报错');
    assert.deepEqual(cb.received.filter((m) => m.t === 'error'), [], '互相申请不该报错');

    ca.close();
    cb.close();
  });

  it('加自己是错的、加不存在的 ID 是错的、已经是好友再申请也是错的', async () => {
    const a = await registerUser('丙');
    const b = await registerUser('丁');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.clear();
    ca.send({ t: 'friend.add', id: a.me.id });
    assert.match((await ca.waitFor('error')).message, /不能加自己/);

    ca.clear();
    ca.send({ t: 'friend.add', id: 'ZZZZZZZ' });
    assert.match((await ca.waitFor('error')).message, /没有这个 ID/);

    await befriend(ca, cb, a.me.id, b.me.id);

    ca.clear();
    ca.send({ t: 'friend.add', id: b.me.id });
    assert.match((await ca.waitFor('error')).message, /你们已经是好友了/);

    ca.close();
    cb.close();
  });

  it('重复发同一条申请会被明确拦住，也不会插出第二条', async () => {
    const a = await registerUser('重');
    const b = await registerUser('复');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.clear();
    cb.clear();
    ca.send({ t: 'friend.add', id: b.me.id });
    await ca.waitFor('friends');
    await cb.waitFor('friends');

    ca.clear();
    cb.clear();
    ca.send({ t: 'friend.add', id: b.me.id });
    assert.match((await ca.waitFor('error')).message, /已经发过申请了/);
    // 乙那边不该因此收到任何新快照（什么都没变）
    assert.deepEqual(cb.received.filter((m) => m.t === 'friends'), []);

    // 重新连一次拿一份干净的快照：outgoing 里必须还是**一条**
    ca.close();
    const again = await wsConnect({ port: app.port, cookie: a.cookie });
    await again.waitFor('ready');
    const snap = await again.waitFor('friends');
    expectIds(snap, { outgoing: [b.me.id] });

    again.close();
    cb.close();
  });

  it('好友上下线会实时推送（推的是整份列表）', async () => {
    const a = await registerUser('戊');
    const b = await registerUser('己');
    const ca = await connect(a.cookie);

    // 乙还没上线就收到了申请 —— 申请存在服务器上，不依赖对方在线
    ca.clear();
    ca.send({ t: 'friend.add', id: b.me.id });
    expectIds(await ca.waitFor('friends'), { outgoing: [b.me.id] });

    // 乙上线 → 自己那份快照里就有这条申请（离线期间发来的不会丢）
    const cb = await wsConnect({ port: app.port, cookie: b.cookie });
    await cb.waitFor('ready');
    expectIds(await cb.waitFor('friends'), { incoming: [a.me.id] });

    // 乙同意 → 甲收到一份新列表：乙成了好友，而且是在线的
    cb.clear();
    cb.send({ t: 'friend.accept', id: a.me.id });
    expectIds(await cb.waitFor('friends'), { list: [a.me.id] });

    const up = await ca.waitFor('friends');
    expectIds(up, { list: [b.me.id] });
    assert.equal(up.list[0].online, true);

    // 乙下线 → 又一份新列表，乙变成离线
    cb.close();
    const down = await ca.waitFor('friends');
    expectIds(down, { list: [b.me.id] });
    assert.equal(down.list[0].online, false);

    ca.close();
  });

  it('离线时发来的申请会留在服务器上，对方一上线就能看到', async () => {
    const a = await registerUser('留');
    const b = await registerUser('着');
    const ca = await connect(a.cookie);

    ca.clear();
    ca.send({ t: 'friend.add', id: b.me.id });
    expectIds(await ca.waitFor('friends'), { outgoing: [b.me.id] });

    // 乙这时候才第一次上线
    const cb = await wsConnect({ port: app.port, cookie: b.cookie });
    await cb.waitFor('ready');
    expectIds(await cb.waitFor('friends'), { incoming: [a.me.id] });

    ca.close();
    cb.close();
  });

  it('好友列表会显示「他正在玩什么」，开局之后就进不去了', async () => {
    const a = await registerUser('玩');
    const b = await registerUser('看');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    const after = await befriend(ca, cb, a.me.id, b.me.id);
    expectIds(after.a, { list: [b.me.id] });

    // 乙建房 → 甲看到"乙正在玩 fake-game"，而且点得进去
    ca.clear();
    cb.send({ t: 'room.create', game: 'fake-game' });
    const room = await cb.waitFor('room.state');
    const waiting = await ca.waitFor('friends');
    assert.equal(waiting.list[0].playing.game, 'fake-game');
    assert.equal(waiting.list[0].playing.code, room.code);
    assert.equal(waiting.list[0].playing.phase, 'waiting');
    assert.equal(waiting.list[0].playing.joinable, true);

    // 甲进房、乙开局 → 还看得到"在玩什么"，但已经进不去了
    ca.send({ t: 'room.join', code: room.code });
    await ca.waitFor('room.state');
    cb.send({ t: 'room.start' });
    await cb.waitFor('room.state');

    const playing = await ca.waitFor('friends');
    assert.equal(playing.list[0].playing.game, 'fake-game');
    assert.equal(playing.list[0].playing.phase, 'playing');
    assert.equal(playing.list[0].playing.joinable, false);

    ca.close(); cb.close();
  });

  it('离线的人不显示"在玩什么"（座位可能还留着，但对别人没意义）', async () => {
    const a = await registerUser('离');
    const b = await registerUser('线');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    const after = await befriend(ca, cb, a.me.id, b.me.id);
    expectIds(after.a, { list: [b.me.id] });

    ca.clear();
    cb.send({ t: 'room.create', game: 'fake-game' });
    await cb.waitFor('room.state');
    const onlineView = await ca.waitFor('friends');
    assert.ok(onlineView.list[0].playing);

    // 乙断开：座位还在（宽限期内），但对甲来说不该再显示"在玩什么"
    cb.close();
    const offlineView = await ca.waitFor('friends');
    assert.equal(offlineView.list[0].online, false);
    assert.equal(offlineView.list[0].playing, null);

    ca.close();
  });

  it('删好友也是双向的', async () => {
    const a = await registerUser('庚');
    const b = await registerUser('辛');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    const after = await befriend(ca, cb, a.me.id, b.me.id);
    expectIds(after.a, { list: [b.me.id] });
    expectIds(after.b, { list: [a.me.id] });

    ca.clear();
    cb.clear();
    ca.send({ t: 'friend.remove', id: b.me.id });
    expectIds(await ca.waitFor('friends'), {});
    expectIds(await cb.waitFor('friends'), {});

    // 删掉之后可以重新发申请（不是被永久拉黑）
    ca.clear();
    cb.clear();
    ca.send({ t: 'friend.add', id: b.me.id });
    expectIds(await ca.waitFor('friends'), { outgoing: [b.me.id] });
    expectIds(await cb.waitFor('friends'), { incoming: [a.me.id] });

    ca.close();
    cb.close();
  });
});

/* ============================== 房间 ============================== */

describe('房间', () => {
  it('建房 → 进房 → 开局 → 操作，且视图按人裁剪', async () => {
    const a = await registerUser('主');
    const b = await registerUser('客');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    // 建房
    ca.clear();
    ca.send({ t: 'room.create', game: 'fake-game' });
    const created = await ca.waitFor('room.state');
    assert.equal(created.phase, 'waiting');
    assert.equal(created.hostId, a.me.id);
    assert.equal(created.members.length, 1);
    const code = created.code;
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);

    // 进房：故意用小写 + 多余字符，验证归一化
    cb.clear();
    cb.send({ t: 'room.join', code: code.toLowerCase() + '- ' });
    const joined = await cb.waitFor('room.state');
    assert.equal(joined.code, code);
    assert.equal(joined.members.length, 2);

    // 客人不能开局
    cb.clear();
    cb.send({ t: 'room.start' });
    assert.match((await cb.waitFor('error')).message, /只有房主/);

    // 房主开局
    ca.clear();
    cb.clear();
    ca.send({ t: 'room.start' });
    const startedA = await ca.waitFor('room.state');
    assert.equal(startedA.phase, 'playing');
    await cb.waitFor('room.state');

    // 房主操作一次 → 两边的 view 必须不同（这就是"裁剪"）
    ca.clear();
    cb.clear();
    ca.send({ t: 'room.act', act: { kind: 'bump' } });
    const afterA = await ca.waitFor('room.state');
    const afterB = await cb.waitFor('room.state');
    assert.deepEqual(afterA.view, { self: 1, othersTotal: 0 });
    assert.deepEqual(afterB.view, { self: 0, othersTotal: 1 });

    ca.close();
    cb.close();
  });

  it('满员会被拒，非法房间号会被拒', async () => {
    const a = await registerUser('壹');
    const b = await registerUser('贰');
    const c = await registerUser('叁');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);
    const cc = await connect(c.cookie);

    ca.clear();
    ca.send({ t: 'room.create', game: 'fake-game' });
    const code = (await ca.waitFor('room.state')).code;

    cb.clear();
    cb.send({ t: 'room.join', code });
    await cb.waitFor('room.state');

    cc.clear();
    cc.send({ t: 'room.join', code });
    assert.match((await cc.waitFor('error')).message, /房间满了/);

    cc.clear();
    cc.send({ t: 'room.join', code: '!!' });
    assert.match((await cc.waitFor('error')).message, /房间号格式/);

    cc.clear();
    cc.send({ t: 'room.join', code: 'ABCDEF' });
    assert.match((await cc.waitFor('error')).message, /房间不存在/);

    ca.close(); cb.close(); cc.close();
  });

  it('「再来一局」把房间放回等待态：成员还在，只有房主能按', async () => {
    const a = await registerUser('再');
    const b = await registerUser('来');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.send({ t: 'room.create', game: 'fake-game' });
    const code = (await ca.waitFor('room.state')).code;

    // 注意：房间状态是**分别**推给每个人的，所以每步都要两边各消费一次，
    // 并且动之前先 clear() —— 否则会消费到上一步残留的那条，断言就会看着像差一格。
    cb.send({ t: 'room.join', code });
    await cb.waitFor('room.state');
    await ca.waitFor('room.state');

    ca.clear(); cb.clear();
    ca.send({ t: 'room.start' });
    await ca.waitFor('room.state');
    await cb.waitFor('room.state');

    // 打到结束：fake-game 自己操作满 3 次就结束
    let last = null;
    for (let i = 0; i < 3; i++) {
      ca.clear(); cb.clear();
      ca.send({ t: 'room.act', act: { kind: 'bump' } });
      last = await ca.waitFor('room.state');
      await cb.waitFor('room.state');
    }
    assert.equal(last.phase, 'over');

    // 客人不能按
    cb.send({ t: 'room.reset' });
    assert.match((await cb.waitFor('error')).message, /只有房主/);

    // 房主按了 → 回到等待态，两个人都还在，视图清空
    ca.clear(); cb.clear();
    ca.send({ t: 'room.reset' });
    const back = await ca.waitFor('room.state');
    assert.equal(back.phase, 'waiting');
    assert.equal(back.members.length, 2);
    assert.equal(back.view, null);
    assert.equal((await cb.waitFor('room.state')).phase, 'waiting');

    ca.close(); cb.close();
  });

  it('房主离开后房主身份移交给留下的人', async () => {
    const a = await registerUser('首');
    const b = await registerUser('次');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.clear();
    ca.send({ t: 'room.create', game: 'fake-game' });
    const code = (await ca.waitFor('room.state')).code;

    cb.clear();
    cb.send({ t: 'room.join', code });
    await cb.waitFor('room.state');

    cb.clear();
    ca.send({ t: 'room.leave' });
    const after = await cb.waitFor('room.state');
    assert.equal(after.hostId, b.me.id);
    assert.equal(after.members.length, 1);

    ca.close(); cb.close();
  });

  it('没接上服务器的游戏建不了房', async () => {
    const a = await registerUser('肆');
    const ca = await connect(a.cookie);
    ca.clear();
    ca.send({ t: 'room.create', game: 'not-a-game' });
    assert.match((await ca.waitFor('error')).message, /没有这个游戏/);
    ca.close();
  });

  it('离开房间的人会收到一条"你不在房里了"', async () => {
    const a = await registerUser('离');
    const b = await registerUser('守');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.clear();
    ca.send({ t: 'room.create', game: 'fake-game' });
    const code = (await ca.waitFor('room.state')).code;
    cb.clear();
    cb.send({ t: 'room.join', code });
    await cb.waitFor('room.state');
    await ca.waitFor('room.state');     // 收到"有人进来了"

    /*
     * ⚠️ 这条以前是坏的：房间层只给**还在房里的人**广播状态，
     * 离开的人自己收不到任何消息，客户端就一直停在房间界面上
     * （看起来就是"点了离开没反应"）。
     * 现在给离开的人单独补一条 code 为空的 room.state —— 客户端靠这个把"我在房里"清掉。
     */
    cb.clear();
    cb.send({ t: 'room.leave' });
    const out = await cb.waitFor('room.state');
    assert.equal(out.code, null, '离开的人应该收到 code 为空的 room.state');

    // 留下的人看到只剩自己，而且自己成了房主
    const left = await ca.waitFor((m) => m.t === 'room.state' && m.members.length === 1);
    assert.equal(left.hostId, a.me.id, '房主走了（或客人走了）之后房主身份要落到剩下的人身上');

    ca.close(); cb.close();
  });

  it('房间号归一化：大小写、空格、常见看错的字符', async () => {
    const { normalizeCode } = await import('../shared/protocol.mjs');
    const code = 'ABCDEF';
    assert.equal(normalizeCode(code), code);
    assert.equal(normalizeCode(' abcdef '), code, '小写和空格要能救回来');
    assert.equal(normalizeCode('ABC-DEF'), code, '中间的横杠要能吃掉');
    // 字母表刻意排除了最容易看错的 0 O 1 I L —— 所以它们会被**丢掉**而不是猜成别的字符
    assert.equal(normalizeCode('ABC0EF'), null, '含被排除字符时长度不够，应该判为无效');
    assert.equal(normalizeCode('ABCOEF'), null, 'O 也在排除之列');
    assert.equal(normalizeCode(null), null);
    assert.equal(normalizeCode(''), null);
    assert.equal(normalizeCode('ABCDE'), null, '短一位也不行');
    assert.equal(normalizeCode('ABCDEFG'), null, '长一位也不行');
  });
});

/* ============================== 人机座位 ============================== */

/*
 * 人机在**房间层**是座位（不是游戏自己造的补位）。
 * 用户要的交互是"按一下加一个人机，它坐在座位上"，
 * 所以这几条钉的是：加/移除/占座位/顶掉/开局门槛 —— 全是平台行为，与具体游戏无关。
 */

describe('人机座位', () => {
  it('房主按一下「添加人机」就多一个座位：单字名字、bot: 前缀、带 isBot', async () => {
    const a = await registerUser('机');
    const ca = await connect(a.cookie);

    ca.clear();
    ca.send({ t: 'room.create', game: 'fake-game' });
    const created = await ca.waitFor('room.state');
    assert.equal(created.members.length, 1, '刚建好房只有房主');
    // 界面靠这两个数决定「开始」亮不亮、还能加几个人机
    assert.equal(created.minSeats, 2, 'fake-game 没写 minSeats，应该退到 minPlayers');
    assert.equal(created.maxSeats, 2);
    assert.equal(created.minPlayers, 2);

    ca.clear();
    ca.send({ t: 'room.bot.add' });
    const added = await ca.waitFor('room.state');
    assert.equal(added.members.length, 2, '按一下只加一个');

    const bot = added.members.find((m) => m.isBot);
    assert.ok(bot, '成员列表里必须有一个带 isBot 的座位');
    assert.equal(bot.id, 'bot:1', '人机 id 要有 bot: 前缀（不会和 7 位真人 id 撞）');
    assert.equal(bot.name.length, 1, '人机名字必须是单字（用户要求沿用单机那套命名）');
    assert.equal(bot.online, true, '人机永远是"在线"的，不然界面上会显示掉线中');
    assert.equal(added.members.find((m) => m.id === a.me.id).isBot, false, '真人要显式标成 isBot:false');

    // 座位满了再加 → 不是静默忽略，要给一句能读懂的话
    ca.clear();
    ca.send({ t: 'room.bot.add' });
    assert.match((await ca.waitFor('error')).message, /座位满了/);

    ca.close();
  });

  it('真人进房时先顶掉最后加的那个人机（人机不挡真人）', async () => {
    const a = await registerUser('顶');
    const b = await registerUser('位');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.send({ t: 'room.create', game: 'fake-game' });
    const code = (await ca.waitFor('room.state')).code;
    ca.clear();
    ca.send({ t: 'room.bot.add' });
    await ca.waitFor('room.state');

    // 座位已经满了（1 真人 + 1 人机 = 2 = maxPlayers），但真人进来必须成功
    cb.clear();
    cb.send({ t: 'room.join', code });
    const joined = await cb.waitFor('room.state');
    assert.equal(joined.members.length, 2);
    assert.equal(joined.members.some((m) => m.isBot), false, '最后加的那个人机应该被顶掉');
    assert.ok(joined.members.some((m) => m.id === b.me.id), '进来的真人必须在座位里');

    ca.close(); cb.close();
  });

  it('座位不够时开局被拒；补一个人机就能开局', async () => {
    const a = await registerUser('单');
    const ca = await connect(a.cookie);

    ca.send({ t: 'room.create', game: 'fake-game' });
    await ca.waitFor('room.state');

    ca.clear();
    ca.send({ t: 'room.start' });
    const refused = await ca.waitFor('error');
    assert.match(refused.message, /座位不够/, '一个人开局必须被拒，而且要说清怎么补');

    ca.clear();
    ca.send({ t: 'room.bot.add' });
    await ca.waitFor('room.state');

    ca.clear();
    ca.send({ t: 'room.start' });
    const started = await ca.waitFor('room.state');
    assert.equal(started.phase, 'playing', '一个人 + 一个人机是正常玩法，必须能开局');
    assert.ok(started.view, '开局后要有视图');

    ca.close();
  });

  it('只有房主能加/移除人机；不能"移除"真人或不存在的座位', async () => {
    const a = await registerUser('主');
    const b = await registerUser('客');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.send({ t: 'room.create', game: 'fake-game' });
    const code = (await ca.waitFor('room.state')).code;

    // 房主单独在房里时加一个人机再撤掉
    ca.clear();
    ca.send({ t: 'room.bot.add' });
    const withBot = await ca.waitFor('room.state');
    const botId = withBot.members.find((m) => m.isBot).id;

    ca.clear();
    ca.send({ t: 'room.bot.remove', id: botId });
    const removed = await ca.waitFor('room.state');
    assert.equal(removed.members.length, 1, '移除之后座位要少一个');
    assert.equal(removed.members.some((m) => m.isBot), false);

    ca.clear();
    ca.send({ t: 'room.bot.remove', id: botId });
    assert.match((await ca.waitFor('error')).message, /没有这个座位/, '已经撤掉的人机不能再撤一次');

    ca.clear();
    ca.send({ t: 'room.bot.remove', id: a.me.id });
    assert.match((await ca.waitFor('error')).message, /没有这个座位/, '真人不能被当成人机移除');

    // 客人进房之后，加/移除都不许（否则客人能把房主的配置改乱）
    cb.clear();
    cb.send({ t: 'room.join', code });
    await cb.waitFor('room.state');
    await ca.waitFor('room.state');

    cb.clear();
    cb.send({ t: 'room.bot.add' });
    assert.match((await cb.waitFor('error')).message, /只有房主能加人机/);

    cb.clear();
    cb.send({ t: 'room.bot.remove', id: a.me.id });
    assert.match((await cb.waitFor('error')).message, /只有房主能移除人机/);

    ca.close(); cb.close();
  });
});

/* ============================== 互动 ============================== */

/*
 * 扔鸡蛋 / 送鲜花是平台级的一件共用能力（三个游戏行为必须一致）。
 * 服务端只管三件事：目标在不在同一间房、种类认不认识、广播给房里每个人（含发起人）。
 * 发起人也收到，是因为发送方要**乐观播放**，靠回执里的 rid 认出自己的回声、不播第二遍。
 *
 * 刻意**没有**次数限制（用户明确要求）—— 只有一条技术性防刷（2 秒 40 次，正常碰不到）。
 */
describe('互动', () => {
  it('扔鸡蛋广播给房里每个人，发送者也收到（好认自己的回声）', async () => {
    const a = await registerUser('扔');
    const b = await registerUser('接');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.send({ t: 'room.create', game: 'fake-game' });
    const code = (await ca.waitFor('room.state')).code;
    cb.send({ t: 'room.join', code });
    await cb.waitFor('room.state');
    await ca.waitFor('room.state');

    ca.clear(); cb.clear();
    ca.send({ t: 'react.send', to: b.me.id, kind: 'egg' });
    const atSender = await ca.waitFor('react');
    const atTarget = await cb.waitFor('react');

    assert.equal(atSender.from.id, a.me.id);
    assert.equal(atSender.from.name, a.me.name, '目标界面要显示是谁扔的');
    assert.equal(atSender.to, b.me.id);
    assert.equal(atSender.kind, 'egg');
    assert.ok(atSender.rid, '每一条互动要带一个编号，发送方靠它认出自己的回声');
    assert.deepEqual(atTarget, atSender, '房里每个人看到的必须是同一条（否则动画会对不上）');

    // 鲜花是另一种，一样要能发
    ca.clear(); cb.clear();
    ca.send({ t: 'react.send', to: a.me.id, kind: 'flower' });
    assert.equal((await cb.waitFor('react')).kind, 'flower');

    ca.close(); cb.close();
  });

  it('不认识的花样、不在房里的人都要被拒（垃圾输入不许把服务端弄崩）', async () => {
    const a = await registerUser('乱');
    const b = await registerUser('真');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    ca.send({ t: 'room.create', game: 'fake-game' });
    const code = (await ca.waitFor('room.state')).code;
    cb.send({ t: 'room.join', code });
    await cb.waitFor('room.state');
    await ca.waitFor('room.state');

    ca.clear();
    ca.send({ t: 'react.send', to: b.me.id, kind: 'bomb' });
    assert.match((await ca.waitFor('error')).message, /不认识这个互动/);

    ca.clear();
    ca.send({ t: 'react.send', to: 'ZZZZZZZ', kind: 'egg' });
    assert.match((await ca.waitFor('error')).message, /他不在这个房间里/);

    ca.clear();
    ca.send({ t: 'react.send', to: null, kind: 'egg' });
    assert.match((await ca.waitFor('error')).message, /他不在这个房间里/);

    // 人机也是能扔的对象（它坐在座位上）。单独开一间房，免得两个真人已经占满座位。
    const c = await registerUser('独');
    const cc = await connect(c.cookie);
    cc.send({ t: 'room.create', game: 'fake-game' });
    await cc.waitFor('room.state');
    cc.clear();
    cc.send({ t: 'room.bot.add' });
    const withBot = await cc.waitFor('room.state');
    const botId = withBot.members.find((m) => m.isBot).id;

    cc.clear();
    cc.send({ t: 'react.send', to: botId, kind: 'egg' });
    assert.equal((await cc.waitFor('react')).to, botId, '要能对人机扔鸡蛋');

    ca.close(); cb.close(); cc.close();
  });

  it('不在房间里就不给扔', async () => {
    const a = await registerUser('外');
    const ca = await connect(a.cookie);
    ca.clear();
    ca.send({ t: 'react.send', to: 'ABCDEFG', kind: 'egg' });
    assert.match((await ca.waitFor('error')).message, /你不在房间里/);
    ca.close();
  });
});

/* ============================== 心跳 ============================== */

/*
 * 浏览器**发不出** WebSocket 协议层的 ping（那套 API 里没有），
 * 所以保活只能靠一条普通消息。这条很小，但它是"手机切网/隧道掉节点之后
 * 界面还显示连着"的唯一解药 —— 客户端收不到 pong 就会主动重连。
 */
describe('心跳', () => {
  it('ping 要原样回一条 pong（带上同一个 ts，客户端才算得出延迟）', async () => {
    const a = await registerUser('跳');
    const ca = await connect(a.cookie);

    ca.clear();
    ca.send({ t: 'ping', ts: 1234567 });
    const pong = await ca.waitFor('pong');
    assert.equal(pong.ts, 1234567, 'ts 必须原样带回来');

    // 不在任何房间里也要能心跳（登录页/首页就靠它保活）
    ca.close();
  });
});

/* ============================== 邀请 ============================== */

describe('邀请', () => {
  it('只能邀请好友；接受即入座，邀请人收到回执', async () => {
    const a = await registerUser('邀');
    const b = await registerUser('请');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    // 先成为好友（申请 → 同意）
    const after = await befriend(ca, cb, a.me.id, b.me.id);
    expectIds(after.a, { list: [b.me.id] });

    // 建房
    ca.clear();
    ca.send({ t: 'room.create', game: 'fake-game' });
    const code = (await ca.waitFor('room.state')).code;

    // 一键邀请
    cb.clear();
    ca.send({ t: 'invite.send', to: [b.me.id], code });
    const invite = await cb.waitFor('invite');
    assert.equal(invite.code, code);
    assert.equal(invite.from.id, a.me.id);
    assert.equal(invite.game, 'fake-game');

    // 非好友收不到邀请
    const c = await registerUser('陌');
    const cc = await connect(c.cookie);
    cc.clear();
    ca.send({ t: 'invite.send', to: [c.me.id], code });
    // 甲这边会收到"一个都没发出去"
    assert.match((await ca.waitFor('error')).message, /一个都没发出去/);
    assert.deepEqual(cc.received.filter((m) => m.t === 'invite'), []);

    // 接受 → 直接入座
    ca.clear();
    cb.clear();
    cb.send({ t: 'invite.reply', from: a.me.id, code, accept: true });
    const roomB = await cb.waitFor('room.state');
    assert.equal(roomB.members.length, 2);

    const reply = await ca.waitFor('invite.reply');
    assert.equal(reply.accept, true);
    assert.equal(reply.from.id, b.me.id);

    ca.close(); cb.close(); cc.close();
  });

  it('不是好友就邀请不进来（哪怕只差"还没同意"这一步）', async () => {
    const a = await registerUser('门');
    const b = await registerUser('外');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);

    // 甲发了申请，乙**还没同意** —— 这时候他们不是好友
    ca.clear();
    ca.send({ t: 'friend.add', id: b.me.id });
    await ca.waitFor('friends');
    await cb.waitFor('friends');

    ca.clear();
    ca.send({ t: 'room.create', game: 'fake-game' });
    const code = (await ca.waitFor('room.state')).code;

    cb.clear();
    ca.send({ t: 'invite.send', to: [b.me.id], code });
    assert.match((await ca.waitFor('error')).message, /一个都没发出去/);
    assert.deepEqual(cb.received.filter((m) => m.t === 'invite'), [], '还没同意的人收不到邀请');

    // 邀请.reply 这条路也拦得住：不是好友就不给回执
    cb.clear();
    ca.clear();
    cb.send({ t: 'invite.reply', from: a.me.id, code, accept: false });
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(ca.received.filter((m) => m.t === 'invite.reply'), []);

    ca.close(); cb.close();
  });
});

/* ============================== 无名杀：账号绑定 ============================== */

describe('无名杀接入', () => {
  it('没登录不能上报状态，也不能读好友', async () => {
    const state = await call('/api/noname/state', { body: { room: 'ROOM1' } });
    assert.equal(state.status, 401);
    const friends = await call('/api/noname/friends');
    assert.equal(friends.status, 401);
  });

  it('好友列表能看到「正在玩无名杀」，开局且允许观战时 joinable', async () => {
    const a = await registerUser('无名甲');
    const b = await registerUser('无名乙');
    const ca = await connect(a.cookie);
    const cb = await connect(b.cookie);
    await befriend(ca, cb, a.me.id, b.me.id);

    cb.clear();
    const pushed = await call('/api/noname/state', {
      cookie: a.cookie,
      body: { room: 'ROOM1', mode: '身份局', started: true, observe: true, count: 4 },
    });
    assert.equal(pushed.status, 200);
    assert.equal(pushed.data.playing, true);

    const snap = await cb.waitFor('friends');
    const row = snap.list.find((f) => f.id === a.me.id);
    assert.equal(row.online, true, '只在无名杀里在线的人，好友列表也要显示在线');
    assert.equal(row.playing.game, 'noname');
    assert.equal(row.playing.code, 'ROOM1');
    assert.equal(row.playing.phase, 'playing');
    assert.equal(row.playing.joinable, true);
    assert.match(row.avatar, /^\/avatar\//, '好友列表要带头像地址');

    // 开局但房主没开「允许观战」→ 不可点
    cb.clear();
    await call('/api/noname/state', {
      cookie: a.cookie,
      body: { room: 'ROOM1', started: true, observe: false },
    });
    const snap2 = await cb.waitFor('friends');
    assert.equal(snap2.list.find((f) => f.id === a.me.id).playing.joinable, false);

    // 从无名杀里发邀请：房号是它自己的，不是平台 6 位短码
    ca.clear();
    cb.clear();
    const invite = await call('/api/noname/invite', {
      cookie: a.cookie,
      body: { room: 'ROOM1', mode: '身份局', to: [b.me.id] },
    });
    assert.equal(invite.status, 200, JSON.stringify(invite.data));
    assert.equal(invite.data.sent, 1);
    const got = await cb.waitFor('invite');
    assert.equal(got.game, 'noname');
    assert.equal(got.code, 'ROOM1');
    assert.equal(got.from.id, a.me.id);
    assert.match(got.from.avatar, /^\/avatar\//);

    // 接受：只转发回执，**不许**走平台房间层（房号格式根本不同）
    cb.send({ t: 'invite.reply', from: a.me.id, code: 'ROOM1', accept: true, game: 'noname' });
    const reply = await ca.waitFor('invite.reply');
    assert.equal(reply.game, 'noname');
    assert.equal(reply.accept, true);
    assert.equal(reply.from.id, b.me.id);
    assert.deepEqual(cb.received.filter((m) => m.t === 'room.state'), [], '接受无名杀邀请不该把乙拉进平台房间');

    // 离开房间：状态清掉，好友看到的不再是"正在玩"
    cb.clear();
    await call('/api/noname/state', { cookie: a.cookie, body: { room: '' } });
    const snap3 = await cb.waitFor('friends');
    assert.equal(snap3.list.find((f) => f.id === a.me.id).playing, null);

    ca.close(); cb.close();
  });

  it('非好友邀请不出去；房号格式不对要被拒', async () => {
    const a = await registerUser('独行');
    const b = await registerUser('路人');
    await connect(b.cookie).then((c) => c.close());

    const bad = await call('/api/noname/invite', { cookie: a.cookie, body: { room: '有中文的房号', to: [b.me.id] } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.message, /先建房|房间/);

    const notFriend = await call('/api/noname/invite', {
      cookie: a.cookie,
      body: { room: 'ROOM1234', to: [b.me.id] },
    });
    assert.equal(notFriend.status, 200);
    assert.equal(notFriend.data.sent, 0, '不是好友，一个都不该发出去');
  });
});

/* ============================== 头像上传 ============================== */

describe('头像', () => {
  // 只要魔术字节对、长度 ≥12 就会被接收（服务端不解码图片，只做防伪装校验）
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

  it('上传 PNG 后 /avatar 返回的就是这份字节；恢复默认变回 SVG', async () => {
    const { cookie, me } = await registerUser('图');
    const url = (path) => new URL(path, app.url);

    const up = await fetch(url('/api/avatar'), {
      method: 'POST',
      headers: { cookie, 'content-type': 'image/png' },
      body: PNG,
    });
    const upData = await up.json();
    assert.equal(up.status, 200, JSON.stringify(upData));
    assert.equal(upData.ok, true);
    assert.notEqual(upData.me.avatar, me.avatar, '换头像后地址里的版本号要变（破缓存）');

    const img = await fetch(url(upData.me.avatar));
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);

    // 伪装成图片的文本必须被拒（只认魔术字节）
    const fake = await fetch(url('/api/avatar'), {
      method: 'POST',
      headers: { cookie, 'content-type': 'image/png' },
      body: 'not really a png',
    });
    assert.equal(fake.status, 400);

    const del = await fetch(url('/api/avatar'), { method: 'DELETE', headers: { cookie } });
    const delData = await del.json();
    assert.equal(del.status, 200);
    assert.notEqual(delData.me.avatar, upData.me.avatar, '恢复默认也要换版本号（否则浏览器还在用旧图）');
    assert.match(delData.me.avatar, /^\/avatar\/[A-Z0-9]{7}\?v=\d+$/);
    const fallback = await fetch(url(delData.me.avatar));
    assert.equal(fallback.status, 200);
    assert.match(fallback.headers.get('content-type'), /image\/svg\+xml/);
  });

  it('没登录不能上传头像', async () => {
    const res = await fetch(new URL('/api/avatar', app.url), { method: 'POST', body: PNG });
    assert.equal(res.status, 401);
  });
});

/* ============================== 存储：老数据库兼容 ============================== */

describe('存储', () => {
  it('老库（只有 friends 表、没有申请表）直接升级：不清库，老好友关系照旧', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frp-old-db-'));
    const dbPath = join(dir, 'old.db');

    // 1. 按**改之前**的表结构造一个库，塞进一条老的（双向）好友关系
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE friends (
        user_id TEXT NOT NULL, friend_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, friend_id)
      );
    `);
    const insUser = old.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)');
    insUser.run('AAAAAAA', '甲', 'x', 'y', 1);
    insUser.run('BBBBBBB', '乙', 'x', 'y', 1);
    const insFriend = old.prepare('INSERT INTO friends VALUES (?, ?, ?)');
    insFriend.run('AAAAAAA', 'BBBBBBB', 1);
    insFriend.run('BBBBBBB', 'AAAAAAA', 1);
    old.close();

    // 2. 用现在的代码打开它：老数据必须原样还在，而且一张行都不用改
    const store = openStore(dbPath);
    try {
      assert.deepEqual(
        store.listFriends('AAAAAAA').map((f) => f.id),
        ['BBBBBBB'],
        '老库里的好友行必须继续算好友（不能清库）'
      );
      assert.deepEqual(store.listIncomingRequests('AAAAAAA'), [], '老库刚打开时没有待处理申请');

      // 新表的接口在同一个库上直接可用
      store.createFriendRequest('AAAAAAA', 'BBBBBBB');
      assert.ok(store.findFriendRequest('AAAAAAA', 'BBBBBBB'), '申请要能落库');
      assert.deepEqual(store.listOutgoingRequests('AAAAAAA').map((r) => r.id), ['BBBBBBB']);
      store.deleteFriendRequestsBetween('AAAAAAA', 'BBBBBBB');
      assert.deepEqual(store.listOutgoingRequests('AAAAAAA'), [], '两个方向的申请都要能一起清掉');

      // 同意之后双向成为好友（老关系不动）
      store.addFriend('AAAAAAA', 'BBBBBBB');
      assert.deepEqual(store.listFriends('BBBBBBB').map((f) => f.id), ['AAAAAAA']);
      store.removeFriend('AAAAAAA', 'BBBBBBB');
      assert.deepEqual(store.listFriends('AAAAAAA'), []);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});