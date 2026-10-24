/*
 * 共用 UI 组件 —— 三个游戏与平台外壳共用（docs/DECISIONS.md D4：对外组件统一、
 * 视觉风格各自保留）。
 *
 * "风格各自保留"靠 **CSS 变量** 实现：本文件只负责行为与 DOM 结构，
 * 颜色/圆角/字体全部走 var(--ui-*, 兜底值)，页面自己的 CSS 覆盖变量即可。
 *
 * 用法：
 *   <link rel="stylesheet" href="/shared/ui/ui.css" />
 *   <script defer src="/shared/ui/ui.js"></script>
 *   FrpUI.toast('已加入房间');
 */
(function (root) {
  'use strict';

  var doc = root.document;

  /* ------------------------------ 提示条 ------------------------------ */

  var tray = null;

  function ensureTray() {
    if (tray && doc.body.contains(tray)) return tray;
    tray = doc.createElement('div');
    tray.className = 'frp-toasts';
    tray.setAttribute('role', 'status');
    tray.setAttribute('aria-live', 'polite');
    doc.body.appendChild(tray);
    return tray;
  }

  /**
   * 弹一条提示。
   * @param {string} text
   * @param {'info'|'ok'|'error'} [kind='info']
   * @param {number} [ms=2600] 停留毫秒；传 0 表示不自动消失
   */
  function toast(text, kind, ms) {
    var node = doc.createElement('div');
    node.className = 'frp-toast frp-toast-' + (kind || 'info');
    node.textContent = String(text == null ? '' : text);
    ensureTray().appendChild(node);

    // 下一帧才加 visible，这样过渡动画一定会播（而不是被合并掉）
    root.requestAnimationFrame(function () { node.classList.add('is-visible'); });

    var life = ms === undefined ? (kind === 'error' ? 4200 : 2600) : ms;
    if (life > 0) {
      root.setTimeout(function () { dismiss(node); }, life);
    }
    node.addEventListener('click', function () { dismiss(node); });
    return node;
  }

  function dismiss(node) {
    if (!node || !node.parentNode) return;
    node.classList.remove('is-visible');
    root.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 220);
  }

  /* ------------------------------ 剪贴板 ------------------------------ */

  /** 复制并顺手提示结果。失败时提示里带上内容，让用户手动抄。 */
  function copyText(text, label) {
    var what = label || '内容';
    return root.GameNet.copy(text).then(function (ok) {
      if (ok) toast('已复制' + what, 'ok');
      else toast('复制失败，请手动抄下：' + text, 'error', 6000);
      return ok;
    });
  }

  /* ------------------------------ 小工具 ------------------------------ */

  /** 建元素：el('div', { class: 'x' }, ['文本', 子元素]) */
  function el(tag, attrs, children) {
    var node = doc.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        var value = attrs[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.indexOf('on') === 0 && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value === true ? '' : value);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (child) {
        if (child === null || child === undefined || child === false) return;
        node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
      });
    }
    return node;
  }

  /** 清空一个容器。 */
  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  /** 简易确认框（浏览器原生 confirm 在部分场景被拦，这里给个统一入口）。 */
  function confirmText(message) {
    return root.confirm(message);
  }

  /* --------------------------- 偏好：音效 / 特效 --------------------------- */

  /*
   * 平台只有**一份**偏好，存在 localStorage 的 `frp.prefs` 里（JSON）。
   *
   * 为什么必须只有一份（用户点名要求）：平台外壳的"设置"栏和三个游戏里**都有**
   * 音效开关，各存各的就会出现"平台开着、游戏关了"或者反过来 —— 两处打架，
   * 用户看到的是"我明明在设置里关了，进游戏还是响"。所以游戏里那个开关现在只是
   * 这份偏好的**另一个入口**（写回来、并订阅变化）。
   *
   *   FrpUI.prefs.sound()        -> true/false
   *   FrpUI.prefs.fx()           -> true/false
   *   FrpUI.prefs.setSound(b) / setFx(b)      改并通知所有订阅者
   *   FrpUI.prefs.on(cb)         -> 退订函数；cb({ sound, fx })
   *
   * 老键（cg.sound / bs.sound / sg.sound 及其 fx）**只在第一次**读时用来定默认值，
   * 之后再也不看 —— 免得哪天删掉一个老键反而把用户后来的设置改回去。
   */

  var PREFS_KEY = 'frp.prefs';
  var LEGACY = [
    { sound: 'cg.sound', fx: 'cg.fx', off: '0' },
    { sound: 'bs.sound', fx: 'bs.fx', off: '0' },
    { sound: 'sg.sound', fx: 'sg.fx', off: 'off' },
  ];
  var prefsCache = null;
  var prefsSubs = [];

  function storage() {
    try { return root.localStorage || null; } catch (err) { return null; }
  }

  function reducedMotion() {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (err) { return false; }
  }

  /** 老键里有没有人明确关过。没有任何老键时返回 null（= 用默认值）。 */
  function legacyDefault(field) {
    var store = storage();
    if (!store) return null;
    var seen = false;
    var on = true;
    for (var i = 0; i < LEGACY.length; i++) {
      var raw = null;
      try { raw = store.getItem(LEGACY[i][field]); } catch (err) { raw = null; }
      if (raw === null || raw === undefined) continue;
      seen = true;
      if (raw === LEGACY[i].off) on = false;
    }
    return seen ? on : null;
  }

  function loadPrefs() {
    if (prefsCache) return prefsCache;
    var data = null;
    var store = storage();
    if (store) {
      try { data = JSON.parse(store.getItem(PREFS_KEY) || 'null'); } catch (err) { data = null; }
    }
    var legacySound = legacyDefault('sound');
    var legacyFx = legacyDefault('fx');
    prefsCache = {
      sound: data && typeof data.sound === 'boolean' ? data.sound : (legacySound === null ? true : legacySound),
      fx: data && typeof data.fx === 'boolean' ? data.fx : (legacyFx === null ? !reducedMotion() : legacyFx),
    };
    return prefsCache;
  }

  function savePrefs() {
    var store = storage();
    if (!store) return;
    try { store.setItem(PREFS_KEY, JSON.stringify(prefsCache)); } catch (err) { /* 隐私模式写不进去就算了 */ }
  }

  function notifyPrefs() {
    var snapshot = { sound: prefsCache.sound, fx: prefsCache.fx };
    prefsSubs.slice().forEach(function (cb) {
      try { cb(snapshot); } catch (err) { if (root.console) console.error('[FrpUI] 偏好订阅者出错', err); }
    });
  }

  var prefs = {
    sound: function () { return loadPrefs().sound; },
    fx: function () { return loadPrefs().fx; },
    setSound: function (on) {
      loadPrefs().sound = !!on;
      savePrefs();
      notifyPrefs();
    },
    setFx: function (on) {
      loadPrefs().fx = !!on;
      savePrefs();
      notifyPrefs();
    },
    /** 订阅变化。返回退订函数（页面卸载/重建时调一下，免得订阅者越堆越多）。 */
    on: function (cb) {
      prefsSubs.push(cb);
      return function () {
        var i = prefsSubs.indexOf(cb);
        if (i >= 0) prefsSubs.splice(i, 1);
      };
    },
  };

  /*
   * 平台**共用**的按钮音。三个游戏各有自己的音效包（音色是各自的调性），
   * 但平台外壳（游戏列表 / 设置栏）本来一个音效都没有，所以这里给一个统一的
   * "点一下"的声音 —— 音色刻意抄刀马那一版（620→420Hz 三角波 60ms），
   * 免得同一站里两种"点击感"。
   */
  var actx = null;

  function audioCtx() {
    if (!prefs.sound()) return null;
    var Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) return null;
    try {
      if (!actx) actx = new Ctx();
      if (actx.state === 'suspended' && actx.resume) actx.resume();
      return actx;
    } catch (err) { return null; }
  }

  /** 播一声共用按钮音。音效关掉/浏览器不给 WebAudio 时**静默返回 false**。 */
  function click() {
    var ctx = audioCtx();
    if (!ctx) return false;
    try {
      var t = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(620, t);
      osc.frequency.exponentialRampToValueAtTime(420, t + 0.06);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.28, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.08);
      return true;
    } catch (err) { return false; }
  }

  /*
   * 给一整块界面自动接上按钮音（平台外壳用；游戏有自己的音效包，不要调这个，
   * 否则同一下会响两声）。
   *
   * 只认真正能点的东西：button / a[href] / role=tab / 勾选框，以及显式标了
   * `data-frp-click` 的自定义控件；`disabled`、`[data-frp-nosound]`、以及
   * 被平台互动代理吃掉的 `[data-frp-avatar]` 一律静音。
   */
  var CLICK_SEL = 'button, a[href], [role="tab"], input[type="checkbox"], input[type="radio"], [data-frp-click]';

  function bindClicks(scope) {
    var host = scope || doc;
    if (!host || !host.addEventListener) return function () {};
    function onPointer(event) {
      if (event.defaultPrevented && event.type === 'click') return;
      var node = event.target;
      if (!node || !node.closest) return;
      var hit = node.closest(CLICK_SEL);
      if (!hit || hit.disabled) return;
      if (hit.closest('[data-frp-nosound]') || hit.closest('[data-frp-avatar]')) return;
      click();
    }
    // 用 pointerdown：比 click 早，且"按住拖动到别处再松开"这种误触不会响。
    host.addEventListener('pointerdown', onPointer, true);
    return function () { host.removeEventListener('pointerdown', onPointer, true); };
  }

  root.FrpUI = {
    toast: toast,
    copyText: copyText,
    el: el,
    clear: clear,
    confirmText: confirmText,
    prefs: prefs,
    sound: { click: click, bindClicks: bindClicks },
  };
})(typeof window !== 'undefined' ? window : globalThis);