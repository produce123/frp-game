/*
 * 大炮轰小鬼 —— 规则 / 视图 / 服务端接入 / AI 的测试。
 *
 * 跑：node --test games/cannon-goblin/tests/rules.test.mjs
 *
 * 【搬迁时做了什么】
 * 原文件 tests/game.test.mjs 是三合一的：MQTT 报文编解码 + 房间号/话题/sid + 规则一致性。
 * 现在：
 *   · MQTT 报文编解码、话题方向、sid 定向、busy 抢占 —— **整段删掉**
 *     那套代码存在的唯一理由是"玩家没有服务器"（见源 AGENTS.md），现在有服务器了。
 *   · 房间号归一化 —— 归平台管（shared/protocol.mjs），不在游戏里测了。
 *   · 规则与 AI 的用例**原样保留**（那两条"困难模式不吃子"的回归用例尤其别丢）。
 *   · 新增：视图层、服务端接入层的用例。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GameState, EMPTY, CANNON, GHOST, PRESET_MAPS } from '../js/engine/rules.js';
import { AIPlayer } from '../js/ai/ai.js';
import { viewFor, stateFromView, sideToName, nameToSide, otherSide } from '../js/view.js';
import { createMatch, meta } from '../../../server/games/cannon-goblin.mjs';

// 断言辅助：把带原型的对象转成纯数据再比较，避免被原型差异干扰
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 按预设地图造一局。 */
function fromPreset(index, turn = CANNON) {
  const preset = PRESET_MAPS[index];
  const gs = new GameState(preset.width, preset.height);
  for (const [r, c] of preset.cannons) gs.placeCannon(r, c);
  for (const [r, c] of preset.ghosts) gs.placeGhost(r, c);
  gs.currentTurn = turn;
  return gs;
}

function isLegalMove(gs, move) {
  if (!move) return false;
  return gs.getAllMoves(move.from.r, move.from.c).some((m) => m.r === move.to.r && m.c === move.to.c);
}

/** 服务端接入层的标准测试局面：预设 0，房主执大炮。 */
function newMatch(options = {}) {
  return createMatch(
    [{ id: 'HOSTAAA', name: '甲', isHost: true }, { id: 'GUESTBB', name: '乙', isHost: false }],
    { hostSide: 'cannon', preset: 0, ...options }
  );
}

/* ============================== 规则 ============================== */

test('大炮隔着恰好一个空格可吃小鬼，中间有子则不能吃', () => {
  const open = new GameState(6, 6);
  open.placeCannon(0, 0);
  open.placeGhost(2, 0);
  assert.deepEqual(plain(open.getAllMoves(0, 0).filter((m) => m.capture)), [{ r: 2, c: 0, capture: true }]);

  const blocked = new GameState(6, 6);
  blocked.placeCannon(0, 0);
  blocked.placeGhost(1, 0);
  blocked.placeGhost(2, 0);
  assert.equal(blocked.getAllMoves(0, 0).filter((m) => m.capture).length, 0);

  const tooFar = new GameState(6, 6);
  tooFar.placeCannon(0, 0);
  tooFar.placeGhost(3, 0);
  assert.equal(tooFar.getAllMoves(0, 0).filter((m) => m.capture).length, 0);
});

test('小鬼数 <= 大炮数时判大炮获胜', () => {
  const gs = new GameState(5, 5);
  gs.placeCannon(0, 0);
  gs.placeCannon(0, 1);
  gs.placeGhost(2, 0);
  gs.placeGhost(4, 4);

  assert.ok(gs.selectPiece(0, 0));
  assert.ok(gs.movePiece(1, 0));
  assert.equal(gs.gameOver, true);
  assert.equal(gs.winner, CANNON);
});

test('引擎是确定性的：同一串操作跑两遍，局面完全一致', () => {
  // 这条原来是"双方本地重放后局面一致"（旧的两端各自重放模型）。
  // 现在联机由服务器裁决，不再两端重放 —— 但确定性仍然是硬要求：
  // 人机对局在浏览器本地跑的是**同一份引擎**，所以它必须可复现，
  // 否则"单机练出来的手感"和"联机实际表现"会对不上。
  const build = () => {
    const gs = new GameState(6, 6);
    gs.placeCannon(5, 2);
    gs.placeCannon(5, 3);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) gs.placeGhost(r, c);
    return gs;
  };

  const a = build();
  const b = build();
  const moves = [[5, 2, 4, 2], [2, 0, 3, 0], [5, 3, 4, 3], [2, 1, 3, 1]];

  for (const [fromR, fromC, toR, toC] of moves) {
    assert.equal(a.currentTurn, b.currentTurn, '走子前两边的轮次必须一致');
    for (const gs of [a, b]) {
      assert.ok(gs.selectPiece(fromR, fromC), `(${fromR},${fromC}) 应可选中`);
      assert.ok(gs.movePiece(toR, toC), `(${fromR},${fromC})->(${toR},${toC}) 应可走`);
    }
  }

  assert.deepEqual(a.board, b.board);
  assert.equal(a.currentTurn, b.currentTurn);
  assert.equal(a.gameOver, b.gameOver);
});

test('吃子后的局面同样是确定的', () => {
  const build = () => {
    const gs = new GameState(6, 6);
    gs.placeCannon(0, 0);
    gs.placeGhost(2, 0);
    gs.placeGhost(0, 3);
    gs.placeGhost(1, 3);
    gs.placeGhost(2, 3);
    gs.placeGhost(3, 3);
    return gs;
  };

  const a = build();
  const b = build();
  for (const gs of [a, b]) {
    assert.ok(gs.selectPiece(0, 0));
    assert.equal(gs.movePiece(2, 0).captured, true);
  }

  assert.equal(a.getPiece(2, 0), CANNON);
  assert.equal(a.countGhosts(), 4);
  assert.deepEqual(a.board, b.board);
  assert.equal(a.currentTurn, GHOST);
  assert.equal(b.currentTurn, GHOST);
});

/* ============================== 视图层 ============================== */

test('view 只含该有的字段 —— 多一个字都要在这里露出来', () => {
  // 这条是"防止悄悄加字段"的哨兵：以后谁往 viewFor 里塞东西（尤其是为了偷懒把
  // 引擎内部状态一起塞进来），这个用例会立刻红，逼人重新想一遍"这该不该给客户端"。
  const gs = fromPreset(0);
  const view = viewFor(gs, 'cannon');
  assert.deepEqual(Object.keys(view).sort(), [
    'board', 'currentTurn', 'gameOver', 'height', 'lastMove', 'mySide', 'width', 'winner',
  ]);
});

test('view 里不许出现界面状态（selectedPiece / validMoves）', () => {
  // 那两个是"我点开了哪个格子"的本地界面状态。放进 view 会让对手的选中状态
  // 同步到你这边（因为服务端会把它算进 view 再发下来）。
  const gs = fromPreset(0);
  assert.ok(gs.selectPiece(5, 2), '先选中一个子，制造出 selectedPiece / validMoves');
  const view = viewFor(gs, 'cannon');
  assert.equal(view.selectedPiece, undefined);
  assert.equal(view.validMoves, undefined);
});

test('view → state 往返一致，且棋盘是深拷贝', () => {
  const gs = fromPreset(1);
  const view = viewFor(gs, 'ghost');
  const back = stateFromView(view);

  assert.deepEqual(back.board, gs.board);
  assert.equal(back.width, gs.width);
  assert.equal(back.height, gs.height);
  assert.equal(back.currentTurn, gs.currentTurn);

  // 深拷贝：改还原出来的棋盘不许影响 view（否则就等于把服务器状态改掉了）
  back.board[0][0] = EMPTY;
  assert.notEqual(view.board[0][0], EMPTY);
});

test('view 是纯数据，能原样过一遍 JSON 而不变性', () => {
  const gs = fromPreset(0);
  gs.selectPiece(5, 2);
  const view = viewFor(gs, 'cannon');
  const round = JSON.parse(JSON.stringify(view));
  assert.deepEqual(round, view);
});

test('两个玩家的 view 只在 mySide 上不同（这个游戏没有隐藏信息）', () => {
  const match = newMatch();
  const a = match.viewFor('HOSTAAA');
  const b = match.viewFor('GUESTBB');
  assert.equal(a.mySide, 'cannon');
  assert.equal(b.mySide, 'ghost');
  assert.deepEqual(a.board, b.board);
});

test('阵营名 ↔ 数字 双向映射，未知值返回 null（不许瞎猜）', () => {
  assert.equal(sideToName(CANNON), 'cannon');
  assert.equal(sideToName(GHOST), 'ghost');
  assert.equal(sideToName(EMPTY), null);
  assert.equal(nameToSide('cannon'), CANNON);
  assert.equal(nameToSide('ghost'), GHOST);
  assert.equal(nameToSide('乱七八糟'), null);
  assert.equal(otherSide('cannon'), 'ghost');
  assert.equal(otherSide('ghost'), 'cannon');
});

/* ============================== 服务端接入层 ============================== */

test('meta 完整，且 slug 和文件名一致', () => {
  assert.equal(meta.slug, 'cannon-goblin');
  // minPlayers = 1 是**真人**下限：房间层只数真人，一个人也能开局
  // （另一个人机座位由房主在准备区按「＋ 添加人机」加进来）。
  // minSeats = 2 是**总座位**下限（含人机）—— 引擎是 2 人棋，1 个座位建不了局。
  // 两个数不是一回事，别合并（见 docs/GAME-SPEC.md §4「AI 补位」；
  // 座位那条通路的专项用例在 tests/ai-fill.test.mjs，真浏览器那一段在 tests/browser.ai-fill.mjs）。
  assert.equal(meta.minPlayers, 1);
  assert.equal(meta.minSeats, 2);
  assert.equal(meta.maxPlayers, 2);
  assert.equal(meta.allowMidJoin, false);
  assert.ok(meta.title && meta.icon);
});

test('开局后不是自己回合就走不了（防"替对手走子"）', () => {
  const match = newMatch();
  // 预设 0：大炮方先手。乙执小鬼，现在轮不到他。
  const result = match.act('GUESTBB', { kind: 'move', from: { r: 0, c: 0 }, to: { r: 1, c: 0 } });
  assert.equal(result.ok, false);
  assert.match(result.message, /还没轮到你/);
});

test('非法走法被拒且会给中文原因，引擎状态不被弄脏', () => {
  const match = newMatch();

  // 走到一个不相邻的格子
  const far = match.act('HOSTAAA', { kind: 'move', from: { r: 5, c: 2 }, to: { r: 0, c: 0 } });
  assert.equal(far.ok, false);
  assert.ok(far.message && typeof far.message === 'string' && far.message.length > 0);
  assert.match(far.message, /[\u4e00-\u9fa5]/, '原因必须是中文，要能直接显示给玩家');

  // 乱塞的操作类型
  assert.equal(match.act('HOSTAAA', { kind: '投降' }).ok, false);
  assert.equal(match.act('HOSTAAA', null).ok, false);
  assert.equal(match.act('HOSTAAA', { kind: 'move', from: { r: 1.5, c: 2 }, to: { r: 1, c: 2 } }).ok, false);

  // 状态没被弄脏：正常的走子照样能走
  const good = match.act('HOSTAAA', { kind: 'move', from: { r: 5, c: 2 }, to: { r: 4, c: 2 } });
  assert.equal(good.ok, true, '前面几次失败不该把引擎搞坏');
});

test('不属于这一局的人操作会被拒，viewFor 也拿不到东西', () => {
  const match = newMatch();
  assert.equal(match.act('路人丙', { kind: 'move', from: { r: 5, c: 2 }, to: { r: 4, c: 2 } }).ok, false);
  assert.equal(match.viewFor('路人丙'), null);
});

test('房主可以选执小鬼方，加入方自动拿大炮方并由他先手', () => {
  // ⚠️ 这是源项目专门修过的一个坑：别再把"房主 = 大炮方"写死。
  const match = newMatch({ hostSide: 'ghost' });
  assert.equal(match.viewFor('HOSTAAA').mySide, 'ghost');
  assert.equal(match.viewFor('GUESTBB').mySide, 'cannon');

  // 轮到大炮方 = 加入方，所以房主现在走不了
  assert.match(match.act('HOSTAAA', { kind: 'move', from: { r: 0, c: 0 }, to: { r: 1, c: 0 } }).message, /还没轮到你/);
  assert.equal(match.act('GUESTBB', { kind: 'move', from: { r: 5, c: 2 }, to: { r: 4, c: 2 } }).ok, true);
});

test('自定义地图会被校验（这是客户端传上来的数据，必须当成不可信输入）', () => {
  const goodBoard = [
    [EMPTY, GHOST, EMPTY],
    [EMPTY, CANNON, EMPTY],
    [EMPTY, EMPTY, GHOST],
  ];
  // 3×3 摆 1 炮 2 鬼：鬼 > 炮，合法
  const ok = createMatch(
    [{ id: 'HOSTAAA', name: '甲', isHost: true }, { id: 'GUESTBB', name: '乙', isHost: false }],
    { hostSide: 'cannon', custom: { width: 3, height: 3, board: goodBoard.map((r) => r.slice()) } }
  );
  assert.ok(ok.viewFor('HOSTAAA').board.length === 3);

  const reject = (custom, why) => {
    const board = custom.board;
    assert.throws(
      () => createMatch(
        [{ id: 'HOSTAAA', name: '甲', isHost: true }, { id: 'GUESTBB', name: '乙', isHost: false }],
        { hostSide: 'cannon', custom }
      ),
      (err) => typeof err.message === 'string' && err.message.length > 0,
      why
    );
  };

  reject({ width: 3, height: 3, board: [] }, '棋盘行数对不上');
  reject({ width: 3, height: 3, board: [[1, 1, 1]] }, '棋盘只有一行');
  reject({ width: 999, height: 999, board: [] }, '尺寸超上限');
  reject({ width: 2, height: 2, board: [[1, 1], [1, 1]] }, '尺寸低于下限');
  reject({ width: 'a', height: 3, board: [] }, '尺寸不是整数');
});

test('自定义地图里没有大炮 / 小鬼不够多 都会被拒（那是开局即死的盘）', () => {
  const two = (board) => createMatch(
    [{ id: 'HOSTAAA', name: '甲', isHost: true }, { id: 'GUESTBB', name: '乙', isHost: false }],
    { hostSide: 'cannon', custom: { width: 3, height: 3, board } }
  );

  assert.throws(() => two([
    [EMPTY, GHOST, GHOST],
    [EMPTY, EMPTY, EMPTY],
    [EMPTY, EMPTY, EMPTY],
  ]), /至少要有/);

  assert.throws(() => two([
    [EMPTY, EMPTY, EMPTY],
    [EMPTY, CANNON, EMPTY],
    [EMPTY, EMPTY, EMPTY],
  ]), /至少要有/);

  // 1 炮 1 鬼：鬼 <= 炮，开局就判大炮赢
  assert.throws(() => two([
    [EMPTY, EMPTY, EMPTY],
    [EMPTY, CANNON, EMPTY],
    [EMPTY, EMPTY, GHOST],
  ]), /小鬼数量/);
});

test('对手离开 → 留下的人直接判胜（否则他会因为"轮不到自己"卡死）', () => {
  const match = newMatch();
  assert.equal(match.isOver(), false);
  match.removePlayer('GUESTBB');
  assert.equal(match.isOver(), true);
  assert.equal(match.result().winner, 'cannon', '离开的是小鬼方，所以大炮方获胜');
});

test('一局结束后不再接受操作，结果里有胜负与棋子数', () => {
  const match = newMatch();
  match.removePlayer('GUESTBB');   // 直接结束，省得摆一盘
  const after = match.act('HOSTAAA', { kind: 'move', from: { r: 5, c: 2 }, to: { r: 4, c: 2 } });
  assert.equal(after.ok, false);
  assert.match(after.message, /已经结束/);

  const result = match.result();
  assert.equal(result.winner, 'cannon');
  assert.ok(Number.isInteger(result.ghosts));
  assert.ok(Number.isInteger(result.cannons));
});

test('真打一盘：走 200 步，每一步都被服务端接受，且发下来的 view 如实反映这一步', () => {
  // 这条不要求"分出胜负"：实测两边都用 AI 时一局能拖很久（见 tests/sim.mjs 的说明），
  // 那是 AI 互相磨，不是缺陷。它要证明的是别的事：
  //   · 服务端接口能承受一整局连续对局，不会中途拒绝合法走法
  //   · view 是**如实**的：走完一步之后，view 里的棋盘必须和这一步对得上
  //     （落点是走子方的子、起点空了、轮次换人）——
  //     界面全靠 view 渲染，view 一旦失真，玩家看到的就是另一盘棋
  const match = newMatch();
  const STEPS = 200;
  let steps = 0;

  while (!match.isOver() && steps < STEPS) {
    const probe = match.viewFor('HOSTAAA');
    const turn = probe.currentTurn;
    const me = turn === 'cannon' ? 'HOSTAAA' : 'GUESTBB';
    const mySide = me === 'HOSTAAA' ? 'cannon' : 'ghost';

    const view = match.viewFor(me);
    const gs = stateFromView(view);
    const move = AIPlayer.makeMove(gs, gs.currentTurn, 'normal');
    assert.ok(move, `第 ${steps} 步 AI 没给出走法，但对局没结束`);
    assert.ok(isLegalMove(gs, move), 'AI 给出的必须是合法走法');

    const piece = view.board[move.from.r][move.from.c];

    const result = match.act(me, { kind: 'move', from: move.from, to: move.to });
    assert.equal(result.ok, true, `第 ${steps} 步被服务端拒了：${result.message}`);
    steps++;

    const after = match.viewFor(me);
    assert.equal(after.board[move.to.r][move.to.c], piece, '落点应当是走子方的那个子');
    assert.equal(after.board[move.from.r][move.from.c], EMPTY, '起点应当空出来');
    assert.deepEqual(after.lastMove, { fromR: move.from.r, fromC: move.from.c, toR: move.to.r, toC: move.to.c });
    assert.equal(after.mySide, mySide, 'mySide 不该变');
    if (after.gameOver) break;
    assert.notEqual(after.currentTurn, turn, '走完一步该换人');
  }

  assert.equal(steps, STEPS, '这 200 步都该被接受');
  // 刻意**不**断言"这盘吃到了子"：实测普通难度（只看 2 步）在预设 0 上会
  // 长时间原地打转、一手不吃 —— 这是源项目 AI 的既有脾性（它的 AGENTS.md 里写着
  // 困难档才有迭代加深），不是服务端接入层的问题。要吃子的行为由下面那条
  // 确定性用例单独守（直接摆一个必定能吃到的局面）。
});

test('吃子走服务端：view 立刻反映吃掉的那一步', () => {
  // 摆一个一眼能吃的局面：大炮在 (2,2)，小鬼在 (2,4)，中间 (2,3) 空着。
  // 不改规则、不靠 AI，直接把这一步发给服务端，看它认不认、view 变没变。
  const B = EMPTY;
  const board = [
    [GHOST, B, B, B, B],
    [B, B, B, B, B],
    [B, B, CANNON, B, GHOST],
    [B, B, B, B, B],
    [B, B, B, B, GHOST],
  ];
  const match = createMatch(
    [{ id: 'HOSTAAA', name: '甲', isHost: true }, { id: 'GUESTBB', name: '乙', isHost: false }],
    { hostSide: 'cannon', custom: { width: 5, height: 5, board: board.map((r) => r.slice()) } }
  );

  const before = match.viewFor('HOSTAAA');
  assert.equal(before.board[2][4], GHOST);
  assert.equal(before.board[2][3], EMPTY);
  assert.equal(before.currentTurn, 'cannon');

  // 中间隔着一个空格的吃子
  assert.equal(match.act('HOSTAAA', { kind: 'move', from: { r: 2, c: 2 }, to: { r: 2, c: 4 } }).ok, true);

  const after = match.viewFor('HOSTAAA');
  assert.equal(after.board[2][4], CANNON, '吃子之后大炮站在小鬼原来的位置上');
  assert.equal(after.board[2][2], EMPTY, '起点应当空出来');
  assert.equal(after.currentTurn, 'ghost', '换小鬼走');
  assert.deepEqual(after.lastMove, { fromR: 2, fromC: 2, toR: 2, toC: 4 });

  // 吃子方向反过来（隔着子吃）必须被拒：中间那格被占着
  const blocked = createMatch(
    [{ id: 'HOSTAAA', name: '甲', isHost: true }, { id: 'GUESTBB', name: '乙', isHost: false }],
    {
      hostSide: 'cannon',
      custom: {
        width: 5, height: 5,
        board: [
          [GHOST, B, B, B, B],
          [B, B, B, B, B],
          [B, B, CANNON, GHOST, GHOST],
          [B, B, B, B, B],
          [B, B, B, B, GHOST],
        ],
      },
    }
  );
  assert.equal(blocked.act('HOSTAAA', { kind: 'move', from: { r: 2, c: 2 }, to: { r: 2, c: 4 } }).ok, false);
});

/* ============================== 人机 AI ============================== */

test('三种难度在预设地图上都返回合法走法（双方都测）', () => {
  for (let index = 0; index < PRESET_MAPS.length; index++) {
    for (const turn of [CANNON, GHOST]) {
      for (const difficulty of ['easy', 'normal', 'hard']) {
        const gs = fromPreset(index, turn);
        const move = AIPlayer.makeMove(gs, turn, difficulty);
        assert.ok(move, `地图 ${index} / ${turn === CANNON ? '大炮' : '小鬼'} / ${difficulty} 应该给出走法`);
        assert.ok(isLegalMove(gs, move), `地图 ${index} / ${difficulty} 给出的必须是合法走法`);
      }
    }
  }
});

test('难度对应预测步数：简单 1 步、普通 2 步；困难不固定层数但不会超过上限', () => {
  const gs = fromPreset(0, CANNON);

  AIPlayer.makeMove(gs, CANNON, 'easy');
  assert.equal(AIPlayer.depthReached, 1);
  AIPlayer.makeMove(gs, CANNON, 'normal');
  assert.equal(AIPlayer.depthReached, 2);

  AIPlayer.makeMove(fromPreset(1, CANNON), CANNON, 'hard');
  assert.ok(AIPlayer.depthReached >= 2, `困难模式至少要比普通深，实际 ${AIPlayer.depthReached}`);
  assert.ok(AIPlayer.depthReached <= 8, `困难模式不该超过 8 层上限，实际 ${AIPlayer.depthReached}`);
});

test('困难模式在满盘小鬼的局面下也会吃子（回归：曾经因为距离项过大而不吃）', () => {
  // 8x8 几乎铺满小鬼，大炮站中间，只给它留一条吃子线路：
  // (3,3) 上方 (2,3) 空、(1,3) 有鬼 → 可以隔空吃掉 (1,3)。
  // 旧评估函数对每个小鬼累加"离大炮多远"，跳过去吃会让大炮离鬼群更近、
  // 总分反而掉了，于是困难电脑宁愿在 (6,4)/(6,3) 之间来回走，一手都不吃。
  const build = () => {
    const gs = new GameState(8, 8);
    for (const [r, c] of [[3, 3], [3, 5], [6, 4]]) gs.placeCannon(r, c);
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (gs.board[r][c] !== EMPTY) continue;
        if (r === 2 && c === 3) continue;   // 吃子线路上的空位，必须留空
        gs.placeGhost(r, c);
      }
    }
    gs.currentTurn = CANNON;
    return gs;
  };

  const gs = build();
  assert.ok(gs.countGhosts() >= 20, `这个局面应该有满盘小鬼，实际 ${gs.countGhosts()}`);
  assert.deepEqual(plain(gs.getCaptureMoves(3, 3)), [{ r: 1, c: 3, capture: true }],
    '构造的局面里 (3,3) 应当正好能吃 (1,3)');
  assert.equal(gs.isSideBlocked(CANNON), false, '这个局面不该已经分出胜负');

  const move = AIPlayer.makeMove(build(), CANNON, 'hard');
  assert.equal(move.to.capture, true, '满盘小鬼时困难电脑也必须吃掉眼前的子，不能原地打转');
  assert.deepEqual(plain(move.to), { r: 1, c: 3, capture: true });
});

test('困难模式会连着吃：两连吃的机会必须抓住', () => {
  const gs = new GameState(12, 12);
  gs.placeCannon(4, 4);
  for (const [r, c] of [[4, 6], [4, 8], [11, 0], [11, 1], [10, 0]]) gs.placeGhost(r, c);
  gs.currentTurn = CANNON;

  assert.deepEqual(plain(gs.getCaptureMoves(4, 4)), [{ r: 4, c: 6, capture: true }], '第一步应当能吃 (4,6)');

  let eaten = 0;
  for (let i = 0; i < 2 && !gs.gameOver; i++) {
    gs.currentTurn = CANNON;    // 这里只考大炮的连吃，小鬼那步直接跳过
    const before = gs.countGhosts();
    const move = AIPlayer.makeMove(gs, CANNON, 'hard');
    assert.ok(move, '应当给出走法');
    assert.equal(move.to.capture, true, `第 ${i + 1} 手有机会吃子，应当吃掉（落在 (${move.to.r},${move.to.c})）`);
    assert.ok(gs.selectPiece(move.from.r, move.from.c));
    gs.movePiece(move.to.r, move.to.c);
    if (gs.countGhosts() < before) eaten++;
  }
  assert.equal(eaten, 2, `两连吃应当都吃到，实际 ${eaten}`);
});

test('简单的 1 步预测也能立刻吃到眼前的小鬼', () => {
  const build = () => {
    const gs = new GameState(6, 6);
    gs.placeCannon(2, 2);
    gs.placeGhost(2, 4); // (2,3) 为空，大炮可以隔空吃掉它
    for (const [r, c] of [[5, 0], [5, 1], [5, 2], [5, 3], [5, 4]]) gs.placeGhost(r, c);
    return gs;
  };

  for (const difficulty of ['easy', 'normal', 'hard']) {
    const gs = build();
    const move = AIPlayer.makeMove(gs, CANNON, difficulty);
    assert.equal(move.to.capture, true, `${difficulty} 应当选择吃子`);
    assert.deepEqual(plain(move.to), { r: 2, c: 4, capture: true });
  }
});

test('无子可走时返回 null，不会瞎走', () => {
  const gs = new GameState(6, 6);
  gs.placeCannon(0, 0);
  gs.placeGhost(0, 1); // 右边被堵
  gs.placeGhost(1, 0); // 下边被堵
  for (const [r, c] of [[5, 5], [5, 4], [4, 5]]) gs.placeGhost(r, c);

  assert.equal(AIPlayer.makeMove(gs, CANNON, 'hard'), null);
});

test('困难模式思考时间受预算保护（不能把界面卡住）', () => {
  for (const turn of [CANNON, GHOST]) {
    const gs = fromPreset(1, turn);
    const started = Date.now();
    assert.ok(AIPlayer.makeMove(gs, turn, 'hard'), '应当给出走法');
    const elapsed = Date.now() - started;
    // 时间预算 1500ms，留足余量：这里主要防止有人把预算/剪枝改坏导致手机端卡死
    assert.ok(elapsed < 3000, `困难模式在最大地图上耗时 ${elapsed}ms，超出预期`);
  }
});
