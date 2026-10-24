/*
 * frp-game 服务器进程 —— 唯一入口。
 *
 * 一个进程同时干两件事：发网页（HTTP）+ 管房间（WebSocket）。
 * 监听 127.0.0.1:7891，由 SakuraFrp 的隧道把公网流量送进来。
 *
 * 用法：
 *   node server/server.mjs              # 默认 127.0.0.1:7891
 *   PORT=8080 node server/server.mjs    # 换端口（记得同步改隧道配置）
 */

import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { currentUser } from './auth.mjs';
import { createAvatarStore } from './avatar.mjs';
import { loadGames } from './games/index.mjs';
import { createHub } from './hub.mjs';
import { createRequestHandler } from './http.mjs';
import { NONAME_RELAY_PATH, NONAME_RELAY_PORT, startNonameRelay } from './noname.mjs';
import { createNonamePresence } from './noname-presence.mjs';
import { createMonopoly } from './monopoly/index.mjs';
import { createMonopolyRelay } from './monopoly/relay.mjs';
import { createMahjong, MAHJONG_BACKEND_PORT } from './mahjong/index.mjs';
import { createMahjongPresence } from './mahjong-presence.mjs';
import { createMonopolyPresence } from './monopoly-presence.mjs';
import { SWEEP_MS, createRooms } from './rooms.mjs';
import { openStore } from './store.mjs';
import { createWerewolfGame } from './werewolf/index.mjs';
import { attachWebSocket } from './ws.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 7891;
export const DEFAULT_HOST = '127.0.0.1';
/** 运行状态文件：工具（tools/service.mjs）靠它找到进程并停掉。 */
export const DEFAULT_STATE_PATH = join(ROOT, 'data', 'server.json');

/**
 * 起一个完整的 frp-game 服务器。
 *
 * @param {object} [options]
 * @param {number} [options.port]   0 = 让系统随机分配（测试用）
 * @param {string} [options.host]
 * @param {string} [options.dbPath] 不传则用 data/frp-game.db
 * @param {string} [options.statePath]
 *        写运行状态（pid 等）的路径。**测试不要传** —— 否则会覆盖掉真实那份，
 *        然后 stop.cmd 就找错进程了。
 * @param {Map<string, object>} [options.extraGames]
 *        额外的游戏模块，**只给测试用** —— 让房间层能在没有真游戏的阶段被完整验证。
 *        正常启动时不要传这个。
 * @param {boolean} [options.nonameRelay=false]
 *        要不要同时起**无名杀自己的联机中继**（见 server/noname.mjs 的说明）。
 *        默认关：测试/体检各起一堆临时服务端，不需要每个都去抢 8082 端口。
 * @param {number} [options.werewolfTimeoutScale]
 *        狼人杀状态倒计时的时间缩放，**只有测试用**（1 = 正常速度）。
 *        一局排到天亮要好几分钟，集成测试按 0.002 缩到毫秒级。
 */
export async function startServer({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  dbPath,
  statePath,
  extraGames,
  nonameRelay = false,
  nonameRelayPort = NONAME_RELAY_PORT,
  werewolfTimeoutScale,
  mahjongBackend = false,
  mahjongBackendPort = MAHJONG_BACKEND_PORT,
  mahjongDbPath = '',
} = {}) {
  const store = openStore(dbPath);
  // 头像跟着数据库走：临时库 → 临时头像目录，跑完一起删。
  const avatars = createAvatarStore(join(dirname(store.path), 'avatars'));
  const loaded = await loadGames();
  const games = loaded.games;
  if (extraGames) for (const [slug, mod] of extraGames) games.set(slug, mod);

  // 加载失败的游戏不许静默消失 —— 打出来，并且随 startServer 的返回值一起交出去
  for (const f of loaded.failures) {
    console.error(`⚠️  游戏模块 ${f.file} 加载失败，这个游戏暂时下线：${f.message}`);
  }

  // rooms 需要 hub 才能投递消息，hub 需要 rooms 才能查座位 —— 先用闭包接上，赋值在使用之前。
  let hub = null;
  // 无名杀的"正在玩"心跳：状态一变就刷新他好友看到的列表（无名杀页面没有平台 WS）。
  const nonamePresence = createNonamePresence({
    onChange: (userId) => hub && hub.pushFriendsOf(userId),
  });
  /*
   * 大富翁页面也不连平台 WS（它的联机走 `/monopoly-relay`），和无名杀一样靠心跳
   * 告诉好友"我在哪个房"。账号仍由平台会话决定，这里只存公开的房间摘要。
   */
  const monopolyPresence = createMonopolyPresence({
    onChange: (userId) => hub && hub.pushFriendsOf(userId),
  });
  /*
   * 莲花广麻也是"页面心跳"型：它的联机走自己的 Python 后端（`/mahjong/api` + `/mahjong/ws`），
   * 不连平台 WS。账号由本机网关注入，房间摘要由页面每 15 秒报一次。
   */
  const mahjongPresence = createMahjongPresence({
    onChange: (userId) => hub && hub.pushFriendsOf(userId),
  });
  const rooms = createRooms({
    games,
    deliver: (playerId, message) => hub && hub.deliver(playerId, message),
    // 有人进/出房间 → 刷新他好友们看到的「正在玩什么」
    onSeatChange: (playerId) => hub && hub.pushFriendsOf(playerId),
  });
  /*
   * 狼人杀：**游戏核心在同一个进程里**（不是又起一个服务）。
   *
   * 接线顺序是 `werewolf → hub → werewolf.attachHub(hub)`：
   * hub 的好友列表要能查到"正在玩狼人杀"，狼人杀要能给玩家投消息，两边互相需要，
   * 所以先造 werewolf（它的 hub 是后插的），再造 hub，最后补上 hub。
   */
  const werewolf = createWerewolfGame({ store, timeoutScale: werewolfTimeoutScale });
  hub = createHub({ store, rooms, nonamePresence, werewolf, monopolyPresence, mahjongPresence });
  werewolf.attachHub(hub);

  /*
   * 大富翁：**只搬上游的 Web 客户端**，游戏逻辑在房主浏览器里跑。
   * 这里提供上游页面要的 `/monopoly-server/*` 兼容接口 + 官方公开地图。
   */
  const monopoly = createMonopoly({
    mapsDir: join(ROOT, 'games', 'monopoly', 'maps'),
  });
  const monopolyRelay = createMonopolyRelay();

  /*
   * 莲花广麻：**只搬上游前后端**。Python 后端跑在 127.0.0.1 的内部端口，
   * 这里只做反向代理（HTTP + WebSocket），公网仍然只有 7891 一条隧道。
   * `mahjongBackend=false`（测试默认）时不启动 Python，静态页照发。
   */
  const mahjong = createMahjong({
    root: ROOT,
    port: mahjongBackendPort,
    enabled: mahjongBackend,
    dbPath: mahjongDbPath,
  });

  const handler = createRequestHandler({
    store,
    availableGames: () => [...games.keys()],
    avatars,
    hub,
    rooms,
    nonamePresence,
    monopolyPresence,
    werewolf,
    monopoly,
    mahjong,
    mahjongPresence,
  });

  const server = createServer((req, res) => { handler(req, res); });

  /*
   * 无名杀的联机中继：本进程里起在 127.0.0.1:8082，再从 7891 的
   * `/noname-online` 做裸 TCP 转发 —— 隧道只用一个端口，玩家不用自己开隧道。
   * 起不来（没构建 / 端口被占）也不算致命：网页端照样能单机玩（见 noname.mjs）。
   */
  const relay = nonameRelay ? await startNonameRelay({ port: nonameRelayPort }) : null;

  // WebSocket 是长连接，别让 HTTP 的请求超时把升级后的 socket 收走。
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 65_000;

  const ws = attachWebSocket(server, {
    path: '/ws',
    /*
     * 无名杀联机中继的转发口。
     * ⚠️ 只在**中继真的起来了**时才挂这条转发 —— 否则 `/noname-online` 会把公网流量
     * 转给"碰巧占着这个端口的别的程序"（这台机器上 QQ 就占着 8082）。
     * 没挂的时候 `/noname-online` 走普通的 upgrade 检查 → 直接被断。
     */
    proxy: relay ? { path: NONAME_RELAY_PATH, port: nonameRelayPort } : null,
    // 握手期就完成鉴权：没登录的连接**根本不会升级成功**，
    // 比升级后再踢更省事，也更难绕。
    verify: (req) => {
      const user = currentUser(store, req);
      if (!user) return { ok: false, code: 401 };
      return { ok: true, data: { user } };
    },
    onConnection: (conn) => {
      hub.attach(conn, conn.data.user);
    },
    /*
     * 大富翁联机中转：和平台主 WS 共用一条 HTTP 端口，仅路径不同。
     * 仍是"握手期鉴权"，没登录平台的连接升不上来。
     */
    extra: [{
      path: '/monopoly-relay',
      verify: (req) => {
        const user = currentUser(store, req);
        if (!user) return { ok: false, code: 401 };
        return { ok: true, data: { user } };
      },
      onConnection: monopolyRelay.onConnection,
    }],
    /*
     * 莲花广麻的实时对局：`/mahjong/ws/room/{id}` → Python 的 `/ws/room/{id}`。
     * 只搬字节（协议是上游的），但**握手期同样要平台登录**：没登录升不上来。
     */
    proxies: [{
      prefix: '/mahjong/ws',
      stripPrefix: '/mahjong',
      port: mahjongBackendPort,
      verify: (req) => {
        const user = currentUser(store, req);
        if (!user) return { ok: false, code: 401 };
        return { ok: true, data: { user } };
      },
    }],
  });

  const sweeper = setInterval(() => {
    try { rooms.sweep(); } catch { /* 清扫失败不该让进程崩掉 */ }
  }, SWEEP_MS);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  /*
   * 无名杀心跳过期清扫。它和房间清扫分开：房间层几秒一次（掉线座位要尽快腾出来），
   * 这里 15 秒一次就够（TTL 45 秒）。
   */
  const nonameSweeper = setInterval(() => {
    try { nonamePresence.sweep(); } catch { /* 同上 */ }
  }, 15_000);
  if (typeof nonameSweeper.unref === 'function') nonameSweeper.unref();

  // 大富翁的"正在玩"也靠心跳，过期了就刷新好友列表（TTL 45 秒）
  const monopolySweeper = setInterval(() => {
    try { monopolyPresence.sweep(); } catch { /* 同上 */ }
  }, 15_000);
  if (typeof monopolySweeper.unref === 'function') monopolySweeper.unref();

  // 莲花广麻同理（TTL 45 秒）
  const mahjongSweeper = setInterval(() => {
    try { mahjongPresence.sweep(); } catch { /* 同上 */ }
  }, 15_000);
  if (typeof mahjongSweeper.unref === 'function') mahjongSweeper.unref();

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });

  const actualPort = server.address().port;

  /*
   * Python 后端起在 listen 之后：它最快也要两三秒，不能挡住端口。
   * 起不来只影响麻将页（接口 503），其它游戏照常。
   */
  if (mahjongBackend) {
    const ok = await mahjong.start();
    if (!ok) {
      console.error('⚠️  莲花广麻后端没起来：麻将页会显示"后端没就绪"。见 games/mahjong/README.md');
    }
  }

  // 运行状态文件：tools/service.mjs 靠它找到进程。写在 listen 之后，这样端口是真实值。
  if (statePath) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ pid: process.pid, host, port: actualPort, startedAt: Date.now() }, null, 2)
    );
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(sweeper);
    clearInterval(nonameSweeper);
    clearInterval(monopolySweeper);
    clearInterval(mahjongSweeper);
    try { await mahjong.stop(); } catch { /* 后端停不掉不该拦住进程退出 */ }
    monopoly.stop();
    monopolyRelay.closeAll();
    ws.closeAll();
    hub.closeAll();
    if (relay) {
      try { await relay.stop(); } catch { /* 中继停不掉不该拦住进程退出 */ }
    }
    await new Promise((r) => server.close(r));
    store.close();
    if (statePath) rmSync(statePath, { force: true });
  }

  return {
    server, store, rooms, hub, games, avatars, nonamePresence, werewolf,
    monopoly, monopolyPresence, monopolyRelay,
    mahjong, mahjongPresence,
    /** 加载失败的游戏模块（正常是空数组）。启动时打日志，测试断言它是空的。 */
    gameFailures: loaded.failures,
    host,
    port: actualPort,
    /** 无名杀联机中继（没起就是 null）。 */
    nonameRelay: relay,
    /** 本机地址。公网地址不在这里 —— 那是隧道的事（见 docs/TUNNEL.md）。 */
    url: `http://${host}:${actualPort}/`,
    close,
  };
}

/* 直接运行（而不是被 import）时才启动。 */
const isMain = process.argv[1] && /server\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || DEFAULT_HOST;

  const app = await startServer({
    port, host, statePath: DEFAULT_STATE_PATH, nonameRelay: true, mahjongBackend: true,
  });
  console.log(`frp-game 已启动：${app.url}`);
  console.log(`已接游戏：${app.games.size ? [...app.games.keys()].join(', ') : '（还没有，见 docs/GAMES.md）'}`);
  console.log(
    app.nonameRelay
      ? `无名杀联机中继：${app.nonameRelay.host}:${app.nonameRelay.port}（公网走 /noname-online）`
      : '⚠️  无名杀联机中继没起来（网页端照常单机玩，见 docs/GAMES.md）'
  );
  console.log(
    app.mahjong?.ready
      ? `莲花广麻后端：127.0.0.1:${app.mahjong.port}（公网走 /mahjong/api 与 /mahjong/ws）`
      : '⚠️  莲花广麻后端没起来（页面会提示后端未就绪，见 games/mahjong/README.md）'
  );
  console.log('公网地址由 SakuraFrp 隧道决定，见 docs/TUNNEL.md');

  const shutdown = async (signal) => {
    console.log(`\n收到 ${signal}，正在关闭…`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
}