/**
 * 刀马 BladeSteed — 小屏尺寸实测（手机端的地图 / 头像到底多大）
 *
 * 【为什么要单独一条】
 * 用户在手机上报过「刀马这个游戏的地图和头像太小了（部分小屏机型）」。
 * 这件事**只能实测**：地图是 SVG，会被缩放到容器里（`preserveAspectRatio="xMidYMid meet"`），
 * 所以「用户坐标里的半径」和「手机上真实多少像素」之间隔着一个缩放系数 ——
 * 设计稿上看起来够大，360px 的机器上可能只有 20px。
 *
 * 这条用例把四个常见手机视口的地图 / 头像 / 最小可点目标量出来并打印成一张表，
 * 改造前 vs 改造后的数字都留在这份文件的历史里（AGENTS.md 第 11 条有一份快照）。
 * **以后改布局、改 viewBox、改 HIT_R 都要重跑它** —— 光"看起来够大"不算数。
 *
 * 跑法：node games/blade-steed/tests/browser.size.mjs
 *      （名字是 `browser*.mjs`：平台体检 `tools/check-game.mjs <slug> --browser`
 *        会带起本目录下的浏览器用例；不带 --browser 的机械体检不会碰它。）
 *
 * 硬指标（和 docs/GAME-SPEC.md 一致，任一不过就退出码 1）：
 *   · 横向不溢出（scrollWidth 不超过视口宽）
 *   · 没有任何可点元素跑出屏幕左右边界
 *   · 任何可点目标**任一边 ≥44px**（含地图头像那圈透明热区）
 *   · 地图真的画出来了（token / 城 / 野外都在）
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../../../server/server.mjs';
import { Page, findChrome } from '../../../tools/cdp.mjs';

/** 用户点名的四个视口（前两个必报数，后两个一起量出来） */
const VIEWPORTS = [
  { w: 360, h: 640, label: '360x640' },
  { w: 375, h: 667, label: '375x667' },
  { w: 390, h: 844, label: '390x844' },
  { w: 430, h: 932, label: '430x932' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等演出排空再点。
 *
 * ⚠️ 演出期间（`FrpAnim.busy()` 为真）游戏会把所有动作点击**当成没点**
 * （用户第 2 条要求，见 docs/DECISIONS.md D10）—— 用例里不等就点，
 * 点了个空，后面会以"牌桌没反应"的形式失败，很难查。
 */
async function clickIdle(page, selector, timeoutMs = 15000) {
  await page.waitFor(
    `return !(window.FrpAnim && typeof window.FrpAnim.busy === 'function' && window.FrpAnim.busy())`,
    timeoutMs,
    `等演出演完（好点 ${selector}）`
  );
  await page.click(selector);
}

/**
 * 量一次：地图容器 / 头像直径 / 最小可点目标 / 溢出。
 *
 * @param {Page} page
 * @param {string} scopeSel 牌桌容器的选择器（`#local-board` 或 `#online-panel .online-board`）
 */
async function measure(page, scopeSel) {
  const r = await page.evalRaw(`(async () => {
    /*
     * 量之前先把一次性动画推到终点：平台的房间面板 / 牌桌有缩放、上滑入场动画，
     * 动画途中 getBoundingClientRect() 拿到的是被 transform 缩过的值
     * （实测 44px 的元素量出来 43.99，会偶发误报）。无限循环的动画不动它。
     */
    var still = function () {
      return document.getAnimations().filter(function (a) {
        return a.playState === 'running' && a.effect &&
          a.effect.getComputedTiming().iterations !== Infinity;
      });
    };
    var t0 = Date.now();
    while (still().length && Date.now() - t0 < 800) {
      still().forEach(function (a) { try { a.finish(); } catch (e) { /* 推不动的等它跑完 */ } });
      await new Promise(function (res) { requestAnimationFrame(res); });
    }

    var scope = document.querySelector(${JSON.stringify(scopeSel)});
    if (!scope) return null;
    var rect = function (el) {
      var b = el.getBoundingClientRect();
      return { w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 };
    };
    var name = function (el) {
      var cls = el.getAttribute ? (el.getAttribute('class') || '') : '';
      return cls || el.id || el.tagName;
    };

    var map = scope.querySelector('.map-wrap');
    var faces = Array.prototype.map.call(scope.querySelectorAll('.tok-face'), rect);
    var hits = Array.prototype.map.call(scope.querySelectorAll('.tok-hit'), rect);

    /*
     * 几何自检一：**头像热区不许被 SVG 视口裁掉**。
     * 地图是 SVG，超出 viewBox 的部分会被裁（看得见摸不着，甚至完全看不见）——
     * 而 getBoundingClientRect() 拿到的是**几何 bbox**，被裁了也一样大，
     * 所以要拿"viewBox 实际画出来的那个矩形"（preserveAspectRatio=meet 的 letterbox 结果）
     * 去比，不能只跟 .map-wrap 比。
     */
    var clipped = [];
    var svg = scope.querySelector('svg');
    if (svg) {
      var sr = svg.getBoundingClientRect();
      var vb = (svg.getAttribute('viewBox') || '0 0 1 1').trim().split(/[\s,]+/).map(Number);
      var sc = Math.min(sr.width / vb[2], sr.height / vb[3]);
      var draw = {
        left: sr.left + (sr.width - vb[2] * sc) / 2,
        top: sr.top + (sr.height - vb[3] * sc) / 2,
        right: sr.left + (sr.width + vb[2] * sc) / 2,
        bottom: sr.top + (sr.height + vb[3] * sc) / 2,
      };
      Array.prototype.forEach.call(scope.querySelectorAll('.tok-hit'), function (el, i) {
        var b = el.getBoundingClientRect();
        if (b.left < draw.left - 1 || b.right > draw.right + 1 || b.top < draw.top - 1 || b.bottom > draw.bottom + 1) {
          clipped.push({
            i: i,
            pid: el.getAttribute('data-pid'),
            box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
            draw: [Math.round(draw.left), Math.round(draw.top), Math.round(draw.right - draw.left), Math.round(draw.bottom - draw.top)],
          });
        }
      });
    }

    /* 几何自检二：城与城不许叠在一起（改 dist / cityR 的时候立刻能发现） */
    var cities = Array.prototype.map.call(scope.querySelectorAll('.city-ring'), function (c) {
      return { x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')), r: Number(c.getAttribute('r')) };
    });
    var overlap = [];
    for (var i = 0; i < cities.length; i++) {
      for (var j = i + 1; j < cities.length; j++) {
        var dx = cities[i].x - cities[j].x;
        var dy = cities[i].y - cities[j].y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < cities[i].r + cities[j].r) overlap.push([i, j, Math.round(dist)]);
      }
    }

    /* 最小可点目标：和平台体检 tools/check-game.mjs 用同一套选择器与判据 */
    var screen = document.querySelector('.screen.is-active') || document.body;
    var SEL = 'button, [onclick], input, a, [data-frp-avatar]';
    var min = null;
    var off = [];
    var vw = window.innerWidth;
    Array.prototype.forEach.call(screen.querySelectorAll(SEL), function (el) {
      var target = el;
      if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        target = el.closest('label') || el.parentElement || el;
      }
      if (el.hasAttribute('data-frp-avatar')) {
        /*
         * 地图上的头像：**真正接指针事件的是里面那个透明热区**
         * （map.js 里那个 class 为 tok-hit 的 circle，见 browser.e2e.mjs 的 avatarHotzones）。
         * 外层的 g 的 bbox 还含血条 / 装备字，而且它的父节点是整层 token ——
         * 那些都不代表"手指能点到的区域"，所以这里优先量热区。
         * （比平台体检更严：体检在头像这层取"自己与父层里更大的那个"，会量到整层。）
         */
        var hitEl = el.querySelector('.tok-hit');
        if (hitEl) {
          target = hitEl;
        } else if (el.parentElement) {
          var wrap = el.parentElement.getBoundingClientRect();
          var own = el.getBoundingClientRect();
          if (wrap.width > own.width || wrap.height > own.height) target = el.parentElement;
        }
      }
      var b = target.getBoundingClientRect();
      if (b.width < 1 && b.height < 1) return;
      var side = Math.min(b.width, b.height);
      if (!min || side < min.side) {
        min = { side: Math.round(side * 10) / 10, what: name(el), w: Math.round(b.width), h: Math.round(b.height) };
      }
      var e = el.getBoundingClientRect();
      if (e.width < 1 || e.height < 1) return;
      if (e.left < -1 || e.right > vw + 1) off.push(name(el));
    });

    return {
      map: map ? rect(map) : null,
      tokens: faces.length,
      cities: scope.querySelectorAll('.city-ring').length,
      wild: scope.querySelectorAll('.wild-ring').length,
      face: faces.length ? Math.round(Math.max.apply(null, faces.map(function (f) { return f.w; })) * 10) / 10 : null,
      hit: hits.length ? Math.round(Math.max.apply(null, hits.map(function (h) { return h.w; })) * 10) / 10 : null,
      min: min,
      overflow: Math.max(0, document.documentElement.scrollWidth - vw),
      off: off,
      clipped: clipped,
      overlap: overlap,
    };
  })()`);
  assert.ok(r, `量不到牌桌容器：${scopeSel}`);
  return r;
}

/** 打印一行表 + 硬指标检查 */
function report(mode, vp, m) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `  ${pad(vp.label, 9)}| ${pad(mode, 18)}| 地图 ${pad(m.map.w + 'x' + m.map.h, 10)}| ` +
      `头像直径 ${pad(m.face + 'px', 8)}| 热区直径 ${pad(m.hit + 'px', 8)}| ` +
      `最小可点 ${pad(m.min.side + 'px', 8)}(${m.min.w}x${m.min.h} ${m.min.what})`
  );
  assert.ok(m.tokens >= 2, `${mode} ${vp.label}：地图上应该至少有 2 个头像，实际 ${m.tokens}`);
  assert.equal(m.wild, 1, `${mode} ${vp.label}：野外应该只有 1 片，实际 ${m.wild}`);
  assert.equal(m.overflow <= 1, true, `${mode} ${vp.label}：横向溢出 ${m.overflow}px`);
  assert.equal(m.off.length, 0, `${mode} ${vp.label}：有元素跑出屏幕：${m.off.join('、')}`);
  assert.ok(
    m.min.side >= 44,
    `${mode} ${vp.label}：最小可点目标只有 ${m.min.side}px（${m.min.w}x${m.min.h} ${m.min.what}），必须 ≥44px`
  );
  assert.equal(
    m.clipped.length,
    0,
    `${mode} ${vp.label}：这些头像热区被 SVG 视口裁了（看得见摸不着）：${JSON.stringify(m.clipped)}`
  );
  assert.equal(m.overlap.length, 0, `${mode} ${vp.label}：城与城叠在一起了：${JSON.stringify(m.overlap)}`);
  return m;
}

async function main() {
  if (!findChrome()) {
    console.log('本机没找到 Chrome / Edge，跳过小屏尺寸实测');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'blade-steed-size-'));
  const app = await startServer({ port: 0, dbPath: join(tmpDir, 'size.db') });
  let page = null;
  /** 改造前 / 改造后的数字都收在这张表里（报告要用） */
  const table = [];

  try {
    page = await Page.launch({ headless: true, width: 430, height: 932, mobile: true });
    await page.goto(app.url);
    await page.waitFor(`return document.getElementById('screen-auth').classList.contains('is-active')`, 10000, '平台登录页');
    await page.click('#tab-register');
    await page.setInput('#register-name', '尺');
    await page.setInput('#register-password', 'size-pass-1234');
    await page.setInput('#register-password2', 'size-pass-1234');
    await page.click('#form-register .btn-primary');
    await page.waitFor(`return !document.getElementById('modal-id').hidden`, 10000, '注册成功');
    await page.click('#btn-id-done');
    await page.waitFor(`return document.getElementById('screen-app').classList.contains('is-active')`, 10000, '平台主界面');

    const base = String(app.url).replace(/\/+$/, '');
    await page.goto(`${base}/games/blade-steed/`);
    await page.waitFor(`return !!document.querySelector('#screen-home.is-active .logo')`, 10000, '游戏首页');

    /* ---------- 单机牌桌（默认 4 人局） ---------- */
    console.log('\n== 单机牌桌（4 人局，整屏）= 地图宽x高 / 头像直径 / 最小可点目标');
    await page.click('#btn-go-local');
    await page.waitFor(`return document.getElementById('screen-local').classList.contains('is-active')`, 5000, '人机设置页');
    await page.click('#btn-local-start');
    await page.waitFor(`return document.querySelectorAll('#local-board .rps-btn').length === 3`, 10000, '单机牌桌出现');
    for (const vp of VIEWPORTS) {
      await page.setViewport(vp.w, vp.h, true);
      await sleep(350);
      const m = report('单机', vp, await measure(page, '#local-board'));
      table.push({ mode: '单机4人', vp: vp.label, ...m });
    }

    /* ---------- 联机牌桌（1 人 + 1 个人机 = 2 人局） ---------- */
    /*
     * ⚠️ 必须**真的走界面**回首页再进在线页：
     *  `#btn-go-online` 住在 `#screen-home` 里，而单机牌桌在的时候首页是 display:none
     *  —— cdp 的 click() 在"没有可见元素"时会退化成点那个隐藏元素（坐标是 0,0），
     *  点了等于没点，然后一直卡在"等房间界面"（这一版踩过）。
     *  正确做法和 browser.e2e.mjs 一样：对局菜单 → 离开 → 首页 → 在线。
     */
    console.log('\n== 联机牌桌（1 人 + 1 个人机座位，住在房间外壳里）');
    await page.setViewport(430, 932, true);
    await sleep(200);
    await page.click('#local-board .icon-btn.menu');
    await page.waitFor(`return !document.getElementById('board-menu').hidden`, 5000, '对局菜单打开');
    await page.click('#menu-leave');
    await page.waitFor(`return document.getElementById('screen-home').classList.contains('is-active')`, 5000, '回首页');
    await page.click('#btn-go-online');
    await page.waitFor(`return document.getElementById('screen-online').classList.contains('is-active')`, 5000, '在线页');
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-idle')`, 8000, '房间入口');
    await page.click('#online-panel .frp-room-idle .frp-btn-primary');
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-waiting')`, 10000, '房间等待界面');
    await page.click('#online-panel .frp-room-bot-add');
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-member.is-bot')`, 8000, '人机座位出现');
    await page.click('#online-panel .frp-room-actions .frp-btn-primary');
    await page.waitFor(`return !!document.querySelector('#online-panel .online-board .rps-btn')`, 10000, '联机牌桌出现');
    for (const vp of VIEWPORTS) {
      await page.setViewport(vp.w, vp.h, true);
      await sleep(350);
      const m = report('联机', vp, await measure(page, '#online-panel .online-board'));
      table.push({ mode: '联机2人', vp: vp.label, ...m });
    }

    /* ---------------------------------------------------------------
     * 最紧的一档：**轮到我行动**（行动面板最高 → 地图被挤到最矮）
     *
     * 地图的高度在猜拳阶段最大、行动阶段最小，而头像直径跟着地图缩放走 ——
     * 所以"猜拳阶段过了 44px"不等于"行动阶段也过"。这一档必须单独量一次。
     * 反复真点出拳直到轮到我：每回合**换一手**（石头→剪刀→布），
     * 总出同一手的话 AI 会读出手习惯、每回合都赢（browser.e2e.mjs 踩过这个坑）。
     * ------------------------------------------------------------- */
    console.log('\n== 联机牌桌·轮到我行动（地图最矮的一档，360x640）');
    await page.setViewport(360, 640, true);
    await sleep(350);
    const HANDS = ['rock', 'scissors', 'paper'];
    const phaseOf = () =>
      page.evalRaw(`(() => {
        const b = document.querySelector('#online-panel .online-board');
        if (!b) return null;
        const view = (window.GameNet.room || {}).view || {};
        return {
          acts: b.querySelectorAll('.act-btn').length,
          rps: b.querySelectorAll('.rps-btn:not([disabled])').length,
          viewPhase: view.phase || '',
        };
      })()`);
    let clicked = 0;
    let st = await phaseOf();
    const turnDeadline = Date.now() + 30000;
    while (Date.now() < turnDeadline && st.acts === 0 && st.viewPhase !== 'over') {
      if (st.rps > 0) {
        await clickIdle(page, `#online-panel .online-board .rps-btn[data-rps="${HANDS[clicked % HANDS.length]}"]`);
        clicked += 1;
        await sleep(400);
      } else {
        await sleep(300);
      }
      st = await phaseOf();
    }
    assert.ok(st.acts > 0, `30 秒内没轮到我行动（出了 ${clicked} 手），量不到"地图最矮"那一档：${JSON.stringify(st)}`);
    const tight = report('联机·行动中', { label: '360x640' }, await measure(page, '#online-panel .online-board'));
    table.push({ mode: '联机行动中', vp: '360x640', ...tight });
    console.log(`  （这一档是出了 ${clicked} 手拳换来的）`);

    /* ---------- 汇总（报告直接抄这一块） ---------- */
    console.log('\n== 汇总表（可以直接抄进报告）');
    console.log('  模式     视口     地图宽x高      头像直径   热区直径   最小可点');
    for (const t of table) {
      console.log(
        `  ${String(t.mode).padEnd(8)} ${String(t.vp).padEnd(8)} ${String(t.map.w + 'x' + t.map.h).padEnd(13)} ` +
          `${String(t.face + 'px').padEnd(10)} ${String(t.hit + 'px').padEnd(10)} ${t.min.side}px (${t.min.w}x${t.min.h} ${t.min.what})`
      );
    }

    if (page.errors.length) {
      throw new Error('浏览器控制台有报错：\n' + page.errors.join('\n'));
    }
    console.log('\n✅ 小屏尺寸实测全部通过（横向不溢出 / 元素都在屏幕内 / 可点目标 ≥44px）');
  } finally {
    if (page) page.close();
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\n❌ 小屏尺寸实测失败：');
  console.error((err && err.stack) || err);
  process.exitCode = 1;
});