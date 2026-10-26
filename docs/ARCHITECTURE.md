# 架构

## 全景

```
                     ┌─────────────── 你的 Windows 电脑 ───────────────┐
   浏览器             │                                                │
     │               │  frpc ──┬──► 127.0.0.1:7891 ──► server/server.mjs│
     │  HTTPS        │         │                        │             │
     ▼  (TLS)        │         │  脱壳：TLS 进来，        ├─ http.mjs  静态 + JSON API
SakuraFrp 国内节点 ───┼─────────┘  明文 HTTP 出去         ├─ ws.mjs    WebSocket（手写）
 (TCP 隧道 :<端口>)   │                                  ├─ hub.mjs   在线状态 / 好友 / 邀请
                     │                                  ├─ rooms.mjs 房间注册表
                     │                                  ├─ auth.mjs  注册 / 登录 / 会话
                     │                                  ├─ store.mjs SQLite
                     │                                  ├─ games/    平台游戏的服务器权威逻辑（斗地主、地平线的一局生命周期等；大富翁不在此列）
                     │                                  ├─ horizon/  地平线赛车的车位置中继（/horizon-relay）
                     │                                  └─ werewolf/ 狼人杀接入层（规则在 games/werewolf）
                     └────────────────────────────────────────────────┘
```

**关键不变量**：服务端**永远只监听 `127.0.0.1:7891` 的明文 HTTP**。
TLS 由 **frpc** 负责 —— 隧道开「自动 HTTPS」之后，frpc 用 TLS 对外收连接、
**脱壳**成明文 HTTP 再发给 7891（细节见 `docs/TUNNEL.md` 坑五）。
所以**换隧道类型、换域名、换节点、开关自动 HTTPS 都不需要改代码**，本项目也不碰证书
（证书是 frpc 读的）。
客户端同理：`shared/net/net.js` 按页面协议自动选 `ws://` / `wss://`。

**唯一例外是莲花广麻的规则进程**：Node 会起一个 Python 子进程（`127.0.0.1:8123`），
页面通过 7891 的 `/mahjong/api` 与 `/mahjong/ws` 反代进去；公网仍然只有 7891（D43）。

进程的开关由 `tools/service.mjs` 管（`start.cmd` / `stop.cmd` / `status.cmd` 是它的快捷方式），
登录自启见 `docs/DECISIONS.md` D7。

## 一条连接干所有事

玩家整个会话的主通道是**一条 WebSocket**（`/ws`），承载：

- 身份与在线状态（上下线时把**整份好友列表**推给相关的人）
- 好友的增删与实时状态（含"他正在玩什么、还能不能进去"）
- 房间的创建/加入/离开/重开
- 游戏操作意图的下行与视图的上行
- 好友邀请

**主通道没有轮询、没有第二条信令通道。** 两个例外是游戏自己的中转：
大富翁的 `/monopoly-relay`（PeerJS 兼容）和地平线的 `/horizon-relay`（12.5Hz 车位置）；
它们和 `/ws` 共用 7891，但**不承载账号/好友/房间**，也不改变"平台只有一条主 WS"的模型。

## 认证：HttpOnly Cookie，不走 JS

登录成功后服务端 `Set-Cookie: sid=<随机>; HttpOnly; SameSite=Lax; Path=/`。

- JS 拿不到这个 cookie（`HttpOnly`），所以**不存在"从 JS 里偷 token"这条路**。
- WebSocket 握手**自动带同源 cookie**，所以 `/ws` 在 `upgrade` 阶段就能确定"你是谁"，
  不需要任何 `hello`/`auth` 首帧，也不需要把 token 拼进 URL（拼接会进日志，是常见泄露点）。

### 身份"先记住、再对齐"（`GameNet.cachedMe`）

平台首页和每个游戏页是**两个不同的网页**，点进游戏是一次整页跳转；游戏页原来只能等
WebSocket 的 `ready`，公网那次握手实测要 **2~3 秒**（决定见 `docs/DECISIONS.md` D13）。
所以：谁先拿到身份（平台外壳的 `/api/me`、`ready`）就顺手记进 `localStorage` 的 `frp.me`，
游戏页先用 `GameNet.cachedMe()` 把名字/ID 画出来，`ready` 到了再对齐。

⛔ **红线**：缓存**只用于显示**。不许拿它填 `GameNet.me`、也不许拿它判断登录态 ——
登录态永远由服务端说了算（`tests/login-race.browser.mjs` 钉着"迟到的 401 不许把界面翻回登录页"）。
401 / 身份对不上时 `GameNet.forgetMe()` 清掉；登出也要清（否则下一个人会先看到上一个人的名字）。

## 消息协议（JSON 文本帧）

统一信封：`{ "t": "<类型>", ... }`。类型常量定义在 `shared/protocol.mjs`，**前后端同一份**。

### 客户端 → 服务端

| `t` | 附加字段 | 说明 |
| --- | --- | --- |
| `room.create` | `game`, `options?` | 建房，成为房主 |
| `room.join` | `code` | 按 6 位房间号进房 |
| `room.leave` | — | 离开房间 |
| `room.act` | `act` | 游戏操作意图（内容由各游戏定义） |
| `room.start` | `options?` | 房主开局，`options` 是准备界面里选的设置 |
| `room.reset` | — | **房主**把已结束的房间放回等待态（"再来一局"），成员保留 |
| `room.bot.add` | — | **房主**在准备区按一下加**一个人机**（它坐在座位上，占一个座位） |
| `room.bot.remove` | `id` | **房主**撤掉一个人机（`id` 是 `bot:N`） |
| `react.send` | `to`, `kind` | 对同一间房里的某个人扔`egg`/送`flower`（见下面的「互动」一节） |
| `ping` | `ts` | 应用层保活（浏览器发不出协议层的 ping，见下面的「网络层」一节） |
| `friend.add` | `id` | 发一条好友申请（**不是**立刻成为好友）；对方已经申请过你时**直接互相成为好友** |
| `friend.accept` | `id` | 同意发给我的一条申请（`id` = 申请人） |
| `friend.decline` | `id` | 拒绝发给我的一条申请（`id` = 申请人） |
| `friend.cancel` | `id` | 撤回我自己发出去的一条申请（`id` = 收件人） |
| `friend.remove` | `id` | 删好友（双向的，立刻生效） |
| `invite.send` | `to: [id…]`, `code` | **一键批量邀请**在线好友进当前房间（人在狼人杀房里也走这条，见下面的「狼人杀」一节） |
| `invite.reply` | `from`, `code`, `accept`, `game?` | 回应邀请；`game:'noname'` 时只转发回执、**不进平台房间层**（房号格式不同）；`game:'werewolf'` 同样只转发；`game:'monopoly'` 也只转发回执，客户端跳 `/games/monopoly/?join=房号`（房间号最多 12 字符，不走 6 位平台码）。其余平台游戏（`ddz` / 三个小游戏）**走平台房间层** |

### 服务端 → 客户端

| `t` | 附加字段 | 说明 |
| --- | --- | --- |
| `ready` | `me:{id,name,avatar}` | 连接就绪，带上自己的身份（`avatar` 是 `/avatar/<id>?v=…`，没上传也有默认 SVG） |
| `friends` | `list:[{id,name,avatar,online,playing}]`, `incoming:[{id,name,avatar}]`, `outgoing:[{id,name,avatar}]` | 好友**全量**快照（增删改、申请、上下线后重发整份） |
| `room.state` | `code`, `game`, `hostId`, `members`, `phase`, `view`, `minPlayers`, `minSeats`, `maxSeats`, `maxBots` | **按人裁剪过的**房间视图；`members[].avatar` 是显示用图片地址（人机为 `''`）。`maxBots: 0` = 这个游戏没有电脑（不画「添加人机」），`null` = 不限 |
| `react` | `from:{id,name,avatar}`, `to`, `kind`, `rid` | 房里有人扔了鸡蛋/送了鲜花（**含发起人自己**，见下面） |
| `pong` | `ts` | 保活的回执，`ts` 原样带回（客户端拿它算往返延迟） |
| `invite` | `from:{id,name,avatar}`, `game`, `code` | 收到邀请；`game:'noname'` 时 `code` 是无名杀自己的房号 |
| `werewolf.event` | `code`, `event`, `data` | **狼人杀的房间信号**（见下面的「狼人杀」一节）。`event` 目前只有 `sync`（房间/阶段变了）；`data` **永远是 `null`** |
| `error` | `message` | 操作被拒（附中文原因） |

`playing` 是 `null` 或者 `{game, code, phase, joinable, started?, observe?, mode?, count?}` ——
好友在玩什么、还能不能进去。`joinable` 为真时列表里会出现「进入」按钮；
无名杀那一份还带"开没开局 / 允不允许观战 / 模式 / 人数"。

### 房间状态里的四个数：`minPlayers` / `minSeats` / `maxSeats` / `maxBots`

| 字段 | 含义 |
| --- | --- |
| `minPlayers` | `meta.minPlayers`（游戏自己声明的最少人数）。**只作为 `minSeats` 的兜底**，房间层不再单独拿它当门槛 |
| `minSeats` | `meta.minSeats ?? meta.minPlayers`：**总座位**下限（人机也算座位）。界面靠它决定「开始游戏」亮不亮 |
| `maxSeats` | `meta.maxPlayers`：座位上限 |
| `maxBots` | `meta.maxBots`：这个游戏最多能坐几个**人机**座位。`0` = 没有电脑（斗地主）；`null`/缺省 = 不设上限（其余平台游戏） |

**为什么要三个数**：座位数（真人 + 人机）和真人人数从这一版起是两件事。
用户要的玩法是"按一下加一个人机就坐在座位上"，那么"一个人 + 一个人机"必须能开局 ——
门槛只能落在**座位数**上（见 `docs/DECISIONS.md` D9）。`members[]` 每一项都带 `isBot`
（真人显式 `false`），人机 id 形如 `bot:1`（字母表里没有 `:`，永远撞不上 7 位真人 id）。

**为什么还要 `maxBots`**：斗地主没有电脑（用户拍板，上游也没有 AI），`maxBots: 0` 让
`shared/ui/room.js` 不画「＋ 添加人机」、`server/rooms.mjs` 的 `botAdd()` 直接拒绝、
"座位不够"的提示语也不会骗人去加人机。这个字段是**通用**的，不认识任何具体游戏；
没有它的老游戏照旧不限（`null`）。

### 互动：扔鸡蛋 / 送鲜花

- 服务端只做三件事：**种类认不认识**、**目标在不在同一间房**（真人座位和人机座位都算）、
  **广播给房里每一个人（含发起人）**。
- 发起人也收到自己那条：客户端点下去就**本地播了动画**（互动不是游戏动作，没有权威状态，
  所以这里**保留**"立刻有反应"），靠回执里的 `rid` 认出"这是我的回声"、不播第二遍
  （见下面的「演出队列」）。
- 目标可以是**人机**（它坐在座位上）。
- **刻意没有次数限制**（用户明确要求随便扔）。只有一条技术性防刷：
  `server/rooms.mjs` 的 `REACT_BURST`（2 秒内超过 40 条**静默丢弃**，不是给玩家看的冷却）。
  客户端另有一条同屏特效节点上限（`shared/ui/react.js` 的 `MAX_FX = 20`），
  两条都是为了防止"一个客户端/一台手机把整房拖垮"，正常怎么点都碰不到。
- 客户端实现全在 `shared/ui/react.js`：任何带 `data-frp-avatar="<玩家id>"` 的元素
  **自动可点**（事件代理，SVG 也算），游戏一行互动代码都不用写。

### 网络层：建连竞速 + 应用层心跳（`shared/net/net.js`）

公网实测（见 `docs/TUNNEL.md`）：约 **12%** 的新建 WebSocket 连接会在链路上被**吞掉**，
浏览器要干等到自己 60 秒的握手超时才算失败。用户感受到的是"点了网页一分钟没反应"。
三件事一起兜住它：

| 机制 | 参数 | 作用 |
| --- | --- | --- |
| 建连超时 | `connectTimeoutMs = 9000` | 9 秒还没 open 就放弃这条、走退避重连（0.5/1/2/4/5 秒） |
| **建连竞速** | `raceDelayMs = 2500` | 2.5 秒还没通就**并行再开一条**，谁先 open 用谁、输的那条当场关掉。吞掉是概率事件，两条同时被吞约 1.4% |
| **应用层心跳** | `pingEveryMs = 25000`，`pongGraceMs = 15000` | 浏览器 API 里**没有**协议层 ping，只能用一条普通消息保活；发过 ping 超过 15 秒没有 pong 就判定这条连接已死并重连 |

心跳解决的是另一种更隐蔽的故障：TCP 还开着、对面已经不理（手机切网、隧道掉节点），
界面会一直停在"看起来连着、实际什么都没发生"。三个数都可以在测试里改小
（`tests/net-timeout.test.mjs` 就是这么把 2.5 秒 / 15 秒压成 0.3 秒 / 0.4 秒的）。

### 演出队列 + 演出期间锁输入（**不做本地预演**）

服务端一次 act 里会把 AI 的整个回合同步跑完（见 `docs/DECISIONS.md` D2），
所以一条报文里常常有好几步。两件事配套：

1. **演出队列**（`shared/ui/anim.js`）：`FrpAnim.push(steps, fn)` 把这几步**串行**演完
   （每步 450~700ms），不再一帧全播 —— 这就是"特效一闪而过"的根因。
   **刻意不做"点击跳过"、也不快进**（用户明确要求逐个演完）。
2. **演出期间锁输入**：队列没排空时，`FrpAnim.busy()` 为真，平台同时给 `<body>`
   挂 `frp-anim-busy`。游戏要做的两件事：
   - 发 `room.act` 之前判 `busy()`，为真就当成没点（`ctx.act()` 里平台也兜了一层）；
   - 用自己的 CSS 接 `body.frp-anim-busy`，把动作控件变灰/禁点。
   不锁的话玩家能"一边看动画一边接着操作"（服务端那一帧早就推进过回合了），
   画面和操作错位。

> **绝不在本地改权威状态。** 血量/胜负/回合/牌堆一律等服务端推下来的 `view`。
> 被服务端拒绝时不需要专门的回滚代码：下一次 `room.state` 会把真实视图重新渲染，
> 房间外壳同时弹一条提示条。

⚠️ **"本地预演"已经整段删掉**（曾经做过：点下去先在本机演一遍"起手"，服务端回包再对齐）。
用户实测**快速连点会把画面演成"所有人都被打死了"**，而且预演和回放是两条时间轴、叠起来就是乱。
现在是"服务器说了什么就演什么"。完整教训见 `docs/DECISIONS.md` D10。

互动（扔鸡蛋/鲜花）是**例外**：它没有权威状态，所以发起人那边仍然点下去立刻飞
（靠 `rid` 跳过自己的回声）。

## 在线界面的约定：加好友与房间状态

### 加好友是申请-同意制（决定见 `docs/DECISIONS.md` D8）

- `list` **只**装已经互相接受的好友；`incoming` 是别人发给我、我还没处理的申请；
  `outgoing` 是我发出去、对方还没处理的申请。
- `friend.add` 只是**发一条申请**。只有两种情况下才真的成为好友：
  对方 `friend.accept`，或者**两个人互相申请**（双方各点了一次 `friend.add`）——
  后者是刻意的，否则两边会各自停在"等对方同意"上，谁也不动。
- 成为好友时存储层照旧在 `friends` 表里**双向插两行**，所以 `listFriends` 的语义
  和上层别的代码一行都不用改；删好友也是双向删。
- 申请的任何改动都会给**双方**各推一份完整的 `friends` 快照（申请是双向可见的：
  我发出去的要进我的 `outgoing`、也要进对方的 `incoming`）。只推一边的话，
  另一边会一直挂着一条已经作废的申请。
- 上面四条消息出错时都走 `error`（中文），例如"没有这个 ID""你们已经是好友了""没有这条申请"。

**没有 `friend.state`**：单个好友的上下线不再单独发一条，而是整份 `friends` 重发。
这样客户端只有一个"好友列表"状态，不会出现"某一条没收到导致状态漂移"。

**裁剪是硬性要求**：客户端收到的永远是 `viewFor(自己)` 的产物，
隐藏信息（牌堆顺序、未揭晓的拳、放大镜情报）**物理上不出现在报文里**。

### 一条特殊约定：`room.state` 的 `code` 为空 = "你不在房里了"

房间永远有房号，所以客户端拿 `code` 有没有值当"我在不在房里"的判断
（`shared/net/net.js` 里就一行 `net.room = msg.code ? msg : null`）。

**为什么要有这条**：有人离开房间时，房间层只给**还留在房里的人**广播状态，
离开的人自己收不到任何东西 —— 不给他单独补一条，他的界面会一直停在房间里，
看起来就是"点了离开没反应"。所以服务端在 `rooms.leave()` 里额外给他发一条
`{t:'room.state', code:null}`。

## 在线界面的两条 DOM 契约

平台要能把房间外壳画进游戏页面，只认这两样（新游戏照此接入）：

| 契约 | 用途 |
| --- | --- |
| `<div id="online-panel">` | `FrpRoom` 的容器。页面加载时就得在（可以在隐藏的屏幕里） |
| `.screen.is-active` | 标记当前屏幕。平台外壳和平台游戏都用这一个类名 |
| `[data-frp-avatar="<玩家id>"]` | 任何"头像"。**画上它就自动能点头像扔鸡蛋/送鲜花**（见 `shared/ui/react.js`），游戏不写互动代码 |

平台游戏都要把头像画出来（房间座位列表由平台画，牌桌/地图/对阵条由游戏画），
圆环颜色是**语义**、不是装饰，所有平台游戏必须一致：

| 圆环 | 谁 | 类名 |
| --- | --- | --- |
| 蓝 | 自己 | `frp-avatar is-me` |
| 橙 | 其他真人 | `frp-avatar is-human` |
| 灰（虚线） | 人机 | `frp-avatar is-bot` |

类名可以用 `FrpReact.ringClass(id, isBot)` 取，也可以自己写（SVG 里就按这个语义配色）。
**可点区域必须 ≥44px** —— 平台的浏览器用例与各游戏自己的 `tests/browser*.mjs` 都会实测。

⚠️ **"够大"的必须是带 `data-frp-avatar` 的那个元素自己**：点击目标是
`closest('[data-frp-avatar]')` 找出来的，"外面套一层大的、里面的圆很小"没有用
（房间座位列表原来就是这种结构，实际只有 40px 可点，被刀马的改造者发现）。
要么圆本身就是 44px，要么在它上面画一个够大的透明热区（地图的 `circle.tok-hit` 是这种）。
体检量的是"带属性的元素与其外层里更大的那个"。

⚠️ **头像的点击归平台**：`shared/ui/react.js` 在 `document` 的**捕获阶段**
`preventDefault + stopPropagation`（否则游戏自己的点击处理会和菜单同时发生）。
所以**游戏不要把别的动作挂到头像上** —— 贝壳赌局原来"点对手头像 = 选中目标"的捷径
就是这么失效的（动作按钮那条路还在）。

另外三个由平台自己处理的入口：

- **全屏（只手机端）**：入口页引入 `<script defer src="/shared/ui/fullscreen.js"></script>`。
  脚本只在 `(pointer: coarse)` 设备上挂右下角「⛶ 全屏」按钮，**电脑端不显示**；
  **只在 click 里请求全屏，绝不在加载/进房/开局时自动进**；不支持 Fullscreen API 的浏览器
  也不显示按钮。**进了全屏之后按钮整个隐藏**（手机用系统返回键退出），不要再显示「退出全屏」。
  伪横屏外壳（`web/*-frame.html`）的 `<body data-frp-fullscreen="landscape">` 让点击全屏时
  额外 `screen.orientation.lock('landscape')`、退出时 `unlock()`，像大富翁一样进真横屏。
  上游页面（无名杀/狼人杀/麻将）由 `server/http.mjs` 注入同一行；
  手机 `/play/*` 外壳负责，iframe 内层检测到 `window.self !== window.top` 后跳过。
  大富翁上游状态栏自带全屏，不重复注入。新游戏**必须**接这一行，详见 D42/D44。
- **音频防下载器（IDM / 迅雷）**：入口页引入 `<script defer src="/shared/ui/no-idm.js"></script>`
  （上游页面由 `server/http.mjs` 注入）。它把同源、以 `.mp3/.ogg/.wav/...` 结尾的
  `fetch` / XHR / `new Audio()` / `media.src` URL **去掉扩展名**；`server/http.mjs` 的
  `candidatesFor()` 再把无扩展名路径映射回真实文件（`/mahjong/audio/1m` → `1m.mp3`），
  并按真实扩展名发 `audio/*` + `Content-Disposition: inline`。
  这样页面照常播放，但下载器不再把游戏音效抓进「下载」文件夹。新游戏接这一行即自动生效。
- **`?join=XXXXXX`**：平台首页好友列表点「进入」时带上的房号。
  `FrpRoom.mount()` 会在连上之后自动发 `room.join`。
  ⚠️ 光跳页面是**不够的** —— 服务端补发 `room.state` 只对"已经在座位上的人"（断线重连）成立，
  从好友列表点进来的人根本没入过座。
- **`FrpRoom.mount()` 里会调一次 `GameNet.connect()`**：平台首页是 `web/assets/js/app.js` 连的，
  游戏页面没有那个文件。少了这一步，界面全画得出来、控制台一声不响，
  但点"创建房间"永远没反应。

## 游戏模块接口（服务器权威）

每个游戏在 `server/games/<slug>.mjs` 导出一个 `meta` 和若干函数：

```js
export const meta = {
  slug: 'cannon-goblin',       // ⚠️ 必须和文件名一致，index.mjs 会校验
  title: '大炮轰小鬼',
  icon: '💥',
  minPlayers: 1,               // 真人下限（历史上是"最少几个人能开局"）
  minSeats: 2,                 // **总座位**下限（含人机）—— 房间层用它当开局门槛
  maxPlayers: 2,
  maxBots: 1,                  // 可选：最多能坐几个人机。0 = 这个游戏没有电脑（斗地主）；
                               //       不写 = 不限（老游戏照旧）
  botNames: ['虎', '狼'],       // 可选：人机的单字名字池，不给就用平台默认池
  allowMidJoin: false,         // 对局中途能不能进人
};

/** 建一局。options 是房主在准备界面选的设置（各游戏自定义）。 */
export function createMatch(players, options) { … }

// players 是 [{ id, name, isHost, isBot }, …] —— **人机座位也在里面**
//   ⚠️ isHost 由房间层显式给。**不要**假设"第一个人是房主" ——
//      房主中途离开会把身份移交给别人，那时第一个人就不是房主了。
//   ⚠️ `isBot: true` 的座位是 AI 座位（id 形如 `bot:1`）。
//      **不要**再从 `options.aiFill` 自己造座位 —— 那条路已作废，见 D9。

// createMatch 返回的对象（`match`）必须实现：
//   viewFor(playerId) -> any | null     按人裁剪的视图，直接发给该玩家；不是这一局的人返回 null
//   act(playerId, act) -> {ok, message?} 校验并应用一个操作意图，message 是中文、会直接显示给玩家
//   removePlayer(playerId) -> void      掉线或主动离开（要么判胜，要么让对局能继续）
//   isOver() -> boolean
//   result() -> any                     终局信息
//   addPlayer(player) -> boolean        可选，allowMidJoin 为真时才需要
```

`rooms.mjs` 只认这个接口，**不认识任何具体游戏**。加新游戏不用动 `rooms.mjs`。

⚠️ **唯一的例外**：`server/games/<slug>.mjs` 会 `import` 那个游戏的
`games/<slug>/js/engine/rules.js` —— 这是刻意的，规则只允许有一份，
服务器和浏览器 import 的是同一个文件。这是平台铁律一（见根目录 `AGENTS.md`）。

## 房间号 / 玩家 ID

统一 **6 位**，字母表 `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
（**刻意排除 `0 O 1 I L`** —— 手抄和念读时最容易错的一批字符）。
玩家 ID 用同一套字母表，**7 位**，注册时由系统分配、不可改。
沿用 `Cannon Goblin` 的既有约定，原 `Shell Gambit` 的 5 位纯数字方案弃用。

## 平台外壳（`web/`）

登录成功后看到的那一页。结构（决定见 `docs/DECISIONS.md` D12）：

| 部分 | 内容 |
| --- | --- |
| 顶栏 | 一行「你：X · ID Y」（点 ID 复制）；"谁邀请你玩"的横幅也在这上面 |
| 底部切换栏 | **只有图标**的三个栏目：🎮 游戏 ｜ 👥 好友 ｜ ⚙️ 设置；选中高亮 + 略微放大 |
| 游戏栏 | 游戏列表（卡片点进去是**整页跳转**：平台自建游戏去 `/games/<slug>/`，无名杀/狼人杀/斗地主各有自己的顶级地址，见对应章节） |
| 好友栏 | 加好友（申请-同意制）、待处理申请、我发出的、好友列表；有待处理时"好友"图标上一个小红点 |
| 设置栏 | 音效开关、特效开关、身份（含复制 ID）、登出、连接状态、关于我（外链卡片） |

- 切换是**同一网页内的栏目切换**，用**淡入淡出**（用户否掉了横向滑动，嫌晃眼）。
- 未登录时是独立的登录/注册整页（`#screen-auth`），看不到三栏。
- ⚠️ 平台那几条浏览器用例是按栏目位置的 DOM 点的（`#friend-id`、`#btn-logout` …），
  **搬栏目必须同步改用例**，不许给旧元素留隐藏副本。

### 音效 / 特效只有一份偏好（`FrpUI.prefs`）

`shared/ui/ui.js` 里的 `FrpUI.prefs`（存 `localStorage` 的 `frp.prefs`）是**唯一**的偏好：

- `sound()` / `fx()` 读，`setSound(b)` / `setFx(b)` 写（会通知订阅者），`on(cb)` 订阅。
- 平台设置栏和各个游戏里的开关都只是这份偏好的入口 —— 各存各的就会出现
  "平台开着、游戏关着"的打架局面（用户点名要求）。
- 老键（`cg.sound` / `bs.sound` / `sg.sound` 及其 `fx`）**只在第一次**读时用来定默认值。
- 平台自己的按钮音：`FrpUI.sound.click()`（音色抄刀马那版 620→420Hz 三角波 60ms），
  平台外壳用 `FrpUI.sound.bindClicks(scope)` 一次接齐（`pointerdown`，按住拖走不算点击）。
  **游戏不要接它** —— 游戏有自己的音效包，接了同一下会响两声。

## 原版无名杀的托管（`/noname/`）

服务端**多托了一个不是平台游戏的东西**：上游无名杀的打包产物（`games/noname-web/dist`，1.29 GB）。
它**不进** `rooms.mjs`、不走平台协议；但账号、昵称、头像、好友在线状态**接上了平台**（见下）。

| 请求 | 由谁处理 | 干什么 |
| --- | --- | --- |
| `GET /noname/` | `server/http.mjs` 的 `MOUNTS` | 先查登录（没登录 302 到平台登录页并带回跳），再发 `dist/index.html`（并在 `</head>` 前注入桥接脚本） |
| `GET /noname/<rest>` | 同上 | 发 `dist/<rest>`（上游全是相对路径，天然落在挂载点下）；文本 gzip + ETag + `max-age=600`。**素材不查登录** |
| `GET /play/noname` | `http.mjs` 的 `PAGES` | **伪横屏外壳**（`web/noname-frame.html`）：手机竖屏 → 横过来的 iframe；电脑立刻跳 `/noname/`。同样要登录 |
| `GET /noname/frp-bridge.js` | `http.mjs` | 平台注入的桥接脚本（源文件 `web/noname-bridge.js`，`no-store`）：绑昵称/头像、加邀请入口、上报房号 |
| `POST /api/noname/state` | `server/http.mjs` | 无名杀页面上报"我在哪个房/开没开局/允不允许观战"（心跳 15 秒，TTL 45 秒） |
| `GET /api/noname/friends` | 同上 | 邀请弹窗用的好友列表（带头像与在线状态） |
| `POST /api/noname/invite` | 同上 | 从无名杀里邀请平台好友（只发给平台 WebSocket 在线的人） |
| `GET/POST /checkFile` `/checkDir` `/readFile` `/readFileAsText` `/getFileList` `/writeFile` `/removeFile` `/removeDir` `/createDir` | `server/noname.mjs` | 无名杀自己的**文件后端**（协议照抄上游 `@noname/fs`） |
| `GET <根绝对路径>`（`/noname.js`、`/character/…`、`/node_modules/…`、`/jit-test.ts`） | `http.mjs` 的**兜底候选** | 先 `data/noname/`、再 `dist/` —— 上游有硬编码的站根路径，这是它们的落点 |
| `UPGRADE /noname-online` | `server/ws.mjs` 的 `proxy` 选项 | **裸 TCP** 转给本机的无名杀中继（`127.0.0.1:8231`，上游 `@noname/server`），不解析帧 |

⚠️ 这几条 `/xxx` 是**站根**上的、和 `/api/*` 并列的新根路径 —— 加别的根路由之前先确认不撞车
（上游客户端是用 `fetch("/checkFile?fileName=…")` 这种绝对地址调的，改成 `/noname-fs/` 就得改上游）。

**为什么绕不开一个"文件后端"**：无名杀启动先探 `checkFile("noname.js")`，探不到就
`return` —— `game.checkFile` 没装上，`loadConfig` 调它抛 `TypeError`，**整页白屏**。
上游是让 `@noname/fs` 同时干"静态 + 这 9 个接口"；我们**不另起进程、不多开端口**
（隧道只映射 7891），把这个协议实现在自己的 HTTP 服务里。

**写只有一份、而且不在 dist 里**：`data/noname/`，只允许 `extension/` `image/` `audio/`
`noname.config.txt` `config.txt` 这几个前缀；读的时候"先 data、再 dist"。
上游是读写同一份（谁都能覆盖 `index.html`），这一处刻意偏离（安全），
代价是"覆盖自带文件"这种操作会失败（正常玩用不到）。见 `docs/DECISIONS.md` D28–D33。

**账号与身份**（D33）：

- 登录门只拦**文档**（`/noname/`、`/play/noname`），素材与接口不拦，否则 250 个模块每个都要查会话。
- 身份靠**注入脚本**绑定，不改 `dist`：`web/noname-bridge.js` 读 `/api/me`，
  写无名杀的 `lib.config.connect_nickname` / `connect_avatar`；头像地址是平台的
  `/avatar/<id>?v=…`，桥接给 `HTMLDivElement.prototype.setBackground` 补了一层"平台地址直接当图"，
  否则上游会把它拼成 `/noname//avatar/…` 而全空。
- 好友在线状态：`server/noname-presence.mjs` 存内存态，`hub.refreshFriends()` 并进好友列表的
  `playing:{game:'noname',code,started,observe,joinable}`；平台好友列表据此显示"正在玩无名杀"，
  点进去就是"加入 / 观战"。
- 邀请复用平台已有的 `invite` / `invite.reply`，多一个 `game:'noname'` 字段；
  服务端遇到这个字段**只转发回执，绝不走 `rooms.join`**（两边房号格式完全不同）。

**联机**是"客户端 ↔ 中继 ↔ 客户端"：中继（上游 `packages/server`）在本进程里监听
`127.0.0.1:8231`，公网从 7891 的 `/noname-online` 进来，走**裸 TCP 转发**（不解析帧）。
规则跑在房主浏览器里 —— 这和平台房间层是两套完全不同的东西（平台的房间层只服务自家平台游戏）。
见 `docs/DECISIONS.md` D31。

## 狼人杀（`/werewolf/`）

**第二个"缝合进来的上游项目"**（第一个是无名杀），但做法不同：**只要上游的界面，
规则是自己写的服务器权威引擎**。上游是 `hanluolin/wolfcha-custom`（MIT，Next.js 16），
本来是和 AI 单机玩的；AI / TTS / 单机 / 观战 / SEO 全部删掉（D37）。

| 请求 | 由谁处理 | 干什么 |
| --- | --- | --- |
| `GET /werewolf/`、`/werewolf/<深链>` | `http.mjs` 的 `MOUNTS` + `isWerewolfDocument` | 先查登录（没登录 302 `/?return=…`），再发 `games/werewolf/dist/index.html` |
| `GET /werewolf/_next/*`、`/werewolf/{roles,avatars,brand}/*` | 同上 | 静态导出产物（带 hash 的长缓存；入口页 no-store） |
| `POST /api/werewolf/room/*`、`/game/*` | `server/werewolf/index.mjs` → 引擎 `act()` | 建房/进房/离开/**再来一局**/开局/**踢人**（`/room/kick`，只有房主）/操作/状态；**身份来自会话 cookie** |
| `GET /api/werewolf/me` `/friends` `/records` `/records/<id>` | 平台这一层 | 我是谁 + 我在哪间房；邀请弹窗好友；对局记录与复盘 |
| `werewolf.event`（平台 WS） | `hub.deliver` | 房间广播。**只是"叮咚"**，客户端收到后自己再拉 `/game/status` |
| `?since=<seq>`（`/game/status`、`/game/act`） | 引擎 `messagesFor()` | 只要 seq 之后的新消息（每 5 秒轮询不再重下整局历史）；返回体带 `messagesSeq` |

**两层分工**（改之前先读）：

1. `games/werewolf/engine/index.mjs` —— **规则与状态机**（纯 ESM、零依赖、零宿主 API）。
   角色配置（房主自定义 4–18 人、每种角色几个）、夜晚顺序、发言/投票/警长/PK/结算、
   倒计时全在这里；服务器进程直接 `import`。同角色多人时用 `guardQueue/witchQueue/seerQueue`
   依次行动，能力状态挂在每个 `player.abilities` 上。
2. `server/werewolf/index.mjs` —— **平台接入层**：会话 → 身份、房间表 → 在线状态、
   `viewFor` 裁剪后的视图、结算 → `game_records`、好友免密判定、`WW_EVENT` 广播。
3. `games/werewolf/app/src/**` —— 页面（Next.js）。只拿平台视图，不自己算规则；
   账号 / 好友 / 邀请全走平台（`@/lib/net/platform` + `T.WW_EVENT`）。

**为什么这样缝**（被否掉的做法见 D37）：

- **不重写界面**：用户看上的就是上游的牌桌/发言/身份揭示；
- **不用上游的 AI 那套**：LLM 网关、角色生成、TTS 全要密钥和成本，还违背"纯真人"；
- **不静态托管上游 + 桥接**：上游没有联机/账号模型，每个交互都带本地状态与 LLM 请求，
  注入层比改源码更容易坏。

**身份与房间（关键不变量）**：

- 狼人杀里的座位 = **平台账号**（引擎 `Player.id` = `user.id`）；客户端不传身份，
  所以冒充别人、串房都做不到（`tests/werewolf.test.mjs` 钉着这条）。
- 一个账号同时只在一间狼人杀房里；再进一次是**回原座位**（刷新、换设备都不会多占一个位置）。
- 开局后**不能进人**（用户明确要求，不做中途加入 / 观战）、不能退房、不能邀请；
  好友列表里"正在玩狼人杀"那条会变成"已开局"且不可点。

**隐藏信息只在 `viewFor()` 裁剪**：别人的 `role`/`alignment` 不出现 —— **唯一的例外是"狼队友给狼人"**
（夜里要合刀；前端靠它给队友卡挂「狼队」标记、把协作面板的队友列全，2026-10-25 修的）；
夜晚结果只发给当事人
（双预言家各看各的 `seerHistory`）；`WW_EVENT` 的 `data` 永远是 `null`。
这是唯一的防作弊手段，改视图时先问"这是不是别人的底牌"（狼人知道狼队友不算别人的底牌）。
`tests/werewolf.test.mjs` + `tests/werewolf.engine.test.mjs` 钉着"好人一个都拿不到，狼人只多出狼队友"。
新增角色（D39）也守这条：`private.grave` 只给守墓人、`private.wolfBeauty` 只给狼美人、
`can.knight / can.wolfBeauty / can.wolfSelfDestruct` 只给当前轮到的人。
警长开关在 `createRoom({ sheriff })` 和 `view.sheriffEnabled` 里；关掉后没有警徽阶段。

**密码只挡陌生人**：房间可以设密码，但**房里只要有一个我的好友就免密**
（服务端 `canBypassPassword` 用 `store.listFriends` 判断）。邀请这条路永远不额外问密码。

**对局记录在数据库里**：结算时引擎调 `onGameEnd(info)`，平台写 `game_records` +
`game_record_players`；`GAME_END` 带 `recordId`，结算页直接跳复盘。
复盘**只对参与者**开放（快照里有全员身份）。

**角色配置**：`createRoom({ seats, roles })` 的 `roles` 是 `{ Werewolf: 3, Seer: 1, ... }`；
校验只要求"总数 = 座位数 + 至少 1 个**狼阵营**角色"（`isWolfRole`：狼人 / 白狼王 / 狼王 / 狼美人 / 恶夜骑士，
2026-10-25 起不再强制必须是狼人或白狼王），允许双女巫/双预言家。等候区快照带 `lobby.roles`。

**胜利条件（`winMode`，房主建房时选，默认屠边）**：

| 值 | 名字 | 狼人怎么赢 |
| --- | --- | --- |
| `side`（默认） | 屠边 | 杀光所有**平民**，或杀光所有**神职**（`isGoodGod`：所有非平民的好人） |
| `wipe` | 屠城 | 杀光所有**好人** |

- 好人胜 = 狼人全灭；**同一刻双方全灭时好人优先**（`checkWinner` 里 `aliveWolves === 0` 最先判）。
- 屠边的两条边在 `g.winModeSides` 里按开局配置记下来；哪边开局没配就不作为条件
  （正常开房时屠边要求"平民 ≥ 1 且 神职 ≥ 1"，`validateRoleSetup(seats, roles, winMode)` 会拒绝）。
- **死讯一结算就判**：`announceDeaths` 里 `kill()` 完死人之后立刻 `checkWinner`，
  中了直接 `endGame` —— 死人不再开枪、不再移交警徽、也不进白天。
  所以"1 狼 1 猎人、狼刀猎人"是当场狼胜，猎人开不了枪；而"1 狼 1 平民 + 1 骑士"被打掉平民后，
  屠城局会继续打下去（骑士还能翻牌决斗），屠边局则因为"平民全灭"当场狼胜。
- **不再有"存活狼人 ≥ 存活好人"的狼控场判定**（2026-10-25 用户拍板改掉）。
- `winMode` 从 `createRoom`/`startGame` 到 `g.winMode`、`view.winMode`、`lobby.winMode`；
  开局第一条系统消息会写明本局规则，`restartRoom` 不变更模式。

**状态倒计时可以按比例缩放**（`timeoutScale`，只有测试会传）：
`0.01` 时 180 秒发言变 1.8 秒，整套集成测试几秒能跑完一次状态推进。
发给客户端的 `deadline` 仍然是真实时间戳；**前端不用这个绝对时间**，
它记住"拿到视图时的本地时刻"，再用 `view.duration` 减本地流逝（`view.phaseStartedAt` 只是 key），
免得两边时钟有偏差时倒计时直接显示 00:00。

**两处"人已经死了还要行动"的特例**（改 `legalActions` 时别把顺序弄反）：
`can.hunter`（猎人开枪）、`can.transfer`（警长移交警徽）、`can.wwkBoom`（白狼王自爆后挑人）
都必须在 `if (!me.alive) return can;` **之前**给出，否则出事的人自己永远拿不到这个动作。
白狼王是**先自爆、再挑人**两步：`wwkBoom`（不带 seat）→ 自己出局、进 `WHITE_WOLF_KING_BOOM`；
带 `seat` 的那次才是挑人（`seat: null` = 不带走），超时就没人被带走，然后直接天黑。

**判完一局之后**：`restartRoom(hostId)` 把 `room.game` 清空、阶段退回 `waiting`、座位不动
（只有房主、只在 `over` 阶段可用，`POST /api/werewolf/room/restart`）；
离开房间仍然走 `leaveRoom`（`POST /room/leave`）—— 前端「返回大厅」必须真的调它，
只清本地 state 会被下一次拉状态拉回结算画面。

## 斗地主（`/ddz/`）

**牌桌是上游的 Godot 网页导出**（`github.com/blmz/GODOT-DouDiZhu`，Godot 4.4，单线程变体），
**规则与状态机在服务器**。为什么这样缝见 `docs/DECISIONS.md` **D40**（它取代了 D35），
上游情况、桥的契约、重新导出的步骤见 `games/ddz/README.md`。

**它是平台游戏**（和另外三个一样接 `rooms.mjs`），只是页面挂在顶级地址：

| 入口/接口 | 实现在哪 | 说明 |
| --- | --- | --- |
| `GET /ddz/`、`/ddz/index.html` | `http.mjs` 的 `MOUNTS` + `isDdzDocument` | 页面 + 登录门（未登录 302 `/?return=…`） |
| `GET /ddz/table/index.html` | 同上（`isDdzDocument` 也认它） | **牌桌页也在登录门里**：iframe 未登录要能回到登录页 |
| `GET /ddz/table/*.wasm` / `*.pck` | `http.mjs` 的 `TABLE_ASSET` | 二进制资源**不拦登录**；`Cache-Control: public, no-cache` + ETag；wasm 走 gzip |
| `GET /ddz/<rest>` | 同上 | `css/table.css`、`js/online.js`（页面用相对路径，所以 `/ddz` 会 301 到 `/ddz/`） |
| `GET /play/ddz` | `http.mjs` 的 `PAGES` → `web/ddz-frame.html` | 手机伪横屏外壳；电脑打开时 `location.replace('/ddz/')` |
| `GET /games/ddz/**` | `http.mjs` 的 `candidatesFor()` **主动 404** | 同一份目录只留一个地址 |
| `room.create` / `room.join` / `room.start` / `room.act` / `room.reset` | `server/games/ddz.mjs` | 房间号是**平台 6 位字母码** |
| `GET /api/me` 的 `games` | `server/games/index.mjs` 自动发现 | 服务端启动日志里会多一行「已接游戏 ddz」 |

**四层分工**：

1. `games/ddz/js/engine/**` —— **规则与状态机**（纯 ESM，零浏览器 API）：
   `cards.js`（54 张牌、洗牌、排序）、`rules.js`（`classify` / `canBeat`，服务器与浏览器共用
   同一份）、`game.js`（发牌 → 叫地主 → 抢地主 → 出牌 → 结算，`viewFor` 裁剪在本文件里）。
2. `server/games/ddz.mjs` —— **平台接入层**：座位表 → `createGame`、意图 → `match.act`、
   `meta`（`minPlayers/minSeats/maxPlayers = 3`、`maxBots = 0`、`allowMidJoin = false`）。
3. `games/ddz/index.html` + `js/online.js` + `css/table.css` —— **平台壳**：页头身份、房间外壳
   （`FrpRoom`）、把按人裁剪的 `view` 推给牌桌、把牌桌的意图发回服务器。**没有昵称输入框**。
4. `games/ddz/table/` —— **Godot 导出产物**（wasm 42 MB + pck 9.8 MB + 8 个小文件），跑在
   页面里一个 `position: fixed` 的 iframe 中。它**只画不判**：所有牌型、回合、胜负都由服务器定。

**页面 ↔ 牌桌的桥**（改 GDScript 必读，完整契约在 `js/online.js` 文件头）：

```
页面 → 牌桌   FrpDdzTable.接上(onPush, onReset) / 推视图(json) / 重置()
牌桌 → 页面   FrpDdzHost.动作(json) / 事件('就绪'|'再来一次'|'退出') / 渲染(json) → window.__FrpDdzTable
```

⚠️ Godot 的 `JavaScriptObject` **只转发方法调用**（没有 setter）；`get_interface()` 只认
**iframe 自己那个 window** 上的全局（父窗口必须贴进去，且 iframe `load` 后要再贴一次）。

**关键不变量**：

- **服务器权威**：底牌与三家手牌只在服务器上；`viewFor` 只给"自己的手牌 + 别人的张数"，
  叫地主结束前连底牌都不给（`null`）。牌桌拿到的就是这份裁剪过的视图，**没有别的通道**。
- **牌桌层不能塞进 `FrpRoom` 的面板**：`room.js` 每次 `room.state` 都整块重画，iframe 被搬动
  会让部分浏览器重新加载牌桌（等于每走一手重开一局）。所以牌桌单独待在 `.ddz-stage`。
- **头像由浏览器代取**：Godot 解不了 SVG（平台默认头像就是 SVG），`js/online.js` 把
  `/avatar/<id>` 画成 96×96 PNG 放进 `players[].avatarData` 再推进去。
- **座位 = 平台账号**：一个账号只坐一个位；开两个标签页是**重连回原座位**。三个人必须都是真人。
- **开局后进不来**（`allowMidJoin: false`）；**有人离开 = 本局作废**（没有 AI 接管手牌）。
- **没有倒计时**、**没有金币/赌注**、**没有聊天**、**不存战绩**（`game_records` 没用上）。
- **交付**：wasm gzip 后约 9 MB；`.wasm`/`.pck` 一律协商缓存；重新导出 `table/` 之后用户强刷。

**回归防线**：`npm run test:ddz` ——
`games/ddz/tests/engine.test.mjs`（37 条：牌型/比大小/两阶段叫抢/整局/视图裁剪/引擎零宿主 API）
+ `tests/ddz.test.mjs`（18 条：登录门含牌桌页、唯一地址、**wasm gzip+ETag**、三人座位、整局打完、
作废、出别人的牌被拒）+ `tests/ddz.browser.mjs`（真 Chrome：邀请进房、三块牌桌起 wasm、
**在 canvas 上真点「叫地主」**、打完一局三家进结算、375px、伪横屏外壳）。

## 地平线赛车（`/games/horizon/`，上游 3D 世界 + 平台房间层 + 独立位置中继）

**不是规则引擎游戏**：世界/物理/车都在浏览器里跑（上游
`github.com/Liyang1145/horizon-racing`，MIT，Three.js r128 + cannon-es，零构建）。
平台只负责联机大厅和一局的生命周期；**车辆位置不走 `room.state`**（D46）。

| 项 | 在哪 |
| --- | --- |
| `GET /games/horizon/`（含 `?join=`） | `server/http.mjs` 静态目录 + `isHorizonDocument` 登录门 | 未登录 302 `/?return=…`；资源（`js/**`、`assets/**`、`lib/**`）不拦 |
| `GET /games/horizon` | `http.mjs` | 301 到带尾斜杠（保留 query；在登录门之后） |
| `GET /play/horizon` | `web/horizon-frame.html` | 手机伪横屏外壳；粗指针竖屏时把 iframe 转 90°，`?join=` 原样带进 iframe |
| `GET /api/games` | 自动发现 `server/games/horizon.mjs` | 首页卡片 / 好友「正在玩」靠它 |
| 房间/座位/邀请 | `server/rooms.mjs` + `shared/ui/room.js` | 和刀马/斗地主同一套 `FrpRoom`；`meta.minSeats=1`、`maxPlayers=8`、`maxBots=0` |
| 一局生命周期 | `server/games/horizon.mjs` | `createMatch` 只记地图/车手/完赛顺序；`act` 支持 `finish`/`dnf`/房主 `over`；开局后 `addPlayer=false` |
| 车辆位置中继 | `server/horizon/relay.mjs` + `server/ws.mjs` 的 `extra` 路由 | 路径 `/horizon-relay`；握手期要平台登录，`hello` 还要核对房号/座位/`phase=playing` |
| 客户端接线 | `games/horizon/js/frp-horizon.js` + `css/frp-horizon.css` | 大厅、地图选择、幽灵车、起终点拱门、结算、触屏按键；**上游 js 一行没改** |

**中继协议**（JSON 文本帧，玩家自己发的 `pos` 不回给自己）：

| 方向 | 消息 |
| --- | --- |
| C→S | `hello {code,map,car}` / `ready` / `pos {x,y,z,yaw,vx,vz,speed,progress}` / `finish {time}` / `over {timeout}` / `bye` |
| S→C | `welcome {selfId,code,started,startedAt,peers}` / `peer` / `peer-left` / `go {delayMs,startedAt}` / `pos` / `finish {id,order,time}` / `all-finished` / `over` / `error` |

**关键不变量**：

- **账号唯一**：大厅里显示的就是平台 7 位账号；页面没有昵称输入框，未登录打不开文档。
- **位置 12.5Hz + 客户端插值**；平台 `room.state` 只在开局/完赛/DNF/结束时发。
- **碰撞是各客户端推自己的车**（三圆胶囊），不是服务器权威物理；不装"撞了改服务器位置"。
- **赛道复用上游路线**：`coast` → `ring` → 最长路线；闭环一根"起点 / 终点"格子旗拱门，
  开放路线起点门 + 终点门；检查点 ~30 个，复用上游 `raceCheckpoints`。
- **开局后不能中途加入**（物理对不齐）；有人离开/手动退回主菜单记 DNF，别让其他人永远等。
- **手机触屏 = 合成键盘事件**（`KeyW/A/S/D/Space/C/R/Escape/H/Q/E`），上游输入逻辑不改。
- **首屏资产 ~15MB**（保时捷 918 GLB base64）；`city3` 另有 ~50MB GLB，按需加载。

**回归防线**：`npm run test:horizon` ——
`tests/horizon.test.mjs`（5 条：自动发现/2–8 人、建房开局视图、地图白名单、中继鉴权/
ready→go/pos 只转别人/finish 名次/重置后拒绝、登录门 + 资源不拦 + 301 保留 `?join`）+
`tests/horizon.browser.mjs`（真 Chrome + Node 队友：平台账号、收起大厅不退房、幽灵车、
三圆胶囊碰撞推开、起点格子旗拱门、`Game.finishRace` 真冲线到 relay + room.act、双人完赛结算、
首页卡片、触屏按键尺寸/真合成 KeyW、手机外壳旋转和 `?join` 透传）。

## 大富翁（`/games/monopoly/`，整份上游 Web 客户端 + WS 中转）

**不是平台房间游戏**：页面/玩法/规则全部来自
`github.com/FatPaper-1874/mine-monopoly`（GPL-3.0，上游原名 `fatpaper-monopoly`，
源码归档在 `games/monopoly/upstream/`）。上游是 pnpm monorepo（Vue3 + Pinia + Three.js +
GSAP + PeerJS），游戏逻辑跑在**房主浏览器**的 `GameProcessWorker` 里；地图（`.mmmap`）
装的是棋盘/角色/事件等全部内容。我们**只静态托管 Web 客户端**，不跑上游
Express/MySQL/管理后台/地图编辑器（D41，取代 D36）。

| 项 | 在哪 |
| --- | --- |
| `GET /games/monopoly/`、`/play/monopoly` | `http.mjs` 的 `MOUNTS` + `isMonopolyDocument`/`sendMonopolyIndex` | 页面 + 登录门（未登录 302 `/?return=…`）+ 注入 `window.__FRP_ME__` |
| `GET /games/monopoly` | `http.mjs` | 301 到带尾斜杠（保留 query） |
| `GET /play/monopoly` | `web/monopoly-frame.html` | 手机伪横屏外壳（整串 query 转发，保住 `?join=`） |
| `GET /monopoly-maps/*` | `server/http.mjs` → `games/monopoly/maps/` | 5 张官方公开 `.mmmap` + 封面 + `manifest.json` |
| `GET /monopoly-audio/sfx\|bgm/<名字>` | `server/http.mjs` → `games/monopoly/web/assets/audio/` | 无扩展名 + `application/octet-stream`，防 IDM 抓 BGM/音效 |
| `GET/POST /monopoly-server/*` | `server/monopoly/index.mjs` | 上游 room-router/地图接口的兼容实现（内存房间表，30s 租约） |
| `WS /monopoly-relay` | `server/monopoly/relay.mjs` + `server/ws.mjs` `extra` 路由 | PeerJS 兼容中转；文本 JSON + 二进制地图分块 |
| `POST /api/monopoly/state`、`GET /api/monopoly/friends`、`POST /api/monopoly/invite` | `server/http.mjs` + `server/monopoly-presence.mjs` | 「正在玩」presence 与平台邀请 |
| 身份桥 | `apps/client/src/frp/bootstrap.ts` | `__FRP_ME__` → `localStorage.user`，清 token，路由守卫跳过上游 login |
| PeerJS shim | `apps/client/src/frp/relay-peer.ts`（Vite alias） | `Peer`/`DataConnection` API → WS 中转，断线重连/resume |

**关键不变量**：

- **账号唯一**：页面里的 `userId` 就是平台 7 位 ID，昵称/头像同平台；**没有上游登录页**，
  也没有起昵称的输入框。改身份桥时先看 `bootstrap.ts` 的 `applyPlatformIdentity()`。
- **联机只走 7891**：不引入 coturn、不依赖公共 TURN/上游 PeerServer；客户端仍然
  `new Peer(...)`，但 `peerjs` 被 alias 到 `relay-peer.ts`。中继房间号就是上游 12 字符以内的
  `roomId`，地图分块 64KB（低于 `ws.mjs` 的 1 MiB 上限）。
- **规则在房主浏览器**：平台不裁剪视图、不做服务器权威；这是上游模型，**不要再改回去**。
- **房间生命周期由上游客户端驱动**：`join → emit-host → heart/status → delete`；
  房主租约 30s、断线 60s 宽限、房间保留 5 分钟；`set-started`/`set-private` 只有房主能调。
- **邀请进房**：好友卡片/邀请卡都落到 `/games/monopoly/?join=房号`，
  `online-room-panel.vue` 自动 `joinRoom(..., { allowCreate:false })`；房间已关要提示人话。
- **地图只发公开 `.mmmap`**：`sourceUrl` 一律 `null`，付费 `.fpmap` 源文件不进仓库/不挂载。

**回归防线**：`npm run test:monopoly` ——
`tests/monopoly.test.mjs`（20 条：登录门/SPA 兜底/源码不泄漏/`__FRP_ME__` 注入/5 张地图/
room-router 生命周期与权限/relay 双向转发/resume/401/presence/邀请/回执）+
`tests/monopoly.browser.mjs`（真 Chrome：登录门回跳、账号一致、好友「正在玩/进入」、
游戏内邀请→平台邀请卡→进房、两人选图/选角色/开始进 3D 棋盘、375px 伪横屏、桌面回真页面）。
## 莲花广麻（`/mahjong/`，整份上游项目 + Python 后端反代）

**唯一一个规则不在 Node 里的游戏**：上游是
`github.com/BestGuo2020/lianhuaguangdongmahjong`（Vue3 + Three.js 前端）+
`github.com/BestGuo2020/lianhua-mahjong-backend`（Python/FastAPI 后端，MIT）。
两份源码都复制在 `games/mahjong/`，前端构建产物提交在 `games/mahjong/web/`；
后端**原样跑**，Node 只做 **HTTP + WebSocket 反向代理**（D43）。

| 项 | 在哪 |
| --- | --- |
| `GET /mahjong/`（含 `?join=房号`） | `http.mjs` 的 `MOUNTS` + `isMahjongDocument`/`sendMahjongIndex` | 页面 + 登录门（未登录 302 `/?return=…`）+ 注入 `window.__FRP_ME__` + 全屏脚本 |
| `GET /mahjong` | `http.mjs` | 301 到带尾斜杠（保留 query；在登录门之前） |
| `GET /play/mahjong` | `web/mahjong-frame.html` | 手机伪横屏外壳（整串 query 转发，保住 `?join=`） |
| `ANY /mahjong/api/*` | `server/mahjong/index.mjs` 的 `proxyHttp()` | 去掉 `/mahjong` 前缀后转给 `127.0.0.1:8123`；**先过平台登录门**，再注入 `x-frp-user-*` |
| `WS /mahjong/ws/*` | `server/ws.mjs` 的 `proxies` 路由 | 握手期验平台会话，然后裸字节转发到 Python 的 `/ws/*` |
| 后端进程 | `server/mahjong/index.mjs` | `python -m uvicorn app.main:app --host 127.0.0.1 --port 8123`；Node 启动时等 `/api/health`，退出时先 SIGTERM 再 SIGKILL |
| 「正在玩」/邀请 | `server/mahjong-presence.mjs` + `http.mjs` + `server/hub.mjs` | 页面每 15 秒 `POST /api/mahjong/state`；好友列表/邀请卡与其它游戏同形状 |
| 前端桥 | `games/mahjong/upstream/web/src/frp/bridge.ts` | 心跳 + 房间内「邀请好友」浮层（只用平台接口） |
| 身份补丁（后端） | `games/mahjong/backend/app/api/deps.py` | `FRP_TRUSTED_HEADERS=True` 时认 `x-frp-user-*`；Node 每次反代都覆盖同名头，浏览器伪造无效 |

**关键不变量**：

- **公网只有 7891**：Python 固定 `127.0.0.1:8123`，不映射到公网、不加第二条隧道。
  直接访问 8123 没有平台身份头，也不算登录态。
- **账号唯一**：页面里没有上游 OAuth 登录入口、没有昵称输入框；REST/WS 的身份都来自
  Node 注入的平台会话。大厅显示「当前账号 xxx」，就是平台首页那个账号。
- **规则和界面都是上游的**：平台不解析麻将协议、不裁剪视图、不重画牌桌；
  牌桌里的隐藏信息由上游后端的 `build_snapshot()` 按座位裁剪。
- **房号是上游的**：6 位大写字母/数字，不是平台 `rooms.mjs` 的短码；
  `/mahjong/api/rooms/*` 里的房间与平台房间层无关（平台只转发）。
- **邀请卡在平台页面弹**：麻将页不连平台 WS（和大富翁同一模型），
  页面负责发出邀请，收到邀请后由平台打开 `/mahjong/?join=房号`，
  页面补丁自动进房并从地址栏删掉 `join`（刷新不会重复触发）。
- **后端可缺席**：没建 `.venv` / 起不来时，麻将接口 503（`MAHJONG_BACKEND_DOWN`），
  其它游戏和平台功能不受影响；`npm test` 的麻将 Node 用例会 skip。

**回归防线**：`npm run test:mahjong` ——
`tests/mahjong.test.mjs`（10 条：登录门/301/`__FRP_ME__` 注入/伪造身份头被覆盖/
未登录 401/建房加入准备开局/WS 反代 `rejoin_ok` + 快照裁剪/presence/邀请回执）+
`tests/mahjong.browser.mjs`（真 Chrome：登录门回跳、账号一致、大厅无昵称框、
建房、好友「正在玩/进入」、游戏内邀请→平台邀请卡→自动进房、375px 伪横屏、桌面回真页面）。

## AI 小镇（`/ai-town/`，Rust host 子进程 + 平台房间/反代）

**规则与模拟不在 Node**：上游 `town-manager` 管用户目录/开镇，`town-host` 跑世界；Node 只包一层
账号、房间、存档、布局与反代（D48）。

| 东西 | 在哪 | 说明 |
| --- | --- | --- |
| `GET /ai-town/`、`/ai-town/game.html` | `http.mjs` 的 `isAiTownDocument` + `sendAiTownIndex` | 登录门 + 注入 `__FRP_ME__`/桥脚本/全屏/音频防下载；`/ai-town/assets/**` 走静态挂载 |
| `GET /ai-town` | `http.mjs` | 301 到带尾斜杠 |
| `ANY /ai-town/api/platform/*` | `server/ai-town/index.mjs` 的 `handlePlatform` | status/state/friends/invite/join/room/leave/close/layout；不经过上游 |
| `ANY /ai-town/api/towns/*` | `manager.proxyHttp` | 房主开镇/关镇走平台包装；其余反代到房主 manager；客人 GET 可看，POST 403 |
| `POST /ai-town/api/towns/<id>/open` | `openFor` | 房主调上游 open；客人拿房主房间的 `browserEntry`（不含 lease） |
| `WS /ai-town/ws?room=&sid=` | `server/ws.mjs` 的 `proxies` + `aiTown.wsTarget` | 握手验平台会话 + 10 分钟房间票据，再按房间查 host 随机端口，裸字节转发；代理在握手前注入 `frp_user/frp_name/frp_role/frp_room/frp_avatar` |
| 子进程 | `server/ai-town/manager.mjs` | 一个平台用户一个 manager（`--root data/ai-town/users/<id>`）；最多 2 个 |
| 房间 | `server/ai-town/rooms.mjs` | 平台 6 位码；房主/成员/joinable/邀请；最多 4 人/房、2 房 |
| 在线状态 | `server/ai-town/presence.mjs` + `hub.mjs` | 好友列表「正在玩 AI 小镇」、邀请回执 |
| 手机布局 | `store.mjs` 的 `user_layouts` + `index.mjs` 的 layout API | 按平台账号存 4 个控件；`kind='ai-town/controls'` |
| 模型 | `upstream/builtin-model/llama-server.exe` + `data/ai-town/models/model.gguf` | host 按需起 llama-server；每用户硬链接共享模型 |
| 多化身 | 上游 kernel/host 的 `guest:<平台ID>` actor + 平台注入的身份 | 房主 `player_avatar`，访客各自一条租约；世界设置仅房主；名册 `avatar_url` 画头顶平台头像 |

**关键不变量**：

- **浏览器永远只看到同源 `/ai-town/ws`**：上游随机端口、`?session=`、`lease` 不出平台。
- **房间票据一次性/10 分钟**：`sid` 绑定 user+room，WS 握手再验平台会话。
- **客人不落盘**：客人用住房主世界，退出/关镇保存的是房主的 `world.json`；`snapshot()` 会
  过滤所有 `guest:` actor 和访客互动。
- **访客权限边界**：只能控制自己的 `Avatar/AvatarInput` + 只读公开查询；`Possess` 与世界设置
  （速度/天气/请村民/开始暂停）由 host 拒绝，错误文案说明归房主。
- **`/games/ai-town/**` 404**：上游源码、Rust target、模型都不从网页暴露。
- **同时最多 2 个世界**：第三个人开镇返回「小镇满了」；每房 4 人。

## 目录职责

```
server/     唯一进程：HTTP + WebSocket + 房间 + 账号 + 游戏权威逻辑
  games/    每个游戏一个 <slug>.mjs 接入层（只做"意图 ↔ 引擎调用"的翻译）
shared/     前后端共用的东西（协议常量、前端网络层、UI 组件）
  protocol.mjs  协议常量（模块，浏览器也直接 <script type="module"> 引它）
  net/net.js    GameNet：唯一的网络层，游戏不许自己连 WebSocket
                （建连竞速 + 应用层心跳 + 身份记忆 cachedMe 都在这里）
  ui/ui.js      FrpUI：按钮/输入框/toast 等零散件 + 平台唯一的偏好（prefs）与共用按钮音
  ui/anim.js    FrpAnim：演出队列（一步演完再演下一步，刻意不支持跳过）
  ui/react.js   FrpReact：头像圆环 + 扔鸡蛋/送鲜花（含音效与特效）
  ui/room.js    FrpRoom：房间外壳（建房/进房/成员/加人机/邀请/开始/再来一局）
  ui/fullscreen.js  可选全屏按钮（只在点击时请求，绝不自动；全屏时按钮隐藏；iframe 内层跳过）
  ui/no-idm.js  音频 URL 去扩展名（防 IDM / 迅雷把游戏音效抓进“下载”）
games/      三个平台小游戏 + 五个"缝进来的上游项目"（都只依赖 shared/）：
              blade-steed/ cannon-goblin/ shell-gambit/   平台自建（房号走 rooms.mjs，页面 /games/<slug>/）
              ddz/          斗地主（玩法借自上游、引擎与页面重写；房间走 rooms.mjs，页面 /ddz/，见《斗地主》）
              monopoly/     大富翁（**整份上游 Web 客户端** + WS 中转 + 平台账号；不走 rooms.mjs，
                            页面 /games/monopoly/，手机走 /play/monopoly，见《大富翁》）
              noname-web/   原版无名杀（静态托管 + 注入桥接，见《原版无名杀的托管》）
              werewolf/     狼人杀（上游界面 + 本仓库引擎，见《狼人杀》）
web/        平台外壳：登录页 + 底部三栏（游戏列表 / 好友 / 设置）
tools/      cdp.mjs（无头浏览器）、check-noname.mjs（无名杀体检）、
            noname-update.mjs（更新上游无名杀）、service.mjs（开关服务）
docs/       架构 / 决策 / 游戏坑 / 游戏索引 / 隧道 / 待办
tests/      平台级测试（node:test + 真浏览器）
data/       SQLite 数据库 + 运行状态（gitignored，绝不提交）
```

**依赖方向是单向的**：`games/*` → `shared/*`，`web/*` → `shared/*`。
游戏之间**绝不互相 import**。



