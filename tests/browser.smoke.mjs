/*
 * 真实浏览器端到端冒烟测试。
 *
 * **为什么必须有一条真浏览器的测试**：本项目的 WebSocket 服务端是手写的
 * （server/ws.mjs，Node 没有内置 WS 服务端）。Node 侧的测试用的是我自己写的
 * 客户端（tests/ws-client.mjs），两边都是我写的 —— 万一我对 RFC 的理解整体偏了，
 * 它们会互相验证通过，而真浏览器一连就炸。所以这条测试是不可替代的：
 * 它用真 Chrome 去连，能不能通，只取决于实现对不对。
 *
 * 覆盖：注册 → 拿到 ID → 进入平台 → WS 连上 → 游戏卡片渲染 →
 *       加好友（甲发申请、乙同意；以及两人互相申请直接成为好友）→
 *       看到实时在线状态 → 控制台零报错。
 *
 * 跑（需要本机有 Chrome 或 Edge）：
 *   node tests/browser.smoke.mjs
 *
 * 它**故意不叫 *.test.mjs** —— 这样 `npm test` 不会顺手跑它（真浏览器测试慢，
 * 而且依赖本机装了浏览器）。这也是原项目家族的约定。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/server.mjs';
import { Page, findChrome } from '../tools/cdp.mjs';
import { wsConnect } from './ws-client.mjs';

const SHOTS = new URL('./screenshots/', import.meta.url).pathname.replace(/^\//, '');

/** 从 Node 侧注册一个用户，返回 { cookie, me }。 */
async function registerViaApi(baseUrl, name, password) {
  const res = await fetch(new URL('/api/register', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });
  const data = await res.json();
  assert.equal(res.status, 200, `注册 ${name} 失败：${JSON.stringify(data)}`);
  const cookie = (res.headers.getSetCookie() || [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('sid='));
  return { cookie, me: data.me };
}

/**
 * 界面体检：横向溢出、点击区域过小、元素跑出屏幕。
 * 这三条是原项目家族既有的验收标准（见 Shell Gambit / BladeSteed 的 README），
 * 搬过来继续用 —— 截图要人看，这几条机器就能判。
 *
 * ⚠️ 选择器是 `button, input, a[href]`：平台首页多了一条「我的个人主页」外链，
 *    链接也是**真实的点击目标**，一样要 ≥44px（`tools/check-game.mjs` 那边早就把 `a`
 *    算进去了）。改这里别把 `a[href]` 删掉，删了就等于给外链开了个盲区。
 */
async function layoutCheck(page, label) {
  const report = await page.eval(`
    var overflow = document.documentElement.scrollWidth - window.innerWidth;

    var small = [];
    document.querySelectorAll('button, input, a[href]').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;      // 隐藏元素不参与（display:none 的栏目量出来是 0）
      if (r.height < 44) small.push((el.id || el.className || el.tagName) + '=' + Math.round(r.height) + 'px');
    });

    var outside = [];
    document.querySelectorAll('.screen.is-active button, .screen.is-active input, .screen.is-active a[href]').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width < 1) return;
      if (r.left < -1 || r.right > window.innerWidth + 1) {
        outside.push((el.id || el.className) + '@' + Math.round(r.left) + '..' + Math.round(r.right));
      }
    });

    return { overflow: overflow, small: small, outside: outside, width: window.innerWidth };
  `);

  assert.ok(
    report.overflow <= 1,
    `${label}（${report.width}px 宽）：横向溢出 ${report.overflow}px`
  );
  assert.deepEqual(report.small, [], `${label}：点击区域小于 44px`);
  assert.deepEqual(report.outside, [], `${label}：元素跑出屏幕`);
  return report;
}

/**
 * 切到平台首页的某一栏（游戏 / 好友 / 设置）。
 *
 * ⚠️ 平台首页现在是**底部三栏**（用户确认过的形态）：好友面板和登出按钮都住在各自的栏目里，
 *    没显示的栏目是 `display:none` —— 那种元素的 rect 是 0，`page.click` 点了等于没点。
 *    所以凡是要点好友面板 / 设置栏里的东西，**都必须先切过去**。
 *    （不许为了让老用例过而给旧元素留一份隐藏副本 —— 那就等于界面搬家没搬干净。）
 * ⚠️ 切完要等旧栏目那层"淡出幻影"（app.js 给旧栏挂 240ms 的 is-leaving）收干净，
 *    不然界面体检会量到那层正在淡出的浮层。
 */
async function showColumn(page, name) {
  await page.click(`#tab-${name}`);
  await page.waitFor(
    `var p = document.getElementById('panel-${name}');
     return !!p && p.classList.contains('is-active') && p.getBoundingClientRect().height > 0`,
    5_000,
    `切到「${name}」栏目`
  );
  await page.waitFor(
    `return document.querySelectorAll('.tab-panel.is-leaving').length === 0`,
    3_000,
    `「${name}」栏目的淡入淡出结束`
  );
}

/**
 * 最后一条提示条（toast）的文本。
 * 提示条会自己消失，所以只能在**点完之后马上**读；取最后一条是因为
 * 前面可能还有没消失完的旧提示。
 */
function lastToast(page) {
  return page.eval(
    `var all = document.querySelectorAll('.frp-toast'); return all.length ? all[all.length - 1].textContent : ''`
  );
}

async function main() {
  if (!findChrome()) {
    console.log('⚠️  本机没找到 Chrome / Edge，跳过浏览器测试');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'frp-game-browser-'));
  const app = await startServer({ port: 0, dbPath: join(tmpDir, 'browser.db') });
  let page;

  try {
    console.log(`服务器起来了：${app.url}`);

    // ---------- 另一个玩家（走 API + WS，用来验证"好友在线状态"）----------
    const bob = await registerViaApi(app.url, '乙', 'secret123');
    const bobClient = await wsConnect({ port: app.port, cookie: bob.cookie });
    await bobClient.waitFor('ready');
    await bobClient.waitFor('friends');
    console.log(`另一个玩家上线了：${bob.me.name} / ${bob.me.id}`);

    // ---------- 真浏览器 ----------
    page = await Page.launch({ headless: true, width: 430, height: 932, mobile: true });
    await page.goto(app.url);

    // 停在登录页
    await page.waitFor(
      `return document.getElementById('screen-auth').classList.contains('is-active')`,
      10_000,
      '登录页出现'
    );
    await layoutCheck(page, '登录页');

    // ---------- 注册 ----------
    await page.click('#tab-register');
    await page.setInput('#register-name', '甲');
    await page.setInput('#register-password', 'secret123');
    await page.setInput('#register-password2', 'secret123');
    await page.click('#form-register .btn-primary');

    await page.waitFor(`return !document.getElementById('modal-id').hidden`, 15_000, 'ID 弹窗出现');
    const myId = await page.eval(`return document.getElementById('new-id').textContent`);
    assert.match(myId, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{7}$/, `发放的 ID 不合规：${myId}`);
    console.log(`注册成功，领到 ID：${myId}`);

    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot(join(SHOTS, 'id-modal.png'));

    // ---------- 进入平台 ----------
    await page.click('#btn-id-done');
    await page.waitFor(
      `return document.getElementById('screen-app').classList.contains('is-active')`,
      10_000,
      '平台主界面出现'
    );

    // 真浏览器连上手写的 WebSocket 服务端
    await page.waitFor(`return window.GameNet && window.GameNet.connected === true`, 15_000, 'WebSocket 连上');
    const meId = await page.eval(`return window.GameNet.me && window.GameNet.me.id`);
    assert.equal(meId, myId, 'WebSocket 认出来的身份应该和注册时一致');
    console.log('真浏览器的 WebSocket 握手成功（手写服务端经受住了真实客户端）');

    // 游戏卡片
    /*
     * ⚠️ 张数**不许写死**：平台首页画出来的就是 `window.GAMES` 里的那份清单
     * （`web/assets/js/games.js`），加一个游戏就多一张卡。写死数字的后果实测过：
     * 三国杀（sanguosha-lite）加进清单那天，这条用例当场变红 —— 页面其实是对的，
     * 是断言自己漂了。所以这里改成"卡片数 === 清单条数"。
     *
     * ⛔ 顺带钉住清单本身：空清单时 "0 === 0" 会假装通过，而且每条都得有
     *    **要么 slug、要么 href**（卡片靠 slug 才点得动平台游戏；href 是外部托管页，
     *    比如 `无名杀（原版）` → `/noname/`，它没有 slug、也不走平台的房间层）。
     */
    const games = await page.eval(`
      return (window.GAMES || []).map(function (g) { return g && (g.slug || g.href) });
    `);
    assert.ok(games.length > 0, '平台首页的游戏清单（window.GAMES）不该是空的');
    assert.ok(
      games.every((id) => typeof id === 'string' && id),
      `游戏清单里每一项都要有 slug 或 href（卡片靠它才点得动）：${JSON.stringify(games)}`
    );
    const cards = await page.eval(`return document.querySelectorAll('.game-card').length`);
    assert.equal(cards, games.length, `首页应该有 ${games.length} 张游戏卡片（= 清单条数），实际 ${cards}`);
    console.log(`游戏卡片：清单里 ${games.length} 个（${games.join(' / ')}）→ 首页画出 ${cards} 张`);

    // ---------- 2026-11 首页改版：搜索 / 人数筛选 / 首字母排序 / 介绍 ≤35 字 ----------
    const catalog = await page.eval(`
      return (window.GAMES || []).map(function (g) {
        return {
          title: g.title, letter: g.letter, desc: g.desc || '',
          min: Number(g.minPlayers), max: Number(g.maxPlayers),
        };
      });
    `);
    for (const game of catalog) {
      assert.match(game.letter, /^[A-Z]$/, `「${game.title}」的 letter 必须是一个大写字母：${game.letter}`);
      assert.ok(
        [...game.desc].length <= 35,
        `「${game.title}」的介绍超过 35 个字（${[...game.desc].length}）：${game.desc}`
      );
      assert.ok(
        Number.isFinite(game.min) && Number.isFinite(game.max) && game.min <= game.max,
        `「${game.title}」的人数范围不合法：${game.min}–${game.max}`
      );
    }

    const layout = await page.eval(`return {
      rail: Array.prototype.map.call(document.querySelectorAll('#game-letters > *'), function (el) {
        return { tag: el.tagName, text: el.textContent.trim(), letter: el.getAttribute('data-letter') };
      }),
      groups: Array.prototype.map.call(document.querySelectorAll('#game-grid .game-group'), function (el) {
        return el.getAttribute('data-letter');
      }),
    }`);
    assert.equal(layout.rail.length, 26, '最右侧应该是完整 A–Z（26 项）');
    const clickable = layout.rail.filter((l) => l.tag === 'BUTTON').map((l) => l.letter);
    assert.deepEqual(clickable, layout.groups, `可点字母应该正好等于有游戏的字母：${JSON.stringify(layout)}`);
    const sortedLetters = [...layout.groups].sort();
    assert.deepEqual(layout.groups, sortedLetters, '游戏分组必须按字母 A–Z 排序');

    // 搜索：只留下匹配的那一个
    await page.setInput('#game-search', '麻将');
    await page.waitFor(
      `return document.querySelectorAll('#game-grid .game-card').length === 1`,
      3000,
      '搜索「麻将」后只剩一张卡片'
    );
    assert.match(await page.eval(`return document.querySelector('#game-grid .game-card').textContent`), /莲花广麻/);

    // 人数筛选：留下所有"能开出 3 人局"的游戏（不是只留正好 3 人的）
    await page.setInput('#game-search', '');
    await page.click('#game-filter');
    await page.waitFor('return !document.getElementById("game-filter-pop").hidden', 2000, '人数筛选面板展开');
    await page.click('#game-filter-chips .filter-chip[data-value="3"]');
    const expected3 = catalog.filter((g) => g.min <= 3 && g.max >= 3).length;
    await page.waitFor(
      `return document.querySelectorAll('#game-grid .game-card').length === ${expected3}`,
      3000,
      `筛「3 人」后应剩 ${expected3} 张卡片`
    );
    assert.ok(
      (await page.eval(`return document.querySelector('#game-grid').textContent`)).includes('斗地主'),
      '「3 人」筛选里应该有斗地主'
    );

    // 清空筛选，回到完整清单
    await page.click('#game-filter');
    await page.click('#game-filter-chips .filter-chip[data-value="all"]');
    await page.waitFor(
      `return document.querySelectorAll('#game-grid .game-card').length === ${games.length}`,
      3000,
      '清空筛选后恢复完整清单'
    );
    console.log(`首页改版：A–Z 索引 ${clickable.join('')} · 搜索/人数筛选可用 · 介绍都 ≤35 字`);

    // 2026-11 防 IDM：音频 URL 去掉扩展名（平台入口页必须带 no-idm.js）
    const noIdm = await page.evalRaw(`return {
      loaded: typeof window.FrpNoIdm === 'object' && !!window.FrpNoIdm,
      fixed: window.FrpNoIdm ? window.FrpNoIdm.fix('/games/x/bgm.mp3?q=1') : null,
      audio: (function () {
        var a = new Audio('/games/x/bgm.ogg');
        return { src: a.src, type: a.constructor.name };
      })(),
    }`);
    assert.equal(noIdm.loaded, true, '平台入口页要加载 /shared/ui/no-idm.js');
    assert.match(noIdm.fixed, /\/games\/x\/bgm\?q=1$/, 'fix() 要去掉媒体扩展名并保留查询串');
    assert.match(noIdm.audio.src, /\/games\/x\/bgm$/, 'new Audio() 的 URL 也要去扩展名');
    console.log('防 IDM：音频扩展名已去掉（URL 里不再有 .mp3/.ogg/.wav）');

    // ---------- 底部三栏：默认落在「游戏」，另外两栏住在页面里但没显示 ----------
    // （用户逐条确认过的形态：底部一条只用图标的切换栏，绝不跳转网页）
    const homeUrl = await page.eval(`return location.href`);
    const columns = await page.eval(`
      return {
        active: Array.prototype.filter.call(document.querySelectorAll('.tab-panel'), function (p) {
          return p.classList.contains('is-active');
        }).map(function (p) { return p.id; }),
        tabs: Array.prototype.map.call(document.querySelectorAll('.tabbar-btn'), function (b) {
          var r = b.getBoundingClientRect();
          var icon = b.querySelector('.tabbar-icon');
          var badge = b.querySelector('.tabbar-badge');
          return {
            id: b.id,
            icon: icon ? icon.textContent : null,
            // 除了图标和（出现时的）小红点数字之外，一个字都不许有 —— 用户要求只用图标。
            // 小红点就算藏着不显示，它的数字也在 textContent 里，所以无条件排掉。
            extraText: b.textContent
              .replace(icon ? icon.textContent : '', '')
              .replace(badge ? badge.textContent : '', '')
              .trim(),
            title: b.getAttribute('title'),
            aria: b.getAttribute('aria-label'),
            role: b.getAttribute('role'),
            selected: b.getAttribute('aria-selected'),
            w: Math.round(r.width), h: Math.round(r.height),
          };
        }),
        gamesVisible: document.getElementById('panel-games').getBoundingClientRect().height > 0,
        friendsHidden: document.getElementById('panel-friends').getBoundingClientRect().height === 0,
        settingsHidden: document.getElementById('panel-settings').getBoundingClientRect().height === 0,
        gamesCards: document.querySelectorAll('#game-grid .game-card').length,
      }
    `);
    assert.deepEqual(columns.active, ['panel-games'], '平台首页默认应该落在最左的「游戏」栏');
    assert.deepEqual(
      columns.tabs.map((t) => t.id),
      ['tab-games', 'tab-friends', 'tab-settings'],
      '底部栏从左到右应该是 游戏 / 好友 / 设置'
    );
    assert.deepEqual(
      columns.tabs.map((t) => t.icon),
      ['🎮', '👥', '⚙️'],
      '三个图标不对（用户点名要的就是这三个）'
    );
    for (const t of columns.tabs) {
      assert.equal(t.role, 'tab', `${t.id} 应该有 role="tab"`);
      assert.equal(t.extraText, '', `${t.id} 上不能有文字标签（用户要求只用图标），实际多了「${t.extraText}」`);
      assert.ok(t.title, `${t.id} 缺 title（鼠标悬停要靠它说明这是什么）`);
      assert.ok(t.aria, `${t.id} 缺 aria-label（图标没有文字，读屏只能靠它）`);
      assert.ok(t.w >= 44 && t.h >= 44, `${t.id} 的点击区只有 ${t.w}×${t.h}px（任一边都要 ≥44px）`);
    }
    assert.equal(columns.tabs[0].selected, 'true', '默认选中的应该是「游戏」');
    assert.equal(columns.gamesVisible, true, '「游戏」栏应该显示着');
    assert.equal(columns.friendsHidden, true, '没选中的「好友」栏应该是隐藏的');
    assert.equal(columns.settingsHidden, true, '没选中的「设置」栏应该是隐藏的');
    assert.equal(columns.gamesCards, games.length, `\`#game-grid\` 里应该有 ${games.length} 张卡片（= 清单条数）`);
    await layoutCheck(page, '平台首页·游戏栏');
    console.log('底部三栏就位：🎮 游戏（默认）｜👥 好友｜⚙️ 设置，图标都带 title + aria-label');

    // 切一下栏目：必须是**网页内部**的切换（地址不变、连接不断），不是跳转
    await showColumn(page, 'friends');
    const afterSwitch = await page.eval(`
      return {
        url: location.href,
        connected: window.GameNet.connected,
        gamesHidden: document.getElementById('panel-games').getBoundingClientRect().height === 0,
        friendsVisible: document.getElementById('panel-friends').getBoundingClientRect().height > 0,
        selected: document.getElementById('tab-friends').getAttribute('aria-selected'),
      }
    `);
    assert.equal(afterSwitch.url, homeUrl, '切栏目把网页跳走了 —— 用户要的是同一个网页里换栏目');
    assert.equal(afterSwitch.connected, true, '切栏目之后 WebSocket 不该断（跳转才会断）');
    assert.equal(afterSwitch.gamesHidden, true, '切到好友之后「游戏」栏应该收起来');
    assert.equal(afterSwitch.friendsVisible, true, '「好友」栏应该显示出来');
    assert.equal(afterSwitch.selected, 'true', '「好友」图标应该变成选中态');
    console.log('栏目切换是网页内部的：地址没变、WebSocket 没断');

    // ---------- 设置栏：两个开关 / 身份与复制 ID / 登出 / 关于我 ----------
    await showColumn(page, 'settings');
    const settings = await page.eval(`
      return {
        sound: {
          on: document.getElementById('switch-sound').getAttribute('aria-checked'),
          text: document.getElementById('switch-sound').textContent.trim(),
          pref: window.FrpUI.prefs.sound(),
        },
        fx: {
          on: document.getElementById('switch-fx').getAttribute('aria-checked'),
          pref: window.FrpUI.prefs.fx(),
        },
        meId: document.getElementById('me-id').textContent.replace(/\\s+/g, ' ').trim(),
        setname: document.getElementById('set-name').textContent,
        logout: !!document.getElementById('btn-logout'),
        link: (function () {
          var a = document.getElementById('link-home');
          var r = a.getBoundingClientRect();
          return { href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), h: Math.round(r.height) };
        })(),
        // 页脚那句"由你自己的电脑 + SakuraFrp 隧道托管"现在住在「关于我」卡片里
        aboutText: document.querySelector('.about-card').textContent.replace(/\\s+/g, ' ').trim(),
        footerGone: !document.querySelector('.site-footer'),
      }
    `);
    assert.equal(settings.sound.on, String(settings.sound.pref), '音效开关显示的状态要跟着 FrpUI.prefs 走');
    assert.equal(settings.sound.text, settings.sound.pref ? '开' : '关', '音效开关上要写清是开还是关');
    assert.equal(settings.fx.on, String(settings.fx.pref), '特效开关显示的状态要跟着 FrpUI.prefs 走');
    assert.match(settings.meId, new RegExp(myId), `设置栏应该能复制自己的 ID：${settings.meId}`);
    assert.equal(settings.setname, '甲', `设置栏应该显示名字：${settings.setname}`);
    assert.equal(settings.logout, true, '登出按钮应该搬进了「设置」栏');
    assert.equal(settings.link.href, 'https://home.prodhub.me', '「关于我」卡片里那个按钮要跳到个人主页');
    assert.equal(settings.link.target, '_blank', '个人主页要在新标签页打开');
    assert.equal(settings.link.rel, 'noopener', '外链必须带 rel="noopener"');
    assert.ok(settings.link.h >= 44, `个人主页那个链接只有 ${settings.link.h}px 高（要 ≥44px）`);
    assert.match(settings.aboutText, /SakuraFrp/, `页脚那句话应该搬进「关于我」卡片：${settings.aboutText}`);
    assert.equal(settings.footerGone, true, '页脚应该整块删掉（那句话已经搬进卡片）');
    await layoutCheck(page, '平台首页·设置栏');
    console.log('设置栏就位：音效/特效开关、身份与复制 ID、登出、连接状态、关于我卡片');

    // 点一下音效开关：prefs 要真的变（而且是**平台唯一那份**），显示也要跟着变
    const soundBefore = await page.eval(`return window.FrpUI.prefs.sound()`);
    await page.click('#switch-sound');
    const soundAfter = await page.eval(`
      return {
        pref: window.FrpUI.prefs.sound(),
        aria: document.getElementById('switch-sound').getAttribute('aria-checked'),
        text: document.getElementById('switch-sound').textContent.trim(),
        stored: JSON.parse(localStorage.getItem('frp.prefs') || '{}').sound,
      }
    `);
    assert.equal(soundAfter.pref, !soundBefore, '点一下开关应该把 FrpUI.prefs 翻过来');
    assert.equal(soundAfter.aria, String(soundAfter.pref), '开关上的 aria-checked 要跟着变');
    assert.equal(soundAfter.text, soundAfter.pref ? '开' : '关', '开关上的字要跟着变');
    assert.equal(soundAfter.stored, soundAfter.pref, '偏好要写进 localStorage 的 frp.prefs（平台唯一那一份）');
    await page.click('#switch-sound');   // 关回去，别影响后面的用例
    assert.equal(await page.eval(`return window.FrpUI.prefs.sound()`), soundBefore, '再点一下应该回到原来的值');
    console.log('音效开关接上了平台唯一那份偏好（FrpUI.prefs，写进 frp.prefs）');

    // 回到「好友」栏继续走好友流程
    await showColumn(page, 'friends');

    // ---------- 加好友：现在要点两下（甲发申请 → 乙同意）----------
    bobClient.clear();
    await page.setInput('#friend-id', bob.me.id);
    await page.click('#form-friend-add .btn');

    // 点完只是**发申请**：好友列表必须还是空的，界面上要出现"我发出的申请"
    await page.waitFor(
      `return document.querySelectorAll('#friend-outgoing-list .friend').length === 1`,
      10_000,
      '"我发出的申请"里出现乙'
    );
    assert.equal(
      await page.eval(`return document.querySelectorAll('#friend-list .friend').length`),
      0,
      '对方还没同意，就不该出现在好友列表里'
    );
    const addToast = await lastToast(page);
    assert.match(addToast, /已发送好友申请/, `点「加好友」之后的提示不对：${addToast}`);
    await page.screenshot(join(SHOTS, 'friend-outgoing.png'));
    await layoutCheck(page, '平台首页·有发出的申请');
    // 申请行上有"名字 + 7 位 ID + 撤回按钮"，窄屏最容易撑破，单独量一次
    await page.setViewport(360, 640, true);
    await layoutCheck(page, '平台首页·有发出的申请·窄屏');
    await page.setViewport(430, 932, true);

    // 乙（Node 侧）收到申请并同意 —— 服务端要**给双方**各推一份新快照
    const asked = await bobClient.waitFor('friends');
    assert.deepEqual(asked.incoming.map((r) => r.id), [myId], '乙应该收到甲发来的申请');
    bobClient.send({ t: 'friend.accept', id: myId });
    const accepted = await bobClient.waitFor('friends');
    assert.deepEqual(accepted.list.map((f) => f.id), [myId], '同意之后乙那边应该多出这个好友');

    // 甲这边的界面要跟着变成"真的好友了"，而且是在线
    await page.waitFor(`return document.querySelectorAll('#friend-list .friend').length === 1`, 10_000, '同意之后好友出现在列表里');
    await page.waitFor(
      `return document.querySelector('#friend-list .friend').classList.contains('is-online')`,
      10_000,
      '好友显示为在线'
    );
    await page.waitFor(
      `return document.getElementById('friend-incoming').hidden && document.getElementById('friend-outgoing').hidden`,
      10_000,
      '申请处理完之后两块申请区整块隐藏'
    );

    const friendText = await page.eval(`return document.querySelector('#friend-list .friend').textContent`);
    assert.match(friendText, /乙/, `好友行应该显示名字：${friendText}`);
    assert.match(friendText, new RegExp(bob.me.id), `好友行应该显示 ID：${friendText}`);

    await page.screenshot(join(SHOTS, 'platform.png'));

    // ---------- 界面体检：手机窄屏 ----------
    // ⚠️ 三栏是**互相隐藏**的（没选的栏目 display:none），所以体检必须**每一栏都量一遍** ——
    //    只量当前栏就等于给另外两栏开了盲区。
    await layoutCheck(page, '平台首页·好友栏');
    await page.setViewport(360, 640, true);
    // 窄屏 + 底部那条切换栏：最容易出问题的组合（三个图标 + 安全区）
    await layoutCheck(page, '平台首页·好友栏·窄屏');
    await showColumn(page, 'games');
    await layoutCheck(page, '平台首页·游戏栏·窄屏');
    await showColumn(page, 'settings');
    await layoutCheck(page, '平台首页·设置栏·窄屏');
    await showColumn(page, 'games');
    await page.setViewport(430, 932, true);
    await layoutCheck(page, '平台首页·游戏栏');
    // 后面的好友流程要点好友面板，切回去（见 showColumn 的说明）
    await showColumn(page, 'friends');

    // ---------- 双方同时互相申请：不能卡在"等对方同意"上 ----------
    // 先让乙删掉好友（双向删），再让乙**先**发一条申请过来；
    // 甲这时候也按下「加好友」—— 两边都在等对方，服务端必须直接判成好友。
    bobClient.clear();
    bobClient.send({ t: 'friend.remove', id: myId });
    await bobClient.waitFor('friends');
    await page.waitFor(
      `return document.querySelectorAll('#friend-list .friend').length === 0`,
      10_000,
      '删好友之后列表变空（双向删）'
    );

    bobClient.clear();
    bobClient.send({ t: 'friend.add', id: myId });
    await page.waitFor(
      `return document.querySelectorAll('#friend-incoming-list .friend').length === 1`,
      10_000,
      '甲看到乙先发来的申请'
    );

    await page.setInput('#friend-id', bob.me.id);
    await page.click('#form-friend-add .btn');
    await page.waitFor(
      `return document.querySelectorAll('#friend-list .friend').length === 1`,
      10_000,
      '两个人互相申请 → 直接成为好友（不卡住）'
    );
    const mutualToast = await lastToast(page);
    assert.match(mutualToast, /已经是好友/, `互相申请时不能还说"等对方同意"：${mutualToast}`);

    // ---------- 邀请横幅：钉在屏幕顶部，三栏都看得见 ----------
    // 它由 shared/ui/room.js 画（.frp-invite-card，position: fixed），
    // 平台首页只负责 handleInvites —— 搬栏目**不能把它挤坏**（用户要求它照旧留在最上面）。
    bobClient.clear();
    bobClient.send({ t: 'room.create', game: 'cannon-goblin', options: {} });
    const bobRoom = await bobClient.waitFor('room.state');
    assert.match(bobRoom.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/, `乙没建成房间：${JSON.stringify(bobRoom)}`);
    bobClient.clear();
    bobClient.send({ t: 'invite.send', to: [myId], code: bobRoom.code });
    await page.waitFor(`return !!document.querySelector('.frp-invite-card')`, 10_000, '邀请横幅出现');
    assert.match(
      await page.eval(`return document.querySelector('.frp-invite-card').textContent`),
      /邀请你玩/,
      '邀请横幅上应该写清是谁邀请你玩哪个游戏'
    );

    for (const name of ['friends', 'games', 'settings']) {
      await showColumn(page, name);
      const inv = await page.eval(`
        return (function () {
          var card = document.querySelector('.frp-invite-card');
          if (!card) return { missing: true };
          var r = card.getBoundingClientRect();
          var btns = Array.prototype.map.call(card.querySelectorAll('button'), function (b) {
            var br = b.getBoundingClientRect();
            return { text: b.textContent.trim(), h: Math.round(br.height) };
          });
          return {
            missing: false,
            top: Math.round(r.top), right: Math.round(r.right),
            h: Math.round(r.height), vw: window.innerWidth,
            btns: btns,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        })()
      `);
      assert.equal(inv.missing, false, `在「${name}」栏里邀请横幅不见了 —— 它必须三栏都在`);
      assert.ok(inv.h > 0, `在「${name}」栏里邀请横幅没有高度`);
      assert.ok(inv.top >= -1 && inv.right <= inv.vw + 1,
        `在「${name}」栏里邀请横幅跑出屏幕了：${JSON.stringify(inv)}`);
      assert.ok(inv.overflow <= 1, `在「${name}」栏里邀请横幅把页面撑宽了 ${inv.overflow}px`);
      assert.deepEqual(inv.btns.map((b) => b.text), ['进入', '忽略'], `邀请横幅上的按钮不对：${JSON.stringify(inv.btns)}`);
      for (const b of inv.btns) assert.ok(b.h >= 44, `邀请横幅上「${b.text}」只有 ${b.h}px（要 ≥44px）`);
    }
    console.log('邀请横幅三栏都在：换个栏目它照旧钉在屏幕顶部（没有跳转、没有重连）');

    // ---------- 好友下线，界面要跟着变 ----------
    bobClient.close();
    await page.waitFor(
      `return !document.querySelector('#friend-list .friend').classList.contains('is-online')`,
      10_000,
      '好友下线后列表实时刷新'
    );

    // ---------- 控制台必须干净 ----------
    if (page.errors.length) {
      throw new Error('浏览器控制台有报错：\n' + page.errors.join('\n'));
    }

    console.log('\n✅ 浏览器端到端全部通过');
    console.log(`   截图：${join(SHOTS, 'platform.png')}`);
  } finally {
    if (page) page.close();
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\n❌ 浏览器测试失败：');
  console.error(err && err.stack || err);
  process.exitCode = 1;
});