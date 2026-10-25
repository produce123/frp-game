/*
 * AI 小镇的房间表。
 *
 * 一个"房间"= 某位房主开着的**一个世界**。房间号是平台自己发的 6 位码，
 * 不是上游的小镇 id：
 *   · 上游的默认图 id 是 `data/maps/2d-town`，每个用户 --root 下都一样；
 *   · 如果拿 townId 当房间号，两个用户开同一张默认图就会撞成一个房间。
 * 所以房间号单独生成，房间表里记 `townId`（给上游接口用）和 `id`（给邀请/深链用）。
 *
 * 这个模块只管数据与生命周期，不认识 HTTP / WebSocket / 进程。
 */

import { randomInt } from 'node:crypto';

import { IDLE_ROOM_MS, MAX_PIPES_PER_ROOM, MAX_ROOMS, MAX_ROOM_MEMBERS, TICKET_TTL_MS } from './config.mjs';

/** 去掉容易看错的 0/O/1/I。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function newCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

function ticketCode() {
  let out = '';
  for (let i = 0; i < 32; i++) out += '0123456789abcdef'[randomInt(16)];
  return out;
}

export function createAiTownRooms({ managers, presence, log = console.log } = {}) {
  /** roomId -> room */
  const rooms = new Map();
  /** userId -> roomId（一个人同一时间只在一个房间里） */
  const userRoom = new Map();
  /** sid -> { userId, roomId, role, expiresAt } */
  const tickets = new Map();
  /** roomId -> Map<userId, invitedAt> */
  const invited = new Map();

  function playingOf(room) {
    return {
      game: 'ai-town',
      code: room.id,
      phase: 'playing',
      joinable: room.joinable,
      started: true,
      count: room.members.size,
    };
  }

  function refreshPresence(room) {
    for (const userId of room.members) {
      presence.set(userId, { town: room.id, joinable: room.joinable, started: true, count: room.members.size });
    }
  }

  function clearPresence(room) {
    for (const userId of room.members) presence.clear(userId);
  }

  function ownerRoom(userId) {
    const id = userRoom.get(userId);
    return id ? rooms.get(id) || null : null;
  }

  function roomForUser(userId) {
    return ownerRoom(userId);
  }

  function get(roomId) {
    return rooms.get(String(roomId || '').toUpperCase()) || null;
  }

  function isMember(room, userId) {
    return Boolean(room && room.members.has(userId));
  }

  function markInvited(roomId, userId) {
    const room = get(roomId);
    if (!room) return false;
    let set = invited.get(room.id);
    if (!set) { set = new Map(); invited.set(room.id, set); }
    set.set(userId, Date.now());
    return true;
  }

  function wasInvited(room, userId) {
    const at = invited.get(room.id)?.get(userId);
    return Boolean(at && Date.now() - at < 30 * 60 * 1000);
  }

  /**
   * 房主开镇成功：登记/更新房间。
   * @param {object} entry 上游 open 返回的 entry（含 endpoint / lease）
   */
  async function hostOpened(userId, townId, entry) {
    const current = ownerRoom(userId);
    if (current && current.townId === townId && current.ownerId === userId) {
      current.entry = entry;
      return current;
    }
    // 换镇 = 先关掉上一个房间（上游 max-running=1 也会自己关，但账单要在这里结清）
    if (current) await closeRoom(current.id, { save: true });

    // 房间满了：第 3 个人开镇直接拒绝，别静默排队（用户看到的是"点了没反应"）
    if (rooms.size >= MAX_ROOMS) {
      throw new Error(`小镇满了（同时最多 ${MAX_ROOMS} 个），等别人关掉再来`);
    }

    // 同一个世界已经有人开着（理论上不会发生：每人的 root 独立）
    for (const room of rooms.values()) {
      if (room.townId === townId && room.ownerId !== userId) {
        throw new Error('这个小镇已经被别人开着');
      }
    }

    let id = newCode();
    while (rooms.has(id)) id = newCode();
    const room = {
      id,
      ownerId: userId,
      townId,
      entry,
      members: new Set([userId]),
      joinable: true,
      openedAt: Date.now(),
      // 从开镇开始计时：房主开了镇却一直没连 WS，也会被空闲清扫收掉。
      lastPipeAt: Date.now(),
      pipes: new Set(),
      closing: false,
    };
    rooms.set(id, room);
    userRoom.set(userId, id);
    refreshPresence(room);
    log(`AI 小镇房间已开：${id}（房主=${userId}，小镇=${townId}）`);
    return room;
  }

  /** 客人进房。房间不存在 / 不允许进时抛错。 */
  function join(userId, roomId) {
    const room = get(roomId);
    if (!room || room.closing) throw new Error('这个房间已经关了');
    if (room.members.has(userId)) {
      userRoom.set(userId, room.id);
      return room;
    }
    if (!room.joinable && !wasInvited(room, userId)) throw new Error('房主没开加入，先让房主邀请你');

    const current = ownerRoom(userId);
    if (current && current.id !== room.id) {
      if (current.ownerId === userId) throw new Error('你正在开自己的小镇，先关掉再进别人的');
      leave(userId);
    }

    if (!room.members.has(userId) && room.members.size >= MAX_ROOM_MEMBERS) {
      throw new Error('这个小镇满了（最多 4 人）');
    }
    room.members.add(userId);
    userRoom.set(userId, room.id);
    refreshPresence(room);
    log(`AI 小镇来客：${userId} → ${room.id}（现在 ${room.members.size} 人）`);
    return room;
  }

  function leave(userId) {
    const room = ownerRoom(userId);
    if (!room) return;
    if (room.ownerId === userId) {
      // 房主退出 = 保存并关镇（用户拍板）
      closeRoom(room.id, { save: true });
      return;
    }
    room.members.delete(userId);
    userRoom.delete(userId);
    presence.clear(userId);
    refreshPresence(room);
    log(`AI 小镇离开：${userId} ← ${room.id}（现在 ${room.members.size} 人）`);
  }

  async function closeRoom(roomId, { save = true } = {}) {
    const room = get(roomId);
    if (!room || room.closing) return;
    room.closing = true;
    rooms.delete(room.id);
    for (const member of room.members) {
      if (userRoom.get(member) === room.id) userRoom.delete(member);
      presence.clear(member);
    }
    for (const pipe of [...room.pipes]) {
      try { pipe.destroy(); } catch { /* 已经断了 */ }
    }
    room.pipes.clear();
    for (const [sid, ticket] of tickets) {
      if (ticket.roomId === room.id) tickets.delete(sid);
    }
    invited.delete(room.id);
    if (save) {
      const lease = room.entry?.lease;
      try {
        await managers.close(room.ownerId, room.townId, lease);
      } catch (err) {
        log(`AI 小镇关镇失败（${room.id}）：${err.message}`);
      }
    }
    log(`AI 小镇房间已关：${room.id}（房主=${room.ownerId}）`);
  }

  /** 给浏览器发一张进镇票据；WS 握手时用它 + 平台会话双重确认。 */
  function mintTicket(room, userId) {
    const sid = ticketCode();
    tickets.set(sid, {
      userId,
      roomId: room.id,
      role: room.ownerId === userId ? 'host' : 'guest',
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    return sid;
  }

  function verifyTicket(roomId, sid, userId) {
    const ticket = tickets.get(String(sid || ''));
    if (!ticket) return null;
    if (ticket.expiresAt < Date.now()) { tickets.delete(String(sid)); return null; }
    if (ticket.userId !== userId || ticket.roomId !== roomId) return null;
    return ticket;
  }

  /** 把上游 endpoint 换成平台同源 WS 地址；端口和上游 session 绝不发给浏览器。 */
  function browserEntry(room, userId, { proto = 'http', host = '127.0.0.1:7891' } = {}) {
    const sid = mintTicket(room, userId);
    const scheme = proto === 'https' ? 'wss' : 'ws';
    const endpoint = `${scheme}://${host}/ai-town/ws?room=${encodeURIComponent(room.id)}&sid=${sid}`;
    const entry = { ...room.entry, endpoint };
    // 关镇凭据只给房主：客人拿到 lease 就能把房主的世界关掉。
    if (userId !== room.ownerId) delete entry.lease;
    return entry;
  }

  /** WS 管道登记：房间关掉时把它们一起踢掉。 */
  function addPipe(room, destroy) {
    if (!room || room.closing) { try { destroy(); } catch { /* 已断 */ } return () => {}; }
    if (room.pipes.size >= MAX_PIPES_PER_ROOM) {
      try { destroy(); } catch { /* 已断 */ }
      throw new Error('这个房间的连接数满了');
    }
    const pipe = { destroy };
    room.pipes.add(pipe);
    room.lastPipeAt = Date.now();
    return () => { room.pipes.delete(pipe); };
  }

  function touchPipe(room) {
    if (room) room.lastPipeAt = Date.now();
  }

  function sweep() {
    const now = Date.now();
    for (const [sid, ticket] of tickets) {
      if (ticket.expiresAt < now) tickets.delete(sid);
    }
    for (const [roomId, set] of invited) {
      for (const [userId, at] of set) {
        if (now - at > 30 * 60 * 1000) set.delete(userId);
      }
      if (!set.size) invited.delete(roomId);
    }
    for (const room of [...rooms.values()]) {
      if (room.closing) continue;
      if (room.pipes.size === 0 && room.lastPipeAt > 0 && now - room.lastPipeAt > IDLE_ROOM_MS) {
        log(`AI 小镇房间空闲太久，自动关闭：${room.id}`);
        closeRoom(room.id, { save: true });
      }
    }
  }

  return {
    hostOpened,
    join,
    leave,
    closeRoom,
    get,
    roomForUser,
    isMember,
    markInvited,
    wasInvited,
    mintTicket,
    verifyTicket,
    browserEntry,
    addPipe,
    touchPipe,
    sweep,
    refreshPresence,
    get roomCount() { return rooms.size; },
    get rooms() { return rooms; },
  };
}