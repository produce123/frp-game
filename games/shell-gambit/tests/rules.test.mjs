/*
 * Shell Gambit 规则单元测试。
 *
 * 跑：node --test games/shell-gambit/tests/rules.test.mjs
 *     （在仓库根目录 E:\frp-game 下跑；下面所有 import 都是相对本文件的路径）
 *
 * 覆盖两类东西，两类都必须有：
 *   A. 规则本身 —— 7 种道具的每个分支 + 容易被改错的边界。
 *      这些用例是从原项目 tests/rules.test.mjs 原样搬过来的，**一条都没删**
 *      （原项目那 32 条是花了真实 bug 换来的，见它的 README「容易记错的细节」）。
 *   B. 接入合同 —— 视图裁剪（铁律二）与服务端接口（GAME-SPEC 第 4 节）。
 *      这一段是搬进平台后**新增**的：原项目没有平台，也就没有这一层。
 *
 * 这里用 node:test + node:assert，不依赖任何第三方（D6：没有 node_modules）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_ITEMS,
  BASE_DAMAGE,
  COPIES_PER_ITEM,
  MAX_HAND,
  MAX_HP,
  START_HAND,
  START_HP,
  TOTAL_CARDS,
} from '../js/engine/constants.js';
import {
  applyAction,
  checkInvariants,
  createGame,
  drawCountFor,
  legalActions,
  remainingCounts,
} from '../js/engine/engine.js';
import {
  PATCH_PLAYER_FIELDS,
  PRIVATE_PATCH_FIELDS,
  PRIVATE_SELF_FIELDS,
  PUBLIC_FIELDS,
  PUBLIC_PATCH_FIELDS,
  PUBLIC_PLAYER_FIELDS,
  viewFor,
} from '../js/view.js';
import { createMatch, meta } from '../../../server/games/shell-gambit.mjs';
import { AI_NAME_POOL } from '../js/ai/ai.js';

/* ============================== 测试辅助 ============================== */

const mk = (n, seed = 12345) =>
  createGame({
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `玩${i + 1}` })),
    seed,
  });

const byId = (s, id) => s.players.find((p) => p.id === id);
const bySeat = (s, seat) => s.players.find((p) => p.seat === seat);
const eq = (actual, expected, msg) => assert.deepEqual(actual, expected, msg);
const assertOk = (cond, msg) => assert.ok(cond, msg);

/**
 * 把某个玩家的手牌换成指定内容。
 * 会从「摸牌堆 → 弃牌堆 → 其他玩家手中」依次找牌，保证 28 张牌始终守恒。
 */
function setHand(state, pid, items) {
  const p = byId(state, pid);
  state.discard.push(...p.hand);
  p.hand = [];
  for (const it of items) {
    let i = state.drawPile.indexOf(it);
    if (i >= 0) { state.drawPile.splice(i, 1); p.hand.push(it); continue; }
    i = state.discard.indexOf(it);
    if (i >= 0) { state.discard.splice(i, 1); p.hand.push(it); continue; }
    let found = false;
    for (const other of state.players) {
      if (other.id === pid) continue;
      const j = other.hand.indexOf(it);
      if (j >= 0) { other.hand.splice(j, 1); p.hand.push(it); found = true; break; }
    }
    if (!found) throw new Error(`测试准备失败：整副牌里找不到 ${it}`);
  }
}

/** 直接指定弹匣，用于精确验证每一条分支 */
function setMagazine(state, shells) {
  /*
   * ⚠️ `faces` = **装填时的那一面**，和引擎的 reloadMagazine 一样必须一起写上：
   * 公开的实弹/空弹统计读的是它（见 engine.js 的 remainingCounts）。
   * 少写这个字段 = 单测里逆转器又变回"免费放大镜"，而线上代码其实是对的。
   */
  state.magazine = { shells: [...shells], index: 0, faces: [...shells] };
  state.load = {
    live: shells.filter((s) => s === 'live').length,
    blank: shells.filter((s) => s === 'blank').length,
  };
  state.knowledge = {};
}

/** 把回合交给指定玩家（不发牌，便于精确断言） */
function setTurn(state, pid) {
  state.turn = pid;
  state.actionsThisTurn = 0;
  state.pending = null;
}

/** 执行一个动作并断言成功 */
function act(state, pid, action) {
  const res = applyAction(state, pid, action);
  assertOk(res.ok, `动作应合法 ${JSON.stringify(action)}，却返回: ${res.error}`);
  return res.events;
}

/* ============================== 建局 ============================== */

describe('建局', () => {
  it('2–4 人、5 血、开局 2 张牌、牌堆共 28 张', () => {
    for (const n of [2, 3, 4]) {
      const s = mk(n);
      eq(s.players.length, n, '人数');
      for (const p of s.players) {
        assert.equal(p.hp, START_HP, `${p.id} 开局血量`);
        assert.equal(p.alive, true, `${p.id} 存活`);
      }
      // 座位 1 同时是全局第一回合，会补 1 张 → 3 张；其他人保持 2 张
      assert.equal(bySeat(s, 1).hand.length, START_HAND + 1, '座位 1 首回合只补 1 张');
      for (let seat = 2; seat <= n; seat++) {
        assert.equal(bySeat(s, seat).hand.length, START_HAND, `座位 ${seat} 开局 2 张`);
      }
      eq(checkInvariants(s), [], '建局后不变量');
    }
  });

  it('座位号是 1..n 且不重复', () => {
    for (const n of [2, 3, 4]) {
      const s = mk(n, 999 + n);
      const seats = s.players.map((p) => p.seat).sort();
      eq(seats, Array.from({ length: n }, (_, i) => i + 1), '座位号');
    }
  });

  it('本轮实弹/空弹数量公开且与弹匣一致', () => {
    const s = mk(4, 777);
    const n = s.players.length;
    const counts = remainingCounts(s);
    assert.equal(counts.total, s.load.live + s.load.blank, '剩余总数 = 本轮装填数');
    const total = s.load.live + s.load.blank;
    assertOk(total >= n * 2 && total <= n * 3, `总弹数应在 [${n * 2}, ${n * 3}]，实际 ${total}`);
    assertOk(s.load.live >= 1, '至少 1 发实弹');
    assertOk(s.load.blank >= 1, '至少 1 发空弹（混合弹序）');
  });

  it('道具总量：7 种 × 4 张 = 28 张', () => {
    assert.equal(ALL_ITEMS.length, 7, '道具种类');
    assert.equal(COPIES_PER_ITEM, 4, '每种份数');
    assert.equal(TOTAL_CARDS, 28, '总张数');
    assert.equal(MAX_HP, 5, '血量上限');
    assert.equal(MAX_HAND, 4, '手牌上限');
  });
});

/* ============================== 发牌 ============================== */

describe('发牌规则', () => {
  it('手牌 3 → 1 张，手牌 4 → 0 张，首回合最多 1 张', () => {
    assert.equal(drawCountFor(2, false), 2, '2 张 → 发 2');
    assert.equal(drawCountFor(3, false), 1, '3 张 → 发 1');
    assert.equal(drawCountFor(4, false), 0, '4 张 → 不发');
    assert.equal(drawCountFor(2, true), 1, '首回合 → 只发 1');
    assert.equal(drawCountFor(3, true), 1, '首回合且已有 3 张 → 1');
    assert.equal(drawCountFor(4, true), 0, '首回合且已满 → 不发');
  });

  it('手牌满 4 张时下回合不发牌', () => {
    const s = mk(2, 4242);
    const a = byId(s, s.turn);
    const other = s.players.find((p) => p.id !== a.id);
    setHand(s, a.id, ['beer', 'beer', 'beer', 'beer']);
    setHand(s, other.id, ['cigarette', 'cigarette']);
    setMagazine(s, ['blank', 'blank', 'blank', 'blank']);
    setTurn(s, a.id);
    assert.equal(a.hand.length, 4, 'a 满手 4 张');

    act(s, a.id, { type: 'shoot', targetId: a.id });
    assert.equal(s.turn, a.id, '空弹打自己保留回合');
    act(s, a.id, { type: 'shoot', targetId: other.id });
    assert.equal(other.hand.length, 4, '对手 2 张 → 补 2 张到 4');

    act(s, other.id, { type: 'shoot', targetId: a.id });
    assert.equal(s.turn, a.id, '回合回到 a');
    assert.equal(a.hand.length, 4, 'a 手牌已满 4 张，不应再发牌');
    eq(checkInvariants(s), [], '不变量');
  });

  it('摸牌堆 < 4 张时，弃牌堆洗匀后放到摸牌堆「底下」', () => {
    const s = mk(2, 555);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    setHand(s, a.id, ['beer']);
    setHand(s, b.id, ['beer']);

    const kept = s.drawPile.splice(0, 3);
    s.discard.push(...s.drawPile.splice(0));
    s.drawPile = kept;
    const discardBefore = s.discard.length;
    assert.equal(s.drawPile.length, 3, '摸牌堆 3 张（< 4，满足回收条件）');
    assertOk(discardBefore > 0, '弃牌堆非空');

    const bHandBefore = b.hand.length; // 1 张
    s.turnNo = 5; // 避开“第一回合只发 1 张”
    setTurn(s, a.id);
    setMagazine(s, ['blank', 'blank']);
    act(s, a.id, { type: 'shoot', targetId: b.id }); // 空弹打别人 → 交棒给 b，触发发牌

    assert.equal(s.discard.length, 0, '弃牌堆被全部回收');
    // 回收的牌放在底部 → 原来那 3 张必须最先被抽走
    eq(b.hand.slice(bHandBefore, bHandBefore + 2), kept.slice(0, 2), '先抽走的应是原本在顶部的那两张');
    assert.equal(s.drawPile.length, 3 - 2 + discardBefore, '摸牌堆 = 原 3 张 - 抽走 2 张 + 回收的弃牌');
    eq(checkInvariants(s), [], '回收后不变量');
  });
});

/* ============================== 7 种道具 ============================== */

describe('放大镜', () => {
  it('只有使用者本人能看到结果，不泄露给其他人', () => {
    const s = mk(3, 31337);
    setMagazine(s, ['blank', 'live', 'live']);
    const a = byId(s, s.turn);
    setHand(s, a.id, ['magnifier']);

    act(s, a.id, { type: 'use', item: 'magnifier' });
    assert.equal(s.knowledge[a.id], 'blank', '自己看到的是空弹');
    eq(remainingCounts(s), { live: 2, blank: 1, total: 3 }, '弹药数量不变');

    const viewA = viewFor(s, a.id);
    assert.equal(viewA.me.knows, 'blank', '自己视野里能看到');
    for (const other of s.players.filter((p) => p.id !== a.id)) {
      const v = viewFor(s, other.id);
      assert.equal(v.me.knows, null, `${other.id} 不应看到别人的放大镜结果`);
    }
    const dumped = JSON.stringify(viewA);
    assertOk(!dumped.includes('"shells"'), '视图不得包含 shells 字段');
  });

  it('用完即进弃牌堆', () => {
    const s = mk(2, 8);
    const a = byId(s, s.turn);
    setHand(s, a.id, ['magnifier']);
    const d = s.discard.length;
    act(s, a.id, { type: 'use', item: 'magnifier' });
    assert.equal(s.discard.length, d + 1, '弃牌堆 +1');
    assert.equal(a.hand.length, 0, '手牌 -1');
  });
});

describe('逆转器', () => {
  /*
   * 这一条是**用户实机报的漏洞**（2026-10）：
   * "我没有放大镜、不知道这一发是什么，用了转换器之后却看到统计从「实弹 5 空弹 3」
   *  变成「实弹 6 空弹 2」—— 等于间接告诉我这一发现在是实弹。"
   *
   * 所以公开统计的口径改成"按**装填时那一面**记账"（见 engine.js 的 remainingCounts）：
   * 逆转器怎么翻，统计都一个字不许变；那一发离开枪膛之后，统计又正好等于真实剩余。
   */
  it('逆转器不改变公开的实弹/空弹统计（不能当放大镜用）', () => {
    const s = mk(2, 100);
    setMagazine(s, ['blank', 'live']); // 第一发空、第二发实
    const a = byId(s, s.turn);
    const b = s.players.find((p) => p.id !== a.id);
    setHand(s, a.id, ['inverter']);

    eq(remainingCounts(s), { live: 1, blank: 1, total: 2 }, '装填时的公开统计');
    act(s, a.id, { type: 'use', item: 'inverter' });
    eq(
      remainingCounts(s),
      { live: 1, blank: 1, total: 2 },
      '用掉逆转器之后公开统计不许变（变了就是白送一次放大镜）'
    );

    // 真去打一枪：这一发确实被翻成了实弹（伤害是真的），说明"统计不变"不是"逆转没生效"
    const ev = act(s, a.id, { type: 'shoot', targetId: b.id });
    assert.equal(ev.find((e) => e.t === 'shoot').shell, 'live', '这一发真的被逆转成实弹了');
    assert.equal(b.hp, START_HP - BASE_DAMAGE, '实弹伤害照常结算');
    eq(
      remainingCounts(s),
      { live: 1, blank: 0, total: 1 },
      '这一发离开枪膛之后，统计正好等于真实剩下的那一发'
    );
  });

  it('翻的那一发还在枪膛里时，统计说的仍然是"装填时的账"（总数必须等于还剩几发）', () => {
    const s = mk(2, 101);
    setMagazine(s, ['live', 'live', 'blank']);
    const a = byId(s, s.turn);
    setHand(s, a.id, ['inverter', 'inverter']);

    const before = remainingCounts(s);
    eq(before, { live: 2, blank: 1, total: 3 }, '装填时的公开统计');
    act(s, a.id, { type: 'use', item: 'inverter' });
    act(s, a.id, { type: 'use', item: 'inverter' });
    eq(remainingCounts(s), before, '翻两次（等于翻回原样）统计还是一个样');

    // 无论如何，总数永远等于枪膛里还剩几发 —— 这条是公开统计的底线
    assert.equal(
      remainingCounts(s).total,
      s.magazine.shells.length - s.magazine.index,
      '公开统计的总数 = 枪膛里还剩几发'
    );
  });

  it('原本知道结果的人，情报应同步翻转', () => {
    const s = mk(3, 101);
    setMagazine(s, ['live', 'blank']);
    const a = byId(s, s.turn);
    setHand(s, a.id, ['magnifier', 'inverter']);
    act(s, a.id, { type: 'use', item: 'magnifier' });
    assert.equal(s.knowledge[a.id], 'live', '先看到实弹');
    act(s, a.id, { type: 'use', item: 'inverter' });
    assert.equal(s.knowledge[a.id], 'blank', '逆转后情报应变为空弹');
  });
});

describe('啤酒', () => {
  it('退出当前这一发并公开类型，且不结束回合', () => {
    const s = mk(3, 11);
    setMagazine(s, ['live', 'blank', 'blank']);
    const a = byId(s, s.turn);
    setHand(s, a.id, ['beer']);
    const turnBefore = s.turn;

    const ev = act(s, a.id, { type: 'use', item: 'beer' });
    const useEv = ev.find((e) => e.t === 'use' && e.item === 'beer');
    assert.equal(useEv.ejected, 'live', '退出的子弹类型公开');
    eq(remainingCounts(s), { live: 0, blank: 2, total: 2 }, '弹匣前进一发');
    assert.equal(s.turn, turnBefore, '啤酒不结束回合');
    assertOk(legalActions(s, a.id).some((x) => x.type === 'shoot'), '退弹后仍可开枪');
  });
});

describe('手锯', () => {
  it('本发实弹伤害翻倍，打出后失效', () => {
    const s = mk(2, 202);
    setMagazine(s, ['live', 'live']);
    const a = byId(s, s.turn);
    const b = s.players.find((p) => p.id !== a.id);
    setHand(s, a.id, ['handsaw']);

    act(s, a.id, { type: 'use', item: 'handsaw' });
    assert.equal(s.saw, true, '已锯短枪管');
    act(s, a.id, { type: 'shoot', targetId: b.id });
    assert.equal(b.hp, 3, '实弹 2 点伤害（5 → 3）');
    assert.equal(s.saw, false, '开完枪后手锯失效');
  });

  it('打出空弹也会浪费掉', () => {
    const s = mk(2, 203);
    setMagazine(s, ['blank', 'live']);
    const a = byId(s, s.turn);
    setHand(s, a.id, ['handsaw']);
    act(s, a.id, { type: 'use', item: 'handsaw' });
    act(s, a.id, { type: 'shoot', targetId: a.id });
    assert.equal(s.saw, false, '空弹也应消耗掉手锯效果');
    assert.equal(a.hp, 5, '空弹不掉血');
    assert.equal(s.turn, a.id, '空弹打自己保留回合');
  });

  it('已经锯过时不允许重复使用（避免浪费）', () => {
    const s = mk(2, 204);
    const a = byId(s, s.turn);
    setHand(s, a.id, ['handsaw', 'handsaw']);
    act(s, a.id, { type: 'use', item: 'handsaw' });
    const legal = legalActions(s, a.id);
    assertOk(!legal.some((x) => x.type === 'use' && x.item === 'handsaw'), '第二次手锯不应出现在合法动作里');
    const res = applyAction(s, a.id, { type: 'use', item: 'handsaw' });
    assert.equal(res.ok, false, '强行提交应被拒绝');
  });
});

describe('香烟', () => {
  it('恢复 1 点生命值', () => {
    const s = mk(2, 300);
    const a = byId(s, s.turn);
    a.hp = 3;
    setHand(s, a.id, ['cigarette']);
    act(s, a.id, { type: 'use', item: 'cigarette' });
    assert.equal(a.hp, 4, '回血 +1');
  });

  it('上限 5 点，满血使用即浪费', () => {
    const s = mk(2, 301);
    const a = byId(s, s.turn);
    a.hp = 5;
    setHand(s, a.id, ['cigarette']);
    act(s, a.id, { type: 'use', item: 'cigarette' });
    assert.equal(a.hp, 5, '不会超过上限');
    assert.equal(a.hand.length, 0, '牌仍然被消耗');
  });
});

describe('手铐', () => {
  it('被铐的对手跳过下一回合', () => {
    const s = mk(3, 400);
    setMagazine(s, ['blank', 'blank', 'blank']);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    const c = bySeat(s, 3);
    setTurn(s, a.id);
    setHand(s, a.id, ['handcuffs', 'beer']);

    act(s, a.id, { type: 'use', item: 'handcuffs', targetId: b.id });
    assert.equal(b.cuffed, true, 'b 被铐住');
    act(s, a.id, { type: 'shoot', targetId: c.id });
    assert.equal(b.cuffed, false, '被跳过时手铐解除');
    assert.equal(s.turn, c.id, 'b 被跳过，回合直接给 c');
  });

  it('回归：2 人局里被跳过的人不能反过来拿到回合', () => {
    // 用户实测的那一把：神铐住品 → 空弹打自己（保留回合）→ 空弹打品（结束回合）。
    // 记录里「品 被手铐跳过回合」后面紧跟着「品 摸了 2 张牌」，品白拿一个回合。
    // 根因：endTurn 在「其他人都被跳过」时把回合顺延给了 alive[startIdx+1] ——
    // 正是刚刚被跳过、手铐也已经解除的那个人。2 人局里 100% 命中。
    const s = mk(2, 402);
    setMagazine(s, ['blank', 'blank', 'blank', 'blank', 'blank', 'blank']);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    setTurn(s, a.id);
    setHand(s, a.id, ['cigarette']);
    setHand(s, b.id, ['handcuffs', 'cigarette']);

    act(s, a.id, { type: 'shoot', targetId: b.id });
    assert.equal(s.turn, b.id, '回合交给 b');

    const aHandBefore = byId(s, a.id).hand.length;
    act(s, b.id, { type: 'use', item: 'handcuffs', targetId: a.id });
    assert.equal(byId(s, a.id).cuffed, true, 'a 被铐住');
    act(s, b.id, { type: 'shoot', targetId: b.id });
    assert.equal(s.turn, b.id, '空弹打自己保留回合');

    const ev = act(s, b.id, { type: 'shoot', targetId: a.id });
    assertOk(ev.some((e) => e.t === 'skip' && e.player === a.id), 'a 被手铐跳过');
    assert.equal(byId(s, a.id).cuffed, false, 'a 的手铐在跳过时解除');
    assert.equal(s.turn, b.id, 'a 是唯一的对手，被跳过之后回合必须回到 b');
    assert.equal(byId(s, a.id).hand.length, aHandBefore, 'a 一张牌都不该摸到');
    assertOk(!ev.some((e) => e.t === 'turn' && e.player === a.id), 'a 不该有摸牌事件');
    eq(checkInvariants(s), [], '不变量');
  });

  it('回归：其他人都被锁住时，回合回到自己身上而不是白送给别人', () => {
    const s = mk(3, 403);
    setMagazine(s, ['blank', 'blank', 'blank', 'blank', 'blank', 'blank']);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    const c = bySeat(s, 3);
    setTurn(s, a.id);
    setHand(s, a.id, ['handcuffs', 'handcuffs']);

    act(s, a.id, { type: 'use', item: 'handcuffs', targetId: b.id });
    act(s, a.id, { type: 'use', item: 'handcuffs', targetId: c.id });
    const ev = act(s, a.id, { type: 'shoot', targetId: b.id });

    assertOk(ev.some((e) => e.t === 'skip' && e.player === b.id), 'b 被跳过');
    assertOk(ev.some((e) => e.t === 'skip' && e.player === c.id), 'c 被跳过');
    assert.equal(s.turn, a.id, 'b、c 都被跳过，回合回到 a');
    assert.equal(byId(s, b.id).cuffed, false, 'b 手铐解除');
    assert.equal(byId(s, c.id).cuffed, false, 'c 手铐解除');
    assertOk(!ev.some((e) => e.t === 'turn' && (e.player === b.id || e.player === c.id)), '被跳过的人不该摸牌');
    eq(checkInvariants(s), [], '不变量');
  });

  it('回归：每轮开始时 1 号戴着手铐也要被跳过', () => {
    const s = mk(2, 404);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    setTurn(s, b.id);
    setHand(s, b.id, ['handcuffs', 'cigarette']);
    act(s, b.id, { type: 'use', item: 'handcuffs', targetId: a.id });
    assert.equal(byId(s, a.id).cuffed, true, 'a 被铐住');

    setMagazine(s, ['blank']);
    const ev = act(s, b.id, { type: 'shoot', targetId: b.id });
    assertOk(ev.some((e) => e.t === 'round'), '触发了换弹');
    assertOk(ev.some((e) => e.t === 'skip' && e.player === a.id), '新一轮开始时 a 被跳过');
    assert.equal(s.turn, b.id, '回合给到 b 而不是被锁住的 a');
    assert.equal(byId(s, a.id).cuffed, false, '手铐解除');
    eq(checkInvariants(s), [], '不变量');
  });

  it('不能铐自己，也不能铐已被铐住的人', () => {
    const s = mk(3, 401);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    setTurn(s, a.id);
    setHand(s, a.id, ['handcuffs']);
    const legal = legalActions(s, a.id);
    assertOk(!legal.some((x) => x.type === 'use' && x.item === 'handcuffs' && x.targetId === a.id), '不能铐自己');
    act(s, a.id, { type: 'use', item: 'handcuffs', targetId: b.id });
    setHand(s, a.id, ['handcuffs']);
    const legal2 = legalActions(s, a.id);
    assertOk(
      !legal2.some((x) => x.type === 'use' && x.item === 'handcuffs' && x.targetId === b.id),
      '不能重复铐同一个人'
    );
  });
});

describe('肾上腺素', () => {
  it('偷一张随机牌并立刻使用（不需要目标的道具）', () => {
    const s = mk(2, 500);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    setTurn(s, a.id);
    setMagazine(s, ['live', 'live']);
    a.hp = 3;
    setHand(s, a.id, ['adrenaline']);
    setHand(s, b.id, ['cigarette']);

    eq(checkInvariants(s), [], '偷之前守恒');
    act(s, a.id, { type: 'use', item: 'adrenaline', targetId: b.id });
    assert.equal(a.hp, 4, '偷到香烟并立刻使用 → 回血');
    assert.equal(b.hand.length, 0, '对手的牌被拿走');
    assert.equal(s.pending, null, '不需要二次指定目标');
    eq(checkInvariants(s), [], '偷之后仍然守恒');
  });

  it('偷到手铐时需要二次指定目标，且期间牌数守恒', () => {
    const s = mk(3, 501);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    const c = bySeat(s, 3);
    setTurn(s, a.id);
    setMagazine(s, ['live', 'live']);
    setHand(s, a.id, ['adrenaline']);
    setHand(s, b.id, ['handcuffs']);

    act(s, a.id, { type: 'use', item: 'adrenaline', targetId: b.id });
    assert.equal(s.pending?.item, 'handcuffs', '挂起等待指定目标');
    eq(checkInvariants(s), [], '挂起期间 28 张牌仍然守恒');
    assert.equal(legalActions(s, a.id).every((x) => x.type === 'target'), true, '此时只能选择目标');

    act(s, a.id, { type: 'target', targetId: c.id });
    assert.equal(c.cuffed, true, '被指定的目标被铐住');
    assert.equal(s.pending, null, '子状态清除');
    eq(checkInvariants(s), [], '结算后守恒');
  });

  it('不能偷到肾上腺素本身（防无限递归）', () => {
    const s = mk(2, 502);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    setTurn(s, a.id);
    setMagazine(s, ['live', 'live']);
    setHand(s, a.id, ['adrenaline']);
    setHand(s, b.id, ['adrenaline', 'adrenaline']);

    act(s, a.id, { type: 'use', item: 'adrenaline', targetId: b.id });
    assert.equal(b.hand.length, 2, '对手的肾上腺素一张都没被偷走');
    assert.equal(s.pending, null, '没有待处理的子状态');
    assert.equal(a.hand.length, 0, '自己的肾上腺素仍然被消耗');
    eq(checkInvariants(s), [], '牌数守恒');
  });

  it('回归：偷到手铐但没有合法目标时不得死锁', () => {
    // 曾经的 BUG：2 人局里 A 先铐住 B，再用肾上腺素偷到 B 的手铐，
    // 此时「其他存活玩家」全都已被铐，目标池为空 → 游戏卡死。
    const s = mk(2, 909);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    setTurn(s, a.id);
    setMagazine(s, ['blank', 'blank', 'blank']);
    setHand(s, a.id, ['handcuffs', 'adrenaline']);
    setHand(s, b.id, ['handcuffs']);

    act(s, a.id, { type: 'use', item: 'handcuffs', targetId: b.id });
    assert.equal(b.cuffed, true, 'b 已被铐住');

    const hcInDiscardBefore = s.discard.filter((c) => c === 'handcuffs').length;
    act(s, a.id, { type: 'use', item: 'adrenaline', targetId: b.id });
    assert.equal(s.pending, null, '没有合法目标时不应挂起');
    assertOk(legalActions(s, a.id).length > 0, 'A 仍然有棋可走');
    assert.equal(b.hand.length, 0, '手铐被偷走');
    assert.equal(
      s.discard.filter((c) => c === 'handcuffs').length,
      hcInDiscardBefore + 1,
      '偷来的手铐因无目标而作废进弃牌堆'
    );
    eq(checkInvariants(s), [], '不变量（含死锁检测）');
  });
});

/* ============================== 射击与回合 ============================== */

describe('射击与回合', () => {
  it('空弹打自己：不掉血、保留回合、可继续操作', () => {
    const s = mk(2, 600);
    setMagazine(s, ['blank', 'live']);
    const a = bySeat(s, 1);
    setTurn(s, a.id);
    act(s, a.id, { type: 'shoot', targetId: a.id });
    assert.equal(a.hp, 5, '空弹不掉血');
    assert.equal(s.turn, a.id, '保留回合');
    assertOk(legalActions(s, a.id).length > 0, '还能继续操作');
  });

  it('实弹打自己：掉血且回合结束', () => {
    const s = mk(2, 601);
    setMagazine(s, ['live', 'live']);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    setTurn(s, a.id);
    act(s, a.id, { type: 'shoot', targetId: a.id });
    assert.equal(a.hp, 4, '掉 1 血');
    assert.equal(s.turn, b.id, '回合交给对手');
  });

  it('实弹打死对手：淘汰、手牌进弃牌堆、对局结束并产生胜者', () => {
    const s = mk(2, 602);
    setMagazine(s, ['live', 'live']);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    setTurn(s, a.id);
    b.hp = 1;
    const bHand = b.hand.length;
    assertOk(bHand > 0, 'b 有手牌');
    const discardBefore = s.discard.length;

    act(s, a.id, { type: 'shoot', targetId: b.id });
    assert.equal(b.hp, 0, '血量归零');
    assert.equal(b.alive, false, '被淘汰');
    assert.equal(b.hand.length, 0, '手牌清空');
    assert.equal(s.discard.length, discardBefore + bHand, '手牌全部进弃牌堆');
    assert.equal(s.phase, 'over', '对局结束');
    assert.equal(s.winner, a.id, 'a 获胜');
    eq(checkInvariants(s), [], '结束后不变量');
  });

  it('多杀：4 人局逐个淘汰，最后一人获胜', () => {
    const s = mk(4, 603);
    const a = bySeat(s, 1);
    setTurn(s, a.id);
    setMagazine(s, ['live', 'live', 'live', 'live']);
    for (const p of s.players) if (p.id !== a.id) p.hp = 1;

    act(s, a.id, { type: 'shoot', targetId: bySeat(s, 2).id });
    assert.equal(s.phase, 'playing', '还有 3 人存活');
    setTurn(s, a.id);
    act(s, a.id, { type: 'shoot', targetId: bySeat(s, 3).id });
    assert.equal(s.phase, 'playing', '还有 2 人存活');
    setTurn(s, a.id);
    act(s, a.id, { type: 'shoot', targetId: bySeat(s, 4).id });
    assert.equal(s.phase, 'over', '只剩 1 人，结束');
    assert.equal(s.winner, a.id, '胜者');
    eq(checkInvariants(s), [], '不变量');
  });

  it('弹匣打空后自动换弹，并从座位 1 开始新的一轮', () => {
    const s = mk(3, 604);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    setTurn(s, a.id);
    setMagazine(s, ['live']);
    const roundBefore = s.round;

    act(s, a.id, { type: 'shoot', targetId: b.id });
    assert.equal(s.round, roundBefore + 1, '进入下一轮');
    assert.equal(s.turn, bySeat(s, 1).id, '1 号为每轮的开始');
    assertOk(remainingCounts(s).total > 0, '已重新装填');
    eq(checkInvariants(s), [], '换弹后不变量');
  });

  it('1 号被淘汰后，新一轮由下一个存活座位开始', () => {
    const s = mk(3, 605);
    const p1 = bySeat(s, 1);
    const p2 = bySeat(s, 2);
    const p3 = bySeat(s, 3);
    p1.alive = false;
    p1.hp = 0;
    setTurn(s, p2.id);
    setMagazine(s, ['live']);
    act(s, p2.id, { type: 'shoot', targetId: p3.id });
    assert.equal(s.round, 2, '进入第二轮');
    assert.equal(s.turn, p2.id, '1 号已淘汰 → 由 2 号开始');
  });

  it('非法动作不会产生任何副作用', () => {
    const s = mk(3, 700);
    const a = bySeat(s, 1);
    const b = bySeat(s, 2);
    setTurn(s, a.id);
    setHand(s, a.id, ['beer']);

    const snapshot = JSON.stringify({
      hp: s.players.map((p) => p.hp),
      hands: s.players.map((p) => p.hand),
      discard: s.discard.length,
      magazine: s.magazine,
      seq: s.seq,
    });

    const bad = [
      { type: 'use', item: 'cigarette' },
      { type: 'use', item: 'handcuffs', targetId: b.id },
      { type: 'shoot', targetId: 'nobody' },
      { type: 'target', targetId: b.id },
      { type: 'nonsense' },
    ];
    for (const action of bad) {
      const res = applyAction(s, a.id, action);
      assert.equal(res.ok, false, `应被拒绝: ${JSON.stringify(action)}`);
    }
    const res = applyAction(s, b.id, { type: 'shoot', targetId: a.id });
    assert.equal(res.ok, false, '非当前回合玩家不能行动');

    assert.equal(
      JSON.stringify({
        hp: s.players.map((p) => p.hp),
        hands: s.players.map((p) => p.hand),
        discard: s.discard.length,
        magazine: s.magazine,
        seq: s.seq,
      }),
      snapshot,
      '状态完全没有变化'
    );
  });
});

/* ============================== 视图裁剪（铁律二） ============================== */

/**
 * 把一个视图里**所有**不该出现的隐藏信息逐条查一遍。
 * 这是本文件最重要的一段：`viewFor` 是唯一的防作弊手段。
 */
function assertNoLeak(view, state, viewerId) {
  const dump = JSON.stringify(view);

  // ① 弹匣真实顺序：只能有数量，不能有数组
  assertOk(!('shells' in view.magazine), '视图的 magazine 不得包含 shells');
  assert.deepEqual(
    Object.keys(view.magazine).sort(),
    ['blank', 'live', 'total'],
    'magazine 只允许有 live/blank/total 三个数字'
  );
  assertOk(!dump.includes('"shells"'), '序列化后也不得出现 shells 字段');

  // ② 摸牌堆 / 弃牌堆的内容与顺序
  assertOk(!('drawPile' in view) && !('discard' in view), '不得暴露摸牌堆/弃牌堆内容');
  assert.equal(view.drawPileCount, state.drawPile.length, '只给张数');
  assert.equal(view.discardCount, state.discard.length, '只给张数');

  // ③ 随机种子（有了它就能复现整局，等于拿到全部隐藏信息）
  assertOk(!dump.includes('"seed"'), '不得暴露随机种子');
  assertOk(!('seed' in view), '视图对象上不该有 seed 属性');

  // ④ 别人的手牌内容：只有 handCount
  for (const pv of view.players) {
    assert.deepEqual(
      Object.keys(pv).sort(),
      [...PUBLIC_PLAYER_FIELDS].sort(),
      `玩家条目字段必须恰好是公开字段（${pv.id}）`
    );
    assertOk(!('hand' in pv), `不得暴露 ${pv.id} 的手牌内容`);
    /*
     * 身份标记这里有个**名字**上的硬约定：视图里叫 `isAI`，
     * 而房间层的成员条目叫 `isBot`（`room.state.members[].isBot`）。
     * `isBot` 是房间层的东西，**不许**漏进游戏视图 —— 逐字段那条断言已经挡住了，
     * 这里再点名钉一次，免得有人"顺手"把房间层的字段名搬到视图上，
     * 然后两边各自演化成两个意思。
     */
    assertOk(!('isBot' in pv), `视图里不许出现房间层的字段名 isBot（${pv.id}）`);
    const real = state.players.find((p) => p.id === pv.id);
    assert.equal(pv.handCount, real.hand.length, '手牌张数要对得上');
    // 身份标记来自状态的座位本身，不许编
    assert.equal(pv.isAI, !!real.isAi, `${pv.id} 的 isAI 必须来自座位`);
  }

  // ⑤ 放大镜情报：只有自己那一份
  for (const other of state.players) {
    if (other.id === viewerId) continue;
    if (state.knowledge[other.id]) {
      const v = viewFor(state, viewerId);
      assert.equal(v.me.knows, state.knowledge[viewerId] || null, '只给"我"的情报');
    }
  }

  // ⑥ 顶层字段也不能多出来
  for (const key of Object.keys(view)) {
    assertOk(PUBLIC_FIELDS.includes(key), `顶层多了一个字段「${key}」—— 加字段要同步改 view.js 与这条用例`);
  }
  for (const key of Object.keys(view.me)) {
    assertOk(PRIVATE_SELF_FIELDS.includes(key), `me 多了一个字段「${key}」`);
  }
}

/* ------------------------- 每一步的补丁（逐步同步，D14） ------------------------- */

/**
 * 把"每一步之后的状态补丁"（`entry.s`）也按人查一遍。
 *
 * 【为什么它是**单独一条**、而且这么长】
 * `s` 是这一版新加的、**最容易漏裁**的一处：引擎生成补丁时不知道"看的人是谁"，
 * 所以它按人存了三张表 —— `hands`（所有人的手牌）、`legals`（所有人的合法动作）、
 * `knows`（所有人的放大镜情报）。那是**整张桌面明牌**。
 * 出报文前由 `narrowLogEntry` 把表裁成"单数"（`hand` / `legal` / `knows` = 我自己那份）。
 * 少裁一张，联机就变成"我能看到对手手牌"，而**单机看起来一切正常**
 * （单机手里本来就有完整状态，玩家分不出来）。
 *
 * 查四件事，缺一不可：
 *   ① 整份报文（含补丁）JSON 化之后搜关键字，命中必须是 **0**；
 *   ② 补丁的顶层字段只允许"公开那一列 + 我自己私有的那三个"，多一个就红；
 *   ③ 补丁里"变了的人"只允许公开字段（没有 hand，也没有房间层的 isBot）；
 *   ④ 私有那三个必须**恰好是"我自己那一份"**：表里没有我 → 字段就不该在；
 *      别人的那一份**一个字都不许**出现在我的报文里。
 */
function assertPatchNoLeak(view, state, viewerId) {
  const dump = JSON.stringify(view);

  // ① 关键字搜索：整份报文（**含补丁 s**）一个都不许命中
  for (const forbidden of [
    '"shells"', '"drawPile"', '"discard"', '"seed"', '"rng"',
    '"knowledge"', '"hands"', '"legals"', '"isBot"',
  ]) {
    assertOk(!dump.includes(forbidden), `${viewerId} 的报文（含补丁）里出现了不该有的 ${forbidden}`);
  }

  for (const e of view.log) {
    assertOk(e && e.s, `日志条目 ${e && e.n} 没带补丁（这一版服务端每条都必须带）`);
    const raw = state.log.find((x) => x.n === e.n);
    assertOk(raw, `引擎日志里找不到第 ${e.n} 条（补丁基准对不上）`);

    // ② 补丁顶层字段白名单
    for (const k of Object.keys(e.s)) {
      assertOk(
        PUBLIC_PATCH_FIELDS.includes(k) || PRIVATE_PATCH_FIELDS.includes(k),
        `${viewerId} 的第 ${e.n} 条补丁多了一个字段「${k}」—— 加字段要同步改 view.js 与这条用例`
      );
    }

    // ③ 补丁里"变了的人"：只允许公开字段（手牌内容在补丁里叫 handCount，不是 hand）
    for (const pv of e.s.players || []) {
      for (const k of Object.keys(pv)) {
        assertOk(
          PATCH_PLAYER_FIELDS.includes(k),
          `补丁的玩家条目多了一个字段「${k}」（${pv.id}，第 ${e.n} 条）`
        );
      }
      assertOk(!('hand' in pv), `补丁里第 ${e.n} 条暴露了 ${pv.id} 的手牌内容`);
    }

    // ④ 私有那三个：要么"恰好是我的那一份"，要么**根本不该出现**
    for (const [field, table] of [['hand', 'hands'], ['legal', 'legals'], ['knows', 'knows']]) {
      const bag = raw.s[table];
      const mine = bag && Object.prototype.hasOwnProperty.call(bag, viewerId) ? bag[viewerId] : undefined;
      if (field in e.s) {
        assert.deepEqual(
          e.s[field],
          mine,
          `${viewerId} 的第 ${e.n} 条补丁里的 ${field} 必须恰好是自己那一份`
        );
      } else {
        assert.equal(
          mine,
          undefined,
          `${viewerId} 的第 ${e.n} 条补丁漏了自己变了的 ${field}（漏了界面就会停在旧状态）`
        );
      }

      for (const other of state.players) {
        if (other.id === viewerId) continue;
        const theirs = bag && Object.prototype.hasOwnProperty.call(bag, other.id) ? bag[other.id] : undefined;
        if (theirs === undefined || theirs === null) continue;
        /*
         * 别人的那一份**一个字都不许**出现在我的报文里。
         * ⚠️ 只对"数组"按字符串搜（手牌 / 合法动作）：`knows` 的值就是 'live' / 'blank'
         *    这种短字符串，按值搜满屏都是（`magazine.live` 这种键名就含 "live"），
         *    那会误伤 —— 它的防线是上面 ① 的 `"hands"/"legals"/"knowledge"` 容器关键字
         *    加 ④ 的"恰好是自己那一份"。
         * ⚠️ 和我自己那份**一模一样**时也不搜（那种情况下它本来就该出现）。
         */
        if (Array.isArray(theirs) && JSON.stringify(theirs) !== JSON.stringify(mine)) {
          assertOk(
            !JSON.stringify(e.s).includes(JSON.stringify(theirs)),
            `${viewerId} 的第 ${e.n} 条补丁里出现了 ${other.id} 的 ${table}（完整数组逐字命中）`
          );
        }
      }
    }
  }
}

/**
 * 造一串"带补丁的日志"：每人手里都有牌 + 都用了放大镜（私有情报最全），
 * 然后互相开枪、用道具、换弹，尽量把 7 条分支都走到。
 */
function playManySteps(s) {
  const n = s.players.length;
  for (const p of s.players) setHand(s, p.id, ['magnifier', 'handcuffs', 'handsaw', 'beer']);
  // 弹匣：实空交替，保证"下一发是什么"在每个人眼里可能不同（放大镜才有意义）
  setMagazine(s, Array.from({ length: n * 3 }, (_, i) => (i % 2 ? 'blank' : 'live')));
  for (const p of s.players) {
    setTurn(s, p.id);
    act(s, p.id, { type: 'use', item: 'magnifier' });
    act(s, p.id, { type: 'use', item: 'beer' });
  }
  // 每个人都对着"下一个人"开一枪（会掉血 / 淘汰 / 交接回合 / 换弹，日志就长了）
  for (let round = 0; round < 3; round++) {
    for (const p of s.players) {
      if (!p.alive) continue;
      setTurn(s, p.id);
      const target = s.players.find((x) => x.alive && x.id !== p.id);
      if (!target) break;
      act(s, p.id, { type: 'shoot', targetId: target.id });
    }
  }
  return s;
}

describe('逐步同步：每一步的状态补丁也必须按人裁剪（D14）', () => {
  /*
   * 【客户端靠这条把"开局"重演出来】
   * 服务端在**广播之前**就把人机的整个回合同步跑完了（见 server/games/shell-gambit.mjs
   * 的文件头），所以"1 号位先行动"那几步发生在玩家拿到第一帧**之前**。
   * 客户端要重演它，就必须有一个**基线**：差量补丁叠不出画面，除非第一条补丁
   * 本身就是**全量快照**。而 `pushEvent` 的 `patchBase` 是按 state 对象存的 WeakMap，
   * 一局的第一条取不到基线 → 天然就是全量。
   * `js/ui/board.js` 的 `openingSteps()` 就是靠 `n === 1` + 这一条判断"能不能从头发演"，
   * 所以这里把那份全量逐字段钉住：谁把 `diffPatch` 改成"永远只记差量"，
   * 这条会立刻红（症状是"进对局看不见 1 号位行动，一进去就轮到自己"）。
   */
  it('开局基线：这一局第一条日志的补丁是**全量快照**（客户端据此重演开局）', () => {
    const s = mk(4, 9300);
    for (const p of s.players) {
      const v = viewFor(s, p.id);
      const first = v.log[0];
      assert.equal(first.n, 1, `${p.id}：日志第一条必须是这一局的第一步`);
      assertOk(first.s, '第一条必须带补丁');
      for (const k of PUBLIC_PATCH_FIELDS) assertOk(k in first.s, `基线补丁缺公开字段 ${k}`);
      for (const k of PRIVATE_PATCH_FIELDS) {
        assertOk(k in first.s, `基线补丁缺"我自己那一份" ${k}`);
      }
      assert.equal(first.s.seq, 1, '基线补丁的 seq');
      assert.equal(first.s.players.length, 4, '基线补丁带着**整张**座位表（差量只带变了的人）');
      // 裁剪口径不变：整张表必须已经被裁掉，只剩"我自己那一份"
      assertOk(!('hands' in first.s), '基线补丁里不许出现 hands 表');
      assertOk(!('legals' in first.s), '基线补丁里不许出现 legals 表');
    }
  });

  it('补丁不泄露：整份报文（含补丁 s）搜关键字命中 0，私有字段只有"我自己那一份"', () => {
    for (const n of [2, 3, 4]) {
      const s = playManySteps(mk(n, 9100 + n));
      assertOk(s.log.length >= n * 3, `这一步至少要造出 ${n * 3} 条日志，实际 ${s.log.length}`);

      for (const p of s.players) {
        const v = viewFor(s, p.id);
        assert.equal(v.me.hand.length, p.hand.length, '自己的手牌原样给出');
        assertPatchNoLeak(v, s, p.id);
      }
    }
  });

  it('补丁不泄露：别人用放大镜看到的结果，绝不出现在我的报文里（反向也要看得到自己的）', () => {
    const s = mk(3, 9200);
    setMagazine(s, ['live', 'blank', 'live', 'blank', 'blank', 'live']);
    const me = bySeat(s, 1);
    const others = s.players.filter((p) => p.id !== me.id);

    // 只有别人用放大镜：我自己**一条情报都没有**
    setHand(s, me.id, ['beer']);
    for (const o of others) setHand(s, o.id, ['magnifier', 'beer']);
    for (const o of others) {
      setTurn(s, o.id);
      act(s, o.id, { type: 'use', item: 'magnifier' });
    }
    assert.equal(s.knowledge[me.id], undefined, '我自己确实没有情报');
    for (const o of others) assertOk(s.knowledge[o.id], `${o.id} 有自己的情报`);

    const v = viewFor(s, me.id);
    assert.equal(v.me.knows, null, '我这边不该有任何情报');
    /*
     * 整份报文（含补丁）里搜"别人的情报"必须命中 0。
     * ⚠️ 只搜 `"knows":"live"` / `"knows":"blank"` 这种**带值**的形状：
     *    第 1 条补丁是**全量基线**，它本来就带着 `knows:null`（"我没有情报"），
     *    那不是泄露 —— 泄露是"拿到别人看到的那一发是什么"。
     */
    const dump = JSON.stringify(v);
    assertOk(!dump.includes('"knows":"live"'), '我的报文里出现了"下一发是实弹"这种情报');
    assertOk(!dump.includes('"knows":"blank"'), '我的报文里出现了"下一发是空弹"这种情报');
    for (const e of v.log) {
      assertOk(
        e.s.knows === undefined || e.s.knows === null,
        `第 ${e.n} 条补丁里带上了 knows=${JSON.stringify(e.s.knows)} —— ` +
          '那是**别人**用放大镜看到的结果（只有自己变过才该带非空值）'
      );
    }

    // 反向：别人各能看到**自己**那一份（裁剪不能一刀切掉所有人的情报）
    for (const o of others) {
      const vo = viewFor(s, o.id);
      assert.equal(vo.me.knows, s.knowledge[o.id], `${o.id} 应该看得到自己的情报`);
      assertPatchNoLeak(vo, s, o.id);
    }
  });
});

describe('视图裁剪', () => {
  it('看不到他人手牌内容与弹匣顺序', () => {
    const s = mk(4, 800);
    const a = bySeat(s, 1);
    const v = viewFor(s, a.id);

    eq(v.me.hand, byId(s, a.id).hand, '自己的手牌可见');
    for (const pv of v.players) {
      assertOk(!('hand' in pv), `玩家视图不得包含 hand 字段: ${pv.id}`);
      assert.equal(typeof pv.handCount, 'number', '只暴露手牌张数');
    }
    assertOk(!('shells' in v.magazine), '不得暴露弹匣顺序');
    assertOk(!('drawPile' in v) && !('discard' in v), '不得暴露摸牌堆/弃牌堆内容');
    assertOk(!JSON.stringify(v).includes('"live","'), '不得以数组形式泄露弹序');
  });

  it('视图不泄露：全部座位各裁剪一遍，逐字段核对（含放大镜与手锯状态）', () => {
    // 这条用例对应 GAME-SPEC 第 11 节的自动检查第 6 项：
    // "把全部座位各调一遍 viewFor，断言隐藏字段不出现在别人的视图里"。
    for (const n of [2, 3, 4]) {
      const s = mk(n, 8000 + n);
      // 造出"所有人都有私有情报"的最坏情况：每人手里一张放大镜，全部用掉
      for (const p of s.players) setHand(s, p.id, ['magnifier', 'handcuffs', 'handsaw']);
      setMagazine(s, Array.from({ length: n * 2 }, (_, i) => (i % 2 ? 'blank' : 'live')));
      for (const p of s.players) {
        setTurn(s, p.id);
        act(s, p.id, { type: 'use', item: 'magnifier' });
      }
      assert.equal(Object.keys(s.knowledge).length, n, '每个人都有了自己的情报');

      for (const p of s.players) {
        const v = viewFor(s, p.id);
        assert.equal(v.me.id, p.id, 'view.me 必须是自己');
        assert.deepEqual(v.me.hand, p.hand, '自己的手牌原样给出');
        assertNoLeak(v, s, p.id);
      }

      // 每个人的视图**必须互不相同**（只要有一处私密信息不同，序列化就该不同）
      const dumps = s.players.map((p) => JSON.stringify(viewFor(s, p.id)));
      assert.equal(new Set(dumps).size, n, '不同人的视图不应完全相同（否则说明私有信息被抹平了）');
    }
  });

  it('视图不泄露：JSON 报文里不含任何未公开字段名', () => {
    const s = mk(3, 8100);
    setMagazine(s, ['live', 'blank', 'live']);
    const a = bySeat(s, 1);
    setHand(s, a.id, ['beer']);
    setTurn(s, a.id);
    act(s, a.id, { type: 'use', item: 'beer' }); // 制造一条公开日志

    for (const p of s.players) {
      const dump = JSON.stringify(viewFor(s, p.id));
      for (const forbidden of ['"shells"', '"drawPile"', '"discard"', '"seed"', '"rng"', '"knowledge"']) {
        assertOk(!dump.includes(forbidden), `报文里出现了不该有的 ${forbidden}`);
      }
      // 对手手牌内容：把别人的手牌当成字符串搜一遍，一张都不该搜到
      for (const other of s.players) {
        if (other.id === p.id) continue;
        const v = viewFor(s, p.id);
        const ownHand = JSON.stringify(v.me.hand);
        const otherHand = JSON.stringify(other.hand);
        if (otherHand.length > 2 && otherHand !== ownHand) {
          // 只要两人的手牌不完全一样，别人的手牌内容就不该逐字出现在我的报文里
          assertOk(!dump.includes(otherHand), `${p.id} 的报文里出现了 ${other.id} 的完整手牌数组`);
        }
      }
    }
  });

  it('非当前回合玩家的合法动作为空', () => {
    const s = mk(3, 801);
    const a = bySeat(s, 1);
    const other = s.players.find((p) => p.id !== a.id);
    eq(viewFor(s, other.id).me.legal, [], '不是自己的回合就没有合法动作');
    assertOk(viewFor(s, a.id).me.legal.length > 0, '当前回合玩家有合法动作');
  });

  it('不在这一局里的人拿不到视图（返回 null，而不是空对象）', () => {
    const s = mk(2, 802);
    assert.equal(viewFor(s, 'not-in-this-game'), null);
    assert.equal(viewFor(null, 'x'), null);
    assert.equal(viewFor({}, 'x'), null);
  });
});

/* ============================== 服务端接入层 ============================== */

/**
 * 造一张座位表 —— 和 `server/rooms.mjs` 的 `start()` 交给 `createMatch` 的东西**同形**：
 * 先是真人，再是人机座位，每项 `{ id, name, isHost, isBot }`。
 *
 * ⚠️ 从这一版起，**人机是座位**（`isBot: true`），不再由游戏按 `options.aiFill`
 * 自己造 —— 所以这里造座位的方式必须和房间层一致（`bot:1` 这种 id、单字名字），
 * 不然测的就不是真实那条路了。人机的名字**故意**从 `meta.botNames` 里取，
 * 顺手验证"服务端接入层真的导出了那套单字池"。
 */
const HUMAN_SEATS = [
  { id: 'AAAAAAA', name: '甲' },
  { id: 'BBBBBBB', name: '乙' },
  { id: 'CCCCCCC', name: '丙' },
  { id: 'DDDDDDD', name: '丁' },
];

function seats(humans, bots = 0) {
  const list = HUMAN_SEATS.slice(0, humans).map((p, i) => ({ ...p, isHost: i === 0, isBot: false }));
  for (let i = 1; i <= bots; i++) {
    list.push({ id: `bot:${i}`, name: meta.botNames[i - 1], isHost: false, isBot: true });
  }
  return list;
}

describe('服务端接入层（server/games/shell-gambit.mjs）', () => {
  it('meta 齐全、slug 与文件名一致、座位区间合理', () => {
    assert.equal(meta.slug, 'shell-gambit', 'slug 必须恰好是 shell-gambit（文件名一致，否则服务器拒绝加载）');
    assert.equal(typeof meta.title, 'string');
    assertOk(meta.title.length > 0, 'title 不能为空');
    assert.equal(typeof meta.icon, 'string');
    assert.equal(meta.minPlayers, 1, '房间层数的是真人座位：写 1 才能"一个人 + 人机座位"开局');
    /*
     * minSeats 是**总座位**下限（含人机）＝ 引擎的座位下限。
     * 平台有两处吃它：房间准备区（「开始游戏」什么时候能点）与
     * tools/check-game.mjs（拿几个座位调 createMatch）。写错这两个地方都会坏。
     */
    assert.equal(meta.minSeats, 2, 'minSeats 必须是 2（引擎的座位下限）');
    assert.equal(meta.maxPlayers, 4);
    assertOk(meta.minPlayers <= meta.minSeats && meta.minSeats <= meta.maxPlayers, '1 <= minSeats <= maxPlayers');
    assert.equal(meta.allowMidJoin, false, '本作不允许中途加入');
    assert.equal(meta.setup, undefined, '本作在准备区没有自己的设置项（人机由平台外壳加）');

    /*
     * 人机名字池：必须是非空的**单字**数组，而且就是本作单机那套池子
     * （js/ai/ai.js 的 AI_NAME_POOL —— 房间层挑名字时读 meta.botNames）。
     * ⚠️ 抄一份字面量在这里是**假通过**：这条用例要断言的是"导出后复用"。
     */
    assertOk(Array.isArray(meta.botNames) && meta.botNames.length > 0, 'botNames 必须是非空数组');
    assert.equal(meta.botNames, AI_NAME_POOL, 'botNames 必须直接复用单机那套池子（同一个数组）');
    for (const n of meta.botNames) {
      assert.equal([...n].length, 1, `人机名字必须是单字（${n}）—— 平台显示名就是一个码点`);
    }

    // 体检（tools/check-game.mjs）就是拿 meta.minSeats 个座位调进来的：必须建得出来
    const two = createMatch(seats(2), {});
    assert.equal(two._state().players.length, 2, '2 个真人座位要建得出来（体检走的就是这条）');
    assert.equal(two._aiIds().length, 0, '两个真人座位，没有 AI');
    // 而"1 个真人 + 1 个人机座位"同样必须建得出来 —— 这是一个人建房后的正常开局
    const oneBot = createMatch(seats(1, 1), {});
    assert.equal(oneBot._state().players.length, 2, '1 真人 + 1 人机座位 = 2 个座位');
    assert.equal(oneBot._aiIds().length, 1, '人机座位要被认成 AI');
    assert.equal(oneBot._state().turn, 'AAAAAAA', '人机先手时，createMatch 返回前必须已经把它推完');
  });

  it('座位数超范围 / 空表一律 throw（防御性第二道闸，房间层不该这么调）', () => {
    // 座位不够：引擎的底线是 2 个座位（人机也算）
    assert.throws(() => createMatch(seats(1), {}), /至少要 2 个座位/, '只有 1 个座位必须抛');
    assert.throws(() => createMatch([], {}), /至少要 2 个座位/, '空座位表必须抛');
    assert.throws(() => createMatch(null, {}), /至少要 2 个座位/, '不是数组必须抛');
    // 座位太多：meta.maxPlayers = 4
    assert.throws(() => createMatch(seats(4, 1), {}), /最多 4 个座位/, '5 个座位必须抛');
    // options 是客户端输入：垃圾值不许把服务端弄崩（本作现在不读它，但参数仍然要吞得下）
    for (const junk of [null, 'abc', 3, { aiFill: 3 }, []]) {
      const m = createMatch(seats(2), junk);
      assert.equal(m._state().players.length, 2, `垃圾 options（${JSON.stringify(junk)}）不该改变座位数`);
    }
  });

  it('createMatch 能真的建一局，每个座位都拿得到视图，且裁剪不泄露', () => {
    const players = seats(2, 1);
    const match = createMatch(players, {});
    assert.equal(match.isOver(), false, '刚开局不该结束');

    for (const p of players) {
      const v = match.viewFor(p.id);
      assertOk(v, `${p.name} 应该有视图`);
      assert.equal(v.me.id, p.id);
      assertNoLeak(v, match._state(), p.id);
    }
    assert.equal(match.viewFor('ZZZZZZZ'), null, '不在局里的人没有视图');
    assert.equal(match.addPlayer({ id: 'ZZZZZZZ', name: '戊' }), false, '中途加入必须被拒');
  });

  it('act 拒绝时给的是中文 message（能直接显示给玩家），不是错误码', () => {
    const match = createMatch(seats(2), {});
    // 找一个不是在行动的人来提交，必然被拒
    const state = match._state();
    const notTurn = state.players.find((p) => p.id !== state.turn).id;
    const res = match.act(notTurn, { type: 'shoot', targetId: notTurn });
    assert.equal(res.ok, false);
    assert.equal(typeof res.message, 'string', '必须是 message 字段（GAME-SPEC 第 4 节）');
    assertOk(!/^E_|[A-Z_]{4,}/.test(res.message), `不该是错误码：${res.message}`);
    assertOk(/[\u4e00-\u9fa5]/.test(res.message), `必须是中文：${res.message}`);

    const outsider = match.act('ZZZZZZZ', { type: 'shoot', targetId: 'ZZZZZZZ' });
    assert.equal(outsider.ok, false);
    assertOk(/[\u4e00-\u9fa5]/.test(outsider.message), '不在局里也要给中文');
  });

  it('人机座位：座位数就是传进来的座位数，不截断也不兜底', () => {
    // 真人座位数 + 人机座位数 → 期望的座位数（**没有**任何截断/让位逻辑了）
    const cases = [
      { humans: 1, bots: 1, seats: 2, ai: 1 },
      { humans: 1, bots: 3, seats: 4, ai: 3 },
      { humans: 2, bots: 1, seats: 3, ai: 1 },
      { humans: 3, bots: 1, seats: 4, ai: 1 },
    ];

    for (const c of cases) {
      const list = seats(c.humans, c.bots);
      const match = createMatch(list, {});
      const state = match._state();
      assert.equal(state.players.length, c.seats, `座位数应为 真人 ${c.humans} + 人机 ${c.bots}`);
      assert.equal(match._aiIds().length, c.ai, 'AI 座位数');
      for (const h of list.filter((s) => !s.isBot)) {
        assertOk(!match._aiIds().includes(h.id), `${h.name} 是真人，不该被当成 AI`);
      }

      // 关键：开局之后的那一刻，如果回合在 AI 身上，它必须**已经**走完了 ——
      // 否则真实客户端会永远停在"等待对手行动"（服务端不能 setTimeout，见那个文件顶部注释）。
      if (!match.isOver()) {
        const turn = state.turn;
        assertOk(!match._aiIds().includes(turn), `开局后回合不该还停在 AI 身上（${turn}）`);
      }
    }
  });

  it('act 之后：回合不会停在 AI 身上，直到分出胜负', () => {
    const me = seats(1, 2)[0];
    const match = createMatch(seats(1, 2), {});
    // 一局平均 20–40 步（sim.mjs 的统计），这里留足余量、但仍然**有上限**：
    // 真出现死锁时它必须以"跑满"的形式暴露出来，而不是把测试挂死。
    const LIMIT = 500;
    let guard = 0;
    while (!match.isOver() && guard++ < LIMIT) {
      const v = match.viewFor(me.id);
      if (v.phase === 'over') break;
      assert.equal(v.turn, me.id, '轮到真人的时候，turn 必须是真人');
      assertOk(v.me.legal.length > 0, '真人必须有棋可走（否则就是死锁）');
      const res = match.act(me.id, v.me.legal[0]);
      assert.equal(res.ok, true, `真人这一步应当合法：${JSON.stringify(v.me.legal[0])}`);
      assertOk(!match._aiIds().includes(match._state().turn) || match.isOver(), 'AI 应当已经被推完');
    }
    assertOk(match.isOver(), `${LIMIT} 步之内应当分出胜负（否则疑似死锁）`);
    assertOk(guard > 0, '至少走了 1 步');
  });

  it('真人掉线：座位由 AI 接管，这一局还能打完', () => {
    const [me, other] = seats(2);
    const match = createMatch(seats(2), {});
    match.removePlayer(me.id);
    assertOk(match._aiIds().includes(me.id), '走掉的人应当被 AI 接管（不是直接判死）');
    assertOk(!match._aiIds().includes(other.id), '另一个真人座位不该被顺手改掉');
    // 接管之后必须能真的推进：一直模拟到结束
    let guard = 0;
    while (!match.isOver() && guard++ < 400) {
      const v = match.viewFor(other.id);
      if (!v || !v.me.legal.length) break;
      match.act(other.id, v.me.legal[0]);
    }
    assertOk(guard < 400, '接管后对局不能卡住');
  });

  it('人机座位不是房间成员：拿它调 removePlayer 必须是无操作', () => {
    const match = createMatch(seats(1, 1), {});
    const before = match._aiIds().slice().sort();
    const res = match.removePlayer('bot:1');
    assert.equal(res, undefined, 'return false 之类的返回值约定不存在，这里只要求无操作');
    assert.deepEqual(match._aiIds().slice().sort(), before, '人机座位的接管状态不该被改');
    assertOk(match.viewFor('bot:1'), '人机座位照样拿得到自己的视图（服务器内部要用）');
  });

  it('result() 给的是座位序的公开信息，并且标出哪些座位是人机', () => {
    const match = createMatch(seats(1, 1), {});
    const r = match.result();
    assert.equal(r.players.length, 2);
    assert.deepEqual(r.players.map((p) => p.seat).sort(), [1, 2]);
    for (const p of r.players) {
      assertOk(!('hand' in p), 'result 里不得有手牌');
      for (const key of Object.keys(p)) {
        assertOk(['id', 'name', 'seat', 'hp', 'alive', 'isAi'].includes(key), `result 多出字段：${key}`);
      }
    }
    assert.equal(r.players.filter((p) => p.isAi).length, 1, 'result 要标出 1 个人机座位');
    assert.equal(r.players.find((p) => p.id === 'AAAAAAA').isAi, false, '真人座位不能被标成 AI');
  });
});