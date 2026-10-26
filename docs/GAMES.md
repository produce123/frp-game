# 游戏索引

平台游戏的唯一入口说明。**加/改游戏先看这里**，再进各自的 `AGENTS.md`。
（另外还有六个**不是平台自建**的缝合项目：原版无名杀 `games/noname-web/` 见文末《无名杀 Web》，
狼人杀 `games/werewolf/` 见文末《狼人杀》，斗地主 `games/ddz/` 见文末《斗地主》，
大富翁 `games/monopoly/` 见文末《大富翁》，莲花广麻 `games/mahjong/` 见文末《莲花广麻》，
AI 小镇 `games/ai-town/` 见文末《AI 小镇》。）

**手机端所有游戏都必须有可选全屏，电脑端不显示**：入口页加
`<script defer src="/shared/ui/fullscreen.js"></script>`，按钮右下角「⛶ 全屏」，
**默认不进、用户点了才进**；脚本只在 `(pointer: coarse)` 设备上挂按钮，电脑端自动跳过。
上游页面由 `server/http.mjs` 注入，`/play/*` 伪横屏外壳负责手机，iframe 内层不重复加。新游戏照做，详见 D42。

## 一览

| slug | 名字 | 人数 | 一句话 | 搬迁状态 |
| --- | --- | --- | --- | --- |
| `cannon-goblin` | 大炮轰小鬼 💥 | 1–2 | 大炮隔空格吃小鬼，小鬼数量围堵大炮 | ✅ 已接入（服务器权威 + 单机人机 + 在线人机座位 / 逐条演出 / 互动） |
| `shell-gambit` | Shell Gambit 💀 | 1–4 | 恶魔轮盘聚会版：霰弹枪、7 种道具 | ✅ 已接入（服务器权威 + 单机人机 + 在线人机座位 / 逐条演出 / 互动） |
| `blade-steed` | 刀马 BladeSteed ⚔️ | 1–4 | 武侠猜拳：赢的人才能买刀买马砍人 | ✅ 已接入（服务器权威 + 单机人机 + 在线人机座位 / 逐条演出 / 互动） |
| `horizon` | 地平线赛车 🏎️ | 2–8 | 开放世界海岸赛道 3D 竞速，车与车真实碰撞 | ✅ 已接入（**上游 3D 世界原样跑在浏览器** + 平台房间层 + `/horizon-relay` 车位置；手机触屏按键 / 伪横屏；没有电脑） |
| `ddz` | 斗地主 🃏 | 3 | 叫地主 → 抢地主、出牌；牌桌是上游的 Godot 网页版 | ✅ 已接入（**牌桌是上游界面** + 服务器权威规则 + 房间层 + 平台账号；**没有电脑**、没有倒计时、不存战绩） |
| `mahjong` | 莲花广麻 🀄 | 2–4 | 四人广东麻将（白板癞子 / 翻精癞子）；界面和规则都是上游的，规则在 Python 后端 | ✅ 已接入（**整份上游项目**：Vue3 页面 + FastAPI 后端 + 平台账号/好友/邀请；手机走 `/play/mahjong`） |
| `ai-town` | AI 小镇 🏘️ | 1–4 | AI 村民自己过日子的 2D 小镇；房主开自己的存档，朋友进同一张图，各自有化身 | ✅ 已接入（**Rust 世界内核 + manager** + 平台账号/邀请/房间 + 每账号存档 + 手机布局 + 服务器端内置小模型；房主/客人同图降临，客人不存档） |

`web/assets/js/games.js` 的卡片清单要与上表一致。另外还有**四条 `href` 卡片**
（点了开新标签页）：`/play/noname`（原版无名杀，见《无名杀 Web》）、
`/werewolf/`（狼人杀，见《狼人杀》）、`/ddz/`（斗地主，见《斗地主》——
它**是**平台游戏、房间走 `rooms.mjs`，只是页面地址不在 `/games/<slug>/` 下）、
`/play/mahjong`（莲花广麻，见《莲花广麻》——**不是**平台房间游戏，规则在 Python）。

> **在线统一口径**（2026-10-20 深夜按用户新反馈改过）：人机是**房间的座位**
> （房主按一下加一个，单字名字、灰色虚线圈头像，见 `docs/DECISIONS.md` D9）；
> 服务端一次推来的多步**逐个演完**（`FrpAnim`，不给跳过，D10）；
> **演出期间锁住输入**（`FrpAnim.busy()` + `body.frp-anim-busy`），
> 且**不做本地预演** —— 点下去到回包之间本机不演任何东西（D10 的新版本，
> 老版本的"乐观起手"已整段删除：用户实测快速连点会把画面演成"所有人都被打死了"）；
> 头像可点扔鸡蛋/送鲜花（平台能力，D11）。
> 圆环语义所有平台游戏必须一致：**自己=蓝、其他真人=橙、人机=灰**。

## 各自来自哪里

| slug | 原文件夹 | 原代码形态 |
| --- | --- | --- |
| `cannon-goblin` | `C:\Users\produce\Desktop\WorkSpace\Cannon Goblin` | 经典脚本（全局 + 内联 `onclick`） |
| `shell-gambit` | `C:\Users\produce\Desktop\WorkSpace\Shell Gambit` | ES Module |
| `blade-steed` | `C:\Users\produce\Desktop\WorkSpace\BladeSteed` | ES Module |
| `horizon` | `github.com/Liyang1145/horizon-racing`（MIT） | 经典 `<script>` + Three.js r128 + cannon-es，零构建；世界/物理/车原样留在浏览器，平台只加房间/中继/触屏 |
| `ddz` | `github.com/blmz/GODOT-DouDiZhu`（Godot 4.4，无 LICENSE） | Godot 工程（规则/界面/AI 搅在 `脚本/手牌管理器.gd`）；**界面原样导出成网页版**（`games/ddz/table/`），规则搬到服务器 |

> 原三个文件夹**保持原样不动**（线上 GitHub Pages 站不受影响，改坏了可对照）。

上游缝合项目的来源（大富翁、地平线的完整来源见各自小节）：

| 项目 | 上游 | 我们这一份 |
| --- | --- | --- |
| 无名杀 | 原版无名杀（GPL-3.0） | `games/noname-web/`：源码 + `dist`，**一行不改**，靠注入桥接 |
| 狼人杀 | `github.com/hanluolin/wolfcha-custom`（MIT，Next.js 16 前端） | 只要界面（`games/werewolf/app` → 静态导出 `dist/`）；规则引擎是本仓库重写的 `games/werewolf/engine/index.mjs`。AI/TTS 全删，见 D37 |
| 斗地主 | 第一版借 `tinyshu/ddz_game` 的玩法（页面是自己画的，用户否掉了那版 UI）；现在是 `github.com/blmz/GODOT-DouDiZhu`（**无 LICENSE**，默认保留所有权利） | **界面原样用上游的 Godot 网页导出**（`games/ddz/table/`）+ 规则搬到服务器（`games/ddz/js/engine/**`）；源码在 `games/ddz/godot/`，见《斗地主》 |
| 莲花广麻 | `github.com/BestGuo2020/lianhuaguangdongmahjong`（MIT，Vue3 + Three.js）+ `github.com/BestGuo2020/lianhua-mahjong-backend`（MIT，Python/FastAPI） | 两份源码都复制进 `games/mahjong/`（**不是 fork**）；前端构建产物提交到 `games/mahjong/web/`；后端原样跑在 `127.0.0.1:8123`，Node 只反代 + 注入平台身份，见《莲花广麻》 |
| AI 小镇 | `github.com/mewamew/my_ai_town`（**PolyForm Noncommercial 1.0.0**） | 源码复制进 `games/ai-town/upstream/`（**不是 fork**）；Rust 内核/manager 编译成 `games/ai-town/bin/`；前端构建产物在 `games/ai-town/web/`；Node 管进程/房间/账号/存档/WS 反代 |

## 搬一个游戏时看什么

目录骨架、三条铁律（`engine`/`ai` 零 DOM、删掉 `js/net/**`、不再问玩家名字）、
`meta` / `createMatch` 契约都在 **`docs/ARCHITECTURE.md`** 的「游戏模块接口（服务器权威）」一节；
本节只记**每个游戏自己的来源、状态和踩过的坑**。
（注：2026-10-23 起平台不再维护 `docs/GAME-SPEC.md` 与 `tools/check-game.mjs`，
新游戏默认缝成熟上游，照着现有游戏抄接线。）

## 各游戏原有的、必须保留的关键约定

搬的时候**逐条核对**（这些是原项目花了真实 bug 换来的）：

- **cannon-goblin**：见 `games/cannon-goblin/AGENTS.md` ——
  棋盘三件套共用坐标系（`flex:none` / `fitCellSize()` / `devicePixelRatio`）、
  AI 评估函数只有"大炮方"一套符号、位置项必须远小于吃子分、
  `selectedPiece`/`validMoves` 不许进 view、自定义地图必须当不可信输入校验。
  ⚠️ 原 `AGENTS.md` 里那批**联机约定（话题方向、`sid` 定向、只同步一手棋、通路降级）
  已经全部作废** —— 那些代码整段删掉了，规则现在由服务器裁决。
  搬迁时多出来的东西：`js/view.js`（视图层）、`js/bridge.js`（把 ESM 引擎挂回 window）、
  `js/ui/online.js`（房间准备区 + 把 view 交给渲染函数）、`server/games/cannon-goblin.mjs`。
  ✅ **在线人机 = 房间的座位（2026-10-20 晚重做）**：本作只有 2 个座位、双方不对称，
  所以"加一个人机"就是"把对面那个座位交给电脑"。房主在准备区按一下「＋ 添加人机」
  （平台统一交互，见 `docs/DECISIONS.md` D9），一个人 + 一个人机就能开局。
  ⚠️ 这里有过一次**口径反转**：最早是"一个人进房时对面交给电脑"、`aiFill` 缺省 = 1、
  房主显式选 0 且只有一个人时**拒绝开局**；那一整套（连"关了补位还自动垫一个会让开关变成假的"
  这个理由）现在都**作废了** —— 因为"补几个电脑"这个开关本身没有了，
  人机变成看得见、能删、能对人扔鸡蛋的座位。游戏侧现在**不读 `options.aiFill`**。
  难度写死最便宜的 easy（hard 会在服务端主线程堵约 1.5 秒 = 整间房卡住），刻意不给房主选。
  ✅ **联机观感（2026-10-20 深夜重做）**：走子/吃子改成 FLIP 滑动 + 碎裂残影，由
  `FrpAnim.push` 逐步演完（每步 460ms，不给跳过，见 D10）；
  ⚠️ **本地预演已整段删除**（用户实测快速连点会把画面演成"所有人都被打死了"），
  改成**演出期间锁输入**（`FrpAnim.busy()` + `body.frp-anim-busy`，棋盘连选子都不响应）。
  ⚠️ 这一轮顺带补回一个**真缺失**：吃子那一步没有声音（用户直接指出的），
  现在吃子有独立的合成音效；细节与"怎么证的"见 `games/cannon-goblin/AGENTS.md`。
  ✅ **不暗屏 + 首页身份 + 偏好统一（2026-10-20 最近一轮）**：
  演出期间**不再把棋盘变暗**（用户原话"不要忽然暗屏"）—— 只保留 `pointer-events:none`
  与 JS 那道闸，提示改成棋盘**右下角一行小字**「演出中，请稍候…」
  （纯 CSS 伪元素，演完自己消失；实测 `opacity=1`、`filter=none`、横向溢出 0px）；
  首页补上「你：X · ID Y」（ID 点一下复制；先用 `GameNet.cachedMe()` **立刻**画出来，
  `ready` 到了再对齐）；音效/特效开关改成只读写平台唯一那份偏好（`FrpUI.prefs`）。
  ⚠️ 那个"暗屏"其实是本作上一轮自己加的（`body.frp-anim-busy #game-board { opacity:.5 }`），
  用例已经把口径**反过来钉住**：谁再把 opacity/filter 加回去，`browser.ai-fill.mjs` 立刻红。
- **shell-gambit**：见原 `README.md` 与 `games/shell-gambit/AGENTS.md` —— 7 种道具的裁定细节（放大镜私有、
  逆转器公开、啤酒公开、手锯对空弹也浪费、肾上腺素不偷肾上腺素、手铐的跳过与顺延）、
  牌堆 28 张守恒、`viewFor` 裁剪是唯一的防泄露手段。
  搬迁时的偏离，都写在 `games/shell-gambit/AGENTS.md` 里：
  ⚠️ 原项目里那套**花朵/鸡蛋互动**是删掉的，但**这一版又回来了** ——
  它现在是平台能力（`shared/ui/react.js` + `react.send`，见 `docs/DECISIONS.md` D11），
  游戏只需给头像加 `data-frp-avatar`。原来那份"没有服务器时的广播通道"照旧不许搬。
  ✅ **人机改成"房间的座位"**（2026-10-20 晚，D9）：`meta.minPlayers` 早先已从 2 改成 1，
  但"补几个电脑"那个开关（`options.aiFill`）现在**整条作废**；
  人机座位由房间层加进 `players`（带 `isBot`），本作把它们当 AI 座位用，
  名字沿用单机那套单字池（导出成 `meta.botNames`）。一个人点【创建房间】→ 按一下「添加人机」→ 开局。
  掉线座位由 AI 接管打完这一局。
  ✅ **联机观感**（用户第 1、4 条反馈）：服务端一次 act 里会跑完 AI 的整个回合，
  客户端因此会**在一帧里收到几十个事件** —— 现在改成 `FrpAnim.push` 逐个演完
  （每步 450~700ms，刻意不支持跳过，见 D10）。
  ⚠️ **本地预演已整段删除**（2026-10-20 深夜，D10 新版）：原来"点下去先在本机演一下起手、
  服务器回放时按指纹跳过"那套全没了 —— 用户实测**快速连点会把画面演成"所有人都被打死了"**。
  现在点下去到回包之间本机不演任何东西，**演出期间锁住输入**（`FrpAnim.busy()` +
  `body.frp-anim-busy`）。数值始终以服务端 `view` 为准。
  ⚠️ 它与 blade-steed 一样有个平台侧的小坑：`shared/net/net.js` **不会自己连**，
  游戏页必须在自己的 `app.js` 里调一次 `GameNet.connect()`。漏掉之后界面看着一切正常
  （名字显示得出、单机也能玩），只有点【创建房间】会**静默失败**。
  ✅ **这个已经平台侧修掉了**：现在 `FrpRoom.mount()` 里会代劳一次 `connect()`，
  游戏不用再自己调（调了也无害）。
  ✅ **逐步同步 + 进度/身份收口（2026-10-20 最近一轮，D14）**：用户报"动画还没播完，
  对方的血亮就已经是结算状态了" —— 根因是 `render()` 收到报文就按**最终**状态重画整块牌桌，
  只有播报/特效在排队。现在牌桌手里有**两份视图**（权威视图 + 显示视图），
  演出每一步先贴"服务器给的这一步补丁"（日志条目的 `s`）再画，演完最后一步、
  **队列真空了**才用权威视图对账一次（对账不许插队）。
  ⚠️ **补丁必须过与 `viewFor` 同一套裁剪**（引擎先按人存 `hands`/`legals`/`knows` 三张表，
  出报文前由 `narrowLogEntry()` 裁成"我自己那一份"）—— 少裁一张表就是明牌，
  而**单机看着一切正常**。用例逐字段钉着（含"表名与单数名同名"那个先删表再提单数的坑）。
  ⚠️ **首次挂载 / 再来一局一条旧条目都不回放**（补丁是差量，没有基线就不能叠；
  老实回放还会把血点算成错的数）。
  身份改成"权威 → 缓存 → `/api/me`"（D13），音效/特效开关统一到 `FrpUI.prefs`（D12）。
  实测：`rules.test.mjs` + `ai-fill.test.mjs` **64 条**、`sim.mjs` 健康、`browser.e2e.mjs` 里
  一边演一边采样 **41 次 / 31 次停在演出中途 / 18 次明显不是最终值**，
  每一步的弹药数·血量点·回合数·轮到谁都等于那一步的补丁；本游戏自己的 Node 用例与
  `tests/browser.e2e.mjs` 全过。
- **blade-steed**：见 `games/blade-steed/AGENTS.md`（和原 `README.md`）——
  `legalActionsFrom()` 是**合法操作的唯一来源**（引擎校验、界面按钮、AI 决策空间三边都从这里取）、
  猜拳多赢家的最小猜拳与指定行动顺序。
  搬迁时的几处偏离，都写在 `games/blade-steed/AGENTS.md` 里：
  删掉整个大厅、删掉取名界面、**超时改成客户端催**
  （平台房间层没有 tick 钩子）、
  ⚠️ 原项目里那套**扔鸡蛋/鲜花互动**与大厅一起删掉了，但**这一版又回来了** ——
  它现在是平台能力（`shared/ui/react.js` + `react.send`，见 `docs/DECISIONS.md` D11），
  游戏只需给地图上的头像加 `data-frp-avatar`（并保证热区 ≥44px）。
  ✅ **联机的人机改成"房间的座位"**（2026-10-20 晚，D9）：`minPlayers` 早先是 1，
  但"补几个电脑"（`options.aiFill`）整条**作废**；人机座位由房间层加进 `players`（带 `isBot`），
  名字沿用单机那套单字池（导出成 `meta.botNames`），AI 的拳在开局那一刻就定下来，
  服务端在 `createMatch` / `act` / `tick` / `removePlayer` 里同步把它跑完（零定时器）。
  ⚠️ 它和别的游戏有个**结构差异**：房间层要几个座位（`meta.minSeats = 2`）和
  引擎要几个座位（`MIN_SEATS = 2`）是两个常量，别合成一个 —— 1 个座位的局永远分不出胜负，
  引擎必须继续拒绝。
  ✅ **联机观感**（用户第 1、4 条反馈）：事件流改成逐个演完（`FrpAnim.push`，
  每步 450~700ms，不给跳过，见 D10）。
  ⚠️ **本地预演已整段删除**（2026-10-20 深夜，D10 新版）：原来"点下去立刻点亮自己那格 +
  音效、服务器回放时按指纹 `_consumeOptimistic` 跳过"那套全没了 —— 用户实测**快速连点会把
  画面演成"所有人都被打死了"**。现在点下去到回包之间本机不演任何东西，
  **演出期间锁住输入**（`FrpAnim.busy()` + `body.frp-anim-busy`）。
  原来那一排「补几个电脑」的设置区也已删除。
  ⚠️ **小屏手机上地图与头像偏小**（用户第 4 条新反馈）已按实测放大：360×640 那一档
  头像直径 **21.4 → 40.4px**、热区 **47.9 → 61.8px**（联机 2 人局 20.6 → **44.7px** / 46.2 → **68.3px**），
  做法是**每局按人数算 viewBox**（紧贴内容）+ 2 人局改斜对角 + `AVATAR_R` 12.5→17。
  尺寸数据与新建的 `tests/browser.size.mjs` 见 `games/blade-steed/AGENTS.md` 第 13 条。
  ⚠️ 出拳那一声（原版点按钮立刻 `play('pick')`）现在挪到**服务器回放 `rps-pick` 那一步**才响，
  只响我自己那一票 —— 删预演时它一度被删掉了，captain 收口时按"音效跟着权威确认走"补回来的。
  `viewFor` 对名单外的人返回 `null`。
  ⚠️ 还有一个平台侧的小坑记在它的 `AGENTS.md` 里：点「离开」之后离开的人收不到新状态
  （`rooms.mjs` 的 `broadcastState` 只遍历留下的成员）。
  ✅ **这个也已经平台侧修掉了**：`rooms.leave()` 现在会给离开的人补一条
  `{t:'room.state', code:null}`，客户端靠"房号是不是空的"判断自己在不在房里。
  游戏侧那段"1.2 秒没新状态就重载页面"的兜底**已经删掉了**（平台修好后它是死代码，
  留着反而可能在正常离房时误重载）。教训：游戏侧兜平台 bug 时，注释里一定要写
  "平台修好之后删掉这段"。回归防线在 `tests/server.test.mjs`（"离开房间的人会收到一条
  '你不在房里了'"）和 `games/blade-steed/tests/browser.e2e.mjs`（点【离开】必须回到入口）。
  另外它顺手记了两条**测试**才能撞到的坑（都在它的 `AGENTS.md` 第 4 条末尾）：
  量尺寸要先把入场动画 `finish()` 掉（否则 44px 量成 43.99 偶发误报）、
  **不能用 `offsetParent` 判元素可见**（祖先链里有 `position:fixed` 时它恒为 null）。
  ✅ **逐步同步 + 倒计时 + 三件平台能力**（用户第 2、3、4、5 条反馈，2026-10-20 深夜）：
  整块牌桌跟着演出**按步走**（引擎给每一步带公开状态补丁 `entry.s`，
  `view.js` 的 `narrowPatch` 用与 `viewFor` 同一份白名单裁剪，**别人还没揭晓的拳不进补丁**；
  `board.js` 拆成 `authView`（权威，只用来判阶段/时限/催 tick）与显示视图，
  队列真空了才 `_reconcile()` 对账；首次挂载 / 「再来一局」一律 `_adopt()` **不重演旧补丁**）。
  倒计时两半：服务器 `REPLAY_BUFFER_MS = 2000` + 客户端**演出期间只写"演出中…"**
  （关键是 `anim.push` 之后立刻再拍一次计时器，堵掉那 0~200ms 会显示在跑数字的窗口）。
  另外身份改成"权威 → `GameNet.cachedMe()` → `/api/me`"（D13）、按钮音与音效/特效开关
  统一到平台的 `FrpUI.prefs` / `FrpUI.sound`（D12）。
  实测：`rules.test.mjs` **36** + `online-ai.test.mjs` **15** = **51 条**、
  `sim.mjs` 12000 局无死锁、`browser.e2e.mjs`（逐步同步 5d-4 / 倒计时 5d-5 / 不暗屏 5b-1 /
  偏好只有一份 3b）、**新增 `browser.identity.mjs`**（WebSocket 与 `/api/me` 两条路一起掐死，
  身份仍瞬间可见）、`browser.size.mjs` 全过（三个浏览器文件逐个跑）。
  ⚠️ **一个实测出来的缺口**（没有偷偷放宽断言）：猜拳阶段（标称 10 秒）最长一帧 **8 步 / 4.1 秒**，
  2 秒缓冲抵不掉 —— 排空时只剩 **77.9%**，而行动阶段是 **101.5%**。
  要一律 ≥90% 得把缓冲提到 ≥4.2 秒，代价是挂机时全桌多等，**属于要用户拍板的取舍**。细节见
  `games/blade-steed/AGENTS.md` 第 14/15/16 条。
## 地平线赛车（`games/horizon/`，上游 3D 世界 + 平台房间层）

**唯一一个"世界/物理全在浏览器、服务器只记名次"的平台游戏**。上游是
`github.com/Liyang1145/horizon-racing`（MIT，Three.js r128 + cannon-es，经典 `<script>`、
零构建；**不是 fork**，源码直接复制进 `games/horizon/`）。完整决定见 D46。

### 玩家看到的样子

- 游戏主菜单多一个「联机竞速」按钮 → 平台标准房间面板（账号/好友/邀请/房号全部平台那套）。
- 房主选地图（阿尔卑斯湖谷 / 海特洛市 / 海特洛2 / 程序化都市 GLB），点开始后所有人切图。
- 联机时每人在主菜单选自己的车；起跑格 2 列排开，沿海闭环赛道，起点/终点格子旗拱门。
- 其他玩家是幽灵车（真实车型/名字牌），撞上会被推开；所有人完赛后弹出名次表，
  房主可「再来一局」。
- 手机：`/play/horizon` 伪横屏外壳；小地图缩到左上角，仪表盘缩到小地图下方；
  左下 ←/→，右下油门/刹车/手刹（放大并向内/上挪），右上视角/复位/暂停/喇叭/升挡/降挡。
  联机时顶部居中的大计时窗在手机上收成**小地图右边的一条**（只留用时+名次），
  地图被布局编辑器拖动/缩放后它也跟着走。
- 手机主菜单「驾驶辅助调节」右边多「手机界面布局」：小地图 / 仪表盘 / 技能点 /
  左转向 / 右油门 / 顶部小按钮 **六组整体**可拖动、缩放、显示隐藏，自动存本机 localStorage，
  可一键恢复默认。布局只改 CSS 变量，不改 3D/物理/绘制代码。

### 我们这一份怎么分工

| 层 | 文件 | 干什么 |
| --- | --- | --- |
| 上游世界 | `games/horizon/js/**`、`lib/**`、`assets/**` | 地形/城市/车流/物理/车模型；**一行没改**（除了 `ui.js` 的 `raceTotal` 一处小改） |
| 平台接线 | `games/horizon/js/frp-horizon.js`、`css/frp-horizon.css`、`index.html` 的浮层 | 大厅、地图、幽灵车、拱门、结算、触屏、中继 |
| 一局生命周期 | `server/games/horizon.mjs` | 地图/车手/完赛顺序/DNF/房主结束；`maxBots: 0` |
| 位置中继 | `server/horizon/relay.mjs` + `server/ws.mjs` | `/horizon-relay`，握手验登录 + `hello` 验房号/座位/phase |
| 手机外壳 | `web/horizon-frame.html` | 竖屏转 90°，`?join=` 带进 iframe |

### 必须记住的约定

- **不要试图把车辆物理搬到服务器**：上游物理和 8 台车的悬挂/轮胎全在浏览器，服务器拉位置会橡皮筋（D46）。
- **不要用 `room.state` 传车位置**：FrpRoom 每条 state 都重画；位置走 `/horizon-relay`（12.5Hz）。
- **开局后不能中途加入**（`addPlayer:false`）；有人离开记 DNF，别让其他人等。
- **手机触屏只合成键盘事件**（`KeyW/A/S/D/Space/C/R/Escape/H/Q/E`），不要另写驾驶逻辑。
- **首屏 ~15MB**（保时捷 918 GLB）；`city3` 另有 ~50MB GLB。手机弱网会慢，这是上游资产。
- **起点/终点**：闭环 `coast` 一根"起点 / 终点"格子旗拱门；开放路线起点门 + 终点门。

### 测试

`npm run test:horizon` = `tests/horizon.test.mjs`（5 条服务器/中继）+ `tests/horizon.browser.mjs`
（真 Chrome + Node 队友：幽灵车/碰撞/结算/手机外壳）。`npm test` 也会跑到前者。

## 无名杀 Web（`games/noname-web/`，**不是平台游戏**）

原版无名杀，网址 **`/noname/`**（`/noname` 会 301 过来）。上游
<https://github.com/libnoname/noname>（GPL-3.0），本机是 **1.11.7** 的源码 + `pnpm build` 产物。
用户要的是"打开网页直接玩**原版**"——所以 **UI / 文件名 / 目录结构全沿用上游**。
但**平台账号已经接上了**：`/noname/` 要登录、昵称/头像自动带进联机、
好友能看到"正在玩无名杀"并直接进房/观战（决定见 `docs/DECISIONS.md` D28 / D29 / D33）。

### 它在服务端长什么样

| 东西 | 在哪 | 干什么 |
| --- | --- | --- |
| 静态托管 | `server/http.mjs` 的 `MOUNTS`（`/noname/` → `games/noname-web/dist`） | 发上游打包产物；**根绝对路径兜底**也在那儿（`/noname.js`、`/character/…`） |
| 文件后端 | `server/noname.mjs` | 实现上游那 9 个接口（`/checkFile` `/readFile` `/writeFile` …） |
| 上传落点 | `data/noname/`（不进 git） | 网页端"写"只落这里；读是"先 data、再 dist" |
| **联机中继** | `server/noname.mjs` 的 `startNonameRelay()`（上游 `packages/server`） | 在本进程里 listen `127.0.0.1:8231`，从 `/noname-online` 裸 TCP 转发进来 |
| **伪横屏外壳** | `web/noname-frame.html`（页面 `/play/noname`） | 手机竖屏时把游戏放进一个横过来的 iframe；电脑直接跳 `/noname/` |
| **登录门** | `server/http.mjs` 的 `isNonameDocument()` | `/noname/`、`/play/noname` 没登录就 302 到平台登录页（带回跳）；素材不拦 |
| **桥接脚本** | `web/noname-bridge.js`（服务端注入，地址 `/noname/frp-bridge.js`） | 绑昵称/头像、「联机」里的邀请入口、上报房号 |
| **在线状态** | `server/noname-presence.mjs` + `hub.refreshFriends()` | 好友列表里显示"正在玩无名杀"、可加入/观战（心跳 15 秒、TTL 45 秒） |
| 首页卡片 | `web/assets/js/games.js` 里带 `href` 的那张 | 新标签页打开 `/play/noname`；**没有 slug**，所以不算平台的游戏 |

### 平台账号绑定（不改 `dist`，全靠注入）

- `server/http.mjs` 在 `/noname/index.html` 的 `</head>` 前插一行
  `<script type="module" src="/noname/frp-bridge.js?v=…">`，脚本本体是 `web/noname-bridge.js`（`no-store`）。
- 桥接读 `/api/me`，写无名杀的 `connect_nickname` / `connect_avatar`；头像地址是
  `/avatar/<id>?v=…`，由桥接给 `HTMLDivElement.prototype.setBackground` 打的补丁直接当背景图。
- ⚠️ 上游模块导出的是 `{ lib, game, get, ui, _status }`，**不是 `window.*`** —— 桥接里只能 import，
  写 `window.ui` 永远是 undefined。
- ⚠️ `setBackground` 是**无名杀启动后才装**的，补丁必须"没装上就重试"（300ms 一次，最多 30s）。
- ⚠️ `game.saveConfig` 要等无名杀的菜单建好（`ui.menuContainer`），否则会被它自己加载配置时覆盖。
- 「选项 → 联机」里的「邀请平台好友」只在**平台 WebSocket 在线**的好友那边弹横幅；
  只开无名杀页面的人收不到，但好友列表里能看到他"正在玩"并点「进入 / 观战」。
- **好友点「进入 / 观战」走 `?frpJoin=` 深链时，桥接直接 `game.connect()`**，不切「联机」模式、
  不点「连接」：先把房号写进 `tmp_user_roomId`，大厅 `roomlist` 一到就自动消费并 `enter`。
  ⚠️ 直接连要自己补 `lib.configOL.bannedcards` 等默认值，否则 `roomlist → clearArena` 会抛异常、
  房间列表都建不出来。这样也绕开了 IP 界面 —— 用户报的「一直显示 *正在连接 wss://…*」不会再出现。
- 深链进房时首次向导还盖在房间上：桥接**只把向导 dialog / control 设成 `display:none`**，
  绝不点「跳过向导」或 `close()` —— 那会让身份局教程继续走清场/`game.reload()`，把房间冲掉。
- ⚠️ 无名杀的全局样式是 `div { display:inline-block; position:absolute; }`。桥接自己的弹窗
  （卡片 / 标题栏 / 底栏）必须显式 `position:relative`，列表要 `flex:1; min-height:0`；
  否则底栏会脱离 flex 流，**「关闭 / 发送邀请」直接盖在好友列表上**（`check-noname` 钉了盒子断言）。

### 为什么需要 `server/noname.mjs`（不实现就白屏）

无名杀网页端启动时要探一个**文件读写后端**（`noname/init/browser.js` 的 `browserReady`：
`fetch("/checkFile?fileName=noname.js")`）。探测失败它直接 `return` ⇒ `game.checkFile` 没被装上
⇒ `loadConfig` 调它抛 `TypeError` ⇒ **整页白屏**。

上游的网页端本来靠 `@noname/fs`（一个 Fastify 服务）同时"发静态 + 提供这 9 个接口"。
我们**不另起进程、不多开端口**（隧道只映射 7891，多一个端口就要多改一次面板），
而是在自己的 HTTP 服务里按同样协议实现，响应形状与上游逐字对齐
（`{success, code, data}`、查不到的文件返 `{}`、`getFileList` 返 `{folders, files}`）。

⚠️ **有一处刻意和上游不同（安全）**：上游把 dist **读写同一份**，谁都能 `POST /writeFile`
覆盖掉 `index.html`。我们把**写**关到 `data/noname/`，只允许
`extension/` `image/` `audio/` `noname.config.txt` `config.txt` 这几个前缀 ——
导入扩展、换背景图/背景音照常能用（读的时候盖住同名文件），但**没有任何请求能改掉
dist 里自带的文件**。路径穿越（`../`）一律拒绝。

### 三个只有子路径部署才会撞的坑（已经踩完并修好）

1. **`lib`/`game` 各两份 ⇒ 白屏。** 上游 `init/import.ts` 用 `/card/…` `/character/…`
   这种**根绝对路径**加载卡牌包/武将包/模式/扩展；index.html 却用相对路径。
   浏览器按 URL 区分模块：于是 `noname` 这个导入名指到站根的 `/noname.js`，
   和 `/noname/noname.js` 成了两个实例。**症状**：武将包一加载就
   `TypeError: Cannot read properties of undefined (reading 'characters')`。
2. **`entry.js` 跑两遍。** `game/game.js` 里 `script.src = "/noname/entry.js"`，
   和 index.html 的 `./noname/entry.js`（= `/noname/noname/entry.js`）是两个 URL
   ⇒ 整个 boot 跑两遍（日志里 vue 警告、"ts文件导入成功"、武将包加载各出现两次）。
3. **Service Worker 的 TypeScript 探针跑出 scope。** `/jit-test.ts` 在站根，
   不在 SW 的 `/noname/` scope 里，JIT 一定失败。

**修法**：改上游那几个文件（`init/import.ts`、`scripts/vite-plugin-importmap.ts`、
`library/index.js`、`init/index.ts`、`packages/server/src/server/createServer.ts`），
把绝对地址换成**相对文档**（`new URL(…, document.baseURI)` / `./xxx`），并把联机地址、
载入超时、中继的错误监听一起补上（见下两节）。站根部署时行为完全不变。
**别在 dist 上手改** —— 下次 `pnpm build` 就没了；补丁全在 `tools/noname-update.mjs` 里。

### 联机（和自己的同学远程打）

无名杀的联机是"**客户端 ↔ 中继服务器 ↔ 客户端**"：中继只登记房间、转发报文，
**规则跑在房主的浏览器里**。上游的中继就是 `packages/server`（`@noname/server`）。

⚠️ **没有"官方中继"参与**（用户第一个直觉就是"会不会绕到官方再绕回来"）。
这个名字里的 "server" 只是**包名**，它跑在**我们自己这台电脑上** —— 它就是本进程里的
一个内部端口。真正的路径只有这一段：

```
玩家A 浏览器 ──wss──▶ SakuraFrp 节点（只转发字节）──▶ 本机 7891（我们的服务）
                                                      │ 裸 TCP 转发（同一台机器，<1ms）
                                                      ▼
                                            中继 127.0.0.1:8231（同一个进程）
                                                      │ 原路返回
玩家B 浏览器 ◀────────────────────────────────────────┘
```

延迟构成：A→节点→你这台电脑（隧道，几十毫秒，无法避免）+ **本机内部一跳（不到 1 毫秒）**。
中继是**无名杀联机的必需品**（它只转发/登记，不跑规则），但它在你的电脑里，不在外面。

- **隧道不用改**：还是只映射 7891。中继只监听回环地址，公网只能从 `/noname-online` 进来。
- **玩家不用填地址**：上游的 `lib.hallURL` 默认是空串，我们打补丁让它按当前页面算
  （`wss://当前域名/noname-online`）。「联机」里那个输入框**一打开就已经填好了**，
  直接按「连接」即可。地址是现算的，**没有写死任何公网域名**。
- 中继**必须**和网页端一起起来（`startServer({ nonameRelay: true })`，
  见 `server/server.mjs` 的 main 分支）。测试/体检起临时服务时默认关 —— 不然会抢 8082/8231。
- 上游中继有个坑：**没给每条连接挂 `error` 监听**，一个非法帧（比如 close 帧里
  status code 是 0）会让 `ws` 抛未处理异常，**把整个进程带走**。我们和平台共用一个进程，
  所以打了补丁兜住（一条坏连接只断它自己）。这条是体检里真踩出来的。

### 「退出」按钮按了没反应（已修）

用户报：**对局里点悬浮球展开的「退出」，一点反应都没有**。

原因在上游：浏览器端的 `game.exit()` 只有一句 `window.close()`，而**浏览器只允许脚本关掉
自己 `window.open` 出来的窗口**。我们的入口是普通跳转（`/play/noname` 甚至是个 iframe），
`close()` 被**静默忽略**、也不报错 —— 于是按钮看起来"死的"。

修法（补丁⑥）：`window.close()` 之后再兜一层 —— 100ms 后如果窗口还活着，就
**回到游戏主菜单（`/noname/`）**。真被 `window.open` 打开的窗口照旧直接关掉，上游行为不变。
体检里钉着这条：点完「退出」**页面必须真的重载**。

### 手机：伪横屏

`/play/noname` 是外壳（`web/noname-frame.html`）：

- **为什么用 iframe 而不是给整页加 `rotate`**：无名杀的排版是**按视口尺寸现算**的
  （`innerWidth/innerHeight` + 自己的缩放）。直接转整页，它仍然按竖屏排版，
  转完只是"竖版内容歪着放"。放进一个**横着的 iframe**（844×390）里，它的排版、
  缩放、触摸坐标全都按横屏算，我们只负责把这块画面转 90° 摆满竖屏。
- **判据只用 `(pointer: coarse)`**（`matchMedia`）。⚠️ 不要用 `navigator.maxTouchPoints`：
  带触摸屏的 Windows 笔记本是 10，会把自己当成手机、整天套在 iframe 里。
- 电脑上外壳会立刻 `location.replace('/noname/')` —— 地址栏干净、没有 iframe。
- 转手机、转回横屏、旋转设备都只重算尺寸，**不重载游戏**（存档/牌局都在）。
- 已知小别扭：竖屏旋转状态下弹**系统键盘**（比如手打联机地址）方向是跟着屏幕的，
  能用但看着歪；地址已经预填好，正常用不到键盘。

### 首屏速度与「游戏似乎未正常载入」

手机上那个弹窗**不是游戏坏了**，是上游的**载入超时兜底**：
`init/index.ts` 里 `setTimeout(lib.init.reset, loadtime)`（默认 10 秒），超时就问
「游戏似乎未正常载入，是否重置游戏？」。点「取消」就行，别点确定（确定会清掉本地存档标记）。

两条根治（都在服务端/补丁里，玩家无感）：

1. **gzip**（`server/http.mjs`）：文本资源按 `accept-encoding` 现压并**在内存里缓存**
   （带 mtime 的键，`dist` 换了自动重压）。实测首屏 **250 个请求 / 压前 3.48 MB → 传输 0.80 MB**。
   Range 请求（音频边播边取）**不压**，几 KB 的小壳文件也不压。
2. **`/noname/` 下给 `max-age=600` + ETag**：刷新是 304，不再把几 MB 重发一遍。
   平台自己的文件照旧 `no-store`（见 `server/http.mjs` 文件头的取舍）。
3. 补丁把兜底超时从 **10 秒放宽到 30 秒**，只为了别在网络抖一下时误报。

### 更新上游

```bash
node tools/noname-update.mjs --check   # 只看本机 vs 上游 main（不动文件）
node tools/noname-update.mjs           # 下载 → 覆盖源码 → 重打补丁 → pnpm install → pnpm build
node tools/check-noname.mjs            # 体检
node tools/service.mjs restart         # 让线上用新产物
```

为什么不是 `git pull`：本机 `github.com:443` **不可靠**（clone 一半 `Connection reset`），
而 `codeload.github.com` 的 zip 稳定（1.1 GB / ~100 秒）。所以走"整包覆盖"。
源码目录 1.25 GB、dist 1.3 GB，都在 `.gitignore` 里（**不进 git**）。

### 怎么验证

```bash
node tools/check-noname.mjs
```

它跑真 Chrome，钉住这些（都是"改服务端顺手能弄坏、只在真浏览器里看得见"的）：

- **零未捕获错误 + 主菜单出现**（"游戏模式"三个字）—— 白屏那次的症状是
  `game.checkFile is not a function`；
- **所有脚本都从 `/noname/` 加载**（根绝对路径的第二份实例会在这里变红）；
- **9 个接口的形状**，外加"越界路径被拒绝""不许覆盖 index.html"、写/删往返
  （写接口测在临时目录里，不碰真实存档）；
- **gzip / ETag(304) / Range(206 且不压)** —— 手机首屏能不能进得去全看这条；
- **联机中继**：连 `/noname-online` 拿到房间列表、报身份后收到在线列表；
  再来一趟真的：**甲建房 → 乙一连上就在大厅里看到那个房间 → 乙进房 → 甲收到通知**
  （报文形状照抄无名杀客户端的 `create`→`config`→`enter`）；
- **「联机」里的地址必须已经预填**（且是当前域名现算的，不是写死的公网地址）；
- **悬浮球的「退出」必须有反应**：点完页面要真的重载（上游只调 `window.close()`，
  普通跳转进来时会被忽略 —— 用户看到的就是"按了没反应"）；
- **伪横屏外壳**：竖屏 390×844 必须量到"内容 844×390 且转了 90°"，电脑必须跳回 `/noname/`；
- **首屏传输量**：实测打印"压前 / 传输"，并且传输量必须 **< 压前的 60%**（gzip 掉了就变红）。

### 已知边界

- **改了 `dist` 之后，已经打开过的浏览器最多 10 分钟还在用旧文件**（`/noname/` 下是
  `max-age=600` + ETag，为的是手机首屏别再重传 3.5 MB）。所以发版/修 bug 之后要让对方
  **强刷一次**（电脑 `Ctrl+F5`；手机长按刷新或清一次缓存），否则他会说"你说的修好了，
  我这儿还是坏的"。这一条**真踩过**（「退出」修完要先强刷才看得见）。

- **Service Worker 需要安全上下文**：公网是 HTTPS（自签证书，第一次点"继续"）能用；
  本机 `http://127.0.0.1:7891/` 也算安全上下文。
- **`/preload.js` 和 `src="vue"` 会 404**：前者只有 Electron 客户端要，后者是上游自己的
  HTML 生成的怪标签（**上游官方站同样 404**，不影响玩）。
- **包很大**：首次加载要拿 ~250 个模块（本机实测 boot ≈ 2.5 秒，首屏 gzip 后 0.8 MB）。
  第一次进仍然有几秒（手机上更久），之后靠 `max-age=600` + Service Worker。
- **联机的中继在同一个进程里**：中继挂了/端口被占，网页端照常单机玩，只是联机连不上
  （启动时会在日志里打一行警告，`data/server.log` 搜「联机中继」）。
  端口默认 **8231**（⚠️ 不用上游默认的 8082 —— 这台机器上 **QQ 就占着 8082**，
  而且绑的是 `0.0.0.0`，撞上会把公网流量转给 QQ）。要换：`FRP_NONAME_RELAY_PORT=xxxx`，
  但**客户端地址是 `/noname-online` 这个路径**，换端口不用改前端。
- **第一次进站要先点掉证书警告**：公网是自签证书，`wss://` 联机复用同一个域名，
  所以"点了继续访问"之后联机才连得上；没点的话浏览器会直接拒绝 WebSocket。
- ⚠️ **写接口是公开的**（和整个 `/noname/` 一样没有账号门槛）：谁都能 `POST /writeFile`
  往 `data/noname/extension/` 里塞文件。一个坏人写的扩展**只会影响自己启用它的人**
  （和原版网页端一样，只是原版连 `index.html` 都能被覆盖）。要收紧就加一条
  "写接口必须带平台登录态"，代价是**纯玩无名杀的人没法导入扩展** —— 属于要用户拍板的取舍。
## 狼人杀（`games/werewolf/`，只要上游的界面）

**它不是平台 `rooms.mjs` 的游戏**：房间、6 位数字房号、阶段机都是自己的
（和无名杀一样"另一个世界"），平台借给它的是**账号、好友、邀请、对局记录**。
和旧版的区别：上游换成了 `wolfcha-custom`，**规则引擎是本仓库重写的**，
没有任何 AI / 大模型 / TTS / 单机 / 观战。

| 想知道 | 看 |
| --- | --- |
| 为什么换上游、删了哪些 AI 内容 | `docs/DECISIONS.md` D37（D34 已被它取代） |
| 前端怎么构建、规则改哪里、怎么发版 | `games/werewolf/README.md` |
| 请求从哪进、`werewolf.event` 怎么走 | `docs/ARCHITECTURE.md` 的《狼人杀（`/werewolf/`）》 |
| 契约测试 | `npm run test:werewolf`（引擎单测 + 11 条平台集成 + 真 Chrome） |

### 玩家看到的样子

- 平台首页的游戏列表里有「🐺 狼人杀」卡片（用 `href` 开新标签页）。
- 进 `/werewolf/` **必须先登录**（没登录 302 回平台登录页并带回跳地址）；
  页面直接用**平台昵称 + 平台头像**，没有"起个昵称"这一步。
- **纯真人 4–18 人**，没有电脑；坐满才发牌。打字发言，每人 **180 秒**，
  **一轮里可以连发好几段**（说完不会自动交麦，点「结束发言」才换人）。
- 放逐投票、警长投票都有**「弃票」**；夜里轮到你行动时有**「不选」**（空守 / 空刀 / 空验 / 不魅惑）。
- **夜里被刀死也有遗言**；狼人夜里有一个**只有狼看得到**的队内频道，可以商量刀谁。
- **白痴翻过牌之后再被投出去也不死**（只播报"本轮放逐无效"）。
- **房主建房时自定义角色**：点「创建房间」弹窗里选 4–18 人，再给 14 种角色各填几个
  （例如"双预言家、没女巫、狼美人+守墓人"）。只强制 **总数 = 座位数** + **至少 1 只狼**；
  等候区会显示"本局角色：…"给所有人看。新角色默认 0 个，默认局仍是老 8 角色组合。
- 建房弹窗里可以关掉**警长**；关掉后第一天不竞选、没有警徽。
- 首页下面有「规则介绍」按钮：点开能看完整流程、胜负条件和 14 个角色技能，
  第一次玩的人不用先去翻文档。
- 建房可以设密码；**好友的房不用密码**（房里有一个你的好友就免密）。
- 等待房里：复制 6 位房号 / 邀请在线好友 / 房主开局。
- 好友邀请：对方页面弹邀请卡（昵称 + 房号），点「接受，进房」直接坐进去。
- 好友列表里能看到"正在玩狼人杀"，**没开局**能点「进入」；**开了局就显示"已开局"、
  点不进去**（用户明确要求：不做中途加入，也不做观战）。
- 打完一局：对局记录里有这一局，点进去是完整复盘（全员身份、夜晚行动、票型），
  记录在**服务器数据库**里，换设备、清缓存都还在。

### 接入要点（改的时候必须守住）

1. **身份只来自会话**：引擎里的 `Player.id` = 平台 `user.id`；客户端不传身份。
   `/api/werewolf/me` 返回的 `me` 就是平台 `publicUser`，头像 `/avatar/<id>`。
2. **一个账号同时只在一间房**：再进一次是回原座位（重连），不是多占一个位置。
3. **房间信号只有"叮咚"**：`WW_EVENT` 的 `data` 里不许出现任何人的身份/技能/底牌。
   客户端收到后自己再拉 `/game/status`（服务端按人裁剪过的）。
4. **隐藏信息只在 `viewFor()` 裁剪**：别人的 `role`/`alignment` 不出现，
   夜晚行动结果只发给当事人（预言家验人、女巫用药、守卫守谁）。
5. **密码只挡陌生人**：`canBypassPassword` = 本来在房里 或者 房里有我的好友。
6. **结算必须写库**：引擎 `onGameEnd` → `store.insertGameRecord` → `game_records`；
   复盘只读数据库、**只对参与者**开放。
7. **角色配置在建房时校验一次**：`validateRoleSetup()` 是唯一入口；
   引擎里任何地方都不要假设"一个女巫/一个守卫"——同角色可以有多个人，按各自的 `player.abilities` 算。
8. **定时器要清**：阶段倒计时、12 小时清扫都要在 `reset()` / 关房时清掉；
   漏了会让测试进程退不出去。

### 这个项目才有的坑

#### 1. 房号是 **6 位数字**，平台那套是字母码

平台的 `normalizeCode()` 字母表里**没有 0 和 1**，把狼人杀房号 `123456` 丢进去会判格式错。
所以狼人杀的房号**一律不经过 `normalizeCode`**：`hub.mjs` 的邀请分支、
`enterGame` 的跳转、`invite.reply` 的转发都单独走 `game === 'werewolf'`。

#### 2. 前端是 **Next.js 静态导出**，资源前缀是 `/werewolf`

`next.config.ts` 里 `basePath: '/werewolf'`，导出的 HTML 引用 `/werewolf/_next/...`；
平台把 `games/werewolf/dist` 挂在 `/werewolf/`，两边必须同时改。
`public/` 里的图片走 `NEXT_PUBLIC_BASE_PATH`（`buildAvatarUrl` 里也有兜底）。

#### 3. 阶段推进靠**服务端定时器**

倒计时到点自动 `endOfPhase`；测试用 `werewolfTimeoutScale` 把 180 秒缩成毫秒级。
玩家刷新页面不会重开一局：`/api/werewolf/me` 告诉他"你还在哪间房"，页面直接回牌桌。

#### 4. 同角色多人时，只有"轮到的那个人"能操作

房主可以配双女巫、双守卫、双预言家。引擎用 `g.night.actor` + `guardQueue/witchQueue/seerQueue`
让每个人**依次**行动，`can.witch/can.guard/can.seer` 只对当前那个人为真。
页面必须信 `can.*`，不要再用"我的角色是女巫"判断该不该出操作面板 ——
否则两个女巫同时看到面板，先点的那个动完，另一个点了会被服务器拒绝，玩家会以为是 bug。

#### 5. 上游的 AI 部分**不要往回捡**

`app/src/components/seo` / `analysis` 等目录虽然还在源码树里（没被页面 import），
但**不要再接线**；`public/` 里的 TTS/模型/复盘素材已经删除。加回来等于把服务器变成 LLM 网关。

#### 6. "不选"必须是显式 `null`，⛔ 不要过 `Number()`

`Number(null) === 0`，所以 `const target = Number(body.seat)` 会把"弃票/空守/空刀/空验"
悄悄变成 **0 号位**。每个角色的分支都要先判 `body.seat === null`。
空守还要清掉连守记录（否则"不能连守同一个人"会跨空守生效），
空刀要从 `g.night.wolfVotes` 里删掉自己那一票（狼队按多数决）。

#### 7. 真浏览器测牌桌要"等 DOM"，不能拿接口状态直接断言

页面更新链路是 `WW_EVENT（只是叮咚）→ 客户端重新拉 /game/status → 重渲染`，
比接口慢一两个 round-trip：`tests/werewolf.browser.mjs` 里对 DOM 的断言一律用
`page.waitFor(...)`（先看到"轮到我了"，再等输入框出现）。
另外 `page.type` 是逐字派发，几秒钟就把发言倒计时耗光（假失败）—— 用
`document.execCommand('insertText', false, text)` 一次插入。

### 已知边界

- **手机能用，但没有专门优化**：375px 实测不横向溢出，但没做伪横屏外壳。
- **不做中途加入、不做观战**（用户拍板）。
- **房主走了房子就散**：等待阶段房主离开会顺位交给下一个人；走空就删房。
- **一局最长 12 小时**；结算后的房间还会留 1 小时（复盘已经进数据库，不依赖它活着）。

## 斗地主（`games/ddz/`，**牌桌是上游的 Godot 网页导出**，规则在服务器）

页面：`/ddz/`（登录门同 `/noname/`、`/werewolf/`）。它是**平台游戏**：房间、邀请、成员、
开始/再来一局全走 `shared/ui/room.js` + `server/rooms.mjs`；只是页面地址在顶级路径，
不在 `/games/<slug>/` 下（两套地址只能留一套，见 `docs/ARCHITECTURE.md`《斗地主》）。
手机走伪横屏外壳 `/play/ddz`（牌桌是 1280×720）。

### 上游是什么（`github.com/blmz/GODOT-DouDiZhu`）

Godot **4.4** + GDScript 的**单机**斗地主：你打两个弱 AI，规则、界面、AI 全搅在
`脚本/手牌管理器.gd` 里（发牌、判断牌型、比较大小、按钮回调都在一个文件）。
没有联网、没有账号、没有房间、**没有 LICENSE**（默认保留所有权利 → 自己家里玩可以，
不公开分发、不商用），也没有网页版构建产物。

所以我们保留它的**界面**（导出成网页版塞 iframe），把**规则**按它的口径搬到服务器
（`判断牌型()` / `是顺子()` / `是连对()` / `是飞机()` 逐条移植，中文牌型名都没改），
把它的 AI / 倒计时 / 商店页 / 开始页删掉（用户拍板：只三个真人）。

### 我们这一份怎么分工

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 规则/状态机（纯 ESM，零宿主 API） | `games/ddz/js/engine/cards.js` | 54 张牌编码（点数 3…15，小王 16、大王 17；花色 0–3）、洗牌、排序 |
| | `games/ddz/js/engine/rules.js` | `classify`（牌型识别）+ `canBeat`（比大小）。**服务器和浏览器 import 同一份** |
| | `games/ddz/js/engine/game.js` | 发牌 → 叫地主 → 抢地主 → 出牌 → 结算；`viewFor` 按人裁剪 |
| 平台接入层 | `server/games/ddz.mjs` | `meta` / `createMatch`，把座位表交给引擎、把意图转成 `act` |
| 页面（平台壳） | `games/ddz/index.html`、`js/online.js`、`css/table.css` | 页头身份、房间外壳、把视图推进牌桌、把牌桌的意图发回服务器 |
| **牌桌（上游界面）** | `games/ddz/table/` | Godot 网页导出产物（wasm + pck，9 个文件 51 MB）。**只画，不判规则** |
| 牌桌源码（要改才动） | `games/ddz/godot/` | 上游工程 + 我们改过的 `脚本/手牌管理器.gd`、`结算界面.gd`、`project.godot`、`export_presets.cfg` |

### 页面 ↔ 牌桌的桥（改 GDScript 必看）

| 方向 | 调用 | 说明 |
| --- | --- | --- |
| 页面 → 牌桌 | `FrpDdzTable.接上(onPush, onReset)` | GDScript 在 `_ready` 里交出回调（**不能**用 `set`，见下面坑） |
| 页面 → 牌桌 | `FrpDdzTable.推视图(json)` / `FrpDdzTable.重置()` | 每来一条 `room.state` 推一份 / 回等待态清桌 |
| 牌桌 → 页面 | `FrpDdzHost.动作(json)` | `{type:'bid'|'play'|'pass', …}` → 页面发 `room.act` |
| 牌桌 → 页面 | `FrpDdzHost.事件(名字)` | `'就绪'` / `'再来一次'` / `'退出'` |
| 牌桌 → 页面 | `FrpDdzHost.渲染(json)` | 观测用，存进 `window.__FrpDdzTable`（测试断言靠它，页面逻辑不读） |

### 规则口径

- 3 人、54 张：每人 17 张、底牌 3 张；随机一家先被问。
- **叫地主**：三家依次「叫 / 不叫」，第一家叫的人是候选；三家都不叫 → 重新发牌（最多 20 次）。
- **抢地主**：候选之后的两人依次「抢 / 不抢」，**最后一个抢的人当地主**（没人抢则候选当地主）。
- 地主拿底牌（20 张）并**先出牌**；一轮里另外两家都不出 → 回到上一手出牌的人重新领出。
- 牌型（照上游）：单/对/三/三带一/三带二/顺子(≥5)/连对(≥3 对)/飞机(**纯三张**)/炸弹/
  四带一/**四带二(四张+一对)**/王炸。顺子连对飞机只到 A（2 和大小王不能连）。
- **和上游唯一一处故意的差异**：`canBeat` 要求"同牌型 + 同张数 + 比点数，炸弹压普通，王炸最大"。
  上游只比头点数、不比牌型也不比张数（还默认客户端已排序），三家真人没法打。
- 地主出完 = 地主赢；任一农民出完 = 农民赢。**没有**春天/底分/倍数/倒计时（用户拍板）。

### 必须记住的约定

- **没有电脑**：`meta.maxBots = 0`。准备区**不画**「＋ 添加人机」、`botAdd()` 直接拒。
- **开局后进不来**：`allowMidJoin: false`。第四个人会看到"房间满了 / 已经开始"。
- **有人离开 = 本局作废**：`removePlayer` 直接 `phase: over` + `aborted` 原因
  （没有 AI 能接管手牌）。页面在退出时用 `confirm` 说清这一点。
- **一个账号只坐一个位**：开两个标签页是重连回原座位，不是多开。座位只从会话反查。
- **牌桌必须待在固定层里**（`.ddz-stage`，`position: fixed`），**绝不能**塞进 `FrpRoom` 的
  对局面板：面板每次 `room.state` 都整块重画，iframe 被搬动会让部分浏览器**重新加载**牌桌。
- **牌桌页 `/ddz/table/index.html` 也在登录门名单里**（和 `/ddz/` 一样未登录 302）。
  二进制资源（`.wasm`/`.pck`）**不拦** —— 拦了会在加载中途 302，表现成白屏。
- **`.wasm` 必须 gzip**（42 MB → 约 9 MB），`.wasm`/`.pck` 走 `public, no-cache` + ETag；
  `.pck` 不 gzip（上游已压过图片/音频）。重新导出后用户要**强刷**。
- **头像由浏览器代取**：Godot 解不了 SVG（平台默认头像就是 SVG），`js/online.js` 把
  `/avatar/<id>` 画成 96×96 PNG 放进 `players[].avatarData` 再推进去。
- **没有昵称输入框**：名字/头像/ID 来自平台会话；`?join=CODE` 由 `FrpRoom.mount` 自动入座。
- **页面用相对路径**（`css/table.css`、`js/online.js`），`/ddz` 301 到 `/ddz/`；
  `/games/ddz/**` 被 `candidatesFor()` 主动 404（一份目录只留一个地址）。

### 测试

`npm run test:ddz`：

- `games/ddz/tests/engine.test.mjs`（37 条）—— 牌型（含顺子到 A、连对 ≥3、纯飞机、四带二）、
  比大小（含炸弹/王炸/长度必须一致）、两阶段叫抢、整局能打完、`viewFor` 不泄漏别人的手牌、
  **`js/engine/` 里 `document`/`window` 命中数必须是 0**。
- `tests/ddz.test.mjs`（18 条）—— 真 HTTP + 真 WS：登录门（含牌桌页）、唯一地址（`/games/ddz` 404）、
  **wasm 的 gzip + ETag 协商**、三人座位、`maxBots = 0`、一整局打到结算、抢地主换人、
  有人离开作废、不是你的回合/出别人的牌会被拒。
- `tests/ddz.browser.mjs`（真 Chrome，四个 profile）—— 首页入口、好友邀请进同一个房、
  三块牌桌把 wasm 跑起来、牌桌显示平台昵称与服务器视图一致、**在 canvas 上真点「叫地主」**、
  打完一局三家都进结算、375px 不溢出、伪横屏外壳、电脑打开外壳回 `/ddz/`。

### 走过的坑（这次踩到/提前避开的）

- **Godot 的 `JavaScriptObject` 只转发方法调用**：GDScript 里 `表.set("推视图", 回调)` 会报
  `TypeError: obj[method] is not a function`（它去找 JS 上叫 `set` 的方法）。所以桥是
  "页面给一个方法 `接上(cb1, cb2)`"，GDScript 调它把回调交过去。
- **`get_interface()` 只认 iframe 自己那个 window**：Godot 跑在 iframe 里，父窗口上挂全局不算数。
  父页面必须 `iframe.contentWindow.FrpDdzTable = window.FrpDdzTable`（同一个对象，不是拷贝），
  并且 iframe `load` 之后再贴一次；GDScript 那边还要**轮询重试**（先到后到都能接上）。
- **GDScript 缩进错了就是解析错误**：`else:` 后面跟语句、tab 层级错一格，导出时才会报；
  改完 `.gd` 先 headless 导出一遍看有没有 `SCRIPT ERROR`。
- **改 `.gd` 不等于改牌桌**：必须重新导出 `table/`（步骤见 `games/ddz/README.md`）。
- **导出模板要单线程变体**（`web_nothreads`）：多线程版浏览器要求 COOP/COEP 头，
  隧道后面很难配；单线程版不需要。
- **别按整张卡片的文本找首页卡片**：无名杀的介绍里写着"武将包里有斗地主"，按文本找会认错卡
  （`tests/ddz.browser.mjs` 里改成看 `window.GAMES` 的 `href` + `#game-grid .game-card` 的标题）。
- **`FrpRoom.mount()` 会自己 `connect()`，但连上要时间**：页面打开就点「创建房间」，
  消息会被静默丢掉、界面看起来"点了没反应"。测试里必须先等 `GameNet.connected === true`。
- **点击类断言要容忍"第一次点空"**：无头 Chrome 里第一次 `click()` 偶尔落在事件还没挂好的那一帧
  （产品本身点得动）。测试里用重试循环，不要用"点一次就断言"。
- **底牌和打出去的牌都是公开信息**：地主 20 张里有 3 张底牌本来就在 `view.bottom` 里，
  "报文里不许出现别人的牌"那条测试要先把底牌/`lastPlay` 排除掉，否则会误报泄漏。

## 大富翁（`/games/monopoly/`，整份上游 Web 客户端 + WS 中转）

页面：`/games/monopoly/`（登录门同 `/ddz/`）；手机走 `/play/monopoly`（伪横屏外壳）。
**不是**平台房间游戏：没有 `rooms.mjs`、没有服务器权威规则，房间/成员/开始都由上游客户端
自己算，平台只提供**静态页面 + 账号注入 + 好友 presence/邀请 + WebSocket 中转 + 地图文件**。
设计决定见 **D41**（取代 D36）；源码/补丁/构建步骤见 `games/monopoly/README.md`。

### 玩家看到的样子

和上游 `FatPaper-1874/mine-monopoly` 的 Web 版一致：Bili 风大厅（联机房间 / 单人游戏 / 设置），
联机房间页有 2–6 个座位、选角色、选地图、准备、开始；开局后是 **Three.js 3D 棋盘**，
骰子/买地/盖房/股票/彩票等都在房主浏览器里跑。**我们没有重画任何 UI**。

### 我们这一份怎么分工

1. `games/monopoly/upstream/` —— 上游源码归档（GPL-3.0，**不是 fork**），
   约 21 MB，不含 `node_modules` / `dist`。
2. `games/monopoly/web/` —— 上游 `pnpm --filter @mine-monopoly/client build:web` 的产物，
   平台静态托管；**这个目录要提交**（和狼人杀 `dist/` 一样，服务器不装 node_modules）。
3. `games/monopoly/maps/` —— 5 张官方公开 `.mmmap` + 封面 + `manifest.json`，
   经 `/monopoly-maps/` 提供；**不发付费 `.fpmap` 源文件**。
4. `server/monopoly/index.mjs` —— 上游 `/monopoly-server/*` 兼容接口：地图列表/信息、
   `room-router` 的 join/emit-host/heart/status/delete/reclaim/公开房、地图 URL。
5. `server/monopoly/relay.mjs` + `server/ws.mjs` 的 `/monopoly-relay` —— PeerJS 兼容的 WS 中转
   （文本 JSON + 二进制地图分块），替代 WebRTC/TURN。
6. `server/monopoly-presence.mjs` + `server/http.mjs` 的 `/api/monopoly/*` —— 「正在玩」和邀请。
7. `apps/client/src/frp/{bootstrap.ts,relay-peer.ts}` —— 平台桥：注入身份、绕过上游登录、
   页面内邀请弹窗、PeerJS shim。**这是我们对上游的补丁，清单在 README。**
8. `server/hub.mjs` —— 邀请消息加 `game:'monopoly'`；`web/assets/js/*` —— 首页卡片/好友状态。

### 必须记住的约定

- **游戏逻辑在房主浏览器**（`GameProcessWorker`），平台不裁剪视图、不防房主作弊；
  这是上游模型，也是用户选它的原因。**不要**再把它改成服务器权威。
- **联机只走 7891**：`relay-peer.ts` 把 `peerjs` 的 `Peer/DataConnection` API 映射到
  `/monopoly-relay`；**不要**引入 coturn、公共 TURN 或上游 PeerServer。
- **账号必须是平台账号**：`window.__FRP_ME__` → `localStorage.user`，`userId` = 平台 ID；
  页面里没有起名/登录框。**不要把上游登录页放出来**。
- **邀请进房用 `?join=`**：平台好友卡片/邀请卡都跳到 `/games/monopoly/?join=房号`，
  由 `online-room-panel.vue` 自动 `joinRoom(..., { allowCreate:false })`；
  房间已关会提示"让好友重新建房后再邀请你"。
- **地图 key**：`MAP_ENCRYPT_KEY=rO8yZ3bM2bW9gA9u` 必须在**构建时**注入（`.env.frp`），
  换 key 等于所有 `.mmmap` 都读不了。
- **base path 是 `/games/monopoly/`**：`VITE_WEB_BASE_PATH` 或 `vite.config.ts` 默认值；
  上游默认 `/monopoly/` 不能用，否则资源全 404。
- **音频 URL 不能带 `.mp3/.ogg`**：IDM 这类下载器会把媒体请求当"可下载文件"抓进下载文件夹。
  页面走 `/monopoly-audio/sfx|bgm/<名字>`（无扩展名）+ `application/octet-stream`，
  Howler 仍用 Web Audio 解码；改音频时别把原扩展名 URL 加回去。
- **上游缺 4 个音效文件**（`success.ogg` / `info.ogg` / `notification.ogg` / `error.ogg`）：
  已从 `utils/audio/config.ts` 移除；别补空路径，也别从付费包里抠素材。

### 测试

`npm run test:monopoly` =
`tests/monopoly.test.mjs`（20 条：登录门/SPA 兜底/源码不泄漏/`__FRP_ME__` 注入/5 张地图/
room-router 生命周期与权限/relay 双向转发与 resume/401/presence/邀请/回执）+
`tests/monopoly.browser.mjs`（真 Chrome：登录门回跳、账号一致、好友「正在玩/进入」、
游戏内邀请→平台邀请卡→进房、两人选图/选角色/开始进 3D 棋盘、375px 伪横屏、桌面回真页面）。

### 走过的坑（这次踩到/提前避开的）

- **`?join` 被路由守卫吃掉**：`login → room-router` 跳转必须带 `query: to.query`，
  否则 B 收到邀请也进不了房。
- **`?join` 自动入房不能建房**：`joinRoom(room, { allowCreate:false })`；房已关要给人话，
  不能静默新建一个空房。
- **开始按钮"看起来能点"但房主拒绝**：上游改地图会让所有人 `isReady=false`，
  客户端 `canStart` 却把有 `roleId` 当准备。已改成和要求一致（只认 `isReady`），
  测试必须先选图、再让客人点准备。
- **邀请弹窗"发送"一直灰**：勾选好友只改了 `selected`，没更新 `send.disabled`；
  已加 `updateSendState()`。
- **客人页有两个 `.choose-role`**：房主卡片那个是 `aria-disabled`，测试要点
  `.choose-role.my-button`（自己的卡），点第一个永远不开弹窗。
- **角色列表来自地图**：先选图、等 `roleList` 解析完再点「选择角色」；空图时弹窗是空的。
- **手机真机验证**：`Page.setViewport(..., mobile=true)` 之后还要
  `Emulation.setTouchEmulationEnabled`，否则 `pointer: coarse` 为 false，外壳不旋转。
- **音效 404 不是错误**：无头浏览器控制台不会因此报错；别把它当白屏原因。


## 莲花广麻（`/mahjong/`，整份上游项目 + Python 后端反代）

页面：`/mahjong/`（登录门同 `/ddz/`）；手机走 `/play/mahjong`（伪横屏外壳）。
**不是**平台房间游戏：没有 `rooms.mjs`、没有服务器权威规则；房间/牌局/规则全在
**上游 Python 后端**（`127.0.0.1:8123`），平台只提供**静态页面 + 身份注入 + 好友
presence/邀请 + HTTP/WS 反代**。设计决定见 **D43**；源码/补丁/构建步骤见
`games/mahjong/README.md`。

### 玩家看到的样子

和上游一样：大厅（单机/联机、东风场/半庄场、白板癞子/翻精癞子）、3D 牌桌、
碰杠吃胡、买马、AI 补位；联机房间有 4 个座位、房间码、准备/开局。
**我们没有重画任何 UI**；账号就是平台账号——大厅显示「当前账号 xxx」，没有登录框、
没有昵称框。

### 我们这一份怎么分工

1. `games/mahjong/upstream/web/` —— 上游前端源码（MIT，**不是 fork**），
   不含 `node_modules`；最小补丁清单在 README。
2. `games/mahjong/web/` —— `npm run build` 的产物，平台静态托管；**这个目录要提交**。
3. `games/mahjong/backend/` —— 上游 Python 后端源码 + `.venv`（gitignore）。
   Node 用 `MAHJONG_PYTHON`（默认 venv）启动，等 `/api/health` 就绪。
4. `server/mahjong/index.mjs` —— 起/停 Python、`/api/health` 轮询、`/mahjong/api` 反代、
   `/mahjong/ws` 转发目标；**不改上游协议**。
5. `server/mahjong-presence.mjs` + `http.mjs` 的 `/api/mahjong/*` —— 「正在玩」与邀请。
6. `src/frp/bridge.ts` —— 页面心跳 + 房间内「邀请好友」浮层；`?join=` 自动进房在 `App.vue`。
7. `server/hub.mjs` —— 邀请消息加 `game:'mahjong'`；`web/assets/js/*` —— 首页卡片/好友状态。
8. `server/ws.mjs` —— `/mahjong/ws` 在握手期验平台会话，然后裸字节转发。

### 必须记住的约定

- **规则不搬**：上游 Python 后端是唯一规则实现；平台不解析麻将协议、不裁视图。
- **公网只有 7891**：Python 固定 `127.0.0.1:8123`，**不要**给它开第二条隧道或映射公网。
- **账号唯一**：`FRP_TRUSTED_HEADERS=True` 时后端只认 Node 注入的 `x-frp-user-*`；
  Node 每次反代都覆盖这三个头，浏览器伪造无效。页面的 `__FRP_ME__` 也必须来自平台会话。
- **邀请进房用 `?join=`**：平台好友卡片/邀请卡都跳到 `/mahjong/?join=房号`；
  页面补丁自动入房，进房后把 `join` 从地址栏删掉（刷新不重复进房）。
- **房号是上游的**：6 位大写字母/数字，不走平台 `normalizeCode`（字母表不同）。
- **邀请卡只在平台页面弹**：麻将页不连平台 WS（和大富翁同一模型）；
  页面里只有「发出邀请」，收到邀请后由平台跳转。
- **后端可缺席**：没 venv/起不来时麻将接口 503，其它游戏不受影响；麻将 Node 测试会 skip。
- **改 UI 必须重新构建**：改 `upstream/web/**` 后 `npm run build` 并覆盖 `games/mahjong/web/`，
  否则线上还是旧页面。

### 测试

`npm run test:mahjong` =
`tests/mahjong.test.mjs`（10 条：登录门/301/`__FRP_ME__` 注入/伪造身份头被覆盖/
未登录 401/建房加入准备开局/WS 反代 `rejoin_ok` + 快照裁剪/presence/邀请回执）+
`tests/mahjong.browser.mjs`（真 Chrome：登录门回跳、账号一致、大厅无昵称框、
建房、好友「正在玩/进入」、游戏内邀请→平台邀请卡→自动进房、375px 伪横屏、桌面回真页面）+
`tests/mahjong.join.browser.mjs`（单独起服务/浏览器：未登录打开 `?join=房号` → 注册 →
登录回跳 → 自动进同一个房；避免和别的 Three.js 页面抢无头 Chrome 导致网络卡死）。
测试固定用独立端口 8199 + 临时 SQLite，不碰线上后端（8123）。

### 走过的坑（这次踩到/提前避开的）

- **Python 依赖**：上游 `pyproject.toml` 声明了 `psycopg[binary]`，但默认 SQLite 根本不用；
  改成按需 import 后不装 psycopg 也能跑（否则新机器 `ModuleNotFoundError`）。
- **`uvicorn` 要装进 venv**：系统 Python 的 `fastapi` 不等于项目后端能跑；
  Node 用 `backend/.venv/Scripts/python.exe`，不要退回系统 python。
- **WebSocket 前缀要分开**：`/mahjong/ws/room/xxx` 转发前只去掉 `/mahjong`，
  得到 `/ws/room/xxx`；直接把 `/mahjong/ws` 当 strip 前缀会变成 `/room/xxx` 而 404。
- **`/mahjong` 的 301 必须在登录门前**：否则未登录访问会被 302 到登录页，
  登录回来地址少了尾斜杠，Vite 相对资源全挂。
- **前端 API 基址不能写 origin**：页面在 `/mahjong/` 下，REST 必须同目录
  （`/mahjong/api`）；写死 `location.origin` 会打到平台根上 404。
- **手机外壳的 load 事件不靠谱**：iframe 里是重前端，`Page.goto` 等 `complete` 会超时；
  测试里改成发导航后等 `#game`/iframe pathname。
- **邀请按钮要等房间 id**：平台桥只在「在房间且未开局」时显示按钮；
  测试必须等 `.room-code strong` 出现后再点。
- **Node 反代不能复用全局 keep-alive 连接**：uvicorn 会按空闲超时关连接，Node 池里留下
  半关的 socket 后，下一个请求会一直等到 30 秒超时才 502（表现为「偶尔建房点不动」）。
  `server/mahjong/index.mjs` 的 `httpRequest(..., { agent: false })` 每个请求新建连接。
- **测试要独立端口 + 独立库**：以前测试会「复用已在运行的真实后端（8123）」，把测试账号/
  房间写进线上库。现在固定 `mahjongBackendPort: 8199` + `MAHJONG_DB_PATH` 临时库。
- **登录回跳的 `?join` 是异步就绪的**：昵称/鉴权/`joinCode` 绑定可能比第一帧晚；
  App 会最多等 20 秒、每秒兜底重试，且只在输入框为空时补回房号。
- **无头 Chrome 多开 Three.js 页面会偶发网络卡死**：同一浏览器里先开两三个牌桌页再测
  「未登录 → 登录取房」会 fetch 永远 pending；所以这条链路放在
  `tests/mahjong.join.browser.mjs`，单独起服务和浏览器跑。

## AI 小镇（`/ai-town/`，Rust 世界内核 + 平台进程/房间层）

页面：`/ai-town/`（选镇/建镇）、`/ai-town/game.html?map=<镇>&room=<房号>`。
**不是**平台 `rooms.mjs` 的规则游戏：世界模拟、村民、存档都在上游的 **Rust host** 里，
Node 只负责**按用户拉起 manager/host 子进程、房间表、账号注入、HTTP/WS 反代、手机布局**。
设计决定见 **D48**。

### 玩家看到的样子

登录平台 → 首页「AI 小镇」→ 选一个镇（或新建）→ 进镇。房主可以：
- 直接开**自己的存档**（每个平台账号一份，退出即保存）；
- 在镇里邀请好友，好友从邀请卡/房间号进**同一张图**。

账号就是平台账号：入口页/游戏页左侧贴着一个**平台头像悬浮球**（平时只露半边，不挡画面）；
点一下才展开头像/昵称/邀请/返回卡片，再点球或点空白收起。球可以拖到任意位置，
松手自动吸附最近的左右边并恢复半隐藏；拖动位置只记当前这次打开，刷新回左上角。
手机上的球比电脑小一点。化身默认用平台昵称；
**没有第二个登录框，也没有玩家聊天**（村民的对话是游戏 AI，不是玩家聊天）。

房主和**每个客人都有自己的化身**，都能「进入化身」在小镇里走、和村民说话；
每个人的头顶上方有一条 22px 的**平台头像圆点 + 昵称**，别人一眼能认出来。
世界设置（开始/暂停、速度、天气、请村民）只归房主；客人点这些会被拒绝，
手机桥也把「开始/暂停」「设定」「居民管理」和空镇「请村民」卡片对客人隐藏。
**房主要先点顶栏「开始」**，世界时间才会走，
客人也才能走动；客人可以先下来等。

### 我们这一份怎么分工

1. `games/ai-town/upstream/` —— 上游源码（**不是 fork**）。Rust 改动：
   - `crates/host/src/builtin.rs`：llama.cpp 新版不认 `--no-mmap`，改 `--load-mode none`；
   - `crates/host/src/world_settings.rs` + `main.rs`：新镇没写世界观时给一份默认说明，
     否则玩家一进镇就被「请先设置世界观」拦住，化身的任何命令都下不去；
   - **多人化身**：`kernel/src/avatar/*` 支持多个玩家 actor（访客 ID `guest:<平台ID>`）、
     `host/src/network.rs` 从 WS 握手注入平台身份、`host/src/avatar/guest.rs` 给每个访客
     独立租约/方向输入、`host/src/avatar/tick.rs` 各自移动；`protocol::RosterMember.avatar_url`
     让头顶带平台头像。访客命令白名单与存档过滤也在这一层。
2. `games/ai-town/bin/town-manager.exe` / `town-host.exe` —— `cargo build --locked -p host -p manager --bins`
   的产物（`host.exe` 复制成 `town-host.exe`，`HOST_BIN` 按这个名字找）。**不进 git**。
3. `games/ai-town/web/` —— 前端构建产物（Vite `base:'/ai-town/'`）。**要提交**，开箱即用。
4. `games/ai-town/upstream/builtin-model/` —— llama.cpp 的 Vulkan Windows 包
   （`llama-server.exe` + `ggml-vulkan.dll` 等，约 99MB）。**不进 git**，换机器按 `DEPLOY.md` 放回。
5. `data/ai-town/models/model.gguf` —— 内置小模型（约 505MB，**不进 git**）。
   `.sha256` 必须和上游清单一致。
6. `server/ai-town/` —— `config` / `manager` / `rooms` / `presence` / `index`：
   - 一个平台用户一个 manager 进程（`--root data/ai-town/users/<平台用户ID>`）；
   - manager 的 `/api/towns/<id>/open` 返回 `endpoint`（上游随机端口 + `?session=`）和
     `lease`；**平台只把 endpoint 换成同源 `/ai-town/ws?room=&sid=`，lease 只给房主**；
   - 房间号是平台自己的 6 位码（不是上游 town id），一个房间最多 4 人；
   - 同时最多 2 个世界、2 个 manager（`AI_TOWN_MAX_ROOMS` / `AI_TOWN_MAX_MANAGERS`）。
7. `web/ai-town-bridge.js` —— 注入到两个页面：平台账号悬浮球（半隐藏/点开卡片/可拖吸附）、
   房间号、邀请好友浮层、15 秒心跳（`/ai-town/api/platform/state`）。**它不碰世界协议**。
8. `server/hub.mjs` / `web/assets/js/*` —— 好友「正在玩 AI 小镇」、邀请、首页卡片。
9. `server/http.mjs` —— `/ai-town/` 静态托管 + 登录门 + 注入 `window.__FRP_ME__`/桥脚本/
   全屏/音频防下载；`/games/ai-town/**` 一律 404（上游源码不暴露）。
10. `server/ws.mjs` —— `/ai-town/ws` 前缀代理：握手期验平台会话 + 房间票据，
    再按房间找 host 随机端口，裸字节转发；**不解析上游世界协议**。

### 账号、存档、房间

- **账号绑定**：页面没有昵称输入，`__FRP_ME__` 来自平台会话；化身默认名字是平台昵称。
- **存档**：`data/ai-town/users/<平台用户ID>/towns/<镇ID>/`，退出/关镇时 host 写
  `world.json`；每个账号独立，换账号看不到别人的存档。
- **房主开新图/旧档**：入口页列的是当前账号自己的镇；房主开哪个，客人就进哪个。
  **客人的存档不落盘**（客人是来房主的世界里玩，客人自己的化身/位置不会写进房主存档）。
- **邀请**：好友列表「邀请」→ 平台邀请卡 → `/ai-town/?room=<房号>` → 自动加入并跳游戏页。
  房间号也可直接发；没开「允许加入」时必须房主邀请。
- **关镇**：房主退出 = 保存并关镇，所有客人一起断开；客人退出不影响房主。
- **同一个人**同一时间只在一个房间里；换房会自动退出上一个。

### 手机端

- 窄屏（≤719px）/ 触屏自动切上游的手机布局；页面有平台统一的可选全屏按钮。
- 手机没有键盘，但**地图本身支持点击**：点地面走路，点人或东西走过去并互动；
  不再额外显示摇杆、互动、换目标键，只保留右下角「背包」和右上角「布局」
  （上游 `town-shared/src/avatar/touch.ts` 已精简）。
- **自定义布局**：「布局」→ 拖动背包、滑杆调大小 → 「完成」。
  布局按**平台账号**存在服务端（`user_layouts`，`kind='ai-town/controls'`），换手机/刷新都还在；
  旧账号存过的四键布局仍保留，只读取/调整其中的背包，其他三个忽略；
  坐标归一化到 0–1，尺寸 44–160px，服务端会夹住越界值。前端落位时还会按当前视口
  再夹一次，竖屏/转屏不会让背包有一半跑出屏幕。
- 手机只渲染画面、不发模型请求；推理全在服务器。

### 内置小模型（服务器端）

- 模型：`data/ai-town/models/model.gguf`（约 505MB），推理程序：
  `games/ai-town/upstream/builtin-model/llama-server.exe`（Vulkan）。
- manager 建用户目录时把共享模型**硬链接**到
  `data/ai-town/users/<id>/builtin-model/model.gguf`（跨盘才复制），
  这样每个 host 的 `builtin_model_store` 都能找到模型，而磁盘上只存一份。
- 村民第一次真正要用模型时，host 才在本机起 `llama-server`（随机端口），
  世界进程退出/关镇时一起停；**手机端不下载、不加载模型**。
- 实测：RTX 5060 Laptop 独显（Vulkan0）加载约 8 秒、显存约 0.6GB，
  `/completion` 16 token 约 130ms；780M 核显是 Vulkan1，默认优先独显。
  **完整链路也真跑过**：真 llama-server 加载模型 → 三位村民入住 → 世界开始 →
  村民通过 `resident-agent-*.jsonl` 得到 `"provider":"builtin"` 的回复 → WS roster 把
  `speech` 推到浏览器；单次约 20 秒内看到第一句（冷启动最长给 150 秒）。
- 模型缺失/下载不完整时 host 会在 `logs/builtin-model.log` 写原因；游戏仍可进，
  只是村民不行动。

### 已知限制（当前版本，必须诚实说明）

- **世界设置只归房主**：客人可以自由走、对话、使用自己的背包；但不能开始/暂停世界、
  改速度/天气/请村民。这是有意的权限边界，不是没做完。
- **客人不存档**：房主退出时只保存房主自己的化身和世界，访客 actor、访客互动和
  访客日志被过滤；客人想保存自己的镇，就自己开一个房。
- 同一张图最多 4 人；同一时间最多 2 个房间（两个 manager/host）。两个房间同时跑
  真模型时的显存/内存峰值还没压测。

### 测试

`npm run test:ai-town` = `tests/ai-town.test.mjs`（4 条，真 manager/host/WS）：
登录门 + 源码不泄露；房主开镇 → 客人加入 → 两人连同一个 host、**客人生成 guest 化身、
头顶平台头像/名字、两人不重叠、客人改世界速度被拒** → 关镇保存 → 重开存档确认
**客人化身/名字不在存档里**；不同账号的存档目录互不串；布局保存/夹值。
默认用 `AI_TOWN_MOCK_LLM=1`，世界/日志放临时目录（`AI_TOWN_DATA_DIR`），不碰真实用户数据。

真内置模型是另一条**可选真机测试**：

```powershell
$env:AI_TOWN_REAL_MODEL='1'
npm run test:ai-town-model
```

它会真起 `llama-server`、开镇、请三位村民、开始世界，等到第一句 `speech`，
并检查 `logs/builtin-model.log` 有 `model loaded`、`resident-agent-*.jsonl` 有
`"provider":"builtin"`。没有模型/显卡的机器默认跳过，不影响 `npm test`。

真浏览器手工验证过：入口/游戏页无控制台错误、双页面同时「进入化身」、客人方向键移动后
房主画面同步移动；手机进入化身后只有「背包」+「布局」，旧的摇杆/互动/换目标 DOM 不存在；
旧账号四键布局里的背包坐标/尺寸照常生效；布局面板只调背包，改成 120px 点「完成」后
服务端读回 `bag.size=120`，其他旧键的值不动；竖屏默认背包不越界。
悬浮球也实测：收起时球左边缘 -22px（44px 球只露一半）、点开卡片、点球收起；
拖到右侧松手吸附到屏幕右边缘半隐藏，再点开面板在球的左边且不出屏；手机 390px 宽时
球变 38px，仍只露半边。电脑端鼠标可从半隐藏球拖到右边并吸附（v10）。

### 走过的坑

- **`--no-mmap` 被 llama.cpp b11871 删了**：host 起推理直接退；改 `--load-mode none`。
- **新镇没有世界观**：化身命令全部被拦；默认补一份世界观（见上）。
- **`host.exe` 名字不对**：manager 的 `HOST_BIN` 找 `town-host.exe`，cargo 产出 `host.exe`；
  构建后复制一份，别只改配置。
- **方向输入曾经绕过访客路由**：`main.rs` 原来直接调 `runtime.avatar_input()`，访客推摇杆
  只动了房主租约；改成 `avatar_input_from()` 按身份分派。
- **化身不能再把自己当障碍**：加入“化身之间不重叠”后，`avatar_obstacles()` 必须排除
  当前正在走的 actor，否则一步都走不动。
- **上游 endpoint 不能直给浏览器**：里面有 `127.0.0.1:随机端口` 和 `?session=`；
  平台换成同源 `/ai-town/ws?room=&sid=`，票据 10 分钟过期，WS 握手再验一次。
- **lease 不能给客人**：`browserEntry` 对非房主会删 `lease`；客人 POST 改存档/重置/删镇
  一律 403（GET 地图仍可）。
- **刷新会重新 open**：host 重启端口会变，所以 WS 目标端口在 upgrade 时才查，浏览器 URL 不变。
- **模型硬链接只对新用户目录生效**：旧测试目录没有 `builtin-model/model.gguf` 时，
  重开一次镇/删用户目录让它重新准备。


