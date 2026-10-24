# 狼人杀（/werewolf/）

上游：**hanluolin/wolfcha-custom**（MIT，纯前端 Next.js 16 / React 19）。
上游本身是"和 AI 玩狼人杀"的单机站；我们只用它的**界面与交互**，
规则引擎、房间、账号、邀请、战绩全部是本仓库重写的，**没有任何 AI/大模型/TTS**。

> 历史：上一版缝的是 xiong35/werewolf（Vue 3 + 独立 socket.io 后端），
> 用户要求换上游重做，旧版已整体删除（见 `docs/DECISIONS.md` D37）。

## 目录

| 路径 | 是什么 |
| --- | --- |
| `app/` | 上游界面改造后的 **Next.js 源码**（静态导出）。改页面只改这里 |
| `dist/` | `app/out/` 的产物，**提交进仓库**；平台直接静态托管，运行期不需要 node_modules |
| `engine/index.mjs` | **服务器权威规则引擎**（纯 ESM，零依赖）。身份、夜晚、发言、投票、警长、PK、结算全在这里 |
| `../../server/werewolf/index.mjs` | 接入层：平台会话 → 身份、HTTP 路由、`WW_EVENT` 推送、写 `game_records` |
| `../../tests/werewolf.engine.test.mjs` | 引擎单测（规则细节） |
| `../../tests/werewolf.test.mjs` | 平台集成（登录门/建房/满员/密码/好友免密/视图裁剪/邀请/整局/复盘） |
| `../../tests/werewolf.browser.mjs` | 真 Chrome（平台昵称头像、入口弹窗、警长开关、建房角色配置、邀请卡、6 人开局、375px、首页卡片） |

## 玩法范围（当前）

- **纯真人 4–18 人**，没有电脑：页面根本没接人机，坐满才发牌。
- **14 个角色**：狼人、白狼王、恶夜骑士、狼王、狼美人、预言家、女巫、猎人、守卫、白痴、
  骑士、长老、守墓人、平民。**房主建房时自己配**：每种角色填几个，只要求总数 = 座位数、至少 1 只狼；
  允许双女巫/双预言家/没女巫（同角色多人时各自独立行动）。新角色默认 0 个，老默认局不变。
- 建房入口是弹窗（选人数/角色/警长/密码）；**警长可以关**，关掉后第一天不竞选、没有警徽。
- 警长竞选（含 PK 发言、二次平票撕警徽）、放逐投票（平票 PK、再平票无人出局）、
  猎人/狼王开枪、白狼王/狼王自爆、骑士决斗、白痴翻牌、守卫/女巫"奶穿"、女巫毒杀、
  长老两条命/封印神职、恶夜骑士反伤、狼美人殉情、守墓人夜间信息、遗言、警徽移交。
- 打字发言，**每人 180 秒**；夜晚行动各自限时（服务器倒计时，超时自动推进）。
- 对局记录写 SQLite（`game_records` / `game_record_players`），**只有参与者**能复盘。

规则细节与"为什么"见 `engine/index.mjs` 顶部注释和 `docs/GAMES.md` 的《狼人杀》一节。

## 改前端（只有改页面时才需要）

```powershell
cd games/werewolf/app
pnpm install          # 第一次
pnpm build            # 产物在 app/out/

# 覆盖到提交目录（不要在 dist 里手改，下次构建就没了）
Remove-Item -Recurse -Force ../dist
New-Item -ItemType Directory ../dist | Out-Null
Copy-Item -Recurse -Force out/* ../dist/
```

要点：

- `next.config.ts` 里 `basePath: "/werewolf"`，所以页面里的资源会自动带 `/werewolf` 前缀；
  平台把 `dist/` 挂在 `/werewolf/`，两边对上。
- `public/` 只保留真正用到的：`avatars/`（本地像素头像）、`roles/`（职业立绘）、`brand/`。
  上游的 `tag_photo/`、`audio/`、`bgm/`、`models/` 是 AI 单机/复盘/模型站用的，**已删除**。
- 页面挂在 `/werewolf/` 下，Next 的 `/_next/**` 会被改成 `/werewolf/_next/**`；
  `server/http.mjs` 对 `_next` 做长缓存，入口页仍然 `no-store`（登录门在入口上）。
- 不要重新引入统计脚本、SEO 落地页、模型对比页、AI 设置面板 —— 用户要求全删。

## 改规则

只改 `engine/index.mjs`，然后：

```powershell
node --test tests/werewolf.engine.test.mjs tests/werewolf.test.mjs
node tests/werewolf.browser.mjs
```

`engine/` 里**不许出现** `document` / `window` / `fetch`（服务器进程直接 import 它）。
任何新字段进视图前先想清楚：**这是不是别人的底牌**。`viewFor()` 是唯一的裁剪点。

## 账号 / 好友 / 邀请

- 页面没有任何"填昵称/选头像"的入口：`/api/werewolf/me` 返回平台会话里的 `me`，
  头像就是 `/avatar/<id>`（`buildAvatarUrl` 见到 URL 直接透传）。
- 邀请走平台好友系统：房主在等候区点「邀请好友」→ 平台 `invite.send` →
  好友页面弹邀请卡（带 6 位房号）→ 点接受直接 `join`，**好友免密码**。
- 房间码是 6 位数字，和平台房间（`rooms.mjs`）不是一套 —— 这是有意的：
  狼人杀一局 4–18 人、角色可自定义、有密码、有更复杂的状态，走自己的房间表更简单。