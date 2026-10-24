# 斗地主（`/ddz/`）

三个人一桌：叫地主 → 抢地主 → 出牌 → 结算。

**牌桌（界面）是上游 [blmz/GODOT-DouDiZhu](https://github.com/blmz/GODOT-DouDiZhu) 的
Godot 网页导出，原样跑在一块 canvas 里**；平台这边只提供"身份 + 房间 + 联机"那一层，
**规则和状态机在服务器**（`js/engine/**`）。用户明确要求"别自己画斗地主界面"，所以：

| 层 | 在哪 | 谁说了算 |
| --- | --- | --- |
| 牌桌画面、手牌、按钮、音效、结算动画 | `table/`（Godot 导出的 wasm + pck，在 iframe 里） | 上游那套界面，只负责**画** |
| 规则（牌型、谁能压谁、叫抢地主） | `js/engine/rules.js`、`js/engine/game.js`（服务器进程里跑） | **服务器** |
| 身份、房间、邀请、开始/再来一局、按人裁剪的视图 | `index.html` + `js/online.js` + `/shared/ui/room.js` | 平台 |
| 上游的**源码**（要改牌桌才动它） | `godot/`（Godot 4.4 工程，能重新导出） | 你 |

- 入口：`http://127.0.0.1:7891/ddz/`（公网地址见隧道面板；**必须登录平台**，未登录 302 回登录页）
- 手机：`/play/ddz` 是伪横屏外壳（牌桌是 1280×720，竖屏会被压扁）；电脑打开外壳会自动回 `/ddz/`
- 平台首页卡片：`web/assets/js/games.js` 里 `slug: 'ddz'` + `href: '/ddz/'`
- 服务端接入层：`server/games/ddz.mjs`（自动发现，重启后日志里能看到「已接游戏 ddz」）
- 设计决定：`docs/DECISIONS.md` **D35（已被 D40 取代）**；架构：`docs/ARCHITECTURE.md`《斗地主（/ddz/）》
- 坑与口径：`docs/GAMES.md`《斗地主》

## 为什么不"照上游托管一份就完事"

上游是**单机**项目：`脚本/手牌管理器.gd` 里同时写着规则、界面、两个弱 AI 和发牌。
它没有联网、没有账号、没有房间，也没有 LICENSE。所以本仓库的做法是：

1. **界面照原样用**：把上游工程导出成网页版，塞进 iframe。牌面、语音、动画、结算画面都是上游的。
2. **规则搬到服务器**：`rules.js` 按上游的 `判断牌型()`/`是顺子()` 等逐条移植（中文牌型名都没改），
   但**只有一份**，跑在服务器进程里；客户端没有任何本地规则。
3. **上游的 AI / 倒计时 / 商店页面 / 开始页面删掉**：用户拍板"不加电脑，就三个真人"。
4. **两处必须改的**：`脚本/手牌管理器.gd` 从"本地引擎"改成"联机客户端"（收发视图），
   `结算界面.gd` 的"退出游戏"不再 `change_scene_to_file` 回已经被删掉的开始页面。

## 目录结构

```
games/ddz/
  index.html              平台壳：页头（平台昵称）/ 房间面板 / 牌桌那一层（iframe）+ 加载与"横过来"提示
  css/table.css           壳的样式（牌桌自己那套样式在 pck 里，不在这里）
  js/online.js            页面主控：身份、房间外壳、把视图推给牌桌、把牌桌的意图发回服务器
  js/engine/cards.js      54 张牌：编码、洗牌、排序（纯逻辑）
  js/engine/rules.js      牌型 classify + 比大小 canBeat（**服务器与浏览器共用这一份**）
  js/engine/game.js       一局的状态机：发牌 / 叫地主 / 抢地主 / 出牌 / 结算 / 作废 + viewFor 裁剪
  table/                  **Godot 网页导出产物**（9 个文件 / 51 MB；浏览器缓存 + 服务器 gzip）
  godot/                  上游工程的源码（443 个文件 / 15 MB，含我们改过的两个 .gd + 导出预设）
  tests/engine.test.mjs   37 条引擎单测（牌型/比大小/叫抢/视图裁剪/"engine 里零宿主 API"）
server/games/ddz.mjs      平台接入层：meta + createMatch（座位表 ↔ 引擎）
tests/ddz.test.mjs        18 条平台集成（登录门/唯一地址/wasm gzip+ETag/三人座位/整局/作废）
tests/ddz.browser.mjs     真 Chrome：邀请进房 / 三块牌桌 / **在 canvas 上真点按钮** / 打完一局 / 手机壳
```

**依赖方向**：`games/ddz/**` 只用 `shared/**`；`server/games/ddz.mjs` 只 import 本游戏的引擎。
`table/` 和 `godot/` 是**上游的东西**，谁都不 import 它们 —— 它们只跟 `js/online.js` 通过下面两条桥说话。

## 页面 ↔ 牌桌的两条桥（改 GDScript 必读）

`js/online.js` 在页面加载时就把两个对象挂到 `window` 上，**并且贴进 iframe 自己的 window**
（Godot 的 `JavaScriptBridge.get_interface()` 只认它自己那个 window 上的全局）：

| 方向 | 调用 | 参数 | 用途 |
| --- | --- | --- | --- |
| 页面 → 牌桌 | `FrpDdzTable.接上(onPush, onReset)` | 两个回调 | GDScript 在 `_ready` 里交出自己的回调 |
| 页面 → 牌桌 | `FrpDdzTable.推视图(json)` | 服务器视图（JSON 字符串） | 每次 `room.state` 推一份 |
| 页面 → 牌桌 | `FrpDdzTable.重置()` | 无 | 回等待态时清桌 |
| 牌桌 → 页面 | `FrpDdzHost.动作(json)` | `{type:'bid'|'play'|'pass', value?, cards?}` | 玩家点了按钮 → 发 `room.act` |
| 牌桌 → 页面 | `FrpDdzHost.事件(名字)` | `'就绪'` / `'再来一次'` / `'退出'` | 加载完、结算页按钮 |
| 牌桌 → 页面 | `FrpDdzHost.渲染(json)` | 观测用数字 | 存进 `window.__FrpDdzTable`，**只给测试和排查看** |

⚠️ **Godot 的 `JavaScriptObject` 只转发方法调用**（`对象.方法(...)` → `obj['方法'](...)`），
没有"给属性赋值"那条路：GDScript 里写 `表.set("推视图", 回调)` 会报
`TypeError: obj[method] is not a function`。所以页面给的是 `接上()` 这个方法，不是 setter。

## 视图（服务器权威的唯一出口）

`viewFor(playerId)` 给的就是这些，别人的手牌**永远只有一个数字**：

```js
{
  seat, phase, stage,        // stage: call（叫地主）/ rob（抢地主）/ playing / over
  hand,                      // 只有自己的 17/20 张（带 id、点数 r、花色 s）
  players: [{ seat, id, name, avatar, count, isLandlord, passed, label }],
  bottom,                    // 叫地主结束前 null；定完地主公开 3 张
  landlord, turn, bids,
  lastPlay: { seat, type, len, rank, tail, rankText, tailText, cards },  // 公开
  winner: { side: 'landlord'|'farmers', seats }, aborted,
}
```

- `rankText` / `tailText` 是**中文点数**（"顺子 3 到 10"这种语音要念的），省得两边各写一张点数表。
- 页面在推给牌桌之前会补一个只读字段 `players[].avatarData`（96×96 PNG 的 data URL）：
  Godot 解不了 SVG，而平台的默认头像是 SVG，所以由浏览器把 `/avatar/<id>` 画成 PNG 再递进去。
- 浏览器也 import `rules.js`，但**只用来**把按钮灰掉那种提示；服务器 `act()` 会重算一遍。

## 规则口径（全部在 `rules.js` / `game.js`）

| 项 | 口径 |
| --- | --- |
| 人数 | **固定 3 个真人**（`minPlayers = minSeats = maxPlayers = 3`，`maxBots = 0`） |
| 发牌 | 54 张：每人 17 + 底牌 3；随机一家先被问 |
| 叫地主 | 三家依次「叫地主 / 不叫」，**第一家叫的人是候选**；三家都不叫 → 重新发牌（上限 20 次） |
| 抢地主 | 候选之后的两家依次「抢 / 不抢」，**最后一个抢的人当地主**（没人抢则候选当地主） |
| 地主 | 拿底牌（20 张），先出牌 |
| 牌型 | 单/对/三/三带一/三带二/顺子(≥5)/连对(≥3 对)/飞机(**纯三张**)/炸弹/四带一/**四带二(四张+一对)**/王炸 |
| 连牌 | 顺子/连对/飞机只到 **A**；2 与大小王不能进连牌 |
| 比大小 | 同牌型 + 同张数比点数；炸弹压普通牌型、炸弹之间比点数；王炸最大 |
| 不出 | 只有跟牌时才能不出；另外两家都不出 → 上一手出牌的人重新领出 |
| 胜负 | 地主出完 = 地主赢；任一农民出完 = 农民赢 |
| 刻意没有 | 春天、底分/倍数、金币赌注、明牌/加倍、癞子、二人斗地主、倒计时、聊天、战绩、观战、中途加入、人机 |

**和上游唯一一处故意的差异**：上游 `比较牌型大小()` **只比头点数，不比牌型也不比张数**
（所以"单张 3"能压"一对 2"，而且它默认客户端已经排好了序）。三家真人这样根本打不了，
本仓库改成标准的"同型同长比点数 + 炸弹/王炸"。这一条写进了 `docs/DECISIONS.md` D40。

**为什么没有 AI / 倒计时**：用户拍板（"就三个真人"）。代价很实际 ——
**有人中途离开，这一局只能作废**（没有 AI 能接管他的手牌），页面会提示「本局作废：…」。

## 交付与缓存（42 MB 的 wasm 不是小事）

- `index.wasm` 42 MB → **运行时 gzip 后约 9 MB**（`server/http.mjs` 的 `COMPRESSIBLE` 里加了 `.wasm`）。
  手机上第一次进对局大概下 10 MB 左右，之后走缓存。
- `.wasm` / `.pck` 的 `Cache-Control` 是 **`public, no-cache` + ETag**：每次重新验证，没变就 304。
  为什么不给长缓存 —— 重新导出之后同名文件内容会变，长缓存会让用户一直玩旧版本。
- `index.pck` 9.8 MB：**不压**（已经把图片/音频压过了，gzip 只省几百 KB，白费 CPU）。
- 改了 `table/` 之后要提醒用户**强刷**（`Ctrl+F5`）；浏览器里可能还留着旧 wasm。

## 重新导出牌桌（改了 `godot/` 之后）

需要 **Godot 4.4.x** + **网页导出模板**（`export_templates/4.4.1.stable/web_nothreads_release.zip`，
在 Godot 里「编辑器 → 管理导出模板」一键装，约 1.3 GB 那一步）。工程里已经带了
`export_presets.cfg`（预设名 **Web**，单线程变体 —— 所以**不需要** COOP/COEP 头）。

```powershell
# 1. 导出（headless，不用开编辑器界面）
& "C:\path\to\Godot_v4.4.1-stable_win64_console.exe" --headless `
  --path "E:\frp-game\games\ddz\godot" `
  --export-release "Web" "E:\frp-game\games\ddz\table\index.html"

# 2. 看一眼产物（9 个文件、约 51 MB；index.wasm 应该 ~42 MB）
Get-ChildItem "E:\frp-game\games\ddz\table" | Select-Object Name,Length

# 3. 跑一遍真浏览器（会真启动三块牌桌）
node tests/ddz.browser.mjs
```

- 工程里删掉了上游的**开始页面、人机出牌、商店/开关图片、bgm3**（用不上，还占 pck）。
  `project.godot` 的主场景已经指到 `场景/手牌管理器.tscn`。
- 改 `.gd` 之后 `table/` 不会自己变 —— **必须重新导出**，否则线上还是旧牌桌。
- `godot/.gitignore` 里我们特意 `!export_presets.cfg`（上游默认把它忽略了，忽略掉就没法复现导出）。

## 测试

```bash
npm run test:ddz                              # 引擎 37 + 平台 18 + 真 Chrome 一条
node --test games/ddz/tests/engine.test.mjs   # 只跑引擎（毫秒级）
node --test tests/ddz.test.mjs                # 只跑平台集成（真 HTTP + 真 WS）
node tests/ddz.browser.mjs                    # 只跑浏览器（需要本机 Chrome/Edge，约 1 分钟）
```

浏览器那条会起**随机端口的临时服务 + 四个全新的 Chrome profile**（三个玩 + 一个手机壳），
不碰正在跑的 7891。「在 canvas 上真点按钮」靠的是 GDScript 每次画完报上来的按钮坐标
（`window.__FrpDdzTable.playButtonRect`）+ `page.clickAt()` 派发**真实鼠标事件**。

## 已知遗留 / 下一轮可以做

- **没人管超时**：真人可能想很久（要做就得先决定"超时怎么出牌"，通常意味着要 AI 托管）。
- **没有春天/明牌/加倍/底分**：上游有倍数显示，我们没接（三个朋友玩，不结算分数）。
- **不存战绩**：打完就没了。复用 `game_records` / `game_record_players`（`game='ddz'`）即可。
- **离开就作废**：没有 AI 接管；以后要加人机，可以改成"AI 托管这副手牌"。
- **结算画面只显示"谁赢了"**：上游那套结算动画照搬了，但没有分数/倍数那一栏。
- **授权**：上游**没有 LICENSE 文件**（默认保留所有权利）。这里的用法国标是"本机自己玩"：
  **不公开分发、不商用**。要公开发布之前必须先解决授权。
- **牌桌细节没人工过一遍**：头像/昵称叠在牌桌上的位置（我 120,366 / 下家 668,236 / 上家 198,236）
  是照场景算的，agent 看不了图，**可能需要你肉眼再调一次**（改 `脚本/手牌管理器.gd` 的 `建玩家信息()`）。