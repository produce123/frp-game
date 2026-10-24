/**
 * BladeSteed 刀马 — 游戏引擎（纯逻辑，零 DOM）
 *
 * 这里是全游戏唯一的权威状态机。UI、AI、联机三边都只调用它，
 * 所以「房主校验后广播」在结构上就是成立的：客人改前端改不出任何东西。
 *
 * 规则（与需求书一一对应）：
 *   · 每人固定 10 滴血，血 ≤0 立即出局，最后活着的人获胜。
 *   · 开局全员在【自己的城内】，可以无前置条件直接出城。
 *   · 买刀 / 买马：只在【城内】能买（任意城，含别人的城），永久持有，消耗 1 步。
 *   · 刀：需已买刀，双方【同一位置】（同城或同在野外），扣 1 血。
 *   · 踹：需已买马，双方【同在同一个城内】，扣 3 血并强制把对方踢到野外。
 *   · 每回合全员同步猜拳：
 *       1 人获胜 → 该玩家 2 步；
 *       ≥2 人获胜 → 各 1 步，并进入「小猜拳」逐轮淘汰出唯一决胜者，
 *                    由决胜者决定全部赢家的行动先后顺序；
 *       无人获胜 → 重新猜拳。
 *   · 每 1 步只能做 1 个操作，2 步可自由组合任意两个操作；也可以主动结束剩余步数。
 *
 * 时间：所有超时都靠 tick() 驱动，注入 now() 就能在测试里用假时钟，
 *       不需要真的等 10 秒。
 */

import {
  ACT,
  ACTION_TIMEOUT_MS,
  BEATS,
  KEEP_EVENTS,
  KEEP_LOG,
  MAX_HP,
  MAX_PLAYERS,
  MIN_SEATS,
  ORDER_TIMEOUT_MS,
  PHASE,
  RPS,
  RPS_LABEL,
  RPS_TIMEOUT_MS,
  STEPS_MULTI,
  STEPS_SOLO,
  WILD,
  isCity,
} from './constants.js';
import { makeRng, seedFromNow } from './rng.js';
import { legalActionsFrom } from './rules.js';

/**
 * 把引擎内部的 `{ ok, error }` 统一成平台要的 `{ ok, message }`。
 * 为什么要在这一层转：`message` 会**直接显示给玩家**（见 docs/GAME-SPEC.md 第 4 节），
 * 而引擎内部用的字段名是 `error`。转换只写一次，就不会有人漏转。
 */
function wrapResult(r) {
  if (r && r.ok) return { ok: true };
  return { ok: false, message: (r && r.error) || '这个操作现在不合法' };
}

/* ============================================================================
 * 逐步同步：每条事件都带一份「这一步之后的公开状态补丁」（字段名 `s`）
 * ============================================================================
 *
 * 【为什么要有它】以前界面一收到 room.state 就按**最终**状态把地图/状态条/行动面板画出来，
 * 只有"特效 + 播报"排进演出队列 —— 于是演出还在演、数字已经是结果了。用户报的两条
 * （"对方的刀、马已经亮起来了""位置移动直接瞬移过去了"）都是这个根因，见 D14。
 *
 * 现在：引擎在**推事件的那一刻**记一份"这一步之后的公开状态"，和上一条事件的那一份做差，
 * 只把**变了**的字段挂在事件上（`s`）。界面演到第几步，就把第几步的补丁贴到画面上。
 *
 * ⛔ **客户端绝不许照事件自己算**（那是在界面里重写一遍规则，违反铁律三）：补丁里的每个
 *    数字都是引擎算好的，界面只负责盖上去。
 * ⛔ **没揭晓的猜拳选择绝不进报文**：下面 `_publicRps/_publicMini` 里的 `submitted` 是
 *    「谁出了什么」的完整表，它**只在进程内存里活一下**，出报文前由 `js/view.js` 按看的人
 *    裁成 `ready`（只有布尔）+ `myChoice`（只有他自己那一手）—— 和主视图用的是同一套裁剪。
 *    测试里有一条"把整份报文 JSON 化搜别人的选择"，命中必须是 0。
 */

/** 一个座位的**公开**字段（本局这些字段本来就在视图里，藏了反而没法玩）。 */
function publicPlayer(p) {
  return { id: p.id, hp: p.hp, alive: p.alive, place: p.place, knife: p.knife, horse: p.horse };
}

/**
 * 猜拳窗口的公开快照（引擎内部用；出报文前由 js/view.js 裁成"单数个人"的那一份）。
 * `submitted` 是"谁出了什么"的完整表 —— 它只在进程内存里活一下，见文件头。
 */
function publicRps(rps, aliveIds) {
  if (!rps) return null;
  return {
    round: rps.round,
    winners: rps.winners.slice(),
    /** 有可能出拳的人（视图里的 ready 只列这些人） */
    ids: aliveIds.slice(),
    /** ⚠️ 私有表：别人的拳。出报文前由 js/view.js 裁掉（见文件头） */
    submitted: { ...rps.submitted },
  };
}

/** 小猜拳窗口的公开快照（`submitted` 同样是私有表，见上面）。 */
function publicMini(mini) {
  if (!mini) return null;
  return {
    round: mini.round,
    candidates: mini.candidates.slice(),
    decider: mini.decider,
    submitted: { ...mini.submitted },
  };
}

export class Match {
  /**
   * @param {object} opts
   * @param {{id:string,name:string,isAI?:boolean}[]} opts.players 2–4 个座位（含 AI 座位）
   * @param {number} [opts.seed]  可复现随机种子
   * @param {() => number} [opts.now] 时钟注入（测试用假时钟）
   */
  constructor({ players, seed, now }) {
    this.now = now || (() => Date.now());
    this.rng = makeRng(seed ?? seedFromNow());
    this.seed = seed ?? null;
    this._init(players);
  }

  /* ============================ 初始化 ============================ */

  _init(players) {
    const list = players.map((p) => ({ id: String(p.id), name: String(p.name), isAI: !!p.isAI }));
    // ⚠️ 卡的是「座位数」（MIN_SEATS = 2），不是「房间要几个真人」（MIN_PLAYERS = 1）。
    //    1 个座位的对局永远分不出胜负，所以"一个人开局"由接入层补 AI 座位来满足。
    if (list.length < MIN_SEATS || list.length > MAX_PLAYERS) {
      throw new Error(`人数必须是 ${MIN_SEATS}–${MAX_PLAYERS} 个座位（含电脑补位）`);
    }
    const ids = new Set(list.map((p) => p.id));
    if (ids.size !== list.length) throw new Error('玩家 id 重复');

    // 开局随机分配座位（1,2,3,4）——座位只决定地图上的摆放位置
    const seats = list.map((_, i) => i + 1);
    this.rng.shuffle(seats);

    this.players = list.map((p, i) => ({
      id: p.id,
      name: p.name,
      isAI: p.isAI,
      seat: seats[i],
      hp: MAX_HP,
      alive: true,
      knife: false,
      horse: false,
      /** 开局默认在【自己城内】：place 就是自己的 id；'wild' 表示野外 */
      place: p.id,
    }));

    this.rev = 0;
    this.events = [];
    // 事件 / 播报编号跨局保持单调递增：
    // 「一键重新开局」后客户端还在用旧的 lastEventId，编号归零会让它把所有新事件当成旧的丢掉。
    this._eventId = this._eventId || 0;
    this.log = [];
    this._logId = this._logId || 0;

    this.round = 1;
    this.phase = PHASE.RPS;
    this.winner = null;
    this.mainWinners = [];
    this.steps = {};
    this.queue = [];
    this.current = null;
    this.stepsLeft = 0;
    this.actionDeadline = 0;
    this.rps = null;
    this.mini = null;

    // 逐步同步用的一样东西（见 _pubSnapshotNow / _pubDiff）：
    //   _pubSnapshot —— 上一条事件那一刻的公开状态，补丁按它做差（只记变了的字段）。
    //   每次 _init 都清成 null，所以"重新开局"后的第一条事件补丁是全量。
    this._pubSnapshot = null;

    this._pushEvent({ t: 'round', round: 1 });
    this._log(`第 1 回合开始，全员猜拳`);
    this._startRps();
  }

  /** 一键重新开局：沿用同一批玩家，血量装备座位全部重置 */
  restart() {
    const roster = this.players.map((p) => ({ id: p.id, name: p.name, isAI: p.isAI }));
    this.rng = makeRng(seedFromNow());
    this._init(roster);
    return this;
  }

  /* ============================ 小工具 ============================ */

  nowMs() {
    return this.now();
  }

  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  alive() {
    return this.players.filter((p) => p.alive);
  }

  name(id) {
    const p = this.player(id);
    return p ? p.name : '?';
  }

  _touch() {
    this.rev += 1;
  }

  _pushEvent(ev) {
    const entry = { id: ++this._eventId, ...ev };
    /*
     * 逐步同步（见文件头）：
     *   `s`       = 这一步之后的公开状态补丁（和上一条事件那份快照做差，只记变了的字段）
     *   `logUpTo` = 这一刻已经写好到哪一条播报（**播报的编号**，不是条数）。
     *               为什么用编号不用条数：`state.log` 只有最后 KEEP_LOG 条（会被裁掉），
     *               条数一裁就对不上号了；编号是单调递增的，界面只要"显示 id ≤ logUpTo 的那些"。
     *               取 0 = 此刻还没有任何播报。
     */
    const snap = this._pubSnapshotNow();
    entry.s = this._pubDiff(this._pubSnapshot, snap);
    entry.logUpTo = this.log.length ? this.log[this.log.length - 1].id : 0;
    this._pubSnapshot = snap;
    this.events.push(entry);
    if (this.events.length > KEEP_EVENTS) this.events.splice(0, this.events.length - KEEP_EVENTS);
  }

  _log(text) {
    const entry = { id: ++this._logId, round: this.round, text };
    this.log.push(entry);
    if (this.log.length > KEEP_LOG) this.log.splice(0, this.log.length - KEEP_LOG);
    /*
     * 播报按步出现：把"已经写好的最后一条播报编号"记在**最近那条事件**上。
     *
     * 【为什么在这里补一刀】引擎里的顺序几乎都是"先 `_pushEvent(结果)`、紧跟一句 `_log(人话)`"
     * （刀砍完了才知道播报怎么写）。如果只在 `_pushEvent` 里记，每条播报都会**晚一步**出现
     * （砍人那一步只飘血、下一句才打字），看起来就是"文字和画面对不上"。
     * 所以：事件推出去之后紧接着写的那条播报，算在**这条事件**头上；没有对应事件的那几条
     * 播报会被下一条事件的 `_pushEvent` 收进去（那两处合起来保证一条播报都不会丢）。
     */
    const last = this.events[this.events.length - 1];
    if (last) last.logUpTo = entry.id;
  }

  /** 把这一刻的公开状态抄成一份快照（补丁就是两份快照的差） */
  _pubSnapshotNow() {
    const alive = this.alive().map((p) => p.id);
    return {
      phase: this.phase,
      round: this.round,
      current: this.current,
      stepsLeft: this.stepsLeft,
      winner: this.winner,
      mainWinners: this.mainWinners.slice(),
      steps: { ...this.steps },
      queue: this.queue.slice(),
      players: this.players.map(publicPlayer),
      rps: publicRps(this.rps, alive),
      mini: publicMini(this.mini),
    };
  }

  /**
   * 两份快照做差：**只记变了的东西**（补丁要小，而且"没变的字段不覆盖"正是逐步演出的前提）。
   * `prev` 为 null（开局第一条 / 换了一局）时等于全量。
   *
   * ⚠️ 别往这里加"按时间走的字段"（比如各种 deadlineIn）：它们每毫秒都在变，
   *    补丁会变成"每条事件都是全量"，而且逐步演出也不需要它 —— 倒计时由 `board.js` 在
   *    **队列演完之后**单独按服务器给的真实剩余显示（见第 12 条约定）。
   */
  _pubDiff(prev, next) {
    const out = {};
    for (const k of ['phase', 'round', 'current', 'stepsLeft', 'winner']) {
      if (!prev || prev[k] !== next[k]) out[k] = next[k];
    }
    for (const k of ['mainWinners', 'steps', 'queue']) {
      if (!prev || JSON.stringify(prev[k]) !== JSON.stringify(next[k])) out[k] = next[k];
    }
    for (const k of ['rps', 'mini']) {
      if (!prev || JSON.stringify(prev[k]) !== JSON.stringify(next[k])) out[k] = next[k];
    }
    if (!prev) {
      out.players = next.players;
    } else {
      // 只带"变了的那几个人"（补丁小、而且是按 id 合进画面的那一份）
      const changed = next.players.filter((p) => {
        const old = prev.players.find((x) => x.id === p.id);
        return !old || JSON.stringify(old) !== JSON.stringify(p);
      });
      if (changed.length) out.players = changed;
    }
    return out;
  }

  /**
   * 猜拳判定：只出现 1 种或 3 种手势都算「无人获胜」，
   * 恰好 2 种时，被克制的那一方全输、克制方全部获胜。
   * @returns {string[]} 获胜者 id
   */
  _rpsWinners(submitted, ids) {
    const picks = {};
    for (const id of ids) if (submitted[id]) picks[id] = submitted[id];
    const types = new Set(Object.values(picks));
    if (types.size !== 2) return [];
    const [a, b] = [...types];
    const win = BEATS[a] === b ? a : BEATS[b] === a ? b : null;
    if (!win) return [];
    return ids.filter((id) => picks[id] === win);
  }

  /* ============================ 猜拳阶段 ============================ */

  _startRps() {
    this.phase = PHASE.RPS;
    this.mini = null;
    this.mainWinners = [];
    this.steps = {};
    this.queue = [];
    this.current = null;
    this.stepsLeft = 0;
    this.actionDeadline = 0;
    this.rps = {
      round: this.round,
      submitted: {},
      winners: [],
      deadline: this.now() + RPS_TIMEOUT_MS,
    };
    this._pushEvent({ t: 'rps-start', round: this.round, deadlineIn: RPS_TIMEOUT_MS });
    this._touch();
  }

  /**
   * 提交猜拳手势。主猜拳和小猜拳共用这一个入口
   * （客户端不需要知道现在是哪一层，照着 phase 出拳就行）。
   * @param {string} pid
   * @param {'rock'|'scissors'|'paper'} choice
   */
  submitRps(pid, choice) {
    if (!RPS.includes(choice)) return { ok: false, error: '手势不合法' };
    const p = this.player(pid);
    if (!p || !p.alive) return { ok: false, error: '你已经不在场上了' };

    if (this.phase === PHASE.RPS) {
      // 重发幂等：同一个人重复提交同一手势视为成功
      if (this.rps.submitted[pid]) {
        return this.rps.submitted[pid] === choice
          ? { ok: true, duplicate: true }
          : { ok: false, error: '本回合已经出过拳了' };
      }
      this.rps.submitted[pid] = choice;
      this._pushEvent({ t: 'rps-pick', pid });
      this._touch();
      this._maybeResolveRps();
      return { ok: true };
    }

    if (this.phase === PHASE.ORDER && this.mini && !this.mini.decider) {
      if (!this.mini.candidates.includes(pid)) return { ok: false, error: '你不在小猜拳名单里' };
      if (this.mini.submitted[pid]) {
        return this.mini.submitted[pid] === choice
          ? { ok: true, duplicate: true }
          : { ok: false, error: '这一轮已经出过拳了' };
      }
      this.mini.submitted[pid] = choice;
      this._pushEvent({ t: 'mini-pick', pid });
      this._touch();
      this._maybeResolveMini();
      return { ok: true };
    }

    return { ok: false, error: '现在不是猜拳阶段' };
  }

  _maybeResolveRps() {
    if (this.phase !== PHASE.RPS || !this.rps) return;
    if (this.alive().some((p) => !this.rps.submitted[p.id])) return;
    this._resolveRps();
  }

  _resolveRps() {
    const ids = this.alive().map((p) => p.id);
    const choices = { ...this.rps.submitted };
    const winners = this._rpsWinners(choices, ids);
    this.rps.winners = winners;
    this._pushEvent({ t: 'rps-reveal', choices, winners });

    if (winners.length === 0) {
      this._log(`${this.round} 回合：无人获胜，重新猜拳`);
      this._startRps();
      return;
    }

    this.mainWinners = winners;
    for (const id of winners) this.steps[id] = winners.length === 1 ? STEPS_SOLO : STEPS_MULTI;

    if (winners.length === 1) {
      const w = winners[0];
      this._log(`${this.name(w)} 获胜（独自赢），获得 2 步行动`);
      this._beginAction([w]);
      return;
    }

    this._log(
      `${winners.map((id) => this.name(id)).join('、')} 共 ${winners.length} 人获胜，各 1 步；` +
        `先小猜拳决出谁来决定行动顺序`
    );
    this._startMini(winners.slice());
    this._touch();
  }

  /* ======================= 小猜拳 / 行动顺序 ======================= */

  _startMini(candidates) {
    const prevRound = this.mini ? this.mini.round : 0;
    this.phase = PHASE.ORDER;
    this.mini = {
      round: prevRound + 1,
      candidates: candidates.slice(),
      submitted: {},
      winners: [],
      decider: null,
      deadline: this.now() + RPS_TIMEOUT_MS,
    };
    this._pushEvent({ t: 'mini-start', candidates: candidates.slice(), round: this.mini.round });
    this._touch();
  }

  _maybeResolveMini() {
    if (this.phase !== PHASE.ORDER || !this.mini || this.mini.decider) return;
    const cands = this.mini.candidates.filter((id) => this.player(id)?.alive);
    if (cands.some((id) => !this.mini.submitted[id])) return;
    this._resolveMini();
  }

  _resolveMini() {
    const cands = this.mini.candidates.filter((id) => this.player(id)?.alive);
    if (cands.length === 0) {
      this._beginAction(this.mainWinners.filter((id) => this.player(id)?.alive));
      return;
    }
    const choices = { ...this.mini.submitted };
    const winners = this._rpsWinners(choices, cands);
    this.mini.winners = winners;
    this._pushEvent({ t: 'mini-reveal', choices, winners });

    if (winners.length === 0) {
      this._log(`小猜拳无人获胜，重新猜拳`);
      this._startMini(cands);
      return;
    }
    if (winners.length === 1) {
      const d = winners[0];
      this.mini.decider = d;
      this.mini.deadline = this.now() + ORDER_TIMEOUT_MS;
      this._pushEvent({ t: 'order-decider', decider: d });
      this._log(`${this.name(d)} 在小猜拳中胜出，由他决定行动顺序`);
      this._touch();
      return;
    }
    this._log(`小猜拳 ${winners.map((id) => this.name(id)).join('、')} 同时获胜，继续猜`);
    this._startMini(winners);
  }

  /**
   * 决胜者提交行动顺序（必须是本轮全部赢家的一个排列）。
   * @param {string} pid
   * @param {string[]} order
   */
  submitOrder(pid, order) {
    if (this.phase !== PHASE.ORDER || !this.mini) return { ok: false, error: '现在不是排序阶段' };
    if (this.mini.decider !== pid) return { ok: false, error: '还没轮到你来决定顺序' };
    const valid = this.mainWinners.filter((id) => this.player(id)?.alive);
    if (!Array.isArray(order) || order.length !== valid.length) {
      return { ok: false, error: '顺序必须包含本轮全部赢家' };
    }
    const seen = new Set(order);
    if (seen.size !== order.length) return { ok: false, error: '顺序里有重复的人' };
    if (!order.every((id) => valid.includes(id))) return { ok: false, error: '顺序里有不在本轮赢家里的人' };

    this._pushEvent({ t: 'order', decider: pid, order: order.slice() });
    this._log(`${this.name(pid)} 决定的行动顺序：${order.map((id) => this.name(id)).join(' → ')}`);
    this._beginAction(order.slice());
    return { ok: true };
  }

  /* ============================ 行动阶段 ============================ */

  _beginAction(order) {
    const list = [];
    for (const id of order) {
      const p = this.player(id);
      if (p && p.alive && !list.includes(id)) list.push(id);
    }
    if (list.length === 0) {
      this._startRps();
      return;
    }
    this.phase = PHASE.ACTION;
    this.mini = null;
    this.queue = list.slice();
    this.current = list[0];
    this.stepsLeft = this.steps[this.current] ?? STEPS_MULTI;
    this.actionDeadline = this.now() + ACTION_TIMEOUT_MS;
    this._pushEvent({ t: 'turn', pid: this.current, steps: this.stepsLeft });
    this._log(`轮到 ${this.name(this.current)} 行动（${this.stepsLeft} 步）`);
    this._touch();
  }

  /**
   * 列出某个玩家此刻所有合法动作。
   * UI 用它来决定按钮亮暗，AI 用它来当动作空间，引擎自己用它来校验 —— 三边同一份真相
   * （实现就在 engine/rules.js，这里只是把引擎自己的字段喂进去）。
   */
  legalActions(pid) {
    return legalActionsFrom({ phase: this.phase, current: this.current, players: this.players }, pid);
  }

  /**
   * 执行一个动作。房主校验后调用，客人永远改不动状态。
   * @param {string} pid
   * @param {{type:string,target?:string}} action
   */
  act(pid, action) {
    if (this.phase !== PHASE.ACTION) return { ok: false, error: '现在不是行动阶段' };
    if (this.current !== pid) return { ok: false, error: '还没轮到你行动' };
    const me = this.player(pid);
    if (!me || !me.alive) return { ok: false, error: '你已经不在场上了' };

    const type = action && action.type;
    const target = (action && action.target) || null;
    const found = this.legalActions(pid).find((a) => a.type === type && (a.target || null) === target);
    if (!found) return { ok: false, error: '这个操作现在不合法' };
    return this._applyAction(pid, found);
  }

  /**
   * 玩家操作「意图信封」的**唯一入口**（服务端与单机人机共用同一份）。
   *
   * 平台只认一种消息：`room.act { act }`，而 `act` 长什么样由游戏自己定
   * （见 docs/ARCHITECTURE.md）。BladeSteed 的信封是：
   *   { kind: 'rps',   choice: 'rock' }           猜拳（主猜拳与小猜拳共用）
   *   { kind: 'order', order: ['b','a'] }         决胜者排行动顺序
   *   { kind: 'act',   type: 'knife', target:'b' } 行动阶段的一个操作
   *   { kind: 'tick' }                            心跳：只推进超时，不改变别的
   * 单机时由 js/ui/local.js 直接把同一个信封喂进来 —— 两条路走完完全全同一段代码，
   * 所以「单机能做、联机不能做」这类分歧在结构上就不存在。
   *
   * @returns {{ok:true}|{ok:false,message:string}} message 是可直接显示的中文
   */
  handleAct(pid, act) {
    const kind = act && act.kind;
    if (kind === 'rps') return wrapResult(this.submitRps(pid, act.choice));
    if (kind === 'order') return wrapResult(this.submitOrder(pid, act.order));
    if (kind === 'act') return wrapResult(this.act(pid, { type: act.type, target: act.target }));
    if (kind === 'tick') {
      // 平台的房间层**不替游戏驱动时钟**（server/rooms.mjs 里没有 tick 的钩子），
      // 所以超时得由客户端自己催：谁醒着谁来催，不依赖房主在线。
      // 客户端只在「本阶段快到点」时才发这一条（见 js/ui/app.js 的 _scheduleTick）。
      this.tick();
      return { ok: true };
    }
    return { ok: false, message: '不认识的操作' };
  }

  /** 真正落地的状态变更（合法性已经校验过） */
  _applyAction(pid, found) {
    const me = this.player(pid);
    const from = me.place;
    /*
     * ⚠️ **步数先扣、事件后推** —— 这个顺序别顺手换回去。
     *
     * 每条事件上的补丁（`s`）记的是"这一步**之后**的公开状态"（见文件头），而"还剩几步"
     * 正是玩家看完这一步马上要看到的东西。扣在事件之后的话，买刀那一步的补丁里没有步数：
     * 画面会先亮出刀、等下一步（450ms）才把"剩 1 步"改过来 —— 那半秒正是用户报过的
     * "演到第几步、画面却不是第几步"（见 docs/DECISIONS.md D14）。
     * 扣在事件之前，补丁就是完整的"这一步之后"，客户端什么都不用猜。
     *
     * `this.steps[pid]` 跟着一起更新：视图里的 `steps` 是**每个人还剩几步**（不是开局分了
     * 几步），`tests/rules.test.mjs` 的"补丁只带变了的字段"那条就按它判定。
     */
    this.stepsLeft = found.type === ACT.PASS ? 0 : Math.max(0, this.stepsLeft - 1);
    this.steps[pid] = this.stepsLeft;

    switch (found.type) {
      case ACT.BUY_KNIFE:
        me.knife = true;
        this._pushEvent({ t: 'buy', pid, item: 'knife' });
        this._log(`${me.name} 买了一把刀`);
        break;

      case ACT.BUY_HORSE:
        me.horse = true;
        this._pushEvent({ t: 'buy', pid, item: 'horse' });
        this._log(`${me.name} 买了一匹马`);
        break;

      case ACT.MOVE_OUT:
        me.place = WILD;
        this._pushEvent({ t: 'move', pid, from, to: WILD });
        this._log(`${me.name} 出城，去了野外`);
        break;

      case ACT.MOVE_IN: {
        me.place = found.target;
        this._pushEvent({ t: 'move', pid, from, to: found.target });
        this._log(`${me.name} 进城，进了 ${this.name(found.target)} 的城`);
        break;
      }

      case ACT.KNIFE: {
        const t = this.player(found.target);
        t.hp -= 1;
        this._pushEvent({ t: 'knife', pid, target: t.id, dmg: 1, hp: Math.max(0, t.hp) });
        this._log(`${me.name} 刀了 ${t.name}，${t.name} 掉 1 血（剩 ${Math.max(0, t.hp)}）`);
        if (t.hp <= 0) this._eliminate(t.id, `${me.name} 刀倒了`);
        break;
      }

      case ACT.KICK: {
        const t = this.player(found.target);
        t.hp -= 3;
        t.place = WILD; // 强制踢到野外
        this._pushEvent({ t: 'kick', pid, target: t.id, dmg: 3, hp: Math.max(0, t.hp), to: WILD });
        this._log(
          `${me.name} 踹了 ${t.name}，${t.name} 掉 3 血（剩 ${Math.max(0, t.hp)}）并被踢到野外`
        );
        if (t.hp <= 0) this._eliminate(t.id, `${me.name} 踹倒了`);
        break;
      }

      case ACT.PASS:
        this._pushEvent({ t: 'pass', pid });
        this._log(`${me.name} 结束了本回合的行动`);
        break;

      default:
        return { ok: false, error: '未知操作' };
    }

    this._touch();

    // 刚才这一下可能已经把人打死、直接结束了本局：那就**不要再交回合**
    // （`_eliminate` 那边已经把步数清零、也推了结算事件）。
    if (this.winner || this.phase === PHASE.OVER) {
      this.stepsLeft = 0;
      return { ok: true, events: this.events.slice(-6) };
    }

    this._advance();
    return { ok: true, events: this.events.slice(-6) };
  }

  /** 当前行动者用完步数（或死掉/超时）后，把回合交给下一位 */
  _advance() {
    if (this.winner) return;
    const cur = this.current ? this.player(this.current) : null;

    // 还有剩余步数：继续由他行动
    if (this.stepsLeft > 0 && cur && cur.alive) {
      this.actionDeadline = this.now() + ACTION_TIMEOUT_MS;
      this._pushEvent({ t: 'turn', pid: this.current, steps: this.stepsLeft });
      this._touch();
      return;
    }

    if (this.current) this.queue = this.queue.filter((id) => id !== this.current);
    this.current = null;
    while (this.queue.length && !this.player(this.queue[0])?.alive) this.queue.shift();

    if (this.queue.length === 0) {
      this._endRound();
      return;
    }

    this.current = this.queue[0];
    this.stepsLeft = this.steps[this.current] ?? STEPS_MULTI;
    this.actionDeadline = this.now() + ACTION_TIMEOUT_MS;
    this._pushEvent({ t: 'turn', pid: this.current, steps: this.stepsLeft });
    this._log(`轮到 ${this.name(this.current)} 行动（${this.stepsLeft} 步）`);
    this._touch();
  }

  _endRound() {
    const finished = this.round;
    this.round += 1;
    this._log(`第 ${finished} 回合结束`);
    this._startRps();
    this._log(`第 ${this.round} 回合开始，全员猜拳`);
    this._touch();
  }

  /* ============================ 淘汰 / 人数变动 ============================ */

  /**
   * 把一名玩家判出局（血空、主动退出、断连都走这里）。
   * 出局者的「城」永久保留，别人照样可以进城 —— 所以只动 alive 标记。
   */
  _eliminate(pid, reason) {
    const p = this.player(pid);
    if (!p || !p.alive) return;
    p.alive = false;
    if (p.hp > 0) p.hp = 0;
    this._pushEvent({ t: 'down', pid, reason: reason || '' });
    this._log(`${p.name} 出局（${reason || '离开'}）`);

    // 从各个阶段里把人清掉
    if (this.rps) delete this.rps.submitted[pid];
    if (this.mini) {
      this.mini.candidates = this.mini.candidates.filter((id) => id !== pid);
      delete this.mini.submitted[pid];
      if (this.mini.decider === pid) this.mini.decider = null;
    }
    this.queue = this.queue.filter((id) => id !== pid);

    // 胜负判定
    const left = this.alive();
    if (left.length <= 1) {
      this.winner = left[0] ? left[0].id : null;
      this.phase = PHASE.OVER;
      this.current = null;
      this.stepsLeft = 0;
      this.mini = null;
      this._pushEvent({ t: 'over', winner: this.winner });
      this._log(this.winner ? `${this.name(this.winner)} 是最后的幸存者，本局获胜！` : '本局无人存活');
      this._touch();
      return;
    }

    if (this.phase === PHASE.ACTION) {
      if (this.current === pid) {
        this.current = null;
        this.stepsLeft = 0;
        this._advance();
      }
    } else if (this.phase === PHASE.RPS) {
      this._maybeResolveRps();
    } else if (this.phase === PHASE.ORDER && this.mini) {
      if (this.mini.candidates.length === 1) {
        this.mini.decider = this.mini.candidates[0];
        this.mini.deadline = this.now() + ORDER_TIMEOUT_MS;
        this._pushEvent({ t: 'order-decider', decider: this.mini.decider });
        this._log(`${this.name(this.mini.decider)} 成为唯一人选，由他决定行动顺序`);
        this._touch();
      } else if (this.mini.candidates.length === 0) {
        this._beginAction(this.mainWinners.filter((id) => this.player(id)?.alive));
      } else {
        this._maybeResolveMini();
      }
    }
    this._touch();
  }

  /** 玩家主动离开 / 断连：直接判出局 */
  leave(pid) {
    if (!this.player(pid) || !this.player(pid).alive) return { ok: false, error: '不在场上' };
    this._eliminate(pid, '离开房间');
    return { ok: true };
  }

  /**
   * 中途加入一个新玩家（房主加 AI 补位用）。
   * 新玩家立刻出现在地图上，从**下一个猜拳回合**开始参与行动
   * （本轮已经定好的行动顺序不动，避免打乱正在进行的回合）。
   */
  addPlayer({ id, name, isAI = false }) {
    if (this.players.length >= MAX_PLAYERS) return { ok: false, error: `最多 ${MAX_PLAYERS} 人` };
    if (this.phase === PHASE.OVER) return { ok: false, error: '本局已结束，请先重新开局' };
    if (this.player(id)) return { ok: false, error: '这个人已经在房间里了' };

    const used = new Set(this.players.map((p) => p.seat));
    let seat = 1;
    while (used.has(seat)) seat += 1;
    const p = {
      id: String(id),
      name: String(name),
      isAI: !!isAI,
      seat,
      hp: MAX_HP,
      alive: true,
      knife: false,
      horse: false,
      place: String(id),
    };
    this.players.push(p);
    this._pushEvent({ t: 'join', pid: p.id });
    this._log(`${p.name} 加入了战场`);
    // 如果正卡在猜拳阶段，得等他出拳
    if (this.phase === PHASE.RPS) {
      // 什么都不用做：_maybeResolveRps 会自然地等他的提交
    }
    this._touch();
    return { ok: true, player: p };
  }

  /* ============================ 超时驱动 ============================ */

  /**
   * 心跳：推进所有超时逻辑。
   * 房主定时调用；测试里注入假时钟即可瞬间跑完整局。
   * @returns {boolean} 是否发生了状态变化
   */
  tick() {
    if (this.phase === PHASE.OVER) return false;
    const now = this.now();

    if (this.phase === PHASE.RPS && this.rps && now >= this.rps.deadline) {
      const missing = this.alive().filter((p) => !this.rps.submitted[p.id]);
      for (const p of missing) {
        this.rps.submitted[p.id] = this.rng.pick(RPS);
        this._pushEvent({ t: 'auto-pick', pid: p.id });
      }
      if (missing.length) this._log(`${missing.map((p) => p.name).join('、')} 超时未出拳，系统随机代出`);
      this._resolveRps();
      this._touch();
      return true;
    }

    if (this.phase === PHASE.ORDER && this.mini && now >= this.mini.deadline) {
      if (!this.mini.decider) {
        const missing = this.mini.candidates.filter((id) => !this.mini.submitted[id] && this.player(id)?.alive);
        for (const id of missing) {
          this.mini.submitted[id] = this.rng.pick(RPS);
          this._pushEvent({ t: 'auto-pick', pid: id });
        }
        if (missing.length) this._log('小猜拳有人超时，系统随机代出');
        this._maybeResolveMini();
        // 全场都不在场等极端情况：兜底直接开打
        if (!this.mini.decider && this.mini.candidates.length === 0) {
          this._beginAction(this.mainWinners.filter((id) => this.player(id)?.alive));
        }
      } else {
        const fallback = this.mainWinners
          .filter((id) => this.player(id)?.alive)
          .sort((a, b) => this.player(a).seat - this.player(b).seat);
        this._log(`${this.name(this.mini.decider)} 超时未决定顺序，按座位号自动排序`);
        this._beginAction(fallback);
      }
      this._touch();
      return true;
    }

    if (this.phase === PHASE.ACTION && now >= this.actionDeadline) {
      const cur = this.current ? this.player(this.current) : null;
      if (cur) this._log(`${cur.name} 行动超时，自动结束剩余步数`);
      this.stepsLeft = 0;
      this._advance();
      this._touch();
      return true;
    }

    return false;
  }

  /* ============================ 调试用 ============================ */

  /** 当前阶段还剩多少毫秒（房主内部用；对外的视图里已经换算过） */
  pendingDeadlineIn() {
    if (this.phase === PHASE.RPS && this.rps) return Math.max(0, this.rps.deadline - this.now());
    if (this.phase === PHASE.ORDER && this.mini) return Math.max(0, this.mini.deadline - this.now());
    if (this.phase === PHASE.ACTION) return Math.max(0, this.actionDeadline - this.now());
    return 0;
  }

  /** 一句话描述当前状态，测试失败时打出来好定位 */
  describe() {
    const seats = this.players
      .map((p) => `${p.seat}:${p.name}${p.alive ? '' : '(出局)'}${p.hp}血@${p.place}`)
      .join(' ');
    return `[${this.phase} 第${this.round}回合] ${seats} 当前=${this.current || '-'} 剩${this.stepsLeft}步`;
  }
}

export { PHASE, ACT, WILD, isCity, RPS_LABEL };