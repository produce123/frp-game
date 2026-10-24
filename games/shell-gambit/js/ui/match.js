/**
 * Shell Gambit — 单机人机对局的驱动器
 *
 * 【位置】这是**浏览器本地**才用的东西（GAME-SPEC 第 14 节：人机对局在本地跑）。
 * 服务器那边不用它 —— 服务器的 AI 由 server/games/shell-gambit.mjs 自己排，
 * 因为它不能 setTimeout 慢慢等（见那个文件顶部的说明）。
 *
 * 【为什么 AI 一定要走 view 再决策】
 * 它是本作"AI 不作弊"的结构性保证：AI 的入口是 `aiDecideFromView(view, …)`，
 * 手上只有 viewFor 裁剪过的那一份数据 —— 读不到弹匣顺序，也读不到别人的手牌。
 * 如果图省事改成 `aiDecide(state, …)`（引擎里也有这个函数，服务器那侧用的就是它），
 * 单机 AI 就会**偷看对手手牌和下一发子弹**，玩家一定会察觉
 * "这电脑怎么老知道我什么时候有实弹"。
 *
 * ⚠️ 别把本文件挪进 js/engine/ 或 js/ai/：它用了 setTimeout，
 * 而那两个目录有"零 DOM / 零宿主 API"的硬约束（GAME-SPEC 铁律一）。
 */

import { aiDecideFromView, createAiMemory } from '../ai/ai.js';
import { applyAction, createGame } from '../engine/engine.js';
import { viewFor } from '../view.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* 引擎只认"状态"，不导出 isOver/result —— 那两句判断是接入合同（GAME-SPEC 第 4 节）
   要求 createMatch 返回对象提供的方法。两边口径必须一致：
   server/games/shell-gambit.mjs 里用的是同一套判断，改这里要同步改那里。 */
const isOver = (state) => state.phase === 'over';
const result = (state) => ({
  winner: state.winner,
  players: state.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat, hp: p.hp, alive: p.alive })),
});

/**
 * 单机对局：一个真人 + 若干 AI，全部在本地跑。
 *
 * @param {object} opts
 * @param {{id:string,name:string}} opts.me  真人（身份来自平台账号 window.GameNet.me）
 * @param {number} opts.playerCount          总人数 2–4
 * @param {string[]} [opts.aiNames]          AI 的单字名，要与真人名字区分开
 * @param {number}   [opts.aiDelayMs=900]    AI 思考时长，让真人看得清它在干什么
 * @param {(view:object, info:object) => void} [opts.onUpdate]
 *        每次状态变化后回调，**只给裁剪过的 view**。
 */
export function createLocalMatch({
  me,
  playerCount,
  aiNames = [],
  aiDelayMs = 900,
  onUpdate = () => {},
}) {
  const total = Math.max(2, Math.min(4, playerCount | 0));

  /**
   * 参与者：真人在前，电脑依次补位。座位由引擎随机分配，与传入顺序无关。
   *
   * ⚠️ `isAi` 必须随座位一起传进引擎：界面画圆环靠的是视图里的 `players[].isAI`
   *    （js/view.js 从 `state.players[].isAi` 取）。不传的话单机对局的电脑会画成
   *    "其他真人"的橙色圆环 —— 而单机里**除了自己全是电脑**，灰色才对。
   *    联机那边这个标记来自房间层的 `players[].isBot`，两条路最后落在同一个字段上。
   */
  const entrants = [{ id: me.id, name: me.name, isAi: false }];
  for (let i = 1; i < total; i++) {
    entrants.push({ id: `ai:${i}`, name: aiNames[i - 1] || `AI${i}`, isAi: true });
  }

  const state = createGame({ players: entrants });
  const isAi = {};
  const memories = {};
  for (const p of entrants) {
    isAi[p.id] = p.id !== me.id;
    memories[p.id] = createAiMemory();
  }

  let disposed = false;
  let timer = null;
  let running = false;
  /** 最近一次 AI 的决策理由，界面用来显示"它在想什么" */
  let lastAiReason = null;

  function schedule(delay) {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void pump(); }, delay);
  }

  /**
   * 连续推进 AI 的动作。
   * 一次循环把"直到又轮到真人"为止的 AI 动作全走完 —— AI 之间不会插入真人，
   * 所以不必一帧一动作；而不是同步跑完（服务器那侧才是同步跑完）的原因只有一个：
   * 让真人**看得见**对手在做什么，否则 4 人局里 AI 的回合会瞬间闪过。
   */
  async function pump() {
    if (disposed || running) return;
    running = true;
    try {
      let steps = 0;
      while (!disposed && state.phase === 'playing' && isAi[state.turn]) {
        const pid = state.turn;
        await wait(aiDelayMs);
        // 等这一段的时候真人可能已经把状态改变了（虽然规则上插不进来），重新确认一遍
        if (disposed || state.phase !== 'playing' || state.turn !== pid) break;

        const decision = aiDecideFromView(viewFor(state, pid), memories[pid], state.rng.next);
        if (!decision) break; // 理论上不会：开枪永远是合法动作
        if (!applyAction(state, pid, decision.action).ok) break;

        lastAiReason = decision.reason;
        onUpdate(viewFor(state, me.id), { aiPlayer: pid, aiReason: decision.reason });
        steps += 1;
        if (steps > 400) break; // 防御性上限，任何情况下都不许把标签页卡死
      }
    } finally {
      running = false;
    }
  }

  /**
   * 开局。
   * ⚠️ 必须有人调它：座位是**随机分配**的，开局可能直接轮到 AI。
   * 那时如果只是把视图画出来、没人去推 AI，界面就会永远停在"等待对手行动" ——
   * 单机对局里没有服务器会替你推进（联机那边是服务端同步跑完的）。
   * 这个坑是浏览器测试撞出来的：同一条用例在一半的运行里会卡住。
   */
  function start() {
    if (state.phase !== 'playing') return;
    if (isAi[state.turn]) schedule(aiDelayMs);
  }

  return {
    start,

    /** 只给裁剪过的视图 —— 界面永远拿不到完整 state。 */
    viewFor(playerId = me.id) { return viewFor(state, playerId); },

    /** 真人提交一个操作意图。返回 { ok } 或 { ok:false, message:'中文原因' }。 */
    submit(action) {
      if (disposed) return { ok: false, message: '对局已结束' };
      if (state.phase !== 'playing') return { ok: false, message: '对局已结束' };
      if (state.turn !== me.id) return { ok: false, message: '还没轮到你' };
      const res = applyAction(state, me.id, action);
      if (res.ok) {
        onUpdate(viewFor(state, me.id), {});
        schedule(aiDelayMs);
      }
      return res;
    },

    /** 某人是 AI 吗（界面用来标出"谁在替你思考"）。 */
    isAiPlayer(playerId) { return !!isAi[playerId]; },

    get lastAiReason() { return lastAiReason; },
    isOver() { return isOver(state); },
    result() { return result(state); },

    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}