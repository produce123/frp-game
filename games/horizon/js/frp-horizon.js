/*
 * 地平线赛车的平台接线（联机大厅 / 联机比赛 / 手机触屏）。
 *
 * 这是**唯一**改上游行为的文件，上游 js/*.js 一行没动。它做四件事：
 *   1. 用平台标准房间面板 FrpRoom（同一套账号/好友/邀请/房号）开联机车。
 *   2. 开局后切到房主选的地图，在现有沿海/环线赛道上放"起点/终点"拱门，
 *      用车位置中继（/horizon-relay）同步其他玩家的车。
 *   3. 车与车真实碰撞：本地车撞上"对方车的最新位置"时被推开（对方也会在它自己
 *      的客户端做同样的事）。**不是服务器权威物理** —— 见 docs/DECISIONS.md D46。
 *   4. 手机没有键盘：把触屏按键合成成 KeyW/KeyA/KeyS/KeyD/Space 等键盘事件，
 *      复用上游已有的输入逻辑，不另写一套驾驶。
 *
 * 为什么不改 main.js：
 *   上游的赛事代码（startRace/finishRace/raceCheckpoints）是现成的，只是被
 *   `Game.start()` 强制成自由漫游。这里在运行时把它接回来（patch finishRace），
 *   上游代码保持可整体替换/更新。
 */
(function () {
  'use strict';

  var P = window.FrpProtocol;
  var T = P && P.T;
  /** 平台共用 UI（toast / el）；游戏自己的 HUD 是全局 `UI`，两个不是一回事！ */
  var PUI = window.FrpUI;
  var Net = window.GameNet;
  var Room = window.FrpRoom;

  var MAP_NAMES = {
    alpine: '阿尔卑斯湖谷',
    city: '海特洛市',
    city2: '海特洛 2',
    city3: '程序化都市 GLB',
  };

  var H = {
    booted: false,
    mounted: false,
    lobbyOpen: false,
    lobbyDismissed: false,
    roomCode: '',
    map: 'alpine',
    view: null,
    racers: [],
    route: null,
    racing: false,
    starting: false,
    /** 每次 startRace 自增；stopRace 也自增，用来丢弃"切图到一半被取消"的旧启动。 */
    raceSeq: 0,
    started: false,
    finished: false,
    selfId: '',
    ghosts: new Map(),
    gates: [],
    results: new Map(),
    localOrder: 0,
    ws: null,
    wsOpen: false,
    wsClosedByUs: false,
    wsRetry: 0,
    lastFrame: 0,
    lastPosAt: 0,
    lastProgress: 0,
    lastCollisionAt: 0,
    rank: 1,
    touchShown: false,
    euler: null,
    internalMenu: false,
    touch: false,
    touchBuilt: false,
    touchKeys: [],
    layout: null,
    layoutEditing: false,
    layoutSel: 'map',
    layoutCollapsed: false,
    layoutDragging: false,
  };

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) { return PUI.el(tag, attrs, children); }
  function clock(t) {
    var n = Math.max(0, Number(t) || 0);
    var m = Math.floor(n / 60);
    var s = n - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function mapName(id) { return MAP_NAMES[id] || id || '阿尔卑斯湖谷'; }
  function isCoarse() {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch (err) { return false; }
  }
  function isHost() {
    return Boolean(Net && Net.room && Net.me && Net.room.hostId === Net.me.id);
  }

  /* ============================== 手机 HUD 布局 ============================== */

  /*
   * 六组整体编辑，不做"每颗按钮独立"。位置/大小只写 CSS 变量，游戏绘制代码
   * 完全不知道布局存在；保存在 localStorage，只影响当前这台设备。
   */
  var LAYOUT_KEY = 'frp.horizon.layout.v1';
  var LAYOUT_ORDER = ['map', 'dash', 'score', 'left', 'right', 'top'];
  var LAYOUT_GROUPS = {
    map: { label: '小地图', min: 0.6, max: 1.6 },
    dash: { label: '仪表盘', min: 0.6, max: 1.6 },
    score: { label: '技能点', min: 0.8, max: 1.6 },
    left: { label: '左转向', min: 0.8, max: 1.5 },
    right: { label: '右油门', min: 0.8, max: 1.5 },
    top: { label: '顶部小按钮', min: 1, max: 1.5 },
  };
  var layoutHandles = {};

  function defaultLayout() {
    var out = {};
    LAYOUT_ORDER.forEach(function (id) {
      out[id] = { x: 0, y: 0, s: 1, v: true };
    });
    return out;
  }

  function clampNum(n, lo, hi) {
    n = Number(n);
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function loadLayout() {
    var out = defaultLayout();
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); } catch (err) { raw = null; }
    if (!raw || typeof raw !== 'object') return out;
    LAYOUT_ORDER.forEach(function (id) {
      var src = raw[id];
      if (!src || typeof src !== 'object') return;
      var g = LAYOUT_GROUPS[id];
      out[id].x = clampNum(src.x, -3000, 3000);
      out[id].y = clampNum(src.y, -3000, 3000);
      out[id].s = clampNum(src.s, g.min, g.max);
      out[id].v = src.v !== false;
    });
    return out;
  }

  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(H.layout)); } catch (err) { /* 隐私模式 */ }
  }

  function layoutTarget(id) {
    if (id === 'map') return $('minimap');
    if (id === 'dash') return $('dashHud');
    if (id === 'score') return $('scoreBox');
    var root = $('horizonTouch');
    return root ? root.querySelector('.hzone.' + id) : null;
  }

  /** 隐藏的组也要能量位置，否则手柄会跑到 (0,0)。 */
  function measureTarget(id) {
    var node = layoutTarget(id);
    if (!node) return null;
    var cls = 'hud-hide-' + id;
    var hidden = document.body.classList.contains(cls);
    if (hidden) document.body.classList.remove(cls);
    var rect = node.getBoundingClientRect();
    if (hidden) document.body.classList.add(cls);
    return rect;
  }

  function applyLayout() {
    if (!H.layout) H.layout = defaultLayout();
    var body = document.body;
    var root = document.documentElement;
    body.classList.toggle('frp-touch-hud', H.touch);
    LAYOUT_ORDER.forEach(function (id) {
      var g = H.layout[id];
      root.style.setProperty('--hud-' + id + '-x', g.x + 'px');
      root.style.setProperty('--hud-' + id + '-y', g.y + 'px');
      root.style.setProperty('--hud-' + id + '-s', String(g.s));
      body.classList.toggle('hud-hide-' + id, Boolean(H.touch && !g.v));
    });
    if (H.layoutEditing && !H.layoutDragging) syncLayoutHandles();
    positionRacePanel();
  }

  /**
   * 手机联机计时条：默认贴在小地图右边。
   * 地图被布局编辑器拖动/缩放后也跟着走；地图隐藏时回 CSS 的左上角兜底。
   * 桌面不写 inline style，保持上游顶部居中的大计时面板。
   */
  function positionRacePanel() {
    var panel = $('racePanel');
    if (!panel) return;
    if (!H.touch) {
      panel.style.left = '';
      panel.style.top = '';
      return;
    }
    var map = $('minimap');
    var rect = map ? map.getBoundingClientRect() : null;
    if (!rect || !rect.width || !rect.height) {
      panel.style.left = '';
      panel.style.top = '';
      return;
    }
    panel.style.left = (rect.right + 8) + 'px';
    panel.style.top = rect.top + 'px';
  }

  /** 让拖出去的元素至少留一点在屏幕内；否则用户只能重置。 */
  function clampGroup(id) {
    var rect = measureTarget(id);
    if (!rect || !rect.width || !rect.height) return;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var keep = Math.min(64, Math.max(24, rect.width * 0.24));
    var dx = 0, dy = 0;
    if (rect.right < keep) dx = keep - rect.right;
    else if (rect.left > vw - keep) dx = (vw - keep) - rect.left;
    if (rect.bottom < keep) dy = keep - rect.bottom;
    else if (rect.top > vh - keep) dy = (vh - keep) - rect.top;
    if (!dx && !dy) return;
    H.layout[id].x += dx;
    H.layout[id].y += dy;
    applyLayout();
  }

  function syncOneHandle(id) {
    var h = layoutHandles[id];
    if (!h) return;
    h.classList.toggle('sel', H.layoutSel === id);
    h.classList.toggle('hiddenItem', !H.layout[id].v);
    var tag = h.querySelector('.layTag');
    if (tag) tag.textContent = LAYOUT_GROUPS[id].label + (H.layout[id].v ? '' : ' · 已隐藏');
    var rect = measureTarget(id);
    if (!rect || (!rect.width && !rect.height)) {
      h.style.display = 'none';
      return;
    }
    h.style.display = 'block';
    h.style.left = rect.left + 'px';
    h.style.top = rect.top + 'px';
    h.style.width = rect.width + 'px';
    h.style.height = rect.height + 'px';
  }

  function syncLayoutHandles() {
    LAYOUT_ORDER.forEach(syncOneHandle);
  }

  function selectLayout(id) {
    if (!LAYOUT_GROUPS[id]) return;
    H.layoutSel = id;
    var cfg = H.layout[id];
    var scale = $('layScale');
    var scaleV = $('layScaleV');
    var show = $('layShow');
    var tabs = $('layTabs');
    if (tabs) {
      Array.prototype.forEach.call(tabs.children, function (b) {
        b.classList.toggle('on', b.getAttribute('data-lay') === id);
      });
    }
    if (scale) {
      scale.min = String(Math.round(LAYOUT_GROUPS[id].min * 100));
      scale.max = String(Math.round(LAYOUT_GROUPS[id].max * 100));
      scale.value = String(Math.round(cfg.s * 100));
    }
    if (scaleV) scaleV.textContent = Math.round(cfg.s * 100) + '%';
    if (show) show.textContent = cfg.v ? '隐藏此项' : '显示此项';
    syncLayoutHandles();
  }

  function buildLayoutHandles() {
    var box = $('layHandles');
    if (!box) return;
    box.innerHTML = '';
    layoutHandles = {};
    LAYOUT_ORDER.forEach(function (id) {
      var h = document.createElement('div');
      h.className = 'layHandle';
      h.setAttribute('data-lay', id);
      var tag = document.createElement('span');
      tag.className = 'layTag';
      h.appendChild(tag);
      var corner = document.createElement('span');
      corner.className = 'layCorner';
      h.appendChild(corner);
      h.addEventListener('pointerdown', function (event) {
        startLayoutDrag(event, id);
      });
      h.addEventListener('click', function (event) {
        event.preventDefault();
        selectLayout(id);
      });
      box.appendChild(h);
      layoutHandles[id] = h;
    });
    syncLayoutHandles();
  }

  function startLayoutDrag(event, id) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    selectLayout(id);
    var cfg = H.layout[id];
    var startX = event.clientX, startY = event.clientY;
    var originX = cfg.x, originY = cfg.y;
    var handle = layoutHandles[id];
    H.layoutDragging = true;
    try { if (handle) handle.setPointerCapture(event.pointerId); } catch (err) { /* 老浏览器 */ }
    function move(e) {
      if (e.cancelable) e.preventDefault();
      cfg.x = Math.round(originX + e.clientX - startX);
      cfg.y = Math.round(originY + e.clientY - startY);
      applyLayout();
      clampGroup(id);
      syncOneHandle(id);
    }
    function up() {
      H.layoutDragging = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      saveLayout();
      syncLayoutHandles();
    }
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function drawLayoutPreview() {
    // 菜单里游戏不在跑，HUD 画布是空的；画个静态样本，拖位置时看得见尺寸。
    try {
      var fake = {
        speedKmh: 188, gear: 4, autoShift: true,
        engineRpm: 6400, spec: { redline: 9000 }, driftScore: 0,
      };
      if (typeof UI !== 'undefined' && UI.drawGauge) UI.drawGauge(fake);
      if (typeof UI !== 'undefined' && UI.els) {
        if (UI.els.speedNum) UI.els.speedNum.textContent = '188';
        if (UI.els.gear) UI.els.gear.textContent = 'D4';
        if (UI.els.rpmFill) UI.els.rpmFill.style.width = '71%';
        if (UI.els.score) UI.els.score.textContent = '1280';
      }
    } catch (err) { /* 预览失败不能影响编辑 */ }
    try {
      var cv = $('minimap');
      var ctx = typeof UI !== 'undefined' ? UI.minimapCtx : null;
      if (!cv || !ctx) return;
      var S = cv.width, c = S / 2;
      ctx.clearRect(0, 0, S, S);
      ctx.fillStyle = 'rgba(9,18,27,.55)';
      ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = 'rgba(120,220,200,.75)';
      ctx.lineWidth = S * 0.035;
      ctx.beginPath();
      ctx.moveTo(S * 0.18, S * 0.74);
      ctx.quadraticCurveTo(S * 0.40, S * 0.18, S * 0.78, S * 0.34);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,210,94,.9)';
      ctx.lineWidth = S * 0.02;
      ctx.beginPath();
      ctx.moveTo(S * 0.18, S * 0.74);
      ctx.lineTo(S * 0.44, S * 0.58);
      ctx.stroke();
      ctx.fillStyle = '#ff2f87';
      ctx.beginPath(); ctx.arc(c, c, S * 0.045, 0, Math.PI * 2); ctx.fill();
    } catch (err) { /* 同上 */ }
  }

  function collapseLayoutPanel(collapsed) {
    H.layoutCollapsed = Boolean(collapsed);
    var bar = $('layoutBar');
    var reopen = $('layReopen');
    if (bar) bar.classList.toggle('hidden', H.layoutCollapsed);
    if (reopen) reopen.classList.toggle('hidden', !H.layoutCollapsed);
  }

  function openLayoutEditor() {
    if (!H.touch) return;
    if (H.layoutEditing) return;
    if (H.racing || H.starting) {
      if (PUI && PUI.toast) PUI.toast('比赛结束后再调整布局');
      return;
    }
    H.layoutEditing = true;
    H.layoutSel = 'map';
    H.layoutDragging = false;
    document.body.classList.add('layout-editing');
    var menu = $('menu');
    var hud = $('hud');
    var root = $('horizonTouch');
    var editor = $('layoutEditor');
    if (menu) menu.classList.add('hidden');
    if (hud) hud.classList.remove('hidden');
    if (root) {
      root.classList.remove('hidden');
      root.setAttribute('aria-hidden', 'false');
      H.touchShown = true;
    }
    if (editor) editor.classList.remove('hidden');
    collapseLayoutPanel(false);
    drawLayoutPreview();
    buildLayoutHandles();
    selectLayout(H.layoutSel);
  }

  function closeLayoutEditor() {
    if (!H.layoutEditing) return;
    H.layoutEditing = false;
    H.layoutDragging = false;
    document.body.classList.remove('layout-editing');
    var menu = $('menu');
    var hud = $('hud');
    var root = $('horizonTouch');
    var editor = $('layoutEditor');
    if (editor) editor.classList.add('hidden');
    if (hud) hud.classList.add('hidden');
    if (menu) menu.classList.remove('hidden');
    if (root) {
      root.classList.add('hidden');
      root.setAttribute('aria-hidden', 'true');
    }
    H.touchShown = false;
    clearTouchKeys();
    saveLayout();
    collapseLayoutPanel(false);
    updateTouchVisibility();
  }

  function bindLayoutEditor() {
    var btn = $('btnLayout');
    if (btn) {
      btn.classList.toggle('hidden', !H.touch);
      btn.addEventListener('click', openLayoutEditor);
    }
    var tabs = $('layTabs');
    if (tabs) {
      Array.prototype.forEach.call(tabs.children, function (b) {
        b.addEventListener('click', function () { selectLayout(b.getAttribute('data-lay')); });
      });
    }
    var scale = $('layScale');
    if (scale) scale.addEventListener('input', function () {
      var cfg = H.layout[H.layoutSel];
      cfg.s = clampNum(Number(scale.value) / 100, LAYOUT_GROUPS[H.layoutSel].min, LAYOUT_GROUPS[H.layoutSel].max);
      var scaleV = $('layScaleV');
      if (scaleV) scaleV.textContent = Math.round(cfg.s * 100) + '%';
      applyLayout();
      clampGroup(H.layoutSel);
      saveLayout();
    });
    var show = $('layShow');
    if (show) show.addEventListener('click', function () {
      var cfg = H.layout[H.layoutSel];
      cfg.v = !cfg.v;
      applyLayout();
      selectLayout(H.layoutSel);
      saveLayout();
    });
    var nudge = document.querySelector('.layNudge');
    if (nudge) {
      Array.prototype.forEach.call(nudge.querySelectorAll('button'), function (b) {
        b.addEventListener('click', function () {
          var cfg = H.layout[H.layoutSel];
          var dir = b.getAttribute('data-nudge');
          var step = 8;
          if (dir === 'left') cfg.x -= step;
          if (dir === 'right') cfg.x += step;
          if (dir === 'up') cfg.y -= step;
          if (dir === 'down') cfg.y += step;
          applyLayout();
          clampGroup(H.layoutSel);
          saveLayout();
        });
      });
    }
    var reset = $('layReset');
    if (reset) reset.addEventListener('click', function () {
      H.layout = defaultLayout();
      applyLayout();
      selectLayout(H.layoutSel);
      saveLayout();
      if (PUI && PUI.toast) PUI.toast('已恢复默认布局');
    });
    var done = $('layDone');
    if (done) done.addEventListener('click', closeLayoutEditor);
    var collapse = $('layCollapse');
    if (collapse) collapse.addEventListener('click', function () { collapseLayoutPanel(true); });
    var reopen = $('layReopen');
    if (reopen) reopen.addEventListener('click', function () { collapseLayoutPanel(false); });
    window.addEventListener('resize', function () {
      if (!H.layoutEditing) return;
      applyLayout();
      syncLayoutHandles();
    });
    window.addEventListener('orientationchange', function () {
      if (!H.layoutEditing) return;
      setTimeout(function () {
        if (!H.layoutEditing) return;
        applyLayout();
        syncLayoutHandles();
      }, 260);
    });
  }

  /* ============================== 启动 ============================== */

  function boot() {
    if (H.booted) return;
    if (!P || !PUI || !Net || !Room || typeof Game === 'undefined' || typeof MAPS === 'undefined' || typeof CAR_SPECS === 'undefined') {
      setTimeout(boot, 120);
      return;
    }
    H.booted = true;
    H.touch = isCoarse() || /[?&]touch=1(?:&|$)/.test(location.search);
    if (H.touch) document.body.classList.add('frp-touch-hud');
    H.layout = loadLayout();
    patchGame();
    buildTouch();
    applyLayout();
    window.addEventListener('resize', function () {
      if (H.touch) positionRacePanel();
    });
    window.addEventListener('orientationchange', function () {
      setTimeout(positionRacePanel, 260);
    });
    mountRoom();
    bindUi();
    Net.on(T.READY, updateAccount);
    Net.on(T.ROOM_STATE, onRoomState);
    if (Net.me) H.selfId = Net.me.id;
    updateAccount();
    requestAnimationFrame(frame);

    // 只给自动化测试/排障用：不改游戏逻辑，也不影响正常玩家。
    window.__FrpHorizon = {
      state: H,
      openLobby: openLobby,
      closeLobby: closeLobby,
      startRace: startRace,
      stopRace: stopRace,
      collide: collideGhost,
      openLayout: openLayoutEditor,
      closeLayout: closeLayoutEditor,
    };
  }

  /**
   * 把上游"有赛事代码但被关掉"的入口接回来。
   *
   * 只包两个方法：
   *   finishRace：上游负责显示成绩；我们额外把"完赛/名次"报给平台和 relay。
   *   toMenu：联机比赛里按 Esc 回主菜单时，把联机大厅浮出来（不偷偷退房）。
   */
  function patchGame() {
    var origFinish = Game.finishRace;
    Game.finishRace = function () {
      var wasRacing = H.racing && !H.finished;
      var time = this.raceTime;
      // 上游的排名是"玩家 arc vs 人机 progress"；联机时人机为空，会变成永远第 1。
      // 冲线这一刻用我们自己算的联机名次覆盖它。
      if (wasRacing) this.racePosition = H.rank || this.racePosition;
      var result = origFinish.apply(this, arguments);
      if (wasRacing) onLocalFinish(time);
      return result;
    };

    // UI.update 在每个主循环帧的最后调用；在这里把联机名次写回 HUD，
    // 避免上游那段"没有人机就第 1"的排名覆盖我们（见 updateRank 的注释）。
    var origUIUpdate = UI.update;
    UI.update = function (dt, car, world, traffic, game) {
      if (H.racing) {
        game.racePosition = H.rank || game.racePosition;
        if (H.racers.length) game.raceTotal = H.racers.length;
      }
      return origUIUpdate.apply(this, arguments);
    };

    var origToMenu = Game.toMenu;
    Game.toMenu = function () {
      var result = origToMenu.apply(this, arguments);
      if (!H.internalMenu && (H.racing || H.starting)) {
        // 玩家自己在比赛里退回主菜单 = 这局不跑了。本地立刻收车，并在平台上记 DNF，
        // 否则服务器会一直等他冲线，其他人永远等不到结算。
        var wasInMatch = Boolean(Net.room && Net.room.game === 'horizon' && Net.room.phase === 'playing');
        stopRace({ toMenu: false });
        if (wasInMatch) Net.send(T.ROOM_ACT, { act: { type: 'dnf' } });
        openLobby();
      }
      return result;
    };
  }

  function bindUi() {
    bindLayoutEditor();
    var btn = $('btnOnline');
    if (btn) btn.addEventListener('click', function () {
      // 用户点击是浏览器允许创建 AudioContext 的时机；顺手把音频叫醒。
      try { AudioSys.init(); AudioSys.resume(); } catch (err) { /* 单机也能玩 */ }
      openLobby();
    });
    var close = $('horizonLobbyClose');
    if (close) close.addEventListener('click', function () {
      // 只收起面板，**不退房**：给玩家回主菜单换车/看风景的机会。
      // 真要退房，用面板底部的「离开」（平台标准按钮）。
      H.lobbyDismissed = true;
      closeLobby();
    });
    window.addEventListener('pagehide', function () {
      if (H.racing) closeRelay(true);
    });
  }

  function updateAccount() {
    var box = $('horizonAccount');
    if (!box) return;
    if (Net.me && Net.me.id) {
      H.selfId = Net.me.id;
      box.textContent = '当前账号：' + Net.me.name + '（与平台首页同一个账号）';
    } else {
      box.textContent = '正在读取平台账号…';
    }
  }

  /* ============================== 平台房间面板 ============================== */

  function mountRoom() {
    if (H.mounted) return;
    H.mounted = true;
    Room.mount({
      container: $('online-panel'),
      game: 'horizon',
      minPlayers: 1,
      options: { map: 'alpine' },
      renderSetup: renderSetup,
      renderGame: renderGame,
    });
    Room.handleInvites({
      goToGame: goToGame,
      gameTitle: function (slug) {
        return slug === 'horizon' ? '地平线赛车' : slug;
      },
    });
  }

  /** 房主的设置区：只选地图（车在游戏主菜单里选，每人自己的车）。 */
  function renderSetup(host, ctx) {
    // ⚠️ FrpRoom 传进来的是**已经插在页面里的容器**，不是让你返回一个新节点。
    // （第一版写成了 `var box = el('div')` 再 return，结果地图选择器根本看不见。）
    var box = host;
    box.style.display = 'block';
    box.style.lineHeight = '1.7';
    box.appendChild(el('div', {
      text: '地图由房主选；开始后所有人自动切到这张图。每人在主菜单选自己的车，联机车与车会真实碰撞。',
    }));

    if (!ctx.isHost) {
      box.appendChild(el('div', {
        style: 'margin-top:6px;color:#9aa8bb;',
        text: '等房主选图并开始。',
      }));
      return box;
    }

    var row = el('div', { class: 'map-pick-row', style: 'margin-top:10px;' });
    var current = (ctx.options && ctx.options.map) || 'alpine';
    MAPS.forEach(function (m) {
      var on = m.id === current;
      row.appendChild(el('button', {
        type: 'button',
        class: 'frp-btn map-pick' + (on ? ' frp-btn-primary is-on' : ''),
        onclick: function () { ctx.setOption('map', m.id); },
      }, m.name));
    });
    box.appendChild(row);

    box.appendChild(el('div', {
      style: 'margin-top:8px;color:#9aa8bb;',
      text: '人数 ' + (ctx.seats || 0) + ' / ' + (ctx.maxSeats || 8) + '。手机端开始比赛后会自动出现触屏按键。',
    }));
    return box;
  }

  /** 对局中/结束时的面板内容。真正比赛时大厅是藏起来的，这里只在回到菜单/结束时看到。 */
  function renderGame(host, view, ctx) {
    // 同上：画进 FrpRoom 给的容器，不要返回新节点。
    var box = host;
    if (!view) {
      box.appendChild(el('p', { class: 'frp-room-note', text: '地图加载中…' }));
      return box;
    }
    var results = Array.isArray(view.results) ? view.results : [];
    var racers = Array.isArray(view.racers) ? view.racers : [];
    var byId = {};
    racers.forEach(function (r) { byId[r.id] = r; });

    box.appendChild(el('p', {
      class: 'frp-room-note',
      text: '地图：' + mapName(view.map) + ' · ' + racers.length + ' 辆车 · '
        + (view.phase === 'over' ? '比赛结束' : '比赛进行中'),
    }));

    if (view.phase === 'over') {
      var list = el('ol', { class: 'race-results' });
      results.forEach(function (r) {
        var mine = Net.me && r.id === Net.me.id;
        list.appendChild(el('li', { class: mine ? 'me' : '' }, [
          el('span', { class: 'pos', text: r.dnf ? 'DNF' : '#' + r.order }),
          el('span', { class: 'who' + (r.dnf ? ' dnf' : ''), text: (byId[r.id] ? byId[r.id].name : r.name) + (mine ? '（你）' : '') }),
          el('span', { class: 'time', text: r.dnf ? '未完赛' : clock(r.time) }),
        ]));
      });
      if (!results.length) {
        box.appendChild(el('p', { class: 'frp-room-note', text: '这局没有记录到完赛成绩。' }));
      } else {
        box.appendChild(list);
      }
      box.appendChild(el('p', {
        class: 'frp-room-note',
        text: '房主点「再来一局」回到准备区；换图后所有人会重新切图。',
      }));
      return box;
    }

    // 进行中：还没完赛的人列出来
    var playing = racers.filter(function (r) {
      return !results.some(function (x) { return x.id === r.id; });
    });
    if (playing.length) {
      box.appendChild(el('p', {
        class: 'frp-room-note',
        text: '还在跑：' + playing.map(function (r) { return r.name; }).join('、'),
      }));
    }
    box.appendChild(el('p', {
      class: 'frp-room-note',
      text: '比赛已经开始。如果你回到了这个面板，说明你已离开赛道；点「离开」结束你的本局。',
    }));
    return box;
  }

  function goToGame(game, code) {
    if (!game) return;
    var coarse = isCoarse();
    var url;
    if (game === 'horizon') url = coarse ? '/play/horizon' : '/games/horizon/';
    else if (game === 'noname') url = coarse ? '/play/noname' : '/noname/';
    else if (game === 'ddz') url = '/ddz/';
    else if (game === 'monopoly') url = coarse ? '/play/monopoly' : '/games/monopoly/';
    else if (game === 'mahjong') url = coarse ? '/play/mahjong' : '/mahjong/';
    else if (game === 'werewolf') url = '/werewolf/join';
    else url = '/games/' + encodeURIComponent(game) + '/';

    if (code) {
      if (game === 'noname') url += '?frpJoin=' + encodeURIComponent(code);
      else if (game === 'werewolf') url += '?number=' + encodeURIComponent(code);
      else url += '?join=' + encodeURIComponent(code);
    }
    window.open(url, '_blank', 'noopener');
  }

  /* ============================== 大厅 ============================== */

  function openLobby() {
    var node = $('horizonLobby');
    if (!node) return;
    node.classList.remove('hidden');
    H.lobbyOpen = true;
    H.lobbyDismissed = false;
    updateAccount();
  }

  function closeLobby() {
    var node = $('horizonLobby');
    if (node) node.classList.add('hidden');
    H.lobbyOpen = false;
  }

  function leaveAndClose() {
    if (H.racing || H.starting) stopRace({ toMenu: true, keepLobby: false });
    if (Net.room && Net.room.game === 'horizon') Net.send(T.ROOM_LEAVE, {});
    H.lobbyDismissed = false;
    closeLobby();
  }

  function onRoomState() {
    var r = Net.room;
    if (!r || r.game !== 'horizon') {
      if (H.racing || H.starting) stopRace({ toMenu: true, keepLobby: false });
      if (!r) {
        H.roomCode = '';
        H.lobbyDismissed = false;
        if (H.lobbyOpen) closeLobby();
      }
      return;
    }

    H.roomCode = r.code;
    if (r.phase === 'waiting') {
      if (H.racing || H.starting) stopRace({ toMenu: true, keepLobby: false });
      if (Game.state !== 'menu' && Game.state !== 'boot') {
        H.internalMenu = true;
        try { Game.toMenu(); } catch (err) { /* 忽略 */ }
        H.internalMenu = false;
      }
      if (!H.lobbyDismissed) openLobby();
      return;
    }

    if (r.phase === 'playing') {
      H.view = r.view;
      if (r.view) {
        // 有人中途离开：座位/成绩以服务器视图为准，别继续拿旧列表排名。
        H.racers = Array.isArray(r.view.racers) ? r.view.racers.slice() : H.racers;
        (r.view.results || []).forEach(function (x) { H.results.set(x.id, x); });
        H.ghosts.forEach(function (g, id) {
          if (!H.racers.some(function (x) { return x.id === id; })) removeGhost(id);
        });
      }
      H.lobbyDismissed = false;
      closeLobby();
      if (!H.racing && !H.starting && r.view) startRace(r.view);
      return;
    }

    if (r.phase === 'over') {
      H.view = r.view;
      if (H.racing || H.starting) stopRace({ toMenu: true, keepLobby: false });
      H.lobbyDismissed = false;
      openLobby();
    }
  }

  /* ============================== 比赛 ============================== */

  function waitFor(check, timeoutMs, stepMs) {
    return new Promise(function (resolve, reject) {
      var startedAt = Date.now();
      (function tick() {
        var ok = false;
        try { ok = check(); } catch (err) { ok = false; }
        if (ok) { resolve(); return; }
        if (Date.now() - startedAt > timeoutMs) { reject(new Error('等待超时')); return; }
        setTimeout(tick, stepMs || 120);
      })();
    });
  }

  function pickRoute(world) {
    var routes = (world.trafficRoutes || []).filter(function (r) {
      return r && r.samples && r.samples.length > 20;
    });
    if (!routes.length) return null;
    return routes.find(function (r) { return r.id === 'coast'; })
      || routes.find(function (r) { return r.id === 'ring'; })
      || routes.slice().sort(function (a, b) { return (b.length || 0) - (a.length || 0); })[0];
  }

  async function startRace(view) {
    if (H.racing || H.starting) return;
    if (H.layoutEditing) closeLayoutEditor();
    var seq = ++H.raceSeq;
    H.starting = true;
    H.view = view;
    H.selfId = (Net.me && Net.me.id) || H.selfId;
    H.racers = Array.isArray(view.racers) ? view.racers.slice() : [];
    H.map = view.map || 'alpine';
    H.results = new Map();
    H.localOrder = 0;
    H.rank = 1;
    H.finished = false;
    H.started = false;
    H.suspended = false;

    try {
      await waitFor(function () {
        return Game.state === 'menu' && Game.world && Game.car;
      }, 90_000);
      if (seq !== H.raceSeq) return;

      var idx = MAPS.findIndex(function (m) { return m.id === H.map; });
      if (idx < 0) idx = 0;
      if (Game.mapIndex !== idx) {
        if (Game.state !== 'menu') {
          H.internalMenu = true;
          try { Game.toMenu(); } catch (err) { /* 忽略 */ }
          H.internalMenu = false;
        }
        await Game.switchMap(idx);
        if (seq !== H.raceSeq) return;
        await waitFor(function () {
          return Game.state === 'menu' && Game.world && Game.car;
        }, 90_000);
        if (seq !== H.raceSeq) return;
      }

      if (Game.state !== 'menu') {
        H.internalMenu = true;
        try { Game.toMenu(); } catch (err) { /* 忽略 */ }
        H.internalMenu = false;
      }
      if (seq !== H.raceSeq) return;

      var route = pickRoute(Game.world);
      if (!route) throw new Error('这张地图没有可用赛道');
      H.route = route;

      Game.start('free');           // 上游把 state 切到 driving，并复位车
      setupRace(view, route);       // 赛事字段/检查点/拱门/幽灵车
      placeLocalCar(view, route);   // start() 会把车放回 startLine，这里再放到发车格
      connectRelay();
      H.racing = true;
      H.starting = false;

      UI.bigMsg('联机竞速', '等待所有车就位…', true);
      PUI.toast('联机竞速：' + mapName(H.map) + ' · ' + H.racers.length + ' 辆车', 'ok');
    } catch (err) {
      if (seq !== H.raceSeq) return;
      H.starting = false;
      H.racing = false;
      try { console.error('[horizon] 联机比赛启动失败', err); } catch (e2) { /* 忽略 */ }
      PUI.toast('联机比赛启动失败：' + (err && err.message ? err.message : '未知错误'), 'error', 6000);
      H.internalMenu = true;
      try { Game.toMenu(); } catch (e3) { /* 忽略 */ }
      H.internalMenu = false;
      openLobby();
    }
  }

  function setupRace(view, route) {
    var arr = route.samples;
    var stepN = Math.max(1, Math.floor(arr.length / 30));
    Game.raceActive = true;
    Game.raceStarted = false;
    Game.raceCountdown = 0;
    Game.raceTime = 0;
    Game.raceCpIdx = 0;
    Game.raceCpNext = 0;
    Game.racePlayerIdx = 0;
    Game.racePlayerArc = 0;
    Game.racePosition = 1;
    Game.raceFinishPos = 0;
    Game.raceTotal = H.racers.length || 1;
    Game.mode = 'online';

    Game.raceCheckpoints = [];
    for (var i = stepN; i < arr.length; i += stepN) {
      Game.raceCheckpoints.push({ x: arr[i].x, z: arr[i].z });
    }
    var last = arr[arr.length - 1];
    var tail = Game.raceCheckpoints[Game.raceCheckpoints.length - 1];
    if (!tail || Math.hypot(tail.x - last.x, tail.z - last.z) > 18) {
      Game.raceCheckpoints.push({ x: last.x, z: last.z });
    }

    Game.oppRoute = route;
    Game.opponents = [];
    Game.racePar = (route.length || last.d || 3000) / 48 * 3.6;

    buildGates(route);
    buildGhosts(route);
    H.lastProgress = 0;
    H.lastPosAt = 0;
    H.lastCollisionAt = 0;
  }

  function gridPose(route, index) {
    var arr = route.samples;
    var s0 = arr[0];
    var s1 = arr[Math.min(1, arr.length - 1)];
    var yaw = Math.atan2(s1.x - s0.x, s1.z - s0.z);
    var fx = Math.sin(yaw), fz = Math.cos(yaw);
    var rx = Math.cos(yaw), rz = -Math.sin(yaw);
    var row = Math.floor(index / 2);
    var col = index % 2;
    var back = 3.2 + row * 5.2;
    var lane = (col === 0 ? -1 : 1) * 2.7;
    return {
      x: s0.x - fx * back + rx * lane,
      z: s0.z - fz * back + rz * lane,
      yaw: yaw,
    };
  }

  function placeLocalCar(view, route) {
    var selfIdx = view.racers.findIndex(function (r) { return r.id === H.selfId; });
    if (selfIdx < 0) selfIdx = 0;
    var pose = gridPose(route, selfIdx);
    var y = Game.world.terrainHeight(pose.x, pose.z);
    Game.car.reset(new THREE.Vector3(pose.x, y, pose.z), pose.yaw);
    Game.camPos.set(pose.x - Math.sin(pose.yaw) * 4, y + 4, pose.z - Math.cos(pose.yaw) * 4);
    Game.camLook.set(pose.x, y + 1, pose.z);
  }

  /* ============================== 幽灵车 ============================== */

  function makeLabel(text) {
    var canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 64);
    ctx.fillStyle = 'rgba(7, 12, 19, .72)';
    ctx.strokeStyle = 'rgba(120, 210, 255, .85)';
    ctx.lineWidth = 2;
    var r = 14;
    ctx.beginPath();
    ctx.moveTo(r, 2); ctx.lineTo(254 - r, 2); ctx.quadraticCurveTo(254, 2, 254, 2 + r);
    ctx.lineTo(254, 62 - r); ctx.quadraticCurveTo(254, 62, 254 - r, 62);
    ctx.lineTo(r, 62); ctx.quadraticCurveTo(2, 62, 2, 62 - r);
    ctx.lineTo(2, 2 + r); ctx.quadraticCurveTo(2, 2, r, 2);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#eaf6ff';
    ctx.font = '700 26px "Microsoft YaHei", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var label = String(text || '玩家');
    if (label.length > 8) label = label.slice(0, 7) + '…';
    ctx.fillText(label, 128, 33);
    var tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false,
    }));
    sprite.scale.set(3.4, 0.85, 1);
    sprite.position.set(0, 2.35, 0);
    return sprite;
  }

  function createGhost(racer, index, carId) {
    var route = H.route;
    if (!route || !Game.scene || !Game.world) return null;
    var spec = CAR_SPECS.find(function (s) { return s.id === carId; }) || CAR_SPECS[0];
    var car = new Car(spec, Game.scene, Game.world);
    // 幽灵车只保留外观：不要物理车身、不要车灯（8 辆车 16 盏聚光灯会拖垮手机）。
    try { car.destroy(); } catch (err) { /* 已经不在物理世界 */ }
    (car.headLights || []).forEach(function (l) { if (l.parent) l.parent.remove(l); });
    if (car.interiorLight && car.interiorLight.parent) car.interiorLight.parent.remove(car.interiorLight);
    car.visual.traverse(function (o) {
      if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; }
    });
    var label = makeLabel(racer.name);
    car.visual.add(label);

    var pose = gridPose(route, index);
    var y = Game.world.terrainHeight(pose.x, pose.z);
    var pos = new THREE.Vector3(pose.x, y, pose.z);
    car.visual.position.copy(pos);
    car.visual.quaternion.setFromEuler(new THREE.Euler(0, pose.yaw, 0));

    return {
      car: car,
      specId: spec.id,
      racer: racer,
      target: pos.clone(),
      yaw: pose.yaw,
      renderYaw: pose.yaw,
      progress: 0,
      vx: 0,
      vz: 0,
      speed: 0,
      lastAt: 0,
      label: label,
    };
  }

  function buildGhosts(route) {
    removeGhosts();
    if (!H.selfId) return;
    H.racers.forEach(function (racer, index) {
      if (racer.id === H.selfId) return;
      var ghost = createGhost(racer, index, '');
      if (ghost) H.ghosts.set(racer.id, ghost);
    });
  }

  function rebuildGhost(id, carId) {
    var ghost = H.ghosts.get(id);
    if (!ghost || !carId || ghost.specId === carId) return;
    var index = H.racers.findIndex(function (r) { return r.id === id; });
    if (index < 0) return;
    // 换车模型时保留它已经跑到哪、朝哪：否则会在下一次 pos 之前闪回发车格。
    var keep = {
      target: ghost.target.clone(),
      yaw: ghost.yaw,
      renderYaw: ghost.renderYaw,
      progress: ghost.progress,
      vx: ghost.vx,
      vz: ghost.vz,
    };
    removeGhost(id);
    var next = createGhost(H.racers[index], index, carId);
    if (next) {
      next.target.copy(keep.target);
      next.yaw = keep.yaw;
      next.renderYaw = keep.renderYaw;
      next.progress = keep.progress;
      next.vx = keep.vx;
      next.vz = keep.vz;
      next.car.visual.position.set(keep.target.x, keep.target.y, keep.target.z);
      H.ghosts.set(id, next);
    }
  }

  function removeGhost(id) {
    var ghost = H.ghosts.get(id);
    if (!ghost) return;
    H.ghosts.delete(id);
    try {
      if (ghost.label) {
        if (ghost.label.material) {
          if (ghost.label.material.map) ghost.label.material.map.dispose();
          ghost.label.material.dispose();
        }
        if (ghost.label.parent) ghost.label.parent.remove(ghost.label);
      }
      if (ghost.car && ghost.car.visual) {
        if (ghost.car.visual.parent) ghost.car.visual.parent.remove(ghost.car.visual);
        ghost.car.destroy();
      }
    } catch (err) { /* 已经在场景外 */ }
  }

  function removeGhosts() {
    for (var id of Array.from(H.ghosts.keys())) removeGhost(id);
    H.ghosts.clear();
  }

  function updateGhosts(dt) {
    var k = 1 - Math.exp(-Math.max(0.001, dt) * 14);
    H.ghosts.forEach(function (g) {
      var p = g.car.visual.position;
      var d = p.distanceTo(g.target);
      if (d > 35) {
        p.copy(g.target);
      } else if (d > 0.001) {
        p.lerp(g.target, Math.min(1, k));
      }
      var diff = ((g.yaw - g.renderYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      g.renderYaw += diff * Math.min(1, k);
      if (!H.euler) H.euler = new THREE.Euler(0, 0, 0, 'YXZ');
      H.euler.set(0, g.renderYaw, 0);
      g.car.visual.quaternion.setFromEuler(H.euler);
      g.car.visual.position.y = p.y;

      if (Game.state === 'driving' && Game.car && !H.finished) collideGhost(g);
    });
  }

  /**
   * 车与车碰撞（用户明确要"真实碰撞"）。
   *
   * 每台客户端只负责**把自己的车**从对方车的位置推开；对方客户端做同一件事，
   * 所以看起来是两车互相弹开。为什么不做服务器权威物理：车在本地物理里跑，
   * 服务器没有完整的轮胎/悬挂状态，硬拉位置会变成橡皮筋。
   *
   * 碰撞体用"三圆胶囊"而不是一个大圆：一个大圆半径 4 米会让并排超车时被弹开。
   * 每辆车沿车头方向取前/中/后三个半径 0.98 米的圆，9 对圆里取最深的一对推开。
   */
  function collideGhost(g) {
    var c = Game.car;
    if (!c || !c.body) return;
    var gp = g.car.visual.position;
    if (Math.abs(c.pos.y - gp.y) > 2.6) return;

    var cy = c.yaw || 0;
    var gy = g.renderYaw || 0;
    var cfx = Math.sin(cy), cfz = Math.cos(cy);
    var gfx = Math.sin(gy), gfz = Math.cos(gy);
    var R = 0.98;
    var reach = 1.3;
    var best = null;

    for (var i = -1; i <= 1; i++) {
      var ax = c.pos.x + cfx * i * reach;
      var az = c.pos.z + cfz * i * reach;
      for (var j = -1; j <= 1; j++) {
        var bx = gp.x + gfx * j * reach;
        var bz = gp.z + gfz * j * reach;
        var dx = ax - bx, dz = az - bz;
        var d2 = dx * dx + dz * dz;
        if (d2 < (R * 2) * (R * 2) && (!best || d2 < best.d2)) {
          best = { dx: dx, dz: dz, d2: d2 };
        }
      }
    }
    if (!best) return;

    var d = Math.sqrt(best.d2);
    var nx, nz;
    if (d < 0.001) {
      // 两个圆心完全重合：没有"推开"的方向，就沿对方车头向后推。
      d = 0.001;
      nx = -gfx;
      nz = -gfz;
    } else {
      nx = best.dx / d;
      nz = best.dz / d;
    }
    var overlap = R * 2 - d;
    c.displace(nx * overlap * 0.82, nz * overlap * 0.82);

    var v = c.body.velocity;
    var rel = (v.x - (g.vx || 0)) * nx + (v.z - (g.vz || 0)) * nz;
    if (rel < 0) c.applyImpact(nx, nz, rel, 1.05);
    c.scaleHorizontalVelocity(0.997);

    var now = performance.now();
    if (now - H.lastCollisionAt > 260) {
      H.lastCollisionAt = now;
      Game.shake = Math.min(1.2, (Game.shake || 0) + 0.22);
      try { AudioSys.impact(0.35); } catch (err) { /* 静音也能玩 */ }
    }
  }

  /* ============================== 起终点拱门 ============================== */

  function gateTexture(text, checker) {
    var canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 256;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b1119';
    ctx.fillRect(0, 0, 1024, 256);
    if (checker) {
      var s = 32;
      for (var y = 0; y < 256; y += s) {
        for (var x = 0; x < 1024; x += s) {
          if (((x / s) + (y / s)) % 2 === 0) {
            ctx.fillStyle = '#f4f6f8';
            ctx.fillRect(x, y, s, s);
          }
        }
      }
      ctx.fillStyle = 'rgba(7, 12, 19, .78)';
      ctx.fillRect(0, 92, 1024, 72);
    }
    ctx.strokeStyle = checker ? '#ff2f87' : '#46c8ff';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, 1014, 246);
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 86px "Microsoft YaHei", "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 512, 130);
    var tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    return tex;
  }

  function buildGates(route) {
    removeGates();
    if (!Game.scene) return;
    var arr = route.samples;
    var start = arr[0];
    var s1 = arr[Math.min(1, arr.length - 1)];
    var yaw = Math.atan2(s1.x - start.x, s1.z - start.z);
    var closed = Boolean(route.closed);

    if (closed) {
      // 闭环赛道：起点和终点是同一根线，一根拱门写两行；但必须是格子旗终点样式。
      addGate(start, yaw, '起点 / 终点', true);
    } else {
      addGate(start, yaw, '起点 START', false);
      var end = arr[arr.length - 1];
      var e0 = arr[Math.max(0, arr.length - 2)];
      var endYaw = Math.atan2(end.x - e0.x, end.z - e0.z);
      addGate(end, endYaw, '终点 FINISH', true);
    }
  }

  function addGate(sample, yaw, text, checker) {
    var group = new THREE.Group();
    var y = (sample.h != null ? sample.h : Game.world.terrainHeight(sample.x, sample.z));
    group.position.set(sample.x, y, sample.z);
    group.rotation.y = yaw;

    var postMat = new THREE.MeshStandardMaterial({ color: checker ? 0xf2f4f6 : 0x46c8ff, roughness: 0.55, metalness: 0.15 });
    for (var side = -1; side <= 1; side += 2) {
      var post = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.32, 7.2, 10), postMat);
      post.position.set(side * 8.6, 3.6, 0);
      post.castShadow = false;
      group.add(post);
    }
    var beam = new THREE.Mesh(new THREE.BoxGeometry(17.4, 0.45, 0.45), postMat);
    beam.position.set(0, 7.0, 0);
    group.add(beam);

    var tex = gateTexture(text, checker);
    var banner = new THREE.Mesh(
      new THREE.PlaneGeometry(16.4, 2.4),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: false })
    );
    banner.position.set(0, 6.0, 0.05);
    // 车从 -Z 方向驶来；PlaneGeometry 正面朝 +Z，不转的话文字是反的。
    banner.rotation.y = Math.PI;
    group.add(banner);

    // 地面格子线（终点是黑白格；起点用一条青色线）
    var lineCanvas = document.createElement('canvas');
    lineCanvas.width = 512;
    lineCanvas.height = 64;
    var lctx = lineCanvas.getContext('2d');
    lctx.fillStyle = checker ? '#11161d' : '#0f2530';
    lctx.fillRect(0, 0, 512, 64);
    var unit = checker ? 32 : 64;
    for (var yy = 0; yy < 64; yy += unit) {
      for (var xx = 0; xx < 512; xx += unit) {
        if (!checker || ((xx / unit) + (yy / unit)) % 2 === 0) {
          lctx.fillStyle = checker ? '#f4f6f8' : '#46c8ff';
          lctx.fillRect(xx, yy, unit, unit);
        }
      }
    }
    var lineTex = new THREE.CanvasTexture(lineCanvas);
    var line = new THREE.Mesh(
      new THREE.PlaneGeometry(17.2, 1.8),
      new THREE.MeshBasicMaterial({ map: lineTex, transparent: true, opacity: 0.92, side: THREE.DoubleSide })
    );
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.08, 0);
    group.add(line);

    Game.scene.add(group);
    H.gates.push({ group: group, tex: tex, lineTex: lineTex });
  }

  function removeGates() {
    H.gates.forEach(function (g) {
      try {
        if (g.group.parent) g.group.parent.remove(g.group);
        g.group.traverse(function (o) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (o.material.map) o.material.map.dispose();
            o.material.dispose();
          }
        });
        if (g.tex) g.tex.dispose();
        if (g.lineTex) g.lineTex.dispose();
      } catch (err) { /* 忽略 */ }
    });
    H.gates = [];
  }

  /* ============================== 车位置中继 ============================== */

  function carId() {
    var spec = CAR_SPECS[UI.carIndex || 0] || CAR_SPECS[0];
    return spec.id;
  }

  function connectRelay() {
    closeRelay(true);
    H.wsClosedByUs = false;
    H.wsRetry = 0;
    openRelay();
  }

  function openRelay() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws;
    try {
      ws = new WebSocket(proto + '//' + location.host + '/horizon-relay');
    } catch (err) {
      scheduleRelayRetry();
      return;
    }
    H.ws = ws;
    ws.onopen = function () {
      if (H.ws !== ws) return;
      H.wsOpen = true;
      H.wsRetry = 0;
      ws.send(JSON.stringify({
        t: 'hello', code: H.roomCode, map: H.map, car: carId(),
      }));
    };
    ws.onmessage = function (event) {
      if (H.ws !== ws) return;
      var msg;
      try { msg = JSON.parse(event.data); } catch (err) { return; }
      onRelayMessage(msg);
    };
    ws.onclose = function () {
      // 旧连接被新连接顶掉时，它的 onclose 不能把新连接的 wsOpen 改成 false。
      if (H.ws !== ws) return;
      H.wsOpen = false;
      if (!H.wsClosedByUs && H.racing) {
        PUI.toast('联机连接断开，正在重连…', 'error', 4000);
        scheduleRelayRetry();
      }
    };
    ws.onerror = function () { /* onclose 会处理 */ };
  }

  function scheduleRelayRetry() {
    if (H.wsClosedByUs || !H.racing) return;
    H.wsRetry = Math.min(H.wsRetry + 1, 5);
    var wait = 800 + H.wsRetry * 900;
    setTimeout(function () {
      if (!H.wsClosedByUs && H.racing && !H.wsOpen) openRelay();
    }, wait);
  }

  function closeRelay(silent) {
    H.wsClosedByUs = true;
    var ws = H.ws;
    H.ws = null;
    H.wsOpen = false;
    if (!ws) return;
    try {
      if (ws.readyState === 1 && !silent) ws.send(JSON.stringify({ t: 'bye' }));
    } catch (err) { /* 已断 */ }
    try { ws.close(1000, '离开比赛'); } catch (err) { /* 已断 */ }
  }

  function relaySend(message) {
    if (!H.ws || !H.wsOpen || H.ws.readyState !== 1) return false;
    try {
      H.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      return false;
    }
  }

  function onRelayMessage(msg) {
    if (!msg || !msg.t) return;
    switch (msg.t) {
      case 'welcome':
        H.selfId = msg.selfId || H.selfId;
        if (msg.code) H.roomCode = msg.code;
        var alive = Object.create(null);
        (msg.peers || []).forEach(function (peer) {
          if (peer && peer.id && peer.id !== H.selfId) {
            alive[peer.id] = true;
            rebuildGhost(peer.id, peer.car);
          }
        });
        // 断线重连时，已经离开的人不会再有 peer-left；用欢迎名单清掉残留幽灵车。
        H.ghosts.forEach(function (g, id) {
          if (!alive[id]) removeGhost(id);
        });
        // 地图/车已经就位（车在 startRace 里就摆好了），告诉服务端可以倒计时。
        relaySend({ t: 'ready' });
        break;

      case 'peer':
        if (msg.id && msg.id !== H.selfId) {
          var racer = H.racers.find(function (r) { return r.id === msg.id; });
          if (!racer) {
            racer = { id: msg.id, name: msg.name || '玩家' };
            H.racers.push(racer);
          }
          if (!H.ghosts.has(msg.id)) {
            var idx = H.racers.findIndex(function (r) { return r.id === msg.id; });
            var ghost = createGhost(racer, idx, msg.car);
            if (ghost) H.ghosts.set(msg.id, ghost);
          } else {
            rebuildGhost(msg.id, msg.car);
          }
          PUI.toast((msg.name || '一名玩家') + ' 已进入比赛', 'ok');
        }
        break;

      case 'peer-left':
        if (msg.id) {
          var left = H.ghosts.get(msg.id);
          if (left && left.racer) PUI.toast(left.racer.name + ' 离开了比赛', 'info');
          removeGhost(msg.id);
        }
        break;

      case 'ready':
        break;

      case 'go':
        if (!H.started && H.racing) {
          H.started = true;
          Game.raceTime = 0;
          Game.raceCpIdx = 0;
          Game.raceCpNext = 0;
          Game.raceStarted = false;
          var delay = Math.max(0, Number(msg.delayMs) || 0);
          if (delay <= 160) {
            Game.raceCountdown = 0;
            Game.raceStarted = true;
            UI.bigMsg('出发!', '', true);
            setTimeout(function () { UI.hideMsg(); }, 900);
          } else {
            Game.raceCountdown = Math.max(0.05, delay / 1000);
            UI.bigMsg('联机竞速', '倒计时 ' + Math.ceil(delay / 1000) + ' 秒', true);
          }
        }
        break;

      case 'pos': {
        var g = H.ghosts.get(msg.id);
        if (!g) break;
        g.target.set(Number(msg.x) || 0, Number(msg.y) || 0, Number(msg.z) || 0);
        g.yaw = Number(msg.yaw) || 0;
        g.vx = Number(msg.vx) || 0;
        g.vz = Number(msg.vz) || 0;
        g.speed = Number(msg.speed) || 0;
        g.progress = Math.max(0, Math.min(1, Number(msg.progress) || 0));
        g.lastAt = performance.now();
        break;
      }

      case 'finish': {
        if (!msg.id) break;
        H.results.set(msg.id, {
          id: msg.id, order: Number(msg.order) || 0, time: Number(msg.time) || 0, dnf: false,
        });
        if (msg.id === H.selfId) {
          H.localOrder = Number(msg.order) || 0;
          if (H.localOrder) H.rank = H.localOrder;
        }
        var racer = H.racers.find(function (r) { return r.id === msg.id; });
        PUI.toast((racer ? racer.name : '一名玩家') + ' 完赛：第 ' + (msg.order || '?') + ' 名 · ' + clock(msg.time), 'ok');
        // 冲线瞬间本地算的名次可能不准；服务端 order 回来后在屏幕中央再报一次正确的。
        if (msg.id === H.selfId && H.finished) {
          UI.bigMsg('完赛', '第 ' + (msg.order || '?') + ' 名 · ' + clock(msg.time), true);
        }
        break;
      }

      case 'all-finished':
        if (isHost() && Net.room && Net.room.phase === 'playing') {
          setTimeout(function () {
            if (Net.room && Net.room.phase === 'playing') Net.send(T.ROOM_ACT, { act: { type: 'over' } });
          }, 2200);
        }
        break;

      case 'over':
        PUI.toast(msg.timeout ? '比赛超时，房主正在结算…' : '比赛结束', 'info', 4000);
        if (msg.timeout && isHost() && Net.room && Net.room.phase === 'playing') {
          Net.send(T.ROOM_ACT, { act: { type: 'over' } });
        }
        break;

      case 'error':
        if (msg.message) PUI.toast('联机：' + msg.message, 'error', 5000);
        break;

      default:
        break;
    }
  }

  function onLocalFinish(time) {
    if (!H.racing || H.finished) return;
    H.finished = true;
    H.lastProgress = 1;
    relaySend({ t: 'finish', time: time });
    if (Net.room && Net.room.game === 'horizon' && Net.room.phase === 'playing') {
      Net.send(T.ROOM_ACT, { act: { type: 'finish', time: time } });
    }
    PUI.toast('你已完赛，等待其他车…', 'ok', 4000);
    // 等一会儿还没结束就由房主宣布结束，避免有人卡在赛道外。
    setTimeout(function () {
      if (H.racing && isHost() && Net.room && Net.room.phase === 'playing'
        && Array.from(H.ghosts.keys()).every(function (id) { return H.results.has(id); })) {
        Net.send(T.ROOM_ACT, { act: { type: 'over' } });
      }
    }, 6000);
  }

  function stopRace(opts) {
    opts = opts || {};
    H.raceSeq += 1;      // 让还在 await 的 startRace 立刻作废
    H.racing = false;
    H.starting = false;
    H.started = false;
    H.finished = false;
    H.route = null;
    closeRelay(false);
    removeGhosts();
    removeGates();
    H.results = new Map();
    H.localOrder = 0;
    H.rank = 1;
    H.view = null;
    try {
      Game.raceActive = false;
      Game.raceStarted = false;
      Game.raceCountdown = 0;
      Game.raceTotal = 0;
      Game.opponents = [];
      Game.oppRoute = null;
    } catch (err) { /* boot 阶段 */ }
    if (opts.toMenu) {
      H.internalMenu = true;
      try { Game.toMenu(); } catch (err) { /* 忽略 */ }
      H.internalMenu = false;
    }
    if (opts.keepLobby) openLobby();
  }

  /* ============================== 排名 / 帧 ============================== */

  function updateRank() {
    if (!Game.raceActive && H.finished) {
      // 已经冲线：名次用 relay 返回的 order
      if (H.localOrder) H.rank = H.localOrder;
      Game.racePosition = H.rank;
      Game.raceTotal = H.racers.length || 1;
      return;
    }
    if (!Game.oppRoute) return;
    var selfProgress = 0;
    try { selfProgress = Game.playerRaceProgress(); } catch (err) { selfProgress = H.lastProgress; }
    H.lastProgress = Math.max(0, Math.min(1, selfProgress));

    var list = [{
      id: H.selfId,
      progress: H.finished ? 1 : H.lastProgress,
      order: H.finished ? (H.localOrder || 999) : 999,
      done: H.finished,
    }];
    H.ghosts.forEach(function (g, id) {
      var done = H.results.has(id);
      list.push({
        id: id,
        progress: done ? 1 : (g.progress || 0),
        order: done ? (H.results.get(id).order || 999) : 999,
        done: done,
      });
    });
    // 已经在房间里但还没连上中继的人也要算进总人数（否则 HUD 会从 2/2 变 1/1）。
    H.racers.forEach(function (r) {
      if (r.id === H.selfId || H.ghosts.has(r.id)) return;
      var done = H.results.has(r.id);
      list.push({
        id: r.id,
        progress: done ? 1 : 0,
        order: done ? (H.results.get(r.id).order || 999) : 999,
        done: done,
      });
    });

    list.sort(function (a, b) {
      if (a.done !== b.done) return a.done ? -1 : 1;
      if (a.done && b.done) return a.order - b.order;
      return b.progress - a.progress;
    });
    var myIndex = list.findIndex(function (x) { return x.id === H.selfId; });
    H.rank = myIndex < 0 ? 1 : myIndex + 1;
    Game.racePosition = H.rank;
    Game.raceTotal = list.length || 1;
  }

  function sendPos(now) {
    if (!H.started || H.finished || Game.state !== 'driving' || !Game.raceActive) return;
    if (now - H.lastPosAt < 80) return;
    H.lastPosAt = now;
    var c = Game.car;
    if (!c || !c.body) return;
    var v = c.body.velocity;
    relaySend({
      t: 'pos',
      x: c.pos.x, y: c.pos.y, z: c.pos.z,
      yaw: c.yaw,
      vx: v.x, vz: v.z,
      speed: c.speed || 0,
      progress: H.lastProgress || 0,
    });
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!H.lastFrame) H.lastFrame = now;
    var dt = Math.min(0.12, (now - H.lastFrame) / 1000);
    H.lastFrame = now;
    updateTouchVisibility();
    if (!H.racing) return;
    updateGhosts(dt);
    if (Game.state === 'driving' && Game.raceActive) {
      updateRank();
      sendPos(now);
    }
  }

  /* ============================== 手机触屏 ============================== */

  function keyButton(label, cls, code) {
    var btn = el('button', {
      type: 'button',
      class: 'hkey ' + (cls || ''),
      'aria-label': label,
      'data-code': code,
    }, label);
    btn.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      try { btn.setPointerCapture(event.pointerId); } catch (err) { /* 老浏览器 */ }
      if (!btn.classList.contains('on')) {
        btn.classList.add('on');
        H.touchKeys.push({ btn: btn, code: code });
        sendKey(code, true);
      }
    });
    function release(event) {
      if (event) event.preventDefault();
      if (!btn.classList.contains('on')) return;
      btn.classList.remove('on');
      var i = H.touchKeys.findIndex(function (k) { return k.btn === btn; });
      if (i >= 0) H.touchKeys.splice(i, 1);
      sendKey(code, false);
    }
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
    btn.addEventListener('contextmenu', function (event) { event.preventDefault(); });
    return btn;
  }

  function sendKey(code, down) {
    try {
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
        code: code, key: code, bubbles: true, cancelable: true,
      }));
    } catch (err) { /* 极老浏览器 */ }
  }

  function buildTouch() {
    if (H.touchBuilt) return;
    var root = $('horizonTouch');
    if (!root) return;
    H.touchBuilt = true;

    var left = el('div', { class: 'hzone left' }, [
      keyButton('‹', 'steer', 'KeyA'),
      keyButton('›', 'steer', 'KeyD'),
    ]);

    var right = el('div', { class: 'hzone right' }, [
      keyButton('手刹', 'hand', 'Space'),
      keyButton('刹车', 'brake', 'KeyS'),
      keyButton('油门', 'gas', 'KeyW'),
    ]);

    var top = el('div', { class: 'hzone top' }, [
      keyButton('视角', 'small', 'KeyC'),
      keyButton('复位', 'small warn', 'KeyR'),
      keyButton('暂停', 'small warn', 'Escape'),
      keyButton('喇叭', 'small', 'KeyH'),
      keyButton('升挡', 'small', 'KeyE'),
      keyButton('降挡', 'small', 'KeyQ'),
    ]);

    root.appendChild(left);
    root.appendChild(right);
    root.appendChild(top);
  }

  function clearTouchKeys() {
    H.touchKeys.slice().forEach(function (k) {
      k.btn.classList.remove('on');
      sendKey(k.code, false);
    });
    H.touchKeys = [];
  }

  function updateTouchVisibility() {
    var root = $('horizonTouch');
    if (!root) return;
    var show = H.touch && (H.layoutEditing || (Game && Game.state === 'driving' && !H.lobbyOpen));
    if (show !== H.touchShown) {
      H.touchShown = show;
      root.classList.toggle('hidden', !show);
      root.setAttribute('aria-hidden', show ? 'false' : 'true');
      if (!show) clearTouchKeys();
      if (show) positionRacePanel();
    }
  }

  /* ============================== 启动 ============================== */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();