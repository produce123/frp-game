/*
 * 莲花广麻 · 登录门保留 ?join 的专项浏览器测试。
 *
 * 为什么单独一个文件：这个流程要依次「未登录打开带房号的链接 → 注册 → 回跳 → 自动进房」，
 * 和主测试里已经开着的 Three.js 页面放在同一个无头 Chrome 里会偶发网络卡死（本机 headless
 * 多实例的毛病），所以这里起**独立的服务 + 独立的浏览器**，只跑这一条链路。
 *
 * 依赖：games/mahjong/backend/.venv（见 games/mahjong/README.md）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/server.mjs';
import { Page } from '../tools/cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acceptDisclaimerIfOpen(page) {
  return page.evalRaw(`return (() => {
    const button = [...document.querySelectorAll('button')]
      .find((el) => el.textContent.trim() === '同意并继续' && el.getBoundingClientRect().width > 1);
    if (!button) return false;
    button.click();
    return true;
  })()`);
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'mahjong-join-'));
  const srv = await startServer({
    port: 0,
    dbPath: join(dir, 'test.db'),
    statePath: join(dir, 'state.json'),
    mahjongBackend: true,
    mahjongBackendPort: 8199,
    mahjongDbPath: join(dir, 'mahjong-backend.db'),
  });
  assert.equal(srv.mahjong?.ready, true, '麻将后端没起来（缺 .venv？见 README）');
  const base = srv.url.replace(/\/$/, '');
  let page;

  try {
    // 房主用 API 建房（不留在页面上），把房号当作「好友发来的邀请链接」
    const reg = await fetch(base + '/api/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '房主甲', password: 'secret123' }),
    });
    assert.equal(reg.status, 200);
    const cookie = reg.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const created = await fetch(base + '/mahjong/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ mode: 'east', capacity: 4, rulesetId: 'lotus-classic' }),
    });
    assert.equal(created.status, 200);
    const code = (await created.json()).roomId;
    assert.match(code, /^[A-Z0-9]{4,8}$/, '房号格式');

    console.log('[join] 未登录打开 /mahjong/?join=' + code);
    page = await Page.launch({ headless: true, width: 1280, height: 900, startUrl: base });
    await page.goto(base + '/mahjong/?join=' + code);
    await page.waitFor(
      `return document.getElementById('screen-auth')?.classList.contains('is-active') === true`,
      15_000,
      '登录页'
    );
    await page.click('#tab-register');
    await page.setInput('#register-name', '登录后进房丁');
    await page.setInput('#register-password', 'secret123');
    await page.setInput('#register-password2', 'secret123');
    await page.click('#form-register .btn-primary');
    await page.waitFor(`return !document.getElementById('modal-id').hidden`, 15_000, 'ID 弹窗');
    await page.click('#btn-id-done');

    // 注册后自动回 /mahjong/?join=…；第一次联机会先弹免责声明
    for (let i = 0; i < 30; i++) {
      if (await acceptDisclaimerIfOpen(page)) break;
      await sleep(200);
    }
    await page.waitFor(
      `return document.querySelector('.room-code strong')?.textContent?.trim() === ${JSON.stringify(code)}`,
      30_000,
      '登录回跳后自动进房'
    );
    console.log('[join] 登录后自动进了同一个房 ' + code);

    assert.ok(
      !(await page.evalRaw('return location.search')).includes('join='),
      '进房后地址栏不再带 ?join'
    );
    console.log('MAHJONG JOIN BROWSER OK');
  } finally {
    try { await page?.close(); } catch { /* 已经关了 */ }
    await srv.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});