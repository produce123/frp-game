/**
 * BladeSteed — 在线房间的「人机座位」用例（node:test，跑的是真的服务端接入层）
 *
 * 覆盖 docs/GAME-SPEC.md §4「AI 补位」的验收要求。**这一版是「人机坐在座位上」的新契约**
 * （用户明确要求，见 docs/DECISIONS.md D9）：
 *
 *   1. `createMatch(players)` 拿到的人机座位（`isBot: true`）真的被当成 AI 座位：
 *      名字来自 `meta.botNames`（单字池），视图里带 `isAI` 标记
 *   2. 1 个真人 + 1 个人机座位：**一次 tick 都不发**就能从开局打到结束
 *   3. 真人视图里 AI 身份**可判定**（名字 + isAI 标记位，两样都断言）
 *   4. 4 个座位（满桌）能开局；真人与人机混着也能打完
 *   5. AI 的未揭晓的拳**没有**进真人的 view（逐字段扫，不是只看一项）
 *   6. 座位不够（只有 1 个座位）时接入层自己也会拒绝 —— 但玩家看到的那句中文
 *      来自**房间层**（房间层会先拦，见 server/rooms.mjs 的 start()）
 *
 * ⚠️ 旧契约 `options.aiFill`（缺省兜底补一个 / 房主明确选 0 就拒绝 / 垃圾值走 clampInt 收口 /
 *    人机叫「电脑1」）**整段作废**，对应的四条用例换成了上面这几条。
 *    历史与"为什么改"见 games/blade-steed/AGENTS.md 第 8 条与 docs/DECISIONS.md D9。
 *
 * 跑：node --test games/blade-steed/tests/online-ai.test.mjs
 * （tools/check-game.mjs 会自己带起 tests/*.test.mjs，这个文件也在里面）
 *
 * ⚠️ 这个文件是**跨层**的：它 import 平台的接入层 server/games/blade-steed.mjs，
 *    因为这个契约（createMatch / act / viewFor）本身就在那一层。
 *    rules.test.mjs 里已经有一段同样的跨层检查，这里专门测"人机座位"这一件事。
 *
 * ⚠️ "真人"由 AiBrain 代打（同一个 js/ai/ai.js），而不是在这里再写一套随机策略：
 *    随机策略在 10 血 + 猜拳定步数的规则下可能要几千步才打死人，
 *    而"用 AI 自己的脑子当陪练"能保证每局都收得掉（sim.mjs 已经证明 AI 自对弈必然结束）。
 *    真人的每一手仍然走 match.act() 这个**真的入口**，所以测的是接入层，不是引擎。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AiBrain } from '../js/ai/ai.js';
import { viewFor } from '../js/view.js';
import { MAX_PLAYERS, MIN_SEATS, PHASE } from '../js/engine/constants.js';

const { createMatch, meta } = await import('../../../server/games/blade-steed.mjs');

/** 人机名字池就是 js/ai/ai.js 的单字池（接入层 re-export 给房间层用，不许抄字面量） */
const BOT_NAMES = meta.botNames;
const HANDS = ['rock', 'scissors', 'paper'];

const HUMAN = { id: 'HU0001', name: '人' };
const HUMAN2 = { id: 'HU0002', name: '客' };
const HUMAN3 = { id: 'HU0003', name: '丙' };
const HUMAN4 = { id: 'HU0004', name: '丁' };

/**
 * 房间层按「＋ 添加人机」加出来的座位长这样：
 * `{ id: 'bot:1', name: <单字>, isHost: false, isBot: true }`
 * （见 server/rooms.mjs 的 start()/botAdd()）。用例照着这个形状造座位。
 */
function botSeat(n) {
  return {
    id: `bot:${n}`,
    name: BOT_NAMES[(n - 1) % BOT_NAMES.length],
    isHost: false,
    isBot: true,
  };
}

/** 帖子里的座位表：若干真人 + 若干人机座位 */
function table(humans, botCount) {
  const seats = humans.map((h, i) => ({ id: h.id, name: h.name, isHost: i === 0, isBot: false }));
  for (let i = 1; i <= botCount; i++) seats.push(botSeat(i));
  return seats;
}

/* ------------------------------ 工具 ------------------------------ */

const X = (m) => m._state();

/**
 * 服务端每次返回之后，AI 都**不能**还欠着一个动作。
 *
 * 这一条是整个"人机座位"的核心不变量：只要有一处漏了 runAi()，
 * 客户端就会永远停在"等待对手行动"（房间层没有心跳，没人会再来推一次）。
 */
function assertNoPendingAi(match, tag) {
  const s = X(match);
  if (s.phase === PHASE.OVER) return;

  if (s.phase === PHASE.RPS) {
    const pending = s.alive().filter((p) => p.isAI && !s.rps.submitted[p.id]);
    assert.deepEqual(pending, [], `${tag}：猜拳阶段还欠着 AI 的拳（${pending.join('、')}）—— 服务端在等客户端催`);
    return;
  }
  if (s.phase === PHASE.ORDER && s.mini) {
    if (s.mini.decider) {
      assert.equal(s.player(s.mini.decider).isAI, false, `${tag}：还等着 AI 定行动顺序`);
      return;
    }
    const pending = s.mini.candidates.filter(
      (id) => s.player(id)?.isAI && s.player(id).alive && !s.mini.submitted[id]
    );
    assert.deepEqual(pending, [], `${tag}：小猜拳还欠着 AI 的拳（${pending.join('、')}）`);
    return;
  }
  if (s.phase === PHASE.ACTION) {
    assert.equal(s.player(s.current).isAI, false, `${tag}：还等着 AI 行动（${s.current}）`);
  }
}

/**
 * 真人的视图里不能有**别人还没揭晓的手势**（自己的拳本来就在自己视图里，撞手不算泄露）。
 * 做法和 rules.test.mjs 的整局扫描一样：拿引擎内部的出手表当答案，逐个手势去视图里搜。
 */
function assertNoHandLeak(match, humanId, tag) {
  const s = X(match);
  const view = match.viewFor(humanId);
  assert.ok(view, `${tag}：真人拿不到视图`);

  const checkBlock = (obj, submitted, roundLabel) => {
    if (!obj) return;
    const text = JSON.stringify(obj);
    const mine = submitted[humanId] || null;
    for (const [pid, hand] of Object.entries(submitted)) {
      if (pid === humanId) continue;
      if (hand === mine) continue; // 撞手：view 里那个同名字符串是自己的拳
      assert.ok(!text.includes(hand), `${tag}：${roundLabel}里 ${pid} 还没揭晓的拳（${hand}）进了真人视图：${text}`);
    }
    assert.equal('submitted' in obj, false, `${tag}：视图里不能带完整出手表`);
  };

  if (s.phase === PHASE.RPS && s.rps && !s.rps.winners.length) {
    checkBlock(view.rps, s.rps.submitted, '主猜拳');
    for (const [id, v] of Object.entries(view.rps.ready)) {
      assert.equal(typeof v, 'boolean', `${tag}：ready 只能是布尔（谁知道出了，不是出了什么）：${id}=${v}`);
    }
    assert.equal(view.rps.myChoice, s.rps.submitted[humanId] || null, `${tag}：myChoice 只能是自己的拳`);
  }
  if (s.phase === PHASE.ORDER && s.mini && !s.mini.decider && !s.mini.winners.length) {
    checkBlock(view.mini, s.mini.submitted, '小猜拳');
  }
}

/**
 * 真人出完拳之后，这一轮**当场就结算了**（AI 的拳在回合开始时就定好了，服务端不在等任何人）。
 * 判据：要么阶段已经不是猜拳，要么引擎已经开了**新一轮**（新一轮的出手表里没有真人）。
 *
 * ⚠️ 别去断言 `events` 里有 `rps-reveal`：事件表只留最后 60 条（引擎的 KEEP_EVENTS），
 *    多个赢家的小猜拳能刷出几十条，主猜拳那条会被挤出窗口 —— 实测踩过，那不是 bug。
 */
function assertResolvedImmediately(match, humanId, tag) {
  const s = X(match);
  if (s.phase !== PHASE.RPS) return;
  assert.equal(
    s.rps.submitted[humanId],
    undefined,
    `${tag}：还停在"等谁出拳"（服务端欠着谁的动作，见 assertNoPendingAi）`
  );
}

/** 把视图里所有字符串连"字段路径"一起收集出来（逐字段检查用） */
function collectStrings(value, path = '', out = []) {
  if (typeof value === 'string') {
    out.push({ path, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectStrings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

/**
 * 让**若干个真人**（由 AiBrain 代打）一直出拳 / 排顺序 / 行动，直到本局结束。
 * **全程不调用 {kind:'tick'}** —— 这正是要证明的事：AI 不需要真人催。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.cycleHand] 真人改成"石头→剪刀→布"轮着出。
 *   整局没有真实时钟参与（一次超时都不触发），所以同一份代码每次跑出来的局面完全一样；
 *   换一种出拳方式才能覆盖到另一条局面路径。
 */
function playHumansToEnd(match, humanIds, { maxSteps = 4000, cycleHand = false } = {}) {
  const brains = new Map(humanIds.map((id) => [id, new AiBrain(id)]));
  let steps = 0;

  while (!match.isOver() && steps < maxSteps) {
    const s = X(match);

    // 先让每个真人"看一眼"（AI 陪练要观察出拳习惯），顺便查泄露
    for (const id of humanIds) {
      const view = match.viewFor(id);
      assert.ok(view, '真人拿不到视图');
      brains.get(id).observe(view);
      assertNoHandLeak(match, id, `第 ${steps} 步之前`);
    }

    // 找出这一拍谁该动（一个真人的局就是他自己；两个真人的局是轮到的/还没出拳的那个）
    let acted = false;
    for (const id of humanIds) {
      const view = match.viewFor(id);
      const hand = cycleHand ? HANDS[steps % HANDS.length] : brains.get(id).chooseHand(view);

      if (s.phase === PHASE.RPS) {
        if (s.rps.submitted[id]) continue;
        const r = match.act(id, { kind: 'rps', choice: hand });
        assert.equal(r.ok, true, `真人出拳被拒了：${r.message}`);
        acted = true;
        break;
      }
      if (s.phase === PHASE.ORDER) {
        if (s.mini.decider === id) {
          const r = match.act(id, { kind: 'order', order: brains.get(id).chooseOrder(view) });
          assert.equal(r.ok, true, `真人排顺序被拒了：${r.message}`);
          acted = true;
          break;
        }
        if (!s.mini.decider && s.mini.candidates.includes(id) && !s.mini.submitted[id]) {
          // 小猜拳里真人也是候选人：出拳和主猜拳共用同一个信封（界面也是这么发的）
          const r = match.act(id, { kind: 'rps', choice: hand });
          assert.equal(r.ok, true, `真人在小猜拳里出拳被拒了：${r.message}`);
          acted = true;
          break;
        }
        continue;
      }
      if (s.phase === PHASE.ACTION) {
        if (s.current !== id) continue;
        const a = brains.get(id).chooseAction(view);
        const r = match.act(id, { kind: 'act', type: a.type, target: a.target });
        assert.equal(r.ok, true, `真人行动被拒了（${a.type}）：${r.message}`);
        acted = true;
        break;
      }
      assert.fail(`没见过的阶段：${s.phase}`);
    }

    assert.ok(
      acted,
      `第 ${steps} 步：一个真人都动不了（阶段 ${s.phase}）—— 服务端欠着 AI 的动作（见 assertNoPendingAi）`
    );
    steps += 1;
    assertNoPendingAi(match, `第 ${steps} 步之后`);
  }

  return { steps, rounds: X(match).round };
}

/* ------------------------------ meta ------------------------------ */

test('meta：真人下限 1、总座位下限 2、上限 4，人机名字池是单字池', () => {
  assert.equal(meta.minPlayers, 1, 'minPlayers 是"至少要几个真人"：一个人也能建房');
  assert.equal(meta.minSeats, MIN_SEATS, 'minSeats 是"至少要几个座位"（含人机）：引擎的下限是 2');
  assert.equal(meta.maxPlayers, MAX_PLAYERS);
  assert.ok(meta.minPlayers <= meta.minSeats && meta.minSeats <= meta.maxPlayers);
  assert.equal(meta.slug, 'blade-steed');

  // 人机名字池：来自 js/ai/ai.js 的 AI_NAME_POOL（接入层 re-export，不抄字面量）
  assert.ok(Array.isArray(meta.botNames) && meta.botNames.length >= 4, 'meta.botNames 要是单字数组（房间层挑名字用）');
  for (const n of meta.botNames) {
    assert.equal(typeof n, 'string');
    assert.equal([...n].length, 1, `人机名字必须是单个字（头像圆里只画得下一个）：${n}`);
  }
});

/* ------------------------------ createMatch：人机是座位 ------------------------------ */

test('createMatch：players 里 isBot 的座位就是 AI 座位（服务端不再自己造座位）', () => {
  const match = createMatch(table([HUMAN], 1));
  const s = X(match);

  assert.equal(s.players.length, 2, '1 个真人 + 1 个人机座位 = 2 个座位');
  assert.deepEqual(match._aiIds(), ['bot:1'], '人机的 id 原样保留（房间层发的是 bot:N）');
  assert.deepEqual(
    s.players.filter((p) => !p.isAI).map((p) => p.id),
    [HUMAN.id],
    '真人座位一个不多一个不少'
  );

  // AI 决策吃的那一档（裸 viewFor，就是 aiStep 拿到的那个）**没有** isAI ——
  // 「AI 拿不到'谁是真人'这个字段」这条结构性保证没被破坏（见 js/view.js 顶部）。
  const aiInput = viewFor(X(match), 'bot:1');
  assert.equal(
    aiInput.players.some((p) => 'isAI' in p),
    false,
    'AI 决策吃的那一档视图里绝不能有 isAI'
  );
  assert.equal(match.viewFor('NOT_IN_THIS_MATCH'), null, '局外人拿不到视图');
});

test('人机的身份：名字来自单字池，真人名字一个都没被改，视图里带 isAI', () => {
  for (const bots of [1, 2, 3]) {
    const seats = table([HUMAN], bots);
    const match = createMatch(seats);
    const view = match.viewFor(HUMAN.id);
    assert.ok(view, '真人拿不到视图');

    const aiSeats = view.players.filter((p) => p.isAI);
    const humanSeats = view.players.filter((p) => !p.isAI);

    // 1) 名字规则：人机用的就是房间层发进来的那个单字（从头到尾没被改写过）
    assert.deepEqual(
      aiSeats.map((p) => p.name).sort(),
      seats.filter((s) => s.isBot).map((s) => s.name).sort(),
      `${bots} 个人机的名字必须原样是房间层挑的单字`
    );
    for (const p of aiSeats) {
      assert.ok(meta.botNames.includes(p.name), `人机名字必须来自 meta.botNames：${p.name}`);
      assert.equal([...p.name].length, 1, `人机名字是单字：${p.name}`);
    }
    // 真人**一个都没被改名**（名字来自平台账号，这条不能被动过）
    assert.equal(humanSeats.length, 1);
    assert.equal(humanSeats[0].name, HUMAN.name, '真人座位的名字不许被改');

    // 2) 标记位：每个座位的身份都明确（不是"看名字猜"—— 人机的单字可能和某个真人重名）
    for (const id of match._aiIds()) {
      assert.equal(view.players.find((p) => p.id === id).isAI, true, `${id} 是人机，视图必须标出来`);
    }
    assert.equal(view.players.filter((p) => p.isAI === true).length, bots);
    assert.equal(view.players.filter((p) => p.isAI === false).length, 1, '真人只有一个');

    // 3) 这条身份是**公开的**，所以它跟隐藏信息无关：没揭晓的拳照旧一个字都不在视图里
    for (const [pid, hand] of Object.entries(X(match).rps.submitted)) {
      if (pid === HUMAN.id || hand === view.rps.myChoice) continue;
      assert.ok(!JSON.stringify(view.rps).includes(hand), `${pid} 的拳泄露进了真人视图`);
    }
    assert.ok(!('submitted' in view.rps), '视图里不能带完整出手表');
    assert.ok(JSON.stringify(view).includes('isAI'), '真人视图里应当**有** isAI（身份标记，不是隐藏信息）');
  }
});

/**
 * ⚠️ 这条钉的是**报文形状**：房间层给座位打的是 `isBot`，引擎里叫 `isAI`，
 * 而 `isBot` 是**房间层的字段**，不许溜进任何发出去的报文里
 * （座位条目只带 isAI；多一个字段就多一处以后会写错的地方）。
 */
test('isBot 不许进视图：座位条目只有 isAI，整份报文里搜不到 isBot', () => {
  const match = createMatch(table([HUMAN, HUMAN2], 2));
  for (const id of [HUMAN.id, HUMAN2.id]) {
    const view = match.viewFor(id);
    for (const seat of view.players) {
      assert.equal('isBot' in seat, false, `座位条目里不许出现 isBot：${JSON.stringify(seat)}`);
    }
    assert.ok(!JSON.stringify(view).includes('isBot'), '整份报文里都不许出现 isBot');
  }
  // 座位够不够、谁能开局是**房间层**的事，接入层不重复一份
  assert.equal('minSeats' in meta === true, true, 'meta.minSeats 是给房间层/体检看的');
});

/* ------------------------------ 同步驱动 AI ------------------------------ */

test('开局那一刻 AI 的拳就已经定下来了（这就是"不等任何客户端"的根）', () => {
  const match = createMatch(table([HUMAN], 3));
  const s = X(match);
  const aiIds = match._aiIds();
  assert.equal(aiIds.length, 3);

  assert.equal(s.phase, PHASE.RPS, '开局在猜拳阶段');
  for (const id of aiIds) {
    assert.ok(HANDS.includes(s.rps.submitted[id]), `${id} 在自己这一轮开始时就应该已经出拳了`);
  }
  assert.equal(s.rps.submitted[HUMAN.id], undefined, '真人当然还没出（他被出拳界面挡着）');
  assertNoPendingAi(match, '开局');
});

test('1 个真人 + 1 个人机座位：不催 tick 也能从开局打到结束', () => {
  const match = createMatch(table([HUMAN], 1));

  // 开局那一手：AI 已经出了，服务端只在等真人 —— 所以真人一出拳就当场开奖。
  const s0 = X(match);
  assert.equal(s0.phase, PHASE.RPS);
  const aiId = match._aiIds()[0];
  const aiHand = s0.rps.submitted[aiId];
  const humanHand = HANDS.find((h) => h !== aiHand) || 'rock';
  const r = match.act(HUMAN.id, { kind: 'rps', choice: humanHand });
  assert.equal(r.ok, true);
  // 这一轮当场就结算了（可能开打，也可能无人获胜重猜 —— 但绝不可能"还在等谁出拳"）
  assertResolvedImmediately(match, HUMAN.id, 'AI 已出拳 + 最后一个提交的是真人');
  assertNoPendingAi(match, '真人出拳之后');

  // 然后一路打到结束：全程只走 match.act，一次 tick 都不发。
  const { steps, rounds } = playHumansToEnd(match, [HUMAN.id]);
  assert.equal(match.isOver(), true, `没打完（走了 ${steps} 步 / 第 ${rounds} 回合）`);
  assert.ok(rounds >= 1, '至少要打完一个回合');
  const result = match.result();
  assert.ok(result.winner, '必须有胜者');
  assert.ok(rounds < 200, `回合数 ${rounds} 看着像在打转`);
});

test('1 个真人 + N 个人机座位（N = 1/2/3）：每一种桌子都能不催 tick 打完一整局', () => {
  for (const bots of [1, 2, 3]) {
    for (const cycleHand of [false, true]) {
      const match = createMatch(table([HUMAN], bots));
      assert.equal(X(match).players.length, bots + 1);
      const { steps, rounds } = playHumansToEnd(match, [HUMAN.id], { cycleHand, maxSteps: 1500 });
      assert.equal(
        match.isOver(),
        true,
        `${bots} 个人机（出拳方式 ${cycleHand ? '轮换' : 'AI 脑子'}）没打完：${steps} 步 / 第 ${rounds} 回合`
      );
      assert.ok(match.result().winner, `${bots} 个人机：打完必须有胜者`);
      assert.ok(rounds < 200, `${bots} 个人机：回合数 ${rounds} 看着像在打转`);
    }
  }
});

test('tick 那条"真人挂机催办"的通路仍然通（人机只是不再依赖它）', () => {
  const match = createMatch(table([HUMAN], 1));
  // 没到点的时候催一下：必须是 ok（否则客户端心跳会被当成错误弹给玩家），状态不动
  assert.deepEqual(match.act(HUMAN.id, { kind: 'tick' }), { ok: true });
  assert.equal(X(match).phase, PHASE.RPS, '还没到 10 秒，催一下不该改变阶段');
  assertNoPendingAi(match, 'tick 之后');
});

test('满桌（4 个座位：1 个真人 + 3 个人机）也能开局', () => {
  const match = createMatch(table([HUMAN], 3));
  const s = X(match);
  assert.equal(s.players.length, MAX_PLAYERS, '满桌 4 个座位');
  assert.equal(match._aiIds().length, 3);
  assert.equal(match.viewFor(HUMAN.id).players.length, 4, '真人的视图里能看到同桌的 4 个人');
  assert.equal(s.phase, PHASE.RPS);
  assertNoPendingAi(match, '满桌开局');

  // 真人一出拳就当场结算（三个人机的拳开局就出完了，服务端不在等任何人）
  const brain = new AiBrain(HUMAN.id);
  const view = match.viewFor(HUMAN.id);
  brain.observe(view);
  assert.equal(match.act(HUMAN.id, { kind: 'rps', choice: brain.chooseHand(view) }).ok, true);
  assertResolvedImmediately(match, HUMAN.id, '满桌局');
  assertNoPendingAi(match, '满桌出拳之后');
});

test('真人与人机混着（2 个真人 + 2 个人机座位）：两个真人自己动手也能打完一整局', () => {
  const match = createMatch(table([HUMAN, HUMAN2], 2));
  assert.equal(X(match).players.length, 4);
  assert.deepEqual(match._aiIds(), ['bot:1', 'bot:2']);
  assert.equal(match.viewFor(HUMAN.id).players.filter((p) => p.isAI).length, 2, '两个真人各自都看得到"谁是电脑"');

  // 两个真人轮流走真的入口，全程不催 tick；AI 的三步（出拳/小猜拳/行动）都由服务端当场跑完
  const { steps, rounds } = playHumansToEnd(match, [HUMAN.id, HUMAN2.id], { maxSteps: 3000 });
  assert.equal(match.isOver(), true, `混桌没打完：${steps} 步 / 第 ${rounds} 回合`);
  assert.ok(match.result().winner, '混桌打完必须有胜者');
  assert.ok(rounds < 200, `回合数 ${rounds} 看着像在打转`);
});

/* ------------------------------ 视图不泄露 ------------------------------ */

test('AI 的拳在揭晓前不在真人的 view 里（逐字段扫整份视图）', () => {
  const match = createMatch(table([HUMAN], 3));
  const s = X(match);
  const aiIds = match._aiIds();
  const aiHands = aiIds.map((id) => s.rps.submitted[id]);
  assert.equal(aiHands.filter(Boolean).length, 3, '三个 AI 都应该已经出拳了（不然这条用例没测到东西）');

  const view = match.viewFor(HUMAN.id);

  // 1) 逐字段：视图里除了 rpsChoices（可选手势清单，本来就该有）之外，
  //    **任何字段的任何字符串**都不许是"拳"。
  const leaked = collectStrings(view).filter(
    (x) => HANDS.includes(x.value) && !/^rpsChoices\[\d+\]$/.test(x.path)
  );
  assert.deepEqual(leaked, [], `这些字段泄露了手势：${leaked.map((x) => `${x.path}=${x.value}`).join('、')}`);

  // 2) 逐字段点名检查（不只依赖上面那把扫把）
  assert.equal(view.rps.myChoice, null, '真人还没出拳，myChoice 必须是 null');
  assert.equal('submitted' in view.rps, false, '视图里不能有完整出手表');
  assert.equal(view.mini, null, '猜拳阶段没有小猜拳');
  for (const id of aiIds) {
    assert.equal(view.rps.ready[id], true, `${id} 已出拳 → ready 只能是 true（谁出了，不是出了什么）`);
  }
  assert.equal(view.rps.winners.length, 0, '还没开奖，winners 必须是空的');
  assert.deepEqual(view.mainWinners, [], '还没开奖，mainWinners 必须是空的');

  // 3) 整段 rps 块（发给真人的报文里那一块）搜不到任何手势名
  const block = JSON.stringify(view.rps);
  assert.ok(!/rock|scissors|paper/.test(block), `rps 块里出现了手势名：${block}`);
  // 4) 整份视图里**有** isAI（人机身份是公开的，玩家要拿它画灰圈），
  //    但那个字段说的是"这个座位是人机"，跟"谁出了什么拳"无关。
  assert.equal(view.players.filter((p) => p.isAI).length, 3, '3 个人机座位都要标出来');
  assert.equal(view.players.filter((p) => !p.isAI).length, 1, '真人座位不标');
  assert.ok(JSON.stringify(view).includes('isAI'), '真人视图里应当有 isAI 身份标记');
});

/* ------------------------------ 座位表边界 ------------------------------ */

/**
 * ⚠️ 这条是"房间层拦得更早"的说明性用例：玩家点【开始游戏】被拒时看到的
 * **不是**这里的报错，而是房间层那句
 * 「座位不够：至少要 2 个座位（现在 1 个）。按「添加人机」补一个，或者等朋友进来」。
 * 接入层自己也要站得住：绕过房间层直接调时给一句中文，不许抛英文栈。
 */
test('座位不够（只有 1 个座位）：接入层也拒绝，而且是中文', () => {
  assert.throws(
    () => createMatch([{ id: HUMAN.id, name: HUMAN.name, isBot: false }]),
    (err) => {
      assert.match(err.message, /座位/, `拒绝文案要说清是座位不够：${err.message}`);
      assert.match(err.message, /[\u4e00-\u9fa5]/, '必须是中文（rooms.start 会把它包成提示条）');
      return true;
    },
    '1 个座位建不了局（引擎的 MIN_SEATS=2）'
  );
  // 一个座位都没有 / 超过 4 个座位，同样不许把服务端弄崩
  assert.throws(() => createMatch([]), /一个人都没有/);
  assert.throws(
    () => createMatch(table([HUMAN, HUMAN2, HUMAN3, HUMAN4], 1)),
    /最多 4 个座位/,
    '5 个座位必须被拒（地图只有 4 座城）'
  );
});

test('垃圾 options 不许把服务端弄炸（allowMidJoin 是客户端输入，乱传就当没传）', () => {
  for (const bad of [null, undefined, 'abc', 0, [], { allowMidJoin: 'abc' }]) {
    const match = createMatch(table([HUMAN], 1), bad);
    assert.equal(X(match).players.length, 2, `options=${JSON.stringify(bad)}：座位表来自 players，与 options 无关`);
    assertNoPendingAi(match, `options=${JSON.stringify(bad)}`);
  }
  // ⚠️ `allowMidJoin` 只认"恰好是 false"那一种（老口径，别改坏）
  const noJoin = createMatch(table([HUMAN], 1), { allowMidJoin: false });
  assert.equal(noJoin.addPlayer(HUMAN2), false, '明确不允许中途加入时必须拒绝');
  assert.equal(createMatch(table([HUMAN], 1), { allowMidJoin: 'abc' }).addPlayer(HUMAN2), true, '垃圾值当没传');
});

test('mid-join：开局后进来的真人按原规则入座，人机座位不动', () => {
  const match = createMatch(table([HUMAN], 1));
  const aiBefore = match._aiIds().slice();

  assert.equal(match.addPlayer(HUMAN2), true, 'allowMidJoin 默认允许中途加入');
  assert.deepEqual(match._aiIds(), aiBefore, '中途加入不动人机座位（让位只发生在开局前的房间层）');
  assert.equal(X(match).players.length, 3);
  assert.ok(match.viewFor(HUMAN2.id), '新来的人拿得到自己的视图');
  assertNoPendingAi(match, '中途加入之后');

  // 满桌之后加不进来（4 个座位已满）
  const full = createMatch(table([HUMAN], 3));
  assert.equal(full.addPlayer(HUMAN2), false, '满桌时必须拒绝');
});

test('removePlayer：有人走了之后 AI 的义务当场跑完（不许卡在场外）', () => {
  const match = createMatch(table([HUMAN, HUMAN2], 2));
  // 让真人甲出拳，逼出"等另一个真人"的状态（AI 早就出完了）
  assert.equal(match.act(HUMAN.id, { kind: 'rps', choice: 'rock' }).ok, true);
  assertNoPendingAi(match, '甲出拳之后');

  match.removePlayer(HUMAN2.id); // 乙掉线超过宽限期
  assertNoPendingAi(match, '乙被踢掉之后');
  assert.equal(
    X(match).alive().some((p) => p.id === HUMAN2.id),
    false,
    '人走了就是出局（本作原来的行为，保持不变）'
  );
});