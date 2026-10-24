/**
 * Shell Gambit — 入口
 *
 * 原项目这里是"纯静态、无服务器"的入口（js/main.js）。搬进平台之后它只剩两件事：
 * 把界面主控跑起来，以及**启动失败时给一句人看得懂的话**
 * （否则页面上只有一片黑，玩家和下一个接续的 AI 都无从下手）。
 */

import { init } from './ui/app.js';

try {
  await init();
} catch (err) {
  console.error('Shell Gambit 启动失败', err);
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div style="position:fixed;inset:0;display:grid;place-items:center;padding:24px;
      background:#0a0c0f;color:#e9eef4;font-family:system-ui;text-align:center;z-index:999">
      <div>
        <h2 style="margin:0 0 8px">游戏启动失败</h2>
        <p style="color:#9aa7b5;font-size:13px">${String(err && err.message ? err.message : err)}</p>
        <p style="color:#6b7683;font-size:12px">请使用较新的 Chrome / Edge / Safari / Firefox 打开本页。</p>
      </div>
    </div>`
  );
}