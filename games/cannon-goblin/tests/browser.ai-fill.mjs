/*
 * 大炮轰小鬼 —— 真浏览器用例：「1 个真人 + 1 个人机座位」的在线对局。
 *
 * 跑：node games/cannon-goblin/tests/browser.ai-fill.mjs
 *     （在仓库根目录 E:\frp-game 下跑，需要本机有 Chrome 或 Edge）
 *     `node tools/check-game.mjs cannon-goblin --browser` 会顺手跑它
 *     （体检脚本按 `tests/browser*.mjs` 这个名字收）。
 *
 * 【为什么必须有一条真浏览器用例】
 * docs/GAME-SPEC.md §4 的验收要求写得明明白白：
 *   一个人建房 → 加一个人机座位 → 开始 → **真的走到"轮到我"**。
 * 这条路上的坑全都只出现在浏览器里：
 *   · 座位不够时「开始游戏」是灰的、要说清"按添加人机补一个"（平台画的）
 *   · 人机是**房间的座位**，成员列表里要有它（灰色虚线圈头像 + 单字名字）
 *   · 棋盘上的对阵条要能从房间成员列表里拿到名字和 isBot 画出可点头像
 *   · 人机那一手要是没被服务端跑完，真人就会永远停在"等待对手行动"
 *   · 一次推送里的两步要靠演出队列**逐步演完**（不是一次成型），且不许卡住界面
 *   · **不做本地预演**（点下去到回包之前棋盘一个像素都不许变）
 *   · **演出期间锁输入**（点棋盘 / 调 submitOnlineMove 都不许发出新的 room.act）
 *   · **演出期间不暗屏**（棋盘的 opacity 必须还是 1、filter 必须是 none；提示只是
 *     右下角一行小字，且那行小字不许挡点击 / 不许遮棋子 / 不许撑出横向滚动条）
 *   · **吃子音效只在真吃子那一步响**（无头环境听不到，所以量 WebAudio 调用与振荡器）
 *   · **首页身份行**（ready 之前靠浏览器里记着的那份身份先画出来、ready 之后对齐、
 *     点 ID 能复制）
 *   · **音效 / 特效只读写平台那一份偏好**（FrpUI.prefs：本作的老键 cg.sound/cg.fx
 *     一个都不许再写；平台那份改了本作要跟着变）
 * 服务端用例（tests/ai-fill.test.mjs）只能证明引擎那一侧，证明不了这些接线。
 *
 * 【为什么自己起一个服务器】
 * 7891 是用户/别的 agent 正在用的那一个，不要打扰它。startServer({ port: 0 }) 起随机端口
 * + 临时数据库，跑完删掉，data/ 一个字节都不动。
 *
 * ⚠️ 故意**不叫** *.test.mjs：根目录的 `npm test` 只收 tests/*.test.mjs，
 *    真浏览器测试慢、还依赖本机装了浏览器，不该被顺手带进那一批。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../../../server/server.mjs';
import { Page, findChrome } from '../../../tools/cdp.mjs';

const SLUG = 'cannon-goblin';
const CANNON = 1;
const GHOST = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面里那个 GameState（app.js 的全局 `let`，任何脚本都读得到）的快照。 */
async function snapshot(page) {
  return page.evalRaw(`return {
    mySide: window.GameNet && window.GameNet.room && window.GameNet.room.view
      ? window.GameNet.room.view.mySide : null,
    viewTurn: window.GameNet && window.GameNet.room && window.GameNet.room.view
      ? window.GameNet.room.view.currentTurn : null,
    viewOver: window.GameNet && window.GameNet.room && window.GameNet.room.view
      ? window.GameNet.room.view.gameOver : null,
    lastMove: window.GameNet && window.GameNet.room && window.GameNet.room.view
      ? window.GameNet.room.view.lastMove : null,
    localTurn: typeof gameState !== 'undefined' && gameState ? gameState.currentTurn : null,
    localSide: typeof playerSide !== 'undefined' ? playerSide : null,
    turnText: (document.getElementById('turn-text') || {}).textContent || '',
    activeScreen: (document.querySelector('.screen.is-active') || {}).id || null,
    cells: document.querySelectorAll('#game-board .board-cell').length,
    pieces: document.querySelectorAll('#game-board .piece').length,
    ghosts: (document.getElementById('ghost-remaining') || {}).textContent || '',
    cannons: (document.getElementById('cannon-remaining') || {}).textContent || '',
  }`);
}

/** 棋盘上某个阵营的棋子坐标（按 view 读，不猜）。 */
async function piecesOf(page, piece) {
  return page.evalRaw(`(() => {
    const view = window.GameNet.room.view;
    const out = [];
    for (let r = 0; r < view.board.length; r++) {
      for (let c = 0; c < view.board[r].length; c++) {
        if (view.board[r][c] === ${piece}) out.push({ r: r, c: c });
      }
    }
    return out;
  })()`);
}

/** 把飘着的提示条点掉 —— 它是 position:fixed，会吃掉按屏幕坐标发的点击。 */
async function dismissToasts(page) {
  for (let i = 0; i < 5; i++) {
    const n = await page.eval(`return document.querySelectorAll('.frp-toast.is-visible').length`);
    if (!n) return;
    await page.click('.frp-toast.is-visible');
    await sleep(150);
  }
}

async function main() {
  if (!findChrome()) {
    console.log('⚠️  本机没找到 Chrome / Edge，跳过这条浏览器用例');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'cg-aifill-'));
  const app = await startServer({ port: 0, dbPath: join(tmpDir, 'browser.db') });
  console.log(`临时服务器起来了：${app.url}（随机端口，不碰 7891）`);
  assert.ok(app.games.has(SLUG), `服务器没有接上 ${SLUG}`);
  assert.deepEqual(app.gameFailures.map((f) => f.file), [], '有游戏模块加载失败');

  let page = null;
  try {
    page = await Page.launch({ headless: true, width: 430, height: 932, mobile: true });

    /* ---------- 1. 在平台首页注册一个账号 ---------- */
    await page.goto(app.url);
    await page.waitFor(`return document.getElementById('screen-auth').classList.contains('is-active')`, 15_000, '登录页出现');
    await page.click('#tab-register');
    await page.setInput('#register-name', '炮');
    await page.setInput('#register-password', 'secret123');
    await page.setInput('#register-password2', 'secret123');
    await page.click('#form-register .btn-primary');
    await page.waitFor(`return !document.getElementById('modal-id').hidden`, 15_000, 'ID 弹窗出现');
    const myId = await page.eval(`return document.getElementById('new-id').textContent`);
    assert.match(myId, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{7}$/, `发放的 ID 不合规：${myId}`);
    await page.click('#btn-id-done');
    await page.waitFor(`return window.GameNet && window.GameNet.connected === true`, 15_000, 'WebSocket 连上');
    console.log(`注册成功，领到 ID：${myId}`);

    /* ---------- 2. 打开游戏页 → 在线对局 ---------- */
    const gameUrl = new URL(`/games/${SLUG}/`, app.url).href;
    await page.goto(gameUrl);
    await page.waitFor(`return !!document.querySelector('.screen.is-active')`, 15_000, '游戏页出现');
    await page.waitFor(`return window.GameNet && window.GameNet.connected === true`, 20_000, '游戏页连上服务器');
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-idle')`, 10_000, '房间入口画出来');

    // 平台的共用脚本必须都挂上（顺序在 tools/check-game.mjs 里另有一条机械检查）
    const libs = await page.evalRaw(`return {
      anim: typeof (window.FrpAnim && window.FrpAnim.push) === 'function',
      react: typeof (window.FrpReact && window.FrpReact.avatarEl) === 'function',
      room: typeof (window.FrpRoom && window.FrpRoom.mount) === 'function',
    }`);
    assert.deepEqual(libs, { anim: true, react: true, room: true }, `共用脚本没挂全：${JSON.stringify(libs)}`);

    // 走真实路径：点菜单上的「在线对局」（第三个按钮）
    await page.click('#screen-menu .menu-btn', { index: 2 });
    await page.waitFor(`return document.getElementById('screen-online-ready').classList.contains('is-active')`, 10_000, '在线对局屏出现');

    /* ---------- 3. 一个人建房（面板会被重画，所以用页面内 click） ---------- */
    const created = await page.evalRaw(`(() => {
      const b = document.querySelector('#online-panel .frp-room-idle .frp-btn-primary');
      if (!b) return null;
      b.click();
      return b.textContent;
    })()`);
    assert.ok(created, '找不到「创建房间」按钮');
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-code-value code')`, 15_000,
      '拿到 6 位房号（点了创建房间没反应？）');
    const code = await page.eval(`return document.querySelector('#online-panel .frp-room-code-value code').textContent`);
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/, `房号格式不对：${code}`);
    const members0 = await page.eval(`return document.querySelectorAll('#online-panel .frp-room-member').length`);
    assert.equal(members0, 1, '现在应当只有房主一个真人');
    console.log(`建房成功：房间号 ${code}，座位 ${members0} 个`);

    /* ---------- 4. 准备区：本游戏不再画「电脑补位」，座位不够时开始按钮是灰的 ---------- */
    const setup = await page.evalRaw(`(() => {
      const panel = document.getElementById('online-panel');
      const box = panel.querySelector('.frp-room-setup');
      const start = panel.querySelector('.frp-room-actions .frp-btn-primary');
      return {
        setupText: box ? box.textContent.replace(/\\s+/g, ' ').trim() : null,
        aifillControls: panel.querySelectorAll('[data-aifill]').length,
        seatCount: (panel.querySelector('.frp-room-seat-count') || {}).textContent || '',
        note: (panel.querySelector('.frp-room-note') || {}).textContent || '',
        hasBotAdd: !!panel.querySelector('.frp-room-bot-add'),
        startDisabled: start ? start.disabled : null,
      };
    })()`);
    assert.ok(setup.setupText !== null, '准备区里没有本游戏的设置区（renderSetup）');
    assert.equal(setup.aifillControls, 0, '「电脑补位」开关已经作废，准备区里不许再有 data-aifill 控件');
    assert.ok(!/电脑补位|补几个电脑/.test(setup.setupText), `设置区里还在提补位：${setup.setupText}`);
    assert.ok(setup.setupText.includes('大炮方'), `设置区里应当还能选边：${setup.setupText}`);
    assert.equal(setup.seatCount.trim(), '座位 1 / 2', `座位数显示不对：${setup.seatCount}`);
    assert.match(setup.note, /至少要 2 个座位/, `座位不够时要说清原因：${setup.note}`);
    assert.match(setup.note, /添加人机/, `要说清怎么办（按「添加人机」）：${setup.note}`);
    assert.equal(setup.hasBotAdd, true, '房主要能按「＋ 添加人机」');
    // 座位不够 → 按钮是灰的（这是**新**的交互：以前是能点、点完被服务端拒）
    assert.equal(setup.startDisabled, true, '只有 1 个座位时「开始游戏」必须是灰的');
    console.log(`准备区：${setup.seatCount}；${setup.note}`);

    /* ---------- 5. 绕过灰按钮直接发 room.start：服务端的拒绝必须**看得见** ---------- */
    // 灰按钮点不动，但"服务端拒绝 → 平台提示条"这条路仍然要通（这条曾经是静默的）。
    await page.evalRaw(`return (function () {
      window.GameNet.send(window.FrpProtocol.T.ROOM_START, {});
      return true;
    })()`);
    await page.waitFor(`return !!document.querySelector('.frp-toast')`, 10_000, '座位不够时被拒的原因要弹出来（不许静默失败）');
    const refused = await page.eval(`return [...document.querySelectorAll('.frp-toast')].map(function (e) { return e.textContent; }).join(' | ')`);
    assert.match(refused, /座位/, `被拒的原因应当提到座位不够，实际：${refused}`);
    const stillWaiting = await page.eval(`return document.getElementById('screen-online-ready').classList.contains('is-active')`);
    assert.equal(stillWaiting, true, '被拒之后应当还留在准备界面，不能进对局屏');
    console.log(`座位不够时点开始 → 提示条：「${refused}」（没有静默失败）`);

    /* ---------- 6. 按「＋ 添加人机」→ 成员里出现一个单字名字的人机座位 ---------- */
    await dismissToasts(page);
    await page.evalRaw(`(() => {
      document.querySelector('#online-panel .frp-room-bot-add').click();
      return true;
    })()`);
    await page.waitFor(`return document.querySelectorAll('#online-panel .frp-room-member').length === 2`, 10_000,
      '按「添加人机」之后成员列表里要多一个座位');

    const bot = await page.evalRaw(`(() => {
      const li = document.querySelector('#online-panel .frp-room-member.is-bot');
      if (!li) return null;
      const av = li.querySelector('.frp-avatar');
      // 可点区域量的是**带 data-frp-avatar 的那个元素**（平台的点击代理就是靠
      // closest('[data-frp-avatar]') 找目标的）；外面那层 .frp-room-avatar-hit 也是 44px。
      // 早先圆本身只有 40px，是刀马报上去之后平台改成 44px 的 —— 两层现在都够。
      const hitEl = li.querySelector('.frp-room-avatar-hit') || av;
      const r = hitEl ? hitEl.getBoundingClientRect() : null;
      return {
        name: (li.querySelector('.frp-room-member-name') || {}).textContent || '',
        // ⚠️ 「人机」这个标记**只在标签上出现一次**（房间外壳刻意去掉了重复：
        //    id 那一格只给真人，右边那一格对非房主的人机留空）。
        tag: (li.querySelector('.frp-room-tag-bot') || {}).textContent || '',
        rowText: li.textContent.replace(/\s+/g, ' ').trim(),
        avatarClass: av ? av.className : null,
        avatarId: av ? av.getAttribute('data-frp-avatar') : null,
        avatarName: av ? av.getAttribute('data-frp-name') : null,
        hit: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
        seatCount: (document.querySelector('#online-panel .frp-room-seat-count') || {}).textContent || '',
        startDisabled: document.querySelector('#online-panel .frp-room-actions .frp-btn-primary').disabled,
      };
    })()`);
    assert.ok(bot, '成员列表里没有 is-bot 那一行');
    assert.match(bot.avatarClass, /frp-avatar/, `人机座位要有头像：${bot.avatarClass}`);
    assert.match(bot.avatarClass, /is-bot/, `人机的圆环必须是灰的那一档（is-bot）：${bot.avatarClass}`);
    assert.match(bot.avatarId, /^bot:/, `人机座位的 id 要带 bot: 前缀：${bot.avatarId}`);
    assert.equal([...bot.name].length, 1, `人机的名字必须是**单字**（头像就一个字），实际：${bot.name}`);
    assert.equal(bot.avatarName, bot.name, 'data-frp-name 要和名字一致（点头像时用它）');
    assert.ok(bot.hit.w >= 44 && bot.hit.h >= 44, `头像的可点区域要 ≥44px：${JSON.stringify(bot.hit)}`);
    assert.equal(bot.tag, '人机', `人机座位要带「人机」标签（一眼看出不是人）：${bot.tag}`);
    assert.ok(
      !/bot:/i.test(bot.rowText),
      `人机座位行里不许出现内部 id「bot:N」（那是内部编号）：${bot.rowText}`
    );
    assert.equal(
      (bot.rowText.match(/人机/g) || []).length, 1,
      `「人机」在一行里只许出现一次（重复显示是观感问题）：${bot.rowText}`
    );
    assert.equal(bot.seatCount.trim(), '座位 2 / 2', `加了人机之后座位数：${bot.seatCount}`);
    assert.equal(bot.startDisabled, false, '座位够了「开始游戏」必须可点');
    console.log(`人机座位进来了：名字「${bot.name}」、圆环 ${bot.avatarClass}、可点区 ${bot.hit.w}×${bot.hit.h}`);

    /* ---------- 7. 地图编辑器走一个来回：确认之后准备区要**强制**重画 ---------- */
    /*
     * 编辑器改的是本游戏的全局变量（`customPositions`），不在 FrpRoom 的"输入指纹"里 ——
     * 所以这里必须走 `render(true)` 强制重画，否则界面是"点了没反应"。
     * 这条用例专门盯着这一点（去重上线之后差点漏掉）。
     */
    await dismissToasts(page);
    await page.evalRaw(`(() => {
      const btns = [...document.querySelectorAll('#online-panel .frp-room-setup button')];
      const edit = btns.find((b) => b.textContent.includes('编辑初始位置'));
      if (!edit) return false;
      edit.click();
      return true;
    })()`);
    await page.waitFor(`return document.getElementById('screen-editor').classList.contains('is-active')`, 10_000,
      '「编辑初始位置」要打开地图编辑器');
    const editorCells = await page.eval(`return document.querySelectorAll('#editor-board .board-cell').length`);
    assert.equal(editorCells, 36, `编辑器棋盘格数：${editorCells}`);
    await page.evalRaw(`(() => { document.querySelector('#screen-editor .start-btn').click(); return true; })()`);
    await page.waitFor(`return document.getElementById('screen-online-ready').classList.contains('is-active')`, 10_000,
      '确认之后要回到在线准备区');
    const afterEditor = await page.eval(`return document.querySelector('#online-panel .frp-room-setup').textContent.replace(/\\s+/g, ' ')`);
    assert.match(afterEditor, /自定义地图/, `确认编辑器之后准备区必须立刻显示"当前用自定义地图"（去重不能把它吞掉）：${afterEditor}`);
    console.log('地图编辑器来回一趟：确认之后准备区立刻显示「自定义地图」（强制重画没被去重吞掉）');

    /* ---------- 8. 开始游戏 → 对局屏 ---------- */
    await dismissToasts(page);
    const started = await page.evalRaw(`(() => {
      const b = document.querySelector('#online-panel .frp-room-actions .frp-btn-primary');
      b.click();
      return b.textContent;
    })()`);
    await page.waitFor(`return document.getElementById('screen-game').classList.contains('is-active')`, 15_000,
      `点了「${started}」之后对局屏要出现`)
      .catch(async (err) => {
        const diag = await page.evalRaw(`(() => ({
          room: window.GameNet.room && { code: window.GameNet.room.code, phase: window.GameNet.room.phase },
          active: (document.querySelector('.screen.is-active') || {}).id,
          toasts: [...document.querySelectorAll('.frp-toast')].map(function (e) { return e.textContent }).join(' | '),
        }))()`);
        throw new Error(`${err.message}\n  诊断：${JSON.stringify(diag)}`);
      });

    await page.waitFor(`return document.querySelectorAll('#game-board .board-cell').length === 36`, 10_000, '6×6 棋盘画出来');
    let snap = await snapshot(page);
    assert.equal(snap.activeScreen, 'screen-game');
    assert.equal(snap.mySide, 'cannon', '房主选了先手的大炮方；这里没选过，就是默认值');
    assert.equal(snap.localSide, CANNON, '界面认为我执大炮');
    assert.equal(snap.viewTurn, 'cannon', '开局就该轮到我（大炮先手）');
    assert.match(snap.turnText, /大炮/, `回合提示要显示轮到我：${snap.turnText}`);
    console.log(`开局了：${snap.cannons} ${snap.ghosts}，回合提示「${snap.turnText}」—— 轮到我`);

    /* ---------- 9. 对阵条：两个可点头像（我=蓝圈、人机=灰虚线圈） ---------- */
    const bar = await page.evalRaw(`(() => {
      const bar = document.getElementById('versus-bar');
      if (!bar) return null;
      const seats = [...bar.querySelectorAll('.vs-seat')].map((s) => {
        const av = s.querySelector('.frp-avatar');
        const r = av ? av.getBoundingClientRect() : null;
        return {
          label: (s.querySelector('.vs-label') || {}).textContent || '',
          avatarClass: av ? av.className : null,
          avatarId: av ? av.getAttribute('data-frp-avatar') : null,
          avatarName: av ? av.getAttribute('data-frp-name') : null,
          hasImg: !!(av && av.querySelector('img.frp-avatar-img')),
          imgSrc: av && av.querySelector('img.frp-avatar-img')
            ? av.querySelector('img.frp-avatar-img').getAttribute('src') : '',
          hit: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
        };
      });
      return { text: bar.textContent.replace(/\\s+/g, ' ').trim(), seats: seats };
    })()`);
    assert.ok(bar, '棋盘页没有对阵条（#versus-bar）');
    assert.equal(bar.seats.length, 2, `对阵条上应当是 2 个座位：${bar.text}`);
    const meSeat = bar.seats.find((s) => s.avatarId === myId);
    const botSeat = bar.seats.find((s) => /^bot:/.test(String(s.avatarId)));
    assert.ok(meSeat, `对阵条上没有我自己（data-frp-avatar=${myId}）：${bar.text}`);
    assert.ok(botSeat, `对阵条上没有人机座位：${bar.text}`);
    assert.match(meSeat.avatarClass, /is-me/, `自己必须是蓝圈（is-me）：${meSeat.avatarClass}`);
    assert.match(botSeat.avatarClass, /is-bot/, `人机必须是灰虚线圈（is-bot）：${botSeat.avatarClass}`);
    // 真人的头像必须是**平台的图片**（没上传也有服务端画的 SVG 默认头像）；人机是单字圆
    assert.ok(meSeat.hasImg, `自己的头像要显示平台图片：${JSON.stringify(meSeat)}`);
    assert.match(meSeat.imgSrc, /^\/avatar\//, `头像图片地址要指向平台：${meSeat.imgSrc}`);
    assert.ok(!botSeat.hasImg, `人机不该有图片头像（单字圆）：${JSON.stringify(botSeat)}`);
    // ⚠️ 可点区域 ≥44px 是平台硬指标（tools/check-game.mjs --browser 会量整个对局屏）
    for (const s of bar.seats) {
      assert.ok(s.hit.w >= 44 && s.hit.h >= 44, `对阵条头像的可点区域要 ≥44px：${JSON.stringify(s)}`);
    }
    assert.match(meSeat.label, /大炮/, `我的标签要写清阵营：${meSeat.label}`);
    assert.match(botSeat.label, /小鬼/, `人机的标签要写清阵营：${botSeat.label}`);
    console.log(`对阵条：${bar.text}`);

    // 点头像 → 平台的互动菜单（扔鸡蛋 / 送鲜花）。互动是平台层实现的，这里只验"接上了"。
    await dismissToasts(page);
    await page.evalRaw(`(() => {
      const av = document.querySelector('#versus-bar .frp-avatar.is-bot');
      av.click();
      return true;
    })()`);
    await page.waitFor(`return !!document.querySelector('.frp-react-menu')`, 5_000, '点头像要弹出互动菜单');
    const menuText = await page.eval(`return (document.querySelector('.frp-react-menu') || {}).textContent || ''`);
    assert.match(menuText, /扔鸡蛋|鸡蛋/, `互动菜单里应当有扔鸡蛋：${menuText}`);
    await page.evalRaw(`(() => {
      const cancel = document.querySelector('.frp-react-cancel');
      if (cancel) cancel.click();
      return true;
    })()`);
    console.log(`点头像弹出互动菜单：「${menuText.replace(/\s+/g, ' ').trim()}」`);

    /* ---------- 10. 音效 / 特效开关：只读写**平台那一份**偏好（FrpUI.prefs） ---------- */
    /*
     * 用户要求："平台设置栏里有总开关，游戏里的开关跟随它，两处不会打架"。
     * 所以本作不再自己存 `cg.sound` / `cg.fx`，只当平台那份偏好的另一个入口：
     * 读它、写它、订阅它。下面把三件事都量出来。
     */
    const prefs0 = await page.evalRaw(`(() => {
      const s = document.querySelector('#screen-game [data-pref="sound"]');
      const f = document.querySelector('#screen-game [data-pref="fx"]');
      const rect = (b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      return {
        soundText: s.textContent, fxText: f.textContent,
        soundRect: rect(s), fxRect: rect(f),
        audioEnabled: AudioManager.enabled,
        platform: { sound: window.FrpUI.prefs.sound(), fx: window.FrpUI.prefs.fx() },
      };
    })()`);
    assert.ok(prefs0.soundRect.h >= 44 && prefs0.soundRect.w >= 44, `音效按钮要 ≥44px：${JSON.stringify(prefs0.soundRect)}`);
    assert.ok(prefs0.fxRect.h >= 44 && prefs0.fxRect.w >= 44, `特效按钮要 ≥44px：${JSON.stringify(prefs0.fxRect)}`);
    assert.equal(prefs0.audioEnabled, true, '默认音效是开的');
    assert.deepEqual(prefs0.platform, { sound: true, fx: true }, '本作一打开就要认平台那一份偏好（FrpUI.prefs）');

    // ① 点本作的开关 → 值落到**平台那一份**（localStorage 的 frp.prefs）；
    //    本作自己的老键 cg.sound / cg.fx **一个都不许再写**（写了就又会跟平台打架）
    await page.evalRaw(`document.querySelector('#screen-game [data-pref="sound"]').click()`);
    await page.waitFor(`return AudioManager.enabled === false`, 3_000, '点了音效开关要立刻生效');
    const afterToggle = await page.evalRaw(`(() => ({
      text: document.querySelector('#screen-game [data-pref="sound"]').textContent,
      platform: JSON.parse(localStorage.getItem('frp.prefs') || '{}'),
      legacy: localStorage.getItem('cg.sound'),
      reactSound: window.FrpReact.isSoundEnabled(),
    }))()`);
    assert.match(afterToggle.text, /关/, `开关文案要跟着变：${afterToggle.text}`);
    assert.equal(afterToggle.platform.sound, false, '开关状态要写进平台那一份（frp.prefs）');
    assert.equal(afterToggle.legacy, null, '本作不许再写自己的老键 cg.sound（平台侧只在第一次读它推默认值）');
    assert.equal(afterToggle.reactSound, false, '平台的互动音效也要一起关（FrpReact.setSound）');

    await page.evalRaw(`document.querySelector('#screen-game [data-pref="fx"]').click()`);
    const afterFx = await page.evalRaw(`(() => ({
      platform: JSON.parse(localStorage.getItem('frp.prefs') || '{}'),
      legacy: localStorage.getItem('cg.fx'),
      animOn: window.FrpAnim.isEnabled(),
      bodyClass: document.body.classList.contains('no-fx'),
    }))()`);
    assert.equal(afterFx.platform.fx, false, '特效开关状态也要写进平台那一份');
    assert.equal(afterFx.legacy, null, '本作不许再写自己的老键 cg.fx');
    assert.equal(afterFx.animOn, false, '关掉特效要连演出队列一起关（FrpAnim.setEnabled）');
    assert.equal(afterFx.bodyClass, true, '关掉特效要挂上 body.no-fx');

    // ② 反过来：在**别的地方**（平台设置栏 / 另一个标签页）改了，本作要跟着变 ——
    //    这条钉的是 `FrpUI.prefs.on(cb)` 那条订阅。不订的话，用户会觉得
    //    "我明明在平台设置里关了，进游戏照样响/照样动"。
    await page.evalRaw(`(() => { window.FrpUI.prefs.setSound(true); window.FrpUI.prefs.setFx(true); return true; })()`);
    const followed = await page.evalRaw(`(() => ({
      audio: AudioManager.enabled,
      anim: window.FrpAnim.isEnabled(),
      soundText: document.querySelector('#screen-game [data-pref="sound"]').textContent,
      fxText: document.querySelector('#screen-game [data-pref="fx"]').textContent,
      bodyClass: document.body.classList.contains('no-fx'),
      reactSound: window.FrpReact.isSoundEnabled(),
    }))()`);
    assert.equal(followed.audio, true, '在平台那一份里打开音效，本作要跟着打开');
    assert.equal(followed.anim, true, '特效同理（FrpAnim 要跟着平台那份走）');
    assert.match(followed.soundText, /音效$/, `本作按钮的文案也要跟着平台那份走：${followed.soundText}`);
    assert.match(followed.fxText, /特效$/, `同上（特效）：${followed.fxText}`);
    assert.equal(followed.bodyClass, false, '打开特效要把 body.no-fx 摘掉');
    assert.equal(followed.reactSound, true, '平台的互动音效也跟着开回来');
    console.log('音效 / 特效开关：只读写平台那一份（frp.prefs），老键 cg.* 一个都没写；平台那份改了本作跟着变');

    /* ---------- 11. 走一步真的：先点自己的大炮，再点高亮的落点 ---------- */
    await dismissToasts(page);
    const cannons = await piecesOf(page, CANNON);
    assert.ok(cannons.length >= 1, '棋盘上应当有大炮');
    const mine = cannons[0];

    /*
     * 探针：把 `queueSteps` 包一层，记下"服务器一次推来几步、分别是谁"。
     * 这是"逐条演出"最直接的证据 —— `busy()` 只能证明"队列在跑"，看不出跑了几步；
     * 而本轮把**本地预演删掉**之后，"第一步还得是**我那一手**"正需要它守着
     * （服务器不发中间帧，我那一手只能靠 online.js 的 pendingMine 拼出来）。
     */
    await page.evalRaw(`(() => {
      if (!window.__cgQueueProbe) {
        const orig = window.queueSteps;
        window.__cgBatches = [];
        window.queueSteps = function (steps) {
          window.__cgBatches.push((steps || []).map(function (s) {
            const lm = s.state && s.state.lastMove;
            return {
              kind: s.kind,
              lastMove: lm ? { fromR: lm.fromR, fromC: lm.fromC, toR: lm.toR, toC: lm.toC } : null,
              capturedPiece: s.capturedPiece === undefined ? null : s.capturedPiece,
            };
          }));
          return orig.apply(this, arguments);
        };
        window.__cgQueueProbe = true;
      }
      window.__cgBatches = [];
      return true;
    })()`);

    await page.click(`#game-board .board-cell[data-r="${mine.r}"][data-c="${mine.c}"]`);
    await page.waitFor(
      `return document.querySelectorAll('#game-board .board-cell.highlight, #game-board .board-cell.capture-highlight').length > 0`,
      5_000,
      '选中棋子后要标出可以走的落点'
    );
    const target = await page.evalRaw(`(() => {
      const el = document.querySelector('#game-board .board-cell.highlight, #game-board .board-cell.capture-highlight');
      return { r: Number(el.dataset.r), c: Number(el.dataset.c) };
    })()`);
    /*
     * 【本轮的新契约】点下去本机**什么都不演** —— 到服务器回包之前，棋盘一个像素
     * 都不许变、队列也不许开始跑。原来这里是"乐观起手"（点下去立刻把目标格点亮 +
     * 起手音效），用户实测**快速连点会把画面演成"所有人都被打死了"**，已整段删除
     * （docs/DECISIONS.md D10）。
     *
     * ⚠️ 点击与取值必须在**同一次页面求值里**做完（下面这个 IIFE）：
     *    本机对局一个来回只有几毫秒，服务端那一帧回来会重画棋盘 ——
     *    分成两次求值的话，中间那几毫秒正好能让回包插进来，前后比较就没意义了。
     *    所以比的是**同一个 JS 任务里**点下去之前 / 之后。
     */
    const afterClick = await page.evalRaw(`(() => {
      const el = document.querySelector('#game-board .board-cell.highlight, #game-board .board-cell.capture-highlight');
      const board = document.getElementById('game-board');
      const htmlBefore = board.innerHTML;
      const stateBefore = JSON.stringify(gameState.board);
      const turnBefore = gameState.currentTurn;
      const busyBefore = window.FrpAnim.busy();
      el.click();
      return {
        busyBefore: busyBefore,
        busyAfter: window.FrpAnim.busy(),
        htmlSame: board.innerHTML === htmlBefore,
        boardSame: JSON.stringify(gameState.board) === stateBefore,
        turnSame: gameState.currentTurn === turnBefore,
        // 预演的遗迹：那个"目标格点亮"的类名一旦回来，这条立刻红
        pendingTargets: document.querySelectorAll('#game-board .board-cell.pending-target').length,
        captureFx: document.querySelectorAll('#game-board .capture-fx').length,
      };
    })()`);
    console.log(`我走了一步：( ${mine.r},${mine.c} ) → ( ${target.r},${target.c} )`);

    assert.equal(afterClick.busyBefore, false, '点下去之前队列必须是空的（不然下面的"没有开始演"不成立）');
    assert.equal(afterClick.busyAfter, false, '点下去本机不许开始演任何东西（不做本地预演）');
    assert.equal(afterClick.htmlSame, true, '点下去到服务器回包之前，棋盘一个像素都不许变');
    assert.equal(afterClick.boardSame, true, '本机不许改权威局面（不吃子、不挪子）');
    assert.equal(afterClick.turnSame, true, '本机不许换回合');
    assert.equal(afterClick.pendingTargets, 0, '「点下去就把目标格点亮」那套预演已经删掉了，不许回来');
    assert.equal(afterClick.captureFx, 0, '也不许在预演里叠吃子残影');
    console.log('点下去本机一片安静（棋盘没变、队列没动），等服务器回包才开演');

    /*
     * 演出队列真的在跑 —— 这是"服务器一次推来两步要逐步演完"的**唯一**直接证据。
     * 我的那一手 + 人机那一手 = 两步，每步 460ms，所以 busy() 会持续近 1 秒。
     */
    await page.waitFor(`return window.FrpAnim.busy() === true`, 5_000,
      '服务器推回来的那一步要进演出队列（没有动画就说明还在"一次成型"）');

    /* ---------- 11b. **演出期间点不动**（本轮的关键防线） ---------- */
    /*
     * 判据是"没有新的 room.act 发出去"：页面里把 `GameNet.send` 包一层计数
     * （online.js 调的正是它，**不是**平台的 `ctx.act` —— 那条路没有平台的 busy 兜底，
     * 所以游戏自己的口子必须自己判）。
     *
     * 这一段**整段在页面里跑**，为的是不跟 120ms 的轮询抢时间：先记下真实的回放窗口，
     * 再往队列尾巴上压一步 600ms 的探针步把窗口拉长，然后在该窗口内点棋盘 +
     * 直接捅一次提交口子。这样"测量时演出确实在跑"是这段自己保证的，不会偶发。
     */
    const lock = await page.evalRaw(`(async () => {
      const Fx = window.FrpAnim;
      const Net = window.GameNet;
      if (!Net.__cgSendPatched) {
        const orig = Net.send.bind(Net);
        Net.__cgActCount = 0;
        Net.send = function (type, payload) {
          if (type === window.FrpProtocol.T.ROOM_ACT) Net.__cgActCount++;
          return orig(type, payload);
        };
        Net.__cgSendPatched = true;
      }
      Net.__cgActCount = 0;

      // 真实回放窗口：服务器刚推回来的那两步正在演
      const realBusy = Fx.busy();
      // 探针步：至少再占 600ms，保证下面的点击一定落在"演出期间"
      Fx.push([{ kind: 'probe' }], function () { return 600; });
      const busyNow = Fx.busy();

      // 找一格**我自己的子**：权威 view 说现在轮到我（不然点它本来也会被"没轮到你"挡掉，
      // 就测不出"演出期间锁输入"这一条了）
      const v = Net.room.view;
      let p = null;
      for (let r = 0; r < v.board.length && !p; r++) {
        for (let c = 0; c < v.board[r].length && !p; c++) {
          if (v.board[r][c] === playerSide) p = { r: r, c: c };
        }
      }
      const boardEl = document.getElementById('game-board');
      const htmlBefore = boardEl.innerHTML;
      const cell = document.querySelector('#game-board .board-cell[data-r="' + p.r + '"][data-c="' + p.c + '"]');
      if (cell) cell.click();                    // 演出期间点棋盘
      const htmlAfter = boardEl.innerHTML;
      // 就算棋盘点击被别的什么东西挡住，提交口子这条路也必须自己判 busy()
      const submitted = window.submitOnlineMove(p.r, p.c, p.r, p.c);

      const style = getComputedStyle(boardEl);
      const hint = getComputedStyle(document.querySelector('.board-wrapper'), '::after');
      const boardRect = boardEl.getBoundingClientRect();
      const wrapRect = document.querySelector('.board-wrapper').getBoundingClientRect();
      return {
        realBusy: realBusy,
        busyNow: busyNow,
        busy: Fx.busy(),
        clickedCell: p,
        bodyBusy: document.body.classList.contains('frp-anim-busy'),
        pointerEvents: style.pointerEvents,
        opacity: style.opacity,
        filter: style.filter,
        hintContent: hint.content,
        hintPointer: hint.pointerEvents,
        roomBelowBoard: Math.round(wrapRect.bottom - boardRect.bottom),
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        htmlSame: htmlAfter === htmlBefore,
        highlights: document.querySelectorAll('#game-board .board-cell.highlight, #game-board .board-cell.capture-highlight').length,
        submitted: submitted,
        acts: Net.__cgActCount,
      };
    })()`);
    assert.equal(lock.realBusy, true, '服务器推回来的那一步应当正在演（真实回放窗口）');
    assert.equal(lock.busyNow, true, '探针步之后队列必须还在跑，否则这条用例量不到东西');
    assert.equal(lock.busy, true, '测量窗口里演出必须还在进行');
    assert.ok(lock.clickedCell, `棋盘上应当有我自己的子（playerSide）：${JSON.stringify(lock.clickedCell)}`);
    assert.equal(lock.bodyBusy, true, '演出期间 <body> 要带 frp-anim-busy（游戏靠它做 CSS 禁点 + 那行小字）');
    assert.equal(lock.pointerEvents, 'none', `演出期间棋盘要禁点（CSS body.frp-anim-busy #game-board）：${lock.pointerEvents}`);
    /*
     * ⚠️ 这一条是**强化**过的（原来是"演出期间棋盘要变灰：opacity < 1"）。
     * 用户原话："动画播放时你为了防止用户操作直接暗屏是什么意思？不要忽然暗屏" ——
     * 所以现在反过来钉住"**演出期间颜色一点都没变**"：谁再把 opacity / filter 加回去，
     * 这条立刻红。锁输入只剩 pointer-events（以及 JS 那道闸，见下面两条断言）。
     */
    assert.equal(Number(lock.opacity), 1, `演出期间棋盘**不许**变暗（用户："不要忽然暗屏"）：opacity=${lock.opacity}`);
    assert.equal(lock.filter, 'none', `演出期间棋盘也不许用 filter 变灰/变暗：filter=${lock.filter}`);
    // 提示改成棋盘右下角的一行小字：纯 CSS 伪元素、不挡点击、压在棋盘外面、不撑出横向滚动条
    assert.match(String(lock.hintContent), /演出中，请稍候/, `演出期间要有「演出中，请稍候…」那行小字：${lock.hintContent}`);
    assert.equal(lock.hintPointer, 'none', '那行小字不许挡点击（pointer-events: none）');
    assert.ok(lock.roomBelowBoard >= 24, `棋盘下面要留得下那行小字（不然会遮住棋子）：实测只剩 ${lock.roomBelowBoard}px`);
    assert.ok(lock.pageOverflow <= 1, `那行小字不许撑出横向滚动条：实测溢出 ${lock.pageOverflow}px`);
    assert.equal(lock.htmlSame, true, '演出期间点棋盘，画面一个像素都不许变');
    assert.equal(lock.highlights, 0, '演出期间连"选中棋子 / 显示可走点"都不做（这张盘马上要变）');
    assert.equal(lock.submitted, false, '演出期间 submitOnlineMove 要当成没点（返回 false）');
    assert.equal(lock.acts, 0, '演出期间一条新的 room.act 都不许发出去');
    console.log(
      `演出期间点棋盘 (${lock.clickedCell.r},${lock.clickedCell.c}) + 直接捅提交口子：` +
      `room.act 发出 ${lock.acts} 条（要求 0）、body.frp-anim-busy=${lock.bodyBusy}、棋盘 pointer-events=${lock.pointerEvents}`
    );
    console.log(
      `演出期间棋盘颜色没变（opacity=${lock.opacity}、filter=${lock.filter}），只在右下角浮了一行「演出中，请稍候…」` +
      `（pointer-events=${lock.hintPointer}、棋盘下方余量 ${lock.roomBelowBoard}px、页面横向溢出 ${lock.pageOverflow}px）`
    );

    // 服务器把「我这一手 + 人机那一手」在**同一帧**推回来：回合又回到我手上
    // ⚠️ waitFor 会把这段包进 `(() => { … })()`，所以只能写「语句 + return 条件」，
    //    不要再套一层 IIFE —— 套了的话它的返回值会被丢掉，条件永远是 undefined。
    await page.waitFor(
      `const v = window.GameNet.room && window.GameNet.room.view;
       if (!v || !v.lastMove || v.gameOver) return false;
       const mine = (v.lastMove.toR === ${target.r} && v.lastMove.toC === ${target.c});
       return v.currentTurn === v.mySide && !mine;`,
      15_000,
      '人机那一手必须由服务端当场跑完 —— 否则真人会永远停在"等待对手行动"'
    ).catch(async (err) => {
      const diag = await page.evalRaw(`(() => {
        const v = window.GameNet.room && window.GameNet.room.view;
        return {
          view: v ? { turn: v.currentTurn, mySide: v.mySide, over: v.gameOver, lastMove: v.lastMove } : null,
          phase: window.GameNet.room && window.GameNet.room.phase,
          localTurn: typeof gameState !== 'undefined' && gameState ? gameState.currentTurn : null,
          localLastMove: typeof gameState !== 'undefined' && gameState ? gameState.lastMove : null,
          toasts: [...document.querySelectorAll('.frp-toast')].map(function (e) { return e.textContent }).join(' | '),
        };
      })()`);
      throw new Error(`${err.message}\n  诊断：${JSON.stringify(diag)}\n  控制台：${page.errors.join(' | ')}`);
    });
    snap = await snapshot(page);
    assert.equal(snap.viewTurn, snap.mySide, 'act 返回后回合必须已经回到真人身上');
    const opponentSide = snap.mySide === 'cannon' ? GHOST : CANNON;
    const opponentPiece = await page.evalRaw(`return window.GameNet.room.view.board[${snap.lastMove.toR}][${snap.lastMove.toC}]`);
    assert.equal(opponentPiece, opponentSide, '最后一次落子必须是人机那一方走的（它自己动的，没人催）');
    console.log(
      `人机自己回了一手：( ${snap.lastMove.fromR},${snap.lastMove.fromC} ) → ` +
      `( ${snap.lastMove.toR},${snap.lastMove.toC} )，又轮到我了`
    );

    /*
     * 演出结束后画面必须落到**权威局面**上（演出中途用的是自己的快照）：
     * 棋子数、回合提示都要和 view 对得上。这条能抓住"动画把界面画歪了"。
     */
    const expectedPieces = await page.evalRaw(`(() => {
      const v = window.GameNet.room.view;
      let n = 0;
      for (const row of v.board) for (const cell of row) if (cell !== 0) n++;
      return n;
    })()`);
    await page.waitFor(
      `return window.FrpAnim.busy() === false
        && document.querySelectorAll('#game-board .piece').length === ${expectedPieces}`,
      15_000,
      `演出期间没卡住，演完之后棋盘要如实反映服务器那一帧（应当 ${expectedPieces} 个棋子）`
    );
    const settled = await page.evalRaw(`return {
      pieces: document.querySelectorAll('#game-board .piece').length,
      fxLeft: document.querySelectorAll('#game-board .capture-fx').length,
      ghosts: document.getElementById('ghost-remaining').textContent,
      turnText: document.getElementById('turn-text').textContent,
      localTurn: gameState.currentTurn,
    }`);
    assert.match(settled.turnText, /大炮/, `演完之后回合提示要回到我这边：${settled.turnText}`);
    assert.equal(settled.localTurn, CANNON, '演完之后界面手里的局面也要是服务器那一帧');
    console.log(`演出收尾：${settled.pieces} 个棋子、残影 ${settled.fxLeft} 个、${settled.ghosts}、回合提示「${settled.turnText}」`);

    /*
     * 锁是"演出期间"的，不是永久的：演完必须自己松开（不然玩家再也点不动了）。
     * 功能上的证据在下一步（真的又发出去一条 room.act），这里先把 CSS 那两样看掉。
     */
    const unlocked = await page.evalRaw(`(() => {
      const style = getComputedStyle(document.getElementById('game-board'));
      return {
        bodyBusy: document.body.classList.contains('frp-anim-busy'),
        pointerEvents: style.pointerEvents,
        opacity: style.opacity,
        hintContent: getComputedStyle(document.querySelector('.board-wrapper'), '::after').content,
      };
    })()`);
    assert.equal(unlocked.bodyBusy, false, '演出排空后 <body> 不许再带 frp-anim-busy');
    assert.notEqual(unlocked.pointerEvents, 'none', '演出排空后棋盘必须能点');
    assert.equal(Number(unlocked.opacity), 1, `演出排空后棋盘要恢复正常：opacity=${unlocked.opacity}`);
    assert.equal(String(unlocked.hintContent), 'none', '演出排空后那行小字要自己消失（纯 CSS，不需要 JS 清理）');
    console.log('演出排空之后锁自己松开了（body 类名摘掉、棋盘恢复可点、那行小字也自己没了）');

    /*
     * ---------- 11c. 逐条演出的直接证据：一次 room.state 里是**两步** ----------
     * 人机那一手是服务端在同一次 act 里同步跑完的，所以客户端**在一条报文里**
     * 收到两步（我一手 + 人机一手）。
     * ⚠️ 删掉本地预演之后更要盯着第一步：服务器从不发中间帧，"我那一手"只能靠
     * online.js 的 pendingMine + 上一帧 view 拼出来。它要是被当成预演一起删干净了，
     * 这里就只剩一步 —— 我那一手的滑动与吃子音会整段消失。
     */
    const batches = await page.evalRaw(`return window.__cgBatches`);
    const twoStep = (batches || []).find((b) => b.length === 2);
    assert.ok(twoStep, `服务器一次推来两步（我一手 + 人机一手），要拆成两步逐个演完：${JSON.stringify(batches)}`);
    assert.deepEqual(
      twoStep[0].lastMove,
      { fromR: mine.r, fromC: mine.c, toR: target.r, toC: target.c },
      `第一步必须还是"我那一手"（靠 pendingMine 拼的中间画面）：${JSON.stringify(twoStep)}`
    );
    assert.deepEqual(twoStep[1].lastMove, snap.lastMove, `第二步是服务器最后落下的那一手：${JSON.stringify(twoStep)}`);
    console.log(
      `一次 room.state 拆成 ${twoStep.length} 步逐个演完：先是我的 ` +
      `( ${mine.r},${mine.c} )→( ${target.r},${target.c} )，再是服务器的 ( ${snap.lastMove.fromR},${snap.lastMove.fromC} )→( ${snap.lastMove.toR},${snap.lastMove.toC} )`
    );

    /* ---------- 12. 再走一步，确认这个循环能一直转 ---------- */
    await dismissToasts(page);
    // 从零数一遍 room.act：这一步要**真的发出去**，才说明 11b 那把锁已经松开
    // （只锁"演出期间"，不是把玩家永久锁死）。
    await page.evalRaw(`(() => { window.GameNet.__cgActCount = 0; return true; })()`);
    const before2 = await page.eval(`const lm = window.GameNet.room.view.lastMove;
      return lm ? [lm.fromR, lm.fromC, lm.toR, lm.toC] : null;`);
    const key2 = JSON.stringify(before2);
    const cannons2 = await piecesOf(page, CANNON);
    let moved2 = false;
    for (const piece of cannons2) {
      await page.click(`#game-board .board-cell[data-r="${piece.r}"][data-c="${piece.c}"]`);
      const has = await page.eval(`return document.querySelectorAll('#game-board .board-cell.highlight, #game-board .board-cell.capture-highlight').length > 0`);
      if (!has) continue;
      await page.click('#game-board .board-cell.highlight, #game-board .board-cell.capture-highlight');
      moved2 = true;
      break;
    }
    assert.equal(moved2, true, '应当至少有一个大炮能走');
    // ⚠️ 条件必须写成"最后一手**变了**"，不能只写"回合在我这里"——
    //    第二步点下去之前那一条就已经成立了，waitFor 会立刻返回，
    //    等于什么都没等（曾经就这么骗过一次）。
    await page.waitFor(
      `const v = window.GameNet.room && window.GameNet.room.view;
       if (!v) return false;
       if (v.gameOver) return true;
       const lm = v.lastMove;
       if (!lm) return false;
       const key = JSON.stringify([lm.fromR, lm.fromC, lm.toR, lm.toC]);
       return key !== ${JSON.stringify(key2)} && v.currentTurn === v.mySide;`,
      15_000,
      '第二步之后，服务器要连着把人机那一手也推回来（最后一手必须换人）'
    );
    const snap2 = await snapshot(page);
    assert.equal(snap2.viewTurn, snap2.mySide, '第二步之后回合必须又回到我手上');
    const actsInStep2 = await page.eval(`return window.GameNet.__cgActCount`);
    assert.ok(actsInStep2 >= 1, `演出演完之后必须能重新操作（第二步要真的发出 room.act）：实际发了 ${actsInStep2} 条`);
    console.log(`第二步也走通了（发了 ${actsInStep2} 条 room.act —— 锁只在演出期间），最后一手：${JSON.stringify(snap2.lastMove)}`);

    // 演出期间界面不能卡住：队列要能自己跑空
    await page.waitFor(`return window.FrpAnim.busy() === false`, 15_000, '演出队列最后要自己跑空，不许卡在演出里');

    /* ---------- 13. 单机人机：同一套渲染 + 演出，对阵条退回纯标记 ---------- */
    /*
     * 用户对动画的要求是**两种模式都要**（本地人机 + 联机共用同一套渲染代码）。
     * 所以这里把单机那半条路也真点一遍：
     *   · 对阵条不再画可点头像（单机没有玩家 id），退回"你 / 电脑"的纯标记
     *   · 我走一步 → 演出跑起来 → 电脑回一手 → 回合回到我手上
     * 走真实路径太重（要先点退出、还要处理 confirm 弹窗），所以直接调页面上的
     * showScreen/selectSide/startAIGame —— 这一屏本来就是"点菜单进来"的效果。
     */
    await page.evalRaw(`(() => {
      showScreen('ai-setup');
      selectSide('cannon');
      window.startAIGame();
      return true;
    })()`);
    await page.waitFor(`return document.querySelectorAll('#game-board .board-cell').length === 36
      && typeof gameState !== 'undefined' && gameState && gameState.currentTurn === playerSide`, 10_000,
      '单机人机开局（我执大炮，先手）');

    const aiBar = await page.evalRaw(`(() => {
      const bar = document.getElementById('versus-bar');
      return {
        text: bar.textContent.replace(/\\s+/g, ' ').trim(),
        avatars: bar.querySelectorAll('.frp-avatar').length,
        seats: bar.querySelectorAll('.vs-seat').length,
      };
    })()`);
    assert.equal(aiBar.seats, 2, `单机也要有对阵条（两个座位）：${aiBar.text}`);
    assert.equal(aiBar.avatars, 0, '单机没有玩家 id，不许画可点头像（那会点出"对 undefined 扔鸡蛋"）');
    assert.match(aiBar.text, /你/, `单机的座位标记要写「你」：${aiBar.text}`);
    assert.match(aiBar.text, /电脑/, `单机的另一个座位要写「电脑」：${aiBar.text}`);
    console.log(`单机对阵条（纯标记）：${aiBar.text}`);

    const localPiece = await page.evalRaw(`(() => {
      for (let r = 0; r < gameState.height; r++) {
        for (let c = 0; c < gameState.width; c++) if (gameState.getPiece(r, c) === ${CANNON}) return { r: r, c: c };
      }
      return null;
    })()`);
    await page.click(`#game-board .board-cell[data-r="${localPiece.r}"][data-c="${localPiece.c}"]`);
    await page.waitFor(`return document.querySelectorAll('#game-board .board-cell.highlight').length > 0`, 5_000,
      '单机也要标出落点');
    await page.click('#game-board .board-cell.highlight');
    await page.waitFor(`return window.FrpAnim.busy() === true`, 5_000, '单机走子也要走演出队列（两种模式共用同一套）');
    // 一步演完之后电脑会在 400ms 的"思考停顿"后接手，然后演出再跑一遍，最后回到我手上
    await page.waitFor(
      `return typeof gameState !== 'undefined' && gameState
        && gameState.currentTurn === playerSide && window.FrpAnim.busy() === false
        && document.getElementById('game-over-modal').style.display !== 'flex'`,
      20_000,
      '单机：电脑要自己接手并把回合还给我'
    ).catch(async (err) => {
      const diag = await page.evalRaw(`return {
        turn: gameState.currentTurn, my: playerSide, over: gameState.gameOver,
        lastMove: gameState.lastMove, busy: window.FrpAnim.busy(),
        status: document.getElementById('game-status').textContent,
      }`);
      throw new Error(`${err.message}\n  诊断：${JSON.stringify(diag)}`);
    });
    const localAfter = await page.evalRaw(`return {
      turn: document.getElementById('turn-text').textContent,
      pieces: document.querySelectorAll('#game-board .piece').length,
      lastMove: gameState.lastMove,
    }`);
    assert.match(localAfter.turn, /大炮/, `单机演完之后回合提示要回到我这边：${localAfter.turn}`);
    console.log(`单机人机也走通了：电脑回了一手 ${JSON.stringify(localAfter.lastMove)}，${localAfter.pieces} 个棋子`);

    /* ---------- 14. 吃子音效：只在**真吃子那一步**响（用户第 3 条反馈） ---------- */
    /*
     * 【无头浏览器听不到声音，"响了"怎么证】
     * 证的是"WebAudio 真的被调用到了"，两层观测：
     *   · `AudioManager.playMove` / `playCapture` 各包一层计数，把**调用当时的开关状态**
     *     一起记下来（音效关掉时函数照样会被调，但第一行 `if (!this.enabled) return;`）；
     *   · `AudioManager.ctx.createOscillator` 也包一层 —— 这才是"有没有真的出声"的物理证据
     *     （每个音效都必须建振荡器才会响）。音效关掉时这个计数必须一动不动。
     *
     * 局面是**自己摆的**（本地双人模式，不走服务器，完全确定）：(4,0) 的大炮隔着
     * (4,1) 这个空格，正好能吃掉 (4,2) 的小鬼；普通走子则是往 (3,0) 走一格。
     * 规则见 js/engine/rules.js 的 getCaptureMoves。
     */
    const soundProbe = await page.evalRaw(`(() => {
      if (!window.__cgSound) {
        window.__cgSound = { move: [], capture: [] };
        window.__cgOsc = 0;
        const A = AudioManager;
        const wrap = (name, key) => {
          const orig = A[name].bind(A);
          A[name] = function () {
            window.__cgSound[key].push(A.enabled === true);
            return orig();
          };
        };
        wrap('playMove', 'move');
        wrap('playCapture', 'capture');
        // 物理证据那一层：每个音效都要 createOscillator 才会出声
        if (!A.ctx) A.init();
        if (A.ctx && !A.ctx.__cgOscPatched) {
          const make = A.ctx.createOscillator.bind(A.ctx);
          A.ctx.createOscillator = function () { window.__cgOsc++; return make(); };
          A.ctx.__cgOscPatched = true;
        }
      }
      return { hasCtx: Boolean(AudioManager.ctx), enabled: AudioManager.enabled };
    })()`);
    assert.equal(soundProbe.enabled, true, '这一节要在音效开着的前提下做（前面把开关开回来了）');
    assert.equal(soundProbe.hasCtx, true, 'AudioManager 应当已经建过 AudioContext（前面点过很多次按钮）');

    /**
     * 摆一张"大炮 (4,0) 隔着空格 (4,1) 吃小鬼 (4,2)"的小盘，并把音效探针清零。
     *
     * ⚠️ 摆盘之前**必须等上一步的演出跑完**：`resetPlaybackState()` 只是 `FrpAnim.clear()`
     * 清队列，"正在演的那一步"要等它自己收尾 —— 没排空的话棋盘点击会被锁输入挡掉
     * （这个坑是本文件第 14 节自己撞出来的：点不出可走点，`.capture-highlight` 是 null）。
     */
    async function armCaptureBoard() {
      return page.evalRaw(`(async () => {
        const t0 = Date.now();
        while (window.FrpAnim.busy() && Date.now() - t0 < 5_000) {
          await new Promise(function (r) { setTimeout(r, 16); });
        }
        const W = 5, H = 5;
        const board = [];
        for (let r = 0; r < H; r++) board.push(new Array(W).fill(0));
        board[4][0] = ${CANNON};
        board[4][2] = ${GHOST};
        customPositions = { width: W, height: H, board: board };
        customSource = 'local';
        startLocalGame();
        window.__cgSound.move = [];
        window.__cgSound.capture = [];
        window.__cgOsc = 0;
        return { mode: gameMode, turn: gameState.currentTurn, busy: window.FrpAnim.busy() };
      })()`);
    }

    /* 14a. 空走一步：响落子音，**不许**响吃子音 */
    const armed = await armCaptureBoard();
    assert.equal(armed.mode, 'local', '这一段用本地双人模式摆盘（不走服务器，结果完全确定）');
    assert.equal(armed.busy, false, '重摆一张盘之后队列必须是空的（否则音效计数会被上一批演出污染）');
    const plain = await page.evalRaw(`(() => {
      document.querySelector('#game-board .board-cell[data-r="4"][data-c="0"]').click();   // 选中大炮
      const cap = document.querySelectorAll('#game-board .board-cell.capture-highlight').length;
      window.__cgOsc = 0;                                                                  // 只量接下来这一步
      document.querySelector('#game-board .board-cell[data-r="3"][data-c="0"]').click();   // 空走一格
      return {
        captureHighlights: cap,
        move: window.__cgSound.move.slice(),
        capture: window.__cgSound.capture.slice(),
        osc: window.__cgOsc,
        busy: window.FrpAnim.busy(),
      };
    })()`);
    assert.equal(plain.captureHighlights, 1, '这张盘上 (4,2) 应当是唯一可吃的目标（隔着 (4,1) 这个空格）');
    assert.deepEqual(plain.move, [true], '空走一步要在那一步响一次落子音（音效开关是开的）');
    assert.deepEqual(plain.capture, [], '空走一步**不许**响吃子音');
    assert.ok(plain.osc >= 1, `落子音要真的建了振荡器才会出声：${plain.osc}`);
    assert.equal(plain.busy, true, '这一步要进演出队列（音效是"演这一步"时响的）');
    console.log(`空走一步：落子音 ×1（振荡器 ${plain.osc} 个）、吃子音 0 次`);

    /* 14b. 真吃子：响吃子音（+碎裂残影），不叠落子音 */
    await page.waitFor(`return window.FrpAnim.busy() === false`, 10_000, '普通走子的演出要自己跑完');
    await armCaptureBoard();
    const eat = await page.evalRaw(`(() => {
      document.querySelector('#game-board .board-cell[data-r="4"][data-c="0"]').click();   // 选中大炮
      window.__cgOsc = 0;
      const cap = document.querySelector('#game-board .board-cell.capture-highlight');
      const coords = { r: Number(cap.dataset.r), c: Number(cap.dataset.c) };
      cap.click();                                                                         // 跳吃 (4,2)
      return {
        coords: coords,
        move: window.__cgSound.move.slice(),
        capture: window.__cgSound.capture.slice(),
        osc: window.__cgOsc,
        fx: document.querySelectorAll('#game-board .capture-fx').length,
      };
    })()`);
    assert.deepEqual(eat.coords, { r: 4, c: 2 }, `吃子目标应当是 (4,2)：${JSON.stringify(eat.coords)}`);
    assert.deepEqual(eat.capture, [true], '吃子那一步要响一次吃子音');
    assert.deepEqual(eat.move, [], '吃子那一步不叠落子音（两个音一起出来会糊）');
    assert.ok(eat.osc >= 2, `吃子音要真的建了振荡器（playCapture 建两个）：${eat.osc}`);
    assert.ok(eat.fx >= 1, '吃子的碎裂残影也要留着（用户说"改的还行"，动画一个字都别删）');
    console.log(`真吃子一步：吃子音 ×1（振荡器 ${eat.osc} 个）、碎裂残影 ${eat.fx} 个，落子音 0 次`);

    /* 14c. 音效开关关掉：一个振荡器都不许建 */
    await page.waitFor(`return window.FrpAnim.busy() === false`, 10_000, '吃子的演出要自己跑完');
    await page.evalRaw(`(() => { document.querySelector('#screen-game [data-pref="sound"]').click(); return true; })()`);
    await page.waitFor(`return AudioManager.enabled === false`, 3_000, '音效开关要立刻生效');
    await armCaptureBoard();
    const muted = await page.evalRaw(`(() => {
      document.querySelector('#game-board .board-cell[data-r="4"][data-c="0"]').click();
      window.__cgOsc = 0;
      document.querySelector('#game-board .board-cell.capture-highlight').click();
      return {
        enabled: AudioManager.enabled,
        move: window.__cgSound.move.slice(),
        capture: window.__cgSound.capture.slice(),
        osc: window.__cgOsc,
      };
    })()`);
    assert.equal(muted.enabled, false, '这一节的前提：音效开关已经关掉');
    assert.deepEqual(muted.capture, [false], '关掉音效后 playCapture 还是会被调，但那一刻开关是 false（函数第一行就 return）');
    assert.equal(muted.osc, 0, '关掉音效后一个振荡器都不许建 —— 这才是"没出声"的物理证据');
    // 开回来，别影响后面的用例（开的那一下本身会给一声点击音）
    await page.evalRaw(`(() => { document.querySelector('#screen-game [data-pref="sound"]').click(); return true; })()`);
    await page.waitFor(`return AudioManager.enabled === true`, 3_000, '音效开关能开回来');
    console.log('音效关掉之后：吃子那一步一次声音都没出（振荡器 0 个）');

    /* 14d. 音效与特效是**两个**开关：特效关掉（不滑、不碎）时声音照样该在 */
    await page.evalRaw(`(() => { document.querySelector('#screen-game [data-pref="fx"]').click(); return true; })()`);
    await page.waitFor(`return window.FrpAnim.isEnabled() === false`, 3_000, '特效开关要立刻生效');
    await armCaptureBoard();
    const noFx = await page.evalRaw(`(() => {
      document.querySelector('#game-board .board-cell[data-r="4"][data-c="0"]').click();
      window.__cgOsc = 0;
      document.querySelector('#game-board .board-cell.capture-highlight').click();
      return {
        animOn: window.FrpAnim.isEnabled(),
        soundOn: AudioManager.enabled,
        move: window.__cgSound.move.slice(),
        capture: window.__cgSound.capture.slice(),
        osc: window.__cgOsc,
        fx: document.querySelectorAll('#game-board .capture-fx').length,
      };
    })()`);
    assert.equal(noFx.animOn, false, '这一节的前提：特效已经关掉');
    assert.equal(noFx.soundOn, true, '音效还开着');
    assert.deepEqual(noFx.capture, [true], '特效关掉不该把吃子音一起掐掉（两个开关是分开的）');
    assert.ok(noFx.osc >= 2, `特效关掉时吃子音照样要真的建振荡器：${noFx.osc}`);
    assert.equal(noFx.fx, 0, '特效关掉时不该有碎裂残影（只关动画，不关声音）');
    await page.evalRaw(`(() => { document.querySelector('#screen-game [data-pref="fx"]').click(); return true; })()`);
    await page.waitFor(`return window.FrpAnim.isEnabled() === true`, 3_000, '特效开关能开回来');
    console.log('特效关掉、音效还开着：吃子音照样响（振荡器 ' + noFx.osc + ' 个），碎裂残影 0 个');

    /* ---------- 15. 首页身份行：你：X · ID Y（立刻显示 + 点 ID 复制） ---------- */
    /*
     * 用户发现本作首页没有名字/ID（另外两个游戏都有）。名字与 ID 都来自平台账号
     * （docs/GAME-SPEC.md §6），打开页面必须**立刻**就有 —— 先读浏览器里记着的那份身份
     * （GameNet.cachedMe），ready 到了再以 GameNet.me 对齐（公网握手要 2~3 秒，
     * 等它就是一段"我是谁？"的空白）。
     *
     * 两条路都要量：② 的做法是**模拟"ready 还没到"** —— `net.me` 只有 ready 才会填
     * （shared/net/net.js 刻意不拿缓存预填它），把它清掉再看那一行是从哪儿来的，完全确定，
     * 不跟连接速度赛跑。用完立刻还原（真的身份 + 真的缓存）。
     *
     * ⚠️ 先切回菜单屏再量：`getBoundingClientRect()` 在 display:none 的屏幕上恒为 0，
     *    量出来的 44px 就成了 0×0（体检脚本那条"先 finish 动画再量"是同一个坑家族）。
     */
    await page.evalRaw(`(() => { showScreen('menu'); return true; })()`);
    await page.waitFor(`return document.getElementById('screen-menu').classList.contains('is-active')`, 5_000,
      '回菜单屏量身份行');
    const meRow = await page.evalRaw(`(() => {
      const nameEl = document.getElementById('menu-me-name');
      const idEl = document.getElementById('menu-me-id');
      if (!nameEl || !idEl) return null;
      const r = idEl.getBoundingClientRect();
      const real = window.GameNet.me;
      const raw = localStorage.getItem('frp.me');
      const fromServer = { name: nameEl.textContent, id: idEl.textContent };

      // ① ready 还没到（net.me 是空的），但浏览器里记着身份 → 必须**立刻**画得出来
      window.GameNet.me = null;
      localStorage.setItem('frp.me', JSON.stringify({ id: 'ZZZZZZZ', name: '甲' }));
      renderMeLine();
      const fromCache = { name: nameEl.textContent, id: idEl.textContent };

      // ② 还原（真的身份 / 真的缓存），那一行要再对齐回服务端那份
      if (raw === null) localStorage.removeItem('frp.me');
      else localStorage.setItem('frp.me', raw);
      window.GameNet.me = real;
      renderMeLine();
      const restored = { name: nameEl.textContent, id: idEl.textContent };

      return {
        fromServer: fromServer, fromCache: fromCache, restored: restored,
        hit: { w: Math.round(r.width), h: Math.round(r.height) },
        cached: window.GameNet.cachedMe(),
      };
    })()`);
    assert.ok(meRow, '首页没有身份行（#menu-me-name / #menu-me-id）');
    assert.match(meRow.fromServer.name, /你：.*炮/, `身份行要写「你：<名字>」：${meRow.fromServer.name}`);
    assert.equal(meRow.fromServer.id, 'ID ' + myId, `身份行要写「ID <ID>」：${meRow.fromServer.id}`);
    assert.ok(meRow.hit.w >= 44 && meRow.hit.h >= 44, `ID 那颗按钮的可点区域要 ≥44px：${JSON.stringify(meRow.hit)}`);
    assert.equal(meRow.fromCache.name, '你：甲', `ready 还没到时要用浏览器里记着的那份身份**立刻**画出来：${meRow.fromCache.name}`);
    assert.equal(meRow.fromCache.id, 'ID ZZZZZZZ', `同上（ID 那一半）：${meRow.fromCache.id}`);
    assert.deepEqual(meRow.restored, meRow.fromServer, 'ready 到了要以 GameNet.me 对齐（缓存只是显示层的提前）');
    assert.deepEqual(meRow.cached, { id: myId, name: '炮' }, `浏览器里要记着身份（frp.me）：${JSON.stringify(meRow.cached)}`);
    console.log(
      `首页身份行：ready 之前先用缓存显示「${meRow.fromCache.name} · ${meRow.fromCache.id}」，` +
      `ready 之后对齐成「${meRow.fromServer.name} · ${meRow.fromServer.id}」（可点区 ${meRow.hit.w}×${meRow.hit.h}）`
    );

    // 点一下 ID 要能复制（走平台共用的 FrpUI.copyText，本作不自己写 clipboard）。
    // 无头浏览器里把剪贴板读回来不稳（要额外授权、还看安全上下文），所以量两件确定的事：
    //   ① 真的把**纯 ID**交给了平台那个复制函数（FrpUI.copyText → GameNet.copy）；
    //   ② 界面上弹出了复制结果（成功是「已复制玩家 ID」，失败会把内容带出来让人手抄）。
    await page.evalRaw(`(() => {
      if (!window.__cgCopied) {
        window.__cgCopied = [];
        const orig = window.GameNet.copy.bind(window.GameNet);
        window.GameNet.copy = function (text) { window.__cgCopied.push(String(text)); return orig(text); };
      }
      window.__cgCopied = [];
      document.getElementById('menu-me-id').click();
      return true;
    })()`);
    await page.waitFor(`return !!document.querySelector('.frp-toast')`, 5_000, '点 ID 要弹一句复制结果');
    const copied = await page.evalRaw(`return {
      texts: window.__cgCopied,
      toasts: [...document.querySelectorAll('.frp-toast')].map(function (e) { return e.textContent; }).join(' | '),
    }`);
    assert.deepEqual(
      copied.texts, [myId],
      `点 ID 要把**纯 ID**交给平台那个复制函数（不是"ID xxx"整串）：${JSON.stringify(copied.texts)}`
    );
    assert.match(copied.toasts, /已复制|复制失败/, `点 ID 要弹一句复制结果：${copied.toasts}`);
    console.log(`点 ID 复制 → 交给 GameNet.copy 的是「${copied.texts[0]}」，提示条：「${copied.toasts.trim()}」`);

    /* ---------- 16. 控制台必须干净 ---------- */
    const errors = page.errors.filter((e) => !/favicon|net::ERR_/i.test(e));
    assert.deepEqual(errors, [], '浏览器控制台有报错');
    console.log('控制台零报错');

    console.log('\n✅ 大炮轰小鬼：1 个真人 + 1 个人机座位的在线对局全部通过');
    console.log('✅ 单机人机：同一套渲染 + 演出、对阵条退回纯标记 —— 同样通过');
    console.log('✅ 不做本地预演 + 演出期间锁输入（**只禁点、不暗屏**，提示是右下角一行小字）+ 吃子音效 —— 同样通过');
    console.log('✅ 首页身份行（缓存先显示、ready 后对齐、点 ID 复制）+ 音效/特效只认平台那一份偏好 —— 同样通过');
  } finally {
    if (page) page.close();
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\n❌ 浏览器用例失败：');
  console.error(err && err.stack || err);
  process.exitCode = 1;
});