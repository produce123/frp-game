/*
 * 真浏览器：平台共用层的「锁定式」互动 + 头像点击策略（设计文档 §9.6，2026-10 加的一层）。
 *
 *   node tests/react-lock.browser.mjs
 *
 * 【为什么必须有这一条】
 * 这一层改的是 `shared/ui/react.js` 的 **document 捕获阶段**监听 —— 它决定"这次点击
 * 要不要吞掉"。这件事的坏法全是**静默**的，单元测试（甚至假 DOM）看不见：
 *
 *   1. 吞早了 → 游戏再也接不到点头像（游戏要拿它开自己的武将/信息面板）；
 *   2. 吞晚了 → 锁定态下点别人头像弹的还是那个老菜单，"连扔"根本连不起来；
 *   3. 吞错了对象 → 点**自己**的头像被吃掉，游戏那边永远开不出面板。
 *
 * 所以这里用**真服务端 + 真 WebSocket + 真 Chrome**，而且判据都落在"看得见的事实"上：
 *
 *   · "吞没吞" = 页面在**冒泡阶段**还收不收得到这次 click / keydown
 *     （捕获阶段 `stopPropagation()` 之后，冒泡那道监听就再也不会响 —— 这是唯一硬证据）；
 *   · "真发出去了" = 页面里包一层 `GameNet.send` 数 `react.send`，
 *     **并且**等**真服务端**广播回来的 `react` 条数（发起人自己也收得到那条回声）；
 *   · "画面上真的锁上了" = `[data-frp-arm].is-armed` 的类 + **实测背景色变了**
 *     （只有 class 没有样式 = 用户看不出锁定）。
 *
 * 【判据的红线】不调 `arm()` / `setAvatarPolicy()` 的页面（另外三个游戏、房间准备界面、
 * 房间成员列表）行为必须和改动前一样 —— 本文件第 1 段就是钉这条的（老菜单、老行为），
 * 另外 `npm run test:browser` 里 `tests/room.browser.mjs`（真点人机头像 → 弹菜单 → 送鲜花）
 * 与 `games/blade-steed/tests/browser.e2e.mjs`（同样点人机头像断言菜单）是另外两道。
 *
 * ⚠️ 服务跑在**随机端口**、浏览器用**全新临时 profile**，既不碰 7891 上正在跑的服务，
 *    也不吃上一次残留的 localStorage。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/server.mjs';
import { Page, findChrome } from '../tools/cdp.mjs';

/** 注册一个账号，关掉"你的 ID"弹窗，返回它领到的 ID（和 tests/room.browser.mjs 同一套）。 */
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

/*
 * 探针：页面里三个计数器。装一次就够（重复调用读回来是同一份）。
 *   bubbles —— 冒泡阶段收到的 click 次数：捕获阶段被吞掉时**永远不涨**
 *   keys    —— 冒泡阶段收到的 Enter / Space 次数（键盘那半条）
 *   sends   —— 真调用 GameNet.send 发出去的 react.send（记的是意图，不看返回值）
 *   reacts  —— **真服务端**广播回来的 react（端到端那半条：服务端收下了才算数）
 */
const PROBE = `
  return (function () {
    if (window.__probe) return window.__probe.info();
    var p = { bubbles: 0, keys: 0, sends: [], reacts: [] };
    window.__probe = {
      info: function () { return { bubbles: p.bubbles, keys: p.keys, sends: p.sends.slice(), reacts: p.reacts.slice() }; },
      reset: function () { p.bubbles = 0; p.keys = 0; p.sends = []; p.reacts = []; return true; },
    };
    document.addEventListener('click', function () { p.bubbles++; });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') p.keys++;
    });
    var T = window.FrpProtocol.T;
    var send = GameNet.send;
    GameNet.send = function (type, payload) {
      if (type === T.REACT_SEND) {
        p.sends.push({ to: String((payload && payload.to) || ''), kind: String((payload && payload.kind) || '') });
      }
      return send.apply(this, arguments);
    };
    GameNet.on(T.REACT, function (msg) {
      if (msg) p.reacts.push({ to: String(msg.to || ''), kind: String(msg.kind || ''), rid: msg.rid });
    });
    return window.__probe.info();
  })()
`;

/*
 * 两个顶栏图标 —— 按**游戏侧该写的样子**搭出来（现在没有游戏用到它，所以这里自己搭一个）：
 *   · `data-frp-arm="egg" | "flower"`：高亮由平台挂（`arm()` 自己刷 `.is-armed`）；
 *   · 同一个图标再点一次 = 取消锁定（`arm(armed() === k ? null : k)`）。
 * 摆在文档流末尾（不用 position:fixed）：不会盖住房间列表里的头像，真鼠标点得到。
 * 键盘那边头像本身就能聚焦（`role=button`），所以顺带量一下"聚焦环不算点击区"。
 */
const ICONS = `
  return (function () {
    var old = document.getElementById('lock-bar');
    if (old) old.parentNode.removeChild(old);
    var bar = document.createElement('div');
    bar.id = 'lock-bar';
    bar.style.cssText = 'display:flex;gap:8px;padding:10px;background:#181a1f';
    [['egg', '\u{1F95A}'], ['flower', '\u{1F338}']].forEach(function (pair) {
      var b = document.createElement('button');
      b.type = 'button';
      b.id = 'lock-' + pair[0];
      b.setAttribute('data-frp-arm', pair[0]);
      b.textContent = pair[1];
      b.style.cssText = 'width:56px;height:56px;font-size:26px';
      b.onclick = function () { FrpReact.arm(FrpReact.armed() === pair[0] ? null : pair[0]); };
      bar.appendChild(b);
    });
    document.body.appendChild(bar);
    return true;
  })()
`;

/** 读探针。 */
function probe(page) {
  return page.eval(`return window.__probe ? window.__probe.info() : null`);
}

/** 清空探针（看"这一段有没有被吞 / 有没有发出去"）。 */
function resetProbe(page) {
  return page.eval(`return window.__probe.reset()`);
}

/** 现在弹出着的老菜单（`.frp-react-menu`）里有几个按钮、写了什么。 */
function menu(page) {
  return page.eval(`
    return Array.prototype.map.call(document.querySelectorAll('.frp-react-menu button'), function (b) {
      return b.textContent.trim();
    })
  `);
}

/** 关掉老菜单（Escape，和用户按 Esc 一样）。 */
async function closeMenu(page) {
  await page.eval(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true
  `);
  await page.waitFor(`return !document.querySelector('.frp-react-menu')`, 3_000, '菜单应该收起来');
}

/*
 * 头像的选择器：锁定房间面板里的那个。
 * ⚠️ 写成 `#online-panel …` 而不是满文档找 —— `page.click` 挑的是"第一个看得见的"，
 *    范围定死之后"预检点到的是谁"和"真点的是谁"才是同一个元素。
 */
const avatarSel = (id) => `#online-panel .frp-avatar[data-frp-avatar="${id}"]`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 真鼠标点头像（CDP 的 Input.dispatchMouseEvent，和用户点的一模一样，会走平台的捕获监听）。
 * ⚠️ 点之前先确认"这个元素的中心真的能点到"：被别的元素盖住时，点下去落到别人身上，
 *    断言会失败但原因说不清 —— 这里提前给一句人话。
 * ⚠️ 滚动之后要**等一拍再点**：平台的菜单是"一滚动就收起来"的（`react.js` 在 scroll 上挂了
 *    `closeMenu`，那是给真用户滚页面用的），而 `scrollIntoView` 引发的 scroll 事件是**下一帧**
 *    才到的 —— 不等它，刚弹出来的菜单会被"我自己的滚动"当场关掉（假红）。真人在牌桌上点头像
 *    不会滚动，所以这只是测试手法，不是引擎的毛病。
 */
async function clickAvatar(page, id) {
  await scrollTo(page, id);
  await sleep(280);                       // 让 scrollIntoView 那一拍过去（见上面）
  await page.click(avatarSel(id));
}

/** 把头像滚到屏幕中间，并确认它的中心真能被点到。 */
async function scrollTo(page, id) {
  const hit = await page.evalRaw(`(() => {
    var el = document.querySelector(${JSON.stringify(avatarSel(id))});
    if (!el) return { ok: false, why: '页面上没有这个头像' };
    el.scrollIntoView({ block: 'center' });
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var top = document.elementFromPoint(x, y);
    var mine = !!top && (top === el || el.contains(top) || (top.closest && top.closest('[data-frp-avatar]') === el));
    return { ok: mine, why: mine ? '' : '中心被 ' + (top ? (top.className || top.tagName) : 'null') + ' 盖住了' };
  })()`);
  assert.equal(hit.ok, true, `头像 ${id} 点不到：${hit.why}`);
}

/** 在头像上按一下键盘（Enter / Space）—— 和用户用键盘操作一样。 */
function keyOnAvatar(page, id, key) {
  return page.evalRaw(`(() => {
    var el = document.querySelector(${JSON.stringify(avatarSel(id))});
    if (!el) return false;
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(key)}, bubbles: true, cancelable: true,
    }));
    return true;
  })()`);
}

/** 两个图标的当前状态：class / aria-pressed / 实测背景色（"用户看得出锁定"的硬证据）。 */
function icons(page) {
  return page.eval(`
    return ['egg', 'flower'].map(function (k) {
      var b = document.getElementById('lock-' + k);
      if (!b) return null;
      var cs = getComputedStyle(b);
      return {
        k: k,
        armedCls: b.classList.contains('is-armed'),
        aria: b.getAttribute('aria-pressed'),
        bg: cs.backgroundColor,
        border: cs.borderColor,
      };
    })
  `);
}

async function main() {
  if (!findChrome()) {
    console.log('⏭  本机没有 Chrome/Edge，跳过这条测试');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'frp-lock-'));
  let page = null;
  let app = null;
  try {
    app = await startServer({ port: 0, dbPath: join(tmpDir, 'lock.db'), statePath: join(tmpDir, 'server.json') });
    const base = String(app.url).replace(/\/+$/, '');
    page = await Page.launch({ headless: true, width: 430, height: 932, mobile: true });

    /* ---------- 0. 一个账号 + 一个房间 + 一个人机座位（拿两个真头像） ---------- */
    const myId = await register(page, base, '锁');
    await page.goto(`${base}/games/cannon-goblin/`);
    await page.waitFor(`return !!document.querySelector('.screen.is-active')`, 15_000, '游戏页面出现');
    await page.eval(`return (function () { window.enterOnline(); return true; })()`);
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-idle')`, 10_000, '房间入口出现');
    await page.waitFor(`return !!(window.GameNet && window.GameNet.connected === true)`, 15_000, 'WebSocket 连上');

    const created = await page.eval(`
      return (function () {
        var btn = document.querySelector('#online-panel .frp-room-idle .frp-btn-primary');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    assert.equal(created, true, '没找到「创建房间」按钮');
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-code-value')`, 10_000, '房号出现');

    // 人机是**座位**：按一下加一个，成员列表里就多一个带属性的头像（拿它当"别人"）
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-bot-add')`, 8_000, '添加人机按钮出现');
    await page.eval(`return (function () { document.querySelector('#online-panel .frp-room-bot-add').click(); return true; })()`);
    await page.waitFor(
      `return document.querySelectorAll('#online-panel .frp-room-member .frp-avatar[data-frp-avatar]').length === 2`,
      8_000,
      '房间里应该有两个带属性的头像（我 + 人机）'
    );

    const who = await page.eval(`
      return Array.prototype.map.call(
        document.querySelectorAll('#online-panel .frp-room-member .frp-avatar[data-frp-avatar]'),
        function (av) { return { id: av.getAttribute('data-frp-avatar'), name: av.getAttribute('data-frp-name') }; }
      )
    `);
    const other = who.find((w) => w.id !== myId);
    assert.ok(other && /^bot:/.test(other.id), `应该有一个别人（人机座位）的头像：${JSON.stringify(who)}`);
    assert.ok(who.some((w) => w.id === myId), `自己的头像也要在成员列表里：${JSON.stringify(who)}`);

    // 探针 + 图标搭起来
    const installed = await page.eval(PROBE);
    assert.deepEqual(installed, { bubbles: 0, keys: 0, sends: [], reacts: [] }, '探针装好应该全是 0');
    await page.eval(ICONS);
    console.log(`账号 ${myId}｜房间 ${await page.eval(`return document.querySelector('#online-panel .frp-room-code-value').textContent.trim()`)}｜别人=${other.id}`);

    // 进场时页面自己就有的报错（游戏侧的杂音）不算在这一次的账上 —— 只盯"这一段新增的"
    const noise = /favicon|net::ERR_|AudioContext/i;
    const errsBefore = page.errors.filter((e) => !noise.test(e)).length;

    /* ================= 1. 没调新 API 的页面 = 改动前的行为 ================= */
    // 点头像 → 老菜单；不发消息。
    await resetProbe(page);
    await clickAvatar(page, other.id);
    await page.waitFor(`return !!document.querySelector('.frp-react-menu')`, 8_000, '没锁定、没策略时点头像应该弹老菜单');
    const baselineBtns = await menu(page);
    assert.deepEqual(
      baselineBtns.slice(0, 2),
      ['🥚 扔鸡蛋', '🌸 送鲜花'],
      `老菜单应该是「扔鸡蛋 / 送鲜花」：${JSON.stringify(baselineBtns)}`
    );
    assert.equal(await page.eval(`return FrpReact.armed()`), null, '没动过 arm() 时锁定态应该是 null');
    let p = await probe(page);
    assert.deepEqual(p.sends, [], '弹菜单本身不许发任何消息（老的、新的都一样）');
    assert.equal(p.bubbles, 0, '老行为：点了头像这一下是被平台吞掉的（冒泡阶段收不到）');
    await closeMenu(page);
    console.log('① 没调新 API：点头像弹老菜单、吞掉事件、不发消息 ✅（与改动前一致）');

    // 点**自己**的头像：这一下必须**放行**（游戏要用它开"我的武将"面板）
    await resetProbe(page);
    await clickAvatar(page, myId);
    await page.waitFor(`return window.__probe.info().bubbles === 1`, 3_000, '点自己的头像，页面应该收得到这次 click');
    p = await probe(page);
    assert.equal(await page.eval(`return document.querySelectorAll('.frp-react-menu').length`), 0, '点自己的头像不许弹菜单');
    assert.deepEqual(p.sends, [], '点自己的头像不许发消息（自己不能被扔）');
    assert.equal(p.bubbles, 1, '点自己的头像必须放行 —— 这一次 click 要能传到页面（游戏靠它开面板）');
    console.log('② 点自己的头像：事件放行（页面收得到）、不弹菜单、不发消息 ✅');

    /* ================= 2. arm / armed：高亮、互斥、取消 ================= */
    await page.click('#lock-egg');
    let st = await icons(page);
    let egg = st.find((s) => s.k === 'egg');
    let flower = st.find((s) => s.k === 'flower');
    assert.equal(await page.eval(`return FrpReact.armed()`), 'egg', '点了 🥚 应该锁上 egg');
    assert.equal(egg.armedCls, true, '🥚 图标应该挂上 .is-armed');
    assert.equal(egg.aria, 'true', '🥚 的 aria-pressed 应该是 true');
    assert.equal(flower.armedCls, false, '🌺 不该跟着亮');
    assert.equal(flower.aria, 'false', '🌸 的 aria-pressed 应该是 false');
    assert.notEqual(egg.bg, flower.bg, `锁定态必须看得见（背景色要变）：🥚=${egg.bg} 🌸=${flower.bg}`);

    await page.click('#lock-flower');       // 两个图标互斥：锁 🥚 时点 🌸 → 变成锁 🌸
    st = await icons(page);
    egg = st.find((s) => s.k === 'egg');
    flower = st.find((s) => s.k === 'flower');
    assert.equal(await page.eval(`return FrpReact.armed()`), 'flower', '点 🌸 应该把锁定态换成 flower');
    assert.equal(flower.armedCls, true, '🌸 应该亮起来');
    assert.equal(egg.armedCls, false, '🥚 必须同时灭掉（两个图标互斥）');

    await page.click('#lock-flower');       // 再点同一个 = 取消
    st = await icons(page);
    assert.equal(await page.eval(`return FrpReact.armed()`), null, '再点同一个图标应该取消锁定');
    assert.equal(st.some((s) => s.armedCls), false, '取消之后两个图标都不该亮');

    // 认不出的 kind 当"取消"处理：游戏手滑传错之后不至于卡在锁定态里
    await page.eval(`return (function () { FrpReact.arm('\u{1F34C}香蕉'); return true; })()`);
    assert.equal(await page.eval(`return FrpReact.armed()`), null, '认不出的 kind 应该当取消');
    assert.equal((await icons(page)).some((s) => s.armedCls), false, '认不出的 kind 不该点亮任何图标');
    console.log('③ 锁定态：高亮（类 + 实测背景色）、armed() 对得上、两图标互斥、再点一次取消 ✅');

    /* ================= 3. 锁定后点别人：直接扔、不弹菜单、连扔 5 次真发 5 条 ================= */
    await page.click('#lock-egg');
    await resetProbe(page);
    for (let i = 0; i < 5; i++) await clickAvatar(page, other.id);
    p = await probe(page);
    assert.equal(
      await page.eval(`return document.querySelectorAll('.frp-react-menu').length`),
      0,
      '锁定态下点别人头像**不许弹菜单**'
    );
    assert.deepEqual(
      p.sends,
      Array.from({ length: 5 }, () => ({ to: other.id, kind: 'egg' })),
      `连点 5 次要真发出 5 条 egg：${JSON.stringify(p.sends)}`
    );
    assert.equal(await page.eval(`return FrpReact.armed()`), 'egg', '扔完不该自己取消（要能一直连扔）');
    // 端到端那一半：**真服务端**收下并广播回来（发起人自己也收得到回声，见 D11）
    await page.waitFor(`return window.__probe.info().reacts.length >= 5`, 8_000, '服务端应该把 5 条都广播回来');
    const echoes = (await probe(page)).reacts;
    assert.equal(echoes.length, 5, `服务端收到并广播的条数应该是 5（2 秒 40 次的兜底只挡刷屏）：${JSON.stringify(echoes)}`);
    assert.ok(echoes.every((e) => e.to === other.id && e.kind === 'egg' && e.rid > 0), `回声内容不对：${JSON.stringify(echoes)}`);
    console.log('④ 锁定态点别人：不弹菜单、连点 5 次真发 5 条、服务端 5 条都广播回来 ✅');

    // 解开锁定 → 又回到"弹菜单、不发消息"
    await page.click('#lock-egg');
    assert.equal(await page.eval(`return FrpReact.armed()`), null, '再点一次 🥚 应该解除锁定');
    await resetProbe(page);
    await clickAvatar(page, other.id);
    await page.waitFor(`return !!document.querySelector('.frp-react-menu')`, 5_000, '取消锁定之后应该回到老菜单');
    assert.deepEqual((await probe(page)).sends, [], '取消锁定之后点头像不该再直接扔');
    await closeMenu(page);

    /* ================= 4. setAvatarPolicy：'game' / 'throw' / 'menu' ================= */
    // 'game' —— 不吞、交还游戏（游戏拿它开自己的武将 / 信息面板）
    await page.eval(`return (function () { FrpReact.setAvatarPolicy(function () { return 'game'; }); return true; })()`);
    await resetProbe(page);
    await clickAvatar(page, other.id);
    await page.waitFor(`return window.__probe.info().bubbles === 1`, 3_000, `策略说 'game'，页面应该收得到这次 click`);
    p = await probe(page);
    assert.deepEqual(p.sends, [], `策略说 'game' 时不该发消息`);
    assert.equal(await page.eval(`return document.querySelectorAll('.frp-react-menu').length`), 0, `策略说 'game' 时不该弹菜单`);

    // 'game' 优先于锁定态（分支顺序不许调换：策略在 arm 之前判）
    await page.click('#lock-egg');
    await resetProbe(page);
    await clickAvatar(page, other.id);
    await page.waitFor(`return window.__probe.info().bubbles === 1`, 3_000, `锁着也得听策略：'game' 仍然放行`);
    assert.deepEqual((await probe(page)).sends, [], `锁着但策略说 'game' → 不许绕过策略直接扔`);
    await page.click('#lock-egg');

    // 'throw' —— 直接扔手上锁着的东西，并吞掉事件
    await page.eval(`return (function () { FrpReact.setAvatarPolicy(function () { return 'throw'; }); return true; })()`);
    await page.click('#lock-flower');
    await resetProbe(page);
    await clickAvatar(page, other.id);
    p = await probe(page);
    assert.deepEqual(p.sends, [{ to: other.id, kind: 'flower' }], `策略说 'throw' 应该直接扔锁着的那件：${JSON.stringify(p.sends)}`);
    assert.equal(p.bubbles, 0, `策略说 'throw' 必须吞掉事件（页面不该再收到一次 click）`);
    assert.equal(await page.eval(`return document.querySelectorAll('.frp-react-menu').length`), 0, `'throw' 不许弹菜单`);

    // 'throw' 但手上什么都没锁 → 退回老菜单（别让点击变成死的）
    await page.click('#lock-flower');
    await resetProbe(page);
    await clickAvatar(page, other.id);
    await page.waitFor(`return !!document.querySelector('.frp-react-menu')`, 5_000, `'throw' 但没锁定 → 退回老菜单`);
    assert.deepEqual((await probe(page)).sends, [], `没锁定就没东西可扔，不该发消息`);
    await closeMenu(page);

    // 'menu' —— 与现状一致（哪怕锁着也走菜单）
    await page.eval(`return (function () { FrpReact.setAvatarPolicy(function () { return 'menu'; }); return true; })()`);
    await page.click('#lock-egg');
    await resetProbe(page);
    await clickAvatar(page, other.id);
    await page.waitFor(`return !!document.querySelector('.frp-react-menu')`, 5_000, `策略说 'menu' → 老菜单`);
    assert.deepEqual((await probe(page)).sends, [], `策略说 'menu' 时不该直接扔`);
    await closeMenu(page);
    await page.click('#lock-egg');

    // 策略自己抛异常 → 当 'menu' 处理：游戏写错一行代码，也不能让头像变成"点了没反应"
    await page.eval(`
      return (function () {
        FrpReact.setAvatarPolicy(function () { throw new Error('游戏策略写错了'); });
        return true;
      })()
    `);
    await resetProbe(page);
    await clickAvatar(page, other.id);
    await page.waitFor(`return !!document.querySelector('.frp-react-menu')`, 5_000, '策略抛异常时应该退回老菜单');
    assert.deepEqual((await probe(page)).sends, [], '策略抛异常时不该乱扔东西');
    await closeMenu(page);
    await page.click('#lock-egg');

    // 注销策略 → 回到"没注册 = 锁定就直接扔"
    await page.eval(`return (function () { FrpReact.setAvatarPolicy(null); return true; })()`);
    await page.eval(`return (function () { FrpReact.arm('egg'); return true; })()`);
    await resetProbe(page);
    await clickAvatar(page, other.id);
    p = await probe(page);
    assert.deepEqual(p.sends, [{ to: other.id, kind: 'egg' }], `注销策略 + 锁定 → 直接扔：${JSON.stringify(p.sends)}`);
    assert.equal(p.bubbles, 0, '这一下应该是平台处理的（吞掉）');
    await page.eval(`return (function () { FrpReact.arm(null); return true; })()`);
    console.log("⑤ 头像策略：'game' 放行 / 'throw' 直接扔并吞掉（没锁定退回菜单）/ 'menu' 老行为 / 注销回到锁定语义 ✅");

    /* ================= 5. 键盘：Enter / Space 走同一套 ================= */
    await page.eval(`return (function () { FrpReact.setAvatarPolicy(function () { return 'game'; }); return true; })()`);
    await resetProbe(page);
    await keyOnAvatar(page, other.id, 'Enter');
    await page.waitFor(`return window.__probe.info().keys === 1`, 3_000, `键盘也要走策略：'game' 时页面收得到 Enter`);
    assert.deepEqual((await probe(page)).sends, [], `'game' 时按 Enter 不该发消息`);
    assert.equal(await page.eval(`return document.querySelectorAll('.frp-react-menu').length`), 0, `'game' 时按 Enter 不该弹菜单`);

    await page.eval(`return (function () { FrpReact.setAvatarPolicy(null); FrpReact.arm('flower'); return true; })()`);
    await resetProbe(page);
    await keyOnAvatar(page, other.id, ' ');
    await page.waitFor(`return window.__probe.info().sends.length === 1`, 3_000, '锁着时按 Space 应该直接扔');
    p = await probe(page);
    assert.deepEqual(p.sends, [{ to: other.id, kind: 'flower' }], `键盘扔的应该是锁着的 flower：${JSON.stringify(p.sends)}`);
    assert.equal(p.keys, 0, '平台处理的这一下要吞掉（Space 不许滚页面）');
    assert.equal(await page.eval(`return document.querySelectorAll('.frp-react-menu').length`), 0, '锁着按 Space 不该弹菜单');

    // 没锁定、没策略 → 键盘也回到老菜单
    await page.eval(`return (function () { FrpReact.arm(null); return true; })()`);
    await resetProbe(page);
    await keyOnAvatar(page, other.id, 'Enter');
    await page.waitFor(`return !!document.querySelector('.frp-react-menu')`, 5_000, '没锁定时按 Enter 应该弹老菜单');
    assert.deepEqual((await probe(page)).sends, [], '没锁定时按 Enter 只弹菜单、不发消息');
    assert.equal((await probe(page)).keys, 0, '老行为：键盘这一下也是被吞掉的');
    await closeMenu(page);
    console.log('⑥ 键盘（Enter / Space）：和鼠标同一条策略，锁着直接扔、策略说 game 就放行 ✅');

    /* ---------- 收尾：这一轮没让页面冒出新的控制台报错 ---------- */
    const errs = page.errors.filter((e) => !noise.test(e));
    assert.equal(
      errs.length,
      errsBefore,
      `这一轮让页面多出了控制台报错：\n${errs.slice(errsBefore).join('\n')}`
    );
    console.log('\n全部通过：平台共用层的「锁定式」互动 + 头像点击策略（§9.6）✅');
    console.log('   覆盖：默认行为一字不变 / 点自己头像放行 / 锁定态高亮·互斥·取消 /');
    console.log('         锁后连扔 5 条（含服务端回声）/ 三种策略 + 注销 / 键盘与鼠标同一套');
  } finally {
    if (page) page.close();
    if (app && app.close) await app.close().catch(() => {});
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

main().catch((err) => {
  console.error('\n❌ react-lock.browser.mjs 失败：', (err && err.stack) || err);
  process.exitCode = 1;
});