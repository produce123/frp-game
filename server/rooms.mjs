/*
 * 房间注册表 —— **完全不认识任何具体游戏**。
 *
 * 它只认 server/games/<slug>.mjs 导出的接口（见 docs/ARCHITECTURE.md「游戏模块接口」）：
 *   meta / createMatch(players, options) -> match
 *   match: viewFor / act / addPlayer / removePlayer / isOver / result
 *
 * 所以加第四个游戏**不需要动这个文件**。
 *
 * 座位与掉线（重要，改之前先读）：
 *   · 连接断了**不立即清座位** —— 手机切后台、刷新页面都会断一下，
 *     立刻清座位会让玩家一刷新就丢局。座位保留 GRACE_MS，期间重连自动回到原座位。
 *   · 超过 GRACE_MS 才真正踢出，并通知 match.removePlayer。
 *   · 房主掉线超时且房里还有别人时，房主身份移交给最早进来的在线成员（**不是**重开一局）。
 */

import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  T,
  botId,
  isReactKind,
  normalizeCode,
  pickBotName,
} from '../shared/protocol.mjs';
import { randomInt } from 'node:crypto';

/** 掉线后座位保留多久，期间重连回到原座位。 */
export const SEAT_GRACE_MS = 120_000;
/** 多久扫一次过期座位。 */
export const SWEEP_MS = 15_000;

/**
 * 互动的**技术性**防洪阈值（**不是玩法限制**）：
 * 用户明确要求"扔鸡蛋/鲜花完全无限制"，所以正常怎么点都碰不到这个数。
 * 它的唯一目的是防止一个客户端把 N 个人的屏幕刷爆 ——
 * 一条 `react.send` 会被放大成"房里每个人各一条"，没有上限的话
 * 一个坏客户端就能把整间房打成幻灯片。
 *
 * 超出阈值时**静默丢弃**（不弹提示条）：报错刷屏本身也是一种刷屏。
 */
const REACT_BURST = { windowMs: 2_000, max: 40 };

export const PHASE = { WAITING: 'waiting', PLAYING: 'playing', OVER: 'over' };

function randomRoomCode() {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) out += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  return out;
}

/**
 * @param {object} options
 * @param {Map<string, object>} options.games    slug -> 游戏模块
 * @param {(playerId: string, message: object) => void} options.deliver  把消息发给某人的所有连接
 * @param {(playerId: string) => void} options.onSeatChange
 *        某人的座位变化（进房/离房/被清理）时回调。hub 用它去刷新**这个人的好友们**
 *        看到的「正在玩什么」—— rooms 自己不认识好友关系，所以只能回调出去。
 */
export function createRooms({ games, deliver = () => {}, onSeatChange = () => {} }) {
  /** code -> room */
  const rooms = new Map();
  /** playerId -> code，一个玩家同时只能在一个房间 */
  const seatOf = new Map();
  /** 互动防洪用：playerId -> { at, n }（见 REACT_BURST） */
  const reactHits = new Map();
  /** 互动编号：服务端是唯一的发源地，客户端靠它认出自己的回声 */
  let reactSeq = 0;

  /* ------------------------------ 内部工具 ------------------------------ */

  function newCode() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const code = randomRoomCode();
      if (!rooms.has(code)) return code;
    }
    throw new Error('房间号用光了（这不正常）');
  }

  /**
   * 这个游戏这一局的座位数上下限。
   *
   * `minPlayers` 是**真人**下限（房间层数真人），`minSeats` 是**总座位**下限
   * （含人机，引擎能不能建局的底线）。两个数不是一回事：
   * 1 个真人 + 0 个人机时真人够了、座位不够，界面要说"加一个人机"。
   * 见 docs/DECISIONS.md D9 与 docs/ARCHITECTURE.md 的「游戏模块接口」。
   */
  function seatLimits(game) {
    const meta = (game && game.meta) || {};
    const minPlayers = Number.isInteger(meta.minPlayers) && meta.minPlayers > 0 ? meta.minPlayers : 1;
    const minSeats = Number.isInteger(meta.minSeats) ? meta.minSeats : minPlayers;
    const maxSeats = Number.isFinite(meta.maxPlayers) ? meta.maxPlayers : Infinity;
    /**
     * 这个游戏最多能坐几个**人机**座位。默认不设上限（老游戏都有电脑）。
     *
     * `meta.maxBots = 0` 是给"没有电脑"的游戏用的（比如斗地主：用户拍板不做 AI，
     * 三个人必须都是真人）。它管三处：准备区不画「＋ 添加人机」（`shared/ui/room.js`）、
     * `botAdd()` 直接拒绝、`start()` 座位不够时的提示语不再让人"加个人机"。
     * 字段本身不认识任何具体游戏，只认数。
     */
    const maxBots = Number.isFinite(meta.maxBots) ? Math.max(0, meta.maxBots) : Infinity;
    return { minPlayers, minSeats, maxSeats, maxBots };
  }

  /** 总座位数（真人 + 人机）。 */
  function seatCount(room) {
    return room.members.size + room.bots.size;
  }

  /**
   * 成员列表（给界面用的那一份）＝ 真人 + 人机。
   * 人机排在后面并带 `isBot: true`，界面靠它画灰色圆环、靠它决定要不要显示「移除」。
   */
  function memberList(room) {
    const humans = [...room.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      avatar: m.avatar || '',
      online: m.online,
      isBot: false,
    }));
    const bots = [...room.bots.values()].map((b) => ({ id: b.id, name: b.name, avatar: '', online: true, isBot: true }));
    return humans.concat(bots);
  }

  /** 组装发给某个成员的房间状态。**view 一定是按人裁剪过的**。 */
  function stateMessage(room, playerId) {
    const member = room.members.get(playerId);
    if (!member) return null;
    let view = null;
    if (room.match && room.phase !== PHASE.WAITING) {
      try {
        view = room.match.viewFor(playerId);
      } catch {
        view = null;
      }
    }
    const { minPlayers, minSeats, maxSeats, maxBots } = seatLimits(games.get(room.game));
    return {
      t: 'room.state',
      code: room.code,
      game: room.game,
      hostId: room.hostId,
      phase: room.phase,
      members: memberList(room),
      options: room.options,
      view,
      // 界面（shared/ui/room.js）靠这几个数决定「添加人机」能不能按、
      // 「开始游戏」该不该亮 —— 它不认识任何具体游戏，所以数字必须由服务端给。
      minPlayers,
      minSeats,
      maxSeats,
      // 0 = 这个游戏没有电脑（不画「＋ 添加人机」）。见 seatLimits() 的注释。
      maxBots: Number.isFinite(maxBots) ? maxBots : null,
    };
  }

  /** 把房间状态推给房里每个人（各自的 view 是分开算的）。 */
  function broadcastState(room) {
    for (const id of room.members.keys()) {
      const msg = stateMessage(room, id);
      if (msg) deliver(id, msg);
    }
  }

  function sendError(playerId, message) {
    deliver(playerId, { t: 'error', message });
  }

  function findRoomOf(playerId) {
    const code = seatOf.get(playerId);
    return code ? rooms.get(code) || null : null;
  }

  /**
   * 「这个人现在在玩什么」—— 给好友列表用的公开摘要。
   * 只暴露游戏、房间号和能不能进，**不含任何对局内容**。
   */
  function presenceOf(playerId) {
    const room = findRoomOf(playerId);
    if (!room) return null;
    const { maxSeats } = seatLimits(games.get(room.game));
    return {
      game: room.game,
      code: room.code,
      phase: room.phase,
      /**
       * 好友能不能点进来。
       *
       * ⚠️ 这里数的是**真人座位**（`room.members`），**不是** `seatCount`（真人 + 人机）。
       * 一开始我写的是 `seatCount(room) < maxSeats`，看着"和 join() 一个口径"，
       * 其实正好写反了：`join()` 在座位被人机占满时会**先顶掉最后加的那个人机**再让人进来
       * （人机不许挡着真人）。所以"1 个真人 + 1 个人机"的房间里，
       * 真人其实进得来，但按 seatCount 算会判定成"满了"→ 好友列表连「进入」按钮都不显示，
       * 朋友根本没法加入。这个 bug 是 `tests/room.browser.mjs` 抓到的
       * （它先加一个人机、再让第二个真人在平台首页点「进入」，按钮不见了）。
       */
      joinable: room.phase === PHASE.WAITING && room.members.size < maxSeats,
    };
  }

  /** 座位变了 → 通知外面（hub 会去刷新这个人的好友们看到的列表）。 */
  function seatChanged(playerId) {
    try {
      onSeatChange(playerId);
    } catch { /* 刷新好友列表失败不该影响房间本身 */ }
  }

  /**
   * 房间的"对局阶段"变了 → 每个成员的 presence 都变了
   * （waiting 时好友能点进来，playing 之后就不行了），所以整个房都要通知一遍。
   */
  function notifyMembers(room) {
    for (const id of room.members.keys()) seatChanged(id);
  }

  /* ------------------------------ 对外接口 ------------------------------ */

  const api = {
    get size() { return rooms.size; },

    findRoomOf,
    presenceOf,

    /**
     * 按房号拿一份**只读**的房间摘要。
     *
     * 给同进程里的联机中继用（大富翁/无名杀那种"页面心跳"的游戏不需要；
     * 地平线的 `/horizon-relay` 要确认"这个人真的在这间地平线房里、而且已经开局"）。
     * 这里刻意只给公开字段，**不交出 room 对象本身** —— 中继没有资格改房间状态。
     *
     * 不认识任何具体游戏：所有游戏拿到的形状一样。
     */
    snapshot(code) {
      const room = rooms.get(String(code || '').trim().toUpperCase());
      if (!room) return null;
      return {
        code: room.code,
        game: room.game,
        hostId: room.hostId,
        phase: room.phase,
        members: [...room.members.values()].map((m) => ({
          id: m.id,
          name: m.name,
          avatar: m.avatar || '',
          online: Boolean(m.online),
        })),
      };
    },

    /** 建房。房主自动入座。 */
    create({ game: slug, host, options = {} }) {
      const game = games.get(slug);
      if (!game) return { ok: false, message: '没有这个游戏' };

      const existing = findRoomOf(host.id);
      if (existing) api.leave(host.id, { silent: true });

      const code = newCode();
      const room = {
        code,
        game: slug,
        hostId: host.id,
        options,
        members: new Map(),
        /**
         * 人机座位（`bot:1` …）。**不是房间成员**：不占 seatOf、不掉线、没有连接，
         * 但它占座位、出现在成员列表里、开局时进 `createMatch` 的 players。
         * 见 docs/DECISIONS.md D9。
         */
        bots: new Map(),
        match: null,
        phase: PHASE.WAITING,
        createdAt: Date.now(),
      };
      rooms.set(code, room);

      room.members.set(host.id, {
        id: host.id,
        name: host.name,
        avatar: host.avatar || '',
        online: true,
        offlineSince: 0,
        joinedAt: Date.now(),
      });
      seatOf.set(host.id, code);
      broadcastState(room);
      seatChanged(host.id);
      return { ok: true, code };
    },

    /** 按房间号入座。 */
    join({ code, player }) {
      const normalized = normalizeCode(code);
      if (!normalized) return { ok: false, message: '房间号格式不对（6 位字母数字）' };

      const room = rooms.get(normalized);
      if (!room) return { ok: false, message: '房间不存在或已解散' };

      const game = games.get(room.game);
      if (!game) return { ok: false, message: '这个游戏还没接上服务器' };

      // 已经在别的房里：先退掉，避免一个人占两个座位
      const other = findRoomOf(player.id);
      if (other && other !== room) api.leave(player.id, { silent: true });

      if (room.members.has(player.id)) {
        // 重连回原座位
        const member = room.members.get(player.id);
        member.online = true;
        member.offlineSince = 0;
        member.name = player.name;
        member.avatar = player.avatar || member.avatar || '';
        seatOf.set(player.id, room.code);
        broadcastState(room);
        seatChanged(player.id);
        return { ok: true, code: room.code };
      }

      const { maxSeats } = seatLimits(game);

      /*
       * 座位满了怎么办？**开局前人机让位**（见 docs/DECISIONS.md D9）：
       * 人机只是来凑人数的，真朋友来了永远优先 —— 顶掉**最后加的那一个**。
       *
       * 这一条不做的话，房主一个人加了 3 个人机之后，朋友点「进入」会收到
       * "房间满了"：明明是朋友想一起玩，却被三个电脑挡在门外。
       */
      if (room.phase === PHASE.WAITING && seatCount(room) >= maxSeats && room.bots.size > 0) {
        const last = [...room.bots.keys()].pop();
        room.bots.delete(last);
      }
      if (seatCount(room) >= maxSeats) {
        // 开局之后人机不让位：座位上已经有一局正在打，撤不掉
        return { ok: false, message: `房间满了（最多 ${maxSeats} 人）` };
      }

      // 开局之后的加入要问过游戏
      if (room.phase !== PHASE.WAITING) {
        let accepted = false;
        try {
          accepted = room.match?.addPlayer?.({ id: player.id, name: player.name }) === true;
        } catch {
          accepted = false;
        }
        if (!accepted) return { ok: false, message: '这局已经开始，进不去了' };
      }

      room.members.set(player.id, {
        id: player.id,
        name: player.name,
        avatar: player.avatar || '',
        online: true,
        offlineSince: 0,
        joinedAt: Date.now(),
      });
      seatOf.set(player.id, room.code);
      broadcastState(room);
      seatChanged(player.id);
      return { ok: true, code: room.code };
    },

    /**
     * 离座。silent=true 时不广播（用于"换房间"这类内部调用，外面紧接着就会广播新房间）。
     */
    leave(playerId, { silent = false } = {}) {
      const room = findRoomOf(playerId);
      if (!room) return { ok: false, message: '你不在任何房间里' };

      room.members.delete(playerId);
      seatOf.delete(playerId);
      seatChanged(playerId);        // 先告诉好友"他不在房间了"，后面的早退分支就不用重复
      try {
        room.match?.removePlayer?.(playerId);
      } catch { /* 游戏自己的清理失败不该拖垮房间层 */ }

      /*
       * ⚠️ 必须**单独**给离开的人发一条"你不在房里了"。
       * broadcastState 只发给还在 room.members 里的人，而这个人刚刚已经被删掉了 ——
       * 不补这一条，他的客户端会一直停在房间界面上（Net.room 没被清掉），
       * 看起来就是"点了离开没反应"，连刷新都要靠手动。
       * 这个 bug 是曾经的浏览器体检（已删除）抓到的，防线现在是
       * tests/server.test.mjs 的「离开房间」用例。
       */
      deliver(playerId, { t: T.ROOM_STATE, code: null });

      if (room.members.size === 0) {
        rooms.delete(room.code);
        return { ok: true, closed: true };
      }

      // 房主走了（或明确离座）→ 移交给最早进来的在线成员
      if (room.hostId === playerId) {
        const next = [...room.members.values()]
          .sort((a, b) => (Number(b.online) - Number(a.online)) || (a.joinedAt - b.joinedAt))[0];
        room.hostId = next.id;
      }

      if (room.phase === PHASE.PLAYING && room.match?.isOver?.()) room.phase = PHASE.OVER;
      if (!silent) broadcastState(room);
      return { ok: true };
    },

    /** 房主开局。 */
    start(playerId, options) {
      const room = findRoomOf(playerId);
      if (!room) return { ok: false, message: '你不在任何房间里' };
      if (room.hostId !== playerId) return { ok: false, message: '只有房主能开始游戏' };
      if (room.phase !== PHASE.WAITING) return { ok: false, message: '这局已经开始了' };

      const game = games.get(room.game);
      if (!game) return { ok: false, message: '这个游戏还没接上服务器' };

      const players = [...room.members.values()].map((m) => ({
        id: m.id,
        name: m.name,
        avatar: m.avatar || '',
        // 谁是房主交给游戏显式判断。**不要**让游戏去猜"第一个人就是房主"：
        // 房主中途离开会把身份移交给别人，那时候第一个人就不是房主了。
        isHost: m.id === room.hostId,
        isBot: false,
      }));
      /*
       * 人机座位**也进 players**（这是"坐在座位上"的落地方式）。
       * 游戏模块把 `isBot: true` 的座位映射成 AI 座位 —— 从这一版起，
       * 游戏不再从 `options.aiFill` 自己造座位了（那条路已经作废，见 D9）。
       */
      for (const bot of room.bots.values()) {
        players.push({ id: bot.id, name: bot.name, isHost: false, isBot: true });
      }

      const { minSeats, maxSeats, maxBots } = seatLimits(game);
      /*
       * ⚠️ 开局门槛看的是**座位数**，不是真人人数。
       *
       * 这一条以前是 `room.members.size < meta.minPlayers`（只数真人），
       * 于是"一个人 + 一个人机"根本开不了局 —— 用户要的正是"按一下加一个人机就能玩"。
       * 现在真人下限由 `minSeats`（总座位，人机也算）承担，
       * `minPlayers` 只在游戏没写 `minSeats` 时当回退值（见 seatLimits）。
       * 真人当然至少要有 1 个（房主），但那是房间存在的前提，不用在这儿数。
       */
      if (players.length < minSeats) {
        // 座位不够是**最常见**的一种"点了没反应"，所以这句话必须给出下一步动作。
        // 提示语要跟着"这个游戏有没有电脑"变：斗地主（maxBots = 0）让人去加人机是句假话。
        const hint = maxBots > 0 ? '按「添加人机」补一个，或者等朋友进来' : '把房间号发给朋友，等人进来';
        return {
          ok: false,
          message: `座位不够：至少要 ${minSeats} 个座位（现在 ${players.length} 个）。${hint}`,
        };
      }
      if (players.length > maxSeats) {
        return { ok: false, message: `座位太多了：最多 ${maxSeats} 个（现在 ${players.length} 个）` };
      }

      const merged = { ...room.options, ...(options || {}) };
      try {
        room.match = game.createMatch(players, merged);
      } catch (err) {
        room.match = null;
        return { ok: false, message: `开局失败：${err && err.message || err}` };
      }
      room.options = merged;
      room.phase = PHASE.PLAYING;
      broadcastState(room);
      notifyMembers(room);   // joinable 从 true 变 false，好友那边要跟着变
      return { ok: true };
    },

    /** 房主在"本局结束"后再来一局：清掉对局、回到等待态，成员不动。 */
    reset(playerId) {
      const room = findRoomOf(playerId);
      if (!room) return { ok: false, message: '你不在任何房间里' };
      if (room.hostId !== playerId) return { ok: false, message: '只有房主能再开一局' };
      if (room.phase === PHASE.WAITING) return { ok: true };

      room.match = null;
      room.phase = PHASE.WAITING;
      broadcastState(room);
      notifyMembers(room);   // 又能进了
      return { ok: true };
    },

    /** 一个操作意图。状态变化后**把每个人的裁剪视图分别推下去**。 */
    act(playerId, act) {
      const room = findRoomOf(playerId);
      if (!room) return { ok: false, message: '你不在任何房间里' };
      if (room.phase !== PHASE.PLAYING) return { ok: false, message: '现在不能操作' };

      let result;
      try {
        result = room.match?.act?.(playerId, act);
      } catch (err) {
        result = { ok: false, message: `操作出错：${err && err.message || err}` };
      }
      if (result && result.ok === false) return result;

      if (room.match?.isOver?.()) room.phase = PHASE.OVER;
      broadcastState(room);
      return { ok: true };
    },

    /* ------------------------------ 人机座位 ------------------------------ */

    /**
     * 房主按一下加**一个**人机座位。
     *
     * 为什么是"按一下加一个"而不是"选补几个"（用户明确要求）：
     * 选数字的界面上，玩家看不到自己选了什么，得先记住"我选了几个"再抬头看座位；
     * 按一下就多一个座位，所见即所得。见 docs/DECISIONS.md D9。
     */
    botAdd(playerId) {
      const room = findRoomOf(playerId);
      if (!room) return { ok: false, message: '你不在任何房间里' };
      if (room.hostId !== playerId) return { ok: false, message: '只有房主能加人机' };
      if (room.phase !== PHASE.WAITING) return { ok: false, message: '这局已经开始了，不能再加人机' };

      const game = games.get(room.game);
      const { maxSeats, maxBots } = seatLimits(game);
      if (maxBots <= 0) {
        // 这个游戏没有电脑（比如斗地主）：三个人必须都是真人
        return { ok: false, message: '这个游戏没有电脑：要凑齐真人才能开局' };
      }
      if (seatCount(room) >= maxSeats) {
        return { ok: false, message: `座位满了（最多 ${maxSeats} 个）：先移除一个，或者就这样开局` };
      }

      // id 取"最小的没用过的序号"，所以移除再加不会让 `bot:3` 越滚越大
      let n = 1;
      while (room.bots.has(botId(n))) n += 1;
      const id = botId(n);

      // 名字沿用各游戏单机人机的单字池（没有自己的池子就用平台默认池），
      // 并且**优先挑房间里没人用过的字** —— 桌上两个"虎"会让人分不清谁是谁。
      const used = new Set([
        ...[...room.members.values()].map((m) => m.name),
        ...[...room.bots.values()].map((b) => b.name),
      ]);
      const name = pickBotName(game?.meta?.botNames, used, room.bots.size);

      room.bots.set(id, { id, name });
      broadcastState(room);
      notifyMembers(room);
      return { ok: true, id, name };
    },

    /** 房主移除一个人机座位（按错了、或者想换个配置）。 */
    botRemove(playerId, id) {
      const room = findRoomOf(playerId);
      if (!room) return { ok: false, message: '你不在任何房间里' };
      if (room.hostId !== playerId) return { ok: false, message: '只有房主能移除人机' };
      if (room.phase !== PHASE.WAITING) return { ok: false, message: '这局已经开始了，人机撤不掉' };

      const target = String(id || '');
      if (!room.bots.has(target)) return { ok: false, message: '没有这个座位' };
      room.bots.delete(target);
      broadcastState(room);
      notifyMembers(room);
      return { ok: true };
    },

    /* ------------------------------ 互动 ------------------------------ */

    /**
     * 扔鸡蛋 / 送鲜花（**同一个房间内**，不限次数）。
     *
     * 为什么由服务端转发而不是点对点直发：只有服务端知道"房里现在有谁"，
     * 而且**每个人的屏幕都要看到这发东西**（发起人、目标、旁观者），
     * 包括人机座位（`bot:1` 也能被扔）。
     *
     * 回执里带 `rid`：发起人本地已经乐观播过一次（不等服务器就播，见 D10），
     * 靠这个编号认出自己的回声、不重复播第二遍。
     */
    react(playerId, msg) {
      const room = findRoomOf(playerId);
      if (!room) return { ok: false, message: '你不在房间里' };

      const sender = room.members.get(playerId);
      if (!sender) return { ok: false, message: '你不在房间里' };

      const kind = String((msg && msg.kind) || '');
      if (!isReactKind(kind)) return { ok: false, message: '不认识这个互动' };

      const to = String((msg && msg.to) || '');
      if (!room.members.has(to) && !room.bots.has(to)) {
        return { ok: false, message: '他不在这个房间里' };
      }

      // 技术性防洪（不是玩法限制）：超了**静默丢弃**，见 REACT_BURST 的说明
      const now = Date.now();
      const hit = reactHits.get(playerId);
      if (!hit || now - hit.at > REACT_BURST.windowMs) {
        reactHits.set(playerId, { at: now, n: 1 });
      } else if (hit.n >= REACT_BURST.max) {
        return { ok: true, dropped: true };
      } else {
        hit.n += 1;
      }

      reactSeq += 1;
      const payload = {
        t: T.REACT,
        from: { id: playerId, name: sender.name, avatar: sender.avatar || '' },
        to,
        kind,
        rid: reactSeq,
      };
      // 发给房里的每一个真人（含发起人自己：他就是靠这条回执确认服务端收下了）
      for (const id of room.members.keys()) deliver(id, payload);
      return { ok: true, rid: reactSeq };
    },

    /** 给某人重发一次他所在的房间状态（WS 重连后调用）。 */
    resend(playerId) {
      const room = findRoomOf(playerId);
      if (!room) return false;
      const msg = stateMessage(room, playerId);
      if (msg) deliver(playerId, msg);
      return Boolean(msg);
    },

    /** 某人上线/下线。只改座位标记，不动座位本身。 */
    setOnline(playerId, online) {
      const room = findRoomOf(playerId);
      if (!room) return;
      const member = room.members.get(playerId);
      if (!member) return;
      member.online = online;
      member.offlineSince = online ? 0 : Date.now();
      broadcastState(room);
    },

    /** 改了平台昵称：房间座位上的名字跟着换（下一份 room.state 就是新名字）。 */
    setName(playerId, name) {
      const room = findRoomOf(playerId);
      if (!room) return false;
      const member = room.members.get(playerId);
      if (!member) return false;
      member.name = name;
      broadcastState(room);
      return true;
    },

    /** 定期清理：掉线超过宽限期的座位真正踢出，并按需移交房主身份。 */
    sweep(now = Date.now()) {
      for (const room of [...rooms.values()]) {
        let changed = false;
        for (const member of [...room.members.values()]) {
          if (member.online || !member.offlineSince) continue;
          if (now - member.offlineSince <= SEAT_GRACE_MS) continue;

          room.members.delete(member.id);
          seatOf.delete(member.id);
          seatChanged(member.id);
          try {
            room.match?.removePlayer?.(member.id);
          } catch { /* 同上 */ }
          changed = true;

          if (room.members.size === 0) { rooms.delete(room.code); changed = false; break; }
          if (room.hostId === member.id) {
            const next = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
            room.hostId = next.id;
          }
        }
        if (changed) {
          if (room.phase === PHASE.PLAYING && room.match?.isOver?.()) room.phase = PHASE.OVER;
          broadcastState(room);
        }
      }
    },

    /** 仅供测试与调试。 */
    _dump() {
      return [...rooms.values()].map((r) => ({
        code: r.code, game: r.game, hostId: r.hostId, phase: r.phase,
        members: memberList(r),
      }));
    },
  };

  return api;
}