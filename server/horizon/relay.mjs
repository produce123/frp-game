/*
 * 地平线赛车的联机中继（`/horizon-relay`）。
 *
 * 为什么位置不走平台房间层：
 *   `server/rooms.mjs` 每收一条 act 就把整间房的 `room.state` 广播给每个人，
 *   而 `shared/ui/room.js` 会按 `view` 的 JSON 重画整块面板。车位置 10~15Hz
 *   走那条路等于每秒把房间面板重画十几次，手机上直接卡死。
 *   所以：**低频事件走平台房间层**（开局/完赛/结束），**高频车位置走这条独立 WS**。
 *
 * 这条中继只做"同一间地平线房里的转发"，**不模拟物理**：
 *   · 每个客户端自己算自己的车，位置/速度按固定频率发上来；
 *   · 服务端只核对"你真在这间房里、这局已经开了"，然后转给同房其他人；
 *   · 车与车的碰撞由各客户端用收到的对方位置做本地碰撞响应（用户明确要真实碰撞）。
 *   这样弱网下也不会出现"服务器把车拉回原位"的橡皮筋。
 *
 * 协议（JSON 文本帧）：
 *   客户端 → 服务端：
 *     {t:'hello', code, map, car}      注册（code = 平台 6 位房号；握手已鉴权）
 *     {t:'ready'}                      地图/车已就位，可以开始倒计时
 *     {t:'pos', x,y,z,yaw,vx,vz,speed,progress}   车状态（建议 10~15Hz）
 *     {t:'finish', time}               自己冲线
 *     {t:'over', timeout}:             房主宣布结束（8 分钟超时/有人掉线时）
 *     {t:'bye'}                        主动退出
 *   服务端 → 客户端：
 *     {t:'welcome', selfId, code, started, startedAt, peers:[{id,name,car}]}
 *     {t:'peer', id, name, car}        有人连进来
 *     {t:'peer-left', id}
 *     {t:'ready', id}
 *     {t:'go', delayMs, startedAt}     倒计时（delayMs 从收到消息算起）
 *     {t:'pos', id, x,y,z,yaw,vx,vz,speed,progress}
 *     {t:'finish', id, order, time}
 *     {t:'all-finished'}
 *     {t:'over', timeout}
 *     {t:'error', message}
 *
 * 房间里的成员表/阶段从 `rooms.snapshot(code)` 读 —— 平台房间层才是权威。
 */

/** 倒计时：收到 go 后多少毫秒发车。 */
const GO_DELAY_MS = 5000;
/** 等人全部 ready 的最长时间；超时就用已经连上的人开赛。 */
const READY_WAIT_MS = 15_000;
/** 一场比赛最长多久；到点由房主客户端宣布结束（DNF 记名次）。 */
const RACE_TIMEOUT_MS = 8 * 60_000;
/** 每条连接每秒最多几条消息（防坏客户端刷屏；正常 15Hz 碰不到）。 */
const MAX_MSG_PER_SEC = 40;

function send(conn, message) {
  try {
    conn.send(message);
  } catch {
    /* 对端已经断了 */
  }
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function createHorizonRelay({ rooms }) {
  /** code -> { code, conns: Map<userId, {conn, name, car}>, ready:Set, finished:Map,
   *           order:number, startedAt:number, startTimer, raceTimer, firstAt } */
  const tables = new Map();

  function tableFor(code) {
    let t = tables.get(code);
    if (!t) {
      t = {
        code,
        conns: new Map(),
        ready: new Set(),
        finished: new Map(),
        order: 0,
        startedAt: 0,
        startTimer: null,
        raceTimer: null,
        cleanupTimer: null,
        firstAt: 0,
      };
      tables.set(code, t);
    }
    return t;
  }

  function roomSnapshot(code) {
    try {
      return rooms.snapshot(code);
    } catch {
      return null;
    }
  }

  function broadcast(t, message, exceptId) {
    for (const [id, peer] of t.conns) {
      if (id === exceptId) continue;
      send(peer.conn, message);
    }
  }

  function expectedIds(t) {
    const snap = roomSnapshot(t.code);
    if (!snap || snap.phase !== 'playing') return [];
    return snap.members.filter((m) => m.online).map((m) => m.id);
  }

  function startRace(t) {
    if (t.startedAt) return;
    if (t.startTimer) {
      clearTimeout(t.startTimer);
      t.startTimer = null;
    }
    t.startedAt = Date.now() + GO_DELAY_MS;
    broadcast(t, { t: 'go', delayMs: GO_DELAY_MS, startedAt: t.startedAt });
    t.raceTimer = setTimeout(() => {
      t.raceTimer = null;
      // 到点不一定所有人在线：让客户端自己决定要不要发 room.act({type:'over'})。
      broadcast(t, { t: 'over', timeout: true });
    }, RACE_TIMEOUT_MS);
    if (typeof t.raceTimer.unref === 'function') t.raceTimer.unref();
  }

  function maybeStart(t) {
    if (t.startedAt || !t.conns.size) return;
    const expected = expectedIds(t);
    if (!expected.length) return;
    const allReady = expected.every((id) => t.ready.has(id));
    if (allReady) {
      startRace(t);
      return;
    }
    if (!t.startTimer) {
      t.startTimer = setTimeout(() => {
        t.startTimer = null;
        // 有人迟迟连不上（手机加载慢）：别让其他人干等，先发车。
        if (t.conns.size) startRace(t);
      }, READY_WAIT_MS);
      if (typeof t.startTimer.unref === 'function') t.startTimer.unref();
    }
  }

  function drop(t, userId, conn) {
    const peer = t.conns.get(userId);
    if (!peer) return;
    // 旧连接被新连接顶掉时，旧连接的 onClose 也会走到这里；
    // 只有"当前这条连接"才有资格把自己删掉，否则会把刚重连上的新连接踢掉。
    if (conn && peer.conn !== conn) return;
    t.conns.delete(userId);
    t.ready.delete(userId);
    broadcast(t, { t: 'peer-left', id: userId });
    if (!t.conns.size) {
      // 不立刻销毁：手机切后台/隧道抖一下时，重连还能接回同一场倒计时。
      // 30 秒内没人回来才清掉。
      if (t.cleanupTimer) clearTimeout(t.cleanupTimer);
      t.cleanupTimer = setTimeout(() => {
        if (t.conns.size) return;
        if (t.startTimer) clearTimeout(t.startTimer);
        if (t.raceTimer) clearTimeout(t.raceTimer);
        tables.delete(t.code);
      }, 30_000);
      if (typeof t.cleanupTimer.unref === 'function') t.cleanupTimer.unref();
    }
  }

  function clearCleanup(t) {
    if (!t.cleanupTimer) return;
    clearTimeout(t.cleanupTimer);
    t.cleanupTimer = null;
  }

  /** 挂到 ws.mjs 的 `/horizon-relay` 上。 */
  function onConnection(conn) {
    const user = conn.data && conn.data.user;
    if (!user) {
      conn.close(1008, '未登录');
      return;
    }

    let table = null;
    let lastMsgAt = 0;
    let msgBudget = MAX_MSG_PER_SEC;

    function join(code, car) {
      const snap = roomSnapshot(code);
      if (!snap) return '房间不存在';
      if (snap.game !== 'horizon') return '这不是地平线赛车房间';
      if (snap.phase !== 'playing') return '比赛还没开始';
      if (!snap.members.some((m) => m.id === user.id)) return '你不在这个房间里';

      const t = tableFor(code);
      clearCleanup(t);
      // 同一个账号重连：先踢掉旧连接，位置状态以新连接为准。
      const old = t.conns.get(user.id);
      if (old && old.conn !== conn) {
        t.conns.delete(user.id);
        try { old.conn.close(4000, '连接已恢复'); } catch { /* 已断 */ }
      }
      t.conns.set(user.id, { conn, name: user.name, car: String(car || '') });
      if (!t.firstAt) t.firstAt = Date.now();
      table = t;
      conn.data.horizonRoom = code;

      const peers = [...t.conns.entries()]
        .filter(([id]) => id !== user.id)
        .map(([id, p]) => ({ id, name: p.name, car: p.car }));

      send(conn, {
        t: 'welcome',
        selfId: user.id,
        code,
        started: Boolean(t.startedAt),
        startedAt: t.startedAt,
        peers,
      });
      if (t.startedAt) {
        send(conn, {
          t: 'go',
          delayMs: Math.max(0, t.startedAt - Date.now()),
          startedAt: t.startedAt,
        });
      } else {
        broadcast(t, { t: 'peer', id: user.id, name: user.name, car: String(car || '') }, user.id);
      }
      maybeStart(t);
      return null;
    }

    conn.onMessage((payload, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      if (now - lastMsgAt >= 1000) {
        lastMsgAt = now;
        msgBudget = MAX_MSG_PER_SEC;
      }
      if (msgBudget-- <= 0) return;

      let msg;
      try {
        msg = JSON.parse(String(payload));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      // 还没 hello：只认 hello
      if (!table) {
        if (msg.t !== 'hello') {
          send(conn, { t: 'error', message: '先发 hello' });
          return;
        }
        const err = join(String(msg.code || '').trim().toUpperCase(), msg.car);
        if (err) {
          send(conn, { t: 'error', message: err });
          try { conn.close(1008, err); } catch { /* 已断 */ }
        }
        return;
      }

      const t = table;
      // 房间可能已经被重置/删掉；位置消息不该再转给任何人。
      const snap = roomSnapshot(t.code);
      if (!snap || snap.phase !== 'playing') {
        send(conn, { t: 'error', message: '比赛已经结束' });
        return;
      }

      switch (msg.t) {
        case 'ready': {
          t.ready.add(user.id);
          broadcast(t, { t: 'ready', id: user.id });
          maybeStart(t);
          return;
        }

        case 'pos': {
          if (!t.startedAt) return;
          const state = {
            t: 'pos',
            id: user.id,
            x: num(msg.x),
            y: num(msg.y),
            z: num(msg.z),
            yaw: num(msg.yaw),
            vx: num(msg.vx),
            vz: num(msg.vz),
            speed: Math.max(0, Math.min(400, num(msg.speed))),
            progress: Math.max(0, Math.min(1, num(msg.progress))),
          };
          broadcast(t, state, user.id);
          return;
        }

        case 'finish': {
          if (!t.startedAt || t.finished.has(user.id)) return;
          t.order += 1;
          const result = {
            id: user.id,
            order: t.order,
            time: Math.max(0, Math.min(3600, num(msg.time))),
          };
          t.finished.set(user.id, result);
          broadcast(t, { t: 'finish', ...result });
          const expected = expectedIds(t);
          if (expected.length && expected.every((id) => t.finished.has(id))) {
            broadcast(t, { t: 'all-finished' });
          }
          return;
        }

        case 'over': {
          // 只有房主能宣布"比赛结束"；别人发来的 over 只当没看见。
          const snap = roomSnapshot(t.code);
          if (!snap || snap.hostId !== user.id) return;
          broadcast(t, { t: 'over', timeout: Boolean(msg.timeout) });
          return;
        }

        case 'bye': {
          drop(t, user.id, conn);
          table = null;
          return;
        }

        default:
          return;
      }
    });

    conn.onClose(() => {
      if (table) drop(table, user.id, conn);
    });
  }

  return {
    onConnection,
    get size() { return tables.size; },
    /** 仅供测试与调试。 */
    _tables: tables,
    closeAll() {
      for (const t of tables.values()) {
        if (t.startTimer) clearTimeout(t.startTimer);
        if (t.raceTimer) clearTimeout(t.raceTimer);
        if (t.cleanupTimer) clearTimeout(t.cleanupTimer);
        for (const peer of t.conns.values()) {
          try { peer.conn.close(1001, '服务端关闭'); } catch { /* 已断 */ }
        }
      }
      tables.clear();
    },
  };
}