/*
 * 狼人杀 · 平台集成测试（真 HTTP + 真 WebSocket 帧 + 真 SQLite）。
 *
 *   node --test tests/werewolf.test.mjs
 *
 * 这一层测的是"有没有真的接在平台上"：
 *   · `/werewolf/` 的登录门（未登录 302、登录后 200）
 *   · 身份只认会话 cookie（伪造 header 没用）
 *   · 建房 / 加入 / 满员 / 密码 / 好友免密 / 开局后进不来
 *   · **视图裁剪**：任何人的 `/game/status` 里都没有别人的底牌
 *   · 好友邀请：`invite.send` → 对方收到 6 位房号，点接受就能进（免密码）
 *   · 一整局能打到结束，写进 `game_records`，且只有参与者能复盘
 *
 * 规则细节（守卫/女巫/警长/PK/白痴/猎人/白狼王）在
 * `tests/werewolf.engine.test.mjs` 里，这一层不重复。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { startServer } from '../server/server.mjs';
import { T } from '../shared/protocol.mjs';
import { wsConnect } from './ws-client.mjs';

let app;
let tmpDir;

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'frp-werewolf-test-'));
  app = await startServer({
    port: 0,
    // 测试要在一个进程里造几十个账号：关掉登录/注册限流（限流本身由 security.test.mjs 专门测）
    authLimitPerMinute: 0,
    dbPath: join(tmpDir, 'ww.db'),
    statePath: join(tmpDir, 'server.json'),
    // 把 180 秒的发言缩成 1.8 秒：测试只驱动"该谁动"，不真的等三分钟
    werewolfTimeoutScale: 0.01,
  });
});

after(async () => {
  if (app) await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
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
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  const sid = (res.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('sid=') && c.length > 4);
  return { status: res.status, data, cookie: sid, headers: res.headers, text };
}

/** 注册一个账号（返回 id + cookie）。 */
async function register(name) {
  const res = await call('/api/register', { body: { name, password: 'secret123' } });
  assert.equal(res.status, 200, `注册失败：${res.text}`);
  return { id: res.data.me.id, name, cookie: res.cookie };
}

/** 直接改库加好友（好友申请流程在 room 测试里已经覆盖）。 */
function befriend(a, b) {
  app.store.addFriend(a.id, b.id);
}

const ww = (path, user, body) => call(`/api/werewolf${path}`, { cookie: user.cookie, body });

async function createRoom(user, seats, password = '', roles, sheriff) {
  const res = await ww('/room/create', user, { seats, password, roles, sheriff });
  assert.equal(res.data.ok, true, `建房失败：${JSON.stringify(res.data)}`);
  return res.data.data.room.code;
}

async function status(user) {
  const res = await ww('/game/status', user);
  assert.equal(res.data.ok, true, `拉状态失败：${JSON.stringify(res.data)}`);
  return res.data.data;
}

/** 轮询等某个阶段（用视图判断）。 */
async function waitPhase(user, predicate, timeoutMs = 6000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await status(user);
    if (last.view && predicate(last.view)) return last.view;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等阶段超时，最后是 ${last && last.view && last.view.phase}`);
}

/** 拿到所有人的身份（测试当"上帝"用；用每个人自己的视图读自己的角色）。 */
async function readRoles(users) {
  const roles = new Map();
  for (const user of users) {
    const { view } = await status(user);
    roles.set(user.id, view.self.role);
    roles.set(`seat:${view.self.seat}`, { id: user.id, seat: view.self.seat, role: view.self.role });
  }
  return roles;
}

/* ============================== 登录门 ============================== */

describe('狼人杀 · 登录门与身份', () => {
  it('未登录访问 /werewolf/ 会被带回平台登录页；登录后能拿到页面', async () => {
    const anon = await call('/werewolf/');
    assert.equal(anon.status, 302);
    assert.match(String(anon.headers.get('location')), /return=%2Fwerewolf/);

    const user = await register('狼人甲');
    const page = await call('/werewolf/', { cookie: user.cookie });
    assert.equal(page.status, 200);
    assert.match(page.text, /werewolf\/_next/);
  });

  it('未登录调接口是 401；伪造身份头没用', async () => {
    const res = await call('/api/werewolf/me');
    assert.equal(res.status, 401);

    const forged = await call('/api/werewolf/me', {
      headers: { 'x-user-id': 'HACKER1', 'x-user-name': 'fake' },
    });
    assert.equal(forged.status, 401);
  });

  it('/api/werewolf/me 用平台账号（昵称/头像同源）', async () => {
    const user = await register('狼人乙');
    const res = await ww('/me', user);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.data.me.id, user.id);
    assert.equal(res.data.data.me.name, '狼人乙');
    assert.match(String(res.data.data.me.avatar), /^\/avatar\//);
    assert.equal(res.data.data.room, null);
  });
});

/* ============================== 房间 ============================== */

describe('狼人杀 · 建房 / 加入 / 开局', () => {
  it('建房给 6 位数字房号；满员才能开局；只有房主能开', async () => {
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await register(`开房${i}`));

    const code = await createRoom(users[0], 6);
    assert.match(code, /^\d{6}$/);

    const early = await status(users[0]);
    assert.equal(early.room.phase, 'waiting');
    assert.equal((await ww('/game/begin', users[0], {})).data.ok, false, '人没坐满不能开');

    for (let i = 1; i < 6; i++) {
      const joined = await ww('/room/join', users[i], { code });
      assert.equal(joined.data.ok, true, JSON.stringify(joined.data));
    }

    // 第 7 个人进不来（房满了）
    const extra = await register('挤不进来');
    const full = await ww('/room/join', extra, { code });
    assert.equal(full.data.ok, false);
    assert.match(full.data.message, /满/);

    // 非房主开局被拒
    const notHost = await ww('/game/begin', users[1], {});
    assert.equal(notHost.data.ok, false);

    const begin = await ww('/game/begin', users[0], {});
    assert.equal(begin.data.ok, true, JSON.stringify(begin.data));

    const playing = await status(users[0]);
    assert.equal(playing.room.phase, 'playing');
    assert.equal(playing.view.players.length, 6);

    // 开局后进不来，也不能退房
    const late = await ww('/room/join', extra, { code });
    assert.equal(late.data.ok, false);
    const leave = await ww('/room/leave', users[1], {});
    assert.equal(leave.data.ok, false);

    app.werewolf.reset();
  });

  it('密码：错密码进不去；好友的房免密码', async () => {
    const owner = await register('房主');
    const friend = await register('好友');
    const stranger = await register('陌生人');
    befriend(owner, friend);

    const code = await createRoom(owner, 6, 'pw123456');

    const bad = await ww('/room/join', stranger, { code, password: 'wrong' });
    assert.equal(bad.data.ok, false);
    assert.match(bad.data.message, /密码/);

    const friendJoin = await ww('/room/join', friend, { code });
    assert.equal(friendJoin.data.ok, true, '好友进房不该再要密码');

    app.werewolf.reset();
  });

  it('房主可以关掉警长：等候区记下 sheriff=false', async () => {
    const host = await register('无警长房主');
    const code = await createRoom(host, 6, '', undefined, false);
    const info = await status(host);
    assert.equal(info.view.lobby.sheriff, false);
    assert.equal(info.view.lobby.code, code);
    app.werewolf.reset();
  });

  it('自定义角色：房主配 4 人双狼局，等候区能看到配置，发牌就是这套', async () => {
    const users = [];
    for (let i = 0; i < 4; i++) users.push(await register(`自定义${i}`));
    const roles = { Werewolf: 2, Seer: 1, Villager: 1 };
    const code = await createRoom(users[0], 4, '', roles);
    for (let i = 1; i < 4; i++) await ww('/room/join', users[i], { code });

    const lobby = await status(users[0]);
    assert.deepEqual(lobby.view.lobby.roles, {
      Werewolf: 2,
      WhiteWolfKing: 0,
      EvilKnight: 0,
      WolfKing: 0,
      WolfBeauty: 0,
      Seer: 1,
      Witch: 0,
      Hunter: 0,
      Guard: 0,
      Idiot: 0,
      Knight: 0,
      Elder: 0,
      Gravekeeper: 0,
      Villager: 1,
    });

    const started = await ww('/game/begin', users[0], {});
    assert.equal(started.data.ok, true, JSON.stringify(started.data));
    const got = [];
    for (const user of users) got.push((await status(user)).view.self.role);
    assert.deepEqual(got.sort(), ['Seer', 'Villager', 'Werewolf', 'Werewolf'].sort());

    // 配置不合法时开房直接拒绝
    const bad = await ww('/room/create', users[0], { seats: 4, roles: { Werewolf: 0, Villager: 4 } });
    assert.equal(bad.data.ok, false);
    assert.match(bad.data.message, /狼人/);
    app.werewolf.reset();
  });

  it('视图裁剪：每个人的状态里都没有别人的底牌', async () => {
    const users = [];
    for (let i = 0; i < 8; i++) users.push(await register(`裁剪${i}`));
    const code = await createRoom(users[0], 8);
    for (let i = 1; i < 8; i++) await ww('/room/join', users[i], { code });
    await ww('/game/begin', users[0], {});

    for (const user of users) {
      const { view } = await status(user);
      const meId = view.self.id;
      // 狼人眼里：自己 + 狼队友看得到身份（夜里要合刀）；好人一个都看不到。
      const meIsWolf = view.private.alignment === 'wolf';
      const peerSeats = new Set((view.private.wolfTeammates || []).map((t) => t.seat));
      for (const player of view.players) {
        if (player.playerId === meId) {
          assert.ok(player.role, '自己的身份要能看到');
          assert.ok(player.alignment, '自己的阵营要能看到');
        } else if (meIsWolf && peerSeats.has(player.seat)) {
          assert.ok(player.role, `狼人要看得到 ${player.seat + 1} 号队友的身份`);
          assert.equal(player.alignment, 'wolf', '狼队友的阵营就是狼');
        } else {
          assert.equal(player.role, undefined, `不该看到别人的底牌（${player.seat + 1} 号）`);
          assert.equal(player.alignment, undefined, `不该看到别人的阵营（${player.seat + 1} 号）`);
        }
      }
      // 原始报文：好人手里连 "role" 字段都不该出现；狼人只多出狼队友那几条
      const raw = JSON.stringify(view.players.filter((p) => p.playerId !== meId));
      if (meIsWolf) {
        assert.equal(raw.split('"role"').length - 1, peerSeats.size, '狼人手里只多出狼队友的身份');
      } else {
        assert.equal(raw.includes('"role"'), false);
        assert.equal(raw.includes('"alignment"'), false);
      }
    }

    app.werewolf.reset();
  });

  it('房间变化会推 werewolf.event（只是叮咚，不带底牌）', async () => {
    const host = await register('推送房主');
    const guest = await register('推送客人');
    const code = await createRoom(host, 6);

    const client = await wsConnect({ port: app.port, cookie: host.cookie });
    await client.waitFor(T.READY);
    client.clear();

    await ww('/room/join', guest, { code });
    const event = await client.waitFor(T.WW_EVENT);
    assert.equal(event.code, code);
    assert.equal(event.event, 'sync');
    assert.equal(event.data, null);
    client.close();

    app.werewolf.reset();
  });
});

/* ============================== 邀请 ============================== */

describe('狼人杀 · 好友邀请', () => {
  it('邀请带上 6 位房号；好友点接受就进房，且免密码', async () => {
    const host = await register('邀请房主');
    const friend = await register('被邀请的');
    befriend(host, friend);

    const code = await createRoom(host, 6, 'pw654321');

    const hostClient = await wsConnect({ port: app.port, cookie: host.cookie });
    await hostClient.waitFor(T.READY);
    const friendClient = await wsConnect({ port: app.port, cookie: friend.cookie });
    await friendClient.waitFor(T.READY);
    await friendClient.waitFor(T.FRIENDS);

    hostClient.send({ t: T.INVITE_SEND, to: [friend.id] });
    const invite = await friendClient.waitFor(T.INVITE);
    assert.equal(invite.game, 'werewolf');
    assert.equal(invite.code, code);
    assert.equal(invite.from.id, host.id);

    // 接受方页面会拿房号直接 join（不带密码）—— 好友免密
    const joined = await ww('/room/join', friend, { code: invite.code });
    assert.equal(joined.data.ok, true, JSON.stringify(joined.data));

    hostClient.close();
    friendClient.close();
    app.werewolf.reset();
  });
});

/* ============================== 整局 ============================== */

/** 用"上帝视角"把一整局推完（真人会自己点，这里只是测试脚本）。 */
async function playWholeGame(users) {
  const roles = new Map();
  for (const user of users) {
    const { view } = await status(user);
    roles.set(view.self.seat, { user, role: view.self.role, seat: view.self.seat });
  }
  const seatOf = (user) => [...roles.values()].find((r) => r.user.id === user.id).seat;

  for (let step = 0; step < 400; step++) {
    const { view } = await status(users[0]);
    if (!view) return;
    if (view.phase === 'GAME_END') return view;

    if (view.phase === 'NIGHT_GUARD_ACTION') {
      const guard = [...roles.values()].find((r) => r.role === 'Guard');
      if (guard) await ww('/game/act', guard.user, { type: 'guard', seat: null });
      continue;
    }
    if (view.phase === 'NIGHT_WOLF_ACTION') {
      const alive = new Set(view.players.filter((p) => p.alive).map((p) => p.seat));
      const wolves = [...roles.values()].filter((r) => r.role === 'Werewolf' || r.role === 'WhiteWolfKing');
      const target = [...roles.values()].find((r) => r.role === 'Villager' && alive.has(r.seat));
      if (target) {
        for (const wolf of wolves) await ww('/game/act', wolf.user, { type: 'wolf', seat: target.seat });
      }
      continue;
    }
    if (view.phase === 'NIGHT_WITCH_ACTION') {
      const witch = [...roles.values()].find((r) => r.role === 'Witch');
      const aliveWitch = witch && view.players.find((p) => p.seat === witch.seat)?.alive;
      if (aliveWitch) await ww('/game/act', witch.user, { type: 'witch', action: 'pass' });
      continue;
    }
    if (view.phase === 'NIGHT_SEER_ACTION') {
      const seer = [...roles.values()].find((r) => r.role === 'Seer');
      const wolf = [...roles.values()].find((r) => r.role === 'Werewolf' || r.role === 'WhiteWolfKing');
      if (seer && wolf) await ww('/game/act', seer.user, { type: 'seer', seat: wolf.seat });
      continue;
    }
    if (view.phase === 'DAY_BADGE_SIGNUP') {
      for (const r of roles.values()) await ww('/game/act', r.user, { type: 'signup', wants: false });
      continue;
    }
    if (
      view.phase === 'DAY_BADGE_SPEECH' ||
      view.phase === 'DAY_PK_SPEECH' ||
      view.phase === 'DAY_SPEECH' ||
      view.phase === 'DAY_LAST_WORDS'
    ) {
      const speaker = [...roles.values()].find((r) => r.seat === view.currentSpeakerSeat);
      if (speaker) await ww('/game/act', speaker.user, { type: 'endSpeech' });
      continue;
    }
    if (view.phase === 'DAY_BADGE_ELECTION') {
      for (const r of roles.values()) await ww('/game/act', r.user, { type: 'badgeVote', seat: null });
      continue;
    }
    if (view.phase === 'BADGE_TRANSFER' || view.phase === 'HUNTER_SHOOT') {
      const pendingSeat = view.players.find((p) => p.seat === view.self.seat) ? null : null;
      // 谁收到了行动视图就由谁做（`can` 里会告诉他自己能不能动）
      for (const r of roles.values()) {
        const { view: own } = await status(r.user);
        if (own.can.transfer) await ww('/game/act', r.user, { type: 'transfer', seat: null });
        if (own.can.hunter) await ww('/game/act', r.user, { type: 'hunter', seat: null });
      }
      void pendingSeat;
      continue;
    }
    if (view.phase === 'DAY_VOTE') {
      const alive = new Set(view.players.filter((p) => p.alive).map((p) => p.seat));
      const wolf = [...roles.values()].find(
        (r) => (r.role === 'Werewolf' || r.role === 'WhiteWolfKing') && alive.has(r.seat),
      );
      for (const r of roles.values()) {
        const { view: own } = await status(r.user);
        if (own.can.vote) {
          await ww('/game/act', r.user, { type: 'vote', seat: wolf ? wolf.seat : null });
        }
      }
      continue;
    }

    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('整局没打完');
}

describe('狼人杀 · 整局与复盘', () => {
  it('六个人能打完一局；只有参与者能看复盘', async () => {
    const users = [];
    for (let i = 0; i < 6; i++) users.push(await register(`整局${i}`));
    const code = await createRoom(users[0], 6);
    for (let i = 1; i < 6; i++) await ww('/room/join', users[i], { code });
    await ww('/game/begin', users[0], {});

    const end = await playWholeGame(users);
    assert.equal(end.phase, 'GAME_END');
    assert.ok(end.winner === 'wolf' || end.winner === 'village');

    // 参与者能读到自己的记录
    const records = await ww('/records', users[0]);
    assert.equal(records.data.ok, true);
    assert.ok(records.data.data.list.length >= 1, '打完应该有一条记录');
    const recordId = records.data.data.list[0].id;

    const detail = await call(`/api/werewolf/records/${recordId}`, { cookie: users[0].cookie });
    assert.equal(detail.data.ok, true);
    assert.equal(detail.data.data.record.players.length, 6);
    assert.ok(detail.data.data.record.players.every((p) => p.role && p.roleName));

    // 局外人读不到
    const outsider = await register('局外人');
    const forbidden = await call(`/api/werewolf/records/${recordId}`, { cookie: outsider.cookie });
    assert.equal(forbidden.data.ok, false);

    app.werewolf.reset();
  });
});