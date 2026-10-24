/*
 * 全屏按钮的真浏览器验收。
 *
 * 为什么单开一条：这是平台级共用 UI（shared/ui/fullscreen.js），
 * 涉及浏览器 Fullscreen API、手机/电脑判定、iframe 跳过、各游戏入口是否都引入了脚本，
 * 单测只能证明文件在、证明不了按钮真的能进/能退。
 *
 * 用户明确要求：**只在手机端显示按钮，电脑端不要加**。
 *
 * 覆盖：
 *   · 电脑端（细指针）：平台游戏、斗地主、狼人杀、无名杀都不出现按钮；
 *   · 手机端（粗指针）：平台三款、斗地主、狼人杀、无名杀入口都有按钮；
 *   · 页面加载时**不自动进全屏**（"不能强制"）；
 *   · 点一下真的进 fullscreen，再点一下真的退出；
 *   · 手机伪横屏外壳 `/play/noname`、`/play/ddz`、`/play/monopoly` 也有按钮，且内层 iframe 不重复。
 *
 * 用临时端口 + 临时数据库，不碰 7891。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/server.mjs';
import { Page } from '../tools/cdp.mjs';

const GAME_PAGES = [
  ['/games/blade-steed/', '刀马'],
  ['/games/cannon-goblin/', '大炮轰小鬼'],
  ['/games/shell-gambit/', 'Shell Gambit'],
  ['/ddz/', '斗地主'],
  ['/werewolf/', '狼人杀'],
  ['/noname/', '无名杀'],
];

const WRAPPER_PAGES = [
  ['/play/noname', '无名杀手机外壳'],
  ['/play/ddz', '斗地主手机外壳'],
  ['/play/monopoly', '大富翁手机外壳'],
  ['/play/mahjong', '莲花广麻手机外壳'],
];

const DESKTOP_NO_BUTTON = [
  ['/games/blade-steed/', '刀马（电脑端）'],
  ['/ddz/', '斗地主（电脑端）'],
  ['/werewolf/', '狼人杀（电脑端·服务端注入）'],
];

const dir = mkdtempSync(join(tmpdir(), 'frp-fullscreen-test-'));
let app;
let page;
let base;

async function register() {
  await page.goto(app.url);
  await page.evalRaw(`(async () => {
    const r = await fetch('/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '全屏测试', password: 'secret123' }),
    });
    if (!r.ok) throw new Error('注册失败 ' + r.status);
    return true;
  })()`);
}

async function waitForButton(label) {
  await page.waitFor(
    'return !!document.querySelector("#frp-fullscreen-btn")',
    20000,
    `${label} 的全屏按钮`
  );
  const info = await page.eval(`return {
    supported: window.FrpFullscreen ? window.FrpFullscreen.supported : null,
    active: !!document.fullscreenElement,
    text: document.querySelector('#frp-fullscreen-btn').textContent,
  }`);
  assert.equal(info.supported, true, `${label}：手机端全屏 API 应该是可用的`);
  assert.equal(info.active, false, `${label}：页面加载时不允许自动进全屏`);
  assert.match(info.text, /全屏/, `${label}：按钮文案不对`);
}

async function assertNoButton(label) {
  await page.waitFor(
    'return !!window.FrpFullscreen',
    10000,
    `${label}：fullscreen.js 应已加载`
  );
  const info = await page.eval(`return {
    button: !!document.querySelector('#frp-fullscreen-btn'),
    supported: window.FrpFullscreen ? window.FrpFullscreen.supported : null,
    reason: window.FrpFullscreen ? window.FrpFullscreen.reason : null,
    active: !!document.fullscreenElement,
  }`);
  assert.equal(info.button, false, `${label}：电脑端不允许出现全屏按钮`);
  assert.equal(info.supported, false, `${label}：电脑端应标记为不提供按钮`);
  assert.equal(info.reason, 'desktop', `${label}：电脑端的跳过原因应为 desktop`);
  assert.equal(info.active, false, `${label}：电脑端更不应该自动进全屏`);
}

try {
  app = await startServer({
    port: 0,
    dbPath: join(dir, 'test.db'),
    statePath: join(dir, 'state.json'),
  });
  page = await Page.launch({
    headless: true,
    width: 1280,
    height: 900,
    startUrl: app.url,
  });
  base = app.url.replace(/\/$/, '');
  await register();

  // 电脑端：不要按钮（含入口直引和服务端注入两种）。
  for (const [path, label] of DESKTOP_NO_BUTTON) {
    await page.goto(base + path);
    await assertNoButton(label);
  }

  // 手机端：粗指针 + 小屏，所有游戏入口都应该有按钮。
  await page.conn.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 5,
  });
  await page.setViewport(390, 844, true);

  for (const [path, label] of GAME_PAGES) {
    await page.goto(base + path);
    await waitForButton(label);
  }

  // 真进 / 真退：只在最轻的刀马页上点（不加载 3D/牌桌/大富翁音频）。
  await page.goto(base + '/games/blade-steed/');
  await waitForButton('刀马（手机端）');
  await page.click('#frp-fullscreen-btn');
  await page.waitFor('return !!document.fullscreenElement', 5000, '进入全屏');
  // 2026-11 用户要求：全屏时**按钮整个消失**（手机上用系统返回键退出）
  await page.waitFor(
    'return getComputedStyle(document.querySelector("#frp-fullscreen-btn")).display === "none"',
    3000,
    '全屏时按钮藏起来'
  );
  // 模拟手机返回键：直接调 exitFullscreen（桌面用例没法真按返回键）
  await page.evalRaw('document.exitFullscreen()');
  await page.waitFor('return !document.fullscreenElement', 5000, '退出全屏');
  await page.waitFor(
    'return getComputedStyle(document.querySelector("#frp-fullscreen-btn")).display !== "none"',
    3000,
    '退出全屏后按钮回来'
  );

  /*
   * 手机外壳：粗指针下外壳才会保留；内层 iframe 里的 fullscreen.js 会因
   * window.self !== window.top 直接退出，所以外壳页面上应该只有一个按钮。
   *
   * 2026-11 起四个伪横屏外壳都标了 `data-frp-fullscreen="landscape"`：
   * 点全屏要像大富翁一样锁成真横屏。
   */
  for (const [path, label] of WRAPPER_PAGES) {
    await page.goto(base + path);
    await page.waitFor(
      'return !!document.querySelector("#frp-fullscreen-btn")',
      20000,
      `${label} 的全屏按钮`
    );
    const info = await page.eval(`return {
      active: !!document.fullscreenElement,
      buttons: document.querySelectorAll('#frp-fullscreen-btn').length,
      frame: !!document.querySelector('iframe'),
      landscape: document.body.getAttribute('data-frp-fullscreen'),
      supportedLandscape: window.FrpFullscreen ? window.FrpFullscreen.landscape : null,
    }`);
    assert.equal(info.active, false, `${label}：外壳加载时不允许自动进全屏`);
    assert.equal(info.buttons, 1, `${label}：外壳只应该有一个全屏按钮`);
    assert.equal(info.frame, true, `${label}：应该是 iframe 伪横屏外壳`);
    assert.equal(info.landscape, 'landscape', `${label}：外壳应声明 data-frp-fullscreen="landscape"`);
    assert.equal(info.supportedLandscape, true, `${label}：FrpFullscreen.landscape 应为 true`);
  }

  /*
   * 伪横屏外壳点全屏 → 真的调 screen.orientation.lock('landscape')。
   * 无头 Chrome 没有真实方向锁，这里把 lock/unlock 换成可观测的桩。
   */
  await page.goto(base + '/play/noname');
  await page.waitFor('return !!document.querySelector("#frp-fullscreen-btn")', 20000, '无名杀外壳按钮');
  const stubbed = await page.evalRaw(`(() => {
    const so = window.screen && window.screen.orientation;
    if (!so) return false;
    window.__frpOrient = { locked: [], unlocked: 0 };
    try {
      Object.defineProperty(so, 'lock', {
        configurable: true,
        value: (value) => { window.__frpOrient.locked.push(value); return Promise.resolve(); },
      });
      Object.defineProperty(so, 'unlock', {
        configurable: true,
        value: () => { window.__frpOrient.unlocked += 1; },
      });
      return true;
    } catch (err) {
      return false;
    }
  })()`);
  if (stubbed) {
    await page.click('#frp-fullscreen-btn');
    await page.waitFor('return !!document.fullscreenElement', 5000, '外壳进入全屏');
    await page.waitFor(
      'return window.__frpOrient.locked.includes("landscape")',
      3000,
      '外壳全屏时锁成横屏'
    );
    await page.evalRaw('document.exitFullscreen()');
    await page.waitFor('return !document.fullscreenElement', 5000, '外壳退出全屏');
    await page.waitFor('return window.__frpOrient.unlocked > 0', 3000, '退出全屏时解锁方向');
    console.log('  · 伪横屏外壳点全屏 → 锁横屏、退出解锁');
  }

  console.log('✔ 全屏按钮只在手机端：电脑端不显示；手机端所有游戏都有；默认不进；全屏时按钮消失；外壳锁真横屏且不重复');
} finally {
  if (page) await page.close();
  if (app) await app.close();
  rmSync(dir, { recursive: true, force: true });
}

