/*
 * 斗地主 · 真浏览器端到端（三个人、三台 Chrome、一张真牌桌）。
 *
 *   node tests/ddz.browser.mjs
 *
 * 【为什么要这条】
 * 斗地主的牌桌是**上游的 Godot 网页导出**（`games/ddz/table/`，一块 canvas + 42 MB wasm）。
 * 它跟页面的关系只有两条 JS 桥（见 `js/online.js` 的文件头），而这两条桥**只有真浏览器证明得了**：
 *   · Node 集成测试（`tests/ddz.test.mjs`）是在报文层面把流程调一遍，看不见 canvas；
 *   · GDScript 打错一个字段名不会让任何 Node 测试变红，只会让牌桌一片空白。
 *
 * 【它要走的路，就是用户实际会走的路】
 *   甲注册 → 进 /ddz/ 建房 → 加乙为好友 → 在房里勾上乙、点「发送邀请」
 *   → 乙的页面弹出「甲邀请你玩斗地主」→ 点「进入」→ 乙坐进同一个房
 *   → 丙用邀请链接 /ddz/?join=房号 进来 → 甲点「开始游戏」
 *   → 三块牌桌把 wasm 跑起来 → **在 canvas 上真点一下「叫地主」**（不是绕过界面发报文）
 *   → 服务器定地主、三家牌桌跟着重画 → 把这一局打到结算
 *   → 再用 375px 的手机视口过一遍：/ddz/ 的登录门、伪横屏外壳 /play/ddz
 *
 * 【怎么"看见" canvas 里的东西】
 * GDScript 每画完一次就把关键数字和两个按钮的坐标报给页面，存在 `window.__FrpDdzTable`
 * （见 `脚本/手牌管理器.gd` 的 `发渲染()`）。测试靠它断言手牌张数、轮到谁、结算没有；
 * 也用它的按钮坐标换算成页面坐标，`page.clickAt()` 点真实鼠标事件。
 *
 * ⚠️ 牌桌要下 51 MB（本地服务，几秒）；这三条用例比其它浏览器用例慢，属正常。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/server.mjs';
import { Page, findChrome } from '../tools/cdp.mjs';
import { canBeat, classify } from '../games/ddz/js/engine/rules.js';

const SHOTS = new URL('./screenshots/', import.meta.url).pathname.replace(/^\//, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 牌桌（Godot 导出）的入口。⚠️ 换地址要同时改 `js/online.js` 和 `server/http.mjs` 的登录门。 */
const TABLE_URL = '/ddz/table/index.html';

/* ============================== 页面小工具 ============================== */

/** 注册一个账号（走真实界面），关掉"你的 ID"弹窗，返回 ID。 */
async function register(page, base, name) {
  await page.goto(base);
  await page.waitFor(
    `return document.getElementById('screen-auth') && document.getElementById('screen-auth').classList.contains('is-active')`,
    15_000,
    '登录页出现'
  );
  await page.click('#tab-register');
  await page.setInput('#register-name', name);
  await page.setInput('#register-password', 'secret123');
  await page.setInput('#register-password2', 'secret123');
  await page.click('#form-register .btn-primary');
  await page.waitFor(`return !document.getElementById('modal-id').hidden`, 15_000, `${name} 的 ID 弹窗`);
  const id = await page.eval(`return document.getElementById('new-id').textContent.trim()`);
  assert.match(id, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{7}$/, `${name} 领到的 ID 不合规：${id}`);
  await page.click('#btn-id-done');
  await page.waitFor(`return window.GameNet && window.GameNet.connected === true`, 15_000, `${name} 连接就绪`);
  return id;
}

/** 按可见文字点一个按钮（房间外壳的按钮没有 id）。 */
async function clickByText(page, selector, label) {
  const ok = await page.evalRaw(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const node = nodes.find((n) => (n.textContent || '').trim() === ${JSON.stringify(label)});
    if (!node) return false;
    node.click();
    return true;
  })()`);
  assert.equal(ok, true, `找不到写着「${label}」的按钮（${selector}）`);
}

/**
 * 点一个"点了就应该发生什么"的按钮：点完等条件成立，没成立就重点一次。
 *
 * 为什么要重试：无头 Chrome 里第一次点击偶尔落在还没挂好事件的那一帧上
 * （历史现象，产品本身点得动）。测试在这里宽容，是因为它要证明的是"点得动"。
 */
async function clickUntil(page, selector, label, condition, tries = 4) {
  for (let i = 0; i < tries; i += 1) {
    await clickByText(page, selector, label);
    try {
      await page.waitFor(condition, 4_000, `${label} 之后的状态`);
      return;
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(300);
    }
  }
}

/** 服务器推下来的那份视图（每个人看到的是自己裁剪过的那份）。 */
function viewOf(page) {
  return page.eval(`return (window.GameNet && window.GameNet.room && window.GameNet.room.view) || null`);
}

/** 牌桌自报的状态（canvas 里看不见，只能靠它）。 */
function probeOf(page) {
  return page.eval(`return window.__FrpDdzTable || null`);
}

/**
 * 让牌桌"替玩家"发一个意图（等同于玩家点了按钮）。
 *
 * 只用在**驱动流程**的地方（叫牌、出牌），针对方块按钮本身的验证另有专门一步。
 */
async function actVia(page, act) {
  const arg = JSON.stringify(JSON.stringify(act));
  const ok = await page.evalRaw(`(() => {
    if (!window.FrpDdzHost) return false;
    window.FrpDdzHost.动作(${arg});
    return true;
  })()`);
  assert.equal(ok, true, '页面上的牌桌桥不在了（FrpDdzHost）');
}

/** 等这一页收到"和刚才不一样"的视图（每个动作都会引来一次 room.state）。 */
async function waitViewChange(page, before, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await page.eval(`
      var v = window.GameNet && window.GameNet.room && window.GameNet.room.view;
      return v ? JSON.stringify(v) : '';
    `);
    if (now && now !== before) return JSON.parse(now);
    await sleep(60);
  }
  throw new Error('动作发出去了，但服务器没有推新状态');
}

/* ============================== 牌桌（canvas）坐标 ============================== */

/**
 * 场景坐标（Godot 的 1280×720 画面）→ 页面坐标。
 *
 * 项目里 `stretch/mode = viewport`、`aspect = keep`：画面等比缩放塞进 canvas，多出来的边是黑边。
 * 所以要先量 canvas 的实际大小，算出缩放比和黑边偏移。
 */
async function tablePoint(page, sceneX, sceneY) {
  const box = await page.eval(`
    var f = document.getElementById('ddz-table');
    if (!f || !f.contentDocument) return null;
    var c = f.contentDocument.querySelector('canvas');
    if (!c) return null;
    var fr = f.getBoundingClientRect();
    var cr = c.getBoundingClientRect();
    return { left: fr.left + cr.left, top: fr.top + cr.top, w: cr.width, h: cr.height };
  `);
  assert.ok(box && box.w > 100, `牌桌的 canvas 还没出来：${JSON.stringify(box)}`);
  const scale = Math.min(box.w / 1280, box.h / 720);
  const offsetX = (box.w - 1280 * scale) / 2;
  const offsetY = (box.h - 720 * scale) / 2;
  return { x: box.left + offsetX + sceneX * scale, y: box.top + offsetY + sceneY * scale };
}

/** 在牌桌上点真实按钮（'play' = 出牌/叫地主/抢地主 那个，'pass' = 不要/不叫/不抢）。 */
async function clickTableButton(page, which) {
  const probe = await probeOf(page);
  assert.ok(probe, '牌桌还没自报状态');
  const rect = which === 'pass' ? probe.passButtonRect : probe.playButtonRect;
  assert.ok(Array.isArray(rect) && rect[2] > 10 && rect[3] > 10, `牌桌没报按钮位置：${JSON.stringify(probe)}`);
  const [x, y, w, h] = rect;
  const point = await tablePoint(page, x + w / 2, y + h / 2);
  await page.clickAt(point.x, point.y);
  return point;
}

/* ============================== 出牌策略（只用来推进流程） ============================== */

function pickMove(view) {
  const prev = view.lastPlay
    ? { type: view.lastPlay.type, rank: view.lastPlay.rank, len: view.lastPlay.len }
    : null;
  const byRank = new Map();
  for (const card of view.hand) {
    if (!byRank.has(card.r)) byRank.set(card.r, []);
    byRank.get(card.r).push(card);
  }
  const groups = view.hand.map((card) => [card]);
  for (const group of byRank.values()) {
    if (group.length >= 2) groups.push(group.slice(0, 2));
    if (group.length >= 3) groups.push(group.slice(0, 3));
    if (group.length === 4) groups.push(group.slice(0, 4));
  }
  groups.sort((a, b) => a.length - b.length || a[0].r - b[0].r);
  for (const group of groups) {
    const info = classify(group);
    if (!info) continue;
    if (prev && !canBeat(prev, info)) continue;
    return group;
  }
  return null;
}

/* ============================== 主流程 ============================== */

async function main() {
  if (!findChrome()) {
    console.log('⏭  本机没有 Chrome/Edge，跳过这条测试');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'frp-ddz-browser-'));
  const app = await startServer({
    port: 0,
    dbPath: join(tmpDir, 'ddz.db'),
    statePath: join(tmpDir, 'server.json'),
  });
  const base = String(app.url).replace(/\/+$/, '');
  const shot = (name) => join(SHOTS, name);

  /** @type {any[]} */
  const pages = [];
  let mobile = null;

  try {
    mkdirSync(SHOTS, { recursive: true });
    console.log(`🧪 本机临时服务：${base}`);

    /* ---------- 0. 首页卡片：游戏列表里有斗地主 ---------- */
    const host = await Page.launch({ headless: true, width: 1280, height: 900 });
    pages.push(host);
    const hostId = await register(host, base, '斗地主甲');
    await host.waitFor(`return document.querySelectorAll('#game-grid .game-card').length >= 5`, 10_000, '游戏卡片画出来');
    const entry = await host.eval(`
      var ddz = (window.GAMES || []).filter(function (g) { return g.slug === 'ddz'; })[0] || null;
      var cards = [].slice.call(document.querySelectorAll('#game-grid .game-card')).map(function (c) {
        return c.textContent.replace(/\\s+/g, ' ').trim();
      });
      return { href: ddz && ddz.href, cards: cards };
    `);
    assert.equal(entry.href, '/ddz/', `首页的斗地主卡片要链到 /ddz/：${JSON.stringify(entry)}`);
    assert.ok(
      entry.cards.some((text) => text.includes('斗地主')),
      `首页游戏列表里应该有斗地主：${JSON.stringify(entry.cards)}`
    );

    /* ---------- 1. 甲进 /ddz/，建一间房 ---------- */
    await host.goto(`${base}/ddz/`);
    await host.waitFor(`return !!document.querySelector('.frp-room-idle')`, 20_000, '房间入口出现');
    // 身份来自平台账号：页头写着"你是 XXX"；页面里唯一允许出现的输入框是
    // 房间外壳自带的「6 位房间号」（输房号进别人的房），**没有**让人起昵称/改名字的地方
    await host.waitFor(`return document.getElementById('ddz-me').textContent.includes('斗地主甲')`, 10_000, '页头显示平台昵称');
    const inputs = await host.evalRaw(`(() =>
      [...document.querySelectorAll('#ddz-app input')].map((i) => ({ type: i.type, ph: i.placeholder || '', aria: i.getAttribute('aria-label') || '' }))
    )()`);
    assert.ok(
      inputs.every((i) => /房间号/.test(i.ph)),
      `斗地主页面里的输入框只该是「房间号」，不许有起昵称/改名的地方：${JSON.stringify(inputs)}`
    );
    // 还没进房，牌桌那一层应该是藏着的
    assert.equal(await host.eval(`return document.getElementById('ddz-stage').hidden`), true, '没进房就不该露牌桌');

    await clickUntil(host, '.frp-room-idle button', '创建房间', `return !!document.querySelector('.frp-room-waiting')`);
    const code = await host.eval(`return document.querySelector('.frp-room-code-value code').textContent.trim()`);
    assert.match(code, /^[A-Z0-9]{6}$/, `房号不合法：${code}`);
    await host.screenshot(shot('ddz-room-waiting.png'));

    /* ---------- 2. 好友邀请：甲勾上乙 → 乙点「进入」 ---------- */
    const friend = await Page.launch({ headless: true, width: 1280, height: 900 });
    pages.push(friend);
    const friendId = await register(friend, base, '斗地主乙');
    await friend.goto(`${base}/ddz/`);
    await friend.waitFor(`return !!document.querySelector('.frp-room-idle')`, 20_000, '乙的页面也起来了');

    // 好友关系直接在库里加上（申请-同意的界面流程在 room 测试里覆盖），
    // 再推一次好友列表 —— 平时这条推送由"申请/同意"那些动作触发
    app.store.addFriend(hostId, friendId);
    app.hub.pushFriends(hostId);
    app.hub.pushFriends(friendId);
    await host.waitFor(
      `return [...document.querySelectorAll('.frp-room-invite button')].some((b) => b.textContent.includes('邀请好友（1 人在线）'))`,
      15_000,
      '甲的房间里出现「邀请好友（1 人在线）」'
    );
    await clickByText(host, '.frp-room-invite button', '邀请好友（1 人在线）');
    // 勾上乙（用 ID 认人，不是名字 —— 名字可能重名）
    const checked = await host.evalRaw(`(() => {
      const box = document.querySelector('.frp-room-friends input[data-friend=' + JSON.stringify(${JSON.stringify(friendId)}) + ']');
      if (!box) return false;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      return true;
    })()`);
    assert.equal(checked, true, '邀请列表里应该有乙');
    await clickByText(host, '.frp-room-friends button', '发送邀请');

    await friend.waitFor(`return !!document.querySelector('.frp-invite-card')`, 15_000, '乙收到邀请卡');
    const inviteText = await friend.eval(`return document.querySelector('.frp-invite-card').textContent`);
    assert.match(inviteText, /斗地主甲/, `邀请卡里要说是谁邀请的：${inviteText}`);
    assert.match(inviteText, /斗地主/, `邀请卡里要写清是哪个游戏：${inviteText}`);
    // 平台这张邀请卡不印房号（点了「进入」服务端按邀请里的房号安排座位），
    // 所以房号对不对看下一条：乙进屋之后显示的房号必须等于甲那间。
    await friend.screenshot(shot('ddz-invite.png'));

    await clickByText(friend, '.frp-invite-card button', '进入');
    await friend.waitFor(`return document.querySelectorAll('.frp-room-members li').length >= 2`, 15_000, '乙坐进同一个房');
    const friendCode = await friend.eval(`return document.querySelector('.frp-room-code-value code').textContent.trim()`);
    assert.equal(friendCode, code, '乙应该进的是甲那间房');

    /* ---------- 3. 丙用邀请链接进来 ---------- */
    const third = await Page.launch({ headless: true, width: 1280, height: 900 });
    pages.push(third);
    await register(third, base, '斗地主丙');
    await third.goto(`${base}/ddz/?join=${code}`);
    await third.waitFor(`return document.querySelectorAll('.frp-room-members li').length >= 3`, 20_000, '丙也坐进来了');
    await host.waitFor(`return document.querySelectorAll('.frp-room-members li').length >= 3`, 10_000, '甲看到三个人');

    /* ---------- 4. 开局：三块牌桌把 wasm 跑起来 ---------- */
    await clickUntil(
      host,
      '.frp-room-waiting button',
      '开始游戏',
      `return window.GameNet.room && window.GameNet.room.phase === 'playing'`
    );
    for (const [who, page] of [['甲', host], ['乙', friend], ['丙', third]]) {
      await page.waitFor(`return window.GameNet.room && window.GameNet.room.phase === 'playing'`, 15_000, `${who} 这边开局了`);
    }
    console.log('✔ 三个人在同一个房里，服务器已开局');

    // 牌桌层露出来、房号对、加载提示最终要消失（消失 = 桥通了 = Godot 起来了）
    for (const [who, page] of [['甲', host], ['乙', friend], ['丙', third]]) {
      await page.waitFor(`return document.getElementById('ddz-stage').hidden === false`, 20_000, `${who} 的牌桌露出来`);
      const chip = await page.eval(`return document.getElementById('ddz-stage-code').textContent.trim()`);
      assert.equal(chip, code, `${who} 那边显示的房号不对：${chip}`);
      const src = await page.eval(`return document.getElementById('ddz-table').getAttribute('src') || ''`);
      assert.equal(src, TABLE_URL, `${who} 的 iframe 地址不对：${src}`);
      await page.waitFor(`return document.getElementById('ddz-stage-loading').hidden === true`, 90_000, `${who} 的牌桌加载完成`);
    }
    console.log('✔ 三块 Godot 牌桌都起来了（wasm + pck 从本地服务拉完，JS 桥通了）');

    // 牌桌自报：三个不同的座位、每人 17 张、阶段是"叫地主"、名字就是平台账号的昵称
    const probes = [];
    for (const [who, page] of [['甲', host], ['乙', friend], ['丙', third]]) {
      await page.waitFor(`return !!window.__FrpDdzTable`, 20_000, `${who} 的牌桌自报状态`);
      const probe = await probeOf(page);
      probes.push({ who, page, probe });
      assert.equal(probe.phase, 'bidding', `${who} 的牌桌应该在叫地主阶段：${JSON.stringify(probe)}`);
      assert.equal(probe.stage, 'call', `${who} 的牌桌应该停在"叫地主"：${JSON.stringify(probe)}`);
      assert.equal(probe.hand, 17, `${who} 的手牌应该是 17 张：${JSON.stringify(probe)}`);
      assert.equal(probe.bottom, 0, `${who} 的底牌在叫地主阶段不该翻开`);
      for (const name of ['斗地主甲', '斗地主乙', '斗地主丙']) {
        assert.ok(
          (probe.names || []).some((n) => n.includes(name)),
          `${who} 的牌桌上要显示平台昵称「${name}」：${JSON.stringify(probe.names)}`
        );
      }
    }
    const seats = probes.map((p) => p.probe.seat).sort();
    assert.deepEqual(seats, [0, 1, 2], `三块牌桌的座位号应该是 0/1/2：${JSON.stringify(seats)}`);
    // 牌桌"我在几号位"必须和服务器视图一致（不一致就是桥把座位弄反了）
    for (const { who, page, probe } of probes) {
      const view = await viewOf(page);
      assert.equal(probe.seat, view.seat, `${who} 的牌桌座位和服务器不一致`);
      assert.equal(probe.hand, view.hand.length, `${who} 的牌桌手牌数和服务器不一致`);
    }
    await host.screenshot(shot('ddz-table-bidding.png'));
    console.log('✔ 牌桌显示的是平台账号的名字，座位/手牌和服务器视图一致');

    /* ---------- 5. 在 canvas 上真点「叫地主」 ---------- */
    const callerEntry = probes.find((p) => p.probe.turn === p.probe.seat);
    assert.ok(callerEntry, '叫地主阶段应该有一家轮到自己：' + JSON.stringify(probes.map((p) => p.probe)));
    assert.equal(callerEntry.probe.playButton, true, '轮到自己时「叫地主」按钮要露出来');
    assert.equal(callerEntry.probe.playText, '叫地主', `按钮文字应该是叫地主：${callerEntry.probe.playText}`);
    assert.equal(callerEntry.probe.passButton, true, '轮到自己时「不叫」按钮也要露出来');
    assert.equal(callerEntry.probe.passText, '不叫', `按钮文字应该是不叫：${callerEntry.probe.passText}`);

    const callerPage = callerEntry.page;
    const callerSeat = callerEntry.probe.seat;
    const beforeClick = JSON.stringify(await viewOf(callerPage));
    const clicked = await clickTableButton(callerPage, 'play');
    console.log(`   在 canvas 上点了「叫地主」（页面坐标 ${Math.round(clicked.x)}, ${Math.round(clicked.y)}）`);
    const afterClick = await waitViewChange(callerPage, beforeClick);
    assert.equal(afterClick.stage, 'rob', `点了叫地主之后应该进抢地主：${JSON.stringify(afterClick)}`);
    assert.notEqual(afterClick.landlord, undefined, '视图结构不对');

    // 抢地主：两家人都不抢（走牌桌的桥发出去，跟玩家点「不抢」是同一条路）
    for (let i = 0; i < 2; i += 1) {
      const views = await Promise.all(pages.slice(1).map((p) => viewOf(p)));
      void views;
      const view = await viewOf(callerPage);
      const seat = view.turn;
      const actor = probes.find((p) => p.probe.seat === seat);
      assert.ok(actor, `找不到座位 ${seat} 的页面`);
      const before = JSON.stringify(await viewOf(actor.page));
      await actVia(actor.page, { type: 'bid', value: 0 });
      await waitViewChange(actor.page, before);
    }

    for (const [who, page] of [['甲', host], ['乙', friend], ['丙', third]]) {
      await page.waitFor(
        `return window.GameNet.room.view && window.GameNet.room.view.phase === 'playing'`,
        15_000,
        `${who} 那边进入出牌阶段`
      );
    }
    const playing = await viewOf(host);
    assert.equal(playing.landlord, callerSeat, '没人抢，叫地主的人就是地主');
    assert.equal(playing.bottom.length, 3, '定完地主底牌翻开');
    const landlordProbe = await probeOf(probes.find((p) => p.probe.seat === playing.landlord).page);
    await probes.find((p) => p.probe.seat === playing.landlord).page.waitFor(
      `return window.__FrpDdzTable && window.__FrpDdzTable.phase === 'playing'`,
      15_000,
      '地主的牌桌切到出牌阶段'
    );
    const landlordProbe2 = await probeOf(probes.find((p) => p.probe.seat === playing.landlord).page);
    assert.equal(landlordProbe2.hand, 20, `地主手里应该 20 张：${JSON.stringify(landlordProbe2)}`);
    assert.equal(landlordProbe2.bottom, 3, `地主的牌桌要把 3 张底牌摊出来：${JSON.stringify(landlordProbe2)}`);
    void landlordProbe;
    console.log('✔ canvas 上真点按钮 → 服务器定地主 → 三家牌桌跟着重画');

    /* ---------- 6. 打完这一局（推进用桥，渲染用牌桌） ---------- */
    const bySeat = new Map(probes.map((p) => [p.probe.seat, p.page]));
    let views = await Promise.all([host, friend, third].map((p) => viewOf(p)));
    let steps = 0;
    let midChecked = false;

    while (views[0].phase !== 'over' && steps < 300) {
      steps += 1;
      const view = views[0];
      const seat = view.turn;
      const page = bySeat.get(seat);
      assert.ok(page, `找不到座位 ${seat} 的页面`);
      const mine = views.find((v) => v.seat === seat);

      const before = JSON.stringify(await viewOf(page));
      if (!view.lastPlay) {
        // 领出：出最小的单张（牌型最简单，不会因为规则细节卡住）
        await actVia(page, { type: 'play', cards: [mine.hand[mine.hand.length - 1].id] });
      } else {
        const move = pickMove(mine);
        if (move) await actVia(page, { type: 'play', cards: move.map((c) => c.id) });
        else await actVia(page, { type: 'pass' });
      }
      await waitViewChange(page, before);
      views = await Promise.all([host, friend, third].map((p) => viewOf(p)));

      // 打到一半抽查一次：牌桌画的手牌数要和服务器一致（桥没断）
      if (!midChecked && steps === 12) {
        midChecked = true;
        const probe = await probeOf(host);
        assert.equal(probe.hand, views.find((v) => v.seat === probe.seat).hand.length, '打到一半牌桌的手牌数就和服务器不一致了');
      }
    }
    assert.equal(views[0].phase, 'over', `${steps} 步还没打完这一局`);
    assert.ok(views[0].winner, '结算要有赢家');
    assert.equal(views[0].aborted, null, '正常打完不该是"作废"');
    console.log(`✔ 一局打完了（${steps} 步），赢家是 ${views[0].winner.side}`);

    // 三家的牌桌都要切到结算（GDScript 收到 over 的视图就会亮出结算界面）
    for (const [who, page] of [['甲', host], ['乙', friend], ['丙', third]]) {
      await page.waitFor(`return window.__FrpDdzTable && window.__FrpDdzTable.over === true`, 20_000, `${who} 的牌桌进入结算`);
    }
    await host.screenshot(shot('ddz-table-over.png'));
    console.log('✔ 三块牌桌都进了结算');

    // 父页面不该有未捕获的异常（Godot 自己打到 console 的警告不算）
    for (const [who, page] of [['甲', host], ['乙', friend], ['丙', third]]) {
      const bad = (page.errors || []).filter((e) => /Uncaught|TypeError|ReferenceError/.test(e));
      assert.deepEqual(bad, [], `${who} 的页面有未捕获的异常：${JSON.stringify(bad)}`);
    }

    /* ---------- 7. 手机：登录门 + 伪横屏外壳 ---------- */
    mobile = await Page.launch({ headless: true, width: 375, height: 667, mobile: true });
    // 真手机上指针是"粗"的（外壳靠 `(pointer: coarse)` 判断要不要转）；无头浏览器要自己打开
    await mobile.conn.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    // 7a. 没登录直接开 /ddz/ → 被带回平台登录页，并且带着回跳地址
    await mobile.goto(`${base}/ddz/`);
    await mobile.waitFor(
      `return document.getElementById('screen-auth') && document.getElementById('screen-auth').classList.contains('is-active')`,
      15_000,
      '未登录时先落到登录页'
    );
    const gate = await mobile.eval(`return { path: location.pathname, search: location.search }`);
    assert.equal(gate.path, '/', `未登录应该落在平台登录页：${JSON.stringify(gate)}`);
    assert.ok(
      decodeURIComponent(gate.search).includes('/ddz/'),
      `登录页要记住"登录后回斗地主"：${gate.search}`
    );

    // 7b. 登录之后 375px 宽：页面不横向溢出，牌桌层仍然藏着
    await register(mobile, base, '手机玩家');
    await mobile.goto(`${base}/ddz/`);
    await mobile.waitFor(`return !!document.querySelector('.frp-room-idle')`, 20_000, '手机上房间入口出现');
    const narrow = await mobile.eval(`
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        stage: document.getElementById('ddz-stage').hidden,
        me: document.getElementById('ddz-me').textContent.trim(),
        bar: document.querySelector('.ddz-bar').getBoundingClientRect().height,
        button: (function () {
          var b = [...document.querySelectorAll('.frp-room-idle button')][0];
          return b ? Math.round(b.getBoundingClientRect().height) : 0;
        })(),
      };
    `);
    assert.ok(narrow.overflow <= 1, `375px 下页面被撑宽了 ${narrow.overflow}px`);
    assert.equal(narrow.stage, true, '不在房里时牌桌层要藏着');
    assert.match(narrow.me, /手机玩家/, `手机上也要显示平台昵称：${narrow.me}`);
    assert.ok(narrow.button >= 44, `手机上按钮点击区只有 ${narrow.button}px（要 ≥44px）`);
    await mobile.screenshot(shot('ddz-mobile-375.png'));

    // 7c. 伪横屏外壳 /play/ddz：竖屏手机把它转 90°，里面装的就是斗地主页面
    await mobile.goto(`${base}/play/ddz`);
    await mobile.waitFor(
      `return !!document.getElementById('rot') && !!document.getElementById('game')`,
      15_000,
      '伪横屏外壳出现'
    );
    await sleep(600);
    const shell = await mobile.eval(`
      var rot = document.getElementById('rot');
      var cs = getComputedStyle(rot);
      var frame = document.getElementById('game');
      var doc = frame.contentDocument;
      return {
        transform: cs.transform,
        coarse: matchMedia('(pointer: coarse)').matches,
        inner: doc && doc.getElementById('ddz-app') ? doc.body.innerText.slice(0, 200) : '',
        src: frame.getAttribute('src') || '',
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    `);
    assert.equal(shell.coarse, true, '模拟的手机应该是粗指针（否则外壳不会转）');
    // rotate(90deg) 在 computed style 里是个矩阵，认得出是 matrix 且不是单位矩阵就够了
    assert.match(shell.transform, /^matrix\(/, `横屏外壳应该把画面转 90°：${shell.transform}`);
    assert.notEqual(shell.transform, 'matrix(1, 0, 0, 1, 0, 0)', `外壳没有真的转：${shell.transform}`);
    assert.match(shell.src, /\/ddz\//, `外壳里的 iframe 应该指向 /ddz/：${shell.src}`);
    assert.match(shell.inner, /斗地主/, '外壳里装的确实是斗地主页面');
    assert.ok(shell.overflow <= 1, `伪横屏外壳在 375px 下被撑宽了 ${shell.overflow}px`);
    await mobile.screenshot(shot('ddz-mobile-shell.png'));

    console.log('✔ 手机：登录门带 return、375px 不溢出、伪横屏外壳转得对');

    // 7d. 电脑打开 /play/ddz 不该看到"横过来的小窗口"：自动回真正的 /ddz/
    await host.goto(`${base}/play/ddz`);
    await host.waitFor(`return location.pathname === '/ddz/'`, 15_000, '电脑访问手机壳会回真正的页面');
    console.log('✔ 电脑访问 /play/ddz 自动回 /ddz/（地址栏不留壳）');

    console.log('✔ 斗地主：首页入口 · 好友邀请进房 · 三人开局 · 真点按钮 · 打完一局 · 手机外壳');
  } catch (err) {
    console.error('✖ 失败：', err && err.message);
    for (const [i, page] of [...pages, mobile].filter(Boolean).entries()) {
      try {
        const state = await page.eval(`
          var f = document.getElementById('ddz-table');
          return JSON.stringify({
            url: location.href,
            phase: window.GameNet && window.GameNet.room && window.GameNet.room.phase,
            view: window.GameNet && window.GameNet.room && window.GameNet.room.view
              ? { seat: window.GameNet.room.view.seat, turn: window.GameNet.room.view.turn, phase: window.GameNet.room.view.phase }
              : null,
            table: window.__FrpDdzTable || null,
            frameSrc: f ? f.getAttribute('src') : null,
          });
        `);
        console.error(`  页面 ${i}: ${state}`);
      } catch (e) {
        console.error(`  页面 ${i}: 读状态失败（${e.message}）`);
      }
      if (page.errors && page.errors.length) console.error(`  页面 ${i} 报错: ${JSON.stringify(page.errors.slice(0, 5))}`);
    }
    process.exitCode = 1;
  } finally {
    for (const page of [...pages, mobile].filter(Boolean)) {
      try {
        page.close();
      } catch {
        /* 关不掉就算了 */
      }
    }
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('✖ 没跑起来：', err);
  process.exitCode = 1;
});
