/*
 * AI 小镇的接入门面：静态页面之外的 HTTP / WS 全部在这里收口。
 *
 *   /ai-town/api/towns/**   → 上游 manager 的 /api/towns/**（登录必需）
 *   /ai-town/data/props     → 上游 manager 的 /data/props（登录必需）
 *   /ai-town/api/platform/* → 平台自己的：心跳、好友、邀请、进镇、布局
 *   /ai-town/ws             → 裸 TCP 管道到某个 host 的随机端口
 *
 * 关键设计：浏览器永远拿不到 127.0.0.1:随机端口和上游 ?session=。
 * endpoint 在返回前被换成同源 /ai-town/ws?room=<房间号>&sid=<票据>，
 * 端口/session 只在服务端房间表里。
 */

import { publicUser } from '../avatar.mjs';
import {
  API_PREFIX,
  MAX_ROOMS,
  PROPS_PREFIX,
  TOWN_API_PREFIX,
  WS_PATH,
} from './config.mjs';
import { createAiTownManagers } from './manager.mjs';
import { createAiTownPresence } from './presence.mjs';
import { createAiTownRooms } from './rooms.mjs';

const ROOM_RE = /^[A-Z0-9]{6}$/;
const MAX_PLATFORM_BODY = 64 * 1024;

function originOf(req) {
  const host = String(req.headers.host || '127.0.0.1:7891');
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const local = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
  return { host, proto: forwarded || (local ? 'http' : 'https') };
}

function readJsonBody(req, limit = MAX_PLATFORM_BODY) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolvePromise({});
      try { resolvePromise(JSON.parse(raw)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  }).end(payload);
}

function townAndAction(pathname) {
  // /ai-town/api/towns/<id>/<action>
  const rest = pathname.slice(TOWN_API_PREFIX.length).replace(/^\/+/, '');
  if (!rest) return { townId: '', action: '' };
  const parts = rest.split('/');
  return { townId: decodeURIComponent(parts[0] || ''), action: parts[1] || '' };
}

export function createAiTown({ store, hub = null, log = console.log } = {}) {
  const presence = createAiTownPresence({
    onChange: (userId) => hub && hub.pushFriendsOf(userId),
  });
  const managers = createAiTownManagers({ log });
  const rooms = createAiTownRooms({ managers, presence, log });

  /** manager 的会话只在这里；浏览器永远看不到。 */
  function layoutKind() { return 'ai-town/controls'; }

  function roomForUser(userId) {
    return rooms.roomForUser(userId);
  }

  function entryFor(room, userId, req) {
    return rooms.browserEntry(room, userId, originOf(req));
  }

  /** 房主页面打开某个小镇 → 真正调上游 open；客人 → 直接拿房主的 entry。 */
  async function openFor(user, townId, body, req) {
    const current = rooms.roomForUser(user.id);
    if (current && current.townId !== townId) {
      if (current.ownerId === user.id) await rooms.closeRoom(current.id, { save: true });
      else rooms.leave(user.id);
    }

    const room = rooms.roomForUser(user.id);
    if (room && room.townId === townId) {
      if (room.ownerId === user.id) {
        // 房主重开/刷新：拿一份新的 lease 与 endpoint（host 可能重启过）
        const entry = await managers.open(user.id, townId, { automatic: Boolean(body?.automatic) });
        const updated = await rooms.hostOpened(user.id, townId, entry);
        return entryFor(updated, user.id, req);
      }
      // 客人不调上游 open：上游的 lease 是房主的，客人调了会把房主的关镇凭据挤掉。
      return entryFor(room, user.id, req);
    }

    const entry = await managers.open(user.id, townId, { automatic: Boolean(body?.automatic) });
    const created = await rooms.hostOpened(user.id, townId, entry);
    return entryFor(created, user.id, req);
  }

  async function closeFor(user, townId, body) {
    const room = rooms.roomForUser(user.id);
    if (room && room.townId === townId) {
      if (room.ownerId !== user.id) {
        rooms.leave(user.id);
        return { ok: true, closed: false };
      }
      await rooms.closeRoom(room.id, { save: true });
      return { ok: true, closed: true };
    }
    // 没有房间记录（比如上次 Node 被强杀）：直接让 manager 关
    const ok = await managers.close(user.id, townId, body?.lease);
    return { ok: true, closed: ok };
  }

  /** 平台自己的接口。返回 true 表示已经处理。 */
  async function handlePlatform(req, res, user, pathname) {
    const sub = pathname.slice(API_PREFIX.length).replace(/^\/+/, '');

    if (sub === 'friends' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, friends: hub ? hub.friendsWithPresence(user.id) : [] }), true;
    }

    if (sub === 'status' && req.method === 'GET') {
      const room = rooms.roomForUser(user.id);
      return sendJson(res, 200, {
        ok: true,
        me: publicUser(user),
        room: room ? { id: room.id, townId: room.townId, joinable: room.joinable, count: room.members.size, owner: room.ownerId === user.id } : null,
      }), true;
    }

    if (sub === 'state' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (err) {
        return sendJson(res, 400, { ok: false, message: err.message }), true;
      }
      const room = rooms.roomForUser(user.id);
      if (!room) return sendJson(res, 409, { ok: false, message: '还没进镇' }), true;
      // 只有房主能改"是否允许好友加入"
      if (room.ownerId === user.id && typeof body?.joinable === 'boolean') room.joinable = body.joinable;
      presence.set(user.id, {
        town: room.id,
        joinable: room.joinable,
        started: true,
        count: room.members.size,
      });
      return sendJson(res, 200, {
        ok: true,
        room: room.id,
        town: room.townId,
        joinable: room.joinable,
        count: room.members.size,
        owner: room.ownerId === user.id,
      }), true;
    }

    if (sub === 'invite' && req.method === 'POST') {
      if (!hub) return sendJson(res, 503, { ok: false, message: '在线服务没接上' }), true;
      let body;
      try { body = await readJsonBody(req); } catch (err) {
        return sendJson(res, 400, { ok: false, message: err.message }), true;
      }
      const room = rooms.roomForUser(user.id);
      if (!room || room.ownerId !== user.id) {
        return sendJson(res, 403, { ok: false, message: '只有房主能邀请' }), true;
      }
      const to = Array.isArray(body?.to) ? body.to : [];
      const friends = new Set(store.listFriends(user.id).map((f) => f.id));
      const delivered = [];
      const failed = [];
      for (const raw of to) {
        const id = String(raw || '').trim().toUpperCase();
        if (!friends.has(id)) { failed.push({ id, reason: '不是好友' }); continue; }
        if (!hub.isReachable(id)) { failed.push({ id, reason: '不在线' }); continue; }
        rooms.markInvited(room.id, id);
        const sent = hub.deliver(id, {
          t: 'invite',
          from: publicUser(user),
          game: 'ai-town',
          code: room.id,
        });
        if (sent > 0) delivered.push(id);
        else failed.push({ id, reason: '发不出去' });
      }
      return sendJson(res, 200, { ok: true, room: room.id, delivered, failed }), true;
    }

    if (sub === 'join' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (err) {
        return sendJson(res, 400, { ok: false, message: err.message }), true;
      }
      const code = String(body?.room || '').trim().toUpperCase();
      if (!ROOM_RE.test(code)) return sendJson(res, 400, { ok: false, message: '房间号不对' }), true;
      let room;
      try {
        room = rooms.join(user.id, code);
      } catch (err) {
        // 已受邀的人即使房主关了"允许加入"也能进；这里只报真正的原因
        return sendJson(res, 403, { ok: false, message: err.message }), true;
      }
      return sendJson(res, 200, {
        ok: true,
        room: room.id,
        town: room.townId,
        entry: entryFor(room, user.id, req),
        joinable: room.joinable,
        count: room.members.size,
      }), true;
    }

    if (sub === 'room' && req.method === 'GET') {
      const url = new URL(req.url, 'http://127.0.0.1');
      const code = String(url.searchParams.get('room') || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return sendJson(res, 404, { ok: false, message: '房间不存在或已关闭' }), true;
      return sendJson(res, 200, {
        ok: true,
        room: { id: room.id, townId: room.townId, joinable: room.joinable, count: room.members.size },
      }), true;
    }

    if (sub === 'leave' && req.method === 'POST') {
      rooms.leave(user.id);
      return sendJson(res, 200, { ok: true }), true;
    }

    if (sub === 'close' && req.method === 'POST') {
      const room = rooms.roomForUser(user.id);
      if (!room) return sendJson(res, 200, { ok: true, closed: false }), true;
      if (room.ownerId !== user.id) {
        rooms.leave(user.id);
        return sendJson(res, 200, { ok: true, closed: false }), true;
      }
      await rooms.closeRoom(room.id, { save: true });
      return sendJson(res, 200, { ok: true, closed: true }), true;
    }

    if (sub === 'layout' && req.method === 'GET') {
      const layout = store.getLayout(user.id, layoutKind());
      return sendJson(res, 200, { ok: true, layout: layout ? JSON.parse(layout) : null }), true;
    }

    if (sub === 'layout' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (err) {
        return sendJson(res, 400, { ok: false, message: err.message }), true;
      }
      const layout = sanitizeLayout(body);
      if (!layout) return sendJson(res, 400, { ok: false, message: '布局格式不对' }), true;
      store.setLayout(user.id, layoutKind(), JSON.stringify(layout));
      return sendJson(res, 200, { ok: true }), true;
    }

    return false;
  }

  /** 把布局限制在四个控件、归一化坐标、44..160 的尺寸。 */
  function sanitizeLayout(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (Number(raw.v) !== 1) return null;
    const src = raw.controls && typeof raw.controls === 'object' ? raw.controls : null;
    if (!src) return null;
    const out = { v: 1, controls: {} };
    for (const name of ['stick', 'act', 'bag', 'cycle']) {
      const item = src[name];
      if (!item || typeof item !== 'object') return null;
      const x = Number(item.x);
      const y = Number(item.y);
      const size = Number(item.size);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(size)) return null;
      out.controls[name] = {
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
        size: Math.max(44, Math.min(160, Math.round(size))),
      };
    }
    return out;
  }

  /** 反代 /ai-town/api/towns 与 /ai-town/data/props。 */
  async function proxyHttp(req, res, user, pathname) {
    const origin = originOf(req);
    if (pathname === PROPS_PREFIX || pathname.startsWith(`${PROPS_PREFIX}/`)) {
      const target = pathname.replace(PROPS_PREFIX, '/data/props');
      const managerUserId = rooms.roomForUser(user.id)?.ownerId || user.id;
      return managers.proxyHttp(req, res, managerUserId, target);
    }

    const { townId, action } = townAndAction(pathname);
    const room = rooms.roomForUser(user.id);

    if (!townId) {
      // 列表：客人在房里时看房主的小镇列表，否则看自己的
      const managerUserId = room ? room.ownerId : user.id;
      return managers.proxyHttp(req, res, managerUserId, '/api/towns');
    }

    if (action === 'open' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message }), true;
      }
      try {
        const entry = await openFor(user, townId, body, req);
        return sendJson(res, 200, entry), true;
      } catch (err) {
        return sendJson(res, 409, { ok: false, error: err.message }), true;
      }
    }

    if (action === 'close' && req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch { body = {}; }
      const result = await closeFor(user, townId, body);
      return sendJson(res, 200, result), true;
    }

    // 地图 / 存档 / 模型 / 建镇等：统一交给拥有这个小镇的 manager。
    // 客人只能看（GET）；改存档、重置、删镇、下载模型都是房主的事。
    const managerUserId = room && room.townId === townId ? room.ownerId : user.id;
    if (room && room.townId === townId && room.ownerId !== user.id && req.method !== 'GET') {
      return sendJson(res, 403, { ok: false, error: '只有房主能改这个小镇' }), true;
    }
    return managers.proxyHttp(req, res, managerUserId, pathname.replace(TOWN_API_PREFIX, '/api/towns'));
  }

  /**
   * ws.mjs 的前缀代理（裸 TCP）。
   * verify 只确认"登录了"，真正的房间/票据校验在 wsTarget。
   */
  function wsVerify(req) {
    // currentUser 由 server.mjs 通过闭包传进来
    const user = currentUserOf(req);
    if (!user) return { ok: false, code: 401, reason: '还没登录' };
    return { ok: true, data: { user } };
  }

  // 由 server.mjs 注入（避免这个模块直接依赖 auth 的细节）
  let currentUserOf = () => null;

  /**
   * 在 **upgrade 时**才决定目标端口：host 重启会换随机端口，而浏览器 URL 不变。
   * 返回 {port, host, path, headers}，由 ws.mjs 的 pipeUpgrade 改写。
   */
  async function wsTarget(req, verdict) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const roomId = String(url.searchParams.get('room') || '').trim().toUpperCase();
    const sid = String(url.searchParams.get('sid') || '').trim();
    const user = verdict?.data?.user;
    if (!user) throw Object.assign(new Error('还没登录'), { code: 401 });

    const room = rooms.get(roomId);
    if (!room || room.closing) throw Object.assign(new Error('房间不存在或已关闭'), { code: 410 });
    if (!rooms.isMember(room, user.id)) throw Object.assign(new Error('你不是这个房间的成员'), { code: 403 });
    const ticket = rooms.verifyTicket(room.id, sid, user.id);
    if (!ticket) throw Object.assign(new Error('进镇票据无效或已过期'), { code: 401 });

    let endpoint = room.entry?.endpoint;
    let parsed = null;
    try { parsed = endpoint ? new URL(endpoint) : null; } catch { parsed = null; }
    if (!parsed || !parsed.port) {
      // host 崩了 / 还没开：现场重新 open（端口会变，前端无感）
      const entry = await managers.open(room.ownerId, room.townId, { automatic: true });
      await rooms.hostOpened(room.ownerId, room.townId, entry);
      endpoint = entry.endpoint;
      parsed = new URL(endpoint);
    }

    const session = parsed.searchParams.get('session') || '';
    const q = new URLSearchParams({ session });
    q.set('frp_user', user.id);
    q.set('frp_name', user.name || '');
    q.set('frp_role', ticket.role);
    q.set('frp_room', room.id);
    q.set('frp_avatar', String(user.avatar || `/avatar/${encodeURIComponent(user.id)}`));
    return {
      host: '127.0.0.1',
      port: Number(parsed.port),
      path: `/?${q.toString()}`,
      headers: { host: `127.0.0.1:${parsed.port}` },
      // 房间关闭/房主退出时，ws.mjs 用这个把管道一起踢掉。
      onPipe: (destroy) => registerPipe(room.id, destroy),
    };
  }

  /** 房间被关/房主退出时，主动踢掉管道（ws.mjs 登记过来的）。 */
  function registerPipe(roomId, destroy) {
    const room = rooms.get(roomId);
    if (!room) { try { destroy(); } catch { /* 已断 */ } return () => {}; }
    return rooms.addPipe(room, destroy);
  }

  function sweep() {
    presence.sweep();
    rooms.sweep();
    managers.sweep();
  }

  async function close() {
    for (const room of [...rooms.rooms.values()]) {
      // 停机时保存（用户拍板：房主退出 = 保存并关镇）
      await rooms.closeRoom(room.id, { save: true }).catch(() => {});
    }
    await managers.stopAll();
  }

  return {
    presence,
    rooms,
    managers,
    handlePlatform,
    proxyHttp,
    wsVerify,
    wsTarget,
    registerPipe,
    entryFor,
    sweep,
    close,
    /** server.mjs 用它注入 currentUser（避免循环 import） */
    setUserResolver(fn) { currentUserOf = fn; },
    get roomCount() { return rooms.roomCount; },
    get managerCount() { return managers.activeCount; },
    get maxRooms() { return MAX_ROOMS; },
  };
}