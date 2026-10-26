#!/usr/bin/env node
/*
 * 服务器开关 —— 给"一键开启 / 一键关闭"用的。
 *
 *   node tools/service.mjs status              看现在开着没
 *   node tools/service.mjs start               后台开起来（不占窗口）
 *   node tools/service.mjs stop                关掉
 *   node tools/service.mjs restart             重启
 *   node tools/service.mjs autostart-install   装开机自启（登录时悄悄启动）
 *   node tools/service.mjs autostart-remove    卸掉开机自启
 *   node tools/service.mjs autostart-status    看开机自启装没装
 *
 * 根目录下的 start.cmd / stop.cmd / status.cmd 就是这些命令的快捷方式，
 * 双击即可，不用敲命令。
 *
 * 【为什么要有它】
 * 用户不是程序员，而且这台机器还要跑别的工作。服务端常驻会**一直占着 7891 端口**，
 * 所以需要一个明确的"关掉"，关掉之后不许自己偷偷再起来。
 * ⚠️ 所以开机自启是"**登录时启动一次**"（schtasks /SC ONLOGON），
 * 不是"守护进程看到挂了就拉起来"。手动关掉之后，它会一直保持关闭，
 * 直到下次登录 —— 这是刻意的，别改成看门狗。
 *
 * 【它怎么知道服务是自己人】
 * 只看端口通不通是不够的（别的程序也可能占 7891）。这里会请求
 * http://127.0.0.1:7891/api/me，期望拿到 401 + JSON —— 那是本服务端
 * 未登录时的固定回答。对不上就说明 7891 上待着的不是我们的服务。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server', 'server.mjs');
const STATE_PATH = join(ROOT, 'data', 'server.json');
const LOG_PATH = join(ROOT, 'data', 'server.log');
const HOST = '127.0.0.1';
const PORT = 7891;                        // 和 SakuraFrp 隧道成对，改这里必须同时改隧道
const BASE = `http://${HOST}:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 探活 */

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** 端口上待着的是不是我们的服务。返回 {up, detail}。 */
async function probe() {
  try {
    /*
     * ⚠️ 用 node:http 而不是 fetch：全局 fetch（undici）在**退出时**留着 keep-alive
     * 连接的 async 句柄，Windows + Node 24 上 `process.exit()` 会顺手打一行
     * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 并把退出码变成 1 ——
     * 于是 `service.mjs start` 明明成功了，脚本/批处理却认为它失败。
     */
    const { status, text } = await new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: PORT, path: '/api/me', method: 'GET', timeout: 2500, headers: { connection: 'close' } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, text: body }));
        }
      );
      req.on('timeout', () => { req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })); });
      req.on('error', reject);
      req.end();
    });
    let json = null;
    try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    if (status === 401 && json && json.ok === false) {
      return { up: true, ours: true, detail: `HTTP 401（未登录）—— 是我们的服务` };
    }
    return { up: true, ours: false, detail: `HTTP ${status}，回答不是本服务的格式` };
  } catch (err) {
    const code = err.code || (err.cause && err.cause.code) || err.name || '未知错误';
    const readable = {
      ECONNREFUSED: '连接被拒绝 —— 7891 上没人监听，服务没开',
      ECONNRESET: '连接被重置',
      ETIMEDOUT: '连接超时',
      AbortError: '请求超时（端口可能被防火墙挡着）',
      TimeoutError: '请求超时（端口可能被防火墙挡着）',
    }[code] || code;
    return { up: false, ours: false, detail: readable };
  }
}

/*
 * 日志轮转（**只保留上一份**）。
 *
 * 为什么要有：每个请求都会写一行 `[来访]`，实测一个多月就到 12 MB，而且没有上限 ——
 * 迟早把盘写满。轮转放在 start 里（服务本来就要重启），不额外加定时器：
 * 超过 20 MB 就改名成 server.log.1，更老的 `.1` 直接删掉（想看更早的日志本来就没意义）。
 */
const LOG_MAX_BYTES = 20 * 1024 * 1024;

function rotateLog() {
  try {
    if (!existsSync(LOG_PATH)) return;
    if (statSync(LOG_PATH).size < LOG_MAX_BYTES) return;
    const old = LOG_PATH + '.1';
    try { rmSync(old, { force: true }); } catch { /* 删不掉就算了，下面 rename 会失败但不影响启动 */ }
    renameSync(LOG_PATH, old);
    console.log(`日志超过 ${Math.round(LOG_MAX_BYTES / 1024 / 1024)} MB，已改名为 ${old}`);
  } catch { /* 轮转失败不该拦住启动 */ }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 从 netstat 里找出占着 7891 的进程号（没法确定是本服务，只用来兜底）。 */
function pidOnPort() {
  try {
    const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout || '';
    for (const line of out.split('\n')) {
      if (!line.includes(`:${PORT}`)) continue;
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const pid = Number(cols[cols.length - 1]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch { /* 忽略 */ }
  return null;
}

/* ------------------------------------------------------------------ 命令 */

async function cmdStatus() {
  const state = readState();
  const p = await probe();

  console.log(`服务端地址：${BASE}`);
  console.log(`端口状态  ：${p.up ? '通' : '不通'}（${p.detail}）`);

  if (!p.up) {
    console.log('结论      ：⛔ 没在跑');
    if (state) console.log(`（上次记录的进程号 ${state.pid}，现在${pidAlive(state.pid) ? '还活着但端口不通' : '已经没了'}）`);
    return 0;
  }
  if (!p.ours) {
    console.log('结论      ：⚠️ 7891 被别的程序占了，不是我们的服务');
    return 2;
  }

  const pid = state && pidAlive(state.pid) ? state.pid : pidOnPort();
  console.log(`进程号    ：${pid || '未知'}`);
  if (state && state.startedAt) console.log(`启动时间  ：${new Date(state.startedAt).toLocaleString()}`);
  console.log('结论      ：✅ 正在运行');
  return 0;
}

async function cmdStart() {
  const p = await probe();
  if (p.up && p.ours) {
    console.log('✅ 已经在跑了，不用重复开');
    return 0;
  }
  if (p.up && !p.ours) {
    console.error(`❌ 7891 被别的程序占着（${p.detail}），换不了。先关掉那个程序。`);
    return 1;
  }

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  rotateLog();   // 日志太大先改名，见 LOG_MAX_BYTES

  // detached + unref + stdio ignore：这个进程要活过当前窗口，
  // 双击 start.cmd 之后窗口关掉服务不能跟着死。
  const log = openSync(LOG_PATH, 'a');
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  child.unref();

  // 等它真的起来（最多 15 秒）
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(300);
    const now = await probe();
    if (now.up && now.ours) {
      console.log(`✅ 服务端起来了：${BASE}（进程号 ${child.pid}）`);
      console.log(`   日志：${LOG_PATH}`);
      console.log('   （关掉它请用 stop.cmd）');
      return 0;
    }
  }
  console.error('❌ 15 秒了还没起来。最后 20 行日志：');
  try {
    const logText = readFileSync(LOG_PATH, 'utf8').split('\n');
    console.error(logText.slice(-21).join('\n'));
  } catch { /* 没日志 */ }
  return 1;
}

async function cmdStop() {
  const state = readState();
  const p = await probe();

  if (!p.up) {
    console.log('⛔ 本来就没在跑');
    // 顺手清掉可能残留的记录
    try { rmSync(STATE_PATH, { force: true }); } catch { /* 忽略 */ }
    return 0;
  }
  if (!p.ours) {
    console.error(`⚠️ 7891 上待着的不是我们的服务（${p.detail}），不敢乱杀。请你手动处理。`);
    return 2;
  }

  const pid = state && pidAlive(state.pid) ? state.pid : pidOnPort();
  if (!pid) {
    console.error('❌ 端口是通的，但找不到进程号。试试 taskkill /F /IM node.exe（会杀掉本机所有 node）。');
    return 1;
  }

  try {
    process.kill(pid);
  } catch (err) {
    console.error(`❌ 关不掉进程 ${pid}：${err.message}`);
    return 1;
  }

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    await sleep(250);
    const now = await probe();
    if (!now.up) {
      console.log(`✅ 已经关掉了（进程 ${pid} 已退出，7891 空出来了）`);
      try { rmSync(STATE_PATH, { force: true }); } catch { /* 忽略 */ }
      return 0;
    }
  }
  console.error(`❌ 进程 ${pid} 还占着 7891，没退干净。`);
  return 1;
}

async function cmdRestart() {
  const stopped = await cmdStop();
  if (stopped !== 0) return stopped;
  await sleep(500);
  return cmdStart();
}

/* ------------------------------------------------------------------ 开机自启 */

/*
 * 开机自启用**当前用户的 Run 注册表键**，两条路都试过了，只有这条能走通：
 *
 *   ❌ schtasks /Create /SC ONLOGON  → 系统回"拒绝访问"，建计划任务要管理员
 *   ❌ 启动文件夹放 .vbs            → 系统拒绝写 .vbs（同一文件夹写 .txt 却可以，
 *                                      是安全策略在拦脚本文件），换 .cmd 会闪黑窗
 *   ✅ HKCU\...\CurrentVersion\Run  → 不需要管理员，实测写入成功，
 *                                      而且在**任务管理器的"启动"页能看见**，
 *                                      用户自己就能关掉，不用记任何命令
 *
 * ⚠️ 自启是"登录时启动一次"，**不是看门狗**。手动 stop 之后它会一直保持关闭，
 * 直到下次登录 —— 这是刻意的（这台机器还要跑别的活，不能被一直占着 7891）。
 */

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_NAME = 'frp-game';

function regValue() {
  return `wscript.exe "${join(ROOT, 'tools', 'run-hidden.vbs')}"`;
}

function runReg(args) {
  return spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
}

function cmdAutostartInstall() {
  const vbs = join(ROOT, 'tools', 'run-hidden.vbs');
  if (!existsSync(vbs)) {
    console.error(`❌ 找不到 ${vbs}，项目文件可能不完整`);
    return 1;
  }

  const value = regValue();
  const r = runReg(['add', REG_KEY, '/v', REG_NAME, '/t', 'REG_SZ', '/d', value, '/f']);
  if (r.status !== 0) {
    console.error('❌ 装开机自启失败：');
    console.error(r.stdout || r.stderr || `退出码 ${r.status}`);
    return 1;
  }

  console.log('✅ 装好了：下次登录 Windows 会自动把服务悄悄开起来（不弹窗口）');
  console.log(`   登记在：${REG_KEY}\\${REG_NAME}`);
  console.log(`   内容是：${value}`);
  console.log('');
  console.log('   想确认的话：Ctrl+Shift+Esc 打开任务管理器 → "启动"页 →');
  console.log('   应该能看到一条叫 frp-game 的，在那里也能直接禁用它。');
  console.log('');
  console.log('⚠️ 它只在**登录时**启动一次，不是看门狗。你手动 stop 之后，');
  console.log('   它会一直保持关闭，直到下次登录 —— 所以不会跟你跑别的活抢 7891。');
  console.log('想立刻验证这条路通不通：双击 tools\\run-hidden.vbs，');
  console.log('   然后双击 status.cmd，应该看到"正在运行"。');
  return 0;
}

function cmdAutostartRemove() {
  const r = runReg(['delete', REG_KEY, '/v', REG_NAME, '/f']);
  if (r.status !== 0) {
    console.log('（注册表里没有这一条，本来就没装）');
    return 0;
  }
  console.log('✅ 已卸掉开机自启，以后登录不会再自动起服务。');
  console.log('   （如果之前也在启动文件夹里放过东西，可以按 Win+R 输入 shell:startup 看一眼）');
  return 0;
}

function cmdAutostartStatus() {
  const r = runReg(['query', REG_KEY, '/v', REG_NAME]);
  console.log(`注册表位置：${REG_KEY}\\${REG_NAME}`);
  if (r.status === 0 && /frp-game/i.test(r.stdout || '')) {
    console.log(`当前内容  ：${regValue()}`);
    console.log('开机自启  ：✅ 已装');
    console.log('（任务管理器 → 启动 页里也能看到并禁用它）');
  } else {
    console.log('开机自启  ：⛔ 没装（双击 install-autostart.cmd 可以装，不需要管理员）');
  }
  return 0;
}

/* ------------------------------------------------------------------ 入口 */

const COMMANDS = {
  status: cmdStatus,
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  'autostart-install': cmdAutostartInstall,
  'autostart-remove': cmdAutostartRemove,
  'autostart-status': cmdAutostartStatus,
};

const command = process.argv[2];

if (!command || !COMMANDS[command]) {
  console.log(`用法：node tools/service.mjs <命令>

  start               后台开启服务端（不占窗口）
  stop                关闭服务端（关掉后不会自己起来）
  restart             重启
  status              看现在跑没跑
  autostart-install   装开机自启（登录时悄悄启动）
  autostart-remove    卸掉开机自启
  autostart-status    看开机自启装没装

根目录下的 start.cmd / stop.cmd / status.cmd 是这些命令的快捷方式。`);
  process.exit(command ? 1 : 0);
}

process.exit(await COMMANDS[command]());