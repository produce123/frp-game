/**
 * 刀马 BladeSteed — 身份"瞬间可见"（用户第 5 条反馈 + docs/DECISIONS.md D13）
 *
 * 【为什么要单独一条】
 * 平台首页和游戏页是**两个网页**，点进游戏是一次整页跳转：公网那次 WebSocket 握手
 * 实测要 2~3 秒（docs/TUNNEL.md 那类链路结论）。这段窗口里原来只能显示"正在确认身份…"，
 * 而且此时点「开始对局」会被误判成"还没登录"、弹一句**假话**（用户实测撞到过）。
 * 修法是 `shared/net/net.js` 的 `rememberMe` / `cachedMe`（localStorage 的 `frp.me`）：
 * 游戏页一打开就先用缓存里的名字 / ID 把身份行画出来。
 *
 * 【这条比平台那条更严一档】
 * `tests/shared.browser.mjs` 只把 WebSocket 换成假货（`/api/me` 还是活的，
 * 身份有可能是它给的）。这里**两条路都掐死**：
 *   · WebSocket 换成永远不 open / 不报错的假货；
 *   · `fetch('/api/me')` 永远不 resolve（"我是谁"这个问题没人回答）。
 * 于是身份行上的名字**只可能**来自浏览器里存着的那一份缓存 —— 这就是"瞬间可见"。
 * 顺带钉住 D13 的红线：缓存**只用于显示**，不许拿它填 `GameNet.me`、
 * 也不许拿它判断登录态（所以这里断言 `GameNet.me` 必须还是 null）。
 *
 * 跑法：node games/blade-steed/tests/browser.identity.mjs
 *      （名字是 `browser*.mjs`，平台体检 `tools/check-game.mjs blade-steed --browser`
 *        会把本目录下的浏览器用例逐个跑完。）
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../../../server/server.mjs';
import { Page, findChrome } from '../../../tools/cdp.mjs';

/** 截图目录（和 browser.e2e.mjs 同一处；单独跑本文件时它可能还不存在） */
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 进游戏页**之前**注入的脚本（`Page.addScriptToEvaluateOnNewDocument`
 * 是在新文档创建时就跑，比页面自己的任何脚本都早）。
 */
const KILL_BOTH_PATHS = `
  (function () {
    // ① WebSocket 换成永远连不上的假货：不 open、不 close、不 error，send 吞掉。
    function FakeWS(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; }
    FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
    FakeWS.prototype.send = function () {};
    FakeWS.prototype.close = function () {};
    FakeWS.prototype.addEventListener = function () {};
    FakeWS.prototype.removeEventListener = function () {};
    window.WebSocket = FakeWS;

    // ② /api/me 永远不回话（别的接口照常，不能把整个页面搞瘫）。
    var realFetch = window.fetch;
    window.fetch = function (url) {
      if (String(url).indexOf('/api/me') >= 0) return new Promise(function () {});
      return realFetch.apply(this, arguments);
    };

    // ③ 从页面还没解析开始盯着身份行：**每一次写入**都记下来。
    //    只认"写入"（mutation），所以静态 HTML 里那句初始文案也算一条 ——
    //    而"脚本把名字写上去"必须是紧随其后的那一条。
    window.__meHistory = [];
    function record() {
      var el = document.getElementById('me-line');
      if (!el) return;
      var t = el.textContent;
      var h = window.__meHistory;
      if (h[h.length - 1] !== t) h.push(t);
    }
    new MutationObserver(record).observe(document, { childList: true, characterData: true, subtree: true });
  })();
`;

async function main() {
  if (!findChrome()) {
    console.log('⚠️ 本机没找到 Chrome / Edge，跳过身份"瞬间可见"实测');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'blade-steed-identity-'));
  const app = await startServer({ port: 0, dbPath: join(tmpDir, 'identity.db') });
  let page = null;
  mkdirSync(SHOTS, { recursive: true });

  try {
    const base = String(app.url).replace(/\/+$/, '');

    /* ---------- 1. 先在平台上注册（这一步是真的连上服务器，会顺手把身份记在浏览器里） ---------- */
    console.log('\n── 1. 平台注册（身份会被记进 localStorage 的 frp.me）');
    page = await Page.launch({ headless: true, width: 430, height: 932, mobile: true });
    await page.goto(app.url);
    await page.waitFor(`return document.getElementById('screen-auth').classList.contains('is-active')`, 15000, '平台登录页');
    await page.click('#tab-register');
    await page.setInput('#register-name', '瞬');
    await page.setInput('#register-password', 'identity-pass-1234');
    await page.setInput('#register-password2', 'identity-pass-1234');
    await page.click('#form-register .btn-primary');
    await page.waitFor(`return !document.getElementById('modal-id').hidden`, 15000, '注册成功弹出账号 ID');
    const myId = await page.eval(`return document.getElementById('new-id').textContent.trim()`);
    await page.click('#btn-id-done');
    await page.waitFor(`return document.getElementById('screen-app').classList.contains('is-active')`, 15000, '平台主界面');
    await page.waitFor(
      `return !!(window.GameNet && window.GameNet.connected && window.GameNet.cachedMe())`,
      15000,
      '注册之后身份被记下来（frp.me）'
    );
    const cached = await page.eval(`return window.GameNet.cachedMe()`);
    assert.ok(cached && cached.id === myId, `注册之后必须把身份记进浏览器（拿到 ${JSON.stringify(cached)}，期望 id=${myId}）`);
    console.log(`  注册成功：名字「瞬」 ID ${myId}，已记进浏览器（${JSON.stringify(cached)}）`);

    /* ---------- 2. 掐死两条路：WebSocket 假货 + /api/me 不回话 ---------- */
    console.log('\n── 2. 掐死两条"问服务器我是谁"的路');
    console.log('  · WebSocket → 永远连不上的假货');
    console.log('  · fetch("/api/me") → 永远不 resolve');
    await page.conn.send('Page.addScriptToEvaluateOnNewDocument', { source: KILL_BOTH_PATHS });

    /* ---------- 3. 进游戏页：身份行必须**在页面加载完成的那一刻**就写着名字/ID ---------- */
    console.log('\n── 3. 进游戏页（/games/blade-steed/）');
    await page.goto(`${base}/games/blade-steed/`);
    // ⚠️ 这里**不轮询、不等待**：goto 回来（readyState=complete）就立刻读。
    //    真等 2~3 秒才出现的话，这条断言读到的就是"正在确认身份…"。
    const now = await page.evalRaw(`(() => {
      const el = document.getElementById('me-line');
      const hint = document.getElementById('login-hint');
      return {
        text: el ? el.textContent : null,
        hintHidden: hint ? hint.hidden : null,
        history: (window.__meHistory || []).slice(),
        netMe: (window.GameNet && window.GameNet.me) || null,
        connected: !!(window.GameNet && window.GameNet.connected),
        cached: (window.GameNet && window.GameNet.cachedMe && window.GameNet.cachedMe()) || null,
      };
    })()`);
    assert.ok(now.text, '身份行不见了（#me-line）');
    assert.ok(
      now.text.includes(myId) && now.text.includes('瞬'),
      `页面加载完成的那一刻，身份行上就该有名字/ID，实际是「${now.text}」`
    );
    console.log(`  页面一加载完成，身份行就是：「${now.text}」`);

    // 历史里**一次都没写过**"正在确认身份…"（除了 HTML 里那句静态文案）
    assert.ok(now.history.length >= 2, `身份行在整页加载里只被记录到 ${now.history.length} 次写入：${JSON.stringify(now.history)}`);
    assert.ok(
      !now.history.slice(1).some((t) => String(t).includes('正在确认身份')),
      `脚本先写了"正在确认身份…"、后来才写名字（用户看到的就是这一闪）：${JSON.stringify(now.history)}`
    );
    assert.ok(
      /你：.+ID/.test(now.history[1] || ''),
      `静态文案之后第一次写入的应该是缓存的姓名/ID，实际是「${now.history[1]}」（全部：${JSON.stringify(now.history)}）`
    );
    console.log(`  身份行的写入历史：${JSON.stringify(now.history)}（只有"静态文案 → 名字/ID"两次）`);

    /* ---------- 4. D13 红线：缓存只用于显示 ---------- */
    assert.equal(now.connected, false, '这一步必须真的没连上服务器（不然"瞬间可见"就证明不了什么）');
    assert.equal(now.netMe, null, '缓存被拿去填 GameNet.me 了 —— 登录态只能由服务端说了算（D13）');
    assert.ok(now.cached && now.cached.id === myId, `缓存里应该是刚注册的身份，实际 ${JSON.stringify(now.cached)}`);
    assert.equal(now.hintHidden, true, '有缓存身份的时候不许闪出"还没登录"那句假话');
    console.log('  ✓ 服务器两条路都掐死了，但 GameNet.me 仍是 null（缓存只画界面，不当登录态）');

    /* ---------- 5. 那句假话迟迟不许出现（原来 2.5 秒后会闪出来） ---------- */
    await sleep(2900);
    const later = await page.evalRaw(`(() => {
      const hint = document.getElementById('login-hint');
      const el = document.getElementById('me-line');
      return { hintHidden: hint ? hint.hidden : null, text: el ? el.textContent : null };
    })()`);
    assert.equal(later.hintHidden, true, `等了 2.9 秒之后弹出了"还没登录"的提示条 —— 可这台机器上刚刚登录过`);
    assert.ok(later.text.includes(myId), `2.9 秒后身份行上的名字没了：「${later.text}」`);
    console.log('  ✓ 2.9 秒后：提示条仍然没出现、名字还在（服务器始终没回话）');

    await page.screenshot(join(SHOTS, '11-online-identity.png'));
    console.log('\n✓ 身份"瞬间可见"通过：两条路都断了，名字/ID 一打开就在，一句假话都没说');
  } finally {
    if (page) page.close();
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\n❌ 身份"瞬间可见"实测失败：');
  console.error((err && err.stack) || err);
  process.exitCode = 1;
});