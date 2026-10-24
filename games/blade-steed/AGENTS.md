# 刀马 BladeSteed — 接续说明（给 AI agent 的项目上下文）

> ⚠️ **2026-10-23：`tools/check-game.mjs` 与 `docs/GAME-SPEC.md` 已删除**（平台后续按"缝上游"走）。
> 下面凡是提到它们的地方，按下表替换后再看：
>
> | 原来写 | 现在用 |
> | --- | --- |
> | `node tools/check-game.mjs blade-steed` | `node --test games/blade-steed/tests/rules.test.mjs` + `node --test games/blade-steed/tests/online-ai.test.mjs` |
> | `... --browser` | 再加 `node games/blade-steed/tests/browser.e2e.mjs`、`browser.size.mjs`、`browser.identity.mjs` |
> | `docs/GAME-SPEC.md 第 N 节` | `docs/ARCHITECTURE.md` 的「游戏模块接口（服务器权威）」 |
>
> 这份文件是**这个游戏**的上下文：规则要点、踩过的坑、改哪里要跑什么。
> 平台级的规矩（端口、隧道、存储、协议）看工作区根目录的 `AGENTS.md`。

## 这个游戏是什么，从哪来的

2–4 人武侠猜拳：每回合同时猜拳，赢的人拿行动步数（买刀 / 买马 / 出城 / 进城 / 砍人 / 踹人），
把别人打到 0 血，最后活着的人赢。

它是从 `C:\Users\produce\Desktop\WorkSpace\BladeSteed`（原项目，GitHub Pages 还挂着）
搬进平台的。**原文件夹是只读的，一个字都不要改。**
两边的差别只有"谁在跑引擎"：

| | 原项目 | 搬进来之后 |
| --- | --- | --- |
| 联机 | 公共 MQTT broker + WebRTC 信令（因为玩家没有服务器） | 平台的服务器进程（`server/games/blade-steed.mjs`） |
| 房间 / 好友 / 邀请 / 名字 / ID | 自己写的大厅 | 平台提供（`/shared/ui/room.js`、`GameNet.me`） |
| 单机人机 | 浏览器里跑引擎 | 一样（`js/ui/local.js`） |

## 目录结构

```
index.html          全部界面（首页 / 人机设置 / 在线 / 牌桌 / 规则），靠 .screen.is-active 切换
css/style.css       本游戏全部样式（配色、牌桌、地图、特效）
js/engine/          规则引擎：纯状态机，零 DOM  ← 服务器 import 的就是这几个文件
  constants.js        数值与枚举（10 血 / 刀 1 / 踹 3 / 10s·15s·60s …）
  rng.js              可注入的随机源（测试和自对弈要用固定种子）
  rules.js            legalActionsFrom(视图) —— **"有哪些操作可以选"的唯一实现**
  engine.js           Match 状态机本体 + handleAct 意图信封
js/ai/ai.js         AI 决策：只吃 viewFor 的结果，零 DOM  ← 服务器也能用
js/view.js          viewFor(状态, 看的人) —— 裁剪视图（两档：给玩家 / 给 AI，差一个 isAI）；不在名单里的人返回 null
js/ui/
  app.js              界面主控：屏幕切换、偏好、单机人机流程（页面入口）
  online.js           联机胶水：FrpRoom.mount + renderSetup + renderGame + 超时催办
  board.js            牌桌渲染（地图 + 状态条 + 播报 + 行动面板）—— 单机与联机共用
  local.js            单机人机驱动：浏览器里推进引擎、给 AI 排延迟
  map.js              SVG 地图（城 / 野外 / 头像 / 血条 / 装备）
  effects.js          特效（砍、踹、飘血、播报横幅）
  audio.js            WebAudio 现场合成音效（没有音频文件）
tests/
  rules.test.mjs      规则单测 36 条（含"视图不泄露""逐步同步的补丁不许带别人的拳"与"接入层契约"）
  online-ai.test.mjs  人机作为**房间座位**的 15 条（1 人 + 1/2/3 个 isBot 座位不催 tick 打完一整局、
                      AI 的拳不泄露、isBot 不许进报文、名字来自单字池、座位不够给中文）
  sim.mjs             AI 自对弈 12000 局（查死锁 / 非法动作 / 胜率偏向）
  browser.e2e.mjs     真浏览器端到端（含两个真客户端联机打一局、一个人按「＋ 添加人机」开局、
                      座位不够点开始 → 界面上弹拒绝提示条、头像热区实测、360px 体检、
                      "不做本地预演"、"演出期间锁输入"、"出拳那一声只响我自己那一票"
                      （逐步数振荡器）几条关键防线；另有 **3b 偏好只有一份**、
                      **5b-1 演出期间不暗屏**、**5d-4 逐步同步**、**5d-5 倒计时**、
                      **5d-6 对局记录不被重画顶回第一条** 几条平台/用户点名的用例
                      —— 见第 14 / 15 / 16 / 17 条）
  browser.identity.mjs 身份"瞬间可见"：WebSocket 与 `/api/me` **两条路一起掐死**，
                      首页仍要显示名字/ID（缓存的那份），且一次都不许写"正在确认身份…"
                      （第 16 条；平台体检会逐个跑 `tests/browser*.mjs`）
  browser.size.mjs    真浏览器尺寸实测：4 个竖屏视口 ×（单机 4 人局 / 联机 2 人局），
                      打印"地图宽高 / 头像直径 / 热区直径 / 最小可点目标"四列，
                      并验"热区没被 SVG 视口裁掉""城与城不叠"—— 放大/缩小地图之后跑它
  screenshots/        e2e 跑出来的截图
```

`js/ui/map.js`、`board.js`、`local.js` 是 GAME-SPEC 骨架之外的三个文件：它们都是"界面实现细节"，
塞进 `app.js` 会变成一千多行一个文件，所以按职责拆开了。**骨架里点名的文件一个不少。**

## 关键约定（改错就会出事）

### 1. 三条铁律怎么落地的

- **铁律一（引擎零 DOM）**：`js/engine/**` 和 `js/ai/**` 里 `document.` / `window.` 命中数必须是 **0**。
  `server/games/blade-steed.mjs` 直接 import 这两个目录，谁顺手在里面写一句 `window.xxx`，
  **整个服务器进程会起不来**（不是这个游戏一个人的事，是全部游戏都挂）。
  `js/view.js` 也保持零 DOM —— 它同样被服务器 import。
- **铁律二（只读 view）**：`legalActionsFrom` 和渲染都只吃 `viewFor` 的结果。
  ⚠️ **单机人机也必须先过一遍 `viewFor(state, myId)`**（`js/ui/local.js` 的 `view()`），
  不能因为"手里有完整 state 就顺手画对手的手牌" —— 那条路一旦走通，联机时就会有人照着抄。
- **铁律三（操作只有一个来源）**：`js/engine/rules.js` 的 `legalActionsFrom(view, selfId)` 同时喂给
  三处：界面按钮（`board.js`）、服务器校验（`engine.js` 的 `_applyAction`）、AI 决策空间（`ai.js`）。
  **别在任何一处自己再写一遍规则**，`tests/rules.test.mjs` 有一条"三处判定必须完全一致"的用例。

### 2. 意图信封：单机与联机唯一的操作入口

客户端只发这四种信封（`js/engine/engine.js` 的 `handleAct`），单机与联机**发的是同一个对象**：

| 信封 | 含义 |
| --- | --- |
| `{ kind:'rps', choice:'rock'\|'paper'\|'scissors' }` | 出一手拳 |
| `{ kind:'order', order:[id,…] }` | 决胜者指定行动顺序 |
| `{ kind:'act', type:'buy_knife'\|'buy_horse'\|'move_out'\|'move_in'\|'knife'\|'kick'\|'pass', target? }` | 花一步行动 |
| `{ kind:'tick' }` | 催一下超时（见下一条），永远返回 `{ok:true}` |

失败一律返回 `{ ok:false, message:'中文原因' }` —— `message` 会**直接显示给玩家**，
所以它必须是中文人话，不要写 `"invalid action"`。
（引擎内部原来是 `{ok, error}`，接入层用 `wrapResult()` 统一转成 `message`；
改引擎的返回值时别忘了这一层。）

### 3. ⚠️ 超时是**客户端驱动**的（本游戏自己补的机制，平台上没有）

`server/rooms.mjs` **没有 tick 钩子**：房间层只转发操作、广播状态，从不替游戏走时钟。
所以「猜拳 10 秒不出拳就随机代出」这类规则必须有人推：

- `js/ui/online.js` 的 `scheduleTick()` 在**本阶段快到点时**（`deadlineIn + 400ms`）发一条 `{kind:'tick'}`，
  服务端 `tick()` 之后广播新状态。
- **每个客户端都会排这个定时器，谁醒着谁推** —— 所以房主切后台、锁屏，也不会把全桌卡死。
- ⚠️ **不要改成每秒心跳**：房间层每次广播都会让所有客户端重画牌桌，
  每秒心跳 = 每秒重画一次，手机上又烫又费电。正确做法是"只在到点前排一次"。
- ⚠️ 发 tick 之前**必须再查一次** `GameNet.room.phase === 'playing'` 和视图不是 `over`：
  最后一手可能刚好把这一局打完，此时再发 tick 会收到一条「现在不能操作」的报错提示条。
  这个竞态窗口很小，但没有完全消除 —— 见到一条偶发提示条属于已知现象，不是新 bug。
- 单机不需要 tick：`js/ui/local.js` 每 250ms 调一次 `engine.tick()`。

### 4. 联机牌桌的容器每次都是新的（⚠️ 最容易写出"动画每次都重头播"的地方）

`FrpRoom.render()` 每次收到 `room.state` 都会 `UI.clear(panel)` 再调 `renderGame(host, view, ctx)`，
**而且 `renderGame` 运行时那个 `host` 还没插进文档**。所以：

- `js/ui/online.js` 里的 `this.root` 是**常驻元素**，每次只是 `host.append(this.root)`。
  ⚠️ 如果改成在 `renderGame` 里 `host.replaceChildren(...)` 重建牌桌，
  正在播的刀光/踹腿动画会被砍断，头像的位移补间每帧重新开始（看起来像卡住）。
- 同理，`js/ui/map.js` **只用 SVG 的 viewBox 用户坐标，绝不量像素**
  （不调用 `getBoundingClientRect`）。因为在文档外量出来全是 0，
  一旦有人图省事改成"按容器宽度算半径"，联机第一次渲染就会画歪，单机（在文档里）却是对的 ——
  这种"只有联机错"的 bug 最难查。
- 联机牌桌的**高度**也不能靠 flex 撑（它住在房间外壳里，不是整屏）：
  `.online-board .map-wrap { height: min(50vh, 360px); min-height: 220px }`，在 `css/style.css` 末尾
  （原来是 `min(46vh, 320px)`，用户嫌地图小，2026-10 放大的，见第 13 条）。
- ⚠️ **同一个"常驻元素被摘出文档"还会让滚动位置归零**：对局记录那条 `.log-strip` 每次
  外壳重画都会被顶回最旧一条（用户实机报的 bug）。修法与纪律见**第 17 条** ——
  元素一旦离开文档，`scrollTop` 的赋值就是无效操作，必须在它**重新进文档之后**再钉一次。

### 5. ✅ 曾经的平台坑：点了「离开」之后房间界面停在原地（**已平台侧修掉**）

> **captain 在三个游戏都搬完之后修掉了**：`server/rooms.mjs` 的 `leave()` 现在会给
> 离开的人单独补一条 `{t:'room.state', code:null}`，客户端（`shared/net/net.js`）
> 靠"房号是不是空的"判断自己在不在房里。
> 所以本作的 `_bindLeaveWorkaround()`（1.2 秒没新状态就重载页面）**已经删掉了**（平台修好之后它就是死代码，留着反而可能在正常离房时误重载页面）。
> **新游戏别抄这个模式**：游戏侧兜底平台 bug 时，一定在注释里写清"平台修好之后把这段删掉"。
> 回归防线在 `tests/server.test.mjs`（"离开房间的人会收到一条'你不在房里了'"）
> 和 `tools/check-game.mjs --browser`（点【离开】必须回到入口）。

下面是当时的原始记录，留作教训：

实测结论：`server/rooms.mjs` 的 `broadcastState()` 只遍历 `room.members`，
而 `leave()` 先把人从 `members` 里删掉再广播 —— **离开的人永远收不到"你已经在房间外了"这条消息**
（`server/hub.mjs` 的 `ROOM_LEAVE` 也没管返回值）。
于是 `GameNet.room` 一直是旧对象，房间界面停在原地，再点一次只会弹「你不在任何房间里」。

根因在 `server/rooms.mjs` + `server/hub.mjs` + `shared/net/net.js` 三个**平台文件**里，
游戏不许改它们。所以 `js/ui/online.js` 的 `_bindLeaveWorkaround()` 在自己能改的地方收尾：
点过「离开」之后 1.2 秒内如果没有任何新状态，就干净地重载页面。
（只要服务端推了新状态，`GameNet.room` 就会换对象，这个兜底就不会触发。）
> **这段兜底代码现在已经删掉了**（平台侧修好之后它就是死代码），见上面 ✅。

### 6. 准备区的设置项

`js/ui/online.js` 的 `renderSetup()` 现在只画**本游戏**剩下的一项设置：

- **对局中途允许 / 不允许别人进来**（`ctx.setOption('allowMidJoin', v)`，服务端读 `options.allowMidJoin`）。

房号、成员、**人机座位**（含「＋ 添加人机」/「移除」）、邀请、开始、离开这些
**一律由 `/shared/ui/room.js` 画**，不要自己写一套。

> **⚠️ 已作废：原来这里还有第二项「补几个电脑」**（`ctx.setOption('aiFill', n)`，
> 服务端读 `options.aiFill`，范围 `0 .. 4 - 真人人数`，默认 0；非房主看一行只读文字
> `电脑补位：N 个（房主决定）`）—— 整段删掉了。
> **为什么删**（用户明确要求，见 `docs/DECISIONS.md` D9）：选数字的界面上，玩家**看不到
> 自己选了什么**，得先记住"我选了几个"再抬头看座位；而且那时人机不是成员，成员列表里根本没有它。
> 现在人机是**房间的座位**：按一下「＋ 添加人机」就多一个座位，所见即所得。再画一排"补几个"
> 就等于给了玩家两个互相打架的入口 —— 别把那套抄回来（`mount({ options: { aiFill: 0 } })`、
> "一个人时至少要补 1 个电脑才能开局"那句提示，都是旧写法）。

⚠️ `FrpRoom.mount()` 的 `minPlayers` **必须由游戏传**：`shared/ui/room.js` 里用的是
`cfg.minPlayers || 1`。本作传的是 **1** —— 房间层只数**真人**，一个人也能建房。
⚠️ 但"能不能开局"看的是**座位数**（真人 + 人机，`meta.minSeats = 2`）：一个人、零人机时
「开始游戏」是**灰的**，旁边那行字（房间层画的）写着"至少要 2 个座位才能开始（现在 1 个）。
按「添加人机」补一个，或者等朋友进来"。**这两个数不是一回事，别合成一个常量**（见第 8 条）。

⚠️ 服务端的拒绝（"座位不够：…"）由平台负责显示成界面上的提示条：
`shared/ui/room.js` 的 `mount()` 里有一条 `Net.on(T.ERROR) → UI.toast()`。
**本游戏不要再自己加一条 `Net.on(T.ERROR, …)`** —— 同一条消息会弹两次。
（本作 `js/ui/app.js` 的 `_bindNet()` 里**原来有一条**，是平台统一监听之前留下的；
两条会同时命中，实测会弹出**两条一模一样的**提示条，所以那条已经删掉了。
回归防线：`tests/browser.e2e.mjs` 的 5d-0 断言提示条**恰好一条**。）

⚠️ 准备区的**重画**由房间层去重（`shared/ui/room.js` 的输入指纹没变就不重画），
所以别把"重要副作用"挂在 `renderSetup` 里 —— 它可能不会被调用（见第 11 条最后一段）。

### 7. 身份、名字

名字与 ID 来自平台账号（`GameNet.me`），**游戏内不问名字**：
源的取名字界面、`constants.js` 里的 `isValidName` / `normalizeName` 都删掉了。
如果你从原项目复制代码回来，发现 import 了这两个函数 —— 那说明你复制了旧版本，
服务器加载这个游戏模块时会直接失败（导入不存在的导出），`node tools/check-game.mjs blade-steed` 会报出来。

### 8. 人机是**房间的座位**（`options.aiFill` 已作废）

**新契约**（用户明确要求，见 `docs/DECISIONS.md` D9 与 `docs/GAME-SPEC.md` §4）：

- 房主在房间壳上按一下「＋ 添加人机」→ 房间层多一个**座位**（`room.bots`，id 形如 `bot:1`）；
  按「移除」撤掉；座位条上写着「座位 2 / 4」。
- `server/rooms.mjs` 调 `createMatch(players, options)` 时，`players` **包含人机座位**，
  每项形如 `{ id, name, isHost, isBot }`；`isBot: true` 的就是 AI 座位。
- `server/games/blade-steed.mjs` **一个字节都不读 `options.aiFill`**，只把 `isBot` 映射成引擎的
  `isAI`（座位条目里**不许**出现 `isBot`）。
- 人机的名字来自 `meta.botNames`（= `js/ai/ai.js` 导出的 `AI_NAME_POOL` **单字池**，
  房间层的 `pickBotName` 挑房里没人用过的那个字）。**别再抄一份字面量**，也别再叫「电脑1」。

**五条必须守住的规矩**（细节都在 `server/games/blade-steed.mjs` 的注释里）：

1. **服务端同步驱动，不许用定时器。** 每次状态变化（开局 / 真人操作 / 催办）返回之前，
   把 AI 的义务全部跑完（`runAi()` → `aiStep()`），一直跑到"该真人了"或分出胜负。
   漏一处，客户端就永远停在"等待对手行动"。
2. **"所有人同时猜拳"这个游戏要在每一轮开始时就把 AI 的拳定下来**
   （`submitRps`）—— 不然真人出拳之后这一轮会卡在"等 AI"，只能等 10 秒超时。
   所以 AI 永远显示"已出"，最后一个提交的必定是真人，服务端不等任何客户端。
3. **客户端催服务的 `{kind:'tick'}` 机制仍然要保住**（真人挂机时的超时全靠它），
   只是 AI 不再依赖它。
4. **座位数与上下限**（`server/games/blade-steed.mjs` 的 `meta`）：
   `minSeats = 2`（**总座位**下限，含人机，也就是引擎的 `MIN_SEATS`）、
   `maxPlayers = 4`（地图只有 4 座城）、`minPlayers = 1`（**真人**下限 —— 房间层只数真人）。
   ⚠️ **minSeats 和 minPlayers 是两个数，别合成一个**：房间层用前者算"座位够不够 / 开始按钮
   亮不亮"，用后者判断"真人够不够"。
   ⚠️ **"开局前人机给真人让位"这条已经上移到房间层**了（`rooms.mjs` 的 `join()` 会顶掉
   *最后加的那一个*人机）：接入层不再算"还能补几个"，它拿到的就是最终座位表，
   只需要在"有人绕过房间层直接塞 1 个座位"时给一句**中文**拒绝
   （`座位不够：至少要 2 个座位（现在 1 个）`）。
   ⚠️ 旧的"`aiFill` 缺省就兜底补到 2 个座位"**绝不能**再回来：`tools/check-game.mjs` 现在拿
   **恰好 `meta.minSeats`（=2）个座位**调 `createMatch`，兜底那条路已经没人走了。
5. **AI 的拳 / 身份不许泄露**：座位条目只带 `isAI`（身份是公开信息，玩家要靠它画灰圈）；
   AI 决策吃的仍然是**裸 `viewFor`**（服务端 `runAi()` 递进 `aiStep` 的就是它），那一档
   **没有** `isAI`。别顺手把带身份的那一份递给 `aiStep`。
   ⚠️ 座位条目里**也不许**冒出房间层的 `isBot`（`isBot` 只活在房间层：
   引擎里叫 `isAI`，报文里只出 `isAI`）。`online-ai.test.mjs` 有一条整份报文搜 `isBot` 的用例。

**人机在界面上怎么认出来**（契约要求"玩家一眼看得出来"）：

- **名字**：单字池里的一个字（`meta.botNames`），出现在玩家能看到的**所有**地方
  （地图头像、ready 标记、排序列表、播报、行动按钮文案，都读同一份 `view.players[].name`）。
  ⚠️ 名字**可能**和某个真人重名（池子只有十几个字），所以**不能靠解析名字**判断谁是电脑 ——
  得看视图里的 `isAI`。
- **圆环**：**自己=蓝 / 其他真人=橙 / 人机=灰**（和平台的 `FrpReact.ringClass` 同一套语义）。
  地图上是 `.token.is-me / .is-human / .is-bot` 的 `tok-face` 描边
  （`js/ui/map.js` 的 `ringState()` + `css/style.css`），人机再多一道虚线；ready 标记给虚线边。
  ⚠️ 这三条 CSS **排在 `.is-current` 之后**：轮到谁行动改用**金色底**表示，
  圈的颜色继续负责说"他是谁"（不然电脑一行动，灰圈就变成主色了）。
  ⚠️ 单机人机的视图里**没有** `isAI`，所以单机牌桌上不会出现任何电脑标记 —— 这是刻意的
  （那边的对手是你一个人的游戏，不需要标）。

⚠️ 视图的**两档**别搞混（细节在 `js/view.js` 顶部）：

| 哪一档 | 谁吃 | 有 `isAI` 吗 |
| --- | --- | --- |
| `exposeAI: true` | 玩家的报文（服务端 `match.viewFor`） | **有**（身份公开，不泄露任何隐藏信息） |
| 裸 `viewFor(state, id)` | AI 决策（`aiStep`）、单机本地 | **没有** |

所以「AI 拿不到'谁是真人'这个字段」这条结构性保证**还在**（服务端 `runAi()` 递进 `aiStep`
的必须是裸 `viewFor`，别顺手换成带身份的那份）。

用例：`tests/online-ai.test.mjs`（**人机作为座位传进 `createMatch` 的四条**：
1 人 + 1 个 `isBot` 座位不催 tick 打完一整局 / 真人视图里 AI 身份可判定 / 4 个座位满桌能开 /
真人与人机混桌也能打完；另加"AI 的拳不泄露""名字来自单字池""`isBot` 不许进报文"
"座位不够给中文"），
`tests/browser.e2e.mjs` 的 5d-0 / 5d / 5e（一个人建房点开始 → 座位不够的提示条**恰好一条** →
按「＋ 添加人机」→ 成员列表里出现 `.frp-avatar.is-bot` → 开局 → 地图上出现带
`data-frp-avatar` 的人机 token → 打一步；非房主看不到加/减人机的控件）。

### 9. 事件与播报的游标

`board.js` 靠事件 / 播报的 `id` 去重（只播新出现的那些），
而**重新开局会建一个全新的引擎，id 从 0 重新开始**。所以：

- 单机「重新开局」前必须先 `localBoard.reset()`（`js/ui/app.js` 里已经这么做）。
- `_playEvents()` / `_renderLog()` 里还有一层兜底：发现 id 比上次小就把游标清零。
  ⚠️ 删掉这层兜底，联机「再来一局」之后**新一局的播报一条都不会显示**（游标停在上局的编号上）。

### 10. AI 出手前的停顿是刻意的

`js/ui/local.js` 的 `_aiDelay()` 给 AI 留 0.65–1.8 秒。这不是"装人"，是**让真人看清发生了什么**：
瞬间刷屏的话，你根本不知道谁出的拳、谁砍了谁。别为了"快"把它改成 0。

### 11. 演出是**串行**的；**不做本地预演**，而且**演出期间锁输入**（用户第 1 / 第 2 条需求）

服务端一次推来几十条事件是常态（它必须把 AI 的整轮同步跑完，见第 8 条）。所以：

- `board.js` 的 `_playEvents()` 用平台的 `shared/ui/anim.js`：`FrpAnim.push(步骤, fn)`，
  `fn` 演一条并**返回这一步该占多少毫秒**（`stepMs()`：砍/踹/倒下/结算 700ms、
  揭晓 650、买/走 600、排序 550、其余 450）。**下一条等这一条演完才开始。**
  ⚠️ 队列**刻意不支持快进 / 点击跳过**（用户明确不要）；唯一的例外是积压超过 24 条时
  `FrpAnim` 自己的技术性兜底（防一条坏报文把界面钉死）。
  ⚠️ 别改回 `setTimeout(..., i * 110)` 那种"固定错开"：那跟动画本身多长毫无关系，
  看起来就是特效一闪而过（这是原来被用户点名的毛病）。
  ⚠️ 平台脚本没加载时（`window.FrpAnim` 不在）要退化成"直接逐条演完"，不许把事件丢了。
  ⚠️ `browser.e2e.mjs` 会用探针包一层 `FrpAnim.push` 记下每一步的时长，
  断言"队列真的被调用了，且步长落在 450–700ms"—— 这条盯的就是"别退回固定 110ms 错开"。
- ⛔ **不做本地预演**（`optimistic(act)` / `_markMyHand` / `_consumeOptimistic` /
  `eventSig` / `_optimistic` **已整段删除**，别抄回来）。
  点下去到服务器回包之间**本机不播任何动画、不出任何音效**；画面上"我这一手"由服务端
  回放的那一步演出来（买/走/砍/踹/结束行动那些 `_playOne` 分支本来就有声有色）。
  - **为什么删**：用户实测**快速连点会把画面演成"所有人都被打死了"** ——
    预演只演起手，连点就串起一串起手，而真正的结果由服务端一条条回放，
    两条时间轴叠在一起。本机往返只有几毫秒，预演本来就没多少收益，
    用户原话是"**卡一点就卡一点没事的**"。
  - **出拳那一声改了时刻、没丢**：原项目是**点按钮时立刻** `play('pick')`
    （原 `js/ui/app.js` 第 720~723 行），删预演时它跟着没了，而回放那一步本来不播声 ——
    captain 收口时按"**音效跟着权威确认走**"补回到 `_playOne` 的 `case 'rps-pick'`：
    服务器收下我的拳、回放走到这一步时才响，**只响我自己那一票**
    （别人 / 人机的拳不该让我听见，一轮里全响就是四声连击）。
    代价是比原来晚一个来回，好处是绝不会"响了一声结果服务器没拒了"。
    ⚠️ 这条有**实测断言**（`browser.e2e.mjs` 的 5b-3）：`spyAudioPerStep()` 把
    `FrpAnim.push` 的 fn 包一层、**逐步**数 `AudioContext.createOscillator`，
    实测输出是「我那一票 1 步响了（振荡器 1），别人那 1 票全静音」。
    无头浏览器听不到声音，只有振荡器个数是"真的出声了"的证据；
    ⚠️ 探针必须挂在**对方出拳之前**（脚本玩家那一票也会在浏览器这边演一步，
    挂晚了就只剩我自己那一票，"别人不响"这条会没东西可测）。
- ⚠️ **演出期间锁住输入**（`FrpAnim.busy()` 为真时）。
  - 判定只有一份实现：`board.js` 导出的 **`animBusy()`**。`BoardView._blocked()` 和
    `js/ui/online.js` 的 `act()` 都问它 —— 出拳三选一、排顺序那两项、花一步行动的
    所有按钮在点击时先判，为真就**当成没点**（不发消息、不出音效、不改界面）。
  - 平台在 `ctx.act()` 里也兜了一层，但本作走的是 `GameNet.send` —— **自己这个口子必须自己判**。
  - `js/ui/online.js` 的 `act()` 里**只有 `{kind:'tick'}` 例外**：它不是玩家点的，
    是"这一阶段快到点了"的催办（见第 3 条），锁住它只会让超时白白晚几秒。
  - CSS 那一半在 `css/style.css`：`body.frp-anim-busy` + 真实类名把
    `.rps-btn` / `.order-list .order-item` / `.act-grid .act-btn` / `.act-btn.hot.wide`
    变灰 + `pointer-events:none`。**房间级按钮（开始 / 离开 / 邀请 / 加人机）不受影响**
    （它们在房间外壳里，不在 `.board` 下面）；结束面板的「回到首页」也不在圈里。
  - 两个口子都**不能"只灰不禁"**：真鼠标能被 CSS 挡住，程序化点击绕不过 JS。
    `browser.e2e.mjs` 的 5b-1（往队列里塞一步 1.4 秒的假演出）与 5d-3（真实演出）
    两条用例都是"两条路都点一遍，断言一条 `room.act` 都没发出去、界面也没变"。
  - 演出演完必须**立刻恢复**（用例 5b-1 会断言 `body` 上的 `frp-anim-busy` 被摘掉）——
    锁是临时的，别写成把游戏锁死。
- 决定与教训的出处：`docs/DECISIONS.md` **D10**（那一版原来写的是"乐观演出"，
  已经被用户实测推翻并重写）。

### 12. 头像与互动：交给平台（`data-frp-avatar`）

用户第 5 条需求是"头像能扔鸡蛋 / 送鲜花"。平台的实现方式是**声明式**的：

- 任何带 `data-frp-avatar="<id>"`（可选 `data-frp-name`）的元素，**自动**变成可点目标 ——
  事件代理听在 `document` 上（`shared/ui/react.js`），所以头像被反复重画也不会漏。
- 本作要做的事只有两件：地图上的头像 token（`js/ui/map.js`）加上这两个属性；
  自己**不要**写 `click` 监听、不要自己弹菜单。
- ⚠️ **热区 ≥44px 是硬指标**。地图是 SVG，会被缩放到容器里，所以要看**实测**（用户坐标
  换算成像素的系数由 viewBox 与容器共同决定，估不出来）。
  当前数字（`tests/browser.size.mjs` 跑出来的，2026-10 那一版布局）：

  | 视口 | 单机 4 人局 头像脸 / 热区 | 联机 2 人局 头像脸 / 热区 |
  | --- | --- | --- |
  | 360×640 | 40.4px / **61.8px** | 44.7px / **68.3px** |
  | 375×667 | 42.1px / **64.5px** | 46.6px / **71.2px** |
  | 390×844 | 43.9px / **67.2px** | 50.3px / **76.9px** |
  | 430×932 | 48.6px / **74.4px** | 50.3px / **76.9px** |

  ⚠️ **改 `HIT_R`、改地图的 viewBox（`_viewBox` / `LAYOUT` / `AVATAR_R` / `RING_R`）、
  改 `.map-wrap` 的高度都必须重跑 `node games/blade-steed/tests/browser.size.mjs`**
  （四个视口逐个数，还会验"热区有没有被 SVG 视口裁掉"和"城与城不许叠"），
  再跑 `browser.e2e.mjs` 的 `avatarHotzones()`。这条不是"看起来够大"就算过。
  ⚠️ 三个数之间的关系别搞混：**脸**（`AVATAR_R`）管好看，**热区**（`HIT_R`）管点得到，
  **`RING_R`** 管同一地点站了好几个人时会不会叠在一起。脸变大时热区只能不变或变大。
  ⚠️ `tools/check-game.mjs` 的 44px 体检**现在把 `[data-frp-avatar]` 也扫进去了**
  （原来是 `button, input, a, [onclick]`，量不到靠事件代理接点击的 SVG 头像 ——
  这条是本作上报平台之后补上的）。它取"带属性的元素与其外层里更大的那个"来量，
  而本作自己的 `browser.size.mjs` 直接量**真正接指针事件的 `.tok-hit`**（更严一档）。
  ⚠️ `browser.e2e.mjs` 还会**真点一下人机头像**，断言平台那个 `.frp-react-menu` 弹出来、
  里面是「🥚 扔鸡蛋 / 🌸 送鲜花」，并点一次「送鲜花」确认菜单收起、消息发得出去
  （没弹出来说明属性没写对或被别的监听吃掉了；发不出去平台会弹"还没连上服务器"）。
- 圆环颜色也来自平台语义（`FrpReact.ringClass(id, isBot)`：自己=蓝 / 其他真人=橙 / 人机=灰），
  本作的 `map.js` 有本地兜底（`ringState()`），平台脚本缺席时曲线不变。

### 13. 地图与头像在小屏手机上要够大（用户第 4 条需求，2026-10 改过一轮）

用户原话：「刀马这个游戏的地图和头像太小了（手机端部分小屏幕机型）」。根因是
**画布比内容大**：`map.js` 原来把 viewBox 写死成 `0 0 400 340`，而 2 人局的内容
只有 340×104（两座城左右排开）—— 竖屏手机上缩放系数被压到 0.83 左右，
头像只有 **20.6px**，地图是容器中间一条小带子。

改完之后（现在的做法，改之前先读这段）：

- **viewBox 每局按人数算**（`_viewBox()`）：紧贴内容（野外 / 各座城 / 头像热区 + `PAD`），
  而且半径取 `max(cityR, RING_R + HIT_R)` —— 同一个地点站了好几个人时，
  最外面那个的热区也要落在画布里，不然会被 SVG 视口裁掉（看得见摸不着）。
- **2 人局改成斜对角**（`angles: [-135, 45]`）：原来左右排是一条扁带子，
  竖屏上永远缩得很小。
- **`LAYOUT` 收紧**（dist 88–92、cityR 38–42、wildR 40），换来更大的缩放系数。
- **头像变大**：`AVATAR_R` 12.5 → **17**，`HIT_R` 28 → **26**（用户坐标；
  像素上反而更大，因为地图整体放大了），`RING_R` 20 → **24**，
  血条 / 装备字 / `.tok-char` 字号一起按比例放大（**要一起改，不然字会溢出圆**）。
- **联机地图容器** `.online-board .map-wrap` 从 `min(46vh,320px)` 放到
  `min(50vh,360px)`（`min-height: 220px`）。房间外壳**可以上下滚**，
  所以别再往上加：地图越高、行动按钮越靠下。
- ⚠️ **仍然只用 viewBox 用户坐标，绝不量像素**（`map.js` 里不许出现
  `getBoundingClientRect`）：联机第一次渲染时 SVB 还没插进文档，量出来全是 0。
- ⚠️ 已知取舍（不是 bug）：4 人局的内容接近正方形，在**又高又窄**的手机上
  （390×844 / 430×932）宽度吃满、竖向还剩一些空白。把内容改成竖长条会在
  360×640 那档把头像缩小 —— 而那一档正是用户点名的"小屏幕机型"。

### 14. 逐步同步：演到第几步，画面就是第几步（GAME-SPEC §11 第 10 条）

用户第 3 条反馈是"演出演到一半，对方的刀、马已经亮起来了，位置也直接瞬移过去了"。
根因是**整块界面按最终状态重画**，而演出队列只是"事后放动画"。修法是把界面拆成两份视图：

| 视图 | 谁写的 | 干什么用 |
| --- | --- | --- |
| `this.authView` | 服务器推来的权威帧（`render(view)` 第一件事就是存下来） | 只能拿它判"现在到底在哪个阶段 / 还剩多久 / 要不要催 tick"（`pendingInMs`） |
| `this.view`（显示视图） | 每一步演完时把该步的补丁 `ev.s` 贴上去（`_applyStepPatch`） | 画地图 / 状态条 / 行动面板 / 播报 |

所以"演到第几步，血量/装备/位置/回合/面板就是第几步"；**只有队列真的排空了**才由
`_reconcile()` 拿 `authView` 对一次账（`_scheduleReconcile()`：平台队列什么时候空只有它自己知道，
所以是轮询，最长 60ms）。

**补丁（`ev.s`）的两条红线**：

- ⛔ **不许把私密字段放进补丁**。补丁走的是 `js/view.js` 的 `narrowPatch` ——
  和 `viewFor` **同一份白名单与同一种裁剪**（`phase / round / current / stepsLeft / winner /
  mainWinners / steps / queue / players / rps / mini`）；`rps` / `mini` 还要再过
  `narrowRpsPatch` / `narrowMiniPatch`，只留 `ready` + `myChoice`。
  本作的私密信息就是这个：**别人还没揭晓的拳**（`rps.submitted[别人]`）。
  给引擎加了新的公开字段却忘了加白名单 → 客户端"看不见"（安全的那一边）；
  把私密字段加进补丁 → **一帧就能让别人抓到你的拳**（`narrowPatch` 里那句注释就是为这个写的）。
  回归防线：`rules.test.mjs` 的「逐步同步：整包 JSON（含补丁）里搜不到别人还没揭晓的拳」、
  「逐步同步：补丁只带"变了的"字段，按步贴完正好等于权威视图（整局扫描）」、
  「视图不泄露：整局扫描，任何时刻别人的手势都不在报文里」。
- ⚠️ **补丁记的是"这一步之后"的公开状态，所以服务端要先把状态改完再推事件**。
  `engine.js` 的 `_applyAction` 把"扣步数"挪到了 `switch` **之前**：
  买刀那一步的补丁里必须已经带着新的"剩 N 步"，否则画面会先亮出刀、450ms 后才把步数改过来 ——
  那半秒正是用户说的"演到第几步、画面却不是第几步"。测试按 `steps[pid]` 判定（视图里的
  `steps` 是**每个人还剩几步**，不是开局分了几个）。

**首次挂载 / 重新开局：⛔ 不许把旧事件重演一遍**（`board.js` 的 `render()` 第 218 行的三选一）：
① 首次挂载（手里还没有视图）、② 游标是 0（单机「重新开局」先 `reset()`）、
③ 事件编号回退（联机「再来一局」是新引擎、编号从 0 重来）—— 这三种情况一律
`_adopt(view, maxId)`：**直接把权威视图画出来、把游标设到当前窗口最后一条**，
只有"从上一帧之后新增的事件"才排队演。
**为什么必须这样**：补丁是"相对上一条事件"的**差量，没有基准**可叠 ——
这三种情况手里那份视图已经是最终状态，再一条条叠几十条旧补丁，血量/位置会算出**错的数**，
还会莫名演上几十秒。`_adopt` 里顺便 `tickTimer(true)`：首次挂载要**立刻**显示权威剩余
（不能等到 200ms 后那一拍，也不能显示"演出中"）。单机「重新开局」前的 `reset()` 同理（第 9 条）。

**用例与实测**（`browser.e2e.mjs` 5d-4，2026-10，无头 Chrome，1 真人 + 1 个人机）：

- 做法：探针把 `FrpAnim.push` 的 fn 包一层，在**每一步演完的那一瞬间**（同一个 JS 任务里，
  没有任何 CDP 往返）拍一份画面；再把队列**卡在中间** —— 第一步演完先塞一步 1.5 秒的空演出，
  于是那一刻有 1.5 秒的稳定窗口，外面用 CDP 从容读一次 DOM 做对照。
- 实测输出：卡住那一步是 `buy`；**补丁里那 1 个人（血量/刀/马/位置）正好是这一步的值**；
  补丁没提到的人一动没动；跨 CDP 再读一次与页内快照**逐字段一致**；
  排空 + 对账之后画面 = 权威视图，且中间那一刻与最终画面确实不同
  （差了 `phase / round / panel / <pid>.cls` —— `.cls` 是"轮到谁"的金底与装备类）。
- ⚠️ 写这类探针会撞到的两个坑（都踩过，别再踩）：
  1. **`FrpAnim.push` 在队列空的时候会同步把第一步跑完**（`anim.js` 的 `push` → `run` → `item.fn`），
     也就是跑在 `online.js` 的 render **里面** —— 而这一刻牌桌还没插进文档（第 4 条），
     `document.querySelector('#online-panel .online-board')` 当场返回 `null`
     （第一次量出来 `before/after` 全是 null 就是这么来的）。联机牌桌的 root 是**常驻元素**，
     所以探针要**记下那个元素**再用它读属性。
  2. 同一瞬间**计时器文案还是上一帧的**（这一帧的 `tickTimer(true)` 在 `anim.push` 返回之后才跑，
     相差几微秒，页面根本来不及画）—— 所以"逐步同步"的对照里**不要把计时器算成牌桌状态**，
     它另有断言（第 15 条）。
- 位置一律读 `.token` 的 `transform`（`map.js` 只改这个属性，补间交给 CSS transition），
  ⛔ **绝不 `getBoundingClientRect`**：联机第一次渲染时这块 DOM 还没插进文档，量出来全是 0。
  判"这个头像此刻在哪"用"离哪个地标（`.city-ring[data-city]` / `.wild-ring`，都是 viewBox 用户坐标）最近"。

### 15. 倒计时：演出那几秒不算玩家的（"限时"这条只有刀马有）

一个限时阶段（猜拳 / 定顺序 / 行动）里，玩家的思考时间由**两半**拼起来，缺一半都会出问题：

1. **服务端那一半 —— 缓冲**：`constants.js` 的 `REPLAY_BUFFER_MS = 2000` 加在三段限时上
   （`RPS_TIMEOUT_MS` 12s = 10+2、`ORDER_TIMEOUT_MS` 17s = 15+2、`ACTION_TIMEOUT_MS` 62s = 60+2）。
   死线是**阶段开始时**按服务器时钟定的，所以演出那几秒本来就落在缓冲里。
2. **客户端那一半 —— 显示顺延**（`board.js`）：
   - 收到权威帧：`_syncDeadline(view)` 记下 `_deadlineAt = Date.now() + deadlineIn`。
     ⛔ **队列排空之后绝不再"重新起算"一遍** —— 那等于把演出那几秒**加**回给玩家：
     服务器和别的客户端的钟一秒都没停，只有本机把数字往后推，屏幕上还剩 8 秒时服务端其实已经到点，
     `scheduleTick()` 按 `pendingInMs()` 排出来的催办也对不上号。理由写在 `_syncDeadline` 上面。
   - `tickTimer()`：`animBusy()` 为真时一律写"演出中"（并挂 `.busy` 类），**队列一空立刻**
     写服务器给的真实剩余（`Math.ceil(left/1000)`）。
   - `_queueSteps()` 在 `anim.push(...)` **之后立刻**再调一次 `tickTimer(true)`：
     否则会有 0~200ms 的窗口（直到 `app.js` 那个 200ms 的定时器响）显示**在跑的数字**。
     **实测修复前**探针采到 `["62","62","演出中",…]`；修复后 5 帧 / 316 次采样里**一个数字都没有**。
   - `{kind:'tick'}` 是输入锁的唯一例外（第 11 条），它和倒计时无关。

**用例与实测**（`browser.e2e.mjs` 5d-5）：探针每 40ms 采一次计时器（**只在 `FrpAnim.busy()` 为真时采**，
排空之后计时器本来就该有数字），排空那一刻按 `remaining = deadlineIn + 帧到达时刻 − 排空时刻`
换算，再和 `constants.js` 算出来的标称（`限时 − 缓冲`，不在用例里抄字面量）对账。
实测（同一轮，1 真人 + 1 个人机）：

| 落点阶段 | 这一帧的回放 | 排空那一刻剩余 | 占标称 | 画面上的数字 |
| --- | --- | --- | --- | --- |
| 行动（标称 60s） | 1050ms（2 步 `buy+turn`） | 60919ms | **101.5%** | 61 |
| 猜拳（标称 10s） | 1500ms（3 步 `buy+rps-start+rps-pick`） | 8959ms | 89.6% ⚠️ | 9 |
| 猜拳 | 4100ms（8 步 `rps-pick+rps-reveal+turn+buy+turn+buy+rps-start+rps-pick`） | 7791ms | 77.9% ⚠️ | 8 |
| 猜拳 | 4100ms（8 步，`move` 版） | 7798ms | 78.0% ⚠️ | 8 |

（同一份代码重复跑，几个百分点在小数点后一位上下浮动 —— 5 帧 / 316 次采样那两条数字是稳定的。）

⚠️ **`rules.test.mjs` 那条"倒计时缓冲"只按 2 步的小批算**（它假设"一次演出 ≈ 一步买东西"，
1050ms 确实盖得住）——**真实帧最长 8 步**，所以那条单测绿着也不代表浏览器里够用。
**这两条是互补的，别只看单测那条**：单测盯"公式没写错"，浏览器那条盯"真实帧盖不盖得住"。

⚠️ **已知缺口（实测出来的，没有偷偷放宽断言）**：GAME-SPEC §11 第 10 条要求
"队列排空那一刻的剩余 ≥ 标称的 90%"，而**猜拳阶段（标称只有 10 秒）实测跌到 78%**。
根因：一帧最长能演 **8 步 / 4.1 秒**（上回合收尾 + 人机整轮 + 新回合开局**全在同一帧里**），
而 `REPLAY_BUFFER_MS` 只有 2000 —— 只抵得掉 2 秒，剩下的 2.1 秒就吃掉了玩家的思考时间。
用例现在的判据分三层（都在输出里看得见）：行动阶段（60s，玩家真正要思考的那一段）
**必须 ≥90%**；**任何一帧低于 75% 一律红**（谁把缓冲改小、或者演出变慢，它立刻红）；
75%~90% 的帧逐条**点名打印**。要真正补上这个缺口就是把 `REPLAY_BUFFER_MS` 提到 **≥4.2 秒**
（代价：挂机时全桌多等，猜拳从 12 秒变 ~14.5 秒）——**这是一个要 captain/用户点头的取舍，本轮没动**。

### 16. 三件平台共用能力的接线（按钮音 / 偏好 / 身份）

- **按钮音**：平台的共用按钮音是 `FrpUI.sound`（`shared/ui/ui.js`），**由平台外壳 `bindClicks()` 接** ——
  游戏**不要**再接一遍，会响两声。本作自己的音是 `js/ui/audio.js` 现场合成的，
  且**跟着权威确认走**（出拳那一声在回放 `rps-pick` 那一步才响，只响我自己那一票，第 11 条）。
  实测防线：5b-3 逐步数 `createOscillator`（我那一票 1 个、别人 0 个）。
- **偏好只有一份**（`docs/DECISIONS.md` D12）：游戏里只读写 `FrpUI.prefs`
  （localStorage 的 `frp.prefs`），**老键 `bs.sound` / `bs.fx` 一个字节都不碰**
  （平台在 `FrpUI.prefs` 首次加载时做过一次性迁移）。各存各的就会出现"平台开着、游戏关着"。
  实测防线：`browser.e2e.mjs` 的 **3b** ——
  **读**：老键说关、`frp.prefs` 说开 → 刷新后界面必须跟着平台那份（菜单那行写"音效：开"）；
  **写**：点游戏里的开关 → 只有 `frp.prefs` 变，老键原地不动，和偏好有关的 localStorage 键
  只有 `frp.prefs`（另外两条是老键，测试自己塞进去当诱饵的）。
- **身份"瞬间可见"**（`docs/DECISIONS.md` D13）：平台首页和游戏页是两个网页，点进游戏是整页跳转，
  公网那次 WebSocket 握手实测要 2~3 秒。这段时间原来只能显示"正在确认身份…"，
  点「开始对局」还会被判成"还没登录"、弹一句**假话**。现在 `GameNet.cachedMe()`
  （localStorage 的 `frp.me`，由 `rememberMe` 在拿到 `ready` 时写下）在页面一打开就把身份行画出来。
  ⛔ **缓存只用于显示 + 放行**：不许拿它填 `GameNet.me`、不许拿它判断登录态 ——
  服务端说没登录（`/api/me` 401）才 `forgetMe()` 并回平台首页。
  实测防线：**`tests/browser.identity.mjs`**（本作自己的文件，平台体检会逐个跑
  `tests/browser*.mjs`）—— 两条路一起掐死：WebSocket 换成永远连不上的假货 **且**
  `fetch('/api/me')` 永远不 resolve。实测输出：`readyState=complete` 的那一刻身份行已经是
  「你：瞬 · ID QBTDP4J」（ID 每次注册都是新的，这里是那一次的实测值；用例只断言"有名字 + 有 ID"，
  ⛔ 别把某个具体 ID 写死进断言）；写入历史恰好是 `["正在确认身份…","你：瞬 · ID QBTDP4J"]`
  （也就是**一次都没写过**"正在确认身份…"）；`GameNet.me` 仍是 `null`；
  2.9 秒后"还没登录"的提示条仍然没出现。
  ⚠️ 它比平台的 `tests/shared.browser.mjs` **更严一档**：平台那条只掐了 WebSocket，
  `/api/me` 还是活的（身份可能是它给的）；这里两条都断了，身份**只可能**来自缓存。

### 17. 对局记录的下滑条：外壳每重画一次，它就会被顶回最旧一条（用户实机反馈，2026-10）

用户原话：「**「演出中」时对局记录会自动上滑至第一条记录，导致对局记录总是在最新的一条
与最旧的一条直接来回跳转**」。

**根因是第 4 条那个"容器每次都是新的"的第二个受害者**（第一个是动画重头播）：
`room.state` 一来，房间外壳就 `UI.clear(panel)` → `renderGame(host, view, ctx)`，
而本作的 `this.root` 是**常驻元素**，每次只是被 `host.append(this.root)` ——
**元素一离开文档，浏览器就把子树里的 `scrollTop` 归零**（`.log-strip` 是它的后代）。
于是两股力量来回拉：外壳重画把它顶回**最旧**一条，而演出走到下一步时
`_renderLog()` 又把它拉到**最新** —— 用户看到的就是"在最新与最旧之间来回跳"。
（`renderGame` 运行时 `host` 还没插进文档，那一刻做任何滚动赋值都是无效操作。）

**修法**：`board.js` 里单独一个 `_pinLog()`：

```js
_pinLog() {
  const el = this.$('.log-strip');          // 取不到就直接返回
  const pin = () => { el.scrollTop = el.scrollHeight; };
  pin();
  if (!el.isConnected) requestAnimationFrame(pin);   // 还没进文档 → 下一帧再钉一次
}
```

两处调用，**缺一不可**：

| 调在哪 | 管什么 |
| --- | --- |
| `render(view, selfId)` 开头（存下 `authView` 之后马上调） | 外壳这一次重画之后**立刻**把它钉回底部；元素还没进文档时由 `requestAnimationFrame` 那一拍补上 |
| `_renderLog()` 里（原来是直接写 `scrollTop = scrollHeight`） | 每追加一条新记录之后照旧跟着往下走 |

- ⛔ **别删 frame 级那一次**（只留 `_renderLog` 里那次）：那样"重画到重新挂载"这段窗口
  （元素在文档外，赋值全部无效）里滚动位置就没人管了，用户照样会看到它跳回第一条。
- ⛔ **别把它改成"记住 scrollTop 再恢复"**：用户要的是**始终跟最新**；
  手动往上翻会被下一次追加拉回底部，这是本作**既有**的语义（和"演出不给跳过"同一套调性），
  不是这次引入的行为。要改成"粘底才跟随"是另一件事，得先问用户。
- ⚠️ `_renderLog()` 开头那句 `if (!lines.length) return;` **刻意没动**（没有记录时无所谓），
  所以"一条记录都没有"那一路靠 `render()` 里 frame 级那次兜底。
- 实测防线：`tests/browser.e2e.mjs` 的 **5d-6** —— 等队列排空 → 读一次滚动位置
  （断言**可滚动且贴底**）→ 调 `window.FrpRoom.render(true)` **强制重画**（普通 `render()`
  会被渲染去重跳过，那就测不到东西了）→ 220ms 后再读一次，断言**行数没变 + 仍然贴底**。
  老写法在这一步会掉回 `scrollTop = 0`，当场红。实测输出：

  ```
  ✓ 21 条记录｜重画前 scrollTop=393 → 重画后 393（可视 56 / 内容 449）
  ```

## 换掉了什么（原项目 → 这里）

| 原项目 | 处理 | 为什么 |
| --- | --- | --- |
| `js/net/**`（mqtt / rtc / channels / protocol / session，约 62KB） | **整块删除** | 它们唯一的存在理由是"玩家没有服务器"，见 `docs/DECISIONS.md` D1。平台就是服务器 |
| `js/game/emitter.js`、`js/game/match.js`（本地对局驱动） | 重写为 `js/ui/local.js` | 同一个引擎，驱动方式简化成"定时 tick + 给 AI 排延迟" |
| `js/main.js` | 并进 `js/ui/app.js` | 页面入口就是 `app.js` 自己 |
| `js/engine/view.js` | 挪到 `js/view.js` | GAME-SPEC 规定 `viewFor` 在 `js/view.js` |
| 取名界面 + `isValidName`/`normalizeName` | 删除 | 名字来自平台账号（`DECISIONS.md` D5） |
| 大厅（头像墙 / 房号 / 连线状态 / 房间输入框） | 删除 | `/shared/ui/room.js` 提供，且长得和别的游戏一样 |
| **反应（扔鸡蛋 / 鲜花）**、大厅头像的点击浮层 | 删除 → **现在平台接管了** | 当时删掉是因为协议里没有这类消息（留一个"点得动但没反应"的头像比删掉更糟）。现在平台有了：`shared/protocol.mjs` 的 `REACT_SEND`/`REACT` + `shared/ui/react.js` 的事件代理，**只要元素带 `data-frp-avatar` 就自动可点**（见第 12 条），本作不用写一行互动代码 |
| 自己的 toast / blocker / spinner | 删除 | `/shared/ui/ui.js` 的 `FrpUI.toast` 是统一的那一个 |
| `favicon.png` | 删除 | 平台统一用 emoji（`index.html` 里一行 data URI） |
| `tests/harness.mjs`（自写迷你测试框架） | 删除 | 用 `node:test` + `node:assert/strict` |
| `tests/net.test.mjs` | 删除 | 没有 net 层可测了 |
| `tests/e2e.test.mjs` | 重写为 `tests/browser.e2e.mjs` | 原版测的是 MQTT/WebRTC 联机；现在改成"真浏览器 + 平台服务器 + 第二个脚本玩家"（改名是为了不被不带 --browser 的机械体检带起来） |

## 怎么验证（只认实测）

```bash
# 1. 语法（每个改过的文件都跑一遍）
node --check games/blade-steed/js/engine/engine.js
node --check games/blade-steed/js/view.js
node --check games/blade-steed/js/ui/app.js
node --check games/blade-steed/js/ui/online.js
node --check games/blade-steed/js/ui/board.js
node --check games/blade-steed/js/ui/local.js
node --check games/blade-steed/js/ui/map.js
node --check games/blade-steed/js/ui/effects.js
node --check games/blade-steed/js/ui/audio.js

# 2. 铁律一：引擎与 AI 目录里零 DOM（命中数必须是 0）
#    pwsh 里：Select-String -Path games/blade-steed/js/engine/*.js,games/blade-steed/js/ai/*.js -Pattern 'document\.|window\.'

# 3. 规则单测（36 条，含"视图不泄露"、"逐步同步的补丁不带别人的拳"、"局外人拿不到视图"）
node --test games/blade-steed/tests/rules.test.mjs
# 3b. 人机作为**房间座位**的 15 条（1 人 + 1/2/3 个 isBot 座位不催 tick 打完一整局、
#     AI 的拳不泄露、isBot 不许进报文、名字来自单字池、座位不够给中文）
node --test games/blade-steed/tests/online-ai.test.mjs

# 4. AI 自对弈 12000 局（查死锁 / 非法动作 / 胜率偏向）
node games/blade-steed/tests/sim.mjs

# 5. 真浏览器端到端（注册 → 人机走一步 → 建房 → 座位不够点开始被拒（提示条）→
#    按「＋ 添加人机」→ 开局 → 两个真客户端打一局 → 超时催办 → 头像热区实测 → 360px 体检 →
#    "点下去本机不演"与"演出期间锁输入" → **对局记录下滑条在重画之后仍贴底（5d-6）**）
#    ⚠️ 5b/5d/5e/5d-6 与 anim.js / react.js / room.js 的接线只有真浏览器点得出来
node games/blade-steed/tests/browser.e2e.mjs

# 5b. 小屏尺寸实测（4 个竖屏视口 × 单机 4 人局 / 联机 2 人局，逐个数地图宽高、
#     头像直径、热区直径、最小可点目标；另验"热区没被 SVG 视口裁""城与城不叠"）
#     ⚠️ 改 map.js 的 LAYOUT / _viewBox / AVATAR_R / HIT_R / RING_R，
#        或改 css 里 .map-wrap 的尺寸，都必须重跑这一条
node games/blade-steed/tests/browser.size.mjs

# 5c. 身份"瞬间可见"：WebSocket 与 /api/me **两条路一起掐死**，首页仍要显示名字/ID，
#     且写入历史里一次都不许出现"正在确认身份…"（第 16 条）
node games/blade-steed/tests/browser.identity.mjs

# 6. 平台的机械体检（骨架 / 零 DOM / 服务端契约 / 跑游戏自己的用例）
node tools/check-game.mjs blade-steed

# 6b. 平台体检 + 真浏览器（脚本顺序、44px 硬指标、控制台零报错；也会带起第 5 条）
node tools/check-game.mjs blade-steed --browser
```

- 第 5 条会**自己起一个临时服务器**（`startServer({port:0, dbPath:临时文件})`），
  不碰 7891、不写 `data/server.json`。它需要本机装了 Chrome 或 Edge。
- 平台集成测试（`npm test`）跑的是房间层与协议，和本游戏无关；
  但**改了 `server/games/blade-steed.mjs` 之后建议顺手跑一次 `npm test`**，
  它用的是一个和本游戏同构的假游戏，接口对不对得上很快就能看出来。
✅ **`node tools/check-game.mjs blade-steed --browser` 现在也能过了**（captain 收口时改的）。
原来那个 `--browser` 阶段是照着**大炮轰小鬼**一个游戏写死的（等 `.screen.active`、
断言 `window.GameState`、调 `window.showScreen('ai-setup')` / `window.startAIGame()`、
数 `.board-cell` / `.piece` / `canvas.board-canvas`），所以模块化界面的游戏全都过不了。
现在它**只用平台契约**：

- 页面起得来、当前屏幕是 `.screen.is-active`
- 页面上有 `#online-panel`，里面画出了 `.frp-room-idle`
- **真的连上了 WebSocket**，点【创建房间】**真的拿到 6 位房号**，点【离开】真的回到入口
- 横向溢出 / 点击区 ≥44px / 元素跑出屏幕 / 控制台零报错
- 顺手跑本游戏自己的 `tests/browser*.mjs` —— **每一个文件都跑**
  （`browser.e2e.mjs` 与 `browser.size.mjs`）。captain 收口时修掉了平台脚本里的一个真 bug：
  `tools/check-game.mjs` 原来把**所有**文件名塞进同一条 argv
  （`node browser.e2e.mjs browser.size.mjs`），而 Node 只执行第一个文件，
  于是 `browser.size.mjs`（小屏尺寸那条用户反馈的唯一防线）**从来没被自动跑过**。
  现在改成逐个文件单独起进程。**新增第二个 `tests/browser*.mjs` 时不用再改平台脚本。**

⚠️ 顺便记一个**实测结论**（原来是本作自己文档里的一个误解，已核实）：
`tools/cdp.mjs` 的 `page.eval(expr)` 会把 `expr` 包成 `(() => { … })()`，
所以**里面嵌套的 IIFE 的返回值会被丢掉**；`page.evalRaw(expr)` 才是"不求值包装"的那个
（它只在字符串以 `return` 开头时才帮你包一层）。
本作的 `browser.e2e.mjs` 一直用对了，别改回去。

## 写测试时踩过的三个坑（和被测代码无关，但浪费过时间）

1. **`page.eval(...)` 会把你写的表达式包进函数体**，所以里面那个 IIFE 的返回值会被丢掉，
   永远拿到 `undefined`。要返回值就用 `page.evalRaw(...)`。
   （症状：断言 `undefined === true` 失败，但页面明明是对的。）
2. **`app.url` 结尾自带 `/`**，写成 `app.url + '/games/...'` 会变成 `//games/...`，
   静态服务直接 404，而 404 页面没有 `#screen-home` —— 症状是"首页等不到，控制台却零报错"。
3. ⚠️ **不要在入场动画没跑完时量元素尺寸**。平台的房间面板 / 牌桌有缩放、上滑动画，
   动画途中 `getBoundingClientRect()` 拿到的是**被 transform 缩过**的值：
   实测一个 44px 的按钮量出来是 `h=43.99`，于是"点击区 ≥44px"这条**偶发**误报
   （同一份代码十次里错一两次，最难查）。
   `tests/browser.e2e.mjs` 的 `layoutCheck()` 现在会先把一次性动画 `finish()` 掉再量
   （无限循环的动画不动它）—— 别把这步删掉，删了就会重新变成随机失败。
   顺带核实了一个结论：平台自己画的「房间号」按钮（`.frp-room-code-value`）在
   `shared/ui/ui.css` 里**已经有** `min-height: 44px` —— 量出来 43.99 纯粹是入场动画的
   transform，不是它真的矮。所以本游戏**不需要**再兜样式（曾经加过一行重复的，已删掉）。

## 还没做 / 做不到的

- ⚠️ **猜拳阶段的倒计时缺口（实测 78%，第 15 条）**：GAME-SPEC §11 第 10 条那条
  "排空那一刻 ≥ 标称的 90%"在**猜拳（标称 10 秒）**上没做到 —— 一帧最长 8 步 / 4.1 秒，
  而缓冲只有 2 秒。用例把它钉在 75% 的地板上并逐条点名打印，**没有**偷偷放宽断言。
  要补上就得把 `REPLAY_BUFFER_MS` 提到 ≥4.2 秒（代价是全桌挂机多等），**等 captain/用户拍板**。
- **服务器端权威超时**：平台房间层没有 tick 钩子，只能客户端催（见第 3 条）。
  理论上"所有客户端都睡着"（全桌都锁屏）时这一回合会多等一会儿，直到有人醒过来催。
  （AI 座位不受这条影响：它的拳在每一轮开始时就已经出完了。）
- **电脑的难度不可选**：人机座位用的是默认 AI（`js/ai/ai.js` 一套打分逻辑，
  便宜、不阻塞主线程）。要分难度就得先给它加档位 —— 目前没有这个需求。
- **满桌之后朋友进不来**：比如 1 个真人 + 3 个人机（4 个座位满了），
  开局后朋友想中途进来会被 `addPlayer` 拒掉（座位是真的满了，不是 bug）。
  （开局**之前**朋友进来是另一回事：房间层会顶掉最后加的那个人机给他让位。）
- **反应道具的动画**：扔鸡蛋 / 鲜花由平台画（`shared/ui/react.js`），本作**不做**自定义表现 ——
  想让鸡蛋砸在头像上更有戏，得等平台开一个"反应事件"的口子。
- **观战**：`viewFor` 对名单外的人返回 `null`，所以没有观战模式（这是平台的契约，不是漏做）。