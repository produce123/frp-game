# 大富翁 · 接手须知

先读 `README.md`（上游、构建、补丁、地图、服务端接线都在那里）。这里只列最容易踩的坑。

## 铁律

- **不要重写上游 UI/规则**。页面/玩法/3D 全是 `mine-monopoly` 的，用户明确要求"别自己做界面"。
- **不要跑上游 Express/MySQL/管理后台**。平台只做静态托管 + `/monopoly-server` 兼容接口 + WS 中转。
- **不要引入 coturn / 公共 TURN / 上游 PeerServer**。联机只走 7891 的 `/monopoly-relay`。
- **改补丁必须改 `upstream/apps/client/src/**`，再 `pnpm build:web` 覆盖 `web/`**；直接改 `web/` 会被下次构建冲掉。
- 账号必须是平台账号：`window.__FRP_ME__` → `localStorage.user`；页面里不许出现上游登录/起名框。

## 测试

```powershell
npm run test:monopoly
```

- Node 20 条：登录门、SPA 兜底、源码不泄漏、身份注入、5 张地图、room-router 生命周期/权限、
  relay 双向转发/resume/401、presence/邀请/回执、音频防抓取出口。
- 真 Chrome：登录门回跳、账号一致、好友「正在玩/进入」、游戏内邀请→平台卡→进房、
  两人选图/选角色/开始进 3D 棋盘、375px 伪横屏、桌面回真页面。
- 浏览器测试自己起随机端口/临时库，**不碰 7891**。

## 全屏

上游状态栏**自带**全屏按钮，桌面版不要再注入 `shared/ui/fullscreen.js`（会重复）。
手机 `/play/monopoly` 伪横屏外壳自己加载平台全屏按钮；iframe 内的上游按钮照旧可用。

## 最容易复发的坑

1. **客人页有两个 `.choose-role`**：房主那个是 `aria-disabled`；只能点 `.choose-role.my-button`。
2. **角色列表来自地图**：先选图，等 `.choose-role.my-button` 出现再点；空图弹窗是空的。
3. **改地图会清 `isReady`**：`canStart` 只认准备；测试要先选图、再让客人准备。
4. **`?join` 必须带过路由守卫**：`login → room-router` 要 `query: to.query`，否则邀请进不了房。
5. **开始按钮灰/亮不一致**：上游 `canStart` 曾把 `roleId` 当准备，已改成 `isReady`。
6. **音频 URL 不能带 `.mp3/.ogg`**：IDM 会把媒体请求抓进下载文件夹；走 `/monopoly-audio/...` + octet-stream。
7. **base path 必须是 `/games/monopoly/`**：上游默认 `/monopoly/` 会让资源全 404。
8. **音效 404 不是白屏**：上游缺 `success/info/notification/error`，已从配置移除；别再补回空路径。

## 交付前

- `npm test` 全绿；大富翁改动跑 `npm run test:monopoly`。
- 提醒用户：**强刷**（资源有缓存），源码/地图已在服务器目录，不需要改 SakuraFrp 面板。

