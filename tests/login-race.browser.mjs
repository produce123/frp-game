/*
 * 登录竞态的确定性用例（web/assets/js/app.js）。
 *
 *   node tests/login-race.browser.mjs      （真 Chrome + 真服务器，随机端口）
 *
 * 【被测的那个 bug】
 * boot() 一上来就探 GET /api/me（未登录时服务端回 401）。如果用户在页面刚打开的
 * 毫秒级内就提交了登录，登录成功返回之后的某一刻，那个**迟到的 401 回调**才跑起来，
 * 把界面翻回登录页 —— 症状是：界面停在登录页，但 GameNet.me 已经是本人了（实际已登录）。
 * 真人手速 / 密码管理器自动填充都可能撞到，但靠手速**永远复现不稳**。
 *
 * 【怎么让它确定性地复现】
 * 用 CDP 的 Page.addScriptToEvaluateOnNewDocument 在页面**加载之前**把 fetch 包一层：
 * 凡是 /api/me，先把响应扣在手里不交给 app.js；等我们确认"登录已经成功、界面已经在平台页"
 * 之后再放行。于是那个 401 **一定**落在登录成功之后 —— 竞态窗口被人为拉成 100% 命中。
 *
 * 断言：放行 401 之后，界面必须**仍然停在平台页**（老代码会翻回登录页），
 *       而且那个 401 确实到达过页面（不是我们测了个空）。
 *
 * 顺带钉住：延迟期间"正在连接服务器…"不会出现（那时还没开始连），以及控制台零报错。
 *
 * ⚠️ 服务器一律 listen(0) 随机端口，绝不碰 127.0.0.1:7891 上正在跑的服务。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/server.mjs';
import { Page, findChrome } from '../tools/cdp.mjs';

const SHOTS = new URL('./screenshots/', import.meta.url).pathname.replace(/^\//, '');

/** 在 Node 侧注册一个账号，返回 { me }。 */
async function registerViaApi(baseUrl, name, password) {
  const res = await fetch(new URL('/api/register', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });
  const data = await res.json();
  assert.equal(res.status, 200, `注册失败：${JSON.stringify(data)}`);
  return data.me;
}

/**
 * 页面加载前注入：把 /api/me 的响应扣在手里，直到 window.__frpReleaseMe() 被调用。
 * 记下它最终的 HTTP 状态码 —— 用来证明"那个迟到的 401 真的到过页面"。
 */
const HOLD_ME = `
(() => {
  const orig = window.fetch;
  window.__frpMeInFlight = false;
  window.__frpMeStatus = null;
  window.__frpReleaseMe = null;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = orig.apply(this, arguments);
    if (!/\\/api\\/me(\\?|$)/.test(url)) return p;
    window.__frpMeInFlight = true;
    return p.then((res) => new Promise((resolve) => {
      window.__frpReleaseMe = () => { window.__frpMeStatus = res.status; resolve(res); };
    }));
  };
})();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!findChrome()) {
    console.log('⏭  本机没有 Chrome/Edge，跳过这条测试');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'frp-login-race-'));
  const app = await startServer({
    port: 0,
    dbPath: join(tmpDir, 'race.db'),
    statePath: join(tmpDir, 'server.json'),
  });
  const base = String(app.url).replace(/\/+$/, '');
  const PASSWORD = 'secret123';

  let page = null;
  try {
    mkdirSync(SHOTS, { recursive: true });
    const me = await registerViaApi(base, '快', PASSWORD);
    console.log(`账号就绪：${me.name} / ${me.id}`);

    page = await Page.launch({ headless: true, width: 430, height: 932, mobile: true });

    // ⚠️ 必须在 goto 之前：让拦截脚本在页面脚本之前生效
    await page.conn.send('Page.addScriptToEvaluateOnNewDocument', { source: HOLD_ME });

    await page.goto(base);

    // 1) 停在登录页，而且那次 /api/me 探测确实被扣住了
    await page.waitFor(
      `return document.getElementById('screen-auth').classList.contains('is-active')`,
      15_000,
      '登录页出现'
    );
    await page.waitFor(`return window.__frpMeInFlight === true`, 10_000, 'boot() 的 /api/me 探测已发出');
    assert.equal(
      await page.eval(`return window.__frpMeStatus`),
      null,
      '这时候 401 还没放行 —— 竞态窗口正是这样被拉开的'
    );
    console.log('页面刚打开：/api/me 的响应被扣在手里（还没到 app.js）');

    // 2) 趁着 401 还没回来，立刻提交登录
    await page.setInput('#login-id', me.id);
    await page.setInput('#login-password', PASSWORD);
    await page.click('#form-login .btn-primary');

    await page.waitFor(
      `return document.getElementById('screen-app').classList.contains('is-active')`,
      15_000,
      '登录成功后进入平台页'
    );
    await page.waitFor(`return window.GameNet && window.GameNet.connected === true`, 15_000, 'WebSocket 连上');
    assert.equal(
      await page.eval(`return window.GameNet.me && window.GameNet.me.id`),
      me.id,
      'WebSocket 认出来的身份应该是刚登录的人'
    );
    const loginDoneAt = Date.now();
    console.log('登录已经成功、界面已经在平台页（真实状态 = 已登录）');

    // 3) 现在放行那个迟到的 401 —— 这就是线上撞到的那一秒
    await sleep(300);
    await page.eval(`return (window.__frpReleaseMe(), true)`);
    await page.waitFor(`return window.__frpMeStatus !== null`, 5_000, '401 已经交给 app.js');
    assert.equal(await page.eval(`return window.__frpMeStatus`), 401, '这次探测确实是个 401（未登录）');
    console.log(`迟到的 401 已放行（比登录成功晚 ${Date.now() - loginDoneAt}ms）`);

    // 4) 关键断言：界面不许被那个旧结果翻回去
    await sleep(1200);
    const after = await page.eval(`
      return {
        app: document.getElementById('screen-app').classList.contains('is-active'),
        auth: document.getElementById('screen-auth').classList.contains('is-active'),
        meId: window.GameNet.me && window.GameNet.me.id,
        connected: window.GameNet.connected,
      }
    `);
    assert.equal(after.auth, false, '迟到的 401 把界面翻回登录页了 —— 竞态没修好');
    assert.equal(after.app, true, '界面应该仍然停在平台页');
    assert.equal(after.meId, me.id, '身份还是刚登录的本人');
    assert.equal(after.connected, true, 'WebSocket 不该受影响');

    // 5) 顺带：登录页那会儿不该已经显示「正在连接服务器…」（那时还没开始连）
    assert.equal(
      await page.eval(`
        var el = document.getElementById('conn-status');
        return el ? getComputedStyle(el).display : 'MISSING'
      `),
      'none',
      '连上了却还显示「正在连接服务器…」'
    );

    await page.screenshot(join(SHOTS, 'login-race-after-401.png'));

    if (page.errors.length) {
      throw new Error('浏览器控制台有报错：\n' + page.errors.join('\n'));
    }

    console.log('\n✅ 迟到的 401 没有翻转界面：竞态用例通过');
  } finally {
    if (page) page.close();
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\n❌ 登录竞态用例失败：');
  console.error((err && err.stack) || err);
  process.exitCode = 1;
});