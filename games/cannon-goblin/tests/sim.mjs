/*
 * 大炮轰小鬼 —— 自我对弈压力测试（不放进 node --test，因为它跑得慢）。
 *
 * 跑：node games/cannon-goblin/tests/sim.mjs [局数] [难度]
 *
 * 【它想抓什么】
 *   · 引擎在长对局里会不会走进死胡同（两边都无路可走却判不出胜负）
 *   · AI 会不会给出非法走法、或者返回 null 导致对局卡死
 *   · 一局会不会永远打不完
 *
 * 【为什么要它】
 * 联机以后规则跑在服务器上，一局卡住就是"所有人的这一局都卡住"，
 * 不再是"我这一端有点怪"。所以除了单元用例，还需要一批完整对局压一压。
 */

import { GameState, EMPTY, CANNON, GHOST, PRESET_MAPS } from '../js/engine/rules.js';
import { AIPlayer } from '../js/ai/ai.js';
import { viewFor, stateFromView } from '../js/view.js';

const GAMES = Number(process.argv[2] || 6);
const DIFFICULTY = process.argv[3] || 'normal';
/** 一手棋算一步。真打下来很少超过 200 步，超过就说明有问题。 */
const MAX_STEPS = 500;

function newState(presetIndex) {
  const preset = PRESET_MAPS[presetIndex];
  const gs = new GameState(preset.width, preset.height);
  for (const [r, c] of preset.cannons) gs.placeCannon(r, c);
  for (const [r, c] of preset.ghosts) gs.placeGhost(r, c);
  return gs;
}

function count(state, piece) {
  let n = 0;
  for (let r = 0; r < state.height; r++) {
    for (let c = 0; c < state.width; c++) if (state.board[r][c] === piece) n++;
  }
  return n;
}

let gamesPlayed = 0;
let totalSteps = 0;
let unfinished = 0;
const winners = { cannon: 0, ghost: 0 };

for (let game = 0; game < GAMES; game++) {
  const presetIndex = game % PRESET_MAPS.length;
  let state = newState(presetIndex);
  let steps = 0;

  while (!state.gameOver && steps < MAX_STEPS) {
    const side = state.currentTurn;

    // 关键：AI 看到的是 view 还原出来的状态，和服务端发给客户端的是同一条路径。
    // 这保证了"AI 认为合法的走法"和"界面能走的走法"必然是同一套。
    const asSeenByAi = stateFromView(viewFor(state, side === CANNON ? 'cannon' : 'ghost'));

    const move = AIPlayer.makeMove(asSeenByAi, side, DIFFICULTY);
    if (!move) {
      throw new Error(
        `第 ${game + 1} 局第 ${steps} 步：AI 没给出走法，但对局没结束 —— ` +
        `轮到 ${side === CANNON ? '大炮' : '小鬼'}，鬼 ${count(state, GHOST)} 炮 ${count(state, CANNON)}`
      );
    }

    const legal = state.getAllMoves(move.from.r, move.from.c)
      .some((m) => m.r === move.to.r && m.c === move.to.c);
    if (!legal) {
      throw new Error(
        `第 ${game + 1} 局第 ${steps} 步：AI 给出的走法不合法 ` +
        `(${move.from.r},${move.from.c})->(${move.to.r},${move.to.c})`
      );
    }

    if (!state.selectPiece(move.from.r, move.from.c)) {
      throw new Error(`第 ${game + 1} 局第 ${steps} 步：走法合法却选不中`);
    }
    if (!state.movePiece(move.to.r, move.to.c)) {
      throw new Error(`第 ${game + 1} 局第 ${steps} 步：走法合法却走不动`);
    }
    steps++;
  }

  // ⚠️ "打到上限还没结束"**不算失败**。
  // 实测：两边都用 AI 时一局可以拖很久（困难档 500 步还剩 8 个鬼）——
  // 这是 AI 互相磨，不是规则有毛病。这里如实报出来当数据看，
  // 只有"没走法却不结束""给出了非法走法"才是真缺陷。
  if (state.gameOver) {
    winners[state.winner === CANNON ? 'cannon' : 'ghost']++;
    console.log(
      `第 ${game + 1} 局（地图 ${PRESET_MAPS[presetIndex].name}）：${steps} 步，` +
      `${state.winner === CANNON ? '💣 大炮' : '👻 小鬼'}胜，` +
      `剩鬼 ${count(state, GHOST)} 炮 ${count(state, CANNON)}`
    );
  } else {
    unfinished++;
    console.log(
      `第 ${game + 1} 局（地图 ${PRESET_MAPS[presetIndex].name}）：${MAX_STEPS} 步仍未分胜负 ` +
      `（剩鬼 ${count(state, GHOST)} 炮 ${count(state, CANNON)}），按未结束计`
    );
  }

  gamesPlayed++;
  totalSteps += steps;
}

console.log(`\n共 ${gamesPlayed} 局，平均 ${(totalSteps / gamesPlayed).toFixed(1)} 步，未分胜负 ${unfinished} 局`);
console.log(`大炮胜 ${winners.cannon} 局 / 小鬼胜 ${winners.ghost} 局（难度：${DIFFICULTY}）`);
console.log('✅ 没有卡死（没有走法却判不出胜负）、没有非法走法');