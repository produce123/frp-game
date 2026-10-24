/*
 * 视图层 —— **界面唯一允许读的东西**（docs/GAME-SPEC.md 铁律二）。
 *
 * 【这个游戏其实没有隐藏信息】
 * 大炮轰小鬼是信息公开的棋类：整个棋盘谁都能看见。
 * 所以 `viewFor` 返回的就是几乎整个局面 —— 这**不是**漏了裁剪，是它本来就没有秘密。
 * （对比一下 Shell Gambit 的牌堆和 BladeSteed 未揭晓的拳，那两个必须狠狠裁剪。）
 *
 * 那为什么还要有这一层？因为三件事：
 *   1. 人机与联机共用同一套渲染代码 —— 界面只吃 view，所以两种模式一模一样。
 *   2. 服务端权威 —— 服务器把 view 发下来，客户端手里永远只有这些。
 *   3. 以后真加了隐藏信息（比如"每方只能看到自己能走的子"），改这一个文件就够。
 *
 * ⚠️ 反过来说，**不要把 `selectedPiece` / `validMoves` 放进 view**。
 * 那两个是"我点开了哪个格子"的界面状态，不是棋局状态：
 * 放进去会让服务端和客户端的选中状态互相打架（对手选了子也会同步到你这边）。
 */

import { CANNON, GHOST, GameState } from './engine/rules.js';

/** 内部用数字表示阵营，跨进程传输用字符串 —— 数字常量不该泄漏到报文里。 */
export function sideToName(side) {
  if (side === CANNON) return 'cannon';
  if (side === GHOST) return 'ghost';
  return null;
}

export function nameToSide(name) {
  if (name === 'cannon') return CANNON;
  if (name === 'ghost') return GHOST;
  return null;
}

/**
 * 把引擎状态裁剪成某个玩家有权看到的样子。
 * @param {GameState} state
 * @param {'cannon'|'ghost'} mySide 谁在看（view 里带上它，界面就不用再问）
 */
export function viewFor(state, mySide) {
  return {
    width: state.width,
    height: state.height,
    board: state.board.map((row) => row.slice()),
    currentTurn: sideToName(state.currentTurn),
    gameOver: Boolean(state.gameOver),
    winner: sideToName(state.winner),
    lastMove: state.lastMove
      ? { fromR: state.lastMove.fromR, fromC: state.lastMove.fromC, toR: state.lastMove.toR, toC: state.lastMove.toC }
      : null,
    /** 我执哪一方。房主可以在准备界面选，加入方自动取另一边。 */
    mySide: mySide,
  };
}

/**
 * 反过来：把 view 还原成一个能直接喂给界面渲染函数的 GameState。
 *
 * 这一步是"界面只读 view"的落地方式：界面照旧用 GameState 对象渲染，
 * 但那个对象**只由 view 造出来**，手里绝不会有 view 之外的信息。
 * 别再偷偷传一个真的 gameState 进来 —— 那正是这条铁律要防的事。
 */
export function stateFromView(view) {
  const gs = new GameState(view.width, view.height);
  gs.board = view.board.map((row) => row.slice());
  gs.currentTurn = nameToSide(view.currentTurn) ?? CANNON;
  gs.gameOver = Boolean(view.gameOver);
  gs.winner = nameToSide(view.winner);
  gs.lastMove = view.lastMove ? { ...view.lastMove } : null;
  return gs;
}

/** 一方执哪一边 —— 房主选了大炮，另一个人就是小鬼。 */
export function otherSide(side) {
  return side === 'cannon' ? 'ghost' : 'cannon';
}