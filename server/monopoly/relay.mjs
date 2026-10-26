/*
 * 大富翁联机的 WebSocket 中转（替代上游的 PeerJS/WebRTC）。
 *
 * 上游是"房主浏览器跑游戏，客人连房主"的 P2P 模型；跨网络需要 TURN，而本项目
 * 只有 7891 一条隧道，不能开 UDP。所以服务端只做**消息转发**：
 *
 *   客人 ──WS──► 本文件 ──WS──► 房主
 *
 * 转发的是上游自己的消息（JSON 文本 + 地图分块二进制），服务端**不解析游戏内容**，
 * 也不保存对局状态。房间路由表（server/monopoly/index.mjs）只负责告诉客人
 * "房主的 peerId 是多少"，和上游 room-router 的职责一样。
 *
 * 帧格式：
 *   客户端 → 服务端：
 *     {"type":"hello", "resume"?:"p-..."}          注册，服务端回 {"type":"welcome","id"}
 *     {"type":"connect","to":"p-..."}                请求连某个 peer
 *     {"type":"data","to":"p-...","payload":"..."}    文本消息
 *     {"type":"close","to":"p-..."}                  断开某个连接
 *     二进制 [1][目标id长度:1][目标id][原始字节]        地图分块
 *   服务端 → 客户端：
 *     {"type":"welcome","id"}
 *     {"type":"connection","from":"p-..."}           有人连进来
 *     {"type":"connected","from":"p-..."}            自己发起的连接已建立
 *     {"type":"data","from":"p-...","payload":"..."}
 *     {"type":"peer-disconnect","id":"p-..."}
 *     {"type":"error","to":"p-...","message":"..."}
 *     二进制 [1][来源id长度:1][来源id][原始字节]
 *
 * `resume` 是为了房主断线重连后**peerId 不变**：房间路由表里存的是旧 id，
 * 如果重连换 id，客人手里的 hostPeerId 就永远连不上了。
 */

import { randomUUID } from 'node:crypto';

const MAX_ID_BYTES = 255;

/**
 * 断线之后 peerId 还能被**原主人**认领多久（房主重连回来还是同一个 id）。
 *
 * 为什么要有上限：`owners` 表以前**只增不减** —— 每开一次连接就多一条 `p-<uuid>`，
 * 一直挂到进程重启。开一天就是几千条，虽然每条很小，但这是纯粹的泄漏。
 */
const RESUME_TTL_MS = 30 * 60_000;
/** 表的上限。超过就先把过期的删掉，还超就按登记顺序删最老的。 */
const OWNERS_MAX = 256;

export function createMonopolyRelay() {
  /** peerId -> { conn, userId, at } */
  const peers = new Map();
  /** peerId -> { userId, at } —— 断线后仍允许原主人 resume 同一个 id */
  const owners = new Map();

  function send(conn, message) {
    try {
      conn.send(message);
    } catch {
      /* 对端已经断了 */
    }
  }

  /**
   * 收拾 `owners`：先删过期的，再按登记顺序删到上限以内。
   * 只删**当前没连着**的（`peers` 里还有的说明人家正在用）。
   */
  function pruneOwners(now = Date.now()) {
    for (const [id, owner] of owners) {
      if (now - owner.at > RESUME_TTL_MS) owners.delete(id);
    }
    if (owners.size <= OWNERS_MAX) return;
    for (const id of [...owners.keys()]) {
      if (owners.size <= OWNERS_MAX) break;
      if (!peers.has(id)) owners.delete(id);
    }
  }

  function notifyDisconnect(id) {
    for (const peer of peers.values()) {
      if (peer.conn.id !== id) send(peer.conn, { type: 'peer-disconnect', id });
    }
  }

  function parseBinary(buf) {
    if (!buf || buf.length < 2 || buf[0] !== 1) return null;
    const idLen = buf[1];
    if (!idLen || buf.length < 2 + idLen) return null;
    const to = buf.subarray(2, 2 + idLen).toString('utf8');
    if (!to) return null;
    return { to, payload: buf.subarray(2 + idLen) };
  }

  function wrapBinary(from, payload) {
    const idBytes = Buffer.from(from, 'utf8');
    if (idBytes.length > MAX_ID_BYTES) return null;
    return Buffer.concat([Buffer.from([1, idBytes.length]), idBytes, payload]);
  }

  function handleText(conn, peerId, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'hello': {
        if (peerId) return; // 已经注册过
        const now = Date.now();
        const userId = conn.data?.user?.id || '';
        let id = String(msg.resume || '');
        const owner = id ? owners.get(id) : null;
        if (!id || !owner || owner.userId !== userId) id = `p-${randomUUID()}`;

        // 同一个 id 还挂着旧连接（网络抖动时新连接先到）→ 先踢掉旧的
        const old = peers.get(id);
        if (old && old.conn !== conn) {
          peers.delete(id);
          try { old.conn.close(4000, '连接已恢复'); } catch { /* 已断 */ }
        }

        peers.set(id, { conn, userId, at: now });
        owners.set(id, { userId, at: now });
        // 插完再收拾：这样 `owners` 的稳态上限就是 OWNERS_MAX（不是 +1）
        pruneOwners(now);
        conn.data.monopolyPeerId = id;
        send(conn, { type: 'welcome', id });
        return;
      }

      case 'connect': {
        if (!peerId) return;
        const to = String(msg.to || '');
        if (!to || !peers.has(to)) {
          send(conn, { type: 'error', to, message: '房主不在线（可能已离开房间）' });
          return;
        }
        send(peers.get(to).conn, { type: 'connection', from: peerId });
        send(conn, { type: 'connected', from: to });
        return;
      }

      case 'data': {
        if (!peerId) return;
        const to = String(msg.to || '');
        const target = peers.get(to);
        if (!target) return;
        if (process.env.MONO_DEBUG) {
          try {
            const inner = JSON.parse(String(msg.payload ?? ''));
            console.log(`[mono-relay] ${peerId} -> ${to} ${inner?.type ?? '?'}${inner?.msg?.content ? ' ' + JSON.stringify(inner.msg.content) : ''}`);
          } catch { /* 非 JSON，忽略 */ }
        }
        send(target.conn, { type: 'data', from: peerId, payload: String(msg.payload ?? '') });
        return;
      }

      case 'close': {
        if (!peerId) return;
        const to = String(msg.to || '');
        const target = peers.get(to);
        if (target) send(target.conn, { type: 'peer-disconnect', id: peerId });
        return;
      }

      default:
        return;
    }
  }

  function handleBinary(conn, peerId, buf) {
    if (!peerId) return;
    const frame = parseBinary(buf);
    if (!frame) return;
    const target = peers.get(frame.to);
    if (!target) return;
    const out = wrapBinary(peerId, frame.payload);
    if (out) {
      try { target.conn.send(out); } catch { /* 对端已断 */ }
    }
  }

  /** 挂到 ws.mjs 的 `/monopoly-relay` 上。 */
  function onConnection(conn) {
    let peerId = '';

    conn.onMessage((payload, isBinary) => {
      peerId = conn.data.monopolyPeerId || '';
      if (isBinary) {
        handleBinary(conn, peerId, payload);
      } else {
        handleText(conn, peerId, String(payload));
      }
      peerId = conn.data.monopolyPeerId || peerId;
    });

    conn.onClose(() => {
      const id = conn.data.monopolyPeerId;
      if (!id) return;
      if (peers.get(id)?.conn === conn) {
        peers.delete(id);
        notifyDisconnect(id);
      }
    });
  }

  return {
    onConnection,
    get size() { return peers.size; },
    _peers: peers,
    _owners: owners,
    closeAll() {
      for (const peer of peers.values()) {
        try { peer.conn.close(1001, '服务端关闭'); } catch { /* 已断 */ }
      }
    },
  };
}