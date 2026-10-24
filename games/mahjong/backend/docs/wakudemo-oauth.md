# WakuDemo OAuth 2.0 + PKCE 接入

本项目使用服务端 BFF 方式完成 OAuth 2.0 Authorization Code + PKCE。浏览器只持有随机、`HttpOnly` 的本游戏会话 ID；`code_verifier`、授权码交换和 `access_token` 始终留在后端。项目不会收集、传输或保存 WakuDemo 密码，也不使用 password grant。

实现遵循 [RFC 7636（PKCE）](https://www.rfc-editor.org/rfc/rfc7636.html)、[RFC 6749（OAuth 2.0）](https://www.rfc-editor.org/rfc/rfc6749.html) 和 [RFC 9700（OAuth 2.0 Security BCP）](https://www.rfc-editor.org/rfc/rfc9700.html)。

## 目录结构

```text
backend/
├─ app/
│  ├─ auth/
│  │  └─ wakudemo.py          # 配置校验、PKCE、一次性事务、Token/Account 客户端、会话仓库
│  ├─ api/
│  │  └─ auth.py              # 发起授权、callback、session、logout 路由与 Cookie
│  ├─ logging_config.py        # code/state/verifier/token/Bearer 日志脱敏
│  └─ main.py                  # 注册 auth_router 与 credentialed CORS
├─ tests/
│  ├─ test_wakudemo_auth.py    # 外部 WakuDemo 接口全 Mock 的流程/失败/安全测试
│  └─ test_logging.py          # OAuth 凭据不落日志回归测试
├─ docs/wakudemo-oauth.md      # 本文
└─ .env.example                # 无秘密的配置模板

前端仓库（上级目录）
└─ src/game/online/
   ├─ api/authApi.ts           # 跳转登录、查询 session、logout
   └─ session/useWakuDemoAuth.ts
```

## 完整流程

1. 浏览器访问 `GET /api/login/wakudemo`。
2. 后端分别生成高熵 `state` 与 RFC 7636 `code_verifier`，计算 `BASE64URL(SHA256(code_verifier))`；只把随机 OAuth transaction ID 放进 `HttpOnly; SameSite=Lax` Cookie。
3. 后端 302 到 `https://wakudemo.cn/oauth/authorize`，参数完整包含：
   `client_id`、`redirect_uri`、`response_type=code`、`scope=account.read`、`state`、`code_challenge`、`code_challenge_method=S256`。
4. WakuDemo 回调 `GET /api/login/callback?code=...&state=...`。成功和错误回调都严格、常量时间校验 `state`；事务只允许消费一次。
5. 后端以 `application/x-www-form-urlencoded` POST Token 接口，字段为 `grant_type=authorization_code`、`code`、`client_id`、`redirect_uri`、`code_verifier`。超时或失败后不会重试同一个 code，用户应重新发起授权。
6. 后端以 `Authorization: Bearer <access_token>` GET Account 接口。账户必须含稳定的 `uid`（兼容 `id/account_id/user_id`）；只保留 `id/displayName/avatarUrl` 摘要。
7. 后端保存 token、最小账户摘要和过期时间，给浏览器签发新的随机登录 session Cookie，并删除 OAuth transaction Cookie。浏览器通过 `GET /api/login/session` 读取摘要，响应中永不包含 token。

OAuth 事务 Cookie 和登录 Cookie 是两个独立值。取消重登、错误 state、旧标签页回调和 callback 重放都不会删除已有的有效登录会话。

## 路由

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/login/wakudemo` | 创建一次性 PKCE 事务并 302 到授权页 |
| `GET` | `/api/login/callback` | 校验回调、服务端换 token、拉取账户、建立会话 |
| `GET` | `/api/login/session` | 返回 `{authenticated, account?}`；过期时返回 false 并清 Cookie |
| `POST` | `/api/login/logout` | 删除服务端 token 会话；要求 JSON Content-Type，浏览器 Origin 必须在配置白名单 |

认证相关响应都带 `Cache-Control: no-store`、`Pragma: no-cache` 和 `Referrer-Policy: no-referrer`。

## 配置

复制 `.env.example` 的相关项到服务器 `backend/.env`。真实值不要提交 Git；Client ID 不是密码，但仍建议通过部署环境管理。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WAKUDEMO_CLIENT_ID` | 空 | 平台审核后发放，必填 |
| `WAKUDEMO_BASE_URL` | 空（模板为 `https://wakudemo.cn`） | 平台根地址；生产强制 HTTPS，不能带 path/query/fragment/userinfo |
| `WAKUDEMO_REDIRECT_URI` | 空 | 平台登记的回调完整地址，必须精确一致；不能带 fragment |
| `WAKUDEMO_FRONTEND_URL` | 空 | 成功/失败后返回的游戏页面，只允许 HTTPS 或 loopback HTTP |
| `WAKUDEMO_SCOPE` | `account.read` | 固定最小权限；其他值会使 OAuth 配置失效 |
| `WAKUDEMO_TIMEOUT_SECONDS` | `10` | Token/Account 单次网络超时 |
| `WAKUDEMO_PENDING_TTL_SECONDS` | `600` | state + verifier 临时事务有效期 |
| `WAKUDEMO_TOKEN_TTL_SECONDS` | `3600` | 平台未返回 `expires_in` 时的保守有效期 |
| `WAKUDEMO_MAX_SESSION_TTL_SECONDS` | `86400` | 本游戏最多保存 token 的时长；平台更长时会截断 |
| `WAKUDEMO_MAX_PENDING` | `1024` | 单进程最多同时存在的 OAuth 事务，防止无界占用内存 |
| `WAKUDEMO_LOGIN_RATE_LIMIT_PER_MINUTE` | `30` | 每客户端 IP 每分钟最多发起的授权次数；仅当网关已限流时可设 `0` 关闭 |
| `WAKUDEMO_COOKIE_NAME` | `lgm_wakudemo_session` | 登录会话 Cookie 名 |
| `WAKUDEMO_TRANSACTION_COOKIE_NAME` | `lgm_wakudemo_oauth_tx` | OAuth 临时事务 Cookie 名，必须与会话名不同 |
| `WAKUDEMO_COOKIE_SAMESITE` | `none` | 登录会话 Cookie 的 SameSite；本地同站联调用 `lax` |
| `WAKUDEMO_COOKIE_SECURE` | `true` | 生产必须为 true；`SameSite=None` 时强制为 true |

生产示例（替换尖括号，不要添加密码或 Client Secret）：

```dotenv
WAKUDEMO_CLIENT_ID=<平台发放的 Client ID>
WAKUDEMO_BASE_URL=https://wakudemo.cn
WAKUDEMO_REDIRECT_URI=https://api.example.com/api/login/callback
WAKUDEMO_FRONTEND_URL=https://game.example.com/
WAKUDEMO_SCOPE=account.read
WAKUDEMO_COOKIE_SAMESITE=none
WAKUDEMO_COOKIE_SECURE=true
```

跨站 `SameSite=None` Cookie 仍可能被 Safari、隐私模式或 WebView 的第三方 Cookie 策略拦截。生产优先在游戏同站网关反代 `/api/login`，并把前端/API 放在同一站点边界；否则必须在目标浏览器实测。

## 启动与本地联调

先在 WakuDemo 创作者后台登记**完全一致**的本地回调（平台若不接受 HTTP localhost，改用已登记的 HTTPS 开发域名或隧道）：

```dotenv
WAKUDEMO_CLIENT_ID=<开发应用 Client ID>
WAKUDEMO_BASE_URL=https://wakudemo.cn
WAKUDEMO_REDIRECT_URI=http://localhost:8000/api/login/callback
WAKUDEMO_FRONTEND_URL=http://localhost:5173/
WAKUDEMO_SCOPE=account.read
WAKUDEMO_COOKIE_SAMESITE=lax
WAKUDEMO_COOKIE_SECURE=false
```

整个浏览器流程必须统一使用 `localhost`，不要把 `localhost` 与 `127.0.0.1` 混用；Cookie 不区分端口，但区分 hostname。

PowerShell 启动后端：

```powershell
cd D:\vueprojects\lianhua_guangma\backend
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[dev]"
$env:PYTHONIOENCODING='utf-8'
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

另开终端启动前端（`pnpm dev` 使用 5173，并把同源 `/api` 代理到后端）：

```powershell
cd D:\vueprojects\lianhua_guangma
pnpm install
pnpm dev
```

打开 `http://localhost:5173/`，点击大厅中的 WakuDemo 登录。不要直接用 `127.0.0.1:5173`。

## 测试

无需真实 Client ID、账户或外网即可运行自动测试；WakuDemo Token/Account 均由 HTTPX MockTransport 模拟：

```powershell
cd D:\vueprojects\lianhua_guangma\backend
.venv\Scripts\python.exe -m pytest tests\test_wakudemo_auth.py tests\test_logging.py -q -p no:cacheprovider
.venv\Scripts\python.exe -m pytest tests -q -p no:cacheprovider
```

自动测试覆盖 S256 参数、随机 state、form Token 请求、Bearer Account 请求、取消授权、缺失/错误 state、PKCE/invalid_grant、code 重放、旧标签页、网络超时、3xx/429/5xx、令牌过期/TTL 上限、登录限流、无效账户、Cookie 隔离、CSRF、缓存头和日志脱敏。

真实平台冒烟时检查：

1. 授权 URL 有全部八个参数，`code_challenge_method` 为 `S256`；URL 中绝不能出现 `code_verifier`。
2. callback 后地址栏只留下游戏页的 `wakudemo_login` 结果，前端随后会清掉它。
3. DevTools 的 Cookie 中只有随机 ID；Local Storage、响应 JSON、URL 和服务日志中都没有 access token。
4. 刷新后 `GET /api/login/session` 仍返回最小账户摘要；到期后返回 `authenticated:false` 并删除 Cookie。
5. 取消授权、篡改 state、回放 callback、禁用第三方 Cookie、模拟慢网分别得到可恢复的失败结果，不会破坏已有登录。

## 部署边界

当前整个游戏后端按 Dockerfile 使用单个 Uvicorn worker；OAuth 的 pending、已用 code 哈希和 access token 会话也保存在该进程内存中。优点是 token 不落磁盘，缺点是进程重启后需重新登录。

不要直接增加 worker 或水平扩容。多进程/多实例前应把三类状态迁到 Redis：pending 使用带 TTL 的原子 compare-and-delete，code 哈希使用 `SET NX EX`，session 使用带 TTL 的服务端记录，并对 token 做静态加密；负载均衡各实例共享该存储。登录起点还应在反向代理按 IP/设备限速。

应用层登录限流使用 Uvicorn 的 `request.client.host`。反向代理必须删除客户端自带的转发头，再写入真实地址，并把**代理自身的精确 IP/CIDR** 配进 Uvicorn `FORWARDED_ALLOW_IPS`；不要在后端可被公网直连时设为 `*`。如果 EdgeOne/CDN 无法稳定传递受信客户端 IP，请在网关完成 `/api/login/wakudemo` 限流，并将 `WAKUDEMO_LOGIN_RATE_LIMIT_PER_MINUTE=0`，避免所有玩家共享代理 IP 配额。

联机对战已接入 WakuDemo 登录身份：`POST /api/rooms`、`POST /api/rooms/{id}/join`、`GET /api/rooms/meta`、`GET /api/rooms/{id}` 与 `POST /api/reports` 要求登录（未登录 → `401 AUTH_REQUIRED`）；登录身份由会话 `uid` 推导为 `wakudemo-<uid>`，客户端提交的 `playerId` 被忽略，防占房、封禁、战绩与免责声明均绑定该键。座位操作（ready/start/leave/换角色/关房）保持 rejoinCode 校验，断线重连不依赖登录态。单机模式仍使用匿名 guestId。

本地开发联调可设置 `WAKUDEMO_LOGIN_BYPASS=true` 绕过真实登录：无会话时联机接口按客户端 `playerId` 推导测试身份（缺失时用 `dev-bypass`），`GET /api/login/session` 返回假登录态。生产环境严禁开启。
