/*
 * HTTP 层：JSON API + 静态文件。
 *
 * 静态文件用**白名单挂载**，不是"整个仓库都发出去" ——
 * server/、data/、docs/、.git 一律不可达。加新目录要显式加进 MOUNTS。
 *
 * 缓存策略：平台自己的文件一律 `no-store`。原 web-games 项目在 README 里专门写了一节
 * "改了内容但网页没变"，根因就是 GitHub Pages 给 assets 4 小时强缓存、
 * HTML 只给 10 分钟，两者过期时间不一致。本站资源很小，
 * 直接不缓存，从根上消灭这一类问题。
 *
 * 唯一的例外是**无名杀那份打包产物**（`/noname/`）：它有一万多文件、首屏要拿
 * ~250 个模块，全 `no-store` 意味着每次刷新都重拿一遍。所以那一块给
 * `max-age=600`（10 分钟）+ ETag 协商 —— 刷新是 304，换版本最多 10 分钟内自己过掉。
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  clearCookie,
  currentUser,
  isSecureRequest,
  login,
  logout,
  register,
  sessionCookie,
} from './auth.mjs';
import { API_PREFIX as WEREWOLF_API } from './werewolf/index.mjs';
import {
  createAvatarStore,
  defaultAvatarSvg,
  mimeForExt,
  publicUser,
} from './avatar.mjs';
import { NONAME_DATA, handleNonameRequest } from './noname.mjs';
import { MONOPOLY_API_PREFIX } from './monopoly/index.mjs';
import { MAHJONG_API_PREFIX } from './mahjong/index.mjs';

/**
 * 大富翁音频的**无扩展名**出口。
 *
 * 为什么不让页面直接请求 `/games/monopoly/assets/audio/sfx/button-click.ogg`：
 * IDM 之类的下载器会把 URL 里的 `.mp3/.ogg` 当成可下载媒体，页面一加载 BGM 就弹窗、
 * 甚至自动把游戏音效抓进“下载”文件夹。这里把路径换成 `/monopoly-audio/sfx/button-click`
 * （没有扩展名），响应头只发 `application/octet-stream`；浏览器用 Web Audio 解码
 * 完全不受影响，下载器的“媒体嗅探”却认不出来。
 */
const MONOPOLY_AUDIO_PREFIX = '/monopoly-audio';
import { T, validateName } from '../shared/protocol.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** 图片/音频/字体可以缓存，代码/页面不缓存。 */
const CACHEABLE = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.svg',
  '.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac',
]);

/**
 * 无扩展名音频请求按这个顺序探测真实文件（配合 `shared/ui/no-idm.js`）。
 * 顺序只影响同名不同格式时的优先级，现有素材没有重名。
 */
const MEDIA_EXTS = ['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac'];

/** URL 前缀 → 仓库内目录。**只发这些**。 */
const MOUNTS = [
  { prefix: '/shared/', dir: 'shared' },
  /*
   * 大富翁：**只发构建产物**（`games/monopoly/web`），不发上游源码（`upstream/`）、
   * 地图源文件目录（`maps/` 另有挂载）、工具脚本。顺序必须在通用 `/games/` 之前，
   * `candidatesFor()` 命中第一条就停。
   */
  { prefix: '/games/monopoly/', dir: 'games/monopoly/web' },
  /*
   * 莲花广麻：**上游 Web 构建产物**（`games/mahjong/web`），不发上游源码（`upstream/`）
   * 和 Python 后端（`backend/`）—— 后者只监听 127.0.0.1，由 server/mahjong/index.mjs 代理。
   */
  { prefix: '/mahjong/', dir: 'games/mahjong/web' },
  /*
   * 官方公开地图（.mmmap + 封面）。单独一个前缀，避免和页面同目录时把
   * `manifest.json`、后续可能放的源文件一起暴露出去；这里只该有可玩地图。
   */
  { prefix: '/monopoly-maps/', dir: 'games/monopoly/maps' },
  { prefix: '/games/', dir: 'games' },
  { prefix: '/assets/', dir: 'web/assets' },
  /*
   * 原版无名杀的托管目录（`games/noname-web/dist`，由 `pnpm build` 产出）。
   *
   * ⚠️ 它不是平台的游戏：没有 meta/createMatch、不接平台账号、也没有房间层。
   * 这里只做**静态托管** —— 页面、素材、Service Worker 全按上游文件名原样发出去。
   * 无名杀自己的账号/存档在浏览器本地，联机走它自己的服务器（见 docs/GAMES.md）。
   */
  { prefix: '/noname/', dir: 'games/noname-web/dist' },
  /*
   * 狼人杀：**上游 wolfcha-custom 的界面 + 本仓库重写的服务器权威引擎**。
   *
   *   · 页面：`games/werewolf/app`（Next.js 静态导出到 `games/werewolf/dist`，`basePath=/werewolf`）；
   *   · 规则：`games/werewolf/engine/index.mjs`，直接 import 进本进程（不再 tsc）；
   *   · 账号 / 好友 / 邀请 / 战绩：全部复用平台（见 `server/werewolf/index.mjs`）。
   *
   * `_next/static` 里的文件名带 hash，可以长缓存；入口页仍然 no-store（登录门在那上面）。
   */
  { prefix: '/werewolf/', dir: 'games/werewolf/dist' },
  /*
   * 斗地主：**上游缝进来的游戏**（牌桌是上游 GODOT-DouDiZhu 的 Godot 网页导出，
   * 规则/状态机是新写的、跑在服务器上），它接的是平台房间层（`server/games/ddz.mjs`），
   * 所以页面挂在自己的顶级路径 `/ddz/`。
   *
   * ⚠️ 和 `/games/ddz/` 只能有**一个**地址：同一份目录挂两遍，排查时永远看不出
   * 用户是在哪个地址上出的问题（无名杀踩过）。所以 `candidatesFor()` 把
   * `/games/ddz/**` 挡掉了。相对路径的 import（`../engine/rules.js`）靠尾斜杠正确解析。
   */
  { prefix: '/ddz/', dir: 'games/ddz' },
];

/**
 * ⚠️ 无名杀有几处**根绝对路径**（上游 `game.js` 里的 `/noname/entry.js`、
 * import map 里的 `/noname.js` 等），不是相对路径，`<base>` 也管不到它们。
 * 所以当上面几条都 404 时，再到这个目录里按"原样的 URL"找一次
 * （`/audio/...`、`/image/...`、`/noname.js`、`/noname/entry.js` 都靠它）。
 * 只是**兜底**：先给平台自己的挂载点和页面让路。
 */
const NONAME_DIST = 'games/noname-web/dist';
/** 注入到无名杀 index.html 里的桥接脚本（放在 web/，不会被 pnpm build 覆盖）。 */
const NONAME_BRIDGE = 'web/noname-bridge.js';
/** 注入脚本的版本号：改了桥接脚本就 +1，浏览器不会拿旧缓存。 */
const NONAME_BRIDGE_VERSION = '1';

/** 顶层页面。 */
const PAGES = new Map([
  ['/', 'web/index.html'],
  ['/index.html', 'web/index.html'],
  /*
   * 伪横屏外壳（手机竖屏 → 内容横过来）。**故意放在 `/noname/` 外面**：
   * `/noname/` 是 Service Worker 的地盘，外壳塞进去会被它自己的缓存规则缠上
   * （见 docs/GAMES.md《无名杀 Web》的伪横屏一节）。
   */
  ['/play/noname', 'web/noname-frame.html'],
  /*
   * 大富翁的伪横屏外壳（40 格环形棋盘在竖屏手机上字会太小，见 web/monopoly-frame.html）。
   * 电脑打开会自动 replace 到 `/games/monopoly/`，手机上把游戏横过来铺满。
   */
  ['/play/monopoly', 'web/monopoly-frame.html'],
  /*
   * 斗地主的伪横屏外壳（和无名杀/大富翁同一套做法，见 web/ddz-frame.html）。
   * 牌桌是 1280×720 的横屏画面，手机上横过来玩；电脑打开会自动 replace 回 `/ddz/`。
   */
  ['/play/ddz', 'web/ddz-frame.html'],
  /*
   * 莲花广麻的手机伪横屏外壳（3D 牌桌是横屏画面，竖着拿牌太小）。
   * 电脑打开外壳会自动 replace 回 `/mahjong/`，和斗地主/大富翁同一套做法。
   */
  ['/play/mahjong', 'web/mahjong-frame.html'],
]);

/**
 * 这些扩展名是**文本**，gzip 能压掉 70%~85%。无名杀首屏要拿 ~250 个模块，
 * 不压的话隧道上首屏十几秒，客户端 10 秒的"载入超时"就会弹
 * 「游戏似乎未正常载入，是否重置游戏？」—— 用户手机上遇到的正是这个。
 */
const COMPRESSIBLE = new Set([
  '.js', '.mjs', '.ts', '.css', '.json', '.map', '.svg', '.txt', '.webmanifest', '.html',
  /*
   * 斗地主牌桌是 Godot 的网页导出：`index.wasm` 42 MB。
   * 走隧道不压的话手机上要下一分多钟；压完 9 MB（本机实测 0.5 秒）。
   */
  '.wasm',
]);

/** 压缩缓存的容量上限（首屏模块全压完约 3 MB；斗地主那个 wasm 一份就 9 MB，放宽容量）。 */
const GZIP_CACHE_MAX = 128 * 1024 * 1024;
/** 单个文件超过这个大小就现压不缓存。⚠️ 必须 ≥ 斗地主那个 42 MB 的 wasm。 */
const GZIP_CACHE_FILE_MAX = 64 * 1024 * 1024;

/**
 * 牌桌的二进制资源（Godot 导出）。它们**不随内容变化改名**，所以既不能 no-store
 * 也不能"缓存一天"，走 `no-cache` + ETag 协商（见 cacheControl / sendFile）。
 */
const TABLE_ASSET = new Set(['.wasm', '.pck']);
/** @type {Map<string, {buf: Buffer, etag: string}>} 插入序当 LRU 用 */
const gzipCache = new Map();
let gzipCacheBytes = 0;

const MAX_BODY = 16 * 1024;

function sendJSON(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 读原始请求体（上传头像用）。超过 limit 直接 413。
 * 和 readBody 分开是因为图片是二进制，不能先 toString('utf8')。
 */
function readRawBody(req, limit) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('图片太大了');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {object} options
 * @param {ReturnType<import('./store.mjs').openStore>} options.store
 * @param {() => string[]} options.availableGames  服务器上已接好的游戏 slug
 * @param {ReturnType<import('./avatar.mjs').createAvatarStore>} options.avatars
 * @param {ReturnType<import('./hub.mjs').createHub>} [options.hub]
 * @param {object} [options.nonamePresence]
 */
export function createRequestHandler({ store, availableGames = () => [], avatars, hub = null, rooms = null,
  nonamePresence = null, monopolyPresence = null, werewolf = null, monopoly = null,
  mahjong = null, mahjongPresence = null }) {
  async function handleApi(req, res, pathname) {
    /* ------------------------------ 狼人杀 ------------------------------ */

    /*
     * `/api/werewolf/*` 全部转给游戏服务（`server/werewolf/index.mjs`）。
     * 身份**只**取会话 cookie：狼人杀页面没有任何"自己填昵称/自己存 token"的入口。
     * 响应形状和平台其它接口一致（`{ok:true, data}` / `{ok:false, message}`），
     * 这样游戏页可以直接用 `shared/net/net.js` 的 `api()`。
     */
    if (pathname === WEREWOLF_API || pathname.startsWith(WEREWOLF_API + '/')) {
      const user = currentUser(store, req);
      let body = {};
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await readBody(req);
        } catch (err) {
          return sendJSON(res, 400, { ok: false, message: err.message });
        }
      }
      const result = werewolf
        ? await werewolf.handleApi(user, pathname, body)
        : { status: 503, body: { ok: false, message: '狼人杀没接上（服务端配置问题）' } };
      return sendJSON(res, result.status, result.body);
    }

    /* ------------------------------ 大富翁 ------------------------------ */

    /*
     * 上游大富翁页面要的 `/monopoly-server/*` 兼容接口（room-router / game-map）。
     * 身份只取平台会话 cookie；页面本身也在登录门后面，所以这里不该出现"游客"。
     * 响应形状沿用上游：`{status:200,data}` / `{status:4xx,msg}`。
     */
    if (pathname === MONOPOLY_API_PREFIX || pathname.startsWith(MONOPOLY_API_PREFIX + '/')) {
      const user = currentUser(store, req);
      let body = {};
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await readBody(req);
        } catch (err) {
          return sendJSON(res, 400, { status: 400, msg: err.message });
        }
      }
      const result = monopoly
        ? await monopoly.handleApi(user, pathname, new URL(req.url, 'http://127.0.0.1').searchParams, body)
        : { status: 503, body: { status: 503, msg: '大富翁没接上（服务端配置问题）' } };
      return sendJSON(res, result.status, result.body);
    }

    /* ------------------------ 大富翁的平台桥接 ------------------------ */

    /*
     * 游戏页不连平台 WebSocket，所以"我在哪个房"由页面心跳报上来；
     * 好友列表里的「正在玩 大富翁 / 进入」靠这三条接口。
     */
    if (pathname === '/api/monopoly/state' && req.method === 'POST') {
      const user = currentUser(store, req);
      if (!user) return sendJSON(res, 401, { ok: false, message: '还没登录' });
      if (!monopolyPresence) return sendJSON(res, 503, { ok: false, message: '大富翁状态服务没接上' });
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJSON(res, 400, { ok: false, message: err.message });
      }
      const result = monopolyPresence.set(user.id, body);
      if (!result.ok) return sendJSON(res, 400, { ok: false, message: result.message });
      return sendJSON(res, 200, { ok: true, playing: result.playing });
    }

    if (pathname === '/api/monopoly/friends' && req.method === 'GET') {
      const user = currentUser(store, req);
      if (!user) return sendJSON(res, 401, { ok: false, message: '还没登录' });
      return sendJSON(res, 200, {
        ok: true,
        friends: hub ? hub.friendsWithPresence(user.id) : [],
      });
    }

    if (pathname === '/api/monopoly/invite' && req.method === 'POST') {
      const user = currentUser(store, req);
      if (!user) return sendJSON(res, 401, { ok: false, message: '还没登录' });
      if (!hub) return sendJSON(res, 503, { ok: false, message: '在线服务没接上' });
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJSON(res, 400, { ok: false, message: err.message });
      }
      const room = String(body?.room || '').trim();
      if (!room || room.length > 12) {
        return sendJSON(res, 400, { ok: false, message: '房号不对' });
      }
      const wanted = Array.isArray(body?.to) ? body.to : [];
      const friends = new Set(store.listFriends(user.id).map((f) => f.id));
      const delivered = [];
      const failed = [];
      for (const raw of wanted) {
        const id = String(raw || '').trim().toUpperCase();
        if (!friends.has(id)) { failed.push({ id, reason: '不是好友' }); continue; }
        if (!hub.isReachable(id)) { failed.push({ id, reason: '不在线' }); continue; }
        const sent = hub.deliver(id, {
          t: T.INVITE,
          from: publicUser(user),
          game: 'monopoly',
          code: room,
        });
        if (sent > 0) delivered.push(id);
        else failed.push({ id, reason: '发不出去' });
      }
      return sendJSON(res, 200, { ok: true, delivered, failed });
    }

    /* ------------------------ 莲花广麻的平台桥接 ------------------------ */

    /*
     * 麻将页和无名杀/大富翁一样**不连平台 WebSocket**（它的联机走自己的后端），
     * 所以"我在哪个房"由页面心跳报上来；好友列表里的「正在玩 莲花广麻 / 进入」
     * 和房间里的「邀请好友」都靠这三条接口。
     */
    if (pathname === '/api/mahjong/state' && req.method === 'POST') {
      const user = currentUser(store, req);
      if (!user) return sendJSON(res, 401, { ok: false, message: '还没登录' });
      if (!mahjongPresence) return sendJSON(res, 503, { ok: false, message: '麻将状态服务没接上' });
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJSON(res, 400, { ok: false, message: err.message });
      }
      const result = mahjongPresence.set(user.id, body);
      if (!result.ok) return sendJSON(res, 400, { ok: false, message: result.message });
      return sendJSON(res, 200, { ok: true, playing: result.playing });
    }

    if (pathname === '/api/mahjong/friends' && req.method === 'GET') {
      const user = currentUser(store, req);
      if (!user) return sendJSON(res, 401, { ok: false, message: '还没登录' });
      return sendJSON(res, 200, {
        ok: true,
        friends: hub ? hub.friendsWithPresence(user.id) : [],
      });
    }

    if (pathname === '/api/mahjong/invite' && req.method === 'POST') {
      const user = currentUser(store, req);
      if (!user) return sendJSON(res, 401, { ok: false, message: '还没登录' });
      if (!hub) return sendJSON(res, 503, { ok: false, message: '在线服务没接上' });
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return sendJSON(res, 400, { ok: false, message: err.message });
      }
      const room = String(body?.room || '').trim().toUpperCase();
      // 上游房号是 6 位大写字母/数字；放宽到 4–8 位，只挡空白 / 分隔符。
      if (!/^[A-Z0-9]{4,8}$/.test(room)) {
        return sendJSON(res, 400, { ok: false, message: '房号不对' });
      }
      const wanted = Array.isArray(body?.to) ? body.to : [];
      const friends = new Set(store.listFriends(user.id).map((f) => f.id));
      const delivered = [];
      const failed = [];
      for (const raw of wanted) {
        const id = String(raw || '').trim().toUpperCase();
        if (!friends.has(id)) { failed.push({ id, reason: '不是好友' }); continue; }
        if (!hub.isReachable(id)) { failed.push({ id, reason: '不在线' }); continue; }
        const sent = hub.deliver(id, {
          t: T.INVITE,
          from: publicUser(user),
          game: 'mahjong',
          code: room,
        });
        if (sent > 0) delivered.push(id);
        else failed.push({ id, reason: '发不出去' });
      }
      return sendJSON(res, 200, { ok: true, delivered, failed });
    }

    /* ------------------------------ 我是谁 ------------------------------ */

    if (pathname === '/api/me') {
      const user = currentUser(store, req);
      if (!user) return sendJSON(res, 401, { ok: false, message: '还没登录' });
      return sendJSON(res, 200, {
        ok: true,
        me: publicUser(user),
        games: availableGames(),
      });
    }

    /* 改显示名：ID 不变（好友认 ID），所以老好友不会丢。 */
    if (pathname === '/api/name' && req.method === 'POST') {
      const user = currentUser(store, req);
      if (!user) return sendJSON(res, 401, { ok: false, message: '还没登录' });
      const body = await readBody(req);
      const check = validateName(body.name);
      if (!check.ok) return sendJSON(res, 400, { ok: false, message: check.message });
      const updated = store.setName(user.id, check.name);
      rooms?.setName?.(user.id, check.name);
      hub?.refreshFriends(user.id);
      return sendJSON(res, 200, { ok: true, me: publicUser(updated) });
    }

    /*
     * ------------------------------ 头像 ------------------------------
     *
     * 上传用**原始字节**（不套 multipart：零依赖，浏览器端 canvas 压完直接
     * POST blob 即可）。服务端只认魔术字节，不认 content-type。
     */
    if (pathname === '/api/avatar' && (req.method === 'POST' || req.method === 'DELETE')) {
      const user = currentUser(store, req);
      if (!user) return sendJSON(res, 401, { ok: false, message: '还没登录' });
      if (!avatars) return sendJSON(res, 500, { ok: false, message: '头像功能没准备好' });

      if (req.method === 'DELETE') {
        avatars.clear(user.id);
        const updated = store.setAvatar(user.id, '');
        hub?.refreshFriends(user.id);
        return sendJSON(res, 200, { ok: true, me: publicUser(updated) });
      }

      let buf;
      try {
        buf = await readRawBody(req, 2 * 1024 * 1024);
      } catch (err) {
        return sendJSON(res, err.statusCode || 400, { ok: false, message: err.message });
      }
      const saved = avatars.save(user.id, buf);
      if (!saved.ok) return sendJSON(res, 400, { ok: false, message: saved.message });
      const updated = store.setAvatar(user.id, saved.ext);
      hub?.refreshFriends(user.id);
      return sendJSON(res, 200, { ok: true, me: publicUser(updated) });
    }

    /*
     * 头像图片。没上传过的人返回**现场生成的 SVG**（不是 404）——
     * 平台、三个游戏、无名杀都可以直接把 avatar 当图片地址用。
     */
    if (pathname.startsWith('/avatar/')) {
      const id = pathname.slice('/avatar/'.length).split('/')[0];
      const user = id ? store.findUser(id) : null;
      if (!user) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      /*
       * 磁盘上那张图才是"有没有头像"的真相：数据库记着 avatar、文件却丢了（手动删了
       * data/avatars、或者换机器搬库）时必须退回默认 SVG。此时 content-type 也得跟着
       * 变回 image/svg+xml —— 否则浏览器拿到"PNG 头 + SVG 内容"就是一张破图。
       */
      const file = user.avatar ? avatars?.read(user.id, user.avatar) : null;
      const buf = file || defaultAvatarSvg(user.id, user.name);
      const type = file ? mimeForExt(user.avatar) : 'image/svg+xml';
      const etag = `W/"${file ? `a${user.avatar_at}` : `d${Buffer.byteLength(user.name || '')}`}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'public, max-age=2592000' }).end();
        return;
      }
      res.writeHead(200, {
        'content-type': type,
        'content-length': buf.length,
        'cache-control': file ? 'public, max-age=2592000, immutable' : 'public, max-age=86400',
        etag,
      });
      if (req.method === 'HEAD') { res.end(); return; }
      res.end(buf);
      return;
    }

    /* ------------------------------ 无名杀 · 平台接入 ------------------------------ */

    if (pathname === '/api/noname/state' && req.method === 'POST') {
      const user = currentUser(store, req);
      if (!user) return sendJSON(res, 401, { ok: false, message: '还没登录' });
      if (!nonamePresence) return sendJSON(res, 500, { ok: false, message: '无名杀状态功能没准备好' });
      const body = await readBody(req);
      const result = nonamePresence.set(user.id, body);
      if (!result.ok) return sendJSON(res, 400, { ok: false, message: result.message });
      return sendJSON(res, 200, { ok: true, playing: result.playing });
    }

    /* 无名杀里的「邀请好友」对话框要的好友列表（带平台在线状态）。 */
    if (pathname === '/api/noname/friends' && req.method === 'GET') {
      const user = currentUser(store, req);
      if (!user) return sendJSON(res, 401, { ok: false, message: '还没登录' });
      if (!hub) return sendJSON(res, 500, { ok: false, message: '好友功能没准备好' });
      return sendJSON(res, 200, { ok: true, list: hub.friendsWithPresence(user.id) });
    }

    /*
     * 无名杀里发邀请。和平台的 `invite.send` 走同一套投递（WebSocket 的 invite），
     * 区别只是房号是**无名杀自己的**、而且邀请人此刻没有平台连接。
     */
    if (pathname === '/api/noname/invite' && req.method === 'POST') {
      const user = currentUser(store, req);
      if (!user) return sendJSON(res, 401, { ok: false, message: '还没登录' });
      if (!hub) return sendJSON(res, 500, { ok: false, message: '好友功能没准备好' });

      const body = await readBody(req);
      const room = String(body.room || '');
      if (!/^[A-Za-z0-9]{1,32}$/.test(room)) {
        return sendJSON(res, 400, { ok: false, message: '先建房或进房，再邀请好友' });
      }
      const to = Array.isArray(body.to) ? body.to : [];
      if (!to.length) return sendJSON(res, 400, { ok: false, message: '没有选好友' });

      const friends = new Map(store.listFriends(user.id).map((f) => [f.id, f]));
      let sent = 0;
      for (const raw of to) {
        const id = String(raw || '').trim().toUpperCase();
        if (!friends.has(id)) continue;
        // 只有开着平台页面（WebSocket）的人才收得到邀请横幅；在无名杀里的人收不到，
        // 但他们本来就能在平台好友列表里看到「正在玩无名杀」，不靠这条邀请。
        if (!hub.isOnline(id)) continue;
        sent += hub.deliver(id, {
          t: 'invite',
          from: publicUser(user),
          game: 'noname',
          code: room,
          mode: String(body.mode || ''),
        });
      }
      return sendJSON(res, 200, { ok: true, sent, message: sent ? '' : '好友都不在平台页面上，没发出去' });
    }

    /* ------------------------------ 游戏可用性 ------------------------------ */

    if (pathname === '/api/games') {
      return sendJSON(res, 200, { ok: true, games: availableGames() });
    }

    /* ------------------------------ 注册 ------------------------------ */

    if (pathname === '/api/register' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await register(store, { name: body.name, password: body.password });
      if (!result.ok) return sendJSON(res, 400, { ok: false, message: result.message });
      return sendJSON(res, 200, {
        ok: true,
        me: result.user,
        games: availableGames(),
      }, {
        'set-cookie': sessionCookie(result.sid, { secure: isSecureRequest(req) }),
      });
    }

    /* ------------------------------ 登录 / 登出 ------------------------------ */

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await login(store, { id: body.id, password: body.password });
      if (!result.ok) return sendJSON(res, 401, { ok: false, message: result.message });
      return sendJSON(res, 200, {
        ok: true,
        me: result.user,
        games: availableGames(),
      }, {
        'set-cookie': sessionCookie(result.sid, { secure: isSecureRequest(req) }),
      });
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      const user = currentUser(store, req);
      if (user) logout(store, user.sid);
      return sendJSON(res, 200, { ok: true }, { 'set-cookie': clearCookie() });
    }

    return sendJSON(res, 404, { ok: false, message: '没有这个接口' });
  }

  /**
   * URL 路径 → 若干"仓库内相对路径"候选（按优先级）。
   * 第一条命中且真的是文件的就是答案；全都没有就 404。
   */
  function candidatesFor(pathname) {
    const list = [];

    const page = PAGES.get(pathname);
    if (page) list.push(page);

    for (const mount of MOUNTS) {
      if (!pathname.startsWith(mount.prefix)) continue;
      const rest = pathname.slice(mount.prefix.length);
      // 只允许普通字符，挡掉编码过的穿越与空段
      if (rest.includes('..') || rest.includes('\\') || rest.includes('\0')) break;
      /*
       * `/games/noname-web/**` 一律不发。
       * 它只该从 `/noname/`（`dist/` 那一份）出去 —— 否则谁都能顺着
       * `/games/noname-web/node_modules/...` 把几百兆依赖和上游源码全拖走，
       * 而且和 `/noname/` 形成两套"同一份东西"的地址，排查时很容易看错是谁在发。
       */
      if (mount.prefix === '/games/' && (rest === 'noname-web' || rest.startsWith('noname-web/'))) break;
      /*
       * 斗地主也只从 `/ddz/` 出去（理由见 MOUNTS 里那条注释）：两套地址会让
       * "页面 404 但资源 200"这种问题变得极难判断。
       */
      if (mount.prefix === '/games/' && (rest === 'ddz' || rest.startsWith('ddz/'))) break;
      /*
       * 大富翁也只能从 `/games/monopoly/`（构建产物）出去，不能顺着
       * `/games/monopoly/upstream/**` 把上游源码拖走。上面有专属挂载点，这条是兜底。
       */
      if (mount.prefix === '/games/' && (rest === 'monopoly' || rest.startsWith('monopoly/'))) break;
      // rest 为空 = 这个挂载点的根（例如 `/noname/`），交给目录 → index.html 的逻辑
      list.push(rest ? `${mount.dir}/${rest}` : `${mount.dir}/`);
      break;
    }

    // 无名杀的根绝对路径兜底（理由见 NONAME_DIST 的注释）。
    // 顺序是"先它上传过的（data/noname），再打包产物（dist）"—— 导入的扩展、
    // 换过的背景图要盖住同名的自带文件，否则客户端读回来的是旧的。
    const bare = pathname.replace(/^\/+/, '');
    if (bare && !bare.includes('..') && !bare.includes('\\') && !bare.includes('\0')) {
      list.push(`${NONAME_DATA}/${bare}`);
      list.push(`${NONAME_DIST}/${bare}`);
    }

    /*
     * 无扩展名的音频路径 → 真实文件。
     *
     * 页面里的音频请求会被 `shared/ui/no-idm.js` 去掉 `.mp3/.ogg/.wav` 扩展名
     * （否则 IDM 之类的下载器会把它们抓进“下载”文件夹）。这里负责把
     * `/mahjong/audio/1m` 映射回 `.../1m.mp3`，按真实扩展名发 `audio/*`。
     * 只对**最后一段没有点**的路径探测，避免给所有 404 都加 6 次 stat。
     */
    const last = bare.slice(bare.lastIndexOf('/') + 1);
    if (last && !last.includes('.')) {
      for (const rel of [...list]) {
        if (!rel || rel.endsWith('/') || rel.slice(rel.lastIndexOf('/') + 1).includes('.')) continue;
        for (const ext of MEDIA_EXTS) list.push(rel + ext);
      }
    }

    return list;
  }

  /** 把一条相对路径解析成绝对文件路径；不是文件就返回 null。 */
  function resolveFile(relPath) {
    let filePath = resolve(ROOT, relPath);
    // 双保险：解析后的绝对路径必须还在仓库内
    if (!filePath.startsWith(ROOT)) return null;

    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        filePath = join(filePath, 'index.html');
        return statSync(filePath).isFile() ? filePath : null;
      }
      return stat.isFile() ? filePath : null;
    } catch {
      return null;
    }
  }

  /**
   * 发一个文件，支持 Range、ETag 协商与 gzip。
   *
   * 为什么要 Range：无名杀的音频是**边播边取**的（浏览器发 `Range: bytes=...`），
   * 老的无名杀网页端就靠这个做 BGM/音效；不支持 Range 的静态服务器只能整段下载完
   * 才能播放，一首 BGM 几十 MB，手机上体感就是"点了没声音"。
   *
   * 为什么要 gzip：无名杀首屏 ~250 个模块，不压十几 MB；客户端有 **10 秒**
   * 载入超时（`app.defer` 之前那个 `setTimeout(lib.init.reset)`），超时就弹
   * 「游戏似乎未正常载入，是否重置游戏？」。压缩是这条弹窗的根治办法。
   *
   * @param {boolean} longCache 这份文件是不是**无名杀打包产物**（只有它可以长时间缓存）
   */
  function sendFile(req, res, filePath, stat, longCache = false) {
    const ext = extname(filePath).toLowerCase();
    const compressible = COMPRESSIBLE.has(ext);
    /** 牌桌的 wasm/pck 就算不 gzip 也要 ETag（no-cache 靠它协商） */
    const etagable = compressible || TABLE_ASSET.has(ext);
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

    // 协商缓存：内容没变就 304，别再把几 MB 重发一遍
    if (etagable && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': cacheControl(ext, longCache) }).end();
      return;
    }

    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': cacheControl(ext, longCache),
      'accept-ranges': 'bytes',
    };
    // 音频明确标 inline：即使下载器认出了 MIME，也不该把它当附件保存。
    if (MIME[ext]?.startsWith('audio/')) headers['content-disposition'] = 'inline';
    if (etagable) {
      headers.etag = etag;
      headers.vary = 'accept-encoding';
    }

    const range = req.headers.range;
    let start = 0;
    let end = stat.size - 1;
    let partial = false;

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m) {
        const [, rawStart, rawEnd] = m;
        if (rawStart === '' && rawEnd === '') {
          rangeFail(res, stat.size);
          return;
        }
        if (rawStart === '') {
          // 后缀范围：bytes=-500 = 最后 500 字节
          const suffix = Number(rawEnd);
          if (!Number.isFinite(suffix) || suffix <= 0) { rangeFail(res, stat.size); return; }
          start = Math.max(0, stat.size - suffix);
          end = stat.size - 1;
        } else {
          start = Number(rawStart);
          end = rawEnd === '' ? stat.size - 1 : Number(rawEnd);
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
          rangeFail(res, stat.size);
          return;
        }
        if (end >= stat.size) end = stat.size - 1;
        partial = true;
      }
    }

    /*
     * gzip 只在「整份、文本、客户端要 gzip」时做。
     * Range 请求（音频）跳过：字节范围是**压缩前**的坐标，混着压缩会切错。
     */
    const wantsGzip =
      compressible && !partial && stat.size > 1024 &&
      /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));

    if (wantsGzip) {
      const cached = gzipFor(filePath, stat);
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = cached.length;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      res.end(cached);
      return;
    }

    if (partial) {
      headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['content-length'] = end - start + 1;
      res.writeHead(206, headers);
    } else {
      headers['content-length'] = stat.size;
      res.writeHead(200, headers);
    }

    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(filePath, { start, end }).pipe(res);
  }

  /**
   * 拿这个文件的 gzip 结果（内存里缓存一份，键里带 mtime，文件换了自动重压）。
   * 无名杀首屏只有 ~250 个文件、总共几 MB，缓存吃完之后每次都是零成本。
   */
  function gzipFor(filePath, stat) {
    const key = `${filePath}|${stat.size}|${Math.floor(stat.mtimeMs)}`;
    const hit = gzipCache.get(key);
    if (hit) {
      // 命中就挪到队尾（最近用过）
      gzipCache.delete(key);
      gzipCache.set(key, hit);
      return hit;
    }
    const raw = readFileSync(filePath);
    let buf = gzipSync(raw, { level: 6 });
    if (buf.length >= raw.length) buf = raw; // 本来就小/压不动，别白压
    if (key && buf.length <= GZIP_CACHE_FILE_MAX && gzipCacheBytes + buf.length <= GZIP_CACHE_MAX) {
      gzipCache.set(key, buf);
      gzipCacheBytes += buf.length;
      // 超了就从最老的开始扔
      while (gzipCacheBytes > GZIP_CACHE_MAX && gzipCache.size > 1) {
        const oldest = gzipCache.keys().next().value;
        const dropped = gzipCache.get(oldest);
        gzipCache.delete(oldest);
        gzipCacheBytes -= dropped.length;
      }
    }
    return buf;
  }

  function cacheControl(ext, longCache) {
    if (longCache) return 'public, max-age=600';
    /*
     * 牌桌的 wasm/pck：几十 MB，不能每次打开都重下；但也绝不能"缓存一天"糊过去 ——
     * 重新导出之后必须让用户拿到新的。`no-cache` = 存下来、每次带 ETag 问一句：
     * 没变就 304（一个来回几十字节），变了才重新下。
     */
    if (TABLE_ASSET.has(ext)) return 'public, no-cache';
    return CACHEABLE.has(ext) ? 'public, max-age=86400' : 'no-store';
  }

  function rangeFail(res, size) {
    res.writeHead(416, {
      'content-range': `bytes */${size}`,
      'content-type': 'text/plain; charset=utf-8',
    }).end('416');
  }

  /**
   * 大富翁音频出口：URL 不带扩展名、响应头不发 audio/*。
   *
   * 这样页面里的 Howler 仍然能拿 ArrayBuffer 解码（Web Audio 不看 MIME），
   * 但 IDM 这类下载器不会把请求认成“可下载的 mp3/ogg”，从根上不弹窗。
   * 只允许 `sfx/<名字>` / `bgm/<名字>`，文件名白名单式校验，不做目录遍历。
   */
  function serveMonopolyAudio(req, res, pathname) {
    if (!pathname.startsWith(MONOPOLY_AUDIO_PREFIX + '/')) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }).end('405');
      return true;
    }

    let rel;
    try {
      rel = decodeURIComponent(pathname.slice(MONOPOLY_AUDIO_PREFIX.length + 1));
    } catch {
      rel = '';
    }
    if (!/^(sfx|bgm)\/[a-z0-9-]+$/.test(rel)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
      return true;
    }

    // 同一个逻辑名可能只有 ogg 或只有 mp3；按顺序探测，命中哪个发哪个。
    for (const ext of ['.ogg', '.mp3']) {
      const file = join(ROOT, 'games/monopoly/web/assets/audio', rel + ext);
      if (!existsSync(file)) continue;
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(stat.size),
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      });
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }
      createReadStream(file).pipe(res);
      return true;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    return true;
  }

  function serveStatic(req, res, pathname) {
    /*
     * 莲花广麻：游戏页入口要注入平台身份 + 全屏按钮；手机外壳是平台自己的页面。
     */
    if (pathname === '/play/mahjong') {
      const filePath = resolve(ROOT, 'web/mahjong-frame.html');
      if (!existsSync(filePath)) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('莲花广麻手机外壳缺失');
        return;
      }
      sendFile(req, res, filePath, statSync(filePath), false);
      return;
    }
    if (pathname === '/mahjong' || pathname === '/mahjong/' || pathname === '/mahjong/index.html') {
      const filePath = resolve(ROOT, 'games/mahjong/web/index.html');
      if (!existsSync(filePath)) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
          .end('莲花广麻前端还没构建（见 games/mahjong/README.md）');
        return;
      }
      sendMahjongIndex(req, res, filePath);
      return;
    }
    /*
     * 狼人杀是一套**客户端路由**的 SPA（`/werewolf/`、`/werewolf/createRoom`、
     * `/werewolf/join`…）。这些地址在磁盘上都不存在，所以：
     *   · 没有扩展名的 `/werewolf/*` 一律回入口页（登录门也拦在入口页上）；
     *   · 带扩展名的（`/werewolf/assets/index-xxxx.js`）走下面的挂载点。
     * 顺序不能反：先发入口页，再找文件。
     */
    if (pathname.startsWith('/games/monopoly/') && isMonopolyDocument(pathname)) {
      const filePath = resolve(ROOT, 'games/monopoly/web/index.html');
      if (!existsSync(filePath)) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
          .end('大富翁前端还没构建（见 games/monopoly/README.md）');
        return;
      }
      sendMonopolyIndex(req, res, filePath);
      return;
    }
    if (isWerewolfDocument(pathname)) {
      const filePath = resolve(ROOT, 'games/werewolf/dist/index.html');
      if (!existsSync(filePath)) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
          .end('狼人杀前端还没打包（见 games/werewolf/README.md）');
        return;
      }
      sendWerewolfIndex(req, res, filePath);
      return;
    }
    /*
     * 无名杀的桥接脚本。**必须放在 dist 之外**：`pnpm build` / 更新上游会重建 dist，
     * 放在里面就会被覆盖掉。它由 index.html 里注入的一行 <script> 加载。
     */
    if (pathname === '/noname/frp-bridge.js') {
      const filePath = resolve(ROOT, NONAME_BRIDGE);
      sendFile(req, res, filePath, statSync(filePath), false);
      return;
    }
    // 只有上游打包产物可以长缓存（10 分钟），平台自己的文件照旧 no-store
    const longCache = pathname.startsWith('/noname/') || pathname.startsWith('/werewolf/_next/') || pathname.startsWith('/werewolf/roles/') || pathname.startsWith('/werewolf/avatars/') || pathname.startsWith('/werewolf/brand/');
    for (const relPath of candidatesFor(pathname)) {
      const filePath = resolveFile(relPath);
      if (filePath) {
        // 无名杀的入口页要注入桥接脚本，而且不能长缓存（否则桥接版本更新要等 10 分钟）
        if (pathname === '/noname/' || pathname === '/noname/index.html') {
          sendInjectedNonameIndex(req, res, filePath);
          return;
        }
        sendFile(req, res, filePath, statSync(filePath), longCache);
        return;
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
  }

  /**
   * 把桥接脚本注入无名杀的 index.html。
   *
   * 为什么用**服务端注入**而不是改上游源码：
   *   · 不用重建 1.3 GB 的 dist（重建期间线上就是半坏状态）；
   *   · 上游更新后注入逻辑仍然生效，不需要在 `noname-update.mjs` 里再加一个补丁；
   *   · 注入内容只在服务端，客户端拿到的是普通的一行 <script>。
   *
   * 上游的 index.html 没有 <body>（脚本全在 <head> 里），所以插在 `</head>` 前；
   * 找不到就追加到末尾 —— 两种都能保证脚本在入口模块之后执行。
   */
  /**
   * 平台通用全屏按钮。所有游戏入口都要有；**只在用户点击时进全屏，绝不自动**。
   * 平台游戏直接写在 index.html 里；无名杀/狼人杀是上游产物，只能服务端注入。
   */
  const FULLSCREEN_TAG = '<script defer src="/shared/ui/fullscreen.js"></script>';
  /**
   * 音频请求去扩展名，防 IDM / 迅雷自动抓取（见 shared/ui/no-idm.js）。
   * 上游页面没有地方改，只能服务端注入；平台自己的页面直接写在 HTML 里。
   */
  const NO_IDM_TAG = '<script src="/shared/ui/no-idm.js"></script>';

  function injectFullscreen(html) {
    const tags = `${NO_IDM_TAG}\n${FULLSCREEN_TAG}`;
    return html.includes('</body>')
      ? html.replace('</body>', `${tags}\n</body>`)
      : `${html}\n${tags}\n`;
  }

  function sendInjectedNonameIndex(req, res, filePath) {
    const raw = readFileSync(filePath, 'utf8');
    const tag = `<script type="module" src="/noname/frp-bridge.js?v=${NONAME_BRIDGE_VERSION}"></script>\n${NO_IDM_TAG}\n${FULLSCREEN_TAG}`;
    const html = raw.includes('</head>')
      ? raw.replace('</head>', `${tag}\n</head>`)
      : `${raw}\n${tag}\n`;
    const body = Buffer.from(html, 'utf8');
    const wantsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    const out = wantsGzip ? gzipSync(body, { level: 6 }) : body;
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'content-length': out.length,
      // 入口页不缓存：登录门 + 桥接版本都在这份 HTML 上
      'cache-control': 'no-store',
    };
    if (wantsGzip) {
      headers['content-encoding'] = 'gzip';
      headers.vary = 'accept-encoding';
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(out);
  }

  /**
   * 狼人杀的入口页。
   *
   * 为什么单独一个函数而不是走 serveStatic 的通用分支：入口页**必须 no-store**
   * （登录门、资源清单都在这份 HTML 上），而且它常被 SPA 的客户端路由复用
   * （`/werewolf/join` 之类在磁盘上并不存在）。
   * 打包产物的文件名里带 hash，缓存问题在那边由 `max-age=600` 兜着。
   */
  function sendWerewolfIndex(req, res, filePath) {
    const html = injectFullscreen(readFileSync(filePath, 'utf8'));
    const body = Buffer.from(html, 'utf8');
    const wantsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    const out = wantsGzip ? gzipSync(body, { level: 6 }) : body;
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'content-length': out.length,
      'cache-control': 'no-store',
    };
    if (wantsGzip) {
      headers['content-encoding'] = 'gzip';
      headers.vary = 'accept-encoding';
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(out);
  }

  /**
   * 大富翁的入口页：把平台身份注入 `window.__FRP_ME__`。
   *
   * 上游页面是给游客/账号登录用的，自己维护 localStorage.user。这里不改它的
   * 登录页逻辑，只在最前面把平台会话"翻译"好（`src/frp/bootstrap.ts` 会读它）。
   * 注入的是**公开资料**（id/名字/头像），没有密码、没有 token。
   */
  function sendMonopolyIndex(req, res, filePath) {
    const user = currentUser(store, req);
    const me = publicUser(user);
    const payload = JSON.stringify(me).replace(/</g, '\\u003c');
    let body = readFileSync(filePath, 'utf8');
    const script = `<script>window.__FRP_ME__=${payload};</script>\n${NO_IDM_TAG}`;
    body = body.includes('</head>') ? body.replace('</head>', `${script}</head>`) : script + body;

    const raw = Buffer.from(body, 'utf8');
    const wantsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    const out = wantsGzip ? gzipSync(raw, { level: 6 }) : raw;
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'content-length': out.length,
      'cache-control': 'no-store',
    };
    if (wantsGzip) {
      headers['content-encoding'] = 'gzip';
      headers.vary = 'accept-encoding';
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(out);
  }

  /**
   * 莲花广麻的入口页：注入平台账号 + 全屏按钮。
   *
   * 上游自己的登录入口（WakuDemo OAuth）在托管模式下被前端补丁关掉了，
   * 页面只认 `window.__FRP_ME__`（由这里注入）——**账号就是平台首页那个账号**。
   * 上游 `index.html` 的脚本是 `type="module"`，注入的经典脚本在 head 里先执行。
   */
  function sendMahjongIndex(req, res, filePath) {
    const user = currentUser(store, req);
    const me = publicUser(user);
    const host = String(req.headers.host || '127.0.0.1');
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const local = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);
    const origin = `${forwarded || (local ? 'http' : 'https')}://${host}`;
    // 上游会把 avatar 当 <img src> 用；相对路径在 /mahjong/ 下会解析错，这里给绝对地址。
    const payload = JSON.stringify({
      ...me,
      avatar: me?.avatar ? new URL(me.avatar, origin).href : `${origin}/avatar/${encodeURIComponent(user.id)}`,
    }).replace(/</g, '\\u003c');
    let body = readFileSync(filePath, 'utf8');
    const script = `<script>window.__FRP_ME__=${payload};</script>\n${NO_IDM_TAG}\n${FULLSCREEN_TAG}`;
    body = body.includes('</head>') ? body.replace('</head>', `${script}</head>`) : script + body;

    const raw = Buffer.from(body, 'utf8');
    const wantsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
    const out = wantsGzip ? gzipSync(raw, { level: 6 }) : raw;
    const headers = {
      'content-type': 'text/html; charset=utf-8',
      'content-length': out.length,
      // 入口页不缓存：账号和资源清单都在这份 HTML 上
      'cache-control': 'no-store',
    };
    if (wantsGzip) {
      headers['content-encoding'] = 'gzip';
      headers.vary = 'accept-encoding';
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(out);
  }

  /**
   * 无名杀（含手机伪横屏外壳）**必须登录平台的账号**才能打开。
   *
   * 只拦"文档"请求：`/noname/`、`/noname/index.html`、`/play/noname`。
   * 素材 / Service Worker / 9 个文件后端**不拦** —— 拦了反而会让已经登录的页面
   * 在加载中途 302 到登录页，表现成白屏。
   */
  function isNonameDocument(pathname) {
    return pathname === '/noname/' || pathname === '/noname/index.html' || pathname === '/play/noname';
  }

  /**
   * 狼人杀的"文档"请求（页面本身）。
   *
   * 判断方式是**没有扩展名**：`/werewolf/`、`/werewolf/join`、`/werewolf/play` 都是页面；
   * `/werewolf/assets/index-abc.js`、`/werewolf/favicon.ico` 是资源，不拦。
   * 拦截范围必须和 SPA 的路由一致，否则刷新某个游戏内页面就会 404。
   */
  function isWerewolfDocument(pathname) {
    if (pathname === '/werewolf' || pathname === '/werewolf/' || pathname === '/werewolf/index.html') return true;
    if (!pathname.startsWith('/werewolf/')) return false;
    return !/\.[A-Za-z0-9]+$/.test(pathname);
  }

  /**
   * 斗地主的"文档"请求。
   *
   * 只认这几个：页面本身。`/ddz/css/table.css`、`/ddz/js/**` 不拦 ——
   * 拦了会让已经登录的页面在加载中途 302，表现成白屏（和无名杀同一条经验）。
   * 页面里的身份仍然由 `/api/me` 和 WebSocket 的 ready 决定，静态资源不是秘密。
   */
  function isDdzDocument(pathname) {
    if (pathname === '/ddz' || pathname === '/ddz/' || pathname === '/ddz/index.html') return true;
    if (pathname === '/play/ddz') return true;
    /*
     * 牌桌自己是 Godot 导出的一个页面（iframe 里跑的），同样只认登录态。
     * `.wasm` / `.pck` / `index.js` 这些资源**不拦** —— 拦了会在加载中途 302 成白屏。
     */
    return pathname === '/ddz/table/index.html';
  }

  /**
   * 大富翁的"文档"请求：游戏页本身 + 手机伪横屏外壳。
   *
   * 它是**平台游戏**（走 rooms.mjs），页面在标准的 `/games/monopoly/` 下；
   * 但和另外三个缝进来的游戏一样**必须登录** —— 页面里没有昵称输入框，
   * 座位直接就是平台账号，未登录时连 WebSocket 都认不出人。
   * 资源（`/games/monopoly/js/**`、`css/**`）**不拦**：拦了会让已登录的页面
   * 在加载中途 302 到登录页，表现成白屏（无名杀/斗地主都踩过同一条）。
   */
  function isMonopolyDocument(pathname) {
    if (pathname === '/play/monopoly') return true;
    if (pathname === '/games/monopoly' || pathname === '/games/monopoly/' || pathname === '/games/monopoly/index.html') return true;
    /*
     * 上游用 vue-router 的 history 模式：`/room-router`、`/room`、`/game` 这些
     * 地址在磁盘上不存在，刷新/深链必须回入口页（和狼人杀同一条规则）。
     * 带扩展名的（assets/**、draco/**、glb、ico）是资源，不拦。
     */
    if (pathname.startsWith('/games/monopoly/')) return !/\.[A-Za-z0-9]+$/.test(pathname);
    return false;
  }

  /**
   * 莲花广麻的"文档"请求：游戏页本身 + 手机伪横屏外壳。
   *
   * 页面在 `/mahjong/`（Vite `base: './'`，尾斜杠不能少）。账号来自平台会话 +
   * 本机网关注入的身份头，所以**必须登录**；资源（`/mahjong/assets/**`）不拦 ——
   * 拦了会在加载中途 302 成白屏（无名杀/斗地主/大富翁都踩过同一条）。
   */
  function isMahjongDocument(pathname) {
    if (pathname === '/play/mahjong') return true;
    if (pathname === '/mahjong' || pathname === '/mahjong/' || pathname === '/mahjong/index.html') return true;
    // 上游没有客户端路由；带扩展名的都是资源。
    return false;
  }

  return async function handle(req, res) {
    const pathname = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    const searchParams = new URL(req.url || '/', 'http://127.0.0.1').searchParams;

    /*
     * 来访日志。隧道排查（docs/TUNNEL.md）全靠它：节点返回 503 时，
     * 唯一能区分"流量没转过来"和"转过来了但服务出错"的证据就是这里有没有这一行。
     * 只记 方法 / 路径 / 状态 / Host / 来源 IP —— **绝不记 cookie 和请求体**
     * （会话在 cookie 里，日志落在 data/，已 .gitignore）。
     * Host 尤其有用：它证明节点把哪个域名转给了我们。
     */
    res.on('finish', () => {
      const host = req.headers.host || '-';
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const from = forwarded || req.socket.remoteAddress || '-';
      console.log(`[来访] ${req.method} ${pathname} -> ${res.statusCode} host=${host} from=${from}`);
    });

    try {
      /*
       * 莲花广麻的 REST：`/mahjong/api/*` 原样转给本机的 Python 后端（只换前缀）。
       * 身份由这里注入（`x-frp-user-*`），后端开了 FRP_TRUSTED_HEADERS 就认平台账号；
       * 页面自己的 OAuth 登录入口在托管模式下是关掉的。
       */
      if (pathname === MAHJONG_API_PREFIX || pathname.startsWith(MAHJONG_API_PREFIX + '/')) {
        const user = currentUser(store, req);
        if (!user) {
          res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            .end(JSON.stringify({ detail: { code: 'AUTH_REQUIRED' } }));
          return;
        }
        if (!mahjong) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            .end(JSON.stringify({ detail: { code: 'MAHJONG_BACKEND_DOWN' } }));
          return;
        }
        mahjong.proxyHttp(req, res, user, pathname);
        return;
      }
      if (pathname.startsWith('/api/') || pathname.startsWith('/avatar/') || pathname === MONOPOLY_API_PREFIX || pathname.startsWith(MONOPOLY_API_PREFIX + '/')) {
        await handleApi(req, res, pathname);
        return;
      }
      /*
       * 无名杀的文件后端（`/checkFile` `/readFile` `/writeFile` … 9 个根路径）。
       * 客户端是**从站点根**发的（`fetch("/checkFile?fileName=…")`，不是 `/noname/checkFile`），
       * 所以这条判断必须放在静态文件之前、并且只认那 9 个确切路径 —— 见 server/noname.mjs。
       */
      if (await handleNonameRequest(req, res, pathname, searchParams)) return;
      /*
       * 莲花广麻：Vite 的 base 是相对路径（`./assets/…`），少了尾斜杠资源会解析到站点根；
       * `?join=XXXXXX` 必须原样带过去，否则"点好友的房"会丢房号。
       * 放在登录门**前面**：补斜杠不该需要先登录（登录门随后会带着完整地址回跳）。
       */
      if (pathname === '/mahjong') {
        res.writeHead(301, { location: '/mahjong/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '') }).end();
        return;
      }
      /*
       * 无名杀从这一版起**绑平台账号**：没登录就先回平台登录页，登录完再回到原地址。
       * `return` 里带完整路径（含 ?frpJoin=…），这样"好友邀请你进房"的深链不会丢。
       */
      if (isNonameDocument(pathname) && !currentUser(store, req)) {
        res.writeHead(302, {
          location: `/?return=${encodeURIComponent(req.url || pathname)}`,
          'cache-control': 'no-store',
        }).end();
        return;
      }
      /*
       * 狼人杀同样**必须登录**：页面里没有昵称输入框，座位直接就是平台账号。
       * 未登录 → 回平台登录页，登录完带着 `return` 回到原来的狼人杀地址
       * （邀请深链 `/werewolf/join?number=…` 因此不会丢）。
       */
      if (isWerewolfDocument(pathname) && !currentUser(store, req)) {
        res.writeHead(302, {
          location: `/?return=${encodeURIComponent(req.url || pathname)}`,
          'cache-control': 'no-store',
        }).end();
        return;
      }
      /*
       * 斗地主**必须登录**：页面里没有昵称输入框，三个座位直接就是三个平台账号，
       * 报文里的身份也只有一个来源（会话）。未登录 → 回登录页，登录完回到 /ddz/。
       */
      if (isDdzDocument(pathname) && !currentUser(store, req)) {
        res.writeHead(302, {
          location: `/?return=${encodeURIComponent(req.url || pathname)}`,
          'cache-control': 'no-store',
        }).end();
        return;
      }
      /*
       * 大富翁**必须登录**：页面里没有昵称输入框，座位直接就是平台账号
       * （邀请/进好友房的深链 `?join=XXXXXX` 靠 `return` 原样带回来）。
       */
      if (isMonopolyDocument(pathname) && !currentUser(store, req)) {
        res.writeHead(302, {
          location: `/?return=${encodeURIComponent(req.url || pathname)}`,
          'cache-control': 'no-store',
        }).end();
        return;
      }
      /*
       * 莲花广麻**必须登录**：页面里没有起名/登录框，账号就是平台首页那个账号
       * （邀请进房深链 `?join=XXXXXX` 靠 `return` 原样带回来）。
       */
      if (isMahjongDocument(pathname) && !currentUser(store, req)) {
        res.writeHead(302, {
          location: `/?return=${encodeURIComponent(req.url || pathname)}`,
          'cache-control': 'no-store',
        }).end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }).end('405');
        return;
      }
      // 无名杀的页面里有大量**相对路径**（`./noname/entry.js` 之类）：
      // 少了尾斜杠，浏览器会把它们解析到站点根上，整个应用就白了。
      if (pathname === '/noname') {
        res.writeHead(301, { location: '/noname/' }).end();
        return;
      }
      // 狼人杀同理（Vite 的 base 是 `/werewolf/`，少了尾斜杠资源全 404）
      if (pathname === '/werewolf') {
        res.writeHead(301, { location: '/werewolf/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '') }).end();
        return;
      }
      // 斗地主：页面里用的是相对路径（`css/style.css`、`js/main.js`），少了尾斜杠会解析到站点根
      if (pathname === '/ddz') {
        res.writeHead(301, { location: '/ddz/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '') }).end();
        return;
      }
      /*
       * 大富翁同上：页面里全是相对路径（`css/style.css`、`js/ui/…`），
       * 少了尾斜杠浏览器会把它们解析到 `/games/` 或站点根上 —— 白屏。
       * `?join=XXXXXX` 要原样带上，否则"点好友的房"会丢掉房号。
       */
      if (pathname === '/games/monopoly') {
        res.writeHead(301, { location: '/games/monopoly/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '') }).end();
        return;
      }
      if (serveMonopolyAudio(req, res, pathname)) return;
      serveStatic(req, res, pathname);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      const message = err && err.message === '请求体过大' ? err.message : '服务端出错';
      try { sendJSON(res, 400, { ok: false, message }); } catch { res.end(); }
    }
  };
}