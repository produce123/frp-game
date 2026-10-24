/*
 * 斗地主 · 平台集成测试（真 HTTP + 真 WebSocket 帧 + 真房间层）。
 *
 *   node --test tests/ddz.test.mjs
 *
 * 覆盖的是"这个游戏有没有真的接在平台上"：
 *   · `/ddz/` 的登录门（未登录 302 回平台登录页、登录后 200）与唯一地址（/games/ddz 不出）
 *   · 牌桌（Godot 导出，`/ddz/table/`）也是登录门保护的，二进制资源不拦
 *   · 42 MB 的 wasm 走 gzip + ETag 协商（不压的话手机上要下一分多钟）
 *   · 服务端自动接上了 `server/games/ddz.mjs`（/api/me 的 games 里有 ddz）
 *   · 房间层：三人座位、`maxBots = 0` 不许加人机、开局后进不来、房主开局/再来一局
 *   · **服务器权威**：每个客户端拿到的 view 里没有别人的手牌；乱序出牌按牌型判
 *   · 一整局能打完（叫地主 → 抢地主 → 出牌 → 结算），结算后不能再操作
 *   · 中途有人离开 → 本局作废，不是把剩下两家挂死
 *
 * ⚠️ 引擎自己另有更细的单测（games/ddz/tests/engine.test.mjs）。
 * ⚠️ 真浏览器那一条在 tests/ddz.browser.mjs（牌桌是 WebAssembly，只有真浏览器认得出来）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { startServer } from '../server/server.mjs';
import { T } from '../shared/protocol.mjs';
import { canBeat, classify } from '../games/ddz/js/engine/rules.js';
import { wsConnect } from './ws-client.mjs';

let app;
let tmpDir;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'frp-ddz-test-'));
  app = await startServer({
    port: 0,
    dbPath: join(tmpDir, 'ddz.db'),
    statePath: join(tmpDir, 'server.json'),
  });
});

after(async () => {
  if (app) await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/* ============================== 工具 ============================== */

/** 发一个 HTTP 请求（cookie 手动带，Node 的 fetch 不保存）。 */
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
  return {
    status: res.status,
    data,
    cookie: sid,
    location: res.headers.get('location'),
    contentType: res.headers.get('content-type'),
  };
}

/** 注册一个用户，返回 { cookie, me }。 */
async function registerUser(name, password = 'secret123') {
  const res = await call('/api/register', { body: { name, password } });
  assert.equal(res.status, 200, `注册失败：${JSON.stringify(res.data)}`);
  assert.ok(res.cookie, '注册应该返回会话 cookie');
  return { cookie: res.cookie, me: res.data.me };
}

/** 用 cookie 连上 WebSocket，并等 ready / friends。 */
async function connect(cookie) {
  const client = await wsConnect({ port: app.port, cookie });
  client.me = (await client.waitFor('ready')).me;
  await client.waitFor('friends');
  return client;
}

/** 等这三个客户端各收到一条 room.state（房间层每次变化都会给每个成员推一份）。 */
function nextStates(clients) {
  return Promise.all(clients.map((client) => client.waitFor('room.state')));
}

/** 单个客户端等一条满足条件的 room.state。 */
function waitState(client, predicate, timeoutMs = 4000) {
  return client.waitFor((m) => m.t === 'room.state' && predicate(m), timeoutMs);
}

/** 这一手轮到谁 —— 换成那个客户端。 */
function actorOf(clients, states, seat) {
  const index = states.findIndex((s) => s.view && s.view.seat === seat);
  assert.ok(index >= 0, `找不到座位 ${seat} 的客户端`);
  return clients[index];
}

/**
 * 叫地主 / 抢地主推到定地主。
 *
 * 口径（照引擎）：叫阶段谁先被问谁叫（其余不叫）；抢阶段默认都不抢，
 * 所以**叫的人当上地主**。传 `{ robber: true }` 就让两家都抢 —— 最后一个抢的人当地主。
 */
async function bidToLandlord(clients, states, { robber = false } = {}) {
  let current = states;
  for (let step = 0; step < 40; step += 1) {
    const view = current[0].view;
    if (!view || view.phase !== 'bidding') return current;
    const seat = view.turn;
    const isCall = view.stage === 'call';
    // 叫阶段：只有第一个被问的人叫；抢阶段：robber 就抢，否则不抢
    const value = isCall ? (view.bids.length === 0 ? 1 : 0) : robber ? 1 : 0;
    const actor = actorOf(clients, current, seat);
    actor.send({ t: T.ROOM_ACT, act: { type: 'bid', value } });
    current = await nextStates(clients);
  }
  throw new Error('叫地主阶段推不完');
}

/**
 * 从服务器推下来的状态里挑出"这一手能出的牌"。
 * 只用来驱动测试 —— 和界面共用同一份 rules.js（这本身也是一条验证：
 * 客户端能算出来的牌型，服务器必须认）。
 */
function pickMove(view) {
  const prev = view.lastPlay
    ? { type: view.lastPlay.type, rank: view.lastPlay.rank, len: view.lastPlay.len }
    : null;
  const hand = view.hand;

  const byRank = new Map();
  for (const card of hand) {
    if (!byRank.has(card.r)) byRank.set(card.r, []);
    byRank.get(card.r).push(card);
  }
  const groups = [];
  for (const card of hand) groups.push([card]);
  for (const group of byRank.values()) {
    if (group.length >= 2) groups.push(group.slice(0, 2));
    if (group.length >= 3) groups.push(group.slice(0, 3));
    if (group.length === 4) groups.push(group.slice(0, 4));
  }
  groups.sort((a, b) => a.length - b.length || a[0].r - b[0].r);

  for (const group of groups) {
    const info = classify(group);
    if (!info) continue;
    if (prev && !canBeat(prev, info)) continue;
    return group;
  }
  return null;
}

/** 打完一整局：叫地主阶段第一家叫，出牌阶段能压就压、不能压就不出。 */
async function playToEnd(clients, initialStates) {
  let states = initialStates;
  for (let step = 0; step < 600; step += 1) {
    const view = states[0].view;
    if (!view || view.phase === 'over') return states;

    const seat = view.turn;
    const actor = actorOf(clients, states, seat);
    const mine = states.find((s) => s.view.seat === seat).view;

    if (view.phase === 'bidding') {
      const value = view.stage === 'call' ? (view.bids.length === 0 ? 1 : 0) : 0;
      actor.send({ t: T.ROOM_ACT, act: { type: 'bid', value } });
    } else {
      const move = pickMove(mine);
      if (move) actor.send({ t: T.ROOM_ACT, act: { type: 'play', cards: move.map((c) => c.id) } });
      else actor.send({ t: T.ROOM_ACT, act: { type: 'pass' } });
    }

    states = await nextStates(clients);
  }
  assert.fail('600 步还没打完，牌局可能卡住了');
}

/** 建一间三人房并开局，返回 { clients, states, code } */
async function startTable(prefix) {
  const users = [];
  for (let i = 0; i < 3; i += 1) users.push(await registerUser(`${prefix}${i}`));
  const clients = [await connect(users[0].cookie), await connect(users[1].cookie), await connect(users[2].cookie)];

  clients[0].send({ t: T.ROOM_CREATE, game: 'ddz' });
  const created = await clients[0].waitFor('room.state');
  const code = created.code;
  assert.equal(code.length, 6);

  clients[1].send({ t: T.ROOM_JOIN, code });
  // 乙进来时，房间里只有甲、乙两个人 —— 只有他们两个会收到广播。
  await Promise.all([clients[0].waitFor('room.state'), clients[1].waitFor('room.state')]);

  clients[2].send({ t: T.ROOM_JOIN, code });
  await nextStates(clients);

  clients[0].send({ t: T.ROOM_START, options: {} });
  const states = await nextStates(clients);
  return { clients, states, code, users };
}

/* ============================== 静态入口与登录门 ============================== */

describe('入口 /ddz/ · 登录门与唯一地址', () => {
  it('未登录访问 /ddz/ 会被带回平台登录页，并带 return', async () => {
    const res = await call('/ddz/');
    assert.equal(res.status, 302);
    assert.match(res.location, /^\/\?return=/);
    assert.ok(decodeURIComponent(res.location).includes('/ddz/'));
  });

  it('未登录访问 /ddz（没尾斜杠）也先过登录门', async () => {
    const res = await call('/ddz');
    assert.equal(res.status, 302);
    assert.match(res.location, /^\/\?return=/);
  });

  it('登录后 /ddz/ 是 200，页面里没有"起昵称"的输入框', async () => {
    const { cookie } = await registerUser('斗地主甲');
    const res = await call('/ddz/', { cookie });
    assert.equal(res.status, 200);
    assert.equal(res.contentType.includes('text/html'), true);
    assert.match(res.data, /斗地主/);
    // 复用平台那套外壳：协议、网络层、房间组件、头像交互
    for (const asset of ['/shared/protocol.mjs', '/shared/net/net.js', '/shared/ui/room.js', 'js/online.js']) {
      assert.ok(res.data.includes(asset), '页面应该加载 ' + asset);
    }
    // 牌桌是 Godot 导出的 iframe（上游界面），不是这里手画的；
    // 具体地址写在 js/online.js 里（下面那条用例查）
    assert.match(res.data, /id="ddz-table"/);
    // D33/D34：游戏里没有昵称输入框，身份只有平台账号
    assert.ok(!/<input/i.test(res.data), '页面里不该有 <input（输入昵称/改名字用）');
  });

  it('资源不拦登录（拦了会在加载中途 302，表现成白屏）', async () => {
    const css = await call('/ddz/css/table.css');
    assert.equal(css.status, 200);
    assert.equal(css.contentType.includes('text/css'), true);

    const js = await call('/ddz/js/online.js');
    assert.equal(js.status, 200);
    assert.equal(js.contentType.includes('javascript'), true);
    // 牌桌地址就写在这里：/ddz/table/index.html（Godot 导出的入口）
    assert.match(js.data, /\/ddz\/table\/index\.html/);

    // 牌桌的二进制资源：不拦登录，但也不该被当成页面
    const wasm = await call('/ddz/table/index.wasm', { method: 'HEAD' });
    assert.equal(wasm.status, 200);
  });

  it('牌桌页面（iframe）也要登录：没登录 302，登录后 200', async () => {
    const anonymous = await call('/ddz/table/index.html');
    assert.equal(anonymous.status, 302);
    assert.match(anonymous.location, /^\/\?return=/);

    const { cookie } = await registerUser('看牌桌的');
    const logged = await call('/ddz/table/index.html', { cookie });
    assert.equal(logged.status, 200);
    assert.equal(logged.contentType.includes('text/html'), true);
    assert.match(logged.data, /Godot/i, '这是 Godot 的网页导出');
  });

  it('42 MB 的 wasm 会走 gzip + ETag（隧道上差一个数量级）', async () => {
    const url = new URL('/ddz/table/index.wasm', app.url);
    const res = await fetch(url, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), 'gzip', 'wasm 必须压：42 MB → 9 MB');
    assert.equal(res.headers.get('cache-control'), 'public, no-cache', '要能协商，不能缓存死');
    const etag = res.headers.get('etag');
    assert.ok(etag && etag.length > 4, '要有 ETag');
    await res.arrayBuffer();

    // 带着 ETag 再要一次 → 304，一个字节都不用重发
    const again = await fetch(url, { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
  });

  it('牌桌的 pck 不 gzip，但同样走 ETag 协商', async () => {
    const url = new URL('/ddz/table/index.pck', app.url);
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('cache-control'), 'public, no-cache');
    const etag = head.headers.get('etag');
    assert.ok(etag, 'pck 也要 ETag');
    const again = await fetch(url, { method: 'HEAD', headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
  });

  it('手机壳 /play/ddz 是平台自己的页面（不是静态文件）', async () => {
    const { cookie } = await registerUser('看手机壳的');
    const res = await call('/play/ddz', { cookie });
    assert.equal(res.status, 200);
    assert.equal(res.contentType.includes('text/html'), true);
    // 电脑打开时会自己 replace 回 /ddz/；手机上套一层横过来的 iframe
    assert.match(res.data, /location\.replace\('\/ddz\/'/);
    assert.match(res.data, /rotate\(90deg\)/);
  });

  it('只有一个地址：/games/ddz/ 一个文件都不出（两套地址会互相打架）', async () => {
    const { cookie } = await registerUser('斗地主乙');
    for (const path of ['/games/ddz/', '/games/ddz/index.html', '/games/ddz/css/table.css', '/games/ddz/table/index.html']) {
      const res = await call(path, { cookie });
      assert.equal(res.status, 404, path + ' 不该被发出来');
    }
  });

  it('/api/me 的游戏清单里有 ddz（服务端自动接上了）', async () => {
    const { cookie } = await registerUser('斗地主丙');
    const res = await call('/api/me', { cookie });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.games));
    assert.ok(res.data.games.includes('ddz'), '服务端应该加载到 server/games/ddz.mjs：' + JSON.stringify(res.data.games));
  });
});

/* ============================== 房间层 ============================== */

describe('房间层 · 三个真人，没有电脑', () => {
  it('建房：3 个座位、maxBots = 0、人机加不进来', async () => {
    const { cookie } = await registerUser('建房的人');
    const client = await connect(cookie);
    try {
      client.send({ t: T.ROOM_CREATE, game: 'ddz' });
      const state = await client.waitFor('room.state');
      assert.equal(state.game, 'ddz');
      assert.equal(state.phase, 'waiting');
      assert.equal(state.minSeats, 3);
      assert.equal(state.maxSeats, 3);
      assert.equal(state.maxBots, 0, '斗地主没有电脑，界面据此不画「添加人机」');
      assert.equal(state.view, null, '还没开局，没有 view');
      assert.equal(state.members.length, 1);

      client.send({ t: T.ROOM_BOT_ADD });
      const error = await client.waitFor('error');
      assert.match(error.message, /没有电脑/);

      client.send({ t: T.ROOM_START, options: {} });
      const notEnough = await client.waitFor('error');
      assert.match(notEnough.message, /座位不够/);
      assert.ok(!/人机/.test(notEnough.message), '没有电脑的游戏不该让人去加人机：' + notEnough.message);

      client.send({ t: T.ROOM_LEAVE });
    } finally {
      client.close();
    }
  });

  it('三个人坐下开局：每人 17 张；底牌保密；报文里没有别人的牌', async () => {
    const { clients, states } = await startTable('开局');
    try {
      states.forEach((state) => {
        assert.equal(state.game, 'ddz');
        assert.ok(state.view, '开局后应该有裁剪过的 view');
        assert.equal(state.members.length, 3);
        assert.ok(state.members.every((m) => m.isBot === false), '三个人都必须是真的');
        assert.equal(state.view.phase, 'bidding');
        assert.equal(state.view.stage, 'call');
        assert.equal(state.view.hand.length, 17, '叫地主阶段三个人都是 17 张');
        assert.equal(state.view.bottom, null, '叫地主阶段底牌对谁都是保密的');
        assert.equal(state.view.landlord, null, '叫地主阶段还没有地主');
        // 没有倍数/底分这些东西（用户拍板：不打钱）
        assert.equal(state.view.base, undefined);
        assert.equal(state.view.multiplier, undefined);
      });

      // 第一家叫地主 → 进入抢地主；两家都不抢 → 叫的人当上地主
      const settled = await bidToLandlord(clients, states);
      const view = settled[0].view;
      assert.equal(view.phase, 'playing');
      assert.notEqual(view.landlord, null);
      assert.equal(view.turn, view.landlord, '地主先出牌');
      assert.equal(settled.find((s) => s.view.seat === view.landlord).view.hand.length, 20);
      settled
        .filter((s) => s.view.seat !== view.landlord)
        .forEach((s) => assert.equal(s.view.hand.length, 17, '农民还是 17 张'));
      assert.equal(view.bottom.length, 3, '定完地主之后底牌公开给所有人');

      // 每个客户端的报文里都不许出现别人的**手牌** id。
      // 底牌和最近一手打出的牌是公开信息，不算泄漏。
      const publicIds = new Set([
        ...view.bottom.map((c) => c.id),
        ...((view.lastPlay && view.lastPlay.cards) || []).map((c) => c.id),
      ]);
      const ids = settled.map((s) => s.view.hand.filter((c) => !publicIds.has(c.id)).map((c) => c.id));
      settled.forEach((state, i) => {
        const json = JSON.stringify(state);
        ids.forEach((list, j) => {
          if (i === j) return;
          for (const id of list) {
            assert.ok(!json.includes('"' + id + '"'), `座位 ${i} 的报文里出现了座位 ${j} 的牌 ${id}`);
          }
        });
      });

      // 别人的"牌"只以张数出现
      for (const player of view.players) {
        assert.equal(typeof player.count, 'number');
        assert.equal(player.hand, undefined);
      }
    } finally {
      clients.forEach((c) => c.close());
    }
  });

  it('抢地主：后抢的那家把地主抢走（服务器说了算）', async () => {
    const { clients, states } = await startTable('抢地主');
    try {
      const callerSeat = states[0].view.turn;
      const settled = await bidToLandlord(clients, states, { robber: true });
      const view = settled[0].view;
      assert.equal(view.phase, 'playing');
      // 抢的顺序是候选之后的两家，最后一个抢的人当地主 → 候选的上家
      assert.equal(view.landlord, (callerSeat + 2) % 3);
      assert.equal(settled.find((s) => s.view.seat === view.landlord).view.hand.length, 20);
    } finally {
      clients.forEach((c) => c.close());
    }
  });

  it('开局之后第四个人进不来', async () => {
    const { clients, code } = await startTable('锁房');
    const extra = await registerUser('想插队的');
    const late = await connect(extra.cookie);
    try {
      late.send({ t: T.ROOM_JOIN, code });
      const error = await late.waitFor('error');
      assert.match(error.message, /房间满了|已经开始|进不去/);
    } finally {
      late.close();
      clients.forEach((c) => c.close());
    }
  });
});

/* ============================== 整局 ============================== */

describe('一整局 · 服务器说了算', () => {
  it('能从头打到结算；结算后不能再操作；房主能再来一局', async () => {
    const { clients, states } = await startTable('整局');
    try {
      const final = await playToEnd(clients, states);
      const view = final[0].view;
      assert.equal(view.phase, 'over');
      assert.ok(view.winner, '结算要有赢家和阵营');
      assert.ok(['landlord', 'farmers'].includes(view.winner.side));
      if (view.winner.side === 'landlord') assert.deepEqual(view.winner.seats, [view.landlord]);
      assert.ok(final.every((s) => s.view.phase === 'over'), '三家看到的都是"结束了"');
      assert.equal(view.aborted, null, '正常打完不是作废');

      // 结算之后谁也不能再动
      const seat = view.turn === null ? 0 : view.turn;
      const myView = final.find((s) => s.view.seat === seat).view;
      const actor = actorOf(clients, final, seat);
      const card = myView.hand[0];
      actor.send({ t: T.ROOM_ACT, act: card ? { type: 'play', cards: [card.id] } : { type: 'pass' } });
      const rejected = await actor.waitFor('error');
      // 房间层在 over 阶段已经不接受操作了（"现在不能操作"）；
      // 引擎自己也会拒（"这局已经结束了"）。两种都算对，关键是别静默吞掉。
      assert.match(rejected.message, /不能操作|结束|作废/);

      // 房主再来一局 → 回到等待态，三个人还坐着
      clients[0].send({ t: T.ROOM_RESET });
      const waiting = await clients[0].waitFor('room.state');
      assert.equal(waiting.phase, 'waiting');
      assert.equal(waiting.view, null);
      assert.equal(waiting.members.length, 3);
    } finally {
      clients.forEach((c) => c.close());
    }
  });

  it('有人中途离开 → 本局作废，另外两家不会挂死', async () => {
    const { clients, states } = await startTable('作废');
    try {
      assert.equal(states[0].view.phase, 'bidding');
      // 先叫地主把牌局推进到出牌，再让人离开（更接近真实：打到一半掉线）
      await bidToLandlord(clients, states);

      clients[1].send({ t: T.ROOM_LEAVE });
      const left = await waitState(clients[0], (m) => m.phase === 'over' && m.view && m.view.aborted);
      assert.equal(left.phase, 'over');
      assert.match(left.view.aborted, /离开了这一局/);
      assert.equal(left.view.winner, null, '作废不是"谁赢了"');

      // 剩下的人还能再来一局（座位里少了一个人，等有人补进来才能开）
      clients[0].send({ t: T.ROOM_RESET });
      const waiting = await clients[0].waitFor('room.state');
      assert.equal(waiting.phase, 'waiting');
      assert.equal(waiting.members.length, 2);
    } finally {
      clients.forEach((c) => c.close());
    }
  });

  it('轮到谁出牌是服务器判的：不是你的回合发操作会被拒', async () => {
    const { clients, states } = await startTable('回合');
    try {
      let current = await bidToLandlord(clients, states);
      const view = current[0].view;
      assert.equal(view.phase, 'playing');
      const notTurn = (view.turn + 1) % 3;
      const client = actorOf(clients, current, notTurn);
      const mine = current.find((s) => s.view.seat === notTurn).view.hand[0];
      client.send({ t: T.ROOM_ACT, act: { type: 'play', cards: [mine.id] } });
      const error = await client.waitFor('error');
      assert.match(error.message, /还没轮到你/);
    } finally {
      clients.forEach((c) => c.close());
    }
  });

  it('出别人的牌会被拒：服务器只认"你手里有什么"', async () => {
    const { clients, states } = await startTable('偷牌');
    try {
      const current = await bidToLandlord(clients, states);
      const view = current[0].view;
      const landlordSeat = view.landlord;
      const landlord = actorOf(clients, current, landlordSeat);
      const otherSeat = (landlordSeat + 1) % 3;
      const mineIds = new Set(current.find((s) => s.view.seat === landlordSeat).view.hand.map((c) => c.id));
      const foreign = current
        .find((s) => s.view.seat === otherSeat)
        .view.hand.map((c) => c.id)
        .find((id) => !mineIds.has(id));
      assert.ok(foreign, '总能找到一张不在自己手里的牌');
      landlord.send({ t: T.ROOM_ACT, act: { type: 'play', cards: [foreign] } });
      const error = await landlord.waitFor('error');
      assert.match(error.message, /不在你手里/);
    } finally {
      clients.forEach((c) => c.close());
    }
  });
});