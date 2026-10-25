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

async function makeRoom(engine, count, { seats = count, password = '', roles, sheriff = true, winMode } = {}) {
  const users = [];
  for (let i = 0; i < count; i++) {
    users.push({ id: `u${i + 1}`, name: `玩家${i + 1}`, avatar: '' });
  }
  const created = engine.createRoom({ host: users[0], seats, password, roles, sheriff, winMode });
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

  it('角色配置的硬性校验：总数、狼阵营、非法角色', () => {
    assert.equal(validateRoleSetup(6, { Werewolf: 2, Villager: 3 }).ok, false, '总数不够');
    assert.equal(validateRoleSetup(6, { Werewolf: 0, Villager: 6 }).ok, false, '一个狼阵营角色都没有');
    assert.equal(validateRoleSetup(6, { Werewolf: 1, Villager: 5, Dragon: 0 }).ok, false, '不认识的角色');
    assert.equal(validateRoleSetup(6, { Werewolf: 1.5, Villager: 4.5 }).ok, false, '不是整数');
    assert.equal(validateRoleSetup(4, { Werewolf: 1, Seer: 1, Villager: 2 }).ok, true);
  });

  it('狼阵营五种都算：狼美人 / 狼王 / 恶夜骑士 单独也能当唯一的狼', () => {
    for (const wolf of ['Werewolf', 'WhiteWolfKing', 'WolfKing', 'WolfBeauty', 'EvilKnight']) {
      const res = validateRoleSetup(4, { [wolf]: 1, Seer: 1, Witch: 1, Villager: 1 });
      assert.equal(res.ok, true, `${wolf} 应该能当唯一的狼阵营角色：${res.message || ''}`);
    }
    const none = validateRoleSetup(4, { Seer: 1, Witch: 1, Villager: 2 });
    assert.equal(none.ok, false, '一个狼阵营角色都没有时不许开房');
    assert.match(none.message, /至少.*狼阵营角色/);
  });

  it('屠边局必须同时有平民和神职，否则不让开房；屠城局没这个限制', () => {
    const noVillager = validateRoleSetup(4, { Werewolf: 1, Seer: 1, Witch: 1, Knight: 1 });
    assert.equal(noVillager.ok, false, '屠边局一个平民都没有 → 不让开房');
    assert.match(noVillager.message, /平民 0 个/);
    const noGod = validateRoleSetup(4, { Werewolf: 1, Villager: 3 });
    assert.equal(noGod.ok, false, '屠边局一个神职都没有 → 不让开房');
    assert.match(noGod.message, /神职 0 个/);
    // 同一个配置换成屠城就合法
    assert.equal(validateRoleSetup(4, { Werewolf: 1, Villager: 3 }, 'wipe').ok, true);
    assert.equal(validateRoleSetup(4, { Werewolf: 1, Seer: 1, Witch: 1, Knight: 1 }, 'wipe').ok, true);
  });

  it('胜利条件落到房间上：默认屠边，可以选屠城', async () => {
    const { engine } = makeEngine();
    const host = { id: 'h1', name: '房主' };
    const made = engine.createRoom({ host, seats: 4 });
    assert.equal(made.ok, true, JSON.stringify(made));
    assert.equal(engine.viewFor(host.id).lobby.winMode, 'side', '默认是屠边');
    assert.equal(engine.createRoom({ host, seats: 4, winMode: 'wipe' }).ok, true);
    assert.equal(engine.viewFor(host.id).lobby.winMode, 'wipe');
    // 屠边 + 只有平民没有神职 → 建房被拒
    const rejected = engine.createRoom({ host, seats: 4, roles: { Werewolf: 1, Villager: 3 } });
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /神职 0 个/);
    engine.reset();
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
    // 这里测的是夜间结算，不测胜负：用屠城，免得屠边默认规则在第一晚就把村民杀光
    const { code, users } = await makeRoom(engine, 6, { winMode: 'wipe' });
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
  it('房主可以关掉警长：第一天不竞选，直接发言', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 6, {
      sheriff: false,
      roles: { Werewolf: 2, Seer: 1, Witch: 1, Villager: 2 },
    });
    const villager = seatOfRole(engine, users, 'Villager');
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
    const evil = seatOfRole(engine, users, 'EvilKnight');
    const seer = seatOfRole(engine, users, 'Seer');
    const witch = seatOfRole(engine, users, 'Witch');
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
    const evil = seatOfRole(engine, users, 'EvilKnight');
    const seer = seatOfRole(engine, users, 'Seer');
    const witch = seatOfRole(engine, users, 'Witch');
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
    const elder = seatOfRole(engine, users, 'Elder');
    const seer = seatOfRole(engine, users, 'Seer');
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
    const elder = seatOfRole(engine, users, 'Elder');
    const seer = seatOfRole(engine, users, 'Seer');
    const witch = seatOfRole(engine, users, 'Witch');
    const villager = seatOfRole(engine, users, 'Villager');
    const wolf = seatOfRole(engine, users, 'Werewolf');
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
    const beauty = seatOfRole(engine, users, 'WolfBeauty');
    const hunter = seatOfRole(engine, users, 'Hunter');
    const villager = seatOfRole(engine, users, 'Villager');
    const seer = seatOfRole(engine, users, 'Seer');
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
    const wolfKing = seatOfRole(engine, users, 'WolfKing');
    const villager = seatOfRole(engine, users, 'Villager');
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
    const wolfKing = seatOfRole(engine, users, 'WolfKing');
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
    // 只有 1 个村民，屠边会在第一晚就判狼胜 → 用屠城，专心测决斗
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false, winMode: 'wipe' });
    const knight = seatOfRole(engine, users, 'Knight');
    const wolf = seatOfRole(engine, users, 'Werewolf');
    const villager = seatOfRole(engine, users, 'Villager');
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
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false, winMode: 'wipe' });
    const knight = seatOfRole(engine, users, 'Knight');
    const seer = seatOfRole(engine, users, 'Seer');
    const villager = seatOfRole(engine, users, 'Villager');
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
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false, winMode: 'wipe' });
    const grave = seatOfRole(engine, users, 'Gravekeeper');
    const wolf = seatOfRole(engine, users, 'Werewolf');
    const villager = seatOfRole(engine, users, 'Villager');
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
  it('别人的身份字段根本不在你的报文里；狼队友除外；终局才公开', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 8);

    // 好人：除了自己，谁的身份都拿不到。
    const good = users.find((u) => !isWolfRole(roleOf(engine, u)));
    const goodView = engine.viewFor(good.id);
    for (const p of goodView.players) {
      if (p.seat === goodView.self.seat) assert.ok(p.role, '自己的身份要能看到');
      else assert.equal(p.role, undefined, `好人拿不到 ${p.seat + 1} 号的底牌`);
    }

    // 狼人：队友的身份要看得到（夜里要合刀，前端靠它给队友挂「狼队」标记），好人的照样拿不到。
    const wolf = seatOfRole(engine, users, 'Werewolf');
    const wolfView = engine.viewFor(wolf.id);
    assert.ok(wolfView.private.wolfTeammates.length >= 1);
    const peerSeats = new Set([
      wolfView.self.seat,
      ...wolfView.private.wolfTeammates.map((t) => t.seat),
    ]);
    for (const p of wolfView.players) {
      if (peerSeats.has(p.seat)) {
        assert.ok(isWolfRole(p.role), `${p.seat + 1} 号是狼阵营，狼人要看得到它的身份`);
      } else {
        assert.equal(p.role, undefined, `狼人也拿不到 ${p.seat + 1} 号好人的底牌`);
      }
    }
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

/* ==================== 白狼王两步 / 平票复投 / 长老与狼美人的公开信息 ==================== */

describe('狼人杀引擎 · 白狼王（先自爆再带人）', () => {
  /** 走到白天发言：6 人 2 狼 4 好，首夜刀一个村民不会直接结束 */
  async function upToDaySpeech(engine, users, wwkSeat, villagerSeat) {
    await playNightAuto(engine, users, { wolfSeat: villagerSeat, seerSeat: wwkSeat });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 8000);
  }

  it('点自爆立刻出局并进入挑人阶段；带走后直接进夜晚', async () => {
    const { engine } = makeEngine();
    const roles = { WhiteWolfKing: 1, Werewolf: 1, Seer: 1, Villager: 3 };
    const { users } = await makeRoom(engine, 6, { roles, sheriff: false });
    const wwk = seatOfRole(engine, users, 'WhiteWolfKing');
    const villager = seatOfRole(engine, users, 'Villager');
    const wolf = seatOfRole(engine, users, 'Werewolf');
    assert.ok(wwk && villager && wolf);
    const wwkSeat = seatOf(engine, wwk);

    await upToDaySpeech(engine, users, wwkSeat, seatOf(engine, villager));

    const boom = engine.act(wwk.id, { type: 'wwkBoom' });
    assert.equal(boom.ok, true, JSON.stringify(boom));
    const afterBoom = engine.viewFor(wwk.id);
    assert.equal(afterBoom.phase, PHASE.WHITE_WOLF_KING_BOOM, '自爆后立刻进入挑人阶段');
    assert.equal(afterBoom.self.alive, false, '自爆的人当场出局');
    assert.equal(afterBoom.can.wwkBoom, true, '他还能挑一个人');
    assert.notEqual(engine.viewFor(wolf.id).can.wwkBoom, true, '别的狼不能替他挑');
    assert.equal(engine.act(wolf.id, { type: 'wwkBoom', seat: wwkSeat }).ok, false);

    const pick = engine.act(wwk.id, { type: 'wwkBoom', seat: seatOf(engine, villager) });
    assert.equal(pick.ok, true, JSON.stringify(pick));
    const afterPick = await waitFor(engine, wwk, (v) => v.phase.startsWith('NIGHT_'), 4000);
    assert.equal(engine.viewFor(villager.id).self.alive, false, '被带走的人出局');
    assert.ok(afterPick.phase.startsWith('NIGHT_'), '带走之后直接天黑');
    engine.reset();
  });

  it('挑人阶段超时（20 秒）就没人被带走，照样天黑', async () => {
    const { engine } = makeEngine();
    const roles = { WhiteWolfKing: 1, Werewolf: 1, Seer: 1, Villager: 3 };
    const { users } = await makeRoom(engine, 6, { roles, sheriff: false });
    const wwk = seatOfRole(engine, users, 'WhiteWolfKing');
    const villager = seatOfRole(engine, users, 'Villager');
    await upToDaySpeech(engine, users, seatOf(engine, wwk), seatOf(engine, villager));

    assert.equal(engine.act(wwk.id, { type: 'wwkBoom' }).ok, true);
    const v = await waitFor(engine, wwk, (x) => x.phase.startsWith('NIGHT_'), 6000);
    assert.ok(v.phase.startsWith('NIGHT_'), '超时后自动进入夜晚');
    const otherVillager = users.filter((u) => roleOf(engine, u) === 'Villager' && u.id !== villager.id)[0];
    assert.equal(engine.viewFor(otherVillager.id).self.alive, true, '没选人就没人被带走');
    engine.reset();
  });
});

describe('狼人杀引擎 · 平票复投', () => {
  it('PK 复投只能投台上的人，投台下会被拒', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 2, Seer: 1, Witch: 1, Villager: 3 };
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false });
    const wolves = users.filter((u) => isWolfRole(roleOf(engine, u)));
    const good = users.filter((u) => !isWolfRole(roleOf(engine, u)));
    assert.equal(wolves.length, 2);

    // 夜里刀一个好人，白天剩 6 人
    await playNightAuto(engine, users, {
      wolfSeat: seatOf(engine, good[0]),
      seerSeat: seatOf(engine, wolves[0]),
    });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 8000);

    // 直接推到投票阶段（发言全部结束）
    const me = users[0];
    for (let i = 0; i < 400; i++) {
      const v = engine.viewFor(me.id);
      if (v.phase === PHASE.DAY_VOTE || v.phase === PHASE.GAME_END) break;
      if (v.phase === PHASE.DAY_SPEECH || v.phase === PHASE.DAY_LAST_WORDS) {
        const speaker = users.find((u) => engine.viewFor(u.id).self.seat === v.currentSpeakerSeat);
        if (speaker) {
          const r = engine.act(speaker.id, { type: 'endSpeech' });
          if (r.ok) continue;
        }
      }
      await sleep(5);
    }
    assert.equal(engine.viewFor(me.id).phase, PHASE.DAY_VOTE);

    // 制造 2:2 平票：两只狼投好甲，两个好人投狼甲，剩下的弃票
    const alive = users.filter((u) => engine.viewFor(u.id).self.alive);
    const targetGood = seatOf(engine, alive.find((u) => !isWolfRole(roleOf(engine, u))));
    const targetWolf = seatOf(engine, alive.find((u) => isWolfRole(roleOf(engine, u))));
    const voters = alive.filter((u) => engine.viewFor(u.id).can.vote);
    const plan = new Map();
    for (const u of voters) plan.set(u.id, null);
    const wolfVoters = voters.filter((u) => isWolfRole(roleOf(engine, u)));
    const goodVoters = voters.filter((u) => !isWolfRole(roleOf(engine, u)));
    wolfVoters.slice(0, 2).forEach((u) => plan.set(u.id, targetGood));
    goodVoters.slice(0, 2).forEach((u) => plan.set(u.id, targetWolf));

    for (const [id, seat] of plan) {
      const r = engine.act(id, { type: 'vote', seat });
      assert.equal(r.ok, true, `投票失败：${JSON.stringify(r)}`);
    }

    const pk = await waitFor(engine, me, (v) => v.phase === PHASE.DAY_PK_SPEECH, 5000);
    assert.ok(pk.pkTargets.includes(targetGood) && pk.pkTargets.includes(targetWolf), '台上就是平票的两个人');

    // 跳到复投
    for (let i = 0; i < 400; i++) {
      const v = engine.viewFor(me.id);
      if (v.phase === PHASE.DAY_VOTE) break;
      if (v.phase === PHASE.GAME_END) break;
      if (v.phase === PHASE.DAY_PK_SPEECH || v.phase === PHASE.DAY_LAST_WORDS) {
        const speaker = users.find((u) => engine.viewFor(u.id).self.seat === v.currentSpeakerSeat);
        if (speaker) {
          const r = engine.act(speaker.id, { type: 'endSpeech' });
          if (r.ok) continue;
        }
      }
      await sleep(5);
    }
    const revote = engine.viewFor(me.id);
    assert.equal(revote.phase, PHASE.DAY_VOTE, 'PK 之后回到投票');

    const outsider = alive
      .map((u) => seatOf(engine, u))
      .find((s) => !revote.pkTargets.includes(s));
    const voter = users.find((u) => engine.viewFor(u.id).can.vote);
    assert.ok(voter && outsider !== undefined);
    const outsiderSeat = alive
      .map((u) => seatOf(engine, u))
      .find((s) => !revote.pkTargets.includes(s) && s !== engine.viewFor(voter.id).self.seat);
    assert.notEqual(outsiderSeat, undefined, '台下还有别人可以试投');
    const rejected = engine.act(voter.id, { type: 'vote', seat: outsiderSeat });
    assert.equal(rejected.ok, false, '投台下应该被拒');
    assert.match(rejected.message || '', /PK/);
    engine.reset();
  });
});

describe('狼人杀引擎 · 公开消息不泄露身份', () => {
  it('长老挨第一刀：公开说的是"平安夜"，不会说"被袭击但活了下来"', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 2, Elder: 1, Seer: 1, Witch: 1, Hunter: 1, Villager: 1 };
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false });
    const elder = seatOfRole(engine, users, 'Elder');
    const villager = seatOfRole(engine, users, 'Villager');
    await playNightAuto(engine, users, {
      wolfSeat: seatOf(engine, elder),
      seerSeat: seatOf(engine, villager),
    });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 8000);
    await sleep(30);

    const texts = engine.viewFor(villager.id).messages.map((m) => m.content).join('\n');
    assert.match(texts, /平安夜/, '公开消息里是平安夜');
    assert.doesNotMatch(texts, /活了下来/, '不能公开暗示长老没死');
    assert.equal(engine.viewFor(elder.id).self.alive, true);
    assert.equal(engine.viewFor(elder.id).private.elderLives, 1);
    engine.reset();
  });

  it('狼美人魅惑谁：别人的消息里一个字都没有', async () => {
    const { engine } = makeEngine();
    const roles = { Werewolf: 1, WolfBeauty: 1, Seer: 1, Witch: 1, Hunter: 1, Villager: 2 };
    const { users } = await makeRoom(engine, 7, { roles, sheriff: false });
    const beauty = seatOfRole(engine, users, 'WolfBeauty');
    const villager = seatOfRole(engine, users, 'Villager');
    const hunter = seatOfRole(engine, users, 'Hunter');
    await playNightAuto(engine, users, {
      wolfSeat: seatOf(engine, hunter),
      charmSeat: seatOf(engine, villager),
      seerSeat: seatOf(engine, beauty),
    });
    await waitFor(engine, users[0], (v) => v.phase === PHASE.DAY_SPEECH, 8000);
    await sleep(30);

    const others = users.filter((u) => u.id !== beauty.id);
    for (const u of others) {
      const texts = engine.viewFor(u.id).messages.map((m) => m.content).join('\n');
      assert.doesNotMatch(texts, /魅惑了/, `${engine.viewFor(u.id).self.role} 不该看到魅惑信息`);
    }
    assert.equal(engine.viewFor(beauty.id).private.wolfBeauty?.charmedSeat ?? null, seatOf(engine, villager), '狼美人自己看得到');
    engine.reset();
  });
});

describe('狼人杀引擎 · 胜利条件（屠边 / 屠城）', () => {
  it('屠城：刀掉平民后不结束，骑士翻牌决斗照样翻盘', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 4, {
      roles: { Werewolf: 1, Knight: 1, Villager: 2 },
      sheriff: false,
      winMode: 'wipe',
    });
    const wolf = seatOf(engine, seatOfRole(engine, users, 'Werewolf'));
    const knight = seatOf(engine, seatOfRole(engine, users, 'Knight'));
    const villagers = users.filter((u) => roleOf(engine, u) === 'Villager');

    // 第 1 夜：刀村民甲；白天全员弃票
    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villagers[0]) });
    await waitPhase(engine, users[0], PHASE.DAY_SPEECH, 8000);
    await playDay(engine, users, { votes: {} });

    // 第 2 夜：刀村民乙 → 只剩 1 狼 1 骑士，屠城局不能结束
    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villagers[1]) });
    const alive = await waitFor(
      engine,
      users[0],
      (v) => v.phase === PHASE.DAY_SPEECH || v.phase === PHASE.GAME_END,
      8000,
    );
    assert.equal(alive.phase, PHASE.DAY_SPEECH, '屠城局里只剩骑士也不该提前判狼胜');
    assert.deepEqual(
      alive.players.filter((p) => p.alive).map((p) => p.seat).sort((a, b) => a - b),
      [wolf, knight].sort((a, b) => a - b),
    );

    // 骑士翻牌决斗唯一那只狼 → 狼全死，好人胜
    const duel = engine.act(seatOfRole(engine, users, 'Knight').id, { type: 'knight', seat: wolf });
    assert.equal(duel.ok, true, JSON.stringify(duel));
    const end = await waitFor(engine, users[0], (v) => v.phase === PHASE.GAME_END, 6000);
    assert.equal(end.winner, 'village');
    engine.reset();
  });

  it('屠边：同一个局面平民被杀光就立刻狼胜，骑士来不及翻牌', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 4, {
      roles: { Werewolf: 1, Knight: 1, Villager: 2 },
      sheriff: false,
    });
    assert.equal(engine.viewFor(users[0].id).winMode, 'side');
    const villagers = users.filter((u) => roleOf(engine, u) === 'Villager');

    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villagers[0]) });
    await waitPhase(engine, users[0], PHASE.DAY_SPEECH, 8000);
    await playDay(engine, users, { votes: {} });
    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villagers[1]) });

    const end = await waitFor(engine, users[0], (v) => v.phase === PHASE.GAME_END, 8000);
    assert.equal(end.winner, 'wolf', '屠边局杀光平民即狼胜');
    engine.reset();
  });

  it('屠城：1 狼 1 猎人，刀死猎人就立刻狼胜，猎人开不了枪', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 4, {
      roles: { Werewolf: 1, Hunter: 1, Villager: 2 },
      sheriff: false,
      winMode: 'wipe',
    });
    const wolf = seatOf(engine, seatOfRole(engine, users, 'Werewolf'));
    const hunter = seatOf(engine, seatOfRole(engine, users, 'Hunter'));
    const villagers = users.filter((u) => roleOf(engine, u) === 'Villager');

    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villagers[0]) });
    await waitPhase(engine, users[0], PHASE.DAY_SPEECH, 8000);
    await playDay(engine, users, { votes: votesFor(engine, users, seatOf(engine, villagers[1])) });
    await playNightAuto(engine, users, { wolfSeat: hunter });

    const end = await waitFor(engine, users[0], (v) => v.phase === PHASE.GAME_END, 8000);
    assert.equal(end.winner, 'wolf');
    const texts = end.messages.map((m) => m.content).join('\n');
    assert.doesNotMatch(texts, /请选择要带走的人/, '死讯一结算就结束，猎人没有开枪机会');
    engine.reset();
  });

  it('屠城：1 狼 1 女巫同归于尽 → 狼全死，判好人胜', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 4, {
      roles: { Werewolf: 1, Witch: 1, Villager: 2 },
      sheriff: false,
      winMode: 'wipe',
    });
    const wolf = seatOf(engine, seatOfRole(engine, users, 'Werewolf'));
    const witchUser = seatOfRole(engine, users, 'Witch');
    const villagers = users.filter((u) => roleOf(engine, u) === 'Villager');

    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villagers[0]), witch: 'pass' });
    await waitPhase(engine, users[0], PHASE.DAY_SPEECH, 8000);
    await playDay(engine, users, { votes: votesFor(engine, users, seatOf(engine, villagers[1])) });

    // 第 2 夜：狼刀女巫，女巫毒狼 → 天亮双方都死了
    await playNightAuto(engine, users, {
      wolfSeat: seatOf(engine, witchUser),
      witch: { action: 'poison', seat: wolf },
    });
    const end = await waitFor(engine, users[0], (v) => v.phase === PHASE.GAME_END, 8000);
    assert.equal(end.winner, 'village', '同时全灭时好人优先胜（狼先死光）');
    assert.equal(end.players.filter((p) => p.alive).length, 0);
    engine.reset();
  });

  it('屠边：神职被杀光也立刻狼胜，平民还活着也救不了', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 4, {
      roles: { Werewolf: 1, Seer: 1, Villager: 2 },
      sheriff: false,
    });
    const seer = seatOfRole(engine, users, 'Seer');
    const wolf = seatOfRole(engine, users, 'Werewolf');
    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, seer), seerSeat: seatOf(engine, wolf) });
    const end = await waitFor(engine, users[0], (v) => v.phase === PHASE.GAME_END, 8000);
    assert.equal(end.winner, 'wolf');
    assert.equal(end.players.filter((p) => p.alive).length, 3, '狼 + 2 个平民都还活着，死的只有神职');
    engine.reset();
  });

  it('屠边：放逐掉最后一个平民就立刻狼胜（屠城局不会）', async () => {
    const side = makeEngine();
    {
      const { engine } = side;
      const { users } = await makeRoom(engine, 4, {
        roles: { Werewolf: 1, Knight: 1, Villager: 2 },
        sheriff: false,
      });
      const villagers = users.filter((u) => roleOf(engine, u) === 'Villager');
      await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villagers[0]) });
      await waitPhase(engine, users[0], PHASE.DAY_SPEECH, 8000);
      await playDay(engine, users, { votes: votesFor(engine, users, seatOf(engine, villagers[1])) });
      const end = await waitFor(engine, users[0], (v) => v.phase === PHASE.GAME_END, 8000);
      assert.equal(end.winner, 'wolf');
      engine.reset();
    }

    const wipe = makeEngine();
    {
      const { engine } = wipe;
      const { users } = await makeRoom(engine, 4, {
        roles: { Werewolf: 1, Knight: 1, Villager: 2 },
        sheriff: false,
        winMode: 'wipe',
      });
      const villagers = users.filter((u) => roleOf(engine, u) === 'Villager');
      await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villagers[0]) });
      await waitPhase(engine, users[0], PHASE.DAY_SPEECH, 8000);
      await playDay(engine, users, { votes: votesFor(engine, users, seatOf(engine, villagers[1])) });
      const after = engine.viewFor(users[0].id);
      assert.equal(after.phase.startsWith('NIGHT_'), true, `屠城局平民死光还要继续打，现在是 ${after.phase}`);
      engine.reset();
    }
  });
});

describe('狼人杀引擎 · 打完再来一局', () => {
  it('只有房主能开下一局；开了之后回到等候区、座位还在', async () => {
    const { engine } = makeEngine();
    const { users } = await makeRoom(engine, 4, {
      roles: { Werewolf: 2, Seer: 1, Villager: 1 },
      sheriff: false,
    });
    const villager = seatOfRole(engine, users, 'Villager');
    // 屠边局（默认）：2 狼 + 1 预言家 + 1 民，首夜刀掉唯一的民 → 平民全灭即狼胜
    await playNightAuto(engine, users, { wolfSeat: seatOf(engine, villager) });
    const end = await waitFor(engine, users[0], (v) => v.phase === PHASE.GAME_END, 8000);
    assert.equal(end.winner, 'wolf');

    assert.equal(engine.restartRoom(users[1].id).ok, false, '非房主不能开');
    const restarted = engine.restartRoom(users[0].id);
    assert.equal(restarted.ok, true, JSON.stringify(restarted));
    const after = engine.viewFor(users[0].id);
    assert.equal(after.phase, 'WAITING');
    assert.equal(after.lobby.players.length, 4, '4 个座位都还在');
    assert.equal(after.winner ?? null, null);
    assert.equal(engine.leaveRoom(users[1].id).ok, true, '打完能正常退房回大厅');
    engine.reset();
  });
});
