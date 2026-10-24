# 大炮轰小鬼 / Cannon Goblin —— 本游戏的约定（给 AI agent）

> ⚠️ **2026-10-23：`tools/check-game.mjs` 与 `docs/GAME-SPEC.md` 已删除**（平台后续按"缝上游"走）。
> 下面凡是提到它们的地方，按下表替换后再看：
>
> | 原来写 | 现在用 |
> | --- | --- |
> | `node tools/check-game.mjs cannon-goblin` | `node --test games/cannon-goblin/tests/rules.test.mjs` + `node --test games/cannon-goblin/tests/ai-fill.test.mjs` |
> | `... --browser` | 再加 `node games/cannon-goblin/tests/browser.ai-fill.mjs` |
> | `docs/GAME-SPEC.md 第 N 节` | `docs/ARCHITECTURE.md` 的「游戏模块接口（服务器权威）」 |
>
> 平台级别的规矩在**根目录的 `AGENTS.md`**。本文件只说**这个游戏自己的事**。
>
> ⚠️ 本文件在游戏搬进平台时**重写过**：搬进来之前的版本描述的是
> "公共 MQTT broker + WebRTC 打洞"那一套，那套代码已经**整段删除**了，别再照着旧版做。

## 这是什么游戏

不对称对抗棋盘游戏，两人：

- **💣 大炮方**（先手）：走一格，或者**隔着恰好一个空格吃掉一个小鬼**。
- **👻 小鬼方**：只能走一格，靠数量和站位**把大炮堵死**。
- 大炮赢：小鬼数 ≤ 大炮数（吃到最后）。
- 小鬼赢：所有大炮一步都走不了。

## 目录结构（骨架见 docs/GAME-SPEC.md 第 2 节，不要另起炉灶）

```
index.html                  全部界面（菜单 / 设置 / 编辑器 / 在线 / 棋盘 / 规则）
                            切屏靠 .screen.is-active，不用路由
css/style.css              全部样式，配色走 :root 的 CSS 变量
js/engine/rules.js         PRESET_MAPS 预设地图、EMPTY/CANNON/GHOST 常量、GameState 规则引擎
js/ai/ai.js                AIPlayer：alpha-beta + 迭代加深 + 时间预算
js/view.js                 viewFor / stateFromView / 阵营名互转 —— 界面唯一允许读的东西
js/bridge.js               把上面这些 ES Module 挂回 window（经典脚本不能 import）
js/ui/audio.js             AudioManager：WebAudio 合成音效，无音频文件
js/ui/online.js            在线对局：房间准备区（选边/选地图/编辑器）+ 把 view 拆成要演的几步
js/ui/app.js               界面控制、屏幕切换、点击处理、本地与人机的对局流程、动画演出、首页身份行、开关
tests/rules.test.mjs       node:test 用例：规则 / 视图 / 服务端接入层 / AI
tests/ai-fill.test.mjs     node:test 用例：人机座位专项（1 人+1 人机整局、不泄露…）
tests/browser.ai-fill.mjs  真浏览器：建房 → 加人机 → 开始 → 走一步（含演出 / 头像 / 开关）
tests/sim.mjs              AI 自我对弈压测（跑得慢，不放进 npm test）
```

服务端接入层在**仓库**里的 `server/games/cannon-goblin.mjs`（不在本目录）。

## 三条最容易踩的线

### 1. 引擎与 AI 必须零 DOM

`js/engine/**` 和 `js/ai/**` **跑在服务器进程里**（服务端权威裁决），所以不允许出现
`document` / `window` / `navigator` / `localStorage`。`tools/check-game.mjs` 会实测这一点。

同时它们必须是**原生 ES Module**：服务器 `import` 它们，浏览器 `js/bridge.js` 也 `import` 它们。
**同一份文件**同时在两边跑 —— 这是"单机手感"和"联机表现"不会分家的原因，别拆成两份。

### 2. 界面只能读 view

渲染函数（`renderGameBoard` / `updateGameUI`）吃一个 `GameState`，但在线对局里那个
`GameState` 是 `stateFromView(服务端发下来的 view)` **造出来的**，手里绝不会有 view 之外的信息。

⚠️ 大炮轰小鬼是**信息公开**的棋类，所以 view 里几乎就是整个局面 —— 这**不是**漏裁剪。
别因为"看不到隐藏信息"就把 `viewFor` 删掉：以后真加了隐藏信息，改一个文件就够。

⚠️ **`selectedPiece` / `validMoves` 不许进 view**。那是"我点开了哪个格子"的界面状态。
`tests/rules.test.mjs` 里有一条哨兵用例盯着 view 的字段列表，加字段会立刻红。

### 3. 不要改规则

`js/engine/rules.js` 是从源项目**原样搬来**的，只多了一行 `export`（在文件末尾）。
`tests/rules.test.mjs` 里保留了源项目那些回归用例，其中两条是踩过坑的：

- **位置项必须远远小于"吃一个子"的分量**（每个小鬼 `SCORE_GHOST = 90`）。
  旧 eval 对每个小鬼累加 `minDist * 3`，24 个鬼就是几百分、比吃子还重，
  于是困难电脑**有子可吃时反而不吃**。
- **评估函数只有一套符号**：全部是"大炮方"视角，极大/极小完全由
  `gs.currentTurn === CANNON` 决定。别写"看 aiSide 换一套权重"的 eval。

## 棋盘渲染要点（手机上"棋子对不上十字交点"就出在这里）

棋盘有三种东西必须共用同一个坐标系：**canvas 上画的网格**、**按 px 绝对定位的格子**、
**格子里的棋子**。任何让它们各自缩放的改动都会造成错位：

- `.game-board` 必须是 `flex: none`。去掉它，可用宽度不够时棋盘会被 flex 压扁：
  canvas 是 `width:100%` 会跟着缩放，格子是按 px 定位的不会，于是棋子越靠边越偏。
- 格子边长一律用 `fitCellSize()` 量**容器的真实可用空间**（`clientWidth` 减 padding）。
  ⚠️ 别再写 `window.innerWidth - 24` 这种魔数估算。
- canvas 位图按 `devicePixelRatio` 放大，再用 `ctx.setTransform(dpr,0,0,dpr,0,0)`
  把绘制坐标拉回 CSS 像素，网格在高分屏上才清晰。
- `renderGameBoard()` / `renderEditorBoard()` 都走 `buildBoard()` + `placePieceInCell()`，
  改棋盘只改这两个函数。

## 人机 AI 要点

- 三档难度在 `js/ai/ai.js` 顶部的 `AI_LEVELS`：简单 `depth 1`、普通 `depth 2`、
  困难 `depth 8 / budgetMs 1500`。**困难的层数是上限而不是定值**，迭代加深能算多深算多深。
- 走法排序靠上一层结论，alpha-beta 才剪得动。⚠️ 别退化成"直接按目标深度搜一次"。
- 模拟走子走 `applyMove()` + `undoMove()`：**原地改、递归完改回来**。
- 各档 `budgetMs` 与 `AI_NODE_BUDGET` 是**手机不卡死**的保险。困难档会占主线程约 1.5 秒
  （这段时间界面不重绘）—— 这也是**人机对局留在浏览器本地跑**的原因，
  RT 这种长思考不值得发给服务器、也不该阻塞别人的房间。
- 实测：困难档当大炮 60 手能吃约 7.5 个小鬼；当小鬼丢 2.8 个。
- ⚠️ 普通难度（只看 2 步）在预设 0 上会长时间原地打转、几百手不吃子。
  这是源项目 AI 的既有脾性，不是 bug；`tests/sim.mjs` 里对此有说明。

## 在线对局怎么接的

房间外壳（房号 / 成员 / 邀请好友 / 开始 / 离开）全部由平台的 `/shared/ui/room.js` 画，
本游戏只负责：

1. **准备区**（`js/ui/online.js` 的 `renderSetup`）：房主选边 + 选地图 + 调地图编辑器。
   选边/选地图通过 `ctx.setOption` 存在 FrpRoom 里，点开始时由 `onStart` 交上去。
2. **对局**（`renderGame`）：把服务端下发的 view 交给原来的渲染函数。
3. **出手**（`submitOnlineMove`）：把点击翻译成一条 `room.act` 消息发给服务器
   （⚠️ 自己调 `Net.send` 而不是 `ctx.act`，理由见下面「动画与即时反馈」第 3 条；
   发之前要判 `FrpAnim.busy()`，演出期间当成没点）。
   这是本游戏唯一碰协议的地方。

**平台只认两条 DOM 契约**（`docs/GAME-SPEC.md` 第 8 节，改名会让体检脚本瞎掉）：

| 必须 | 本游戏在哪 |
| --- | --- |
| `<div id="online-panel">` | `index.html` 的 `#screen-online-ready` 里 |
| `.screen.is-active` | `showScreen()` / `forceScreen()` 切的类名 |

⚠️ 屏幕的当前标记**统一是 `is-active`**（平台外壳、Shell Gambit、BladeSteed 都用它）。
本游戏原来用 `active`，已改齐 —— 别改回去。注意 `app.js` 里 `.tool-btn` 的 `active`
是编辑器里"选中了哪个工具"，跟屏幕无关，保持原样。

⚠️ `#online-panel` **必须在页面加载时就存在**，FrpRoom 也要在加载时就 `mount`。
体检脚本直接看 DOM、不调任何游戏自己的函数 —— 所以别把 mount 拖到"用户点了在线对局"才做。

⚠️ **游戏页面没有 `web/assets/js/app.js`**，所以没人替你连 WebSocket。
`FrpRoom.mount()` 里代劳了（这一步曾经漏掉，表现是：界面全画得出来、
控制台一声不响、点"创建房间"永远没反应）。别把那次 `connect()` 挪走。

`?join=XXXXXX`：从平台好友列表点「进入」跳过来时带的房号，由
`shared/ui/room.js` 的 `mount()` 自动发 `room.join`（等连上再发）。本游戏不用管。

服务端的裁决在 `server/games/cannon-goblin.mjs`：

- `meta` / `createMatch(players, options)` / `viewFor` / `act` / `isOver` / `result` / `removePlayer`
- **回合校验放在最前面**，否则客户端能把对手的子也走掉。
- **自定义地图必须校验**（尺寸上下限、行列数、至少一个大炮一个小鬼、小鬼必须多于大炮）——
  那张盘是客户端传上来的，属于不可信输入。
- 房主身份由房间层用 `players[].isHost` **显式给**，不许猜"第一个人是房主"
  （房主中途离开会把身份移交）。房主可以选执小鬼方，那时加入方是大炮方且**加入方先手**。

### 人机座位（在线房间 1 个真人也能开局）

契约在 `docs/GAME-SPEC.md` 第 4 节「AI 补位」。本作是**固定 2 人、双方不对称**，
所以"凑够 2 个座位"就是"一个人进房时，对面那个座位由人机顶上"。三处各自只管一段：

| 谁 | 干什么 |
| --- | --- |
| `server/rooms.mjs`（**不要改**） | 只数**真人**：`房间里的真人 < meta.minPlayers` 就拒绝开局。`minPlayers: 1` = 只要 1 个真人就能点开始 |
| `server/games/cannon-goblin.mjs` | `meta.minSeats = 2`（**总座位**下限，含人机）；`createMatch(players, options)` 按 `players[].isBot === true` 认出电脑座位（`players` 里**真人 + 人机都在**） |
| `shared/ui/room.js`（**不要改**） | 画「＋ 添加人机」/「移除」和座位数；座位数 < `minSeats` 时「开始游戏」是**灰**的，并提示"按添加人机补一个" |

> ⚠️ **原来的「电脑补位」开关（`options.aiFill` / `data-aifill` / `ai:1`）已整段作废**，
> 别照着旧写法改回去。旧契约里"游戏模块自己偷偷补一个座位""人机不算房间成员""房主明确选 0
> 时一个人开局要被拒"这三条**都不作数了**：
> 人机现在是**房间的座位**（成员列表里有它、占座位数、有灰色虚线圈的单字头像），
> 房间层把它和真人一起递给 `createMatch`，服务端**根本不读 `aiFill`**。
> 作废的写法在 `server/games/cannon-goblin.mjs` 与 `js/ui/online.js` 的注释里留了墓碑说明。

**几条实测出来的规矩，别改坏**：

1. **人机由服务端同步驱动，不许用定时器。** `createMatch` 建完局、`act()` 里真人走完，
   都要 `runAi()` 一直推到"该真人了"为止 —— 只要返回时回合还在人机身上，
   客户端就永远停在"等待对手行动"（`rooms.mjs` 没有任何"稍后再推一次"的机制）。
   ⚠️ 代价是**真人一手 + 人机一手在同一条报文里到达**。界面必须靠 `/shared/ui/anim.js`
   的演出队列把这几步**一步一步演完**（见 `js/ui/app.js` 的 `queueSteps`），别改回"一次成型"。
2. **人机只用最便宜的一档（`AI_FILL_DIFFICULTY = 'easy'`，depth 1 / 150ms）。**
   hard 是 depth 8 + 1500ms 预算，会把服务端主线程堵约 1.5 秒 = 整间房卡住。
   `ai-fill.test.mjs` 有一条"人机一手 < 300ms"的用例守着它。**刻意不给房主选难度**。
3. **两个数的含义不一样，别合并**：`minPlayers = 1` 是**真人**下限（房间层只数真人），
   `minSeats = 2` 是**总座位**下限（含人机，引擎就是 2 人棋）。
   `tools/check-game.mjs` 拿 **`minSeats`** 个座位（都是 `isBot: false` 的真人）调
   `createMatch(seats, {})` —— 那条路必须能开局。
   一个人、又没有座位时 `createMatch` 抛一句中文（"座位不够…按「＋ 添加人机」补一个"），
   房间层原样转成提示条；正常情况下按钮是灰的，走不到那一步（第二道防线）。
4. **人机的痕迹不许进真人的 view。** 本作是信息公开的棋类（没有只属于某一方的秘密），
   但 `viewFor` 的字段表必须一动不动，人机座位的 id（`bot:1`）和它的单字名字也不许出现。
   `ai-fill.test.mjs` 里有一条逐字段的用例盯着。
   ⚠️ 界面上要知道"这是电脑"请读**房间成员列表**（`room.state.members[].isBot`）——
   棋盘页的对阵条就是这么画的（`js/ui/app.js` 的 `versusSeats()`），别往 view 里加字段。
5. **人机座位由服务端驱动，不作"玩家"看待**：拿它的 id 调 `act()` 只会得到"还没轮到你"。
   `removePlayer` 的语义**不变**：走的那个真人判负、对手（可能是人机）获胜。
6. **服务端的拒绝由平台统一显示**：`shared/ui/room.js` 的 `mount()` 里有一条
   `Net.on(T.ERROR, …)` → `FrpUI.toast`。游戏页**不加载平台外壳**（`web/assets/js/app.js`），
   在平台补上那一条之前，服务端拒一次（"还没轮到你"、座位不够…）是**完全静默**的
   —— 这个坑就是本游戏做 AI 补位时撞出来的。
   ⚠️ **本游戏曾经自己补过一条同样的监听，现在已删掉**（会弹两条一样的提示条）。
   新游戏不要再自己加，也别把平台那条挪走。
   `tests/browser.ai-fill.mjs` 里有一条"座位不够 → 提示条看得见"的用例守着它
   （按钮是灰的，所以那条用例直接发 `room.start` 绕过界面）。

## 动画与即时反馈（用户明确要求的两条）

1. **一步棋不许"一次成型"。** 走子用 FLIP 滑动（先把新棋盘画出来，再把落点那个棋子
   用 `translate` 拉回起点、动回 0），吃子叠一层会碎掉的残影 + **吃子音效**。
   每一步占 460ms，**串行、不快进、没有点击跳过**（用户说不要）。队列在
   `/shared/ui/anim.js`（平台的），本游戏只决定"这一步演什么、演多久"。
2. **不做本地预演。** 点下去到服务器回包之间，本机**不播任何动画、不出任何音效** ——
   画面上"我这一手"由服务端回放的那一步演出来。
   ⚠️ 原来那套"乐观起手"（`app.js` 的 `playOptimisticStart`：目标格加 `pending-target`
   高亮 + 棋子弹一下 + `AudioManager.playStart()`）已经**整段删除**，连 `playStart()`
   这个音效函数和 CSS 里那条 `.board-cell.pending-target` 规则都删了。
   用户实测的原话是"快速点击直接把所有人打死了"：预演只演起手，而真正的结果由服务器
   一条条回放，两条时间轴叠在一起就成了"我一边点、所有人一边死"。
   决定与教训见 `docs/DECISIONS.md` D10。**别把预演加回来。**
   用例 `tests/browser.ai-fill.mjs` 第 11 节钉着它：点下去之后（同一个 JS 任务里）
   棋盘 `innerHTML` 必须一个字节都没变、`FrpAnim.busy()` 必须还是 `false`。
3. **演出期间锁住输入。** 队列没排空（`FrpAnim.busy()`）时：
   - 棋盘点击一律当没点 —— `app.js` 的 `handleCellClick` 第一行就判 `animBusy()`，
     **连"选中棋子 / 显示可走点"都不做**（这张盘马上要变，在过时的画面上选来选去只会更乱）；
   - 发消息那条线自己也要判：`online.js` 的 `submitOnlineMove` 判 `busy()` 为真就
     返回 `false`（不发消息、不改界面状态）。
     ⚠️ **这一步不能省**：本文件直接调 `Net.send`，不走平台 `ctx.act` —— 平台在
     `ctx.act()` 里兜的那层 busy 判断**管不到这条路**（`docs/GAME-SPEC.md` §4）。
   - CSS（**只禁点，不许暗屏**）：`body.frp-anim-busy` 时 `#game-board`
     **只保留 `pointer-events: none`**，棋盘的颜色/透明度一个字节都不变。
     原来这条还写着 `opacity: .5`，一演动画整张棋盘就暗一下 —— 用户原话是
     "动画播放时你为了防止用户操作直接暗屏是什么意思？不要忽然暗屏"，已删。
     提示改由最新一条承担：右下角一行小字（见下面「演出期间那行小字」）。
     **只锁棋盘**：房间级的开始 / 离开 / 邀请 / 加人机不在这张盘上；底栏那两个
     「音效 / 特效」开关也刻意留着 —— 看动画的时候正好想静音一下。
   - 房间级操作**不受影响**（它们本来就不走 `submitOnlineMove`）。
   用户第 2 条反馈的原话是"还没演完操作权就又回到用户层了"。
4. **我点的那一手只用来拼回放画面，不是权威状态**（原来是"乐观播放"，现在只剩这个用途）。
   服务器**从不发中间帧**：真人走完一手、人机在同一次 act 里被跑完，view 里的 `lastMove`
   只剩**最后**那一手（人机的）—— "我那一手"根本没有报文能还原，所以 `submitOnlineMove`
   记下坐标（`pendingMine`）+ 上一帧的 view 拼一张中间画面（`scaffoldAfterMine`），
   `takePendingMine` 还要拿 view 里的盘对一下"这一手到底生效没有"
   （被服务端拒时不会有新 `room.state`，不能只看"收到新 view"）。
   ⚠️ **这三样都别删**：删掉第一步就只剩服务器那一手，我那一手的滑动 / 吃子音全没了。
   用例第 11c 节钉着："一次 `room.state` 必须拆成两步，第一步必须是我那一手"。
   它同时**不吃子、不换回合、不挪棋子**：被服务端拒绝时也不写回滚 ——
   下一次 `room.state` 会把真实局面重新画出来，拒绝原因由平台的房间外壳弹提示条。
5. **同一步不许演两遍**：靠 `lastMove` 的签名去重（`lastMoveKey`），
   换局 / 回等待态时清零（`resetOnlinePlayback`）—— 不清的话，新一局的第一步
   很可能和上一局最后一步是同一对坐标，那一步就永远不演了。
6. **演出中途的"中间画面"是快照，不是权威局面。** 服务器从不发中间帧，所以"我那一手"
   那张画面是拿**上一帧的 view + 我点的那一手**自己拼的（`scaffoldAfterMine`），
   而本地人机的每一步是 `boardSnapshot(gameState)`。
   ⚠️ 别改成"演出时现读 gameState"：队列是串行的，而引擎不会等动画
   （人机那一手可能已经落进 gameState 了），现读会让第一步画出"两步之后"的盘。
   每一步演完，队列会补一个收尾步把画面画回**权威局面**并判终局（结算弹窗刻意
   等动画演完才弹）。
7. **单机人机的"思考停顿"（400/500ms）保留**，别删 —— 瞬间刷屏看不清发生了什么。

### 音效接在哪（回放那一步）

走子 / 吃子音都接在**回放**那一步（`app.js` 的 `playStepSound()`，由 `playMoveAnimation()`
在 FLIP 之前调，所以**特效关掉（不滑、不碎）时声音照样在**）：

| 哪一步 | 响什么 | 实现 |
| --- | --- | --- |
| 普通走子（`capturedPiece` 为空） | `AudioManager.playMove()` | 正弦 800→600Hz，0.1 秒 |
| 真吃子（`capturedPiece` 非空） | `AudioManager.playCapture()` | 锯齿 300→100Hz + 方波 150→50Hz 叠出来的下坠闷响，0.4 秒 |
| 空走一步 | **不响吃子音** | `capturedPiece` 是 `null`，判据来自 `online.js` 的 `victimOf()`（跨 2 格 = 大炮跳吃） |

- **两个音不叠着响**（吃子那一步只响吃子音），否则糊成一片。
  ⚠️ 这条不是我们定的规矩，**原项目就是这么写的**：`Cannon Goblin/js/app.js` 第 362~366 行
  `if (result.captured) AudioManager.playCapture(); else AudioManager.playMove();`、
  第 878 行 `result.captured ? AudioManager.playCapture() : AudioManager.playMove();`
  —— 两个音本来就是**二选一**，所以"补回吃子音 + 顺带接上落子音"是**复原原版行为**，
  不是新加的东西（`playMove()` 也和 `playCapture()` 一样，在改成逐步演出时一起漏接了）。
- ⚠️ `playCapture()` 这段合成音早就写好了，但在改成"逐步演出"时**漏接了调用点** ——
  这就是用户第 3 条反馈"就是没有吃子的声音了"的来源。别再把调用点删掉。
- ⚠️ **去掉本地预演时一起删掉了 `playStart()`**（"起手"那一声）：它只服务于预演，
  留着只会让人以为预演还在。
- `tests/browser.ai-fill.mjs` 第 14 节是**可观测的证据**（无头浏览器听不到声音）：
  量 `playMove` / `playCapture` 的调用、调用当时的 `AudioManager.enabled`，
  再量 `AudioManager.ctx.createOscillator` 的**振荡器个数**（那才是"真的出声了"）。
  实测：空走一步 = 落子音 1 次 / 吃子音 0 次 / 振荡器 1 个；真吃子 = 吃子音 1 次 /
  落子音 0 次 / 振荡器 2 个；音效关掉后吃子那一步 = 振荡器 **0** 个；
  **特效关掉、音效还开着**时吃子 = 吃子音照响（振荡器 2 个）但碎裂残影 0 个
  （两个开关确实是分开的）。

## 演出期间那行小字（**不暗屏**，用户明确要求）

用户原话："动画播放时你为了防止用户操作直接暗屏是什么意思？不要忽然暗屏"。
所以演出期间的视觉提示**不是把画面压暗**，而是棋盘右下角外侧的一行小字
「演出中，请稍候…」，演完自动消失：

- **纯 CSS 伪元素**：`body.frp-anim-busy .board-wrapper::after { content: '演出中，请稍候…' }`
  （`css/style.css` 的「演出期间锁输入」一节）。演出状态本来就在 `<body>` 的类名上
  （平台的 `shared/ui/anim.js` 挂的），所以**本作一行 JS 逻辑都不用加** ——
  少一个 JS 状态就少一处"忘了清掉"的地方。淡入 0.18 秒（不是"啪"地弹出来）。
- **颜色走本作自己的变量**：背景/边框/文字用 `--ui-surface` / `--ui-border` / `--ui-muted`
  （就是文件末尾把平台 `--ui-*` 映射过来的那一组），不写死颜色，跟本作视觉一致。
- ⚠️ **伪元素必须 `position: absolute`**：`.board-wrapper` 是 `display: flex`，
  伪元素一旦留在流里就会变成一个 flex 子项、跟着参与布局，把棋盘挤小/挤偏 ——
  而棋盘的"画布网格 / px 定位的格子 / 格子里的棋子"共用同一个原点，
  挪一点就是"棋子对不上十字交点"。`.board-wrapper` 上那句 `position: relative`
  只给它当定位基准，**不改布局**。
- ⚠️ **位置按棋盘算，不按 wrapper 的右下角算**：`--board-w` / `--board-h` 由
  `buildBoard()` 写在 `:root` 上（和 `--cell-size` 一起），CSS 里
  `top: calc(50% + 棋盘高/2 + 4px)`、`left: calc(50% + 棋盘宽/2)` 再 `translateX(-100%)`，
  也就是"贴着棋盘右下角的外侧"。为什么不用 wrapper 自己的右下角：wrapper 是 `flex:1`
  且棋盘居中，在"宽高同时吃满"的窗口里 wrapper 的右下角**正好压在棋盘最后一格上**
  —— 那就遮住棋子了。实测：430×932 时棋盘下方有 157px 余量、桌面上（棋盘高度吃满）
  那行字落在棋盘下沿外 4px 处，两种情况下页面横向溢出都是 0。
- 不拦截点击（`pointer-events: none`）、单行不换行、右边界不超过棋盘右边界
  （所以撑不出横向滚动条 —— 平台体检实测 `scrollWidth`，多 1px 就红）。
- ⚠️ **别再往 `#game-board` 上加 `opacity` / `filter`**。用例第 11b 节钉着
  "演出期间棋盘的 `opacity` 必须还是 1、`filter` 必须是 `none`"，
  谁把暗屏加回来立刻红。

## 首页身份行（你：X · ID Y）

用户发现本作首页没有名字/ID（另外两个游戏都有），已补齐：`index.html` 的菜单屏里
一行 `.cg-me`，`js/ui/app.js` 的 `renderMeLine()` / `bindMeLine()` / `copyMenuMeId()` 管它。

- 名字与 ID 都来自**平台账号**（`docs/GAME-SPEC.md` §6），本作**不许**再出现输入名字的界面。
- **点 ID 能复制**：走平台共用的 `FrpUI.copyText(id, '玩家 ID')`
  （`shared/ui/ui.js`；HTTP 下 `navigator.clipboard` 不可用，它有退路）——
  **不要**自己写 clipboard。按钮上写的是 `ID xxxx`，交给复制函数的是**纯 ID**。
- **立刻显示，不等 WebSocket**：先 `GameNet.cachedMe()`（浏览器里记着的那份身份，
  `localStorage` 的 `frp.me`，见 `shared/net/net.js`）画出来，`Net.on('ready')`
  到了再用 `GameNet.me` 对齐。理由：游戏页是一次整页跳转，公网那次握手要 2~3 秒，
  等它就是一段"我是谁？"的空白。
  ⚠️ **不要**拿 cachedMe 去填 `GameNet.me`、也不要拿它判断登录态 ——
  登录态永远由服务端说了算（平台外壳的登录竞态用例钉着这条）。
- ⚠️ 左右两个**可点目标**（ID 按钮）必须 ≥44px：`min-width/min-height: 44px`
  在 `.cg-me-id` 上，别为了紧凑改小（`tools/check-game.mjs --browser` 实测）。
- 本作**没有**"还没登录"那类拦截（grep 过：没有 `还没登录` 文案、也没有
  `GameNet.me` 的登录门），所以另外两个游戏"页面打开 2~3 秒内点开始被误判没登录"
  那条毛病本作没有；身份行是这条要求在本作的落地。

## 音效 / 特效开关（**只读写平台那一份偏好**）

用户原话："平台设置栏里有总开关，游戏里的开关跟随它，两处不会打架"。

棋盘底栏和首页各有一对开关（`data-pref="sound"` / `"fx"`），但**值只有一份**：
`shared/ui/ui.js` 的 `FrpUI.prefs`（`localStorage` 的 `frp.prefs`）。
本作原来自己存 `cg.sound` / `cg.fx` —— 那样会出现"平台开着、游戏关着"的打架局面，**已废**。
`js/ui/app.js` 现在只干三件事：

| 什么时候 | 干什么 |
| --- | --- |
| 打开页面 | `FrpUI.prefs.sound()/fx()` 读出来 → `applyPrefs()` 接到下面那三处 |
| 点本作的开关 | `FrpUI.prefs.setSound(b)/setFx(b)`（平台设置栏会同步） |
| 别处改了 | `FrpUI.prefs.on(cb)` 订回来 → `applyPrefs()`（平台设置栏 / 另一个标签页改了都算） |

要接的东西有三处，缺一个就是"假开关"：

| 接哪 | 管什么 |
| --- | --- |
| `AudioManager.enabled` | 本作自己合成的音效（`js/ui/audio.js`，每个 `playXxx()` 第一行就 return） |
| `FrpReact.setSound/setFx` | 平台那套互动（扔鸡蛋/鲜花）的音效与飞行动画 |
| `FrpAnim.setEnabled` | 演出队列的时长（关掉 = 立刻演完，不拖时间） |

⚠️ **老键 `cg.sound` / `cg.fx` 不要删、也不要再写**：平台侧在"用户从来没设过"时会拿它们
推默认值（老用户的设置因此不会丢），那是 `FrpUI.prefs` 的迁移逻辑；
本作一个字节都不再写它们（用例钉着"点完开关 `cg.sound` 还是 null"）。
⚠️ **不要接 `FrpUI.sound.bindClicks()`**：本作自己的按钮已经有音效
（`showScreen()` 等处各响一次），再接一遍会响两声。
⚠️ 两个按钮的可点区域**必须 ≥44px**（平台硬指标，`tools/check-game.mjs --browser` 会实测）。
特效的默认值（用户从没设过时）跟着系统的 `prefers-reduced-motion` 走 ——
那条判断现在也在 `FrpUI.prefs` 里（本作只在平台脚本没挂上时才自己兜一遍）。

## 对阵条（头像）

棋盘页顶部那条 `.versus-bar` 是两个座位：**自己=蓝圈 / 其他真人=橙圈 / 人机=灰虚线圈**，
名字是**单字**，带 `data-frp-avatar` + `data-frp-name` —— 点一下就能扔鸡蛋 / 送鲜花
（互动由 `/shared/ui/react.js` 全包，本游戏**一行都不用写**）。
数据来自**房间成员列表**（`GameNet.room.members`，带 `isBot`）和 `mySide`；
**单机对局没有 id、也没有名字**，所以画的是不可点的纯标记（你 / 电脑）——
用户明确允许这条退路，**别为了它去改引擎或往 view 里塞名字**。

## 怎么验证

```bash
node tools/check-game.mjs cannon-goblin            # 骨架 + 零 DOM + 服务端契约 + 跑用例
node tools/check-game.mjs cannon-goblin --browser  # 再加真浏览器（含界面体检 + 本作用例）
node --test games/cannon-goblin/tests/rules.test.mjs      # 规则 / 视图裁剪 / 接入层
node --test games/cannon-goblin/tests/ai-fill.test.mjs    # 人机座位专项（1 人+1 人机整局等）
node games/cannon-goblin/tests/browser.ai-fill.mjs        # 建房→加人机→开始→走一步（含演出/开关/头像）
node games/cannon-goblin/tests/sim.mjs 4 normal    # AI 自我对弈压测（慢）
```

改联机、棋盘渲染或动画之后，`--browser` 那条必须跑。

改「演出期间的观感」「首页身份行」「音效 / 特效开关」之后也是同一条（只有真浏览器量得出来）：

- **演出期间不暗屏**（第 11b 节）：棋盘的 `opacity` 必须**还是 1**、`filter` 必须是 `none`
  —— 这一条是**从"要变灰（opacity < 1）"反过来改的强化断言**：用户说不要暗屏，
  那用例就该钉住"颜色没变"，以后谁再加回去立刻红。同一节还量：
  那行小字在不在（`getComputedStyle(wrapper, '::after').content`）、
  `pointer-events` 是不是 `none`、棋盘下方有没有地方放它、页面横向溢出是不是 0；
  演出排空之后那行小字必须自己消失（`content === 'none'`）。
- **首页身份行**（第 15 节）：把 `GameNet.me` 清掉（模拟"ready 还没到"）+ 塞一份假缓存，
  再调 `renderMeLine()`，断言那一行**立刻**用的是缓存；还原之后要对齐回服务端那份；
  ID 按钮 ≥44px；点 ID 要把**纯 ID**交给 `GameNet.copy`。
- **偏好只有一份**（第 10 节）：点本作开关 → `localStorage` 的 `frp.prefs` 要变、
  `cg.sound` / `cg.fx` **都还是 null**；反过来用 `FrpUI.prefs.setSound/setFx` 改，
  本作要跟着变（这条钉的是 `prefs.on(cb)` 订阅）。

## 已删掉的东西（别加回来）

搬进平台时删掉了约 145 KB 只为"玩家没有服务器"而存在的代码：

- `js/mqtt.js`（手写 MQTT 3.1.1 over WebSocket 客户端）、`js/room.js`（旧房间层）
- 5 个公共 broker（EMQX / HiveMQ / mqtt-dashboard / mosquitto / eclipseprojects）、`ntfy.sh`
- WebRTC 优先 + 中继降级、通路中途切换、QoS0 补偿与 2 秒全量重播、`busy` / `sid` 定向信令
- `functions/`（Supabase Edge Function 旧后端）、`favicon.png`、`tests/browser/`

这些解决的全是"没有服务器"带来的问题。现在**规则由服务器裁决**，
所以历史上那些坑（直连断了误判成"对手走了"、两端静默不同步、broker 限流）整类消失了。
`tools/check-game.mjs` 会扫 `mqtt` / `broker` / `ntfy` / `RTCPeerConnection` / `wss://`，
加回来就会报错。