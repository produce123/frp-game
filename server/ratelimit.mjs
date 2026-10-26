/*
 * 进程内限流（零依赖，内存态）。
 *
 * 【为什么要有】服务端在公网后面（隧道），两件事必须自己兜住：
 *   1. 账号接口被脚本刷 —— 每次登录都要跑一次 scrypt，几十个并发就能把 CPU 吃满；
 *   2. 长连接被刷 —— 平台一条 `react.send` 会放大成"发给房里每个人"，
 *      一条位置消息会放大成"发给同房每个客户端"。
 * 这些不该指望隧道面板或防火墙，进程里几行就够。
 *
 * 【两种形状】
 *   · createFixedWindow —— 固定窗口，用来管"登录/注册"这种低频动作。
 *   · createTokenBucket —— 令牌桶，用来管高频消息（平滑、不会在窗口边界放行两倍）。
 *
 * 【为什么可以只在内存里】限流是为了抗刷，不是记账：进程重启清零完全没问题。
 * 状态表自己会清理过期条目，不会随请求数无限长。
 */

/**
 * 固定窗口限流。窗口内超过 max 次就拒绝，到下个窗口恢复。
 *
 * @param {object} [options]
 * @param {number} [options.windowMs=60000] 窗口长度
 * @param {number} [options.max=20]         窗口内允许几次
 */
export function createFixedWindow({ windowMs = 60_000, max = 20 } = {}) {
  /** key -> { start, n } */
  const map = new Map();

  const sweep = (now) => {
    for (const [key, hit] of map) {
      if (now - hit.start >= windowMs * 2) map.delete(key);
    }
  };

  return {
    /**
     * 记一次并判断。
     * @returns {{ok: true, remaining: number} | {ok: false, retryAfterMs: number, count: number}}
     */
    take(key, now = Date.now()) {
      const k = String(key || '');
      // 表太大才扫（正常几十个 IP，扫一次是零成本；防止被海量来源 IP 撑爆内存）
      if (map.size > 2048) sweep(now);

      let hit = map.get(k);
      if (!hit || now - hit.start >= windowMs) {
        hit = { start: now, n: 0 };
        map.set(k, hit);
      }
      hit.n += 1;
      if (hit.n <= max) return { ok: true, remaining: max - hit.n };
      return {
        ok: false,
        count: hit.n,
        retryAfterMs: Math.max(0, hit.start + windowMs - now),
      };
    },

    /** 清掉某个来源的记录（比如登录成功之后，别让上一次失败拖着）。 */
    reset(key) {
      map.delete(String(key || ''));
    },

    /** 仅供测试与调试。 */
    get size() { return map.size; },
  };
}

/**
 * 令牌桶：每秒回 perSec 个令牌，最多攒 burst 个。
 * `take()` 返回 false 就表示"这一下太密了"。
 *
 * 秒级平滑的好处：不会像固定窗口那样在两个窗口交界处放过 2 倍流量。
 *
 * @param {object} [options]
 * @param {number} [options.perSec=100] 每秒回多少令牌
 * @param {number} [options.burst=200]  桶的上限（允许的瞬时爆发）
 */
export function createTokenBucket({ perSec = 100, burst = 200 } = {}) {
  let tokens = burst;
  let at = Date.now();

  return {
    /** @returns {boolean} 还有令牌就是 true（并扣掉） */
    take(n = 1, now = Date.now()) {
      const elapsed = Math.max(0, now - at);
      at = now;
      tokens = Math.min(burst, tokens + (elapsed / 1000) * perSec);
      if (tokens >= n) {
        tokens -= n;
        return true;
      }
      return false;
    },
    /** 仅供测试与调试。 */
    get tokens() { return tokens; },
  };
}