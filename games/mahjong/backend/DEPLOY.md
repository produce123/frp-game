# 部署指南 · GitHub Actions → GHCR → 服务器（仅后端）

> 本仓库（后端）的每个 `master` push 会由 GitHub Actions 自动：
> 构建后端镜像 → 推 GHCR → scp `docker-compose.yml` 到服务器 → `docker compose pull && up -d`。
>
> 前端不在此流水线内（另行托管/部署）。

```
后端仓库 push ──► Actions ──► build 镜像 ──► push ghcr.io ──► 服务器 docker compose pull && up -d
                  └── scp docker-compose.yml ──► 服务器
```

---

## 1. 一次性准备

### 1.1 推送本仓库到 GitHub

```bash
git remote add origin https://github.com/BestGuo2020/lianhua-mahjong-backend.git
git push -u origin master
```

> 后端是独立仓库（根仓库 `.gitignore` 忽略 `/backend/`，前端仓不含后端代码，互不影响）。

### 1.2 服务器准备

```bash
# Docker 安装（Debian/Ubuntu 示例，或按你的发行版）
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
docker compose version        # 需要 docker compose v2 插件

# 部署目录（workflow 会在此目录放 compose 文件）
sudo mkdir -p /opt/python-project/lianhua-mahjong-backend
cd /opt/python-project/lianhua-mahjong-backend
# 运行时配置：docker-compose.yml 会从同目录的 .env 加载数据库/LLM 等变量。
# 按需填写完整配置；例如走 PostgreSQL 时至少设置：
echo 'PG_PASSWORD=你的密码' > .env
# 启用 WakuDemo 登录时，再按 docs/wakudemo-oauth.md 填写全部 WAKUDEMO_* 配置；
# Client ID、回调地址必须使用平台审核通过的精确值，绝不配置密码。
# TTS 使用 config/tts.yml，并通过其中的 credential_file 引用 config/secrets/。
mkdir -p config/secrets
cp config/tts.example.yml config/tts.yml
# 填入 config/secrets/火山apikey.txt 和 百度api-key.txt；这些文件都不要提交到 Git。
```

### 1.3 GHCR 包可见性

镜像默认 **private**，服务器拉取需登录。二选一：

- **简单（推荐）**：GitHub 网页 → 包 `lianhua-mahjong-backend` 的
  Settings → `Change visibility` → 设为 **Public**（服务器免登录 pull）。
- 或保持 private：服务器上 `docker login ghcr.io -u BestGuo2020 -p <PAT>`（PAT 需 `read:packages`）。

> 包只有在镜像首次推送后才会出现，所以先推一次再改可见性。

### 1.4 配置 Secrets

GitHub → 本仓库 → Settings → Secrets and variables → Actions → New repository secret：

| Secret | 值 |
|---|---|
| `SSH_HOST` | 服务器 IP 或域名 |
| `SSH_USER` | SSH 用户名（如 `ubuntu` / `root`） |
| `SSH_KEY` | 服务器的 SSH **私钥**（`cat ~/.ssh/id_ed25519` 内容） |
| （可选）`SSH_PORT` | 非 22 端口时填写（workflow 默认 22） |

> GHCR 推送不需要额外 secret，workflow 用内置 `GITHUB_TOKEN`。

### 1.5 首次部署

```bash
git add -A && git commit -m "ci: deploy backend" && git push
```

去 GitHub → Actions 页看构建是否全绿；绿了即部署完成。

## 2. 日常更新

改完代码后照常 `git add -A && git commit -m "..." && git push`，镜像自动重建并滚动部署。

## 3. 查看 / 回滚

```bash
ssh 服务器
cd /opt/python-project/lianhua-mahjong-backend
docker compose -f docker-compose.yml ps                       # 运行状态
docker compose -f docker-compose.yml logs -f --tail=100       # 日志
# 回滚：把 compose 里 image 的 tag 从 latest 改回 sha-<commit>，再 pull && up
```

## 4. 前端如何连后端

后端监听 `0.0.0.0:8000`（REST + WebSocket）。前端构建时设 `VITE_API_BASE` 指向本服务器，
例如 `VITE_API_BASE=https://你的域名`。后端 credentialed CORS 只允许 `app/main.py`
列出的来源和 `WAKUDEMO_FRONTEND_URL` 的精确 origin；其他生产域名必须显式加入
白名单，不能使用 `*`。
若服务器 8000 端口不直接对公网开放，可前置 Nginx / EdgeOne 反代 `/api` 与 `/ws`。
WakuDemo 跨站 Cookie 在部分浏览器会受第三方 Cookie 策略影响，生产优先让前端通过同站
网关反代 `/api/login`；完整说明见 `docs/wakudemo-oauth.md`。
登录限流依赖真实客户端 IP：反代应覆盖（而非追加）转发头，并把代理的精确 IP/CIDR
配置到 Uvicorn `FORWARDED_ALLOW_IPS`。无法可靠恢复客户端 IP 时，应在网关限流并设置
`WAKUDEMO_LOGIN_RATE_LIMIT_PER_MINUTE=0`，不要盲目信任 `*`。

### 单机 LLM 透传通道（无 CORS 的供应商）

单机的大模型是**浏览器直连供应商**，而千问 Token Plan / Coding Plan 端点对预检
（OPTIONS + Origin）直接 401、不带任何 `Access-Control-*` 头（2026-09-18 实测），
网页无法直连，因此后端提供白名单透传：
`POST /api/llm/relay/<upstream>/chat/completions`（实现见 `app/api/llm_relay.py`）。

- 上游白名单在服务端：`LLM_RELAY_UPSTREAMS`（缺省含 `token-plan`）。客户端只能传 id，
  **不能传 URL**，避免本端点变成 SSRF 跳板。
- Key 由浏览器自带并原样透传给上游：服务端不保存、不写日志、不回显。
- 前端 AI 设置里的「千问 Token Plan（经网关）」预置已指向该通道；玩家需要自己填
  `sk-sp-` 开头的 Token Plan Key（套餐凭证与按量付费 `sk-` Key 不可混用）。
- **反代这条路由必须关闭响应缓冲**（Nginx/OpenResty 加 `proxy_buffering off;`，
  实现已回 `X-Accel-Buffering: no`）：否则 SSE 会被攒到结束才吐，前端 40s 决策预算
  全被代理吃掉，表现为「决策超时」。
- 单 IP 每分钟上限由 `LLM_RELAY_RATE_LIMIT_PER_MINUTE` 控制（缺省 600）。

## 5. 已知边界

- 服务器必须能访问 `ghcr.io`（国内服务器可考虑给 `ghcr.io` 配加速，或改推腾讯云 TCR）。
- 镜像 `:latest` 随每次 push 被覆盖；`sha-<commit>` tag 保留历史，可据此回滚。
- 若用 PostgreSQL：`PG_HOST/PG_PORT/PG_USER/PG_DATABASE` 可在服务器 `.env` 里覆盖（默认指向 Supabase pooler）。
