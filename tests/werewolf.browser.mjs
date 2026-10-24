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
      werewolfTimeoutScale: 0.02,
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
    await page.click('[data-testid="create-room"]');
    await page.waitFor(`return !!document.querySelector('[data-testid="room-code"]')`, 15_000, '等候区出现');
    const roomCode = await page.eval(`return document.querySelector('[data-testid="room-code"]').textContent.trim()`);
    assert.match(roomCode, /^\d{6}$/, '房号应该是 6 位数字');
    const composition = await page.eval(`return document.querySelector('[data-testid="role-composition"]').textContent`);
    assert.match(composition, /2 狼人/, '等候区要显示房主配的角色');
    assert.match(composition, /预言家/, '等候区要显示房主配的角色');
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
    for (let i = 0; i < 3; i++) {
      const res = await jsonCall(base, '/api/register', { body: { name: `补位${i}`, password: 'secret123' } });
      assert.equal(res.status, 200);
      const joined = await jsonCall(base, '/api/werewolf/room/join', {
        cookie: res.cookie,
        body: { code: roomCode },
      });
      assert.equal(joined.data.ok, true, JSON.stringify(joined.data));
      extras.push(res.me?.id || joined.data);
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
      '✔ 狼人杀：登录门禁、平台昵称头像、建房、好友邀请（接受后进同一房）、6 人开局、375px、首页卡片',
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


