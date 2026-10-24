/*
 * Shell Gambit 的服务端接入层 —— 平台只通过这个文件认识这个游戏。
 *
 * 导出两个东西（docs/ARCHITECTURE.md 的「游戏模块接口」，一个字都不能改接口）：
 *   meta        slug / title / icon / minPlayers / minSeats / maxPlayers / allowMidJoin / botNames
 *   createMatch players + options -> match{ viewFor / act / addPlayer / removePlayer / isOver / result }
 *
 * 【它 import 的是游戏自己的引擎，不是副本】
 *   ../../games/shell-gambit/js/engine/engine.js
 * 同一份文件浏览器也在用（单机人机对局），所以规则不可能分叉。
 * 这也是为什么那两个目录不许出现 document / window（平台铁律一）。
 *
 * 【服务端的 AI 是同步跑完的，不要改成 setInterval】
 * 原项目里 AI 是 setTimeout 一步一步"演"给真人看的（见 js/game/match.js）。
 * 服务器上不能这么干：真实客户端在等这一条 room.state，而 rooms.mjs 不会替游戏
 * 保留"还在思考"的状态，也没有任何机制在若干秒后再推一次。
 * 一旦这里返回时回合还在 AI 身上，客户端就会永远停在"等待对手行动"。
 * 所以：act() 返回之前，把 AI 的动作**全部**跑完，跑不动（轮到真人或分出胜负）为止。
 * 代价是 AI 的动作在客户端是一起到达的 —— 这正是 `shared/ui/anim.js`
 * （逐条演出队列）存在的理由：客户端把这一串事件按时间轴一步一步演完。
 *
 * 【人机是"房间的座位"，不再由本文件自己造 —— options.aiFill 已作废】
 *
 * 这一版之前：`players` 里**只有真人**，本文件按 `options.aiFill`（房主在准备界面
 * 选的"补几个电脑"）在 `maxPlayers` 以内自己造「电脑1」「电脑2」… 顶上空的座位。
 *
 * 现在：人机**坐在房间的座位上**，由房主在准备区按「＋ 添加人机」一个一个加
 * （`server/rooms.mjs` 的 `botAdd`，id 形如 `bot:1`、名字是单字）。开局时房间层把
 * 真人与人机**一起**放进 `players`，每项形如 `{ id, name, isHost, isBot }`。
 * 本文件只做一件事：把 `isBot === true` 的座位映射成 AI 座位。
 *
 * **为什么改**（不是"换个写法"，是修掉了几个真实的不一致）：
 *   · 旧口径下"房主选了 3 个电脑、后来又进来 2 个真人"要在这里截断 AI，
 *     界面上表现为可补范围从 0..3 收缩到 0..2 —— 玩家看到的是"我选的数变了"。
 *     现在座位就是座位，加了几个人机就是几个，没有"截断"这个概念。
 *   · 旧口径下 `aiFill` 是**客户端输入**，于是不得不写一套 clampInt 收口
 *     （垃圾值当"没选"、明确 0 又要在一个人时拒绝开局）。现在服务端收到的
 *     `players` 由房间层生成，客户端根本碰不到座位表 —— 那一整段校验连同它的
 *     三种特例（缺省兜底补 1 个 / 明确 0 拒绝 / 垃圾值收口）**整段作废**。
 *   · 旧口径下"人机不是房间成员"，成员列表里看不到它，玩家得先记住自己选了几个。
 *     现在人机有头像、有「人机」标签、还能被扔鸡蛋（房间层负责画）。
 *   · 旧口径下体检脚本拿 `meta.minPlayers`（=1）个座位调进来，
 *     靠这里的"缺省兜底补 1 个"才不炸。现在平台用例拿 `meta.minSeats`（=2）个座位调进来，
 *     **这里必须能老老实实建出一局 2 个座位的局**，不靠任何兜底。
 *
 * ⚠️ 别再把这些特例加回来：只要 `players` 是房间层给的座位表，
 *    任何"按 client options 增减座位"的写法都会让界面人数和服务端座位对不上。
 *
 * 四条容易改坏的地方，都写在下面代码边上：
 *   1. 座位数超范围**就 throw**（房间层的防御性第二道闸，见下面 createMatch）。
 *   2. AI 由 runAi() 在 createMatch / act 里**同步**跑完，绝不留"轮到 AI"的状态返回。
 *   3. 真人掉线 → 座位由 AI 接管（removePlayer），不是判死。
 *   4. AI 的隐藏信息（手牌、放大镜情报）和真人一样受 viewFor 裁剪；
 *      座位条目字段**恰好**是 js/view.js 的 PUBLIC_PLAYER_FIELDS。
 */

import {
  applyAction,
  createGame,
  legalActions,
} from '../../games/shell-gambit/js/engine/engine.js';
import { AI_NAME_POOL, aiDecide, createAiMemory } from '../../games/shell-gambit/js/ai/ai.js';
import { viewFor } from '../../games/shell-gambit/js/view.js';

/** 服务器上接的 slug 必须**恰好**等于文件名 shell-gambit.mjs，否则 index.mjs 拒绝加载。 */
export const meta = {
  slug: 'shell-gambit',
  title: 'Shell Gambit',
  icon: '💀',
  /*
   * minPlayers = 1：房间层（server/rooms.mjs）数的是**真人座位**，
   * 所以这个数就是"至少要几个真人"。
   *
   * 一个人建房当然能开局：空的座位由房主按「＋ 添加人机」补上，
   * 人机也是座位，只是不算真人。
   *
   * ⚠️ 别再写回 2：房间层只拿它数真人（`room.members.size < minPlayers` 才拒绝），
   *    写 2 的后果是"一个真人 + 一个人机"这种正常玩法被房间层挡回去。
   */
  minPlayers: 1,
  /*
   * minSeats = 2：**总座位**的下限（含人机），也就是引擎的座位下限
   * （engine.createGame 要 2–4 个座位）。
   *
   * 平台用它的地方只有两处，两处都必须写 2：
   *   · 房间准备区：「开始游戏」的禁用条件与"至少要 N 个座位"那句提示
   *     （shared/ui/room.js 的 `seats < minSeats`）；
   *   · 平台用例：拿 `meta.minSeats` 个座位调 createMatch。
   *     缺省才退回 minPlayers —— 只给 1 个座位的话引擎会抛"需要 2–4 名玩家"，
   *     而那不是游戏的错，是用例少给了座位。
   *
   * ⚠️ 它和 minPlayers 不是一个数：minPlayers 是**真人**下限（1），
   *    这里是**总座位**下限（2）。写混了就会出现"一个人 + 人机也开不了局"。
   */
  minSeats: 2,
  maxPlayers: 4,
  /** 开局之后不许进人：中途加入会打乱座位与已经发出去的牌，规则上做不到公平。 */
  allowMidJoin: false,
  /*
   * 人机座位的名字池。**直接复用单机那套单字池**（js/ai/ai.js 的 AI_NAME_POOL），
   * 不抄字面量：房间层（server/rooms.mjs 的 pickBotName）挑名字时优先避开房里
   * 已经有人用的字，所以单机里叫「虎」的电脑，联机里的人机座位也会叫「虎」——
   * 玩家在两个入口看到的是同一批脸。
   *
   * ⚠️ 必须是**单字**：平台的显示名就是一个码点，头像圆里放不下「电脑1」。
   *    （旧口径那套「电脑1」「电脑2」的写法已经作废，见文件头。）
   */
  botNames: AI_NAME_POOL,
  /*
   * 没有 `setup` 字段：本作在准备区**没有自己的设置项**。
   * 原来那个"补几个电脑"的控件已经删掉 —— 人机现在是房间的座位，
   * 由平台外壳统一画「＋ 添加人机 / 移除」。见 docs/ARCHITECTURE.md 的「在线界面的两条 DOM 契约」。
   */
};

/** 一局最多走多少步（含 AI）。防御性上限，只在引擎彻底坏掉时才会碰到。 */
const MAX_AI_STEPS = 20_000;

/** 停牌：避免 AI 在极端情况下把服务端主线程占住。 */
const AI_STEP_BUDGET = 4_000;

/** 座位上限，等于 meta.maxPlayers。 */
const MAX_SEATS = 4;

/** 座位下限，等于 meta.minSeats（引擎的座位下限）。 */
const MIN_SEATS = 2;

export function createMatch(players, options = {}) {
  /*
   * players 由 `server/rooms.mjs` 的 start() 组装：先全部真人，再全部人机座位，
   * 每项 `{ id, name, isHost, isBot }`。人机的 id 形如 `bot:1`（玩家 ID 的字母表里
   * 没有冒号，撞不上），名字是单字。
   *
   * ⚠️ 这里是**防御性第二道闸**：房间层保证 players.length 落在
   *    [minSeats, maxPlayers] 之间，超范围就 throw（rooms.start 会 catch 它，
   *    包成"开局失败：…"提示条推给房主，不是静默失败）。
   *    留着它的意义是：哪天有人从别处（测试、脚本、将来的观战入口）调进来，
   *    引擎抛的是"需要 2–4 名玩家"这种看不懂的话，而这里抛的能直接读。
   */
  if (!Array.isArray(players) || players.length < MIN_SEATS) {
    throw new Error(`至少要 ${MIN_SEATS} 个座位才能开局（人机也算座位）`);
  }
  if (players.length > MAX_SEATS) {
    throw new Error(`最多 ${MAX_SEATS} 个座位（现在 ${players.length} 个）`);
  }

  /*
   * options 是客户端传上来的（房间层合并后原样交给这里），一律当不可信输入。
   * ⚠️ 本作**现在没有任何自己的设置项**：座位表是房间层给的，`aiFill` 已作废。
   *    所以这里不读 options 的任何字段 —— 但仍然要吞掉垃圾值（`null` / 字符串 /
   *    数字都被 rooms.mjs 原样传得进来），不许因为参数长得怪就把服务端弄崩。
   *    将来真要加设置项（比如"选哪套牌"），在这里校验，别信客户端。
   */
  void options;

  /* ------------------------------ 座位 ------------------------------ */

  /*
   * 座位表：真人是真人，`isBot === true` 的是 AI 座位。
   * `isAi` 这个名字是**引擎内部**的（engine.createGame 的 `isAi` 字段）；
   * 视图里那个公开的身份标记叫 `isAI`，由 js/view.js 加上去。
   */
  const seats = players.map((p) => ({
    id: String(p.id),
    name: String(p.name),
    isAi: p.isBot === true,
  }));

  const state = createGame({ players: seats.map((s) => ({ id: s.id, name: s.name, isAi: s.isAi })) });

  const isAi = new Map(seats.map((s) => [s.id, s.isAi]));
  const memories = new Map(seats.map((s) => [s.id, createAiMemory()]));
  let over = false;
  let steps = 0;

  /* ------------------------------ AI 推进 ------------------------------ */

  /**
   * 跑到"轮到真人"或"分出胜负"为止。
   * AI 的入口是 aiDecide(state, id, memory) —— 引擎自己保证它只读公开字段和自己的私有牌，
   * 所以服务端 AI 和浏览器本地 AI 看到的信息一样多（README 里对这一条有专门说明）。
   */
  function runAi() {
    let guard = 0;
    while (!over && isAi.get(state.turn) && guard++ < AI_STEP_BUDGET && steps++ < MAX_AI_STEPS) {
      const pid = state.turn;
      const decision = aiDecide(state, pid, memories.get(pid));
      // 兜底：AI 理论上永远有合法动作（开枪永远合法）。真出事也不能把整局卡死。
      const action = decision ? decision.action : legalActions(state, pid)[0];
      if (!action) break;
      const res = applyAction(state, pid, action);
      if (!res.ok) break;
      if (state.phase === 'over') { over = true; break; }
    }
  }

  runAi(); // 有可能开局第一个回合就落在 AI 身上

  return {
    /* ------------------------------ 接口 ------------------------------ */

    /** **必须**只返回这个人有权看到的东西（隐藏信息见 js/view.js 顶部）。 */
    viewFor(playerId) {
      return viewFor(state, playerId);
    },

    /** 一个操作意图。失败时 message 是能**直接显示给玩家**的中文。 */
    act(playerId, act) {
      if (over) return { ok: false, message: '这一局已经结束了' };
      if (!state.players.some((p) => p.id === playerId)) {
        return { ok: false, message: '你不在这一局里' };
      }
      if (state.turn !== playerId) return { ok: false, message: '还没轮到你' };

      const res = applyAction(state, playerId, act);
      // 引擎说的是 error，接入合同要的是 message —— 在这一层翻译，
      // 引擎保持"不认识中文提示文案"的纯粹性。
      if (!res.ok) return { ok: false, message: res.error || '这个操作现在不能做' };

      if (state.phase === 'over') {
        over = true;
        return { ok: true };
      }
      runAi();
      if (state.phase === 'over') over = true;
      return { ok: true };
    },

    /** 中途加入：本作不给进（allowMidJoin 为 false，rooms.mjs 会先问这里）。 */
    addPlayer() {
      return false;
    },

    /**
     * 掉线或主动离开。
     * 真人走了，座位**由 AI 接管**而不是直接判死：
     * 直接判死会让剩下的朋友觉得"这局因为有人掉线就废了"，
     * 而且 3 人局里掉一个就只剩 2 人，场面会瞬间崩。
     * 座位上的名字保持不变，其他人看到的是"他还在打"，体感上比"突然出局"好。
     *
     * 开局**后**离开的真人走这条路（不动人机座位）；
     * 开局**前**有真人进来则是"人机让位"—— 那件事现在发生在房间层：
     * 人机是房间的座位，真人进来只占真人名额，跟人机座位互不影响。
     *
     * ⚠️ 人机座位（`bot:1` 这种 id）不是房间成员，房间层永远不会拿它调进来；
     *    真调进来也必须是无操作 —— 不能把一个 AI 座位"再接管一次"。
     */
    removePlayer(playerId) {
      if (!isAi.has(playerId) || isAi.get(playerId)) return;
      isAi.set(playerId, true);
      if (!memories.has(playerId)) memories.set(playerId, createAiMemory());
      /*
       * ⚠️ **不动**座位上的 `isAi`（也就是视图里的 `isAI` 身份标记）。
       * 那个标记回答的是"这个座位是不是房间里的人机"，掉线接管是另一回事：
       * 房间成员列表里这个人照样是「掉线中」的真人（房间层只知道 `isBot`），
       * 这里要是把它翻成灰环，牌桌和成员列表就会对同一个人给出两种身份。
       * 想让玩家看出"这台电脑在替谁打"，该做的是在牌桌上另给一个"掉线接管"提示，
       * 而不是把身份改掉。
       */
      if (!over && state.phase === 'playing' && state.turn === playerId) runAi();
      if (state.phase === 'over') over = true;
    },

    isOver() { return over; },

    result() {
      return {
        winner: state.winner,
        players: state.players
          .map((p) => ({ id: p.id, name: p.name, seat: p.seat, hp: p.hp, alive: p.alive, isAi: !!isAi.get(p.id) }))
          .sort((a, b) => a.seat - b.seat),
      };
    },

    /** 调试/测试用：AI 座位上的 id。 */
    _aiIds() { return [...isAi].filter(([, v]) => v).map(([k]) => k); },
    _state() { return state; },
  };
}