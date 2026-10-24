/*
 * 大炮轰小鬼 —— 服务端接入层。
 *
 * 【它只做三件事】
 *   1. 把玩家的 id 映射到阵营（大炮 / 小鬼）
 *   2. 按房主选的设置摆出初始局面
 *   3. 把客户端发来的意图转成引擎调用，把引擎状态裁剪成每个人的 view
 *
 * 规则本身**一行都不在这里** —— 全在 games/cannon-goblin/js/engine/rules.js，
 * 那份文件同时被浏览器 import（人机对局本地跑）。同一份代码，所以单机和联机的
 * 规则不可能对不上。见 docs/ARCHITECTURE.md。
 *
 * 【人机座位（docs/ARCHITECTURE.md 的「游戏模块接口」「AI 补位」）】
 * 本作是**固定 2 人、双方不对称**：房里只有 1 个真人时，另一个座位由人机顶上。
 *   · 人机**现在是房间的座位**：房主在准备区按一下「＋ 添加人机」就多一个座位，
 *     开局时房间层把它和真人一起塞进 `players`，每项形如
 *     `{ id, name, isHost, isBot }`，人机的 id 是 `bot:1`（平台发的 7 位 id 里没有冒号，
 *     永远撞不上），名字是**单字**（平台默认池：虎狼鹰豹…）。
 *   · 所以本文件**不再读 `options.aiFill`**（那条契约已作废，整段删掉了）：
 *     座位是不是电脑，只看 `players[].isBot`。
 *   · `meta.minPlayers = 1` 是**真人**下限（房间层只数真人）；
 *     `meta.minSeats = 2` 是**总座位**下限（含人机）—— 引擎就是 2 人棋，
 *     1 个真人 + 0 个人机建不了局。两个数不是一回事，别合并。
 *   · ⚠️ 人机由服务端**同步**驱动，不许用定时器 —— 见下面 runAi() 那段注释。
 *
 * 接口约定见 docs/ARCHITECTURE.md「游戏模块接口」。
 */

import { GameState, PRESET_MAPS, CANNON, GHOST } from '../../games/cannon-goblin/js/engine/rules.js';
import { AIPlayer } from '../../games/cannon-goblin/js/ai/ai.js';
import { viewFor, sideToName, nameToSide, otherSide } from '../../games/cannon-goblin/js/view.js';

export const meta = {
  slug: 'cannon-goblin',
  title: '大炮轰小鬼',
  icon: '💥',
  /**
   * minPlayers = 1：**真人**下限。一个人点「创建房间」也能开一局 ——
   * 空出来的那个座位由房主按「＋ 添加人机」补上（房间层看得见人机座位，
   * 因为它现在就是房间的一个座位，见 docs/ARCHITECTURE.md 的「游戏模块接口」）。
   */
  minPlayers: 1,
  /**
   * minSeats = 2：**总座位**下限（真人 + 人机）。
   * 引擎是 2 人不对称棋，1 个座位建不了局 —— 所以
   * 1 个真人 + 0 个人机时房间层的「开始游戏」是灰的，服务端也会拒。
   * 旧体检脚本就是这么拿 `minSeats` 个座位调 createMatch 的。
   */
  minSeats: 2,
  maxPlayers: 2,
  /**
   * 开局之后不许进人。本作双方阵营开局就定死了（谁执炮、谁执鬼），
   * 中途加座会打乱它，规则上做不到公平。所以 `addPlayer` 永远是 false，
   * 房间层会回一句"这局已经开始，进不去了"。
   */
  allowMidJoin: false,
};

/** 自定义地图的尺寸上限。**必须校验**：这张盘是客户端传上来的。 */
const MIN_SIZE = 3;
const MAX_SIZE = 16;

/**
 * 联机人机用的难度 —— **必须是便宜的那一档**。
 *
 * `js/ai/ai.js` 的 AI_LEVELS：easy = depth 1 / 150ms，normal = 2 / 400ms，
 * hard = depth 8 / 1500ms。hard 那一档会在**主线程**阻塞约 1.5 秒（迭代加深直到
 * 预算用完），联机时那就是"整间房卡住 1.5 秒"。所以联机座位固定用 easy：
 *   · 一手实测几毫秒（时限 150ms 是它的上限，不是常态）
 *   · 单机人机对局不受影响 —— 那边难度由玩家在游戏页自己选，跑在浏览器里
 *
 * 想让房主自己选难度是"可以的"（见 docs/ARCHITECTURE.md 的「游戏模块接口」 硬规矩四），
 * 但那要多一套控件 + 一套校验，而联机人机的定位是"凑个人陪你下完这一局"。
 * 这里刻意从简：**不给难度选项**。
 */
const AI_FILL_DIFFICULTY = 'easy';

/**
 * 一次 act() 里最多替人机走多少步。本作回合**严格交替**（走一步必换人），
 * 所以这个循环实际永远是 1 步就退出 —— 它是防御性上限，只在引擎坏掉时才会碰到。
 */
const AI_STEP_BUDGET = 4000;

/**
 * 校验房主用地图编辑器摆出来的自定义棋盘。
 * @returns {{ok: true, board: number[][]} | {ok: false, message: string}}
 */
function validateCustom(custom) {
  if (!custom || typeof custom !== 'object') return { ok: false, message: '自定义地图格式不对' };

  const w = custom.width;
  const h = custom.height;
  if (!Number.isInteger(w) || !Number.isInteger(h)) return { ok: false, message: '自定义地图尺寸不对' };
  if (w < MIN_SIZE || h < MIN_SIZE || w > MAX_SIZE || h > MAX_SIZE) {
    return { ok: false, message: `自定义地图尺寸要在 ${MIN_SIZE}~${MAX_SIZE} 之间` };
  }
  if (!Array.isArray(custom.board) || custom.board.length !== h) {
    return { ok: false, message: '自定义地图的行数和高度对不上' };
  }

  let cannons = 0;
  let ghosts = 0;
  const board = [];
  for (let r = 0; r < h; r++) {
    const row = custom.board[r];
    if (!Array.isArray(row) || row.length !== w) return { ok: false, message: '自定义地图的列数和宽度对不上' };
    const copy = [];
    for (let c = 0; c < w; c++) {
      const v = row[c];
      if (v !== CANNON && v !== GHOST) { copy.push(0); continue; }
      if (v === CANNON) cannons++; else ghosts++;
      copy.push(v);
    }
    board.push(copy);
  }

  // 没有大炮就没法赢、没有小鬼就没法堵 —— 这种盘开局即死局，直接拒
  if (cannons === 0) return { ok: false, message: '自定义地图里至少要有一个大炮' };
  if (ghosts === 0) return { ok: false, message: '自定义地图里至少要有一个小鬼' };
  // 小鬼数量一开始就少于等于大炮 = 开局直接判定大炮赢，也是死局
  if (ghosts <= cannons) return { ok: false, message: '小鬼数量必须多于大炮，否则开局就结束了' };

  return { ok: true, board };
}

/** 按房主的设置摆初始局面。 */
function createState(options) {
  if (options.custom) {
    const check = validateCustom(options.custom);
    if (!check.ok) throw new Error(check.message);
    const state = new GameState(options.custom.width, options.custom.height);
    state.board = check.board;
    return state;
  }

  const index = Number.isInteger(options.preset) && PRESET_MAPS[options.preset] ? options.preset : 0;
  const preset = PRESET_MAPS[index];
  const state = new GameState(preset.width, preset.height);
  for (const [r, c] of preset.cannons) state.placeCannon(r, c);
  for (const [r, c] of preset.ghosts) state.placeGhost(r, c);
  return state;
}

/**
 * @param {{id: string, name: string, isHost?: boolean, isBot?: boolean}[]} players
 *        座位：**真人 + 人机都在里面**（房间层把它们拼好才递进来，顺序 = 真人先进、
 *        人机在后）。`isBot === true` 的就是电脑座位。
 * @param {object} options 房主在准备界面选的：{ hostSide, preset, custom? }
 */
export function createMatch(players, options = {}) {
  if (!Array.isArray(players) || players.length < 1) throw new Error('这一局一个人都没有');
  if (players.length > meta.maxPlayers) {
    throw new Error(`大炮轰小鬼是 ${meta.maxPlayers} 人对局（现在 ${players.length} 个人）`);
  }

  // 座位是客户端（房间层）递进来的，仍然当成不可信输入：没有合法 id 的条目直接丢掉
  const given = players.filter((p) => p && typeof p.id === 'string' && p.id);
  const humans = given.filter((p) => p.isBot !== true);

  // 一个人机都没有的"全是电脑"对局没有意义（房间层也不会让它发生：minPlayers = 1）
  if (humans.length === 0) throw new Error('这一局至少要有一个真人');

  // 谁是房主由房间层显式给（房主中途离开会把身份移交，不能靠"第一个人"来猜）
  const host = humans.find((p) => p.isHost) || humans[0];
  const hostSide = options.hostSide === 'ghost' ? 'ghost' : 'cannon';

  /* ------------------------------ 座位 ------------------------------ */

  // 房主执 hostSide，其余座位（另一个真人 / 人机）自动执另一方。
  // 本作 maxPlayers = 2，所以"其余"最多一个 —— 别写成能发 3 个座位的循环。
  const seats = [{ id: host.id, name: host.name, side: hostSide, isAi: false }];
  for (const p of given) {
    if (p.id === host.id) continue;
    seats.push({ id: p.id, name: p.name, side: otherSide(hostSide), isAi: p.isBot === true });
  }

  /*
   * 座位不够时**抛中文**，让房间层原样转成提示条给房主看。
   *
   * 正常情况下走不到这里：种子的「开始游戏」在座位数 < meta.minSeats 时是灰的
   * （`shared/ui/room.js` 按服务端给的 minSeats 画）。留着它是第二道防线 ——
   * 房间层将来改了按钮逻辑、或者有别的调用方直接调 createMatch，都不该得到一个
   * "1 个座位的 2 人棋"。
   */
  if (seats.length < meta.minSeats) {
    throw new Error(
      `座位不够：大炮轰小鬼要 ${meta.minSeats} 个座位（现在 ${seats.length} 个）。` +
      '按「＋ 添加人机」补一个，或者等第二个真人进来'
    );
  }

  /** playerId -> 'cannon' | 'ghost'（**含人机座位**；人机的 id 不出现在任何报文里）。 */
  const sideOf = new Map(seats.map((s) => [s.id, s.side]));
  const aiSeat = seats.find((s) => s.isAi) || null;

  const state = createState(options);

  /* ------------------------------ 人机的行动 ------------------------------ */

  /** 现在轮到人机了没有。 */
  function aiTurn() {
    return aiSeat !== null && !state.gameOver && sideToName(state.currentTurn) === aiSeat.side;
  }

  /**
   * 把人机这一手当场算完并应用，一直推进到"该真人了"或分出胜负为止。
   *
   * ⚠️ **不许改成 setInterval / setTimeout**（docs/ARCHITECTURE.md 的「游戏模块接口」 硬规矩一）：
   *   · rooms.mjs 没有心跳、没有任何"稍后再推一次状态"的机制 —— 浏览器一关就没人催；
   *   · 定时器会让两个客户端看到的进度不一样；
   *   · 最要命的是"返回时回合还在人机身上"：那一刻 broadcastState 早就把
   *     "轮到对手"的视图推出去了，之后**再也不会推第二次**，
   *     真人屏幕上就永远停在"等待对手行动"，而且谁都不报错。
   *
   * 客户端看到的后果是"真人的一手 + 人机的一手在同一条报文里到达"。
   * 那是**刻意**的取舍：界面用 /shared/ui/anim.js 的演出队列把这几步
   * **一步一步演完**（见 js/ui/app.js 的 queueSteps），而不是"一次成型"。
   *
   * 因为本作走一步必换人，这个循环实际最多跑 1 步；guard 只是兜底。
   */
  function runAi() {
    let guard = 0;
    while (aiTurn() && guard++ < AI_STEP_BUDGET) {
      const move = AIPlayer.makeMove(state, nameToSide(aiSeat.side), AI_FILL_DIFFICULTY);
      // 无路可走时引擎已经在 checkWinCondition 里判过胜负了，这里只是兜底别卡死
      if (!move) break;
      if (!state.selectPiece(move.from.r, move.from.c)) break;
      if (!state.movePiece(move.to.r, move.to.c)) { state.deselectPiece(); break; }
    }
  }

  runAi();   // 房主选了执小鬼方时，开局第一个回合就落在人机身上

  return {
    /**
     * 按人裁剪。大炮轰小鬼是信息公开的棋类，所以大家的 view 内容一样（只有 mySide 不同）——
     * 这不是漏裁剪，是它本来就没有秘密（见 js/view.js 顶部的说明）。
     * 人机座位拿到的也是同一份公开视图，而且它的 id 根本不会出现在任何报文里。
     * 但**接口必须保留**：界面只吃 view，以后真加了隐藏信息才不用改架构。
     */
    viewFor(playerId) {
      const side = sideOf.get(playerId);
      if (!side) return null;
      return viewFor(state, side);
    },

    /**
     * 一个操作意图。act = { kind:'move', from:{r,c}, to:{r,c} }
     * 返回的中文原因会直接显示给玩家，所以别写错误码。
     */
    act(playerId, action) {
      const mySide = sideOf.get(playerId);
      if (!mySide) return { ok: false, message: '你不在这一局里' };
      if (state.gameOver) return { ok: false, message: '这一局已经结束了' };

      // 回合校验放在最前面：不校验的话客户端可以把对手的子也走掉
      if (sideToName(state.currentTurn) !== mySide) return { ok: false, message: '还没轮到你' };

      const act = action || {};
      if (act.kind !== 'move') return { ok: false, message: '不认识的操作' };

      const from = act.from;
      const to = act.to;
      if (!isCell(from) || !isCell(to)) return { ok: false, message: '走法格式不对' };

      // selectPiece 自己会校验"这个格子是不是当前回合方的子、它有没有路可走"
      if (!state.selectPiece(from.r, from.c)) return { ok: false, message: '这个子不能动' };

      const moved = state.movePiece(to.r, to.c);
      if (!moved) {
        // 失败时把选中状态清掉，别留在引擎里污染下一次校验
        state.deselectPiece();
        return { ok: false, message: '不能走到那里' };
      }

      // 真人这一步走完 → 轮到人机就**当场**把它跑完。
      // 所以这个 act 返回时，回合一定又回到真人手上（或者已经分出胜负）。
      if (!state.gameOver) runAi();
      return { ok: true };
    },

    addPlayer() {
      return false;   // meta.allowMidJoin = false，中途进不来
    },

    /**
     * 有人离开：对手直接判胜，否则留下的人会因为"轮不到自己"而卡死。
     *
     * 【人机在场时这条照旧】
     * 一个人 + 人机的房间里，真人走了就是"对手（人机那一方）获胜" —— 语义和
     * 两个真人时完全一致（离开的是小鬼方，大炮方获胜），不搞第二套规则。
     * 这个判决其实没人看得到：他一个人走了，房间成员清零，房间层会直接把房间解散。
     * 人机座位也**不接管** —— 本作是 2 人不对称对局，"电脑替你把这局打完"没有意义
     * （打赢打输都不是你的），直接判胜更简单也更符合"对手走了"的直觉。
     *
     * ⚠️ 人机座位不走这条路：它不是房间成员，房间层从来不会为它调 removePlayer。
     */
    removePlayer(playerId) {
      if (state.gameOver) return;
      const gone = sideOf.get(playerId);
      if (!gone) return;
      state.gameOver = true;
      state.winner = nameToSide(otherSide(gone));
    },

    isOver() {
      return Boolean(state.gameOver);
    },

    result() {
      return {
        winner: sideToName(state.winner),
        ghosts: count(state, GHOST),
        cannons: count(state, CANNON),
      };
    },

    /** 调试/测试用：人机座位的 id（不进 view，界面上不需要知道谁是电脑）。 */
    _aiIds() { return seats.filter((s) => s.isAi).map((s) => s.id); },
  };
}

function isCell(cell) {
  return Boolean(cell) && Number.isInteger(cell.r) && Number.isInteger(cell.c);
}

function count(state, piece) {
  let n = 0;
  for (let r = 0; r < state.height; r++) {
    for (let c = 0; c < state.width; c++) if (state.board[r][c] === piece) n++;
  }
  return n;
}