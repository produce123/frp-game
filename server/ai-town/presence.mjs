/*
 * "正在玩 AI 小镇"的心跳。
 *
 * 和无名杀/大富翁/麻将页面一样，AI 小镇页面**不连平台 WebSocket**（它的联机走
 * 上游自己的 WS）。所以好友列表里的「正在玩 / 进入」只能靠页面定时上报。
 *
 * 形状必须和 noname-presence.mjs 完全一致：
 *   { game, code, phase, joinable, started, count }
 * hub.mjs 会把这个对象原样交给前端。
 */

const DEFAULT_TTL_MS = 90_000;

export function createAiTownPresence({ onChange = null, ttlMs = DEFAULT_TTL_MS } = {}) {
  /** userId -> { at, playing } */
  const entries = new Map();

  function remember(userId, playing) {
    const before = entries.get(userId)?.playing || null;
    entries.set(userId, { at: Date.now(), playing });
    // 只有"在玩什么"真的变了才推好友列表，避免每 15 秒一次全量推送。
    const same = before && playing
      && before.game === playing.game && before.code === playing.code
      && before.joinable === playing.joinable && before.started === playing.started
      && before.count === playing.count;
    if (!same && typeof onChange === 'function') {
      try { onChange(userId); } catch { /* 推送失败不该影响心跳 */ }
    }
  }

  /** @param {{town:string, joinable?:boolean, started?:boolean, count?:number}} raw */
  function set(userId, raw) {
    const town = String(raw?.town || '').trim();
    if (!town || town.length > 80) return { ok: false, message: '小镇不对' };
    const count = Math.max(1, Math.min(8, Number(raw?.count) || 1));
    remember(userId, {
      game: 'ai-town',
      code: town,
      phase: 'playing',
      joinable: raw?.joinable !== false,
      started: raw?.started !== false,
      count,
    });
    return { ok: true, playing: entries.get(userId).playing };
  }

  function clear(userId) {
    if (!entries.has(userId)) return;
    entries.delete(userId);
    if (typeof onChange === 'function') {
      try { onChange(userId); } catch { /* 同上 */ }
    }
  }

  function presenceOf(userId) {
    const entry = entries.get(userId);
    if (!entry) return null;
    if (Date.now() - entry.at > ttlMs) {
      entries.delete(userId);
      return null;
    }
    return entry.playing;
  }

  function sweep() {
    const now = Date.now();
    for (const [userId, entry] of entries) {
      if (now - entry.at <= ttlMs) continue;
      entries.delete(userId);
      if (typeof onChange === 'function') {
        try { onChange(userId); } catch { /* 同上 */ }
      }
    }
  }

  return { set, clear, presenceOf, sweep, get size() { return entries.size; } };
}