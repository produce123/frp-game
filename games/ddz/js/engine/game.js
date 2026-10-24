/*
 * 斗地主 —— 一局牌的状态机（**服务器权威**）。
 *
 * 流程照上游 GODOT-DouDiZhu（`脚本/手牌管理器.gd`）：**发牌 → 叫地主 → 抢地主 → 出牌 → 结算**。
 * 上游是单机打两个弱 AI：叫地主只问玩家自己，抢地主是 AI 随机掷硬币，而且**没有胜负判定之外的
 * 任何收尾**。这里把同一套流程变成"三家真人都能走"的回合制：
 *
 *   bidding  叫地主：随机一家先叫，三家依次「叫地主 / 不叫」；第一家叫的人成为候选；
 *            三家都不叫 → 重新发牌（上限 MAX_REDEAL 次后强制落定，防死循环）。
 *   robbing  抢地主：候选之后的另外两家依次「抢地主 / 不抢」，**最后一个抢的人当地主**。
 *   playing  出牌：地主先出；另外两家都不出 → 上一手出牌的人重新领出。
 *   over     一手打完 / 有人离开（本局作废）。
 *
 * 隐藏信息只有两样：三个人的手牌、三张底牌（叫地主结束前连自己都不知道谁是地主）。
 * `viewFor()` 是唯一的裁剪点 —— 别人的牌只给张数。
 *
 * 纯逻辑：不碰任何宿主 API（测试里有 grep 盯着）。
 */

import { createDeck, shuffle, sortCards, rankText } from './cards.js';
import { TYPE, canBeat, classify } from './rules.js';

/** 三个人：这是斗地主的硬性座位数。 */
export const SEAT_COUNT = 3;

/** 三家都不叫 → 重新发牌，最多重发这么多次（概率上几乎碰不到，防死循环）。 */
const MAX_REDEAL = 20;

function fail(message) {
  return { ok: false, message };
}

/**
 * 建一局。
 *
 * @param {object} opts
 * @param {Array<{id:string,name:string,avatar?:string,isBot?:boolean}>} opts.players 正好 3 个座位
 * @param {() => number} [opts.rng] 默认 Math.random；测试注入确定性随机
 */
export function createGame({ players, rng = Math.random } = {}) {
  if (!Array.isArray(players) || players.length !== SEAT_COUNT) {
    throw new Error(`斗地主刚好 ${SEAT_COUNT} 个人：现在 ${Array.isArray(players) ? players.length : 0} 个座位`);
  }

  /** 座位表：座位号就是数组下标（房间层按入座顺序给）。 */
  const seats = players.map((p, index) => ({
    seat: index,
    id: String(p.id),
    name: String(p.name || ''),
    avatar: String(p.avatar || ''),
  }));
  const seatById = new Map(seats.map((s) => [s.id, s.seat]));

  /** 下一个座位 / 上一个座位（下家 / 上家）。 */
  const next = (seat) => (seat + 1) % SEAT_COUNT;

  const state = {
    phase: 'bidding',
    /** bidding 的两个小阶段：call=叫地主，rob=抢地主 */
    stage: 'call',
    hands: [[], [], []],
    bottom: [],
    landlord: null,
    /** 叫/抢的当前候选地主 */
    candidate: null,
    /** 抢地主还没问过的座位，按顺序 */
    robQueue: [],
    /** 叫分/抢分轮到谁 */
    turn: 0,
    /** 出牌阶段最近一手有效出牌 */
    lastPlay: null,
    /** 这一轮已经「不要」的座位 */
    passed: [],
    /** 每个座位头上那行字（上游的 玩家/上家/下家 文字显示）：叫地主 / 不叫 / 抢地主 / 不抢 / 不要 */
    labels: ['', '', ''],
    /** 叫/抢的记录（公开，界面可以用） */
    bids: [],
    winner: null,
    aborted: null,
    redeals: 0,
  };

  /* ------------------------------ 发牌 ------------------------------ */

  function deal() {
    const deck = shuffle(createDeck(), rng);
    state.hands = [
      sortCards(deck.slice(0, 17)),
      sortCards(deck.slice(17, 34)),
      sortCards(deck.slice(34, 51)),
    ];
    state.bottom = sortCards(deck.slice(51));
    state.phase = 'bidding';
    state.stage = 'call';
    state.landlord = null;
    state.candidate = null;
    state.robQueue = [];
    state.turn = Math.floor(rng() * SEAT_COUNT) % SEAT_COUNT;
    state.lastPlay = null;
    state.passed = [];
    state.labels = ['', '', ''];
    state.bids = [];
    state.winner = null;
    state.aborted = null;
  }

  /* ------------------------------ 工具 ------------------------------ */

  function seatName(seat) {
    const s = seats[seat];
    return s ? s.name || s.id : `座位 ${seat}`;
  }

  function finishBidding() {
    const landlord = state.candidate;
    state.landlord = landlord;
    state.hands[landlord] = sortCards(state.hands[landlord].concat(state.bottom));
    state.phase = 'playing';
    state.stage = 'playing';
    state.turn = landlord;
    state.lastPlay = null;
    state.passed = [];
    state.labels = ['', '', ''];
  }

  function endGame(winnerSeat) {
    const side = winnerSeat === state.landlord ? 'landlord' : 'farmers';
    const winSeats = side === 'landlord'
      ? [state.landlord]
      : seats.map((s) => s.seat).filter((seat) => seat !== state.landlord);
    state.phase = 'over';
    state.winner = { side, seats: winSeats };
    state.turn = null;
    state.passed = [];
  }

  function abort(reason) {
    if (state.phase === 'over') return;
    state.phase = 'over';
    state.aborted = String(reason || '本局作废');
    state.winner = null;
    state.turn = null;
    state.passed = [];
  }

  /** 叫地主成功：进入抢地主，问候选之后的两家。 */
  function enterRob() {
    state.stage = 'rob';
    state.robQueue = [next(state.candidate), next(next(state.candidate))];
    state.turn = state.robQueue[0];
  }

  /* ------------------------------ 叫地主 / 抢地主 ------------------------------ */

  function actBid(seat, action) {
    if (seat !== state.turn) return fail('还没轮到你叫地主');
    const value = Number(action && action.value);
    if (value !== 0 && value !== 1) return fail('只能叫 / 不叫（0 或 1）');

    if (state.stage === 'call') {
      state.bids.push({ seat, value });
      if (value === 1) {
        state.candidate = seat;
        state.labels[seat] = '叫地主';
        enterRob();
        return { ok: true };
      }
      state.labels[seat] = '不叫';
      const called = state.bids.filter((b) => b.value === 1).length;
      const asked = state.bids.length;
      if (asked >= SEAT_COUNT && called === 0) {
        state.redeals += 1;
        if (state.redeals > MAX_REDEAL) {
          // 概率极低：连续这么多把没人叫。强制最后问的人当地主，不然这桌永远开不了局。
          state.candidate = seat;
          state.labels[seat] = '叫地主';
          finishBidding();
        } else {
          deal();
        }
        return { ok: true };
      }
      state.turn = next(seat);
      return { ok: true };
    }

    // stage === 'rob'
    state.bids.push({ seat, value });
    if (value === 1) {
      state.candidate = seat;
      state.labels[seat] = '抢地主';
    } else {
      state.labels[seat] = '不抢';
    }
    state.robQueue.shift();
    if (state.robQueue.length === 0) {
      finishBidding();
      return { ok: true };
    }
    state.turn = state.robQueue[0];
    return { ok: true };
  }

  /* ------------------------------ 出牌 ------------------------------ */

  function actPlay(seat, action) {
    const ids = Array.isArray(action && action.cards) ? action.cards.map(String) : [];
    if (!ids.length) return fail('先选要出的牌');
    if (new Set(ids).size !== ids.length) return fail('同一张牌不能出两次');

    const hand = state.hands[seat];
    const byId = new Map(hand.map((c) => [c.id, c]));
    const picked = [];
    for (const id of ids) {
      const card = byId.get(id);
      if (!card) return fail('有牌不在你手里');
      picked.push(card);
    }

    const info = classify(picked);
    if (!info) return fail('这几张凑不成合法牌型');
    if (!canBeat(state.lastPlay && state.lastPlay.info, info)) {
      return fail('压不过上家出的牌');
    }

    const pickedSet = new Set(ids);
    state.hands[seat] = sortCards(hand.filter((c) => !pickedSet.has(c.id)));
    state.lastPlay = { seat, cards: sortCards(picked), info };
    state.passed = [];
    state.labels[seat] = '';

    if (state.hands[seat].length === 0) {
      endGame(seat);
      return { ok: true, won: true };
    }
    state.turn = next(seat);
    return { ok: true };
  }

  function actPass(seat) {
    if (!state.lastPlay) return fail('这一轮是你领出，不能不出');
    if (!state.passed.includes(seat)) state.passed.push(seat);
    state.labels[seat] = '不要';
    if (state.passed.length >= SEAT_COUNT - 1) {
      // 另外两家都不出 → 回到上一手出牌的人重新领出
      const lead = state.lastPlay.seat;
      state.lastPlay = null;
      state.passed = [];
      state.labels = ['', '', ''];
      state.turn = lead;
    } else {
      state.turn = next(seat);
    }
    return { ok: true };
  }

  /* ------------------------------ 对外接口 ------------------------------ */

  deal();

  const match = {
    /**
     * 按人裁剪的视图。**别人手里是什么牌永远不出现在这里** —— 只有张数。
     * 底牌在叫地主/抢地主结束前也不给。
     */
    viewFor(playerId) {
      const seat = seatById.get(String(playerId));
      if (seat === undefined) return null;

      const last = state.lastPlay;
      return {
        seat,
        phase: state.phase,
        /** bidding 的 call / rob；出牌阶段是 'playing'；结束是 'over' */
        stage: state.phase === 'bidding' ? state.stage : state.phase,
        /** 自己手牌（从大到小） */
        hand: state.hands[seat].map((c) => ({ id: c.id, r: c.r, s: c.s })),
        /** 三个座位公开信息：张数、地主、头上那行字 */
        players: seats.map((s) => ({
          seat: s.seat,
          id: s.id,
          name: s.name,
          avatar: s.avatar,
          count: state.hands[s.seat].length,
          isLandlord: state.landlord === s.seat,
          passed: state.passed.includes(s.seat),
          label: state.labels[s.seat] || '',
        })),
        /** 底牌：叫地主阶段保密（null），定完地主公开 */
        bottom: state.phase === 'bidding' ? null : state.bottom.map((c) => ({ id: c.id, r: c.r, s: c.s })),
        landlord: state.landlord,
        /** 该谁行动（叫/抢/出牌都是它） */
        turn: state.turn,
        /** 叫/抢记录：[{seat, value}]，value 1=叫或抢，0=不叫或不抢 */
        bids: state.bids.map((b) => ({ seat: b.seat, value: b.value })),
        /** 最近一手牌（牌面公开）；轮空就是 null */
        lastPlay: last
          ? {
            seat: last.seat,
            type: last.info.type,
            len: last.info.len,
            rank: last.info.rank,
            tail: last.info.tail,
            /** 语音要念"顺子 3 到 10" / "三带一 A" —— 直接把文字给客户端，免得两边各有一张点数表 */
            rankText: rankText(last.info.rank),
            tailText: last.info.tail === null ? '' : rankText(last.info.tail),
            cards: last.cards.map((c) => ({ id: c.id, r: c.r, s: c.s })),
          }
          : null,
        winner: state.winner ? { side: state.winner.side, seats: state.winner.seats.slice() } : null,
        aborted: state.aborted,
      };
    },

    /**
     * 一个操作意图。**座位只从 playerId 反查** —— 客户端说自己是几号位不算数。
     * @param {string} playerId
     * @param {{type:'bid'|'play'|'pass', value?:number, cards?:string[]}} action
     */
    act(playerId, action) {
      const seat = seatById.get(String(playerId));
      if (seat === undefined) return fail('你不在这一局里');
      if (state.phase === 'over') {
        return fail(state.aborted ? '这局已经作废了' : '这局已经结束了');
      }
      const kind = action && action.type;
      if (state.phase === 'bidding') {
        if (kind !== 'bid') return fail(state.stage === 'call' ? '现在是叫地主阶段' : '现在是抢地主阶段');
        return actBid(seat, action);
      }
      if (seat !== state.turn) return fail('还没轮到你出牌');
      if (kind === 'pass') return actPass(seat);
      if (kind === 'play') return actPlay(seat, action);
      return fail('不认识的操作');
    },

    /** 斗地主不允许中途加入（进不来就是进不来）。 */
    addPlayer() {
      return false;
    },

    /** 有人离开这局（掉线超时 / 主动退房）：本局作废，剩下的两家不用干等。 */
    removePlayer(playerId) {
      const seat = seatById.get(String(playerId));
      if (seat === undefined) return false;
      if (state.phase === 'over') return true;
      abort(`${seatName(seat)} 离开了这一局`);
      return true;
    },

    isOver() {
      return state.phase === 'over';
    },

    result() {
      return {
        aborted: state.aborted,
        winner: state.winner ? state.winner.side : null,
        landlord: state.landlord,
      };
    },
  };

  return match;
}

/** 牌型常量再导出一次，测试和界面都用得上。 */
export { TYPE };