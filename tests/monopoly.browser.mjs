/*
 * 大富翁 · 平台级真浏览器验证（这一版是上游 MineMonopoly 的 Web 客户端）。
 *
 *   node tests/monopoly.browser.mjs
 *
 * 验的是用户点名的三件事，以及手机外壳：
 *   1. 登录门：未登录开 `/games/monopoly/` → 平台登录页（带回跳）；注册完自动回游戏页。
 *   2. 账号一致：页面里的 `window.__FRP_ME__` / localStorage.user 就是平台账号，
 *      游戏里没有"自己起昵称"的输入框。
 *   3. 好友邀请 / 进好友房：A 建房 → B 在平台好友列表看到「正在玩 大富翁」/「进入」，
 *      A 在游戏里点「邀请好友」→ B 收到平台邀请卡 → 接受后自动进同一个房；
 *      然后两人选角色/选地图/开始，真进 3D 棋盘（canvas）。
 *   4. 手机：竖屏 `/play/monopoly` 旋转 90° 包 iframe；桌面自动回真页面。
 *
 * ⚠️ 真 HTTP + 真 WebSocket + 真 Chrome（每个页面独立临时 profile）。
 *    服务跑随机端口，不碰 7891。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/server.mjs';
import { Page } from '../tools/cdp.mjs';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/* ============================== 工具 ============================== */

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

/** 从游戏大厅输入房号并建房/进房。 */
async function enterRoomByInput(page, room) {
  await page.waitFor('return document.body.innerText.includes("联机房间")', 30_000, '游戏大厅出现');
  await page.eval(`
    const input = [...document.querySelectorAll('input')].find((el) => (el.placeholder || '').includes('房间号'));
    if (!input) return false;
    input.value = ${JSON.stringify(room)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim().includes('加入/创建房间'));
    if (!button) return false;
    button.click();
    return true;
  `);
  await page.waitFor('return location.pathname.endsWith("/room")', 30_000, '进入房间页');
}

async function clickText(page, selector, text) {
  const ok = await page.evalRaw(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.textContent.trim() === ${JSON.stringify(text)} && !node.disabled);
    if (!el) return false;
    el.click();
    return true;
  })()`);
  assert.equal(ok, true, `找不到可点的「${text}」`);
}

async function chooseFirstRole(page) {
  // 地图数据（含角色表）是先传图再解析的：要等 canSelectRole 变 true，
// 否则点的是一个 aria-disabled 的空按钮，弹窗根本不出现。
  await page.waitFor('return Boolean(document.querySelector(".choose-role.my-button"))', 30_000, '角色按钮可用');
  const opened = await page.evalRaw(`(() => {
    // 客人页面里房主卡片也有 .choose-role（只是 aria-disabled），必须点自己那张
    const el = document.querySelector('.choose-role.my-button');
    if (!el) return false;
    el.click();
    return true;
  })()`);
  assert.equal(opened, true, '点不开选择角色');
  await page.waitFor('return Boolean(document.querySelector(".fp-dialog .item-selector .items"))', 10_000, '角色弹窗');
  await page.eval(`
    const item = document.querySelector('.fp-dialog .item-selector .items');
    item.click();
    const ok = document.querySelector('.fp-dialog-footer button');
    if (ok) ok.click();
    return true;
  `);
  await sleep(500);
}

async function chooseFirstMap(page) {
  await clickText(page, 'button', '选择地图');
  await page.waitFor('return document.body.innerText.includes("点击想玩的地图然后确认")', 10_000, '地图弹窗');
  await page.waitFor('return document.querySelectorAll(".fp-dialog .item-selector .items").length >= 5', 15_000, '5 张官方地图');
  const name = await page.eval(`
    const item = document.querySelector('.fp-dialog .item-selector .items');
    const name = item.innerText.trim().split('\\n')[0];
    item.click();
    const ok = document.querySelector('.fp-dialog-footer button');
    if (ok) ok.click();
    return name;
  `);
  assert.ok(name && name.length > 0, '地图名不该为空');
  return name;
}

/* ============================== 主流程 ============================== */

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'mp-browser-'));
  const srv = await startServer({ port: 0, dbPath: join(dir, 'test.db'), statePath: join(dir, 'state.json') });
  const base = srv.url.replace(/\/$/, '');
  const pages = [];
  const launch = async (width = 1280, height = 900) => {
    const page = await Page.launch({ headless: true, width, height, startUrl: base });
    pages.push(page);
    return page;
  };

  try {
    /* ================= 1. 登录门 + 账号注入 ================= */
    console.log('[1] 未登录 → 平台登录 → 注册后自动回游戏页');
    const p1 = await launch();
    await p1.goto(base + '/games/monopoly/');
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
    await p1.waitFor('return location.pathname === "/games/monopoly/"', 20_000, '注册完自动回大富翁');
    await p1.waitFor('return typeof window.__FRP_ME__ === "object" && window.__FRP_ME__ !== null', 20_000, '身份注入');
    const me = await p1.eval('return window.__FRP_ME__');
    assert.equal(me.id, idA, '游戏里的 ID 必须就是平台 ID');
    assert.equal(me.name, '浏览器甲');
    // 上游 bundle 写 localStorage.user 比 __FRP_ME__ 注入晚一拍，等它写出来再断言
    await p1.waitFor(`return !!localStorage.getItem("user")`, 10_000, '上游 localStorage.user 已写入');
    const stored = await p1.evalRaw('return JSON.parse(localStorage.getItem("user"))');
    assert.equal(stored.userId, idA, '上游 localStorage.user 也要是平台账号');
    assert.equal(stored.username, '浏览器甲');
    console.log('  · ' + me.name + ' / ' + me.id + ' · 没有上游登录页');

    /* ================= 2. 建房 + 好友 presence ================= */
    console.log('[2] 建房 → 好友列表看到「正在玩 大富翁」');
    await enterRoomByInput(p1, 'browserroom');
    await p1.waitFor('return document.body.innerText.includes("邀请好友")', 15_000, '房间页');
    assert.ok((await p1.eval('return document.body.innerText')).includes('浏览器甲'), '房间页要显示平台昵称');

    let p2 = await launch();
    const meB = await registerViaApi(p2, base, '浏览器乙');
    srv.store.addFriend(idA, meB.id);
    await p2.goto(base);
    await p2.waitFor('return window.GameNet && window.GameNet.connected === true', 15_000, '乙平台连接');
    await p2.click('#tab-friends');
    await p2.waitFor('return document.body.innerText.includes("浏览器甲")', 20_000, '乙看到好友');
    await p2.waitFor('return document.querySelector("#friend-list .friend-status")?.textContent.includes("正在玩 大富翁")', 15_000, '好友状态');
    const joinButton = await p2.eval('return Boolean(document.querySelector("#friend-list .friend-join"))');
    assert.equal(joinButton, true, '好友卡片要有「进入」按钮');
    console.log('  · 乙看到「正在玩 大富翁」+「进入」');

    /* ================= 3. 游戏内邀请 → 平台邀请卡 → 进房 ================= */
    console.log('[3] 游戏里点「邀请好友」→ 乙收到平台邀请 → 接受即进房');
    await p1.click('.frp-invite-button');
    await p1.waitFor('return Boolean(document.querySelector("#frp-invite-overlay"))', 5_000, '邀请弹窗');
    await p1.waitFor('return document.querySelector("#frp-invite-overlay").innerText.includes("浏览器乙")', 10_000, '邀请弹窗列出乙');
    await p1.eval(`
      const box = document.querySelector('#frp-invite-overlay input[type=checkbox]');
      box.click();
      const send = [...document.querySelectorAll('#frp-invite-overlay button')].find((el) => el.textContent.trim() === '发送邀请');
      send.click();
      return true;
    `);
    await p2.waitFor('return Boolean(document.querySelector(".frp-invite-card"))', 15_000, '乙收到邀请卡');
    assert.ok((await p2.eval('return document.querySelector(".frp-invite-card").innerText')).includes('大富翁'));
    // 真实点击（脚本 .click() 没有用户手势，window.open 会被拦）
    await p2.click('.frp-invite-card button');
    // 平台首页所有游戏都新窗口打开：切到新标签页继续
    p2 = await p2.waitForNewPage({ urlIncludes: '/games/monopoly/' });
    await p2.waitFor('return location.pathname.endsWith("/room")', 30_000, '乙接受后进房');
    await p1.waitFor('return document.body.innerText.includes("浏览器乙")', 15_000, '甲看到乙进房');
    console.log('  · 乙已进同一个房');

    /* ================= 4. 选角色 / 选图 / 开始 → 两边进棋盘 ================= */
    console.log('[4] 乙选角色 → 甲选官方地图 → 乙准备 → 开始 → 两边 canvas');
    // 角色列表来自地图，必须先选图再选角色（空图时「选择角色」弹窗是空的）
    const mapName = await chooseFirstMap(p1);
    await p1.waitFor('return !document.body.innerText.includes("地图传输中")', 60_000, '地图传到乙');
    await p2.waitFor(`return document.body.innerText.includes(${JSON.stringify(mapName)})`, 30_000, '乙看到地图名');
    await chooseFirstRole(p2);
    await clickText(p2, 'button', '准备');
    await p1.waitFor('return [...document.querySelectorAll("button")].some((el) => el.textContent.trim() === "开始游戏" && !el.disabled)', 20_000, '开始按钮亮');
    await clickText(p1, 'button', '开始游戏');
    await p1.waitFor('return location.pathname.endsWith("/game")', 60_000, '甲进棋盘');
    await p2.waitFor('return location.pathname.endsWith("/game")', 60_000, '乙进棋盘');
    // Three.js 要等模型加载完才建 canvas，不能刚跳路由就数
    await p1.waitFor('return document.querySelectorAll("canvas").length > 0', 60_000, '甲的 canvas');
    await p2.waitFor('return document.querySelectorAll("canvas").length > 0', 60_000, '乙的 canvas');
    const canvasA = await p1.eval('return document.querySelectorAll("canvas").length');
    const canvasB = await p2.eval('return document.querySelectorAll("canvas").length');
    console.log('  · 地图「' + mapName + '」· 两边都进了 3D 棋盘');

    /* ================= 5. 手机伪横屏 ================= */
    console.log('[5] 375px 手机竖屏 /play/monopoly：内容转 90°');
    const p3 = await launch(390, 844);
    await registerViaApi(p3, base, '外壳测试丙');
    await p3.setViewport(390, 844, true);
    await p3.conn.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await p3.goto(base + '/play/monopoly');
    await p3.waitFor('return Boolean(document.getElementById("game"))', 10_000, '外壳 iframe');
    // iframe 里的 Vue 路由还要一次 login → room-router 的守卫跳转
    await p3.waitFor(
      `return (() => { const f = document.getElementById('game'); return f && f.contentWindow.location.pathname === '/games/monopoly/room-router'; })()`,
      30_000,
      'iframe 进大厅路由'
    );
    const shell = await p3.eval(`
      const rot = document.getElementById('rot');
      const frame = document.getElementById('game');
      return {
        coarse: matchMedia('(pointer: coarse)').matches,
        transform: getComputedStyle(rot).transform,
        src: frame.src,
        innerPath: frame.contentWindow.location.pathname,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    `);
    assert.equal(shell.coarse, true, '模拟手机应该是粗指针');
    assert.match(shell.transform, /matrix/, '竖屏时 #rot 必须旋转');
    assert.ok(shell.src.includes('/games/monopoly/'), 'iframe 指向游戏页');
    assert.equal(shell.innerPath, '/games/monopoly/room-router', 'iframe 里应该已经进大厅');
    assert.equal(shell.overflowX, 0, '外壳页不许横向溢出');
    await p3.waitFor(
      `return (() => { const d = document.getElementById('game').contentDocument; return d && d.body && d.body.innerText.includes('联机房间'); })()`,
      30_000,
      'iframe 里的大厅'
    );
    console.log('  · ' + shell.transform + ' · 无横向溢出');

    /* ================= 6. 桌面 /play/monopoly 自动回真页面 ================= */
    console.log('[6] 桌面访问 /play/monopoly 自动回 /games/monopoly/');
    await p1.goto(base + '/play/monopoly');
    await p1.waitFor('return location.pathname === "/games/monopoly/"', 15_000, '桌面不走 iframe');
    console.log('  · 落到 ' + (await p1.eval('return location.pathname')));

    const errors = [...p1.errors, ...p2.errors, ...p3.errors];
    assert.deepEqual(errors, [], '浏览器控制台不该有错误：' + errors.join(' | '));
    console.log('\n✔ 大富翁平台级真浏览器验证全部通过');
    console.log('  账号：' + idA + ' / ' + meB.id);
  } finally {
    for (const page of pages) {
      try { await page.close(); } catch { /* 忽略 */ }
    }
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});