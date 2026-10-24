/**
 * BladeSteed — 规则单元测试（node:test）
 *
 * 每一条都对着 README.md 里的规则书。引擎是纯逻辑，所以这里不需要浏览器、
 * 也不需要等真实时间（时钟是注入的，超时测试瞬间完成）。
 *
 * 跑：node --test games/blade-steed/tests/rules.test.mjs
 *
 * 原项目用的是自带的小测试框架（`node tests/rules.test.mjs` 直接跑）。
 * 平台上统一改成 node:test —— 这样 `node --test` 能一条一条报出用例名，
 * 而不是「整个文件过了/没过」。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Match } from '../js/engine/engine.js';
import { viewFor } from '../js/view.js';
import {
  ACT,
  ACTION_TIMEOUT_MS,
  MAX_HP,
  ORDER_TIMEOUT_MS,
  PHASE,
  REPLAY_BUFFER_MS,
  RPS_TIMEOUT_MS,
  STEPS_MULTI,
  STEPS_SOLO,
  WILD,
} from '../js/engine/constants.js';
import { aiStep, makeBrains } from '../js/ai/ai.js';
// 「一步演多久」是界面那边定的，这里直接 import 真值 —— 另写一份迟早会分叉。
// board.js 是纯 ESM、模块顶层不碰 DOM（`document` 只在函数体里），所以 Node 里 import 得动。
import { stepMs } from '../js/ui/board.js';

/* ------------------------------ 测试夹具 ------------------------------ */

const NAMES = ['甲', '乙', '丙', '丁'];
const IDS = ['a', 'b', 'c', 'd'];

/** 造一局，玩家 id 是 a/b/c/d，名字是 甲乙丙丁 */
function makeMatch(n = 2, { seed = 7, now, ai = false } = {}) {
  const players = IDS.slice(0, n).map((id, i) => ({ id, name: NAMES[i], isAI: ai }));
  return new Match({ players, seed, now });
}

const P = (m, id) => m.player(id);
/** 原测试框架的 eq：这里就是 deepEqual（值比较），只是名字短一点 */
const eq = (actual, expected, msg) => assert.deepStrictEqual(actual, expected, msg);

/**
 * 测试夹具：直接把某人摆到某个位置。
 * 只为「构造场景」，合法性校验本身仍然全部走 act()/legalActions()。
 */
function place(m, id, where) {
  P(m, id).place = where;
}

/** 一轮猜拳：choices 是 { id: 'rock'|'scissors'|'paper' } */
function pick(m, choices) {
  const out = {};
  for (const [id, c] of Object.entries(choices)) out[id] = m.submitRps(id, c);
  return out;
}

/** 让 solo 独自获胜（其他人出被克制的手势），返回该玩家 */
function soloWin(m, solo, choice = 'rock', loserChoice = 'scissors') {
  const choices = {};
  for (const p of m.players) choices[p.id] = p.id === solo ? choice : loserChoice;
  pick(m, choices);
  return P(m, solo);
}

/** 走完小猜拳：让 decider 成为唯一决胜者 */
function decideBy(m, decider) {
  const cands = m.mini.candidates.slice();
  const choices = {};
  for (const id of cands) choices[id] = id === decider ? 'rock' : 'scissors';
  pick(m, choices);
  return m.mini.decider;
}

/* ------------------------------ 基础设定 ------------------------------ */

test('初始属性：每人 10 血、开局在自己城内、无装备', () => {
  const m = makeMatch(4);
  eq(m.players.length, 4);
  for (const p of m.players) {
    eq(p.hp, MAX_HP, `${p.name} 初始血量`);
    eq(p.place, p.id, `${p.name} 开局应在自己城内`);
    eq(p.knife, false);
    eq(p.horse, false);
    eq(p.alive, true);
  }
});

test('开局随机分配座位 1..N，互不重复', () => {
  const m = makeMatch(4);
  const seats = m.players.map((p) => p.seat).sort();
  eq(seats, [1, 2, 3, 4]);
});

test('座位数必须是 2–4（1 个座位的对局永远分不出胜负，所以引擎卡 MIN_SEATS=2）', () => {
  assert.throws(() => makeMatch(1), '1 个座位应该被拒绝');
  const five = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, name: NAMES[i] || '戊' }));
  assert.throws(() => new Match({ players: five }), '5 人应该被拒绝');
});

/* ------------------------------ 猜拳与步数 ------------------------------ */

test('只有 1 人获胜：获得 2 步行动', () => {
  const m = makeMatch(4);
  soloWin(m, 'b');
  eq(m.phase, PHASE.ACTION);
  eq(m.current, 'b');
  eq(m.stepsLeft, STEPS_SOLO);
  eq(m.steps.b, STEPS_SOLO);
  eq(m.queue, ['b']);
});

test('≥2 人获胜：各 1 步，进入小猜拳决定顺序', () => {
  const m = makeMatch(4);
  pick(m, { a: 'rock', b: 'rock', c: 'scissors', d: 'scissors' });
  eq(m.phase, PHASE.ORDER);
  eq(m.mainWinners.sort(), ['a', 'b']);
  eq(m.steps.a, STEPS_MULTI);
  eq(m.steps.b, STEPS_MULTI);
  // 小猜拳：a 赢 → a 是决胜者
  eq(decideBy(m, 'a'), 'a');
  eq(m.submitOrder('a', ['b', 'a']).ok, true);
  eq(m.phase, PHASE.ACTION);
  eq(m.queue, ['b', 'a'], '行动顺序应完全按决胜者的决定');
});

test('3 人获胜：小猜拳里又出现 2 人获胜则继续猜，直到唯一胜者', () => {
  const m = makeMatch(4);
  pick(m, { a: 'rock', b: 'rock', c: 'rock', d: 'scissors' });
  eq(m.mainWinners.sort(), ['a', 'b', 'c']);
  eq(m.steps.a, 1);
  // 第一轮小猜拳：a、b 出布，c 出石头 → a、b 获胜，继续
  pick(m, { a: 'paper', b: 'paper', c: 'rock' });
  eq(m.mini.round, 2);
  eq(m.mini.candidates.sort(), ['a', 'b']);
  // 第二轮：b 赢
  eq(decideBy(m, 'b'), 'b');
  eq(m.submitOrder('b', ['c', 'a', 'b']).ok, true);
  eq(m.queue, ['c', 'a', 'b']);
});

test('无胜者（三种手势齐全 / 全员同一手势）都重开猜拳', () => {
  const m = makeMatch(3);
  pick(m, { a: 'rock', b: 'scissors', c: 'paper' });
  eq(m.phase, PHASE.RPS, '三种手势循环克制 → 无人获胜 → 重新猜拳');
  eq(m.rps.winners, []);
  pick(m, { a: 'rock', b: 'rock', c: 'rock' });
  eq(m.phase, PHASE.RPS, '全员同一手势 → 无人获胜 → 重新猜拳');
  soloWin(m, 'c');
  eq(m.phase, PHASE.ACTION);
});

test('猜拳提交幂等：重复同一手势成功，换手势被拒', () => {
  const m = makeMatch(3);
  eq(m.submitRps('a', 'rock').ok, true);
  eq(m.submitRps('a', 'rock').ok, true);
  eq(m.submitRps('a', 'paper').ok, false);
  eq(m.submitRps('a', '火').ok, false);
});

test('猜拳超时由系统随机代出，绝不停摆', () => {
  let t = 0;
  const m = makeMatch(3, { now: () => t });
  m.submitRps('a', 'rock');
  t += RPS_TIMEOUT_MS + 1;
  eq(m.tick(), true);
  assert.ok(m.phase !== PHASE.RPS || m.rps.submitted.b, '超时后必须已经代出');
  assert.ok(m.phase === PHASE.ACTION || m.phase === PHASE.ORDER || m.rps.round === m.round);
});

test('小猜拳与排序都有超时兜底', () => {
  let t = 0;
  const m = makeMatch(3, { now: () => t });
  pick(m, { a: 'rock', b: 'rock', c: 'scissors' });
  eq(m.phase, PHASE.ORDER);

  // 小猜拳超时：系统随机代出。运气不好两边撞成同一种手势时，
  // 规则要求「再次猜拳」——那也是正常的，所以这里只要求「一定在推进」，
  // 并且最终必须能决出唯一决胜者（不允许永久卡住）。
  let guard = 0;
  while (!m.mini.decider && guard < 200) {
    t += RPS_TIMEOUT_MS + 1;
    m.tick();
    guard += 1;
  }
  assert.ok(m.mini.decider, '小猜拳超时后最终必须有人成为决胜者');
  assert.ok(guard < 200, `小猜拳重赛次数异常：${guard}`);

  t += ORDER_TIMEOUT_MS + 1;
  m.tick();
  eq(m.phase, PHASE.ACTION, '排序超时后必须自动开打');
  eq(m.queue.length, 2);
});

test('行动超时会自动结束剩余步数并把回合交出去', () => {
  let t = 0;
  const m = makeMatch(3, { now: () => t });
  pick(m, { a: 'rock', b: 'rock', c: 'scissors' });
  decideBy(m, 'a');
  m.submitOrder('a', ['a', 'b']);
  eq(m.current, 'a');
  t += ACTION_TIMEOUT_MS + 1;
  eq(m.tick(), true);
  assert.ok(m.current !== 'a', '超时后不能还卡在同一个人身上');
});

/* ------------------------------ 装备购买 ------------------------------ */

test('买刀 / 买马：只在城内可买，消耗 1 步，永久持有', () => {
  const m = makeMatch(2);
  soloWin(m, 'a'); // 2 步
  eq(m.act('a', { type: ACT.BUY_KNIFE }).ok, true);
  eq(m.stepsLeft, 1);
  eq(P(m, 'a').knife, true);
  eq(m.act('a', { type: ACT.BUY_HORSE }).ok, true);
  eq(m.stepsLeft, 0);
  eq(P(m, 'a').horse, true);
  assert.ok(m.current !== 'a' || m.stepsLeft === 0, '两步用完必须交出回合');
});

test('野外不能买装备，也不能重复买', () => {
  const m = makeMatch(2);
  soloWin(m, 'a');
  eq(m.act('a', { type: ACT.MOVE_OUT }).ok, true);
  eq(P(m, 'a').place, WILD);
  eq(m.act('a', { type: ACT.BUY_KNIFE }).ok, false, '野外不能买刀');

  const m2 = makeMatch(2);
  soloWin(m2, 'a');
  eq(m2.act('a', { type: ACT.BUY_KNIFE }).ok, true);
  eq(m2.act('a', { type: ACT.BUY_KNIFE }).ok, false, '已经买过就不能再买');
});

/* ------------------------------ 位移 ------------------------------ */

test('出城 / 进城：可指定任意一个人的城（含自己的城、含出局者的城）', () => {
  const m = makeMatch(3);
  soloWin(m, 'a'); // 2 步：出城 → 进城
  eq(m.act('a', { type: ACT.MOVE_OUT }).ok, true);
  eq(P(m, 'a').place, WILD);
  eq(m.act('a', { type: ACT.MOVE_IN, target: 'c' }).ok, true);
  eq(P(m, 'a').place, 'c');

  // 出局者的城永久存在
  const m3 = makeMatch(3);
  soloWin(m3, 'a');
  m3._eliminate('c', '测试');
  eq(m3.alive().length, 2);
  eq(m3.legalActions('a').some((x) => x.type === ACT.BUY_KNIFE), true, 'a 还在城里');
  const m4 = makeMatch(3);
  soloWin(m4, 'a');
  m4.act('a', { type: ACT.MOVE_OUT });
  m4._eliminate('c', '测试');
  eq(m4.legalActions('a').some((x) => x.type === ACT.MOVE_IN && x.target === 'c'), true, '可以进已出局者的城');
});

test('野外不能「出城」、城里不能凭空「进城」', () => {
  const m = makeMatch(2);
  soloWin(m, 'a');
  eq(m.act('a', { type: ACT.MOVE_OUT }).ok, true);
  eq(m.act('a', { type: ACT.MOVE_OUT }).ok, false, '已经在野外不能再出城');
  eq(m.act('a', { type: ACT.MOVE_IN, target: '不存在' }).ok, false);
});

/* ------------------------------ 攻击 ------------------------------ */

test('刀：需要已买刀 + 双方同一位置（同城或同在野外）', () => {
  const m = makeMatch(2);
  soloWin(m, 'a');
  eq(m.act('a', { type: ACT.KNIFE, target: 'b' }).ok, false, '没买刀不能刀人');
  m.act('a', { type: ACT.BUY_KNIFE });

  // 两人各在自己城内 → 不同位置
  const m2 = makeMatch(3);
  soloWin(m2, 'a');
  m2.act('a', { type: ACT.BUY_KNIFE });
  eq(m2.act('a', { type: ACT.KNIFE, target: 'b' }).ok, false, '不同位置不能刀');

  // 同城：a 进城到 b
  const m3 = makeMatch(3);
  soloWin(m3, 'a');
  P(m3, 'a').knife = true;
  place(m3, 'a', 'b');
  eq(m3.act('a', { type: ACT.KNIFE, target: 'b' }).ok, true);
  eq(P(m3, 'b').hp, MAX_HP - 1);

  // 同在野外
  const m4 = makeMatch(3);
  soloWin(m4, 'a');
  P(m4, 'a').knife = true;
  P(m4, 'a').place = WILD;
  P(m4, 'b').place = WILD;
  eq(m4.act('a', { type: ACT.KNIFE, target: 'b' }).ok, true, '野外两人可以互刀');
  eq(P(m4, 'b').hp, MAX_HP - 1);
});

test('踹：需要已买马 + 双方同在同一城内，扣 3 血并强制踢到野外', () => {
  const m = makeMatch(3);
  soloWin(m, 'a');
  place(m, 'a', 'b');
  place(m, 'c', 'b'); // 三人都在 b 的城里
  eq(m.act('a', { type: ACT.KICK, target: 'b' }).ok, false, '没买马不能踹');
  P(m, 'a').horse = true;
  eq(m.act('a', { type: ACT.KICK, target: 'b' }).ok, true);
  eq(P(m, 'b').hp, MAX_HP - 3);
  eq(P(m, 'b').place, WILD, '被踹的人必须被踢到野外');
  eq(P(m, 'a').place, 'b', '踹人的人留在原地');
});

test('踹：野外不能踹，城里的人也踹不到野外的人', () => {
  // 双方都在野外
  const m = makeMatch(3);
  soloWin(m, 'a');
  P(m, 'a').horse = true;
  P(m, 'a').place = WILD;
  P(m, 'b').place = WILD;
  eq(m.act('a', { type: ACT.KICK, target: 'b' }).ok, false, '野外不能踹');

  // a 在城里（自己的城），b 在野外 → 位置不同，踹不到
  const m2 = makeMatch(3);
  soloWin(m2, 'a');
  P(m2, 'a').horse = true;
  P(m2, 'b').place = WILD;
  eq(P(m2, 'a').place, 'a', 'a 在自己的城里');
  eq(m2.act('a', { type: ACT.KICK, target: 'b' }).ok, false, '对方在野外，踹不到');

  // a 在城里，b 在另一座城 → 不是同一个城，踹不到
  const m3 = makeMatch(3);
  soloWin(m3, 'a');
  P(m3, 'a').horse = true;
  eq(m3.act('a', { type: ACT.KICK, target: 'c' }).ok, false, '不同城踹不到');
});

test('每 1 步只能做 1 个操作，2 步可以自由组合两个操作', () => {
  const m = makeMatch(3);
  soloWin(m, 'a');
  eq(m.stepsLeft, 2);
  eq(m.act('a', { type: ACT.BUY_KNIFE }).ok, true);
  eq(m.stepsLeft, 1);
  eq(m.act('a', { type: ACT.MOVE_OUT }).ok, true);
  eq(m.stepsLeft, 0);
  eq(m.current, null, '两步用完，回合结束');
});

test('可以主动结束剩余步数（防卡局）', () => {
  const m = makeMatch(3);
  pick(m, { a: 'rock', b: 'rock', c: 'scissors' });
  decideBy(m, 'a');
  m.submitOrder('a', ['a', 'b']);
  eq(m.stepsLeft, 1);
  eq(m.act('a', { type: ACT.PASS }).ok, true);
  eq(m.current, 'b', '结束时立刻把回合交给下一位');
});

/* ------------------------------ 胜负 ------------------------------ */

test('血量 ≤0 立即淘汰', () => {
  const m = makeMatch(3);
  soloWin(m, 'a');
  P(m, 'a').knife = true;
  place(m, 'a', 'b');
  P(m, 'b').hp = 1;
  eq(m.act('a', { type: ACT.KNIFE, target: 'b' }).ok, true);
  eq(P(m, 'b').alive, false);
  eq(P(m, 'b').hp, 0);
});

test('踹死：扣 3 血后出局，且出局前先被踢出城', () => {
  const m = makeMatch(3);
  soloWin(m, 'a');
  P(m, 'a').horse = true;
  place(m, 'a', 'b');
  place(m, 'b', 'b');
  P(m, 'b').hp = 2;
  eq(m.act('a', { type: ACT.KICK, target: 'b' }).ok, true);
  eq(P(m, 'b').alive, false);
  eq(P(m, 'b').place, WILD);
});

test('场上最后存活的一人获胜，一键重新开局可用', () => {
  const m = makeMatch(2);
  soloWin(m, 'a');
  P(m, 'a').knife = true;
  place(m, 'a', 'b');
  P(m, 'b').hp = 1;
  m.act('a', { type: ACT.KNIFE, target: 'b' });
  eq(m.phase, PHASE.OVER);
  eq(m.winner, 'a');

  const beforeRestart = m._eventId;
  m.restart();
  eq(m.phase, PHASE.RPS);
  eq(m.winner, null);
  eq(m.round, 1);
  for (const p of m.players) {
    eq(p.hp, MAX_HP);
    eq(p.alive, true);
    eq(p.knife, false);
    eq(p.horse, false);
    eq(p.place, p.id);
  }
  assert.ok(
    m.events[0].id === beforeRestart + 1,
    '事件编号必须跨局保持单调，否则客户端会把重新开局的新事件当成旧的丢弃'
  );
});

test('玩家退出 / 断连自动判定出局', () => {
  const m = makeMatch(3);
  eq(m.leave('c').ok, true);
  eq(P(m, 'c').alive, false);
  eq(m.alive().length, 2);
  // 出局后不再需要他出拳
  pick(m, { a: 'rock', b: 'scissors' });
  eq(m.phase, PHASE.ACTION);
});

/* ------------------------------ 权威 / 视图裁剪 ------------------------------ */

test('权威校验：不是当前行动者、不是行动阶段的操作一律被拒', () => {
  const m = makeMatch(3);
  eq(m.act('a', { type: ACT.MOVE_OUT }).ok, false, '猜拳阶段不能行动');
  soloWin(m, 'a');
  eq(m.act('b', { type: ACT.MOVE_OUT }).ok, false, '没轮到 b');
  eq(m.act('a', { type: ACT.KICK, target: 'x' }).ok, false, '目标不存在');
});

test('视图裁剪：不泄露对手手势；AI 决策吃的那一档不下发 isAI', () => {
  const m = makeMatch(3);
  m.submitRps('a', 'rock');
  m.submitRps('b', 'paper');
  const va = viewFor(m, 'a');
  eq(va.rps.myChoice, 'rock');
  eq(va.rps.ready.a, true);
  eq(va.rps.ready.c, false);
  eq('submitted' in va.rps, false, '视图里不能有完整的出手表');
  // 这里用的是**裸** viewFor —— 也就是 aiStep 递给 AI 的那一份：里面没有 isAI。
  // （带 isAI 的是"发给玩家"的那一档：服务端 `viewFor` 传 exposeAI: true，见 js/view.js 顶部。
  //   身份是公开信息，但 AI 拿不到它就少一条"谁是真人"的线索 —— 这条结构性保证要保住。）
  assert.ok(!JSON.stringify(va).includes('isAI'), 'AI 决策吃的那一档里绝不能出现 isAI 字段');
  // rpsChoices 是「可选手势清单」，本来就该有 paper；
  // 真正要检查的是 rps 这一块里不含别人出了什么。
  assert.ok(!JSON.stringify(va.rps).includes('paper'), '不能泄露别人出了什么');
  eq(va.rps.myChoice, 'rock', '自己的手势自己看得到');
  assert.ok(!JSON.stringify(va.mini || {}).includes('paper'), '小猜拳同样不能泄露');
});

/**
 * 上面那条是「构造一个局面」的定点检查。这一条是**整局扫描**：
 * 用 AI 自对弈走完一整局，每一步都对每个人做一次「泄露预言机」——
 * 拿引擎内部的出手表当答案，逐个手势断言它没有出现在别人的视图里。
 * 定点检查只能证明那一刻没漏，扫整局才能证明**任何时刻**都没漏。
 */
test('视图不泄露：整局扫描，任何时刻别人的手势都不在报文里', () => {
  const m = makeMatch(4, { seed: 20260101, ai: true });
  const brains = makeBrains(m.players);
  let guard = 0;
  let checkedStates = 0;

  while (m.phase !== PHASE.OVER && guard < 20000) {
    for (const p of m.alive()) {
      const v = viewFor(m, p.id);
      const text = JSON.stringify(v);
      // 裸 viewFor = AI 决策吃的那一档，没有身份标记（见上面那条用例的说明）
      assert.ok(!text.includes('isAI'), `AI 决策吃的那一档里出现了 isAI（给 ${p.id}）`);

      if (m.phase === PHASE.RPS && m.rps) {
        const block = JSON.stringify(v.rps);
        for (const [pid, hand] of Object.entries(m.rps.submitted)) {
          if (pid === p.id) continue;
          assert.ok(!block.includes(hand), `别人还没揭晓的手势泄露给 ${p.id}：${hand}`);
        }
        assert.ok(!('submitted' in v.rps), '视图不能带完整出手表');
        for (const val of Object.values(v.rps.ready)) {
          assert.equal(typeof val, 'boolean', 'ready 只能是布尔值（谁出了，不是出了什么）');
        }
      }

      if (m.phase === PHASE.ORDER && m.mini && !m.mini.decider) {
        const block = JSON.stringify(v.mini);
        for (const [pid, hand] of Object.entries(m.mini.submitted)) {
          if (pid === p.id) continue;
          assert.ok(!block.includes(hand), `小猜拳里别人的手势泄露给 ${p.id}：${hand}`);
        }
      }
      checkedStates += 1;
    }
    if (!aiStep(m, brains, viewFor) && !m.tick()) break;
    guard += 1;
  }

  eq(m.phase, PHASE.OVER, '自对弈必须能打完（否则扫描没覆盖完整局）');
  assert.ok(checkedStates > 100, `扫描到的局面太少：${checkedStates}`);
});

test('无合法动作时永远有「结束行动」兜底（死锁不变量）', () => {
  const m = makeMatch(2);
  soloWin(m, 'a');
  m.act('a', { type: ACT.MOVE_OUT });
  const acts = m.legalActions('a');
  assert.ok(acts.some((x) => x.type === ACT.PASS), '任何时刻都必须能结束行动');
});

/* ------------------------------ 中途加入 ------------------------------ */

test('中途加入：不影响本轮已定顺序，下一回合参与', () => {
  const m = makeMatch(2);
  m.addPlayer({ id: 'z', name: '机', isAI: true });
  eq(m.players.length, 3);
  eq(P(m, 'z').hp, MAX_HP);
  eq(P(m, 'z').place, 'z');
  const seats = m.players.map((p) => p.seat).sort();
  eq(seats, [1, 2, 3], '新玩家要占一个空座位');
  // 猜拳阶段加入 → 必须等他出拳
  pick(m, { a: 'rock', b: 'scissors' });
  eq(m.phase, PHASE.RPS, '还有人在猜拳，不能直接开打');
  m.submitRps('z', 'scissors');
  eq(m.phase, PHASE.ACTION);
  eq(m.alive().length, 3);

  // 上限 4 人
  m.addPlayer({ id: 'y', name: '器', isAI: true });
  eq(m.addPlayer({ id: 'x', name: '械', isAI: true }).ok, false);
});

/* ------------------------------ 位置合法性交叉检查 ------------------------------ */

test('legalActions 与 act 的判定完全一致（UI/AI/校验同一份真相）', () => {
  const m = makeMatch(3);
  soloWin(m, 'a');
  P(m, 'a').knife = true;
  P(m, 'a').horse = true;
  place(m, 'a', 'b');
  place(m, 'b', 'b');
  place(m, 'c', WILD);
  const acts = m.legalActions('a');
  const key = (x) => `${x.type}:${x.target || ''}`;
  const legalKeys = acts.map(key);
  for (const a of acts) {
    if (a.type === ACT.PASS) continue;
    const probe = makeMatch(3);
    soloWin(probe, 'a');
    P(probe, 'a').knife = true;
    P(probe, 'a').horse = true;
    place(probe, 'a', 'b');
    place(probe, 'b', 'b');
    place(probe, 'c', WILD);
    eq(probe.act('a', a).ok, true, `${key(a)} 应该合法`);
  }
  assert.ok(!legalKeys.includes('knife:'), '刀必须指定目标');
  assert.ok(legalKeys.includes('kick:b'), '同城且有马 → 能踹');
  assert.ok(!legalKeys.includes('kick:c'), 'c 在野外 → 不能踹');
  assert.ok(!legalKeys.includes('buy_knife:'), '已经买过刀 → 不能再买');
});

/* ------------------------------ 意图信封（服务端与单机共用） ------------------------------ */

test('handleAct 信封：四种 kind 都能用，失败时给的是可直接显示的中文', () => {
  const m = makeMatch(3);
  eq(m.handleAct('a', { kind: 'rps', choice: 'rock' }), { ok: true });
  eq(m.handleAct('a', { kind: 'rps', choice: '火' }), { ok: false, message: '手势不合法' });
  eq(m.handleAct('a', { kind: 'act', type: ACT.MOVE_OUT }), { ok: false, message: '现在不是行动阶段' });
  eq(m.handleAct('a', { kind: 'order', order: [] }), { ok: false, message: '现在不是排序阶段' });
  eq(m.handleAct('a', { kind: '什么鬼' }), { ok: false, message: '不认识的操作' });
  // tick 只推进超时，永远当作成功（否则客户端心跳会被当成错误弹给玩家）
  eq(m.handleAct('a', { kind: 'tick' }), { ok: true });

  pick(m, { a: 'rock', b: 'scissors', c: 'scissors' });
  eq(m.phase, PHASE.ACTION);
  eq(m.handleAct('a', { kind: 'act', type: ACT.BUY_KNIFE }), { ok: true });
  eq(m.handleAct('b', { kind: 'act', type: ACT.BUY_KNIFE }), { ok: false, message: '还没轮到你行动' });
});

/* ------------------------------ 服务端接入层契约 ------------------------------ */

/**
 * 这一块是**测试专用**的跨层检查：直接 import 平台的接入层，
 * 确认 meta / createMatch 的契约成立（slug 与文件名一致、viewFor 每个座位都出得来…）。
 * 运行时游戏代码不会 import server/ —— 那是平台反向调我们的方向。
 */
test('服务端接入层：meta 合规，createMatch 每个座位都拿得到自己的视图', async () => {
  const mod = await import('../../../server/games/blade-steed.mjs');

  eq(mod.meta.slug, 'blade-steed', 'slug 必须和文件名一致，否则服务器会拒绝加载');
  eq(typeof mod.meta.title, 'string');
  eq(typeof mod.meta.icon, 'string');
  assert.ok(mod.meta.minPlayers <= mod.meta.maxPlayers);
  // minPlayers 数的是**真人**：1 = 一个人点【创建房间】也允许开局 —— 但**座位**得够
  // （`meta.minSeats = 2`，人机也算座位；房间层的「＋ 添加人机」就是干这个的）。
  // 引擎那边的座位下限是 MIN_SEATS=2，两回事 —— 详见 constants.js 的注释。
  eq(mod.meta.minPlayers, 1);
  eq(mod.meta.maxPlayers, 4);
  eq(typeof mod.createMatch, 'function');

  const players = [
    { id: 'P1', name: '甲' },
    { id: 'P2', name: '乙' },
    { id: 'P3', name: '丙' },
  ];
  const match = mod.createMatch(players, {});

  for (const fn of ['viewFor', 'act', 'addPlayer', 'removePlayer', 'isOver', 'result']) {
    eq(typeof match[fn], 'function', `match 必须实现 ${fn}`);
  }
  eq(match.isOver(), false);

  // 每个座位的视图都出得来，而且拿不到别人的手势。
  // 视图里现在**有** isAI 这个字段（身份标记，玩家要靠它把电脑画成另一种样子）——
  // 这一桌全是真人，所以每个座位都必须是 false。带 isAI:true 的情形见 online-ai.test.mjs。
  for (const p of players) {
    const v = match.viewFor(p.id);
    assert.ok(v && Array.isArray(v.players), `${p.name} 的视图不合法`);
    eq(v.players.length, 3);
    assert.ok(
      v.players.every((x) => x.isAI === false),
      '这一桌没有电脑，身份标记必须都是 false：' + JSON.stringify(v.players.map((x) => x.isAI))
    );
  }

  // 操作信封走通，失败时 message 是中文
  eq(match.act('P1', { kind: 'rps', choice: 'rock' }), { ok: true });
  const bad = match.act('P2', { kind: 'act', type: 'move_out' });
  eq(bad.ok, false);
  assert.match(bad.message, /[\u4e00-\u9fa5]/, 'message 必须是中文，会直接显示给玩家');

  // 中途加入：加得进、加满了就拒绝（allowMidJoin 为 true）
  eq(match.addPlayer({ id: 'P4', name: '丁' }), true);
  eq(match.addPlayer({ id: 'P5', name: '戊' }), false, '超过上限要拒绝');

  // 打到结束：isOver 必须真的会翻、result 必须出得来。
  // 这里刻意不写一个"自动打手"（那会把引擎逻辑再抄一遍，抄出来的那份迟早和引擎分叉）——
  // 直接用「其他人离开」这条规则把对局收掉：平台在断线/主动离开时走的就是这个入口。
  eq(match.isOver(), false, '三个人还在场上，不该结束');
  match.removePlayer('P2');
  match.removePlayer('P3');
  eq(match.isOver(), false, '还有两个人，不该结束');
  match.removePlayer('P4');
  eq(match.isOver(), true, '只剩一个人时必须结束');
  const result = match.result();
  eq(result.winner, 'P1');
  eq(typeof result.round, 'number');

  // 结束后再操作一律被拒（房间层会先拦，但接入层自己也要站得住）
  eq(match.act('P1', { kind: 'rps', choice: 'rock' }).ok, false);
});

test('viewFor：局外人一律返回 null；出局的人还能看完这一局', () => {
  const m = new Match({ players: [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }] });

  // 座位上的两个人拿得到视图
  assert.ok(viewFor(m, 'a') !== null);
  assert.ok(viewFor(m, 'b') !== null);

  // 局外人 / 空身份：什么都不给（docs/GAME-SPEC.md 第 4 节的契约：
  // "不是这一局的人返回 null"，否则谁都能旁观别人的牌）
  eq(viewFor(m, 'c'), null, '局外人必须拿不到视图');
  eq(viewFor(m, 'zzz'), null);
  eq(viewFor(m, ''), null);
  eq(viewFor(m, null), null);
  eq(viewFor(m, undefined), null);

  // ⚠️ 出局的人**仍然在名单里**（地图上要显示他的城和尸体），所以要照常给视图 ——
  //    界面上写着"你已出局，可以继续看完这一局"。别为了"更严"把他也挡掉。
  m.leave('b');
  assert.ok(viewFor(m, 'b') !== null, '出局的人还在名单里，应该还能看');
  assert.ok(viewFor(m, 'a') !== null, '留下的人照常拿得到');
});

/* ============================================================================
 * 逐步同步（用户第 1 条需求 / docs/DECISIONS.md D14）
 * ============================================================================
 *
 * 这三条盯的是同一件事的三个面：
 *   · 补丁**够用**：一步一步贴完，画面正好等于权威视图（少了字段/贴错了立刻红）
 *   · 补丁**不泄露**：整份报文（含补丁）里搜不到别人还没揭晓的拳
 *   · 倒计时**够用**：演出那几秒不会把玩家的思考时间吃掉
 */

/** 补丁里允许出现的字段（白名单）。多一个字段就说明有人往报文里塞了新东西，必须想清楚能不能公开。 */
const PATCH_TOP_KEYS = ['phase', 'round', 'current', 'stepsLeft', 'winner', 'mainWinners', 'steps', 'queue', 'players', 'rps', 'mini'];
const PATCH_PLAYER_KEYS = ['id', 'hp', 'alive', 'place', 'knife', 'horse'];
const PATCH_RPS_KEYS = ['round', 'winners', 'ready', 'myChoice'];
const PATCH_MINI_KEYS = ['round', 'candidates', 'ready', 'myChoice', 'decider'];

/** 断言一个补丁的形状合法（白名单 + 类型），并返回它的字段集 */
function checkPatchShape(s, who, where) {
  assert.ok(s && typeof s === 'object', `${where}：补丁必须是个对象（给 ${who}）`);
  for (const k of Object.keys(s)) {
    assert.ok(PATCH_TOP_KEYS.includes(k), `${where}：补丁里出现了没在名单上的字段 ${k} —— 想清楚它能不能公开，再显式加进白名单`);
  }
  if (s.players) {
    assert.ok(Array.isArray(s.players), `${where}：players 必须是数组`);
    for (const p of s.players) {
      for (const k of Object.keys(p)) {
        assert.ok(PATCH_PLAYER_KEYS.includes(k), `${where}：座位补丁里出现了 ${k}（只能有 ${PATCH_PLAYER_KEYS.join('/')}）`);
      }
      assert.equal(typeof p.id, 'string');
      assert.equal(typeof p.hp, 'number');
      assert.equal(typeof p.alive, 'boolean');
      assert.equal(typeof p.knife, 'boolean');
      assert.equal(typeof p.horse, 'boolean');
    }
  }
  if (s.rps) {
    for (const k of Object.keys(s.rps)) {
      assert.ok(PATCH_RPS_KEYS.includes(k), `${where}：猜拳补丁里出现了 ${k}`);
    }
    assert.ok(!('submitted' in s.rps), `${where}：猜拳补丁里带上了完整出手表（那是别人的拳）`);
    for (const val of Object.values(s.rps.ready || {})) {
      assert.equal(typeof val, 'boolean', `${where}：ready 只能是布尔（谁出了，不是出了什么）`);
    }
  }
  if (s.mini) {
    for (const k of Object.keys(s.mini)) {
      assert.ok(PATCH_MINI_KEYS.includes(k), `${where}：小猜拳补丁里出现了 ${k}`);
    }
    assert.ok(!('submitted' in s.mini), `${where}：小猜拳补丁里带上了完整出手表`);
  }
}

/** 客户端那一步的语义（和 js/ui/board.js 的 _applyPatch 同一套）：把补丁盖到显示状态上 */
function applyPatch(disp, s) {
  for (const k of ['phase', 'round', 'current', 'stepsLeft', 'winner']) {
    if (k in s) disp[k] = s[k];
  }
  if (Array.isArray(s.mainWinners)) disp.mainWinners = s.mainWinners.slice();
  if (s.steps) disp.steps = { ...s.steps };
  if (Array.isArray(s.queue)) disp.queue = s.queue.slice();
  if (Array.isArray(s.players)) {
    for (const changed of s.players) {
      const cur = disp.players.find((p) => p.id === changed.id);
      if (cur) Object.assign(cur, changed);
    }
  }
  if (s.rps) disp.rps = { ...(disp.rps || {}), ...s.rps };
  if (s.mini) disp.mini = { ...(disp.mini || {}), ...s.mini };
}

/** 从一份权威视图里取出"补丁负责的那部分公开状态"（deadlineIn 不在补丁里，所以不算） */
function publicProjection(view) {
  const pick = (x, keys) => {
    if (!x) return null;
    const out = {};
    for (const k of keys) if (k in x) out[k] = x[k];
    return out;
  };
  return {
    phase: view.phase,
    round: view.round,
    current: view.current,
    stepsLeft: view.stepsLeft,
    winner: view.winner,
    mainWinners: view.mainWinners,
    steps: view.steps,
    queue: view.queue,
    players: view.players.map((p) => pick(p, PATCH_PLAYER_KEYS)),
    rps: pick(view.rps, ['round', 'winners', 'ready', 'myChoice']),
    mini: pick(view.mini, ['round', 'candidates', 'ready', 'myChoice', 'decider']),
  };
}

test('逐步同步：补丁只带"变了的"字段，按步贴完正好等于权威视图（整局扫描）', () => {
  const m = makeMatch(2, { seed: 4242, ai: true });
  const brains = makeBrains(m.players);
  let cursor = 0; // 已演到哪条事件
  let applied = 0; // 已贴到哪条事件（链子接得上才推进）
  let disp = null;
  let frames = 0;
  let patchedSteps = 0;
  let coldStarts = 0;

  while (m.phase !== PHASE.OVER && frames < 2000) {
    if (!aiStep(m, brains, viewFor) && !m.tick()) break;
    const view = viewFor(m, 'a', { exposeAI: true });
    const events = view.events;
    const maxId = events.length ? events[events.length - 1].id : 0;

    // ① 每条事件的补丁形状都要站得住（多一个字段/类型不对立刻红）
    for (const e of events) checkPatchShape(e.s, 'a', `事件 #${e.id}(${e.t})`);

    // ② 首次挂载 = 直接采用权威视图（界面上就是"你已经看过了"这条路）
    if (disp === null) {
      disp = publicProjection(view);
      cursor = maxId;
      applied = maxId;
      coldStarts += 1;
      frames += 1;
      continue;
    }

    // ③ 只演新事件：链子接得上才贴补丁（接不上就交给对账，这里相当于对账）
    const fresh = events.filter((e) => e.id > cursor);
    cursor = maxId || cursor;
    for (const e of fresh) {
      if (e.s && e.id === applied + 1) {
        applyPatch(disp, e.s);
        applied = e.id;
        patchedSteps += 1;
      }
    }
    // ④ 补丁负责的那部分公开状态必须和权威视图**逐字段**相等
    eq(disp, publicProjection(view), `第 ${frames} 帧贴完补丁之后和权威视图对不上（事件 ${applied}/${maxId}）`);
    frames += 1;
  }

  eq(m.phase, PHASE.OVER, '自对弈必须能打完，否则这条扫描没覆盖完整局');
  assert.ok(patchedSteps > 50, `贴过的补丁太少（${patchedSteps}），这条用例没测到东西`);
  eq(coldStarts, 1, '整局只该有"首次挂载"那一次直接采用权威视图');

  // 顺带钉住"补丁只带变了的字段"：买刀那一步只有买东西的人变了，
  // 补丁里就**只该有他一个座位**（不能把整桌人再抄一遍 —— 那正是报文变大的原因）
  const m2 = makeMatch(2);
  soloWin(m2, 'a');
  m2.act('a', { type: ACT.BUY_KNIFE });
  const buy = viewFor(m2, 'a', { exposeAI: true }).events.filter((e) => e.t === 'buy').pop();
  assert.ok(buy && buy.s, '买刀那一步必须带补丁');
  eq(buy.s.players, [{ id: 'a', hp: 10, alive: true, place: 'a', knife: true, horse: false }], '补丁里只该有变了的那一个座位');
  assert.equal(buy.s.steps.a, 1, '步数必须真的变了：' + JSON.stringify(buy.s));
  assert.ok(!('rps' in buy.s) && !('mini' in buy.s), '买刀跟猜拳无关，补丁里不该重复猜拳那一块');
  assert.ok(!('round' in buy.s) && !('phase' in buy.s), '回合/阶段都没变，不该出现：' + JSON.stringify(buy.s));
});

test('逐步同步：整包 JSON（含补丁）里搜不到别人还没揭晓的拳', () => {
  // 定点场景：甲还没出拳，乙出布、丙出剪刀 —— 这两手在这一刻是**私有**的。
  const m = makeMatch(3);
  m.submitRps('b', 'paper');
  m.submitRps('c', 'scissors');
  eq(m.phase, PHASE.RPS, '还有人在猜拳，不该开奖');

  const va = viewFor(m, 'a', { exposeAI: true });
  // `rpsChoices` 是「可选手势清单」，本来就该有 rock/paper/scissors 三个词 —— 先摘掉它再搜。
  const { rpsChoices, ...rest } = va;
  eq(rpsChoices.length, 3, '可选手势清单还是要给的');
  const text = JSON.stringify(rest);
  assert.ok(!text.includes('paper'), '乙出的布泄露了（整份报文，含补丁）');
  assert.ok(!text.includes('scissors'), '丙出的剪刀泄露了（整份报文，含补丁）');
  assert.ok(!text.includes('submitted'), '整份报文里不能出现完整出手表');
  assert.ok(text.includes('"ready"'), '要给出"谁已经出了"的布尔标记（不然界面画不出来）');

  // 我自己的那一手照样看得到（补丁里也带）。⚠️ 这里必须是"这一轮还没开奖"的局面
  // （只出了我一个人）—— 三个人都出完就开奖/重猜了，新窗口的 myChoice 当然是 null。
  const m5 = makeMatch(3);
  m5.submitRps('a', 'rock');
  const v5 = viewFor(m5, 'a', { exposeAI: true });
  eq(v5.rps.myChoice, 'rock');
  const myPatches = JSON.stringify(v5.events.map((e) => e.s));
  assert.ok(myPatches.includes('rock'), '我自己出的拳必须出现在补丁里');
  assert.ok(!myPatches.includes('paper'), '开奖前别人的拳照样不许出现');

  // 小猜拳同一套口径：a/b 出石头赢、c 剪刀输 → 小猜拳只让 a/b 再猜
  const m4 = makeMatch(3);
  pick(m4, { a: 'rock', b: 'rock', c: 'scissors' });
  eq(m4.phase, PHASE.ORDER, '两个赢家 → 进小猜拳');
  m4.submitRps('a', 'paper');
  const v4 = viewFor(m4, 'b', { exposeAI: true });
  const text4 = JSON.stringify({ ...v4, rpsChoices: undefined });
  assert.ok(!text4.includes('paper'), '小猜拳里别人出的布泄露了');
  eq(v4.mini.myChoice, null, '我自己还没出小猜拳');
  assert.equal(typeof v4.mini.ready.a, 'boolean', '小猜拳的 ready 只能是布尔');
});

test('倒计时缓冲：演出那几秒不占玩家的思考时间（队列空时剩余 ≥ 标称的 90%）', () => {
  /*
   * 用户看到的倒计时是**服务器给的剩余**（board.js 在队列演完之后才显示它，
   * ⛔ 本机绝不自己加时间）。所以能保证"队列空的那一刻还剩 ≥90%"的只有一件事：
   * 服务器每段限时多给的 `REPLAY_BUFFER_MS` 必须**盖得住一次演出的时长**。
   *
   * 这里用的是"对手动一步"这种常规小批（用户报的那两条毛病就发生在它身上）：
   * 每一步的时长是 board.js 的 `stepMs()`（真实值，不是这里另写一份）。
   */
  const oneStep = { t: 'buy', pid: 'b', item: 'knife' };
  const small = [oneStep, { t: 'turn', pid: 'b' }];
  const played = small.reduce((sum, e) => sum + stepMs(e), 0);
  const left = RPS_TIMEOUT_MS - played;
  assert.ok(
    left >= 0.9 * (RPS_TIMEOUT_MS - REPLAY_BUFFER_MS),
    `两小步演完只剩 ${left}ms（演出 ${played}ms，限时 ${RPS_TIMEOUT_MS}ms，其中缓冲 ${REPLAY_BUFFER_MS}ms）`
  );

  // 三段限时都要成立（猜拳 10s / 定顺序 15s / 行动 60s）
  for (const [name, total, buffer] of [
    ['猜拳', RPS_TIMEOUT_MS, REPLAY_BUFFER_MS],
    ['定顺序', ORDER_TIMEOUT_MS, REPLAY_BUFFER_MS],
    ['行动', ACTION_TIMEOUT_MS, REPLAY_BUFFER_MS],
  ]) {
    const nominal = total - buffer;
    const left2 = total - played;
    assert.ok(left2 >= 0.9 * nominal, `${name}：演完只剩 ${left2}ms，标称 ${nominal}ms`);
  }

  // 单步最长的那几种（砍/踹/倒下/结算 700ms）也要留得住 90%
  const worst1 = Math.max(...['knife', 'kick', 'down', 'over', 'rps-reveal', 'mini-reveal', 'buy', 'move', 'order', 'pass'].map((t) => stepMs({ t })));
  assert.ok(RPS_TIMEOUT_MS - worst1 >= 0.9 * (RPS_TIMEOUT_MS - REPLAY_BUFFER_MS), '连最长的那一步都不该吃掉 10%');
});