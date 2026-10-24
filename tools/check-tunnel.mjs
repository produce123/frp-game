#!/usr/bin/env node
/*
 * 公网通道体检 —— 一条命令回答"隧道现在通了没有"。
 *
 *   node tools/check-tunnel.mjs 127.0.0.1:7891                  体检本机（正对照）
 *   node tools/check-tunnel.mjs <公网地址>               体检公网隧道（明文 HTTP）
 *   node tools/check-tunnel.mjs https://<公网地址>       开了自动 HTTPS 之后这样写
 *   node tools/check-tunnel.mjs https://<公网地址> --ws 30   再连打 30 次握手
 *
 * 【为什么要有它】
 * `docs/TUNNEL.md` 第二节的三步排查法一直是手敲 curl + 翻日志，容易漏一步，
 * 而且"节点回了它自己的错误页"和"本机一条来访都没有"经常被混在一起看。
 * 这里把三步合成一条，并把判据钉死：
 *
 *   1) 本机 `127.0.0.1:7891/api/me` 必须回 **401 + 我们自己的 JSON**
 *      （只看端口通不通不够，别的程序也可能占 7891，见 tools/service.mjs 的注释）
 *   2) 公网地址 GET `/`：状态码、`<title>`、TCP 连接耗时、整趟耗时；
 *      走 https 时**顺便把对端证书读出来**（受不受信任），回答"访客会不会看到红警告"
 *   3) ⭐ **唯一硬证据**：`data/server.log` 里必须**新增**一条
 *      `[来访] ... host=<公网主机:端口>` —— 面板/启动器显示"在线"不算证据
 *      （`docs/TUNNEL.md` 第 82 行就是这么写的，为此误判过一次）
 *   4) `--ws N`：连打 N 次 WebSocket 握手，统计"9 秒没人应答"的次数 ——
 *      我们关心的是那条"公网新建连接约 12% 卡满 60 秒"的老毛病还在不在
 *      （判据与 `shared/net/net.js` 的建连超时同一个数）
 *
 * 只读：不启动/不停止服务、不碰 SakuraFrp 隧道、不写 data/。
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_PATH = join(ROOT, 'data', 'server.log');
const LOCAL = { host: '127.0.0.1', port: 7891, base: 'http://127.0.0.1:7891' };
const HANDSHAKE_TIMEOUT_MS = 9000;   // 和 shared/net/net.js 的建连超时同一个数
const HTTP_TIMEOUT_MS = 12000;

/* ------------------------------------------------------------------ 参数 */

let target = null;
let wsCount = 0;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--ws') { wsCount = Number(argv[i + 1]) || 0; i += 1; continue; }
  if (!argv[i].startsWith('--')) target = argv[i];
}
if (!target) {
  console.error('用法: node tools/check-tunnel.mjs <[https://]主机:端口> [--ws 次数]');
  console.error('  例: node tools/check-tunnel.mjs 127.0.0.1:7891');
  console.error('  例: node tools/check-tunnel.mjs https://<公网地址> --ws 30');
  process.exit(2);
}

/* 目标可以带协议头。国内 TCP 隧道开了"自动 HTTPS"之后，访客地址就是 https:// 开头的。 */
let scheme = 'http';
let rest = target;
if (/^https:\/\//i.test(rest)) { scheme = 'https'; rest = rest.slice(8); }
else if (/^http:\/\//i.test(rest)) { rest = rest.slice(7); }
rest = rest.split('/')[0];
const [host, portText] = rest.split(':');
const isDefaultPort = (scheme === 'http' && (!portText || Number(portText) === 80))
  || (scheme === 'https' && (!portText || Number(portText) === 443));
const port = Number(portText) || (scheme === 'https' ? 443 : 80);
const hostHeader = isDefaultPort ? host : `${host}:${port}`;   // 日志里 host= 就是长这样
const base = `${scheme}://${hostHeader}`;

/* ------------------------------------------------------------------ 工具 */

const logSize = () => { try { return readFileSync(LOG_PATH).length; } catch { return 0; } };
const logTailSince = (from) => {
  try { return readFileSync(LOG_PATH).subarray(from).toString('utf8'); } catch { return ''; }
};

const titleOf = (html) => {
  const m = /<title>([^<]*)<\/title>/i.exec(html || '');
  return m ? m[1].trim() : '(没有 title)';
};

/**
 * 把 HTML 压成纯文本再判断。
 *
 * ⚠️ 这里踩过一次：一开始直接在原始 HTML 上 `/SakuraFrp/` 和 `/HTTP 协议访问此隧道/`，
 * 结果**一条都没匹配上** —— 那张 501 页正文里写的是 `Sakura Frp`（**中间有空格**），
 * 中文那句中间还夹着标签和换行。于是"明文 HTTP 被拦"这条分支永远走不到。
 * 所以判据一律打在压平后的文本上。
 */
const plainOf = (html) => String(html || '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function tcpConnect(h, p, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host: h, port: p });
    let done = false;
    const finish = (r) => { if (done) return; done = true; sock.destroy(); resolve({ ms: Date.now() - t0, ...r }); };
    sock.setTimeout(timeoutMs, () => finish({ ok: false, why: `${timeoutMs}ms 超时` }));
    sock.once('connect', () => finish({ ok: true }));
    sock.once('error', (e) => finish({ ok: false, why: e.code || e.message }));
  });
}

/** 读出这次 TLS 连接用的证书 —— 用来回答"访客会不会看到证书警告"。 */
function tlsInfoOf(res) {
  const sock = res.socket;
  if (!sock || typeof sock.getPeerCertificate !== 'function') return null;
  let cert = {};
  try { cert = sock.getPeerCertificate() || {}; } catch { return null; }
  return {
    authorized: Boolean(sock.authorized),
    error: sock.authorizationError ? String(sock.authorizationError) : null,
    cn: cert.subject?.CN || null,
    issuer: cert.issuer?.CN || cert.issuer?.O || null,
    validTo: cert.valid_to || null,
  };
}

/**
 * GET 一次。
 *
 * 用 `node:http` / `node:https` 而不是 `fetch`：`fetch` **没法忽略自签名证书**，
 * 而国内 TCP 隧道开了"自动 HTTPS"之后默认就是自签名证书 —— 那样我们会连自己的隧道都测不了。
 * 这里固定 `rejectUnauthorized: false`，然后把证书内容单独读出来报告，让人自己判断。
 */
function httpGet(url) {
  const t0 = Date.now();
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const req = mod.request(url, { method: 'GET', rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({
        ok: true, status: res.statusCode, body, ms: Date.now() - t0, tls: tlsInfoOf(res),
      }));
    });
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('TIMEOUT')));
    req.on('error', (e) => resolve({
      ok: false,
      why: e.message === 'TIMEOUT' ? `${HTTP_TIMEOUT_MS}ms 没回应` : (e.code || e.message),
      ms: Date.now() - t0,
    }));
    req.end();
  });
}

/**
 * 一次 WebSocket 握手，直接在 HTTP 层做。
 *
 * 为什么不用 `new WebSocket()`：Node 内置的 WS 客户端**不把状态码暴露出来**
 * （服务端回 401 时它只抛一个信息为空的 `TypeError`），而我们要的正是一个明确的状态码
 * 和"第一个字节什么时候回来"这个时间。所以这里自己写 upgrade 请求、只看响应首行。
 *
 * 判据：`101` = 升级成功；`401` = 服务端明确拒绝（这次没带登录 cookie）——
 * **两者都证明链路通**。`stall` = 到点一个字节都没回来（那条"卡满 60 秒"的老毛病）。
 *
 * `secure = true` 时走 TLS（wss），自动 HTTPS 打开之后公网那边就是这个形态。
 */
function wsProbe(h, p, path, timeoutMs, secure) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = secure
      ? tls.connect({ host: h, port: p, rejectUnauthorized: false })
      : net.connect({ host: h, port: p });
    let buf = '';
    let done = false;
    const finish = (kind, why, status) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* 已经关了 */ }
      resolve({ kind, why, status, ms: Date.now() - t0 });
    };
    sock.setTimeout(timeoutMs, () => finish('stall', `>${timeoutMs}ms 一个字节都没回来`));
    sock.once('error', (e) => finish('fail', e.code || e.message));
    sock.once(secure ? 'secureConnect' : 'connect', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n`
        + `Host: ${h}:${p}\r\n`
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n'
        + '\r\n',
      );
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (!m) return;
      const status = Number(m[1]);
      finish(status === 101 || status === 401 ? 'ok' : 'fail', `HTTP ${status}`, status);
    });
  });
}

/* ------------------------------------------------------------------ 体检 */

const line = (s) => console.log(s);
const marks = { ok: '✅', bad: '❌', warn: '⚠️' };

line(`公网通道体检：${base}${wsCount ? `（另打 ${wsCount} 次 WebSocket 握手）` : ''}`);
line('────────────────────────────────────────────────────────');

/* 1. 本机服务 */
const localMe = await httpGet(`${LOCAL.base}/api/me`);
const localIsOurs = localMe.ok && localMe.status === 401 && /"ok"\s*:\s*false/.test(localMe.body);
line(`${localIsOurs ? marks.ok : marks.bad} 本机 ${LOCAL.base}  ${localMe.ok
  ? `${localMe.status} ${localMe.body.slice(0, 60)}`
  : `连不上（${localMe.why}）`}${localIsOurs ? '' : '  ← 不是我们的服务，或服务没开'}`);

/* 2. 公网地址 */
const tcp = await tcpConnect(host, port);
const page = await httpGet(`${base}/`);
const ourTitle = /网页游戏平台/.test(page.body || '');
line(`${tcp.ok && page.ok && page.status === 200 && ourTitle ? marks.ok : marks.bad} 公网 GET ${base}/  ${
  page.ok ? `${page.status}，标题「${titleOf(page.body)}」` : `没回应（${page.why}）`}`);
line(`   TCP 连接 ${tcp.ok ? `${tcp.ms}ms` : `失败（${tcp.why}）`} · 整趟 ${page.ms}ms${ourTitle ? '' : ' · 页面不是我们的'}`);

/* 2b. 走 https 时顺便看看证书 —— 决定访客会不会看到"不安全"警告 */
if (page.tls) {
  const t = page.tls;
  line(`${t.authorized ? marks.ok : marks.warn} 证书  ${t.authorized ? '受信任' : '**不受信任**（访客会看到警告）'}`
    + ` · CN=${t.cn || '(无)'} · 签发者 ${t.issuer || '(无)'} · 到期 ${t.validTo || '?'}`
    + (t.error ? ` · ${t.error}` : ''));
}

/* 3. 唯一硬证据：本机来访日志 */
const before = logSize();
const page2 = await httpGet(`${base}/`);
const added = logTailSince(before).split('\n').filter((l) => l.includes(`host=${hostHeader}`));
line(`${added.length > 0 ? marks.ok : marks.bad} data/server.log 新增来访  ${added.length} 条 host=${hostHeader}`);
if (added.length > 0) line(`   ${added[0].trim()}`);
else if (page2.ok && page2.status === 200) line('   ⚠️ 页面回了 200 但日志里没有对应的 host= 行 —— host 对不上，或请求没经过本服务');

/* 4. WebSocket 握手（可选） */
let stall = 0;
if (wsCount > 0) {
  const results = [];
  for (let i = 0; i < wsCount; i += 1) results.push(await wsProbe(host, port, '/ws', HANDSHAKE_TIMEOUT_MS, scheme === 'https'));
  const ok = results.filter((r) => r.kind === 'ok').length;
  stall = results.filter((r) => r.kind === 'stall').length;
  const slowest = Math.max(...results.map((r) => r.ms));
  const failed = wsCount - ok;
  line(`${ok === wsCount ? marks.ok : marks.bad} WebSocket 握手 ${scheme === 'https' ? 'wss' : 'ws'}://${hostHeader}/ws × ${wsCount}  `
    + `${ok}/${wsCount} 通，最慢 ${slowest}ms，卡住(>${HANDSHAKE_TIMEOUT_MS / 1000}秒) ${stall} 次，其它失败 ${failed - stall} 次`);
  const sample = results.find((r) => r.kind !== 'ok');
  if (sample) line(`   首次失败样本：${sample.kind} —— ${sample.why}`);
}

/* 结论 */
line('────────────────────────────────────────────────────────');
const sakura = /Sakura\s*Frp/i.test(plainOf(page.body));
if (!localIsOurs) {
  line('结论：⛔ 本机服务没开（或 7891 上不是我们的服务）—— 先 start.cmd，再谈隧道。');
} else if (page.ok && page.status === 200 && ourTitle && added.length > 0) {
  line(`结论：✅ 通了。访客地址就是上面这个，TCP 连接 ${tcp.ms}ms。`);
} else if (page.ok && page.status === 501 && sakura && /HTTP 协议访问此隧道/.test(plainOf(page.body))) {
  line('结论：⛔ 明文 HTTP 被节点的合规策略拦住了 —— 隧道本身是好的，字节根本没转发到本机。');
  line('      页面原文：「您正试图使用 HTTP 协议访问此隧道 / 执行机房的内容合规要求…」');
  line('      解法（官方文档 doc.natfrp.com/frpc/auto-https.html）：');
  line('      ① 面板里编辑这条隧道 →「自动 HTTPS」选 `自动` → 保存 → 重启隧道');
  line('      ② 之后一律用 https:// 访问（TLS 由本机 frpc 脱壳，脱壳后仍是明文 HTTP 发给 7891，');
  line('         所以服务端代码一个字都不用改）');
  line('      官方速查表写得很直白：「网页 + 国内节点 → 必须开自动 HTTPS」。');
} else if (page.ok && page.status === 501 && sakura) {
  line('结论：⛔ 隧道没通。回的是 SakuraFrp 自己的 501 页，而且本机一条来访都没有');
  line('      → 节点侧没把连接转给本机 frpc（本地端口/隧道登记的问题，不是代码问题）。');
  line(`      → 先看启动器日志 ${'C:\\ProgramData\\SakuraFrpService\\Logs\\SakuraFrpService.<日期>.log'}`);
  line('        有没有「连接映射目标 [tcp://127.0.0.1:xxxx] 失败」；没有这一行就是节点没来敲。');
} else if (page.ok && (page.status === 502 || page.status === 503)) {
  line('结论：⛔ 节点/Cloudflare 认不出这条隧道（503=域名或隧道没生效，502=转到本机但本机没答）。');
} else if (page.ok) {
  line(`结论：⛔ 没通（HTTP ${page.status}${sakura ? '，SakuraFrp 的页面' : ''}）。`);
} else {
  line(`结论：⛔ 没通（${page.why}）。`);
}
if (stall > 0) line(`⚠️ 另有 ${stall} 次 WebSocket 握手卡满 ${HANDSHAKE_TIMEOUT_MS / 1000} 秒 —— 那条老毛病还在。`);
if (page.tls && !page.tls.authorized) {
  line('⚠️ 证书不受信任 —— 朋友第一次打开会看到"不安全"提示，点「继续访问」即可。');
  line('   想消掉它要往 frpc 工作目录放一张可信证书：%ProgramData%\\SakuraFrpService\\FrpcWorkingDirectory');
  line('   （见 doc.natfrp.com/frpc/ssl.html；证书的域名必须等于访客输入的域名，否则照样告警）');
}