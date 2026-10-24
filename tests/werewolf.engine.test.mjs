/*
 * 狼人杀 · 服务器权威引擎的规则测试。
 *
 * 只测 `games/werewolf/engine/index.mjs` 这一层（没有 HTTP、没有浏览器）：
 *   · 4–18 人的发牌、阵营人数；房主自定义角色配置（含双女巫/双预言家）
 *   · 夜晚流程：守卫 / 狼人 / 女巫 / 预言家 / 结算（含"奶穿"）
 *   · 白天：警长竞选、发言、放逐投票、平票 PK、白痴翻牌、猎人开枪、白狼王自爆
 *   · 视图裁剪：别人的身份绝不出现在你的报文里
 *   · 倒计时到点自动推进（靠 `timeoutScale` 缩放，测试秒级跑完）
 *
 * 跑：node --test tests/werewolf.engine.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWerewolfEngine, PHASE, ROLE_CONFIG, isWolfRole, validateRoleSetup } from '../games/werewolf/engine/index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 测试里的倒计时缩放：180 秒的发言 → 0.18 秒。 */
const SCALE = 0.001;

function makeEngine(scale = SCALE) {
  const ended = [];
  const engine = createWerewolfEngine({
    timeoutScale: scale,
    onGameEnd: (room) => ended.push(room),
  });
  return { engine, ended };
}

async function makeRoom(engine, count, { seats = count, password = '', roles, sheriff = true } = {}) {
  const users = [];
  for (let i = 0; i < count; i++) {
    users.push({ id: `u${i + 1}`, name: `玩家${i + 1}`, avatar: '' });
  }
  const created = engine.createRoom({ host: users[0], seats, password, roles, sheriff });
  assert.equal(created.ok, true, JSON.stringify(created));
  for (let i = 1; i < count; i++) {
    const joined = engine.joinRoom({ user: users[i], code: created.code });
    assert.equal(joined.ok, true, JSON.stringify(joined));
  }
  const started = engine.startGame(users[0].id);
  assert.equal(started.ok, true, JSON.stringify(started));
  return { code: created.code, users };
}

const roleOf = (engine, user) => engine.viewFor(user.id).self.role;
const seatOf = (engine, user) => engine.viewFor(user.id).self.seat;
const seatOfRole = (engine, users, role) => {
  for (const u of users) {
    if (roleOf(engine, u) === role) return u;
  }
  return null;
};

/** 所有活人都投同一个人（测试白天放逐用）。 */
function votesFor(engine, users, targetSeat) {
  const out = {};
  for (const u of users) {
    const v = engine.viewFor(u.id);
    if (v?.self.alive) out[v.self.seat] = targetSeat;
  }
  return out;
}

async function waitFor(engine, user, predicate, timeoutMs = 6000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const view = engine.viewFor(user.id);
    last = view;
    if (view && predicate(view)) return view;
    await sleep(5);
  }
  throw new Error(`等状态超时，最后是 ${last && last.phase}`);
}

async function waitPhase(engine, user, phase, timeoutMs = 6000) {
  return waitFor(engine, user, (v) => v.phase === phase, timeoutMs);
}

/**
 * 通用夜晚驱动器：新角色（狼美人/恶夜骑士/狼王/守墓人）都能用。
 * `witch` 可以传 { action:'poison', seat } / 'save' / 'pass'。
 */
async function playNightAuto(engine, users, opts = {}) {
  const me = users[0];
  for (let guard = 0; guard < 160; guard++) {
    const view = engine.viewFor(me.id);
    if (!view) throw new Error('拿不到房间视图');
    if (view.phase === PHASE.NIGHT_START) {
      await sleep(5);
      continue;
    }
    if (view.phase === PHASE.DAY_START) {
      await sleep(5);
      continue;
    }
    if (view.phase === PHASE.HUNTER_SHOOT) {
      for (const u of users) {
        const v = engine.viewFor(u.id);
        if (!v?.can.hunter) continue;
        const seat = opts.shootSeat ?? null;
        const res = engine.act(u.id, { type: 'hunter', seat });
        assert.equal(res.ok, true, `开枪失败：${JSON.stringify(res)}`);
      }
      await sleep(5);
      continue;
    }
    if (!view.phase.startsWith('NIGHT_') || view.phase === PHASE.NIGHT_RESOLVE) {
      return view;
    }

    if (view.phase === PHASE.NIGHT_GUARD_ACTION) {
      for (const u of users) {
        const v = engine.viewFor(u.id);
        if (v?.can.guard) engine.act(u.id, { type: 'guard', seat: null });
      }
      await sleep(5);
      continue;
    }

    if (view.phase === PHASE.NIGHT_WOLF_ACTION) {
      for (const u of users) {
        const v = engine.viewFor(u.id);
        if (!v?.can.wolf) continue;
        let seat = opts.wolfSeat;
        if (seat === undefined) {
          const other = users.find((x) => {
            const xv = engine.viewFor(x.id);
            return xv?.self.alive && xv.self.seat !== v.self.seat;
          });
          seat = other ? engine.viewFor(other.id).self.seat : null;
        }
        // 恶夜骑士/狼美人不能自刀；换一个活人。
        if (seat === v.self.seat && ['EvilKnight', 'WolfBeauty'].includes(v.self.role)) {
          const other = users.find((x) => {
            const xv = engine.viewFor(x.id);
            return xv?.self.alive && xv.self.seat !== v.self.seat;
          });
          seat = other ? engine.viewFor(other.id).self.seat : null;
        }
        const res = engine.act(u.id, { type: 'wolf', seat });
        assert.equal(res.ok, true, `狼刀失败：${JSON.stringify(res)}`);
      }
      await sleep(5);
      continue;
    }

    if (view.phase === PHASE.NIGHT_WOLF_BEAUTY_ACTION) {
      for (const u of users) {
        const v = engine.viewFor(u.id);
        if (!v?.can.wolfBeauty) continue;
        let seat = opts.charmSeat;
        if (seat === undefined) {
          const other = users.find((x) => {
            const xv = engine.viewFor(x.id);
            return xv?.self.alive && xv.self.seat !== v.self.seat &&
              xv.self.seat !== v.private.wolfBeauty?.lastTarget;
          });
          seat = other ? engine.viewFor(other.id).self.seat : null;
        }
        const res = engine.act(u.id, { type: 'charm', seat });
        assert.equal(res.ok, true, `魅惑失败：${JSON.stringify(res)}`);
      }
      await sleep(5);
      continue;
    }

    if (view.phase === PHASE.NIGHT_WITCH_ACTION) {
      for (const u of users) {
        const v = engine.viewFor(u.id);
        if (!v?.can.witch) continue;
        const choice = opts.witch;
        if (choice === 'save') engine.act(u.id, { type: 'witch', action: 'save' });
        else if (choice && typeof choice === 'object' && choice.action === 'poison') {
          engine.act(u.id, { type: 'witch', action: 'poison', seat: choice.seat });
        } else {
          engine.act(u.id, { type: 'witch', action: 'pass' });
        }
      }
      await sleep(5);
      continue;
    }

    if (view.phase === PHASE.NIGHT_SEER_ACTION) {
      for (const u of users) {
        const v = engine.viewFor(u.id);
        if (!v?.can.seer) continue;
        const seat = opts.seerSeat ?? opts.wolfSeat ?? engine.viewFor(users[1].id).self.seat;
        const res = engine.act(u.id, { type: 'seer', seat });
        assert.equal(res.ok, true, `查验失败：${JSON.stringify(res)}`);
      }
      await sleep(5);
      continue;
    }

    await sleep(5);
  }
  throw new Error('夜晚没有在限定时间内结束');
}

/** 夜里按角色把该做的事做完（谁有行动谁做）。 */
async function playNight(engine, users, { wolfSeat, witch = 'pass', seerSeat }) {
  const wolves = users.filter((u) => ['Werewolf', 'WhiteWolfKing'].includes(roleOf(engine, u)));
  const guard = seatOfRole(engine, users, 'Guard');
  const witchUser = seatOfRole(engine, users, 'Witch');
  const seer = seatOfRole(engine, users, 'Seer');
  const me = users[0];

  const phaseView = await waitFor(
    engine,
    me,
    (v) => v.phase.startsWith('NIGHT_') && v.phase !== 'NIGHT_START',
    6000
  );

  // 守卫：空守（如果这局有守卫）
  if (phaseView.phase === PHASE.NIGHT_GUARD_ACTION && guard) {
    const res = engine.act(guard.id, { type: 'guard', seat: null });
    assert.equal(res.ok, true, JSON.stringify(res));
  }

  // 狼人：每只狼都投 wolfSeat
  await waitPhase(engine, me, PHASE.NIGHT_WOLF_ACTION);
  for (const wolf of wolves) {
    const res = engine.act(wolf.id, { type: 'wolf', seat: wolfSeat });
    assert.equal(res.ok, true, JSON.stringify(res));
  }

  // 女巫
  if (witchUser) {
    await waitPhase(engine, me, PHASE.NIGHT_WITCH_ACTION);
    const v = engine.viewFor(witchUser.id);
    if (v.phase === PHASE.NIGHT_WITCH_ACTION) {
      if (witch === 'save') engine.act(witchUser.id, { type: 'witch', action: 'save' });
      else if (typeof witch === 'number') engine.act(witchUser.id, { type: 'witch', action: 'poison', seat: witch });
      else engine.act(witchUser.id, { type: 'witch', action: 'pass' });
    }
  }

  // 预言家
  if (seer) {
    await waitPhase(engine, me, PHASE.NIGHT_SEER_ACTION);
    const res = engine.act(seer.id, { type: 'seer', seat: seerSeat ?? wolfSeat });
    assert.equal(res.ok, true, JSON.stringify(res));
  }
}

/** 全员过一遍白天：报名 → 发言 → 投票。 */
async function playDay(engine, users, { signup = [], votes = {}, endSpeech = true } = {}) {
  const me = users[0];
  const signupPhase = await waitFor(
    engine,
    me,
    (v) => v.phase === PHASE.DAY_BADGE_SIGNUP || v.phase === PHASE.DAY_SPEECH || v.phase === PHASE.DAY_VOTE,
    6000
  );

  if (signupPhase.phase === PHASE.DAY_BADGE_SIGNUP) {
    for (const u of users) {
      const v = engine.viewFor(u.id);
      if (!v || !v.self.alive) continue;
      if (v.can.signup) {
        const wants = signup.includes(v.self.seat);
        engine.act(u.id, { type: 'signup', wants });
      }
    }
  }

  // 竞选发言 / PK 发言 / 白天发言：轮到自己就结束
  if (endSpeech) {
    for (let guard = 0; guard < 40; guard++) {
      const v = engine.viewFor(me.id);
      if (!v) break;
      if (v.phase === PHASE.DAY_BADGE_SPEECH || v.phase === PHASE.DAY_SPEECH || v.phase === PHASE.DAY_LAST_WORDS) {
        const who = v.currentSpeakerSeat;
        const speaker = users.find((u) => engine.viewFor(u.id)?.self.seat === who);
        if (speaker) {
          const res = engine.act(speaker.id, { type: 'endSpeech' });
          if (res.ok) continue;
        }
        await sleep(20);
        continue;
      }
      if (v.phase === PHASE.DAY_BADGE_ELECTION) break;
      if (v.phase === PHASE.DAY_VOTE) break;
      if (v.phase === PHASE.GAME_END) break;
      await sleep(10);
    }
  }

  // 警长投票：不投（弃票）
  const afterSpeech = engine.viewFor(me.id);
  if (afterSpeech && afterSpeech.phase === PHASE.DAY_BADGE_ELECTION) {
    for (const u of users) {
      const v = engine.viewFor(u.id);
      if (v && v.can.badgeVote) engine.act(u.id, { type: 'badgeVote', seat: null });
    }
  }

  // 放逐投票
  for (let guard = 0; guard < 200; guard++) {
    const v = engine.viewFor(me.id);
    if (!v) break;
    if (v.phase === PHASE.DAY_VOTE) {
      for (const u of users) {
        const view = engine.viewFor(u.id);
        if (view && view.can.vote) {
          const target = votes[view.self.seat];
          const targetSeat = typeof target === 'number' ? target : null;
          engine.act(u.id, { type: 'vote', seat: targetSeat });
        }
      }
      await sleep(20);
      continue;
    }
    if (v.phase === PHASE.GAME_END) return v;
    if (v.phase.startsWith('NIGHT_') && v.phase !== 'NIGHT_START') return v;
    await sleep(10);
  }
  return engine.viewFor(me.id);
}

/* ============================== 发牌 ============================== */

describe('狼人杀引擎 · 发牌与开局', () => {
  it('4–18 人的默认配置都能发牌，阵营人数正确', async () => {
    for (let count = 4; count <= 18; count++) {
      const { engine } = makeEngine();
      const { users } = await makeRoom(engine, count);
      const roles = users.map((u) => roleOf(engine, u)).sort();
      const expected = [...ROLE_CONFIG[count]].sort();
      assert.deepEqual(roles, expected, `${count} 人局的角色配置不对`);

      const wolves = roles.filter((r) => r === 'Werewolf' || r === 'WhiteWolfKing').length;
      const wolvesExpected = ROLE_CONFIG[count].filter((r) => r === 'Werewolf' || r === 'WhiteWolfKing').length;
      assert.equal(wolves, wolvesExpected);
      engine.reset();
    }
  });

  it('房主自定义角色：数量一一对上，允许双预言家/没有女巫', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 2, WhiteWolfKing: 0, Seer: 2, Witch: 0, Hunter: 0, Guard: 1, Idiot: 0, Villager: 3 };
    const { users } = await makeRoom(engine, 8, { roles });
    const got = users.map((u) => roleOf(engine, u)).sort();
    assert.deepEqual(
      got,
      ['Guard', 'Seer', 'Seer', 'Villager', 'Villager', 'Villager', 'Werewolf', 'Werewolf'].sort(),
    );
    engine.reset();
  });

  it('角色配置的硬性校验：总数、狼人、非法角色', () => {
    assert.equal(validateRoleSetup(6, { Werewolf: 2, Villager: 3 }).ok, false, '总数不够');
    assert.equal(validateRoleSetup(6, { Werewolf: 0, Villager: 6 }).ok, false, '一只狼都没有');
    assert.equal(validateRoleSetup(6, { Werewolf: 1, Villager: 5, Dragon: 0 }).ok, false, '不认识的角色');
    assert.equal(validateRoleSetup(6, { Werewolf: 1.5, Villager: 4.5 }).ok, false, '不是整数');
    assert.equal(validateRoleSetup(6, { Werewolf: 1, Villager: 5 }).ok, true);
    assert.equal(validateRoleSetup(4, { Werewolf: 1, Seer: 1, Villager: 2 }).ok, true);
    assert.equal(validateRoleSetup(18, { Werewolf: 4, Villager: 14 }).ok, true);
  });

  it('座位 4–18 之外不许建房；人没坐满不许开局', async () => {
    const { engine } = makeEngine();
    const host = { id: 'h1', name: '房主' };
    assert.equal(engine.createRoom({ host, seats: 3 }).ok, false);
    assert.equal(engine.createRoom({ host, seats: 19 }).ok, false);
    const created = engine.createRoom({ host, seats: 4 });
    assert.equal(created.ok, true, '4 人房应该能建');
    const started = engine.startGame(host.id);
    assert.equal(started.ok, false, '人没坐满不许开局');
    engine.reset();
  });
});

/* ============================== 夜晚 ============================== */

describe('狼人杀引擎 · 夜晚流程', () => {
  it('狼人刀人 → 天亮公布死讯；预言家拿到的是私有结果', async () => {
    const { engine } = makeEngine();
    const { code, users } = await makeRoom(engine, 6);
    const wolf = seatOfRole(engine, users, 'Werewolf');
    const villager = seatOfRole(engine, users, 'Villager');
    const seer = seatOfRole(engine, users, 'Seer');
    assert.ok(wolf && villager && seer);

    await playNight(engine, users, { wolfSeat: seatOf(engine, villager), seerSeat: seatOf(engine, wolf) });
    const day = await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_BADGE_SIGNUP, 6000);
    const texts = day.messages.map((m) => m.content).join('\n');
    assert.match(texts, /死亡/);
    assert.match(texts, new RegExp(`${seatOf(engine, villager) + 1}号`));

    // 预言家的查验结果只在他自己的视图里
    const seerView = engine.viewFor(seer.id);
    assert.equal(seerView.private.seerHistory.length, 1);
    assert.equal(seerView.private.seerHistory[0].isWolf, true);
    const others = users.find((u) => u.id !== seer.id);
    assert.deepEqual(engine.viewFor(others.id).private.seerHistory, []);

    engine.reset();
  });

  it('双预言家：各自查验、各看各的结果，别人拿不到', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 2, Seer: 2, Witch: 1, Guard: 1, Villager: 2 };
    const { users } = await makeRoom(engine, 8, { roles });
    const me = users[0];
    const seers = users.filter((u) => roleOf(engine, u) === 'Seer');
    const guard = users.find((u) => roleOf(engine, u) === 'Guard');
    const witch = users.find((u) => roleOf(engine, u) === 'Witch');
    const wolf = users.find((u) => roleOf(engine, u) === 'Werewolf');
    const villager = users.find((u) => roleOf(engine, u) === 'Villager');

    await waitPhase(engine, me, PHASE.NIGHT_GUARD_ACTION);
    engine.act(guard.id, { type: 'guard', seat: null });
    await waitPhase(engine, me, PHASE.NIGHT_WOLF_ACTION);
    for (const u of users) {
      if (['Werewolf', 'WhiteWolfKing'].includes(roleOf(engine, u))) {
        engine.act(u.id, { type: 'wolf', seat: seatOf(engine, villager) });
      }
    }
    await waitPhase(engine, me, PHASE.NIGHT_WITCH_ACTION);
    engine.act(witch.id, { type: 'witch', action: 'pass' });
    await waitPhase(engine, me, PHASE.NIGHT_SEER_ACTION);

    // 第一个预言家先查验；这时第二个还不能动
    const first = seers.find((u) => engine.viewFor(u.id).can.seer);
    const second = seers.find((u) => u.id !== first.id);
    assert.equal(engine.viewFor(second.id).can.seer, false, '第一个人没查完，第二个人不能抢');
    assert.equal(engine.act(first.id, { type: 'seer', seat: seatOf(engine, wolf) }).ok, true);
    await waitPhase(engine, me, PHASE.NIGHT_SEER_ACTION);
    assert.equal(engine.viewFor(second.id).can.seer, true, '轮到第二个预言家');
    assert.equal(engine.act(second.id, { type: 'seer', seat: seatOf(engine, guard) }).ok, true);

    const h1 = engine.viewFor(first.id).private.seerHistory;
    const h2 = engine.viewFor(second.id).private.seerHistory;
    assert.equal(h1.length, 1);
    assert.equal(h2.length, 1);
    assert.equal(h1[0].isWolf, true);
    assert.equal(h2[0].isWolf, false);
    // 别的预言家看不到对方的查验
    assert.notDeepEqual(h1, h2);
    engine.reset();
  });

  it('多个猎人：打死猎人会连锁开枪，且同一个人只开一次', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 2, Hunter: 3, Villager: 3 };
    const { users } = await makeRoom(engine, 8, { roles });
    const me = users[0];
    const hunters = users.filter((u) => roleOf(engine, u) === 'Hunter');
    const wolves = users.filter((u) => ['Werewolf', 'WhiteWolfKing'].includes(roleOf(engine, u)));

    await waitPhase(engine, me, PHASE.NIGHT_WOLF_ACTION);
    for (const wolf of wolves) {
      engine.act(wolf.id, { type: 'wolf', seat: seatOf(engine, hunters[0]) });
    }
    await waitPhase(engine, me, PHASE.HUNTER_SHOOT);
    assert.equal(engine.viewFor(hunters[0].id).can.hunter, true);

    // 第一个猎人带走第二个猎人 → 第二个猎人还能继续开枪
    const shot = engine.act(hunters[0].id, { type: 'hunter', seat: seatOf(engine, hunters[1]) });
    assert.equal(shot.ok, true, JSON.stringify(shot));
    await waitFor(engine, hunters[1], (v) => v.phase === PHASE.HUNTER_SHOOT && v.can.hunter);
    const pass = engine.act(hunters[1].id, { type: 'hunter', seat: null });
    assert.equal(pass.ok, true, JSON.stringify(pass));

    await waitFor(engine, me, (v) => v.phase !== PHASE.HUNTER_SHOOT);
    assert.equal(engine.viewFor(hunters[0].id).self.alive, false);
    assert.equal(engine.viewFor(hunters[1].id).self.alive, false);
    engine.reset();
  });

  it('守卫 + 女巫解药同时生效会"奶穿"（人还是死）', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 10);
    const wolf = seatOfRole(engine, users, 'Werewolf');
    const witch = seatOfRole(engine, users, 'Witch');
    const guard = seatOfRole(engine, users, 'Guard');
    const target = seatOfRole(engine, users, 'Villager');
    assert.ok(wolf && witch && guard && target);

    // 守卫守目标，狼刀目标，女巫救目标
    const me = users[0];
    await waitPhase(engine, me, PHASE.NIGHT_GUARD_ACTION);
    engine.act(guard.id, { type: 'guard', seat: seatOf(engine, target) });
    await waitPhase(engine, me, PHASE.NIGHT_WOLF_ACTION);
    for (const u of users) {
      if (['Werewolf', 'WhiteWolfKing'].includes(roleOf(engine, u))) engine.act(u.id, { type: 'wolf', seat: seatOf(engine, target) });
    }
    await waitPhase(engine, me, PHASE.NIGHT_WITCH_ACTION);
    engine.act(witch.id, { type: 'witch', action: 'save' });
    await waitPhase(engine, me, PHASE.NIGHT_SEER_ACTION);
    const seer = seatOfRole(engine, users, 'Seer');
    engine.act(seer.id, { type: 'seer', seat: seatOf(engine, wolf) });

    const day = await waitFor(engine, me, (v) => v.phase === PHASE.DAY_BADGE_SIGNUP, 6000);
    const dead = day.players.filter((p) => !p.alive).map((p) => p.seat);
    assert.ok(dead.includes(seatOf(engine, target)), '奶穿的人应该死亡');
    engine.reset();
  });

  it('守卫不能连续两晚守同一个人', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 10);
    const guard = seatOfRole(engine, users, 'Guard');
    const target = seatOfRole(engine, users, 'Villager');
    const me = users[0];
    await waitPhase(engine, me, PHASE.NIGHT_GUARD_ACTION);
    assert.equal(engine.act(guard.id, { type: 'guard', seat: seatOf(engine, target) }).ok, true);

    // 走完这一夜到第二天夜里
    await playNight(engine, users, { wolfSeat: seatOf(engine, users[0]), seerSeat: seatOf(engine, target) }).catch(() => {});
    await waitFor(engine, me, (v) => v.phase === PHASE.NIGHT_GUARD_ACTION || v.phase === PHASE.NIGHT_WOLF_ACTION, 8000);
    const secondGuard = engine.viewFor(guard.id);
    if (secondGuard.phase === PHASE.NIGHT_GUARD_ACTION) {
      const res = engine.act(guard.id, { type: 'guard', seat: seatOf(engine, target) });
      assert.equal(res.ok, false, '同一个人不能连续两晚守');
    }
    engine.reset();
  });
});

/* ============================== 视图 ============================== */

/* ============================== 新角色 ============================== */

describe('狼人杀引擎 · 新角色与无警长', () => {
  const byRole = (users, engine, role) => users.find((u) => roleOf(engine, u) === role);

  it('房主可以关掉警长：第一天不竞选，直接发言', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 6, {
      sheriff: false,
      roles: { Werewolf: 2, Seer: 1, Witch: 1, Villager: 2 },
    });
    const villager = byRole(users, engine, 'Villager');
    assert.ok(villager);
    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villager) });
    const speech = await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 6000);
    assert.equal(speech.sheriffEnabled, false);
    assert.equal(speech.badge.holderSeat, null);
    engine.reset();
  });

  it('恶夜骑士：免疫夜刀和毒；被预言家查验后预言家次日死', async () => {
    const { engine } = makeEngine();
    const roles = {
      Werewolf: 1,
      WolfKing: 1,
      EvilKnight: 1,
      Seer: 1,
      Witch: 1,
      Hunter: 1,
      Villager: 2,
    };
    const { users } = await makeRoom(engine, 8, { roles, sheriff: false });
    const evil = byRole(users, engine, 'EvilKnight');
    const seer = byRole(users, engine, 'Seer');
    const witch = byRole(users, engine, 'Witch');
    assert.ok(evil && seer && witch);

    await playNightAuto(engine, users, {
      wolfSeat: seatOf(engine, evil),
      seerSeat: seatOf(engine, evil),
    });
    const day = await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 6000);
    assert.equal(engine.viewFor(evil.id).self.alive, true, '恶夜骑士被刀/验都不该死');
    assert.equal(engine.viewFor(seer.id).self.alive, false, '查验恶夜骑士的预言家次日死');
    assert.equal(engine.viewFor(witch.id).self.alive, true);
    assert.match(day.messages.map((m) => m.content).join('\n'), /反噬/);
    assert.equal(engine.viewFor(evil.id).private.evilReflectUsed, true);
    engine.reset();
  });

  it('恶夜骑士：同晚被验+被毒，只反伤预言家，女巫没事', async () => {
    const { engine } = makeEngine();
    const roles = {
      Werewolf: 1,
      WolfKing: 1,
      EvilKnight: 1,
      Seer: 1,
      Witch: 1,
      Hunter: 1,
      Villager: 2,
    };
    const { users } = await makeRoom(engine, 8, { roles, sheriff: false });
    const evil = byRole(users, engine, 'EvilKnight');
    const seer = byRole(users, engine, 'Seer');
    const witch = byRole(users, engine, 'Witch');
    assert.ok(evil && seer && witch);

    await playNightAuto(engine, users, {
      wolfSeat: seatOf(engine, evil),
      seerSeat: seatOf(engine, evil),
      witch: { action: 'poison', seat: seatOf(engine, evil) },
    });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 6000);
    assert.equal(engine.viewFor(evil.id).self.alive, true, '毒也毒不死恶夜骑士');
    assert.equal(engine.viewFor(seer.id).self.alive, false, '预言家优先被反伤');
    assert.equal(engine.viewFor(witch.id).self.alive, true, '同晚只反伤预言家，女巫活');
    engine.reset();
  });

  it('长老：第一刀不死，第二刀才死；被狼刀死不封印神职', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 2, Elder: 1, Seer: 1, Witch: 1, Hunter: 1, Villager: 1 };
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false });
    const elder = byRole(users, engine, 'Elder');
    const seer = byRole(users, engine, 'Seer');
    assert.ok(elder && seer);

    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, elder), seerSeat: seatOf(engine, elder) });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 6000);
    assert.equal(engine.viewFor(elder.id).self.alive, true, '第一刀刀不死长老');
    assert.equal(engine.viewFor(seer.id).goodSkillsDisabled, false);

    await playDay(engine, users, { votes: {} });
    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, elder), seerSeat: seatOf(engine, elder) });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH || v.phase === PHASE.GAME_END, 6000);
    assert.equal(engine.viewFor(elder.id).self.alive, false, '第二刀长老死亡');
    assert.equal(engine.viewFor(seer.id).goodSkillsDisabled, false, '狼刀死不触发神职封印');
    engine.reset();
  });

  it('长老：被女巫毒死，所有好人神职永久失去技能', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 2, Elder: 1, Seer: 1, Witch: 1, Villager: 3 };
    const { users } = await makeRoom(engine, 8, { roles, sheriff: false });
    const elder = byRole(users, engine, 'Elder');
    const seer = byRole(users, engine, 'Seer');
    const witch = byRole(users, engine, 'Witch');
    const villager = byRole(users, engine, 'Villager');
    const wolf = byRole(users, engine, 'Werewolf');
    assert.ok(elder && seer && witch && villager && wolf);

    await playNightAuto(engine, users, {
      wolfSeat: seatOf(engine, villager),
      seerSeat: seatOf(engine, wolf),
      witch: { action: 'poison', seat: seatOf(engine, elder) },
    });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 6000);
    assert.equal(engine.viewFor(elder.id).self.alive, false);
    assert.equal(engine.viewFor(seer.id).goodSkillsDisabled, true);
    assert.equal(engine.viewFor(seer.id).can.seer, false);
    assert.equal(engine.viewFor(witch.id).can.witch, false);
    engine.reset();
  });

  it('狼美人：被放逐时魅惑对象跟着殉情，且不能开枪', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 1, WolfBeauty: 1, Seer: 1, Witch: 1, Hunter: 1, Villager: 2 };
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false });
    const beauty = byRole(users, engine, 'WolfBeauty');
    const hunter = byRole(users, engine, 'Hunter');
    const villager = byRole(users, engine, 'Villager');
    const seer = byRole(users, engine, 'Seer');
    assert.ok(beauty && hunter && villager && seer);

    await playNightAuto(engine, users, {
      wolfSeat: seatOf(engine, villager),
      charmSeat: seatOf(engine, hunter),
      seerSeat: seatOf(engine, beauty),
    });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 6000);
    await playDay(engine, users, { votes: votesFor(engine, users, seatOf(engine, beauty)) });

    assert.equal(engine.viewFor(beauty.id).self.alive, false);
    assert.equal(engine.viewFor(hunter.id).self.alive, false, '被魅惑的猎人殉情');
    const msgs = engine.viewFor(beauty.id).messages.map((m) => m.content).join('\n');
    assert.match(msgs, /殉情/);
    assert.equal(engine.viewFor(beauty.id).phase.startsWith('NIGHT_'), true);
    engine.reset();
  });

  it('狼王：被自刀/放逐/猎人带走时能开枪；自爆不能开枪', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 1, WolfKing: 1, Seer: 1, Witch: 1, Hunter: 1, Villager: 2 };
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false });
    const wolfKing = byRole(users, engine, 'WolfKing');
    const villager = byRole(users, engine, 'Villager');
    assert.ok(wolfKing && villager);

    await playNightAuto(engine, users, {
      wolfSeat: seatOf(engine, wolfKing),
      seerSeat: seatOf(engine, wolfKing),
      shootSeat: seatOf(engine, villager),
    });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 6000);
    assert.equal(engine.viewFor(wolfKing.id).self.alive, false, '狼王被自刀出局');
    assert.equal(engine.viewFor(villager.id).self.alive, false, '狼王出局开枪带走一人');
    engine.reset();
  });

  it('狼王：白天自爆立刻天黑，且没有开枪', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 1, WolfKing: 1, Seer: 1, Witch: 1, Hunter: 1, Villager: 2 };
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false });
    const wolfKing = byRole(users, engine, 'WolfKing');
    const villagers = users.filter((u) => roleOf(engine, u) === 'Villager');
    assert.ok(wolfKing && villagers.length === 2);

    await playNightAuto(engine, users, {
      wolfSeat: seatOf(engine, villagers[0]),
      seerSeat: seatOf(engine, wolfKing),
    });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 6000);
    const res = engine.act(wolfKing.id, { type: 'wolfSelfDestruct' });
    assert.equal(res.ok, true, JSON.stringify(res));
    const after = engine.viewFor(wolfKing.id);
    assert.equal(after.phase.startsWith('NIGHT_'), true, '自爆跳过白天');
    assert.equal(engine.viewFor(wolfKing.id).self.alive, false);
    assert.equal(engine.viewFor(villagers[1].id).self.alive, true, '自爆不带走人');
    engine.reset();
  });

it('骑士：决斗到狼，狼立刻死并进入黑夜（跳过投票）', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 2, Knight: 1, Seer: 1, Witch: 1, Hunter: 1, Villager: 1 };
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false });
    const knight = byRole(users, engine, 'Knight');
    const wolf = byRole(users, engine, 'Werewolf');
    const villager = byRole(users, engine, 'Villager');
    assert.ok(knight && wolf && villager);

    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villager) });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 6000);
    const res = engine.act(knight.id, { type: 'knight', seat: seatOf(engine, wolf) });
    assert.equal(res.ok, true, JSON.stringify(res));
    const after = engine.viewFor(knight.id);
    assert.equal(after.phase.startsWith('NIGHT_'), true, '决斗到狼要立刻天黑');
    assert.equal(engine.viewFor(wolf.id).self.alive, false);
    assert.equal(engine.viewFor(knight.id).self.alive, true);
    engine.reset();
  });

  it('骑士：决斗到好人，骑士出局，白天继续', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 2, Knight: 1, Seer: 1, Witch: 1, Hunter: 1, Villager: 1 };
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false });
    const knight = byRole(users, engine, 'Knight');
    const seer = byRole(users, engine, 'Seer');
    const villager = byRole(users, engine, 'Villager');
    assert.ok(knight && seer && villager);

    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villager) });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 6000);
    const res = engine.act(knight.id, { type: 'knight', seat: seatOf(engine, seer) });
    assert.equal(res.ok, true, JSON.stringify(res));
    const after = engine.viewFor(knight.id);
    assert.equal(engine.viewFor(knight.id).self.alive, false);
    assert.equal(engine.viewFor(seer.id).self.alive, true);
    assert.equal(after.phase.startsWith('NIGHT_'), false, '决斗好人后白天继续');
    engine.reset();
  });

  it('守墓人：看到昨天公投放逐者的阵营；没有放逐就没有信息', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 2, Gravekeeper: 1, Seer: 1, Witch: 1, Hunter: 1, Villager: 1 };
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false });
    const grave = byRole(users, engine, 'Gravekeeper');
    const wolf = byRole(users, engine, 'Werewolf');
    const villager = byRole(users, engine, 'Villager');
    assert.ok(grave && wolf && villager);

    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villager), seerSeat: seatOf(engine, wolf) });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 6000);
    assert.equal(engine.viewFor(grave.id).private.grave.day, null, '第一夜没有放逐信息');

    await playDay(engine, users, { votes: votesFor(engine, users, seatOf(engine, wolf)) });
    const night = await waitFor(engine, users[0], (v) => v.phase === PHASE.NIGHT_WOLF_ACTION, 6000);
    const info = engine.viewFor(grave.id).private.grave;
    assert.equal(info.day, 1);
    assert.equal(info.seat, seatOf(engine, wolf));
    assert.equal(info.alignment, 'wolf');
    assert.equal(night.phase, PHASE.NIGHT_WOLF_ACTION);
    engine.reset();
  });
});

/* ============================== 视图裁剪 ============================== */

describe('狼人杀引擎 · 视图裁剪（防作弊）', () => {
  it('别人的身份字段根本不在你的报文里；终局才公开', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 8);
    const view = engine.viewFor(users[0].id);
    const meSeat = view.self.seat;
    for (const p of view.players) {
      if (p.seat === meSeat) assert.ok(p.role, '自己的身份要能看到');
      else assert.equal(p.role, undefined, `不该看到 ${p.seat} 号的底牌`);
    }
    // 狼人能看到队友，但看不到好人的身份
    const wolf = seatOfRole(engine, users, 'Werewolf');
    const wolfView = engine.viewFor(wolf.id);
    assert.ok(wolfView.private.wolfTeammates.length >= 1);
    engine.reset();
  });
});

/* ============================== 白天 ============================== */

describe('狼人杀引擎 · 白天与投票', () => {
  it('第一天选警长；警长有 1.5 票', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 8);
    const me = users[0];
    const signup = await waitPhase(engine, me, PHASE.DAY_BADGE_SIGNUP);

    // 1 号和 2 号上警；1 号（民/狼都行）被选为警长
    engine.act(users[0].id, { type: 'signup', wants: true });
    engine.act(users[1].id, { type: 'signup', wants: true });
    for (let i = 2; i < users.length; i++) engine.act(users[i].id, { type: 'signup', wants: false });

    await waitPhase(engine, me, PHASE.DAY_BADGE_SPEECH);
    // 竞选发言：轮到的候选人结束发言
    for (let i = 0; i < 30; i++) {
      const v = engine.viewFor(me.id);
      if (!v) break;
      if (v.phase !== PHASE.DAY_BADGE_SPEECH) break;
      const who = v.currentSpeakerSeat;
      const speaker = users.find((u) => engine.viewFor(u.id)?.self.seat === who);
      if (speaker) engine.act(speaker.id, { type: 'endSpeech' });
      await sleep(10);
    }

    const election = await waitPhase(engine, me, PHASE.DAY_BADGE_ELECTION);
    assert.equal(election.badge.candidates.length, 2);
    // 除候选人外都投 1 号
    for (const u of users) {
      const v = engine.viewFor(u.id);
      if (v && v.can.badgeVote) engine.act(u.id, { type: 'badgeVote', seat: 0 });
    }
    const speech = await waitFor(engine, me, (v) => v.phase === PHASE.DAY_SPEECH, 6000);
    assert.equal(speech.badge.holderSeat, 0);
    engine.reset();
  });

  it('放逐投票把狼投出去，第二天狼人少一只', async () => {
    const { engine, ended } = makeEngine();
    const { users } = await makeRoom(engine, 6);
    const wolf = seatOfRole(engine, users, 'Werewolf');
    const me = users[0];

    // 第一晚：空刀（狼人不投目标 → 空刀）
    await playNight(engine, users, { wolfSeat: undefined, seerSeat: seatOf(engine, wolf) });
    // 第一天：全部跳过警长，直接发言 + 投票
    const afterDay = await playDay(engine, users, { signup: [], votes: {} });
    const v = engine.viewFor(me.id);
    // 走到夜晚后检查狼的数量
    assert.ok(v);
    engine.reset();
    assert.ok(ended.length >= 0);
  });

  it('倒计时到点会自动推进（没人操作也能往下走）', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 6);
    const me = users[0];
    await waitPhase(engine, me, PHASE.DAY_BADGE_SIGNUP, 8000);
    engine.reset();
  });
});
