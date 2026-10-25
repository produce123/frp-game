/*
 * 地平线赛车（HORIZON）—— 平台房间层里的"联机比赛"游戏模块。
 *
 * 为什么服务器上几乎没有"游戏规则"：
 *   物理和世界都在**每个玩家的浏览器里**跑（见 docs/DECISIONS.md D46）。
 *   服务器只负责三件事：
 *     1. 房间/座位/邀请 —— 平台房间层已经做好了；
 *     2. 一场比赛的生命周期（开始 / 谁完赛 / 结束 / 再来一局）；
 *     3. 给客户端一份"这局是哪个地图、有谁、谁第几"的公开视图。
 *
 * 高频的车位置**不走这里**：平台房间层每收一条 act 就广播整间房的 state，
 * 15Hz 的车位置会把房间面板重画 15 次/秒。位置走 `/horizon-relay`
 * （server/horizon/relay.mjs），这里只在"完赛/结束"这类低频事件上用 act。
 *
 * 视图里没有任何隐藏信息（赛车没有手牌/底牌），所以 viewFor 对参赛者返回同一份数据。
 */

/** 允许联机的地图 id —— 必须和 games/horizon/js/utils.js 的 MAPS 一致。 */
const MAP_IDS = new Set(['alpine', 'city', 'city2', 'city3']);

export const HORIZON_MAPS = ['alpine', 'city', 'city2', 'city3'];

function cleanMap(value) {
  const id = String(value ?? '').trim();
  return MAP_IDS.has(id) ? id : 'alpine';
}

function cleanTime(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(3600, n);
}

export const meta = {
  slug: 'horizon',
  title: '地平线赛车',
  icon: '🏎️',
  /** 一个人也能开房（自己先跑一圈看地图）；联机靠邀请/进入。 */
  minPlayers: 2,
  /** 总座位下限：一个人也能先开局看地图，所以是 1。 */
  minSeats: 1,
  maxPlayers: 8,
  /** 没有电脑 —— 联机比的是真人；单机模式在游戏主菜单里，不走房间层。 */
  maxBots: 0,
  botNames: null,
};

/**
 * @param {Array<{id:string,name:string,avatar?:string,isHost?:boolean}>} players
 * @param {{map?: string}} [options]
 */
export function createMatch(players, options = {}) {
  const racers = players
    .filter((p) => p && !p.isBot)
    .map((p) => ({
      id: String(p.id),
      name: String(p.name || ''),
      avatar: String(p.avatar || ''),
      isHost: Boolean(p.isHost),
    }));

  const state = {
    map: cleanMap(options.map),
    startedAt: Date.now(),
    /** id -> { order, time, dnf } */
    finished: new Map(),
    over: false,
    overAt: 0,
  };

  /** 完赛顺序：1,2,3…；DNF 不占名次（order=0）。 */
  let finishSeq = 0;

  function isRacer(id) {
    return racers.some((r) => r.id === id);
  }

  function recordFinish(id, time, dnf = false) {
    if (!isRacer(id) || state.finished.has(id)) return false;
    if (!dnf) finishSeq += 1;
    state.finished.set(id, {
      order: dnf ? 0 : finishSeq,
      time: dnf ? 0 : cleanTime(time),
      dnf: Boolean(dnf),
    });
    if (state.finished.size >= racers.length) {
      state.over = true;
      state.overAt = Date.now();
    }
    return true;
  }

  function results() {
    return [...state.finished.entries()]
      .map(([id, r]) => {
        const racer = racers.find((x) => x.id === id);
        return {
          id,
          name: racer ? racer.name : '',
          order: r.order,
          time: r.time,
          dnf: r.dnf,
        };
      })
      .sort((a, b) => {
        if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
        if (a.order !== b.order) return a.order - b.order;
        return a.id.localeCompare(b.id);
      });
  }

  return {
    viewFor(playerId) {
      if (!isRacer(playerId)) return null;
      return {
        map: state.map,
        racers: racers.map((r) => ({
          id: r.id,
          name: r.name,
          avatar: r.avatar,
          isHost: r.isHost,
        })),
        startedAt: state.startedAt,
        phase: state.over ? 'over' : 'racing',
        results: results(),
      };
    },

    act(playerId, act = {}) {
      if (!isRacer(playerId)) return { ok: false, message: '你不在这一局里' };
      if (state.over) return { ok: false, message: '比赛已经结束了' };

      switch (act && act.type) {
        case 'finish':
          recordFinish(playerId, act.time, false);
          return { ok: true };

        case 'dnf':
          recordFinish(playerId, 0, true);
          return { ok: true };

        case 'over': {
          // 只有房主能"结束比赛"（8 分钟没跑完、或者有人掉线不回来时用）。
          // 客户端在 relay 的 8 分钟超时消息之后发这一条。
          const host = racers.find((r) => r.isHost);
          if (!host || host.id !== playerId) {
            return { ok: false, message: '只有房主能结束比赛' };
          }
          for (const r of racers) recordFinish(r.id, 0, true);
          state.over = true;
          state.overAt = Date.now();
          return { ok: true };
        }

        default:
          return { ok: false, message: '不认识的操作' };
      }
    },

    /** 比赛开始后不允许中途加入（物理对不齐，不装这个能力）。 */
    addPlayer() {
      return false;
    },

    removePlayer(playerId) {
      // 主动离开 / 掉线超时：按 DNF 记，别让其他人永远等不到"结束"。
      recordFinish(playerId, 0, true);
    },

    isOver() {
      return state.over;
    },

    result() {
      return { map: state.map, results: results() };
    },
  };
}