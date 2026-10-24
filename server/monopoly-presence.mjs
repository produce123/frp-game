/*
 * 「谁正在玩大富翁」—— 平台好友列表要显示这一条。
 *
 * 和无名杀一样：大富翁页面**不连平台的房间 WebSocket**（它的联机走 `/monopoly-relay`），
 * 所以页面里的桥接脚本每 15 秒 POST 一次很短的房间摘要；这里只记公开信息，
 * 超过 TTL 没心跳就当离开。不写数据库（重启就没了，本来也没价值）。
 *
 * 房号是**上游大富翁自己的房间号**（1-12 个字符），不是平台 6 位短码，所以正则单独一套。
 */

/** 心跳间隔（游戏页每 15 秒发一次）。 */
export const MONOPOLY_HEARTBEAT_MS = 15_000;
/** 超过这么久没心跳就当作离开。要大于心跳间隔，留两次丢包的余量。 */
export const MONOPOLY_TTL_MS = 45_000;

/** 上游允许 1-12 个字符（它只看长度）；这里只挡空白/控制字符，保留中文房号。 */
const ROOM_RE = /^[^\s\u0000-\u001f\u007f]{1,12}$/u;

function cleanText(value, max = 40) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/**
 * @param {object} [options]
 * @param {(userId: string) => void} [options.onChange] 状态一变就调（hub 用来刷新好友列表）
 */
export function createMonopolyPresence({ onChange = () => {} } = {}) {
  /** userId -> { room, started, count, joinable, at } */
  const map = new Map();

  function changed(userId) {
    try {
      onChange(userId);
    } catch {
      /* 刷新好友列表失败不该影响游戏本身 */
    }
  }

  /**
   * 收到一次心跳。`state.room` 为空 = 离开房间。
   * 返回 {ok, playing}；格式不对返回 {ok:false}，调用方回 400。
   */
  function set(userId, state) {
    if (!userId) return { ok: false, message: '还没登录' };
    const roomRaw = state && state.room;
    if (roomRaw == null || roomRaw === '') {
      return clear(userId) ? { ok: true, playing: false } : { ok: true, playing: false, unchanged: true };
    }
    const room = String(roomRaw);
    if (!ROOM_RE.test(room)) return { ok: false, message: '房间号格式不对' };

    const next = {
      room,
      started: Boolean(state.started),
      joinable: state.joinable === undefined ? !state.started : Boolean(state.joinable),
      count: Number.isFinite(Number(state.count)) ? Math.max(0, Math.min(99, Number(state.count))) : 0,
      at: Date.now(),
    };
    const prev = map.get(userId);
    map.set(userId, next);

    const same =
      prev &&
      prev.room === next.room &&
      prev.started === next.started &&
      prev.joinable === next.joinable &&
      prev.count === next.count;
    if (!same) changed(userId);
    return { ok: true, playing: true, unchanged: Boolean(same) };
  }

  /** 明确离开（收不到心跳也会自然过期）。返回"是否真的有过状态"。 */
  function clear(userId) {
    const had = map.delete(userId);
    if (had) changed(userId);
    return had;
  }

  /** 读这个人的公开摘要；过期了返回 null（顺手删掉）。 */
  function get(userId) {
    const entry = map.get(userId);
    if (!entry) return null;
    if (Date.now() - entry.at > MONOPOLY_TTL_MS) {
      map.delete(userId);
      return null;
    }
    return entry;
  }

  /** 定期清扫过期项。返回状态真的过期了的用户 id 列表。 */
  function sweep(now = Date.now()) {
    const expired = [];
    for (const [userId, entry] of map) {
      if (now - entry.at > MONOPOLY_TTL_MS) {
        map.delete(userId);
        expired.push(userId);
      }
    }
    for (const userId of expired) changed(userId);
    return expired;
  }

  /** 这个人现在算不算"在玩大富翁"（给好友列表合并在线状态用）。 */
  function isPlaying(userId) {
    return Boolean(get(userId));
  }

  /** 好友列表里"正在玩什么"的那一份形状（和 rooms.presenceOf 对齐）。 */
  function presenceOf(userId) {
    const entry = get(userId);
    if (!entry) return null;
    return {
      game: 'monopoly',
      code: entry.room,
      phase: entry.started ? 'playing' : 'waiting',
      /** 大富翁开局后就进不去了（客人只能在房间里等开局）。 */
      joinable: entry.joinable,
      started: entry.started,
      count: entry.count,
    };
  }

  /** 仅供测试与调试。 */
  function _dump() {
    return [...map.entries()].map(([userId, entry]) => ({ userId, ...entry }));
  }

  return { set, clear, get, sweep, isPlaying, presenceOf, _dump };
}

/** 校验房号（房间路由和邀请共用一套规则，避免两处不一致）。 */
export function isValidMonopolyRoom(room) {
  return ROOM_RE.test(String(room ?? ''));
}

/** 房号规范化：大富翁房号**大小写敏感**，只 trim，不转大写。 */
export function normalizeMonopolyRoom(room) {
  return cleanText(room, 12);
}