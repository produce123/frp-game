/*
 * 斗地主 —— 规则与状态机的单测（Node 自己的 test runner，没有第三方依赖）。
 *
 * 这里钉的是**服务器权威那一半**：牌型怎么认、谁能压谁、叫地主/抢地主怎么走、
 * 什么时候算赢，以及**隐藏信息一个字都不许出现在视图里**。
 *
 * 上游是 github.com/blmz/GODOT-DouDiZhu（Godot 4.4，单机打两个弱 AI）。
 * 规则从它那里搬过来，但有三处**故意的差异**，测试里逐条钉住（改之前先读
 * `js/engine/rules.js` 的文件头）：
 *   1. 上游 `比较牌型大小()` 只比头点数，不比牌型、不比张数 —— 三家真人根本没法打。
 *      这里按"同牌型 + 同张数 + 比点数，炸弹压普通，王炸最大"。
 *   2. 上游叫地主只问玩家自己（另外两家是 AI 随机），这里改成三家依次叫 + 抢。
 *   3. 上游有倍数/春天/倒计时，这里没有（用户拍板：三个真人，不打钱）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDeck, shuffle, rankText } from '../js/engine/cards.js';
import { TYPE, classify, canBeat, isRun, isPairRun, isTripleRun } from '../js/engine/rules.js';
import { createGame, SEAT_COUNT } from '../js/engine/game.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(HERE, '..', 'js', 'engine');

/* ============================== 小工具 ============================== */

/** 造几张牌（只关心点数，花色随便，够 classify 用）。 */
function cards(...ranks) {
  return ranks.map((r, i) => ({ r, s: i % 4 }));
}

function ok(result, label) {
  assert.ok(result && result.ok, `${label} 应该成功，实际：${JSON.stringify(result)}`);
  return result;
}

function bad(result, label, hint) {
  assert.ok(result && result.ok === false, `${label} 应该被拒，实际：${JSON.stringify(result)}`);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 2, `${label} 的拒绝理由要是人话：${result.message}`);
  if (hint) assert.ok(result.message.includes(hint), `${label} 的拒绝理由里应该提到「${hint}」，实际：${result.message}`);
  return result;
}

/** 可复现的伪随机（线性同余，够用了）。 */
function seeded(seed = 12345) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const PLAYERS = [
  { id: 'p1', name: '甲' },
  { id: 'p2', name: '乙' },
  { id: 'p3', name: '丙' },
];

/** 场上该谁行动（视图里的 turn 是绝对座位号）。 */
function turnSeat(game, players = PLAYERS) {
  return game.viewFor(players[0].id).turn;
}

function viewOf(game, index, players = PLAYERS) {
  return game.viewFor(players[index].id);
}

/**
 * 把叫地主/抢地主推到底。
 *
 * @param {object} game
 * @param {{callSeat?:number|null, robSeat?:number|null}} plan 谁叫、谁抢
 */
function finishBidding(game, plan = {}, players = PLAYERS) {
  const { callSeat = null, robSeat = null } = plan;
  for (let i = 0; i < 120; i += 1) {
    const view = game.viewFor(players[0].id);
    if (view.phase !== 'bidding') return view;
    const seat = view.turn;
    const wants = view.stage === 'call' ? seat === callSeat : seat === robSeat;
    ok(game.act(players[seat].id, { type: 'bid', value: wants ? 1 : 0 }), `${seat} 号叫/抢地主`);
  }
  throw new Error('叫地主阶段推不完');
}

/** 起一局推进到出牌阶段，返回 { game, landlord } */
function playingGame(seed = 29) {
  const game = createGame({ players: PLAYERS, rng: seeded(seed) });
  const caller = turnSeat(game);
  ok(game.act(PLAYERS[caller].id, { type: 'bid', value: 1 }), '叫地主');
  finishBidding(game, {});
  return { game, landlord: caller };
}

/* ============================== 牌型：认牌 ============================== */

test('牌型：单张 / 对子 / 三张', () => {
  assert.equal(classify(cards(5)).type, TYPE.单张);
  assert.equal(classify(cards(5, 5)).type, TYPE.对子);
  assert.equal(classify(cards(9, 9, 9)).type, TYPE.三张);
});

test('牌型：三带一 / 三带二（大小只看三张那个点数）', () => {
  const a = classify(cards(7, 7, 7, 3));
  assert.equal(a.type, TYPE.三带一);
  assert.equal(a.rank, 7);
  const b = classify(cards(7, 7, 7, 3, 3));
  assert.equal(b.type, TYPE.三带二);
  assert.equal(b.rank, 7);
});

test('牌型：炸弹 / 王炸', () => {
  assert.equal(classify(cards(6, 6, 6, 6)).type, TYPE.炸弹);
  const rocket = classify(cards(16, 17));
  assert.equal(rocket.type, TYPE.王炸);
  assert.equal(rocket.rank, 17);
  assert.notEqual(rocket.type, TYPE.对子, '两个王不是对子');
});

test('牌型：顺子 5~12 张、最大到 A、不能带 2 和王', () => {
  assert.equal(classify(cards(3, 4, 5, 6, 7)).type, TYPE.顺子);
  assert.equal(classify(cards(3, 4, 5, 6, 7)).tail, 7);
  const toA = classify(cards(10, 11, 12, 13, 14));
  assert.equal(toA.type, TYPE.顺子);
  assert.equal(toA.tail, 14);
  // 带 2 不算顺子（上游口径：到 A 为止）
  assert.equal(classify(cards(11, 12, 13, 14, 15)), null);
  assert.ok(!isRun([11, 12, 13, 14, 15]));
  // 不连续不算；只有 4 张也不算
  assert.equal(classify(cards(3, 4, 5, 6, 8)), null);
  assert.equal(classify(cards(3, 4, 5, 6)), null);
  // 12 张（3 到 A）也认
  const big = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((r) => ({ r, s: 0 }));
  assert.equal(classify(big).type, TYPE.顺子);
});

test('牌型：连对至少 3 对、每点数正好 2 张、连续', () => {
  assert.equal(classify(cards(3, 3, 4, 4, 5, 5)).type, TYPE.连对);
  assert.equal(classify(cards(3, 3, 4, 4)), null, '两对不算连对');
  assert.ok(!isPairRun([3, 3, 4, 4]));
  assert.equal(classify(cards(3, 3, 3, 4, 4, 4)).type, TYPE.飞机, '这三张连着，是飞机不是连对');
  assert.equal(classify(cards(3, 3, 3, 4, 4, 5)), null, '三张 + 对子 + 散牌什么都不算');
  assert.equal(classify(cards(13, 13, 14, 14, 15, 15)), null, '连对不能带 2');
});

test('牌型：飞机是纯三张，不带翅膀（照上游）', () => {
  assert.equal(classify(cards(3, 3, 3, 4, 4, 4)).type, TYPE.飞机);
  assert.equal(classify(cards(3, 3, 3, 4, 4, 4, 5, 5, 5)).type, TYPE.飞机);
  assert.ok(isTripleRun([3, 3, 3, 4, 4, 4]));
  // 带翅膀不认：上游只认"每点数 3 张且连续"
  assert.equal(classify(cards(3, 3, 3, 4, 4, 4, 5, 6)), null);
  assert.equal(isTripleRun([3, 3, 3, 5, 5, 5]), false, '不连续不认');
});

test('牌型：四带一 / 四带二（四带二是四张 + 一对，照上游口径）', () => {
  const a = classify(cards(8, 8, 8, 8, 3));
  assert.equal(a.type, TYPE.四带一);
  assert.equal(a.rank, 8);
  const b = classify(cards(8, 8, 8, 8, 3, 3));
  assert.equal(b.type, TYPE.四带二);
  assert.equal(b.rank, 8);
  // 四张 + 两张**散牌**不算四带二（上游要求那两张是一对）
  assert.equal(classify(cards(8, 8, 8, 8, 3, 4)), null);
});

test('牌型：凑不成牌型的一律返回 null（上游叫"无牌型"）', () => {
  assert.equal(classify(cards(3, 5)), null);
  assert.equal(classify(cards(3, 3, 4)), null);
  assert.equal(classify([]), null);
  assert.equal(classify(cards(3, 4, 5, 6, 7, 9)), null);
});

/* ============================== 牌型：比大小 ============================== */

test('比大小：同牌型同张数比点数', () => {
  assert.ok(canBeat(classify(cards(5)), classify(cards(9))));
  assert.ok(!canBeat(classify(cards(9)), classify(cards(5))));
  assert.ok(canBeat(classify(cards(5, 5)), classify(cards(9, 9))));
  assert.ok(!canBeat(classify(cards(5)), classify(cards(5))), '一样大压不过');
});

test('比大小：牌型不同 / 张数不同都不行（上游这里是个 bug，别抄回去）', () => {
  assert.ok(!canBeat(classify(cards(5)), classify(cards(9, 9))), '单张压不了对子');
  assert.ok(canBeat(classify(cards(3, 3, 3)), classify(cards(9, 9, 9, 9))), '炸弹能压三张');
  assert.ok(!canBeat(classify(cards(3, 3, 3, 3)), classify(cards(9, 9, 9))), '三张压不了炸弹');

  const run5 = classify(cards(3, 4, 5, 6, 7));
  const run6 = classify(cards(4, 5, 6, 7, 8, 9));
  assert.ok(!canBeat(run5, run6), '6 张顺子压不了 5 张顺子（长度必须一样）');
  assert.ok(canBeat(run5, classify(cards(4, 5, 6, 7, 8))));

  const pairs3 = classify(cards(3, 3, 4, 4, 5, 5));
  const pairs4 = classify(cards(4, 4, 5, 5, 6, 6, 7, 7));
  assert.ok(!canBeat(pairs3, pairs4), '4 连对压不了 3 连对');
});

test('比大小：炸弹压普通牌型，炸弹之间比点数，王炸最大', () => {
  const single = classify(cards(14));
  const bomb = classify(cards(3, 3, 3, 3));
  const bigBomb = classify(cards(9, 9, 9, 9));
  const rocket = classify(cards(16, 17));

  assert.ok(canBeat(single, bomb), '炸弹能压单张 A');
  assert.ok(!canBeat(bomb, single), '单张压不了炸弹');
  assert.ok(canBeat(bomb, bigBomb), '大炸弹压小炸弹');
  assert.ok(!canBeat(bigBomb, bomb));
  assert.ok(canBeat(bigBomb, rocket), '王炸压炸弹');
  assert.ok(!canBeat(rocket, bigBomb), '炸弹压不了王炸');
  assert.ok(!canBeat(rocket, rocket), '王炸不能压王炸');
});

test('比大小：领出（上家没牌）随便出', () => {
  assert.ok(canBeat(null, classify(cards(3))));
  assert.ok(canBeat(undefined, classify(cards(3, 4, 5, 6, 7))));
});

/* ============================== 发牌 ============================== */

test('发牌：三家各 17 张、54 张不重复、手牌从大到小', () => {
  const game = createGame({ players: PLAYERS, rng: seeded(7) });
  const views = PLAYERS.map((p) => game.viewFor(p.id));
  const ids = new Set();
  for (const view of views) {
    assert.equal(view.hand.length, 17);
    for (const card of view.hand) {
      assert.ok(!ids.has(card.id), `牌 ${card.id} 发给了两个人`);
      ids.add(card.id);
    }
    const ranks = view.hand.map((c) => c.r);
    assert.deepEqual(ranks, ranks.slice().sort((a, b) => b - a), '手牌应该从大到小');
    assert.equal(view.bottom, null, '叫地主结束前底牌保密');
  }
  assert.equal(ids.size, 51);
});

test('发牌：第一个行动的人随机，但一定是合法座位', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const game = createGame({ players: PLAYERS, rng: seeded(seed) });
    const seat = turnSeat(game);
    assert.ok(seat >= 0 && seat < SEAT_COUNT);
    assert.equal(viewOf(game, seat).seat, seat);
  }
});

/* ============================== 叫地主 / 抢地主 ============================== */

test('叫地主：先叫的那家成为候选，然后进入抢地主', () => {
  const game = createGame({ players: PLAYERS, rng: seeded(11) });
  const first = turnSeat(game);
  ok(game.act(PLAYERS[first].id, { type: 'bid', value: 1 }), '先叫地主');
  const view = viewOf(game, first);
  assert.equal(view.stage, 'rob');
  assert.equal(view.players[first].label, '叫地主');
});

test('叫地主：三家都不叫就重新发牌（手牌会换）', () => {
  const game = createGame({ players: PLAYERS, rng: seeded(13) });
  const before = viewOf(game, 0).hand.map((c) => c.id).join(',');

  for (let i = 0; i < 3; i += 1) {
    const seat = turnSeat(game);
    ok(game.act(PLAYERS[seat].id, { type: 'bid', value: 0 }), `${seat} 不叫`);
  }
  const after = viewOf(game, 0);
  assert.equal(after.phase, 'bidding');
  assert.equal(after.stage, 'call', '应该回到叫地主阶段重发');
  assert.notEqual(after.hand.map((c) => c.id).join(','), before, '重发之后手牌应该变了');
  assert.equal(after.hand.length, 17);
});

test('抢地主：没人抢，叫的人当地主，拿到底牌共 20 张', () => {
  const game = createGame({ players: PLAYERS, rng: seeded(17) });
  const caller = turnSeat(game);
  ok(game.act(PLAYERS[caller].id, { type: 'bid', value: 1 }), '叫地主');
  const view = finishBidding(game, { robSeat: null });
  assert.equal(view.phase, 'playing');
  assert.equal(view.landlord, caller, '没人抢，叫的人就是地主');
  assert.equal(view.players[caller].count, 20);
  assert.equal(view.bottom.length, 3, '定完地主底牌公开');
  assert.equal(view.hand.length, 20);
  assert.equal(view.turn, caller, '地主先出牌');
});

test('抢地主：后抢的那家把地主抢走', () => {
  const game = createGame({ players: PLAYERS, rng: seeded(19) });
  const caller = turnSeat(game);
  ok(game.act(PLAYERS[caller].id, { type: 'bid', value: 1 }), '叫地主');
  // 抢的顺序是候选之后的两家：先问 next(caller)，再问 next(next(caller))
  const last = (caller + 2) % 3;
  const view = finishBidding(game, { robSeat: last });
  assert.equal(view.landlord, last);
  assert.equal(view.players[last].count, 20);
  assert.equal(viewOf(game, last).hand.length, 20, '抢到地主的人手里是 20 张');
});

test('叫地主：轮不到你的时候不能出价，值只能是 0/1', () => {
  const game = createGame({ players: PLAYERS, rng: seeded(23) });
  const seat = turnSeat(game);
  const other = (seat + 1) % 3;
  bad(game.act(PLAYERS[other].id, { type: 'bid', value: 1 }), '不是自己叫人', '还没轮到');
  bad(game.act(PLAYERS[seat].id, { type: 'bid', value: 3 }), '出价 3', '0 或 1');
  bad(game.act(PLAYERS[seat].id, { type: 'play', cards: [] }), '叫地主阶段出牌', '叫地主');
});

/* ============================== 出牌 ============================== */

test('出牌：地主先出，领出必须先选牌、不能"不要"', () => {
  const { game, landlord } = playingGame();
  assert.equal(turnSeat(game), landlord);
  bad(game.act(PLAYERS[landlord].id, { type: 'play', cards: [] }), '不出牌就点出牌', '先选');
  bad(game.act(PLAYERS[landlord].id, { type: 'pass' }), '领出时点不要', '不能不出');
});

test('出牌：不能出不在自己手里的牌', () => {
  const { game, landlord } = playingGame();
  const mine = viewOf(game, landlord).hand.map((c) => c.id);
  const otherSeat = (landlord + 1) % 3;
  const other = viewOf(game, otherSeat).hand.map((c) => c.id);
  const foreign = other.find((id) => !mine.includes(id));
  bad(game.act(PLAYERS[landlord].id, { type: 'play', cards: [foreign] }), '出别人的牌', '不在你手里');
});

test('出牌：凑不成牌型会被拒，而且手牌一张都不许少', () => {
  const { game, landlord } = playingGame(31);
  const hand = viewOf(game, landlord).hand;
  const i = hand.findIndex((c) => c.r !== hand[0].r);
  assert.ok(i > 0, '20 张牌不可能全一样大');
  bad(game.act(PLAYERS[landlord].id, { type: 'play', cards: [hand[0].id, hand[i].id] }), '两张散牌', '牌型');
  assert.equal(viewOf(game, landlord).hand.length, hand.length, '被拒之后手牌不许变');
});

test('出牌：两家都不要，回到上一手出牌的人重新领出', () => {
  const { game, landlord } = playingGame(37);
  const hand = viewOf(game, landlord).hand;
  ok(game.act(PLAYERS[landlord].id, { type: 'play', cards: [hand[0].id] }), '地主出一张');
  const next1 = (landlord + 1) % 3;
  const next2 = (landlord + 2) % 3;
  ok(game.act(PLAYERS[next1].id, { type: 'pass' }), '下家不要');
  ok(game.act(PLAYERS[next2].id, { type: 'pass' }), '上家不要');
  const view = viewOf(game, landlord);
  assert.equal(view.turn, landlord, '两家都不要，回到出牌的人');
  assert.equal(view.lastPlay, null, '这一轮结束了');
  assert.equal(view.players[next1].label, '', '新一轮头上那行字要清掉');
  ok(game.act(PLAYERS[landlord].id, { type: 'play', cards: [view.hand[0].id] }), '重新领出');
});

test('出牌：压不过上家会被拒（不是随便出都行）', () => {
  const { game, landlord } = playingGame(39);
  const hand = viewOf(game, landlord).hand;
  // 地主先出一张最大的单张，下家最大的都比它小的话应该压不过
  const biggest = hand[0];
  ok(game.act(PLAYERS[landlord].id, { type: 'play', cards: [biggest.id] }), '地主出最大的单张');
  const nextSeat = (landlord + 1) % 3;
  const nextHand = viewOf(game, nextSeat).hand;
  if (biggest.r >= 17) {
    // 大王出掉了，下家肯定压不过
    bad(game.act(PLAYERS[nextSeat].id, { type: 'play', cards: [nextHand[0].id] }), '压不过还出', '压不过');
  } else {
    // 找一张压不过的单张（比头牌小的）
    const weaker = nextHand.find((c) => c.r < biggest.r);
    if (weaker) {
      bad(game.act(PLAYERS[nextSeat].id, { type: 'play', cards: [weaker.id] }), '压不过还出', '压不过');
    }
  }
});

test('出牌：打完最后几张就赢，赢家和 result() 都对得上', () => {
  const { game, landlord } = playingGame(41);
  for (let i = 0; i < 40; i += 1) {
    const view = viewOf(game, landlord);
    if (view.phase === 'over') break;
    assert.equal(view.turn, landlord, '两家都不要的话一直轮到地主');
    const card = view.hand[view.hand.length - 1];
    ok(game.act(PLAYERS[landlord].id, { type: 'play', cards: [card.id] }), '地主出一张');
    if (game.isOver()) break;
    ok(game.act(PLAYERS[(landlord + 1) % 3].id, { type: 'pass' }), '下家不要');
    ok(game.act(PLAYERS[(landlord + 2) % 3].id, { type: 'pass' }), '上家不要');
  }
  assert.ok(game.isOver(), '地主应该把牌出完了');
  const view = viewOf(game, landlord);
  assert.equal(view.phase, 'over');
  assert.deepEqual(view.winner, { side: 'landlord', seats: [landlord] });
  const result = game.result();
  assert.equal(result.winner, 'landlord');
  assert.equal(result.aborted, null);
  assert.equal(result.landlord, landlord);
  bad(game.act(PLAYERS[landlord].id, { type: 'play', cards: [] }), '结束之后还出牌', '结束了');
});

test('出牌：上一手在视图里带着中文点数和张数（语音播报要用）', () => {
  const { game, landlord } = playingGame(43);
  const view = viewOf(game, landlord);
  const card = view.hand[view.hand.length - 1];
  ok(game.act(PLAYERS[landlord].id, { type: 'play', cards: [card.id] }), '出单张');
  const after = viewOf(game, landlord);
  assert.equal(after.lastPlay.type, TYPE.单张);
  assert.equal(after.lastPlay.rankText, rankText(card.r), '视图里要直接给中文点数');
  assert.equal(after.lastPlay.tailText, '');
  assert.equal(after.lastPlay.len, 1);
  assert.equal(after.lastPlay.seat, landlord);
  assert.equal(after.lastPlay.cards.length, 1);
});

/* ============================== 一局从头到尾 ============================== */

test('整局：三家用最笨的策略也能打完，不会卡死', () => {
  const game = createGame({ players: PLAYERS, rng: seeded(101) });
  let steps = 0;
  while (!game.isOver() && steps < 4000) {
    steps += 1;
    const seat = viewOf(game, 0).turn;
    const view = viewOf(game, seat);
    if (view.phase === 'bidding') {
      ok(game.act(PLAYERS[seat].id, { type: 'bid', value: view.stage === 'call' && seat === 0 ? 1 : 0 }), '叫/抢');
      continue;
    }
    const mine = view.hand;
    let chosen = null;
    if (!view.lastPlay) {
      chosen = [mine[mine.length - 1].id];
    } else {
      for (let i = mine.length - 1; i >= 0; i -= 1) {
        const info = classify([mine[i]]);
        if (info && canBeat(view.lastPlay, info)) {
          chosen = [mine[i].id];
          break;
        }
      }
    }
    if (chosen) ok(game.act(PLAYERS[seat].id, { type: 'play', cards: chosen }), '出牌');
    else ok(game.act(PLAYERS[seat].id, { type: 'pass' }), '不要');
  }
  assert.ok(game.isOver(), `应该在 4000 步内打完（实际 ${steps} 步）`);
  const result = game.result();
  assert.ok(result.winner === 'landlord' || result.winner === 'farmers');
  assert.equal(result.aborted, null);
});

/* ============================== 视图裁剪（唯一的防作弊点） ============================== */

test('视图：整局扫一遍，任何时刻都拿不到别人的手牌', () => {
  const game = createGame({ players: PLAYERS, rng: seeded(107) });
  let steps = 0;

  while (!game.isOver() && steps < 600) {
    steps += 1;
    // 同一步里取三份视图，才谈得上"别人手里是什么"
    const views = PLAYERS.map((p) => game.viewFor(p.id));
    const handsBySeat = views.map((v) => v.hand.map((c) => c.id));

    for (let i = 0; i < 3; i += 1) {
      const json = JSON.stringify(views[i]);
      /*
       * 底牌和最近一手牌是**公开**的（底牌定完地主就翻开了，打出去的牌本来就摊在桌上），
       * 所以这两处出现别人的牌是应该的。要盯的是"别人**手里**的牌"。
       */
      const publicIds = new Set([
        ...(views[i].bottom || []).map((c) => c.id),
        ...((views[i].lastPlay && views[i].lastPlay.cards) || []).map((c) => c.id),
      ]);
      for (let j = 0; j < 3; j += 1) {
        if (i === j) continue;
        for (const id of handsBySeat[j]) {
          if (publicIds.has(id)) continue;
          assert.ok(!json.includes(`"${id}"`), `第 ${i} 号位的视图里出现了第 ${j} 号位手里的牌 ${id}`);
        }
      }
      if (views[i].phase === 'bidding') assert.equal(views[i].bottom, null, '叫地主阶段底牌不许出现');
      else assert.equal(views[i].bottom.length, 3);
    }

    const seat = views[0].turn;
    const view = views[seat];
    if (view.phase === 'bidding') {
      ok(game.act(PLAYERS[seat].id, { type: 'bid', value: view.stage === 'call' ? 1 : 0 }), '叫/抢');
      continue;
    }
    const mine = view.hand;
    if (!view.lastPlay) ok(game.act(PLAYERS[seat].id, { type: 'play', cards: [mine[mine.length - 1].id] }), '领出');
    else ok(game.act(PLAYERS[seat].id, { type: 'pass' }), '不要');
  }
  assert.ok(game.isOver());
});

test('视图：不在名单里的人拿不到视图（没有观战）', () => {
  const game = createGame({ players: PLAYERS, rng: seeded(109) });
  assert.equal(game.viewFor('outsider'), null);
  assert.equal(game.viewFor(undefined), null);
});

test('视图：字段就这些（多一个都要想清楚是不是泄露）', () => {
  const game = createGame({ players: PLAYERS, rng: seeded(113) });
  const view = viewOf(game, 1);
  assert.deepEqual(
    Object.keys(view).sort(),
    ['aborted', 'bids', 'bottom', 'hand', 'landlord', 'lastPlay', 'phase', 'players', 'seat', 'stage', 'turn', 'winner'].sort()
  );
  assert.deepEqual(
    Object.keys(view.players[0]).sort(),
    ['avatar', 'count', 'id', 'isLandlord', 'label', 'name', 'passed', 'seat'].sort()
  );
});

/* ============================== 有人离开 ============================== */

test('有人离开：本局作废，剩下的两家不用干等', () => {
  const { game } = playingGame(127);
  assert.equal(game.removePlayer('p2'), true);
  assert.ok(game.isOver());
  const view = viewOf(game, 0);
  assert.equal(view.phase, 'over');
  assert.ok(view.aborted && view.aborted.includes('离开'), `作废理由要说人话：${view.aborted}`);
  assert.equal(view.winner, null);
  bad(game.act(PLAYERS[0].id, { type: 'play', cards: [] }), '作废之后还出牌', '作废');
});

test('中途加入：斗地主不允许（没有第四把椅子）', () => {
  const game = createGame({ players: PLAYERS, rng: seeded(131) });
  assert.equal(game.addPlayer({ id: 'p4', name: '丁' }), false);
});

test('建局：不是三个座位直接报错', () => {
  assert.throws(() => createGame({ players: PLAYERS.slice(0, 2) }), /3 个人/);
  assert.throws(() => createGame({ players: [] }), /3 个人/);
});

/* ============================== 结构性约束 ============================== */

test('引擎里不许碰宿主 API（服务器要直接 import 它）', () => {
  const files = readdirSync(ENGINE_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 3, '引擎目录至少有三个文件');
  for (const file of files) {
    const source = readFileSync(join(ENGINE_DIR, file), 'utf8');
    for (const banned of ['document.', 'window.', 'localStorage', 'fetch(', 'XMLHttpRequest']) {
      assert.ok(!source.includes(banned), `${file} 里出现了 ${banned} —— 引擎必须是纯逻辑`);
    }
  }
});

test('引擎没有第三方依赖（import 只能是相对路径）', () => {
  for (const file of readdirSync(ENGINE_DIR).filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(join(ENGINE_DIR, file), 'utf8');
    for (const m of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(m[1].startsWith('./'), `${file} import 了 ${m[1]} —— 只许相对路径`);
    }
  }
});

test('牌堆：54 张、id 唯一、洗牌不丢牌', () => {
  const deck = createDeck();
  assert.equal(deck.length, 54);
  assert.equal(new Set(deck.map((c) => c.id)).size, 54);
  assert.equal(deck.filter((c) => c.r >= 16).length, 2, '两个王');
  shuffle(deck, seeded(3));
  assert.equal(deck.length, 54);
  assert.equal(new Set(deck.map((c) => c.id)).size, 54);
});

test('牌型常量：中文名一个不少（上游的 无牌型 也在）', () => {
  assert.equal(TYPE.无牌型, '无牌型');
  for (const name of ['单张', '对子', '三张', '三带一', '三带二', '顺子', '连对', '飞机', '炸弹', '四带一', '四带二', '王炸']) {
    assert.ok(Object.values(TYPE).includes(name), `少了牌型 ${name}`);
  }
});