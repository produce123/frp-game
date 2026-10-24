/*
 * 真浏览器：两个人、两台浏览器，把在线对局的整条路走一遍。
 *
 *   node tests/room.browser.mjs
 *
 * 【它要走的路，就是用户实际会走的路】
 *   甲注册 → 给乙发好友申请 → 乙在平台首页点「同意」 →（双方成为好友）
 *   甲进游戏建房拿到房号 → **按一下「＋ 添加人机」看它坐在座位上**（单字名 / 灰圆环）→
 *   **点头像扔一个鸡蛋**（两边都要看到特效）→
 *   乙在**平台首页的好友列表**里看到"甲正在玩大炮轰小鬼"
 *   → 点「进入」→ 自己进了那个房（**顶掉刚才那个人机**）→ 甲点开始 → 双方都进棋盘 →
 *   甲走一步 → 乙那边跟着变 → 乙抢着走被服务器拒
 *
 * 【为什么这条要单独有】
 * `tests/browser.smoke.mjs` 只到"好友列表能看见"；`tests/server.test.mjs` 是在报文层面
 * 直接把流程调一遍。中间那一层 —— **界面按钮真的接对了没有** —— 只有真浏览器能证明。
 * 历史上这个项目吃过"内联 onclick 里的 async 报错被静默吞掉、点按钮毫无反应"的亏。
 *
 * ⚠️ 用真实 HTTP + 真实 WebSocket + 真 Chrome，但服务跑在**随机端口**上，
 *    所以不会跟本机 7891 上正在跑的服务打架。
 *
 * 【公网模式】—— 本机跑绿 ≠ 公网能用，这一层只有真打公网才证明得了
 *
 *   FRP_PUBLIC_URL=https://<公网地址> node tests/room.browser.mjs
 *
 *   · 不启临时服务，直接打公网地址（也就是内网穿透隧道那一条路）
 *   · 公网那台是**自签证书**（SakuraFrp 自动 HTTPS 默认就发自签），所以浏览器要多带一个
 *     `--ignore-certificate-errors` 才进得去 —— 真实访客对应的是"点一次继续访问"
 *   · 截图另存为 `public-*.png`，不会盖掉本机跑的那几张
 *   · ⚠️ **会在真实库里留下两个测试账号和它们的好友关系** —— 这是故意的：
 *     这条路要走的就是"两个真人跨网络"的那套东西，用完可以在库里删掉。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/server.mjs';
import { Page, findChrome } from '../tools/cdp.mjs';

const SHOTS = new URL('./screenshots/', import.meta.url).pathname.replace(/^\//, '');

/** 注册一个账号，关掉"你的 ID"弹窗，返回它领到的 ID。 */
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
  await page.waitFor(`return !document.getElementById('modal-id').hidden`, 15_000, `${name} 的 ID 弹窗出现`);
  const id = await page.eval(`return document.getElementById('new-id').textContent`);
  assert.match(id, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{7}$/, `${name} 领到的 ID 不合规：${id}`);
  await page.click('#btn-id-done');
  await page.waitFor(`return window.GameNet && window.GameNet.connected === true`, 15_000, `${name} 连接就绪`);
  return id;
}

/**
 * 读棋盘：直接看界面渲染所依据的那份状态（在线时它只来自服务端的 view）。
 *
 * ⚠️ 用**裸标识符** `gameState` / `playerSide`，不要写 `window.gameState` ——
 *    app.js 是经典脚本，它们是顶层 `let`，落在**全局词法环境**里，
 *    不是 window 的属性。写 `window.gameState` 会永远拿到 undefined。
 */
async function boardOf(page) {
  return page.eval(`
    if (!gameState) return null;
    return {
      board: gameState.board.map(function (row) { return row.slice(); }),
      turn: gameState.currentTurn,
      me: playerSide,
      over: gameState.gameOver,
      // 顺手把常量带回来 —— 别在测试里硬编码 EMPTY=0/CANNON=1/GHOST=2，
      // 那是引擎的内部约定，写死之后规则一改测试就开始说谎
      EMPTY: EMPTY, CANNON: CANNON, GHOST: GHOST,
    }
  `);
}

/**
 * 切到平台首页的某一栏（游戏 / 好友 / 设置）。
 *
 * ⚠️ 平台首页现在是**底部三栏**（用户确认过的形态）：好友面板住在「好友」栏里，
 *    没显示的栏目是 `display:none` —— 那种元素的 rect 是 0，`page.click` 点了等于没点。
 *    所以要点 `#friend-id` / `#form-friend-add .btn` / `.friend-accept` 之前，
 *    必须先切到「好友」栏。
 * ⚠️ 切完要等旧栏目那层"淡出幻影"（app.js 给旧栏挂 240ms 的 is-leaving）收干净。
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

/** 「好友」图标上那颗小红点的当前状态（只有待处理申请时才出现）。 */
function friendBadge(page) {
  return page.eval(`
    var b = document.getElementById('friend-badge');
    var tab = document.getElementById('tab-friends');
    var r = b.getBoundingClientRect();
    return {
      hidden: b.hidden,
      text: b.textContent.trim(),
      shown: !b.hidden && r.width > 0 && r.height > 0,
      aria: tab.getAttribute('aria-label'),
    }
  `);
}

async function main() {
  if (!findChrome()) {
    console.log('⏭  本机没有 Chrome/Edge，跳过这条测试');
    return;
  }

  /* 公网模式：设了 FRP_PUBLIC_URL 就不起临时服务，直接打公网地址（见文件头的说明） */
  const publicUrl = String(process.env.FRP_PUBLIC_URL || '').replace(/\/+$/, '');
  const shot = (name) => join(SHOTS, (publicUrl ? 'public-' : '') + name);

  const tmpDir = publicUrl ? null : mkdtempSync(join(tmpdir(), 'frp-room-'));
  const app = publicUrl
    ? null
    : await startServer({ port: 0, dbPath: join(tmpDir, 'room.db'), statePath: join(tmpDir, 'server.json') });
  const base = publicUrl || String(app.url).replace(/\/+$/, '');
  const gameUrl = `${base}/games/cannon-goblin/`;

  let a = null;
  let b = null;

  try {
    mkdirSync(SHOTS, { recursive: true });
    console.log(publicUrl ? `🌐 公网实测：${base}` : `🧪 本机临时服务：${base}`);

    // 公网那台是自签证书，浏览器必须忽略证书错误才进得去
    const extraArgs = publicUrl ? ['--ignore-certificate-errors'] : [];
    a = await Page.launch({ headless: true, width: 430, height: 932, mobile: true, extraArgs });
    b = await Page.launch({ headless: true, width: 430, height: 932, mobile: true, extraArgs });

    /* ---------- 1. 两个账号；甲发好友申请，乙在**界面上**点「同意」 ---------- */
    const idB = await register(b, base, '乙');
    const idA = await register(a, base, '甲');
    console.log(`账号就绪：甲=${idA} 乙=${idB}`);

    // 甲在「游戏」栏（默认栏），要加好友必须**先切到「好友」栏**再点
    await showColumn(a, 'friends');
    await a.setInput('#friend-id', idB);
    await a.click('#form-friend-add .btn');

    // 甲这边：没多出好友，只多了一条"我发出的申请"，状态是"等待对方同意"
    await a.waitFor(
      `return document.querySelectorAll('#friend-outgoing-list .friend').length === 1`,
      10_000,
      '甲看到"我发出的申请"'
    );
    assert.equal(
      await a.eval(`return document.querySelectorAll('#friend-list .friend').length`),
      0,
      '对方还没同意，就不该出现在好友列表里'
    );
    assert.equal(
      await a.eval(`return document.getElementById('friend-incoming').hidden`),
      true,
      '甲没有待处理的申请，那一块应该**整块隐藏**（连标题一起）'
    );
    // 点完之后必须明确说"这是申请"，不能让人以为已经加上了
    const addToast = await a.eval(
      `var all = document.querySelectorAll('.frp-toast'); return all.length ? all[all.length - 1].textContent : ''`
    );
    assert.match(addToast, /已发送好友申请/, `点「加好友」之后的提示不对：${addToast}`);
    await a.screenshot(shot('friend-outgoing.png'));

    // 乙这边：看到"新的好友申请"，同意 / 拒绝 两个按钮，而且在 430px 手机上放得下
    //
    // ⚠️ 乙这时候还停在**「游戏」栏**（注册完默认落在那一栏）—— 正好用来验一件事：
    //    别人发来的好友申请，在游戏栏就应该看到「好友」图标上那颗**小红点 + 数字**，
    //    否则用户在游戏栏里根本不知道有人加他（用户明确要求）。
    await b.waitFor(
      `return document.querySelectorAll('#friend-incoming-list .friend').length === 1`,
      10_000,
      '乙看到"新的好友申请"'
    );
    const badge = await friendBadge(b);
    assert.equal(badge.shown, true, `「好友」图标上应该冒出小红点（实际：${JSON.stringify(badge)}）`);
    assert.equal(badge.text, '1', `小红点上的数字应该是待处理申请数（实际：${JSON.stringify(badge)}）`);
    assert.match(badge.aria, /1 条待处理/, `图标的 aria-label 也要念出有几条待处理：${badge.aria}`);

    /* 切到「好友」栏看一眼 —— 看过之后小红点就该消失（用户要求） */
    await showColumn(b, 'friends');
    const badgeAfter = await friendBadge(b);
    assert.equal(badgeAfter.shown, false, `进过好友栏之后小红点应该消失（实际：${JSON.stringify(badgeAfter)}）`);
    assert.equal(badgeAfter.aria, '好友', `小红点没了，aria-label 也要回到「好友」：${badgeAfter.aria}`);
    console.log('好友小红点走通：申请来了冒出来（数字 1）→ 进过好友栏就消失');

    await b.screenshot(shot('friend-incoming.png'));

    const reqRow = await b.eval(`
      return (function () {
        var row = document.querySelector('#friend-incoming-list .friend');
        var btns = Array.prototype.map.call(row.querySelectorAll('button'), function (el) {
          var r = el.getBoundingClientRect();
          return { text: el.textContent, h: Math.round(r.height) };
        });
        return {
          text: row.textContent.replace(/\\s+/g, ' ').trim(),
          btns: btns,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        };
      })()
    `);
    assert.deepEqual(reqRow.btns.map((x) => x.text), ['同意', '拒绝'], `申请行上的按钮不对：${JSON.stringify(reqRow)}`);
    for (const btn of reqRow.btns) assert.ok(btn.h >= 44, `「${btn.text}」的点击区只有 ${btn.h}px（要 ≥44px）`);
    assert.ok(reqRow.overflow <= 1, `待处理申请那一行把页面撑宽了 ${reqRow.overflow}px`);
    assert.match(reqRow.text, /甲/, `申请行应该显示对方的名字：${reqRow.text}`);
    assert.match(reqRow.text, /想加你为好友/, `申请行应该说明这是"想加你为好友"：${reqRow.text}`);
    assert.match(reqRow.text, new RegExp(idA), `申请行应该显示对方的 ID（单字名会重名，靠 ID 认人）：${reqRow.text}`);

    // 真点一下「同意」（不是绕过界面直接发消息）
    await b.click('#friend-incoming-list .friend-accept');

    // 同意之后：双方好友列表里各有一个人，两块申请区都整块隐藏
    await a.waitFor(`return document.querySelectorAll('#friend-list .friend').length === 1`, 10_000, '同意后好友出现在甲的列表里');
    await b.waitFor(`return document.querySelectorAll('#friend-list .friend').length === 1`, 10_000, '同意后好友出现在乙的列表里');
    for (const [who, page] of [['甲', a], ['乙', b]]) {
      const hidden = await page.eval(`
        return document.getElementById('friend-incoming').hidden && document.getElementById('friend-outgoing').hidden
      `);
      assert.equal(hidden, true, `${who} 的申请处理完之后，两块申请区都该整块隐藏`);
    }
    console.log('申请-同意走通：甲发申请 → 乙在界面上点同意 → 双方成为好友');

    /* ---------- 2. 甲进游戏建房 ---------- */
    a.errors.length = 0;
    await a.goto(gameUrl);
    await a.waitFor(`return !!document.querySelector('.screen.is-active')`, 15_000, '甲的游戏页面出现');
    await a.eval(`return (function () { window.enterOnline(); return true; })()`);
    await a.waitFor(`return !!document.querySelector('#online-panel .frp-room-idle')`, 10_000, '房间入口出现');

    /*
     * ⚠️ 点「创建房间」之前必须等 WebSocket **真的连上**。
     *
     * `Net.send`（shared/net/net.js:405）在 socket 没到 OPEN 时**静默 `return false`** ——
     * 什么都不发、也不提示。本机 1ms 就绪，所以这条在本机永远撞不到；
     * 公网（自动 HTTPS + 内网穿透 + 几十毫秒 RTT）2026-10-21 第一次跑就撞上了：
     * 「房间入口出现」比 WebSocket 就绪早 → 点下去什么也没发生 → 10 秒超时。
     * 界面结构本身没毛病 —— 所以这里补的是**测试的竞态**，不是界面的。
     */
    await a.waitFor(
      `return !!(window.GameNet && window.GameNet.connected === true)`,
      15_000,
      '甲的游戏页 WebSocket 连上'
    );

    const clickedCreate = await a.eval(`
      return (function () {
        var btn = document.querySelector('#online-panel .frp-room-idle .frp-btn-primary');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    // 原来这里不看返回值：于是"按钮没找到"和"点了没发出去"都变成同一句"房号出现超时"
    assert.equal(clickedCreate, true, '没找到「创建房间」按钮（在线面板的结构变了吗？）');
    try {
      await a.waitFor(`return !!document.querySelector('#online-panel .frp-room-code-value')`, 10_000, '房号出现');
    } catch (err) {
      // 公网模式下失败时把现场留下来，省得为了看一眼状态再跑一整轮
      const diag = await a.eval(`
        var panel = document.getElementById('online-panel');
        var toasts = document.querySelectorAll('.frp-toast');
        return {
          connected: !!(window.GameNet && window.GameNet.connected),
          panel: panel ? panel.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200) : '(没有 online-panel)',
          toast: toasts.length ? toasts[toasts.length - 1].textContent : '(没有提示)',
        }
      `);
      console.log('建房失败现场：', JSON.stringify(diag));
      console.log('甲的控制台错误：', a.errors.length ? a.errors.join(' | ') : '(无)');
      console.log('甲最后几行日志：', a.logs.slice(-6).join(' | ') || '(无)');
      throw err;
    }

    const code = (await a.eval(`return document.querySelector('#online-panel .frp-room-code-value').textContent`)).trim();
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/, `房号不合规：${code}`);
    console.log(`甲建好房间，房号 ${code}`);

    /* ---------- 2.5 人机是**座位**：按一下加一个（平台统一交互） ---------- */

    await a.waitFor(`return !!document.querySelector('#online-panel .frp-room-seat-count')`, 8000, '座位计数出现');
    let seatsText = await a.eval(`return document.querySelector('#online-panel .frp-room-seat-count').textContent`);
    assert.match(seatsText, /座位\s*1\s*\/\s*2/, `刚建房应该是「座位 1 / 2」，实际：${seatsText}`);

    const addBtn = await a.eval(`
      return (function () {
        var btn = document.querySelector('#online-panel .frp-room-bot-add');
        if (!btn) return null;
        var r = btn.getBoundingClientRect();
        return { text: btn.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
      })()
    `);
    assert.ok(addBtn, '房主应该看得到「＋ 添加人机」按钮（人机改成座位之后，这是唯一的入口）');
    assert.match(addBtn.text, /添加人机/, `按钮文案不对：${JSON.stringify(addBtn)}`);
    assert.ok(addBtn.w >= 44 && addBtn.h >= 44, `「添加人机」的点击区只有 ${addBtn.w}×${addBtn.h}px（要 ≥44px）`);

    // 按一下 → 多**一个**座位，而且它是个灰色圆环的单字名字人机
    await a.eval(`return (function () { document.querySelector('#online-panel .frp-room-bot-add').click(); return true; })()`);
    await a.waitFor(
      `return document.querySelectorAll('#online-panel .frp-room-member').length === 2`,
      8000,
      '按一下应该只加一个座位'
    );

    const botRow = await a.eval(`
      return (function () {
        var row = document.querySelector('#online-panel .frp-room-member.is-bot');
        if (!row) return null;
        var av = row.querySelector('.frp-avatar');
        var hit = row.querySelector('.frp-room-avatar-hit');
        var hr = hit.getBoundingClientRect();
        return {
          text: row.textContent.replace(/\\s+/g, ' ').trim(),
          ring: av.className,
          name: av.getAttribute('data-frp-name'),
          target: av.getAttribute('data-frp-avatar'),
          hitW: Math.round(hr.width), hitH: Math.round(hr.height),
        };
      })()
    `);
    assert.ok(botRow, '人机应该像真人一样坐在座位列表里（.frp-room-member.is-bot）');
    assert.match(botRow.ring, /is-bot/, `人机的圆环必须是灰的（is-bot），实际：${botRow.ring}`);
    assert.equal(botRow.name.length, 1, `人机名字必须沿用单机那套单字名，实际：${botRow.name}`);
    assert.match(botRow.target, /^bot:/, `人机的 data-frp-avatar 应该是 bot:N，实际：${botRow.target}`);
    assert.match(botRow.text, /人机/, `人机那一行要有「人机」标签，别让人以为来了个陌生玩家：${botRow.text}`);
    assert.ok(botRow.hitW >= 44 && botRow.hitH >= 44,
      `人机头像的点击区只有 ${botRow.hitW}×${botRow.hitH}px（要 ≥44px，不然扔不了鸡蛋）`);

    // 满座（2/2）时按钮变灰：点了也没用，别让人反复戳
    await a.waitFor(
      `return document.querySelector('#online-panel .frp-room-bot-add').disabled === true`,
      8000,
      '满座时「添加人机」应该变灰'
    );

    // 「移除」要真的能撤掉（房主按错了能改回来）
    const removeBtn = await a.eval(`
      return (function () {
        var btn = document.querySelector('#online-panel .frp-room-bot-remove');
        if (!btn) return null;
        var r = btn.getBoundingClientRect();
        btn.click();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })()
    `);
    assert.ok(removeBtn, '房主应该能移除人机');
    assert.ok(removeBtn.w >= 44 && removeBtn.h >= 44, `「移除」的点击区只有 ${removeBtn.w}×${removeBtn.h}px`);
    await a.waitFor(
      `return document.querySelectorAll('#online-panel .frp-room-member').length === 1`,
      8000,
      '移除之后应该只剩房主'
    );

    // 再加回来：下一个真人进来时要验"真人顶掉最后加的那个人机"
    await a.eval(`return (function () { document.querySelector('#online-panel .frp-room-bot-add').click(); return true; })()`);
    await a.waitFor(
      `return document.querySelectorAll('#online-panel .frp-room-member.is-bot').length === 1`,
      8000,
      '人机又坐回来了'
    );
    await a.screenshot(shot('room-bot-seat.png'));
    console.log('人机座位走通：按一下加一个（单字名、灰圆环、带「人机」标签）');

    /* ---------- 3. 乙从平台首页的好友列表里直接进去 ---------- */
    // 关键：乙**不输房号**，而是靠"好友正在玩什么 + 进入"这条路进去
    // （这是用户明确定下来的功能：friends 推送里带 playing，可进时给按钮）
    await b.waitFor(
      `return (function () {
         var rows = document.querySelectorAll('#friend-list .friend');
         for (var i = 0; i < rows.length; i++) {
           if (/大炮轰小鬼|Cannon/i.test(rows[i].textContent) && rows[i].querySelector('.friend-join')) return true;
         }
         return false;
       })()`,
      15_000,
      '乙的好友列表里出现"甲正在玩大炮轰小鬼"并能进入'
    );
    await b.screenshot(shot('room-friend-playing.png'));

    // 真实鼠标点击（脚本 .click() 没有用户手势，浏览器会把 window.open 拦掉）
    await b.click('#friend-list .friend .friend-join');

    // 2026-11 起平台首页所有游戏都**新窗口打开**：要切到新标签页继续断言。
    b = await b.waitForNewPage({ urlIncludes: '/games/cannon-goblin' });

    await b.waitFor(`return location.pathname.replace(/\\/+$/, '') === '/games/cannon-goblin'`, 15_000, '乙被带进了游戏页面');
    await b.waitFor(`return !!document.querySelector('#online-panel .frp-room-waiting')`, 15_000, '乙进了房间（等待态）');

    /* ---------- 4. 两边都看到 2 个人 ---------- */
    for (const [who, page] of [['甲', a], ['乙', b]]) {
      await page.waitFor(
        `return document.querySelectorAll('#online-panel .frp-room-member').length === 2`,
        15_000,
        `${who} 看到 2 个成员`
      );
    }
    const members = await a.eval(`
      return Array.prototype.map.call(document.querySelectorAll('#online-panel .frp-room-member'), function (li) {
        return li.textContent.replace(/\\s+/g, ' ').trim();
      })
    `);
    assert.ok(members.some((m) => m.includes('房主')), `成员列表里应该有房主标记：${JSON.stringify(members)}`);
    await a.screenshot(shot('room-waiting.png'));

    // 真人进来把**最后加的那个人机**顶掉了（人机不占着位置不让真人玩），座位还是满的 2/2
    assert.equal(
      await a.eval(`return document.querySelectorAll('#online-panel .frp-room-member.is-bot').length`),
      0,
      '第二个真人进来时应该顶掉那个人机'
    );
    seatsText = await a.eval(`return document.querySelector('#online-panel .frp-room-seat-count').textContent`);
    assert.match(seatsText, /座位\s*2\s*\/\s*2/, `两个真人应该是「座位 2 / 2」，实际：${seatsText}`);

    // 圆环语义（用户点名要求三个游戏一致）：自己=蓝、其他真人=橙、人机=灰
    const rings = await a.eval(`
      return Array.prototype.map.call(document.querySelectorAll('#online-panel .frp-avatar'), function (av) {
        return { id: av.getAttribute('data-frp-avatar'), cls: av.className };
      })
    `);
    const mineAvatar = rings.filter((r) => r.id === idA);
    const friendAvatar = rings.filter((r) => r.id === idB);
    assert.equal(mineAvatar.length, 1, `自己的头像应该正好一个：${JSON.stringify(rings)}`);
    assert.match(mineAvatar[0].cls, /is-me/, `自己的圆环应该是蓝的（is-me）：${mineAvatar[0].cls}`);
    assert.equal(friendAvatar.length, 1, `好友的头像应该正好一个：${JSON.stringify(rings)}`);
    assert.match(friendAvatar[0].cls, /is-human/, `其他真人的圆环应该是橙的（is-human）：${friendAvatar[0].cls}`);

    /* ---------- 4.5 互动：点头像 → 扔鸡蛋，两边都要看到特效 ---------- */
    // 甲点乙的头像。⚠️ 头像列表每次推送都会重画，所以点击是**事件代理**在 document 上的。
    await a.eval(`
      return (function () {
        var av = document.querySelector('#online-panel .frp-avatar[data-frp-avatar="${idB}"]');
        if (!av) return false;
        av.click();
        return true;
      })()
    `);
    await a.waitFor(`return !!document.querySelector('.frp-react-menu')`, 8000, '点头像应该弹出「扔鸡蛋 / 送鲜花」');

    const menuBtns = await a.eval(`
      return Array.prototype.map.call(document.querySelectorAll('.frp-react-menu button'), function (b) {
        var r = b.getBoundingClientRect();
        return { text: b.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
      })
    `);
    assert.ok(menuBtns.length >= 2, `菜单里至少要能扔鸡蛋和送鲜花：${JSON.stringify(menuBtns)}`);
    for (const mb of menuBtns) assert.ok(mb.h >= 44, `「${mb.text}」的点击区只有 ${mb.h}px（要 ≥44px）`);

    /*
     * 点「扔鸡蛋」。⚠️ **点击与取值必须在同一次页面求值里做完**：
     * 抛物线是按"出手那一刻的头像位置"算的，中间多一次来回就可能赶上重画。
     *
     * 这里同时钉两件事（用户反馈过"路径别扭、没砸到头像中心"）：
     *   · 起点 = 扔的人自己头像的中心（不是屏幕中间、也不是左上角）
     *   · 飞行物是**按中心**对位的（CSS 里那句 translate(-50%,-50%) 不许被关键帧覆盖）
     */
    const throwFx = await a.eval(`
      return (function () {
        var center = function (el) {
          if (!el) return null;
          var r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        };
        var target = document.querySelector('#online-panel .frp-avatar[data-frp-avatar="${idB}"]');
        var self = document.querySelector('#online-panel .frp-avatar[data-frp-avatar="${idA}"]');
        var btns = document.querySelectorAll('.frp-react-menu button');
        for (var i = 0; i < btns.length; i++) {
          if (/扔鸡蛋/.test(btns[i].textContent)) { btns[i].click(); break; }
        }
        var p = document.querySelector('.frp-fx-layer .frp-fx-projectile');
        return {
          projectile: !!p,
          styleLeft: p ? parseFloat(p.style.left) : null,
          styleTop: p ? parseFloat(p.style.top) : null,
          rendered: p ? center(p) : null,
          self: center(self),
          target: center(target),
        };
      })()
    `);
    assert.ok(throwFx.projectile, '点了「扔鸡蛋」应该立刻出现飞行物');
    assert.ok(throwFx.self && throwFx.target, '甲和乙的头像都应该画在屏幕上（算抛物线要用）');
    assert.ok(
      Math.abs(throwFx.styleLeft - throwFx.self.x) <= 1 && Math.abs(throwFx.styleTop - throwFx.self.y) <= 1,
      `抛物线起点要是扔的人头像中心（${JSON.stringify(throwFx.self)}），实际 ${throwFx.styleLeft},${throwFx.styleTop}`
    );
    assert.ok(
      throwFx.rendered && Math.abs(throwFx.rendered.x - throwFx.self.x) <= 4
        && Math.abs(throwFx.rendered.y - throwFx.self.y) <= 4,
      `飞行物要**按中心**对位（CSS 的 translate(-50%,-50%) 被关键帧覆盖就会偏半个身位）：`
        + `${JSON.stringify(throwFx.rendered)} vs ${JSON.stringify(throwFx.self)}`
    );

    // 被扔的人那边也要出现（服务端广播过去的），并且弹一句"是谁扔的"
    await b.waitFor(`return !!document.querySelector('.frp-fx-layer')`, 5000, '乙的屏幕上也要出现互动特效');
    await b.waitFor(
      `return Array.prototype.some.call(document.querySelectorAll('.frp-toast'), function (t) {
         return /你被扔了一个鸡蛋/.test(t.textContent);
       })`,
      5000,
      '乙应该收到"你被扔了一个鸡蛋"的提示'
    );

    /*
     * 等它飞完、炸开 —— 断言**碎裂特效正好落在对方头像的中心**。
     * ⚠️ 量的必须是**渲染出来的中心**（getBoundingClientRect），不是 style.left：
     *    之前那个"偏半个身位"的 bug 里 style 值是对的，只有渲染位置错了。
     */
    await a.waitFor(`return !!document.querySelector('.frp-fx-layer .frp-fx-burst')`, 4000,
      '鸡蛋飞完应该在对方身上炸开');
    const hit = await a.eval(`
      return (function () {
        var center = function (el) {
          if (!el) return null;
          var r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        };
        var fx = document.querySelector('.frp-fx-layer .frp-fx-burst');
        var target = document.querySelector('#online-panel .frp-avatar[data-frp-avatar="${idB}"]');
        return { fx: center(fx), target: center(target) };
      })()
    `);
    assert.ok(hit.target, '碎裂那一刻对方的头像应该还在屏幕上');
    assert.ok(
      Math.abs(hit.fx.x - hit.target.x) <= 4 && Math.abs(hit.fx.y - hit.target.y) <= 4,
      `碎裂特效要正好落在对方头像中心：特效 ${JSON.stringify(hit.fx)} vs 头像 ${JSON.stringify(hit.target)}`
    );
    await a.screenshot(shot('react-egg.png'));
    console.log(`互动走通：点头像 → 扔鸡蛋 → 双方都看到特效；碎裂落在头像中心（偏差 `
      + `${Math.abs(hit.fx.x - hit.target.x).toFixed(1)}px / ${Math.abs(hit.fx.y - hit.target.y).toFixed(1)}px）`);

    /* ---------- 5. 甲点开始，双方进棋盘 ---------- */
    await a.eval(`
      return (function () {
        var btns = document.querySelectorAll('#online-panel .frp-room-actions button');
        for (var i = 0; i < btns.length; i++) {
          if (/开始游戏/.test(btns[i].textContent)) { btns[i].click(); return true; }
        }
        return false;
      })()
    `);

    for (const [who, page] of [['甲', a], ['乙', b]]) {
      await page.waitFor(
        `return document.getElementById('screen-game').classList.contains('is-active') &&
                document.querySelectorAll('.board-cell').length > 0`,
        15_000,
        `${who} 进到棋盘`
      );
    }

    const before = { a: await boardOf(a), b: await boardOf(b) };
    assert.deepEqual(before.a.board, before.b.board, '开局时两边的棋盘必须一样');

    // 谁执哪一方必须由**服务端**决定，而且两边看到的一定是互补的两方。
    // 顺便把"谁是房主"打出来 —— 这条以前真的错过（房主被判成了客人）。
    const sidesOf = async (page) => page.eval(`
      return {
        mySide: (GameNet.room && GameNet.room.view) ? GameNet.room.view.mySide : null,
        hostId: GameNet.room && GameNet.room.hostId,
        meId: GameNet.me && GameNet.me.id,
        members: ((GameNet.room && GameNet.room.members) || []).map(function (m) {
          return m.id + (m.isHost ? '(房主)' : '');
        }),
        optionHostSide: (window.FrpRoom && FrpRoom.options) ? String(FrpRoom.options.hostSide) : '(无)',
      }
    `);
    const infoA = await sidesOf(a);
    const infoB = await sidesOf(b);
    console.log('甲：', JSON.stringify(infoA));
    console.log('乙：', JSON.stringify(infoB));

    assert.equal(infoA.hostId, infoA.meId, '建房的人应该是房主');
    assert.equal(infoA.meId, idA, '甲的页面拿到的身份应该就是甲');
    assert.equal(infoB.meId, idB, '乙的页面拿到的身份应该就是乙');
    // 房主没主动点过选边按钮时，FrpRoom 的 options 里根本没有 hostSide ——
    // 这是正常的（服务端把缺失当成默认的"大炮方"）。但它**绝不能**是 'ghost'。
    assert.notEqual(infoA.optionHostSide, 'ghost', '房主没改过设置，不该被判成小鬼方');
    assert.notEqual(before.a.me, before.b.me, '两个人不能执同一方');
    assert.equal(before.a.me, before.a.CANNON, '甲（房主，默认选大炮方）执大炮');
    assert.equal(before.b.me, before.b.GHOST, '乙自动执小鬼');
    assert.equal(before.a.turn, before.b.turn, '两边的"该谁走"必须一致');
    assert.equal(before.a.turn, before.a.CANNON, '大炮方先手');
    await a.screenshot(shot('room-playing.png'));
    console.log(`开局：轮到 ${before.a.turn === before.a.CANNON ? '大炮' : '小鬼'}`);

    /* ---------- 6. 甲走一步，乙那边要跟着变 ---------- */
    // 预设 0 上大炮在 (5,2)/(5,3)，往上走一格是空格
    const moved = await a.eval(`
      return (function () {
        if (typeof handleCellClick !== 'function') return 'no-handler';
        var board = gameState.board;
        var from = null;
        for (var c = 0; c < board[5].length; c++) {
          if (board[5][c] === CANNON && board[4][c] === EMPTY) { from = c; break; }
        }
        if (from === null) return 'no-cannon-with-room-above';
        var turnBefore = gameState.currentTurn;
        handleCellClick(5, from);
        var selected = gameState.selectedPiece;
        handleCellClick(4, from);
        return {
          from: from,
          selected: selected ? { r: selected.r, c: selected.c } : null,
          turnBefore: turnBefore,
          // 点完之后**立刻**看一眼本地棋盘：在线对局是服务端权威的，
          // 客户端只发意图、不做预测。所以这里必须还是原样 ——
          // 如果本地马上就动了，说明界面在自己跑规则，那就跟服务端分家了
          landedImmediately: gameState.board[4][from],
          fromImmediately: gameState.board[5][from],
        };
      })()
    `);
    assert.ok(moved && typeof moved === 'object', `甲没能走子：${JSON.stringify(moved)}`);
    assert.ok(moved.selected, '甲点了大炮之后应当被选中（没选中说明点击没接到引擎上）');
    assert.equal(moved.landedImmediately, before.a.EMPTY,
      '客户端不该自己把棋子挪过去 —— 在线对局以服务端下发为准');
    assert.equal(moved.fromImmediately, before.a.CANNON, '客户端也不该自己把原来的格子清掉');

    // 真正的变化要等服务端把裁剪后的 view 发回来
    await a.waitFor(
      `return !!gameState && gameState.board[4][${moved.from}] === CANNON && gameState.board[5][${moved.from}] === EMPTY`,
      10_000,
      '甲等到服务端确认这一步（(4,' + moved.from + ') 有大炮、(5,' + moved.from + ') 空了）'
    );

    await b.waitFor(
      `return !!gameState && gameState.board[4][${moved.from}] === CANNON`,
      10_000,
      '乙那边看到大炮走到了 (4,' + moved.from + ')'
    );

    const after = { a: await boardOf(a), b: await boardOf(b) };
    assert.deepEqual(after.a.board, after.b.board, '走完一步之后两边的棋盘仍然必须一样');
    assert.equal(after.a.turn, after.b.turn, '走完一步之后轮次也一致');

    /* ---------- 7. 轮到乙了，甲再走一步 → 服务端必须拒绝 ---------- */
    // 先确认现在的确轮到小鬼（说明甲那一步被服务端接受了，轮次翻了面）
    const nowTurn = await a.eval(`return gameState.currentTurn`);
    assert.equal(nowTurn, before.a.GHOST, '甲走完之后应该轮到小鬼');

    // 先把服务端回的错误消息接下来，好断言"它真的拒绝了，而且给了人话"
    await a.eval(`
      return (function () {
        window.__lastErr = null;
        GameNet.on(window.FrpProtocol.T.ERROR, function (m) { window.__lastErr = m; });
        return true;
      })()
    `);

    // (a) 正面点：客户端的回合判断会就地拦住，连消息都不发
    const clickedOutOfTurn = await a.eval(`
      return (function () {
        var b = gameState.board;
        for (var c = 0; c < b[4].length; c++) {
          if (b[4][c] === CANNON && b[5][c] === EMPTY) {
            handleCellClick(4, c);
            var sel = gameState.selectedPiece;
            return { selected: sel ? { r: sel.r, c: sel.c } : null, c: c };
          }
        }
        return null;
      })()
    `);
    if (clickedOutOfTurn) {
      assert.equal(clickedOutOfTurn.selected, null,
        '轮不到自己的时候点棋子不该被选中（app.js 的在线回合判断没生效）');
    }

    // (b) 绕过界面：直接朝服务端发一个"轮不到自己"的走子。
    //     这一条才是真正在测服务端 —— 界面拦得住，不代表能把界面改坏的人也拦得住。
    const from = moved.from;
    await a.eval(`
      return (function () {
        GameNet.send(window.FrpProtocol.T.ROOM_ACT, {
          act: { kind: 'move', from: { r: 4, c: ${from} }, to: { r: 5, c: ${from} } },
        });
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 1200));

    const afterOutOfTurn = await boardOf(a);
    assert.equal(afterOutOfTurn.board[4][from], before.a.CANNON, '轮不到的走子被服务端执行了 —— 没拦住');
    assert.equal(afterOutOfTurn.board[5][from], before.a.EMPTY, '轮不到的走子被服务端执行了 —— 没拦住');
    assert.equal(afterOutOfTurn.turn, before.a.GHOST, '轮次不该被这一手改掉');

    const lastErr = await a.eval(`return window.__lastErr`);
    assert.ok(lastErr && typeof lastErr.message === 'string' && lastErr.message.length > 0,
      `服务端拒绝时应该回一条能读的中文原因，实际拿到：${JSON.stringify(lastErr)}`);
    console.log(`服务端拒绝的理由：${lastErr.message}`);

    const errsA = a.errors.filter((e) => !/favicon|net::ERR_/i.test(e));
    const errsB = b.errors.filter((e) => !/favicon|net::ERR_/i.test(e));
    assert.deepEqual(errsA, [], `甲的页面有控制台报错：\n${errsA.join('\n')}`);
    assert.deepEqual(errsB, [], `乙的页面有控制台报错：\n${errsB.join('\n')}`);

    console.log('\n✅ 在线对局真浏览器端到端全部通过');
    console.log('   覆盖：加好友（甲发申请 → 乙在界面上点同意）→ 建房 →');
    console.log('         人机座位（按一下加一个 / 单字名 / 灰圆环 / 真人顶掉人机）→');
    console.log('         圆环语义（自己蓝 / 别人橙）→ 点头像扔鸡蛋（双端特效 + 提示 + ');
    console.log('         抛物线起点=扔的人头像中心、碎裂正好落在对方头像中心）→');
    console.log('         好友列表显示"正在玩"并一键进入 → 房间成员与房主标记 →');
    console.log('         房主开局 → 双方棋盘一致 → 走一步双端同步 → 抢着走被服务端拒绝');
    console.log(`   截图：${shot('room-waiting.png')}`);
  } finally {
    if (a) a.close();
    if (b) b.close();
    if (app && app.close) await app.close();
    try { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

await main();