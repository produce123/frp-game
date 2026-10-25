/*
 * 真浏览器：地平线赛车的联机链路 + 手机伪横屏外壳。
 *
 *   node tests/horizon.browser.mjs
 *
 * 为什么必须有一条真浏览器的：
 *   · `tests/horizon.test.mjs` 只证明"报文/房间/中继"对；证明不了**3D 页面真的
 *     把幽灵车建出来、真的能撞、结算面板真的出现**。
 *   · 这条用例用一台真 Chrome 做主机，另一个人用 Node 的 WebSocket 客户端扮队友
 *     （不需要第二台 3D 浏览器，headless 跑两个 Three.js 世界太慢了）。
 *   · 最后单独开一个手机视口 + 触摸模拟，验证 `/play/horizon` 真的把游戏横过来、
 *     并把 `?join=` 带进 iframe。
 *
 * 服务跑随机端口和临时库，不会碰 7891 / data/。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/server.mjs';
import { Page } from '../tools/cdp.mjs';
import { wsConnect } from './ws-client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app;
let tmpDir;

async function call(path, { body, cookie } = {}) {
  const res = await fetch(new URL(path, app.url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const sid = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('sid=') && c.length > 4);
  return { status: res.status, data, cookie: sid };
}

async function registerUser(name) {
  const res = await call('/api/register', { body: { name, password: 'secret123' } });
  assert.equal(res.status, 200, `注册失败：${JSON.stringify(res.data)}`);
  assert.ok(res.cookie);
  return { cookie: res.cookie, me: res.data.me };
}

async function setCookie(page, cookie, base) {
  await page.conn.send('Network.enable');
  await page.conn.send('Network.setCookie', {
    name: 'sid',
    value: cookie.slice(4),
    url: base,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });
}

async function clickButtonText(page, text) {
  await page.evalRaw(`(() => {
    const btn = [...document.querySelectorAll('#online-panel button')]
      .find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
    if (!btn) throw new Error('没有按钮：' + ${JSON.stringify(text)});
    btn.click();
  })()`);
}

async function waitForRoom(page, check) {
  await page.waitFor(`return Boolean(GameNet.room && (${check}))`, 10_000, '房间状态');
  return page.evalRaw('return GameNet.room');
}

async function main() {
  tmpDir = mkdtempSync(join(tmpdir(), 'frp-horizon-browser-'));
  app = await startServer({ port: 0, dbPath: join(tmpDir, 'test.db') });
  const base = app.url;

  const hostUser = await registerUser('浏览器主机');
  const peerUser = await registerUser('联机队友');

  const page = await Page.launch({
    headless: true,
    width: 1100,
    height: 720,
    startUrl: 'about:blank',
    extraArgs: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  let peerWs = null;
  let peerRelay = null;
  let mobile = null;
  let desktop = null;

  try {
    await setCookie(page, hostUser.cookie, base);
    await page.goto(new URL('/games/horizon/?touch=1', base).toString());
    await page.waitFor('return window.__stage === "input"', 120_000, '游戏菜单加载');
    await page.waitFor('return Boolean(window.__FrpHorizon)', 10_000, '平台接线就绪');

    // 账号绑定：大厅里显示的必须是平台首页那个账号。
    await page.click('#btnOnline');
    await page.waitFor('return !document.getElementById("horizonLobby").classList.contains("hidden")', 5000, '大厅打开');
    const accountText = await page.eval('return document.getElementById("horizonAccount").textContent');
    assert.match(accountText, new RegExp(hostUser.me.name), '大厅必须显示平台账号名');
    assert.match(accountText, /同一个账号/);

    await clickButtonText(page, '创建房间');
    await page.waitFor('return Boolean(document.querySelector(".frp-room-code"))', 10_000, '房间号出现');
    const code = await page.eval('return document.querySelector(".frp-room-code code").textContent');
    assert.match(code, /^[A-Z2-9]{6}$/);

    // 先把大厅收起来：房间不能因此散掉，再打开时房号还在。
    await page.eval('return document.getElementById("horizonLobbyClose").click()');
    await sleep(300);
    assert.equal(
      await page.eval('return document.getElementById("horizonLobby").classList.contains("hidden")'),
      true,
      '收起后大厅应隐藏'
    );
    assert.equal(await page.eval('return GameNet.room && GameNet.room.code'), code, '收起面板不能退房');
    await page.click('#btnOnline');
    await page.waitFor('return Boolean(document.querySelector(".frp-room-code"))', 5000, '重新打开大厅');

    // 队友从平台 WS 进房（真实链路：不是直接改 view）。
    peerWs = await wsConnect({ port: app.port, cookie: peerUser.cookie });
    await peerWs.waitFor('ready');
    peerWs.send({ t: 'room.join', code });
    const joined = await peerWs.waitFor((m) => m.t === 'room.state' && m.phase === 'waiting' && m.members.length === 2);
    assert.equal(joined.game, 'horizon');
    await waitForRoom(page, 'GameNet.room.phase === "waiting" && GameNet.room.members.length === 2');

    // 房主开始：服务端把 phase 推到 playing，页面自动切到赛道。
    // 偶尔 FrpRoom 刚重画完，第一次原生 click 会被 React 的换节点吞掉；先给它
    // 3 秒把 state 推回来，确实没开再点第二次（不绕过平台逻辑）。
    await clickButtonText(page, '开始游戏');
    try {
      await page.waitFor('return Boolean(GameNet.room && GameNet.room.phase === "playing")', 3000, '开始比赛');
    } catch {
      const hasStart = await page.eval(`return [...document.querySelectorAll('#online-panel button')]
        .some((b) => (b.textContent || '').includes('开始游戏'))`);
      if (hasStart) await clickButtonText(page, '开始游戏');
    }
    await waitForRoom(page, 'GameNet.room.phase === "playing"');
    await page.waitFor('return window.__FrpHorizon.state.racing === true', 60_000, '页面开始比赛');

    peerRelay = await wsConnect({ port: app.port, path: '/horizon-relay', cookie: peerUser.cookie });
    peerRelay.send({ t: 'hello', code, map: 'alpine', car: 'gt' });
    const peerWelcome = await peerRelay.waitFor('welcome');
    assert.equal(peerWelcome.code, code);
    peerRelay.send({ t: 'ready' });

    await page.waitFor('return window.__FrpHorizon.state.started === true', 15_000, '收到发车倒计时');
    // headless SwiftShader 只有几帧/秒，倒计时按 dt 走会很慢；测试里直接推到终点。
    await page.eval('Game.raceCountdown = 0.05; return true;');
    await page.waitFor('return Game.raceStarted === true', 30_000, '倒计时结束');
    await sleep(400);

    // 手机触屏：?touch=1 强制显示；必须真的合成 KeyW/KeyA…，而不是只画几个按钮。
    const touch = await page.evalRaw(`return (() => {
      const root = document.getElementById('horizonTouch');
      const codes = [...root.querySelectorAll('[data-code]')].map((b) => b.getAttribute('data-code'));
      const box = (code) => {
        const r = root.querySelector('[data-code="' + code + '"]').getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
      };
      const rect = (sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
      };
      return {
        hidden: root.classList.contains('hidden'),
        codes,
        steerL: box('KeyA'), steerR: box('KeyD'), gas: box('KeyW'), brake: box('KeyS'),
        map: rect('#minimap'), dash: rect('#dashHud'), score: rect('#scoreBox'),
        top: rect('#horizonTouch .hzone.top'),
        racePanel: rect('#racePanel'), raceTime: rect('#raceTime'),
        raceDeltaDisplay: getComputedStyle(document.getElementById('raceDelta')).display,
        raceCheckDisplay: getComputedStyle(document.getElementById('raceCheck')).display,
        raceParDisplay: getComputedStyle(document.getElementById('racePar')).display,
        raceTimeFont: parseFloat(getComputedStyle(document.getElementById('raceTime')).fontSize),
        vw: innerWidth, vh: innerHeight,
      };
    })()`);
    assert.equal(touch.hidden, false, '比赛中触屏按键应该显示');
    for (const code of ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space', 'KeyC', 'KeyR', 'Escape', 'KeyH', 'KeyQ', 'KeyE']) {
      assert.ok(touch.codes.includes(code), '触屏按键缺 ' + code);
    }
    assert.ok(touch.steerL.right < touch.vw / 2, '左转应在左半屏');
    assert.ok(touch.steerR.right < touch.vw / 2, '右转应在左半屏');
    assert.ok(touch.gas.left > touch.vw / 2, '油门应在右半屏');
    assert.ok(touch.brake.left > touch.vw / 2, '刹车应在右半屏');
    assert.ok(touch.gas.bottom <= touch.vh + 0.5 && touch.steerL.bottom <= touch.vh + 0.5, '按键不许跑出屏幕');
    assert.ok(touch.gas.w >= 44 && touch.gas.h >= 44, '油门点击区至少 44px');
    assert.ok(touch.steerL.w >= 44 && touch.steerL.h >= 44, '转向点击区至少 44px');
    assert.ok(touch.map.left < 160 && touch.map.top < 160 && touch.map.w <= 130, '比赛中小地图应在左上角且比桌面小');
    assert.ok(touch.dash.top > touch.map.top && touch.dash.w <= 150, '比赛中仪表盘应缩小放在小地图下方');
    assert.ok(touch.score.top >= touch.top.bottom - 1, '比赛中技能点不能被顶部小按钮盖住');
    assert.ok(touch.steerL.w >= 80 && touch.gas.w >= 96, '比赛中转向/油门应放大');
    assert.ok(touch.steerL.left > 20 && touch.gas.right < touch.vw - 20, '比赛中按键应离边缘远一点');
    assert.ok(touch.steerL.bottom < touch.vh - 20 && touch.gas.bottom < touch.vh - 20, '比赛中按键应往上挪一点');
    assert.ok(touch.racePanel.left >= touch.map.right + 4, '计时窗应在地图右边');
    assert.ok(Math.abs(touch.racePanel.top - touch.map.top) < 2, '计时窗应与地图同高');
    assert.ok(touch.racePanel.h <= 44 && touch.racePanel.w <= 150, '计时窗应最小化');
    assert.ok(touch.racePanel.right < touch.top.left - 4, '计时窗不能碰到顶部小按钮');
    assert.ok(touch.racePanel.bottom < touch.dash.top, '计时窗不能压住仪表盘');
    assert.ok(touch.raceTimeFont <= 18, '计时字号应收小');
    assert.equal(touch.raceDeltaDisplay, 'none', '手机计时窗隐藏目标差');
    assert.equal(touch.raceCheckDisplay, 'none', '手机计时窗隐藏检查点');
    assert.equal(touch.raceParDisplay, 'none', '手机计时窗隐藏目标时间');

    const keyDown = await page.evalRaw(`(() => {
      const b = document.querySelector('#horizonTouch [data-code="KeyW"]');
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'touch' }));
      return Boolean(Game.keys && Game.keys.KeyW);
    })()`);
    assert.equal(keyDown, true, '按住油门应让游戏收到 KeyW');
    const keyUp = await page.evalRaw(`(() => {
      const b = document.querySelector('#horizonTouch [data-code="KeyW"]');
      b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'touch' }));
      return Boolean(Game.keys && Game.keys.KeyW);
    })()`);
    assert.equal(keyUp, false, '松开油门应让游戏收到 KeyW 抬起');

    // 起点/终点拱门：闭环海岸赛道是一根“起点 / 终点”门，至少要有门柱+横梁+旗面+地面线。
    const gate = await page.evalRaw(`return (() => {
      const h = window.__FrpHorizon.state;
      return { n: h.gates.length, children: h.gates[0] ? h.gates[0].group.children.length : 0, closed: h.route && h.route.closed };
    })()`);
    assert.ok(gate.n >= 1, '联机比赛必须有起点/终点拱门');
    assert.ok(gate.children >= 5, '拱门至少要有两根门柱、横梁、旗面和地面线');

    // 队友的幽灵车必须真的被建出来，而不是只有服务器那边有记录。
    await page.waitFor(
      `return window.__FrpHorizon.state.ghosts.size === 1 && window.__FrpHorizon.state.racers.length === 2`,
      10_000,
      '幽灵车出现'
    );

    const routeStart = await page.evalRaw(`return (() => {
      const s = Game.oppRoute.samples[0];
      return { x: s.x, y: Game.world.terrainHeight(s.x, s.z) + 0.5, z: s.z };
    })()`);
    peerRelay.send({ t: 'pos', ...routeStart, yaw: 0, vx: 0, vz: 0, speed: 0, progress: 0.25 });
    const ghostPos = await page.waitFor(
      `return (() => {
        const g = window.__FrpHorizon.state.ghosts.get(${JSON.stringify(peerUser.me.id)});
        return Boolean(g && Math.hypot(g.target.x - ${routeStart.x}, g.target.z - ${routeStart.z}) < 0.01);
      })()`,
      5000,
      '幽灵车目标位置更新'
    );
    assert.ok(ghostPos);
    await sleep(800);
    const ghostView = await page.evalRaw(`return (() => {
      const g = window.__FrpHorizon.state.ghosts.get(${JSON.stringify(peerUser.me.id)});
      return { x: g.car.visual.position.x, z: g.car.visual.position.z, progress: g.progress };
    })()`);
    assert.ok(Math.hypot(ghostView.x - routeStart.x, ghostView.z - routeStart.z) < 25, '幽灵车视觉应靠近目标');

    // 车与车真实碰撞：把幽灵车放到本地车旁边 1.5 米，本地车必须被推开。
    const hit = await page.evalRaw(`return (() => {
      const H = window.__FrpHorizon.state;
      const g = H.ghosts.get(${JSON.stringify(peerUser.me.id)});
      const c = Game.car;
      g.car.visual.position.set(c.pos.x + 1.5, c.pos.y, c.pos.z);
      g.renderYaw = (c.yaw || 0) + Math.PI / 2;
      const bx = c.body.position.x, bz = c.body.position.z;
      window.__FrpHorizon.collide(g);
      return { dx: c.body.position.x - bx, dz: c.body.position.z - bz };
    })()`);
    assert.ok(Math.hypot(hit.dx, hit.dz) > 0.02, `碰撞应推开本地车，实际 ${JSON.stringify(hit)}`);

    // 队友先完赛，主机再完赛；两边都报 room.act 后比赛应该结束并弹出成绩。
    peerRelay.send({ t: 'finish', time: 44.4 });
    peerWs.send({ t: 'room.act', act: { type: 'finish', time: 44.4 } });
    await page.waitFor(
      `return window.__FrpHorizon.state.results.has(${JSON.stringify(peerUser.me.id)})`,
      5000,
      '收到队友完赛'
    );

    // 主机走真正的上游冲线函数：Game.finishRace → 我们的 patch → relay finish + room.act。
    // （不直接手发报文，否则测不到接线是否真的把完赛送出去。）
    // 两人都完赛后服务端立刻把房间推到 over，页面按设计收车回大厅，所以这里等 over。
    await page.eval('Game.finishRace(); return true;');
    await waitForRoom(page, 'GameNet.room.phase === "over"');

    await waitForRoom(page, 'GameNet.room.phase === "over"');
    await page.waitFor('return window.__FrpHorizon.state.racing === false && Game.state === "menu"', 15_000, '回到主菜单');
    await page.waitFor('return document.querySelectorAll(".race-results li").length === 2', 10_000, '结算列表');
    const results = await page.evalRaw(`return [...document.querySelectorAll('.race-results li')].map((li) => ({
      pos: li.querySelector('.pos').textContent,
      who: li.querySelector('.who').textContent,
      time: li.querySelector('.time').textContent,
    }))`);
    assert.deepEqual(results.map((r) => r.pos), ['#1', '#2']);
    assert.match(results[0].who, new RegExp(peerUser.me.name));
    assert.match(results[1].who, new RegExp(hostUser.me.name));
    assert.match(results[1].who, /你/);

    // 手机 HUD 布局：六组默认位置 + 真拖动/缩放/隐藏/重置。
    await page.eval('document.getElementById("horizonLobbyClose").click(); return true;');
    await page.waitFor('return document.getElementById("horizonLobby").classList.contains("hidden")', 5000, '收起大厅');
    const toolRow = await page.evalRaw(`return (() => {
      const tune = document.getElementById('btnTune').getBoundingClientRect();
      const layout = document.getElementById('btnLayout').getBoundingClientRect();
      return {
        layoutHidden: document.getElementById('btnLayout').classList.contains('hidden'),
        layoutVisible: layout.width > 1 && layout.height > 1,
        tune: { left: tune.left, right: tune.right, top: tune.top },
        layout: { left: layout.left, right: layout.right, top: layout.top },
      };
    })()`);
    assert.equal(toolRow.layoutHidden, false, '触屏设备主菜单要有手机界面布局按钮');
    assert.equal(toolRow.layoutVisible, true);
    assert.ok(toolRow.layout.left >= toolRow.tune.right - 1, '布局按钮应在驾驶辅助调节右边');
    assert.ok(Math.abs(toolRow.layout.top - toolRow.tune.top) < 8, '两个按钮应在同一行');
    await page.eval('document.getElementById("btnLayout").click(); return true;');
    await page.waitFor('return !document.getElementById("layoutEditor").classList.contains("hidden")', 5000, '布局编辑器打开');

    const layout = await page.evalRaw(`return (() => {
      const rect = (sel) => {
        const node = document.querySelector(sel);
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
      };
      return {
        menuHidden: document.getElementById('menu').classList.contains('hidden'),
        hudHidden: document.getElementById('hud').classList.contains('hidden'),
        handles: document.querySelectorAll('.layHandle').length,
        map: rect('#minimap'), dash: rect('#dashHud'), score: rect('#scoreBox'),
        steer: rect('#horizonTouch [data-code="KeyA"]'), gas: rect('#horizonTouch [data-code="KeyW"]'),
        top: rect('#horizonTouch .hzone.top'), vw: innerWidth, vh: innerHeight,
      };
    })()`);
    assert.equal(layout.menuHidden, true, '编辑布局时主菜单要收起');
    assert.equal(layout.hudHidden, false, '编辑布局时 HUD 要显示');
    assert.equal(layout.handles, 6, '六个布局组都要有拖动手柄');
    assert.ok(layout.map.left < 160 && layout.map.top < 160, '小地图应到左上角');
    assert.ok(layout.map.w <= 130, '小地图要比桌面版小');
    assert.ok(layout.dash.top > layout.map.top && layout.dash.w <= 150, '仪表盘应缩小放在小地图下方');
    assert.ok(layout.steer.w >= 80 && layout.gas.w >= 96, '转向和油门应放大');
    assert.ok(layout.steer.left > 20 && layout.gas.right < layout.vw - 20, '左右按键应离屏幕边缘远一点');
    assert.ok(layout.steer.bottom < layout.vh - 20 && layout.gas.bottom < layout.vh - 20, '按键应往上挪一点');
    assert.ok(layout.score.top >= layout.top.bottom - 1, '技能点不能被顶部小按钮盖住');

    const dragged = await page.evalRaw(`(() => {
      const h = document.querySelector('.layHandle[data-lay="map"]');
      const r = h.getBoundingClientRect();
      const x0 = r.left, y0 = r.top;
      h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x0 + 12, clientY: y0 + 12 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x0 + 52, clientY: y0 + 42 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x0 + 52, clientY: y0 + 42 }));
      return { left: document.getElementById('minimap').getBoundingClientRect().left };
    })()`);
    assert.ok(dragged.left > layout.map.left + 20, `拖动小地图后位置应改变，实际 ${dragged.left}`);

    const scaled = await page.evalRaw(`(() => {
      const s = document.getElementById('layScale');
      s.value = '120';
      s.dispatchEvent(new Event('input', { bubbles: true }));
      return { raw: localStorage.getItem('frp.horizon.layout.v1'), w: document.getElementById('minimap').getBoundingClientRect().width };
    })()`);
    assert.ok(scaled.w > layout.map.w * 1.1, '缩放滑杆应放大所选组');
    assert.ok(scaled.raw && JSON.parse(scaled.raw).map.s > 1, '布局改动应自动写入 localStorage');

    const hidden = await page.evalRaw(`(() => {
      document.getElementById('layShow').click();
      return {
        display: getComputedStyle(document.getElementById('minimap')).display,
        handle: Boolean(document.querySelector('.layHandle[data-lay="map"]')),
        tag: document.querySelector('.layHandle[data-lay="map"] .layTag').textContent,
      };
    })()`);
    assert.equal(hidden.display, 'none', '隐藏此项应真的隐藏小地图');
    assert.equal(hidden.handle, true, '隐藏后仍要留手柄，方便再打开');
    assert.match(hidden.tag, /已隐藏/);

    const reset = await page.evalRaw(`(() => {
      document.getElementById('layReset').click();
      const r = document.getElementById('minimap').getBoundingClientRect();
      return { left: r.left, w: r.width, display: getComputedStyle(document.getElementById('minimap')).display };
    })()`);
    assert.equal(reset.display, 'block');
    assert.ok(Math.abs(reset.left - 14) < 2, `重置后小地图应回默认位置，实际 ${reset.left}`);
    assert.ok(Math.abs(reset.w - 104) < 2, `重置后小地图应回默认大小，实际 ${reset.w}`);

    await page.eval('document.getElementById("layDone").click(); return true;');
    await page.waitFor('return document.getElementById("layoutEditor").classList.contains("hidden")', 5000, '布局编辑器关闭');
    const closed = await page.evalRaw(`return {
      menuHidden: document.getElementById('menu').classList.contains('hidden'),
      hudHidden: document.getElementById('hud').classList.contains('hidden'),
    }`);
    assert.equal(closed.menuHidden, false, '关闭布局后主菜单要回来');
    assert.equal(closed.hudHidden, true, '关闭布局后 HUD 要收起');

    // 真实横屏手机尺寸（844×390）：默认布局不能互相压住，面板可收起再打开。
    await page.conn.send('Emulation.setDeviceMetricsOverride', {
      width: 844, height: 390, deviceScaleFactor: 1, mobile: true,
    });
    await page.waitFor('return innerWidth === 844 && innerHeight === 390', 5000, '切到手机横屏尺寸');
    await page.eval('document.getElementById("btnLayout").click(); return true;');
    await page.waitFor('return !document.getElementById("layoutEditor").classList.contains("hidden")', 5000, '手机横屏布局编辑器打开');
    const phoneLayout = await page.evalRaw(`return (() => {
      const rect = (sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
      };
      return {
        map: rect('#minimap'), dash: rect('#dashHud'), score: rect('#scoreBox'),
        steer: rect('#horizonTouch [data-code="KeyA"]'), gas: rect('#horizonTouch [data-code="KeyW"]'),
        top: rect('#horizonTouch .hzone.top'), bar: rect('#layoutBar'), vw: innerWidth, vh: innerHeight,
      };
    })()`);
    assert.ok(phoneLayout.map.left < 30 && phoneLayout.map.top < 30, '小地图在左上角');
    assert.ok(phoneLayout.dash.top > phoneLayout.map.bottom, '仪表盘在小地图下方');
    assert.ok(phoneLayout.dash.bottom < phoneLayout.steer.top, '仪表盘不能压到左转向');
    assert.ok(phoneLayout.gas.left > phoneLayout.dash.right, '右油门不能压到仪表盘');
    assert.ok(phoneLayout.score.top >= phoneLayout.top.bottom - 1, '技能点不能被顶部小按钮盖住');
    assert.ok(phoneLayout.steer.w >= 80 && phoneLayout.gas.w >= 96, '横屏手机上按键也要够大');
    assert.ok(phoneLayout.gas.bottom <= phoneLayout.vh && phoneLayout.steer.bottom <= phoneLayout.vh, '按键不能跑出屏幕');
    assert.ok(phoneLayout.bar.left > phoneLayout.map.right, '布局面板不能盖住左上角小地图');
    assert.ok(phoneLayout.bar.bottom < phoneLayout.steer.top, '布局面板不能盖住左下转向');
    assert.ok(phoneLayout.bar.bottom < phoneLayout.gas.top, '布局面板不能盖住右下油门');

    const panel = await page.evalRaw(`return (() => {
      document.getElementById('layCollapse').click();
      const collapsed = {
        bar: document.getElementById('layoutBar').classList.contains('hidden'),
        reopen: document.getElementById('layReopen').classList.contains('hidden'),
      };
      document.getElementById('layReopen').click();
      return {
        collapsed,
        reopenedBar: !document.getElementById('layoutBar').classList.contains('hidden'),
        reopenedPill: document.getElementById('layReopen').classList.contains('hidden'),
      };
    })()`);
    assert.equal(panel.collapsed.bar, true, '收起面板后编辑条应隐藏');
    assert.equal(panel.collapsed.reopen, false, '收起面板后应出现"布局面板"按钮');
    assert.equal(panel.reopenedBar, true, '点"布局面板"应重新打开编辑条');
    assert.equal(panel.reopenedPill, true, '重新打开后按钮应隐藏');
    await page.eval('document.getElementById("layDone").click(); return true;');
    await page.conn.send('Emulation.setDeviceMetricsOverride', {
      width: 1100, height: 720, deviceScaleFactor: 1, mobile: false,
    });
    await page.waitFor('return innerWidth === 1100 && innerHeight === 720', 5000, '恢复桌面尺寸');

    // 刷新后布局必须还在：存 localStorage → 重新加载 → 启动时自动 apply。
    await page.evalRaw(`(() => {
      const key = 'frp.horizon.layout.v1';
      const cfg = JSON.parse(localStorage.getItem(key));
      cfg.map.x = 30;
      cfg.map.s = 1.2;
      localStorage.setItem(key, JSON.stringify(cfg));
      return true;
    })()`);
    const reloaded = new URL('/games/horizon/', base);
    reloaded.searchParams.set('touch', '1');
    reloaded.searchParams.set('layouttest', String(Date.now()));
    await page.goto(reloaded.toString());
    await page.waitFor('return location.search.includes("layouttest=")', 15_000, '刷新后的新页面');
    await page.waitFor('return window.__stage === "input"', 120_000, '刷新后游戏菜单');
    await page.waitFor('return Boolean(window.__FrpHorizon)', 10_000, '刷新后平台接线');
    await page.eval('document.getElementById("btnLayout").click(); return true;');
    await page.waitFor('return !document.getElementById("layoutEditor").classList.contains("hidden")', 5000, '刷新后打开布局');
    const persisted = await page.evalRaw(`return (() => {
      const r = document.getElementById('minimap').getBoundingClientRect();
      return {
        left: r.left, w: r.width,
        stateX: window.__FrpHorizon.state.layout.map.x,
        stateS: window.__FrpHorizon.state.layout.map.s,
      };
    })()`);
    assert.ok(Math.abs(persisted.left - 44) < 2, `刷新后小地图应保留自定义位置，实际 ${persisted.left}`);
    assert.ok(Math.abs(persisted.w - 124.8) < 3, `刷新后小地图应保留自定义大小，实际 ${persisted.w}`);
    assert.equal(persisted.stateX, 30);
    assert.ok(Math.abs(persisted.stateS - 1.2) < 0.001);

    // 平台首页卡片必须在，且不是"离线"状态。
    await page.goto(base);
    await page.waitFor('return document.getElementById("screen-app").classList.contains("is-active")', 15_000, '首页');
    const card = await page.evalRaw(`return (() => {
      const card = [...document.querySelectorAll('.game-card')]
        .find((c) => (c.textContent || '').includes('地平线赛车'));
      return card ? { offline: card.classList.contains('is-offline'), text: card.textContent } : null;
    })()`);
    assert.ok(card, '首页应有地平线赛车卡片');
    assert.equal(card.offline, false);
    assert.match(card.text, /2–8 人|2-8 人/);

    assert.deepEqual(page.errors, [], '游戏页不应有控制台错误');
    page.close();
    const hostCookie = hostUser.cookie;

    // 手机伪横屏外壳：粗指针 + 竖屏时，iframe 必须被横过来，?join= 必须传进去。
    mobile = await Page.launch({
      headless: true,
      width: 390,
      height: 844,
      mobile: true,
      startUrl: 'about:blank',
      extraArgs: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
    });
    await setCookie(mobile, hostCookie, base);
    await mobile.conn.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    assert.equal(await mobile.eval("return matchMedia('(pointer: coarse)').matches"), true);
    await mobile.goto(new URL('/play/horizon?join=' + code, base).toString());
    const shell = await mobile.evalRaw(`return (() => {
      const rot = document.getElementById('rot');
      const game = document.getElementById('game');
      const rr = rot.getBoundingClientRect();
      return {
        transform: rot.style.transform,
        src: game.src,
        rotW: Math.round(rr.width),
        rotH: Math.round(rr.height),
        gameW: game.style.width,
        gameH: game.style.height,
      };
    })()`);
    assert.match(shell.transform, /rotate\(90deg\)/, '竖屏手机应把 iframe 旋转 90°');
    assert.equal(shell.rotW, 390);
    assert.equal(shell.rotH, 844);
    assert.match(shell.src, /\/games\/horizon\//);
    assert.match(shell.src, new RegExp('join=' + code));
    assert.ok(parseInt(shell.gameW, 10) > parseInt(shell.gameH, 10), 'iframe 内部应是横屏尺寸');

    // 桌面（没有触摸）不能被手机布局连带改掉：表盘仍在右下，布局按钮不出现。
    desktop = await Page.launch({
      headless: true,
      width: 1100,
      height: 720,
      startUrl: 'about:blank',
      extraArgs: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
    });
    await setCookie(desktop, hostCookie, base);
    await desktop.goto(new URL('/games/horizon/', base).toString());
    await desktop.waitFor('return window.__stage === "input"', 120_000, '桌面游戏菜单');
    await desktop.waitFor('return Boolean(window.__FrpHorizon)', 10_000, '桌面平台接线');
    await desktop.eval('document.getElementById("hud").classList.remove("hidden"); return true;');
    const desk = await desktop.evalRaw(`return (() => {
      const rect = (sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
      };
      return {
        touch: window.__FrpHorizon.state.touch,
        layoutBtnDisplay: getComputedStyle(document.getElementById('btnLayout')).display,
        map: rect('#minimap'), gauge: rect('#gauge'), score: rect('#scoreBox'),
        vw: innerWidth, vh: innerHeight,
      };
    })()`);
    assert.equal(desk.touch, false, '桌面不应启用手机触屏布局');
    assert.equal(desk.layoutBtnDisplay, 'none', '桌面不显示手机界面布局按钮');
    assert.ok(Math.abs(desk.map.left - 18) < 2 && Math.abs(desk.map.w - 216) < 2, '桌面小地图保持左下 216px');
    assert.ok(Math.abs(desk.gauge.right - (desk.vw - 22)) < 2 && Math.abs(desk.gauge.w - 210) < 2, '桌面表盘保持右下 210px');
    assert.ok(Math.abs(desk.score.top - 20) < 2 && Math.abs(desk.score.right - (desk.vw - 26)) < 2, '桌面技能点保持右上');
    assert.deepEqual(desktop.errors, [], '桌面游戏页不应有控制台错误');
    desktop.close();

    console.log('✔ 地平线赛车浏览器联机 / 碰撞 / 结算 / 手机外壳 全部通过');
  } finally {
    try { peerRelay?.close(); } catch { /* ignore */ }
    try { peerWs?.close(); } catch { /* ignore */ }
    try { mobile?.close(); } catch { /* ignore */ }
    try { desktop?.close(); } catch { /* ignore */ }
    try { page.close(); } catch { /* ignore */ }
    if (app) await app.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});