/*
 * 狼人杀 · 真浏览器验证（真 Chrome + 真 HTTP + 真 WebSocket）。
 *
 *   node tests/werewolf.browser.mjs
 *
 * 只证明"页面真的能跑、账号真的接上了"：
 *   · 未登录访问 `/werewolf/` 会被带回平台登录页；
 *   · 登录后页面显示的是**平台账号**（昵称 + 头像），没有昵称输入框；
 *   · 建房 → 6 位房号 → 人没满时「开始」是灰的 → 满了能开 → 进入牌桌看到自己的身份；
 *   · 好友邀请：A 在房里点邀请 → B 的页面弹出邀请卡 → 点接受进同一个房（免密码）；
 *   · 375px 手机宽度不横向溢出；
 *   · 平台首页的狼人杀卡片点得动；
 *   · 全程没有 console error / 未捕获异常。
 *
 * ⚠️ 服务跑在随机端口、浏览器用全新临时 profile，不碰 7891 上正在跑的服务。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startServer } from '../server/server.mjs';
import { Page, findChrome } from '../tools/cdp.mjs';

async function jsonCall(base, path, { cookie, body, method } = {}) {
  const res = await fetch(new URL(path, base), {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  const sid = (res.headers.getSetCookie?.() || [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('sid=') && c.length > 4);
  return { status: res.status, data, cookie: sid };
}

async function registerViaUI(page, base, name) {
  await page.goto(base);
  await page.waitFor(
    `return document.getElementById('screen-auth').classList.contains('is-active')`,
    15_000,
    '登录页出现',
  );
  await page.click('#tab-register');
  await page.setInput('#register-name', name);
  await page.setInput('#register-password', 'secret123');
  await page.setInput('#register-password2', 'secret123');
  await page.click('#form-register .btn-primary');
  await page.waitFor(`return !document.getElementById('modal-id').hidden`, 15_000, 'ID 弹窗出现');
  const id = await page.eval(`return document.getElementById('new-id').textContent`);
  await page.click('#btn-id-done');
  await page.waitFor(`return window.GameNet && window.GameNet.connected === true`, 15_000, '平台连接就绪');
  return id;
}

/** 按可见文字点一个元素（返回是否点到）。 */
function clickByText(page, selector, text) {
  return page.eval(`return (() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const el = els.find((e) => (e.textContent || '').includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
}

async function main() {
  if (!findChrome()) {
    console.log('跳过：本机没有 Chrome / Edge');
    return;
  }

  let page = null;
  let friendPage = null;
  let linkPage = null;
  let app = null;
  const tmpDir = mkdtempSync(join(tmpdir(), 'frp-werewolf-browser-'));

  try {
    app = await startServer({
      port: 0,
      dbPath: join(tmpDir, 'ww.db'),
      statePath: join(tmpDir, 'server.json'),
      werewolfTimeoutScale: 0.04,
    });
    const base = String(app.url).replace(/\/+$/, '');

    page = await Page.launch({ headless: true, width: 1024, height: 900 });

    /* ================= 1. 登录门禁 ================= */
    await page.goto(`${base}/werewolf/`);
    await page.waitFor(
      `return location.pathname === '/' && document.getElementById('screen-auth') && document.getElementById('screen-auth').classList.contains('is-active')`,
      15_000,
      '未登录访问 /werewolf/ 会被带回平台登录页',
    );

    /* ================= 2. 登录后：平台账号 ================= */
    const hostId = await registerViaUI(page, base, '狼人甲');
    await page.goto(`${base}/werewolf/`);
    await page.waitFor(
      `return !!document.querySelector('[data-testid="me-name"]') && document.querySelector('[data-testid="me-name"]').textContent.trim() === '狼人甲'`,
      15_000,
      '大厅出现且显示平台昵称',
    );
    const profile = await page.eval(`return (() => {
      const name = document.querySelector('[data-testid="me-name"]').textContent.trim();
      const img = [...document.querySelectorAll('img')].find((i) => (i.getAttribute('src') || '').startsWith('/avatar/'));
      return { name, avatar: img ? img.getAttribute('src') : null, inputs: document.querySelectorAll('input[name="nickname"]').length };
    })()`);
    assert.equal(profile.name, '狼人甲', '页面昵称必须是平台账号');
    assert.ok(profile.avatar && profile.avatar.startsWith('/avatar/'), '头像要来自平台账号');
    assert.equal(profile.inputs, 0, '不该有"自己填昵称"的入口');

    /* ================= 2.5 规则介绍 ================= */
    await page.click('[data-testid="open-rules"]');
    await page.waitFor(
      `return !!document.querySelector('[data-testid="rules-modal"]')`,
      10_000,
      '点规则介绍后弹出规则弹窗',
    );
    const rulesText = await page.eval(`return document.querySelector('[data-testid="rules-modal"]').innerText`);
    assert.match(rulesText, /14 个角色/);
    assert.match(rulesText, /恶夜骑士/);
    assert.match(rulesText, /守墓人/);
    await page.eval(`return (() => {
      const btn = [...document.querySelectorAll('[data-testid="rules-modal"] button')]
        .find((b) => (b.textContent || '').includes('关闭'));
      if (btn) btn.click();
      return !!btn;
    })()`);

    /* ================= 3. 建房（现在入口在弹窗里） ================= */
    await page.click('[data-testid="open-create"]');
    await page.waitFor(
      `return !!document.querySelector('[data-testid="seat-6"]') && !!document.querySelector('[data-testid="create-room"]')`,
      10_000,
      '点创建房间后弹出房间设置',
    );
    const sheriffDefault = await page.eval(
      `return document.querySelector('[data-testid="sheriff-toggle"]').checked`,
    );
    assert.equal(sheriffDefault, true, '默认带警长');
    await page.click('[data-testid="sheriff-toggle"]');
    assert.equal(
      await page.eval(`return document.querySelector('[data-testid="sheriff-toggle"]').checked`),
      false,
      '警长开关可以关掉',
    );
    await page.click('[data-testid="sheriff-toggle"]');
    await page.click('[data-testid="seat-6"]');
    await page.waitFor(
      `return document.querySelector('[data-testid="role-total"]') && document.querySelector('[data-testid="role-total"]').textContent.includes('6/6')`,
      10_000,
      '6 人房默认角色应该正好配满 6 个',
    );
    const defaultWolves = await page.eval(
      `return document.querySelector('[data-testid="role-count-Werewolf"]').textContent.trim()`,
    );
    assert.equal(defaultWolves, '2', '6 人标准配置是 2 只狼');
    // 加一个角色 → 超出座位，开房按钮必须变灰；减回去再开
    await page.click('[data-testid="role-inc-Idiot"]');
    await page.waitFor(
      `return document.querySelector('[data-testid="role-total"]').textContent.includes('7/6')`,
      10_000,
      '角色总数超出时应该显示 7/6',
    );
    assert.equal(
      await page.eval(`return document.querySelector('[data-testid="create-room"]').disabled`),
      true,
      '角色总数不对时不许开房',
    );
    await page.click('[data-testid="role-dec-Idiot"]');
    await page.waitFor(
      `return document.querySelector('[data-testid="role-total"]').textContent.includes('6/6')`,
      10_000,
      '减回去之后应该重新配满',
    );

    /* ---------- 3.1 胜利条件：屠边要同时有平民和神职，屠城不限 ---------- */
    const winModeDefault = await page.eval(`return (() => {
      const picker = document.querySelector('[data-testid="win-mode-picker"]');
      return picker ? picker.innerText : '';
    })()`);
    assert.match(winModeDefault, /屠边/, '建房弹窗要有胜利条件选择器，且默认屠边');
    assert.match(winModeDefault, /屠城/, '建房弹窗要有屠城选项');
    // 6 人标准 = 2 狼 + 预言家 + 女巫 + 猎人 + 平民：把平民换成长老 → 0 平民
    await page.click('[data-testid="role-dec-Villager"]');
    await page.click('[data-testid="role-inc-Elder"]');
    await page.waitFor(
      `return document.querySelector('[data-testid="create-room"]').disabled === true`,
      10_000,
      '屠边局没有平民时不许开房',
    );
    const rejectText = await page.eval(`return document.querySelector('[data-testid="create-modal"]').innerText`);
    assert.match(rejectText, /屠边局要同时有平民和神职/, '要告诉房主为什么不让开');
    await page.click('[data-testid="win-mode-wipe"]');
    await page.waitFor(
      `return document.querySelector('[data-testid="create-room"]').disabled === false`,
      10_000,
      '切成屠城后同一个配置就能开',
    );
    // 回到"屠边 + 标准配置"，继续原来的建房流程
    await page.click('[data-testid="win-mode-side"]');
    await page.click('[data-testid="role-reset"]');
    await page.waitFor(
      `return document.querySelector('[data-testid="create-room"]').disabled === false`,
      10_000,
      '切回屠边并套用标准配置后可以开房',
    );

    await page.click('[data-testid="create-room"]');
    await page.waitFor(`return !!document.querySelector('[data-testid="room-code"]')`, 15_000, '等候区出现');
    const roomCode = await page.eval(`return document.querySelector('[data-testid="room-code"]').textContent.trim()`);
    assert.match(roomCode, /^\d{6}$/, '房号应该是 6 位数字');
    const composition = await page.eval(`return document.querySelector('[data-testid="role-composition"]').textContent`);
    assert.match(composition, /2 狼人/, '等候区要显示房主配的角色');
    assert.match(composition, /预言家/, '等候区要显示房主配的角色');
    const winModeSetting = await page.eval(
      `return document.querySelector('[data-testid="win-mode-setting"]').innerText`,
    );
    assert.match(winModeSetting, /屠边/, '等候区要把本局胜利条件写出来');
    const startDisabled = await page.eval(`return document.querySelector('[data-testid="start-game"]').disabled`);
    assert.equal(startDisabled, true, '人没坐满时「开始」必须是灰的');

    /* ================= 4. 好友邀请 ================= */
    friendPage = await Page.launch({ headless: true, width: 1024, height: 900 });
    const friendId = await registerViaUI(friendPage, base, '狼人乙');
    await friendPage.goto(`${base}/werewolf/`);
    await friendPage.waitFor(
      `return !!document.querySelector('[data-testid="me-name"]') && !document.body.innerText.includes('连接断开')`,
      20_000,
      '好友大厅出现且 WebSocket 已连上',
    );

    // 直接入库加好友（好友申请流程在 room 测试里覆盖）
    app.store.addFriend(hostId, friendId);

    // 好友的 WebSocket 必须已经"在线"，邀请弹窗才会出现可点的「在线」好友
    const onlineDeadline = Date.now() + 15_000;
    while (!app.hub.isOnline(friendId) && Date.now() < onlineDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(app.hub.isOnline(friendId), true, '好友的 WebSocket 应该在线');

    await page.waitFor(`return !!document.querySelector('[data-testid="invite-open"]')`, 10_000, '邀请按钮出现');
    await page.click('[data-testid="invite-open"]');
    await page.waitFor(
      `return [...document.querySelectorAll('button')].some((b) => b.textContent.includes('狼人乙') && b.textContent.includes('在线'))`,
      15_000,
      '邀请弹窗里能看到在线好友',
    );
    await clickByText(page, 'button', '狼人乙');
    await clickByText(page, 'button', '发送邀请');

    await friendPage.waitFor(
      `return !!document.querySelector('[data-testid="invite-card"]')`,
      15_000,
      '好友页面弹出邀请卡',
    );
    const inviteText = await friendPage.eval(`return document.querySelector('[data-testid="invite-card"]').textContent`);
    assert.match(inviteText, /狼人甲/);
    assert.ok(inviteText.includes(roomCode), '邀请卡里要有 6 位房号');

    await friendPage.click('[data-testid="invite-accept"]');
    await friendPage.waitFor(
      `return document.querySelector('[data-testid="room-code"]') && document.querySelector('[data-testid="room-code"]').textContent.trim() === ${JSON.stringify(roomCode)}`,
      15_000,
      '接受邀请后进同一个房',
    );

    // 房主这边也应该看到 2/6
    await page.waitFor(
      `return [...document.querySelectorAll('*')].some((e) => e.textContent && e.textContent.includes('座位 2/6'))`,
      15_000,
      '房主看到好友已经坐进来',
    );

    /* ================= 4a. 等候区：没有 markdown 星号、房主能踢人 ================= */
    const lobbyHost = await page.eval(`return (() => {
      const kick = document.querySelector('[data-testid="kick-player"]');
      return { text: document.body.innerText, hasKick: !!kick };
    })()`);
    assert.equal(
      lobbyHost.text.includes('**'),
      false,
      '等待区文字不该出现 markdown 星号（以前写着 **不能中途加入**）',
    );
    assert.match(lobbyHost.text, /不能中途加入/, '这句提示本身要留着');
    assert.equal(lobbyHost.hasKick, true, '房主应该能踢掉掉线的人');
    const friendSeesKick = await friendPage.eval(
      `return document.querySelectorAll('[data-testid="kick-player"]').length`,
    );
    assert.equal(friendSeesKick, 0, '只有房主看得到「踢出」按钮');

    /* ================= 4b. 平台好友列表的「进入」深链 ================= */
    linkPage = await Page.launch({ headless: true, width: 1024, height: 900 });
    const linkId = await registerViaUI(linkPage, base, '狼人丙');
    app.store.addFriend(hostId, linkId);
    await linkPage.goto(`${base}/werewolf/join?number=${roomCode}`);
    await linkPage.waitFor(
      `return document.querySelector('[data-testid="room-code"]') && document.querySelector('[data-testid="room-code"]').textContent.trim() === ${JSON.stringify(roomCode)}`,
      15_000,
      '从 /werewolf/join?number= 直接进好友的房',
    );

    /* ================= 5. 补满 6 人，开局 ================= */
    const extras = [];
    const extraCookies = [];
    for (let i = 0; i < 3; i++) {
      const res = await jsonCall(base, '/api/register', { body: { name: `补位${i}`, password: 'secret123' } });
      assert.equal(res.status, 200);
      const joined = await jsonCall(base, '/api/werewolf/room/join', {
        cookie: res.cookie,
        body: { code: roomCode },
      });
      assert.equal(joined.data.ok, true, JSON.stringify(joined.data));
      extras.push(res.me?.id || joined.data);
      extraCookies.push(res.cookie);
    }
    await page.waitFor(
      `return !document.querySelector('[data-testid="start-game"]').disabled`,
      15_000,
      '坐满后「开始」可点',
    );
    await page.click('[data-testid="start-game"]');

    await page.waitFor(`return !!document.querySelector('[data-testid="table"]')`, 20_000, '进入牌桌');
    await page.waitFor(
      `return document.querySelector('[data-testid="my-role"]') && document.querySelector('[data-testid="my-role"]').textContent.trim().length > 0`,
      15_000,
      '看到自己的身份',
    );
    const role = await page.eval(`return document.querySelector('[data-testid="my-role"]').textContent.trim()`);
    assert.ok(
      ['狼人', '白狼王', '预言家', '女巫', '猎人', '守卫', '白痴', '平民'].includes(role),
      `身份显示不对：${role}`,
    );
    const phase = await page.eval(`return document.querySelector('[data-testid="phase"]').textContent.trim()`);
    assert.ok(phase.length > 0, '顶栏要有阶段');

    /* ==================================================================
     * 5. 牌桌真的能玩：夜间提示 / 一轮里连发两段话 / 弃票
     *
     * 人类（房主）只用鼠标，另外 5 个座位用接口代替 —— 和玩家实际走的路径一样。
     * 页面更新是异步的（WS 推送 → load），所以每条断言都是"等 DOM"，不是"接口说啥就断言啥"。
     * ================================================================== */
    const loginViaApi = async (id) => {
      const res = await jsonCall(base, '/api/login', { body: { id, password: 'secret123' } });
      assert.equal(res.status, 200, `${id} 登录失败：${JSON.stringify(res.data)}`);
      assert.ok(res.cookie, `${id} 没拿到会话`);
      return res.cookie;
    };
    // 平台是按 ID + 密码登录的（注册时那个弹窗让人抄的就是它）
    const hostCookie = await loginViaApi(hostId);
    const others = [await loginViaApi(friendId), await loginViaApi(linkId), ...extraCookies];

    const viewOf = async (cookie) => {
      const res = await jsonCall(base, '/api/werewolf/game/status', { cookie });
      return res.data?.data?.view || null;
    };
    const actOf = async (cookie, body) => {
      const res = await jsonCall(base, '/api/werewolf/game/act', { cookie, body });
      return res.data;
    };

    /** 替一个座位做掉当前能做的所有事（一律选"不做"的选项，最省事）。
     *  `avoidSeat` = 人类（房主）的座位：别人不许刀他，否则人类活不到投票阶段。 */
    const driveSeat = async (cookie, v, avoidSeat) => {
      const can = v.can || {};
      const alive = (v.players || []).filter((p) => p.alive);
      const firstOther = alive.filter((p) => p.seat !== v.self.seat && p.seat !== avoidSeat)[0]
        || alive.filter((p) => p.seat !== v.self.seat)[0];
      if (can.guard) return actOf(cookie, { type: 'guard', seat: null });
      if (can.wolf) return actOf(cookie, { type: 'wolf', seat: firstOther ? firstOther.seat : null });
      if (can.wolfBeauty) return actOf(cookie, { type: 'charm', seat: null });
      if (can.witch) return actOf(cookie, { type: 'witch', action: 'pass' });
      if (can.seer) return actOf(cookie, { type: 'seer', seat: null });
      if (can.hunter) return actOf(cookie, { type: 'hunter', seat: null });
      if (can.transfer) return actOf(cookie, { type: 'transfer', seat: null });
      if (can.signup) return actOf(cookie, { type: 'signup', wants: false });
      if (can.badgeVote) return actOf(cookie, { type: 'badgeVote', seat: null });
      if (can.vote) return actOf(cookie, { type: 'vote', seat: null });
      if (can.wwkBoom) return actOf(cookie, { type: 'wwkBoom', seat: null });
      if (can.endSpeech) return actOf(cookie, { type: 'endSpeech' });
      return null;
    };

    /** 往可编辑区整段插入文字（一次调用，比逐字输入快一个数量级）。 */
    const insertSpeech = async (text) => {
      return page.eval(`(() => {
        const el = document.querySelector('[data-testid="speech-input"] [contenteditable="true"]');
        if (!el) return 'no-editor';
        el.focus();
        const ok = document.execCommand('insertText', false, ${JSON.stringify(text)});
        return (ok ? 'ok:' : 'fail:') + el.innerText;
      })()`);
    };

    let sawNightPanel = '';
    let sawTwoParagraphs = false;
    let abstained = false;
    let skippedNight = '';
    const trace = [];

    for (let i = 0; i < 500; i++) {
      const st = await viewOf(hostCookie);
      if (!st) throw new Error('拿不到自己的对局视图');
      const ph = st.phase;
      if (ph === 'GAME_END') break;

      // ① 夜间面板不能是空白（以前守卫那晚就是一块空白）
      if (ph.startsWith('NIGHT_') && ph !== 'NIGHT_START' && !sawNightPanel) {
        const text = await page.eval(
          `return (document.querySelector('[data-testid="dialog-panel"]')||{}).innerText || ''`,
        );
        if (text.trim().length > 0) sawNightPanel = text.trim();
      }

      // ② 轮到我说话：等页面把输入框画出来，然后一轮里连发两段
      if (st.currentSpeakerSeat === st.self.seat) {
        const gotInput = await page
          .waitFor(`return !!document.querySelector('[data-testid="speech-input"]')`, 5000, '轮到我时出现输入框')
          .then(() => true)
          .catch(() => false);
        if (!gotInput) {
          trace.push(`NO_INPUT ${ph} sp=${st.currentSpeakerSeat}`);
          continue;
        }
        const insertEcho = await insertSpeech('第一段话');
        const sendOk = await page
          .waitFor(
            `return (() => { const b = document.querySelector('[data-testid="speech-send"]'); return !!b && !b.disabled; })()`,
            5000,
            '打完字后发送键可点',
          )
          .then(() => true)
          .catch(() => false);
        if (!sendOk) {
          const editorText = await page.eval(
            `return ((document.querySelector('[data-testid="speech-input"] [contenteditable="true"]')||{}).innerText) || ''`,
          );
          trace.push(`SEND_FAIL inserted=${JSON.stringify(insertEcho)} editor=${JSON.stringify(editorText)}`);
          continue;
        }
        await page.click('[data-testid="speech-send"]');
        await page.waitFor(
          `return document.body.innerText.includes('第一段话')`,
          10_000,
          '第一段话进了记录',
        );
        // 关键：一轮发言里还能再发第二段（不会因为说了第一段就换人）
        await insertSpeech('第二段话');
        await page.waitFor(
          `return (() => { const b = document.querySelector('[data-testid="speech-send"]'); return !!b && !b.disabled; })()`,
          10_000,
          '第二段打字后发送键可点',
        );
        await page.click('[data-testid="speech-send"]');
        await page.waitFor(
          `return document.body.innerText.includes('第二段话')`,
          10_000,
          '第二段话也进了记录（同一轮里连发）',
        );
        sawTwoParagraphs = true;
        const stillMe = await page.eval(`return !!document.querySelector('[data-testid="speech-end"]')`);
        assert.equal(stillMe, true, '连发两段之后还应该是我的麦，不该自动换人');
        await page.click('[data-testid="speech-end"]');
        continue;
      }

      // ③ 放逐投票：弃票按钮必须存在，点得动
      if (ph === 'DAY_VOTE' && st.can.vote && !abstained) {
        const appeared = await page
          .waitFor(`return !!document.querySelector('[data-testid="vote-abstain"]')`, 5000, '弃票按钮出现')
          .then(() => true)
          .catch(() => false);
        if (!appeared) {
          const pagePhase = await page.eval(
            `return (document.querySelector('[data-testid="phase"]')||{}).innerText || ''`,
          );
          trace.push(`NO_ABSTAIN pagePhase=${JSON.stringify(pagePhase)}`);
          continue;
        }
        await page.click('[data-testid="vote-abstain"]');
        abstained = true;
        continue;
      }

      // ④ 轮到我行动的那一夜：面板要有明确提示 + 一个"不选"的按钮
      if (!skippedNight && (st.can.guard || st.can.wolf || st.can.seer || st.can.wolfBeauty)) {
        const gotPrompt = await page
          .waitFor(`return !!document.querySelector('[data-testid="night-prompt"]')`, 5000, '夜间行动提示出现')
          .then(() => true)
          .catch(() => false);
        if (gotPrompt) {
          const text = await page.eval(
            `return (document.querySelector('[data-testid="night-prompt"]')||{}).innerText || ''`,
          );
          assert.match(text, /轮到你/, '轮到我行动时必须有明确提示');
          const clicked = await page.eval(`return (() => {
            const btn = document.querySelector('[data-testid="night-prompt"] button');
            if (!btn) return false;
            btn.click();
            return true;
          })()`);
          assert.equal(clicked, true, '夜间行动必须留一个"不选"的按钮');
          skippedNight = ph;
          continue;
        }
      }

      // ⑤ 其它座位用接口做掉，人类页面等着
      for (const cookie of others) {
        const v = await viewOf(cookie);
        if (!v) continue;
        await driveSeat(cookie, v, st.self.seat);
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    if (!sawTwoParagraphs) console.error('[TRACE]\n' + trace.slice(-25).join('\n'));
    assert.ok(sawNightPanel, '夜里对话框不能是空白（要写着谁在行动 / 轮到你）');
    assert.equal(sawTwoParagraphs, true, '一轮发言里要能连发两段话');
    assert.equal(abstained, true, '放逐投票要能弃票');

    /* ================= 6. 375px 手机宽度 ================= */
    await page.setViewport(375, 812, true);
    await page.goto(`${base}/werewolf/`);
    await page.waitFor(`return !!document.querySelector('[data-testid="table"]')`, 20_000, '手机宽度也能进牌桌');
    const overflow = await page.eval(
      `return { sw: document.documentElement.scrollWidth, iw: window.innerWidth }`,
    );
    assert.ok(overflow.sw <= overflow.iw + 2, `横向溢出了：${overflow.sw} > ${overflow.iw}`);

    /* ================= 7. 平台首页卡片 ================= */
    await page.setViewport(1024, 900, false);
    await page.goto(`${base}/`);
    await page.waitFor(`return !!document.querySelector('#game-grid .game-card')`, 15_000, '首页游戏列表出现');
    const card = await page.eval(`return (() => {
      const cards = [...document.querySelectorAll('#game-grid .game-card')];
      const wolf = cards.find((c) => c.textContent.includes('狼人杀'));
      if (!wolf) return null;
      const btn = wolf.querySelector('.card-actions button');
      return { disabled: btn ? btn.disabled : true, text: btn ? btn.textContent.trim() : '' };
    })()`);
    assert.ok(card, '首页应该有狼人杀卡片');
    assert.equal(card.disabled, false, '狼人杀卡片不该是灰的');

    /* ================= 8. 没有前端报错 ================= */
    const errors = [...(page?.errors || []), ...(friendPage?.errors || []), ...(linkPage?.errors || [])].filter(
      (e) => !/favicon/i.test(e),
    );
    assert.deepEqual(errors, [], `页面不该有 console error：\n${errors.join('\n')}`);

    console.log(
      '✔ 狼人杀：登录门禁、平台昵称头像、建房、好友邀请（接受后进同一房）、6 人开局、' +
        '房主踢人、夜间提示、一轮连发两段发言、弃票、375px、首页卡片',
    );
  } finally {
    if (linkPage) await linkPage.close();
    if (friendPage) await friendPage.close();
    if (page) await page.close();
    app?.werewolf?.reset?.();
    if (app) await app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});


