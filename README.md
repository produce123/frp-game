# frp-game · 一个跑在自己电脑上的网页桌游平台

**中文** · [English](README.en.md)

> 适合**小团体之间的桌游**：宿舍、班级、社团，甚至大学水课上。
> 不用每个人下载客户端 —— 你在一台 Windows 电脑上跑一个 Node 进程，
> 同学用浏览器打开一个网址就能一起玩。

- 账号、好友、房间、邀请、头像全平台共用一套；好友列表能看到「正在玩 XXX」，没开局可以直接进入。
- 10 个游戏：3 个自建小游戏 + 7 个缝合的开源上游项目（三国杀 / 狼人杀 / 斗地主 / 大富翁 / 广东麻将 / 地平线赛车 / AI 小镇）。
- 手机能玩：五个横屏大项目有伪横屏外壳，所有游戏都有可选的「全屏」按钮（电脑端不显示）。
- 零第三方运行时依赖：服务端只用 Node 自带能力，一个进程、一个 SQLite 文件就能跑。

> ⚠️ 本项目仅供**学习交流和朋友之间娱乐**，**禁止商用**（售卖、付费运营、商业部署等）。
> 各上游项目的许可证见文末，GPL-3.0 项目再分发时必须继续遵守 GPL。

---

## 目录

- [游戏一览](#游戏一览)
- [为什么做这个](#为什么做这个)
- [部署到你自己的电脑](#部署到你自己的电脑)
- [日常使用](#日常使用)
- [上游项目与许可证](#上游项目与许可证)
- [隐私：仓库里没有什么](#隐私仓库里没有什么)
- [开发者命令](#开发者命令)
- [文档](#文档)

## 游戏一览

| 游戏 | 入口 | 人数 | 说明 |
| --- | --- | --- | --- |
| 🎴 无名杀（三国杀） | `/noname/` | 2–10 | 原版上游静态托管：身份局 / 国战 / 塔防，武将包完整，可联机 |
| 🐺 狼人杀 | `/werewolf/` | 4–18 | 房主配角色，打字发言，结束后能在「对局记录」里看复盘 |
| 🃏 斗地主 | `/ddz/` | 3 | 叫地主 → 抢地主 → 出牌；牌桌是上游 Godot 网页版 |
| 🎲 大富翁 | `/games/monopoly/` | 1–6 | 上游 3D 棋盘，买地盖楼收租，5 张公开地图，可联机 |
| 🀄 莲花广麻 | `/mahjong/` | 2–4 | 四人广东麻将：碰杠吃胡买马，单机也能和 AI 打 |
| 🏎️ 地平线赛车 | `/games/horizon/` | 2–8 | 开放世界海岸赛道 3D 竞速；联机车与车真实碰撞，手机有触屏按键 |
| 🏘️ AI 小镇 | `/ai-town/` | 1–4 | AI 村民自己过日子的 2D 小镇；房主开自己的存档，朋友进同一张图，各自有化身 |
| 💣 大炮轰小鬼 | `/games/cannon-goblin/` | 1–2 | 不对称棋盘：大炮隔空吃子，小鬼靠数量堵死大炮 |
| 🔫 Shell Gambit | `/games/shell-gambit/` | 1–4 | 恶魔轮盘：霰弹枪、7 种道具，胆子和运气 |
| ⚔️ 刀马 BladeSteed | `/games/blade-steed/` | 2–4 | 武侠猜拳：赢了才能动手，买刀买马、出城砍人 |

平台首页支持**搜索**、按**人数筛选**、按**拼音首字母 A–Z** 浏览；点卡片会**新窗口打开**游戏，
方便同时挂几个游戏页面。

## 为什么做这个

想和朋友联机一个小游戏，通常要每个人先下载、注册、加好友、找房间 —— 为了水课上的 20 分钟，
成本太高。网页端的好处是：

- **零安装**：发一个链接，手机/电脑浏览器点开就能玩。
- **账号统一**：一个平台账号进所有游戏，不用在每个游戏里重新起名字。
- **服务器是你自己的**：数据留在自己电脑上，没有第三方平台抽成或停服风险。
- **能随时改**：规则、界面、新游戏都可以自己加。

## 部署到你自己的电脑

> 详细、可交给 AI 照着做的步骤在 **[`DEPLOY.md`](DEPLOY.md)**。
> 这里只给最短路径。

### 1. 准备

- **Windows 10/11**（其它系统理论上能跑，但仓库的脚本/路径按 Windows 写）
- **Node.js ≥ 24**（要 `node:sqlite`，Node 22 不够）
- 可选：**Python 3.11+**（只有莲花广麻需要）
- 可选：**Chrome 或 Edge**（只有跑真浏览器测试需要）

### 2. 启动

```powershell
cd E:\frp-game
npm start
```

本机打开 <http://127.0.0.1:7891/>，注册一个账号就能玩。

也可以双击：

| 文件 | 作用 |
| --- | --- |
| `start.cmd` / `stop.cmd` / `status.cmd` / `restart.cmd` | 后台开关服务、看状态 |
| `install-autostart.cmd` / `uninstall-autostart.cmd` | 登录 Windows 时自动启动（不需要管理员） |

> 服务默认只监听 `127.0.0.1:7891`，**同一局域网的其他电脑也访问不到**。
> 想让朋友从外网访问，需要一条隧道（下一步）。

### 3. 让朋友从外网访问（可选）

推荐 **SakuraFrp**（免费、国内可用）：

1. 在面板建一条 **TCP 隧道**，本地地址填 `127.0.0.1:7891`；
2. 打开隧道设置里的「**自动 HTTPS**」；
3. 把面板给你的公网地址（形如 `https://xxx:端口`）发给朋友。

> 为什么不是 HTTP 隧道：国内节点会拦明文 HTTP（返回它自己的 501 页，请求根本到不了你的电脑）。
> 开「自动 HTTPS」后，TLS 在隧道那端终止，你的 Node 服务仍然只讲明文 HTTP。
> 细节与排障见 [`docs/TUNNEL.md`](docs/TUNNEL.md)。

### 4. 可选组件

- **莲花广麻**：需要 Python 后端。按 [`DEPLOY.md`](DEPLOY.md) 里的命令建一个 `.venv` 并装依赖；
  没装时麻将页会 503，其它游戏不受影响。
- **无名杀**：上游源码约 1.2GB，**不进仓库**。需要时运行 `node tools/noname-update.mjs`
  拉取并构建；没拉取时 `/noname/` 不可用，其它游戏不受影响。
- **大富翁 / 狼人杀 / 斗地主**：构建产物已经提交，**开箱即用**，不需要 `pnpm install`。
- **AI 小镇**：前端产物已提交，开箱能开页面；**Rust 的 `bin/` 和内置模型不进仓库**。
  本机已经编译/放好；换机器要么把 `games/ai-town/bin/` 和 `data/ai-town/models/model.gguf`
  一起拷过去，要么按 `DEPLOY.md` 重编 Rust + 下载模型（约 505MB）。
  服务器只跑 `llama-server.exe`（Vulkan），手机端不跑模型。
  ✅ AI 小镇现在支持**房主和每个客人各自降临**：每人在自己屏幕上是上帝，自己走、自己聊；
  别人头顶会显示他的平台头像和昵称（小圆点，不挡画面）。世界设置（开始/暂停、天气、
  请村民）只归房主；客人是临时访客，不写进房主存档。

## 日常使用

- **首页**：搜索框查游戏名；右边圆形按钮筛人数；最右一列字母表点一下跳到对应首字母。
- **好友**：注册后把自己的 7 位 ID 发给朋友，对方在「好友」里搜索/申请，你同意后生效。
- **房间**：每个游戏页都有房间面板；好友的房免密码；没开局时好友列表会显示「进入」。
- **全屏**：手机端右下角有「⛶ 全屏」；进入全屏后按钮会**自动隐藏**，用手机返回键退出。
  电脑端不显示这个按钮（用 F11）。
- **新窗口**：首页卡片、好友「进入」、邀请「接受」都会新开标签页，不会顶掉平台首页。

## 上游项目与许可证

本项目**不是所有游戏都从零写的**，下面这些是直接搬/缝了上游项目：

| 游戏 | 上游项目 | 许可证 | 本项目做了什么 |
| --- | --- | --- | --- |
| 无名杀（三国杀） | [libnoname/noname](https://github.com/libnoname/noname) | **GPL-3.0** | 原样静态托管 + 平台登录/账号/头像桥接 + 手机伪横屏外壳 + 联机中继 |
| 狼人杀 | [hanluolin/wolfcha-custom](https://github.com/hanluolin/wolfcha-custom) | **MIT**（界面） | 只搬界面；规则引擎、房间、账号、复盘是本仓库重写的 |
| 斗地主 | [blmz/GODOT-DouDiZhu](https://github.com/blmz/GODOT-DouDiZhu) | **上游未声明 LICENSE** | 牌桌是上游 Godot 网页导出；规则/状态机/联机由本仓库重写 |
| 大富翁 | [FatPaper-1874/mine-monopoly](https://github.com/FatPaper-1874/mine-monopoly) | **GPL-3.0** | 整份 Web 客户端静态托管 + WebSocket 中转 + 平台账号注入 |
| 莲花广麻 | [BestGuo2020/lianhuaguangdongmahjong](https://github.com/BestGuo2020/lianhuaguangdongmahjong)（前端）<br>[BestGuo2020/lianhua-mahjong-backend](https://github.com/BestGuo2020/lianhua-mahjong-backend)（后端） | **MIT** | 整份项目搬入 + Node 反代 + 平台账号/邀请接线 |
| 地平线赛车 | [Liyang1145/horizon-racing](https://github.com/Liyang1145/horizon-racing) | **MIT** | 3D 世界/物理原样搬入 + 平台房间/邀请 + `/horizon-relay` 车位置 + 起终点拱门 + 手机触屏/伪横屏 |
| AI 小镇 | [mewamew/my_ai_town](https://github.com/mewamew/my_ai_town) | **PolyForm Noncommercial 1.0.0** | Rust 世界内核 + manager + TS 前端搬入；平台账号/邀请/房间 + 每账号存档 + 多化身联机 + 手机布局 + 服务器端内置小模型 |

三个自建小游戏（大炮轰小鬼 / Shell Gambit / 刀马）的规则引擎与界面在本仓库内；
地平线的 3D 世界来自上游（MIT），平台接线在本仓库内。整体按 MIT 发布。
AI 小镇的上游代码按 **PolyForm Noncommercial 1.0.0** 使用：只许非商业用途，再分发时保留原许可证与 NOTICE。

> **禁止商用**：本项目整体仅供个人学习、朋友之间娱乐。不要拿它做付费服务、售卖、
> 商业运营或任何以营利为目的的部署。上游项目各自的许可证仍然有效；如果你再分发
> GPL-3.0 的上游代码/产物，必须遵守 GPL-3.0。

## 隐私：仓库里没有什么

发布到 GitHub 的版本**不包含**：

- `data/`：账号数据库、密码哈希、会话、日志、上传的头像；
- `frpc/**/*.local.ini`：隧道访问密钥、真实端口、隧道 ID；
- 真实公网地址、访客 IP、隧道节点信息；
- `games/noname-web/`：上游 1.2GB 源码与构建依赖；
- 任何 `.env`、证书、私钥。

这些路径都在 `.gitignore` 里。仓库里出现的地址一律是 `<公网地址>` 之类的占位符。
你自己部署时，真实地址只应留在你的隧道面板和本机被忽略的配置里。

## 开发者命令

```powershell
npm test              # Node 集成测试（真 HTTP + 真 WebSocket）
npm run test:browser  # 真 Chrome 端到端（平台外壳 / 房间 / 登录 / 游戏页面 / 全屏 / 地平线）
npm run test:ai-town  # AI 小镇（真 manager/host/WS + 布局；用 --mock-llm）
npm run test:horizon  # 地平线赛车（5 条服务器/中继 + 真 Chrome 双人联机）
npm run test:mahjong  # 莲花广麻（需要 Python .venv）
npm run test:ddz      # 斗地主（Godot 牌桌）
npm run test:monopoly # 大富翁
npm run test:werewolf # 狼人杀
node tools/check-noname.mjs                # 无名杀托管体检
node tools/check-tunnel.mjs <公网地址> --ws 30   # 公网隧道体检（只读）
```

## 文档

| 想知道 | 看 |
| --- | --- |
| 怎么在另一台电脑上部署（写给 AI 照着做） | [`DEPLOY.md`](DEPLOY.md) |
| 当前进度、下一步、已知小毛病 | [`docs/NEXT.md`](docs/NEXT.md) |
| 架构、协议、各游戏怎么接进来的 | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| 某个设计为什么这样（D1–D48） | [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| 各游戏的坑与口径 | [`docs/GAMES.md`](docs/GAMES.md) |
| 公网 / 隧道排障 | [`docs/TUNNEL.md`](docs/TUNNEL.md) |
| 开发约定（给接手的 AI） | [`AGENTS.md`](AGENTS.md) |

## License

本仓库自己的代码按 **MIT** 发布（见 [`LICENSE`](LICENSE)）；
缝合的上游项目仍归各自作者所有，许可证见上表。**禁止商用。**
