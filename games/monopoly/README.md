# 大富翁（上游 MineMonopoly 的 Web 客户端）

页面 `/games/monopoly/`；手机 `/play/monopoly`（伪横屏外壳）。
**不是平台房间游戏**：没有 `rooms.mjs`、没有服务器权威规则，也没有我们自己画的 UI。

## 上游与许可

- 上游 `https://github.com/FatPaper-1874/fatpaper-monopoly`（301 → `FatPaper-1874/mine-monopoly`），**GPL-3.0**。
- 源码整份归档在 `upstream/`，**不是 fork**；上游 `LICENSE` 原样保留。
- 桥接/补丁同样按 GPL-3.0；地图版权归作者。
- **自用，不含付费 `.fpmap` 源文件**：只放官方公开的 5 张 `.mmmap`。

## 目录

| 路径 | 是什么 |
| --- | --- |
| `upstream/` | 上游 pnpm monorepo 源码（Vue3 + Three.js + PeerJS；不含 `node_modules`/`dist`） |
| `web/` | 上游 `build:web` 产物，**要提交**；服务器不装 node_modules |
| `maps/` | 5 张官方公开 `.mmmap` + 封面 + `manifest.json`，经 `/monopoly-maps/` 提供 |
| `tools/fetch-official-maps.mjs` | 当初下载/校验地图的脚本（只在补图时手动跑） |

## 构建

```powershell
cd E:\frp-game\games\monopoly\upstream
$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'
pnpm install --filter "@mine-monopoly/client..." --frozen-lockfile
pnpm --filter @mine-monopoly/env build

cd apps\client
pnpm build:web
```

构建配置 `upstream/.env.frp`：`VITE_WEB_BASE_PATH=/games/monopoly/`、
`MAP_ENCRYPT_KEY=rO8yZ3bM2bW9gA9u`、`API_BASE_PREFIX=/monopoly-server`。
**base 用错资源全 404；key 用错所有地图读不了。**

覆盖产物（先删再拷，旧 hash 不会自己消失）：

```powershell
cd E:\frp-game
Remove-Item games\monopoly\web -Recurse -Force
robocopy games\monopoly\upstream\apps\client\dist\frontend games\monopoly\web /E /XF *.gz stats.html
```

## 对上游的补丁（只改源码）

1. `apps/client/vite.config.ts`：`envPath` → `../../.env.frp`；base 默认 `/games/monopoly/`；`peerjs` alias → `src/frp/relay-peer.ts`。
2. `src/frp/relay-peer.ts`（新增）：PeerJS 兼容 WS 中转；`Peer`/`DataConnection`、文本 + 二进制、断线 1s→10s 重连、`hello.resume` 保 peerId。
3. `src/frp/bootstrap.ts`（新增）：`__FRP_ME__` → 上游 `localStorage.user`；15s presence 心跳；页面内邀请弹窗；`isFrpHosted()/frpMe()`。
4. `src/main.ts`：先注入身份再 `initPlatform()`；mount 后启动桥。
5. `src/router/index.ts`：托管时 `login` → `room-router`，**必须带 `query: to.query`**。
6. `room_router.vue`：右上角「回平台」。
7. `online-room-panel.vue`：读 `?join` 自动进房（`allowCreate:false`）。
8. `MonopolyClient.ts`：`joinRoom(roomId,{allowCreate})`；房间关了给中文提示。
9. `online-room.vue`：加「邀请好友」；`canStart` 只认 `isReady`（改地图会清准备）。
10. API base 改相对前缀（`utils/api/index.ts`、`global.config.ts`、`utils/api/room-router.ts`）。
11. `utils/audio/AudioManager.ts` + `server/http.mjs`：音频走 `/monopoly-audio/sfx|bgm/<名字>`，
    **URL 不带 `.mp3/.ogg`，响应 `application/octet-stream`**；Howler 仍用 Web Audio 解码。
    这是为了不让 IDM 等下载器把游戏 BGM/音效当成可下载媒体。
12. `utils/audio/config.ts`：去掉上游没有的 `notification/success/error/info` 四个音效，避免 404。

> 改完必须重新 `build:web` 并覆盖 `web/`；只改 `web/` 里的 hash 文件等于没改。

## 服务端接线

- `server/monopoly/index.mjs`：`/monopoly-server/*`（地图 + room-router join/emit-host/heart/status/delete/reclaim/公开房/开局）；内存房间表，30s 租约、60s 宽限、5min 保留。
- `server/monopoly/relay.mjs`：`/monopoly-relay` WS 中转；文本 JSON + 二进制 `[1][idLen][id][payload]`（地图 64KB 分块）。
- `server/monopoly-presence.mjs`：15s 心跳、45s TTL，好友列表 `playing`。
- `server/http.mjs`：静态挂载、`__FRP_ME__` 注入、登录门、SPA 兜底、`/monopoly-audio` 防抓取出口。
- `server/hub.mjs`：`game:'monopoly'` 邀请/回执，开局后拒绝邀请。

## 地图

`非常好地图`、`非常好地图-测试版`、`非常好地图·疯狂扩张版-双环方城`、`霓虹不夜城`、`玩具箱`。
文件是 UUID `.mmmap`；列表只返回 `mapUrl`，`sourceUrl` 一律 `null`。不要放 `.fpmap`。

## 测试

`npm run test:monopoly` = `tests/monopoly.test.mjs`（20 条 Node）+ `tests/monopoly.browser.mjs`（真 Chrome 全流程）。
`npm test` 含前者，`npm run test:browser` 含后者。浏览器测试自己起随机端口，不碰 7891。

## 已知限制

- 规则在房主浏览器，平台不防房主作弊（上游模型，D41）。
- 没有上游 Express/MySQL/管理后台/地图编辑器；加地图只能手工放 `.mmmap` + 改 `manifest.json`。
