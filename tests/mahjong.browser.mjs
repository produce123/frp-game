/*
 * 莲花广麻 · 平台级真浏览器验证（整份上游前端 + 上游 Python 后端 + 平台账号/好友/邀请）。
 *
 *   npm run test:mahjong:browser      # = node tests/mahjong.browser.mjs
 *
 * 验的是用户点名的三件事：
 *   1. 账号一致：未登录先回平台登录页；注册后自动回到 `/mahjong/`，
 *      页面里的 `window.__FRP_ME__` 就是平台账号，**大厅里没有昵称输入框**。
 *   2. 进好友房：A 建房 → B 在平台好友列表看到「正在玩 莲花广麻」/「进入」→
 *      点「进入」自动带房号进同一个房；A 在游戏里「邀请好友」→ B 收到平台邀请卡 →
 *      接受后同样自动进房。
 *   3. 手机：`/play/mahjong` 竖屏转 90° 包 iframe；桌面打开外壳自动回 `/mahjong/`。
 *
 * ⚠️ 真 HTTP + 真 WebSocket + 真 Chrome（每个页面独立临时 profile）+ 真上游后端。
 *    服务跑随机端口，不碰 7891。后端起不来时打印原因并退出（CI 需要 .venv）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/server.mjs';
import { Page } from '../tools/cdp.mjs';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function registerViaApi(page, base, name) {
  await page.goto(base);
  const res = await page.evalRaw(`(async () => {
    const r = await fetch('/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: ${JSON.stringify(name)}, password: 'secret123' }),
    });
    return { status: r.status, data: await r.json() };
  })()`);
  assert.equal(res.status, 200, '注册失败：' + JSON.stringify(res.data));
  return res.data.me;
}

async function clickText(page, text, selector = 'button') {
  const ok = await page.evalRaw(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.textContent.trim() === ${JSON.stringify(text)} && !node.disabled);
    if (!el) return false;
    el.click();
    return true;
  })()`);
  return ok;
}

/** 上游联机前有免责声明（一次性的）；自动点"同意并继续"。 */
async function acceptDisclaimerIfOpen(page) {
  return clickText(page, '同意并继续');
}

/** 登录页已经打开时：注册 → 关掉 ID 弹窗（不负责跳转，调用方自己等目标页）。 */
async function registerViaUi(page, name) {
  await page.waitFor(
    `return document.getElementById('screen-auth')?.classList.contains('is-active') === true`,
    15_000,
    '登录页出现'
  );
  await page.click('#tab-register');
  await page.setInput('#register-name', name);
  await page.setInput('#register-password', 'secret123');
  await page.setInput('#register-password2', 'secret123');
  await page.click('#form-register .btn-primary');
  await page.waitFor(`return !document.getElementById('modal-id').hidden`, 15_000, 'ID 弹窗');
  await page.click('#btn-id-done');
}

async function roomCodeOf(page) {
  return page.evalRaw(`(() => {
    const el = document.querySelector('.room-code strong');
    return el ? el.textContent.trim() : '';
  })()`);
}

async function waitForRoom(page, timeout = 30_000) {
  await page.waitFor(`return Boolean(document.querySelector('.room-code strong'))`, timeout, '进入房间');
  return roomCodeOf(page);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'mahjong-browser-'));
  const srv = await startServer({
    port: 0,
    dbPath: join(dir, 'test.db'),
    statePath: join(dir, 'state.json'),
    mahjongBackend: true,
    // 独立端口 + 独立 SQLite：不和真实服务（8123）复用后端，也不往线上库写测试房间
    mahjongBackendPort: 8199,
    mahjongDbPath: join(dir, 'mahjong-backend.db'),
  });
  assert.equal(srv.mahjong?.ready, true, '麻将后端没起来（缺 games/mahjong/backend/.venv？见 README）');
  const base = srv.url.replace(/\/$/, '');
  const pages = [];
  const launch = async (width = 1280, height = 900) => {
    const page = await Page.launch({ headless: true, width, height, startUrl: base });
    pages.push(page);
    return page;
  };

  try {
    /* ================= 1. 登录门 + 账号注入 ================= */
    console.log('[1] 未登录 → 平台登录 → 注册后自动回莲花广麻');
    const p1 = await launch();
    await p1.goto(base + '/mahjong/');
    await p1.waitFor(
      `return document.getElementById('screen-auth')?.classList.contains('is-active') === true`,
      15_000,
      '登录页出现'
    );
    await p1.click('#tab-register');
    await p1.setInput('#register-name', '浏览器甲');
    await p1.setInput('#register-password', 'secret123');
    await p1.setInput('#register-password2', 'secret123');
    await p1.click('#form-register .btn-primary');
    await p1.waitFor(`return !document.getElementById('modal-id').hidden`, 15_000, 'ID 弹窗');
    const idA = await p1.eval(`return document.getElementById('new-id').textContent.trim()`);
    assert.match(idA, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{7}$/, '领到的平台 ID 不合规');
    await p1.click('#btn-id-done');
    await p1.waitFor('return location.pathname === "/mahjong/"', 20_000, '注册完自动回麻将页');
    await p1.waitFor('return typeof window.__FRP_ME__ === "object" && window.__FRP_ME__ !== null', 20_000, '身份注入');
    const me = await p1.eval('return window.__FRP_ME__');
    assert.equal(me.id, idA, '游戏里的 ID 必须就是平台 ID');
    assert.equal(me.name, '浏览器甲');
    console.log('  · ' + me.name + ' / ' + me.id + ' · 没有上游登录页');

    /* ================= 2. 联机大厅：账号一致、没有昵称输入框 ================= */
    console.log('[2] 大厅：账号就是平台账号（没有昵称输入框）');
    await p1.waitFor('return document.body.innerText.includes("联机对战")', 30_000, '大厅出现');
    // 按钮里是 <b>联机对战</b><span>创建或加入房间</span>，textContent 不是纯「联机对战」
    const switched = await p1.evalRaw(`(() => {
      const el = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('联机对战'));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    assert.equal(switched, true, '找不到「联机对战」');
    await p1.waitFor('return document.body.innerText.includes("当前账号")', 10_000, '联机大厅账号');
    await sleep(300);
    const lobbyText = await p1.eval('return document.body.innerText');
    assert.ok(lobbyText.includes('当前账号'), '联机大厅要显示当前平台账号');
    assert.ok(lobbyText.includes('浏览器甲'), '显示的账号名必须是平台名字');
    const nameInputs = await p1.evalRaw(`return [...document.querySelectorAll('.remote-lobby input')]
      .filter((el) => (el.placeholder || '').includes('昵称')).length`);
    assert.equal(nameInputs, 0, '平台托管时不能再让玩家填昵称');

    /* ================= 3. 建房 + 邀请按钮 + 心跳 ================= */
    console.log('[3] 建房 → 房间码 + 邀请好友按钮');
    assert.equal(await clickText(p1, '创建房间'), true, '找不到「创建房间」');
    assert.equal(await clickText(p1, '确认创建'), true, '找不到「确认创建」');
    // 首次联机要过上游的免责声明
    for (let i = 0; i < 20; i++) {
      if (await acceptDisclaimerIfOpen(p1)) break;
      await sleep(200);
    }
    const code = await waitForRoom(p1);
    assert.match(code, /^[A-Z0-9]{6}$/, '房间码应该是上游的 6 位短码');
    await p1.waitFor(
      `return [...document.querySelectorAll('button')].some((el) => el.textContent.trim() === '邀请好友')`,
      15_000,
      '邀请好友按钮'
    );
    // 页面心跳要能让好友列表看到「正在玩」——直接读平台接口
    const presence = await p1.evalRaw(`(async () => {
      const r = await fetch('/api/mahjong/friends');
      return { status: r.status, data: await r.json() };
    })()`);
    assert.equal(presence.status, 200);
    console.log('  · 房号 ' + code + ' · 页面心跳/邀请接口通的');

    /* ================= 4. 好友列表「正在玩 / 进入」 ================= */
    console.log('[4] 乙在平台首页看到「正在玩 莲花广麻」+「进入」');
    let p2 = await launch();
    const meB = await registerViaApi(p2, base, '浏览器乙');
    srv.store.addFriend(idA, meB.id);
    srv.store.addFriend(meB.id, idA);
    await p2.goto(base);
    await p2.waitFor('return window.GameNet && window.GameNet.connected === true', 15_000, '乙平台连接');
    await p2.click('#tab-friends');
    await p2.waitFor('return document.body.innerText.includes("浏览器甲")', 20_000, '乙看到好友');
    await p2.waitFor(
      'return document.querySelector("#friend-list .friend-status")?.textContent.includes("正在玩 莲花广麻")',
      20_000,
      '好友状态'
    );
    assert.equal(
      await p2.eval('return Boolean(document.querySelector("#friend-list .friend-join"))'),
      true,
      '好友卡片要有「进入」按钮'
    );
    console.log('  · 乙看到「正在玩 莲花广麻」+「进入」');

    /* ================= 5. 游戏内邀请 → 平台邀请卡 → 自动进房 ================= */
    console.log('[5] 甲点「邀请好友」→ 乙收到邀请 → 接受后自动进同一个房');
    await p1.eval(`
      const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '邀请好友');
      button.click();
      return true;
    `);
    await p1.waitFor('return Boolean(document.getElementById("frp-mahjong-invite-dialog"))', 10_000, '邀请弹窗');
    await p1.waitFor(
      'return document.getElementById("frp-mahjong-invite-dialog").innerText.includes("浏览器乙")',
      10_000,
      '邀请弹窗列出乙'
    );
    await p1.eval(`
      const dialog = document.getElementById('frp-mahjong-invite-dialog');
      const box = dialog.querySelector('input[type=checkbox]');
      box.click();
      const send = [...dialog.querySelectorAll('button')].find((el) => el.textContent.trim() === '发送邀请');
      send.click();
      return true;
    `);
    await p2.waitFor('return Boolean(document.querySelector(".frp-invite-card"))', 20_000, '乙收到邀请卡');
    assert.ok(
      (await p2.eval('return document.querySelector(".frp-invite-card").innerText')).includes('莲花广麻'),
      '邀请卡要写莲花广麻'
    );
    // 真实点击（脚本 .click() 没有用户手势，window.open 会被拦）
    await p2.click('.frp-invite-card button');
    // 平台首页所有游戏都新窗口打开：切到新标签页继续
    p2 = await p2.waitForNewPage({ urlIncludes: '/mahjong/' });
    await p2.waitFor('return location.pathname === "/mahjong/"', 30_000, '乙接受后进麻将页');
    for (let i = 0; i < 30; i++) {
      if (await acceptDisclaimerIfOpen(p2)) break;
      await sleep(200);
    }
    const codeB = await waitForRoom(p2);
    assert.equal(codeB, code, '乙应该自动进了甲的那个房');
    const searchAfterJoin = await p2.evalRaw('return location.search');
    assert.ok(!searchAfterJoin.includes('join='), '进房后地址栏不再带 ?join');
    await p1.waitFor(
      `return document.body.innerText.includes('浏览器乙')`,
      30_000,
      '甲看到乙进房'
    );
    console.log('  · 乙已自动进房 ' + code);

    /* ================= 6. 手机伪横屏 + 桌面回真页面 ================= */
    console.log('[6] 375px 手机 /play/mahjong 旋转 90°；桌面自动回 /mahjong/');
    const p3 = await launch(390, 844);
    await registerViaApi(p3, base, '外壳测试丙');
    await p3.setViewport(390, 844, true);
    await p3.conn.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await p3.conn.send('Page.navigate', { url: base + '/play/mahjong' });
    await p3.waitFor('return Boolean(document.getElementById("game"))', 10_000, '外壳 iframe');
    await p3.waitFor(
      `return (() => { const f = document.getElementById('game'); return f && f.contentWindow.location.pathname === '/mahjong/'; })()`,
      30_000,
      'iframe 进麻将页'
    );
    const shell = await p3.evalRaw(`(() => {
      const rot = document.getElementById('rot');
      const frame = document.getElementById('game');
      return { transform: getComputedStyle(rot).transform, w: frame.clientWidth, h: frame.clientHeight, src: frame.src };
    })()`);
    assert.match(shell.src, /\/mahjong\/$/, 'iframe 要指向 /mahjong/');
    assert.ok(shell.w > shell.h, '手机竖屏时 iframe 应该是横的（转 90°）');
    assert.notEqual(shell.transform, 'none', '外壳应该旋转了');

    const p4 = await launch();
    await registerViaApi(p4, base, '桌面测试丁');
    // 外壳在桌面会 location.replace('/mahjong/')：中途换页会让 goto 的 load 等待落空，
    // 所以只发导航、等最终路径。
    await p4.conn.send('Page.navigate', { url: base + '/play/mahjong' });
    await p4.waitFor('return location.pathname === "/mahjong/"', 20_000, '桌面回真页面');
    console.log('  · 手机转 90° / 桌面回真页面');

    console.log('MAHJONG BROWSER OK');
  } finally {
    for (const page of pages) {
      try { await page.close(); } catch { /* 已经关了 */ }
    }
    await srv.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});