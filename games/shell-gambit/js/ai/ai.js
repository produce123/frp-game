/**
 * Shell Gambit — AI 决策
 *
 * 设计原则（对应需求「AI 眼里不能有 AI 和用户之分」）
 *  1. AI 只能看到「任何人坐在这个位置都能看到的信息」：
 *     血量、存活、手牌张数、座位、手铐、弹匣剩余实弹/空弹数量、公开事件日志，
 *     以及**自己**的手牌和**自己**用放大镜看到的结果。
 *     它读不到弹匣真实顺序，也读不到别人的手牌 —— relate() 里没有任何隐藏字段。
 *  2. AI 不知道谁是真人谁是 AI：所有判断只基于 playerId 的公开状态。
 *     ⚠️ 视图里从这一版起带一个 `isAI` 字段（人机座位是**房间层的座位**，
 *     身份在房间成员列表里本来就是公开的，见 js/view.js）。但**打分逻辑一个字都不读它**：
 *     scoreAction / threatOf / strongestOpponent 里没有 isAI。这是刻意的 ——
 *     哪天有人想"AI 优先打真人"或者"放过人机"，得先改这里，改不动就说明守住了。
 *  3. AI 会记仇（谁打过我），但记仇只是加权项，局势分析（威胁/击杀机会）权重更高。
 *
 * 决策方式：把每一个合法动作算成「期望收益」，取最高分。
 * 这样「敢赌实弹/空弹」是自然涌现的：
 * 剩余空弹多时，打自己的期望收益（保留回合）会超过打别人。
 */

import { BASE_DAMAGE, MAX_HP, SAW_DAMAGE } from '../engine/constants.js';
import { legalActions, remainingCounts } from '../engine/engine.js';

/* ---------------------------- 权重 ---------------------------- */

const W = {
  keepTurn: 4.0, // 空弹打自己：保留回合的价值
  wasteTurn: 1.2, // 空弹打别人：白白交出回合的代价
  kill: 9.0, // 击杀对手的价值
  selfRiskBase: 1.0, // 打自己的基础风险
  selfRiskPerMissingHp: 0.7, // 血越少越怕自伤
  selfDamageScale: 2.2, // 自伤惩罚系数
  hpThreat: 1.6, // 威胁评估：每点血
  handThreat: 0.7, // 威胁评估：每张手牌
  grudgeWeight: 0.9, // 记仇权重
  nextSeatBonus: 0.3, // 下一个行动的人威胁略高
  noise: 0.15, // 小幅随机，避免行为过于机械
};

/* ---------------------------- 记忆 ---------------------------- */

/** 每名 AI 玩家一份记忆（记仇表 + 已消费的日志序号） */
export function createAiMemory() {
  return { grudges: {}, seenSeq: 0 };
}

/**
 * 从公开事件日志里更新记仇表。
 * 只处理“谁打了我、掉了我多少血”，不涉及任何隐藏信息。
 */
function updateMemory(log, meId, memory) {
  for (const e of log) {
    if (e.n <= memory.seenSeq) continue;
    memory.seenSeq = e.n;
    if (e.t === 'shoot' && e.target === meId && e.damage > 0 && e.player !== meId) {
      memory.grudges[e.player] = (memory.grudges[e.player] || 0) + e.damage;
    }
    // 记仇随时间淡化，避免一条道走到黑
    if (e.t === 'round') {
      for (const k of Object.keys(memory.grudges)) {
        memory.grudges[k] *= 0.5;
        if (memory.grudges[k] < 0.25) delete memory.grudges[k];
      }
    }
  }
}

/* ---------------------------- 感知 ---------------------------- */

/**
 * 构建 AI 的「视野」。
 * 注意：这里读取的字段全部是公开信息 + 自己的私有信息，绝无隐藏信息。
 */
function perceive(state, meId) {
  const counts = remainingCounts(state);
  const me = state.players.find((p) => p.id === meId);
  return {
    me: {
      id: me.id,
      seat: me.seat,
      hp: me.hp,
      alive: me.alive,
      hand: me.hand.slice(),
      knows: state.knowledge[meId] || null, // 只有自己用放大镜看过的结果
    },
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      hp: p.hp,
      alive: p.alive,
      handCount: p.hand.length,
      cuffed: p.cuffed,
    })),
    magazine: counts, // 只有数量，没有顺序
    saw: state.saw,
    phase: state.phase,
    // 用引擎自己的规则函数取合法动作，AI 与真人共用同一份规则
    legal: legalActions(state, meId),
  };
}

/**
 * 从「客户端视图」构建视野。
 * 联机时客户端手里只有 viewFor() 裁剪过的数据，AI 用这个入口同样能决策。
 */
export function perceiveView(view) {
  return {
    me: {
      id: view.me.id,
      seat: view.me.seat,
      hp: view.me.hp,
      alive: view.me.alive,
      hand: view.me.hand.slice(),
      knows: view.me.knows || null,
    },
    // ⚠️ 这里是 `{ ...p }`：视图里的 `isAI` 会跟着进来。**决策逻辑不许读它**
    //    （见文件头第 2 条）。要过滤就在这一行过滤，别在打分函数里加例外。
    players: view.players.map((p) => ({ ...p })),
    magazine: { ...view.magazine },
    saw: view.saw,
    phase: view.phase,
    legal: view.me.legal.map((a) => ({ ...a })),
  };
}

/* ---------------------------- 概率 ---------------------------- */

/**
 * 当前这一发「是实弹」的概率。
 *  - 如果自己用放大镜看过 → 100% 确定
 *  - 否则用公开的剩余弹药比例估计
 */
function liveProbability(p) {
  if (p.me.knows === 'live') return 1;
  if (p.me.knows === 'blank') return 0;
  const { live, total } = p.magazine;
  if (total <= 0) return 0;
  return live / total;
}

/** 信息熵（0=完全确定，1=最不确定），决定放大镜等道具的价值 */
function uncertainty(pLive) {
  return 4 * pLive * (1 - pLive);
}

/* ---------------------------- 评估 ---------------------------- */

/** 对手威胁度：血多、牌多、刚打过我 → 更该先解决 */
function threatOf(p, target, memory) {
  let s = target.hp * W.hpThreat + target.handCount * W.handThreat;
  s += (memory.grudges[target.id] || 0) * W.grudgeWeight;
  if (isNextToAct(p, target)) s += W.nextSeatBonus;
  return s;
}

/** 对手中谁在我之后最先行动 */
function isNextToAct(p, target) {
  const alive = p.players.filter((x) => x.alive).sort((a, b) => a.seat - b.seat);
  if (alive.length < 2) return false;
  const idx = alive.findIndex((x) => x.id === p.me.id);
  if (idx < 0) return false;
  return alive[(idx + 1) % alive.length].id === target.id;
}

/** 自伤风险系数：血越少越保守 */
function selfRisk(p) {
  return W.selfRiskBase + (MAX_HP - p.me.hp) * W.selfRiskPerMissingHp;
}

/** 最强的对手是谁（按威胁度） */
function strongestOpponent(p, memory) {
  const list = p.players.filter((x) => x.alive && x.id !== p.me.id);
  if (!list.length) return null;
  return list.reduce((best, x) =>
    threatOf(p, x, memory) > threatOf(p, best, memory) ? x : best
  );
}

/**
 * 给一个合法动作打分。分数越高越想执行。
 * @returns {{score:number, reason:string}}
 */
function scoreAction(p, action, memory, pLive) {
  const me = p.me;
  const dmg = p.saw ? SAW_DAMAGE : BASE_DAMAGE;
  const risk = selfRisk(p);

  /* ---- 开枪 ---- */
  if (action.type === 'shoot') {
    const target = p.players.find((x) => x.id === action.targetId);
    if (!target) return { score: -Infinity, reason: '目标不存在' };

    if (target.id === me.id) {
      // 打自己：中弹自己掉血，空弹保留回合
      const ev = (1 - pLive) * W.keepTurn * (1 + 0.15 * p.magazine.blank) - pLive * dmg * risk * W.selfDamageScale;
      return {
        score: ev,
        reason: pLive === 0
          ? '已知空弹，打自己保住回合'
          : `赌空弹（空弹概率 ${Math.round((1 - pLive) * 100)}%）`,
      };
    }
    // 打别人：中弹造成伤害，空弹白交回合
    const kill = target.hp <= dmg;
    const gain = kill ? W.kill : threatOf(p, target, memory);
    const ev = pLive * gain - (1 - pLive) * W.wasteTurn;
    return {
      score: ev,
      reason: kill && pLive > 0.5 ? '有机会击杀' : `打 ${target.name}（实弹概率 ${Math.round(pLive * 100)}%）`,
    };
  }

  /* ---- 用道具 ---- */
  if (action.type !== 'use') return { score: -Infinity, reason: '未知动作' };
  const item = action.item;

  switch (item) {
    case 'magnifier': {
      // 只有「不确定」时才值得看；已经知道就毫无价值
      if (me.knows) return { score: -0.5, reason: '已经知道这一发' };
      const ev = uncertainty(pLive) * 3.2 + 0.4;
      return { score: ev, reason: '看一发子弹，降低不确定性' };
    }

    case 'cigarette': {
      const missing = MAX_HP - me.hp;
      if (missing <= 0) return { score: -1, reason: '满血，抽了也浪费' };
      return { score: missing * 0.9 + (me.hp <= 2 ? 1.5 : 0), reason: `回血（差 ${missing} 点满）` };
    }

    case 'handsaw': {
      // 实弹概率越高、对手血越多，锯短枪管越赚
      const best = strongestOpponent(p, memory);
      if (!best) return { score: -1, reason: '没有对手' };
      const canKill = best.hp <= SAW_DAMAGE;
      if (me.knows === 'live') return { score: canKill ? 6 : 4.5, reason: '已知实弹，翻倍伤害' };
      if (me.knows === 'blank') return { score: -1, reason: '已知空弹，锯了浪费' };
      const ev = pLive * (canKill ? 3.5 : 2.2) - (1 - pLive) * 1.8;
      return { score: ev, reason: '赌这一发是实弹，加倍伤害' };
    }

    case 'beer': {
      // 退弹 = 跳过这一发并保留回合。已知空弹时不如直接打自己，已知实弹时不如打别人。
      if (me.knows === 'live') return { score: 1.2, reason: '已知实弹，退掉换个机会' };
      if (me.knows === 'blank') return { score: -1, reason: '已知空弹，打自己更赚' };
      const ev = pLive * 2.4 - (1 - pLive) * 2.0;
      return { score: ev, reason: '退掉这一发，避开风险' };
    }

    case 'inverter': {
      // 逆转器只有在「知道当前是什么」时才真正强
      if (me.knows === 'blank') return { score: 5.5, reason: '已知空弹，逆转成实弹打人' };
      if (me.knows === 'live') return { score: 3.2, reason: '已知实弹，逆转成空弹保命' };
      return { score: 0.2, reason: '盲用逆转器，收益有限' };
    }

    case 'handcuffs': {
      const target = p.players.find((x) => x.id === action.targetId);
      if (!target || target.cuffed) return { score: -1, reason: '目标已被铐' };
      const ev = 3.2 + (isNextToAct(p, target) ? 1.6 : 0) + threatOf(p, target, memory) * 0.12;
      return {
        score: ev,
        reason: isNextToAct(p, target) ? '铐住下一个行动的人' : `铐住威胁最大的 ${target.name}`,
      };
    }

    case 'adrenaline': {
      const target = p.players.find((x) => x.id === action.targetId);
      if (!target) return { score: -1, reason: '目标不存在' };
      if (target.handCount === 0) return { score: -0.5, reason: '对方没有牌可偷' };
      // 偷牌永远不亏，但优先偷牌多的、威胁大的
      return { score: 2.4 + target.handCount * 0.25, reason: `偷 ${target.name} 的牌` };
    }

    default:
      return { score: -Infinity, reason: '未知道具' };
  }
}

/* ---------------------------- 主决策 ---------------------------- */

/**
 * 决策核心：不关心视野是来自房主状态还是客户端视图，逻辑完全一致。
 *
 * @param {object} p        perceive() / perceiveView() 产生的视野
 * @param {object} memory   记忆
 * @param {() => number} rngNext 取 [0,1) 随机数（用于小幅扰动）
 * @returns {{action:object, reason:string}|null} null 表示没有合法动作
 */
function decideFrom(p, memory, rngNext) {
  if (p.phase !== 'playing' || !p.legal.length) return null;

  // 1) 需要二次指定目标（肾上腺素偷到手铐）
  const targetOnly = p.legal.filter((a) => a.type === 'target');
  if (targetOnly.length) {
    const best = strongestOpponent(p, memory);
    const pick = targetOnly.find((a) => a.targetId === best?.id) || targetOnly[0];
    return { action: pick, reason: '指定被铐的人' };
  }

  const pLive = liveProbability(p);

  // 2) 枚举所有合法动作并打分
  let best = null;
  for (const action of p.legal) {
    const { score, reason } = scoreAction(p, action, memory, pLive);
    if (!Number.isFinite(score)) continue;
    // 小幅随机：让 AI 不至于每局都走出完全一样的一手棋
    const noisy = score + (rngNext() - 0.5) * W.noise * 2;
    if (!best || noisy > best.noisy) best = { noisy, action, score, reason };
  }
  if (!best) {
    // 理论上不会发生（开枪永远是合法动作），兜底避免死锁
    return { action: p.legal[0], reason: '兜底动作' };
  }
  return { action: best.action, reason: best.reason };
}

/**
 * 决定当前玩家这一步做什么（房主端：手里有完整状态）。
 *
 * @param {object} state    权威状态（AI 只会读取其中的公开字段）
 * @param {string} playerId 该 AI 的 id
 * @param {object} memory   createAiMemory() 产生的记忆对象
 */
export function aiDecide(state, playerId, memory) {
  updateMemory(state.log, playerId, memory);
  return decideFrom(perceive(state, playerId), memory, state.rng.next);
}

/**
 * 决定动作（客户端端：手里只有裁剪后的视图）。
 * 与 aiDecide 共用同一套评分逻辑，永远不会看到别人的手牌或弹序。
 */
export function aiDecideFromView(view, memory, rngNext = Math.random) {
  updateMemory(view.log || [], view.me.id, memory);
  return decideFrom(perceiveView(view), memory, rngNext);
}

/**
 * 本作人机用的**单字名字池**。
 *
 * 为什么是 export 而不是内部常量：在线房间的人机座位由**平台**命名
 * （`server/rooms.mjs` 的 `pickBotName(meta.botNames, …)`），而 `meta.botNames`
 * 就在 `server/games/shell-gambit.mjs` 里。两边必须是**同一份池子** ——
 * 单机里的电脑叫「虎」，联机里的人机座位也叫「虎」，玩家看到的才是同一批脸
 * （`shared/protocol.mjs` 的 BOT_NAMES 注释里也是这么说的）。
 * 抄一份字面量到服务端接入层就会分叉，所以这里导出、那边 import。
 *
 * 零 DOM 不受影响：导出一个常量数组不需要任何宿主 API（铁律一只管别碰 DOM）。
 */
export const AI_NAME_POOL = '虎狼鹰豹蛇狐枭鲨鲸隼'.split('');

/**
 * 生成 AI 用的单字名字（与真人名字冲突时自动换字）。
 */
export function pickAiName(used = []) {
  const free = AI_NAME_POOL.filter((c) => !used.includes(c));
  const pool = free.length ? free : AI_NAME_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}