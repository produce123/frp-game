/*
 * 平台通用「全屏」按钮。
 *
 * 规则（用户明确要求，2026-11 更新）：
 *   · **只在手机/平板（粗指针设备）显示**，电脑端不显示（电脑用 F11 / 浏览器自带全屏）；
 *   · **绝不自动进全屏** —— 只在用户点按钮时调用 Fullscreen API；
 *   · **进了全屏就把按钮藏起来**：手机上用系统返回键退出全屏，页面上不再出现
 *     「退出全屏」按钮（用户明确不喜欢那个按钮）；
 *   · 不支持全屏的浏览器（例如 iPhone Safari）不硬撑：不显示按钮，也不改页面布局；
 *   · 游戏页在 `/play/*` 伪横屏外壳的 iframe 里运行时，按钮由外壳负责，内层直接跳过；
 *   · `<body data-frp-fullscreen="landscape">` 的外壳页（手机伪横屏的四个游戏）点全屏时，
 *     会像大富翁一样**顺带锁成真横屏**（`screen.orientation.lock('landscape')`）；
 *     普通页面不加这个属性，全屏只放大、不转屏。
 *
 * 用法：在页面里加一行
 *   <script defer src="/shared/ui/fullscreen.js"></script>
 * 脚本会自己挂按钮、监听 fullscreenchange，并把接口暴露成
 *   window.FrpFullscreen = { supported, landscape, isActive(), toggle(), mount() }
 * 后续新游戏只要引这一行，不要自己写全屏逻辑，也不要自动 requestFullscreen。
 */
(function () {
  'use strict';

  if (window.FrpFullscreen) return;

  // 外壳页负责自己的全屏；iframe 里的游戏页不再重复挂按钮。
  if (window.self !== window.top) {
    window.FrpFullscreen = Object.freeze({
      supported: false,
      landscape: false,
      reason: 'iframe',
      isActive: function () { return false; },
      toggle: function () {},
      mount: function () {},
    });
    return;
  }

  var doc = document;
  var root = doc.documentElement;
  var request =
    root.requestFullscreen ||
    root.webkitRequestFullscreen ||
    root.msRequestFullscreen;
  var exit =
    doc.exitFullscreen ||
    doc.webkitExitFullscreen ||
    doc.msExitFullscreen;
  var getFullscreenElement = function () {
    return (
      doc.fullscreenElement ||
      doc.webkitFullscreenElement ||
      doc.msFullscreenElement ||
      null
    );
  };
  var fullscreenEnabled = doc.fullscreenEnabled;
  if (fullscreenEnabled === undefined) fullscreenEnabled = doc.webkitFullscreenEnabled;
  if (fullscreenEnabled === undefined) fullscreenEnabled = true;

  if (!request || !fullscreenEnabled) {
    window.FrpFullscreen = Object.freeze({
      supported: false,
      landscape: false,
      reason: 'unsupported',
      isActive: function () { return false; },
      toggle: function () {},
      mount: function () {},
    });
    return;
  }

  /*
   * 用户明确要求：**电脑端不要加这个按钮**，只在手机上显示。
   * 判据和 `/play/*` 外壳一致，只看 `(pointer: coarse)`：
   * 不看窗口宽度（电脑窗口缩窄不算手机），也不看 navigator.maxTouchPoints
   * （带触摸屏的 Windows 笔记本会被误判成手机）。
   */
  var coarsePointer =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches;
  if (!coarsePointer) {
    window.FrpFullscreen = Object.freeze({
      supported: false,
      landscape: false,
      reason: 'desktop',
      isActive: function () { return false; },
      toggle: function () {},
      mount: function () {},
    });
    return;
  }

  /*
   * 伪横屏外壳（/play/noname、/play/ddz、/play/monopoly、/play/mahjong）在 body 上标了
   * `data-frp-fullscreen="landscape"`：点全屏时除了 requestFullscreen，还要锁横屏。
   * 这就是"像大富翁一样进真横屏"：锁成功之后视口宽高对调，外壳的 layout() 不再旋转，
   * iframe 直接横着铺满；退出全屏时解锁，恢复竖屏旋转。
   */
  var landscape =
    Boolean(doc.body) && doc.body.getAttribute('data-frp-fullscreen') === 'landscape';

  function orientationOf() {
    try {
      return window.screen && window.screen.orientation ? window.screen.orientation : null;
    } catch (err) {
      return null;
    }
  }

  function lockLandscape() {
    if (!landscape) return;
    try {
      var so = orientationOf();
      if (!so || typeof so.lock !== 'function') return;
      var p = so.lock('landscape');
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (err) {
      // iOS / 桌面浏览器不支持锁屏方向：留在伪横屏即可，不要弹错误
    }
  }

  function unlockOrientation() {
    if (!landscape) return;
    try {
      var so = orientationOf();
      if (so && typeof so.unlock === 'function') so.unlock();
    } catch (err) {}
  }

  var button = null;
  var flashTimer = 0;

  function isActive() {
    return Boolean(getFullscreenElement());
  }

  function updateButton() {
    if (!button) return;
    var active = isActive();
    // 全屏时**整颗按钮消失**（用户要求：不再出现「取消全屏」，用手机返回键退出）。
    // 用 style.display 而不是 hidden 属性：`.frp-fullscreen-btn` 自己有 display，
    // 会盖掉浏览器默认的 `[hidden]{display:none}`。
    button.style.display = active ? 'none' : '';
    button.setAttribute('aria-hidden', active ? 'true' : 'false');
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.textContent = '⛶ 全屏';
    button.title = '进入全屏（退出请按手机返回键）';
  }

  function flash(text) {
    if (!button) return;
    clearTimeout(flashTimer);
    button.textContent = text;
    flashTimer = setTimeout(updateButton, 1600);
  }

  function toggle() {
    try {
      if (isActive()) {
        var p = exit ? exit.call(doc) : null;
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } else {
        var q = request.call(root);
        if (q && typeof q.then === 'function') {
          q.then(lockLandscape).catch(function () {
            // 浏览器可能因为不是用户手势 / 策略限制而拒绝；不要弹 alert。
            flash('浏览器不让全屏');
          });
        } else {
          lockLandscape();
        }
      }
    } catch (err) {
      flash('浏览器不让全屏');
    }
    // 成功的路径由 fullscreenchange 更新；这里兜底一次（部分旧浏览器不发事件）
    setTimeout(updateButton, 80);
  }

  function addStyle() {
    if (doc.getElementById('frp-fullscreen-style')) return;
    var style = doc.createElement('style');
    style.id = 'frp-fullscreen-style';
    style.textContent = [
      '.frp-fullscreen-btn {',
      '  position: fixed;',
      '  right: calc(12px + env(safe-area-inset-right, 0px));',
      '  bottom: calc(12px + env(safe-area-inset-bottom, 0px));',
      '  z-index: 2147483000;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  min-height: 44px;',
      '  padding: 0 14px;',
      '  border: 1px solid rgba(255, 255, 255, 0.22);',
      '  border-radius: 999px;',
      '  background: rgba(12, 16, 24, 0.72);',
      '  color: #eaf1ff;',
      '  font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;',
      '  letter-spacing: 0.02em;',
      '  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);',
      '  -webkit-backdrop-filter: blur(10px);',
      '  backdrop-filter: blur(10px);',
      '  cursor: pointer;',
      '  touch-action: manipulation;',
      '  -webkit-tap-highlight-color: transparent;',
      '}',
      '@media (hover: hover) {',
      '  .frp-fullscreen-btn:hover { background: rgba(30, 42, 62, 0.9); }',
      '}',
      '.frp-fullscreen-btn:focus-visible {',
      '  outline: 2px solid #7cc4ff;',
      '  outline-offset: 2px;',
      '}',
    ].join('\n');
    (doc.head || root).appendChild(style);
  }

  function onFullscreenChange() {
    if (!isActive()) unlockOrientation();
    updateButton();
  }

  function mount() {
    if (button) return;
    addStyle();

    button = doc.createElement('button');
    button.type = 'button';
    button.id = 'frp-fullscreen-btn';
    button.className = 'frp-fullscreen-btn';
    button.setAttribute('data-frp-fullscreen-btn', '');
    button.addEventListener('click', toggle);
    (doc.body || root).appendChild(button);

    doc.addEventListener('fullscreenchange', onFullscreenChange);
    doc.addEventListener('webkitfullscreenchange', onFullscreenChange);
    doc.addEventListener('MSFullscreenChange', onFullscreenChange);
    updateButton();
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  window.FrpFullscreen = Object.freeze({
    supported: true,
    landscape: landscape,
    isActive: isActive,
    toggle: toggle,
    mount: mount,
  });
})();