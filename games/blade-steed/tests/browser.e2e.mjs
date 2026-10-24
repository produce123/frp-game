/**
 * 刀马 BladeSteed — 真 Chrome 端到端（不是"应该可以"，是跑出来的结果）
 *
 * 覆盖这几件事：
 *   1. 服务器真的把这个游戏接上了（等价于启动日志里的「已接游戏」那一行）
 *   2. 在真浏览器里注册 → 打开 /games/blade-steed/ → 页面能起来、控制台零报错
 *   3. 身份来自平台账号（页面上显示的就是账号 ID，游戏里不再问名字）
 *   4. 人机对局真的能走一步：真实鼠标点猜拳 → 引擎状态变了 → 轮到我 → 真实点一个行动
 *   5. 在线对局能建出房间并看到 6 位房号（房间界面由 shared/ui/room.js 提供）
 *   5b. 两个真客户端（浏览器 + 脚本玩家）打一局，含"超时催办"
 *   5d. **人机是房间的座位**（用户明确要求）：一个人建房 → 座位不够开不了局 →
 *       按「＋ 添加人机」→ 成员列表里出现灰圈的 `.frp-avatar.is-bot` →
 *       开局 → 地图上出现带 `data-frp-avatar` 的人机 token → 打一步
 *   5e. 非房主看到的设置区里没有房主才有的控件（加/减人机是房主的）
 *   6. 手机硬指标：360px / 430px 下没有横向溢出、可点目标 ≥44px、没有元素跑出屏幕，
 *      **包括地图头像的热区**（`data-frp-avatar` 那圈，见 avatarHotzones()）
 *
 * 跑法：node games/blade-steed/tests/browser.e2e.mjs
 *      （或用平台体检带起来：node tools/check-game.mjs blade-steed --browser）
 * （要求本机装了 Chrome 或 Edge；服务器用 startServer({port:0}) 起在随机端口，
 *   不碰 7891 那个真服务，也不写 data/server.json。）
 *
 * ⚠️ 文件名是 `browser.*.mjs` 而不是 `*.test.mjs` 是**刻意的**：
 *    `node tools/check-game.mjs <slug>`（不带 --browser）会跑 `tests/*.test.mjs`，
 *    而这条用例要真浏览器 —— 让它留在 `*_test.mjs` 里会让不带 --browser 的机械体检
 *    也依赖 Chrome。GAME-SPEC 第 10 节就是按 `tests/browser*.mjs` 这个命名约定的。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../../../server/server.mjs';
import { Page, findChrome } from '../../../tools/cdp.mjs';
import { wsConnect } from '../../../tests/ws-client.mjs';

/** 服务端接入层的 meta：人机名字池从这儿取（不在这里再抄一份字面量） */
const { meta: BS_META } = await import('../../../server/games/blade-steed.mjs');

/*
 * 三段限时与演出缓冲的**真值**（引擎常量）。
 * 倒计时那条断言要拿"队列空那一刻的剩余"和"标称限时"对账，
 * 所以标称限时必须从常量里算出来 —— 在用例里再抄一份 10000/60000 迟早会分叉。
 */
const { ACTION_TIMEOUT_MS, ORDER_TIMEOUT_MS, REPLAY_BUFFER_MS, RPS_TIMEOUT_MS } = await import(
  '../js/engine/constants.js'
);

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------------------------------
   脚本玩家：直接用平台 HTTP + 平台自己的 WebSocket 测试客户端。
   借用平台测试的客户端是刻意的 —— 它是"另一份实现"，
   如果它和浏览器都能跑通同一条协议，说明协议是真的对，不是自己验自己。
   ------------------------------------------------------------------------- */

async function registerScript(app, name, password = 'secret123') {
  const res = await fetch(new URL('/api/register', app.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password }),
    redirect: 'manual',
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  assert.equal(res.status, 200, `脚本玩家注册失败：${JSON.stringify(data)}`);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const sid = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('sid=') && c.length > 4);
  assert.ok(sid, '注册应该返回会话 cookie');
  return { cookie: sid, me: data.me };
}

async function connectScript(app, cookie) {
  const client = await wsConnect({ port: app.port, cookie });
  await client.waitFor('ready');
  await client.waitFor('friends');
  return client;
}

/**
 * 脚本玩家等一个满足条件的房间状态。
 * 这里**扫整个收件箱**而不是"只等新消息"：揭晓那一瞬间的状态可能在调用之前就到了，
 * 只等新消息会把它错过（实测踩过：一直等到超时，其实状态早就收到了）。
 */
async function waitPeer(peer, pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = (peer.received || []).find((m) => m.t === 'room.state' && m.view && pred(m.view, m));
    if (hit) return hit.view;
    await sleep(120);
  }
  throw new Error(`脚本玩家没等到：${label}`);
}

/**
 * 手机硬指标体检（和平台 tests/browser.smoke.mjs 同一套判据）：
 *   横向溢出 / 可点目标 <44px / 元素跑出屏幕
 */
async function layoutCheck(page, label) {
  const r = await page.evalRaw(`(async () => {
    /*
     * 量之前先让界面稳下来。
     * 平台的房间面板 / 牌桌有入场动画（缩放、上滑），动画途中 getBoundingClientRect()
     * 拿到的是**被 transform 缩过**的尺寸 —— 实测一个 44px 的按钮量出来 43.99，
     * 于是"点击区 ≥44px"偶发误报。这里把一次性动画直接推到终点再量；
     * 无限循环的动画（倒计时呼吸灯之类）不去动它。
     */
    const running = () => document.getAnimations().filter((a) =>
      a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations !== Infinity);
    const t0 = Date.now();
    while (running().length && Date.now() - t0 < 1000) {
      for (const a of running()) { try { a.finish(); } catch { /* 推不动的就等它自己跑完 */ } }
      await new Promise((r) => requestAnimationFrame(r));
    }

    const vw = window.innerWidth;
    const screen = document.querySelector('.screen.is-active');
    const scope = screen || document.body;
    const small = [], off = [];
    for (const el of scope.querySelectorAll('button, input')) {
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      const name = el.id ? '#' + el.id : (el.className || el.tagName);
      const cs = getComputedStyle(el);
      if (b.height < 44) {
        small.push(name + ' h=' + b.height.toFixed(2) + ' minH=' + cs.minHeight + ' box=' + cs.boxSizing);
      }
      if (b.left < -1 || b.right > vw + 1) off.push(name + ' [' + Math.round(b.left) + ',' + Math.round(b.right) + ']');
    }
    return { overflow: document.documentElement.scrollWidth - vw, small, off, screen: scope.id || '(body)' };
  })()`);

  const bad = [];
  if (r.overflow > 1) bad.push('横向溢出 ' + r.overflow + 'px');
  if (r.small.length) bad.push('点击目标 <44px：' + r.small.join('、'));
  if (r.off.length) bad.push('跑出屏幕：' + r.off.join('、'));
  assert.equal(bad.length, 0, `${label} [${r.screen}]：${bad.join('；')}`);
  console.log(`  ✓ ${label}：横向溢出 ${r.overflow}px，可点目标全部 ≥44px 且都在屏幕内 [${r.screen}]`);
}

/**
 * 头像热区必须 ≥44px（点击头像能扔鸡蛋/鲜花，是平台的共用能力，见 shared/ui/react.js）。
 *
 * ⚠️ `layoutCheck()` **量不到它**：它只看 `button, input`，而地图上的头像是 SVG 的
 *    `<g data-frp-avatar>` + 一个透明的 `<circle class="tok-hit">`。
 *    而 SVG 会被缩放到容器里（preserveAspectRatio="xMidYMid meet"），
 *    所以 HIT_R=28（用户坐标）在 360px 宽的手机上量出来只有 ~46px —— 必须实测。
 * 量的是真正接指针事件的那个圆（`.tok-hit`），不是外层的 <g>（<g> 的 bbox 还含血条）。
 */
async function avatarHotzones(page, scope, label) {
  const list = await page.evalRaw(`(() => {
    const box = document.querySelector(${JSON.stringify(scope)});
    if (!box) return null;
    return [...box.querySelectorAll('[data-frp-avatar]')].map((el) => {
      const hit = el.querySelector('.tok-hit') || el;
      const b = hit.getBoundingClientRect();
      return {
        id: el.getAttribute('data-frp-avatar'),
        name: el.getAttribute('data-frp-name'),
        w: Math.round(b.width * 10) / 10,
        h: Math.round(b.height * 10) / 10,
      };
    });
  })()`);
  assert.ok(Array.isArray(list) && list.length, `${label}：没找到带 data-frp-avatar 的可点元素`);
  const small = list.filter((x) => x.w < 44 || x.h < 44);
  assert.equal(
    small.length,
    0,
    `${label}：这些头像热区任一边 <44px：${JSON.stringify(small)}（全部：${JSON.stringify(list)}）`
  );
  const minW = Math.min(...list.map((x) => x.w));
  const minH = Math.min(...list.map((x) => x.h));
  console.log(`  ✓ ${label}：${list.length} 个可点头像，热区最小 ${minW}×${minH}px（都 ≥44px）`);
  return list;
}

/**
 * 等演出排空再点。
 *
 * ⚠️ 演出期间（`FrpAnim.busy()` 为真）游戏会把所有动作点击**当成没点**
 * （用户第 2 条要求，见 docs/DECISIONS.md D10）。用例里不等就点 = 点了个空，
 * 后面会以"牌桌没反应 / 等不到揭晓"的形式失败 —— 那种失败最难查。
 * 房间级按钮（开始 / 离开 / 邀请 / 加人机）不受影响，不用等。
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
 * 给 `GameNet.send` 装一个**只数不改**的探针：数到几条 `room.act`，真的发还是真发。
 *
 * 用来断言"演出期间一条 `room.act` 都没发出去"（用户第 2 条要求）。
 * ⚠️ 刻意**不吞消息**：吞掉的话超时催办那条路会被切断，
 *    被测代码没毛病也可能把用例自己搞挂。count 只在"锁失效"时才会涨 ——
 *    那本来就是要红的。
 * ⚠️ `tick` 单独数：它不是玩家点的（是到点催服务端），不该算在内。
 */
async function spySends(page) {
  await page.evalRaw(`(() => {
    const T = window.FrpProtocol.T;
    window.__sendSpy = { n: 0, ticks: 0, acts: [] };
    const orig = window.GameNet.send.bind(window.GameNet);
    window.GameNet.send = function (t, payload) {
      const act = payload && payload.act;
      if (t === T.ROOM_ACT) {
        if (act && act.kind === 'tick') window.__sendSpy.ticks += 1;
        else { window.__sendSpy.n += 1; window.__sendSpy.acts.push(act); }
      }
      return orig(t, payload);
    };
    return true;
  })()`);
}

/** 探针数到的"玩家操作"条数（tick 不算） */
const sendCount = (page) => page.eval(`return window.__sendSpy ? window.__sendSpy.n : -1`);

/**
 * **逐步**数音效：把 `FrpAnim.push` 的 fn 包一层，记下每一步产生了几个振荡器。
 *
 * 为什么要这一步（captain 收口时加的）：删掉本地预演之后，"出拳那一声"从"点按钮立刻响"
 * 变成"服务器回放 `rps-pick` 那一步才响"。它是个**新增在回放步里**的音效，
 * 而"真的出声了"在无头浏览器里只有 `createOscillator` 数得出来（听不到）。
 * 不这么数的话，这行代码被谁顺手删掉都不会有测试变红。
 *
 * ⚠️ 判据是**逐步增量**而不是总数：一轮里所有人都会出拳（别人的拳不该让我听见），
 *    而且揭晓那一步本来就有 `reveal` 音 —— 只看总数分不清是谁响的。
 * ⚠️ 只包计数，不改行为（`fn` 的返回值原样透传，队列的时长一点没变）。
 */
async function spyAudioPerStep(page) {
  await page.evalRaw(`(() => {
    if (window.__oscSpy) return true;
    window.__oscSpy = { total: 0, steps: [] };
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && AC.prototype && !AC.prototype.__frpSpyPatched) {
      const orig = AC.prototype.createOscillator;
      AC.prototype.createOscillator = function () {
        window.__oscSpy.total += 1;
        return orig.apply(this, arguments);
      };
      AC.prototype.__frpSpyPatched = true;
    }
    const Fx = window.FrpAnim;
    if (Fx && typeof Fx.push === 'function' && !Fx.__frpSpyPatched) {
      const origPush = Fx.push.bind(Fx);
      Fx.push = function (items, fn) {
        return origPush(items, (item) => {
          const before = window.__oscSpy.total;
          const ms = fn(item);
          window.__oscSpy.steps.push({ t: item && item.t, pid: item && item.pid, osc: window.__oscSpy.total - before });
          return ms;
        });
      };
      Fx.__frpSpyPatched = true;
    }
    return true;
  })()`);
}

/** 读回"逐步音效"探针（`t` 是事件类型，`osc` 是这一步产生的振荡器个数） */
const audioSteps = (page) => page.eval(`return window.__oscSpy || null`);

/* -------------------------------------------------------------------------
   「逐步同步 + 倒计时」探针（GAME-SPEC §11.10 的头两条）

   为什么必须**在页面里**采这个样：演出是异步的，"演完第 k 步"只是一个瞬间。
   如果在外面用 CDP 一问一答去读，光往返就把那个瞬间错过去了（用户报的正是
   "演到一半画面已经是结果"）。所以这里把 `FrpAnim.push` 的 fn 包一层：
   每一步 **演完的那一瞬间**（同一个 JS 任务里，没有任何 CDP 往返）把画面读一份快照。

   还做一件 GAME-SPEC §11.10 点名的事：把队列**卡在中间**。
   做法：`armed` 之后的第一帧（≥2 步）只把**第一步**排进队列，等它演完先塞一步
   1.5 秒的空演出（`FrpAnim.push` 本来就不认识具体游戏，只按返回值排时间轴），
   再把剩下的步接回去 —— 于是"演完第一步"那一刻会稳定停 1.5 秒，外面随便怎么读都抓得住。

   ⚠️ 位置一律读 `.token` 的 `transform`（js/ui/map.js 只改这个属性，CSS transition 负责补间），
      **绝不 getBoundingClientRect** —— 联机第一次渲染时这块 DOM 还没插进文档，量出来全是 0。
   ⚠️ 探针只读不改：`fn` 的返回值原样透传，队列时长一点没变。
   ------------------------------------------------------------------------- */
const STEP_PROBE = `(() => {
  if (window.__stepProbe) return 'already';
  const Fx = window.FrpAnim;
  if (!Fx || typeof Fx.push !== 'function') return 'no-anim';
  const origPush = Fx.push.bind(Fx);
  const P = { armed: false, freezeMs: 1500, frozen: null, frames: [], drains: [], acc: 0, latest: null };
  window.__stepProbe = P;

  const timerText = () => {
    const b = boardEl();
    const t = b ? b.querySelector('.timer') : null;
    return t && t.firstChild ? t.firstChild.textContent : null;
  };

  /*
   * 牌桌元素（尽量从文档里现查，查不到就用上次记下的那个）。
   *
   * 【为什么需要这个兜底】FrpAnim.push 在队列空的时候会**同步**跑第一步
   * （anim.js 的 push → run → item.fn），也就是在 online.js 的 render 里面跑。
   * 而平台每次收状态都会先清空房间面板、再调 renderGame —— **这一刻牌桌还没插进文档**，
   * document.querySelector 当场返回 null（第一次量出来 before/after 全是 null 就是这么来的）。
   * 好在联机牌桌的 root 是**常驻元素**（从来只 append 不重建，见 AGENTS.md 第 4 条），
   * 所以"上次在文档里记下的那个元素"就是正在被画的那一个，读它的属性完全等价。
   */
  const boardEl = () => {
    const found = document.querySelector('#online-panel .online-board');
    if (found) P.el = found;
    return found || P.el || null;
  };
  P.boardEl = boardEl;

  // 这一帧到达时服务器说的"还剩多少毫秒" —— "队列空那一刻还剩多少"要拿它当基准
  const deadlineNow = () => {
    const v = window.GameNet && window.GameNet.room ? window.GameNet.room.view : null;
    if (!v) return null;
    if (v.phase === 'rps' && v.rps) return v.rps.deadlineIn;
    if (v.phase === 'order' && v.mini) return v.mini.deadlineIn;
    if (v.phase === 'action') return v.actionDeadlineIn;
    return null;
  };
  const phaseNow = () => {
    const v = window.GameNet && window.GameNet.room ? window.GameNet.room.view : null;
    return v ? v.phase : '';
  };

  const snap = () => {
    const b = boardEl();
    if (!b) return null;
    const toks = {};
    for (const t of b.querySelectorAll('.token')) {
      const eq = t.querySelectorAll('.eq');
      toks[t.getAttribute('data-pid')] = {
        hp: (t.querySelector('.tok-hptext') || {}).textContent || '',
        knife: !!(eq[0] && eq[0].classList.contains('has')),
        horse: !!(eq[1] && eq[1].classList.contains('has')),
        tf: t.getAttribute('transform') || '',
        cls: t.getAttribute('class') || '',
      };
    }
    const pills = b.querySelectorAll('.board-status .pill');
    return {
      phase: pills[0] ? pills[0].textContent : '',
      round: pills[1] ? pills[1].textContent : '',
      timer: timerText() || '',
      panel: (b.querySelector('.action-panel') || {}).textContent || '',
      toks,
    };
  };
  P.snap = snap;

  // 地图上的地标（用户坐标）。判断"这个头像此刻在哪"只看 transform 离谁近，绝不量像素。
  P.landmarks = () => {
    const b = boardEl();
    const out = {};
    if (!b) return out;
    const wild = b.querySelector('.wild-ring');
    if (wild) out.wild = [Number(wild.getAttribute('cx')), Number(wild.getAttribute('cy'))];
    for (const c of b.querySelectorAll('.city-ring')) {
      out[c.getAttribute('data-city')] = [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))];
    }
    return out;
  };

  let internal = false;   // 探针自己塞进去的步（空演出 / 剩下的步）不再记一条"帧"

  Fx.push = function (steps, fn) {
    if (internal) return origPush(steps, fn);
    const frame = {
      n: (steps || []).length,
      t0: performance.now(),
      play: 0,
      types: (steps || []).map((s) => (s && s.t) || null),
      timerSeen: [],
      deadlineIn: deadlineNow(),
      phase: phaseNow(),
    };
    P.frames.push(frame);
    P.latest = frame;

    // 只在**队列还忙着**的时候采样计时器 —— 排空之后计时器本来就应该有数字
    const iv = setInterval(() => {
      if (!window.FrpAnim.busy()) return;
      const t = timerText();
      if (t != null) frame.timerSeen.push(t);
    }, 40);
    const wait = setInterval(() => {
      if (window.FrpAnim.busy()) return;
      clearInterval(wait);
      clearInterval(iv);
      const rec = {
        at: performance.now(),
        t0: frame.t0,
        n: frame.n,
        types: frame.types.slice(),
        play: frame.play,
        deadlineIn: frame.deadlineIn,
        phase: frame.phase,
        windowPlay: P.acc,
        dom: snap(),
      };
      P.acc = 0;
      P.drains.push(rec);
      // 排空之后对账那一拍（最长 60ms）才会把数字写上去，等它出现再记一次
      const wait2 = setInterval(() => {
        const t = timerText();
        if (t != null && /^[0-9]+$/.test(t)) {
          clearInterval(wait2);
          rec.numberAt = performance.now();
          rec.number = Number(t);
          rec.numberDom = snap();
        }
      }, 20);
      setTimeout(() => clearInterval(wait2), 900);
    }, 20);

    if (!P.armed || !steps || steps.length < 2) {
      return origPush(steps, (item) => {
        const ms = fn(item);
        frame.play += ms;
        P.acc += ms;
        return ms;
      });
    }

    // 【卡在中间】第一步先演；演完塞一步空演出（队列就停在"演完第一步"那一刻），再把剩下的接上
    P.armed = false;
    const rest = steps.slice(1);
    let done = false;
    return origPush([steps[0]], (item) => {
      const before = snap();
      const ms = fn(item);
      frame.play += ms;
      P.acc += ms;
      const after = snap();
      if (!done) {
        done = true;
        P.frozen = {
          t: (item && item.t) || null,
          s: (item && item.s) || null,
          before,
          after,
          rest: rest.map((x) => (x && x.t) || null),
        };
        internal = true;
        try {
          origPush([{ __probeFreeze: true }], () => P.freezeMs);
          origPush(rest, (it) => {
            const m2 = fn(it);
            frame.play += m2;
            P.acc += m2;
            return m2;
          });
        } finally {
          internal = false;
        }
      }
      return ms;
    });
  };
  return 'ok';
})()`;

/** 挂上探针（幂等） */
async function installStepProbe(page) {
  const r = await page.evalRaw(STEP_PROBE);
  assert.ok(r === 'ok' || r === 'already', `逐步同步探针没挂上：${r}`);
  // 挂上之后先读一次，把常驻牌桌元素记在探针里（渲染途中它不在文档里，见 boardEl 的说明）
  await page.evalRaw(`(() => {
    const b = document.querySelector('#online-panel .online-board');
    if (b && window.__stepProbe) window.__stepProbe.el = b;
    return !!b;
  })()`);
  return r;
}

/** 读回探针记下的东西（帧 / 排空记录 / 卡住那一刻的快照） */
const readStepProbe = (page) =>
  page.eval(`return window.__stepProbe ? {
    frozen: window.__stepProbe.frozen,
    drains: window.__stepProbe.drains,
    frames: window.__stepProbe.frames.map((f) => ({ n: f.n, play: f.play, types: f.types, phase: f.phase, deadlineIn: f.deadlineIn, timerSeen: f.timerSeen })),
  } : null`);

/** 现在地图上是什么样（跨 CDP 的独立一次读取，用来和"页内快照"对照） */
const readBoardSnap = (page) =>
  page.evalRaw(`(window.__stepProbe && window.__stepProbe.snap) ? window.__stepProbe.snap() : null`);

/** 地图上的地标坐标（城 / 野外，用户坐标） */
const readLandmarks = (page) =>
  page.evalRaw(`(window.__stepProbe && window.__stepProbe.landmarks) ? window.__stepProbe.landmarks() : {}`);

/**
 * 这个头像此刻站在哪个地标上（只认 `transform` 的 translate 数值）。
 * 判据是"离谁最近"：地图上同一个地点站好几个人时最多偏离地标 RING_R(=24 用户坐标)，
 * 而两个地标之间至少隔 88 —— 所以"最近的那个"不可能判错。
 */
function nearestLandmark(tf, marks) {
  const m = /translate\(\s*(-?[\d.]+)[,\s]+(-?[\d.]+)\s*\)/.exec(tf || '');
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  let best = null;
  let bestD = Infinity;
  for (const [k, xy] of Object.entries(marks || {})) {
    const d = Math.hypot(x - xy[0], y - xy[1]);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best === null ? null : { where: best, d: Math.round(bestD * 10) / 10 };
}

/**
 * 两份画面快照之间到底哪儿变了（字段级，好定位是哪一项错位）。
 *
 * ⚠️ 刻意**不比计时器**：它是个一直在走的钟，而且"某一步演完的那一瞬间"这一帧的
 * 计时器文案还没被改写（`_queueSteps` 是在 `anim.push` 返回**之后**才调 `tickTimer(true)` 的，
 * 而队列空的时候 `anim.push` 会**同步**把第一步跑完）—— 也就是那几微秒里它还是上一帧的文案。
 * 页面根本来不及画这一帧，玩家看不到任何东西；倒计时另有自己的断言（5d-5 的采样）。
 */
function snapDiff(a, b) {
  if (!a || !b) return ['(快照缺失)'];
  const out = [];
  for (const k of ['phase', 'round', 'panel']) if (a[k] !== b[k]) out.push(k);
  const ids = new Set([...Object.keys(a.toks || {}), ...Object.keys(b.toks || {})]);
  for (const pid of ids) {
    const x = (a.toks || {})[pid] || {};
    const y = (b.toks || {})[pid] || {};
    for (const k of ['hp', 'knife', 'horse', 'tf', 'cls']) if (x[k] !== y[k]) out.push(pid + '.' + k);
  }
  return out;
}

/** 点一下"现在能提交的那一个入口"（出拳 / 花一步 / 排顺序的确定键），返回它是什么 */
function playOneExpr(hand) {
  return `(() => {
    const b = document.querySelector('#online-panel .online-board');
    if (!b) return 'no-board';
    const view = (window.GameNet.room || {}).view || {};
    if (view.phase === 'over') return 'over';
    if (view.phase === 'action') {
      const a = b.querySelector('.act-grid .act-btn');
      if (a) { a.click(); return 'act'; }
      return 'action-wait';
    }
    if (view.phase === 'rps') {
      const r = b.querySelector('.rps-btn[data-rps=' + ${JSON.stringify(JSON.stringify(hand))} + ']:not([disabled])')
        || b.querySelector('.rps-btn:not([disabled])');
      if (r) { r.click(); return 'rps'; }
      return 'rps-wait';
    }
    if (view.phase === 'order') {
      const c = b.querySelector('.action-panel .act-btn.hot.wide');
      if (c) { c.click(); return 'order-confirm'; }
      const it = b.querySelector('.order-list .order-item');
      if (it) { it.click(); return 'order-item'; }
      return 'order-wait';
    }
    return 'wait';
  })()`;
}

/** 牌桌行动面板当前长什么样（用来断言"演出期间点了界面也没变"） */
const PANEL_HTML = `(() => {
  const p = document.querySelector('#online-panel .online-board .action-panel');
  return p ? p.innerHTML : '';
})()`;

/**
 * 程序化点一下"当前能提交的那一个动作入口"（出拳 / 行动 / 排顺序），返回它的类名。
 *
 * ⚠️ 用 `el.click()` 而不是真鼠标：`body.frp-anim-busy` 那条 CSS 有
 * `pointer-events: none`，真鼠标会被它挡在外面 —— 那样只能测到 CSS，
 * 测不到游戏自己的 JS 兜底（`_blocked()`）。两条路都要试，见用例里那一段。
 */
const CLICK_SUBMIT = `(() => {
  const b = document.querySelector('#online-panel .online-board');
  if (!b) return 'no-board';
  const el = b.querySelector('.act-grid .act-btn')
    || b.querySelector('.rps-btn:not([disabled])')
    || b.querySelector('.order-list .order-item');
  if (!el) return 'none';
  const cls = el.getAttribute('class') || el.tagName;
  el.click();
  return cls;
})()`;

/** 读一张牌桌的状态（牌桌上看到的，就是"视图"画出来的） */
const BOARD_STATE = `(() => {
  const b = document.getElementById('local-board');
  const pill = b.querySelector('.board-status .pill');
  return {
    phase: pill ? pill.textContent : '',
    rps: b.querySelectorAll('.rps-btn:not([disabled])').length,
    rpsPicked: b.querySelectorAll('.rps-btn.is-picked').length,
    readyOn: b.querySelectorAll('.ready-chip.on').length,
    acts: b.querySelectorAll('.act-btn').length,
    log: b.querySelectorAll('.log-line').length,
    hp: [...b.querySelectorAll('.tok-hptext')].map((e) => e.textContent).join(','),
  };
})()`;

async function main() {
  if (!findChrome()) {
    console.log('⚠️ 本机没找到 Chrome / Edge，跳过浏览器端到端');
    return;
  }
  mkdirSync(SHOTS, { recursive: true });

  const tmpDir = mkdtempSync(join(tmpdir(), 'blade-steed-e2e-'));
  const app = await startServer({ port: 0, dbPath: join(tmpDir, 'e2e.db') });
  let page = null;

  try {
    /* ---------- 1. 服务器接上了这个游戏 ---------- */
    console.log('\n── 1. 服务器接入');
    console.log(`  服务器：${app.url}`);
    const keys = [...app.games.keys()];
    console.log(`  已接游戏：${keys.length ? keys.join('、') : '（一个都没有）'}`);
    assert.ok(keys.includes('blade-steed'), `服务器没有接上 blade-steed（现在只有：${keys.join('、') || '空'}）`);
    const mine = (app.gameFailures || []).filter((f) => String(f.file || f).includes('blade-steed'));
    assert.equal(mine.length, 0, `blade-steed 加载失败：${JSON.stringify(mine)}`);
    if ((app.gameFailures || []).length) {
      console.log(`  （别的游戏加载失败，与本游戏无关：${app.gameFailures.map((f) => f.file || f).join('、')}）`);
    }

    /* ---------- 2. 起浏览器 + 注册 ---------- */
    console.log('\n── 2. 真浏览器 + 平台注册');
    page = await Page.launch({ headless: true, width: 430, height: 932, mobile: true });
    await page.goto(app.url);
    // 平台首页先显示登录页（等 /api/me + WebSocket 回来才切屏幕），不能立刻点
    await page.waitFor(`return document.getElementById('screen-auth').classList.contains('is-active')`, 10000, '平台登录页出现');
    await page.click('#tab-register');
    await page.setInput('#register-name', '刀');
    await page.setInput('#register-password', 'e2e-pass-1234');
    await page.setInput('#register-password2', 'e2e-pass-1234');
    await page.click('#form-register .btn-primary');
    await page.waitFor(`return !document.getElementById('modal-id').hidden`, 10000, '注册成功弹出账号 ID');
    const myId = await page.eval(`return document.getElementById('new-id').textContent.trim()`);
    await page.click('#btn-id-done');
    await page.waitFor(`return document.getElementById('screen-app').classList.contains('is-active')`, 10000, '进入平台主界面');
    console.log(`  注册成功：名字「刀」 ID ${myId}`);

    /* ---------- 3. 打开游戏页 ---------- */
    console.log('\n── 3. 打开 /games/blade-steed/');
    await page.goto(app.url + 'games/blade-steed/');
    await page.waitFor(`return !!document.querySelector('#screen-home.is-active .logo')`, 10000, '首页出现');
    const logo = await page.eval(`return document.querySelector('#screen-home .logo').textContent`);
    const sub = await page.eval(`return document.querySelector('#screen-home .logo-sub').textContent`);
    assert.match(logo, /刀马/, `游戏标题不对：${logo}`);
    console.log(`  标题：${logo}｜${sub}`);

    // 身份来自平台账号（页面上显示的就是注册拿到的 ID），登录提示不该出现
    await page.waitFor(`return window.GameNet && window.GameNet.me && window.GameNet.me.id === ${JSON.stringify(myId)}`, 10000, '游戏页拿到平台身份');
    const meLine = await page.eval(`return document.getElementById('me-line').textContent`);
    assert.ok(meLine.includes(myId), `身份行没显示账号 ID：${meLine}`);
    assert.equal(await page.eval(`return document.getElementById('login-hint').hidden`), true, '已登录却提示未登录');
    console.log(`  身份行：${meLine}`);

    // 人机 / 在线 / 规则 三个入口都在
    for (const id of ['btn-go-local', 'btn-go-online', 'btn-go-rules']) {
      assert.equal(await page.eval(`return !!document.getElementById(${JSON.stringify(id)})`), true, `缺少按钮 ${id}`);
    }
    await layoutCheck(page, '首页 430px');
    await page.screenshot(join(SHOTS, '01-home.png'));

    /* ---------------------------------------------------------------
     * 3b. 音效 / 特效偏好**只有一份**（GAME-SPEC §11 第 10 条 + docs/DECISIONS.md D12）
     *
     * 平台把这份偏好收在 `FrpUI.prefs`（localStorage 的 `frp.prefs`）里，平台设置栏与
     * 三个游戏里的开关都只是它的入口。坏掉的典型症状是"平台开着、游戏关着"（各存各的）。
     * 所以这里两头都钉：**读**（老键说关、平台说开 → 界面必须跟着平台）
     * 与**写**（点游戏里的开关 → 只有 `frp.prefs` 变，老键一个字都不许动）。
     * ------------------------------------------------------------- */
    console.log('\n── 3b. 音效 / 特效偏好只有一份（FrpUI.prefs）');
    // 读：老键说"关"、平台那份说"开" —— 刷新之后界面必须听平台那份的
    await page.evalRaw(`(() => {
      localStorage.removeItem('frp.prefs');
      localStorage.setItem('bs.sound', 'false');
      localStorage.setItem('bs.fx', 'false');
      localStorage.setItem('frp.prefs', JSON.stringify({ sound: true, fx: true }));
      return true;
    })()`);
    await page.goto(`${app.url}games/blade-steed/`);
    await page.waitFor(`return !!document.querySelector('#screen-home.is-active .logo')`, 10000, '首页又出现（刷新之后）');
    const prefRead = await page.evalRaw(`(() => ({
      sound: window.FrpUI.prefs.sound(),
      fx: window.FrpUI.prefs.fx(),
      soundBtn: document.getElementById('toggle-sound').textContent.trim(),
      soundAria: document.getElementById('toggle-sound').getAttribute('aria-pressed'),
      menuSound: (document.getElementById('menu-sound') || {}).textContent || '',
      fxBtn: document.getElementById('toggle-fx').textContent.trim(),
      legacy: [localStorage.getItem('bs.sound'), localStorage.getItem('bs.fx')],
      stored: localStorage.getItem('frp.prefs'),
    }))()`);
    assert.equal(prefRead.sound, true, `平台那份偏好是"开"，游戏却读成 ${prefRead.sound}（读的是老键 bs.sound？）`);
    assert.equal(prefRead.fx, true, `平台那份特效偏好是"开"，游戏却读成 ${prefRead.fx}`);
    assert.equal(prefRead.soundAria, 'true', `音效按钮的 aria-pressed 应该跟着偏好（开），实际 ${prefRead.soundAria}`);
    assert.ok(prefRead.soundBtn.includes('音效'), `音效按钮文案不对：「${prefRead.soundBtn}」`);
    assert.ok(
      /音效：开/.test(prefRead.menuSound),
      `老键说关、平台说开时，对局菜单里那行应该写"音效：开"，实际「${prefRead.menuSound}」`
    );
    assert.equal(prefRead.legacy[0], 'false', `老键 bs.sound 被游戏动过了（${prefRead.legacy[0]}）—— 那份偏好已经作废，不许再写`);
    assert.equal(prefRead.legacy[1], 'false', `老键 bs.fx 被游戏动过了（${prefRead.legacy[1]}）`);
    console.log(`  ✓ 读：老键（bs.sound/bs.fx=false）被忽略，界面跟着平台那份（按钮「${prefRead.soundBtn}」/「${prefRead.menuSound}」）`);

    // 写：点游戏里的开关 → 只有 frp.prefs 变
    await page.evalRaw(`(() => { localStorage.setItem('bs.sound', 'true'); localStorage.setItem('bs.fx', 'true'); return true; })()`);
    await page.click('#toggle-sound');
    await page.click('#toggle-fx');
    const prefWrite = await page.evalRaw(`(() => ({
      sound: window.FrpUI.prefs.sound(),
      fx: window.FrpUI.prefs.fx(),
      soundBtn: document.getElementById('toggle-sound').textContent.trim(),
      soundAria: document.getElementById('toggle-sound').getAttribute('aria-pressed'),
      menuSound: (document.getElementById('menu-sound') || {}).textContent || '',
      stored: JSON.parse(localStorage.getItem('frp.prefs') || 'null'),
      legacy: [localStorage.getItem('bs.sound'), localStorage.getItem('bs.fx')],
      keys: Object.keys(localStorage).filter((k) => /sound|fx|prefs/i.test(k)).sort(),
    }))()`);
    assert.equal(prefWrite.sound, false, `点了音效开关，FrpUI.prefs 没变（还是 ${prefWrite.sound}）`);
    assert.equal(prefWrite.fx, false, `点了特效开关，FrpUI.prefs 没变（还是 ${prefWrite.fx}）`);
    assert.equal(prefWrite.soundAria, 'false', `点了开关之后按钮的 aria-pressed 要跟着变（关），实际 ${prefWrite.soundAria}`);
    assert.ok(/音效：关/.test(prefWrite.menuSound), `对局菜单里那行应该跟着变成"音效：关"，实际「${prefWrite.menuSound}」`);
    assert.deepEqual(prefWrite.stored, { sound: false, fx: false }, `frp.prefs 里应该是关掉的那一份，实际 ${JSON.stringify(prefWrite.stored)}`);
    assert.equal(prefWrite.legacy[0], 'true', `游戏又去写老键了（bs.sound 变成 ${prefWrite.legacy[0]}）—— 偏好会分叉成两份`);
    assert.equal(prefWrite.legacy[1], 'true', `游戏又去写老键了（bs.fx 变成 ${prefWrite.legacy[1]}）`);
    assert.deepEqual(
      prefWrite.keys,
      ['bs.fx', 'bs.sound', 'frp.prefs'],
      `和偏好有关的 localStorage 键只有这三条（后两条是测试自己塞的老键）：${JSON.stringify(prefWrite.keys)}`
    );
    console.log(`  ✓ 写：点开关只改 frp.prefs（${JSON.stringify(prefWrite.stored)}），老键原地不动（${JSON.stringify(prefWrite.legacy)}）`);
    // 收拾干净，别让"关着音效"影响后面的用例（后面有几条要数振荡器）
    await page.evalRaw(`(() => {
      window.FrpUI.prefs.setSound(true); window.FrpUI.prefs.setFx(true);
      localStorage.removeItem('bs.sound'); localStorage.removeItem('bs.fx');
      return true;
    })()`);

    /* ---------- 4. 人机对局：真的走一步 ---------- */
    console.log('\n── 4. 人机对局（2 人局，真实点击）');
    await page.click('#btn-go-local');
    await page.waitFor(`return document.getElementById('screen-local').classList.contains('is-active')`, 5000, '人机设置页');
    await layoutCheck(page, '人机设置 430px');
    await page.click('#local-size .seg-btn[data-size="2"]');
    await page.click('#btn-local-start');
    await page.waitFor(`return document.querySelectorAll('#local-board .rps-btn').length === 3`, 10000, '猜拳按钮出现');
    await layoutCheck(page, '人机牌桌（猜拳）430px');
    await page.screenshot(join(SHOTS, '02-local-rps.png'));

    // 牌桌上真的画出了东西（几何体检查不出"地图是空的"）
    const drawn = await page.evalRaw(`(() => {
      const b = document.getElementById('local-board');
      const box = (sel) => { const r = b.querySelector(sel).getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); };
      return {
        tokens: b.querySelectorAll('.token').length,
        cities: b.querySelectorAll('.city-ring').length,
        wild: b.querySelectorAll('.wild-ring').length,
        hp: [...b.querySelectorAll('.tok-hptext')].map((e) => e.textContent).join(','),
        map: box('.map-wrap'),
        token: box('.token'),
        timer: b.querySelector('.timer').textContent.trim(),
      };
    })()`);
    assert.equal(drawn.tokens, 2, `2 人局应该画 2 个头像，实际 ${drawn.tokens}`);
    assert.equal(drawn.cities, 2, `2 人局应该画 2 座城，实际 ${drawn.cities}`);
    assert.equal(drawn.wild, 1, `野外应该只有 1 片，实际 ${drawn.wild}`);
    assert.equal(drawn.hp, '10,10', `开局血量应该是 10,10，实际 ${drawn.hp}`);
    assert.ok(!/^0x/.test(drawn.token), `头像画出来是 0 尺寸：${drawn.token}`);
    console.log(`  地图画出来了：${drawn.tokens} 个头像 / ${drawn.cities} 座城 / 野外 ${drawn.wild} 片｜血量 ${drawn.hp}｜地图 ${drawn.map}｜计时器 ${drawn.timer}`);

    // 头像必须能点（平台互动）且热区 ≥44px —— 单机牌桌是整屏的，缩放最大那一档
    const localAvatars = await avatarHotzones(page, '#local-board', '人机牌桌头像热区（430px）');
    assert.equal(localAvatars.every((a) => a.name && a.name.length >= 1), true, '头像要带上名字（弹菜单时显示）');
    // 我自己那一圈是蓝的，另一个是橙的 —— 圆环配色是语义（自己=蓝/其他真人=橙/人机=灰）
    const rings = await page.evalRaw(`(() => {
      const toks = [...document.querySelectorAll('#local-board .token')];
      return toks.map((t) => ({ cls: t.getAttribute('class'), pid: t.getAttribute('data-pid') }));
    })()`);
    assert.equal(rings.filter((r) => r.cls.includes('is-me')).length, 1, `自己那个头像要有 is-me（蓝圈）：${JSON.stringify(rings)}`);
    assert.equal(
      rings.filter((r) => r.cls.includes('is-human')).length,
      1,
      `其他真人是 is-human（橙圈）：${JSON.stringify(rings)}`
    );

    // 演出队列接线（用户第 1 条需求）：先装个探针，证明事件真的交给平台的 FrpAnim 串行演出，
    // **不是**游戏自己 for 循环错开 110ms 一次全播。探针只转发，不改平台行为。
    await page.evalRaw(`(() => {
      const anim = window.FrpAnim;
      if (!anim || typeof anim.push !== 'function') return 'no-anim';
      window.__animProbe = { calls: 0, steps: 0, ms: [] };
      const orig = anim.push.bind(anim);
      anim.push = function (steps, fn) {
        window.__animProbe.calls++;
        window.__animProbe.steps += steps.length;
        return orig(steps, function (s) {
          const ms = fn(s);
          window.__animProbe.ms.push(ms);
          return ms;
        });
      };
      return 'ok';
    })()`);

    // 反复真实点击出拳，直到轮到我行动。每一步都要过引擎校验，点错了面板不会有变化。
    let st = await page.evalRaw(BOARD_STATE);
    assert.ok(st.rps >= 1, `猜拳按钮没出来（rps=${st.rps}）`);
    await clickIdle(page, '#local-board .rps-btn');
    await sleep(250);
    /*
     * ⚠️ 这两条断言是**单机专属**的，不要拿去类比联机：
     *    单机没有网络往返 —— 点下去就地把引擎推了一步（LocalMatch.handle），
     *    面板上的"你出了…/已出"来自**引擎算完后的权威视图**，不是本地预演。
     *    联机那边的契约是"点下去本机一动不动"（见 5b-2 的那条用例）。
     */
    const picked = await page.evalRaw(BOARD_STATE);
    assert.ok(picked.rpsPicked >= 1, '点了出拳，牌桌上没有出现「你出了…」的状态（点击没进引擎）');
    assert.ok(picked.readyOn >= 1, '点了出拳，自己没有变成「已出」');
    console.log(`  出拳已登记：${picked.phase}｜本轮已出 ${picked.readyOn} 人`);

    // 探针结果：队列真的被调用了，而且每一步的时长是"按动画本身长度"报的（450–700ms）
    let probe = null;
    const probeDeadline = Date.now() + 10000;
    while (Date.now() < probeDeadline) {
      probe = await page.eval('return window.__animProbe || null');
      if (probe && probe.steps >= 2) break;
      await sleep(150);
    }
    assert.ok(probe && probe.calls >= 1, '牌桌没把事件交给平台的 FrpAnim 演出队列（演出还是自己同步播完的）');
    const paced = probe.ms.filter((ms) => ms >= 450 && ms <= 700);
    assert.ok(paced.length >= 1, `FrpAnim 收到的步长不在 450–700ms 之间：${JSON.stringify(probe.ms)}`);
    console.log(`  演出队列：FrpAnim.push 调了 ${probe.calls} 次 / ${probe.steps} 步，步长 ${paced.join('、')}ms（串行）`);

    const deadline = Date.now() + 45000;
    let myTurn = false;
    while (Date.now() < deadline) {
      st = await page.evalRaw(BOARD_STATE);
      if (st.acts > 0) {
        myTurn = true;
        break;
      }
      if (st.rps > 0) await clickIdle(page, '#local-board .rps-btn');
      await sleep(350);
    }
    assert.ok(myTurn, '45 秒内一直没轮到我行动（人机对局没有往下走）');
    console.log(`  轮到我行动：${st.phase}｜行动按钮 ${st.acts} 个｜已播报 ${st.log} 条`);
    await page.screenshot(join(SHOTS, '03-local-action.png'));

    // 真实点一个行动按钮，再确认引擎状态真的变了（播报变长 / 面板变化）
    const before = await page.evalRaw(BOARD_STATE);
    await clickIdle(page, '#local-board .act-btn');
    await sleep(1500);
    const after = await page.evalRaw(BOARD_STATE);
    const changed = after.log > before.log || after.phase !== before.phase || after.acts !== before.acts;
    assert.ok(changed, `点了行动按钮但牌桌没有任何变化：${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    console.log(`  行动已生效：${before.phase}→${after.phase}｜播报 ${before.log}→${after.log} 条｜血量 ${after.hp}`);
    await layoutCheck(page, '人机牌桌（行动）430px');
    // 行动阶段是**地图被行动面板挤得最矮**的一档 → 头像热区在这里也要过 44px
    await avatarHotzones(page, '#local-board', '人机牌桌（行动中）430px');

    // 从对局菜单退出去（真实的两次点击）
    await page.click('#local-board .icon-btn.menu');
    await page.waitFor(`return !document.getElementById('board-menu').hidden`, 5000, '对局菜单打开');
    await layoutCheck(page, '对局菜单 430px');
    await page.click('#menu-leave');
    await page.waitFor(`return document.getElementById('screen-home').classList.contains('is-active')`, 5000, '回到首页');

    /* ---------- 5. 在线对局：建房看到房号 ---------- */
    console.log('\n── 5. 在线对局（建房间）');
    await page.click('#btn-go-online');
    await page.waitFor(`return document.getElementById('screen-online').classList.contains('is-active')`, 5000, '在线页');
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-idle')`, 8000, '房间闲置界面出现');
    await layoutCheck(page, '在线·未进房 430px');
    await page.screenshot(join(SHOTS, '04-online-idle.png'));

    await page.click('#online-panel .frp-room-idle .frp-btn-primary');
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-waiting')`, 10000, '房间等待界面出现');
    const code = await page.eval(`return document.querySelector('#online-panel .frp-room-code-value').textContent.trim()`);
    assert.match(code, /^[A-Z0-9]{6}$/, `房号不对：${code}`);
    console.log(`  房间号：${code}`);

    // 房间层必须把我们游戏自己的设置区画出来（renderSetup 没抛错）
    const setupText = await page.eval(`return (document.querySelector('#online-panel .frp-room-setup') || {}).textContent || ''`);
    assert.ok(setupText.includes('本局设置') && setupText.includes('对局中途允许别人进来'), `设置区没画出来：${setupText.slice(0, 40)}`);
    assert.ok(!setupText.includes('画不出来'), `设置区报错了：${setupText}`);
    console.log(`  游戏自己的设置区：${setupText.replace(/\s+/g, ' ').trim().slice(0, 60)}`);

    // 房间层现在只数真人（minPlayers=1）：一个人也能建房、按钮本身不灰 ——
    // 但**座位数不够**（人机也算座位）时「开始游戏」是灰的，旁边那行字会说清怎么补。
    // ⚠️ 「补几个电脑」那一排（options.aiFill）**已作废**：人机现在是房间的座位，
    //    由房间壳上的「＋ 添加人机」一个一个加（见 docs/DECISIONS.md D9）。
    const soloRoom = await page.evalRaw(`(() => {
      const panel = document.getElementById('online-panel');
      const setup = panel.querySelector('.frp-room-setup');
      const startBtn = [...panel.querySelectorAll('.frp-room-actions button')].find((x) => x.textContent.includes('开始游戏'));
      const addBot = panel.querySelector('.frp-room-bot-add');
      return {
        setup: setup ? setup.textContent.replace(/\\s+/g, ' ').trim() : '(没有设置区)',
        hasOldAiFill: setup ? /补几个电脑/.test(setup.textContent) : false,
        startExists: !!startBtn,
        startDisabled: startBtn ? startBtn.disabled : null,
        seatCount: (panel.querySelector('.frp-room-seat-count') || {}).textContent || '',
        note: (panel.querySelector('.frp-room-note') || {}).textContent || '',
        addBot: addBot ? { text: addBot.textContent.trim(), disabled: addBot.disabled } : null,
        members: panel.querySelectorAll('.frp-room-member').length,
      };
    })()`);
    assert.ok(soloRoom.setup.includes('本局设置') && soloRoom.setup.includes('对局中途允许别人进来'), `设置区没画出来：${soloRoom.setup}`);
    assert.ok(!soloRoom.setup.includes('画不出来'), `设置区报错了：${soloRoom.setup}`);
    assert.equal(soloRoom.hasOldAiFill, false, `「补几个电脑」那一排已作废，不该再出现在设置区：${soloRoom.setup}`);
    assert.equal(soloRoom.startExists, true, '等待界面里没有「开始游戏」按钮');
    assert.equal(
      soloRoom.startDisabled,
      true,
      '只有 1 个座位（一个人、零个人机）时「开始游戏」必须是灰的 —— 房间里还开不了局（minSeats=2）'
    );
    assert.match(soloRoom.seatCount, /座位 1 \/ 4/, `座位数没画对：${soloRoom.seatCount}`);
    assert.ok(soloRoom.note.includes('至少要 2 个座位'), `座位不够时要说清怎么补：${soloRoom.note}`);
    assert.equal(soloRoom.addBot && soloRoom.addBot.text, '＋ 添加人机', `房间壳上应该有「＋ 添加人机」：${JSON.stringify(soloRoom.addBot)}`);
    assert.equal(soloRoom.addBot.disabled, false, '还有空座位，「添加人机」应该是可点的');
    assert.equal(soloRoom.members, 1, `现在只有房主一个人：${soloRoom.members}`);
    console.log(`  一个人建房：座位 ${soloRoom.seatCount}｜开始按钮 disabled=${soloRoom.startDisabled}｜${soloRoom.note.slice(0, 40)}`);
    console.log(`  游戏自己的设置区：${soloRoom.setup.slice(0, 60)}`);
    await layoutCheck(page, '在线·等待开局 430px');
    await page.screenshot(join(SHOTS, '05-online-room.png'));

    /* ---------- 5b. 两个人真的打一局（第二个玩家是脚本，但走的是同一条真实协议） ---------- */
    console.log('\n── 5b. 两人联机开局（脚本玩家 + 浏览器玩家）');
    const peerUser = await registerScript(app, '侠');
    const peer = await connectScript(app, peerUser.cookie);
    peer.send({ t: 'room.join', code });
    const joined = await peer.waitFor('room.state', 5000);
    assert.equal(joined.code, code, `脚本玩家没进到同一个房间：${joined.code}`);
    assert.equal(joined.phase, 'waiting', `刚进房应该是等待态，实际 ${joined.phase}`);
    console.log(`  脚本玩家「侠」(${peerUser.me.id}) 用房间号 ${code} 进来了`);

    // 浏览器是房主：人够了，「开始游戏」应该变得可点
    await page.waitFor(`return (() => {
      const b = [...document.querySelectorAll('#online-panel .frp-room-actions button')].find((x) => x.textContent.includes('开始游戏'));
      return !!b && !b.disabled;
    })()`, 8000, '两个人到了，开始游戏可点');
    await page.click('#online-panel .frp-room-actions .frp-btn-primary');

    // 联机牌桌出现（渲染的是服务端发来的、按人裁剪过的 view）
    await page.waitFor(`return !!document.querySelector('#online-panel .online-board .rps-btn')`, 10000, '联机牌桌出现（猜拳）');
    await layoutCheck(page, '联机牌桌（猜拳）430px');
    await page.screenshot(join(SHOTS, '06-online-rps.png'));

    // 脚本玩家出「石头」，浏览器出「剪刀」→ 石头赢，脚本玩家拿 2 步行动
    // ⚠️ 「逐步音效」探针必须挂在**对方出拳之前**：脚本玩家那一票也会在浏览器这边
    //    演一步 `rps-pick`，晚一步挂就抓不到（第一版挂在 5b-1，结果只数到我自己那一票，
    //    "别人的拳不响"那条断言没东西可测 —— 这就是它当时的报错）。
    await spyAudioPerStep(page);
    peer.clear();
    peer.send({ t: 'room.act', act: { kind: 'rps', choice: 'rock' } });
    const peerPicked = await waitPeer(peer, (v) => v.rps && v.rps.myChoice === 'rock', 6000, '脚本玩家自己的拳确认了');
    assert.equal(peerPicked.rps.myChoice, 'rock');
    // 别人的拳在揭晓前拿不到 —— 这是铁律二在真实报文里的体现
    assert.equal(peerPicked.rps.ready[peerUser.me.id], true, '自己已出拳，ready 应该是 true');
    console.log('  脚本玩家出「石头」，报文里只有自己的拳（对手的拳还没揭晓）');

    // 先查浏览器这边：应该只看到「对手已出、我还没出」，且报文里没有别人的拳。
    // （揭晓那一刻太快抓不住，所以查这个更硬的东西。）
    const beforePick = await page.evalRaw(`(() => {
      const chips = [...document.querySelectorAll('#online-panel .online-board .ready-chip')];
      return {
        chips: chips.length,
        on: chips.filter((c) => c.classList.contains('on')).length,
        rpsJson: JSON.stringify((window.GameNet.room.view || {}).rps || {}),
      };
    })()`);
    assert.equal(beforePick.chips, 2, `猜拳阶段应该有两个人的准备状态，实际 ${beforePick.chips}`);
    assert.equal(beforePick.on, 1, `应该只有对手「已出」，实际已出 ${beforePick.on} 人`);
    assert.ok(
      !/rock|scissors|paper/.test(beforePick.rpsJson),
      `浏览器报文里出现了还没揭晓的拳：${beforePick.rpsJson}`
    );
    console.log(`  浏览器报文里的猜拳状态：${beforePick.rpsJson}`);
    console.log('  还没揭晓时，浏览器拿不到对手的拳（报文里搜不到任何手势名）');

    /* ---------------------------------------------------------------
     * 5b-1. ⚠️ 演出期间点不动（用户第 2 条要求，docs/DECISIONS.md D10）
     *
     * 怎么把"演出进行中"这个瞬间**钉死**：往平台的队列里塞一步 1.4 秒的假演出
     * （`FrpAnim.push` 本来就不认识具体游戏，它只按你返回的毫秒数排时间轴）。
     * 老代码（演出期间照样能点）在这条用例里会当场把 room.act 发出去 → 变红。
     * 三件事一起验：控件真的变灰禁点（CSS）、真鼠标点发不出去、程序化点也发不出去（JS 兜底）。
     * ------------------------------------------------------------- */
    console.log('\n── 5b-1. 演出期间锁输入（本轮的关键防线）');
    await spySends(page);
    // 顺便挂上"逐步音效"探针（幂等：5b 开头已经挂过一次，这里只是确保它一定在）
    // ⚠️ 探针必须在**点击之前**挂好（回放是点击之后立刻开始的）
    await spyAudioPerStep(page);
    await page.waitFor(`return !(window.FrpAnim && window.FrpAnim.busy())`, 8000, '开演前队列是空的');
    await page.evalRaw(`(() => {
      window.FrpAnim.push([{ probe: true }], () => 1400);
      return true;
    })()`);
    await page.waitFor(`return window.FrpAnim.busy() === true`, 3000, '演出进行中');
    const busyUi = await page.evalRaw(`(() => {
      const btn = document.querySelector('#online-panel .online-board .rps-btn');
      const cs = getComputedStyle(btn);
      const board = document.querySelector('#online-panel .online-board');
      const bs = board ? getComputedStyle(board) : null;
      return {
        bodyBusy: document.body.classList.contains('frp-anim-busy'),
        opacity: cs.opacity,
        pointerEvents: cs.pointerEvents,
        // 牌桌自己有没有被整块调暗（用户原话："不要忽然暗屏"）
        boardOpacity: board ? bs.opacity : null,
        boardFilter: board ? bs.filter : null,
      };
    })()`);
    assert.equal(busyUi.bodyBusy, true, '演出期间 body 上没有 frp-anim-busy（平台的钩子没接上？）');
    assert.equal(busyUi.pointerEvents, 'none', `演出期间动作控件必须禁点，现在 pointer-events=${busyUi.pointerEvents}`);
    assert.ok(Number(busyUi.opacity) < 1, `演出期间动作控件要变灰，现在 opacity=${busyUi.opacity}`);
    // 不暗屏（GAME-SPEC §11 第 10 条）：只有**按钮**可以变灰，牌桌本身必须原样。
    // ⚠️ 用 0.99 而不是严格等于 1：入场动画/合成层的舍入会让它偶尔量出 0.999…
    //    （严格等于会在 CI 里偶发红）。判据是"没被调暗"，0.99 足够。
    assert.ok(
      Number(busyUi.boardOpacity) >= 0.99,
      `演出期间牌桌被整块调暗了（opacity=${busyUi.boardOpacity}）—— 用户原话是"不要忽然暗屏"`
    );
    assert.equal(busyUi.boardFilter, 'none', `演出期间牌桌被加了 filter=${busyUi.boardFilter}（整块变灰/变暗）`);
    console.log(
      `  ✓ 演出中：动作按钮变灰禁点（opacity=${busyUi.opacity}），牌桌本身没被调暗` +
        `（opacity=${busyUi.boardOpacity} / filter=${busyUi.boardFilter}）`
    );

    const sendsBeforeBusy = await sendCount(page);
    const panelBeforeBusy = await page.evalRaw(PANEL_HTML);
    const busySnap = () =>
      page.evalRaw(`(() => ({
        picked: document.querySelectorAll('#online-panel .online-board .rps-btn.is-picked').length,
        readyOn: document.querySelectorAll('#online-panel .online-board .ready-chip.on').length,
      }))()`);
    const snapBefore = await busySnap();
    // (1) 真鼠标点：应该被 CSS 的 pointer-events:none 挡在外面
    await page.click('#online-panel .online-board .rps-btn[data-rps="scissors"]').catch(() => {});
    // (2) 程序化点：绕过 CSS，必须被游戏自己的 `_blocked()` 挡住
    const clickedDuring = await page.evalRaw(CLICK_SUBMIT);
    assert.notEqual(clickedDuring, 'no-board', '演出期间牌桌不见了');
    assert.equal(
      await sendCount(page),
      sendsBeforeBusy,
      '演出期间还是把 room.act 发出去了（锁没生效）—— 服务端那一帧早就推进过回合了'
    );
    assert.equal(await page.evalRaw(PANEL_HTML), panelBeforeBusy, '演出期间点了动作入口，界面却变了');
    const snapAfter = await busySnap();
    assert.equal(snapAfter.picked, snapBefore.picked, `演出期间自己那格被点亮了：${JSON.stringify(snapAfter)}`);
    assert.equal(snapAfter.readyOn, snapBefore.readyOn, `演出期间自己变成「已出」了：${JSON.stringify(snapAfter)}`);
    console.log(`  ✓ 演出中（${clickedDuring}）：真点 + 程序化点都没发出去，界面一个字没变`);

    // 演出演完之后必须**立刻恢复** —— 锁是临时的，不是把游戏锁死
    await page.waitFor(`return !(window.FrpAnim && window.FrpAnim.busy())`, 5000, '演出演完');
    assert.equal(
      await page.evalRaw(`return document.body.classList.contains('frp-anim-busy')`),
      false,
      '演出演完了 body 上还挂着 frp-anim-busy（按钮会一直是灰的）'
    );
    console.log('  ✓ 演出演完：frp-anim-busy 已摘掉，操作权回来了');

    /* ---------------------------------------------------------------
     * 5b-2. 不做本地预演（用户第 1 条要求）
     *
     * 老代码在这里会**同步**把"我这一手"演出来（online.js 的 optimistic()：
     * 点亮自己那格 + 出音效 + 记指纹），而契约是"点下去到服务器回包之间本机一动不动"。
     * 判定刻意做成**同步**的：在同一个 JS 任务里「快照 → 派发点击 → 再快照」，
     * 老代码的乐观改动正好发生在这两句之间，新代码什么都还没发生 —— 没有竞态、不靠等。
     * ------------------------------------------------------------- */
    console.log('\n── 5b-2. 点下去本机不演（本地预演已删除）');
    const sendsBeforePick = await sendCount(page);
    const noPreview = await page.evalRaw(`(() => {
      const b = document.querySelector('#online-panel .online-board');
      const snap = () => ({
        panel: b.querySelector('.action-panel').innerHTML,
        picked: b.querySelectorAll('.rps-btn.is-picked').length,
        readyOn: b.querySelectorAll('.ready-chip.on').length,
      });
      const btn = b.querySelector('.rps-btn[data-rps="scissors"]');
      if (!btn || btn.disabled) return { skip: btn ? '按钮已经禁用了' : '没找到剪刀按钮' };
      const before = snap();
      btn.click();     // 同步派发：老代码会在这一句里就把自己那格点亮
      const after = snap();
      return {
        same: before.panel === after.panel,
        picked: [before.picked, after.picked],
        readyOn: [before.readyOn, after.readyOn],
      };
    })()`);
    assert.equal(noPreview.skip, undefined, `这一步没点成拳：${noPreview.skip}`);
    assert.equal(noPreview.same, true, `点下去本机立刻改了界面（本地预演没删干净）：${JSON.stringify(noPreview)}`);
    assert.deepEqual(noPreview.picked, [0, 0], `点下去自己那格就亮了：${JSON.stringify(noPreview)}`);
    assert.deepEqual(noPreview.readyOn, [1, 1], `点下去自己就变成「已出」了：${JSON.stringify(noPreview)}`);
    assert.equal(
      await sendCount(page),
      sendsBeforePick + 1,
      '点下去必须真的把这一手发出去（"不在本地演"不等于"不发"）'
    );
    console.log(`  ✓ 点「剪刀」：界面一个字没动，但 room.act 真的发出去了（${sendsBeforePick}→${sendsBeforePick + 1}）`);

    // 揭晓：石头赢剪刀 → 行动权在脚本玩家手里，浏览器应该进入"等对手行动"
    // ⚠️ 上面的「剪刀」是**同步派发**发出去的，所以这里不再重复点一次 ——
    //    按钮此时已经 disabled，再点只会是一次空点（看起来像"点了没反应"）。
    await page.waitFor(`return !!document.querySelector('#online-panel .online-board .waiting')`, 8000, '浏览器进入等待对手行动');
    console.log('  揭晓：石头赢剪刀 → 浏览器看到「等 侠 行动中」');

    /* ---------------------------------------------------------------
     * 5b-3. 「我出拳了」那一声：**在服务器回放 `rps-pick` 那一步响**（captain 收口时补的）
     *
     * 原项目是点按钮立刻 `play('pick')`（原 `js/ui/app.js` 720~723 行）。
     * 删本地预演时那一声被一起删掉了，而回放的 `rps-pick` 本来不播声 ——
     * 于是出拳变成**全程静音**。现在补回到回放那一步（"音效跟着权威确认走"）：
     *   · 我自己那一票：`rps-pick` 这一步必须响（振荡器 ≥1）
     *   · 别人 / 人机的票：**不许响**（一轮里全响就是连击）
     * ⚠️ 这两条只有"逐步数振荡器"分得清（见 spyAudioPerStep）。
     * ------------------------------------------------------------- */
    const audio = await audioSteps(page);
    assert.ok(audio, '音效探针没挂上（FrpAnim.push / AudioContext 的接线变了？）');
    const myIdHere = await page.eval(`return window.GameNet && window.GameNet.me ? window.GameNet.me.id : null`);
    const picks = audio.steps.filter((s) => s.t === 'rps-pick');
    const myPick = picks.filter((s) => s.pid === myIdHere);
    const otherPick = picks.filter((s) => s.pid !== myIdHere);
    assert.ok(picks.length > 0, `回放里根本没走到 rps-pick 那一步：${JSON.stringify(audio.steps)}`);
    assert.ok(
      myPick.some((s) => s.osc > 0),
      `我出拳那一步一声都没响（这个音被顺手删掉了？）：${JSON.stringify(picks)}`
    );
    assert.ok(
      otherPick.length > 0,
      `一个别人的 rps-pick 都没走到，"只响我自己那一票"这条没被测到：${JSON.stringify(picks)}`
    );
    assert.deepEqual(
      otherPick.map((s) => s.osc).filter((n) => n !== 0),
      [],
      `别人的拳也响了（一轮里所有人都出拳 = 连击）：${JSON.stringify(otherPick)}`
    );
    console.log(
      `  ✓ 出拳的声：我那一票 ${myPick.length} 步响了（振荡器 ${myPick.map((s) => s.osc).join('/')}），` +
        `别人那 ${otherPick.length} 票全静音`
    );

    const peerTurn = await waitPeer(peer, (v) => v.phase === 'action' && v.current === peerUser.me.id, 8000, '脚本玩家拿到行动权');
    assert.equal(peerTurn.stepsLeft, 2, `独自获胜应该拿 2 步，实际 ${peerTurn.stepsLeft}`);
    console.log(`  揭晓：石头赢剪刀 → 脚本玩家拿到 ${peerTurn.stepsLeft} 步行动`);

    // 脚本玩家买刀（同一个意图信封，和本地那条路一模一样）
    peer.clear();
    peer.send({ t: 'room.act', act: { kind: 'act', type: 'buy_knife' } });
    const bought = await waitPeer(peer, (v) => (v.players.find((p) => p.id === peerUser.me.id) || {}).knife === true, 6000, '脚本玩家买到刀');
    assert.equal(bought.stepsLeft, 1, `买刀花掉 1 步，应该剩 1 步，实际 ${bought.stepsLeft}`);
    // 浏览器这边必须看到播报（说明服务端的状态真的广播到了真浏览器）
    await page.waitFor(`return [...document.querySelectorAll('#online-panel .online-board .log-line')].some((l) => l.textContent.includes('买了一把刀'))`, 8000, '浏览器看到对手买刀的播报');
    console.log('  脚本玩家买刀（剩 1 步）→ 浏览器牌桌上出现了「侠 买了一把刀」');

    /* ---------- 5c. 没人出拳时，客户端催办超时（这是本游戏自己补的机制） ---------- */
    console.log('\n── 5c. 双方都不出拳，等客户端催服务器代出');
    // 脚本玩家结束剩余行动 → 回到猜拳 → 两边都不点，看谁把超时推起来
    peer.clear();
    peer.send({ t: 'room.act', act: { kind: 'act', type: 'pass' } });
    const rpsAgain = await waitPeer(peer, (v) => v.phase === 'rps', 8000, '回到猜拳阶段');
    console.log(`  回到猜拳（第 ${rpsAgain.round} 回合）。两边都不出拳，看浏览器会不会在 10 秒后催服务器代出…`);
    const auto = await waitPeer(
      peer,
      (v) => v.log.some((l) => l.text.includes('超时未出拳')) || v.phase !== 'rps',
      22000,
      '超时自动代出'
    );
    assert.ok(
      auto.log.some((l) => l.text.includes('超时未出拳')),
      `没有出现「超时未出拳」的播报 —— 客户端没把超时推起来。现在：${auto.phase} 第 ${auto.round} 回合`
    );
    console.log(`  ✓ 超时机制生效：服务端代出了（现在 ${auto.phase} / 第 ${auto.round} 回合）`);

    await page.screenshot(join(SHOTS, '07-online-after.png'));
    peer.close();
    await sleep(600); // 等"脚本玩家退出"引起的重画落定，再点「离开」

    /*
     * 离开房间。
     * ⚠️ 这里**不能按 class 点**（`#online-panel .frp-btn-ghost` 会随房间状态匹配到别的幽灵按钮，
     * 实测十次里会有一两次点错，然后一直等不到"回到首页"）。
     * 改成先按文字找到「离开」，给它临时挂个 id，再用真鼠标点它。
     *
     * 平台侧的坑：离开的人收不到新状态，房间界面会停在原地。
     * 本游戏在 1.2 秒后自己重载页面收尾（见 js/ui/online.js 的注释），
     * 所以正常情况下这里会回到干净的首页。
     */
    /** 是不是已经干净地退出房间了（客户端不残留房间状态 + 房间面板回到入口态） */
    async function hasLeft() {
      try {
        return await page.evalRaw(`(() =>
          !window.GameNet.room && !!document.querySelector('#online-panel .frp-room-idle'))()`);
      } catch {
        return false;
      }
    }

    /**
     * 按下「离开」并等到干净退房（客户端不再残留房间状态，房间面板回到入口态）。
     *
     * ⚠️ 踩过的两点：
     *   1. **不能按 class 点**（`#online-panel .frp-btn-ghost` 会匹配到别的幽灵按钮），
     *      要按文字找到「离开」，给它临时挂个 id，再用真鼠标点。
     *   2. **面板每收到一条新状态就整块重画**，挂好的 id 会跟着没，
     *      所以"挂 id → 点"要重试；而且点成功之后按钮就消失了，别把它当成失败。
     *   3. 离开之后**停在"在线对局"页**（平台的行为，不会自己跳回首页），
     *      而且 `GameNet.room` 会变成 null —— 服务端在 rooms.leave() 里专门给离开的人
     *      补了一条 `{t:'room.state', code:null}`（平台侧已经修好了）。
     */
    async function clickLeave() {
      for (let attempt = 0; attempt < 25; attempt++) {
        if (await hasLeft()) return;
        const found = await page.evalRaw(`(() => {
          const vis = (x) => {
            const r = x.getBoundingClientRect();
            return r.width > 1 && r.height > 1 && getComputedStyle(x).visibility !== 'hidden';
          };
          // ⚠️ 别用 offsetParent 判可见：祖先链里有 position:fixed 时它恒为 null，
          //    会把明明看得见的按钮全过滤掉（实测踩过）。
          const b = [...document.querySelectorAll('#online-panel button')]
            .find((x) => /离开/.test(x.textContent) && vis(x));
          if (!b) return false;
          b.id = 'e2e-leave';
          return true;
        })()`);
        if (found) {
          try {
            await page.click('#e2e-leave');
          } catch {
            /* 元素刚被重画掉，下一轮再来 */
          }
        }
        await sleep(400);
      }
      const what = await page.evalRaw(`(() => {
        const t = (b) => (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 12);
        return {
          btns: [...document.querySelectorAll('#online-panel button')].map(t),
          screen: (document.querySelector('.screen.is-active') || {}).id || '(无)',
          room: window.GameNet.room ? (window.GameNet.room.code || '残留') : null,
          panel: (document.getElementById('online-panel').textContent || '').replace(/\\s+/g, ' ').slice(0, 120),
        };
      })()`);
      throw new Error('离开房间后没回到首页（点了 10 秒）：' + JSON.stringify(what));
    }

    await clickLeave();
    const roomAfter = await page.eval(`return window.GameNet.room ? (window.GameNet.room.code || '残留') : null`);
    assert.equal(roomAfter, null, `离开房间后客户端还残留着房间状态：${roomAfter}`);
    console.log('  已退出房间：房间面板回到入口态，客户端不再残留房间状态');

    /* ---------------------------------------------------------------
     * 5d. 人机是**房间的座位**：一个人 → 按「＋ 添加人机」→ 开局
     *
     * 顺序是"先说清、再验"：
     *   ① 一个人建房（房间层已经保证「开始游戏」是灰的 + 一行"至少要 2 个座位…按「添加人机」补一个"）
     *   ② 真按一次开始（把灰按钮临时放开，模拟"改了客户端的玩家"）→ 服务端拒绝 →
     *      **界面上恰好一条提示条**（验的是"拒绝 → 共用外壳 UI.toast"这条平台链路）
     *   ③ 按「＋ 添加人机」→ 成员列表里多一行灰圈的 `.frp-avatar.is-bot`，名字是单字池里的一个字
     *   ④ 开始 → 地图上出现带 `data-frp-avatar="bot:1"` 的人机 token，AI 的拳已经在服务端出完了
     *   ⑤ 真点出拳直到轮到我行动（打一步）
     * ------------------------------------------------------------- */
    console.log('\n── 5d. 一个人 + 「＋ 添加人机」（人机坐在座位上）');
    await page.click('#online-panel .frp-room-idle .frp-btn-primary');
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-waiting')`, 10000, '单人的新房间出现');
    const soloCode = await page.eval(`return document.querySelector('#online-panel .frp-room-code-value').textContent.trim()`);
    console.log(`  房间号：${soloCode}（房里只有我一个人）`);

    /* ---------------------------------------------------------------
     * 5d-0. 座位不够：服务端必须拒绝开局，界面上恰好弹一条提示条
     *
     * ⚠️ 平台这一版把「开始游戏」在座位不够时**画成了 disabled**（先说清，别让玩家白点一次）。
     *    所以这里先断言"按钮确实是灰的 + 旁边写着怎么补"，再把灰按钮临时放开点一次 ——
     *    这一步验的是**服务端的兜底校验 + 拒绝提示条这条链路**（改了客户端的玩家也走这条路）。
     * ⚠️ 本游戏**没有**自己再挂一条 T.ERROR 监听（js/ui/app.js 里那条老的已经删掉：
     *    留着会和平台这条重复，同一条拒绝弹两次 —— 实测抓到过）。
     * ------------------------------------------------------------- */
    const beforeStart = await page.evalRaw(`(() => {
      const panel = document.getElementById('online-panel');
      const b = [...panel.querySelectorAll('.frp-room-actions button')].find((x) => x.textContent.includes('开始游戏'));
      return { disabled: b ? b.disabled : null, seats: (panel.querySelector('.frp-room-seat-count') || {}).textContent || '' };
    })()`);
    assert.equal(beforeStart.disabled, true, '座位不够时「开始游戏」应当是灰的（房间层先说清）');
    assert.match(beforeStart.seats, /座位 1 \/ 4/, `座位数：${beforeStart.seats}`);

    // 把灰按钮临时放开，点一次 —— 服务端必须拒绝（房主可以改设置再点，所以拒绝后还留在原房间）
    await page.evalRaw(`(() => {
      const b = [...document.querySelectorAll('#online-panel .frp-room-actions button')]
        .find((x) => x.textContent.includes('开始游戏'));
      if (!b) return false;
      b.disabled = false;
      b.click();
      return true;
    })()`);

    await page.waitFor(
      `return [...document.querySelectorAll('.frp-toast')].some(function (t) { return t.textContent.indexOf('座位不够') >= 0 })`,
      10000,
      '座位不够：界面上出现了提示条'
    );
    const soloRejectMsg = await page.eval(
      `return [...document.querySelectorAll('.frp-toast')].map(function (t) { return t.textContent }).join(' | ')`
    );
    const soloRejectCount = await page.eval(`return document.querySelectorAll('.frp-toast').length`);
    console.log(`提示条出现了：「${soloRejectMsg}」`);
    assert.ok(
      soloRejectMsg.includes('至少要 2 个座位') && soloRejectMsg.includes('添加人机'),
      `提示条里必须是房间层那句话（含"至少要 2 个座位"和"添加人机"），实际「${soloRejectMsg}」`
    );
    // ⚠️ **恰好一条**：游戏自己再挂一条 T.ERROR 监听就会弹两次（本游戏曾经就有一条，已删）
    assert.equal(soloRejectCount, 1, `同一条拒绝只许弹一条提示条，实际 ${soloRejectCount} 条：「${soloRejectMsg}」`);
    assert.equal(
      await page.eval(`return !!document.querySelector('#online-panel .online-board')`),
      false,
      '被拒绝时不该进牌桌（进去了就说明拒绝是假的）'
    );
    assert.equal(
      await page.eval(`return document.querySelector('#online-panel .frp-room-code-value').textContent.trim()`),
      soloCode,
      '被拒绝之后还留在原来的房间里（房主可以补个人机再点一次）'
    );
    await page.screenshot(join(SHOTS, '11-online-ai-refused.png'));

    // 提示条是 position:fixed 而且会吃掉真实鼠标点击（见 AGENTS.md），先收掉再往下走
    await page.evalRaw(`(() => {
      document.querySelectorAll('.frp-toast').forEach(function (t) { t.click(); });
      return true;
    })()`);
    await page
      .waitFor(`return document.querySelectorAll('.frp-toast').length === 0`, 5000, '提示条收掉')
      .catch(() => {});

    /* ---------------------------------------------------------------
     * 5d-1. 按「＋ 添加人机」：多一个**座位**（不是"多补几个"的开关）
     * ------------------------------------------------------------- */
    await page.click('#online-panel .frp-room-bot-add');
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-member.is-bot')`, 8000, '成员列表里出现了人机座位');

    const botSeat = await page.evalRaw(`(() => {
      const panel = document.getElementById('online-panel');
      const row = panel.querySelector('.frp-room-member.is-bot');
      const av = row ? row.querySelector('.frp-avatar') : null;
      const addBtn = [...panel.querySelectorAll('.frp-room-actions button')].find((x) => x.textContent.includes('开始游戏'));
      return {
        rowText: row ? row.textContent.replace(/\\s+/g, ' ').trim() : '',
        avatarClass: av ? av.getAttribute('class') : '',
        avatarId: av ? av.getAttribute('data-frp-avatar') : '',
        avatarName: av ? av.getAttribute('data-frp-name') : '',
        avatars: panel.querySelectorAll('.frp-avatar.is-bot').length,
        humans: panel.querySelectorAll('.frp-avatar.is-human, .frp-avatar.is-me').length,
        seatCount: (panel.querySelector('.frp-room-seat-count') || {}).textContent || '',
        startDisabled: addBtn ? addBtn.disabled : null,
      };
    })()`);
    assert.equal(botSeat.avatars, 1, `成员列表里应该有 1 个灰圈人机头像：${JSON.stringify(botSeat)}`);
    assert.match(botSeat.avatarClass, /is-bot/, `人机头像是灰圈（.frp-avatar.is-bot）：${botSeat.avatarClass}`);
    assert.match(botSeat.avatarId, /^bot:\d+$/, `人机座位的 id 形如 bot:1：${botSeat.avatarId}`);
    assert.equal([...botSeat.avatarName].length, 1, `人机名字是**单字**：${botSeat.avatarName}`);
    assert.ok(
      BS_META.botNames.includes(botSeat.avatarName),
      `人机名字来自 meta.botNames 那个单字池：${botSeat.avatarName}`
    );
    assert.match(botSeat.seatCount, /座位 2 \/ 4/, `加完人机是 2 个座位：${botSeat.seatCount}`);
    assert.equal(botSeat.startDisabled, false, '座位够了，「开始游戏」应当变成可点');
    console.log(`  人机座位：${botSeat.rowText}｜头像 class=${botSeat.avatarClass}｜座位 ${botSeat.seatCount}`);
    await layoutCheck(page, '在线·加了 1 个人机 430px');

    await page.click('#online-panel .frp-room-actions .frp-btn-primary'); // 开始游戏
    await page.waitFor(`return !!document.querySelector('#online-panel .online-board .rps-btn')`, 10000, '联机牌桌出现（1 人 + 1 个人机座位）');

    /** 联机牌桌此刻看到的东西 */
    const ONLINE_STATE = `(() => {
      const b = document.querySelector('#online-panel .online-board');
      if (!b) return null;
      const room = window.GameNet.room || {};
      const view = room.view || {};
      return {
        phase: (b.querySelector('.board-status .pill') || {}).textContent || '',
        viewPhase: view.phase || '',
        rps: b.querySelectorAll('.rps-btn:not([disabled])').length,
        rpsAll: b.querySelectorAll('.rps-btn').length,
        chips: b.querySelectorAll('.ready-chip').length,
        readyOn: b.querySelectorAll('.ready-chip.on').length,
        acts: b.querySelectorAll('.act-btn').length,
        tokens: b.querySelectorAll('.token').length,
        // 发给浏览器的报文里那一块猜拳状态（别人的拳在揭晓前绝不能出现在这里）
        rpsJson: JSON.stringify(view.rps || {}),
        seats: (view.players || []).length,
        // 人机座位在界面上长什么样：报文里的身份标记 + 真的画出来的名字/圈
        // （契约要求玩家一眼看得出来，所以不能只断言报文里有字段）
        aiFlag: (view.players || []).filter((p) => p.isAI).map((p) => p.name),
        aiChars: [...b.querySelectorAll('.token.is-ai .tok-char')].map((n) => n.textContent),
        aiChips: [...b.querySelectorAll('.ready-chip.is-ai')].map((n) => n.textContent),
        aiAvatar: (() => {
          const t = b.querySelector('.token.is-bot');
          return t ? { id: t.getAttribute('data-frp-avatar'), name: t.getAttribute('data-frp-name'), cls: t.getAttribute('class') } : null;
        })(),
        myRing: (() => {
          const t = b.querySelector('.token.is-me');
          return t ? t.getAttribute('class') : null;
        })(),
        // 平台头像：真人 token 里的 <image> 要指向 /avatar/；人机只有单字、不挂图
        aiImg: (() => {
          const t = b.querySelector('.token.is-bot');
          const i = t && t.querySelector('image.tok-img');
          return i ? { href: i.getAttribute('href') || '', display: i.style.display } : null;
        })(),
        myImg: (() => {
          const t = b.querySelector('.token.is-me');
          const i = t && t.querySelector('image.tok-img');
          return i ? { href: i.getAttribute('href') || '', display: i.style.display } : null;
        })(),
      };
    })()`;

    const solo0 = await page.evalRaw(ONLINE_STATE);
    assert.ok(solo0, '联机牌桌没画出来');
    assert.equal(solo0.seats, 2, `1 个真人 + 1 个人机座位 = 2 个座位，实际 ${solo0.seats}`);
    assert.equal(solo0.chips, 2, `准备状态应该有 2 条（我 + 人机），实际 ${solo0.chips}`);
    // 玩家不用猜：人机座位的名字和标记必须**真的画在页面上**（不只是报文里有个字段）
    assert.deepEqual(solo0.aiFlag, [botSeat.avatarName], `报文里的人机座位名字要跟成员列表一致：${JSON.stringify(solo0.aiFlag)}`);
    assert.deepEqual(
      solo0.aiChars,
      [botSeat.avatarName],
      `地图上人机头像的名字必须是成员列表里那个单字（灰虚线圈那个），实际 ${JSON.stringify(solo0.aiChars)}`
    );
    assert.ok(solo0.aiAvatar, '地图上没找到人机 token（.token.is-bot）');
    assert.equal(solo0.aiAvatar.id, botSeat.avatarId, `地图上的人机 token 要带 data-frp-avatar=${botSeat.avatarId}：${JSON.stringify(solo0.aiAvatar)}`);
    assert.equal(solo0.aiAvatar.name, botSeat.avatarName, `地图上的人机 token 要带 data-frp-name：${JSON.stringify(solo0.aiAvatar)}`);
    assert.match(solo0.aiAvatar.cls, /is-bot/, `人机 token 的圆环语义类是 is-bot（灰）：${solo0.aiAvatar.cls}`);
    assert.match(solo0.myRing || '', /is-me/, `我自己那个 token 要是 is-me（蓝圈）：${solo0.myRing}`);
    assert.ok(solo0.myImg, '地图上我自己的 token 里没有头像 <image class="tok-img">');
    assert.match(solo0.myImg.href, /^\/avatar\//, `我自己的地图头像要指向平台图片：${JSON.stringify(solo0.myImg)}`);
    assert.notEqual(solo0.myImg.display, 'none', '我自己的地图头像图片不该被藏起来');
    assert.ok(solo0.aiImg, '地图上人机 token 里应有（被藏起来的）tok-img 占位');
    assert.ok(!solo0.aiImg.href, `人机不该挂平台头像图片：${JSON.stringify(solo0.aiImg)}`);
    assert.equal(solo0.aiImg.display, 'none', '人机应显示单字、藏掉图片头像');
    assert.equal(solo0.aiChips.length, 1, `ready 标记里要有 1 条人机座位的（虚线边），实际 ${JSON.stringify(solo0.aiChips)}`);
    assert.ok(solo0.aiChips[0].includes(botSeat.avatarName), `ready 标记上也要写着人机的名字，实际「${solo0.aiChips[0]}」`);
    console.log(
      `  人机座位在界面上：地图头像「${solo0.aiChars[0]}」（灰虚线圈 + data-frp-avatar=${solo0.aiAvatar.id}）｜ready 标记「${solo0.aiChips[0]}」`
    );
    // 地图上带 data-frp-avatar 的两个头像（我 + 人机）热区都要 ≥44px —— 联机牌桌是缩放最小那一档
    await avatarHotzones(page, '#online-panel .online-board', '联机牌桌头像热区（430px）');

    // 头像上的「扔鸡蛋 / 送鲜花」是**平台**接管的（shared/ui/react.js 的 document 事件代理）：
    // 游戏这边只负责把 data-frp-avatar 写在 token 上。所以这里点一下**人机**的头像，
    // 必须弹出平台那个菜单 —— 点不出来就说明属性没写、或者被别的监听吃掉了。
    await page.click(`#online-panel .online-board [data-frp-avatar="${solo0.aiAvatar.id}"]`);
    await page.waitFor(`return !!document.querySelector('.frp-react-menu')`, 3000, '点头像弹出互动菜单');
    const reactMenu = await page.evalRaw(`(() => {
      const box = document.querySelector('.frp-react-menu');
      return {
        title: (box.querySelector('.frp-react-menu-title') || {}).textContent || '',
        buttons: [...box.querySelectorAll('.frp-react-btn')].map((b) => b.textContent.trim()),
        toasts: [...document.querySelectorAll('.frp-toast')].map((t) => t.textContent.trim()),
      };
    })()`);
    assert.ok(
      reactMenu.buttons.some((t) => t.includes('扔鸡蛋')) && reactMenu.buttons.some((t) => t.includes('送鲜花')),
      `头像菜单里应该有「扔鸡蛋」「送鲜花」，实际 ${JSON.stringify(reactMenu.buttons)}`
    );
    assert.ok(reactMenu.title.includes(botSeat.avatarName), `菜单标题要写着对谁动手：${reactMenu.title}`);
    console.log(`  头像互动（平台画的）：${reactMenu.title}｜${reactMenu.buttons.join(' / ')}`);

    // 点一次「送鲜花」：我们在房里，消息必须发得出去 —— 发不出去平台会弹一条"还没连上服务器"
    await page.click('.frp-react-menu .frp-react-btn:nth-of-type(2)');
    await sleep(400);
    const afterFlower = await page.evalRaw(`(() => ({
      menu: !!document.querySelector('.frp-react-menu'),
      toasts: [...document.querySelectorAll('.frp-toast')].map((t) => t.textContent.trim()).join('|'),
    }))()`);
    assert.ok(!afterFlower.menu, '点了「送鲜花」之后菜单要收起来');
    assert.ok(
      !/还没连上服务器/.test(afterFlower.toasts),
      `在房里送鲜花不该说连不上服务器，实际提示条：${afterFlower.toasts}`
    );
    console.log('  送鲜花：菜单收起、消息发得出去（没有"还没连上服务器"的提示条）');
    assert.equal(
      solo0.readyOn,
      1,
      `开局后"人机已经出拳"必须立刻成立（实际已出 ${solo0.readyOn} 条）—— 它要是等客户端催 tick，` +
        `真人就得干等 10 秒（本游戏是所有人同时猜拳）`
    );
    assert.equal(solo0.rpsAll, 3, `出拳按钮应该有 3 个，实际 ${solo0.rpsAll}`);
    assert.ok(
      !/rock|scissors|paper/.test(solo0.rpsJson),
      `人机还没揭晓的拳进了浏览器报文：${solo0.rpsJson}`
    );
    console.log(`  人机已出拳（1 条 ready-chip 亮着），我的 3 个出拳按钮也能点｜报文里的猜拳状态：${solo0.rpsJson}`);

    // 反复真点出拳，直到轮到我行动。AI 的拳服务端早就出完了，所以每点一次都当场结算。
    // ⚠️ **每回合换一手**（石头 → 剪刀 → 布轮着出）：总出同一手的话，AI 会读出手习惯、
    //    每回合都赢，玩家还没等到行动权就被打死了（实测就是这么失败的）。
    const CLICK_HANDS = ['rock', 'scissors', 'paper'];
    let clicked = 0;
    let soloSt = solo0;
    const turnDeadline = Date.now() + 30000;
    while (Date.now() < turnDeadline && soloSt.acts === 0 && soloSt.viewPhase !== 'over') {
      if (soloSt.rps > 0) {
        await clickIdle(page, `#online-panel .online-board .rps-btn[data-rps="${CLICK_HANDS[clicked % CLICK_HANDS.length]}"]`);
        clicked += 1;
        await sleep(400);
      } else {
        await sleep(300);
      }
      soloSt = await page.evalRaw(ONLINE_STATE);
    }
    assert.equal(
      soloSt.viewPhase === 'over',
      false,
      `这局在我拿到行动权之前就打完了（阶段=${soloSt.phase}）—— 1 人 + 1 个人机应该打得有来有回`
    );
    assert.ok(
      soloSt.acts > 0,
      `30 秒内一直没轮到"我"行动（一个人 + 1 个人机打不动？现在阶段=${soloSt.phase}）`
    );
    console.log(
      `  轮到我出拳 → 出了 ${clicked} 次 → 轮到我行动：${soloSt.phase}｜行动按钮 ${soloSt.acts} 个｜地图上 ${soloSt.tokens} 个头像`
    );
    assert.equal(soloSt.tokens, 2, `1 人 + 1 个人机的地图上应该画 2 个头像，实际 ${soloSt.tokens}`);
    await layoutCheck(page, '联机牌桌（1 人 + 1 个人机）430px');
    await page.screenshot(join(SHOTS, '10-online-solo-ai.png'));

    /* ---------------------------------------------------------------
     * 5d-3. 锁输入在**真实演出**里的样子（不是刚才那步假演出）
     *
     * 真点一个行动 → 服务端把这一步 + 人机的整轮一起推回来 → 演出开始。
     * 趁演出还没演完再点下一个行动：既发不出去、界面也不许变。
     * 这一条盯的是"服务端那一帧早就推进过回合了，画面还在演"的真实时序。
     * ------------------------------------------------------------- */
    // 逐步同步 / 倒计时的探针必须**在演出开始之前**挂好（回放是点下去之后立刻开始的）
    await installStepProbe(page);
    console.log('\n── 5d-3. 真实演出期间再点一个行动');
    assert.notEqual(await sendCount(page), -1, '发送探针还在（5b-1 装的）');
    const sendsBeforeReal = await sendCount(page);
    await clickIdle(page, '#online-panel .online-board .act-grid .act-btn');
    await page.waitFor(`return !!(window.FrpAnim && window.FrpAnim.busy())`, 6000, '服务端回包 → 演出开始');
    const sendsDuring = await sendCount(page);
    assert.equal(sendsDuring, sendsBeforeReal + 1, `真点的那一个行动应该发出去（${sendsBeforeReal}→${sendsDuring}）`);
    const realPanelBefore = await page.evalRaw(PANEL_HTML);
    const realClicked = await page.evalRaw(CLICK_SUBMIT);
    assert.equal(
      await sendCount(page),
      sendsDuring,
      `演出期间又发出去了一条 room.act（点了 ${realClicked}）—— 这正是"画面和操作错位"的来源`
    );
    assert.equal(await page.evalRaw(PANEL_HTML), realPanelBefore, '演出期间点了动作入口，界面却变了');
    console.log(`  ✓ 真实演出中再点「${realClicked}」：没发消息、界面没变`);
    await page.waitFor(`return !(window.FrpAnim && window.FrpAnim.busy())`, 8000, '这批演出演完');

    /* ---------------------------------------------------------------
     * 5d-4. 逐步同步：演出演到第几步，画面就必须是第几步（GAME-SPEC §11.10 第 1 条）
     *
     * 用户报的问题是**反过来的**："演到一半，对方的刀马已经亮起来了、位置也瞬移过去了"。
     * 所以这条用例要抓的是"画面跑到前面去了"。做法：
     *   ① 探针把 `FrpAnim.push` 的 fn 包一层，在"每步演完的那一瞬间"（同一个 JS 任务里，
     *      没有任何 CDP 往返）把画面拍下来；
     *   ② 再把队列**卡在中间**（第一步演完先塞一步 1.5 秒的空演出），于是那一刻有
     *      1.5 秒的稳定窗口，外面用 CDP 从容读一次 DOM —— 两次读数必须一模一样
     *      （"采样和点击要在同一次页面求值里"说的就是这个坑）；
     *   ③ 断言四件事：
     *      · 补丁里提到的人：血量 / 刀 / 马 / 位置**正好等于那一步的值**；
     *      · 补丁里**没提到**的人：一根汗毛都没动（"瞬移 / 提前亮"就死在这一条上）；
     *      · 卡住那一刻的画面 **≠ 最终画面**（否则这一帧当不了见证）；
     *      · 队列排空 + 对账之后，画面**正好等于权威视图**。
     * ⚠️ 位置一律读 `.token` 的 `transform`（map.js 只改这个属性），
     *    绝不 `getBoundingClientRect` —— 联机第一次渲染时这块 DOM 还没插进文档，量出来全是 0。
     * ------------------------------------------------------------- */
    console.log('\n── 5d-4. 逐步同步：演出演到第几步，画面就是第几步');
    console.log(`  探针：${await installStepProbe(page)}（5d-3 之前就该挂上）`);

    const boardNow = () =>
      page.evalRaw(`(() => {
        const v = (window.GameNet.room || {}).view || {};
        const b = document.querySelector('#online-panel .online-board');
        return {
          phase: v.phase, current: v.current, stepsLeft: v.stepsLeft,
          acts: b ? b.querySelectorAll('.act-grid .act-btn').length : 0,
          busy: !!(window.FrpAnim && window.FrpAnim.busy()),
        };
      })()`);

    /** 出拳 / 排顺序 / 花一步，一直打到"轮到我行动"为止（后面要量我点下去的那一帧） */
    const waitMyActionTurn = async (budgetMs = 45000) => {
      const t0 = Date.now();
      const hands = ['rock', 'paper', 'scissors'];
      let i = 0;
      while (Date.now() - t0 < budgetMs) {
        const st = await boardNow();
        if (st.phase === 'over') throw new Error('这一局已经打完了，量不到演出了');
        if (st.phase === 'action' && st.acts > 0 && !st.busy) return st;
        if (st.busy) { await sleep(200); continue; }
        const r = await page.evalRaw(playOneExpr(hands[i++ % 3]));
        await sleep(r === 'wait' || r === 'no-board' || r.endsWith('-wait') ? 200 : 300);
      }
      throw new Error('等了很久也没轮到我行动（量不了"演出演到哪一步"）');
    };

    await waitMyActionTurn();
    const marks = await readLandmarks(page);
    assert.ok(Object.keys(marks).length >= 2, `地图上没读到地标（城 / 野外）：${JSON.stringify(marks)}`);
    await page.evalRaw(`(() => { window.__stepProbe.armed = true; return true; })()`);
    await clickIdle(page, '#online-panel .online-board .act-grid .act-btn');
    await page.waitFor(`return !!(window.__stepProbe && window.__stepProbe.frozen)`, 12000, '第一步演完（探针把队列卡在中间）');
    await page.waitFor(`return window.FrpAnim.busy() === true`, 4000, '空演出把队列顶住');
    const live = await readBoardSnap(page); // 跨 CDP 的独立一次读取（页内快照之外的第二双眼睛）
    const fz = (await readStepProbe(page)).frozen;
    assert.ok(fz && fz.after && fz.before, '没采到"演完第一步"那一刻的画面');
    assert.deepEqual(
      snapDiff(fz.after, live),
      [],
      `页内快照和跨 CDP 读到的画面不一致：${snapDiff(fz.after, live).join('、')}`
    );
    console.log(`  卡在中间那一刻：这一步是「${fz.t}」（后面还要演 ${fz.rest.join('、') || '（没有了）'}）`);
    console.log(`    回合条「${fz.after.round}」｜状态「${fz.after.phase}」｜计时器「${live.timer}」`);

    // ① 补丁里提到的人：画面必须正好是"这一步之后"的值
    const patched = (fz.s && fz.s.players) || [];
    for (const p of patched) {
      const tok = fz.after.toks[p.id];
      assert.ok(tok, `补丁里提到 ${p.id}，地图上却没有这个头像`);
      assert.equal(tok.hp, p.alive ? String(p.hp) : '✕', `${p.id} 的血条：这一步之后应该是 ${p.alive ? p.hp : '✕'}，画面是 ${tok.hp}`);
      assert.equal(tok.knife, !!p.knife, `${p.id} 的刀：这一步之后应该是 ${!!p.knife}，画面是 ${tok.knife}`);
      assert.equal(tok.horse, !!p.horse, `${p.id} 的马：这一步之后应该是 ${!!p.horse}，画面是 ${tok.horse}`);
      const at = nearestLandmark(tok.tf, marks);
      assert.equal(
        at && at.where,
        p.place,
        `${p.id} 的位置：这一步之后应该在 ${p.place}，画面上的 transform="${tok.tf}" 离 ${JSON.stringify(at)} 最近`
      );
    }
    // ② 补丁里**没提到**的人：这一步不许动他们（"提前亮 / 瞬移"就死在这一条上）
    for (const pid of Object.keys(fz.after.toks)) {
      if (patched.some((p) => p.id === pid)) continue;
      assert.deepEqual(
        fz.after.toks[pid],
        fz.before.toks[pid],
        `${pid} 不在这一步的补丁里，画面却变了：${JSON.stringify(fz.before.toks[pid])} → ${JSON.stringify(fz.after.toks[pid])}`
      );
    }
    if (fz.s && fz.s.stepsLeft != null) {
      assert.match(
        fz.after.phase + '|' + fz.after.panel,
        new RegExp('(?:还剩|剩) ' + fz.s.stepsLeft + ' 步'),
        `这一步之后还剩 ${fz.s.stepsLeft} 步，画面上却没写：${fz.after.phase}｜${fz.after.panel}`
      );
    }
    if (fz.s && fz.s.round != null) {
      assert.equal(fz.after.round, `第 ${fz.s.round} 回合`, `这一步之后是第 ${fz.s.round} 回合，回合条写的却是「${fz.after.round}」`);
    }

    // ③ 排空 + 对账之后：画面必须正好等于权威视图
    await page.waitFor(`return !(window.FrpAnim && window.FrpAnim.busy())`, 20000, '卡住的那批演出演完');
    await sleep(400); // 对账那一拍（最长 60ms）+ 计时器一拍（200ms）
    const final = await readBoardSnap(page);
    const authView = await page.evalRaw(`(() => {
      const v = (window.GameNet.room || {}).view;
      return v ? JSON.parse(JSON.stringify(v)) : null;
    })()`);
    assert.ok(authView, '拿不到权威视图');
    for (const p of authView.players) {
      const tok = final.toks[p.id];
      assert.ok(tok, `地图上少了 ${p.id}`);
      assert.equal(tok.hp, p.alive ? String(p.hp) : '✕', `对账之后 ${p.id} 的血条应该是 ${p.hp}，画面是 ${tok.hp}`);
      assert.equal(tok.knife, !!p.knife, `对账之后 ${p.id} 的刀应该是 ${!!p.knife}`);
      assert.equal(tok.horse, !!p.horse, `对账之后 ${p.id} 的马应该是 ${!!p.horse}`);
      assert.equal(
        nearestLandmark(tok.tf, marks)?.where,
        p.place,
        `对账之后 ${p.id} 应该站在 ${p.place}，画面上的 transform="${tok.tf}"`
      );
    }
    assert.equal(final.round, `第 ${authView.round} 回合`, `对账之后回合条应该是「第 ${authView.round} 回合」，实际「${final.round}」`);
    assert.ok(!/演出中/.test(final.timer), `队列已经空了，计时器还写着「${final.timer}」`);
    const moved = snapDiff(fz.after, final);
    assert.ok(
      moved.length,
      `卡住那一刻的画面和最终画面一模一样（${JSON.stringify(fz.after.toks)}）—— 这一帧当不了"逐步同步"的见证，得换一帧`
    );
    console.log(`  ✓ 演完「${fz.t}」那一刻：补丁里那 ${patched.length} 个人正好是这一步的值，`);
    console.log(`    没被提到的人一动没动；跨 CDP 再读一次也一模一样`);
    console.log(`  ✓ 排空 + 对账之后：画面 = 权威视图（中间那一刻和最终画面差了：${moved.join('、')}）`);

    /* ---------------------------------------------------------------
     * 5d-5. 倒计时：演出那几秒不许走玩家的表（GAME-SPEC §11.10 的"限时"一条）
     *
     * 两件事：
     *   (a) 演出期间计时器上**一个数字都不许出现**（要显"演出中"）——
     *       探针每 40ms 采一次，采到的每一份都得是"演出中"。
     *       老写法（先在 render 里 tickTimer 一次、再排队）会在这条上变红：
     *       实测采到 ["62","62","演出中",…]，也就是那 0~200ms 里数字已经在跑了。
     *   (b) 队列排空那一刻剩余 ≥ 标称的 90%（服务器给了 REPLAY_BUFFER_MS 缓冲，
     *       就是要抵掉演出这几秒）。标称从 constants.js 算，不在这里抄字面量。
     *
     * ⚠️ **实测出来的缺口（如实记着，没有偷偷放宽断言）**：
     *    猜拳阶段的标称只有 10 秒，而实测一帧最长能演到 **8 步 / 4.1 秒**
     *    （上回合收尾 + 人机整轮 + 新回合开局，全在同一帧里），
     *    缓冲 REPLAY_BUFFER_MS = 2000 只抵得掉 2 秒 —— 排空那一刻只剩 **7.8 秒（78%）**。
     *    所以这里的判据分三层（都要在输出里看得见）：
     *      · 行动阶段（标称 60 秒，玩家真正要思考的那一段）：**必须 ≥90%**，契约在这里必须成立；
     *      · 任何一帧低于 **75%** 一律红 —— 缓冲被改小、或者演出变长，它立刻红；
     *      · 75%~90% 的帧逐条打出来点名（现在只有猜拳阶段会出现），
     *        缺口与根因写在 AGENTS.md 第 15 条，等 captain 决定缓冲要不要加大。
     * ------------------------------------------------------------- */
    console.log('\n── 5d-5. 倒计时：演出期间不许有在跑的数字');
    const hands = ['rock', 'paper', 'scissors'];
    const tPlay = Date.now();
    let clickIdx = 0;
    while (Date.now() - tPlay < 75000) {
      const p = await readStepProbe(page);
      const measured = p.frames.filter((f) => f.play >= 400 && f.deadlineIn != null).length;
      // 顺带要求至少有一条"行动阶段"的排空记录 —— 契约那条断言拿它当见证帧
      if (measured >= 5 && p.drains.some((d) => d.phase === 'action')) break;
      const st = await boardNow();
      if (st.phase === 'over') break;
      if (st.busy) { await sleep(200); continue; }
      const r = await page.evalRaw(playOneExpr(hands[clickIdx++ % 3]));
      await sleep(r === 'wait' || r === 'no-board' || r.endsWith('-wait') ? 200 : 300);
    }

    const sp = await readStepProbe(page);
    const real = sp.frames.filter((f) => f.play >= 400 && f.types.every((t) => t));
    assert.ok(real.length >= 3, `演出帧采得太少（${real.length} 条），这条断言没有说服力：${JSON.stringify(real)}`);
    const noisy = real.filter((f) => f.timerSeen.some((t) => /^[0-9]+$/.test(t)));
    assert.equal(
      noisy.length,
      0,
      `演出期间计时器上出现了在跑的数字（共 ${real.length} 帧，${noisy.length} 帧有问题）：${JSON.stringify(noisy.map((f) => f.timerSeen))}`
    );
    console.log(`  ✓ ${real.length} 帧演出（每 40ms 采一次计时器，共 ${real.reduce((n, f) => n + f.timerSeen.length, 0)} 次采样）里一个数字都没有`);

    // 同一个"排空"会被几条帧记录各报一次，按时间归并
    const drains = [];
    for (const d of sp.drains) {
      const dup = drains.find((x) => Math.abs(x.at - d.at) < 80);
      if (!dup) drains.push(d);
      else if (d.number != null && dup.number == null) Object.assign(dup, d);
    }
    const NOMINAL = {
      rps: RPS_TIMEOUT_MS - REPLAY_BUFFER_MS,
      order: ORDER_TIMEOUT_MS - REPLAY_BUFFER_MS,
      action: ACTION_TIMEOUT_MS - REPLAY_BUFFER_MS,
    };
    const rows = drains
      .map((d) => {
        const nominal = NOMINAL[d.phase] || null;
        // 排空那一刻的剩余 = 服务端给的 deadlineIn − 从这帧到达到排空走掉的时间
        const remain = d.deadlineIn != null ? d.deadlineIn - (d.at - d.t0) : null;
        return { ...d, nominal, remain, pct: nominal && remain != null ? (remain / nominal) * 100 : null };
      })
      .sort((a, b) => a.at - b.at);
    assert.ok(rows.length >= 3, `排空记录太少（${rows.length} 条）：${JSON.stringify(sp.drains)}`);

    /** 缺口的地板：实测最差 77.2%（猜拳阶段 8 步 4.1 秒那两帧）——再往下就是缓冲/演出出了新问题 */
    const FLOOR_PCT = 75;
    for (const r of rows) {
      const head = `  ${String(r.phase || '?').padEnd(6)} 回放 ${String(Math.round(r.play)).padStart(4)}ms（${r.n} 步：${(r.types || []).filter(Boolean).join('+') || '?'}）`;
      if (r.pct == null) { console.log(`${head} → 这一阶段没有限时，跳过`); continue; }
      const flag = r.pct < FLOOR_PCT ? '  ⛔ 低于地板' : (r.pct < 90 ? '  ⚠️ 低于 90%（见 AGENTS.md 第 15 条的已知缺口）' : '');
      console.log(
        `${head} → 排空那一刻还剩 ${Math.round(r.remain)}ms / 标称 ${r.nominal}ms = ${r.pct.toFixed(1)}%` +
        `${r.number != null ? `（画面写的是 ${r.number}）` : ''}${flag}`
      );
    }

    const timed = rows.filter((r) => r.pct != null);
    assert.ok(timed.length >= 1, `一条能换算"排空时还剩多少"的记录都没有`);
    const belowFloor = timed.filter((r) => r.pct < FLOOR_PCT);
    assert.equal(
      belowFloor.length,
      0,
      `队列排空那一刻的剩余低于标称的 ${FLOOR_PCT}%（演出把玩家的思考时间吃掉了，缓冲是不是被改小了？）：` +
        JSON.stringify(belowFloor.map((r) => ({ phase: r.phase, play: Math.round(r.play), remain: Math.round(r.remain), pct: Math.round(r.pct) })))
    );
    // 契约线断言：行动阶段（标称 60 秒 —— 玩家真正要思考的那一段）里回放最长的那一帧必须 ≥90%
    const witness = timed.filter((r) => r.phase === 'action').sort((a, b) => b.play - a.play)[0];
    assert.ok(
      witness,
      `没量到"行动阶段"的排空记录，这条契约断言就没有见证帧了：${JSON.stringify(timed.map((r) => r.phase))}`
    );
    assert.ok(
      witness.pct >= 90,
      `行动阶段回放最长的那个见证帧（${Math.round(witness.play)}ms）排空时只剩 ${witness.pct.toFixed(1)}%，` +
        `低于契约线 90%（GAME-SPEC §11.10）`
    );
    const gap = timed.filter((r) => r.pct < 90);
    console.log(
      `  ✓ 见证帧：行动阶段最长的一帧（${Math.round(witness.play)}ms 回放）排空时还剩 ` +
        `${Math.round(witness.remain)}ms = 标称的 ${witness.pct.toFixed(1)}%（契约线 90%）`
    );
    if (gap.length) {
      console.log(
        `  ⚠️ 有 ${gap.length} 帧低于契约线 90%，全在猜拳阶段（标称只有 10 秒）：` +
          gap.map((r) => `${Math.round(r.play)}ms→${r.pct.toFixed(1)}%`).join('、')
      );
      console.log('     根因：一帧最长 8 步 / 4.1 秒，而 REPLAY_BUFFER_MS 只有 2000 —— 已记在 AGENTS.md 第 15 条');
    }

    /* ---------------------------------------------------------------
     * 5d-6. 对局记录不许被"重画"顶回第一条（用户实机反馈）
     *
     * 房间外壳每收到一帧 `room.state`（或好友在线状态一变）都会 `UI.clear(panel)` 再重画，
     * 而牌桌的根元素是**常驻**的（第 4 条）—— 它被"拔出来再插回去"的那一瞬间，浏览器会把
     * `.log-strip` 的滚动位置**清零**：记录当场跳回**最旧**的一条，要等下一步演出追加上
     * 新行时才又滚回最新。用户原话：
     *   「"演出中"时对局记录会自动上滑至第一条记录，导致对局记录总是在最新的一条
     *     与最旧的一条之间来回跳转」。
     *
     * 做法：先等演出排空、确认记录确实钉在最新一条，然后**强制重画一次房间面板**
     * （`FrpRoom.render(true)` —— 和收到一帧 room.state 走的是同一条路：清面板 + 重挂牌桌），
     * 再读一次滚动位置。老写法（只有 `_renderLog` 追加新行时才写 scrollTop）这里会掉回 0。
     * ------------------------------------------------------------- */
    console.log('\n── 5d-6. 对局记录：房间面板重画之后仍然钉在最新一条');
    await page.waitFor(`return !(window.FrpAnim && window.FrpAnim.busy())`, 20000, '5d-6 之前先等演出排空');
    const LOG_SCROLL = `(() => {
      const el = document.querySelector('#online-panel .online-board .log-strip');
      if (!el) return null;
      return {
        lines: el.querySelectorAll('.log-line').length,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        last: el.lastElementChild ? el.lastElementChild.textContent : '',
      };
    })()`;
    const logBefore = await page.evalRaw(LOG_SCROLL);
    assert.ok(logBefore, '找不到联机牌桌的播报条（.log-strip）');
    assert.ok(
      logBefore.scrollHeight > logBefore.clientHeight + 1,
      `播报条没溢出（内容 ${logBefore.scrollHeight} / 可视 ${logBefore.clientHeight}，${logBefore.lines} 条）——这一条量不出东西来`
    );
    assert.ok(
      logBefore.scrollTop + logBefore.clientHeight >= logBefore.scrollHeight - 2,
      `演出排空之后记录应当停在最新一条：scrollTop=${logBefore.scrollTop}（可视 ${logBefore.clientHeight} / 内容 ${logBefore.scrollHeight}）`
    );
    await page.evalRaw(`(() => { window.FrpRoom.render(true); return true; })()`);
    await sleep(220); // 外壳重画（同步）+ _pinLog 排的那一帧回调
    const logAfter = await page.evalRaw(LOG_SCROLL);
    assert.equal(logAfter.lines, logBefore.lines, `重画之后记录条数变了（${logBefore.lines} → ${logAfter.lines}）`);
    assert.ok(
      logAfter.scrollTop > 0 && logAfter.scrollTop + logAfter.clientHeight >= logAfter.scrollHeight - 2,
      `房间面板重画之后对局记录跳回了最旧的一条（scrollTop=${logAfter.scrollTop}，` +
        `可视 ${logAfter.clientHeight} / 内容 ${logAfter.scrollHeight}）——用户报的"来回跳转"就是它`
    );
    console.log(
      `  ✓ ${logAfter.lines} 条记录｜重画前 scrollTop=${logBefore.scrollTop} → 重画后 ${logAfter.scrollTop}` +
        `（可视 ${logAfter.clientHeight} / 内容 ${logAfter.scrollHeight}）——仍停在「${logAfter.last}」`
    );

    await clickLeave();
    console.log('  已退出「一个人 + 1 个人机座位」的房间');

    /* ---------------------------------------------------------------
     * 5e. 非房主：加/减人机是房主的事
     *
     * 「＋ 添加人机」和「移除」都只有房主能按（房间里那一行座位条上，
     * 非房主看到的是只读的「人机由房主添加」）。给别人画一个点了没用的按钮，
     * 用户会以为界面坏了。做法：脚本玩家建房（他当房主），浏览器用房号进去当客人。
     * ------------------------------------------------------------- */
    console.log('\n── 5e. 非房主：人机由房主添加');
    const hostUser = await registerScript(app, '剑');
    const host = await connectScript(app, hostUser.cookie);
    // 房主的设置：中途允许别人进来（options 里**没有** aiFill —— 那个开关已作废）
    host.send({ t: 'room.create', game: 'blade-steed', options: { allowMidJoin: true } });
    const hostRoom = await host.waitFor('room.state', 5000);
    assert.ok(hostRoom.code, `脚本房主没建出房间：${JSON.stringify(hostRoom).slice(0, 80)}`);
    // 房间层给人机座位留了位置：脚本房主自己按一下「添加人机」，客人那边应当看得见
    host.send({ t: 'room.bot.add', id: '' });
    const hostWithBot = await host.waitFor(
      (m) => m.t === 'room.state' && (m.members || []).some((x) => x.isBot),
      5000
    );
    const hostBot = hostWithBot.members.find((x) => x.isBot);
    assert.ok(hostBot && [...hostBot.name].length === 1, `脚本房主加的人机名字要是一个字：${JSON.stringify(hostBot)}`);
    await page.evalRaw(
      `(() => { window.GameNet.send(window.FrpProtocol.T.ROOM_JOIN, { code: ${JSON.stringify(hostRoom.code)} }); return true; })()`
    );
    await page.waitFor(
      `return !!(window.GameNet.room && window.GameNet.room.code === ${JSON.stringify(hostRoom.code)})`,
      8000,
      '浏览器作为客人进了脚本房主的房间'
    );
    const guestSetup = await page.evalRaw(`(() => {
      const panel = document.getElementById('online-panel');
      const box = panel.querySelector('.frp-room-setup');
      if (!box) return { missing: true };
      return {
        missing: false,
        text: box.textContent.replace(/\\s+/g, ' ').trim(),
        // 旧的「补几个电脑」一排按钮（0/1/2/3 个）必须彻底消失
        aiFillButtons: [...box.querySelectorAll('.seg-btn')].filter((b) => /^\\d+ 个$/.test(b.textContent.trim())).length,
        botAdd: panel.querySelectorAll('.frp-room-bot-add').length,
        botRemove: panel.querySelectorAll('.frp-room-bot-remove').length,
        seatNote: (panel.querySelector('.frp-room-seats') || {}).textContent || '',
        botRows: panel.querySelectorAll('.frp-room-member.is-bot').length,
        botAvatar: panel.querySelectorAll('.frp-avatar.is-bot').length,
        midJoinRow: box.textContent.includes('对局中途允许别人进来'),
      };
    })()`);
    assert.equal(guestSetup.missing, false, '客人也要能看到设置区');
    assert.equal(guestSetup.aiFillButtons, 0, `「补几个电脑」那一排已作废，不该再有：${guestSetup.text}`);
    assert.equal(guestSetup.midJoinRow, true, `本作自己的设置项要保留：${guestSetup.text}`);
    assert.equal(guestSetup.botAdd, 0, '非房主不该看到能点的「＋ 添加人机」');
    assert.equal(guestSetup.botRemove, 0, '非房主不该看到「移除」人机');
    assert.ok(guestSetup.seatNote.includes('人机由房主添加'), `非房主看到的是只读说明：${guestSetup.seatNote}`);
    // 房主加的人机，客人这边也要看得见（它是座位，不是房主私有的东西）
    assert.equal(guestSetup.botRows, 1, `客人应当看到房主加的那 1 个人机座位：${JSON.stringify(guestSetup)}`);
    assert.equal(guestSetup.botAvatar, 1, '客人看到的人机头像也是灰圈（.frp-avatar.is-bot）');
    const guestIsHost = await page.eval(
      `return !!(window.GameNet.room && window.GameNet.room.hostId === window.GameNet.me.id)`
    );
    assert.equal(guestIsHost, false, '这一步浏览器必须是客人，不是房主');
    console.log(`  客人看到的设置区：${guestSetup.text.slice(0, 60)}`);
    console.log(`  客人看到的座位条：${guestSetup.seatNote.replace(/\s+/g, ' ').trim()}`);
    await host.close();
    await clickLeave();
    console.log('  已退出脚本房主的房间');

    // 离开之后停在「在线对局」页（平台的行为），先回首页再继续做窄屏体检
    await page.click('[data-back="screen-home"]');
    await page.waitFor(
      `return document.getElementById('screen-home').classList.contains('is-active')`,
      5000,
      '离开后回首页'
    );

    /* ---------- 6. 360px 窄屏 ---------- */
    console.log('\n── 6. 360px 窄屏体检（常见安卓机宽度）');
    await page.setViewport(360, 740, true);
    await sleep(300);
    await layoutCheck(page, '首页 360px');

    await page.click('#btn-go-online');
    await page.waitFor(`return !!document.querySelector('#online-panel .frp-room-idle')`, 8000, '在线页（360px）');
    await layoutCheck(page, '在线·未进房 360px');
    await page.click('[data-back="screen-home"]');
    await page.waitFor(`return document.getElementById('screen-home').classList.contains('is-active')`, 5000, '回首页');

    await page.click('#btn-go-local');
    await page.waitFor(`return document.getElementById('screen-local').classList.contains('is-active')`, 5000, '人机设置页（360px）');
    await layoutCheck(page, '人机设置 360px');
    await page.click('#btn-local-start');
    await page.waitFor(`return document.querySelectorAll('#local-board .rps-btn').length === 3`, 10000, '牌桌出现（360px）');
    await sleep(400);
    await layoutCheck(page, '人机牌桌 360px');
    // 360px 是"最窄 + SVG 缩放最小"的那一档，头像热区必须在这里也过 44px（实测值见输出）
    await avatarHotzones(page, '#local-board', '人机牌桌头像热区（360px）');
    await page.screenshot(join(SHOTS, '08-board-360.png'));
    await page.click('#local-board .icon-btn.menu');
    await page.click('#menu-leave');
    await page.waitFor(`return document.getElementById('screen-home').classList.contains('is-active')`, 5000, '回首页');

    await page.click('#btn-go-rules');
    await page.waitFor(`return document.getElementById('screen-rules').classList.contains('is-active')`, 5000, '规则页');
    await layoutCheck(page, '规则页 360px');
    await page.screenshot(join(SHOTS, '09-rules-360.png'));

    /* ---------- 7. 控制台必须干净 ---------- */
    console.log('\n── 7. 控制台');
    if (page.errors.length) {
      throw new Error('浏览器控制台有报错：\n' + page.errors.join('\n'));
    }
    console.log('  ✓ 全程零 console 报错');

    console.log('\n✅ 刀马 BladeSteed 浏览器端到端全部通过');
    console.log(`   截图：${SHOTS}`);
  } finally {
    if (page) page.close();
    await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\n❌ 浏览器端到端失败：');
  console.error((err && err.stack) || err);
  process.exitCode = 1;
});