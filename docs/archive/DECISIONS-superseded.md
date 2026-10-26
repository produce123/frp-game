# 已被取代的设计决定（归档）

> 这些决定**当时**是对的，后来被新的决定取代了。正文留在这里，好让 `docs/DECISIONS.md`
> 只放『现在还成立』的东西；编号、标题、被谁取代仍然在 `docs/DECISIONS.md` 的一览表和原位那一段里。
>
> ⚠️ 读的时候记住：**它们不是现行做法**。要看现在的做法，按取代它的那个编号去看。

## D3 隧道用新增一条 HTTP 隧道，不是改造现有 TCP 隧道（⛔ 2026-10-21 已被 D15 取代）

> 下面这条当时是对的（也真的通了），但**Cloudflare 免费版把大陆访客甩到洛杉矶**，
> 慢且 503/522 —— 2026-10-21 换成了国内 TCP + frpc 自动 HTTPS。**看 D15，别照本条做。**
> 保留它是因为里面的几条硬约束（备案 / HSTS / SSL 模式匹配 / 免费版回源端口）现在依然成立。

**决定**：保留现有 TCP 隧道不动，另外建一条 HTTP 隧道指到 `localhost:7891`，
Cloudflare 的 SSL/TLS 模式设成「灵活」。

**为什么**（都是从官方文档和实测推出来的硬约束）：
- Cloudflare 免费版**不能**回源到自定义端口，所以 TCP 隧道那种
  `<节点域名>:<端口>` 的带端口地址套不上小黄云。
- HTTP 隧道挂在内地节点上要求域名有 ICP 备案，`<你的域名>` 没有 → 必须选**非内地节点**。
- 免费送的 `nyat.app` 子域名带 HSTS Preloading，不带 HTTPS 用不了 → 不能用。
- 隧道类型和 CF 的 SSL 模式必须匹配，否则 **503**：HTTP 隧道 ↔ 「灵活」，HTTPS 隧道 ↔ 「完全」。

细节和排查表在 `docs/TUNNEL.md`。

## D29 无名杀的账号与存档**完全隔离**，服务端只做托管（⛔ 2026-10-23 已被 D33 取代）

> **这条已经不是现在的做法了，只留作历史。** 现在 `/noname/` 必须登录平台，
> 昵称/头像/好友都走平台账号 —— 见 **D33**。
>
> 当时否掉"接账号"的理由是"等于要在无名杀里塞平台协议，上游一更新就崩"。
> 后来发现不用改上游：**注入一层桥接脚本**（`web/noname-bridge.js`）就能在运行时
> 读 `/api/me`、写 `lib.config.connect_nickname/connect_avatar`，上游产物一个字节都不用改。
> 所以这条的前提不成立了。

## D34 狼人杀：搬后端 + 重建前端，记录进数据库（**已被 D37 取代**）

**决定**：把上游 `xiong35/werewolf`（MIT，Vue 3 + Koa + socket.io）缝合进本平台：

1. **后端搬进本进程**：`games/werewolf/backend/src/**` 留在树里（TypeScript），
   `tsc` 编译到 `games/werewolf/server-dist/`（CommonJS + 一份 `{"type":"commonjs"}` 的
   `package.json`），`server/werewolf/index.mjs` 用 `createRequire` 加载。
   **不另起进程、不另开端口**。
2. **砍掉 Koa 和 socket.io**：Koa → `index.ts` 里一张 10 条路由表 + 一个最小 `ctx`；
   socket.io → `bus.ts` + 平台 WS 的 `T.WW_EVENT`。所以不需要 `koa` / `koa-router` /
   `socket.io` / `socket.io-client` 任何运行时依赖，D6（零第三方运行时依赖）仍然成立。
3. **前端按源码重建**：`games/werewolf/frontend/` 是上游前端的改造版（去 socket.io、
   去 localStorage 身份、去 sha256、去二维码、加好友邀请与对局记录），`vite build` 到
   `games/werewolf/dist/`（**提交进仓库**，约 200 KB）。页面挂在 `/werewolf/`，登录门同 `/noname/`。
4. **身份 = 平台账号**：`Player._id` 直接是 `user.id`；客户端发来的 `player-id` /
   `room-number` 两个头一律不采信（前者取自会话，后者取自房间表）。
5. **对局记录进数据库**：新增两张**通用**表
   `game_records(id, game, room_code, winner, started_at, ended_at, detail)` 和
   `game_record_players(record_id, user_id, seat, name, character, alive)`。
   结算时核心调 `hooks.onGameEnd` 写库，复盘只读数据库、**只对参与者开放**（里面有全员身份）。
   表名不带 `werewolf` 前缀 —— 下一个需要"打完能回看"的游戏（比如三国杀 PVE）直接复用。
6. **不做中途加入、不做观战**（用户拍板）：开局即锁房，好友列表显示"已开局"且不可点。
7. **密码只挡陌生人**：房里有一个我的好友就免密（房号会通过链接、截图流出去，密码只防那个）。

**为什么**：

- 6 角色 / 18 阶段的状态机是上游最值钱的东西，重写等于重做一个游戏；
- 平台已经有一整套账号、好友、邀请、在线状态 —— 让狼人杀自己再维护一套必然对不上
  （无名杀当年就是两套在线状态打架）；
- 用户要的是"我列表里的账号就是狼人杀里的账号"，这只有让**服务端认会话**才能做到；
- 对局记录只有落在服务器上才能跨设备、换浏览器还在（上游存 localStorage，清一次缓存就没了）。

**被否掉的选项**：

- **保留 Koa + socket.io，反代一个额外端口**：多一条 HTTP 端口、第二条 WebSocket、
  两套在线状态、两个进程一起管；而且 socket.io 是运行时依赖。
- **像无名杀那样整包静态托管它的 `dist`**：上游前端写死了自己的域名和 socket.io 路径、
  身份存 localStorage、没有"好友邀请"，宿主层改不动 —— 只能重建。
- **前端也用 iframe + 注入桥接**：狼人杀几乎每个交互都带身份（进房、操作、拉状态），
  注入层要同时拦 axios 和 socket.io，比直接改源码更容易坏。
- **每个游戏自己建一张记录表**：下个游戏又要重写一遍增删查；通用两张表 + `game` 字段更省。
- **让狼人杀房间走平台 `rooms.mjs`**：房号语义（6 位数字 vs 字母码）、成员模型、
  状态机（阶段 / 倒计时 / 结算）完全不同，硬接等于重写上游。

**代价（记住）**：

- **前端产物要提交**（`games/werewolf/dist/`）：平台不需要 `node_modules` 就能跑；
  代价是改前端必须真的重新 `npm install && npm run build`，忘了重建就等于没改。
- **`server-dist/` 也要提交**（且要带那份 `{"type":"commonjs"}`，`tsc` 不生成它）：
  改后端必须重新 `tsc`。
- **改上游只能手工重打**（37 个后端文件 + 整个前端的边界层），不像无名杀有
  `noname-update.mjs` 自动打补丁。清单在 `games/werewolf/README.md`。
- **12 小时清扫之后房间就没了**：一局没打完最多留 12 小时（上游行为）。

**回归防线**：`npm test` 的「狼人杀 · …」六节（15 条：登录门、伪造头、重连回原座位、满员、
开局锁房、好友免密、`WW_EVENT` 信号、邀请与回执、结算写库与复盘权限、状态机推进）
+ `node tests/werewolf.browser.mjs`（真 Chrome：登录门、平台昵称头像、建房、邀请卡片、
手机宽度不溢出、平台首页卡片可点）。

## D35 斗地主：用上游的玩法，重写规则与页面（⛔ 已被 D40 取代）

**决定**：把上游 `tinyshu/ddz_game`（斗地主，无 LICENSE）缝进平台，但**只借玩法**：

1. **规则与状态机重写**在 `games/ddz/js/engine/**`（纯 ESM、零宿主 API）：
   `cards.js`（54 张编码/洗牌/排序）、`rules.js`（`classify` + `canBeat`，**服务器和浏览器
   import 同一份**）、`game.js`（发牌 → 叫分 1/2/3 → 出牌 → 结算，`viewFor` 在这里裁剪）。
   服务器侧只多一个 `server/games/ddz.mjs` 接入层（`meta` / `createMatch`）。
2. **房间走平台房间层**：`meta = { minPlayers: 3, minSeats: 3, maxPlayers: 3,
   maxBots: 0, allowMidJoin: false }`。房号是平台 **6 位字母码**，所以**不碰**上游的数字房号、
   也不需要 `hub.mjs` 分支（更不存在"数字房号过 `normalizeCode`"那个坑）。
3. **页面重写**在 `games/ddz/`（HTML + CSS + ESM）：挂在顶级地址 `/ddz/`，服务端登录门
   （未登录 302 `/?return=…`），页面里**没有昵称输入框**，名字/头像/ID 全来自平台账号；
   房间外壳、邀请、成员、开始/再来一局全用 `shared/ui/room.js`。竖屏优先（375px 不横向溢出），
   **不做** `/play/ddz` 伪横屏外壳（斗地主本来就是竖屏游戏）。
4. **不做人机**（用户拍板）：上游也没有 AI。新增通用字段 `meta.maxBots = 0`：
   准备区不画「＋ 添加人机」、`botAdd()` 直接拒、"座位不够"的提示语改成"把房间号发给朋友"。
   三个人必须都是真人。
5. **不存战绩**（用户拍板本轮先不做）：`game_records` / `game_record_players` 保持不动，
   以后要存直接复用（`game='ddz'`）。
6. **不做**：中途加入 / 观战（`allowMidJoin: false`，座位就是三个）、倒计时、金币赌注、
   聊天、本地单机模式、上游的 Cocos 客户端与 MySQL 服务端。

**为什么**（不是"想重写"，是上游那两份真的用不了）：

- **客户端是 Cocos Creator 2.x 编辑器工程**：`.fire` 场景 + `cc.Class` + Canvas。仓库里
  **没有任何构建产物**（无 `build/`、无 Release、无 gh-pages），本机也没有 Cocos Creator ——
  不能像无名杀那样"静态托管 dist"，而且 Canvas 里没有 DOM，**注入不了平台昵称/头像**，
  好友邀请、房间号、平台账号这一整层都没地方挂。
- **服务端是 2019 年的半成品**：`socket.io@2` + `mysql` + 独立 3000 端口（运行时依赖、多一个端口、
  第二套账号），`app.js` 里连库、`game/room.js` **没有回合校验**（谁都能随时出牌）、
  `gameScene.js` 的 `gameEnd(){}` 是空的（**没有胜负判定**）、`todo.txt` 自己写着叫分流没做完。
- **比较逻辑是坏的**：`game/carder.js` 用 `last_cards.value` 取数组的 `.value`（`undefined`）、
  用未定义的 `a[i]`，而且牌型判定默认客户端已按特定顺序排好牌 —— 上游 issue 里
  "3 个 3 变成 3 个 A"、"牌型比较问题"正是这两类。照抄等于把 bug 抄进来。
- **没有 LICENSE**（GitHub `license: null`；`ddz_server_node/package.json` 里的 `ISC` 是 npm
  默认值，不是授权声明）→ 默认"保留所有权利"。自己家里玩没问题，**不公开分发、不商用**，
  也不复制它的美术/音频素材（牌面是 CSS 画的）。按用户要求 fork 了一份留档：
  `https://github.com/produce123/ddz_game`（只是复刻记录，代码没有从它拷进本仓库）。

**被否掉的选项**：

- **静态托管上游客户端**：仓库里没有构建产物；要先用 Cocos Creator GUI 打开 41 MB 工程
  手动 build，产物还没有平台账号、邀请、房间号的位置（Canvas，无 DOM 可注入）。
- **装 Cocos Creator 重建它的前端**：为了一个页面引入一个数 GB 的 GUI 编辑器 + 一套
  资源管线，而且 1280×720 `fit-height` 的横屏设计在手机上要另做一套布局，收益为负。
- **保留它的 Node + socket.io + MySQL 服务端，反代一个额外端口**：违背 D6（零第三方运行时
  依赖），多一条端口/进程/数据库和**第二套账号**（好友、邀请、在线状态必然对不上，
  无名杀当年两套在线状态打架就是前车之鉴）。
- **让它的数字房号走平台 `hub.mjs` 分支**（需求里问的那条）：只有"房号沿用上游"时才需要；
  现在房号由平台房间层发（6 位字母码），这条分支根本不存在，也就没有"数字被 `normalizeCode`
  改写"的风险。
- **做 AI 填座位**：用户明确否掉；上游也没有任何 AI 代码可借。没有 AI 的另一个后果是
  有人离开时**本局只能作废**（见下）。
- **本轮就存战绩**：能复用通用两张表，但用户说先不存；不做就少一次"记录里带别人手牌"的风险。

**代价（记住）**：

- **规则是自己写的**，所以牌型覆盖以 `rules.js` 为准：**没有四带二？有**（`four_two` /
  `four_two_pair` 都支持）；但**没有**春天/明牌/加倍/癞子/二人斗地主/比赛分。
- **没有 AI**：一个人开不了局（`minSeats = 3`，且不能加人机）。三个人必须真人同时在线。
- **有人离开 = 本局作废**（`removePlayer` 直接判 `phase: over` + `aborted` 原因）：
  没有 AI 接管手牌，硬撑只会让剩下两个人干等 120 秒掉线宽限。房主可以「再来一局」。
- **没有倒计时**：真人可能想很久；这一版不加超时托管（加了也需要 AI 出牌）。
- **不存战绩**：打完就没了；想复盘/攒数据要另开一轮（复用 `game_records`）。
- **上游没有 LICENSE**：不公开分发、不商用；fork 只作记录。
- **页面是新的**：以后上游更新跟这次缝的东西没关系（只借了玩法），不需要"更新上游"脚本。

**回归防线**：`npm run test:ddz` = `games/ddz/tests/engine.test.mjs`（27 条：牌型/比大小/
状态机/视图裁剪/引擎里不许出现宿主 API）+ `tests/ddz.test.mjs`（12 条：登录门、唯一地址、
服务端自动接载、三人座位、`maxBots = 0`、整局打完、有人离开作废、回合判定）
+ `tests/ddz.browser.mjs`（真 Chrome：登录门、平台昵称头像、**没有昵称输入框**、首页卡片、
好友"正在玩 斗地主"+「进入」直接坐进房、三人开局、叫地主、出牌、375px 不横向溢出、无 JS 报错）。
`npm test` 与 `npm run test:browser` 都已把这几条包含进去。

## D36 大富翁：界面搬上游，规则重写成服务器权威引擎

**决定**：把上游 `intrepidcoder/monopoly`（MIT）缝进平台，**"长相"用上游的，"规则"用自己的**：

1. **页面搬上游**（用户明确要求："别给我自己写"）：`games/monopoly/index.html` 以上游
   `upstream/index.html` 为底稿 —— 40 格 `<table id="board">`（`#cell0` … `#cell39` 都在 HTML 里）、
   地契卡 `#deed`、状态窗 `#stats`、弹窗 `#popup`、事件流水 `#alert`、"落在…"`#landed`、
   钱条 `#p1moneybar`… 这些**上游原有 id 一个不改**；`css/style.css` = 上游 `styles.css` **整份**
   （87 个选择器一个不缺）+ 末尾一段「平台接线」追加样式；骰子/房屋/旅馆/图标用上游 `upstream/images/`。
   上游 `monopoly.js` 里的 DOM 渲染函数（`updatePosition` 摆棋子、`updateMoney` 钱条、地契卡填充、
   房屋/抵押标记、`addAlert`、`popup`、拍卖表、交易表）**照着移植**，只把 jQuery 换成原生。
2. **规则重写**在 `games/monopoly/js/engine/rules.js`（1927 行，纯 ESM，只 import `board.js`；
   服务器与热座浏览器 import **同一份**）。棋盘数据中文意译（40 格 + 32 张机会/命运卡）在 `board.js`。
3. **房间走平台房间层**：`meta = { minPlayers: 1, minSeats: 2, maxPlayers: 6, allowMidJoin: false }`。
   **1 个真人 + 人机**能开局（人机是座位不是补位，见 D9），也能 2–6 个真人。初始资金 1000/1500/2000。
4. **两种玩法**：联机（服务器权威，客户端只拿 `viewFor` 裁剪过的视图）+ **同屏热座**
   （一台设备轮流，引擎跑在浏览器里）。手机走 `/play/monopoly` 伪横屏外壳（D32 那套）。
5. **服务器接入层** `server/games/monopoly.mjs`：座位 → `createGame`、`room.act` → `match.act`，
   同一次 act 里把**人机回合也算完**（`while (currentPlayer 是人机) botAct → act`），
   掉线/退出调 `forfeit`（房产回银行、不进拍卖）后判胜。
6. **中文、不做聊天、不存战绩**（本轮）。

**为什么不能像无名杀那样"静态托管 + 注入桥接"**：

- 上游**没有任何联机代码**（纯本地 jQuery 单体），状态全在浏览器全局 `player[]` / `square[]` 里。
  要让"服务器权威"，注入层得同时接管**每一处渲染**和**整条回合流程**，实际上等于重写；
  而重写渲染又会丢掉用户要的上游长相 —— 所以拆成"搬页面 + 重写规则"两半，各取所长。
- 上游 `monopoly.js` 里规则与 DOM 搅在一起（`takeTurn` 里直接弹窗、弹窗回调里直接改钱），
  **零第三方依赖**（D6）又禁止带 jQuery。保留 jQuery 就等于为一个游戏破一条平台铁律。

**被否掉的选项**：

- **整页静态托管上游 + 桥接注入**：规则在浏览器 → 谁都能改钱（无服务器权威 = 好友房没意义）。
- **保留 jQuery 只加一层联机**：违反 D6（零第三方运行时依赖），且 140 处 `$()` 与规则纠缠。
- **自己画一套界面**（第一版就是这么干的，已被用户否掉）：用户要的是上游那张棋盘。
- **照搬上游 8 人**：棋盘只有 6 种颜色，6 座封顶；上游 7/8 号钱条与开局设置页（`player1..8`）
  不搬（豁免清单在 `games/monopoly/AGENTS.md`）。
- **搬到 `games/werewolf` 那种"重建前端"路线**：那套是给"必须有自己前端"准备的；这里用户要上游页面。

**代价（记住）**：

- 上游是 2016 年的**桌面固定 px 布局**，手机上靠伪横屏外壳铺满 + 少量响应式补丁，不是原生移动体验。
- 渲染函数是**移植**不是原样跑：jQuery → 原生改写，行为以"看起来和上游一样"为准，不保证逐像素。
- 规则以 `RULES-SPEC.md` 为准（完整原版：买地/拍卖/盖房/抵押/交易/卡牌/监狱/欠款破产/判胜），
  上游那句"AI 仅供演示"我们不用：人机是 `js/ai/ai.js`（只读 view + legal）。

**回归防线**：`npm run test:monopoly` =
`games/monopoly/tests/engine.test.mjs`（101 条：回合/双骰/租金/盖房/抵押/拍卖/交易/卡牌/监狱/
欠款破产/判胜/视图裁剪/零宿主 API）+ `tests/monopoly.test.mjs`（15 条：登录门、唯一地址、
座位与人机、服务器权威、掷骰买地、好友邀请进房、掉线判胜、接入层契约）+
`tests/monopoly.browser.mjs`（真 Chrome：上游 40 格、地契卡、身份行、邀请进房、390×844 无横向溢出）。
`npm test` 已自动包含 `tests/monopoly.test.mjs`。
