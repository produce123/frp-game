# DEPLOY · 把 frp-game 部署到另一台电脑（给 AI 的操作手册）

> 这份文档写给**执行部署的 AI / 技术人员**。目标是：在一台干净的 Windows 电脑上，
> 用最少步骤把平台跑起来，并让外网的朋友通过隧道访问。
>
> 原则：**先只跑核心平台，再按需加可选组件**。每一步都有"怎么确认成功"；
> 不确定或需要用户提供密钥/域名时，**停下来问**，不要猜。
>
> 仓库地址：`https://github.com/produce123/frp-game`（示例，换成实际地址）

---

## 0. 先确认你需要什么

| 组件 | 必需？ | 用途 |
| --- | --- | --- |
| Node.js **≥ 24** | ✅ | 服务端（用了 `node:sqlite`，22 不够） |
| Windows 10/11 | ✅ | 项目脚本按 Windows 写；Linux 需自己改 `.cmd`/路径 |
| Chrome 或 Edge | 仅测试 | `npm run test:browser` 需要 |
| Python **3.11+** | 仅莲花广麻 | 上游 FastAPI 规则后端 |
| Git + pnpm | 仅无名杀 | `tools/noname-update.mjs` 拉取约 1.2GB 上游 |
| 一条 TCP 隧道 | 仅外网访问 | 推荐 SakuraFrp；局域网/NAT 内也可用其它方案 |

> 大富翁 / 狼人杀 / 斗地主 / 莲花广麻的**构建产物已提交在仓库里**，
> 不需要 `pnpm install` 或前端构建。只有你改了它们的源码才需要重新构建。

---

## 1. 安装 Node 24

1. 打开 <https://nodejs.org/> 下载 **LTS 或 Current ≥ 24** 的 Windows 安装包。
2. 安装时勾选「Add to PATH」。
3. 新开一个 PowerShell 验证：

```powershell
node -v          # 必须 v24.x 或更高
npm -v
```

❌ 如果 `node -v` 低于 24：不要继续，先升级。`node:sqlite` 是硬依赖。

---

## 2. 拿到代码

```powershell
cd E:\
git clone https://github.com/<你的账号>/frp-game.git
cd frp-game
```

没有 Git 就下载 ZIP 解压到 `E:\frp-game`（路径可以不同，下文统一写 `E:\frp-game`）。

**不要**把别人机器上的 `data/` 拷过来：里面是账号数据库、密码哈希、会话和日志。
新机器从空数据库开始，重新注册账号。

验证目录里有这些文件：

```powershell
Test-Path server\server.mjs       # True
Test-Path web\index.html          # True
Test-Path package.json            # True
```

---

## 3. 启动（核心平台）

```powershell
cd E:\frp-game
npm start
```

- **不需要 `npm install`**：本项目零第三方运行时依赖。
- 默认监听 `127.0.0.1:7891`。
- 前台窗口会持续输出日志；按 `Ctrl+C` 停止。

验证：

```powershell
# 另开一个 PowerShell
curl.exe -sS -o NUL -w "%{http_code}`n" http://127.0.0.1:7891/api/me
```

期望 **401**（未登录，说明服务活着；不是连接失败）。

浏览器打开 <http://127.0.0.1:7891/>，注册账号 → 首页看到游戏卡片 → 能进三个自建小游戏。

### 后台运行（推荐）

```powershell
cd E:\frp-game
node tools\service.mjs start     # 或双击 start.cmd
node tools\service.mjs status    # 看端口/进程/运行时间
node tools\service.mjs stop
node tools\service.mjs restart
```

开机自启（登录 Windows 时悄悄启动，**不需要管理员**）：

```powershell
.\install-autostart.cmd
# 卸载：.\uninstall-autostart.cmd
```

### 改端口 / 换数据库路径（可选）

```powershell
$env:PORT = '7892'
$env:HOST = '127.0.0.1'
npm start
```

⚠️ **改端口必须同时改隧道**（隧道本地地址要指向新端口），只改一边必坏。
默认 `data/frp-game.db`；不建议改。

---

## 4. 外网访问（隧道）

目标：把 `127.0.0.1:7891` 暴露成一个 HTTPS 地址给朋友。推荐 **SakuraFrp**：

1. 注册并登录 SakuraFrp 面板，下载/安装它的启动器（frpc）。
2. 新建隧道：
   - 类型：**TCP**
   - 本地地址：`127.0.0.1`（⛔ 不要填 `localhost`）
   - 本地端口：`7891`
   - 节点：任选一个可用的国内节点
3. 建好后编辑隧道 → 打开「**自动 HTTPS**」→ 保存 → **重启隧道**。
4. 面板会给你一个公网地址，形如 `https://<节点域名>:<远端端口>`。
5. 把该地址发给朋友；第一次打开浏览器会提示证书不受信任 → 「高级 → 继续前往」。

验证（必须看到**本机日志新增一条 `[来访]`**）：

```powershell
node tools\check-tunnel.mjs https://<公网地址> --ws 30
Get-Content data\server.log -Tail 5
```

期望 `data/server.log` 里出现：

```
[来访] GET / -> 200 host=<公网主机:端口>
```

没有 `[来访]` = 流量没到本机：先查隧道本地地址/端口，再查「自动 HTTPS」。
详细排障见 `docs/TUNNEL.md`。

### 关于「访问认证」

SakuraFrp 隧道如果开了「访问认证」，每台新设备第一次打开要先输访问密码。
两种处理：

- 把访问密码一起发给朋友（勾「记住我」），或
- 在面板里关掉访问认证（仅建议在熟人小圈子使用）。

### 不要做的事

- ⛔ 不要给 Node 服务本身加 HTTPS：TLS 应该由隧道终止，服务端只讲明文 HTTP。
- ⛔ 不要把公网地址、隧道 ID、访问密钥写进代码或提交到 Git。
- ⛔ 不要把 8123（麻将后端）/ 8082（无名杀中继）映射到公网，它们只该监听 127.0.0.1。

---

## 5. 可选：莲花广麻（Python 后端）

需要 **Python 3.11+**（本机验证过 3.14）。在仓库根目录执行：

```powershell
cd E:\frp-game\games\mahjong\backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install fastapi "uvicorn[standard]" pydantic websockets python-dotenv httpx PyYAML loguru
cd E:\frp-game
```

然后重启服务：

```powershell
node tools\service.mjs restart
```

验证：

```powershell
curl.exe -sS http://127.0.0.1:7891/mahjong/api/health
```

以及浏览器登录平台后打开 <http://127.0.0.1:7891/mahjong/>，大厅应显示「当前账号」。

说明：

- Node 会自动找到 `backend/.venv/Scripts/python.exe` 并拉起 Python 子进程；
- 后端只监听 `127.0.0.1:8123`，公网仍然只走 7891 的 `/mahjong/api` `/mahjong/ws` 反代；
- 起不来时麻将页 503，**其它游戏不受影响**；
- 日志：`data/mahjong-backend.log`；
- 想换解释器：设 `MAHJONG_PYTHON=<python.exe 绝对路径>`。

---

## 6. 可选：无名杀（三国杀）

仓库**不包含**上游 1.2GB 源码/依赖。需要时：

```powershell
cd E:\frp-game
node tools\noname-update.mjs          # 拉上游 main + pnpm install + pnpm build，约 10 分钟
node tools\check-noname.mjs           # 真 Chrome 体检
```

前置：**Git**、**pnpm**（`npm i -g pnpm`）、磁盘 ≥ 3GB。更新后重启服务：

```powershell
node tools\service.mjs restart
```

打开 <http://127.0.0.1:7891/noname/>：应直接是游戏大厅（没有上游登录页），
右下角有平台账号。手机入口 `/play/noname`。

> 上游源码在 `games/noname-web/`，已在 `.gitignore` 里，**不要提交**。
> 以后更新上游只需重新跑 `node tools/noname-update.mjs`。

---

## 7. 验证清单

按顺序跑，任何一步失败先修再继续：

```powershell
cd E:\frp-game

npm test                                   # 146 条集成测试，约 15 秒
npm run test:browser                       # 真 Chrome 端到端（需 Chrome/Edge）
node tools/check-noname.mjs                # 仅当拉取了无名杀
node tools/check-tunnel.mjs <公网地址> --ws 30
```

手工验收（浏览器）：

1. 注册 → 首页出现 8 张游戏卡片（无名杀未拉取时可能少一张/不可用）。
2. 搜索「麻将」、筛「3 人」、点字母表，列表正确过滤/跳转。
3. 点游戏卡片 → **新标签页**打开游戏，平台首页还在。
4. 手机（或 Chrome 设备模拟 375×812）：游戏页右下角有「⛶ 全屏」；
   点进全屏后**按钮消失**；手机返回键退出全屏；伪横屏游戏进全屏后是横屏。
5. 建一个房间，第二个浏览器/手机用房间号加入，开始一局。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动报 `EADDRINUSE` | 7891 被占用：`node tools/service.mjs status`，先 stop；或改 `PORT`（记得同步改隧道） |
| 本机 401 正常，公网 501 | 隧道没开「自动 HTTPS」，或访客用了 `http://`。开自动 HTTPS 并用 `https://` |
| 公网 503 | 隧道本地地址/端口错，或节点上还挂着同名旧隧道。检查本地 `127.0.0.1:7891`，换隧道名重建 |
| 公网面板显示在线，但本机日志零 `[来访]` | 流量没到本机：查隧道「连接映射目标」日志；见 `docs/TUNNEL.md` |
| 朋友被要求输访问密码 | 隧道开了「访问认证」：给密码或关掉 |
| 麻将页 503 | 没装 Python `.venv`，或 8123 被占。看 `data/mahjong-backend.log` |
| `/noname/` 404/503 | 没拉取无名杀：跑 `node tools/noname-update.mjs` |
| 页面还是旧样式 | 浏览器缓存；强刷 `Ctrl+F5`。构建产物最多缓存 10 分钟 |
| 手机上全屏按钮不见了 | 进全屏后按钮本来就会隐藏，按手机返回键退出 |
| IDM 弹窗/下载游戏音频 | 入口页需加载 `/shared/ui/no-idm.js`，服务器需支持无扩展名音频路径；本仓库已内置（见 `docs/ARCHITECTURE.md`） |

---

## 9. 备份、迁移与更新

- **备份**：停服务后整体复制 `data/`（至少 `frp-game.db`；WAL 文件一起复制）。
  ```powershell
  node tools\service.mjs stop
  Copy-Item E:\frp-game\data E:\backup\frp-game-data -Recurse
  node tools\service.mjs start
  ```
- **迁移到新电脑**：代码 + `data/` 一起拷；Python `.venv` 不要跨机器拷，重新建。
- **更新代码**：`git pull` → `node tools\service.mjs restart`。
  如果上游游戏有更新，按对应目录的 README 重新构建/覆盖产物。
- **绝对不要提交/上传** `data/`、`frpc/**/*.local.ini`、`.env`、证书、私钥。

---

## 10. 给执行部署的 AI 的纪律

1. **先读** `AGENTS.md` → `docs/NEXT.md`，再动手；不要通读所有 docs。
2. 不要改隧道配置、不要重启 SakuraFrp 服务 —— 那是用户手动管理的。
3. 不要引入第三方运行时依赖；需要时先问用户。
4. 不要为了让测试变绿而放宽断言；先报告失败现象和根因。
5. 涉及真实地址 / 密钥 / 域名时，**停下来问用户**；把它们留在本机，不要写进仓库。
6. 每完成一步，报告「用户能看到什么变化」和「下一步需要用户做什么」。
7. 用户不是程序员：用大白话解释，给推荐项和代价。
