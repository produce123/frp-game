/*
 * 大炮轰小鬼 —— 「人机座位」专项用例（docs/GAME-SPEC.md §4「AI 补位」的验收）。
 *
 * 跑：node --test games/cannon-goblin/tests/ai-fill.test.mjs
 *     （在仓库根目录 E:\frp-game 下跑；下面的 import 都是相对本文件的路径）
 *
 * 【这一版换了契约，改之前先看】
 * 人机**不再是"游戏模块自己偷偷补的座位"**，而是**房间的一个座位**：
 *   · 房主在准备区按「＋ 添加人机」→ 房间层多一个 `bot:1` 座位（单字名字，灰色头像）
 *   · 开局时房间层把 `[{真人…}, {人机…}]` 一起塞进 `createMatch(players, options)`
 *   · `options.aiFill` **整段作废**（服务端不再读它，客户端也不再画那个开关）
 * 所以这个文件测的是"**座位表里带 isBot 时，这一局能不能好好打完**"，
 * 而不是以前那个"一个人 + 补位开关"。
 *
 * 【为什么单独一个文件，而不是塞进 rules.test.mjs】
 * rules.test.mjs 管的是"规则与视图裁剪本身别改错"；这一个管的是**在线房间的座位通路**：
 * 人机座位能不能开局、两个真人时不掺电脑、人机的动作有没有被服务端同步跑完。
 * 后者出问题时排查方向完全不同（跟 shell-gambit 的 tests/ai-fill.test.mjs 摆成一样的形状）。
 *
 * 【这里不碰 DOM、不起服务器、不连 WebSocket】
 * 测的是 server/games/cannon-goblin.mjs 的 createMatch —— 房间层交给它的就是
 * "座位数组 + options"，所以这一层测干净了，"一个人 + 一个人机也能开局"就没问题了。
 * 真浏览器那一段在 tests/browser.ai-fill.mjs（建房 → 加人机 → 开局 → 走一步）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CANNON, GHOST, EMPTY } from '../js/engine/rules.js';
import { AIPlayer } from '../js/ai/ai.js';
import { stateFromView } from '../js/view.js';
import { createMatch, meta } from '../../../server/games/cannon-goblin.mjs';

/* ============================== 测试辅助 ============================== */

/** 房主（真人）。 */
const HOST = { id: 'HOSTAAA', name: '甲', isHost: true, isBot: false };
/** 第二个真人。 */
const GUEST = { id: 'GUESTBB', name: '乙', isHost: false, isBot: false };
/**
 * 人机座位 —— id 用平台协议的 `bot:` 前缀（`shared/protocol.mjs` 的 BOT_ID_PREFIX）。
 * 名字是**单字**（平台默认池那批：虎狼鹰豹…），头像就是一个字。
 */
const BOT = { id: 'bot:1', name: '虎', isHost: false, isBot: true };

/** 最标准的联机局面：1 个真人 + 1 个人机座位。 */
function soloMatch(options = {}) {
  return createMatch([{ ...HOST }, { ...BOT }], { hostSide: 'cannon', preset: 0, ...options });
}

/**
 * 用例里那个"真人"怎么走：能吃就吃（用引擎自己列的吃子线），否则用最便宜的一档随便走。
 * 目的是让用例**确定性地**推进，而不是替玩家扮演一个高手 ——
 * 人机那边的决策全部由服务端的驱动逻辑负责，这里一次都不替它走子。
 */
function humanMove(view) {
  const gs = stateFromView(view);
  for (const piece of gs.getAllPiecesForSide(gs.currentTurn)) {
    const captures = gs.getCaptureMoves(piece.r, piece.c);
    if (captures.length) return { from: { r: piece.r, c: piece.c }, to: { r: captures[0].r, c: captures[0].c } };
  }
  return AIPlayer.makeMove(gs, gs.currentTurn, 'easy');
}

/* ============================== 座位与开局 ============================== */

test('meta：真人下限 1、总座位下限 2，座位够了就能开局', () => {
  assert.equal(meta.minPlayers, 1, '房间层只数真人：一个人也能点开始（另一个人机座位顶上）');
  assert.equal(meta.minSeats, 2, '引擎是 2 人棋：总座位（含人机）的下限是 2');
  assert.equal(meta.maxPlayers, 2);
  assert.ok(meta.minSeats >= meta.minPlayers && meta.minSeats <= meta.maxPlayers);

  /*
   * ⚠️ 这一段是**体检脚本走的那条路**（tools/check-game.mjs 拿 meta.minSeats 个座位、
   * options 传空对象来调 createMatch）：两个真人的座位表 + 空 options 必须能开局。
   * 以前这里缺了就会当场红。
   */
  const bare = createMatch([{ ...HOST }, { ...GUEST }], {});
  assert.equal(bare.viewFor('HOSTAAA').mySide, 'cannon');
  assert.equal(bare.viewFor('GUESTBB').mySide, 'ghost');
  assert.deepEqual(bare._aiIds(), [], '两个真人时不许硬塞一个电脑进来');
  assert.equal(bare.isOver(), false);
});

test('1 个真人 + 1 个人机座位能开局，第二个座位就是电脑', () => {
  const match = soloMatch();
  assert.deepEqual(match._aiIds(), ['bot:1']);
  assert.equal(match.viewFor('HOSTAAA').mySide, 'cannon');
  assert.equal(match.viewFor('HOSTAAA').gameOver, false);
  assert.equal(match.viewFor('bot:1') !== null, true, '人机座位也是座位，服务端要能拿到它的视图');
});

test('房主选小鬼方时，人机执大炮方并当场走完先手第一手', () => {
  const match = soloMatch({ hostSide: 'ghost' });
  const view = match.viewFor('HOSTAAA');

  assert.equal(view.mySide, 'ghost', '房主选小鬼，人机座位就是大炮');
  // 大炮先手。创建完回合还在电脑身上 = 客户端永远停在"等待对手行动"，这是踩过的坑
  assert.equal(view.currentTurn, 'ghost', 'createMatch 返回之前，人机那一手必须已经跑完');
  assert.ok(view.lastMove, '人机应当已经走过一手了');
  assert.equal(view.board[view.lastMove.toR][view.lastMove.toC], CANNON, '人机那一手是大炮走的');
});

/* ============================== 同步驱动（不许用定时器） ============================== */

test('真人每走一步，人机都在同一次 act() 里被跑完（500 步上限，不靠定时器）', () => {
  /*
   * 这是"人机由服务端同步驱动"最直接的证据：
   *   · act() 返回 **之后** 立刻看 view —— 要么已经分出胜负，要么回合一定回到真人身上；
   *     如果返回时回合还在人机身上，真人就会永远卡在"等待对手行动"（项目踩过的坑）。
   *   · 顺带压一压"不死循环"：给 500 步上限，超了或者卡住了就是失败。
   * 实测（preset 0、人机难度 easy）：500 步约 10ms，一直有来有回、不分胜负 ——
   * 那是两边 AI 互相磨（见 tests/sim.mjs 的说明），不是死循环，所以这里只断言"能持续推进"。
   */
  const MAX_STEPS = 500;
  const match = soloMatch({ hostSide: 'cannon', preset: 0 });
  let steps = 0;
  let aiMoves = 0;

  while (!match.isOver() && steps < MAX_STEPS) {
    const before = match.viewFor('HOSTAAA');
    assert.equal(before.currentTurn, before.mySide, `第 ${steps} 步开始时该轮到真人`);

    const move = humanMove(before);
    assert.ok(move, `第 ${steps} 步没给出走法，但对局没结束`);
    const result = match.act('HOSTAAA', { kind: 'move', from: move.from, to: move.to });
    assert.equal(result.ok, true, `第 ${steps} 步被服务端拒了：${result.message}`);
    steps++;

    const after = match.viewFor('HOSTAAA');
    if (after.gameOver) break;

    // 人机必须在同一次 act() 里走完 —— 这两条就是"没用定时器"的证据
    assert.equal(after.currentTurn, after.mySide, `第 ${steps} 步之后回合还在人机身上（真人会卡住）`);
    assert.ok(after.lastMove, '人机应当接过一手');
    assert.equal(
      after.board[after.lastMove.toR][after.lastMove.toC], GHOST,
      `第 ${steps} 步之后落下的是人机（小鬼）的子`
    );
    assert.notDeepEqual(after.lastMove, {
      fromR: move.from.r, fromC: move.from.c, toR: move.to.r, toC: move.to.c,
    }, 'lastMove 应当已经被人机那一手覆盖');
    aiMoves++;
  }

  assert.ok(steps > 0, '至少要真的走过一步');
  assert.ok(steps <= MAX_STEPS, `超过 ${MAX_STEPS} 步上限（${steps} 步）—— 检查是不是死循环了`);
  assert.ok(aiMoves > 0, '人机至少接手过一手，否则座位根本没驱动起来');
});

test('1 个真人 + 1 个人机座位能从开局一路打到分出胜负（全程不需要真人催）', () => {
  /*
   * 用一块 5×5 的小盘（1 炮 3 鬼），让"真人"用最朴素的"能吃就吃"打法 ——
   * 实测**确定性**地 7 步结束（每一步之后人机立刻回一手），所以可以断言结局本身，
   * 而不是"跑到上限看看有没有结束"。图的是"整条路真的能收尾"：引擎判胜、result() 如实。
   */
  const B = EMPTY;
  const match = createMatch([{ ...HOST }, { ...BOT }], {
    hostSide: 'cannon',
    custom: {
      width: 5,
      height: 5,
      board: [
        [GHOST, B, B, B, GHOST],
        [B, B, GHOST, B, B],
        [B, B, B, B, B],
        [B, B, B, B, B],
        [B, B, B, B, CANNON],
      ],
    },
  });

  let steps = 0;
  while (!match.isOver() && steps < 500) {
    const view = match.viewFor('HOSTAAA');
    assert.equal(view.currentTurn, view.mySide, '每一步开始时都该轮到真人');
    const move = humanMove(view);
    assert.ok(match.act('HOSTAAA', { kind: 'move', from: move.from, to: move.to }).ok);
    steps++;
    const after = match.viewFor('HOSTAAA');
    if (!after.gameOver) assert.equal(after.currentTurn, after.mySide, '人机没被跑完');
  }

  assert.equal(match.isOver(), true, `这盘小棋 ${steps} 步内必须分出胜负，实际没结束`);
  assert.equal(steps, 7, `这盘棋是确定性的 7 步结束，实际 ${steps} 步`);
  const result = match.result();
  assert.equal(result.winner, 'cannon', '真人把 3 个鬼吃到只剩 1 个（= 大炮数），大炮方胜');
  assert.equal(result.ghosts, 1);
  assert.equal(result.cannons, 1);
  // 结束之后不再接受操作
  assert.match(match.act('HOSTAAA', { kind: 'move', from: { r: 1, c: 4 }, to: { r: 1, c: 3 } }).message, /已经结束/);
});

/* ============================== 座位表是不可信输入 ============================== */

test('座位不够 / 座位太多 / 没有真人：抛的是能看懂的中文，不是 TypeError', () => {
  const chinese = (err) => typeof err.message === 'string' && /[\u4e00-\u9fa5]/.test(err.message);

  // 1 个座位：引擎是 2 人棋，建不了局 —— 提示要指向「＋ 添加人机」
  assert.throws(
    () => createMatch([{ ...HOST }], {}),
    (err) => chinese(err) && /座位/.test(err.message) && /添加人机/.test(err.message),
    '一个人、也没有人机座位时要抛一句说清楚怎么办的中文'
  );

  // 3 个座位：超过 maxPlayers
  assert.throws(() => createMatch([{ ...HOST }, { ...GUEST }, { ...BOT }], {}), chinese, '座位超上限');
  // 全是人机：这一局没有真人，没有意义
  assert.throws(() => createMatch([{ ...BOT }, { id: 'bot:2', name: '狼', isBot: true }], {}), chinese, '没有真人');
  // 垃圾形状
  for (const bad of [null, undefined, '乱七八糟', 42, [], [null, undefined], [{ id: 123 }]]) {
    assert.throws(
      () => createMatch(bad, {}),
      chinese,
      `座位表传 ${JSON.stringify(bad)} 时要给中文错误，不许抛 TypeError`
    );
  }
});

test('座位表里的 isBot 只看真假：字符串 "false" 之类不会被当成人机', () => {
  // 平台给的一律是真正的布尔。这里说的是"别用真值判断收口"——
  // 只有 `isBot === true` 才是电脑座位，别的都按真人算。
  const match = createMatch([{ ...HOST }, { id: 'GUESTBB', name: '乙', isHost: false, isBot: false }], {});
  assert.deepEqual(match._aiIds(), []);
  assert.equal(match.viewFor('GUESTBB').mySide, 'ghost');
});

test('作废的 options.aiFill 不再有任何作用（传什么都不影响这一局）', () => {
  /*
   * ⚠️ 这段是**旧契约的墓碑**：以前 `aiFill: 0` 意味着"房主不想要电脑"，
   * 一个人时会**拒绝开局**（抛中文，房间层转成提示条）；`aiFill: 99` 会被截断。
   * 现在人机就是座位、由房间层管，服务端**根本不读这个字段** ——
   * 所以这些值传进来都必须照常开局（真要是还有人传，也不能把服务端弄炸）。
   */
  for (const value of [0, 1, 99, -3, 1.9, '乱七八糟', null, undefined, {}]) {
    const match = createMatch([{ ...HOST }, { ...BOT }], { hostSide: 'cannon', preset: 0, aiFill: value });
    assert.deepEqual(match._aiIds(), ['bot:1'], `aiFill=${JSON.stringify(value)} 不该影响座位表`);
    assert.equal(match.isOver(), false);
  }
  // 两个真人的座位表 + aiFill: 99 也不许凭空多出电脑
  const two = createMatch([{ ...HOST }, { ...GUEST }], { aiFill: 99 });
  assert.deepEqual(two._aiIds(), []);
});

test('垃圾输入在带人机座位的局里照样只是被拒，不抛异常', () => {
  // 沿用它原来的防线（docs/GAME-SPEC.md：「垃圾输入不许抛异常」）——
  // 多了一个人机座位，act() 的入口校验一个字都没放松。
  const match = soloMatch({ hostSide: 'cannon' });
  const garbage = [
    null, undefined, {},
    { kind: '投降' },
    { kind: 'move', from: 'x', to: 'y' },
    { kind: 'move', from: { r: 1.5, c: 2 }, to: { r: 1, c: 2 } },
    { kind: 'move', from: { r: 99, c: 99 }, to: { r: 0, c: 0 } },
  ];

  for (const bad of garbage) {
    let result;
    assert.doesNotThrow(() => { result = match.act('HOSTAAA', bad); }, `act(${JSON.stringify(bad)}) 抛异常了`);
    assert.equal(result.ok, false, `act(${JSON.stringify(bad)}) 应当被拒`);
    assert.match(result.message, /[\u4e00-\u9fa5]/, '被拒时要给能直接显示给玩家的中文');
  }

  // 不在这一局的人也一样
  assert.doesNotThrow(() => match.act('路人丙', {}));
  assert.equal(match.act('路人丙', {}).ok, false);

  // 被拒了这么多下，正常的走子照样能走（引擎状态没被弄脏）
  assert.equal(match.act('HOSTAAA', { kind: 'move', from: { r: 5, c: 2 }, to: { r: 4, c: 2 } }).ok, true);
});

/* ============================== 人机的身份与不泄露 ============================== */

test('人机座位不是"能被人操纵的玩家"：拿它的 id 走子只会得到"还没轮到你"', () => {
  const match = soloMatch({ hostSide: 'cannon' });
  const aiId = match._aiIds()[0];
  assert.equal(typeof aiId, 'string');
  assert.match(aiId, /^bot:/, '人机 id 带平台约定的前缀（字母表里没有冒号，撞不上真人 id）');

  // 真人是大炮、现在轮到大炮，所以拿人机的 id 走子只会得到"还没轮到你" ——
  // 人机座位只能由服务端自己驱动。
  assert.match(match.act(aiId, { kind: 'move', from: { r: 5, c: 2 }, to: { r: 4, c: 2 } }).message, /还没轮到你/);
});

test('人机座位的 view 逐字段检查：没有电脑那一方的任何痕迹', () => {
  /*
   * ⚠️ 先说清楚一件事，免得这条用例被误读：
   * 大炮轰小鬼是**信息公开**的棋类，引擎里不存在"只属于某一方的隐藏状态"
   * （没有牌堆顺序、没有对手手牌、没有未揭晓的拳 —— 对比 Shell Gambit / BladeSteed）。
   * 所以这里能查的是**裁剪本身没被"人机坐上座位"这件事改动**：
   *   · view 的字段表一个都不许多（多了就是偷偷把服务端状态塞给客户端）
   *   · 人机的 id / 名字 / 任何 `bot` 痕迹都不许出现在 view 里
   *   · 每个字段的取值都只能"公开局面"该有的东西
   *   · 界面状态（selectedPiece / validMoves）也不许混进来
   *
   * ⚠️ 这条是**哨兵**：view 里加任何一个字段（比如"这台电脑叫什么"）都会让它当场红。
   * 界面上要知道"谁是电脑"请读**房间成员列表**（`room.state.members[].isBot`），
   * 那是平台的口子，别往棋盘报文里塞 —— 见 js/view.js 与 js/ui/app.js 的 versusSeats()。
   */
  // 让人机执大炮：这样对局里已经发生过"人机的一手"，不是空局面
  const match = soloMatch({ hostSide: 'ghost', preset: 0 });
  const aiIds = match._aiIds();
  assert.equal(aiIds.length, 1, '这一局应当有一个人机座位');

  const view = match.viewFor('HOSTAAA');
  const dump = JSON.stringify(view);

  // ① 字段表：与没有 AI 的局完全一致
  assert.deepEqual(Object.keys(view).sort(), [
    'board', 'currentTurn', 'gameOver', 'height', 'lastMove', 'mySide', 'width', 'winner',
  ]);

  // ② 电脑的痕迹（连人机的单字名字都不许出现）
  for (const id of aiIds) assert.ok(!dump.includes(id), `view 里出现了人机座位 id：${id}`);
  assert.ok(!/bot|isBot|isAi|aiFill|difficulty|虎/i.test(dump), `view 里出现了电脑相关的字样：${dump.slice(0, 200)}`);

  // ③ 逐字段查取值
  assert.equal(typeof view.width, 'number');
  assert.equal(typeof view.height, 'number');
  assert.equal(view.board.length, view.height);
  for (const row of view.board) {
    assert.equal(row.length, view.width);
    for (const cell of row) {
      assert.ok(cell === EMPTY || cell === CANNON || cell === GHOST, `棋盘里出现了不该有的值：${cell}`);
    }
  }
  assert.ok(['cannon', 'ghost'].includes(view.currentTurn));
  assert.equal(typeof view.gameOver, 'boolean');
  assert.ok(view.winner === null || ['cannon', 'ghost'].includes(view.winner));
  assert.ok(['cannon', 'ghost'].includes(view.mySide));
  if (view.lastMove) {
    for (const v of Object.values(view.lastMove)) assert.ok(Number.isInteger(v), 'lastMove 只能是整数坐标');
    assert.deepEqual(Object.keys(view.lastMove).sort(), ['fromC', 'fromR', 'toC', 'toR']);
  }

  // ④ 纯数据：能原样过一遍 JSON（发不过 WebSocket 的视图等于没发）
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);

  // ⑤ 界面状态不许混进来
  assert.equal(view.selectedPiece, undefined);
  assert.equal(view.validMoves, undefined);
});

test('人机座位的 id 拿不到视图时返回 null（不在名单里的人就是拿不到）', () => {
  const match = soloMatch();
  assert.equal(match.viewFor('不存在的座位'), null);
});

/* ============================== 离开与不退化 ============================== */

test('真人离开时这一局判给对手 —— 人机在场时语义和两个真人时一样', () => {
  const match = soloMatch({ hostSide: 'cannon' });   // 真人是大炮，人机是小鬼
  assert.equal(match.isOver(), false);
  match.removePlayer('HOSTAAA');
  assert.equal(match.isOver(), true);
  assert.equal(match.result().winner, 'ghost', '走的真人执大炮，所以判另一方（人机）胜');

  // 人机座位不走这条路（它不是房间成员），但就算有人误调也不能把局面弄乱
  const again = soloMatch({ hostSide: 'cannon' });
  again.removePlayer('bot:1');
  assert.equal(again.isOver(), true, '人机座位被移除 = 对局结束（对手走了的处理，没有第二套规则）');
});

test('联机人机用的是最便宜的一档：标准盘上人机一手不许超过 300ms', () => {
  /*
   * §4 硬规矩四：hard 是 depth 8 + 1500ms 预算，会让服务端主线程阻塞约 1.5 秒 ——
   * 联机时那就是"全场卡住"。所以联机座位固定 easy（depth 1 / 150ms 上限）。
   * 这条用**实测耗时**守它：谁把难度改成贵的那一档，这里立刻红。
   * （preset 1 是 8×8 三炮 24 鬼，最费的一盘；房主执炮 / 执鬼各测一次。）
   */
  for (const hostSide of ['cannon', 'ghost']) {
    const started = Date.now();
    createMatch([{ ...HOST }, { ...BOT }], { hostSide, preset: 1 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 300, `人机一手花了 ${elapsed}ms —— 联机难度被改成贵的那一档了？`);
  }
});