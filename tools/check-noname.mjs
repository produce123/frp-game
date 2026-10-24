/*
 * 无名杀 Web 的体检：`node tools/check-noname.mjs`
 *
 * 它不是平台游戏（没有引擎、没有房间层），所以 它不走平台游戏接口 ——
 * 它的大小、协议、坑都来自上游，能坏的只有三样东西：
 *
 *   ① 静态托管能不能把 `/noname/` 拼对（含上游那些**根绝对路径**）；
 *   ② 文件后端（`/checkFile` 等 9 个接口）是不是上游那个形状 —— 少了就白屏；
 *   ③ 模块身份**只有一份**（`lib` / `game` 不能有两份），否则武将包一加载就崩。
 *
 * 这三样都是"改服务端顺手能弄坏、而且只在真浏览器里看得见"的，
 * 所以这里跑真 Chrome：零未捕获错误、主菜单出现、所有脚本都从 `/noname/` 加载。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'games', 'noname-web', 'dist');

const step = (msg) => console.log(`\n▶ ${msg}`);

/** 登录后的会话 cookie（无名杀从这一版起**绑平台账号**，没登录进不去）。 */
let sid = '';

function authHeaders(extra = {}) {
  return sid ? { cookie: `sid=${sid}`, ...extra } : extra;
}

/**
 * 在临时服务上注册一个体检账号，拿到会话。
 * 这一步必须用真的 `/api/register` —— 门就是用这张 cookie 开的，
 * 自己伪造一张会让"门到底有没有在验"失去意义。
 */
async function signIn(base) {
  const res = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '体检员', password: 'secret123' }),
  });
  const data = await res.json();
  assert.equal(res.status, 200, `体检账号注册失败：${JSON.stringify(data)}`);
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const raw = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='));
  assert.ok(raw, '注册应该返回会话 cookie');
  sid = raw.slice('sid='.length);
}

/** 找一个空闲端口（联机中继要真监听一个端口）。 */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function preflight() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error(
      `✗ 找不到 ${DIST}\\index.html\n` +
        '  无名杀的打包产物不在（`games/noname-web/` 整目录不进 git）。\n' +
        '  重建：`node tools/noname-update.mjs`（下载 + 打补丁 + pnpm build，约 10 分钟）'
    );
    process.exit(1);
  }
}

/* ---------------------------------------------------------------- 1. 静态 + 文件后端 */

async function checkHttp(app) {
  step('静态托管 + 文件后端（不需要浏览器）');

  const base = app.url.replace(/\/$/, '');

  /*
   * 登录门：没登录时无名杀的两个"页面"入口都必须 302 回平台登录页，
   * 而且要把原地址放进 `?return=`（带上 ?frpJoin= 的邀请深链不能丢）。
   * 素材 / Service Worker / 文件后端**不在**这条门里（拦了会白屏）。
   */
  for (const door of ['/noname/', '/play/noname', '/noname/?frpJoin=ABCD1234']) {
    const res = await fetch(base + door, { redirect: 'manual' });
    assert.equal(res.status, 302, `${door} 没登录时应该 302 到平台登录页`);
    const location = res.headers.get('location') || '';
    assert.ok(location.startsWith('/?return='), `${door} 的 302 应该带 ?return=，实际 ${location}`);
    assert.ok(
      decodeURIComponent(location).includes(door.split('?')[0]),
      `${door} 的 return 里应该带原地址，实际 ${location}`
    );
  }
  const directAsset = await fetch(base + '/noname/noname.js');
  assert.equal(directAsset.status, 200, '素材/模块不该被登录门拦（拦了页面会白屏）');
  console.log('  ✓ 没登录：/noname/、/play/noname 都 302 回登录页（带 ?return=），素材不受影响');

  await signIn(base);

  const get = async (path) => {
    const r = await fetch(base + path, { redirect: 'manual', headers: authHeaders() });
    return { status: r.status, type: r.headers.get('content-type') || '', body: await r.text().catch(() => '') };
  };

  const index = await get('/noname/');
  assert.equal(index.status, 200, '/noname/ 登录后应该是 200');
  assert.match(index.type, /text\/html/, '/noname/ 应该发 index.html');
  assert.match(index.body, /<script type="importmap">/, 'index.html 里应该有 import map（上游构建的产物）');
  assert.match(
    index.body,
    /<script type="module" src="\/noname\/frp-bridge\.js\?v=\d+"><\/script>/,
    '入口页应该被注入平台桥接脚本（名字/头像/邀请/在线状态都靠它）'
  );
  assert.doesNotMatch(
    index.body,
    /"imports":\s*\{\s*"noname":\s*"\//,
    'import map 里的地址必须是相对的（`./xxx`）—— 写成 "/xxx" 会变成站根，`lib`/`game` 会有两份'
  );
  console.log('  ✓ /noname/ 是上游的 index.html（相对 import map + 注入桥接脚本）');

  const bridge = await fetch(base + '/noname/frp-bridge.js', { headers: authHeaders() });
  assert.equal(bridge.status, 200, '桥接脚本应该能从 /noname/frp-bridge.js 取到');
  assert.match(bridge.headers.get('cache-control') || '', /no-store/, '桥接脚本必须 no-store（改了要立刻生效）');
  const bridgeText = await bridge.text();
  assert.match(bridgeText, /frpJoin/, '桥接脚本要处理邀请深链 ?frpJoin=');
  assert.match(bridgeText, /from 'noname'/, '桥接脚本要走 import map 的 noname 包');
  console.log('  ✓ 桥接脚本可加载、no-store、带邀请深链逻辑');

  const redirect = await get('/noname');
  assert.equal(redirect.status, 301, '/noname（不带斜杠）应该 301 到 /noname/');
  console.log('  ✓ /noname → 301 /noname/');

  // 根绝对路径必须**仍然可用**（上游的 character/card/mode 是硬编码 `/xxx` 加载的），
  // 但只能是"同一条通往 /noname/ 的兜底"，不能是第二份文件 —— 这一点由下面的模块身份检查钉住。
  const nonameJs = await get('/noname.js');
  assert.equal(nonameJs.status, 200, '/noname.js 应该能取到（上游的 import map 指向它）');
  const jitTest = await get('/jit-test.ts');
  assert.equal(jitTest.status, 200, '/jit-test.ts 应该能取到（Service Worker 的 TypeScript 探针）');
  console.log('  ✓ 根绝对路径（/noname.js、/jit-test.ts）能取到');

  // ---- 文件后端 9 个接口 ----
  const json = async (path) => {
    const r = await fetch(base + path, { headers: authHeaders() });
    return r.json();
  };

  const stat = await json('/checkFile?fileName=noname.js');
  assert.deepEqual(stat, { success: true, code: 200, data: 'file' }, 'checkFile 的形状要和上游一致');
  const dir = await json('/checkDir?dir=extension');
  assert.equal(dir.data, 'directory', 'checkDir 应该认出 extension/ 是文件夹');
  const missing = await json('/checkFile?fileName=no-such-file.txt');
  assert.deepEqual(missing.data, {}, '查不到的文件，上游返回的是空对象');
  const text = await json('/readFileAsText?fileName=jit-test.ts');
  assert.match(text.data, /ts文件导入成功/, 'readFileAsText 应该能读出文件内容');
  const bytes = await json('/readFile?fileName=jit-test.ts');
  assert.ok(Array.isArray(bytes.data) && bytes.data[0] === 101, 'readFile 应该返回字节数组');
  const list = await json('/getFileList?dir=extension');
  assert.ok(Array.isArray(list.data.folders) && list.data.folders.includes('英雄杀'), 'getFileList 应该列出扩展目录');
  console.log('  ✓ checkFile / checkDir / readFile / readFileAsText / getFileList 都对');

  // 写接口走临时目录（FRP_NONAME_DATA），**不碰真实 data/noname**
  const unsafe = await json('/checkFile?fileName=../../server/auth.mjs');
  assert.deepEqual(unsafe.data, {}, '带 .. 的路径必须当作"不存在"，不许逃出根目录');
  const bad = await fetch(base + '/readFileAsText?fileName=../../../package.json', { headers: authHeaders() });
  assert.equal((await bad.json()).success, false, '越界的路径必须被拒绝');
  console.log('  ✓ 路径穿越（../）被拒绝');

  const write = await fetch(base + '/writeFile', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ path: 'extension/__check__/info.json', data: [...Buffer.from('{"name":"__check__"}')] }),
  });
  assert.equal((await write.json()).success, true, 'writeFile 应该能写进上传目录');
  const created = await json('/checkDir?dir=extension/__check__');
  assert.equal(created.data, 'directory', '写完应该能读到新建的文件夹');
  const readBack = await json('/readFileAsText?fileName=extension/__check__/info.json');
  assert.equal(readBack.data, '{"name":"__check__"}', '写进去的内容应该能按同一路径读回来');
  const forbidden = await fetch(base + '/writeFile', {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ path: 'index.html', data: [60] }),
  });
  assert.equal((await forbidden.json()).success, false, '**不许**覆盖 dist 里自带的文件（index.html）');
  const removed = await json('/removeDir?dir=extension/__check__');
  assert.equal(removed.success, true, 'removeDir 应该能删掉刚建的文件夹');
  console.log('  ✓ writeFile / removeDir 往返正常，覆盖 index.html 被拒绝');

  /* ---- gzip + 协商缓存：手机首屏能不能在 10 秒内载完，全靠这两样 ---- */
  // 用一个**大**模块做样本（顶层的 noname.js 只有几百字节的重导出壳，压了也没意义）
  const bigModule = '/noname/noname/library/index.js';
  const gz = await fetch(`${base}${bigModule}`, { headers: authHeaders({ 'accept-encoding': 'gzip' }) });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers.get('content-encoding'), 'gzip', '文本资源必须 gzip（无名杀首屏 ~250 个模块，不压十几 MB）');
  const gzBody = await gz.text();
  assert.ok(gzBody.length > 10_000, 'gzip 之后正文应该还是完整的 JS');
  const etag = gz.headers.get('etag');
  assert.ok(etag, '文本资源要带 ETag，刷新时才能 304');
  const fresh = await fetch(`${base}${bigModule}`, {
    headers: authHeaders({ 'accept-encoding': 'gzip', 'if-none-match': etag }),
  });
  assert.equal(fresh.status, 304, 'ETag 命中应该是 304');
  const ranged = await fetch(`${base}${bigModule}`, {
    headers: authHeaders({ 'accept-encoding': 'gzip', range: 'bytes=0-99' }),
  });
  assert.equal(ranged.status, 206, 'Range 请求照旧（音频要边播边取）');
  assert.equal(ranged.headers.get('content-encoding'), null, 'Range 请求**不许** gzip（字节范围是压缩前的坐标）');
  // 小文件不压（省 CPU，也省得 imp 里每个小文件都多一层）
  const small = await fetch(`${base}/noname/noname.js`, { headers: authHeaders({ 'accept-encoding': 'gzip' }) });
  assert.equal(small.headers.get('content-encoding'), null, '几百字节的壳文件不值得 gzip');
  console.log('  ✓ gzip + ETag(304) + Range(206 不压缩) + 小文件不压');

  /* ---- 伪横屏外壳 ---- */
  const frame = await get('/play/noname');
  assert.equal(frame.status, 200, '/play/noname 是手机用的伪横屏外壳');
  assert.match(frame.body, /rotate\(90deg\)/, '外壳里要有旋转逻辑');
  assert.match(frame.body, /game\.src = '\/noname\/' \+ joinSuffix/, '外壳要给 iframe 带上 ?frpJoin= 深链');
  console.log('  ✓ /play/noname 外壳（iframe + 旋转 + frpJoin 透传）');

  /* ---- 联机地址默认值（补丁打进去了吗） ---- */
  const libJs = await get('/noname/noname/library/index.js');
  assert.match(libJs.body, /\/noname-online/, '联机的默认地址（hallURL）要指向我们自己的中继');
  const bootJs = await get('/noname/noname/init/index.js');
  assert.match(bootJs.body, /loadtime"\) \|\| "30000"/, '载入超时的默认值要是 30 秒（手机上 10 秒太紧）');
  console.log('  ✓ 补丁都在产物里（联机地址 /noname-online、载入超时 30 秒）');
}

/* --------------------------------------------------------------- 2. 联机中继 */

async function checkRelay(app) {
  step('联机中继（无名杀自己的服务器，从 /noname-online 进来）');

  const { wsConnect } = await import(pathToFileURL(join(ROOT, 'tests', 'ws-client.mjs')).href);

  // 走的是我们自己的 7891（临时端口）+ 裸 TCP 转发 → 中继的真实端口
  const client = await wsConnect({ port: app.port, path: '/noname-online' });
  try {
    // 中继一连上就推房间列表：["roomlist", 房间, 公告, 在线的人, 我的 wsid]
    const hello = await client.waitFor((m) => Array.isArray(m) && m[0] === 'roomlist', 5000);
    assert.ok(Array.isArray(hello[1]), 'roomlist 的第 2 项是房间数组');
    assert.ok(Array.isArray(hello[3]), 'roomlist 的第 4 项是在线玩家数组');
    assert.equal(typeof hello[4], 'string', 'roomlist 的最后一个参数是中继分配的 wsid');

    // 双向：报个身份（中继 2 秒内收不到 key 会把我们踢掉），再改个昵称看它推回来
    client.send(['server', 'key', [`check-${Date.now()}`]]);
    client.clear();
    client.send(['server', 'changeAvatar', '体检机器人', 'caocao']);
    const update = await client.waitFor(
      (m) => Array.isArray(m) && (m[0] === 'updateclients' || m[0] === 'updaterooms'),
      5000
    );
    assert.ok(Array.isArray(update[1]), '中继应该把在线列表推回来');
    console.log('  ✓ 握手 + 房间列表 + 双向报文（经 7891 转发）');
  } finally {
    client.close();
  }

  /*
   * 真正的联机那一趟（用户的原话："我和同学远程打"）：
   * 甲 建房 → 乙 一连上来就在大厅**看得见**那个房间 → 乙 进房 → 甲 收到通知。
   * 报文形状照抄无名杀客户端的（create → config → enter），这样测的是**同一条路**。
   */
  const key = `check-${Date.now().toString(36)}`;
  const owner = await wsConnect({ port: app.port, path: '/noname-online' });
  let guest;
  try {
    await owner.waitFor((m) => Array.isArray(m) && m[0] === 'roomlist', 5000);
    owner.send(['server', 'key', [key]]);
    owner.send(['server', 'create', key, '甲（房主）', 'caocao', {}, 'identity']);
    await owner.waitFor((m) => Array.isArray(m) && m[0] === 'createroom', 5000);
    // 中继只把**配好了**的房间放进大厅列表（room.config 有了才算"能进"）
    owner.send(['server', 'config', { gameStarted: false, mode: 'identity', playerNum: 2 }]);
    owner.clear();

    guest = await wsConnect({ port: app.port, path: '/noname-online' });
    const list = await guest.waitFor((m) => Array.isArray(m) && m[0] === 'roomlist', 5000);
    const room = (list[1] || []).find((r) => Array.isArray(r) && r[4] === key);
    assert.ok(room, '乙连上后应该在大厅里看到甲建的房间');
    assert.equal(room[0], '甲（房主）', '房间条目第 1 项是房主昵称');

    guest.send(['server', 'key', [key]]);
    guest.send(['server', 'enter', key, '乙（同学）', 'sunquan']);
    const joined = await owner.waitFor((m) => Array.isArray(m) && m[0] === 'onconnection', 5000);
    assert.equal(typeof joined[1], 'string', '甲应该收到"有人进房"的通知（带对方的 wsid）');
    console.log('  ✓ 甲建房 → 乙在大厅看到 → 进房 → 甲收到通知');
  } finally {
    owner.close();
    guest?.close();
  }
}

/* ------------------------------------------------------------------- 2. 真浏览器 */

/**
 * 给无头浏览器塞上体检账号的会话 cookie。
 *
 * ⚠️ 必须用 CDP 的 `Network.setCookie`，不能用 `document.cookie =`：
 *    会话是 HttpOnly 的，JS 根本写不进去 —— 而门恰恰只认这张 HttpOnly cookie。
 */
async function loginBrowser(page, base) {
  await page.conn.send('Network.enable');
  const res = await page.conn.send('Network.setCookie', {
    name: 'sid',
    value: sid,
    url: base + '/',
    path: '/',
    httpOnly: true,
  });
  assert.notEqual(res.success, false, '把体检会话写进浏览器失败');
}

/**
 * 无名杀首次启动会自动进「新手向导」的演示对局，主菜单被它挡着。
 * 体检不是玩家，不需要走教学过程：把「跳过向导」点掉、再点「退出」回主菜单。
 * 这不是产品逻辑，只是让体检不依赖"本机以前打开过无名杀"。
 */
async function dismissFirstRunTutorial(page, docExpr = 'document') {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = await page.eval(`
      const doc = ${docExpr};
      if (!doc) return 'no-doc';
      const text = doc.body ? doc.body.innerText : '';
      const visible = (el) => el && el.offsetParent !== null;
      const pick = (label) => [...doc.querySelectorAll('div,button,span')]
        .filter((el) => visible(el) && el.textContent.trim() === label)
        .pop();
      const menu = /身份/.test(text) && /国战/.test(text) && /联机/.test(text) && !/跳过向导/.test(text);
      if (menu) return 'menu';
      const skip = pick('跳过向导');
      if (skip) {
        (skip.closest('.menubutton,button,.button,.control') || skip).click();
        return 'skip';
      }
      if (/跳过向导|自由选将|选择角色|托管中/.test(text)) {
        const quit = pick('退出');
        if (quit) {
          (quit.closest('.menubutton,button,.button,.control') || quit).click();
          return 'quit';
        }
      }
      return 'wait';
    `);
    if (state === 'menu') return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function checkInBrowser(app) {
  step('真浏览器：能不能真的进到主菜单');

  const { Page, findChrome } = await import(pathToFileURL(join(ROOT, 'tools', 'cdp.mjs')).href);
  if (!findChrome()) {
    console.log('  · 本机没有 Chrome/Edge，跳过（这一步是"白屏"唯一能查出来的地方，别长期跳过）');
    return;
  }

  const page = await Page.launch({ headless: true, width: 1000, height: 700 });
  try {
    await loginBrowser(page, app.url);
    await page.goto(app.url.replace(/\/?$/, '/') + 'noname/');
    await dismissFirstRunTutorial(page);
    // 兜底：向导点完/没点完都等主菜单真正出来（导航后的第一帧可能还是黑的）
    await page.waitFor(`return /身份/.test(document.body.innerText) && /联机/.test(document.body.innerText)`, 15_000, '主菜单出现（身份 / 国战 / 联机…）');

    // ① 零未捕获错误。白屏那次的症状是 `game.checkFile is not a function`。
    //    首次向导里点按钮会触发一段被浏览器自动播放策略拒绝的音效（NotAllowedError），
    //    那是无头浏览器的正常现象，不是页面错误。
    const fatalErrors = page.errors.filter((e) => !/NotAllowedError: play\(\)/.test(e));
    assert.deepEqual(fatalErrors, [], `控制台不该有错误：${fatalErrors.join(' | ')}`);

    // ② 除了"新手向导"那种游戏自己的提示，不该弹别的原生框。
    //    无头浏览器没有用户手势，点向导按钮后背景音乐会被自动播放策略拒绝，
    //    无名杀会把这个异常原样弹成错误框 —— 那是环境限制，不是页面坏了。
    const unexpected = page.dialogs.filter((d) => !/GPLv3|新手向导|play\(\) failed|NotAllowedError/.test(d));
    assert.deepEqual(unexpected, [], `不该弹原生对话框：${unexpected.join(' | ')}`);

    // ③ 模块身份：所有脚本都必须从 /noname/ 来，且**没有**根绝对路径的第二份。
    //    这是 `/noname.js` 与 `/noname/noname.js` 双份实例（= 白屏）的回归防线。
    const scripts = await page.evalRaw(`
      return performance.getEntriesByType('resource')
        .map(e => e.name)
        .filter(n => /\\.(js|mjs|ts)$/.test(n))
        .map(n => new URL(n).pathname)
    `);
    assert.ok(scripts.length > 100, `应该加载了上百个模块，实际 ${scripts.length}`);
    const outsiders = scripts.filter((p) => !p.startsWith('/noname/') && p !== '/jit-test.ts');
    assert.deepEqual(outsiders, [], `模块必须都从 /noname/ 加载（根绝对路径会造成两份 lib/game）：${outsiders.slice(0, 5)}`);
    console.log(`  ✓ 零错误、主菜单出现、${scripts.length} 个模块全部来自 /noname/`);

    /*
     * 平台桥接：昵称 / 头像 / 邀请入口。
     * 这几样是用户点名的需求，而且**只在真浏览器里**能看出有没有生效
     * （模块加载失败、import map 不对、菜单重建后没补回来，单测都看不见）。
     */
    try {
      await page.waitFor(`return typeof window.__frpNonameState === 'function'`, 20_000, '桥接脚本读到平台账号');
    } catch (err) {
      console.error(page.logs.slice(-25).join('\n'));
      throw err;
    }
    const ident = await page.eval(`
      const s = window.__frpNonameState();
      return { me: s.me, nick: s.nick, avatar: s.avatar, patched: s.patched };
    `);
    assert.equal(ident.nick, ident.me.name, '无名杀的联机昵称应该自动等于平台名字');
    assert.ok(
      String(ident.avatar).startsWith('/avatar/'),
      `无名杀的联机头像应该指向平台头像地址，实际 ${ident.avatar}`
    );
    assert.equal(ident.patched, true, '图片头像的兼容层要装上（否则头像在无名杀里不显示）');
    console.log(`  ✓ 平台身份已绑定（${ident.nick} / ${ident.avatar}）`);

    /*
     * 弹窗排版：无名杀有全局 `div { position: absolute; }`，桥接的卡片/头/脚也是 div。
     * 这里用同一套 class 注入一个假弹窗量盒子 —— 不依赖好友接口，就能钉住
     * 「头/脚不能盖在列表上」「卡片必须完整落在遮罩里」。
     */
    const layout = await page.eval(`
      const mask = document.createElement('div');
      mask.className = 'frp-noname-mask';
      const rows = Array.from({ length: 20 }, (_, i) =>
        '<li class="frp-noname-friend"><input type="checkbox"><span class="frp-noname-avatar"></span>' +
        '<span class="frp-noname-name">好友' + i + '</span><span class="frp-noname-online">在线</span></li>').join('');
      mask.innerHTML =
        '<div class="frp-noname-card">' +
          '<div class="frp-noname-head"><strong>邀请平台好友</strong>' +
            '<button class="frp-noname-close" type="button">×</button></div>' +
          '<ul class="frp-noname-list">' + rows + '</ul>' +
          '<div class="frp-noname-foot"><div class="frp-noname-msg"></div>' +
            '<button class="frp-noname-btn" type="button">关闭</button>' +
            '<button class="frp-noname-btn primary" type="button">发送邀请</button></div>' +
        '</div>';
      document.body.appendChild(mask);
      const box = (sel) => document.querySelector(sel).getBoundingClientRect().toJSON();
      const result = {
        mask: box('.frp-noname-mask'), card: box('.frp-noname-card'),
        head: box('.frp-noname-head'), list: box('.frp-noname-list'),
        foot: box('.frp-noname-foot'), close: box('.frp-noname-close'),
        send: box('.frp-noname-btn.primary'),
        headPosition: getComputedStyle(document.querySelector('.frp-noname-head')).position,
        footPosition: getComputedStyle(document.querySelector('.frp-noname-foot')).position,
      };
      mask.remove();
      return result;
    `);
    assert.equal(layout.headPosition, 'relative', '弹窗标题栏必须显式 relative（无名杀全局 div 是 absolute）');
    assert.equal(layout.footPosition, 'relative', '弹窗底栏必须显式 relative（否则「关闭」会盖在好友上）');
    assert.ok(layout.head.bottom <= layout.list.top + 1, `标题栏压到了好友列表：${JSON.stringify(layout)}`);
    assert.ok(layout.list.bottom <= layout.foot.top + 1, `底栏压到了好友列表：${JSON.stringify(layout)}`);
    assert.ok(layout.foot.bottom <= layout.card.bottom + 1, '底栏跑出弹窗卡片');
    assert.ok(layout.card.bottom <= layout.mask.bottom + 1 && layout.card.top >= layout.mask.top - 1,
      '弹窗卡片跑出遮罩');
    assert.ok(layout.close.bottom <= layout.head.bottom + 1, '关闭按钮跑出标题栏');
    assert.ok(layout.send.bottom <= layout.foot.bottom + 1 && layout.send.top >= layout.foot.top - 1,
      '「发送邀请」跑出底栏');
    console.log('  ✓ 弹窗盒子没被无名杀的全局 div 样式带跑（关闭 / 发送邀请都在底栏里）');

    const dupes = await page.eval(`
      const names = performance.getEntriesByType('resource').map(e => new URL(e.name).pathname);
      return names.filter(p => p === '/noname.js').length
    `);
    assert.equal(dupes, 0, '/noname.js 不该被单独加载（它必须是 /noname/noname.js 的同一份）');
    console.log('  ✓ 没有 /noname.js 的第二份实例');

    // 首屏到底搬了多少字节（gzip 生效的证据，也是"手机能不能 10 秒内进去"的依据）
    const bytes = await page.eval(`
      const list = performance.getEntriesByType('resource');
      let raw = 0, wire = 0;
      for (const e of list) { raw += e.decodedBodySize || 0; wire += e.encodedBodySize || 0; }
      return { raw, wire, count: list.length };
    `);
    const mb = (n) => (n / 1048576).toFixed(2);
    console.log(`  · 首屏 ${bytes.count} 个请求：压前 ${mb(bytes.raw)} MB → 传输 ${mb(bytes.wire)} MB`);
    assert.ok(bytes.wire < bytes.raw * 0.6, `gzip 没生效？传输量 ${mb(bytes.wire)} MB 不该接近原始 ${mb(bytes.raw)} MB`);

    /* 「联机」里的地址必须**已经填好**，而且是当前页面的域名（不是写死的公网地址） */
    const entered = await page.eval(`
      const hit = [...document.querySelectorAll('div,span,button')]
        .filter(n => (n.textContent || '').trim() === '联机' && n.offsetParent !== null);
      if (!hit.length) return false;
      hit[hit.length - 1].click();
      return true;
    `);
    assert.ok(entered, '主菜单里应该有「联机」按钮');
    const findAddr = `const all = [...document.querySelectorAll('*')];
       const node = all.find(n => n.children.length === 0 && /^wss?:\\/\\/[^\\s]+\\/noname-online$/.test((n.textContent || '').trim()));
       return node ? node.textContent.trim() : ''`;
    await page.waitFor(`return Boolean((() => { ${findAddr} })())`, 15_000, '「联机」里的地址已经预填');
    const prefilled = await page.eval(findAddr);
    const expectProto = new URL(app.url).protocol === 'https:' ? 'wss://' : 'ws://';
    assert.ok(
      prefilled.startsWith(expectProto) && prefilled.includes('/noname-online'),
      `联机地址应该是 ${expectProto}<当前域名>/noname-online，实际 ${prefilled}`
    );
    console.log(`  ✓ 「联机」地址已预填：${prefilled}（当前域名现算，不写死）`);

    // 进了联机模式，无名杀才会把「选项 → 联机」那一套菜单建出来；
    // 桥接的 MutationObserver 会在它出现时补上「邀请平台好友」。
    await page.waitFor(
      `const cat = [...document.querySelectorAll('.menubutton.large')].find(n => n.mode === 'connect');
       return Boolean(cat && cat.link && cat.link.querySelector('.frp-noname-invite'));`,
      10_000,
      '「选项 → 联机」里出现「邀请平台好友」'
    );
    console.log('  ✓ 「邀请平台好友」入口在');

    /*
     * 悬浮球里的「退出」（这一步会**重载页面**，所以放最后）。
     * 上游只调 window.close()，而浏览器只允许关掉**脚本自己打开的**窗口 ——
     * 从平台首页点进来的是普通跳转，close() 被静默忽略，用户看着就是"按了没反应"。
     * 补丁的兜底是"关不掉就回主菜单"，所以这里钉：点完**页面真的重载了**。
     */
    const exitClicked = await page.eval(`
      window.__frpAlive = 1;
      const btn = [...document.querySelectorAll('#shortcut .menubutton.round')]
        .find(n => (n.textContent || '').trim() === '退出');
      if (!btn) return 'no-button';
      btn.click();
      return 'clicked';
    `);
    if (exitClicked === 'clicked') {
      await page.waitFor(`return window.__frpAlive === undefined`, 20_000, '点「退出」之后回到主菜单');
      console.log('  ✓ 悬浮球的「退出」有反应了（窗口关不掉时回主菜单）');
    } else {
      console.log('  · 这一轮没进到对局，跳过「退出」检查');
    }
  } finally {
    page.close();
  }
}

/* --------------------------------------------------- 3. 伪横屏外壳（手机竖屏） */

async function checkWrapper(app) {
  step('伪横屏外壳（手机竖屏 → 游戏内容横过来）');

  const { Page, findChrome } = await import(pathToFileURL(join(ROOT, 'tools', 'cdp.mjs')).href);
  if (!findChrome()) {
    console.log('  · 本机没有 Chrome/Edge，跳过');
    return;
  }
  const base = app.url.replace(/\/?$/, '/');

  // ① 手机：竖着拿，内容转 90°，游戏在 iframe 里正常启动
  const phone = await Page.launch({ headless: true, width: 390, height: 844, mobile: true });
  try {
    await loginBrowser(phone, app.url);
    // 真机有触摸点，CDP 要显式打开，否则 (pointer: coarse) / maxTouchPoints 都是 0
    await phone.conn.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await phone.goto(base + 'play/noname');
    await dismissFirstRunTutorial(
      phone,
      `document.getElementById('game') && document.getElementById('game').contentDocument`
    );
    await phone.waitFor(
      `const f = document.getElementById('game');
       const t = f && f.contentDocument ? f.contentDocument.body.innerText : '';
       return /身份/.test(t) && /联机/.test(t);`,
      30_000,
      '外壳里的无名杀进到主菜单'
    );
    const geo = await phone.eval(`
      const rot = document.getElementById('rot');
      const f = document.getElementById('game');
      return {
        transform: getComputedStyle(rot).transform,
        fw: parseFloat(f.style.width), fh: parseFloat(f.style.height),
        vw: innerWidth, vh: innerHeight,
        title: f.contentDocument.title,
      };
    `);
    assert.match(geo.transform, /matrix\(0, 1, -1, 0/, `竖屏时必须转 90°（实际 ${geo.transform}）`);
    assert.equal(geo.title, '无名杀', 'iframe 里就是游戏本体');
    // 转完之后：逻辑宽 = 屏高、逻辑高 = 屏宽
    assert.ok(Math.abs(geo.fw - geo.vh) < 2 && Math.abs(geo.fh - geo.vw) < 2,
      `iframe 的逻辑尺寸应该是 ${geo.vh}×${geo.vw}（横过来的这一屏），实际 ${geo.fw}×${geo.fh}`);
    assert.deepEqual(
      phone.errors.filter((e) => !/NotAllowedError: play\(\)/.test(e)),
      [],
      `伪横屏外壳里不该有报错：${phone.errors.join(' | ')}`
    );
    console.log(`  ✓ 竖屏 ${geo.vw}×${geo.vh} → 内容 ${geo.fw}×${geo.fh}，转到主菜单零错误`);
  } finally {
    phone.close();
  }

  // ② 电脑：直接回真页面，地址栏干净
  const desktop = await Page.launch({ headless: true, width: 1200, height: 800 });
  try {
    await loginBrowser(desktop, app.url);
    await desktop.goto(base + 'play/noname');
    await desktop.waitFor(`return location.pathname === '/noname/'`, 15_000, '电脑上跳回 /noname/');
    const fine = await desktop.eval(`return { coarse: matchMedia('(pointer: coarse)').matches }`);
    assert.equal(fine.coarse, false, '电脑上不该被当成手机');
    console.log('  ✓ 电脑上自动跳回 /noname/（不套 iframe）');
  } finally {
    desktop.close();
  }
}

/* ----------------------------------------------------------------------- 入口 */

preflight();

const tmpData = mkdtempSync(join(tmpdir(), 'frp-noname-'));
// 写接口落到临时目录，跑完就删 —— 体检绝不能碰真实存档/扩展
process.env.FRP_NONAME_DATA = tmpData;

const { startServer } = await import(pathToFileURL(join(ROOT, 'server', 'server.mjs')).href);
const relayPort = await freePort();
const app = await startServer({
  port: 0,
  dbPath: join(tmpData, 'check.db'),
  statePath: join(tmpData, 'server.json'),
  // 联机中继要真监听一个端口（体检用随机端口，别和线上 8082 抢）
  nonameRelay: true,
  nonameRelayPort: relayPort,
});

let failed = false;
try {
  await checkHttp(app);
  await checkRelay(app);
  await checkInBrowser(app);
  await checkWrapper(app);
} catch (err) {
  failed = true;
  console.error(`\n✗ ${err.message}`);
} finally {
  await app.close?.().catch(() => {});
  rmSync(tmpData, { recursive: true, force: true });
  // startServer 自己会 process.exit？没有的话这里已经断开监听
  process.exit(failed ? 1 : 0);
}