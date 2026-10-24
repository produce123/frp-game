/**
 * BladeSteed — 单机人机对局的驱动
 *
 * 单机与联机的区别**只有一处**：谁在推进引擎。
 *   · 联机：服务端进程里的引擎（server/games/blade-steed.mjs），客户端只发意图、收视图
 *   · 单机：这个文件，在浏览器里推进**同一个引擎**（js/engine/engine.js）
 *
 * 所以「单机能玩、联机不能玩」的分歧在结构上不存在：
 *   · 渲染：两边都只把 viewFor(...) 的产物交给 js/ui/board.js
 *   · 操作：两边都走 engine.handleAct 的同一套意图信封
 *   · AI：aiStep 只吃 viewFor(engine, aiId)，和真人客户端收到的是同一档裁剪
 *     （给 AI 的那一档视图里**没有** isAI —— 带身份标记的那一档只发给玩家，
 *      见 js/view.js 顶部。所以 AI 不可能知道谁是真人，它不是"不看"，是拿不到）
 *
 * ⚠️ 这个文件**不是**纯状态机（它用 setTimeout/setInterval），所以它放在 ui/ 而不是 engine/。
 * engine/ 与 ai/ 必须保持零 DOM、零定时器，才能被服务器直接 import（docs/GAME-SPEC.md 铁律一）。
 */

import { Match } from '../engine/engine.js';
import { viewFor } from '../view.js';
import { PHASE } from '../engine/constants.js';
import { aiStep, makeBrains, pickAiName } from '../ai/ai.js';

/** 推进超时的节拍（和原项目一致：250ms 足够准，也不费电） */
const TICK_MS = 250;

export class LocalMatch {
  /**
   * @param {object} opts
   * @param {{id:string,name:string}} opts.me 我（来自平台账号，不再问名字）
   * @param {number} opts.size 本局人数 2–4，其余席位由 AI 补
   * @param {() => void} opts.onUpdate 任何状态变化（含 AI 落子）后回调
   */
  constructor({ me, size, onUpdate }) {
    this.onUpdate = onUpdate || (() => {});
    this.me = { id: me.id, name: me.name };
    this.size = Math.max(2, Math.min(4, Number(size) || 4));
    this._timer = null;
    this._aiTimer = null;
    this._stopped = true;
    this._reset();
  }

  _reset() {
    const roster = [{ id: this.me.id, name: this.me.name }];
    for (let i = 1; i < this.size; i++) {
      roster.push({
        id: `AI${i}`,
        // 单机的对手用汉字单字名（虎/狼/鹰…）。**这不是隐瞒身份** ——
        // 单机只有你一个人，你本来就知道对面是电脑；名字是味道。
        // 在线房间的人机座位用的是**同一个名字池**（`js/ai/ai.js` 的 `AI_NAME_POOL`，
        // 经 `meta.botNames` 交给房间层挑字，见 server/games/blade-steed.mjs）。
        name: pickAiName(roster.map((p) => p.name)),
        isAI: true,
      });
    }
    this.engine = new Match({ players: roster });
    this.brains = makeBrains(this.engine.players);
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._timer = setInterval(() => {
      if (this.engine.tick()) this.notify();
    }, TICK_MS);
    this._scheduleAi();
    this.notify();
  }

  stop() {
    this._stopped = true;
    clearInterval(this._timer);
    clearTimeout(this._aiTimer);
    this._timer = null;
    this._aiTimer = null;
  }

  /** 一键重新开局：座位重洗、血量装备全重置；AI 性格由 id 决定，所以还是那几个人 */
  restart() {
    this._reset();
    if (this._stopped) this.start();
    else this.notify();
  }

  /* ------------------------------ 输入 ------------------------------ */

  /** 我看到的视图（**必须**过 viewFor 这一道，铁律二） */
  view() {
    return viewFor(this.engine, this.me.id);
  }

  /**
   * 接一个意图信封（和联机发给服务端的是同一种对象）。
   * @returns {{ok:true}|{ok:false,message:string}}
   */
  handle(act) {
    if (this.engine.phase === PHASE.OVER && act && act.kind !== 'tick') {
      return { ok: false, message: '本局已经结束了' };
    }
    const r = this.engine.handleAct(this.me.id, act);
    if (r.ok) this.notify();
    return r;
  }

  notify() {
    this.onUpdate();
    this._scheduleAi();
  }

  /* ------------------------------ AI 调度 ------------------------------ */

  hasPendingAi() {
    const e = this.engine;
    if (e.phase === PHASE.RPS && e.rps) return e.alive().some((p) => p.isAI && !e.rps.submitted[p.id]);
    if (e.phase === PHASE.ORDER && e.mini) {
      if (e.mini.decider) return e.player(e.mini.decider)?.isAI === true;
      return e.mini.candidates.some((id) => e.player(id)?.isAI && !e.mini.submitted[id]);
    }
    if (e.phase === PHASE.ACTION) return e.player(e.current)?.isAI === true;
    return false;
  }

  /**
   * AI 出手前的停顿。
   * 不是为了"像人"，而是为了让真人**看清**刚才发生了什么：
   * 瞬间刷屏的话，你根本不知道是谁出的拳、谁砍了谁。
   */
  _aiDelay() {
    const e = this.engine;
    if (e.phase === PHASE.RPS && e.rps) {
      return e.alive().some((p) => p.isAI && !e.rps.submitted[p.id]) ? 900 + Math.random() * 900 : null;
    }
    if (e.phase === PHASE.ORDER && e.mini) {
      if (e.mini.decider) return e.player(e.mini.decider)?.isAI ? 800 + Math.random() * 500 : null;
      if (e.mini.candidates.some((id) => e.player(id)?.isAI && !e.mini.submitted[id])) {
        return 700 + Math.random() * 700;
      }
      return null;
    }
    if (e.phase === PHASE.ACTION && e.player(e.current)?.isAI) return 650 + Math.random() * 550;
    return null;
  }

  _scheduleAi() {
    if (this._stopped || this._aiTimer) return;
    const delay = this._aiDelay();
    if (delay == null) return;
    this._aiTimer = setTimeout(() => {
      this._aiTimer = null;
      if (this._stopped) return;
      // aiStep 内部会自己 viewFor(engine, aiId) —— AI 拿到的和真人看到的一样多（同一档裁剪）
      const acted = aiStep(this.engine, this.brains, viewFor);
      if (acted) this.notify();
      else this._scheduleAi();
    }, delay);
  }
}