# 莲花广麻（mahjong）

平台里**唯一一个规则跑在 Python 里的游戏**：上游是一份完整的开源项目（前端 + 后端），
本目录把它**整份搬进服务器**，Node 只做反向代理和平台账号/好友/邀请的接线。

- 上游前端：[BestGuo2020/lianhuaguangdongmahjong](https://github.com/BestGuo2020/lianhuaguangdongmahjong)（MIT，Vue 3 + Three.js + Vite）
- 上游后端：[BestGuo2020/lianhua-mahjong-backend](https://github.com/BestGuo2020/lianhua-mahjong-backend)（MIT，Python 3.11+ / FastAPI / uvicorn / SQLite）
- 抓取时的上游提交：`37bb286a74064b31df0654034e2c117681c490b0`（2026-10-20，`master`）
- 设计原因与被否掉的方案：`docs/DECISIONS.md` 的 **D43**

```
games/mahjong/
  upstream/web/      上游前端源码（含 .gitignore、vite 配置、public/；不含 node_modules）
  web/               前端的**构建产物**（提交；Node 静态托管在 /mahjong/）
  backend/           上游 Python 后端源码（独立项目；.venv 已 gitignore）
  README.md          本文件
```

## 用户看到的样子

- 平台首页多一张「🀄 莲花广麻」卡片，点「开始游戏」→ 手机 `/play/mahjong`（伪横屏）、
  电脑 `/mahjong/`。
- **账号就是平台账号**：页面里没有登录页、没有昵称输入框；大厅显示「当前账号 xxx」。
- 好友列表会显示「正在玩 莲花广麻」+「进入」；房间里点「邀请好友」→ 对方平台页收到邀请卡 →
  点「进入」自动进同一个房（`/mahjong/?join=房号`）。
- 单机/联机都是上游自己的界面与规则：东风场/半庄场、白板癞子、翻精癞子、碰杠吃胡、买马、AI 补位。
- 手机端右下角有可选全屏按钮（D42）；电脑端不显示。

## 平台给上游打的最小补丁

**前端**（`upstream/web/`，改完必须重新构建并覆盖 `web/`）：

| 文件 | 改动 |
| --- | --- |
| `src/game/online/api/httpClient.ts` | REST/WS 基址改成从页面目录推导（`/mahjong/api`、`/mahjong/ws`），不再写死 origin |
| `src/game/online/session/useWakuDemoAuth.ts` | 身份来源换成服务端注入的 `window.__FRP_ME__`；没有注入时保留上游 OAuth 行为 |
| `src/components/lobby/LobbyView.vue` | 平台托管时隐藏登录/退出按钮；不再显示昵称输入框，改为「当前账号」 |
| `src/App.vue` | `?join=房号` 自动进房（进房后从地址栏删掉）；启动 `src/frp/bridge.ts` |
| `src/frp/bridge.ts` | **新增**：15 秒房间心跳 + 「邀请好友」浮层（平台接口） |
| `index.html` | 去掉 Google Analytics；`favicon`/`manifest` 改相对路径（子路径托管） |

**后端**（`backend/`）：

| 文件 | 改动 |
| --- | --- |
| `app/api/deps.py` | 新增 `frp_trusted_identity()`：`FRP_TRUSTED_HEADERS=True` 时认 `x-frp-user-id/-name/-avatar`，`require_wakudemo_login()` 优先用它 |
| `app/api/auth.py` | `GET /api/login/session` 在可信身份下直接返回 `authenticated:true` + 平台账号 |
| `app/storage/db.py` | `PostgresStorage` 改成**按需导入**（没配 `PG_PASSWORD` 就不需要 psycopg） |
| `app/storage/sqlite.py` | 默认库路径支持 `MAHJONG_DB_PATH`（测试/多实例用独立库，不碰线上 `data/mahjong.db`） |

Node 侧(不属于上游补丁，但一起看)：
`server/mahjong/index.mjs`（起进程/健康检查/HTTP 反代）、`server/mahjong-presence.mjs`（心跳）、
`server/http.mjs`（静态页 + 登录门 + `/mahjong/api` 反代 + 注入身份）、
`server/ws.mjs`（`/mahjong/ws` 裸字节转发）、`server/hub.mjs`（邀请分支）。

> ⚠️ 补丁要**逐条**保留：上游更新后要么重新套一遍，要么用 diff 对齐。
> 不要 fork 上游、也不要把整份 UI 重写（用户明确要求）。

## 重新构建前端（改了 `upstream/web/` 才需要）

```powershell
cd E:\frp-game\games\mahjong\upstream\web
npm install            # 只在第一次或依赖变更后
npm run build          # typecheck + vite build → dist/
cd E:\frp-game
Remove-Item games\mahjong\web -Recurse -Force
Copy-Item games\mahjong\upstream\web\dist games\mahjong\web -Recurse
```

- 上游本来用 pnpm，npm 也能构建（仓库里提交的是 `web/` 产物，不是 `node_modules`）。
- `dist/` 和 `web/` 都是**相对路径**产物（`base: './'`）；页面地址必须是 `/mahjong/`（带尾斜杠），
  `server/http.mjs` 会把 `/mahjong` 301 过去。

## 第一次在新机器上准备后端

需要 **Python 3.11+**（本机用的是 3.14）。Node 会自动找
`backend/.venv/Scripts/python.exe`（Windows）或 `backend/.venv/bin/python`（其它系统）。

```powershell
cd E:\frp-game\games\mahjong\backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install `
  fastapi "uvicorn[standard]" pydantic websockets python-dotenv httpx PyYAML loguru
```

- **不需要 psycopg**：数据库默认 SQLite（`backend/data/mahjong.db`），只有配了 `PG_PASSWORD`
  才会走 Postgres（那时再 `pip install "psycopg[binary]"`）。
- 想换解释器：设环境变量 `MAHJONG_PYTHON=<python.exe 的绝对路径>`。
- 想换内部端口：设 `MAHJONG_BACKEND_PORT`（**不要**去动隧道，公网只映射 7891）。
- 想换后端数据库：`createMahjong({ dbPath })` 会传 `MAHJONG_DB_PATH` 给 Python（测试用临时库；
  正常运行时不用设）。

## 怎么跑

```powershell
npm start        # server/server.mjs：自动起后端 → 等 /api/health → 才开始对外服务
```

- 后端日志：`data/mahjong-backend.log`（gitignored）。
- 后端进程由 Node 托管：Node 退出会先 SIGTERM 再 SIGKILL；后端挂了只会让麻将页接口 503，
  其它游戏照常。日志里会打 `[麻将后端] ...`。
- 后端**只监听 `127.0.0.1:8123`**；公网流量走 7891 的 `/mahjong/api/*` 与 `/mahjong/ws/*`。
- 直接访问 `127.0.0.1:8123` 没有平台身份头，也不算登录态；不要把它映射到公网。

## 测试

```powershell
npm run test:mahjong          # 平台 10 条 + 真 Chrome
npm run test:mahjong:node     # 只跑 Node 集成（要 .venv）
```

- `tests/mahjong.test.mjs`：登录门 / 301 / `__FRP_ME__` 注入 / 伪造身份头被覆盖 /
  未登录 401 / 建房加入准备开局 / WS 反代 `rejoin_ok` + 快照裁剪 / presence / 邀请回执。
- `tests/mahjong.browser.mjs`：真 Chrome 跑登录门回跳、账号一致、大厅没有昵称框、
  建房、好友「正在玩/进入」、游戏内邀请后自动进房、375px 伪横屏、桌面回真页面。
- `tests/mahjong.join.browser.mjs`：单独起服务和浏览器，专测「未登录打开 `?join=房号` →
  注册 → 登录回跳 → 自动进同一个房」；单独跑是为了不和其他 Three.js 页面抢无头 Chrome。
- 测试用**独立端口 8199 + 临时 SQLite**，不会复用/污染正在运行的线上后端（8123）。
- 后端起不来时 Node 用例会 **skip**（不会把 `npm test` 拖红），浏览器用例会直接失败并提示缺 venv。

## 已知边界（不是 bug）

- **邀请卡只在平台页面上弹**（和大富翁一样）：麻将页不连平台 WS，页面里只有「发出邀请」；
  收到邀请的人在平台首页/游戏列表页看到卡片，点「进入」再由 `/mahjong/?join=` 进房。
- **房号是上游麻将的**（6 位大写字母/数字），不是平台 `rooms.mjs` 的 6 位短码；
  平台只做格式校验和转发，不解析麻将房间状态。
- 上游的大模型座位/AI 语音/百度/火山 TTS 仍保留代码，但没配 key 时自动降级；
  平台不主动配置这些 key。
- 上游自带的 WakuDemo 账号体系在平台托管模式下**不使用**（登录入口已隐藏），
  但代码保留，方便单独部署上游时继续用。
- 页面里如果点了「单机对战」，对局仍在上游后端里跑（房间/规则都在 Python），
  只是不需要第二个真人。