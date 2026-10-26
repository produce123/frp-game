/*
 * 在线中心：谁在线、好友、邀请，以及所有 WebSocket 消息的分发。
 *
 * 一个玩家可以有多条连接（多开标签页），所以在线状态按**用户**聚合：
 * 只有第一条连接建立时才算上线，最后一条断开时才算下线。
 * 消息投递则发给该用户的所有连接（多开标签页能同时看到状态）。
 *
 * 这里不做聊天（用户明确要求），只做：
 *   ready / friends / room.* / invite / error
 *
 * 好友相关的推送**只有 friends 这一条**（全量列表）。在线状态变了、某人进了房间，
 * 都是重推一次列表 —— 好友就几个人，全量推比"只推变化量"少一整套合并逻辑，
 * 也就少一处能写错的地方。历史上有过一条单独的 friend.state，已经删掉了。
 */

import { T, normalizeCode } from '../shared/protocol.mjs';
import { publicUser } from './avatar.mjs';

/**
 * 同一账号最多同时挂几条连接。
 *
 * 为什么要上限：多标签页 + 手机重连竞速（`shared/net/net.js` 会并开两条）
 * 正常也就 3~4 条；浏览器抽风或有人写脚本时可以开到几百条，每条都要收广播。
 * 超过就**踢掉最早那条** —— 不会影响刚连上的那条（它才是用户眼前这个页面）。
 */
const MAX_CONNS_PER_USER = 8;

export function createHub({ store, rooms, nonamePresence = null, werewolf = null, monopolyPresence = null,
  mahjongPresence = null, aiTown = null }) {
  /** userId -> Set<WsConnection> */
  const conns = new Map();
  /** connId -> userId，断线时用 */
  const connOwner = new Map();

  /** rooms 才是座位的真相来源，这里只是起个短名字。 */
  const presenceOf = (userId) => rooms.presenceOf(userId);

  /** 无名杀页面不走平台 WebSocket，它的"在玩"由心跳单独记着。 */
  const nonameOf = (userId) => (nonamePresence ? nonamePresence.presenceOf(userId) : null);

  /**
   * 狼人杀的"在玩"直接问游戏核心（它本来就有房间表），**没有心跳、没有 TTL**。
   * 狼人杀页面连的就是平台这条 WebSocket，人跑了 `isOnline` 立刻就是 false，
   * 所以不需要第二套在线判断 —— 这正是把它缝进同一进程换来的好处。
   */
  const werewolfOf = (userId) => (werewolf ? werewolf.presenceOf(userId) : null);

  /** 大富翁页面不走平台 WS，它的"在玩"也是页面心跳报上来的（和无名杀同一套）。 */
  const monopolyOf = (userId) => (monopolyPresence ? monopolyPresence.presenceOf(userId) : null);

  /** 莲花广麻同理：页面心跳报到 `/api/mahjong/state`。 */
  const mahjongOf = (userId) => (mahjongPresence ? mahjongPresence.presenceOf(userId) : null);

  /** AI 小镇同理：页面心跳报到 `/ai-town/api/platform/state`。 */
  const aiTownOf = (userId) => (aiTown ? aiTown.presence.presenceOf(userId) : null);

  /* ------------------------------ 基础 ------------------------------ */

  function isOnline(userId) {
    return conns.has(userId) && conns.get(userId).size > 0;
  }

  /** 平台 WebSocket 在线 **或** 正在玩无名杀 / 狼人杀，都算"找得到这个人"。 */
  function isReachable(userId) {
    return isOnline(userId) || Boolean(nonameOf(userId)) || Boolean(werewolfOf(userId))
      || Boolean(monopolyOf(userId)) || Boolean(mahjongOf(userId)) || Boolean(aiTownOf(userId));
  }

  /** 把消息发给某人的**所有**连接。rooms.mjs 就是靠这个投递的。 */
  function deliver(userId, message) {
    const set = conns.get(userId);
    if (!set) return 0;
    let sent = 0;
    for (const conn of set) {
      if (conn.send(message)) sent++;
    }
    return sent;
  }

  function sendError(conn, message) {
    conn.send({ t: T.ERROR, message });
  }

  /** 好友列表 + 在线标记 + **他正在玩什么**。 */
  function friendsWithPresence(userId) {
    return store.listFriends(userId).map((f) => {
      const noname = nonameOf(f.id);
      const wolf = werewolfOf(f.id);
      const mono = monopolyOf(f.id);
      const mahjong = mahjongOf(f.id);
      const aiTownPlaying = aiTownOf(f.id);
      const inRoom = presenceOf(f.id);
      const online = isOnline(f.id) || Boolean(noname) || Boolean(wolf) || Boolean(mono) || Boolean(mahjong)
        || Boolean(aiTownPlaying);
      // 离线时房间可能还留着座位，但对别人没意义；无名杀/狼人杀/大富翁/麻将那边同理
      return {
        ...publicUser(f),
        online,
        playing: online ? (inRoom || wolf || noname || mono || mahjong || aiTownPlaying) : null,
      };
    });
  }

  /**
   * 好友相关的**唯一**一条推送（全量快照），三个部分：
   *   list     已经互相接受的好友（带在线状态 / 在玩什么）
   *   incoming 别人发给我的待处理申请 + 申请人名字
   *   outgoing 我发出去的、还没被处理的申请 + 收件人名字
   *
   * 申请是**双向可见**的：我发出去的要进我的 outgoing、也要进对方的 incoming，
   * 所以每处理一条申请都要推**两个**人的快照（见下面 dispatch 里的好友分支）。
   */
  function friendsSnapshot(userId) {
    return {
      t: T.FRIENDS,
      list: friendsWithPresence(userId),
      incoming: store.listIncomingRequests(userId).map(publicUser),
      outgoing: store.listOutgoingRequests(userId).map(publicUser),
    };
  }

  /** 把**我的**好友快照推给我。对方离线时 deliver() 自然什么也不做。 */
  function pushFriends(userId) {
    deliver(userId, friendsSnapshot(userId));
  }

  /** 一条申请/一次同意会同时改变双方的界面 —— 两边都要推。 */
  function pushFriendsBoth(a, b) {
    pushFriends(a);
    pushFriends(b);
  }

  /**
   * 我的**公开资料**变了（换了头像 / 恢复默认）→ 自己那份快照和所有好友看到的
   * 列表都要重推。好友列表里带头像地址，不推的话他们那边还是旧图。
   */
  function refreshFriends(userId) {
    pushFriends(userId);
    for (const friend of store.listFriends(userId)) {
      if (isOnline(friend.id)) pushFriends(friend.id);
    }
  }

  /**
   * 我身上发生了好友会关心的事（上线/下线/进了房间/离开房间）
   * → 刷新**所有好友**看到的列表。
   */
  function pushFriendsOf(userId) {
    for (const friend of store.listFriends(userId)) {
      if (isOnline(friend.id)) pushFriends(friend.id);
    }
  }

  /* ------------------------------ 连接生命周期 ------------------------------ */

  function attach(conn, user) {
    conn.data.user = user;
    connOwner.set(conn.id, user.id);

    let set = conns.get(user.id);
    const first = !set;
    if (!set) {
      set = new Set();
      conns.set(user.id, set);
    }
    // 连接数上限：踢掉最早建立的那条（Set 的遍历顺序就是插入顺序）
    while (set.size >= MAX_CONNS_PER_USER) {
      const oldest = set.values().next().value;
      set.delete(oldest);
      connOwner.delete(oldest.id);
      try { oldest.close(1008, '同一账号的连接太多了'); } catch { /* 已经断了 */ }
    }
    set.add(conn);

    conn.send({ t: T.READY, me: publicUser(user) });
    conn.send(friendsSnapshot(user.id));

    if (first) {
      rooms.setOnline(user.id, true);
      pushFriendsOf(user.id);
    }
    // 重连回原座位：把房间状态补发一次（包含自己裁剪过的 view）
    rooms.resend(user.id);

    conn.onMessage((text) => handleMessage(conn, text));
    conn.onClose(() => detach(conn));
  }

  function detach(conn) {
    const userId = connOwner.get(conn.id);
    connOwner.delete(conn.id);
    if (!userId) return;

    const set = conns.get(userId);
    if (!set) return;
    set.delete(conn);
    if (set.size > 0) return;

    conns.delete(userId);
    // 座位**不**在这里清掉：手机切后台/刷新都会断一下，清座位等于一刷新就丢局。
    // 真正的清理交给 rooms.sweep()。
    rooms.setOnline(userId, false);
    pushFriendsOf(userId);
  }

  /* ------------------------------ 消息处理 ------------------------------ */

  function handleMessage(conn, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      sendError(conn, '消息不是合法 JSON');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      sendError(conn, '消息缺少类型字段');
      return;
    }

    const user = conn.data.user;
    if (!user) { sendError(conn, '还没登录'); return; }

    try {
      dispatch(conn, user, msg);
    } catch (err) {
      sendError(conn, `服务端出错：${err && err.message || err}`);
    }
  }

  function dispatch(conn, user, msg) {
    switch (msg.t) {
      /* ---------- 房间 ---------- */

      case T.ROOM_CREATE: {
        const result = rooms.create({
          game: String(msg.game || ''),
          host: { id: user.id, name: user.name, avatar: user.avatar },
          options: msg.options && typeof msg.options === 'object' ? msg.options : {},
        });
        if (!result.ok) return sendError(conn, result.message);
        return;
      }

      case T.ROOM_JOIN: {
        const result = rooms.join({
          code: msg.code,
          player: { id: user.id, name: user.name, avatar: user.avatar },
        });
        if (!result.ok) return sendError(conn, result.message);
        return;
      }

      case T.ROOM_LEAVE: {
        rooms.leave(user.id);
        return;
      }

      case T.ROOM_START: {
        const result = rooms.start(user.id, msg.options);
        if (!result.ok) return sendError(conn, result.message);
        return;
      }

      case T.ROOM_RESET: {
        const result = rooms.reset(user.id);
        if (!result.ok) return sendError(conn, result.message);
        return;
      }

      case T.ROOM_ACT: {
        const result = rooms.act(user.id, msg.act);
        if (!result.ok) return sendError(conn, result.message);
        return;
      }

      /* ---------- 人机座位（房主按一下加一个） ---------- */

      case T.ROOM_BOT_ADD: {
        const result = rooms.botAdd(user.id);
        if (!result.ok) return sendError(conn, result.message);
        return;
      }

      case T.ROOM_BOT_REMOVE: {
        const result = rooms.botRemove(user.id, msg.id);
        if (!result.ok) return sendError(conn, result.message);
        return;
      }

      /* ---------- 互动（扔鸡蛋 / 送鲜花） ---------- */

      case T.REACT_SEND: {
        const result = rooms.react(user.id, { to: msg.to, kind: msg.kind });
        if (!result.ok) return sendError(conn, result.message);
        return;
      }

      /*
       * 应用层心跳：浏览器**发不出** WebSocket 的控制帧（那套 API 里没有 ping），
       * 所以保活与测延迟只能走一条普通消息。回一句 pong 就够了（见 shared/net/net.js）。
       * 这条消息不碰任何状态，也不广播。
       */
      case T.PING: {
        /*
         * 只回**发起这一条连接**，不 deliver 给这个账号的所有标签页。
         * 以前是 deliver：另一个标签页的 pong 会把这条连接的心跳标记清掉，
         * 于是一条已经"半死"的连接可能被别的标签页误判成还活着（`latencyMs` 也会串台）。
         * 浏览器发不出协议层 ping，这条消息是唯一的保活手段，必须一问一答。
         */
        conn.send({ t: T.PONG, ts: msg.ts });
        return;
      }

      /* ---------- 好友 ---------- */
      /*
       * 申请-同意制（docs/DECISIONS.md D8）。四条消息都是"改一次两个人的关系"，
       * 所以每条处理完都要**给双方**推全量快照 —— 只推一边的话，
       * 另一边会一直挂着一条已经作废的申请。
       */

      case T.FRIEND_ADD: {
        const targetId = String(msg.id || '').trim().toUpperCase();
        if (targetId === user.id) return sendError(conn, '不能加自己');
        const target = store.findUser(targetId);
        if (!target) return sendError(conn, '没有这个 ID');
        if (store.listFriends(user.id).some((f) => f.id === targetId)) {
          return sendError(conn, '你们已经是好友了');
        }

        // 对方也申请过我 → 两个人其实都点了"加" → 直接互相成为好友。
        // 少了这一条，双方会各自停在"等待对方同意"上，谁也不动。
        if (store.findFriendRequest(targetId, user.id)) {
          store.addFriend(user.id, targetId);
          store.deleteFriendRequestsBetween(user.id, targetId);
          return pushFriendsBoth(user.id, targetId);
        }

        // 重复申请：不报错也不静默，明确告诉他"已经在等了"
        if (store.findFriendRequest(user.id, targetId)) {
          return sendError(conn, '已经发过申请了，等对方同意');
        }

        store.createFriendRequest(user.id, targetId);
        return pushFriendsBoth(user.id, targetId);
      }

      case T.FRIEND_ACCEPT: {
        const fromId = String(msg.id || '').trim().toUpperCase();
        // 只有"**他发给我**的申请"才轮得到我同意
        if (!store.findFriendRequest(fromId, user.id)) return sendError(conn, '没有这条申请');
        store.addFriend(user.id, fromId);
        store.deleteFriendRequestsBetween(user.id, fromId);
        return pushFriendsBoth(user.id, fromId);
      }

      case T.FRIEND_DECLINE: {
        const fromId = String(msg.id || '').trim().toUpperCase();
        if (!store.findFriendRequest(fromId, user.id)) return sendError(conn, '没有这条申请');
        store.deleteFriendRequest(fromId, user.id);
        return pushFriendsBoth(user.id, fromId);
      }

      case T.FRIEND_CANCEL: {
        const toId = String(msg.id || '').trim().toUpperCase();
        // 只能撤回**我发出去**的那条，不能替别人撤回
        if (!store.findFriendRequest(user.id, toId)) return sendError(conn, '没有这条申请');
        store.deleteFriendRequest(user.id, toId);
        return pushFriendsBoth(user.id, toId);
      }

      case T.FRIEND_REMOVE: {
        const targetId = String(msg.id || '').trim().toUpperCase();
        store.removeFriend(user.id, targetId);
        return pushFriendsBoth(user.id, targetId);
      }

      /* ---------- 邀请 ---------- */

      case T.INVITE_SEND: {
        /*
         * 邀请的"我在哪间房"有三种可能：
         *   · 平台房间（三个自建小游戏）—— 房号是平台 6 位短码
         *   · 狼人杀房间 —— 房号是狼人杀自己的 6 位数字，**没有平台房间**
         *   · 都没有 → 拒
         * 无名杀不发邀请（它在自己页面里，不连这条 WS），所以不在这里。
         */
        const platformRoom = rooms.findRoomOf(user.id);
        const wolfRoom = werewolf ? werewolf.roomOf(user.id) : null;
        const monoRoom = monopolyOf(user.id);
        const mahjongRoom = mahjongOf(user.id);
        const aiTownRoom = aiTownOf(user.id);
        if (!platformRoom && !wolfRoom && !monoRoom && !mahjongRoom && !aiTownRoom) return sendError(conn, '你还没在房间里');
        if (wolfRoom && wolfRoom.phase !== 'waiting') return sendError(conn, '已经开局了，不能再邀请人');
        if (monoRoom && monoRoom.started) return sendError(conn, '已经开局了，不能再邀请人');
        if (mahjongRoom && mahjongRoom.started) return sendError(conn, '已经开局了，不能再邀请人');
        // AI 小镇是"人已经在镇里玩"，房主随时可以拉好友进来 —— 不按 started 拦。

        const to = Array.isArray(msg.to) ? msg.to : [];
        if (!to.length) return sendError(conn, '没有选好友');

        const friendIds = new Set(store.listFriends(user.id).map((f) => f.id));
        const game = platformRoom ? platformRoom.game
          : wolfRoom ? 'werewolf'
            : monoRoom ? 'monopoly'
              : mahjongRoom ? 'mahjong' : 'ai-town';
        // 狼人杀/大富翁/麻将/AI 小镇的房间号是各自游戏里的号，平台房间是 6 位短码
        const code = platformRoom ? platformRoom.code
          : wolfRoom ? wolfRoom.code
            : monoRoom ? monoRoom.code
              : mahjongRoom ? mahjongRoom.code : aiTownRoom.code;
        let sent = 0;
        for (const raw of to) {
          const id = String(raw || '').trim().toUpperCase();
          if (!friendIds.has(id)) continue;          // 只能邀请好友
          if (!isOnline(id)) continue;               // 离线的人发不到，静默跳过
          sent += deliver(id, {
            t: T.INVITE,
            from: publicUser(user),
            game,
            code,
          });
        }
        if (sent === 0) sendError(conn, '一个都没发出去（好友可能都不在线）');
        return;
      }

      case T.INVITE_REPLY: {
        const fromId = String(msg.from || '').trim().toUpperCase();

        /*
         * 无名杀的邀请：房间号是它自己的（10 位数字之类），不是平台那套 6 位短码，
         * 所以**绝不能**走 normalizeCode + rooms.join —— 那会把合法的邀请判成"格式不对"。
         * 接受方跳转由无名杀桥接脚本负责，这里只把结果转告邀请人。
         */
        if (msg.game === 'noname') {
          if (fromId && store.listFriends(user.id).some((f) => f.id === fromId)) {
            deliver(fromId, {
              t: T.INVITE_REPLY,
              from: publicUser(user),
              game: 'noname',
              code: String(msg.code || ''),
              accept: Boolean(msg.accept),
            });
          }
          return;
        }

        /*
         * 狼人杀同理：房号是 6 位数字，走不了平台的 normalizeCode（那套字母表里没有 0/1），
         * 而且**狼人杀的座位由游戏核心管**，平台不能替它入座。
         * 接受方跳转由狼人杀页面自己做（`/werewolf/join?number=…` → 它自己发一条
         * HTTP `/api/werewolf/room/join`，好友的房自动免密码）。
         */
        if (msg.game === 'werewolf') {
          if (fromId && store.listFriends(user.id).some((f) => f.id === fromId)) {
            deliver(fromId, {
              t: T.INVITE_REPLY,
              from: publicUser(user),
              game: 'werewolf',
              code: String(msg.code || ''),
              accept: Boolean(msg.accept),
            });
          }
          return;
        }

        /*
         * 大富翁同理：房号是它自己的（1-12 字符），不能走 normalizeCode；
         * 而且**入房由游戏页面做**（`/games/monopoly/?join=`），平台不替它建 socket/座位。
         * 这里只把"接受/忽略"转告邀请人。
         */
        if (msg.game === 'monopoly') {
          if (fromId && store.listFriends(user.id).some((f) => f.id === fromId)) {
            deliver(fromId, {
              t: T.INVITE_REPLY,
              from: publicUser(user),
              game: 'monopoly',
              code: String(msg.code || ''),
              accept: Boolean(msg.accept),
            });
          }
          return;
        }

        /*
         * 莲花广麻同理：房号是上游麻将自己的（6 位大写字母/数字），走不了平台的
         * normalizeCode；入房由麻将页面做（`/mahjong/?join=…` 自动进房）。
         * 这里只把"接受/忽略"转告邀请人。
         */
        if (msg.game === 'mahjong') {
          if (fromId && store.listFriends(user.id).some((f) => f.id === fromId)) {
            deliver(fromId, {
              t: T.INVITE_REPLY,
              from: publicUser(user),
              game: 'mahjong',
              code: String(msg.code || ''),
              accept: Boolean(msg.accept),
            });
          }
          return;
        }

        /*
         * AI 小镇：房间号是平台为这个镇生成的 6 位码（**不是**上游小镇 id），
         * 接受邀请不能走 normalizeCode + rooms.join —— 那是平台房间层的 6 位短码，
         * 会把 AI 小镇的邀请当成平台房间。这里只登记"受邀"并把结果转告房主；
         * 接受方的页面由 app.js 新窗口打开 /ai-town/?room=<code>，桥接脚本负责进镇。
         */
        if (msg.game === 'ai-town') {
          const code = String(msg.code || '').trim().toUpperCase();
          if (msg.accept && code) aiTown?.rooms.markInvited(code, user.id);
          if (fromId && store.listFriends(user.id).some((f) => f.id === fromId)) {
            deliver(fromId, {
              t: T.INVITE_REPLY,
              from: publicUser(user),
              game: 'ai-town',
              code,
              accept: Boolean(msg.accept),
            });
          }
          return;
        }

        const code = normalizeCode(msg.code);
        if (!code) return sendError(conn, '房间号格式不对');

        if (msg.accept) {
          // 接受 = 直接入座，省掉客户端再发一次 room.join 的往返
          const result = rooms.join({ code, player: { id: user.id, name: user.name, avatar: user.avatar } });
          if (!result.ok) return sendError(conn, result.message);
        }
        // 告诉邀请人结果（只发给在线的邀请人，且仅当他是好友）
        if (fromId && store.listFriends(user.id).some((f) => f.id === fromId)) {
          deliver(fromId, {
            t: T.INVITE_REPLY,
            from: publicUser(user),
            code,
            accept: Boolean(msg.accept),
          });
        }
        return;
      }

      default:
        return sendError(conn, `不认识的消息类型：${msg.t}`);
    }
  }

  return {
    attach,
    detach,
    deliver,
    isOnline,
    isReachable,
    friendsWithPresence,
    pushFriends,
    pushFriendsOf,
    refreshFriends,
    handleMessage,
    get onlineCount() { return conns.size; },
    /** 停机时用。 */
    closeAll() {
      for (const set of conns.values()) for (const conn of set) conn.close(1001, '服务端关闭');
    },
  };
}