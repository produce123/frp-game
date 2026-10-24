/*
 * 把无名杀（<https://github.com/libnoname/noname>）更新到上游最新，并重建 `games/noname-web/dist`。
 *
 * `node tools/noname-update.mjs`        完整更新：下载 → 解包 → 覆盖源码 → 打补丁 → pnpm build
 * `node tools/noname-update.mjs --check` 只看上游现在是什么版本（不下载、不动本地文件）
 *
 * 为什么不是 `git pull`：本机的 github.com:443 不可靠（clone 一半会 `Connection reset`），
 * 而 `codeload.github.com` 的 zip 稳定。所以走"整包覆盖"这条路。
 *
 * ⚠️ **`apps/core` 里有两个文件被我们改过**（原因见 `docs/GAMES.md` 的《无名杀 Web》）。
 * 每次覆盖源码之后必须重新打补丁，否则：import map 变回站根绝对地址 →
 * `lib` / `game` 各两份 → 武将包一加载就白屏。补丁锚点找不到时**它会让整个更新失败**，
 * 而不是悄悄产出一个坏 dist。
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'games', 'noname-web');
const WORK = join(ROOT, '.tmp-noname', 'update');
const ZIP = join(WORK, 'noname-main.zip');
const ZIP_URL = 'https://codeload.github.com/libnoname/noname/zip/refs/heads/main';
const API_URL = 'https://api.github.com/repos/libnoname/noname/commits/main';

const say = (msg) => console.log(msg);

async function pnpm(args, cwd = DEST) {
  say(`\n$ pnpm ${args.join(' ')}`);
  const r = spawnSync('pnpm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`pnpm ${args.join(' ')} 失败（退出码 ${r.status}）`);
}

/* --------------------------------------------------------------- 上游是什么版本 */

async function upstreamInfo() {
  const commit = await fetch(API_URL, { headers: { 'user-agent': 'frp-game', accept: 'application/vnd.github+json' } }).then((r) =>
    r.ok ? r.json() : null
  );
  // ⚠️ 版本号在 apps/core/package.json（workspace 根的 package.json 是 1.0.0 的工具壳）
  const local = JSON.parse(readFileSync(join(DEST, 'apps', 'core', 'package.json'), 'utf8')).version;
  const infoPath = join(DEST, 'dist', 'game', 'build-info.json');
  const built = existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, 'utf8')) : null;
  return { local, built, commit };
}

/* ------------------------------------------------------------------- 下载解包 */

async function download() {
  mkdirSync(WORK, { recursive: true });
  say(`\n▶ 下载 ${ZIP_URL}`);
  const res = await fetch(ZIP_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const chunks = [];
  let got = 0;
  let last = Date.now();
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (Date.now() - last > 5000) {
      last = Date.now();
      say(`  ${(got / 1048576).toFixed(0)} MB${total ? ` / ${(total / 1048576).toFixed(0)} MB` : ''}`);
    }
  }
  const buf = Buffer.concat(chunks);
  writeFileSync(ZIP, buf);
  say(`  ✓ ${(buf.length / 1048576).toFixed(1)} MB`);
  if (buf.length < 100 * 1024 * 1024) throw new Error('包太小了，八成没下全 —— 不动本地文件');

  // Windows 自带的 tar 就是 bsdtar，能直接解 zip（不引入第三方依赖）
  const src = join(WORK, 'noname-main');
  rmSync(src, { recursive: true, force: true });
  say('▶ 解包');
  const r = spawnSync('tar', ['-xf', ZIP, '-C', WORK], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`解包失败（退出码 ${r.status}）`);
  if (!existsSync(join(src, 'package.json'))) throw new Error('解包出来的目录里没有 package.json，包结构变了？');
  return src;
}

/* ------------------------------------------------------------------ 覆盖源码 */

function copySource(src) {
  say('\n▶ 覆盖源码（保留 node_modules / dist）');
  const KEEP = new Set(['node_modules', 'dist']);
  let copied = 0;
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (KEEP.has(entry.name)) continue;
    const from = join(src, entry.name);
    const to = join(DEST, entry.name);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    copied++;
  }
  say(`  ✓ 覆盖了 ${copied} 项`);
}

/* -------------------------------------------------------------------- 打补丁 */

function patchFile(relPath, edits) {
  const full = join(DEST, relPath);
  let text = readFileSync(full, 'utf8');
  for (const [find, replace, why] of edits) {
    const count = text.split(find).length - 1;
    if (count !== 1) {
      throw new Error(
        `补丁打不上了：${relPath} 里找不到（或找到 ${count} 处）这段代码：\n  ${find}\n` +
          `这段补丁的作用是：${why}\n` +
          '上游大概是重构了这个文件 —— 请按 docs/GAMES.md《无名杀 Web》里写的三条原则自己改一遍，再更新补丁脚本。'
      );
    }
    text = text.replace(find, replace);
  }
  writeFileSync(full, text);
  say(`  ✓ ${relPath}`);
}

/*
 * 三条补丁，每一处都对应一个"只有托管在子路径下才会犯"的错。别删。
 */
function applyPatches() {
  say('\n▶ 打补丁（无名杀原本假定自己部署在网站根目录）');

  // ① 动态加载卡牌/武将/模式/扩展：/card/x.js 这种根绝对路径 → 相对文档拼
  patchFile('apps/core/noname/init/import.ts', [
    [
      'import { lib, game, _status } from "noname";',
      'import { lib, game, _status } from "noname";\n\n' +
        '/* 【frp-game 补丁】无名杀托管在 /noname/ 下，而它按"部署在网站根目录"写死了\n' +
        ' * /card/xxx.js、/character/xxx.js、/mode/xxx.js 这类根绝对路径。\n' +
        ' * 根绝对路径会绕过 /noname/ 前缀 → 要么 404，要么同一模块出现两份实例\n' +
        ' * （lib/game 各一套，于是 lib.config.characters 为 undefined，武将包一加载就崩）。\n' +
        ' * 改成相对文档：站根部署时行为不变，子路径部署时自动带上前缀。 */\n' +
        'const appBase = () => document.baseURI;',
      '给"相对文档"的基址函数找落点',
    ],
    [
      'await importFunction("card", `/card/${name}`);',
      'await importFunction("card", new URL(`card/${name}`, appBase()).href);',
      '卡牌包从 /card/xxx.js 改成相对文档',
    ],
    [
      'const path = import.meta.env.DEV ? `/character/${name}/index` : `/character/${name}`;',
      'const suffix = import.meta.env.DEV ? "/index" : "";\n\tconst path = new URL(`character/${name}${suffix}`, appBase()).href;',
      '武将包从 /character/xxx.js 改成相对文档',
    ],
    [
      'await importFunction("extension", `/extension/${name}/extension`);',
      'await importFunction("extension", new URL(`extension/${name}/extension`, appBase()).href);',
      '扩展从 /extension/xxx/extension.js 改成相对文档',
    ],
    [
      'const path = alreadyModernMode.includes(name) && import.meta.env.DEV ? `/mode/${name}/index` : `/mode/${name}`;',
      'const suffix = alreadyModernMode.includes(name) && import.meta.env.DEV ? "/index" : "";\n\tconst path = new URL(`mode/${name}${suffix}`, appBase()).href;',
      '游戏模式从 /mode/xxx.js 改成相对文档',
    ],
  ]);

  // ② 生成 game/game.js 的那个插件：import map / 入口脚本 / ts 探针
  const importmap = 'apps/core/scripts/vite-plugin-importmap.ts';
  patchFile(importmap, [
    [
      'const require = createRequire(import.meta.url);',
      'const require = createRequire(import.meta.url);\n\n' +
        '/**\n' +
        ' * 【frp-game 补丁】import map 里的地址要写成**相对页面**（./xxx）。\n' +
        ' *\n' +
        ' * 原来产出的是 /noname.js、/node_modules/.pnpm/... 这种根绝对地址。站根部署没问题，\n' +
        ' * 但我们托管在 https://host/noname/ 下 —— index.html 用的是 ./noname.js\n' +
        ' * （→ /noname/noname.js），而 import map 把 noname 这个 specifier 指向 /noname.js\n' +
        ' * （→ 站根，另一份文件）。浏览器按 URL 区分模块，于是 lib / game 各有两份，\n' +
        ' * 武将包加载时 lib.config.characters 是 undefined，整页白屏。\n' +
        ' * 相对地址由浏览器按文档基址解析：两种部署都对。\n' +
        ' */\n' +
        'function toRelativeUrl(resolved: string, root: string): string {\n' +
        '\tconst posix = normalizePath(resolved);\n' +
        '\tconst rel = normalizePath(path.relative(root, posix));\n' +
        '\tif (!rel.startsWith("..")) return `./${rel}`;\n' +
        '\tconst marker = posix.lastIndexOf("/node_modules/");\n' +
        '\tif (marker >= 0) return `./${posix.slice(marker + 1)}`;\n' +
        '\treturn `./${rel.replace(/^(?:\\.\\.\\/)+/, "")}`;\n' +
        '}',
      '插入"把依赖地址写成 dist 内相对路径"的函数',
    ],
    [
      'resolvedImportMap[key] = normalizePath("/" + path.relative(root, resolved));',
      'resolvedImportMap[key] = toRelativeUrl(resolved, root);',
      'import map 的解析结果从站根绝对路径改成相对路径',
    ],
    [
      'resolvedImportMap[key] = importMap[key];',
      'resolvedImportMap[key] = importMap[key].startsWith("/") ? `.${importMap[key]}` : importMap[key];',
      '解析不了的 specifier（noname）也要相对化',
    ],
    [
      'const path = "/jit-test.ts";',
      'const path = "./jit-test.ts";',
      'Service Worker 的 TypeScript 探针改到 /noname/ 下（也在 SW 的 scope 里）',
    ],
    [
      'script.src = "/noname/entry.js";',
      'script.src = "./noname/entry.js";',
      '入口脚本和 index.html 用同一个 URL，否则 entry.js 跑两遍、整个 boot 跑两遍',
    ],
  ]);

  /*
   * ③ 联机：把默认的"联机地址"预填成**我们自己的中继**。
   * 上游默认 hallURL 是空串，玩家得手打一串 wss:// 地址 —— 朋友不可能打得对。
   * 用 location 现算，所以不写死公网域名（隧道地址由用户面板决定）。
   */
  patchFile('apps/core/noname/library/index.js', [
    [
      '\thallURL = "";',
      '\thallURL =\n' +
        '\t\t/* 【frp-game 补丁】上游默认没有大厅地址，玩家要手打联机地址。\n' +
        '\t\t * 我们把自建中继挂在同一个域名的 /noname-online 上（见 server/noname.mjs），\n' +
        '\t\t * 所以这里按当前页面现算：https → wss，http → ws。站根部署 / 子路径部署都对，\n' +
        '\t\t * 也不写死任何公网地址。 */\n' +
        '\t\ttypeof location === "object" && location.host\n' +
        '\t\t\t? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/noname-online`\n' +
        '\t\t\t: "";',
      '联机地址默认值（hallURL）按当前页面算',
    ],
  ]);

  /*
   * ④ 载入超时：上游默认 10 秒。手机 + 隧道 + 几百个模块，10 秒太紧 ——
   * 超时就会弹「游戏似乎未正常载入，是否重置游戏？」，用户以为游戏坏了。
   * 压缩之后正常 2~3 秒就进得去，这里把兜底放宽到 30 秒，只是别误报。
   */
  patchFile('apps/core/noname/init/index.ts', [
    [
      'parseInt(localStorage.getItem(lib.configprefix + "loadtime") || "10000")',
      'parseInt(localStorage.getItem(lib.configprefix + "loadtime") || "30000")',
      '载入超时的默认值 10 秒 → 30 秒（手机/隧道留余量）',
    ],
  ]);

  /*
   * ⑤ 联机中继（`packages/server`）：上游没给连接挂 error 监听，
   * 一个不合规的帧就能让 ws 抛未处理异常、把**整个进程**带走。
   * 我们和平台共用进程，所以必须兜住；顺带 server 级也挂一个常驻监听。
   */
  patchFile('packages/server/src/types.ts', [
    [
      'export interface ServerOptions {\n\tport?: number;\n}',
      'export interface ServerOptions {\n\tport?: number;\n\t/** 【frp-game 补丁】只监听某个地址。不传 = 上游行为（所有网卡）。 */\n\thost?: string;\n}',
      'ServerOptions 增加 host（中继只该监听回环地址）',
    ],
  ]);

  patchFile('packages/server/src/server/createServer.ts', [
    [
      '\tconst port = options.port ?? 8082;',
      '\tconst port = options.port ?? 8082;\n' +
        '\t/* 【frp-game 补丁】允许只监听回环地址。上游默认绑 0.0.0.0 —— 我们用 7891 的\n' +
        '\t * `/noname-online` 转发，中继没有任何理由在局域网上再开一个口。 */\n' +
        '\tconst host = options.host;',
      'createServer 支持 host',
    ],
    [
      '\t\tclient.wsid = util.newId();\n\t\tclient.clientIp = ip;\n\t\tclients.set(client.wsid, client);',
      '\t\tclient.wsid = util.newId();\n' +
        '\t\tclient.clientIp = ip;\n' +
        '\t\tclients.set(client.wsid, client);\n\n' +
        '\t\t/* 【frp-game 补丁】上游没给每条连接挂 error 监听。ws 遇到协议错误（例如\n' +
        '\t\t * 一个 close 帧里写着非法的 status code 0）会 emit("error") —— 没人听就是\n' +
        '\t\t * 未处理异常，把**整个进程**带走。我们和平台共用同一个进程，所以必须兜住：\n' +
        '\t\t * 一条坏连接只断它自己。 */\n' +
        '\t\tclient.on("error", () => {\n' +
        '\t\t\ttry {\n' +
        '\t\t\t\tclient.terminate();\n' +
        '\t\t\t} catch {\n' +
        '\t\t\t\t/* 已经断了 */\n' +
        '\t\t\t}\n' +
        '\t\t});',
      '每条连接挂 error 监听（否则一个坏帧能带走进程）',
    ],
    [
      '\t\t\t\tconst server = new WebSocketServer({ port });',
      '\t\t\t\tconst server = new WebSocketServer(host ? { port, host } : { port });\n' +
        '\t\t\t\t/* 【frp-game 补丁】同上：listen 之后 start() 会摘掉自己的错误监听，\n' +
        '\t\t\t\t * 之后任何 server 级错误都会变成未处理异常。挂一个常驻的空监听。 */\n' +
        '\t\t\t\tserver.on("error", () => { /* 交给下面的 reject / 日志，不让进程崩 */ });',
      'WebSocketServer 挂常驻 error 监听 + 允许只绑回环地址',
    ],
  ]);

  /*
   * ⑥ 浏览器端的「退出」：上游 `game.exit()` 只调 `window.close()`，
   * 而浏览器**只允许脚本关掉自己 window.open 出来的窗口**。我们是从平台首页/
   * 手机外壳点进来的（普通跳转，甚至是 iframe），close() 被静默忽略 ——
   * 用户点悬浮球里的「退出」像没反应。补一个"关不掉就回主菜单"的兜底。
   */
  patchFile('apps/core/noname/init/browser.js', [
    [
      '\tgame.exit = function () {\n\t\twindow.onbeforeunload = null;\n\t\twindow.close();\n\t};',
      '\tgame.exit = function () {\n' +
        '\t\twindow.onbeforeunload = null;\n' +
        '\t\twindow.close();\n' +
        '\t\t/* 【frp-game 补丁】浏览器只允许脚本关掉**自己 window.open 出来的**窗口。\n' +
        '\t\t * 我们是从平台首页 / 手机外壳点进来的（普通跳转，甚至是 iframe），\n' +
        '\t\t * window.close() 会被**静默忽略** —— 用户点了悬浮球里的「退出」像没反应。\n' +
        '\t\t * 关不掉就退而求其次：回游戏主菜单（`/noname/`）。 */\n' +
        '\t\tsetTimeout(function () {\n' +
        '\t\t\tif (window.closed) return;\n' +
        '\t\t\ttry {\n' +
        '\t\t\t\twindow.location.href = new URL("./", document.baseURI).href;\n' +
        '\t\t\t} catch (e) {\n' +
        '\t\t\t\t/* 连跳转都被拦（极少数浏览器策略），那就真没辙了 */\n' +
        '\t\t\t}\n' +
        '\t\t}, 100);\n' +
        '\t};',
      '「退出」关不掉窗口时回主菜单',
    ],
  ]);
}

/* ---------------------------------------------------------------------- 构建 */

function build() {
  say('\n▶ 构建（几分钟，产物 ~1.3 GB）');
  const oldDist = join(DEST, 'dist.old');
  rmSync(oldDist, { recursive: true, force: true });
  if (existsSync(join(DEST, 'dist'))) renameSync(join(DEST, 'dist'), oldDist);

  const r = spawnSync('pnpm', ['build'], { cwd: DEST, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    say('\n✗ 构建失败，把旧产物放回去');
    rmSync(join(DEST, 'dist'), { recursive: true, force: true });
    if (existsSync(oldDist)) renameSync(oldDist, join(DEST, 'dist'));
    throw new Error(`pnpm build 失败（退出码 ${r.status}）`);
  }
  rmSync(oldDist, { recursive: true, force: true });
  const size = dirSize(join(DEST, 'dist'));
  say(`  ✓ dist 重建完成（${(size / 1073741824).toFixed(2)} GB）`);

  // 联机中继是**另一个包**（@noname/server），pnpm build 不包含它 —— 单独构建
  say('  · 构建联机中继（@noname/server）');
  const relay = spawnSync('pnpm -F @noname/server build', {
    cwd: DEST,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (relay.status !== 0) throw new Error(`@noname/server 构建失败（退出码 ${relay.status}）`);
  say('  ✓ 联机中继构建完成');
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

/* ---------------------------------------------------------------------- 入口 */

const checkOnly = process.argv.includes('--check');

const before = await upstreamInfo();
say(`本机源码版本：${before.local}`);
say(
  `本机打包产物：${
    before.built ? `${before.built.channel} / 上游提交 ${String(before.built.commit).slice(0, 8)} / builtAt ${before.built.builtAt}` : '（没有 dist）'
  }`
);
say(
  `上游 main：${
    before.commit
      ? `${before.commit.sha.slice(0, 8)} (${before.commit.commit.committer.date}) ${before.commit.commit.message.split('\n')[0]}`
      : '查询失败（网络？）'
  }`
);

if (checkOnly) {
  // 别用 process.exit：Node 24 的 fetch 还挂着 keep-alive 连接时会报 libuv 断言
  process.exitCode = 0;
} else {
  try {
    const src = await download();
    copySource(src);
    applyPatches();
    await pnpm(['install', '--ignore-scripts']);
    build();

    say('\n✅ 更新完成。接下来请：');
    say('   1) node tools/check-noname.mjs            体检（零错误 + 主菜单出现 + 模块只有一份）');
    say('   2) node tools/service.mjs restart         让线上指向新产物');
    say('   3) 浏览器打开 http://127.0.0.1:7891/noname/ 自己点一局');
  } catch (err) {
    say(`\n✗ 更新失败：${err.message}`);
    say('  本地文件可能已被覆盖（源码是新版、dist 还是旧的），修好之后重跑本脚本即可。');
    process.exitCode = 1;
  }
}