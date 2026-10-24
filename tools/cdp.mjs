/**
 * frp-game — 极简 CDP 驱动（开发/测试用）
 *
 * 来源：从原项目 Shell Gambit / BladeSteed 的 tools/cdp.mjs **原样搬过来**
 * （那两个仓库里这个文件字节完全相同，说明它是这个项目家族的标准工具）。
 * 除了本段注释，代码一行没改 —— 它能用就别动它。
 *
 * 为什么自己写：只为「用真实浏览器跑一遍端到端」这一个目的，
 * 为此引入 puppeteer/playwright 属于杀鸡用牛刀（还要下载上百 MB 的浏览器）。
 * Node 24 自带 fetch 与 WebSocket，够用了。
 *
 * 能力：启动无头 Chrome/Edge、导航、执行 JS、等条件、截图、收集控制台错误。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChrome() {
  return CANDIDATES.find((p) => existsSync(p)) || null;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 给一条新连接挂上控制台/异常/原生对话框监听。
 * launch() 和 waitForNewPage() 都走这里，保证新标签页的错误也收得到。
 */
function wirePage(conn, page) {
  conn.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || [])
      .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
      .join(' ');
    page.logs.push(`[${p.type}] ${text}`);
    if (p.type === 'error') page.errors.push(text);
  });
  conn.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    const text = d.exception?.description || d.text || '未知异常';
    page.errors.push(text);
    page.logs.push(`[exception] ${text}`);
  });
  // 原生对话框自动点掉（见 Page#dialogs 的注释）
  conn.on('Page.javascriptDialogOpening', (p) => {
    page.dialogs.push(p.message || p.type || '');
    conn.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
}

/** 一条 CDP 连接 */
class Connection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error(`无法连接调试端口 ${url}`));
    });
    const c = new Connection(ws);
    ws.onmessage = (ev) => c._onMessage(JSON.parse(ev.data));
    ws.onclose = () => {
      for (const p of c.pending.values()) p.reject(new Error('调试连接已关闭'));
      c.pending.clear();
    };
    return c;
  }

  _onMessage(m) {
    if (m.id) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${m.error.message}${m.error.data ? ` ${m.error.data}` : ''}`));
      else p.resolve(m.result);
      return;
    }
    for (const cb of this.handlers.get(m.method) || []) {
      try {
        cb(m.params);
      } catch (e) {
        console.error('CDP 事件处理失败', e);
      }
    }
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

/** 一个浏览器标签页 */
export class Page {
  constructor(conn, proc, profile) {
    this.conn = conn;
    this.proc = proc;
    this.profile = profile;
    /** @type {string[]} 控制台错误与未捕获异常 */
    this.errors = [];
    /** @type {string[]} 所有 console 输出（调试用） */
    this.logs = [];
    /**
     * 页面上弹过的原生对话框（alert/confirm/prompt）的正文。
     *
     * ⚠️ 原生对话框会**阻塞页面的 JS 线程**，不处理的话后面每一条 CDP 命令
     * （包括 `page.eval`）都会一直挂着 —— 症状是"用例跑到一半就不动了"。
     * 无名杀的上游 `index.html` 里就有 `window.onerror → alert(...)`，
     * 网页端一旦有脚本报错就会弹一个，所以这里统一自动点掉，只把正文记下来。
     */
    this.dialogs = [];
  }

  static async launch({
    headless = true,
    width = 430,
    height = 932,
    mobile = false,
    startUrl = 'about:blank',
    extraArgs = [],
  } = {}) {
    const exe = findChrome();
    if (!exe) throw new Error('本机没有找到 Chrome 或 Edge');
    const port = await freePort();
    const profile = mkdtempSync(join(tmpdir(), 'sg-chrome-'));
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-features=Translate,OptimizationHints',
      `--window-size=${width},${height}`,
      startUrl,
    ];
    if (headless) args.unshift('--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio');
    args.push(...extraArgs);

    const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });

    // 等调试端口就绪
    let target = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/list`);
        const list = await r.json();
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (target) break;
      } catch {
        /* 还没起来 */
      }
      await sleep(150);
    }
    if (!target) {
      try {
        proc.kill();
      } catch {
        /* 忽略 */
      }
      throw new Error('浏览器调试端口没有就绪');
    }

    const conn = await Connection.open(target.webSocketDebuggerUrl);
    const page = new Page(conn, proc, profile);
    page.port = port;
    page.targetId = target.id;
    wirePage(conn, page);

    await conn.send('Page.enable');
    await conn.send('Runtime.enable');
    // Windows 上的 Chrome 有最小窗口宽度（约 500px），--window-size=360,640 会被夹到 512，
    // 想真的按 360px 这种手机宽度排版，必须用 Emulation 覆盖视口。
    await page.setViewport(width, height, mobile);
    return page;
  }

  /**
   * 把视口精确设成指定尺寸（默认带手机 emulation）。
   * 不这么做的话，所谓「360×640 小屏手机」实际测的是 512px 宽的窗口。
   */
  async setViewport(width, height, mobile = false) {
    await this.conn.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: mobile ? 2 : 1,
      mobile: !!mobile,
      screenWidth: width,
      screenHeight: height,
    });
    this.viewport = { width, height, mobile: !!mobile };
    return this.viewport;
  }

  /** 执行 JS 表达式并取回值 */
  async eval(expression) {
    const r = await this.conn.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  /** 求值一段表达式（不包成函数体，允许返回对象） */
  async evalRaw(expression) {
    // 图省事写成 `return ...;` 也能用：自动包一层函数体
    const expr = /^\s*return\b/.test(expression) ? `(() => { ${expression} })()` : expression;
    const r = await this.conn.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  async goto(url) {
    await this.conn.send('Page.navigate', { url });
    await this.waitFor('return document.readyState === "complete"', 15000, '页面加载完成');
  }

  /**
   * 等这个浏览器里 popup 出来的**新标签页**（`window.open` / `target=_blank`），
   * 连上它并返回一个新的 Page。
   *
   * 平台首页从 2026-11 起所有游戏都开新窗口；用例点完按钮必须换到这个新页面继续断言。
   * ⚠️ 调用前的那次点击必须是**真实鼠标点击**（Page.click / clickByText）——
   *    `element.click()` 是脚本点击、没有用户手势，浏览器会把 popup 拦掉。
   *
   * @param {{ timeoutMs?: number, urlIncludes?: string }} [opts]
   * @returns {Promise<Page>}
   */
  async waitForNewPage({ timeoutMs = 15000, urlIncludes = '' } = {}) {
    if (!this.port) throw new Error('这个 Page 不是 launch() 出来的，拿不到浏览器调试端口');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let list = [];
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json/list`);
        list = await r.json();
      } catch {
        /* 调试端口偶尔抖一下，继续等 */
      }
      const target = list.find(
        (t) =>
          t.type === 'page' &&
          t.webSocketDebuggerUrl &&
          t.id !== this.targetId &&
          (!urlIncludes || String(t.url || '').includes(urlIncludes)),
      );
      if (target) {
        const conn = await Connection.open(target.webSocketDebuggerUrl);
        const page = new Page(conn, this.proc, this.profile);
        page.port = this.port;
        page.targetId = target.id;
        wirePage(conn, page);
        await conn.send('Page.enable');
        await conn.send('Runtime.enable');
        if (this.viewport) {
          await page.setViewport(this.viewport.width, this.viewport.height, this.viewport.mobile);
        }
        return page;
      }
      await sleep(100);
    }
    throw new Error(`等待新标签页超时（${timeoutMs}ms，url 包含 ${urlIncludes || '*'})`);
  }

  /** 轮询等待条件成立 */
  async waitFor(expr, timeoutMs = 10000, label = expr) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        if (await this.eval(expr)) return true;
      } catch (e) {
        lastErr = e;
      }
      await sleep(120);
    }
    throw new Error(
      `等待超时（${timeoutMs}ms）：${label}${lastErr ? ` — 最后错误：${lastErr.message}` : ''}`
    );
  }

  /** 点击一个选择器（用真实鼠标事件，走页面的事件委托） */
  async click(selector, { index = 0 } = {}) {
    // 只挑「真正显示出来」的元素：隐藏屏幕里的同名按钮尺寸为 0，
    // 点它等于什么都没点，所以这里直接跳过
    const box = await this.evalRaw(`(() => {
      const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const visible = all.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
      });
      const el = (visible.length ? visible : all)[${index}];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, n: all.length, v: visible.length };
    })()`);
    if (!box) throw new Error(`找不到可点击元素：${selector}[${index}]`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.conn.send('Input.dispatchMouseEvent', {
        type,
        x: box.x,
        y: box.y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
      });
    }
  }

  /**
   * 在页面坐标 (x, y) 上点一下真实鼠标事件。
   *
   * 给 canvas 里的界面用（Godot 的网页导出就是一块 canvas，按钮不是 DOM 元素，
   * 既选不中也没法 `el.click()`）—— 只能自己算坐标再点。
   */
  async clickAt(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.conn.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
      });
    }
  }

  /** 在输入框里输入文字（逐字派发，兼容 input 事件驱动的校验） */
  async type(selector, text) {
    await this.click(selector);
    await this.evalRaw(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ''; el.focus(); })()`);
    for (const ch of text) {
      await this.conn.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
      await this.conn.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch });
      // 无头模式下 Input.insertText 更稳，两者都发一次保证 value 被写入
      await this.conn.send('Input.insertText', { text: ch });
    }
  }

  /** 直接设置输入框的值并触发 input 事件（比模拟键盘稳定） */
  async setInput(selector, text) {
    await this.evalRaw(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.focus();
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  }

  async screenshot(path) {
    const r = await this.conn.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  }

  close() {
    this.conn.close();
    try {
      if (this.proc) this.proc.kill();
    } catch {
      /* 忽略 */
    }
  }
}