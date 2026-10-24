/*
 * Shell Gambit — 真浏览器端到端测试。
 *
 * 跑：node games/shell-gambit/tests/browser.e2e.mjs
 *     （在仓库根目录 E:\frp-game 下跑，需要本机有 Chrome 或 Edge）
 *
 * 【为什么要自己起一个服务器，而不是连 7891】
 * 7891 是用户 / 别的 agent 正在用的那一个，可能早就起来了（它启动时还没有本游戏，
 * 所以它的游戏列表里不会有 shell-gambit）。这条测试要的是"**当前这份代码**能跑"，
 * 所以用 startServer({ port: 0 }) 自己起一个随机端口 + 临时数据库：
 *   · 不占 7891，不打扰任何人
 *   · 不写 data/server.json（startServer 不传 statePath 就不写）
 *   · 跑完临时数据库整个删掉，data/ 一个字节都不动
 *
 * 【它验的是什么】
 *   1. 平台上注册一个账号（真表单、真 cookie）
 *   2. 打开 /games/shell-gambit/ 页面能加载、控制台零报错
 *   3. 单机人机对局能进得去，并且**真的走了一步**（不是只看了一眼界面）
 *   4. 在线对局能建房间，并看到 6 位房间号
 *   5. **一个人建房 + 补 1 个电脑，真的开局、真的走到"轮到我"**（AI 补位那条路，
 *      见 docs/GAME-SPEC.md 第 4 节「AI 补位」）；准备界面里房主能选"补几个电脑"，
 *      客人看到的是只读文字
 *   5b. **一个人 + 补位选 0 → 点开始被拒绝，界面上真的弹出提示条**（不是静默失败）：
 *      验的是"服务端拒绝 → shared/ui/room.js 的 Net.on(T.ERROR) → UI.toast"这条**平台链路**，
 *      所以只看界面，不去断言服务端返回值
 *   6. 第二个真人用房间号 join → 房主开局 → 谁轮到谁点，两边收到同一帧（服务器权威）
 *   7. 手机窄屏 360px：无横向溢出、点击区 ≥44px、元素不跑出屏幕
 *   8. 服务器推下来的 view 里搜不到弹序 / 牌堆 / 种子 / 情报
 *
 * ⚠️ 它故意**不叫 *.test.mjs** —— 这样根目录的 `npm test` 不会顺手跑它
 *    （真浏览器测试慢，而且依赖本机装了浏览器）。这也是原项目家族的约定。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../../../server/server.mjs';
import { meta } from '../../../server/games/shell-gambit.mjs';
import { Page, findChrome } from '../../../tools/cdp.mjs';

const SHOTS = new URL('../screenshots/', import.meta.url).pathname.replace(/^\//, '');
const SLUG = 'shell-gambit';

/* ------------------------------ 界面体检 ------------------------------ */

/**
 * 横向溢出 / 点击区域 <44px / 元素跑出屏幕。
 * 这三条是平台既有的验收标准（见 tests/browser.smoke.mjs），照抄同一套，
 * 免得两个地方的标准悄悄分叉。
 */
async function layoutCheck(page, label) {
  const report = await page.eval(`
    var overflow = document.documentElement.scrollWidth - window.innerWidth;

    var small = [];
    document.querySelectorAll('button, input').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (getComputedStyle(el).visibility === 'hidden') return;
      if (r.height < 44) small.push((el.id || el.className || el.tagName) + '=' + Math.round(r.height) + 'px');
    });

    var outside = [];
    document.querySelectorAll('.screen.is-active button, .screen.is-active input').forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width < 1) return;
      if (r.left < -1 || r.right > window.innerWidth + 1) {
        outside.push((el.id || el.className) + '@' + Math.round(r.left) + '..' + Math.round(r.right));
      }
    });

    return { overflow: overflow, small: small, outside: outside, width: window.innerWidth };
  `);

  assert.ok(report.overflow <= 1, `${label}（${report.width}px 宽）：横向溢出 ${report.overflow}px`);
  assert.deepEqual(report.small, [], `${label}：点击区域小于 44px`);
  assert.deepEqual(report.outside, [], `${label}：元素跑出屏幕`);
  return report;
}

/**
 * 等演出队列排空（`window.FrpAnim.busy() === false`）。
 *
 * 【为什么每个"真点击"之前都要等它】从这一版起**演出期间输入是锁着的**
 * （`docs/DECISIONS.md` D10）：`render()` 是同步把最新一帧画出来的，所以按钮在
 * 演出还没演完的时候就已经在屏幕上了 —— 这时候点下去会被**当成没点**，
 * 消息根本不发。不等就点 = 用例偶发失败，而且失败得毫无线索（seq 一直不涨）。
 * 平台脚本没加载时直接放行（那样队列也不存在）。
 */
async function waitIdle(p, why) {
  await p.waitFor(
    `return !window.FrpAnim || typeof window.FrpAnim.busy !== 'function' || window.FrpAnim.busy() === false`,
    20_000,
    why
  );
}

/**
 * 开局回放：牌桌挂上来的第一帧就要把**开局**演出来（对局记录第一条 = 「第 1 轮」）。
 *
 * 【为什么这条是硬证据】老写法是"首次进入只画最终状态、一条旧条目都不回放"，
 * 于是「第 1 轮」这一条**永远不会**出现在对局记录里（它只在真的又开一轮时才播）——
 * 玩家一进对局就已经轮到自己，用户实机报的"我明明在 3 号位，却是第一个行动"就是它。
 * 服务端在广播之前就把人机那一整轮同步跑完了，所以这条也顺带证明
 * "1 号位先行动"那几步真的演给玩家看了（它们就排在记录的最前面）。
 */
async function assertOpeningReplayed(page, label) {
  await page.waitFor(
    `var f = document.querySelectorAll('#screen-game .feed-item');
     return f.length > 0 && f[0].textContent.indexOf('第 1 轮') >= 0;`,
    15_000,
    `${label}：对局记录的第一条应当是「第 1 轮」（开局被回放出来了）`
  );
  return page.eval(
    `return [...document.querySelectorAll('#screen-game .feed-item')].map(function (e) { return e.textContent })`
  );
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  if (!findChrome()) {
    console.log('⚠️  本机没找到 Chrome / Edge，跳过浏览器测试');
    return;
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'sg-browser-'));
  const app = await startServer({ port: 0, dbPath: join(tmpDir, 'browser.db') });

  // ---- 服务器侧先确认：本游戏真的被发现了，而且没有加载失败 ----
  console.log(`服务器起来了：${app.url}`);
  console.log(`已接游戏：${[...app.games.keys()].join(', ') || '（无）'}`);
  console.log(`加载失败：${app.gameFailures.length ? app.gameFailures.map((f) => `${f.file}: ${f.message}`).join('; ') : '（无）'}`);
  assert.ok(app.games.has(SLUG), `服务器没有接上 ${SLUG}`);
  assert.deepEqual(
    app.gameFailures.map((f) => f.file),
    [],
    '有游戏模块加载失败（这里面如果有别人的游戏，先确认不是自己造成的）'
  );

  let page;
  let guest = null;
  try {
    page = await Page.launch({ headless: true, width: 430, height: 932, mobile: true });
    mkdirSync(SHOTS, { recursive: true });

    /* ---------- 1. 在平台首页注册一个账号 ---------- */
    await page.goto(app.url);
    await page.waitFor(`return document.getElementById('screen-auth').classList.contains('is-active')`, 10_000, '登录页出现');

    await page.click('#tab-register');
    await page.setInput('#register-name', '弹');
    await page.setInput('#register-password', 'secret123');
    await page.setInput('#register-password2', 'secret123');
    await page.click('#form-register .btn-primary');
    await page.waitFor(`return !document.getElementById('modal-id').hidden`, 15_000, 'ID 弹窗出现');
    const myId = await page.eval(`return document.getElementById('new-id').textContent`);
    assert.match(myId, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{7}$/, `发放的 ID 不合规：${myId}`);
    console.log(`注册成功，领到 ID：${myId}`);

    await page.click('#btn-id-done');
    await page.waitFor(`return document.getElementById('screen-app').classList.contains('is-active')`, 10_000, '平台主界面出现');
    await page.waitFor(`return window.GameNet && window.GameNet.connected === true`, 15_000, 'WebSocket 连上');
    console.log('真浏览器 WebSocket 握手成功');

    /* ---------- 2. 打开游戏页 ---------- */
    const gameUrl = new URL(`/games/${SLUG}/`, app.url).href;
    await page.goto(gameUrl);
    await page.waitFor(`return document.body.dataset.sgReady === '1'`, 15_000, '游戏页初始化完成');
    await page.waitFor(`return document.getElementById('screen-home').classList.contains('is-active')`, 10_000, '首页出现');
    // WebSocket 必须连上 —— 身份、房间、对局全靠它。连不上后面所有事都没意义。
    await page
      .waitFor(`return window.GameNet && window.GameNet.connected === true`, 20_000, '游戏页的 WebSocket 连上')
      .catch(async (err) => {
        const diag = await page.evalRaw(`(async () => {
          const probe = await new Promise(function (resolve) {
            var out = { events: [] };
            var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
            ws.onopen = function () { out.events.push('open'); resolve(out); };
            ws.onerror = function () { out.events.push('error'); };
            ws.onclose = function (e) { out.events.push('close ' + e.code + ' ' + e.reason); resolve(out); };
            setTimeout(function () { out.events.push('timeout readyState=' + ws.readyState); resolve(out); }, 4000);
          });
          return {
            hasGameNet: typeof window.GameNet,
            connected: window.GameNet && window.GameNet.connected,
            cookie: document.cookie,
            probe: probe,
            logs: (window.__sgLogs || []).slice(-10),
          };
        })()`);
        throw new Error(`${err.message}\n  ${JSON.stringify(diag)}`);
      });
    await page.waitFor(`return !!(window.GameNet.me && window.GameNet.me.id)`, 20_000, 'WebSocket 认出身份');

    // 名字与 ID 来自账号，游戏里不该有任何名字输入框
    const homeName = await page.eval(`return document.getElementById('home-name').textContent`);
    const homeId = await page.eval(`return document.getElementById('home-id').textContent`);
    assert.equal(homeName, '弹', `首页应显示账号名字，实际「${homeName}」`);
    assert.ok(homeId.includes(myId), `首页应显示玩家 ID，实际「${homeId}」`);
    // 名字与 ID 来自账号，游戏里不该再出现"取个名字"的输入框。
    // 平台上唯一合法的那种输入框是房间层的"房间号"（FrpRoom 自己画的），
    // 所以这里按 aria-label 排除它，其余文字输入框一个都不该有。
    const nameInputs = await page.eval(`
      return [...document.querySelectorAll('input[type=text]')]
        .filter(function (el) { return el.getAttribute('aria-label') !== '房间号'; })
        .map(function (el) { return el.id || el.className || el.outerHTML.slice(0, 60); })
    `);
    assert.deepEqual(nameInputs, [], '游戏页不该有取名字的输入框（身份来自账号）');
    console.log(`游戏页加载完成：名字「${homeName}」 ${homeId}`);

    await layoutCheck(page, '游戏首页 430px');

    /* ---------- 3. 单机人机对局，真的走一步 ---------- */
    await page.click('[data-go="ai"]');
    await page.waitFor(`return document.getElementById('screen-ai').classList.contains('is-active')`, 5_000, '人机对局页出现');
    await page.click('#ai-counts [data-players="2"]');

    await page.waitFor(`return document.getElementById('screen-game').classList.contains('is-active')`, 10_000, '牌桌出现');
    await page.waitFor(`return document.querySelectorAll('#screen-game .seat').length === 2`, 10_000, '两个座位画出来');

    const seats = await page.eval(`return [...document.querySelectorAll('#screen-game .seat .seat-name')].map(function(e){return e.textContent})`);
    const handCards = await page.eval(`return document.querySelectorAll('#screen-game .card').length`);
    const roundBefore = await page.eval(`return document.querySelector('#screen-game .js-round').textContent`);
    console.log(`人机对局开局：座位 ${JSON.stringify(seats)}，手牌 ${handCards} 张，第 ${roundBefore} 轮`);
    assert.ok(handCards >= 2, `开局应当有手牌，实际 ${handCards} 张`);

    /*
     * 单机桌的圆环也要对：**除了自己全是电脑**，所以应当恰好是"1 个蓝 + 1 个灰"。
     * 这条同时钉住"本地对局的电脑座位也带身份标记"（js/ui/match.js 把 isAi 传进引擎，
     * js/view.js 再从座位取出 isAI）—— 漏了的话单机里电脑会画成橙色（当真人）。
     */
    const localRings = await page.eval(
      `return [...document.querySelectorAll('#screen-game .seat .avatar')].map(function (a) {
         return a.classList.contains('is-me') ? 'me' : a.classList.contains('is-bot') ? 'bot' : a.classList.contains('is-human') ? 'human' : '无';
       }).sort()`
    );
    assert.deepEqual(localRings, ['bot', 'me'], `单机桌圆环应当是自己(蓝)+电脑(灰)，实际 ${JSON.stringify(localRings)}`);
    console.log(`人机对局头像圆环：${localRings.join(' / ')}（自己是蓝、电脑是灰）`);

    const localOpening = await assertOpeningReplayed(page, '单机人机对局');
    console.log(`单机开局回放：对局记录第一条是「${localOpening[0]}」（共 ${localOpening.length} 条）`);

    // 座位是随机分配的，所以开局可能轮到 AI、也可能轮到我。
    // 等到"轮到我（有动作按钮）"或"我先出局了（观战提示）"为止，两种都算正常推进。
    await page.waitFor(
      `return document.querySelectorAll('#screen-game .act-btn').length > 0
              || document.querySelector('#screen-game .turn-hint').textContent.includes('观战')`,
      30_000,
      '轮到真人（或已被淘汰）'
    );
    const canAct = await page.eval(`return document.querySelectorAll('#screen-game .act-btn').length > 0`);
    const hint = await page.eval(`return document.querySelector('#screen-game .turn-hint').textContent`);
    console.log(`轮到我了：${canAct}（提示：${hint}）`);
    assert.ok(canAct, '2 人局第一次轮到真人时应当有动作按钮（除非已被 AI 打死，概率极低）');

    await layoutCheck(page, '人机对局牌桌 430px');

    // 真的点一下（优先点"对自己开枪"，那是本作的核心操作）
    const clicked = await page.evalRaw(`(() => {
      const b = document.querySelector('#screen-game .act-btn.self') || document.querySelector('#screen-game .act-btn.shoot');
      return b ? b.textContent : null;
    })()`);
    assert.ok(clicked, '应当至少有一个可以点的动作按钮');
    // ⚠️ 有按钮 ≠ 点得动：演出期间输入是锁的（D10），点了等于没点，后面的断言会白等
    await waitIdle(page, '单机牌桌：演出队列排空（否则这一点等于没点）');

    /*
     * 单机这一边也走的是**同一条** `render()`（§3.2：单机与联机共用一个牌桌），
     * 所以"逐步同步"在单机也必须成立。这里把平台队列的 `push` 包一层，
     * 看牌桌到底往队列里排了什么：
     *   · 每一步都要带"这一步之后的公开状态补丁"（`s`）—— 那是逐步渲染的原料；
     *   · 单机是**同步**回结果的（点 → 本地引擎跑完 → `onUpdate` → `render`），
     *     所以"点完的那一瞬间"就能看到画面停在第几步：牌桌排了 N 步，
     *     画面必须是**第 1 步**（不是最后一步）—— 这正是"演到第几步画面就是第几步"。
     * ⚠️ 单机一帧常常只有 1~2 步（AI 是 950ms 一步单独推的），步数不足 2 时那条
     *    "画面还不是最终值"的断言无从谈起，会跳过；**画面中途 == 那一步**的硬证据
     *    在联机那一节（4c-D：一次回包 5 步）量。
     */
    await page.evalRaw(`(() => {
      window.__sgLocalSteps = [];
      const orig = window.FrpAnim.push;
      window.FrpAnim.push = function (steps, fn) {
        window.__sgLocalSteps = window.__sgLocalSteps.concat(steps || []);
        return orig.call(this, steps, fn);
      };
      return true;
    })()`);
    await page.click('#screen-game .act-btn.self');
    const localFrame = await page.evalRaw(`(() => {
      const host = document.getElementById('screen-game');
      const ns = window.__sgLocalSteps.map(function (e) { return e.n; });
      return {
        queued: window.__sgLocalSteps.length,
        withPatch: window.__sgLocalSteps.filter(function (e) { return e && e.s; }).length,
        ns: ns,
        displaySeq: Number(host.dataset.seq || 0),
      };
    })()`);
    assert.ok(
      localFrame.queued >= 1,
      '单机走一步之后牌桌必须往演出队列里排步（逐步渲染的入口；排 0 步说明又回到"一次画完"了）'
    );
    assert.equal(
      localFrame.withPatch,
      localFrame.queued,
      `单机排进队列的每一步都要带补丁 s（实际 ${localFrame.withPatch}/${localFrame.queued}）`
    );
    assert.deepEqual(
      [...localFrame.ns].sort((a, b) => a - b),
      localFrame.ns,
      '排进队列的步必须按事件序号升序（顺序/去重口径不许变）'
    );
    if (localFrame.queued >= 2) {
      assert.equal(
        localFrame.displaySeq,
        localFrame.ns[0],
        `点了之后画面必须停在第 1 步（seq=${localFrame.ns[0]}），不是最终第 ${localFrame.ns[localFrame.ns.length - 1]} 步`
      );
    }
    console.log(
      `单机逐条演出：这一手排进队列 ${localFrame.queued} 步（序号 ${localFrame.ns.join('/')}），` +
        `每一步都带"这一步的状态补丁"；点完那一瞬画面停在第 ${localFrame.displaySeq} 步` +
        (localFrame.queued >= 2 ? `（不是最终第 ${localFrame.ns[localFrame.ns.length - 1]} 步）` : '（这一帧只有 1 步）')
    );

    // 走完一步之后界面必须动起来：事件流里有新条目，且操作确实被判定了
    await page.waitFor(`return document.querySelectorAll('#screen-game .feed-item').length > 0`, 10_000, '对局记录出现条目');
    const feedText = await page.eval(`return [...document.querySelectorAll('#screen-game .feed-item')].map(function(e){return e.textContent}).join(' | ')`);
    console.log(`点了「${clicked}」→ 对局记录：${feedText}`);
    assert.ok(feedText.length > 0, '点完之后对局记录不该是空的');

    // 再等一手：AI 必须能自己动（否则就是"服务器/本地 AI 卡住"）
    await page.waitFor(`return document.querySelectorAll('#screen-game .feed-item').length >= 2`, 25_000, 'AI 跟着动了一步');

    /* ---------- 3b. 对局中不许有底部提示弹窗挡住动作区（用户实机反馈） ---------- */
    /*
     * 老版本在演出「使用放大镜 / 手铐」那一步会调 `onInfo` → 平台提示条
     * （`shared/ui/ui.css` 的 `.frp-toast` 是 `position:fixed; bottom:18px` 且
     * `pointer-events:auto`），正好压在牌桌的动作区上。用户原话：
     * "行动时屏幕下方会出现「放大镜：下一发是实弹」「虎 被带上铐」这种提示弹窗
     *  挡住我的操作按钮"。那两条现在整段删掉了 —— 信息本来就在 HUD 的「已知下一发」
     * 提示条和「对局记录」里。
     *
     * 手里的牌是随机发的，"这一次有没有放大镜"不一定 —— 没有就跳过
     * （和上面"这一帧只有 1 步"同一个口径：跳过的原因在输出里写着），
     * 有就**真点一次**，然后盯着提示条看 1.6 秒（那一步的演出约 560ms）。
     */
    await waitIdle(page, '单机：等演出排空（下面要真点一次手牌）');
    const toastWatch = await page.evalRaw(`(async () => {
      const sleep = (ms) => new Promise(function (r) { setTimeout(r, ms); });
      const cards = [...document.querySelectorAll('#screen-game .hand .card')];
      const card = cards.find(function (c) { return c.textContent.indexOf('放大镜') >= 0 && !c.disabled; });
      if (!card) return { skipped: true, hand: cards.map(function (c) { return c.textContent }) };
      const seen = [];
      const sample = function () {
        document.querySelectorAll('.frp-toast').forEach(function (t) { seen.push(t.textContent); });
      };
      sample();                       // 先记下"点之前就挂着的"，只对新增的那些负责
      const before = seen.length;
      const label = card.textContent;
      card.click();                   // 本机不预演：这一手要等引擎回包后才演（D10）
      for (let i = 0; i < 40; i++) { sample(); await sleep(40); }
      return { skipped: false, label: label, fresh: seen.slice(before) };
    })()`);
    if (toastWatch.skipped) {
      console.log(`对局中的底部弹窗：这一局手里没有放大镜（${toastWatch.hand.join(' / ')}），跳过这一条`);
    } else {
      const bad = toastWatch.fresh.filter((t) => t.indexOf('放大镜') >= 0);
      assert.deepEqual(bad, [], '对局中不许再弹「放大镜：下一发是…」这种底部提示条（它压在动作区上）');
      console.log(
        `对局中的底部弹窗：真出了「${toastWatch.label}」这一手，1.6 秒里新增提示条 ${toastWatch.fresh.length} 条` +
          `（老版本这里会弹一条「放大镜：下一发是…」）`
      );
    }

    await page.screenshot(join(SHOTS, 'e2e-local-game.png'));

    // 窄屏也让牌桌过一遍体检
    await page.setViewport(360, 640, true);
    await layoutCheck(page, '人机对局牌桌 360px');
    await page.screenshot(join(SHOTS, 'e2e-local-game-360.png'));
    await page.setViewport(430, 932, true);

    /*
     * 建房 + 等房号（第 4 节与第 5 节都要用）。
     *
     * ⚠️ 点「创建房间」必须用**页面内** el.click()：FrpRoom 一收到 room.state 就整块重画，
     *    真实鼠标事件的 mouseReleased 会落在已经被摘掉的旧 DOM 上，静默点空（见 AGENTS.md 4.7）。
     */
    const createRoom = async (p) => {
      await p.evalRaw(`(() => {
        const b = document.querySelector('.frp-room-idle .frp-btn-primary');
        if (b) b.click();
        return b ? b.textContent : null;
      })()`);
      await p
        .waitFor(`return document.querySelector('.frp-room-code-value code') !== null`, 15_000, '房间号出现')
        .catch(async (err) => {
          const diag = await p.evalRaw(`(() => ({
            connected: window.GameNet.connected,
            me: window.GameNet.me,
            room: window.GameNet.room,
            toasts: [...document.querySelectorAll('.frp-toast')].map(function (e) { return e.textContent }).join(' | '),
            panelHtml: (document.getElementById('online-panel') || {}).innerHTML,
          }))()`);
          throw new Error(`${err.message}\n  诊断：${JSON.stringify(diag).slice(0, 1500)}`);
        });
      const c = await p.eval(`return document.querySelector('.frp-room-code-value code').textContent`);
      assert.match(c, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/, `房间号不合规：${c}`);
      return c;
    };

    /* ---------- 4. 离开对局，去在线对局建房间 ---------- */
    await page.click('#screen-game .js-menu');
    await page.waitFor(`return !document.getElementById('modal-layer').hidden`, 5_000, '菜单弹窗出现');
    // 菜单按钮：[继续游戏, 音效, 特效, 离开对局] —— 点最后一个
    await page.click('#modal-layer .ghost-btn', { index: 2 });
    await page.waitFor(`return document.getElementById('screen-home').classList.contains('is-active')`, 5_000, '回到首页');

    await page.click('[data-go="online"]');
    await page.waitFor(`return document.getElementById('screen-online').classList.contains('is-active')`, 5_000, '在线对局页出现');
    await page.waitFor(`return document.querySelector('.frp-room-idle') !== null`, 10_000, '房间入口出现');

    const code = await createRoom(page);
    const memberName = await page.eval(`return document.querySelector('.frp-room-member-name') ? document.querySelector('.frp-room-member-name').textContent : ''`);
    console.log(`建房成功：房间号 ${code}，成员 ${memberName}`);

    /* ---------- 4b. 房主一个人：「开始游戏」是**灰的**，座位 1 / 2 ---------- */
    /*
     * 平台契约（shared/ui/room.js）：`开始游戏` 的禁用条件是 **座位数 < minSeats**
     * （本作 `meta.minSeats = 2`，**含人机**），旁边那句提示写"至少要 2 个座位…"。
     * 所以一个人建房时按钮**点不动** —— 这是刻意的：与其让玩家点了再被拒，
     * 不如当场告诉他"按「添加人机」补一个"。
     *
     * ⚠️ 这里**不再**有"补几个电脑"的控件（`aiFill` 整条通路已作废）：
     *    人机是房间的座位，由平台外壳的「＋ 添加人机」加。所以这一段验的是
     *    "座位数说真话 + 按钮灰得对 + 游戏自己的设置区已经没了"。
     */
    /*
     * ⚠️ 下面那段页面脚本里**只认"座位那一句"**：房间等待区直属的 .frp-room-note。
     *    邀请区里也有一条 .frp-room-note（"好友都不在线，暂时没法邀请"），
     *    没有好友时它永远都在 —— 拿 .frp-room-note 泛查会永远命中，断言就假通了。
     *    （这段说明写在模板串**外面**：页面脚本里的注释不能带反引号，
     *      否则会把模板串提前截断，后面那半截会被当成 Node 侧的代码去解析。）
     */
    const solo = await page.evalRaw(`(() => {
      const b = document.querySelector('#screen-online .frp-room-actions .frp-btn-primary');
      const seatCount = document.querySelector('#screen-online .frp-room-seat-count');
      const note = document.querySelector('#screen-online .frp-room-waiting > .frp-room-note');
      const add = document.querySelector('#screen-online .frp-room-bot-add');
      return {
        startText: b ? b.textContent : null,
        startDisabled: b ? b.disabled : null,
        seatCount: seatCount ? seatCount.textContent : null,
        note: note ? note.textContent : null,
        addText: add ? add.textContent : null,
      };
    })()`);
    assert.ok(solo.startText, '应当有「开始游戏」按钮');
    assert.equal(solo.startDisabled, true, '只有 1 个座位时「开始游戏」必须是灰的（minSeats=2）');
    assert.match(solo.seatCount, /1 \/ 4/, `座位数应显示 1 / 4，实际「${solo.seatCount}」`);
    assert.match(solo.note, /至少要 2 个座位/, `要有"至少要 2 个座位"那句，实际「${solo.note}」`);
    assert.match(solo.addText, /添加人机/, '房主要看得到「＋ 添加人机」');
    // 本作在准备区**没有**自己的设置项了：既不画设置区，也没有"补几个电脑"的控件
    assert.equal(
      await page.eval(`return !!document.querySelector('#screen-online .frp-room-setup')`),
      false,
      '准备区不该再有游戏自己的设置区（"补几个电脑"已经删掉）'
    );
    assert.equal(
      await page.eval(`return document.querySelectorAll('#screen-online .count-btn').length`),
      0,
      '不该再有"补几个电脑"的控件'
    );
    console.log(`准备区（房主一个人）：${solo.seatCount}，「开始游戏」灰着；${solo.addText}`);
    console.log(`  提示原文：「${solo.note}」`);

    await layoutCheck(page, '在线房间 430px');
    await page.screenshot(join(SHOTS, 'e2e-room.png'));

    await page.setViewport(360, 640, true);
    await layoutCheck(page, '在线房间 360px');
    await page.screenshot(join(SHOTS, 'e2e-room-360.png'));
    await page.setViewport(430, 932, true);

    /* ---------- 4b2. 绕过灰按钮直接发一条 room.start：服务端真的会拒，界面真的会弹提示条 ---------- */
    /*
     * ⚠️ 为什么是"直接发消息"而不是"点按钮"：有了 minSeats 之后按钮是**灰的**，
     *    点它什么都不会发生（浏览器根本不给 disabled 的按钮派发 click）——
     *    所以"点按钮 → 被拒 → 提示条"这条界面路径已经不存在了，
     *    取而代之的是按钮旁边那句"至少要 2 个座位…按「添加人机」补一个"（上面刚验过）。
     *
     *    但**服务端那道闸不能不验**：按钮灰着是平台外壳的礼貌，
     *    真防线在 `server/rooms.mjs` 的 `start()`（它只认座位数）。
     *    这里发出去的就是按钮本来会发的那条报文，验的是
     *    "服务端拒绝 → shared/ui/room.js 的 Net.on(T.ERROR) → 提示条"这条链路。
     *    哪天平台把 disabled 改坏了、或者有人从控制台发消息，这条就是最后一道防线。
     */
    await page.evalRaw(`(() => {
      window.GameNet.send(window.FrpProtocol.T.ROOM_START, { options: {} });
      return true;
    })()`);

    await page.waitFor(
      `return [...document.querySelectorAll('.frp-toast')].some(function (t) { return t.textContent.indexOf('座位不够') >= 0 })`,
      10_000,
      '一个人 + 1 个座位：界面上出现了服务端拒绝的提示条'
    );
    const soloRejectMsg = await page.eval(
      `return [...document.querySelectorAll('.frp-toast')].map(function (t) { return t.textContent }).join(' | ')`
    );
    console.log(`提示条出现了：「${soloRejectMsg}」`);
    assert.ok(
      soloRejectMsg.includes('座位不够：至少要 2 个座位'),
      `提示条里必须是服务端那句话（rooms.mjs 的 start），实际「${soloRejectMsg}」`
    );
    assert.ok(
      soloRejectMsg.includes('添加人机'),
      `拒绝的时候必须告诉玩家下一步怎么做（按「添加人机」），实际「${soloRejectMsg}」`
    );
    assert.equal(
      await page.eval(`return document.getElementById('screen-game').classList.contains('is-active')`),
      false,
      '被拒绝时不该进牌桌（进去了就说明拒绝是假的）'
    );
    assert.equal(
      await page.eval(`return document.querySelector('.frp-room-code-value code').textContent`),
      code,
      '被拒绝之后还留在原来的房间里'
    );

    // 提示条是 position:fixed 而且会吃掉真实鼠标点击（AGENTS.md 4.7），先收掉再往下走
    await page.evalRaw(`(() => {
      document.querySelectorAll('.frp-toast').forEach(function (t) { t.click(); });
      return true;
    })()`);
    await page
      .waitFor(`return document.querySelectorAll('.frp-toast').length === 0`, 5_000, '提示条收掉')
      .catch(() => {});

    /* ---------- 4c. 按一下「＋ 添加人机」→ 座位上多一个人机 → 开始 → 走到"轮到我" ---------- */
    /*
     * 这就是用户要的那条路：一个人建房 → 按「＋ 添加人机」 → 开始 → 真的走到"轮到我"。
     * AI 跑在服务器上、且是**同步推完**的（做完才广播），所以客户端这边不需要催任何东西。
     *
     * ⚠️ 用页面内 el.click()：房间面板一收到 room.state 就整块重画，
     *    真实鼠标事件的 mouseReleased 会落在已经被摘掉的旧 DOM 上（AGENTS.md 4.7）。
     */
    await page.evalRaw(`(() => {
      const b = document.querySelector('#screen-online .frp-room-bot-add');
      if (b) b.click();
      return true;
    })()`);
    await page.waitFor(
      `return document.querySelectorAll('#screen-online .frp-room-member').length === 2`,
      10_000,
      '人机座位坐进来了（成员列表 2 行）'
    );

    const botSeat = await page.evalRaw(`(() => {
      const rows = [...document.querySelectorAll('#screen-online .frp-room-member')];
      const bot = rows.find(function (r) { return r.classList.contains('is-bot'); });
      const startBtn = document.querySelector('#screen-online .frp-room-actions .frp-btn-primary');
      return {
        exists: !!bot,
        name: bot ? bot.querySelector('.frp-room-member-name').textContent : null,
        grayRing: bot ? !!bot.querySelector('.frp-avatar.is-bot') : false,
        avatarClickable: bot ? !!bot.querySelector('[data-frp-avatar]') : false,
        tag: bot ? (bot.querySelector('.frp-room-tag-bot') || {}).textContent : null,
        seatCount: (document.querySelector('#screen-online .frp-room-seat-count') || {}).textContent,
        startDisabled: startBtn ? startBtn.disabled : null,
        // 同样只认座位那一句（见上面 4b 的说明）
        noteGone: !document.querySelector('#screen-online .frp-room-waiting > .frp-room-note'),
      };
    })()`);
    assert.ok(botSeat.exists, '成员列表里应当出现一个人机座位');
    assert.ok(botSeat.grayRing, '人机头像必须是**灰环**（.frp-avatar.is-bot）');
    assert.ok(botSeat.avatarClickable, '人机头像也要能点头像互动（data-frp-avatar）');
    assert.equal(botSeat.tag, '人机', '人机座位要带「人机」标签，玩家不该误以为来了个陌生人');
    assert.equal([...botSeat.name].length, 1, `人机名字必须是单字，实际「${botSeat.name}」`);
    assert.ok(
      meta.botNames.includes(botSeat.name),
      `人机名字必须来自本作的单字池（meta.botNames），实际「${botSeat.name}」`
    );
    assert.match(botSeat.seatCount, /2 \/ 4/, `座位数应变成 2 / 4，实际「${botSeat.seatCount}」`);
    assert.equal(botSeat.startDisabled, false, '座位够 2 个之后「开始游戏」必须解禁');
    assert.ok(botSeat.noteGone, '座位够了之后"至少要 2 个座位"那句提示应当消失');
    console.log(`按了「＋ 添加人机」：座位 ${botSeat.seatCount}，人机「${botSeat.name}」，灰环 ${botSeat.grayRing}`);

    await page.evalRaw(`(() => {
      const b = document.querySelector('#screen-online .frp-room-actions .frp-btn-primary');
      if (b) b.click();
      return true;
    })()`);
    await page
      .waitFor(`return document.getElementById('screen-game').classList.contains('is-active')`, 15_000, '联机牌桌出现（1 真人 + 1 人机座位）')
      .catch(async (err) => {
        const diag = await page.evalRaw(`(() => ({
          connected: window.GameNet.connected,
          room: window.GameNet.room && { code: window.GameNet.room.code, phase: window.GameNet.room.phase, members: window.GameNet.room.members.length },
          activeScreen: (document.querySelector('.screen.is-active') || {}).id,
          toasts: [...document.querySelectorAll('.frp-toast')].map(function (e) { return e.textContent }).join(' | '),
        }))()`);
        throw new Error(`${err.message}\n  诊断：${JSON.stringify(diag)}`);
      });
    await page.waitFor(`return document.querySelectorAll('#screen-game .seat').length === 2`, 15_000, '2 个座位（我 + 1 个人机）');

    const soloSeats = await page.eval(`return [...document.querySelectorAll('#screen-game .seat .seat-name')].map(function(e){return e.textContent})`);
    console.log(`联机开局（1 个真人 + 1 个人机座位）：座位 ${JSON.stringify(soloSeats)}`);
    assert.ok(soloSeats.some((n) => n.includes(`（我）`)), '自己的座位要带"（我）"');
    assert.ok(
      soloSeats.some((n) => n.includes(botSeat.name)),
      `牌桌上应当出现那个人机座位「${botSeat.name}」，实际 ${JSON.stringify(soloSeats)}`
    );

    /*
     * 牌桌头像：平台互动认 `data-frp-avatar`，圆环配色靠视图里的 `isAI`
     * （自己=蓝 / 其他真人=橙 / 人机=灰，用户点名要求三个游戏一致）。
     * 这一版是**新加的**，所以在这里真量一遍：属性在不在、类名对不对。
     */
    const boardAvatars = await page.evalRaw(`(() => {
      return [...document.querySelectorAll('#screen-game .seat')].map(function (seat) {
        const av = seat.querySelector('.avatar');
        const name = seat.querySelector('.seat-name').textContent;
        if (!av) return { name: name, missing: true };
        const r = av.getBoundingClientRect();
        return {
          name: name,
          id: av.getAttribute('data-frp-avatar'),
          frpName: av.getAttribute('data-frp-name'),
          cls: av.className,
          hasImg: !!av.querySelector('img.frp-avatar-img'),
          imgSrc: av.querySelector('img.frp-avatar-img')
            ? av.querySelector('img.frp-avatar-img').getAttribute('src') : '',
          ring: av.classList.contains('is-me') ? 'me' : av.classList.contains('is-bot') ? 'bot' : av.classList.contains('is-human') ? 'human' : '无',
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      });
    })()`);
    for (const a of boardAvatars) {
      assert.ok(!a.missing, `${a.name} 的座位上没有头像`);
      assert.ok(/^[A-Za-z0-9:_-]{1,32}$/.test(a.id || ''), `${a.name} 的头像缺 data-frp-avatar（实际 ${a.id}）`);
      assert.ok(a.frpName && a.frpName.length > 0, `${a.name} 的头像缺 data-frp-name`);
      assert.ok(a.w >= 44 && a.h >= 44, `${a.name} 的头像点击区必须 ≥44px，实际 ${a.w}×${a.h}`);
      if (a.ring === 'bot') {
        assert.ok(!a.hasImg, `${a.name} 是人机，不该有图片头像：${a.imgSrc}`);
      } else {
        assert.ok(a.hasImg, `${a.name} 是真人，头像要显示平台图片`);
        assert.match(a.imgSrc, /^\/avatar\//, `${a.name} 的头像地址要指向平台：${a.imgSrc}`);
      }
    }
    const rings = boardAvatars.map((a) => a.ring).sort();
    assert.deepEqual(rings, ['bot', 'me'], `牌的圆环应当恰好是自己(蓝)+人机(灰)，实际 ${JSON.stringify(rings)}`);
    console.log(
      `牌桌头像：${boardAvatars.map((a) => `${a.frpName}=${a.ring}(${a.w}px)`).join(' / ')} —— 圆环语义色对上了`
    );

    /*
     * 开局回放（用户实机反馈："我在 3 号位却是第一个行动"）：
     * 服务端把 1 号位（往往是人机）那一整轮**在广播之前**就跑完了，老写法一条都不回放 ——
     * 玩家一进牌桌就已经轮到自己，看起来像自己先手。现在从"这一步的补丁是全量基线"起
     * 一条条演出来，所以对局记录的第一条必然是「第 1 轮」，后面才是 1 号位、2 号位的动作。
     */
    const onlineOpening = await assertOpeningReplayed(page, '联机（1 真人 + 1 人机座位）');
    console.log(
      `联机开局回放：对局记录第一条是「${onlineOpening[0]}」 —— 开场动作按座位顺序演出来` +
        `（共 ${onlineOpening.length} 条：${onlineOpening.slice(1, 4).join(' / ')}${onlineOpening.length > 4 ? ' …' : ''}）`
    );

    // "轮到我"：服务端把 AI 推完之后才广播，所以这个按钮一定会出现
    await page.waitFor(`return document.querySelectorAll('#screen-game .act-btn').length > 0`, 25_000, '轮到我（出现动作按钮）');
    const turnHint = await page.eval(`return document.querySelector('#screen-game .turn-hint').textContent`);
    const actCount = await page.eval(`return document.querySelectorAll('#screen-game .act-btn').length`);
    console.log(`联机（1 真人 + 1 人机）：${turnHint}（${actCount} 个动作按钮）`);

    /* ---------- 4c-A. 新契约①：点下去**本机不演**（本地预演已删除，D10） ---------- */
    /*
     * 旧口径（用户已否掉）是"点下去立刻播起手"：枪口火光 + 音效，等服务器回包再对齐。
     * 用户实测**快速连点会把画面演成"所有人都被打死了"** —— 预演和回放是两条时间轴，
     * 叠在一起就乱。所以现在的契约是：点下去到回包之间**本机什么都不播**，
     * 画面上"我这一手"完全由服务端回放的那一步演出来（`docs/DECISIONS.md` D10）。
     *
     * 观测手段（都在页面里，包一层计数器）：
     *   · `GameNet.send` 里数 `room.act` —— "消息到底发没发"的唯一硬证据；
     *   · `AudioContext.createOscillator` —— 本作的音效全是 WebAudio 现场合成的
     *     正弦/方波，每次 `tone()` 都会建一个振荡器，用它数"这一下有没有出声"
     *     （`sfx` 是模块私有的，从页面外面取不到）；
     *   · `#fx-layer` 里的火光/伤害数字节点 —— 特效走 DOM，同一帧里数得出来。
     * ⚠️ **点击与取值必须在同一次页面求值里做完**：分两步的话中间那几毫秒正好能让
     *    服务器回包插进来，断言就成了掷骰子（这一条 cannon-goblin 的改造者踩过）。
     */
    await page.evalRaw(`(() => {
      if (!window.__sgActs) window.__sgActs = 0;
      if (!window.__sgOsc) window.__sgOsc = 0;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC && AC.prototype.createOscillator && !window.__sgOscHooked) {
        var origOsc = AC.prototype.createOscillator;
        AC.prototype.createOscillator = function () { window.__sgOsc++; return origOsc.apply(this, arguments); };
        window.__sgOscHooked = true;
      }
      if (!window.__sgSendHooked) {
        var origSend = window.GameNet.send;
        window.GameNet.send = function (t, p) {
          if (t === window.FrpProtocol.T.ROOM_ACT) window.__sgActs++;
          return origSend.apply(this, arguments);
        };
        window.__sgSendHooked = true;
      }
      return true;
    })()`);

    await waitIdle(page, '联机牌桌：演出队列排空（点击才真的发得出去）');

    /*
     * ===== 4c-A / 4c-A2 / 4c-D 三件事在**同一次页面求值**里做完 =====
     *
     * 三条验的都是"点下去之后的那两三秒"：
     *   · 4c-A ：点下去到服务器回包之间**本机一帧都不许演**（D10 前半条）；
     *   · 4c-A2：服务端一次推来的多条事件要**一条一条**演（不是同一帧全冒出来）；
     *   · 4c-D ：**整块牌桌按步走** —— 演到第几步，血量点 / 弹药数 / 回合数 / 锯子 /
     *            轮到谁就是第几步的值，而**不是**最终结算值（用户这一轮报的那条：
     *            "动画还没播完，对方的血量就已经是结算状态了"）。
     *
     * 【为什么必须挤在一个求值里】分成几次求值就有几次 CDP 往返（几毫秒到几十毫秒），
     * 而演出总共只有 2~3 秒：第一帧很容易被错过，"演出中途"这个窗口根本抓不稳，
     * 断言会偶发红而且毫无线索。所以：**点一下 → 同一个 JS 回合里取值 → 然后在这个
     * 求值里一直采样到队列排空 + 对账落地**（"采样"这件事本身就是把队列卡在中间看的
     * 做法，比"往队列里塞一条探针步"更彻底：探针步只能拉长尾巴，这里是从第一步开始逐步看）。
     *
     * 观测手段（都在页面里，包一层计数器）：
     *   · `GameNet.send` 里数 `room.act` —— "消息到底发没发"的唯一硬证据；
     *   · `AudioContext.createOscillator` —— 本作的音效全是 WebAudio 现场合成的
     *     正弦/方波，每次 `tone()` 都会建一个振荡器，用它数"这一下有没有出声"
     *     （`sfx` 是模块私有的，从页面外面取不到）；
     *   · `#fx-layer` 里的火光/伤害数字节点 —— 特效走 DOM，同一帧里数得出来；
     *   · 牌桌上的 `.js-round` / `.js-live` / `.js-blank` / `.js-saw` / 每个座位的
     *     血量点（`.hp i` 里没有 `off` 的那些）与 `.is-turn` / `.is-dead` ——
     *     **逐步同步**要比的就是这几个数。
     */
    const fire = await page.evalRaw(`(async () => {
      const fireSnapshot = () => ({
        muzzle: document.querySelectorAll('#fx-layer .fx-muzzle').length,
        damage: document.querySelectorAll('#fx-layer .fx-damage').length,
        osc: window.__sgOsc,
        acts: window.__sgActs,
        feed: document.querySelectorAll('#screen-game .feed-item').length,
        banner: document.getElementById('banner').textContent,
        seq: document.getElementById('screen-game').dataset.seq,
        actions: document.querySelector('#screen-game .js-actions').innerHTML,
        hand: document.querySelector('#screen-game .js-hand').innerHTML,
      });
      const boardSnapshot = () => {
        const h = document.getElementById('screen-game');
        const seats = [...h.querySelectorAll('.seat')];
        const lit = (s) => {
          const hp = s.querySelector('.hp');
          return hp ? [...hp.children].filter((i) => !i.classList.contains('off')).length : -1;
        };
        return {
          seq: Number(h.dataset.seq || 0),
          busy: window.FrpAnim.busy(),
          bodyBusy: document.body.classList.contains('frp-anim-busy'),
          live: Number(h.querySelector('.js-live').textContent),
          blank: Number(h.querySelector('.js-blank').textContent),
          round: Number(h.querySelector('.js-round').textContent),
          sawHidden: h.querySelector('.js-saw').hidden,
          feed: h.querySelectorAll('.feed-item').length,
          seats: seats.map((s) => {
            const av = s.querySelector('.avatar');
            return {
              id: av ? av.getAttribute('data-frp-avatar') : null,
              hp: lit(s),
              dead: s.classList.contains('is-dead'),
              turn: s.classList.contains('is-turn'),
            };
          }),
        };
      };

      const before = fireSnapshot();
      const btn =
        document.querySelector('#screen-game .act-btn.shoot') ||
        document.querySelector('#screen-game .act-btn.self');
      if (!btn) return null;
      const label = btn.textContent;
      btn.click();
      const after = fireSnapshot();   // 同一个 JS 回合里取值：本机**什么都没演**

      const t0 = performance.now();
      const trace = [];
      let settled = null;
      for (let i = 0; i < 200; i++) {
        const s = boardSnapshot();
        trace.push({ t: Math.round(performance.now() - t0), ...s });
        const rv = window.GameNet.room && window.GameNet.room.view;
        if (i > 4 && !s.busy && rv && rv.seq > Number(before.seq || 0)) {
          // 队列空了，再等一拍：对账是 60ms 一次的小轮询，落地之后画面才等于权威视图
          await new Promise(function (r) { setTimeout(r, 400); });
          settled = boardSnapshot();
          break;
        }
        await new Promise(function (r) { setTimeout(r, 50); });
      }

      const rv = window.GameNet.room && window.GameNet.room.view;
      return {
        label: label,
        before: before,
        after: after,
        trace: trace,
        settled: settled,
        auth: rv
          ? {
              seq: rv.seq,
              round: rv.round,
              live: rv.magazine.live,
              blank: rv.magazine.blank,
              saw: rv.saw,
              turn: rv.turn,
              players: rv.players.map(function (p) { return { id: p.id, hp: p.hp, alive: p.alive }; }),
              // 每一步的补丁（服务器算好的"这一步之后的公开状态"）—— 逐步同步的**基准**
              patches: rv.log.map(function (e) { return { n: e.n, s: e.s }; }),
            }
          : null,
      };
    })()`);
    assert.ok(fire, '轮到我时必须至少有一个开枪按钮');
    const beforeFire = fire.before;
    const afterFire = fire.after;
    assert.equal(afterFire.acts, beforeFire.acts + 1, '点下去消息必须照发（"本机不演"不等于"不发消息"）');
    assert.ok(
      afterFire.muzzle <= beforeFire.muzzle,
      `点下去本机不许放枪口火光（本地预演已删除），实际 ${beforeFire.muzzle} → ${afterFire.muzzle}`
    );
    assert.ok(
      afterFire.damage <= beforeFire.damage,
      `点下去本机不许出伤害数字，实际 ${beforeFire.damage} → ${afterFire.damage}`
    );
    assert.equal(afterFire.osc, beforeFire.osc, '点下去本机不许出声（预演的"击发"音已经删掉）');
    assert.equal(afterFire.feed, beforeFire.feed, '服务端回包之前对局记录不许动');
    assert.equal(afterFire.banner, beforeFire.banner, '服务端回包之前横幅不许动');
    assert.equal(afterFire.seq, beforeFire.seq, '服务端回包之前画面（视图序号）不许动');
    assert.equal(afterFire.actions, beforeFire.actions, '服务端回包之前动作区不许重画');
    assert.equal(afterFire.hand, beforeFire.hand, '服务端回包之前手牌区不许重画');
    console.log(
      `点了「${fire.label}」：同一帧内火光 ${beforeFire.muzzle}→${afterFire.muzzle}、` +
        `音效 ${beforeFire.osc}→${afterFire.osc}、room.act ${beforeFire.acts}→${afterFire.acts}` +
        `（消息发了，本机一帧都没演）`
    );

    /* ---------- 4c-A2. 逐条演出：一次推来的事件要**一条一条**演，不是同一帧全冒出来 ---------- */
    /*
     * 用户需求 1（本作最严重的那条）：`board.js` 的 `playNewEvents()` 从同步 for 循环
     * 改成 `FrpAnim.push(steps, …)`，每步 **450–700ms**，顺序/数量/去重一个字不许变。
     *
     * 观测量用"对局记录"（`.feed-item`）的条数 —— 数据直接来自上面那份采样轨迹
     * （4c-A 那次点击之后每 50ms 一个点），不再单独求值采样：分开求值的话，
     * 那段演出可能已经演完了，采样会看到"0 次增长"而**假红**。
     * 同步老写法下这一帧会把所有事件一次全塞进去 → 只有 1 次增长，这条立刻红。
     * ⚠️ 只断言"分多次 + 相邻两次间隔 ≥300ms"（留出采样与定时器抖动的余量），
     *    不逐条卡死 450/560/700 那三个数 —— 那种断言会因为机器忙而随机红。
     *
     * ⚠️ **它必须紧跟在"开局第一手"那次点击后面**：开局第一次 `room.act` 的回包是
     *    **最富**的一帧（我这一手 + 人机的整个回合都在里面），后面的回合可能只带回一条
     *    事件（实测：第二手的回包只多出 1 条对局记录，而队列照样演了 2.2 秒 ——
     *    "分多次长起来"这条会因为**没内容可长**而假红，不是演出退化了）。
     *    4c-A 已经把"点击 + 取值 + 采样"合成了一个求值，所以顺序天然是对的。
     */
    const grew = [];
    let seenFeed = fire.trace[0].feed;
    for (const s of fire.trace) {
      if (s.feed > seenFeed) { grew.push(s.t); seenFeed = s.feed; }
    }
    const gaps = grew.slice(1).map((t, i) => t - grew[i]);
    const traceLine = fire.trace
      .map((s) => `${s.t}:n${s.feed}/s${s.seq}${s.busy ? '*' : ''}`)
      .join(' ');
    console.log(
      `逐条演出：对局记录分 ${grew.length} 次长起来（时刻 ${grew.join('/')}ms，间隔 ${gaps.join('/')}ms，最终 ${seenFeed} 条）`
    );
    console.log(`  采样轨迹（t:n/seq，* = 队列在演）：${traceLine}`);
    assert.ok(
      grew.length >= 2,
      `一次推来的多条事件必须分多次演（实际只长了 ${grew.length} 次 = 还是同步全冒出来）\n  轨迹：${traceLine}`
    );
    assert.ok(
      Math.max(...gaps) >= 300,
      `相邻两条必须拉开接近 450–700ms 的节奏，实际间隔 ${JSON.stringify(gaps)}\n  轨迹：${traceLine}`
    );

    /* ---------- 4c-D. 整块牌桌按步走：演到第几步画面就是第几步（用户这一轮报的 bug） ---------- */
    /*
     * 【这条才是这一版真正要钉的东西】用户原话：
     * "恶魔轮盘在线对局中，ui 动画还没播放完对方的血量就已经是结算状态了，
     *  血量等参数与动画不同步"。
     *
     * 根因是老的 `render(view)` 一收到报文就按**最终**状态重画整块牌桌，
     * 只有"播报 + 特效"进了串行队列。新契约（GAME-SPEC §4「逐步同步」、D14）是：
     * 服务器给每条日志带一份"这一步之后的公开状态补丁"（`entry.s`），客户端**逐步**贴到
     * 显示视图上再重画 —— 整块牌桌（回合数 / 弹药数 / 锯子 / 血量点 / 轮到谁）都跟着演出走，
     * 整批演完再用权威视图对账一次。
     *
     * 【判据】演出中途采到的每一个样本，`dataset.seq` 就是"画面此刻照着画的那一步"，
     * 拿它去 `room.view.log` 里找**同一条**日志的补丁，补丁说多少、屏幕上就必须是多少；
     * 并且至少有一次样本明显**不是**最终结算值（这正是老写法会当场露馅的地方）。
     */
    assert.ok(fire.auth, '采样结束时应当已经拿到服务器推来的新视图');
    const baseSeq = Number(beforeFire.seq || 0);
    const finalSeq = fire.auth.seq;
    const patchOf = new Map(fire.auth.patches.map((p) => [p.n, p.s]));
    const mid = fire.trace.filter((s) => s.busy && s.seq > baseSeq && s.seq < finalSeq);
    assert.ok(
      fire.trace.some((s) => s.busy),
      '这一帧的演出必须真的忙起来过（后面 4c-B 就靠它证明"锁输入"的窗口天然存在）'
    );
    assert.ok(
      fire.trace.some((s) => s.busy && s.bodyBusy),
      '自然演出期间 <body> 也要带 frp-anim-busy（CSS 那一半靠它变灰）'
    );
    assert.ok(
      mid.length >= 1,
      `演出中途必须采到"还没演到最后一步"的画面：采了 ${fire.trace.length} 次，` +
        `视图序号 ${baseSeq} → ${finalSeq}\n  轨迹：${traceLine}`
    );

    const finalBoard = {
      live: fire.auth.live,
      blank: fire.auth.blank,
      round: fire.auth.round,
      hp: Object.fromEntries(fire.auth.players.map((p) => [p.id, p.hp])),
    };
    const patchMiss = [];
    let notFinal = 0;
    for (const s of mid) {
      const patch = patchOf.get(s.seq);
      if (!patch) {
        patchMiss.push(`第 ${s.seq} 步在日志窗口里找不到补丁（每一步都该带）`);
        continue;
      }
      if (patch.magazine) {
        if (s.live !== patch.magazine.live || s.blank !== patch.magazine.blank) {
          patchMiss.push(
            `第 ${s.seq} 步弹药数：画面 ${s.live}/${s.blank} ≠ 补丁 ${patch.magazine.live}/${patch.magazine.blank}`
          );
        }
      }
      if (typeof patch.round === 'number' && s.round !== patch.round) {
        patchMiss.push(`第 ${s.seq} 步回合数：画面 ${s.round} ≠ 补丁 ${patch.round}`);
      }
      if (typeof patch.saw === 'boolean' && s.sawHidden !== !patch.saw) {
        patchMiss.push(`第 ${s.seq} 步锯子：hidden=${s.sawHidden} ≠ 补丁 saw=${patch.saw}`);
      }
      if (patch.turn) {
        for (const seat of s.seats) {
          if (seat.turn !== (seat.id === patch.turn)) {
            patchMiss.push(`第 ${s.seq} 步"轮到谁"不对：${seat.id} turn=${seat.turn}（补丁说是 ${patch.turn}）`);
          }
        }
      }
      for (const cp of patch.players || []) {
        const seat = s.seats.find((x) => x.id === cp.id);
        if (!seat) continue;
        if (typeof cp.hp === 'number' && seat.hp !== cp.hp) {
          patchMiss.push(`第 ${s.seq} 步 ${cp.id} 的血量点：画面 ${seat.hp} ≠ 补丁 ${cp.hp}`);
        }
        if (typeof cp.alive === 'boolean' && seat.dead === cp.alive) {
          patchMiss.push(`第 ${s.seq} 步 ${cp.id} 的存活标记不对（画面 dead=${seat.dead}，补丁 alive=${cp.alive}）`);
        }
      }
      // 这一瞬间"还不是最终结算状态"吗？（弹药数 / 血量点 / 回合数任意一项不同就算）
      const differs =
        s.live !== finalBoard.live ||
        s.blank !== finalBoard.blank ||
        s.round !== finalBoard.round ||
        s.seats.some((seat) => finalBoard.hp[seat.id] !== undefined && seat.hp !== finalBoard.hp[seat.id]);
      if (differs) notFinal++;
    }
    assert.deepEqual(
      patchMiss,
      [],
      `画面和"那一步的补丁"对不上 —— 逐步同步没做到（演出还在演、数字已经是结果了）：\n  ${patchMiss.slice(0, 10).join('\n  ')}`
    );
    assert.ok(
      notFinal >= 1,
      '至少要采到一次"画面还不是最终结算状态"的样本 —— 这正是用户报的那条 bug' +
        `（"动画还没播完，对方的血量就已经是结算状态"）\n  轨迹：${traceLine}`
    );
    console.log(
      `逐步同步：采样 ${fire.trace.length} 次，其中 ${mid.length} 次停在演出中途` +
        `（第 ${[...new Set(mid.map((s) => s.seq))].join('/')} 步 < 最终第 ${finalSeq} 步），` +
        `${notFinal} 次明显不是最终结算值；每一步的弹药数/血量点/回合数/轮到谁都与那一步的补丁一致`
    );

    /*
     * 队列排空 + 对账之后：画面必须**整体等于权威视图**（这一步是收口，也是兜底）。
     * 采样时特意多等了 400ms：对账是 60ms 一次的小轮询，落地之后画面才等于权威视图。
     */
    assert.ok(fire.settled, '采样结束时队列应当已经排空（settled 为空说明 8 秒都没演完）');
    assert.equal(fire.settled.busy, false, '采样结束时队列必须已经排空');
    assert.equal(fire.settled.seq, finalSeq, '对账之后画面的视图序号必须等于权威视图');
    assert.equal(fire.settled.live, finalBoard.live, '对账之后实弹数必须等于权威视图');
    assert.equal(fire.settled.blank, finalBoard.blank, '对账之后空弹数必须等于权威视图');
    assert.equal(fire.settled.round, finalBoard.round, '对账之后回合数必须等于权威视图');
    assert.equal(fire.settled.sawHidden, !fire.auth.saw, '对账之后锯子标记必须等于权威视图');
    for (const p of fire.auth.players) {
      const seat = fire.settled.seats.find((x) => x.id === p.id);
      assert.ok(seat, `对账之后座位上应当有 ${p.id}`);
      assert.equal(seat.hp, p.hp, `对账之后 ${p.id} 的血量点必须等于权威视图`);
      assert.equal(seat.dead, !p.alive, `对账之后 ${p.id} 的存活标记必须等于权威视图`);
    }
    console.log(
      `对账（队列排空后）：第 ${fire.settled.seq} 步 = 权威视图，` +
        `实弹 ${fire.settled.live} / 空弹 ${fire.settled.blank} / 第 ${fire.settled.round} 回合，` +
        `血量 ${fire.settled.seats.map((s) => `${s.id}:${s.hp}`).join(' ')}`
    );

    /* ---------- 4c-B. 新契约②：演出期间**点不动**（D10 的核心防线） ---------- */
    /*
     * 上面那一帧的天然窗口已经被采样"看"到了（`busy` 与 `body.frp-anim-busy` 都采到过），
     * 而采样是**等到队列排空才返回**的 —— 所以这里不再干等"天然窗口"（等不到了），
     * 改成自己往队列里排一条**占位空步**把窗口造出来：变的只是"演出还要多久"，
     * 判据（`busy()` + `<body>` 类名 + 游戏自己的 CSS/JS 锁）一个字都没变。
     */
    await waitIdle(page, '上一帧演出演完（下面要给队列排一条占位空步）');
    const busyHeld = await page.evalRaw(`(() => {
      window.__sgHold = window.FrpAnim.push([{ fake: true }], function () { return 1600; });
      return { busy: window.FrpAnim.busy(), bodyClass: document.body.classList.contains('frp-anim-busy') };
    })()`);
    assert.equal(busyHeld.busy, true, '占位空步必须让队列忙起来（特效开关被关掉时 FrpAnim 会把时长压成 0，这里会当场变红）');
    assert.equal(busyHeld.bodyClass, true, '演出期间 <body> 必须带 frp-anim-busy');

    const holdSnapshot = `
      acts: window.__sgActs,
      osc: window.__sgOsc,
      muzzle: document.querySelectorAll('#fx-layer .fx-muzzle').length,
      feed: document.querySelectorAll('#screen-game .feed-item').length,
      seq: document.getElementById('screen-game').dataset.seq,
      banner: document.getElementById('banner').textContent,
      actions: document.querySelector('#screen-game .js-actions').innerHTML,
      hand: document.querySelector('#screen-game .js-hand').innerHTML,
      turnHint: document.querySelector('#screen-game .turn-hint').textContent,
      buttons: document.querySelectorAll('#screen-game .act-btn').length,
      cards: document.querySelectorAll('#screen-game .card').length,
      pointerEvents: (function () {
        const b = document.querySelector('#screen-game .act-btn');
        return b ? getComputedStyle(b).pointerEvents : null;
      })(),
      opacity: (function () {
        const b = document.querySelector('#screen-game .act-btn');
        return b ? Number(getComputedStyle(b).opacity) : null;
      })(),
      hitIsButton: (function () {
        const b = document.querySelector('#screen-game .act-btn');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return hit === b;
      })()`;
    const duringBefore = await page.evalRaw(`(() => ({ ${holdSnapshot} }))()`);

    // ① CSS 那一半：动作控件必须变灰，而且命中测试要绕开它（真手指点不进去）
    assert.ok(
      duringBefore.buttons > 0,
      `演出期间动作按钮应当在屏幕上（实际 ${duringBefore.buttons} 个）—— 这正是"看着动画连着操作"的土壤`
    );
    assert.equal(duringBefore.pointerEvents, 'none', '演出期间动作按钮必须 pointer-events:none');
    assert.ok(
      duringBefore.opacity < 0.6,
      `演出期间动作按钮必须变灰（实测 opacity=${duringBefore.opacity}）`
    );
    assert.equal(duringBefore.hitIsButton, false, '演出期间按钮中心点的命中测试必须绕开按钮（真手指点不进去）');

    // ② JS 那一半：绕过 pointer-events 直接 el.click()（等于"从控制台点"），也不许发出任何消息
    const duringAfter = await page.evalRaw(`(() => {
      document.querySelectorAll('#screen-game .act-btn, #screen-game .card').forEach(function (el) { el.click(); });
      return { ${holdSnapshot} };
    })()`);
    assert.equal(duringAfter.acts, duringBefore.acts, '演出期间点动作控件**不许发出 room.act**（D10 的核心防线）');
    assert.equal(duringAfter.seq, duringBefore.seq, '演出期间点下去界面状态不许变（视图序号）');
    assert.equal(duringAfter.actions, duringBefore.actions, '演出期间点下去动作区不许重画');
    assert.equal(duringAfter.hand, duringBefore.hand, '演出期间点下去手牌区不许重画');
    assert.equal(duringAfter.turnHint, duringBefore.turnHint, '演出期间点下去提示语不许变');
    assert.equal(duringAfter.banner, duringBefore.banner, '演出期间点下去横幅不许变');
    assert.equal(duringAfter.feed, duringBefore.feed, '演出期间点下去对局记录不许动（连本地自己加戏都没有）');
    assert.ok(
      duringAfter.muzzle <= duringBefore.muzzle,
      `演出期间点下去不许自己加戏（火光 ${duringBefore.muzzle} → ${duringAfter.muzzle}）`
    );
    assert.equal(duringAfter.osc, duringBefore.osc, '演出期间点下去不许出声');
    console.log(
      `演出期间点了 ${duringBefore.buttons} 个动作按钮 + ${duringBefore.cards} 张手牌：` +
        `room.act ${duringBefore.acts}→${duringAfter.acts}（一个都没发出去）、` +
        `按钮 pointer-events=${duringBefore.pointerEvents} / opacity=${duringBefore.opacity}、界面没动`
    );

    // 放掉占位空步：队列必须能自己跑空（不许卡在"还在演"里）
    await page.evalRaw(`(() => {
      if (window.__sgHold) window.__sgHold.cancel();
      window.FrpAnim.clear();
      return true;
    })()`);
    await waitIdle(page, '占位空步演完：演出队列要能自己跑空');

    /* ---------- 4c-C. 服务器真的在裁决（界面自己不算） ---------- */
    const seqBefore = Number(await page.eval(`return document.getElementById('screen-game').dataset.seq || '0'`));
    /*
     * 这一步**刻意打对手**（`.act-btn.shoot`）而不是打自己：打对手必然让回合交接
     * （服务端一次 act 里连人机的回合一起跑完），seq 会明确变大；
     * 打自己若是空弹会**保留回合**，有可能只推一条事件，"服务器真的裁决了"
     * 这条证据就变弱了（前面 4c-B 刚放掉占位空步，这里必须先等队列排空再点）。
     */
    const shotLabel = await page.evalRaw(`(() => {
      const self = document.querySelector('#screen-game .act-btn.self');
      const other = document.querySelector('#screen-game .act-btn.shoot');
      const btn = other || self;
      const label = btn ? btn.textContent : null;
      if (btn) btn.click();
      return label;
    })()`);
    assert.ok(shotLabel, '轮到我时必须至少有一个开枪按钮');
    console.log(`联机走一步：点了「${shotLabel}」`);
    await page.waitFor(
      `return Number(document.getElementById('screen-game').dataset.seq || '0') > ${seqBefore}`,
      20_000,
      '服务器把我的操作裁决后推回新视图'
    );
    const seqAfter = await page.eval(`return document.getElementById('screen-game').dataset.seq`);
    console.log(`联机走了一步（1 真人 + 1 人机）：seq ${seqBefore} → ${seqAfter}`);
    assert.ok(Number(seqAfter) > seqBefore, 'seq 必须变大（服务器推了新视图）');

    await layoutCheck(page, '联机牌桌（1 真人 + 1 人机）430px');

    // 离开这一局：牌桌右上角菜单 →「离开对局」（联机时发 room.leave，房间会被服务端收掉）
    await page.click('#screen-game .js-menu');
    await page.waitFor(`return !document.getElementById('modal-layer').hidden`, 5_000, '菜单弹窗出现');
    await page.click('#modal-layer .ghost-btn', { index: 2 });
    await page.waitFor(`return document.getElementById('screen-online').classList.contains('is-active')`, 5_000, '离开之后回到在线对局屏');
    await page.waitFor(`return document.querySelector('.frp-room-idle') !== null`, 10_000, '房间入口回来了');

    /* ---------- 4d. 再建一间房，留给第 5 节的两个真人 ---------- */
    const code2 = await createRoom(page);
    console.log(`第二间房建好了：${code2}（这一间要等第二个真人进来）`);

    /* ---------- 5. 第二个真人用房间号加入 → 房主开局（服务器权威那条路） ---------- */
    /*
     * 这一段仍然是**两个真浏览器**：第一个是房主，第二个用房间号 join。
     * 为什么不能只测"一个人 + 电脑"：真人之间的那条路（谁轮到谁、两边收到同一帧、
     * 服务器裁决）只有两个真页面才测得到；AI 补位只是把座位补齐，不替代它。
     */
    const guestPage = await Page.launch({ headless: true, width: 430, height: 932, mobile: true });
    guest = guestPage;
    try {
      await guestPage.goto(app.url);
      await guestPage.waitFor(`return document.getElementById('screen-auth').classList.contains('is-active')`, 10_000, '访客登录页出现');
      await guestPage.click('#tab-register');
      await guestPage.setInput('#register-name', '客');
      await guestPage.setInput('#register-password', 'secret123');
      await guestPage.setInput('#register-password2', 'secret123');
      await guestPage.click('#form-register .btn-primary');
      await guestPage.waitFor(`return !document.getElementById('modal-id').hidden`, 15_000, '访客领到 ID');
      const guestId = await guestPage.eval(`return document.getElementById('new-id').textContent`);
      await guestPage.click('#btn-id-done');
      await guestPage.waitFor(`return window.GameNet && window.GameNet.connected === true`, 15_000, '访客连上平台');

      await guestPage.goto(new URL(`/games/${SLUG}/`, app.url).href);
      await guestPage.waitFor(`return document.body.dataset.sgReady === '1'`, 15_000, '访客游戏页就绪');
      await guestPage.waitFor(`return window.GameNet && window.GameNet.connected === true`, 20_000, '访客游戏页连上');
      await guestPage.click('[data-go="online"]');
      await guestPage.waitFor(`return document.querySelector('.frp-room-idle') !== null`, 10_000, '访客看到房间入口');
      await guestPage.setInput('.frp-room-joinform .frp-input', code2);
      await guestPage.evalRaw(`(() => {
        const f = document.querySelector('.frp-room-joinform');
        f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return true;
      })()`);
      await guestPage.waitFor(
        `return document.querySelector('.frp-room-code-value code') && document.querySelector('.frp-room-code-value code').textContent === ${JSON.stringify(code2)}`,
        15_000,
        '访客进了同一个房间'
      );
      console.log(`第二个真人（${guestId}）用房间号 ${code2} 加入成功`);

      /*
       * 两个真人到齐、座位也够 2 个了：房主这边「开始游戏」可点。
       * （上一个房间加过的人机**不会**跟过来 —— 人机挂在房间上，新房间是干净的。）
       */
      await page.waitFor(`return document.querySelectorAll('#screen-online .frp-room-member').length === 2`, 15_000, '房主看到 2 个成员');
      const ready = await page.evalRaw(`(() => {
        const b = document.querySelector('#screen-online .frp-room-actions .frp-btn-primary');
        const seats = document.querySelector('#screen-online .frp-room-seat-count');
        return {
          text: b ? b.textContent : null,
          disabled: b ? b.disabled : null,
          seatCount: seats ? seats.textContent : null,
          bots: document.querySelectorAll('#screen-online .frp-room-member.is-bot').length,
        };
      })()`);
      assert.equal(ready.disabled, false, '2 个真人到齐后「开始游戏」必须可点');
      assert.match(ready.seatCount, /2 \/ 4/, `座位数应当是 2 / 4，实际「${ready.seatCount}」`);
      assert.equal(ready.bots, 0, '新房间里不该有上一条用例加的人机（人机挂在房间上）');
      console.log(`两个人到齐：「${ready.text}」可点，${ready.seatCount}`);

      /*
       * 客人那边：座位条是**只读文字**（"人机由房主添加"），没有能点的控件 ——
       * GAME-SPEC 第 8 节的"房间的界面归平台，游戏只填设置项"。
       * 本作现在连设置项都没有，所以客人的准备区应该是**空的**（没有 .frp-room-setup）。
       */
      const guestSetup = await guestPage.evalRaw(`(() => {
        const bar = document.querySelector('.frp-room-seats');
        const setup = document.querySelector('.frp-room-setup');
        return {
          barText: bar ? bar.textContent : '(没有座位条)',
          addButton: bar ? bar.querySelectorAll('button').length : -1,
          hasSetupBox: !!setup,
          setupText: setup ? setup.textContent : '',
        };
      })()`);
      assert.equal(guestSetup.addButton, 0, '客人那边不许有能点的人机控件');
      assert.match(guestSetup.barText, /人机由房主添加/, `客人只该看到只读文字，实际「${guestSetup.barText}」`);
      assert.equal(guestSetup.hasSetupBox, false, '本作在准备区没有设置项，客人那边不该有空的设置区');
      console.log(`客人看到的座位条是只读文字：「${guestSetup.barText}」`);

      // 房主开局（用页面内 click：点一下就会重画，鼠标事件容易点空）
      await page.evalRaw(`(() => {
        document.querySelector('#screen-online .frp-room-actions .frp-btn-primary').click();
        return true;
      })()`);
      await page
        .waitFor(`return document.getElementById('screen-game').classList.contains('is-active')`, 15_000, '联机牌桌出现')
        .catch(async (err) => {
          const diag = await page.evalRaw(`(() => ({
            connected: window.GameNet.connected,
            room: window.GameNet.room && { code: window.GameNet.room.code, phase: window.GameNet.room.phase, members: window.GameNet.room.members.length },
            activeScreen: (document.querySelector('.screen.is-active') || {}).id,
            toasts: [...document.querySelectorAll('.frp-toast')].map(function (e) { return e.textContent }).join(' | '),
          }))()`);
          throw new Error(`${err.message}\n  诊断：${JSON.stringify(diag)}`);
        });
      await page.waitFor(`return document.querySelectorAll('#screen-game .seat').length === 2`, 15_000, '两个真人各占一个座位');

      const onlineSeats = await page.eval(`return [...document.querySelectorAll('#screen-game .seat .seat-name')].map(function(e){return e.textContent})`);
      console.log(`联机对局开局（服务器权威，2 个真人）：座位 ${JSON.stringify(onlineSeats)}`);

      // 客人的屏幕也要跟着切到牌桌，并且两个页面看到的座位一致
      await guestPage.waitFor(`return document.getElementById('screen-game').classList.contains('is-active')`, 15_000, '访客也切到牌桌');
      await guestPage.waitFor(`return document.querySelectorAll('#screen-game .seat').length === 2`, 15_000, '访客看到两个座位');
      const guestSeats = await guestPage.eval(`return [...document.querySelectorAll('#screen-game .seat .seat-name')].map(function(e){return e.textContent})`);
      assert.equal(
        guestSeats.join(',').replace('（我）', ''),
        onlineSeats.join(',').replace('（我）', ''),
        '两个真人看到的座位必须一致（「（我）」是各自本地加的标记，不参与比较）'
      );
      console.log(`两个页面看到的座位一致：${onlineSeats.join(' / ')} ↔ ${guestSeats.join(' / ')} —— 服务器是唯一权威`);

      await layoutCheck(page, '联机对局牌桌 430px');

      /* ---------- 6. 服务器权威：谁轮到谁点，两边都不许自己算 ---------- */
      /*
       * 两个真人、座位随机，谁先手不一定。所以这里**不能**假定某一边轮得到，
       * 而是两个页面一起轮询：谁出现了动作按钮就由谁点。
       * 点完之后两边都必须收到服务器推下来的新 view（seq 变大）——
       * 这才是"服务器裁决 + 裁剪视图推送"的真证据。
       */
      const seqOf = async (p) => Number(await p.eval(`return document.getElementById('screen-game').dataset.seq || '0'`));
      /*
       * ⚠️ "有按钮" ≠ "点得动"：`render()` 是同步把最新一帧画出来的，而演出还在排队
       *    （D10 起演出期间输入是锁的）。所以"能操作"要**同时**满足
       *    "有动作按钮" + "演出队列排空" —— 只看按钮的话，点下去等于没点，
       *    后面的 waitFor（seq 变大）会白等到超时。
       */
      const canAct = async (p) =>
        (await p.eval(`return document.querySelectorAll('#screen-game .act-btn').length`)) > 0 &&
        (await p.eval(`return !window.FrpAnim || window.FrpAnim.busy() === false`)) === true;
      const isOver = async (p) => (await p.eval(`return document.body.innerText.includes('本局结束')`)) === true;

      let mover = null;
      const round0 = await page.eval(`return document.querySelector('#screen-game .js-round').textContent`);

      for (let tick = 0; tick < 200 && !mover; tick++) {
        if (await isOver(page)) break;
        for (const [who, p] of [['房主', page], ['客人', guestPage]]) {
          if (await canAct(p)) { mover = { who, p }; break; }
        }
        if (mover) break;
        await page.evalRaw(`return new Promise(function (r) { setTimeout(r, 150); })`);
      }

      if (!mover) {
        console.log(`联机对局：还没轮到真人操作，对局就结束了（第 ${round0} 轮）—— 服务器已经裁决完毕`);
        assert.ok(await isOver(page), '既没人能操作、又没结束，说明卡住了');
      } else {
        // 先把提示条收掉（平台提示条固定在右下角，会吃掉按屏幕坐标发的点击）
        for (const p of [mover.p]) {
          for (let i = 0; i < 5; i++) {
            if (!(await p.eval(`return document.querySelectorAll('.frp-toast.is-visible').length`))) break;
            await p.click('.frp-toast.is-visible');
            await p.evalRaw(`return new Promise(function (r) { setTimeout(r, 200); })`);
          }
        }
        const before = await seqOf(mover.p);
        // 再确认一次队列空了（canAct 已经判过，但从轮询到点击之间还会过几百毫秒的收尾）
        await waitIdle(mover.p, `${mover.who}：演出排空（否则这一点等于没点）`);
        await mover.p.click('#screen-game .act-btn.self');
        await mover.p.waitFor(
          `return Number(document.getElementById('screen-game').dataset.seq || '0') > ${before}`,
          20_000,
          `${mover.who}的操作被服务器裁决并推回新 view`
        );
        const afterMover = await seqOf(mover.p);
        console.log(`联机走了一步：${mover.who}点了「对自己开枪」，seq ${before} → ${afterMover}`);

        // 对面那个页面也必须跟着更新（它自己没有做任何本地判定）
        const other = mover.p === page ? guestPage : page;
        const otherName = mover.p === page ? '客人' : '房主';
        await other.waitFor(
          `return Number(document.getElementById('screen-game').dataset.seq || '0') > ${before}`,
          20_000,
          `${otherName}也收到了同一次服务器推送`
        );
        const afterOther = await seqOf(other);
        assert.equal(afterOther, afterMover, '两边页面拿到的 seq（也就是同一帧视图）必须一致');
        console.log(`对面（${otherName}）也收到同一帧：seq ${afterOther} —— 两边视图一致`);
      }

      await page.screenshot(join(SHOTS, 'e2e-online-game.png'));
    } finally {
      guestPage.close();
      guest = null;
    }

    // 服务器推下来的 view 不许泄露弹药顺序或他人手牌
    const leak = await page.evalRaw(`(() => {
      var room = window.GameNet && window.GameNet.room;
      if (!room || !room.view) return '没有 view（不该发生）';
      var dump = JSON.stringify(room.view);
      var bad = [];
      ['"shells"', '"drawPile"', '"discard"', '"seed"', '"knowledge"'].forEach(function (k) {
        if (dump.indexOf(k) >= 0) bad.push(k);
      });
      return bad.length ? bad.join(',') : '干净';
    })()`);
    assert.equal(leak, '干净', `联机 view 里出现了不该有的字段：${leak}`);
    console.log('联机 view 字段检查：干净（没有弹药顺序 / 牌堆 / 种子 / 情报）');

    /* ---------- 7. 控制台必须干净 ---------- */
    if (page.errors.length) {
      throw new Error('浏览器控制台有报错：\n' + page.errors.join('\n'));
    }

    console.log('\n✅ Shell Gambit 浏览器端到端全部通过');
    console.log(`   截图目录：${SHOTS}`);
  } finally {
    if (guest) guest.close();
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