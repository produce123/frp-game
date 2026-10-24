// 人机难度。简单/普通仍旧是"只看 1 步 / 2 步"；困难不写死层数：
// 在时间预算内迭代加深，能算多深算多深（实测中局稳定 6 层，局面简单时到 8 层）。
//
// 搬迁说明：本文件原来是经典脚本（全局 AIPlayer），现在改成 ES Module 才能 import
// 引擎常量。为此只加了下面这行 import，**搜索与评估逻辑一个字没动**。
import { CANNON, GHOST, EMPTY } from '../engine/rules.js';

const AI_LEVELS = {
  easy:   { depth: 1, budgetMs: 150 },
  normal: { depth: 2, budgetMs: 400 },
  hard:   { depth: 8, budgetMs: 1500 }
};

// 兜底节点上限：极端局面下也不许无限呆住（时间检查每 1024 个节点做一次）。
const AI_NODE_BUDGET = 400000;

// ---------------------------------------------------------------------------
// 评估权重。**全部是"大炮方"视角：分越高对大炮越有利。**
// 只有一套符号，极大/极小完全由"轮到谁走"决定，不会出现两套方向互相打架。
// ---------------------------------------------------------------------------
const SCORE_WIN = 100000;      // 赢
const SCORE_GHOST = 90;        // 每个小鬼（大炮要吃到只剩自己这么多才算赢，这是主项）
const SCORE_CAPTURE = 60;      // 眼前就能吃到的小鬼
const SCORE_ADJACENT = 30;     // 贴在大炮身上的小鬼：既堵路，又永远不会被吃
const SCORE_NEAR = 3;          // 距离 2~5 的压迫感
const SCORE_EDGE = 15;         // 大炮冲着棋盘外的方向：边上角上更容易被围死
// 大炮的空邻居数 → 分值。空位越少越危险，所以是非线性的（0 个空位就是输了，
// 正常搜不到这种终局，只是给兜底局面一个极低分）。
// ⚠️ 这个惩罚**不要**调得比吃一个子（SCORE_GHOST）还大：位置项一旦压过吃子，
// 大炮就会为了躲而不敢吃子 —— 那正是旧评估函数翻车的方式。
const CANNON_MOBILITY = [-600, -80, 20, 55, 80];
const WIN_THRESHOLD = SCORE_WIN - 1000;   // 已经算出必赢/必败，不必再深挖

const AIPlayer = {
  makeMove(gameState, side, difficulty = 'normal') {
    return this.searchMove(gameState, side, AI_LEVELS[difficulty] || AI_LEVELS.normal);
  },

  /**
   * level 既可以是难度配置，也可以直接给层数（那就用困难档的时间预算）。
   * 迭代加深：1 层 → 2 层 → …，每层拿上一层的结论做走法排序；
   * 预算用完就退回"最后一层算完整的结果"，所以永远会有一手合法走法。
   */
  searchMove(gs, side, level) {
    const config = typeof level === 'number'
      ? { depth: level, budgetMs: AI_LEVELS.hard.budgetMs }
      : (level || AI_LEVELS.normal);

    this.nodes = 0;
    this.aborted = false;
    this.depthReached = 0;
    this.budgetMs = config.budgetMs;
    this.startedAt = Date.now();

    let best = null;
    for (let depth = 1; depth <= Math.max(1, config.depth | 0); depth++) {
      const result = this.searchRoot(gs, side, depth, best);

      if (result.aborted) {
        // 预算用完：有完整结果就用完整结果，一层都没算完时至少出一手（不然人机不动了）
        if (!best && result.move) best = result.move;
        break;
      }

      best = result.move || best;
      this.depthReached = depth;
      if (Math.abs(result.score) >= WIN_THRESHOLD) break;
    }

    return best;
  },

  /** 搜根节点这一层。previousBest 先搜，alpha-beta 才剪得动。 */
  searchRoot(gs, side, depth, previousBest) {
    const moves = this.orderMoves(gs, side, this.listMoves(gs, side));
    if (moves.length === 0) return { move: null, score: 0, aborted: false };
    if (previousBest) this.promoteFirst(moves, previousBest);

    const maximizing = side === CANNON;
    let bestScore = maximizing ? -Infinity : Infinity;
    let bestMove = moves[0];

    for (const move of moves) {
      const undo = this.applyMove(gs, move, side);
      const score = this.minimax(gs, depth - 1, -Infinity, Infinity, 1);
      this.undoMove(gs, move, side, undo);
      if (this.aborted) break;
      if (maximizing ? score > bestScore : score < bestScore) {
        bestScore = score;
        bestMove = move;
      }
    }

    return { move: bestMove, score: bestScore, aborted: this.aborted };
  },

  /**
   * alpha-beta 极小极大。评估函数是"大炮视角"的，所以轮到大炮就取极大、小鬼取极小。
   * ply 是从根往下的步数，只用来给"越早赢越好"打分。
   */
  minimax(gs, depth, alpha, beta, ply) {
    if (depth <= 0 || gs.gameOver) return this.evaluateBoard(gs, ply);

    if (++this.nodes > AI_NODE_BUDGET ||
        ((this.nodes & 1023) === 0 && Date.now() - this.startedAt > this.budgetMs)) {
      this.aborted = true;
      return this.evaluateBoard(gs, ply);
    }

    const side = gs.currentTurn;
    const maximizing = side === CANNON;
    // 最后一层不用排序：子节点全是叶子，排了也剪不到，纯浪费时间。
    const moves = depth >= 2
      ? this.orderMoves(gs, side, this.listMoves(gs, side))
      : this.listMoves(gs, side);
    if (moves.length === 0) return this.evaluateBoard(gs, ply);

    let best = maximizing ? -Infinity : Infinity;
    for (const move of moves) {
      const undo = this.applyMove(gs, move, side);
      const score = this.minimax(gs, depth - 1, alpha, beta, ply + 1);
      this.undoMove(gs, move, side, undo);

      if (maximizing) {
        if (score > best) best = score;
        if (best > alpha) alpha = best;
      } else {
        if (score < best) best = score;
        if (best < beta) beta = best;
      }
      if (beta <= alpha || this.aborted) break;
    }
    return best;
  },

  listMoves(gs, side) {
    const moves = [];
    for (const piece of gs.getAllPiecesForSide(side)) {
      for (const move of gs.getAllMoves(piece.r, piece.c)) {
        moves.push({ from: piece, to: move });
      }
    }
    return moves;
  },

  /**
   * 走法排序。剪枝效果几乎全看这个顺序，而顺序直接决定"同样时间里能搜多深"。
   *   大炮：先吃子，再挑空位多的落点（保住机动性）
   *   小鬼：先抢"贴着大炮"的落点（堵住这个方向，而且距离 1 的子大炮永远吃不到）
   */
  orderMoves(gs, side, moves) {
    const cannons = side === GHOST ? gs.getAllPiecesForSide(CANNON) : null;

    const scored = moves.map((move) => {
      let score = move.to.capture ? 1000 : 0;

      if (cannons) {
        for (const cannon of cannons) {
          const dist = Math.abs(move.to.r - cannon.r) + Math.abs(move.to.c - cannon.c);
          if (dist === 1) score += 40;            // 贴上去堵路，而且不会被吃
          else if (dist === 2) score -= 5;        // 隔一格就是吃子线，别站
          else score += Math.max(0, 6 - dist);
        }
      } else {
        let room = 0;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = move.to.r + dr;
          const nc = move.to.c + dc;
          if (gs.inBounds(nr, nc) && gs.board[nr][nc] === EMPTY) room++;
        }
        score += room * 8;
      }

      return { move, score };
    });

    return scored.sort((a, b) => b.score - a.score).map((entry) => entry.move);
  },

  promoteFirst(moves, move) {
    const index = moves.findIndex((m) =>
      m.from.r === move.from.r && m.from.c === move.from.c &&
      m.to.r === move.to.r && m.to.c === move.to.c);
    if (index > 0) moves.unshift(moves.splice(index, 1)[0]);
  },

  /**
   * 落子 / 撤销。搜索里每个节点都 clone 一份棋盘太贵（实测能差 2 倍以上速度），
   * 干脆原地改、递归完再原样改回来。
   * 顺序必须和 GameState.movePiece 一致：先按走子方的回合判胜负，再换手。
   */
  applyMove(gs, move, side) {
    const undo = {
      captured: gs.board[move.to.r][move.to.c],
      turn: gs.currentTurn,
      over: gs.gameOver,
      winner: gs.winner
    };

    gs.board[move.from.r][move.from.c] = EMPTY;
    gs.board[move.to.r][move.to.c] = side;
    gs.currentTurn = side;
    gs.checkWinCondition();
    if (!gs.gameOver) {
      gs.currentTurn = side === CANNON ? GHOST : CANNON;
    }

    return undo;
  },

  undoMove(gs, move, side, undo) {
    gs.board[move.to.r][move.to.c] = undo.captured;
    gs.board[move.from.r][move.from.c] = side;
    gs.currentTurn = undo.turn;
    gs.gameOver = undo.over;
    gs.winner = undo.winner;
  },

  /**
   * 从**大炮视角**给局面打分，只算"能立刻兑现的东西"。
   *
   * ⚠️ 这里踩过一个大坑：以前对每个小鬼累加"离大炮多远"（`minDist * 3`），
   * 24 个小鬼就是几百分的大项，比吃一个子（30 分）重得多，
   * 结果困难电脑在有子可吃时反而**不吃**——因为跳过去吃子会让它离小鬼群更近，
   * 总分反而掉了。所以现在：小鬼数量是压倒性的主项，位置项一律小而局部。
   */
  evaluateBoard(gs, ply = 0) {
    const cannons = gs.getAllPiecesForSide(CANNON);
    const ghosts = gs.getAllPiecesForSide(GHOST);

    if (gs.gameOver) {
      // 同样是赢，越早赢越好；同样是输，越晚输越好。
      const value = SCORE_WIN - ply;
      return gs.winner === CANNON ? value : -value;
    }

    // 主项：小鬼数量。大炮要吃到只剩自己这么多才算赢，每个子都必须很值钱。
    let score = (cannons.length - ghosts.length) * SCORE_GHOST;

    const cannonToMove = gs.currentTurn === CANNON;
    for (const cannon of cannons) {
      const room = gs.getNormalMoves(cannon.r, cannon.c).length;
      score += CANNON_MOBILITY[Math.min(room, CANNON_MOBILITY.length - 1)];
      // 轮到大炮走，眼前的吃子基本吃到手了；轮到小鬼走，它多半会先跑掉。
      score += gs.getCaptureMoves(cannon.r, cannon.c).length * SCORE_CAPTURE * (cannonToMove ? 1 : 0.4);
      if (cannon.r === 0 || cannon.r === gs.height - 1) score -= SCORE_EDGE;
      if (cannon.c === 0 || cannon.c === gs.width - 1) score -= SCORE_EDGE;
    }

    for (const ghost of ghosts) {
      let minDist = Infinity;
      let adjacent = 0;
      for (const cannon of cannons) {
        const dist = Math.abs(ghost.r - cannon.r) + Math.abs(ghost.c - cannon.c);
        if (dist < minDist) minDist = dist;
        if (dist === 1) adjacent++;
      }
      score -= adjacent * SCORE_ADJACENT;
      if (minDist > 1) score -= Math.max(0, 5 - minDist) * SCORE_NEAR;
    }

    return score;
  }
};

/* ---- ESM 导出 -------------------------------------------------------------
 * 和 rules.js 一样：只在末尾加导出，搜索与评估逻辑**一行没改**。
 * 源项目 AGENTS.md 里"位置项不能压过吃子"的两条回归用例仍然守着它。
 */
export { AIPlayer, AI_LEVELS };