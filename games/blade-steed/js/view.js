/**
 * BladeSteed — 视图裁剪（viewFor）
 *
 * **这个文件是「谁能看见什么」的唯一实现**，服务端与浏览器共用同一份：
 *   · 服务端：server/games/blade-steed.mjs 里 viewFor(state, playerId) → 直接发给该玩家
 *   · 浏览器：单机人机时也必须先过一遍它，才交给渲染函数（见 js/ui/app.js）
 *
 * 为什么单机也要绕这一道：单机时手里握着完整 state，随手就能把对手的手牌画出来。
 * 那条路一旦走通，联机时就会有人照着抄，于是「前端不显示」成了唯一的防线 ——
 * 而前端不显示根本不是防线。**报文里没有**才算数（docs/GAME-SPEC.md 铁律二）。
 *
 * 本局唯一需要保密的信息是**猜拳还没揭晓时各自出了什么**；
 * 血量 / 位置 / 装备 / 行动顺序本来就是公开信息，藏了反而没法玩。
 *
 * 另外：视图有**两档**，差别只有一个字段 `isAI`。
 *
 *   · **给玩家的那一档**（`{ exposeAI: true }`）：座位条目带 `isAI`，
 *     界面据此把人机座位标出来（地图灰虚线圈 + ready 标记虚线边，见 js/ui/map.js / board.js）。
 *     身份是**公开信息**，不是隐藏信息：人机的名字本来就是单字池里的一个字
 *     （`meta.botNames`，房间层挑的，见 docs/GAME-SPEC.md §4），玩家一眼就该看出来
 *     —— 所以下发它不泄露任何东西。名字**可能**和某个真人重名，界面不许靠解析名字判断身份。
 *     服务端发报文走的就是这一档（server/games/blade-steed.mjs 的 viewFor）。
 *
 *   · **给 AI 决策的那一档**（默认，不传 exposeAI）：**没有** isAI。
 *     js/ai/ai.js 的 aiStep 吃的就是这一档（服务端 runAi 递进去的也是裸 viewFor），
 *     所以「AI 拿不到'谁是 AI / 谁是真人'这个字段」这条结构性保证仍然成立
 *     —— 它不是"不看"，是拿不到。（这是原项目专门验证过的一条，搬家时必须保住。）
 *     ⚠️ 改服务端时别顺手把带身份的那一份递给 aiStep。
 */

import { KEEP_EVENTS, KEEP_LOG, PHASE, RPS } from './engine/constants.js';

/** 只保留「谁已经出过拳」，绝不泄露出什么 */
function readyMap(submitted, ids) {
  const out = {};
  for (const id of ids) out[id] = !!(submitted && submitted[id]);
  return out;
}

/*
 * ------------------------------ 逐步同步的裁剪 ------------------------------
 *
 * 引擎（engine.js 的 `_pushEvent`）给每条事件挂了一份"这一步之后的公开状态补丁"（`s`），
 * 界面据此**按步走**（演到第几步，血量/装备/位置/回合/倒计时就变到第几步，见 D14）。
 *
 * 【为什么必须在这里再裁一遍】
 * 那份补丁里的 `rps` / `mini` 各带一张**私有表** `submitted`（"谁出了什么"），
 * 它是"每个看的人各有一份"的：引擎不知道看的人是谁，所以先给全的，
 * **出报文之前由这里按人裁成单数** —— `ready`（只有"出没出"的布尔）+ `myChoice`（只有他自己那一手）。
 * 主视图（上面的 viewFor）用的就是同一套口径，两处不许分叉。
 *
 * ⛔ 别人**没揭晓**的拳、任何私有字段，**绝不许出现在报文里**。这条有测试盯着
 *    （整份报文 JSON 化之后搜别人的选择，命中必须是 0）—— 它是防作弊的唯一手段。
 *
 * ⛔ `exposeAI` 那两档照旧：补丁里**不放** `isAI`（身份只在主视图的座位条目上）。
 *    下面这个函数是"白名单"写法：只抄列出来的字段，将来引擎往补丁里加了新字段，
 *    也会**默认漏不进报文**（漏了要显式加进来，正好逼人想一遍"这东西该公开吗"）。
 */
function narrowRpsPatch(r, viewerId) {
  if (!r) return null;
  return {
    round: r.round,
    winners: Array.isArray(r.winners) ? r.winners.slice() : [],
    ready: readyMap(r.submitted, r.ids || []),
    /*
     * 只有"我自己出的那一手"是我的；别人的在揭晓前谁都拿不到（和主视图同一条口径）。
     * ⚠️ 这个字段**必须每条带 rps 的补丁都有**（没有就是 null）：新一轮猜拳开始时
     *    `_startRps` 会把 submitted 清空，界面靠这个 null 把"你出了✊"擦掉 ——
     *    少了它，合并到显示视图上的会是上一轮那一手（同一回合"无人获胜重猜"时
     *    round 是不变的，光看 round 分不出来）。
     */
    myChoice: (r.submitted && r.submitted[viewerId]) || null,
  };
}

function narrowMiniPatch(m, viewerId) {
  if (!m) return null;
  const cands = Array.isArray(m.candidates) ? m.candidates.slice() : [];
  return {
    round: m.round,
    candidates: cands,
    ready: readyMap(m.submitted, cands),
    myChoice: (m.submitted && m.submitted[viewerId]) || null,
    decider: m.decider,
  };
}

/**
 * 把一条事件的补丁裁成"这个人有权看到的那一份"。
 * 没补丁（老报文）时返回 null —— 界面那边会照旧演特效、最后由对账收口（见 board.js）。
 */
function narrowPatch(s, viewerId) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const k of ['phase', 'round', 'current', 'stepsLeft', 'winner']) {
    if (k in s) out[k] = s[k];
  }
  if (Array.isArray(s.mainWinners)) out.mainWinners = s.mainWinners.slice();
  if (s.steps) out.steps = { ...s.steps };
  if (Array.isArray(s.queue)) out.queue = s.queue.slice();
  // 座位补丁只带"变了的那几个人"，而且只有这几个公开字段（按 id 合进画面的那一份）
  if (Array.isArray(s.players)) out.players = s.players.map((p) => ({ ...p }));
  if (s.rps) out.rps = narrowRpsPatch(s.rps, viewerId);
  if (s.mini) out.mini = narrowMiniPatch(s.mini, viewerId);
  return out;
}

/**
 * 生成某个玩家该看到的视图。
 * @param {import('./engine/engine.js').Match} state 引擎实例（服务端里的权威状态）
 * @param {string} viewerId 看的人
 * @param {object} [opts]
 * @param {boolean} [opts.exposeAI] 是否下发 `isAI` 身份标记。
 *   **只有"发给玩家"的那一档传 true**（服务端 viewFor）；给 AI 决策用的裸调用保持 false，
 *   这样 AI 依旧拿不到身份字段（见文件头）。
 * @returns {object|null} **名单里没有的人一律返回 null**（平台契约，见 docs/GAME-SPEC.md 第 4 节）
 */
export function viewFor(state, viewerId, { exposeAI = false } = {}) {
  // 不是这一局的人（局外人 / 随便编一个 id）什么都不给。
  // 少了这一条，任何拿到 playerId 的人都能旁观别人的牌 —— check-game.mjs 会实测这一条。
  //
  // ⚠️ 注意"出局的人"和"局外人"是两回事：出局/离开的人**仍然在 state.players 里**
  //    （地图上要显示他的城和尸体），所以照常给视图 —— 界面上写着"你已出局，可以继续看完这一局"。
  if (!viewerId || !state.players.some((p) => p.id === viewerId)) return null;

  const now = state.nowMs();

  // 公开的玩家信息。isAI 只在"发给玩家的那一档"里出现（身份公开，见文件头）；
  // 不传 exposeAI 时字段和以前**一模一样**，AI 的输入里没有它。
  const players = state.players.map((p) => {
    const pub = {
      id: p.id,
      name: p.name,
      seat: p.seat,
      hp: p.hp,
      alive: p.alive,
      knife: p.knife,
      horse: p.horse,
      place: p.place,
    };
    if (exposeAI) pub.isAI = !!p.isAI;
    return pub;
  });

  const rps = state.rps
    ? {
        round: state.rps.round,
        ready: readyMap(state.rps.submitted, state.players.filter((p) => p.alive).map((p) => p.id)),
        // 只有「自己出的那一手」是自己的；别人的在揭晓前谁都拿不到
        myChoice: state.rps.submitted[viewerId] || null,
        winners: state.rps.winners.slice(),
        deadlineIn: Math.max(0, state.rps.deadline - now),
      }
    : null;

  const mini = state.mini
    ? {
        round: state.mini.round,
        candidates: state.mini.candidates.slice(),
        ready: readyMap(state.mini.submitted, state.mini.candidates),
        myChoice: state.mini.submitted[viewerId] || null,
        decider: state.mini.decider,
        deadlineIn: Math.max(0, state.mini.deadline - now),
      }
    : null;

  return {
    v: 1,
    rev: state.rev,
    phase: state.phase,
    round: state.round,
    players,
    rps,
    mini,
    mainWinners: state.mainWinners.slice(),
    steps: { ...state.steps },
    queue: state.queue.slice(),
    current: state.current,
    stepsLeft: state.stepsLeft,
    winner: state.winner,
    /** 猜拳可用手势（客户端照着渲染按钮，避免两边写死不一致） */
    rpsChoices: RPS.slice(),
    actionDeadlineIn: state.phase === PHASE.ACTION ? Math.max(0, state.actionDeadline - now) : 0,
    log: state.log.slice(-KEEP_LOG),
    /**
     * 动画事件：客户端按 id 去重后依次播放。
     * 每条事件上的 `s`（这一步之后的公开状态补丁）和 `logUpTo`（这一刻写好到哪条播报）
     * 都**原样带下来**，但 `s` 必须过上面那层裁剪（见 narrowPatch 的说明）——
     * 事件本身（谁出拳了 / 谁被砍了 / 结果）本来就是公开信息，不是隐藏信息。
     */
    events: state.events.slice(-KEEP_EVENTS).map((ev) => ({
      ...ev,
      s: narrowPatch(ev.s, viewerId),
    })),
  };
}