/*
 * 大富翁（上游 MineMonopoly）的**平台接入层**。
 *
 * 边界（和 docs/ARCHITECTURE.md 的"上游缝合"一致）：
 *   · 游戏逻辑仍然在**房主浏览器**里跑（上游 GameProcessWorker），平台不重写规则；
 *   · 联机走本进程的 WebSocket 中转（server/monopoly/relay.mjs），不用 WebRTC/TURN；
 *   · 账号/好友/邀请用平台会话与 hub（server/hub.mjs），这里只提供上游页面要的
 *     `/monopoly-server/*` 兼容接口 + 官方公开地图列表。
 *
 * 不跑上游的 Express / MySQL / 管理后台 / 地图编辑器。房间表只在内存里，
 * 进程重启就没了（和上游 room-router 的内存表一样）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { isValidMonopolyRoom, normalizeMonopolyRoom } from '../monopoly-presence.mjs';

export const MONOPOLY_API_PREFIX = '/monopoly-server';
export const MONOPOLY_MAPS_PREFIX = '/monopoly-maps';
export const MONOPOLY_RELAY_PATH = '/monopoly-relay';

/** 房主心跳租约（和上游一致：30 秒租约 + 60 秒宽限）。 */
const HEART_LEASE_MS = 30_000;
const HEART_INTERVAL_MS = 5_000;
const LEASE_GRACE_MS = 60_000;
const CLOSED_RETENTION_MS = 5 * 60_000;
const SWEEP_MS = 2_000;

function ok(data, extra = {}) {
  return { status: 200, body: { status: 200, data, ...extra } };
}
function fail(status, msg) {
  return { status, body: { status, msg } };
}
function bool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * 读 `games/monopoly/maps/manifest.json`，转换成上游 `GameMapInDb` 的形状。
 * 只列**文件真的存在**的条目；缺文件就跳过（宁可少一张图，不要给客户端一个 404 的地图）。
 */
export function loadMaps(mapsDir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(mapsDir, 'manifest.json'), 'utf8'));
  } catch {
    return [];
  }
  const entries = Array.isArray(manifest?.maps) ? manifest.maps : [];
  const out = [];
  for (const item of entries) {
    if (!item || !item.id || !item.file) continue;
    if (!existsSync(join(mapsDir, item.file))) continue;
    const cover = item.cover ? `${MONOPOLY_MAPS_PREFIX}/${encodeURI(item.cover)}` : '';
    out.push({
      id: String(item.id),
      name: String(item.name || '未命名地图'),
      author: String(item.author || ''),
      version: Number(item.version) || 0,
      description: String(item.description || ''),
      pendingChangelog: null,
      changelog: [],
      hash: String(item.hash || ''),
      coverUrl: cover,
      mapUrl: `${MONOPOLY_MAPS_PREFIX}/${encodeURI(item.file)}`,
      inuse: item.inuse !== false,
      creatorId: null,
      creatorName: String(item.author || '') || null,
      creatorAccount: null,
      isOfficial: true,
      status: 'published',
      rejectReason: null,
      pendingUrl: null,
      pendingSourceUrl: null,
      // 上游付费 .fpmap 源文件**不提供**（用户已明确：只要官方公开的 .mmmap）
      sourceUrl: null,
      pendingHash: null,
      pendingVersion: null,
    });
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} options.mapsDir
 * @param {string} [options.assetsPrefix] 页面静态资源前缀（诊断用）
 */
export function createMonopoly({ mapsDir, assetsPrefix = '/games/monopoly/' } = {}) {
  const maps = loadMaps(mapsDir);
  const mapsById = new Map(maps.map((m) => [m.id, m]));
  /** roomId -> room */
  const rooms = new Map();

  function createRoom(roomId, user) {
    const room = {
      roomId,
      hostName: '',
      hostId: '',
      hostPeerId: null,
      createTime: Date.now(),
      deleteTime: Date.now() + HEART_LEASE_MS,
      lastHeartTime: Date.now(),
      isPrivate: true,
      isStarted: false,
      mapId: null,
      mapName: null,
      status: 'active',
      statusUpdatedAt: Date.now(),
      hostLeaseToken: randomUUID(),
      hostEpoch: 0,
      ownerUserId: user?.id || '',
    };
    rooms.set(roomId, room);
    return room;
  }

  function isHost(user, room) {
    // 老房间可能没记 owner（服务端刚重启/夺回），此时不拦，保持上游原有行为
    return !room.ownerUserId || room.ownerUserId === user?.id;
  }

  /** 定期把租约到期的房间标成 grace/expired，并清掉很久以前的关闭房间。 */
  function sweep(now = Date.now()) {
    for (const [roomId, room] of rooms) {
      if (room.status === 'active' && room.deleteTime < now) {
        room.status = 'grace';
        room.statusUpdatedAt = now;
      } else if (room.status === 'grace' && room.deleteTime + LEASE_GRACE_MS < now) {
        room.status = 'expired';
        room.statusUpdatedAt = now;
        room.hostPeerId = null;
      }
      if (room.status !== 'active' && room.status !== 'grace' && room.statusUpdatedAt + CLOSED_RETENTION_MS < now) {
        rooms.delete(roomId);
      }
    }
  }

  const sweepTimer = setInterval(() => sweep(), SWEEP_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  /**
   * 处理 `/monopoly-server/*`。
   * @param {object|null} user 平台会话用户（`{id,name}`）
   * @param {string} pathname 完整的 URL path
   * @param {URLSearchParams} query
   * @param {object} body JSON body（GET 时为 {}）
   */
  async function handleApi(user, pathname, query, body = {}) {
    if (!user) return fail(401, '还没登录平台');
    const rest = pathname.startsWith(MONOPOLY_API_PREFIX)
      ? pathname.slice(MONOPOLY_API_PREFIX.length)
      : pathname;

    /* ------------------------------ 地图 ------------------------------ */

    if (rest === '/game-map/list') {
      const page = Math.max(1, Number(query.get('page')) || 1);
      const size = Math.max(1, Math.min(100, Number(query.get('size')) || 10));
      const inuse = query.get('inuse');
      const filtered = inuse === 'true' ? maps.filter((m) => m.inuse) : maps;
      const start = (page - 1) * size;
      return ok({
        total: filtered.length,
        current: page,
        gameMapList: filtered.slice(start, start + size),
      });
    }

    if (rest === '/game-map/info') {
      const id = String(query.get('id') || '');
      const map = mapsById.get(id);
      if (!map) return fail(404, '地图不存在');
      return ok(map);
    }

    /* --------------------------- 房间路由 --------------------------- */

    if (rest === '/room-router/join') {
      const roomId = normalizeMonopolyRoom(query.get('roomId'));
      if (!isValidMonopolyRoom(roomId)) return fail(400, 'RoomId不符合标准');

      const room = rooms.get(roomId);
      if (!room) {
        const created = createRoom(roomId, user);
        return ok({
          hostPeerId: '',
          needCreate: true,
          deleteIntervalMs: HEART_LEASE_MS,
          heartbeatIntervalMs: HEART_INTERVAL_MS,
          // 中转模式下不需要 TURN；上游只把这份塞进 RTCPeerConnection，不会用到
          iceServers: [],
          hostLeaseToken: created.hostLeaseToken,
          hostEpoch: 0,
        });
      }
      if (room.status !== 'active' && room.status !== 'grace') {
        return fail(410, room.status === 'closed' ? '房间已关闭' : '房间已过期');
      }
      if (room.hostPeerId) {
        return ok({
          hostPeerId: room.hostPeerId,
          needCreate: false,
          iceServers: [],
          hostEpoch: room.hostEpoch,
          heartbeatIntervalMs: HEART_INTERVAL_MS,
        });
      }
      /*
       * 上游这里只回 `{status:202,msg}`，没有 data；而客户端把 202 当成功，
       * 接着读 `response.data.iceServers` 会抛 "Cannot read properties of undefined"。
       * 我们补一个空 data，让客户端走到它自己的 "房主尚未就绪，请稍后重试"。
       */
      return {
        status: 202,
        body: {
          status: 202,
          msg: '服务器正在与房主建立联系, 请稍后重试...',
          data: { hostPeerId: '', needCreate: false, iceServers: [], hostEpoch: 0 },
        },
      };
    }

    if (rest === '/room-router/emit-host') {
      const roomId = normalizeMonopolyRoom(body.roomId);
      const { hostPeerId, hostName, hostId, hostLeaseToken } = body;
      if (!isValidMonopolyRoom(roomId) || !hostPeerId || !hostName || !hostId) {
        return fail(400, 'RoomId不符合标准');
      }
      const room = rooms.get(roomId);
      if (!room) return fail(400, 'RoomId不存在');
      if ((room.status !== 'active' && room.status !== 'grace') || room.hostLeaseToken !== hostLeaseToken) {
        return fail(409, '房主租约无效');
      }
      room.hostPeerId = String(hostPeerId);
      room.hostName = String(hostName);
      room.hostId = String(hostId);
      room.ownerUserId = user.id;
      room.hostEpoch += 1;
      room.status = 'active';
      room.statusUpdatedAt = Date.now();
      room.deleteTime = Date.now() + HEART_LEASE_MS;
      room.lastHeartTime = Date.now();
      return ok({ hostEpoch: room.hostEpoch });
    }

    if (rest === '/room-router/heart') {
      const roomId = normalizeMonopolyRoom(query.get('roomId'));
      const token = query.get('hostLeaseToken');
      const room = rooms.get(roomId);
      if (!room || (room.status !== 'active' && room.status !== 'grace') || room.hostLeaseToken !== token) {
        return fail(409, '房主租约无效');
      }
      room.deleteTime = Date.now() + HEART_LEASE_MS;
      room.lastHeartTime = Date.now();
      room.status = 'active';
      room.statusUpdatedAt = Date.now();
      return { status: 200, body: { status: 200 } };
    }

    if (rest === '/room-router/delete') {
      const roomId = normalizeMonopolyRoom(query.get('roomId'));
      const token = query.get('hostLeaseToken');
      const room = rooms.get(roomId);
      if (!room) return { status: 200, body: { status: 200 } };
      if (room.hostLeaseToken !== token) return fail(409, '房主租约无效');
      room.status = 'closed';
      room.statusUpdatedAt = Date.now();
      room.hostPeerId = null;
      return { status: 200, body: { status: 200 } };
    }

    if (rest === '/room-router/status') {
      const roomId = normalizeMonopolyRoom(query.get('roomId'));
      const room = rooms.get(roomId);
      if (!room) return ok({ status: 'expired', hostEpoch: 0 });
      return ok({ status: room.status, hostEpoch: room.hostEpoch });
    }

    if (rest === '/room-router/reclaim-host') {
      const roomId = normalizeMonopolyRoom(body.roomId);
      const { hostPeerId, hostName, hostId, hostLeaseToken } = body;
      if (!isValidMonopolyRoom(roomId) || !hostPeerId || !hostName || !hostId) {
        return fail(400, '参数不完整');
      }
      const room = rooms.get(roomId);
      if (!room) {
        const created = createRoom(roomId, user);
        created.hostPeerId = String(hostPeerId);
        created.hostName = String(hostName);
        created.hostId = String(hostId);
        created.hostEpoch = 1;
        // 恢复中的房间保守设私有+已开局（和上游一致）
        created.isPrivate = true;
        created.isStarted = true;
        return ok({ hostLeaseToken: created.hostLeaseToken, hostEpoch: 1 });
      }
      if (room.status === 'closed') return fail(410, '房间已关闭');
      if (room.status === 'active') return fail(400, '房间仍处于活跃状态，无需夺回');
      if (room.hostLeaseToken !== hostLeaseToken) return fail(409, '房主租约无效');
      room.hostLeaseToken = randomUUID();
      room.hostPeerId = String(hostPeerId);
      room.hostName = String(hostName);
      room.hostId = String(hostId);
      room.ownerUserId = user.id;
      room.hostEpoch += 1;
      room.status = 'active';
      room.statusUpdatedAt = Date.now();
      room.deleteTime = Date.now() + HEART_LEASE_MS;
      room.lastHeartTime = Date.now();
      return ok({ hostLeaseToken: room.hostLeaseToken, hostEpoch: room.hostEpoch });
    }

    if (rest === '/room-router/room-list') {
      return ok(
        [...rooms.values()]
          .filter((r) => r.status === 'active' && r.hostPeerId)
          .map((r) => ({ ...r, hostPeerId: null })),
      );
    }

    if (rest === '/room-router/random-public-room') {
      // 上游这个接口返回的是**顶层** `{roomId}`（客户端 `(res as any).roomId`），不是 data
      const publicRooms = [...rooms.values()].filter(
        (r) => r.status === 'active' && !r.isPrivate && !r.isStarted && r.hostPeerId,
      );
      const picked = publicRooms.length
        ? publicRooms[Math.floor(Math.random() * publicRooms.length)]
        : null;
      return { status: 200, body: { status: 200, roomId: picked ? picked.roomId : '' } };
    }

    if (rest === '/room-router/set-private') {
      const roomId = normalizeMonopolyRoom(body.roomId);
      const room = rooms.get(roomId);
      if (!room) return fail(400, '不存在的房间');
      if (!isHost(user, room)) return fail(403, '只有房主能改这个');
      room.isPrivate = bool(body.isPrivate);
      return ok(
        { roomId, isPrivate: room.isPrivate },
        { msg: room.isPrivate ? '现在房间只能通过输入ID进入啦' : '已将房间公开' },
      );
    }

    if (rest === '/room-router/set-started') {
      const roomId = normalizeMonopolyRoom(body.roomId);
      const room = rooms.get(roomId);
      if (!room) return fail(400, '不存在的房间');
      if (!isHost(user, room)) return fail(403, '只有房主能开始游戏');
      room.isStarted = bool(body.isStarted);
      room.mapId = body.mapId ? String(body.mapId) : room.mapId;
      room.mapName = body.mapName ? String(body.mapName) : room.mapName;
      return ok(
        { roomId, isStarted: room.isStarted },
        { msg: room.isStarted ? '游戏开始！' : '游戏已结束' },
      );
    }

    return fail(404, `不认识的大富翁接口：${rest}`);
  }

  return {
    handleApi,
    maps,
    /** 仅供测试/排查。 */
    _rooms: rooms,
    _sweep: sweep,
    assetsPrefix,
    stop() {
      clearInterval(sweepTimer);
    },
  };
}