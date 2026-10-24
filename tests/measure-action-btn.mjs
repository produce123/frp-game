/*
 * 实测：大炮轰小鬼「房间准备区」里那个 .action-btn（「编辑初始位置」）的真实高度，
 * 以及平台首页那颗「正在连接服务器…」在窄屏下会不会撑破布局。
 *
 *   node tests/measure-action-btn.mjs      （真 Chrome + 临时服务器，随机端口）
 *
 * 背景：平台硬指标是**真实点击目标 ≥44px**，而这个按钮实测只有 42px
 * （padding 10px×2 + 0.95rem 的 normal 行盒 22px，min-height 原来是 0）。
 * `.action-btn` 在 css/style.css 里加了 min-height: 44px 之后由这条脚本盯着。
 *
 * ⚠️ tools/check-game.mjs 那条体检用的是 `height < 44 && width < 44`（AND），
 *    这个按钮宽度撑满一行（326px），所以它**漏得过去** —— 这就是它一直没被发现的原因。
 *    这条脚本按平台口径（只看高度）量，别退回 AND。
 * ⚠️ 量之前必须先把一次性入场动画 finish() 掉，否则量到的是被 transform 缩过的值
 *    （44px 会偶发量成 43.99，见 docs/GAME-SPEC.md）。
 * ⚠️ 服务器一律 listen(0) 随机端口，不碰本机 7891 上正在跑的服务。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/server.mjs';
import { Page, findChrome } from '../tools/cdp.mjs';

const WIDTHS = [430, 360];

async function register(page, base, name) {
  await page.goto(base);
  await page.waitFor(
    `return document.getElementById('screen-auth').classList.contains('is-active')`,
    15_000,
    '登录页出现'
  );
  await page.click('#tab-register');
  await page.setInput('#register-name', name);
  await page.setInput('#register-password', 'secret123');
  await page.setInput('#register-password2', 'secret123');
  await page.click('#form-register .btn-primary');
  await page.waitFor(`return !document.getElementById('modal-id').hidden`, 15_000, 'ID 弹窗出现');
  await page.click('#btn-id-done');
  await page.waitFor(`return window.GameNet && window.GameNet.connected === true`, 15_000, '连接就绪');
}

/* 量尺寸前先把一次性入场动画推到终点（否则量到的是被 transform 缩过的值，见 docs/GAME-SPEC.md 第 467 行）
   ⚠️ page.eval 会把表达式包成同步箭头函数，所以这里不能出现 await。 */
const FINISH = `
  return document.getAnimations()
    .filter(function (a) {
      return a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations !== Infinity;
    })
    .map(function (a) { try { a.finish(); } catch (e) { return String(e); } return 'ok'; })
`;

const MEASURE = `
  return Array.prototype.map.call(
    document.querySelectorAll('#online-panel button.action-btn'),
    function (el) {
      var r = el.getBoundingClientRect();
      return {
        text: el.textContent.trim(),
        h: Math.round(r.height * 100) / 100,
        w: Math.round(r.width * 100) / 100,
        minH: getComputedStyle(el).minHeight,
        pad: getComputedStyle(el).padding,
        font: getComputedStyle(el).fontSize,
        line: getComputedStyle(el).lineHeight,
      };
    }
  )
`;

async function main() {
  if (!findChrome()) {
    console.log('⚠️  本机没找到 Chrome / Edge');
    return;
  }
  const tmpDir = mkdtempSync(join(tmpdir(), 'frp-measure-'));
  const app = await startServer({ port: 0, dbPath: join(tmpDir, 'm.db'), statePath: join(tmpDir, 's.json') });
  const base = String(app.url).replace(/\/+$/, '');
  let page = null;
  try {
    page = await Page.launch({ headless: true, width: 430, height: 932, mobile: true });
    await register(page, base, '测');

    /* ---- 顺带体检：那颗「正在连接服务器…」在 360px 下会不会撑破布局 ----
       ⚠️ 它现在住在平台首页的**「设置」栏**里（原来在顶栏），所以要先切到那一栏；
          而且它**只在没连上的时候出现**，测量前得先把整行和它自己都显示出来，
          否则量到的是 0×0 的假数字（那种"看起来过了"的假绿最难查）。 */
    await page.click('#tab-settings');
    await page.waitFor(
      `var p = document.getElementById('panel-settings');
       return !!p && p.classList.contains('is-active') && p.getBoundingClientRect().height > 0`,
      5_000,
      '切到「设置」栏'
    );
    for (const w of [430, 360]) {
      await page.setViewport(w, 932, true);
      const r = await page.eval(`
        var el = document.getElementById('conn-status');
        if (!el) return { missing: true };
        var row = document.getElementById('row-conn');
        if (row) row.style.display = '';
        el.style.display = '';
        var rect = el.getBoundingClientRect();
        return {
          missing: false,
          text: el.textContent,
          h: Math.round(rect.height * 100) / 100,
          w: Math.round(rect.width * 100) / 100,
          right: Math.round(rect.right * 100) / 100,
          vw: window.innerWidth,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      `);
      console.log(`连接状态条 @${w}px：`, JSON.stringify(r));
      assert.equal(r.missing, false, '没建出 #conn-status');
      assert.ok(r.h >= 44, `连接状态条只有 ${r.h}px 高（可点/可读的状态条也要 ≥44px）`);
      assert.ok(r.overflow <= 1, `${w}px 下连接状态条把布局撑出了 ${r.overflow}px`);
      assert.ok(r.right <= r.vw + 1, `连接状态条跑出屏幕了：right=${r.right} vw=${r.vw}`);
    }
    await page.setViewport(430, 932, true);

    await page.goto(`${base}/games/cannon-goblin/`);
    await page.waitFor(`return !!document.querySelector('.screen.is-active')`, 15_000, '游戏页面出现');
    await page.eval(`return (function () { window.enterOnline(); return true; })()`);
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-idle')`, 10_000, '房间入口出现');
    await page.eval(`
      return (function () {
        var btn = document.querySelector('#online-panel .frp-room-idle .frp-btn-primary');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    await page.waitFor(`return !!document.querySelector('#online-panel button.action-btn')`, 10_000, '准备区出现');

    for (const w of WIDTHS) {
      await page.setViewport(w, 932, true);
      await page.eval(FINISH);
      await new Promise((r) => setTimeout(r, 400));
      await page.eval(FINISH);
      await new Promise((r) => setTimeout(r, 400));
      const rows = await page.eval(MEASURE);
      console.log(`\n=== 视口 ${w}px ===`);
      for (const r of rows) {
        console.log(
          `「${r.text}」 高 ${r.h}px 宽 ${r.w}px  min-height=${r.minH} padding=${r.pad} font=${r.font} line=${r.line}`
        );
        assert.ok(r.h >= 44, `「${r.text}」在 ${w}px 下只有 ${r.h}px，没到 44`);
      }
      // 顺带做一次界面体检：横向溢出
      const overflow = await page.eval(`return document.documentElement.scrollWidth - window.innerWidth`);
      console.log(`横向溢出：${overflow}px`);
      assert.ok(overflow <= 1, `${w}px 下横向溢出 ${overflow}px`);
    }
    console.log('\n✅ 所有 .action-btn 都 ≥44px');
  } finally {
    if (page) page.close();
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\n❌ 实测失败：');
  console.error((err && err.stack) || err);
  process.exitCode = 1;
});