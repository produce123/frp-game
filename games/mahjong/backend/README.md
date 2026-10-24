# 莲花广麻 · 联网后端

[![GitHub Stars](https://img.shields.io/github/stars/BestGuo2020/lianhua-mahjong-backend?style=flat&logo=github)](https://github.com/BestGuo2020/lianhua-mahjong-backend/stargazers)
[![License](https://img.shields.io/github/license/BestGuo2020/lianhua-mahjong-backend)](./LICENSE)
![Python](https://img.shields.io/badge/Python-%3E%3D3.11-3776ab?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115%2B-009688?logo=fastapi&logoColor=white)

「莲花广麻」的联网对战后端，为前端 Vue 工程（`../`）提供**房间管理、实时对局、战绩持久化与风控能力**。前端可独立运行单机模式；联机模式（创建/加入房间、与真实玩家同场）依赖本服务。

本仓库为**独立 git 仓库**（前端根仓 `.gitignore` 刻意忽略 `/backend/`，互不影响），玩法规则、牌面操作、AI 决策等核心逻辑从前端 `src/game/` 纯函数 1:1 翻译为 Python 复用，**不重写规则引擎**。

> 玩法按作者第一次接触的莲花广麻规则实现，部分计分细节可能与其他地区或牌馆的规则存在差异。实际行为以项目代码和游戏内“玩法”面板为准。

## 声明

本后端仅为「莲花广麻」提供纯娱乐棋牌对局技术服务。游戏内所有积分、道具仅为本游戏内部虚拟娱乐数值，不具备任何现金价值，不可兑换人民币、实物、有价资产，不支持任何形式回购、变现、折现、线下结算；游戏内**无赌资流通载体**（不充值、不提现、无筹码，分数仅对局计分），不做赌注显示或现金奖励排行榜。

平台严禁一切赌博及变相赌博行为，并内置了封禁、举报与合规留证能力（见「功能概览 · 风控」）。完整的用户声明与违规处置条款见前端仓库根目录 [README.md](https://github.com/BestGuo2020/lianhuaguangdongmahjong/blob/master/README.md)。

### 部署与运营免责声明

本项目为开源娱乐软件，作者仅提供源代码与必要的技术支持，不参与、不组织、不授权任何个人或机构的部署与运营行为。部署者（含服务器所有者、运维人员、房间运营者）使用本项目时，应自行确保：

1. 部署与运营行为符合部署所在地的法律法规，仅在合法合规的场景下运行本软件；
2. 不得利用本项目从事赌博、变相赌博或任何其它违法违规活动；
3. 若本软件被用于任何违法违规用途，由此产生的全部法律责任由实际部署者、运营者自行承担，与作者无关。

作者无法监控任何第三方部署实例的实际用途，亦不对任何未经作者控制的部署实例及其产生的行为负责。

## 技术栈

| 分类 | 技术 |
| --- | --- |
| 语言 | Python `>=3.11` |
| Web 框架 | FastAPI（`>=0.115`）、Uvicorn、WebSocket、Pydantic v2 |
| 并发模型 | `asyncio` 驱动，每房间一个 `GameManager` 状态机，房间内异步串行执行 |
| 数据存储 | 默认 SQLite（内置 `sqlite3`）；设 `PG_PASSWORD` 后自动切换 PostgreSQL（已适配 Supabase pooler） |
| 测试 | pytest + pytest-asyncio + httpx + websockets |
| 部署 | Docker / docker compose，GitHub Actions 自动构建镜像推送 GHCR |

## 功能概览

- **房间生命周期（REST）**：创建（6 位房间码，`capacity` 2/3/4）、加入、离开、准备、开局、房主解散、房间限时自动回收。
- **实时对局（WebSocket）**：`/ws/room/{room_id}` 凭重进码鉴权，服务端权威校验每步动作，**状态快照即唯一真源**（每份快照 per-seat 差异化，他人手牌隐藏）。
- **断线托管与重连**：断线后座位立即由 AIPlayer 接管、对局继续；玩家凭重进码可换浏览器/重开标签页恢复原座位与控制权，重连后下发全量快照。
- **轻量匿名身份**：`playerId`（guestId）为账号锚点，零注册；对局中刷新/关页可凭会话重进。
- **战绩持久化**：对局/每局结算/玩家统计落库，支持单场明细、房间历史、按玩家查统计。
- **风控（Phase 8 P1）**：封禁黑名单（player/room/device 三级）+ 玩家举报；join 与 WS 握手处即时查禁。首版无管理端鉴权（内部工具）。
- **免责声明同意记录**：按匿名身份跨设备记住「首次确认」，声明版本升级后需重新确认。
- **视觉节奏（pace）**：真人联机房间注入 AI 出牌/碰杠延迟（对齐前端 `PACE_MS`），避免 AI 瞬移；测试保持默认 0 加速。

### 当前实现的主要规则

- 只碰、杠，不吃牌。
- 仅支持自摸与抢杠胡，不支持普通弃牌点炮。
- 白板作为癞子，可替代对子、刻子或顺子所需的牌。
- 底分为 100；庄家 ×2，无白板胡牌 ×2，四张红中胡牌额外 ×4，杠上开花 ×2。
- 摸到红中会立即亮杠，并从牌墙尾部补摸；累计四张红中立即按自摸结算。
- 胡牌后从牌墙摸最多 8 张马牌；1、5、9 和红中为中马，每张增加一份底分。
- 暗杠由其余三家各支付 2 份底分；明杠由出牌者支付 1 份底分；补杠由其余三家各支付 1 份底分。
- 抢杠胡只由被抢杠者支付胡牌分数。

## 架构

```
客户端 (Vue 3, 保留 UI/3D/音效)         服务端 (FastAPI)
┌───────────────────────────┐        ┌──────────────────────────────────┐
│ 组件层 (App.vue, 3D 牌桌)  │        │  API 层                          │
│ 交互层 (手势/点击/倒计时)   │        │  ├─ POST /api/rooms              │ 创建/加入房间
│ 前端表现层 (音效/动画)      │        │  ├─ GET  /api/rooms/{id}          │ 房间信息
│                           │        │  └─ POST /api/rooms/{id}/ready     │ 准备/开局
│ ┌───────────────┐         │        │  WS 层                            │
│ │ useRemoteGame │         │  WS   │  ├─ /ws/room/{id}                  │ 实时游戏消息
│ │ - 状态快照     │◄────────►│  JSON │  └─ 出站队列 + 后台发送任务          │
│ │ - 动作发送     │         │        │                                     │
│ └───────────────┘         │        │  Game 层                          │
│  远程模式；本地单机走       │        │  ├─ GameManager (房间权威状态机)    │
│  useGame 不动             │        │  ├─ RemotePlayer (人类客户端)       │
│                           │        │  └─ AIPlayer (复用 core/ai.py)     │
│                           │        │                                     │
│                           │        │  Core 层 (★ 从 TS 翻译复用)         │
│                           │        │  ├─ core/tiles.py   (牌墙/洗牌)     │
│                           │        │  ├─ core/rules.py   (胡牌/算分) ★   │
│                           │        │  ├─ core/ai.py      (AI 决策)       │
│                           │        │  └─ core/actions.py (牌面操作)      │
│                           │        │                                     │
│                           │        │  Storage 层                         │
│                           │        │  └─ SQLite / PostgreSQL: 房间/战绩/封禁│
└───────────────────────────┘        └──────────────────────────────────┘
```

**消息协议核心思想**：服务端权威，客户端动作为「意图」，由服务端校验后执行。

- 服务端 → 客户端：**状态快照 + 定向请求**（`state_snapshot` / `turn_request` / `claim_request` / `rob_kong_request`）
- 客户端 → 服务端：**动作**（`discard` / `claim` / `gang` / `hu` / `pass` / `ping`）
- 服务端 → 全房间：**事件**（`table_action` / `score_flow` / `announcement` / `hand_result`）

协议草案详见 `docs/mahjong-backend-dev-plan.md` §4；前后端职责划分见 `docs/claude-handoff-phase7.md` §4。

## 目录结构

```text
backend/
├─ app/
│  ├─ main.py                 # FastAPI 装配：CORS、路由注册、启动建表、/api/health
│  ├─ api/                    # REST 层
│  │  ├─ rooms.py             # 房间生命周期（创建/join/leave/ready/start/关闭）
│  │  ├─ matches.py           # 战绩（单场/房间历史/玩家统计）
│  │  ├─ moderation.py        # 风控（封禁/解封/举报）
│  │  ├─ account.py           # 免责声明同意记录
│  │  └─ auth.py              # WakuDemo 登录入口/回调/服务端会话
│  ├─ auth/
│  │  └─ wakudemo.py          # OAuth 2.0 Authorization Code + PKCE
│  ├─ core/                   # ★ 从前端 src/game/ 翻译的纯逻辑
│  │  ├─ tiles.py             # 牌墙/洗牌/排序/中马
│  │  ├─ rules.py             # 胡牌判定/听牌/算分/买马/杠分（游戏心脏）
│  │  ├─ ai.py                # AI 决策
│  │  └─ actions.py           # 牌面操作
│  ├─ game/
│  │  ├─ manager.py           # GameManager 权威状态机（从 useGame.ts 翻译）
│  │  ├─ room.py              # RoomSession：座位/重进码/托管/落库 + room_registry
│  │  ├─ player.py            # PlayerController / AIPlayer
│  │  └─ remote_player.py     # RemotePlayer（挂起等待 WS 动作）
│  ├─ ws/
│  │  ├─ manager.py           # ConnectionManager（座位→出站队列/发送任务）
│  │  └─ game_ws.py           # /ws/room/{id} 端点
│  ├─ models/                 # Pydantic 模型（game / messages 协议）
│  └─ storage/
│     ├─ db.py                # SQLite/PostgreSQL 门面
│     └─ schema_sqlite.sql / schema_postgres.sql
├─ tests/                     # 160+ pytest 用例（对照前端 vitest 逐条移植）
├─ scripts/
│  ├─ smoke_4p.py             # 4 真人 WS 客户端完整东风场
│  ├─ smoke_e2e.py            # 生产构建前端 + 真实后端端到端冒烟
│  └─ benchmark_rooms.py      # 单 worker 并发房间压测基准
├─ docs/                      # 开发计划与各阶段交接文档（见「文档索引」）
├─ data/                      # SQLite 运行时数据（gitignored）
├─ DEPLOY.md                  # 部署指南
├─ Dockerfile                 # python:3.11-slim + 单 uvicorn worker
├─ docker-compose.yml         # 本地/服务器 Compose 配置
├─ LICENSE
└─ pyproject.toml
```

## 安装方式

### 前置条件

- Python `>=3.11`
- 推荐 venv；可选 Docker（本地 `docker compose` 一键启动）

### 本地启动

```powershell
cd backend

# 方式一：uvicorn（开发）
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"     # Windows
# .venv/bin/pip install -e ".[dev]"                 # Linux/macOS
$env:PYTHONIOENCODING='utf-8'                       # PowerShell
.venv/Scripts/python -m uvicorn app.main:app

# 方式二：Docker（本地构建，监听 8000）
docker compose up --build
```

启动后：

```text
REST + WebSocket → http://localhost:8000
健康检查          → GET http://localhost:8000/api/health
API 文档(可选)    → http://localhost:8000/docs   （设 DOCS_SHOW=True 开启）
```

前端默认请求同源 `/api`，开发服务器通过 Vite 代理到 `127.0.0.1:8000`；后端部署到其他地址时可设置 `VITE_API_BASE`。WakuDemo 登录的完整配置和联调步骤见 [docs/wakudemo-oauth.md](./docs/wakudemo-oauth.md)。

## 测试与冒烟

```powershell
cd backend
$env:PYTHONIOENCODING='utf-8'                                 # PowerShell
.venv/Scripts/python -m pytest -q                              # 160+ 用例
.venv/Scripts/python scripts/smoke_4p.py                      # 4 真人 WS 完整东风场
.venv/Scripts/python scripts/smoke_e2e.py                     # 前端产物 + 真实后端端到端
.venv/Scripts/python scripts/benchmark_rooms.py 8             # 并发房间压测（默认 8 房）
```

测试对照前端 vitest 逐条移植（`tests/test_rules.py` ↔ `src/game/rules.test.ts` 等），关键原则：每个 TS 用例至少一个等价 Python 用例；随机逻辑（洗牌、AI 弃牌）注入 `random` 保证确定性；用纯 AI 对局模拟跑通全流程。全部测试需在**非沙箱 shell** 下运行（沙箱会阻断 pytest-asyncio 的 worker 通信）。

## 环境变量

全部可选，由 `backend/.env`（gitignored）或环境变量提供，环境变量优先：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PG_PASSWORD` | 未设 | 设置后自动走 PostgreSQL；未设则回退 SQLite |
| `PG_HOST` / `PG_PORT` / `PG_USER` / `PG_DATABASE` | Supabase pooler 默认 | PostgreSQL 连接覆盖 |
| `ROOM_MAX` | `4` | 本服务器最多同时存在的房间数（大厅「剩余房间」用） |
| `ROOM_LIFETIME` | `3600` | 房间限时（秒）；非对局中超时自动解散，对局中等结束自动释放 |
| `ROOM_MATCH_MAX` | `5400` | 单场对局硬上限（秒）；超过即由看门狗判定卡死并强制收尾 |
| `ROOM_WATCHDOG_INTERVAL` | `30` | 僵尸/卡死房间的看门狗扫描间隔（秒）；`0` = 关闭（紧急开关） |
| `DOCS_SHOW` | `False` | 是否暴露 `/docs` 接口文档 |
| `LOG_LEVEL` | `INFO` | 日志级别（`DEBUG` 输出逐动作细节：出牌/碰/杠等） |
| `LOG_DIR` | `logs` | 日志目录（滚动文件，已 gitignore） |
| `LOG_ROTATION` | `10 MB` | 日志文件滚动大小 |
| `LOG_RETENTION` | `30 days` | 日志文件保留时长 |
| `LOG_TO_FILE` | `1` | 是否写滚动文件；`0` 仅控制台输出（测试/CI 用） |
| `WAKUDEMO_CLIENT_ID` / `WAKUDEMO_BASE_URL` | 未设 | WakuDemo 应用 Client ID 与平台根地址；启用登录时必填 |
| `WAKUDEMO_REDIRECT_URI` / `WAKUDEMO_FRONTEND_URL` | 未设 | 平台登记的精确回调地址与回调完成后的前端地址 |
| `WAKUDEMO_*` 其余项 | 见 `.env.example` | PKCE 事务、会话 TTL 与安全 Cookie；完整说明见 [WakuDemo 登录文档](./docs/wakudemo-oauth.md) |
| `LLM_ENABLED` | `false` | 启用服务端 LLM 空座补位（未启用时 LLM 开关一律不生效） |
| `LLM_API_BASE` | 空 | OpenAI 兼容 API 根地址（**单提供商兼容路径**，见下） |
| `LLM_API_KEY` | 空 | API 密钥（服务端持有，不下发） |
| `LLM_MODEL` | 空 | 模型名，如 `deepseek-chat` |
| `LLM_TIMEOUT_S` | `40` | 单次决策总预算（秒，含并发排队 + 一次语义重试） |
| `LLM_TIMEOUT_ENABLED` | `true` | 是否启用牌桌请求超时；`false` 表示不设置服务端截止时间 |
| `LLM_POOL_TIMEOUT_S` | `1` | 并发信号量排队等待（秒） |
| `LLM_STYLE` | `稳健` | 出牌风格：激进 / 稳健 / 话痨 / 高冷（单提供商路径） |
| `LLM_CONCURRENCY` | `4` | 决策请求并发上限 |
| `LLM_MAX_REQUESTS_PER_ROOM` | `0` | 每房间请求预算（0 = 不限；超出后该座位回退启发式） |

TTS 不再读取环境变量；provider、音色、缓存、超时和故障降级统一配置在
`config/tts.yml`，结构参考 `config/tts.example.yml`。

### LLM 大模型（可选，§9 设计文档）

服务端给「空座位 AI 补位」接大模型，支持**多提供商注册**（每座位可用不同
模型/风格，头像与昵称按供应商展示）：

**方式一：多提供商（推荐）**——`backend/.env` 注册若干提供商（Key 全在服务端）：

```bash
LLM_PROVIDER_DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
LLM_PROVIDER_DEEPSEEK_API_KEY=sk-xxx
LLM_PROVIDER_DEEPSEEK_MODEL=deepseek-chat
LLM_PROVIDER_DEEPSEEK_TYPE=deepseek
LLM_PROVIDER_DEEPSEEK_STYLE=稳健
LLM_PROVIDER_DEEPSEEK_NICKNAME=大肥鱼
LLM_PROVIDER_DEEPSEEK_AVATAR_FOLDER=deepseek
LLM_PROVIDER_KIMI_BASE_URL=https://api.moonshot.cn/v1
LLM_PROVIDER_KIMI_API_KEY=sk-yyy
LLM_PROVIDER_KIMI_MODEL=kimi-k2.6
LLM_PROVIDER_KIMI_TYPE=kimi

# GLM-5.3 Flash via OrcaRouter（实验性；实测行为与官方不一致）
LLM_PROVIDER_GLM_ORCA_BASE_URL=https://api.orcarouter.ai/v1
LLM_PROVIDER_GLM_ORCA_API_KEY=sk-zzz
LLM_PROVIDER_GLM_ORCA_MODEL=z-ai/glm-5.3-flash
LLM_PROVIDER_GLM_ORCA_TYPE=glm
```

- 提供商 id = 变量名中段（小写）：`deepseek`、`kimi`…；可加 `_STYLE`（四风格）、
  `_NICKNAME`（缺省按 base URL 推导：DeepSeek=大肥鱼等）、`_TIMEOUT_MS`（毫秒）、
  `_TIMEOUT_ENABLED`（默认 true；false 表示该提供商永不超时）、
  `_NAME`（展示名，缺省=id）、`_AVATAR_FOLDER`（头像素材文件夹）、`_TYPE`
  （`deepseek/qwen/kimi/doubao/minimax/openai/glm/claude/custom`）。使用自定义代理时建议设置
  `_TYPE`；未设置或设为 `custom` 时仍会按 Base URL/完整模型 ID 识别已知厂商参数。未知或推理专用模型不在请求前拦截，由上游返回真实错误。
- 客户端建房时在**房间面板为每个空位选择“提供商/模型 + 策略”**；每个已配置
  模型都会展开激进、稳健、话痨、高冷四种策略。`start` 请求只带
  `llmSeats: [{seat, providerId, style}]`，**key 不经过客户端**；未指定时使用
  服务端默认 provider 的默认策略。`GET /api/rooms/meta` 返回 `llmProviders`
  及其 `styles` 列表（不含 key）。
- 单机与联机配置完全独立：单机只读浏览器本地设置；联机建房必须单独勾选
  “空位使用服务器大模型”，只使用本节服务端注册表，绝不读取单机 Key/开关。
- 对局显示：`昵称（策略）` + `img/llm/<供应商英文名>/llm-avatar-<策略>.png`
  （供应商文件夹：deepseek/kimi/qwen/doubao/minimax/gpt/glm/claude，未知=custom）。
- **中转站 / 聚合 API 就是一个提供商**：`BASE_URL` 填中转站地址（如
  `https://xx.com/api/v1`）、`API_KEY` 填中转站的 key、`MODEL` 按**中转站文档**
  的模型名填。同中转站可注册多个 id（**同 key 不同 model/风格/昵称**），
  实现每座位不同模型；中转站域名不会触发 DeepSeek/Anthropic 官方特判，
  按普通 OpenAI 兼容处理；较慢的中转站可配 `_TIMEOUT_MS`（如 15000），
  按量计费建议同时设 `LLM_MAX_REQUESTS_PER_ROOM` 控费。

**方式二：单提供商（兼容）**——未注册 `LLM_PROVIDER_*` 时，旧全局配置
（`LLM_ENABLED=true` + `LLM_API_BASE/API_KEY/MODEL/STYLE`）作为 `id=default`
的提供商兜底注册。

说明：

- 任何 **OpenAI 兼容** API 均可（Kimi `/v1`、通义 `compatible-mode/v1`、豆包
  `/api/v3`、MiniMax `/v1`、OpenAI `/v1`、智谱 `/api/paas/v4` 等），只需换
  Base / Key / Model。
- 所有供应商的游戏决策默认最多等待 40 秒；可通过全局 `LLM_TIMEOUT_ENABLED=false` 或提供商 `_TIMEOUT_ENABLED=false` 关闭服务端截止时间。快速路径自动关闭思考，困难局面可条件开启（每个AI座位每小局 2 次，其中普通软触发最多 1 次；全桌整场 24 次）；庄家首打及 AI 前两巡不因候选接近或审计抽样升级，完全同质的并列候选直接走确定性引擎，多个不同听牌方案或破坏听牌风险仍可强触发；对手暗手与用户私有听牌提示不进入 LLM 快照，早巡公开威胁需达到 90；超时回退启发式；
- 每小局结束后，服务端直接从按性格与输赢类型划分的默认台词池取句，不额外请求大模型；再按“LLM AI 赢家优先、其余 LLM AI 顺时针；荒庄按座位顺序”串行广播感言和 TTS，同局同性格 AI 使用不同句，真人座位不发言；感言全部完成前不下发 settled 结算快照，两种规则玩法共用该联机屏障；
  官方 API、OrcaRouter 和未知自定义中转使用独立参数方言。Kimi K3 普通 `low/128`、疑难 `high/512`；GLM-5.3-Flash 始终思考，官方接口普通/疑难均使用其允许的 low（预算 128/1024），OrcaRouter 既有配置按 `low/512`、`medium/1024` 兼容但不再作为前端推荐预设；完整 GLM-5.3 官方疑难使用 high，OrcaRouter 使用 medium；
  自定义中转的 Kimi K2.5/K2.6 非思考保持 `disabled/64`，条件思考使用 `enabled/2048` 并请求 JSON Object；官方 Moonshot 维持官方参数与 512 思考上限；
  OrcaRouter 域名下的 DeepSeek、Qwen 与 Kimi 条件深思统一使用 `max_tokens=65536`；普通路径、官方 API、其他中转及其他供应商不受影响，服务端超时仍可能先结束请求；
  深思预算按端点、模型和档位记录最近 32 次 reasoning token，使用 P99+96 动态调整；截断后下一次至少翻倍，最大 65536。同一模型连续两次在满额时截断会暂停条件深思 30 分钟，不对当前局面即时重试；
  后端统一请求 `stream:true` 并解析 SSE。普通 always-on low 不先播“让我想想怎么打”等台词/TTS，但收到推理块后仍通过 `llm_status` 广播安全进度气泡；原始 `reasoning_content` 永不广播、记录或送入 TTS；
  百炼 `qwen3.5`～`qwen3.8` 自动设置 `enable_thinking=false` 并请求 JSON Object，
  未显式配置 `TIMEOUT_MS` 时使用统一 40 秒决策预算；
  Anthropic 自动追加浏览器访问头；`http://127.0.0.1:端口` 本地代理（如
  Ollama）允许使用，远端仅允许 https。
- 失败兜底：任何一次决策超时 / 网络 / 非法返回都会自动回退启发式 AI
  （每次决策在 `LLM_TIMEOUT_S` 内完成，不会卡住对局）。
- LLM 吐槽通过 WS `llm_message` 实时广播为牌桌座位气泡；整场结束后，日志按
  AI 座位写请求/成功/回退/吐槽/非法统计，并逐条记录本场所有 AI 吐槽文本。
- `话痨`性格每次摸牌后的出牌都发送一句台词，不参与普通全桌/座位冷却与抽稀，
  也不占用其他座位的普通发言冷却；吃、碰、杠等重要动作仍按原有优先级直通。
- LLM 失败转交引擎时按相同发言频率广播“？”气泡，但不创建 TTS 音频任务；
  单候选直接采用引擎参考不算失败。
- 大模型临时不可用时**静默降级**：房间自动回退纯 AI 补位，不阻塞对局。
- Key 只在服务端环境变量/`.env` 中，**不进日志与任何接口响应**；前端
  右下角「🤖 AI 设置」仅单机模式显示（联机由服务端提供商配置）。

`backend/.env` 不应提交仓库（已在 `.gitignore`）；这里仅存数据库和 LLM 等环境配置。
TTS 凭据放在 `config/secrets/`，由 `config/tts.yml` 引用，两者同样严禁提交。

### 火山引擎 TTS、百度故障降级与音频缓存

- LLM 文字吐槽先通过 `llm_message` 广播；TTS 在后台异步生成，完成后广播
  `llm_audio`，不会阻塞出牌。
- 主 provider 使用火山引擎豆包语音合成 V3 SSE（`seed-tts-2.0`，MP3/24 kHz）；
  火山超时、网络、鉴权、额度或业务失败时自动切换到百度。
- 百度只保留一个中性音色，所有 LLM provider 和策略故障降级时共用；不再维护
  provider 级百度音色环境变量。
- 每个 provider 有独立负缓存和全局冷却期。冷却期内直接走百度；冷却结束后重新
  尝试火山，不会被已经生成的百度缓存永久黏住。
- 缓存键包含 provider、接口版本、资源 ID、规范化文本、音色、策略、语速、音调、
  音量和格式；同一 key 的并发请求只调用上游一次。
- 音频存放在 `data/tts-cache/<hash前缀>/<hash>.mp3`，SQLite 记录命中次数和
  最近访问时间；每 6 小时按 TTL/LRU 清理。
- 配置步骤：复制 `config/tts.example.yml` 为 `config/tts.yml`，把火山和百度凭据
  文件放入 `config/secrets/`；真实配置和 secrets 已由 `.gitignore` 排除。
- 安全连通性检查：`python -m app.tts.check --voice-key deepseek --style 激进`。
  输出实际命中的 provider、音频字节数和缓存状态，不显示 Key/Secret/Token。
- 火山返回 `45000030 requested resource not granted` 表示 API Key 本身有效，但账号尚未
  获得 YAML 中 `resource_id` 对应的语音合成资源授权；须在火山语音控制台开通相应
  `seed-tts-2.0` 资源后再检查，期间服务会自动使用百度。
- 单机网关与联机房间链路独立：`POST /api/local-tts/synthesize` 只接受最多 30 字、
  四种合法策略和服务端白名单 `voiceKey`，返回不可变哈希音频 URL；不接受客户端
  直接指定上游参数。缓存位于 `data/local-tts-cache`，限流按来源 IP执行；浏览器和
  vibehub 只拿音频地址，所有上游凭据始终留在服务端。
- 网关连通性检查：`python -m app.local_tts.check --voice-key deepseek --style 高冷`。

### 日志说明

后端统一使用 loguru 输出（`app/logging_config.py` 配置，拦截标准库 logging）。每条日志带**时间戳、级别、调用位置**；HTTP 请求由中间件记录**状态码 / 耗时(ms) / 来源 IP / `request_id`**；房间级日志带 `room_id` / `seat` 上下文（对局日志的 `request_id` 为触发开局的请求）。WS 连接日志带连接时长。`rejoin_code` 属座位凭据，日志中会脱敏。

## REST API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/login/wakudemo` | 发起 WakuDemo Authorization Code + PKCE 授权 |
| `GET` | `/api/login/callback` | 严格校验 state、服务端换 token 并读取账户 |
| `GET` | `/api/login/session` | 返回最小账户摘要（永不返回 access token） |
| `POST` | `/api/login/logout` | 注销服务端会话（JSON 请求 + Origin/CSRF 校验） |
| `POST` | `/api/rooms` | 创建房间（mode/capacity），签发 6 位房间码 |
| `GET` | `/api/rooms/meta` | 服务器房间容量（active/max） |
| `GET` | `/api/rooms/{id}` | 房间详情 + 座位表 + 准备状态 |
| `POST` | `/api/rooms/{id}/join` | 加入（占座 + 签发 rejoinCode + 落库） |
| `POST` | `/api/rooms/{id}/leave` | 离开（带 rejoinCode 身份校验） |
| `POST` | `/api/rooms/{id}/ready` | 准备 / 取消准备 |
| `POST` | `/api/rooms/{id}/start` | 开局（所有已占真人座位 ready 后触发） |
| `DELETE` | `/api/rooms/{id}` | 关闭房间（仅创建者） |
| `GET` | `/api/matches/{id}` | 单场对局详情（含各局结算） |
| `GET` | `/api/rooms/{id}/matches` | 房间历史对局列表 |
| `GET` | `/api/players/{nickname}/stats` | 个人统计（旧版，按昵称） |
| `GET` | `/api/players/by-id/{player_id}/stats` | 个人统计（按匿名身份，改名不丢历史） |
| `GET` / `PUT` | `/api/players/by-id/{player_id}/disclaimer-agreement` | 免责声明同意查询 / 记录（幂等） |
| `POST` | `/api/admin/bans` | 封禁（player/room/device + 原因） |
| `DELETE` | `/api/admin/bans/{scope}/{target}` | 解封 |
| `POST` | `/api/reports` | 玩家举报 |

错误响应统一为 `HTTPException(detail={'code': ...})`，如 `ROOM_NOT_FOUND` / `ROOM_LIMIT_REACHED` / `ALREADY_IN_ROOM` / `INVALID_REJOIN_CODE`。

**WebSocket**：`/ws/room/{room_id}?rejoin_code=...` —— 握手鉴权（重进码限速 30s 内 5 次）→ `rejoin_ok` + 全量快照 → 客户端动作循环 → 断线标记 + AI 托管。开局由 REST `POST /start` 显式触发（先连 WS 再 start）。

## 部署

部署流程与一次性准备（GitHub Actions → GHCR → 服务器）见 **[DEPLOY.md](./DEPLOY.md)**。要点：

- 后端是独立仓库（`ghcr.io/bestguo2020/lianhua-mahjong-backend`），每个 `master` push 自动构建镜像 → 推 GHCR → scp `docker-compose.yml` → 服务器 `docker compose pull && up -d`。
- 实时对局强依赖长连接 WebSocket + 服务端内存态（`room_registry`），不适合边缘函数 / 无服务器运行时。
- 前端另行托管；如需要可前置 Nginx / EdgeOne 反代 `/api` 与 `/ws`（WebSocket 空闲超时上限 300s，客户端 20s 心跳维持）。
- 存储：默认 SQLite（`mahjong_data` 卷持久化 `/app/data`）；设 `PG_PASSWORD` 自动走 PostgreSQL。
- 镜像 `:latest` 随每次 push 覆盖；`sha-<commit>` tag 保留历史可回滚。

## 已知边界

- 单 worker 部署（Uvicorn 单进程）；SQLite 多 worker 需 WAL + 写锁（当前未启用）。
- WakuDemo 的 PKCE 事务、code 防重放和 access token 会话同样保存在单 worker 内存；进程重启后玩家需重新登录，多实例部署前必须换成 Redis 原子 TTL 存储。
- 当前 WakuDemo 身份用于大厅账号展示和昵称预填，尚未替代既有 `guestId/playerId`，也不改变房间与战绩接口的授权语义。
- `GET /api/players/{nickname}/stats` 用昵称做路径参数，含特殊字符需 URL 编码；长期建议换 `player_id`。
- 首版封禁/举报接口无管理端鉴权（内部工具），上真账号体系后再收紧。
- 房间内存态运行期保存在 `room_registry`，服务重启丢失进行中对局（无重启恢复）。

## 文档索引

`docs/` 记录了完整的设计过程，适合接手开发前阅读：

| 文档 | 内容 |
| --- | --- |
| [wakudemo-oauth.md](./docs/wakudemo-oauth.md) | WakuDemo OAuth + PKCE 架构、配置、启动、测试、安全边界 |
| [mahjong-backend-dev-plan.md](./docs/mahjong-backend-dev-plan.md) | 开发计划：现状盘点、目标架构、分阶段任务、WS 协议草案、表结构 DDL、测试策略、风控规划 |
| [claude-handoff-phase0-4.md](./docs/claude-handoff-phase0-4.md) | Phase 0–4：环境骨架、数据模型与牌系统、规则引擎、AI/动作、游戏状态机 |
| [claude-handoff-phase5.md](./docs/claude-handoff-phase5.md) | Phase 5：WebSocket 实时层与断线托管 |
| [claude-handoff-phase6.md](./docs/claude-handoff-phase6.md) | Phase 6：REST 房间生命周期与 SQLite 持久化 |
| [claude-handoff-phase7.md](./docs/claude-handoff-phase7.md) | Phase 7：前端对接 + 实测问题修复（快照真源 / pace / 公告去重 / 音效） |
| [design-dice-wall-laizi.md](./docs/design-dice-wall-laizi.md) | 骰子拆墙、牌墙布局与癞子设计 |

## 资源说明

项目代码许可见 [LICENSE](./LICENSE)。前端工程（Vue 3 + Three.js）及完整玩法说明见上级目录根 README。
