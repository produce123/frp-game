const PRESET_MAPS = [
  {
    name: '经典对战',
    desc: '6×6 · 2炮18鬼',
    width: 6,
    height: 6,
    cannons: [[5, 2], [5, 3]],
    ghosts: (function() {
      const g = [];
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 6; c++)
          g.push([r, c]);
      return g;
    })()
  },
  {
    name: '广阔天地',
    desc: '8×8 · 3炮24鬼',
    width: 8,
    height: 8,
    cannons: [[7, 3], [7, 4], [6, 3]],
    ghosts: (function() {
      const g = [];
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 8; c++)
          g.push([r, c]);
      return g;
    })()
  },
  {
    name: '狭路相逢',
    desc: '10×5 · 2炮16鬼',
    width: 10,
    height: 5,
    cannons: [[4, 4], [4, 5]],
    ghosts: (function() {
      const g = [];
      for (let r = 0; r < 2; r++)
        for (let c = 1; c < 9; c++)
          g.push([r, c]);
      return g;
    })()
  }
];

const EMPTY = 0;
const CANNON = 1;
const GHOST = 2;

class GameState {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.board = [];
    this.currentTurn = CANNON;
    this.selectedPiece = null;
    this.validMoves = [];
    this.gameOver = false;
    this.winner = null;
    this.lastMove = null;

    for (let r = 0; r < height; r++) {
      this.board[r] = [];
      for (let c = 0; c < width; c++) {
        this.board[r][c] = EMPTY;
      }
    }
  }

  placeCannon(r, c) {
    if (this.inBounds(r, c)) this.board[r][c] = CANNON;
  }

  placeGhost(r, c) {
    if (this.inBounds(r, c)) this.board[r][c] = GHOST;
  }

  inBounds(r, c) {
    return r >= 0 && r < this.height && c >= 0 && c < this.width;
  }

  getPiece(r, c) {
    if (!this.inBounds(r, c)) return -1;
    return this.board[r][c];
  }

  countCannons() {
    let count = 0;
    for (let r = 0; r < this.height; r++)
      for (let c = 0; c < this.width; c++)
        if (this.board[r][c] === CANNON) count++;
    return count;
  }

  countGhosts() {
    let count = 0;
    for (let r = 0; r < this.height; r++)
      for (let c = 0; c < this.width; c++)
        if (this.board[r][c] === GHOST) count++;
    return count;
  }

  getNormalMoves(r, c) {
    const piece = this.getPiece(r, c);
    if (piece === EMPTY) return [];
    const moves = [];
    const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (this.inBounds(nr, nc) && this.board[nr][nc] === EMPTY) {
        moves.push({ r: nr, c: nc, capture: false });
      }
    }
    return moves;
  }

  getCaptureMoves(r, c) {
    const piece = this.getPiece(r, c);
    if (piece !== CANNON) return [];
    const captures = [];
    const dirs = [[-1,0],[1,0],[0,-1],[0,1]];

    for (const [dr, dc] of dirs) {
      const midR = r + dr;
      const midC = c + dc;
      const targetR = r + 2 * dr;
      const targetC = c + 2 * dc;

      if (this.inBounds(targetR, targetC) &&
          this.inBounds(midR, midC) &&
          this.board[midR][midC] === EMPTY &&
          this.board[targetR][targetC] === GHOST) {
        captures.push({ r: targetR, c: targetC, capture: true });
      }
    }
    return captures;
  }

  getAllMoves(r, c) {
    const piece = this.getPiece(r, c);
    if (piece === EMPTY) return [];

    if (piece === CANNON) {
      const normal = this.getNormalMoves(r, c);
      const captures = this.getCaptureMoves(r, c);
      return [...normal, ...captures];
    }

    return this.getNormalMoves(r, c);
  }

  selectPiece(r, c) {
    const piece = this.getPiece(r, c);
    if (piece === EMPTY) return false;
    if (piece !== this.currentTurn) return false;

    const moves = this.getAllMoves(r, c);
    if (moves.length === 0) return false;

    this.selectedPiece = { r, c };
    this.validMoves = moves;
    return true;
  }

  deselectPiece() {
    this.selectedPiece = null;
    this.validMoves = [];
  }

  movePiece(toR, toC) {
    if (!this.selectedPiece) return false;

    const move = this.validMoves.find(m => m.r === toR && m.c === toC);
    if (!move) return false;

    const fromR = this.selectedPiece.r;
    const fromC = this.selectedPiece.c;
    const piece = this.board[fromR][fromC];

    this.board[fromR][fromC] = EMPTY;
    this.board[toR][toC] = piece;

    this.lastMove = { fromR, fromC, toR, toC };
    this.selectedPiece = null;
    this.validMoves = [];

    const captured = move.capture;

    this.checkWinCondition();

    if (!this.gameOver) {
      this.currentTurn = this.currentTurn === CANNON ? GHOST : CANNON;
    }

    return { captured, piece };
  }

  checkWinCondition() {
    const ghostCount = this.countGhosts();
    const cannonCount = this.countCannons();

    if (ghostCount <= cannonCount) {
      this.gameOver = true;
      this.winner = CANNON;
      return;
    }

    if (cannonCount === 0) {
      this.gameOver = true;
      this.winner = GHOST;
      return;
    }

    const nextTurn = this.currentTurn === CANNON ? GHOST : CANNON;
    if (nextTurn === CANNON) {
      if (this.isSideBlocked(CANNON)) {
        this.gameOver = true;
        this.winner = GHOST;
      }
    }
  }

  isSideBlocked(side) {
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        if (this.board[r][c] === side) {
          if (this.getAllMoves(r, c).length > 0) return false;
        }
      }
    }
    return true;
  }

  clone() {
    const gs = new GameState(this.width, this.height);
    gs.board = this.board.map(row => [...row]);
    gs.currentTurn = this.currentTurn;
    gs.gameOver = this.gameOver;
    gs.winner = this.winner;
    return gs;
  }

  getAllPiecesForSide(side) {
    const pieces = [];
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        if (this.board[r][c] === side) {
          pieces.push({ r, c });
        }
      }
    }
    return pieces;
  }
}

/* ---- ESM 导出 -------------------------------------------------------------
 * 只在文件末尾加导出，**上面那些规则代码一行都没动** —— 规则是这个游戏最容易
 * 出错的地方，搬迁时一个字都不该碰（源项目 AGENTS.md 里那些回归用例就是为它写的）。
 *
 * 导出是为了让同一份文件被两个地方 import：
 *   · 服务器进程（server/games/cannon-goblin.mjs）—— 服务端权威裁决
 *   · 浏览器（js/bridge.js 再把它挂回全局名字上）—— 人机对局在本地跑
 * 同一份文件，所以"单机规则"和"联机规则"不可能对不上。
 * 见 docs/GAME-SPEC.md 铁律一。
 *
 * ⚠️ 本文件（以及 js/ai/**）里**一个字都不许出现浏览器宿主 API 的名字**，
 * 连注释里都不许 —— 那两个目录里那条 grep 的命中数必须是 0，
 * 写了就等于给"服务器 import 时会炸"埋雷（见本游戏 AGENTS.md 与体检脚本）。
 * 所以上面那句说的是"挂回全局名字"，不点名那两个词。
 */
export { PRESET_MAPS, EMPTY, CANNON, GHOST, GameState };
