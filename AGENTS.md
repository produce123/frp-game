# frp-game 工作台规则

本工作区（`E:\frp-game`）的长期约定。**新会话只读两份**：本文件 → `docs/NEXT.md`。
其余细节按需查（见文末「文档地图」，或 `docs/README.md` 那一页总索引），不要通读所有 docs。

## 项目是什么

Windows 本机跑**唯一一个 Node 进程**（`server/`，**零第三方运行时依赖**），
提供网页游戏平台：账号 / 好友 / 房间 / 三个自建小游戏 + 七个缝合的上游项目
（无名杀 / 狼人杀 / 斗地主 / 大富翁 / 莲花广麻 / 地平线赛车 / AI 小镇）。
公网通过隧道暴露（TLS 在隧道那端终止），同学用浏览器打开就能玩，不用下载。

| 游戏 | 地址 | 说明 |
| --- | --- | --- |
| 大炮轰小鬼 / 刀马 / Shell Gambit | `/games/<slug>/` | 平台游戏，规则引擎在服务器，房间走 `rooms.mjs` |
| 地平线赛车 | `/games/horizon/` | 上游 3D 世界原样跑在浏览器；平台房间层 + `/horizon-relay` 车位置；手机 `/play/horizon` |
| 原版无名杀（三国杀） | `/noname/` | GPL-3.0 上游**原样静态托管**；源码不进 git（`node tools/noname-update.mjs` 拉取） |
| 狼人杀 | `/werewolf/` | 界面来自 wolfcha-custom（MIT），规则引擎是本仓库重写的 ESM |
| 斗地主 | `/ddz/` | 牌桌是上游 Godot 网页导出（iframe wasm），规则在服务器 |
| 大富翁 | `/games/monopoly/` | 整份上游 Web 客户端静态托管 + `/monopoly-relay` WS 中转 |
| 莲花广麻 | `/mahjong/` | 上游 Vue3 页面 + FastAPI/Python 规则后端，Node 只反代 |
| AI 小镇 | `/ai-town/` | 上游 Rust 世界内核/manager 跑子进程；Node 管账号/房间/存档/反代；房主+客人各有化身；手机只留背包键可自定义 |

手机端另有五个伪横屏外壳：`/play/noname`、`/play/ddz`、`/play/monopoly`、`/play/mahjong`、`/play/horizon`。

| 路径 | 是什么 |
| --- | --- |
| `server/` | 唯一进程：HTTP + 手写 WebSocket + 账号/好友/房间 + 各游戏接入层 |
| `shared/` | 前后端共用：`protocol.mjs`、`net/net.js`（唯一网络层）、`ui/*`（房间外壳、全屏、UI） |
| `games/<slug>/` | 三个平台小游戏 + `horizon/` / `ddz/` / `monopoly/` / `mahjong/` / `werewolf/` / `ai-town/` 的文件 |
| `web/` | 平台外壳（登录 / 游戏列表 / 好友 / 设置）+ 五个伪横屏外壳 + `ai-town-bridge.js` |
| `tools/` | `service.mjs`（开关服务）、`check-noname.mjs`、`noname-update.mjs`、`check-tunnel.mjs`、`cdp.mjs`（无头浏览器） |
| `tests/` | 平台级测试（`*.test.mjs` Node 集成 + `*.browser.mjs` 真 Chrome） |
| `data/` | SQLite + 日志 + 头像，**gitignored，绝不提交** |
| `docs/` | 决策 / 架构 / 游戏说明 / 隧道 / 当前待办 |

## 硬约束（没有用户新的明确要求，不要动）

**部署**

- 服务端**只监听 `127.0.0.1:7891` 的明文 HTTP**。TLS 由隧道终止（面板开「自动 HTTPS」）。
  ⛔ 国内节点会拦明文 HTTP（回它自己的 501 页，字节根本不到本机）——
  **解法是在面板开「自动 HTTPS」，不是给服务端加 TLS**。
- **7891 与隧道配置成对**：改端口必须同时改面板隧道，只改一边必坏；公网地址**不许写进代码**。
  仓库里 `frpc/*.ini.example` 只是归档模板，改了不影响线上。
- **不要自动重启 / 改 SakuraFrp 服务或隧道参数**（用户手动管理）。

**技术选型**

- **零第三方运行时依赖**（没有 `node_modules`）。WebSocket 服务端是手写的（`server/ws.mjs`）——
  想引入 `ws` 之类的包**必须先问用户**。存储只用 `node:sqlite`。
- 加协议消息要**同时**改三处：`shared/protocol.mjs` 的 `T`、`docs/ARCHITECTURE.md` 的表格、
  `server/hub.mjs` 的 `dispatch`。

**架构铁律**

- **规则引擎在服务器进程里**：`games/*/js/engine/**`、`games/*/js/ai/**` 里
  `document` / `window` 命中数必须是 **0**。
  **例外是大富翁**：整份上游 Web 客户端，规则在房主浏览器 Worker 里（D41）。
  **另一个例外是莲花广麻**：规则在上游自己的 **Python 子进程**里（`127.0.0.1:8123`），
  Node 只做 `/mahjong/api` `/mahjong/ws` 反代 + 身份注入（D43）。
  **AI 小镇同理**：世界模拟在上游 **Rust `town-host` 子进程**里，Node 只做 manager/房间/反代（D48）。
- **客户端只拿按人裁剪过的视图**（`viewFor`）。隐藏信息（牌堆、对手手牌、未揭晓的拳…）
  **绝不能进任何报文** —— 这是唯一的防作弊手段。
- **`rooms.mjs` 不认识任何具体游戏**（只认 `meta` / `createMatch`）；加新游戏不要改它。
- 依赖单向：`games/* → shared/*`，`web/* → shared/*`；游戏之间绝不互相 import。
- **不做聊天**（用户明确要求，任何形式）。唯一例外：狼人杀的**狼队夜间频道**
  （消息 `scope:'wolf'`，只在夜里、只发给存活狼）—— 那是游戏规则，不是聊天入口（D50）。

**入口交互（2026-11 用户拍板）**

- 平台首页**所有游戏统一新窗口打开**（`window.open(url, '_blank', 'noopener')`）：
  首页卡片、好友「进入」、邀请「接受」都一样。⛔ 不要改回本页跳转。
- 手机端**每个游戏都必须有可选全屏，且不许强制**；电脑端不显示：
  入口页加 `<script defer src="/shared/ui/fullscreen.js"></script>`（上游页面由
  `server/http.mjs` 注入；`/play/*` 外壳负责，iframe 内层脚本会自己跳过）。
  **进了全屏按钮会整个隐藏**（手机用返回键退出），不要再显示「退出全屏」。
  五个伪横屏外壳的 `<body data-frp-fullscreen="landscape">` 让点全屏时
  `screen.orientation.lock('landscape')`，像大富翁一样进真横屏（地平线是第五个）。
  ⛔ 不要在游戏代码里自动 `requestFullscreen()`，也不要自己再写一套全屏按钮。
- **音频防下载器**：入口页加 `<script defer src="/shared/ui/no-idm.js"></script>`
  （上游页面由 `server/http.mjs` 注入）。它把同源音频 URL 去掉 `.mp3/.ogg/.wav` 扩展名，
  服务器再按无扩展名映射回真实文件。⛔ 不要把带媒体扩展名的音频 URL 直接写进页面；
  **以后的新游戏也要接这一行**（D45）。

## 改了什么 → 必跑什么

只认实测，不写"应该可以"。

| 改动 | 必跑 |
| --- | --- |
| 任何改动收尾 | `npm test`（185 条集成：184 通过 + 1 条默认跳过的真模型用例，约 25 秒；`--test-concurrency=2` 是钉死的） |
| `server/ws.mjs` | `npm test` + `npm run test:browser`（只有真浏览器能证明帧格式对） |
| `shared/net/net.js` | `npm test`（9 秒建连 / 2.5 秒竞速 / 心跳 / 自动重连，**这几个数不许动**） |
| 登录 / 注册流程 | `npm run test:login` |
| 房间层 / 好友 / 平台外壳 / `shared/ui/*` | `npm run test:room` + `npm run test:browser` |
| `web/`、`shared/ui/**` 的界面 | `npm run test:browser`（实测横向溢出 / 点击区 ≥44px / 元素跑出屏幕） |
| 加或改游戏 | 该游戏自己的 `tests/*.test.mjs` + `tests/browser*.mjs`，再加 `npm test` |
| 狼人杀 | `npm run test:werewolf`（改前端要 `pnpm build` 并覆盖 `games/werewolf/dist/`） |
| 斗地主 | `npm run test:ddz`（改 `godot/` 必须重新导出 `games/ddz/table/`） |
| 大富翁 | `npm run test:monopoly`（改 UI 必须 `pnpm build:web` 并覆盖 `games/monopoly/web/`） |
| 莲花广麻 | `npm run test:mahjong`（改前端必须 `npm run build` 覆盖 `games/mahjong/web/`；改后端重装 `.venv`） |
| AI 小镇 | `npm run test:ai-town`（真 manager/host/WS；改 Rust 要重编 bin；改前端要 pnpm build 覆盖 `games/ai-town/web/`） |
| `server/http.mjs` / 无名杀托管 | `node tools/check-noname.mjs` |
| 公网通道 | `node tools/check-tunnel.mjs <公网地址> --ws 30`（唯一硬证据是 `data/server.log` 的 `[来访]`） |

- 开关服务：`node tools/service.mjs start|stop|status|restart`（= 同名 `.cmd`）。
- ⚠️ 体检/测试自己起临时服务（随机端口），但实测常连真实 **7891** —— 别和别人同时抢。
- 公网结论只认实测：`Test-NetConnection` 只证明端口开着；面板显示"在线"不算证据。
- `dist/` 改动后用户浏览器最多 **10 分钟**还在用旧文件（`max-age=600`）——要提醒强刷。

## 加游戏 / 改游戏

平台**不再提供"游戏开发规范"脚本与文档**：新游戏默认**缝合成熟的上游项目**（像无名杀那样）。

- 先读 `docs/ARCHITECTURE.md` 的「游戏模块接口（服务器权威）」，再照现有平台游戏抄接线。
  各游戏自己的坑先看该目录的 `README.md` / `AGENTS.md`，再看 `docs/GAMES.md`。
- 原文件夹**只读**，不要改动。原项目的公共 broker / WebRTC / ntfy / 信令一律删除（D1）。
- 缝上游优先**静态托管 + 注入桥接脚本**；能不动上游产物就不动。
- 主流程细节与"当年为什么这么改"在 `docs/DECISIONS.md`（D1–D52）与 `docs/HISTORY.md`，
  **只在查具体问题时按编号/标题跳**。

## 记录习惯

设计决定 → `docs/DECISIONS.md`（含"为什么"和"被否掉的选项"）；
架构与协议 → `docs/ARCHITECTURE.md`；游戏各自的坑 → `docs/GAMES.md`；
隧道排查 → `docs/TUNNEL.md`；未决问题 → `docs/NEXT.md`（解决后删掉该条）。
历史轮次只追加到 `docs/HISTORY.md`，**不要再往 `NEXT.md` 里堆过程**。

## 文档地图（按需查，别通读）

| 想知道 | 看 |
| --- | --- |
| **文档总索引**（先看这一页） | `docs/README.md` |
| 现在做到哪了 / 下一步 / 要用户拍板的事 | `docs/NEXT.md` |
| 协议、房间层、网络层、路由、各游戏接入方式 | `docs/ARCHITECTURE.md` |
| 某个设计为什么这样（D1–D52） | `docs/DECISIONS.md`（文首有一览表） |
| 已被取代的旧决定的正文 | `docs/archive/DECISIONS-superseded.md` |
| 各游戏与无名杀的坑 | `docs/GAMES.md` |
| 公网/隧道排障 | `docs/TUNNEL.md` |
| 某件事当年是怎么修过来的 | `docs/HISTORY.md`（**别通读**，文首有目录） |
| 部署到另一台电脑（给 AI 的步骤） | `DEPLOY.md` |

## 和接手的 agent 说的话

- 任何"我以为"都要能在文档里找到出处；找不到就是文档缺了一条 —— **补上它**。
- 用户**不是程序员**：结论用大白话讲，给选项时给**推荐项 + 代价**。
- 每次交付说清"**用户看到什么变化**"，以及**他需要做什么**（强刷、面板点一下…）。
