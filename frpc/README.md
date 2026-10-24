# frpc 配置档案

⚠️ **这个文件夹里的东西都不是"真正在跑的配置"。**

真正在跑的隧道配置由 **SakuraFrp 启动器**（`C:\Program Files\SakuraFrpLauncher\SakuraLauncher.exe`）
在启动时自己生成、直接喂给 `frpc.exe`，不落在仓库里。
所以**在这里改 ini 不会改变隧道行为** —— 改隧道请去启动器界面（隧道 → 编辑）。

这里放的是**脱敏档案 + 手动模式模板**，两条通道各自一个文件夹：

| 文件夹 | 通道 | 状态 |
| --- | --- | --- |
| `tcp/` | 国内 TCP 隧道 + frpc **自动 HTTPS**：访客按 **https://<你的公网地址>** 访问（证书自签） | **当前在用（2026-10-21 起）** |
| `http/` | SakuraFrp HTTP 隧道 + Cloudflare：`https://<你的域名>/` | **已停用（保留）**，等以后有公网 IP / 想要有效证书再开 |

⚠️ **国内节点会拦截明文 HTTP**（回它自己的 501 合规页），所以 `tcp/` 那条**必须**在面板里
开「自动 HTTPS」—— 开了之后 TLS 在 frpc 里终止、脱壳成明文 HTTP 再发给 7891。
踩坑全过程见 `../docs/TUNNEL.md` 坑五，取舍见 `../docs/DECISIONS.md` D15。

两条通道共同的硬约束：**本机服务端永远只监听 `127.0.0.1:7891` 的明文 HTTP**
（`tools/service.mjs` 的 `PORT`、`server/server.mjs` 的 `DEFAULT_PORT`），
所以**隧道的"本地端口"必须填 7891**；改任何一边都必须同时改另一边。

## 出问题先看哪儿

- **排障三步法、踩过的坑** → `../docs/TUNNEL.md`
- **启动器的真实日志**（只读，很有用）→
  `C:\ProgramData\SakuraFrpService\Logs\SakuraFrpService.<日期>.log`
  （里面有 `连接映射目标 [tcp://127.0.0.1:<端口>] 失败` 这类原文，能直接指出本地端口/本地服务的问题）

## 密钥

各文件夹里的 `frpc.local.ini` 是**带真实密钥**的手动模式配置，已在 `.gitignore` 里
（`frpc/**/*.local.ini`）：**不要提交、不要外发**。