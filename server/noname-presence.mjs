/*
 * 「谁正在玩无名杀」—— 平台好友列表要显示这一条，但无名杀页面**不走平台的 WebSocket**。
 *
 * 所以无名杀里注入的那段桥接脚本会定期 POST 一个很短的房间摘要到这里（心跳），
 * 服务端在内存里记着；超过 TTL 没心跳就当作已经离开（关页面、断网、锁屏都能自然过期）。
 *
 * 这里**只存公开信息**：房间号、模式名、开没开局、允不允许观战。
 * 不碰无名杀的对局内容（那是它自己中继的事），也不写数据库（重启就没了 —— 本来也没价值）。
 */

/** 心跳间隔（无名杀桥接脚本每 15 秒发一次）。 */
export const NONAME_HEARTBEAT_MS = 15_000;
/** 超过这么久没心跳就当作离开。要大于心跳间隔，留两次丢包的余量。 */
export const NONAME_TTL_MS = 45_000;

const ROOM_RE = /^[A-Za-z0-9]{1,32}$/;

function cleanText(value, max = 40) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/**
 * @param {object} [options]
 * @param {(userId: string) => void} [options.onChange] 状态一变就调（hub 用来刷新好友列表）
 */
export function createNonamePresence({ onChange = () => {} } = {}) {
  /** userId -> { room, mode, started, observe, count, at } */
  const map = new Map();

  function changed(userId) {
    try {
      onChange(userId);
    } catch {
      /* 刷新好友列表失败不该影响无名杀本身 */
    }
  }

  /**
   * 收到一次心跳。`state.room` 为空 = 离开房间（但仍算在上线？不算 —— 见 clear）。
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
      mode: cleanText(state.mode, 20),
      started: Boolean(state.started),
      observe: Boolean(state.observe),
      count: Number.isFinite(Number(state.count)) ? Math.max(0, Math.min(99, Number(state.count))) : 0,
      at: Date.now(),
    };
    const prev = map.get(userId);
    map.set(userId, next);

    const same =
      prev &&
      prev.room === next.room &&
      prev.mode === next.mode &&
      prev.started === next.started &&
      prev.observe === next.observe &&
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
    if (Date.now() - entry.at > NONAME_TTL_MS) {
      map.delete(userId);
      return null;
    }
    return entry;
  }

  /**
   * 定期清扫过期项。返回**状态真的过期了**的用户 id 列表，
   * 调用方逐个刷新他们的好友列表（不然好友会一直看到"正在玩无名杀"）。
   */
  function sweep(now = Date.now()) {
    const expired = [];
    for (const [userId, entry] of map) {
      if (now - entry.at > NONAME_TTL_MS) {
        map.delete(userId);
        expired.push(userId);
      }
    }
    for (const userId of expired) changed(userId);
    return expired;
  }

  /** 这个人现在算不算"在玩无名杀"（给好友列表合并在线状态用）。 */
  function isPlaying(userId) {
    return Boolean(get(userId));
  }

  /** 好友列表里"正在玩什么"的那一份形状（和 rooms.presenceOf 对齐）。 */
  function presenceOf(userId) {
    const entry = get(userId);
    if (!entry) return null;
    return {
      game: 'noname',
      code: entry.room,
      phase: entry.started ? 'playing' : 'waiting',
      /**
       * 开局后能不能进：看房主在无名杀里有没有开"允许观战"。
       * 没开局时当然能进；已开局且不允许观战就不可点（避免点进去被无名杀弹一句拒绝）。
       */
      joinable: !entry.started || entry.observe,
      started: entry.started,
      observe: entry.observe,
      mode: entry.mode,
      count: entry.count,
    };
  }

  /** 仅供测试与调试。 */
  function _dump() {
    return [...map.entries()].map(([userId, entry]) => ({ userId, ...entry }));
  }

  return { set, clear, get, sweep, isPlaying, presenceOf, _dump };
}