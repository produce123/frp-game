/*
 * 真浏览器：**平台共用层**的两件事（这一轮新加的，平台自己的一层，不属于任何游戏）。
 *
 *   node tests/shared.browser.mjs
 *
 * 【为什么要有这一条】
 * 这一轮给平台加了两样东西，它们的"坏法"都是**静默**的，单元测试看不见：
 *
 *   1. **音效 / 特效只有一份偏好**（`shared/ui/ui.js` 的 `FrpUI.prefs`）。
 *      平台设置栏和三个游戏里的开关都只是这份偏好的入口。坏掉的典型症状是
 *      "我在设置里关了，进游戏还是响" —— 页面自己看着一切正常。
 *   2. **身份先记住、再对齐**（`shared/net/net.js` 的 `rememberMe/cachedMe/forgetMe`）。
 *      游戏页靠它**瞬间**显示名字/ID，不用等公网那次 2~3 秒的 WebSocket 握手。
 *      坏掉的典型症状是"又变成正在确认身份…"，而且**本机测不出来**（本机握手只有几毫秒）。
 *
 * 【怎么把"瞬间"这条钉死】
 * 把 WebSocket **整个换成永远不会连上的假货**（`Page.addScriptToEvaluateOnNewDocument`
 * 在页面脚本之前注入），这样游戏页**绝不可能**从服务端拿到身份。
 * 此时名字/ID 还显示得出来，就只可能来自 `frp.me` 那份缓存 —— 这才是"不用等握手"的硬证据。
 *
 * ⚠️ 真 HTTP + 真 WebSocket + 真 Chrome，但服务跑在**随机端口**、浏览器用**全新临时 profile**，
 *    所以既不碰 7891 上正在跑的服务，也不会被上一次跑残留的 localStorage 影响。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/server.mjs';
import { Page } from '../tools/cdp.mjs';

/** 一次求值里做完"清掉旧偏好 → 写老键"，返回读到的结果（避免中间被别的脚本读到）。 */
const LEGACY_PROBE = `
  return (function () {
    localStorage.removeItem('frp.prefs');
    localStorage.setItem('cg.sound', '0');
    localStorage.setItem('cg.fx', '0');
    return true;
  })()
`;

async function main() {
  let page = null;
  let app = null;
  const tmpDir = mkdtempSync(join(tmpdir(), 'frp-shared-'));
  try {
    app = await startServer({ port: 0, dbPath: join(tmpDir, 'shared.db'), statePath: join(tmpDir, 'server.json') });
    const base = String(app.url).replace(/\/+$/, '');
    page = await Page.launch({ headless: true, width: 430, height: 932, mobile: true });

    /* ================= 1. 偏好：默认值、写入、订阅、老键迁移 ================= */
    await page.goto(`${base}/games/cannon-goblin/`);
    await page.waitFor('return !!window.FrpUI && !!window.FrpUI.prefs', 15_000, '共用层加载完');

    const defaults = await page.eval(`return { sound: FrpUI.prefs.sound(), fx: FrpUI.prefs.fx() }`);
    assert.equal(defaults.sound, true, '全新浏览器上音效默认应该是开');
    assert.equal(defaults.fx, true, '全新浏览器上特效默认应该是开（没有 prefers-reduced-motion 时）');

    // 写一份 → localStorage 里必须是同一份（三个游戏/平台外壳都读它）
    const afterSet = await page.eval(`
      return (function () {
        window.__seen = [];
        FrpUI.prefs.on(function (p) { window.__seen.push(p); });
        FrpUI.prefs.setSound(false);
        FrpUI.prefs.setFx(false);
        return {
          sound: FrpUI.prefs.sound(),
          fx: FrpUI.prefs.fx(),
          stored: JSON.parse(localStorage.getItem('frp.prefs') || 'null'),
          seen: window.__seen.slice(),
        };
      })()
    `);
    assert.equal(afterSet.sound, false, 'setSound(false) 之后读回来必须也是关');
    assert.equal(afterSet.fx, false, 'setFx(false) 之后读回来必须也是关');
    assert.deepEqual(afterSet.stored, { sound: false, fx: false }, 'localStorage 里必须落成同一份偏好');
    assert.ok(afterSet.seen.length >= 2, '订阅者必须收到变化通知（平台设置栏靠它同步）');
    assert.deepEqual(afterSet.seen[afterSet.seen.length - 1], { sound: false, fx: false }, '通知里带的必须是最新值');
    console.log('偏好：默认开 → 写关 → localStorage 与订阅者都跟着变 ✅');

    // 老键迁移：只有第一次读时生效（页面重新加载才会重读）
    await page.eval(LEGACY_PROBE);
    await page.goto(`${base}/games/cannon-goblin/`);
    await page.waitFor('return !!window.FrpUI && !!window.FrpUI.prefs', 15_000, '重新加载');
    const migrated = await page.eval(`return { sound: FrpUI.prefs.sound(), fx: FrpUI.prefs.fx() }`);
    assert.equal(migrated.sound, false, '老键 cg.sound=0 应该被当成"用户本来就关着"，不能突然响起来');
    assert.equal(migrated.fx, false, '老键 cg.fx=0 同理');
    console.log('偏好：老键（cg.sound / cg.fx）迁移生效，不会被无声地重置成"开" ✅');

    /* ================= 2. 共用按钮音：开关、自动接、静音名单 ================= */
    const clickSound = await page.eval(`
      return (function () {
        // 数"真的创建了振荡器"= 真的出声了（无头浏览器听不到，这是唯一硬证据）
        var real = AudioContext.prototype.createOscillator;
        window.__osc = 0;
        AudioContext.prototype.createOscillator = function () { window.__osc++; return real.apply(this, arguments); };

        var host = document.createElement('div');
        host.innerHTML = '<button id="probe-btn">点我</button>'
          + '<button id="probe-off" data-frp-nosound>静音按钮</button>'
          + '<button id="probe-dis" disabled>禁用的</button>';
        document.body.appendChild(host);
        FrpUI.sound.bindClicks(host);

        function fire(id) { document.getElementById(id).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); }

        FrpUI.prefs.setSound(false);           // 音效关着
        window.__osc = 0; fire('probe-btn');
        var offCount = window.__osc;

        FrpUI.prefs.setSound(true);            // 打开
        window.__osc = 0; fire('probe-btn');
        var onCount = window.__osc;

        window.__osc = 0; fire('probe-off');
        var mutedCount = window.__osc;

        window.__osc = 0; fire('probe-dis');
        var disabledCount = window.__osc;

        window.__osc = 0; var ok = FrpUI.sound.click();
        var manual = window.__osc;
        return { offCount: offCount, onCount: onCount, mutedCount: mutedCount, disabledCount: disabledCount, manual: manual, clickReturned: ok };
      })()
    `);
    assert.equal(clickSound.offCount, 0, '音效关掉时点按钮不许出声');
    assert.ok(clickSound.onCount >= 1, `音效打开时点按钮必须出声（实测振荡器 ${clickSound.onCount} 个）`);
    assert.equal(clickSound.mutedCount, 0, 'data-frp-nosound 的按钮必须静音');
    assert.equal(clickSound.disabledCount, 0, '禁用的按钮必须静音');
    assert.ok(clickSound.manual >= 1 && clickSound.clickReturned === true, 'FrpUI.sound.click() 本身也要能出声');
    console.log(`共用按钮音：关=0 声 / 开=${clickSound.onCount} 声 / 静音名单=0 声 / 禁用=0 声 ✅`);

    /* ================= 3. 身份记忆：记、读、忘 ================= */
    const identity = await page.eval(`
      return (function () {
        GameNet.forgetMe();
        var before = GameNet.cachedMe();
        GameNet.rememberMe({ id: 'ABCDEFG', name: '刀' });
        var after = GameNet.cachedMe();
        var raw = localStorage.getItem('frp.me');
        // 多余字段不许进缓存（只留 id / name）
        GameNet.rememberMe({ id: 'ABCDEFG', name: '刀', token: '不许进来' });
        var raw2 = localStorage.getItem('frp.me');
        GameNet.forgetMe();
        return {
          before: before, after: after, raw: raw, raw2: raw2,
          afterForget: GameNet.cachedMe(), left: localStorage.getItem('frp.me'),
        };
      })()
    `);
    assert.equal(identity.before, null, '全新浏览器上不该有记着的身份');
    assert.deepEqual(identity.after, { id: 'ABCDEFG', name: '刀' }, '记下的身份要能原样读回来');
    assert.deepEqual(JSON.parse(identity.raw2), { id: 'ABCDEFG', name: '刀' }, '缓存里只许留 id / name');
    assert.equal(identity.afterForget, null, 'forgetMe() 之后必须读不到了');
    assert.equal(identity.left, null, 'forgetMe() 必须把 localStorage 那条也删掉（否则换个人用会看到上一个人的名字）');
    console.log('身份记忆：记 → 读 → 忘，且只留 id/name ✅');

    /* ================= 4. 注册一次，平台外壳必须把身份记下来 ================= */
    await page.goto(base);
    await page.waitFor(`return document.getElementById('screen-auth').classList.contains('is-active')`, 15_000, '登录页');
    await page.click('#tab-register');
    await page.setInput('#register-name', '刀');
    await page.setInput('#register-password', 'secret123');
    await page.setInput('#register-password2', 'secret123');
    await page.click('#form-register .btn-primary');
    await page.waitFor(`return !document.getElementById('modal-id').hidden`, 15_000, 'ID 弹窗');
    const id = await page.eval(`return document.getElementById('new-id').textContent`);
    await page.click('#btn-id-done');
    await page.waitFor(
      `return !!(window.GameNet && window.GameNet.connected && window.GameNet.cachedMe())`,
      15_000,
      '注册之后身份被记下来'
    );

    const cachedAfterRegister = await page.eval(`return window.GameNet.cachedMe()`);
    assert.ok(cachedAfterRegister && cachedAfterRegister.id === id,
      `注册进平台之后身份必须被记下来（拿到 ${JSON.stringify(cachedAfterRegister)}，期望 id=${id}）`);
    console.log(`注册进平台 → 身份已记下（${cachedAfterRegister.name} · ${id}）✅`);

    /* ============ 5. 魔法：把 WebSocket 换成永远连不上的假货，再进游戏页 ============ */
    // 从这一刻起新建的文档里，WebSocket 永远不会 open、也永远不会发 ready。
    // 游戏页要是还能显示名字/ID，就只可能来自 frp.me。
    await page.conn.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        (function () {
          function FakeWS(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; }
          FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
          FakeWS.prototype.send = function () {};
          FakeWS.prototype.close = function () {};
          FakeWS.prototype.addEventListener = function () {};
          FakeWS.prototype.removeEventListener = function () {};
          window.WebSocket = FakeWS;
        })();
      `,
    });

    const games = [
      { slug: 'cannon-goblin', label: '大炮轰小鬼', expr: `
          var name = document.getElementById('menu-me-name');
          var bid = document.getElementById('menu-me-id');
          var el = name || document.querySelector('#me-line, .me-line');
          if (!el) return null;
          return name ? (name.textContent + ' ' + (bid ? bid.textContent : '')) : el.textContent;` },
      { slug: 'blade-steed', label: '刀马', expr: `
          var el = document.getElementById('me-line');
          return el ? el.textContent : null;` },
      { slug: 'shell-gambit', label: '恶魔轮盘', expr: `
          var name = document.getElementById('home-name');
          var bid = document.getElementById('home-id');
          return name ? (name.textContent + ' ' + (bid ? bid.textContent : '')) : null;` },
    ];

    for (const g of games) {
      await page.goto(`${base}/games/${g.slug}/`);
      await page.waitFor(
        `return !!window.FrpUI && !!window.GameNet`,
        15_000,
        `${g.label} 的共用层加载完`
      );
      // 最多等 4 秒。身份是从缓存里读的，本该**立刻**出现；这里留宽一点只是为了
      // 别和"脚本执行顺序"赛跑 —— 真等满 4 秒说明缓存这条路没走通。
      let seen = null;
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        seen = await page.eval(`
          return (function () {
            var connected = !!(window.GameNet && window.GameNet.connected);
            var text = (function () { ${g.expr} })();
            return { text: text, connected: connected };
          })()
        `);
        if (seen.text && String(seen.text).includes(id)) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.equal(seen.connected, false,
        `${g.label}：这一步必须真的没连上（不然"瞬间显示"就证明不了什么）`);
      assert.ok(seen.text && seen.text.includes(id),
        `${g.label}：WebSocket 连不上时也要立刻显示名字/ID（拿到 ${JSON.stringify(seen.text)}，期望含 ${id}）`);
      assert.ok(!/正在确认身份|还没登录/.test(seen.text),
        `${g.label}：不许出现"正在确认身份…"或"还没登录"（拿到 ${JSON.stringify(seen.text)}）`);
      console.log(`${g.label}：WebSocket 连不上的情况下，身份依然立刻可见（${seen.text.trim()}）✅`);
    }

    /* ================= 6. 关掉音效之后，游戏页读到的必须是"关" ================= */
    await page.eval(`return FrpUI.prefs.setSound(false)`);
    for (const slug of ['cannon-goblin', 'blade-steed', 'shell-gambit']) {
      await page.goto(`${base}/games/${slug}/`);
      await page.waitFor('return !!window.FrpUI', 15_000, `${slug} 加载`);
      const on = await page.eval(`return FrpUI.prefs.sound()`);
      assert.equal(on, false, `${slug}：平台设置栏关掉的音效，游戏页必须也是关（两处不许打架）`);
    }
    console.log('跨页一致：平台关掉音效 → 三个游戏页读到的都是"关" ✅');

    /* ============ 7. 存储被禁用（隐私模式）时不许把页面搞崩 ============ */
    // 用户的浏览器要是拒绝存储（隐私模式 / 站点数据被禁），页面必须还能用：
    // 偏好退回默认值、身份读不到就当没登录 —— 而不是白屏。
    // ⚠️ 这条会对**之后所有导航**生效，所以放在最后跑。
    await page.conn.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get: function () { throw new Error('storage blocked'); },
        });
      `,
    });
    await page.goto(`${base}/games/cannon-goblin/`);
    await page.waitFor('return !!window.FrpUI && !!window.GameNet', 15_000, '存储被禁时共用层仍要加载');
    const blocked = await page.eval(`
      return (function () {
        var out = {};
        try {
          out.sound = FrpUI.prefs.sound();
          out.fx = FrpUI.prefs.fx();
          out.cached = GameNet.cachedMe();
          // 写不进去也不许抛
          FrpUI.prefs.setSound(false);
          GameNet.rememberMe({ id: 'ABCDEFG', name: '刀' });
          out.wrote = 'ok';
          out.afterWrite = GameNet.cachedMe();
        } catch (err) {
          out.error = String(err);
        }
        return out;
      })()
    `);
    assert.ok(!blocked.error, `存储被禁用时不许抛错（拿到 ${blocked.error}）`);
    assert.equal(blocked.sound, true, '读不到存储就退回默认值：音效默认开');
    assert.equal(blocked.fx, true, '读不到存储就退回默认值：特效默认开');
    assert.equal(blocked.cached, null, '读不到存储就当作"没记着身份"（不许崩）');
    console.log(`存储被禁用（隐私模式）：偏好退回默认、身份读不到也不崩 ✅（写回 ${blocked.wrote}）`);

    const errs = page.errors.filter((e) => !/favicon|net::ERR_|AudioContext/i.test(e));
    assert.deepEqual(errs, [], `页面有控制台报错：\n${errs.join('\n')}`);

    console.log('\n✅ 平台共用层真浏览器用例全部通过');
    console.log('   覆盖：偏好默认值 / 写入与订阅 / 老键迁移 / 共用按钮音（含静音名单）/');
    console.log('         身份记忆（记·读·忘·只留 id,name）/ 注册后自动记下 /');
    console.log('         WebSocket 连不上时三个游戏仍立刻显示身份 / 关音效跨页一致');
  } finally {
    if (page) page.close();
    if (app && app.close) await app.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

await main();