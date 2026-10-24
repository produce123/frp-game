/**
 * BladeSteed — AI 决策
 *
 * 三条硬约束，全部是结构上保证的，不靠自觉：
 *
 * 1. **AI 的输入里没有「我是 AI / 别人是真人」这个字段。**
 *    AI 的唯一输入是 viewFor(engine, aiId) —— 那是**不带身份标记**的那一档
 *    （js/view.js 顶部解释了两档的区别；带 isAI 的那一档只发给玩家）。
 *    服务端跑 AI 时递进去的也是同一个裸 viewFor，所以两边看到的一样多。
 *    「针对用户 / 保护用户」在结构上做不到 —— 不是"AI 自觉不看"，是它拿不到。
 *
 * 2. **AI 不作弊。**
 *    它只能看到裁剪后的视图：血量、位置、装备、行动顺序、以及已经揭晓的手势。
 *    别人本轮出了什么拳，它也看不到。
 *
 * 3. **AI 一定会推进局面。**
 *    动作一律从 legalActionsFrom() 里选（和引擎校验同一份实现），
 *    真选不出来时兜底「结束行动」，绝不会卡住对局。
 *
 * 决策方式：给每个合法动作打分，取最高分。分数里既有「局势分析」（威胁评估、
 * 能不能一击带走、位置收益），也有「记仇」——但记仇只是一个小权重，
 * 永远盖不过局势判断，另外每个 AI 有稳定的性格系数，避免所有 AI 一个样。
 */

import { ACT, PHASE, WILD } from '../engine/constants.js';
import { legalActionsFrom } from '../engine/rules.js';
import { makeRng } from '../engine/rng.js';

/* ---------------------------- AI 名字 ---------------------------- */

/**
 * 单字名字池。**导出的**，因为在线房间的人机名字也从这里来：
 * `server/games/blade-steed.mjs` 的 `meta.botNames` 直接 re-export 这个数组，
 * 房间层（`server/rooms.mjs` 的 `pickBotName`）按它给「＋ 添加人机」加出来的座位取名。
 * ⚠️ 名字**必须是一个字**：地图头像圆里只画得下一个字（见 js/ui/map.js 的 CHAR_MAX_W），
 *    平台的显示名也都是单字（docs/DECISIONS.md D5）。
 * ⚠️ 别在服务端抄一份字面量：两处各写一份，改一处就会分叉。
 */
export const AI_NAME_POOL = '虎狼鹰豹熊罴狮鲸鲨隼鸦蛇猿鹤龙'.split('');

/**
 * 单机【人机对局】的 AI 名字：汉字单字（虎/狼/鹰…）。
 * 在线房间的人机座位**也用这个池子**，但由房间层挑（`meta.botNames` → pickBotName），
 * 而且优先挑房里没人用过的字 —— 见 docs/GAME-SPEC.md §4。
 */
export function pickAiName(usedNames = []) {
  const used = new Set(usedNames);
  const free = AI_NAME_POOL.filter((c) => !used.has(c));
  const pool = free.length ? free : AI_NAME_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ---------------------------- 性格 ---------------------------- */

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * 性格由玩家 id 哈希出来 → 同一个 AI 整局性格稳定，
 * 但不同 AI 之间互不相同（有人莽、有人苟、有人特别记仇）。
 */
function traitsFrom(id) {
  const r = makeRng(hashStr(id));
  return {
    aggression: 0.85 + r.next() * 0.4, // 进攻性
    caution: 0.9 + r.next() * 0.35, // 保守程度：残血时更明显
    grudge: 0.15 + r.next() * 0.35, // 记仇权重（刻意压得很小）
    greed: 0.85 + r.next() * 0.35, // 买装备的积极性
    readOpponent: 0.6 + r.next() * 0.9, // 读对手出拳习惯的程度
    bluff: 0.7 + r.next() * 0.9, // 随机成分，防止被对手读死
    jitter: 0.35,
  };
}

/* ---------------------------- AI 大脑 ---------------------------- */

export class AiBrain {
  constructor(id) {
    this.id = String(id);
    this.traits = traitsFrom(this.id);
    this.rng = makeRng(hashStr(this.id) ^ 0x9e3779b9);
    /** 记仇表：谁打过我、打了多少（每个回合衰减一次） */
    this.grudge = {};
    /** 对手出拳统计：只用「已经公开揭晓过」的历史 */
    this.handStats = {};
    this.seenEventId = 0;
    this.roundSeen = 0;
  }

  /* -------------------- 记忆：只吃公开事件 -------------------- */

  /** 消费视图里的新事件，更新记仇表与对手出拳习惯 */
  observe(view) {
    for (const ev of view.events || []) {
      if (ev.id <= this.seenEventId) continue;
      this.seenEventId = ev.id;

      // 记仇：谁打了我，我就记住谁
      if ((ev.t === 'knife' || ev.t === 'kick') && ev.target === this.id && ev.pid !== this.id) {
        this.grudge[ev.pid] = (this.grudge[ev.pid] || 0) + ev.dmg;
      }
      // 我还手了 → 气消一半（记仇但更看局势）
      if ((ev.t === 'knife' || ev.t === 'kick') && ev.pid === this.id) {
        const prev = this.grudge[ev.target] || 0;
        this.grudge[ev.target] = Math.max(0, prev * 0.5);
      }

      // 出拳习惯：只用已经揭晓（公开）的手势
      if ((ev.t === 'rps-reveal' || ev.t === 'mini-reveal') && ev.choices) {
        for (const [pid, hand] of Object.entries(ev.choices)) {
          if (pid === this.id) continue;
          const st = (this.handStats[pid] ||= { rock: 0, scissors: 0, paper: 0 });
          if (st[hand] !== undefined) st[hand] += 1;
        }
      }
    }

    // 每个新回合衰减一次记仇
    if (view.round !== this.roundSeen) {
      this.roundSeen = view.round;
      for (const k of Object.keys(this.grudge)) this.grudge[k] *= 0.7;
    }
  }

  /* -------------------- 猜拳 -------------------- */

  /**
   * 出拳：用公开历史里对手的出手频率，挑一个「最可能克制对面」的手势，
   * 再掺足够大的噪声——没有任何历史时就是纯随机（这本来就是猜拳的最优解）。
   */
  chooseHand(view) {
    const hands = view.rpsChoices && view.rpsChoices.length ? view.rpsChoices : ['rock', 'scissors', 'paper'];
    const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
    let best = null;
    let bestScore = -Infinity;
    for (const h of hands) {
      let score = 0;
      for (const st of Object.values(this.handStats)) {
        const total = st.rock + st.scissors + st.paper;
        if (!total) continue;
        // 对手历史出「被 h 克制」的那一手越多，h 越值得出
        score += (st[beats[h]] / total) * this.traits.readOpponent;
      }
      score += this.rng.next() * this.traits.bluff;
      if (score > bestScore) {
        bestScore = score;
        best = h;
      }
    }
    return best || 'rock';
  }

  /* -------------------- 行动顺序 -------------------- */

  /**
   * 决胜者排顺序。
   * 先手价值最高：能先买装备、先抢人头、先脱离危险，所以自己排第一；
   * 其余人按「对我的威胁」升序——威胁大的排后面，我这轮的动作不至于立刻被反制。
   * 加一点抖动，避免每局都一模一样。
   */
  chooseOrder(view) {
    const me = this.id;
    const others = (view.mainWinners || []).filter((id) => id !== me && view.players.find((p) => p.id === id)?.alive);
    const scored = others.map((id) => {
      const p = view.players.find((x) => x.id === id);
      return { id, s: this._threat(view, view.players.find((x) => x.id === me), p) + this.rng.next() * this.traits.jitter };
    });
    scored.sort((a, b) => a.s - b.s);
    return [me, ...scored.map((x) => x.id)];
  }

  /* -------------------- 打分核心 -------------------- */

  /** 某人对我的威胁度（局势分析主体，记仇只是其中一个很小的加项） */
  _threat(view, me, o) {
    if (!o) return 0;
    let base = 0.55 * o.hp; // 血越多越难缠、越可能笑到最后
    if (o.horse) base += 2.0; // 有马 = 3 点爆发
    if (o.knife) base += 0.7;
    if (me && o.place === me.place) base += 1.3; // 现在就能打到我
    const g = (this.grudge[o.id] || 0) * this.traits.grudge; // 记仇（小权重）
    return base + g;
  }

  /** 买装备的紧迫度：越早买越值，但不能盖过「眼前能打人」 */
  _buyUrgency(view) {
    return Math.max(0.55, 1.55 - 0.11 * ((view.round || 1) - 1));
  }

  /** 「待在某个位置」的价值：在这里我能打到谁、谁能打到我、下一还能去哪儿 */
  _positionScore(view, me, where, foes, stepsLeftAfter) {
    let s = 0;
    const inCity = where !== WILD;
    for (const o of foes) {
      const threat = this._threat(view, me, o);
      if (o.place === where) {
        if (me.horse && inCity) {
          // 同城 + 有马 = 手里握着一次 3 点爆发，这是全局最赚的位置
          s += 2.5 + (o.hp <= 3 ? 2.1 : 0) + 0.45 * threat;
        } else if (me.knife) {
          s += 0.9 + (o.hp <= 1 ? 2.2 : 0) + 0.25 * threat;
        } else {
          s += 0.25;
        }
        // 对方也能打到我 → 减分，残血时减得更狠
        if (o.horse && inCity) s -= (0.55 + (me.hp <= 3 ? 1.4 : 0)) * this.traits.caution;
        else if (o.knife) s -= (0.25 + (me.hp <= 1 ? 1.7 : 0)) * this.traits.caution;
      } else if (where === WILD) {
        // 野外是所有城的枢纽：下一步可以进任意一座城
        s += (stepsLeftAfter > 0 ? 0.32 : 0.13) * (0.4 + 0.1 * threat);
      } else if (stepsLeftAfter > 1) {
        // 从一个城到另一个城要先出城，得两步
        s += 0.1 * (0.4 + 0.1 * threat);
      }
    }
    return s;
  }

  _moveScore(view, me, where, foes, stepsAfter) {
    const here = this._positionScore(view, me, me.place, foes, stepsAfter + 1);
    const there = this._positionScore(view, me, where, foes, stepsAfter);
    let s = 0.92 * (there - here);
    if (where === WILD) s += 0.12; // 枢纽本身的一点点价值
    return s;
  }

  _attackScore(view, me, targetId, dmg, foes) {
    const t = view.players.find((p) => p.id === targetId);
    if (!t) return -Infinity;
    const aliveCount = view.players.filter((p) => p.alive).length;
    const lethal = t.hp <= dmg;

    let s = dmg * (0.9 + 0.5 * this._threat(view, me, t));

    if (lethal) {
      // 一击带走永远是最优解：少一个对手就少一份威胁，人越多越值
      s += 60 + 14 * Math.max(0, aliveCount - 2);
    }

    if (dmg === 3) {
      // 踹额外收益：把对手踢出城，拆散他的同城组合
      const others = view.players.filter((p) => p.alive && p.id !== me.id && p.id !== t.id && p.place === t.place).length;
      s += 0.9 + 0.6 * others;
    }

    // 自己残血时，击杀的权重更高（活着才有输出）
    if (lethal && me.hp <= 3) s += 18 * this.traits.caution;

    return s * this.traits.aggression;
  }

  /* -------------------- 行动选择 -------------------- */

  /**
   * 选出这一步要做什么。动作空间直接来自 legalActionsFrom（和引擎校验同源）。
   * @param {object} view viewFor(engine, this.id)
   */
  chooseAction(view) {
    const me = view.players.find((p) => p.id === this.id);
    if (!me || !me.alive) return { type: ACT.PASS };
    const acts = legalActionsFrom(view, this.id);
    if (!acts.length) return { type: ACT.PASS };

    const foes = view.players.filter((p) => p.alive && p.id !== this.id);
    const stepsAfter = Math.max(0, (view.stepsLeft || 1) - 1);

    let best = null;
    let bestScore = -Infinity;
    for (const a of acts) {
      let s;
      switch (a.type) {
        case ACT.BUY_KNIFE:
          s = 9 * this.traits.greed * this._buyUrgency(view);
          break;
        case ACT.BUY_HORSE:
          s = 12.5 * this.traits.greed * this._buyUrgency(view);
          break;
        case ACT.MOVE_OUT:
          s = this._moveScore(view, me, WILD, foes, stepsAfter);
          break;
        case ACT.MOVE_IN:
          s = this._moveScore(view, me, a.target, foes, stepsAfter);
          break;
        case ACT.KNIFE:
          s = this._attackScore(view, me, a.target, 1, foes);
          break;
        case ACT.KICK:
          s = this._attackScore(view, me, a.target, 3, foes);
          break;
        case ACT.PASS:
        default:
          s = 0;
          break;
      }
      // 一点噪声：势均力敌时做出不同选择，看起来更像人
      if (a.type !== ACT.PASS) s += this.rng.next() * this.traits.jitter;
      if (s > bestScore) {
        bestScore = s;
        best = a;
      }
    }
    return best || { type: ACT.PASS };
  }

  /** 给测试/调试用：把当前所有选项的分数打出来 */
  explain(view) {
    const me = view.players.find((p) => p.id === this.id);
    const foes = view.players.filter((p) => p.alive && p.id !== this.id);
    const stepsAfter = Math.max(0, (view.stepsLeft || 1) - 1);
    return legalActionsFrom(view, this.id).map((a) => {
      let s = 0;
      if (a.type === ACT.BUY_KNIFE) s = 9 * this.traits.greed * this._buyUrgency(view);
      else if (a.type === ACT.BUY_HORSE) s = 12.5 * this.traits.greed * this._buyUrgency(view);
      else if (a.type === ACT.MOVE_OUT) s = this._moveScore(view, me, WILD, foes, stepsAfter);
      else if (a.type === ACT.MOVE_IN) s = this._moveScore(view, me, a.target, foes, stepsAfter);
      else if (a.type === ACT.KNIFE) s = this._attackScore(view, me, a.target, 1, foes);
      else if (a.type === ACT.KICK) s = this._attackScore(view, me, a.target, 3, foes);
      return { action: a, score: Number(s.toFixed(3)) };
    });
  }
}

/* ---------------------------- 驱动 ---------------------------- */

/** 为一局里的每个 AI 玩家建一个大脑 */
export function makeBrains(players) {
  const brains = {};
  for (const p of players) if (p.isAI) brains[p.id] = new AiBrain(p.id);
  return brains;
}

/**
 * AI 健康度计数：正常情况下 fallbacks 永远是 0。
 * 只要它不为 0，就说明 AI 选出了一个引擎不接受的动作（或者 AI 想卡住对局），
 * 自对弈压测会把它当成失败。
 */
export const aiStats = { fallbacks: 0 };

/** 清空计数（压测开始前调用） */
export function resetAiStats() {
  aiStats.fallbacks = 0;
}

/**
 * 让所有「轮到它」的 AI 立刻做决定。
 * 每次调用只推进一层（当前阶段的一批提交 / 当前行动者的一步），
 * 由调用方决定节奏（浏览器里会加一点思考延时，让玩家看得清）。
 *
 * @param {import('../engine/engine.js').Match} engine
 * @param {Record<string, AiBrain>} brains
 * @param {(view:object, pid:string)=>object} viewFor
 * @returns {boolean} 是否真的做了点什么（调用方据此决定要不要继续驱动）
 */
export function aiStep(engine, brains, viewFor) {
  const brainOf = (pid) => brains[pid] || (brains[pid] = new AiBrain(pid));

  if (engine.phase === PHASE.RPS && engine.rps) {
    let acted = false;
    for (const p of engine.alive()) {
      if (!p.isAI || engine.rps.submitted[p.id]) continue;
      const v = viewFor(engine, p.id);
      const b = brainOf(p.id);
      b.observe(v);
      engine.submitRps(p.id, b.chooseHand(v));
      acted = true;
    }
    return acted;
  }

  if (engine.phase === PHASE.ORDER && engine.mini) {
    if (engine.mini.decider) {
      const d = engine.player(engine.mini.decider);
      if (d && d.isAI) {
        const v = viewFor(engine, d.id);
        const b = brainOf(d.id);
        b.observe(v);
        const order = b.chooseOrder(v);
        const r = engine.submitOrder(d.id, order);
        if (!r.ok) {
          // 极端兜底：顺序不被接受就按座位来，绝不停摆
          aiStats.fallbacks += 1;
          const fallback = engine.mainWinners.filter((id) => engine.player(id)?.alive);
          engine.submitOrder(d.id, fallback);
        }
        return true;
      }
      return false;
    }
    let acted = false;
    for (const id of engine.mini.candidates) {
      const p = engine.player(id);
      if (!p || !p.isAI || !p.alive || engine.mini.submitted[id]) continue;
      const v = viewFor(engine, id);
      const b = brainOf(id);
      b.observe(v);
      engine.submitRps(id, b.chooseHand(v));
      acted = true;
    }
    return acted;
  }

  if (engine.phase === PHASE.ACTION) {
    const cur = engine.player(engine.current);
    if (!cur || !cur.isAI) return false;
    const v = viewFor(engine, cur.id);
    const b = brainOf(cur.id);
    b.observe(v);
    const action = b.chooseAction(v);
    const r = engine.act(cur.id, action);
    if (!r.ok) {
      // AI 永远不允许卡住对局：选不出来就直接结束剩余步数
      aiStats.fallbacks += 1;
      engine.act(cur.id, { type: ACT.PASS });
    }
    return true;
  }

  return false;
}