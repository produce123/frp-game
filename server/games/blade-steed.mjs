/*
 * BladeSteed 的服务端接入层。
 *
 * 它只做一件事：把「平台认识的 match 接口」翻译成「BladeSteed 引擎的调用」。
 * 规则一行都不在这里 —— 规则全在 games/blade-steed/js/engine/**，
 * 与浏览器人机对局跑的是**同一份文件**（这是本项目防作弊与防分叉的地基，见 D2）。
 *
 * 为什么文件名必须叫 blade-steed.mjs：server/games/index.mjs 按文件名自动发现，
 * 并要求 `meta.slug === 文件名`，不一致这个游戏就整个加载不上（启动日志会报出来）。
 *
 * 平台接口的完整说明见 docs/ARCHITECTURE.md 的「游戏模块接口」。
 *
 * ==================== 人机是「房间的座位」（options.aiFill 已作废） ====================
 *
 * 【这一版改了什么，为什么改】
 * 旧版：房主在准备界面选「补几个电脑」，服务端按 `options.aiFill` 自己造 AI 座位。
 * 问题是玩家看不见自己选了什么 —— 得先记住"我选了几个"再抬头看座位，
 * 而且 AI 不是成员，成员列表里根本看不到它。
 * 新版（用户明确要求，见 docs/DECISIONS.md D9）：**人机就是房间的一个座位**。
 * 房主按一下「＋ 添加人机」就多一个座位，界面由 shared/ui/room.js 统一画（含「移除」）。
 * 所以：
 *   · `players` 里**包含人机座位**，每项形如 `{ id, name, isHost, isBot }`
 *     （人机 id 形如 `bot:1`，名字是单字，来自下面 meta.botNames 的池子）
 *   · 这里不再读 `options.aiFill` —— 一个字节都不读。旧的那套
 *     「clampInt 收口 / 明确选 0 拒绝开局 / 缺省兜底补到 2 个座位」整段作废。
 *   · 「座位不够就不许开局」由**房间层**拦（`players.length < meta.minSeats`，
 *     它会推一条中文提示条让玩家去按「添加人机」，见 server/rooms.mjs 的 start()）。
 *     本文件只在最外面留一道防御性校验（有人绕过房间层直接调时会抛中文）。
 *
 * 【"AI 让位给真人"也不在这一层了】
 * 旧版这里按 `aiFill` 截断"还能补几个"。现在这条**已上移到房间层**：
 * `server/rooms.mjs` 的 `join()` 在开局前发现有真人要进来、而座位又满了时，
 * 会顶掉**最后加的那一个人机**（开局后人机不再让位）。
 * 所以本文件不需要、也不应该再算"补几个" —— 它拿到的就是最终座位表。
 *
 * 【AI 由服务端同步跑完，绝不用定时器】
 * 原项目（浏览器本地人机）里 AI 是 setTimeout 一步一步"演"给真人看的。
 * 服务器上不能这么干：rooms.mjs 不为游戏保留"还在思考"的状态，也没有任何机制
 * 在若干秒后再推一次；一旦这里返回时回合还在 AI 身上，客户端就永远停在
 * "等待对手行动"。所以每次状态变化（开局 / 真人操作 / 催办）之后，
 * 都在返回之前把 AI 的义务**全部**跑完，一直跑到"该真人了"或分出胜负为止。
 * 代价是 AI 的动作在客户端是一起到达的 —— 界面那侧由 shared/ui/anim.js 的
 * `FrpAnim.push()` 把它们**逐条、串行**演出来（用户第 1 条需求，见 js/ui/board.js）。
 *
 * 【"同时出拳"这类游戏怎么做到"不等任何客户端"】
 * 本游戏每一轮是**所有人同时猜拳**，引擎要等齐所有人的手势才开奖（_maybeResolveRps）。
 * 如果让 AI 也"等到被催才出拳"，那真人出拳之后这一轮会一直卡在"等 AI"上，
 * 只能靠客户端到点发的 {kind:'tick'} 兜底 —— 而 tick 要等 10 秒超时，体感就是
 * "我出了拳，对面一直不动"。
 * 正确做法：**AI 在每一轮开始的那一刻就把自己的拳定下来**（submitRps）。
 * 于是「AI 的拳」永远是"已出/未出"里的"已出"，最后一个提交的必定是真人，
 * 引擎当场开奖，服务端不需要等任何客户端。
 * 这个动作发生在三处：createMatch（开局那一刻）、act（真人任何一次操作之后，
 * 可能开了新一轮）、removePlayer（有人走了之后可能凑齐了这一轮）。
 *
 * 【那个"客户端到点催 tick"的机制要保住】
 * 真人挂机时仍然需要它（猜拳 10 秒 / 排序 15 秒 / 单步 60 秒的超时都靠它推）。
 * AI 座位**不再依赖它**：AI 的拳在回合开始时就已经出完了，哪怕一个真人都没动。
 *
 * 【座位上下限：minPlayers 与 minSeats 是两回事，别合并】
 *   meta.minPlayers = 1 —— 房间层数的是**真人**：一个人也能点【创建房间】。
 *   meta.minSeats   = 2 —— **总座位**下限（含人机），也是引擎的底线（constants.js 的
 *                          MIN_SEATS）：一个座位的对局永远分不出胜负。
 *   所以"一个人建房 → 按「＋ 添加人机」补一个座位 → 开局"是标准路径；
 *   一个人、零个人机点【开始游戏】会被**房间层**用中文提示条挡住（不是这里抛错）。
 *
 * 【人机的名字：单字，来自 meta.botNames（就是 js/ai/ai.js 的 AI_NAME_POOL）】
 * 契约 docs/ARCHITECTURE.md 的「游戏模块接口」 要求人机的名字**玩家一眼看得出来**。平台的做法是
 * 名字取自各游戏单机人机的单字池 + 房间成员列表里的灰圈「人机」标签 + 牌桌上的
 * 灰色虚线圈（js/ui/map.js 的 is-bot，配色见 css/style.css）。
 * 这里把池子**导出**给房间层用（`meta.botNames`），不是抄一份字面量 ——
 * 抄一份的话，改一处就会分叉（原来的「电脑1」「电脑2」是另一套规则，已作废）。
 * ⚠️ **单机【人机对局】不走这条路**：那边由 js/ui/local.js 自己用 pickAiName() 挑名字，
 *    引擎里的 AI 座位不带 isBot，所以单机牌桌上不会出现任何电脑标记（这是刻意的）。
 *
 * 【界面上怎么认出人机：视图里的 isAI】
 * 发给**玩家**的那一档视图带 `isAI`（js/view.js 的 exposeAI），界面据此画灰圈/虚线圈。
 * 而 AI 决策吃的那一份是**裸 viewFor**（runAi() 递进 aiStep 的就是它），**没有** isAI ——
 * 「AI 拿不到'谁是真人'这个字段」这条结构性保证还在（见 js/view.js 顶部）。
 * `isBot` 只是房间层给我们的座位标记，**不许进座位条目**：下面造座位时只取
 * id / name / isBot → isAI，别把整个 player 对象塞进引擎。
 */

import { Match } from '../../games/blade-steed/js/engine/engine.js';
import { viewFor } from '../../games/blade-steed/js/view.js';
import { AI_NAME_POOL, aiStep, makeBrains } from '../../games/blade-steed/js/ai/ai.js';
import { MAX_PLAYERS, MIN_PLAYERS, MIN_SEATS, PHASE } from '../../games/blade-steed/js/engine/constants.js';

export const meta = {
  slug: 'blade-steed',
  title: '刀马 BladeSteed',
  icon: '⚔️',
  /**
   * 房间层只数**真人**：1 表示"一个人也能建房"。
   * ⚠️ 别改成引擎那边的 MIN_SEATS —— 平台在"真人不够 minPlayers"时直接拒绝开局，
   *    而它数的人里**不含人机**。
   */
  minPlayers: MIN_PLAYERS,
  /**
   * **总座位**下限（含人机）：引擎至少要 2 个座位才打得起来（constants.js 的 MIN_SEATS）。
   * 房间层用它决定「开始游戏」亮不亮、以及座位不够时那句中文提示；
   * 平台用例也拿 `meta.minSeats` 个座位调 createMatch。
   * ⚠️ 和 minPlayers 是两个数，别合成一个（见文件头）。
   */
  minSeats: MIN_SEATS,
  maxPlayers: MAX_PLAYERS,
  /**
   * 人机名字池（单字）。房间层 `pickBotName(meta.botNames, used, n)` 用它给
   * 「＋ 添加人机」加出来的座位取名，并**优先挑房里没人用过的字**。
   * 直接 re-export js/ai/ai.js 的池子 —— 不抄字面量（见文件头）。
   */
  botNames: AI_NAME_POOL,
  /**
   * 对局中途允许新人入座（引擎的 addPlayer：新人下一回合开始参与行动）。
   * 注：平台目前**不读**这个字段（server/rooms.mjs 是直接问 match.addPlayer 的），
   * 它只是给人和工具看的声明 —— 真正生效的是下面 addPlayer 的返回值。
   */
  allowMidJoin: true,
};

/**
 * 一次调用里最多允许 AI 走多少步。
 * 纯防御性上限：只有引擎彻底坏掉（AI 永远推进不了局面）时才会碰到，
 * 正常一局几百步就到头了。有它就不会把服务端主线程占死。
 */
const MAX_AI_STEPS = 20_000;

/**
 * 建一局，返回平台要的那个 match 对象。
 *
 * @param {{id:string,name:string,isHost?:boolean,isBot?:boolean}[]} players
 *   **座位表**：真人 + 人机（人机是房间层按「＋ 添加人机」加出来的，`isBot: true`）。
 *   顺序即入座顺序（引擎开局会把座位号 1–4 随机洗一遍，只影响头像摆哪个方位）。
 * @param {object} [options] 房主在准备界面选的设置（只剩 allowMidJoin 一项，见 js/ui/online.js）
 */
export function createMatch(players, options = {}) {
  // options 是客户端/房间层传上来的，**一律当不可信输入**：null / 字符串 / 数字都当没传。
  // （不这么写的话 `createMatch(players, null)` 会在这里抛 TypeError，
  //   那就把一个"垃圾输入"变成了"服务器炸了"。）
  if (!options || typeof options !== 'object') options = {};

  if (!Array.isArray(players) || players.length < 1) {
    throw new Error('这一局一个人都没有');
  }
  if (players.length > MAX_PLAYERS) {
    throw new Error(`最多 ${MAX_PLAYERS} 个座位（现在 ${players.length} 个）`);
  }
  /*
   * 防御性校验（房间层已经保证 players.length >= minSeats 了，但接入层自己也要站得住）：
   * 1 个座位的对局永远分不出胜负（引擎的新 Match 也会抛），早点给一句中文，
   * 总比抛一个英文栈给 rooms.start 强。
   * 走不到这里 —— 玩家看到的是房间层那句「座位不够：…按「添加人机」补一个」。
   */
  if (players.length < MIN_SEATS) {
    throw new Error(`座位不够：至少要 ${MIN_SEATS} 个座位（现在 ${players.length} 个）`);
  }

  const allowMidJoin = options.allowMidJoin !== false;

  /* ------------------------------ 造座位 ------------------------------ */

  /*
   * `isBot` 是**房间层**给的（人机座位）。这里只映射三个字段：
   *   · id / name 原样
   *   · isBot → 引擎的 isAI（引擎只认这个）
   * ⚠️ 别把整个 player 对象塞进引擎：那样 `isBot` 会跟着进 state，
   *    再顺手溜进某个报文里 —— 契约说好座位条目只带 isAI，不带 isBot。
   */
  const seats = players.map((p) => ({
    id: String(p.id),
    name: String(p.name),
    isAI: p.isBot === true,
  }));
  /*
   * 「人机座位数 ≤ MAX_PLAYERS − 真人数」这条规矩**由上面的长度校验天然成立**
   * （players.length ≤ MAX_PLAYERS 就是全部座位数），所以这里不需要再算一遍 ——
   * 旧版那句 `wantAi = clampInt(options.aiFill, 0, MAX_PLAYERS - players.length)`
   * 连同它的 clampInt 一起删掉了。地图只有 4 座城，撑爆了会画歪。
   */

  // 座位顺序交给引擎（开局随机洗座位），这里只把 id/name/isAI 递进去。
  const state = new Match({ players: seats });

  // AI 大脑：一人一个。aiStep 只吃 viewFor(state, 该 AI) 的产物 —— 那是**不带身份标记**
  // 的那一档（裸调用，没有 exposeAI），所以服务端 AI 与浏览器本地 AI 看到的一样多，
  // 也仍然拿不到"谁是真人"这个字段。
  const brains = makeBrains(state.players);

  /**
   * 对局是否结束。**必须**是"随时问都准"的：房间层每次操作后都会问一次，
   * 答案决定房间进入 over 阶段（然后客户端才会看到「再来一局」）。
   * 所以这里不缓存布尔值，直接看引擎的状态 —— 少一个能写错的地方。
   */
  const isOver = () => state.phase === PHASE.OVER;

  /**
   * 把 AI 的义务当场跑完：一直推进到"该真人了"或分出胜负为止。
   *
   * aiStep 每次只推进一层（当前阶段的一批提交 / 当前行动者的一步）：
   *   · 猜拳阶段：把**所有还没出拳的 AI** 一次性出完（这就是"AI 在回合开始就定拳"）
   *   · 小猜拳 / 定顺序：AI 候选人或 AI 决胜者当场出拳 / 排顺序
   *   · 行动阶段：轮到 AI 就做一步
   * 它返回 false 就代表"没有 AI 的事了"，可以安全返回给客户端。
   */
  function runAi() {
    let guard = 0;
    while (!isOver() && guard++ < MAX_AI_STEPS) {
      if (!aiStep(state, brains, viewFor)) break;
    }
  }

  // 开局那一刻就把 AI 这一轮的拳定下来 —— 这样真人一出拳就立刻开奖，服务端不等任何人。
  runAi();

  return {
    /**
     * 按人裁剪。**只**返回这个人有权看到的字段（实现见 js/view.js）。
     *
     * 这里多传一个 `exposeAI`：发给**玩家**的那一份带上 `isAI` 身份标记 ——
     * 人机的名字是单字（可能和某个真人重名），界面不能靠解析名字来决定怎么画，
     * 得有这个能判定的位（见 js/ui/map.js / board.js 的 `is-ai` / `is-bot`）。
     * 身份是公开信息，不是隐藏信息：猜拳没揭晓时各自出了什么，照旧一个字都不下发。
     * ⚠️ AI 决策吃的那一份**不带**它：runAi() 递进 aiStep 的是**裸 viewFor**，
     *    所以「AI 拿不到'谁是真人'这个字段」这条结构性保证还在（见 js/view.js 顶部）。
     */
    viewFor(playerId) {
      return viewFor(state, playerId, { exposeAI: true });
    },

    /**
     * 一个操作意图（含 {kind:'tick'} 催办）。成功返回 { ok:true }，
     * 失败返回 { ok:false, message } —— message 必须是可以直接显示给玩家的中文。
     */
    act(playerId, act) {
      if (isOver()) return { ok: false, message: '本局已经结束了' };
      const r = state.handleAct(playerId, act);
      if (!r.ok) return r;
      /*
       * ⚠️ 这一句是本文件最重要的两行之一。
       * 真人的这一手可能：把这一轮凑齐（→ 开奖）、开出一个新局面（→ 该 AI 行动了）、
       * 或者结束一整轮（→ 新一轮猜拳，AI 要在这一轮开始就定拳）。
       * 全部当场跑完再返回，客户端才不会永远停在"等待对手行动"。
       */
      runAi();
      return { ok: true };
    },

    /**
     * 中途加入。房间层只有在返回值**恰好是 true** 时才认这个人入座，
     * 所以这里必须老老实实返回布尔值（返回 {ok:true} 会被当成拒绝）。
     */
    addPlayer(player) {
      if (!allowMidJoin) return false;
      const r = state.addPlayer({ id: player.id, name: player.name });
      /*
       * 这里**故意不跑 runAi()**：能走到这一步，说明上一次操作返回前 AI 的义务已经跑完了，
       * 而新座位是个真人（人机那一轮的手势早就出完），所以此刻不可能有 AI 欠着动作。
       * 于是"AI 的手势已经出完"这条不变量不受中途加入影响。
       */
      return r.ok === true;
    },

    /** 掉线（超过宽限期）或主动离开 → 立刻判出局。 */
    removePlayer(playerId) {
      if (isOver()) return;
      state.leave(playerId);
      /*
       * 人走了之后局面**必须**再推一次：他可能正是当前行动者（引擎会把回合交给下一位，
       * 那可能就是 AI），也可能他正是这一轮最后一个没出拳的人（走了就等于凑齐了 → 开奖）。
       */
      runAi();
    },

    isOver,

    /** 终局信息（房间层只透传，不做任何解释）。 */
    result() {
      return {
        winner: state.winner,
        winnerName: state.winner ? state.name(state.winner) : null,
        round: state.round,
        players: state.players.map((p) => ({
          id: p.id,
          name: p.name,
          seat: p.seat,
          hp: p.hp,
          alive: p.alive,
          knife: p.knife,
          horse: p.horse,
          place: p.place,
        })),
      };
    },

    /* ------------------------------ 调试 / 测试用 ------------------------------ */

    /**
     * AI 座位的 id。视图里**有** `isAI` 了（界面上要把人机标出来），所以这里不再是
     * "唯一能认出人机的地方"；它给用例一个按 id 的硬断言入口
     * （比如"AI 的拳在揭晓前没进真人的 view"）。
     */
    _aiIds() {
      return state.players.filter((p) => p.isAI).map((p) => p.id);
    },

    /** 引擎本体：给用例做"AI 到底出没出拳"这类硬断言，别在业务代码里用。 */
    _state() {
      return state;
    },
  };
}