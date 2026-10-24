/**
 * BladeSteed — 界面主控（页面入口，index.html 用 <script type="module"> 加载它）
 *
 * 职责：
 *   · 屏幕切换（首页 / 人机设置 / 在线对局 / 牌桌 / 规则）
 *   · 把「裁剪过的视图」交给 js/ui/board.js 去画
 *   · 把玩家的点击翻译成意图信封，按当前模式发给正确的地方：
 *       单机 → LocalMatch（浏览器里的引擎，见 js/ui/local.js）
 *       联机 → OnlineMode → FrpRoom 的 ctx.act（→ 服务端进程里的引擎，见 js/ui/online.js）
 *   · 顶栏 / 音效 / 特效偏好
 *
 * 房间外壳（房号 / 成员 / 邀请 / 开始 / 离开）**一律由 /shared/ui/room.js 负责**，
 * 本游戏的联机胶水在 js/ui/online.js。
 *
 * 这里**不包含任何游戏规则判断**：能做什么一律问 board.js → legalActionsFrom(视图)。
 *
 * ⚠️ 身份来自平台账号（window.GameNet.me）。游戏内**不问名字**，也没有名字输入框 ——
 *    名字在注册时就定死了（单字），见 docs/DECISIONS.md D5。
 */

import { BoardView } from './board.js';
import { LocalMatch } from './local.js';
import { AudioKit } from './audio.js';
import { OnlineMode } from './online.js';

const { GameNet, FrpUI, FrpProtocol } = window;
const T = FrpProtocol.T;
const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.audio = new AudioKit();
    this.me = null;
    this.connected = false;
    /** 掉过线 / 连上过吗 —— 只用来决定身份行要不要写"（掉线，正在重连…）"，见 _renderIdentity */
    this._everConnected = false;
    this.fxEnabled = true;
    this.local = null;
    this.localBoard = null;
    /** 联机那一半（房间胶水 + 联机牌桌）都在 js/ui/online.js 里 */
    this.online = null;
    this._localSize = 4;
    this.screen = 'screen-home';
    /** 退订平台偏好（页面不会重建，留着只是为了不漏掉退订这件事） */
    this._unsubPrefs = null;
  }

  /* ============================== 启动 ============================== */

  boot() {
    this._loadPrefs();
    this._bindNav();
    this._bindLocal();
    this._bindMenu();
    this._mountRoom();
    this._bindNet();

    // 计时数字每 200ms 刷一次（只改一个文本节点，不重画牌桌）
    setInterval(() => {
      if (this.localBoard) this.localBoard.tickTimer();
      if (this.online && this.online.board) this.online.board.tickTimer();
    }, 200);

    this.showScreen('screen-home');
  }

  /* ------------------------------ 偏好 ------------------------------ */

  /**
   * 音效 / 特效偏好：**只读写平台那一份**（`FrpUI.prefs`，存在 localStorage 的 `frp.prefs`）。
   *
   * 【为什么不能各存各的】平台外壳的"设置"栏和本游戏的首页开关、对局菜单开关
   * 说的是同一件事。各存各的就会出现"平台开着、游戏关着"——用户看到的是
   * "我明明在设置里关了，进游戏还是响"（用户点名要求，见 docs/DECISIONS.md D12）。
   * 所以这里只做三件事：读一次、写回去、**订阅变化**（在另一个标签页/平台设置栏改过，
   * 游戏里这两个按钮要跟着变）。
   *
   * ⚠️ 老键 `bs.sound` / `bs.fx` 这里**一个字节都不碰**（平台在 `FrpUI.prefs` 的
   *    首次加载里做了一次性迁移，见 shared/ui/ui.js 的 LEGACY）：两边都写就会出现
   *    "到底谁说了算"的第二次打架。
   * ⚠️ 系统级 `prefers-reduced-motion` 的默认值也在平台那一份里（特效默认值），
   *    本游戏不再自己算一遍 —— 否则同一个开关会有两个默认值。
   */
  _loadPrefs() {
    const prefs = FrpUI.prefs;
    const apply = (p) => {
      this.audio.enabled = !!p.sound;
      this.fxEnabled = !!p.fx;
      this._applyFx();
      this._applySound();
    };
    apply({ sound: prefs.sound(), fx: prefs.fx() });
    this._unsubPrefs = prefs.on((p) => apply(p));
  }

  _applyFx() {
    document.body.classList.toggle('no-fx', !this.fxEnabled);
    if (this.localBoard) this.localBoard.fx.enabled = this.fxEnabled;
    if (this.online) this.online.setFx(this.fxEnabled);
    /*
     * 平台那两套也要跟着一起关，否则用户按了「特效关」却还能看到东西在动 —— 那就是骗人：
     *   · FrpAnim 是**演出队列**（shared/ui/anim.js）：关掉它，逐条演出改成立刻演完，
     *     这正是"特效关了就别慢慢演"该有的样子（它内部只管时间，不管画什么）。
     *   · FrpReact 是**互动特效**（扔鸡蛋/鲜花，shared/ui/react.js）：抛物线、碎裂。
     * 两个都是平台脚本（index.html 里用 defer 引的），所以取 window 上的全局对象；
     * 万一没加载也不能让开关本身报错。
     */
    if (window.FrpAnim && typeof window.FrpAnim.setEnabled === 'function') {
      window.FrpAnim.setEnabled(this.fxEnabled);
    }
    if (window.FrpReact && typeof window.FrpReact.setFx === 'function') {
      window.FrpReact.setFx(this.fxEnabled);
    }
    const btn = $('toggle-fx');
    if (btn) {
      btn.setAttribute('aria-pressed', String(this.fxEnabled));
      btn.textContent = this.fxEnabled ? '✨ 特效' : '✨ 特效关';
    }
    const menu = $('menu-fx');
    if (menu) menu.textContent = `✨ 特效：${this.fxEnabled ? '开' : '关'}`;
  }

  _applySound() {
    // 平台的互动音效（扔鸡蛋「啪叽」/ 鲜花铃声）走同一个开关：本作的音效是现场合成的，
    // 平台那套也是，两边关一个开一个会让用户觉得开关坏了。
    if (window.FrpReact && typeof window.FrpReact.setSound === 'function') {
      window.FrpReact.setSound(this.audio.enabled);
    }
    const btn = $('toggle-sound');
    if (btn) {
      btn.setAttribute('aria-pressed', String(this.audio.enabled));
      btn.textContent = this.audio.enabled ? '🔊 音效' : '🔇 音效关';
    }
    const menu = $('menu-sound');
    if (menu) menu.textContent = `🔊 音效：${this.audio.enabled ? '开' : '关'}`;
  }

  /* ------------------------------ 屏幕 / 导航 ------------------------------ */

  showScreen(id) {
    this.screen = id;
    for (const s of document.querySelectorAll('.screen')) {
      s.classList.toggle('is-active', s.id === id);
    }
    window.scrollTo(0, 0);
  }

  _bindNav() {
    /*
     * 导航按钮的点击音（用户第 3 条要求："点了没声"）。
     *
     * ⛔ **不要接平台的 `FrpUI.sound.bindClicks()`**：那是平台外壳一次接齐所有点击用的，
     *    本作自己有音效包（620→420Hz 三角波 60ms，见 js/ui/audio.js 的 'click'），
     *    两边都接同一下会**响两声**。
     * ⛔ `pointerdown` 那一次 `audio.unlock()` 不许动：AudioContext 必须等第一次用户手势
     *    才能创建（浏览器自动播放策略），换到 click 上会让"第一次点没声"。
     */
    const go = (id) => this.audio.play('click');
    $('btn-go-local').addEventListener('click', () => {
      go();
      this.showScreen('screen-local');
    });
    $('btn-go-online').addEventListener('click', () => {
      go();
      this.showScreen('screen-online');
    });
    $('btn-go-rules').addEventListener('click', () => {
      go();
      this.showScreen('screen-rules');
    });
    // 各屏左上角那个「‹」返回按钮（data-back 指向要回的那一屏）
    for (const btn of document.querySelectorAll('[data-back]')) {
      btn.addEventListener('click', () => {
        go();
        this.showScreen(btn.dataset.back);
      });
    }

    // 任何一次点击都可能解锁音频（浏览器的自动播放策略）
    document.addEventListener('pointerdown', () => this.audio.unlock(), { capture: true });

    $('toggle-sound').addEventListener('click', () => {
      FrpUI.prefs.setSound(!FrpUI.prefs.sound());
      this.audio.play('click');
    });
    $('toggle-fx').addEventListener('click', () => {
      FrpUI.prefs.setFx(!FrpUI.prefs.fx());
      this.audio.play('click');
    });
  }

  /* ------------------------------ 身份 / 网络 ------------------------------ */

  _bindNet() {
    GameNet.on(T.READY, (msg) => {
      // 服务端说了才算（ready 是身份的权威来源）——缓存那份只是"先显示着"
      this.me = msg.me;
      this._renderIdentity();
    });
    GameNet.on(T.ROOM_STATE, () => this._renderHomeRoomHint());
    /*
     * ⚠️ 这里**曾经**自己挂过一条 `GameNet.on(T.ERROR, …) → FrpUI.toast(...)`（服务端拒绝时弹提示）。
     * 平台后来在 `shared/ui/room.js` 的 `mount()` 里统一加了一条一模一样的，而本页 **boot() 会
     * 依次调 `_mountRoom()` 和 `_bindNet()`** —— 两条监听同时在，同一条 error 会**弹两次**
     * （实测：一个人 + 补位选 0 点【开始游戏】，屏幕上出现两条一模一样的"开局失败：只有你一个人…"）。
     * 所以按平台的约定删掉了：**平台的那一条是唯一的**，新游戏不要再自己加。
     * 回归防线在 tests/browser.e2e.mjs 的 5d-0（断言提示条**恰好一条**）。
     */
    GameNet.on('open', () => {
      this.connected = true;
      this._everConnected = true;
      this._renderIdentity();
    });
    GameNet.on('close', () => {
      this.connected = false;
      this._renderIdentity();
    });

    /*
     * 【身份：先用浏览器里记着的那份把界面画出来，等 ready 到了再对齐】
     *
     * 平台首页和游戏页是**两个网页**，点进游戏是一次整页跳转：公网那次 WebSocket 握手
     * 实测要 2~3 秒（docs/TUNNEL.md 那类链路结论）。这段窗口里原来只能显示"正在确认身份…"，
     * 而且点「开始对局」会被误判成"还没登录"并弹一句**假话**（用户实测撞到过）。
     * 所以：谁先把身份拿到手就顺手记在浏览器里（shared/net/net.js 的 rememberMe），
     * 游戏页一打开先用 `cachedMe()` 画出来。
     *
     * ⛔ **缓存只用于显示 + 放行**：不许拿它填 `GameNet.me`、也不许拿它当登录态
     *    （平台的登录竞态靠"me 只有服务端说了才算"成立，见 docs/DECISIONS.md D13）。
     *    服务端说没登录（下面那次 /api/me 返回 401）才 forgetMe() 并回平台首页。
     */
    this.me = GameNet.me || GameNet.cachedMe();
    this._renderIdentity();
    GameNet.connect();

    /*
     * 顺手用 HTTP 问一次"我是谁"（/api/me）：
     *   · 200 → 服务端认定的身份（比缓存准），拿去显示
     *   · 401 → 会话真的没了：把缓存清掉（forgetMe，否则下一个人在这台机器上会先看到
     *     上一个人的名字）并回平台首页登录。WS 握手被拒时浏览器只看到 'close'，
     *     分不出"没登录"和"网络抖"，所以这条明确的路不能省。
     */
    fetch('/api/me', { credentials: 'same-origin' })
      .then((res) => {
        if (res.status === 401) {
          GameNet.forgetMe();
          this.me = null;
          this._renderIdentity();
          location.replace('/');
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data) => {
        if (data && data.ok && data.me && !GameNet.me) {
          this.me = data.me;
          this._renderIdentity();
        }
      })
      .catch(() => {
        /* 网络抖一下就等 WebSocket 的 ready，别跳转 */
      });

    /*
     * 没登录才提示。⚠️ 有**缓存身份**时不许闪出来（那正是用户报的"假话"）：
     * 缓存说明这台机器上刚登录过，真正作准的是上面那次 /api/me 和 WebSocket 的 ready。
     */
    setTimeout(() => {
      if (!this.me && !GameNet.cachedMe()) $('login-hint').hidden = false;
    }, 2500);
  }

  _renderIdentity() {
    const el = $('me-line');
    if (!el) return;
    if (!this.me) {
      el.textContent = '正在确认身份…';
      return;
    }
    /*
     * "（掉线，正在重连…）"只在**真的连过又断了**的时候写。
     * 用缓存身份先画出来的那 2~3 秒里 connected 还是 false，但那不是掉线
     * （刚进页面、握手还没回来），写上去就成了第二句假话。
     */
    const offline = this._everConnected && !this.connected;
    el.textContent = `你：${this.me.name} · ID ${this.me.id}${offline ? '（掉线，正在重连…）' : ''}`;
  }

  _renderHomeRoomHint() {
    const el = $('btn-go-online-sub');
    if (!el) return;
    const r = GameNet.room;
    if (r && r.game === 'blade-steed') {
      el.textContent = `你正在房间里（${r.code}）· 点这里回去`;
    } else {
      el.textContent = '6 位房间号 · 一个人也能补个电脑开局';
    }
  }

  _requireLogin() {
    /*
     * 有身份就放行 —— **包括"只有浏览器里记着的那份"**。
     *
     * 为什么：原来这里只看 `this.me`，而 `this.me` 要等 WebSocket 的 ready（公网 2~3 秒），
     * 于是刚进游戏页就点「开始对局」会弹「还没登录，先回平台首页登录」—— 那句话是**假的**
     * （人明明登录着），用户实测撞到过。
     * 现在的取舍：有缓存身份就先放行，**真正作数的仍然是服务端**：
     *   · 单机人机整局跑在本机，不向服务器要任何权限；
     *   · 联机的每一步都由服务端裁决（"还没轮到你""你不在这一局里"都是服务器说的），
     *     会话真的过期时 /api/me 会给 401，那边会 forgetMe() + 回平台首页（见 _bindNet）。
     */
    const me = GameNet.me || this.me || GameNet.cachedMe();
    if (me) {
      if (!this.me) this.me = me;
      return true;
    }
    FrpUI.toast('还没登录，先回平台首页登录', 'error');
    $('login-hint').hidden = false;
    return false;
  }

  /* ============================== 单机人机 ============================== */

  _bindLocal() {
    for (const btn of document.querySelectorAll('#local-size .seg-btn')) {
      btn.addEventListener('click', () => {
        this._localSize = Number(btn.dataset.size) || 4;
        this._syncSizeButtons();
        this.audio.play('click');
      });
    }
    this._syncSizeButtons();
    $('btn-local-start').addEventListener('click', () => {
      // 点了没声在这一屏最明显（它是"进牌桌"的那一下），所以也补一个点击音
      this.audio.play('click');
      this._startLocal();
    });
  }

  _syncSizeButtons() {
    for (const btn of document.querySelectorAll('#local-size .seg-btn')) {
      btn.classList.toggle('is-on', Number(btn.dataset.size) === this._localSize);
    }
    const hint = $('local-hint');
    if (hint) hint.textContent = `除你之外的 ${this._localSize - 1} 个席位由 AI 补齐。`;
  }

  _startLocal() {
    if (!this._requireLogin()) return;
    if (this.local) this.local.stop();

    this._ensureLocalBoard();
    this.localBoard.reset();
    this.local = new LocalMatch({
      me: this.me,
      size: this._localSize,
      onUpdate: () => this._onLocalUpdate(),
    });
    this.local.start();
    this.showScreen('screen-board');
  }

  _ensureLocalBoard() {
    if (this.localBoard) return;
    const root = $('local-board');
    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'icon-btn menu';
    menu.id = 'btn-board-menu';
    menu.setAttribute('aria-label', '对局菜单');
    menu.textContent = '☰';
    menu.addEventListener('click', () => this._openMenu());

    this.localBoard = new BoardView(root, {
      onAct: (act) => this._localAct(act),
      audio: this.audio,
      menuButton: menu,
      onHome: () => this._leaveLocal(),
    });
    this.localBoard.fx.enabled = this.fxEnabled;
  }

  _onLocalUpdate() {
    if (!this.localBoard || !this.local) return;
    // 单机也必须先过 viewFor 再渲染（铁律二）—— 见 local.js 的 view()
    this.localBoard.render(this.local.view(), this.me.id);
  }

  /** 单机：意图信封直接喂给浏览器里的引擎 */
  _localAct(act) {
    if (!this.local) return;
    const r = this.local.handle(act);
    if (r && r.ok === false) FrpUI.toast(r.message, 'error');
  }

  _leaveLocal() {
    if (this.local) this.local.stop();
    this.local = null;
    this.showScreen('screen-home');
  }

  /* ------------------------------ 单机的对局菜单 ------------------------------ */

  _bindMenu() {
    $('menu-restart').addEventListener('click', () => {
      this.audio.play('click');
      this._closeMenu();
      if (!this.local) return;
      this.localBoard.reset(); // 事件/播报编号会从头开始，必须先把游标清掉
      this.local.restart();
      this._onLocalUpdate();
    });
    $('menu-sound').addEventListener('click', () => {
      FrpUI.prefs.setSound(!FrpUI.prefs.sound());
      this.audio.play('click');
    });
    $('menu-fx').addEventListener('click', () => {
      FrpUI.prefs.setFx(!FrpUI.prefs.fx());
      this.audio.play('click');
    });
    $('menu-leave').addEventListener('click', () => {
      this.audio.play('click');
      this._closeMenu();
      this._leaveLocal();
    });
    $('menu-close').addEventListener('click', () => {
      this.audio.play('click');
      this._closeMenu();
    });
  }

  _openMenu() {
    this.audio.play('click');
    $('board-menu').hidden = false;
  }

  _closeMenu() {
    $('board-menu').hidden = true;
  }

  /* ============================== 联机（房间） ============================== */

  /**
   * 联机全部委托给 js/ui/online.js（房间外壳由 /shared/ui/room.js 画）。
   * 这里只做两件事：把容器交给它、把它接上本页的偏好与屏幕切换。
   */
  _mountRoom() {
    this.online = new OnlineMode({
      container: $('online-panel'),
      audio: this.audio,
      me: () => this.me,
      showScreen: (id) => this.showScreen(id),
    });
    this.online.setFx(this.fxEnabled);
    this.online.mount();
  }
}

new App().boot();