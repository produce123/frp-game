/*
 * 狼人杀 · 平台接入层（HTTP API + 推送 + 对局记录）。
 *
 * 分工（重要，改之前先读）：
 *   · **规则和状态机**在 `games/werewolf/engine/index.mjs`（纯 ESM，服务器权威）。
 *     这个文件一行游戏规则都不写。
 *   · **身份**来自平台的会话 cookie（`server/auth.mjs`）。座位就是平台账号（`player.id`），
 *     客户端报上来的 id/昵称一律不采信。
 *   · **推送**走平台那条 WebSocket（`/ws`），消息类型 `T.WW_EVENT`。
 *     这条报文只是"叮咚"，客户端收到后自己再拉一次 `/game/status`（按人裁剪过的），
 *     所以广播里不会有任何底牌。
 *   · **对局记录**写进 SQLite（`game_records` / `game_record_players`），复盘只读数据库。
 *
 * 和旧版的区别：旧版把上游 TypeScript 后端编译成 `server-dist/` 再用 `createRequire` 加载；
 * 现在规则引擎直接是 ESM，`import` 进来即可 —— 没有 tsc、没有 CJS 桥。
 */

import { publicUser } from '../avatar.mjs';
import { T } from '../../shared/protocol.mjs';
import { createWerewolfEngine, roleName } from '../../games/werewolf/engine/index.mjs';

/** `/api/werewolf` 这个前缀，客户端和这里只认一份。 */
export const API_PREFIX = '/api/werewolf';

/**
 * @param {object} options
 * @param {ReturnType<import('../store.mjs').openStore>} options.store
 * @param {number} [options.timeoutScale] 只有测试会传（把状态倒计时缩到毫秒级）
 */
export function createWerewolfGame({ store, timeoutScale } = {}) {
  /** 平台 hub，后插（hub 的构造又需要本对象，见 server/server.mjs 的接线顺序）。 */
  let hub = null;

  const engine = createWerewolfEngine({
    timeoutScale,
    onChange: onRoomChange,
    onGameEnd: onGameEnd,
  });

  /* ------------------------------ 平台会问的东西 ------------------------------ */

  function presenceOf(userId) {
    return engine.presenceOf(String(userId || ''));
  }

  function roomOf(userId) {
    return engine.roomOf(String(userId || ''));
  }

  /**
   * 好友的房免密码。
   *
   * 规则：**房里只要有一个我的好友**，就可以不填密码直接进。
   * 密码从此只挡"拿到房号的陌生人"（房号会通过链接、截图流出去），
   * 而"好友邀请"这条路上永远不会多问一道密码 —— 用户要求的就是这个体验。
   */
  function canBypassPassword(userId, code) {
    const snapshot = engine.roomInfo(code, userId);
    if (!snapshot) return false;
    if (snapshot.players.some((p) => p.id === userId)) return true; // 本来就在房里（重连）
    const friendIds = new Set(store.listFriends(userId).map((f) => f.id));
    return snapshot.players.some((p) => friendIds.has(p.id));
  }

  /** 头像地址：和平台好友列表里的头像同源（`/avatar/<id>?v=<版本>`）。 */
  function avatarOf(user) {
    const base = `/avatar/${encodeURIComponent(user.id)}`;
    return user.avatar_at ? `${base}?v=${user.avatar_at}` : base;
  }

  /* ------------------------------ 引擎 → 平台 ------------------------------ */

  /**
   * 房间里任何变化（加入、开局、阶段推进、操作）→ 通知房里每个人刷新。
   * 顺便让每个玩家的好友刷新"正在玩什么"。
   */
  function onRoomChange(code) {
    if (!hub) return;
    const ids = engine.playerIdsOf(code);
    for (const id of ids) {
      hub.deliver(id, { t: T.WW_EVENT, code, event: 'sync', data: null });
      hub.pushFriendsOf(id);
    }
  }

  /**
   * 一局结束 → 写对局记录，并把 recordId 挂回房间（结算页拿它跳复盘）。
   * detail 里有所有人的身份，所以记录**只对参与者可读**（见 store.getGameRecord）。
   */
  function onGameEnd(room) {
    try {
      const game = room.game;
      if (!game) return null;
      const endedAt = Number(game.endedAt) || Date.now();
      const startedAt = Number(room.startedAt) || endedAt;
      const players = game.players || [];
      const rows = players.map((p) => ({
        id: p.id,
        seat: p.seat,
        name: p.name,
        character: roleName(p.role),
        alive: Boolean(p.alive),
      }));
      const detail = {
        roomCode: room.code,
        winner: game.winner,
        startedAt,
        endedAt,
        day: game.day,
        players: players.map((p) => ({
          id: p.id,
          seat: p.seat,
          name: p.name,
          role: p.role,
          roleName: roleName(p.role),
          alignment: p.alignment,
          alive: p.alive,
        })),
      };
      const recordId = store.insertGameRecord({
        game: 'werewolf',
        roomCode: room.code,
        winner: game.winner,
        startedAt,
        endedAt,
        detail,
        players: rows,
      });
      engine.attachRecord(room.code, recordId);
      return recordId;
    } catch (err) {
      // 写不进数据库只是"没有复盘"，绝不能影响这一局本身的结算
      console.error('[狼人杀] 写对局记录失败：', err && err.message);
      return null;
    }
  }

  /* ------------------------------ HTTP API ------------------------------ */

  /**
   * 处理一条 `/api/werewolf/*` 请求。统一返回 `{status, body}`：
   *   · 200 + `{ok:true, data}`        成功
   *   · 200 + `{ok:false, message}`    游戏层的拒绝（"密码错误"这种人话）
   *   · 401 + `{ok:false, message}`    没登录（页面据此回登录页）
   */
  async function handleApi(user, pathname, body = {}, query = null) {
    if (!user) return { status: 401, body: { ok: false, message: '还没登录' } };

    const suffix = pathname.slice(API_PREFIX.length) || '/';
    const self = { id: user.id, name: user.name, avatar: avatarOf(user) };
    // 增量拉消息：页面把"我已经收到第几号消息"带上来，只回传这之后的新消息
    // （不带上就是刚打开页面/刷新，服务端只给最近 200 条）。
    const sinceRaw = query && typeof query.get === 'function' ? Number(query.get('since')) : NaN;
    const viewOpts = Number.isFinite(sinceRaw) && sinceRaw > 0 ? { since: sinceRaw } : {};

    // 页面自己用：我是谁 + 我现在在哪个房间（刷新页面后恢复现场）
    if (suffix === '/me') {
      return {
        status: 200,
        body: { ok: true, data: { me: publicUser(user), room: presenceOf(user.id) } },
      };
    }

    // 邀请好友的弹窗用（和无名杀那个 `/api/noname/friends` 对齐）
    if (suffix === '/friends') {
      const list = hub ? hub.friendsWithPresence(user.id) : [];
      return { status: 200, body: { ok: true, data: { list } } };
    }

    // 我的对局记录（列表页）
    if (suffix === '/records') {
      const rows = store.listGameRecords(user.id, 'werewolf');
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            list: rows.map((r) => ({
              id: r.id,
              winner: r.winner,
              roomCode: r.room_code,
              startedAt: r.started_at,
              endedAt: r.ended_at,
              mySeat: r.seat,
              myCharacter: r.character,
              alive: Boolean(r.alive),
              playersCount: r.players_count,
            })),
          },
        },
      };
    }

    // 复盘（只有这一局的参与者能读）
    if (suffix.startsWith('/records/')) {
      const recordId = Number(suffix.slice('/records/'.length)) || 0;
      const record = store.getGameRecord(recordId, user.id);
      if (!record) return { status: 200, body: { ok: false, message: '没有这条记录（或者不是你那一局）' } };
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            record: {
              id: record.id,
              winner: record.winner,
              roomCode: record.room_code,
              startedAt: record.started_at,
              endedAt: record.ended_at,
              selfId: user.id,
              selfSeat: record.self.seat,
              players: record.detail && Array.isArray(record.detail.players) ? record.detail.players : [],
            },
          },
        },
      };
    }

    if (suffix === '/room/create') {
      const res = engine.createRoom({
        host: self,
        seats: body.seats,
        password: body.password,
        roles: body.roles,
        sheriff: body.sheriff,
        // 'side' = 屠边（默认）/ 'wipe' = 屠城
        winMode: body.winMode,
      });
      return envelope(res, res.ok ? { room: presenceOf(user.id) } : null);
    }

    if (suffix === '/room/join') {
      const code = String(body.code || body.roomNumber || '').trim();
      const bypass = canBypassPassword(user.id, code);
      const res = engine.joinRoom({
        user: self,
        code,
        password: body.password,
        friendBypass: bypass,
      });
      return envelope(res, res.ok ? { room: presenceOf(user.id) } : null);
    }

    if (suffix === '/room/leave') {
      const res = engine.leaveRoom(user.id);
      return envelope(res, res.ok ? { room: null } : null);
    }

    // 房主在等待区踢人（掉线的人不会自己退房，没这个接口房间就只能解散）
    if (suffix === '/room/kick') {
      const res = engine.kickPlayer(user.id, body.userId);
      return envelope(res, res.ok ? { room: presenceOf(user.id) } : null);
    }

    // 一局打完，房主点「再来一局」：房间退回等候区，座位和人都不动
    if (suffix === '/room/restart') {
      const res = engine.restartRoom(user.id);
      return envelope(res, res.ok ? { room: presenceOf(user.id) } : null);
    }

    if (suffix === '/room/init') {
      const room = roomOf(user.id);
      if (!room) return envelope({ ok: false, message: '你不在任何房间里' }, null);
      return { status: 200, body: { ok: true, data: { lobby: engine.roomInfo(room.code, user.id), me: publicUser(user) } } };
    }

    if (suffix === '/game/begin') {
      const res = engine.startGame(user.id);
      return envelope(res, res.ok ? { room: presenceOf(user.id) } : null);
    }

    if (suffix === '/game/status') {
      const view = engine.viewFor(user.id, viewOpts);
      return { status: 200, body: { ok: true, data: { room: presenceOf(user.id), view } } };
    }

    if (suffix === '/game/act') {
      const res = engine.act(user.id, body || {});
      return envelope(res, { view: engine.viewFor(user.id, viewOpts) });
    }

    return { status: 404, body: { ok: false, message: '没有这个接口' } };
  }

  function envelope(res, data) {
    if (res && res.ok) return { status: 200, body: { ok: true, data: data || {} } };
    return { status: 200, body: { ok: false, message: (res && res.message) || '请求失败' } };
  }

  function attachHub(nextHub) {
    hub = nextHub || null;
  }

  /** 只给测试 / 排查用。 */
  function stats() {
    return { ready: true, rooms: engine.stats() };
  }

  /** 停机 / 测试用：清空所有房间。 */
  function reset() {
    engine.reset();
  }

  /** 定时清扫：闲置 12 小时的大厅、结算后 1 小时的房间（由 `server.mjs` 每 60 秒调一次）。 */
  function sweep() {
    engine.sweep();
  }

  return {
    handleApi,
    presenceOf,
    roomOf,
    canBypassPassword,
    avatarOf,
    attachHub,
    stats,
    reset,
    sweep,
    /** 只给测试用：直接看引擎。 */
    _engine: engine,
  };
}