/*
 * Shell Gambit —— 「人机座位」专项用例（GAME-SPEC 第 4 节的验收）。
 *
 * 跑：node --test games/shell-gambit/tests/ai-fill.test.mjs
 *     （在仓库根目录 E:\frp-game 下跑；下面的 import 都是相对本文件的路径）
 *
 * 【这个文件名为什么还叫 ai-fill】
 * 它原来是"AI **补位**"专项：房主在准备界面选「补几个电脑」，服务端按
 * `options.aiFill` 自己造出「电脑1」「电脑2」顶上空的座位。
 * **那套口径已经作废**（见 server/games/shell-gambit.mjs 文件头"为什么改"）：
 * 人机现在是**房间的座位** —— 房主按「＋ 添加人机」，房间层把它和真人一起放进
 * `players`（`{ id:'bot:1', name:'虎', isBot:true }`），游戏只把 `isBot` 映射成 AI 座位。
 * 文件名保留，是因为它盯的那件事没变：**"人不够也能开局"这条通路不能坏**，
 * 外加"人机的隐藏信息不许进真人的视图"。
 *
 * 【这里不碰 DOM、不起服务器、不连 WebSocket】
 * 测的是 server/games/shell-gambit.mjs 的 createMatch —— 房间层交给它的就是
 * "座位表 + options"，所以这一层测干净了，"一个人 + 一个人机座位能开局"就没问题了。
 * 真浏览器那一段在 tests/browser.e2e.mjs（一个人建房 → 加人机 → 开始 → 轮到我）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AI_NAME_POOL } from '../js/ai/ai.js';
import { remainingCounts } from '../js/engine/engine.js';
import { PRIVATE_SELF_FIELDS, PUBLIC_FIELDS, PUBLIC_PLAYER_FIELDS } from '../js/view.js';
import { createMatch, meta } from '../../../server/games/shell-gambit.mjs';

/* ============================== 测试辅助 ============================== */

const HUMANS = [
  { id: 'AAAAAAA', name: '甲' },
  { id: 'BBBBBBB', name: '乙' },
  { id: 'CCCCCCC', name: '丙' },
  { id: 'DDDDDDD', name: '丁' },
];

const humans = (n) => HUMANS.slice(0, n).map((p, i) => ({ ...p, isHost: i === 0, isBot: false }));

/**
 * 人机座位 —— 形状与 `server/rooms.mjs` 的 botAdd 造出来的东西一致：
 * id 是 `bot:N`（玩家 ID 的字母表里没有冒号，撞不上真人），名字是**单字**。
 * 名字从 `meta.botNames` 里取，所以这条用例顺手也在查"池子真的导出到服务端了"。
 */
const bots = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `bot:${i + 1}`,
    name: meta.botNames[i % meta.botNames.length],
    isHost: false,
    isBot: true,
  }));

/** 一张完整的座位表：n 个真人 + m 个人机座位（房间层交进来的就是这个） */
const table = (h, b = 0, options = {}) => createMatch([...humans(h), ...bots(b)], options);

/** 这张桌上的 AI 座位 id（`_aiIds()` 是给测试用的调试口子） */
const aiSeats = (list) => list.filter((s) => s.isBot).map((s) => s.id);

/**
 * 一直打到分出胜负。
 *
 * ⚠️ 循环里**只**在"轮到真人"的时候调 `match.act()`，一次都不去碰引擎 ——
 * 所以"AI 由服务端同步驱动、不需要真人催"这件事是被这条用例证明的，
 * 而不是被假设的：只要有一刻返回的 view 里 `turn` 落在 AI 座位上，这里的断言立刻红。
 *
 * @param pick 真人这一手选哪个动作（缺省 `legal[0]`，也就是引擎给的顺序里第一个）。
 *   ⚠️ 缺省策略**会把手里所有道具用光**，其中手铐能把对手**每一回合**都铐住 ——
 *   于是人机整局只有 `skip`、一次 `use/shoot` 都没有（约 1/30 的局）。想证明
 *   "人机真的会出手"就得换一个不用道具的策略，见下面 1 人 + 1 人机那一节。
 * @returns {number} 真人走了多少步
 */
function playToEnd(match, humanIds, { limit = 900, each, pick } = {}) {
  let steps = 0;
  while (!match.isOver() && steps < limit) {
    const v = match.viewFor(humanIds[0]);
    assert.ok(v, '真人的视图不该是空的');
    if (v.phase === 'over') break;
    if (each) each(v, steps);

    assert.ok(
      humanIds.includes(v.turn),
      `轮到 AI 了（${v.turn}）—— 服务端必须在返回之前把 AI 推完，否则客户端永远停在"等待对手行动"`
    );
    assert.ok(v.me.legal.length > 0, '轮到自己却没有棋可走 = 死锁');

    const action = pick ? pick(v) : v.me.legal[0];
    const res = match.act(humanIds[0], action);
    assert.equal(res.ok, true, `这一步应当合法：${JSON.stringify(action)}`);
    steps++;

    // act 返回之后，回合要么在真人身上、要么分出胜负；AI 座位**不许**停在回合上
    if (!match.isOver()) {
      const turn = match._state().turn;
      assert.ok(!match._aiIds().includes(turn), `act 返回时回合还停在 AI（${turn}）身上`);
    }
  }
  assert.ok(match.isOver(), `${limit} 步之内没打完（疑似死锁）`);
  return steps;
}

/** 日志里有没有这个座位做过事（证明 AI 真的出过手，不是被跳过） */
const actedInLog = (state, id) =>
  state.log.some((e) => e.player === id && ['use', 'shoot'].includes(e.t));

/* ============================== 1 人 + 1 个人机座位 ============================== */

describe('人机座位：1 个真人 + 1 个人机座位', () => {
  it('能从开局打到结束，全程不需要真人催服务端', () => {
    const match = table(1, 1);
    const state = match._state();
    const me = HUMANS[0].id;

    assert.equal(state.players.length, 2, '1 真人 + 1 人机座位 = 2 个座位');
    assert.deepEqual(match._aiIds(), ['bot:1'], '人机座位就是传进来的 bot:1');
    assert.equal(match.isOver(), false, '刚开局不该结束');

    // 开局那一刻 AI 就已经被推完了（座位随机，人机可能先手）
    if (!match.isOver()) {
      assert.equal(state.turn, me, '开局后回合必须在真人身上（AI 已经走完）');
      assert.ok(match.viewFor(me).me.legal.length > 0, '开局真人就该有棋可走');
    }

    const steps = playToEnd(match, [me]);
    assert.ok(steps > 0, '至少走了 1 步');
    /*
     * ⚠️ 这里**只**断言"人机座位被服务端驱动过"（轮到它的回合真的在日志里留了痕），
     * 不断言它出过手 —— 上面那条真人策略是"引擎给的第一个合法动作"，
     * 它会把道具全用光，其中**手铐能把对手每一个回合都铐住**：这时人机整局只有 `skip`，
     * 一次 `use/shoot` 都没有，而那**完全合法**（人机被铐住了，不是服务端没推它）。
     * 实测约 1/30 的局是这样，硬断言"必须出过手"会偶发假红。
     * "人机真的会自己出手"由紧接着的第二次对局证明：真人只开枪、一颗道具都不用。
     */
    assert.ok(
      state.log.some((e) => e.player === 'bot:1'),
      '人机座位从头到尾没轮到过 —— 服务端的 runAi() 没把它推完'
    );

    // 第二次：真人**只开枪**（不用任何道具 → 铐不住人机），人机的回合就不可能被跳过
    const m2 = table(1, 1);
    const s2 = m2._state();
    playToEnd(m2, [me], {
      pick: (v) => v.me.legal.find((a) => a.type === 'shoot') || v.me.legal[0],
    });
    assert.ok(actedInLog(s2, 'bot:1'), '真人不用道具时，人机必须真的出过手（不是被跳过）');

    const result = match.result();
    assert.equal(result.players.length, 2, 'result 里两个座位都在');
    assert.ok(result.winner, '打完了必须有胜者');
    assert.ok(
      result.players.map((p) => p.id).includes(result.winner),
      '胜者必须是这一局里的座位'
    );
    assert.equal(result.players.filter((p) => p.isAi).length, 1, 'result 标出 1 个人机座位');
    assert.equal(result.players.find((p) => p.id === 'bot:1').isAi, true, 'bot:1 是人机');
    assert.equal(result.players.find((p) => p.id === me).isAi, false, '真人座位不是人机');
  });

  it('真人视图里 AI 身份可判定：players[].isAI 与座位一致（界面靠它画灰圆环）', () => {
    /*
     * 界面**只吃视图**，而它要画出"自己=蓝 / 其他真人=橙 / 人机=灰"
     * （用户点名要求三个游戏一致）。所以身份标记必须出现在视图里。
     *
     * ⚠️ 不许按名字猜：人机的名字和真人名字用的是**同一个单字表**
     *    （js/ai/ai.js 的 AI_NAME_POOL，房间层挑名字时读的就是它）——
     *    桌上完全可能出现一个真人叫「虎」、一个人机也叫「虎」。
     */
    const match = table(2, 1);
    const me = HUMANS[0].id;
    const view = match.viewFor(me);

    for (const pv of view.players) {
      const expected = aiSeats([...humans(2), ...bots(1)]).includes(pv.id);
      assert.equal(pv.isAI, expected, `${pv.id} 的 isAI 标错了（界面圆环会跟着错）`);
    }
    assert.equal(view.players.find((p) => p.id === me).isAI, false, '我自己是真人');
    assert.equal(view.players.find((p) => p.id === 'bot:1').isAI, true, 'bot:1 是人机 → 灰环');

    // 三个真人坐一桌时，一个 AI 标记都不该出现
    const allHuman = table(3, 0).viewFor(HUMANS[0].id);
    assert.equal(allHuman.players.filter((p) => p.isAI).length, 0, '全是真人时没有人机标记');

    // 人机的名字来自本作的单字池，而且确实是单字
    const botName = view.players.find((p) => p.id === 'bot:1').name;
    assert.ok(AI_NAME_POOL.includes(botName), `人机名字必须来自 meta.botNames：${botName}`);
    assert.equal([...botName].length, 1, '平台的显示名就是一个码点，人机也必须是单字');
  });

  it('座位表原样交给引擎：不截断、不兜底、不多造一个', () => {
    // 老口径下这里会"按 aiFill 造座位、超了就截断、缺省还兜底垫 1 个"。
    // 现在座位表是房间层给的：**传几个就是几个**。
    const cases = [
      { humans: 1, bots: 1, seats: 2 },
      { humans: 1, bots: 3, seats: 4 },
      { humans: 2, bots: 1, seats: 3 },
      { humans: 3, bots: 1, seats: 4 },
      { humans: 4, bots: 0, seats: 4 },
    ];
    for (const c of cases) {
      const list = [...humans(c.humans), ...bots(c.bots)];
      const match = createMatch(list, {});
      const state = match._state();
      assert.equal(state.players.length, c.seats, `真人 ${c.humans} + 人机 ${c.bots}：座位数`);
      assert.deepEqual(
        match._aiIds().sort(),
        aiSeats(list).sort(),
        `真人 ${c.humans} + 人机 ${c.bots}：AI 座位必须恰好是 isBot 的那些`
      );
      for (const h of list.filter((s) => !s.isBot)) {
        assert.ok(!match._aiIds().includes(h.id), `${h.name} 是真人，不该被当成 AI`);
        assert.ok(
          state.players.some((p) => p.id === h.id && p.name === h.name),
          `${h.name} 必须坐在座位上`
        );
      }
    }

    // 垃圾 options 不许改变座位表（本作现在不读 options 的任何字段）
    for (const junk of [{}, undefined, null, { aiFill: 3 }, { aiFill: 0 }, 'abc', 3]) {
      const m = createMatch([...humans(1), ...bots(1)], junk);
      assert.equal(
        m._state().players.length,
        2,
        `options=${JSON.stringify(junk)} 时座位表必须原样不变`
      );
      assert.equal(m._aiIds().length, 1, '垃圾 options 不许造出第二个 AI 座位');
    }
  });
});

/* ============================== 满桌与混合桌 ============================== */

describe('人机座位：满桌与混合桌', () => {
  it('1 个真人 + 3 个人机座位：满桌能打完，座位号 1..4 不重复', () => {
    const match = table(1, 3);
    const state = match._state();
    const me = HUMANS[0].id;

    assert.equal(state.players.length, 4, '1 真人 + 3 人机 = 满桌 4 个座位');
    assert.deepEqual(match._aiIds().sort(), ['bot:1', 'bot:2', 'bot:3'], '人机座位');
    assert.deepEqual(state.players.map((p) => p.seat).sort(), [1, 2, 3, 4], '座位号 1..4');
    assert.ok(
      state.players.some((p) => p.id === me && p.name === '甲'),
      '真人座位的名字不许被顶掉'
    );

    playToEnd(match, [me]);
    assert.ok(match.result().winner, '满桌也要能分出胜负');
  });

  it('真人座位与人机座位混合：2+1 与 3+1 都能打，标记各归各位', () => {
    for (const c of [{ humans: 2, bots: 1 }, { humans: 3, bots: 1 }, { humans: 2, bots: 2 }]) {
      const list = [...humans(c.humans), ...bots(c.bots)];
      const match = createMatch(list, {});
      const label = `真人 ${c.humans} + 人机 ${c.bots}`;

      // 每个座位都拿得到视图，而且标记与座位表一一对应
      for (const s of list) {
        const v = match.viewFor(s.id);
        assert.ok(v, `${label}：${s.name} 应该有视图`);
        assert.equal(
          v.players.find((p) => p.id === s.id).isAI,
          s.isBot === true,
          `${label}：${s.id} 的身份标记`
        );
      }
      // 然后**真的**把这一局打完（模拟"真人轮流操作"）
      let guard = 0;
      while (!match.isOver() && guard++ < 900) {
        const turn = match._state().turn;
        if (match._aiIds().includes(turn)) break; // 服务端没推完 AI 就是 bug，交给下面的断言
        const v = match.viewFor(turn);
        if (!v || !v.me.legal.length) break;
        assert.equal(match.act(turn, v.me.legal[0]).ok, true, `${label}：真人这一步应当合法`);
      }
      assert.ok(guard < 900, `${label}：不能卡住`);
      assert.ok(match.isOver(), `${label}：应当分出胜负`);
      assert.equal(
        match.result().players.filter((p) => p.isAi).length,
        c.bots,
        `${label}：result 里的人机数`
      );
    }
  });

  it('人机的名字不与同桌真人重名（房间层挑名字时会避开，这里钉住字表）', () => {
    // 两个真人故意叫「虎」「狼」（人机池里的字），人机座位就不该再用这两个字 ——
    // 这是房间层 pickBotName 的职责，但它挑名字的依据是 meta.botNames，
    // 所以这条用例一并钉住"池子确实是单字、且是那 10 个字"。
    assert.deepEqual(meta.botNames, AI_NAME_POOL, 'meta.botNames 必须就是单机那套池子');
    const seen = new Set();
    for (const n of meta.botNames) {
      assert.equal([...n].length, 1, `池子里有非单字：${n}`);
      assert.ok(!seen.has(n), `池子里有重复字：${n}`);
      seen.add(n);
    }
  });
});

/* ============================== 视图不泄露（重点） ============================== */

describe('人机座位：隐藏信息不进真人的视图', () => {
  it('逐字段核对 1 真人 + 3 人机的那个 view（放大镜情报、手牌、弹序）', () => {
    const match = table(1, 3);
    const state = match._state();
    const me = HUMANS[0].id;
    const aiIds = match._aiIds();

    // 最坏情况：三个人机都做过放大镜，各自知道了下一发是什么；
    // 真人自己也有一份情报。真人的报文里**只准**出现"自己那一份"。
    state.knowledge[me] = 'blank';
    for (const id of aiIds) state.knowledge[id] = 'live';
    assert.equal(Object.keys(state.knowledge).length, 4, '四个座位都有私有情报（测试前提）');

    assertNoLeak(match.viewFor(me), state, me);

    const view = match.viewFor(me);
    assert.equal(view.me.knows, 'blank', '只给"我"的情报');
    // AI 的情报是 'live'，而我的弹药数量里本来就有 live 这个数字 ——
    // 所以不能靠搜字符串，只能靠结构：视图里**没有任何以玩家 id 为键的对象**
    // （引擎里 knowledge 是唯一一张那样的表，它没被带出来）。
    assert.equal(
      aiIds.some((id) => keysOf(view).has(id)),
      false,
      '视图里出现了以人机座位 id 为键的对象（knowledge 那张表漏出来了）'
    );

    // 整局每一步都再核一遍：规则跑起来之后（摸牌、用道具、换弹）也不能漏
    playToEnd(match, [me], { each: (v) => assertNoLeak(v, state, me) });
    assert.ok(match.isOver(), '顺便证明这局真的打完了');
  });

  it('人机的手牌内容不会出现在真人的报文里', () => {
    const match = table(1, 1);
    const state = match._state();
    const me = HUMANS[0].id;
    const aiId = match._aiIds()[0];
    const ai = state.players.find((p) => p.id === aiId);

    // 先给人机塞一手牌（直接改权威状态，等价于它摸到了这些牌）
    ai.hand = ['adrenaline', 'handcuffs', 'beer', 'magnifier'];

    const view = match.viewFor(me);
    const dump = JSON.stringify(view);
    assert.ok(!dump.includes(JSON.stringify(ai.hand)), '人机的完整手牌数组漏进报文了');
    assert.equal(
      view.players.find((p) => p.id === aiId).handCount,
      4,
      '人机只该给出"几张牌"，不是"什么牌"'
    );
    for (const pv of view.players) {
      assert.ok(!('hand' in pv), `座位 ${pv.id} 的条目里出现了 hand 字段`);
    }
  });

  it('字段哨兵：座位条目恰好是 PUBLIC_PLAYER_FIELDS，房间层的 isBot 不进视图', () => {
    /*
     * 身份标记这里有个**名字**上的硬约定：
     *   · 游戏视图里叫 `isAI`（公开身份，界面靠它画圆环）；
     *   · 房间层的成员条目叫 `isBot`（`room.state.members[].isBot`）——
     *     那是房间层的东西，**不许**漏进游戏视图。
     * 这条用例逐字段钉死这件事：加了新字段就必须同步改 js/view.js 与这里。
     */
    const match = table(1, 2);
    const me = HUMANS[0].id;
    const view = match.viewFor(me);

    for (const pv of view.players) {
      assert.deepEqual(
        Object.keys(pv).sort(),
        [...PUBLIC_PLAYER_FIELDS].sort(),
        `座位 ${pv.id} 的字段必须恰好等于 PUBLIC_PLAYER_FIELDS`
      );
      assert.ok(!('isBot' in pv), `座位 ${pv.id} 里漏进了房间层的 isBot`);
      assert.ok(!('isAi' in pv), `座位 ${pv.id} 里漏进了引擎内部的 isAi（视图里叫 isAI）`);
      assert.equal(typeof pv.isAI, 'boolean', `座位 ${pv.id} 的 isAI 必须是布尔值`);
    }
    // 顶层字段也不许多出来
    assert.deepEqual(
      Object.keys(view).sort(),
      [...PUBLIC_FIELDS].sort(),
      '顶层字段必须恰好等于 PUBLIC_FIELDS'
    );
  });
});

/* ============================== 有人离座 ============================== */

describe('人机座位：有人离座时的行为', () => {
  it('真人走了 → 座位由 AI 接管，剩下的真人还能把这局打完', () => {
    const match = table(2, 1);
    const state = match._state();
    const [a, b] = [HUMANS[0].id, HUMANS[1].id];
    const botIdsBefore = match._aiIds().filter((id) => id.startsWith('bot:')).sort();

    assert.equal(state.players.length, 3, '2 真人 + 1 人机座位');
    const nameBefore = state.players.find((p) => p.id === a).name;

    match.removePlayer(a);

    assert.equal(state.players.length, 3, '离座不该把人从座位上删掉（座位由 AI 接管）');
    assert.ok(match._aiIds().includes(a), '走掉的人应当被 AI 接管（不是直接判死）');
    assert.equal(state.players.find((p) => p.id === a).name, nameBefore, '名字保持不变');
    assert.deepEqual(
      match._aiIds().filter((id) => id.startsWith('bot:')).sort(),
      botIdsBefore,
      '接管真人座位不该动原来那个人机座位'
    );
    /*
     * 视图里的身份标记**不动**：接管回答的是"谁在替这个座位打"，
     * 而 isAI 回答的是"这个座位是不是房间里的人机"。
     * 房间成员列表里这个人照样是「掉线中」的真人，两处必须一致，
     * 不然同一个人会同时显示成"掉线中的真人"和"人机"。
     */
    assert.equal(match.viewFor(b).players.find((p) => p.id === a).isAI, false, '接管不改身份标记');
    // 如果当时正好轮到走掉的那个人，这一回合必须已经被 AI 走完
    if (!match.isOver()) {
      assert.ok(
        !match._aiIds().includes(state.turn),
        '接管之后回合不该停在 AI 身上（否则客户端永远停在"等待对手行动"）'
      );
    }

    // 再来一次必须是幂等的
    match.removePlayer(a);
    assert.equal(state.players.length, 3, '重复调用无副作用');

    playToEnd(match, [b]);
    assert.ok(match.result().winner, '剩下的真人一个人也要能把这局打完');
  });

  it('人机座位传进 removePlayer 是无操作（它不是房间成员）', () => {
    const match = table(1, 2);
    const state = match._state();
    const before = {
      seats: state.players.length,
      ai: match._aiIds().slice().sort(),
      turn: state.turn,
      seq: state.seq,
      hp: state.players.map((p) => p.hp),
    };

    for (const id of [...match._aiIds(), 'ZZZZZZZ']) {
      assert.equal(match.removePlayer(id), undefined, `${id}：不该抛异常，也不该有返回值`);
    }

    assert.equal(state.players.length, before.seats, '座位数不变');
    assert.deepEqual(match._aiIds().sort(), before.ai, 'AI 座位集合不变');
    assert.equal(state.turn, before.turn, '回合不变');
    assert.equal(state.seq, before.seq, '一个事件都不该产生');
    assert.deepEqual(state.players.map((p) => p.hp), before.hp, '血量不变');
    // 还能继续玩
    playToEnd(match, [HUMANS[0].id]);
  });

  it('唯一的真人走了：不抛异常，那一局交给房间层去收拾', () => {
    const match = table(1, 1);
    const me = HUMANS[0].id;
    assert.equal(match.removePlayer(me), undefined, '不能抛异常');
    assert.ok(match._aiIds().includes(me), '座位照样由 AI 接管');
    // 房里一个人都不剩时房间层会直接把房间删掉（见 server/rooms.mjs 的 leave），
    // 这里只保证"这一层不炸、状态自洽"。
    assert.ok(match.viewFor(me), '接管之后视图照样出得来');
    assert.equal(match._state().players.length, 2, '座位数不变');
  });

  it('开局后有人想进来：拒绝，而且不动任何座位', () => {
    const match = table(1, 1);
    const state = match._state();
    const before = { seats: state.players.length, ai: match._aiIds().slice().sort(), seq: state.seq };

    // 房间层只在 phase !== waiting 时才会问这里（server/rooms.mjs 的 join）。
    // 本作一律回 false：发出去的牌收不回来，中途加座做不到公平
    // —— 这也是 meta.allowMidJoin 为 false 的含义。
    assert.equal(match.addPlayer({ id: 'EEEEEEE', name: '戊' }), false, 'addPlayer 必须回 false');
    assert.equal(match.addPlayer(), false, '不带参数也不能抛');

    assert.equal(state.players.length, before.seats, '座位数不变（没给新人加座）');
    assert.deepEqual(match._aiIds().sort(), before.ai, 'AI 座位不变');
    assert.equal(state.seq, before.seq, '一个事件都不该产生');
    assert.equal(match.viewFor('EEEEEEE'), null, '没进来的人拿不到视图');

    // 加不进来这件事不该影响这一局继续打完
    playToEnd(match, [HUMANS[0].id]);
    assert.ok(match.result().winner, '拒绝加入之后这局照样能打完');
  });
});

/* ============================== meta 与房间层的约定 ============================== */

describe('与房间层的约定', () => {
  it('meta.minSeats=2 / minPlayers=1：座位与真人分开数', () => {
    assert.equal(meta.minPlayers, 1, 'minPlayers 数的是**真人**：1 才支持"一个人 + 人机座位"');
    assert.equal(meta.minSeats, 2, 'minSeats 数的是**总座位**（含人机）= 引擎的座位下限');
    assert.equal(meta.maxPlayers, 4);
    assert.equal(meta.allowMidJoin, false, '本作开局后不允许进人');

    /*
     * 体检走的那条路（tools/check-game.mjs）：拿 `meta.minSeats` 个座位调 createMatch。
     * 座位是**没有 isBot 的**普通座位（体检只管接口，不关心谁是电脑），
     * 所以这里必须能建出一局 2 个真人的局 —— 抛异常体检当场红。
     */
    assert.doesNotThrow(() => createMatch(humans(2), {}), '2 个座位必须建得出来（体检路径）');
    // 而"1 个真人 + 1 个人机座位"是玩家实际遇到的那条路
    assert.doesNotThrow(() => createMatch([...humans(1), ...bots(1)], {}), '1 真人 + 1 人机');
  });

  it('座位不够就 throw：一个人没有任何人机座位时建不了局', () => {
    // ⚠️ 房间层**不会**这么调（它在 players.length < minSeats 时就先拦住了，
    //    给房主弹的是"座位不够：至少要 2 个座位…按「添加人机」补一个"）。
    //    这里的 throw 是游戏层的防御性第二道闸：真被这样调进来时，
    //    抛出来的话要能直接读懂，而不是引擎那句"需要 2–4 名玩家"。
    assert.throws(
      () => createMatch(humans(1), {}),
      /至少要 2 个座位/,
      '一个真人、零个人机座位必须抛'
    );
    assert.throws(() => createMatch([...humans(4), ...bots(1)], {}), /最多 4 个座位/, '5 个座位必须抛');
  });
});

/* ============================== 小工具 ============================== */

/**
 * 把一个视图**逐字段**核一遍（这是本文件最重要的一段）。
 *
 * 光看"没有对手手牌"是不够的 —— 那只是隐藏信息里的第一条。
 * 本作的隐藏信息一共四类，这里每一类都单独查：
 *   ① 弹匣真实顺序（只有数量能公开）
 *   ② 别人的手牌内容（只有 handCount 能公开）
 *   ③ 放大镜情报（只有自己那一份能公开）
 *   ④ 摸牌堆/弃牌堆的内容与顺序、随机种子（有了种子等于拿到全部隐藏信息）
 * 另外还核两件"结构性"的事：字段清单不许悄悄变长（加了新字段必须同步改 view.js
 * 与这条用例），以及日志里不许出现私有字段名。
 *
 * ⚠️ `players[].isAI` 是**公开字段**（人机是房间的座位，成员列表里本来就写着「人机」），
 *    所以它出现在 PUBLIC_PLAYER_FIELDS 里；房间层的 `isBot` 不许进来。
 */
function assertNoLeak(view, state, viewerId) {
  const dump = JSON.stringify(view);

  // ① 顶层字段恰好是公开字段那一份清单
  assert.deepEqual(
    Object.keys(view).sort(),
    [...PUBLIC_FIELDS].sort(),
    '顶层字段必须恰好等于 view.js 的 PUBLIC_FIELDS（加字段要同步改 view.js 与这条用例）'
  );

  // ② 弹匣：只有数量，没有顺序；数量还必须与权威状态算出来的一致
  assert.deepEqual(
    Object.keys(view.magazine).sort(),
    ['blank', 'live', 'total'],
    'magazine 只准有 live/blank/total 三个数字'
  );
  assert.deepEqual(view.magazine, remainingCounts(state), '公开的弹药数必须与权威状态一致');

  // ④ 牌堆、种子、情报表
  for (const forbidden of ['"shells"', '"drawPile"', '"discard"', '"seed"', '"rng"', '"knowledge"']) {
    assert.ok(!dump.includes(forbidden), `报文里出现了不该有的 ${forbidden}`);
  }
  assert.equal(view.drawPileCount, state.drawPile.length, '摸牌堆只给张数');
  assert.equal(view.discardCount, state.discard.length, '弃牌堆只给张数');
  assert.ok(!dump.includes(JSON.stringify(state.drawPile)), '摸牌堆的顺序漏进报文了');

  // ② 每个座位：字段恰好是公开字段；手牌只给张数
  const mine = state.players.find((p) => p.id === viewerId);
  /*
   * "我"出现过的**每一份**手牌：当前这一份 + 日志里每一步补丁里的那一份
   * （`entry.s.hand`，逐步演出靠它，见 AGENTS §4.9.1）。
   *
   * ⚠️ 为什么要收成一个集合：下面那条"别人的整手牌不许出现在报文里"是**字符串包含**判断。
   * 只用"当前手牌"去豁免时会**偶发假红** —— 别人的这手牌正好等于我**某一步**的手牌，
   * 一搜就命中，而那串字确实是我自己的（不是泄露）。实测 8 次里有 1 次。
   */
  const myHands = new Set([JSON.stringify(mine.hand)]);
  for (const e of view.log || []) if (e.s && e.s.hand) myHands.add(JSON.stringify(e.s.hand));
  for (const pv of view.players) {
    assert.deepEqual(
      Object.keys(pv).sort(),
      [...PUBLIC_PLAYER_FIELDS].sort(),
      `座位 ${pv.id} 的字段必须恰好是公开字段（房间层的 isBot 之类不许进来）`
    );
    assert.ok(!('hand' in pv), `座位 ${pv.id} 的手牌内容漏了`);
    assert.ok(!('isBot' in pv), `座位 ${pv.id} 里出现了房间层的字段名 isBot`);
    const real = state.players.find((p) => p.id === pv.id);
    assert.ok(real, `座位 ${pv.id} 不在权威状态里`);
    assert.equal(pv.handCount, real.hand.length, `座位 ${pv.id} 的手牌张数`);
    assert.equal(pv.hp, real.hp, `座位 ${pv.id} 的血量`);
    assert.equal(pv.alive, real.alive, `座位 ${pv.id} 的存活标记`);
    assert.equal(pv.isAI, !!real.isAi, `座位 ${pv.id} 的身份标记必须来自座位`);
    if (pv.id === viewerId || real.hand.length < 2) continue;
    // 手牌内容恰好与"我的某一份"完全相同是可以的（那就等于我的报文里本来就有），其余一律不行
    if (myHands.has(JSON.stringify(real.hand))) continue;
    assert.ok(!dump.includes(JSON.stringify(real.hand)), `座位 ${pv.id} 的整手牌漏进报文了`);
  }

  // ③ 我自己的那一份：字段恰好是私有字段；放大镜情报只有自己的
  assert.deepEqual(
    Object.keys(view.me).sort(),
    [...PRIVATE_SELF_FIELDS].sort(),
    'me 的字段必须恰好是 PRIVATE_SELF_FIELDS'
  );
  assert.deepEqual(view.me.hand, mine.hand, '自己的手牌要原样给出');
  assert.equal(view.me.knows, state.knowledge[viewerId] || null, '只给"我"的放大镜情报');
  for (const other of state.players) {
    if (other.id === viewerId || !state.knowledge[other.id]) continue;
    // 情报表在引擎里是"playerId → 弹种"，视图里出现以玩家 id 为键的对象就是漏了
    assert.ok(
      !keysOf(view).has(other.id),
      `视图里出现了以 ${other.id} 为键的对象（放大镜情报表漏出来了）`
    );
  }

  // 日志只播报公开事件。注意 `shell`（单数）是**允许**的：那是刚打出去的那一发，
  // 有没有伤害当场就看得见，属于规则上的公开信息（同 beer 的 ejected）。
  // 不许出现的是"还没打出去的东西"：弹匣数组、别人的手牌、放大镜看到的结果。
  for (const e of view.log) {
    for (const k of Object.keys(e)) {
      assert.ok(
        !['shells', 'hand', 'handCount', 'knowledge', 'knows', 'peek', 'seed',
          'drawPile', 'discard', 'magazine', 'index', 'rng', 'order'].includes(k),
        `日志条目里出现了字段「${k}」`
      );
    }
  }

  // pending（肾上腺素偷到手铐之类）只准有这 4 个字段
  if (view.pending) {
    for (const k of Object.keys(view.pending)) {
      assert.ok(['kind', 'item', 'from', 'waitingFor'].includes(k), `pending 多出字段「${k}」`);
    }
  }
}

/** 视图里所有出现过的"键"（递归，含数组里的对象） */
function keysOf(node, out = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return out;
  for (const [k, v] of Object.entries(node)) {
    out.add(k);
    keysOf(v, out, depth + 1);
  }
  return out;
}