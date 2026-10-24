/*
 * 斗地主 —— 页面主控（平台壳）。
 *
 * 这一版**牌桌是上游的 Godot 网页导出**（`table/`，来自 github.com/blmz/GODOT-DouDiZhu）。
 * 所以本文件只做四件事：
 *   1. 身份：名字/头像来自平台账号（页面上**没有**起昵称的输入框）；
 *   2. 房间：建房 / 进房 / 邀请好友 / 开始 / 离开 / 再来一局 —— 全部交给 `/shared/ui/room.js`；
 *   3. 联机：把 `room.state` 里那份**按人裁剪过的视图**塞给牌桌，把牌桌的意图发回服务器；
 *   4. 牌桌的加载/显示：牌桌是个 iframe（Godot 的导出），进对局时才露出来。
 *
 * ⛔ 这里**不跑规则**：牌型、谁能出、谁赢了全在服务器（`games/ddz/js/engine/**`）。
 *    页面上也没有任何"本地预演"。
 *
 * 【和牌桌之间的约定（改 GDScript 那边也要看这里）】
 *   页面 → 牌桌   window.FrpDdzTable.推视图(JSON 字符串)
 *   牌桌 → 页面   window.FrpDdzHost.动作(JSON 字符串)   {type:'bid'|'play'|'pass', …}
 *                 window.FrpDdzHost.事件(名字)           '就绪' / '再来一次' / '退出'
 * 这两个对象必须在 iframe 里的 Godot 起来**之前**就存在（本文件在页面加载时立刻挂上）。
 */
(function () {
  'use strict';

  var Net = window.GameNet;
  var P = window.FrpProtocol;
  var UI = window.FrpUI;
  var T = P.T;

  var SLUG = 'ddz';
  /** 牌桌页（Godot 导出产物）。⚠️ 必须和 server/http.mjs 的登录门名单一致。 */
  var TABLE_URL = '/ddz/table/index.html';

  var panel = document.getElementById('ddz-online-panel');
  var stage = document.getElementById('ddz-stage');
  var frame = document.getElementById('ddz-table');
  var stageCode = document.getElementById('ddz-stage-code');
  var stageLeave = document.getElementById('ddz-stage-leave');
  var loading = document.getElementById('ddz-stage-loading');
  var rotate = document.getElementById('ddz-stage-rotate');
  var meLabel = document.getElementById('ddz-me');

  /** 牌桌（iframe 里的 Godot）报过'就绪'没有 */
  var tableReady = false;
  /** 最近一次推进去的视图（牌桌晚到时补推） */
  var pendingView = null;
  /** 头像缓存：id → data URL（Godot 里没有 cookie，取头像必须由页面代劳） */
  var avatarCache = Object.create(null);
  var avatarLoading = Object.create(null);
  var frameStarted = false;
  var renderedOnce = false;

  /* ============================== 桥（先挂，谁先起来都不怕） ============================== */

  /**
   * 牌桌 → 页面这一头的回调（由 GDScript 在 `_ready` 里用 `FrpDdzTable.接上(...)` 交过来）。
   *
   * ⚠️ 为什么要拐这一道 `接上`：Godot 的 `JavaScriptObject` 只会转发**方法调用**
   *    （`对象.方法(...)` → `obj['方法'](...)`），没有"给属性赋值"那条路 ——
   *    那边写 `表.set("推视图", 回调)` 会被当成"JS 上真有个叫 set 的方法"，
   *    报 `obj[method] is not a function`（实测踩过）。所以改成页面给一个方法。
   */
  var tableBridge = { push: null, reset: null };

  window.FrpDdzTable = {
    接上: function (onPush, onReset) {
      tableBridge.push = onPush;
      tableBridge.reset = onReset;
    },
    推视图: function (json) {
      if (typeof tableBridge.push === 'function') tableBridge.push(json);
    },
    重置: function () {
      if (typeof tableBridge.reset === 'function') tableBridge.reset();
    },
  };

  window.FrpDdzHost = {
    /** 牌桌把玩家意图发回来 */
    动作: function (json) {
      var act = null;
      try {
        act = JSON.parse(String(json));
      } catch (err) {
        console.error('[ddz] 牌桌发来的动作不是 JSON', json, err);
        return;
      }
      if (!act || typeof act !== 'object' || !act.type) return;
      if (!Net || !Net.room) {
        UI.toast('不在房间里了，刷新一下', 'error');
        return;
      }
      Net.send(T.ROOM_ACT, { act: act });
    },

    /**
     * 牌桌报一下"我现在画成什么样了"（给自己人看的观测口）。
     *
     * 为什么需要它：牌桌是一块 canvas，**测试和排查都没法从 DOM 上看出手牌几张、
     * 现在是不是结算了**。所以 GDScript 每次画完把关键数字报上来，存在
     * `window.__FrpDdzTable` 里。它只用于观察，页面逻辑一个字节都不读它。
     */
    渲染: function (json) {
      try {
        window.__FrpDdzTable = JSON.parse(String(json));
      } catch (err) {
        /* 观测口坏了不影响玩 */
      }
    },

    /** 牌桌发来的事件 */
    事件: function (name) {
      if (name === '就绪') {
        tableReady = true;
        loading.hidden = true;
        // 牌桌晚到时补一次：它可能错过了最后一条视图
        if (pendingView) sendView(pendingView);
        return;
      }
      if (name === '再来一次') {
        var room = Net && Net.room;
        if (room && Net.me && room.hostId === Net.me.id) {
          Net.send(T.ROOM_RESET, {});
        } else {
          UI.toast('等房主开下一局', 'error');
        }
        return;
      }
      if (name === '退出') {
        leaveRoom();
      }
    },
  };

  /* ============================== 房间外壳 ============================== */

  function mount() {
    if (!window.FrpRoom) {
      panel.textContent = '页面没加载全（缺 room.js），刷新一下试试';
      return;
    }
    FrpRoom.mount({
      container: panel,
      game: SLUG,
      // 真人下限 3：房间层只数真人；座位数（minSeats）也是 3（见 server/games/ddz.mjs 的 meta）
      minPlayers: 3,
      // 牌桌在下面那层 iframe 里画，房间里这一块只留一句说明
      renderGame: function (host) {
        var note = document.createElement('p');
        note.className = 'frp-room-note ddz-stage-note';
        note.textContent = '牌桌在下方打开。没看到的话点一下「退出房间」再进来。';
        host.appendChild(note);
      },
    });

    FrpRoom.handleInvites({
      gameTitle: function (slug) {
        return slug === SLUG ? '斗地主' : slug;
      },
      goToGame: function (slug, code) {
        if (slug === SLUG) {
          // 已经在这个页面上了：房间状态会自己刷出来
          return;
        }
        window.location.href = '/games/' + encodeURIComponent(slug) + '/';
      },
    });

    Net.on(T.READY, applyMe);
    Net.on(T.ROOM_STATE, sync);
    if (Net.me) applyMe({ me: Net.me });
    sync();
  }

  function applyMe(msg) {
    var me = (msg && msg.me) || (Net && Net.me);
    if (!me || !meLabel) return;
    meLabel.textContent = '你是 ' + (me.name || me.id);
    meLabel.title = '玩家 ID ' + me.id;
  }

  /* ============================== 牌桌的显示 / 隐藏 ============================== */

  function myRoom() {
    var room = Net && Net.room;
    return room && room.game === SLUG ? room : null;
  }

  /** 房间状态变了：决定牌桌露不露、要不要推新视图。 */
  function sync() {
    var room = myRoom();
    if (!room) {
      hideStage();
      pendingView = null;
      return;
    }

    // 在房间里（哪怕还没开局）就开始下牌桌 —— 等开局再下就来不及了。
    startFrameOnce();

    stageCode.textContent = room.code || '';
    if (room.view) {
      pendingView = room.view;
      if (tableReady) sendView(room.view);
      showStage();
    } else {
      hideStage();
    }
    updateRotateHint();
  }

  function startFrameOnce() {
    if (frameStarted) return;
    frameStarted = true;
    installBridgeInto(frame);
    frame.addEventListener('load', function () {
      // 换了文档就是新的 window，桥得再挂一次
      installBridgeInto(frame);
    });
    frame.src = TABLE_URL;
  }

  /**
   * 把桥挂进 **iframe 自己的窗口**。
   *
   * ⚠️ 这一步不是可选的：Godot 的 `JavaScriptBridge.get_interface('FrpDdzTable')`
   *    查的是**它自己那个 window** 上的全局，父窗口上有一个不算。所以同源 iframe
   *    要把这两个对象贴过去（贴的是同一个对象，不是拷贝）。
   *    GDScript 那边还会轮询重试几秒，两边谁先到都能接上。
   */
  function installBridgeInto(iframe) {
    try {
      var win = iframe.contentWindow;
      if (!win) return;
      win.FrpDdzTable = window.FrpDdzTable;
      win.FrpDdzHost = window.FrpDdzHost;
    } catch (err) {
      console.error('[ddz] 桥没挂进 iframe', err);
    }
  }

  function showStage() {
    if (!stage.hidden) return;
    stage.hidden = false;
    // 让 iframe 拿到焦点，键盘/触摸事件才会进到 Godot 里
    try {
      frame.focus();
    } catch (err) {
      /* 忽略 */
    }
  }

  function hideStage() {
    stage.hidden = true;
  }

  /** 竖屏手机直接开 /ddz/ 时给一句"横过来"（横屏外壳 /play/ddz 里本来就是横的） */
  function updateRotateHint() {
    if (!rotate) return;
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    var portrait = window.innerHeight > window.innerWidth;
    rotate.hidden = !(stage.hidden === false && coarse && portrait);
  }

  /* ============================== 把视图塞给牌桌 ============================== */

  function sendView(view) {
    if (!tableReady || !tableBridge.push) {
      return;
    }
    var enriched = enrichAvatars(view);
    try {
      window.FrpDdzTable.推视图(JSON.stringify(enriched));
    } catch (err) {
      console.error('[ddz] 推视图失败', err);
    }
    if (!renderedOnce) {
      renderedOnce = true;
      loading.hidden = true;
    }
  }

  /**
   * 给视图里每个玩家补一个 `avatarData`（PNG 的 data URL）。
   *
   * 为什么由页面来取：Godot 的 HTTPRequest 在 web 导出里不一定带得上会话 cookie，
   * 而 `/avatar/<id>` 是登录态接口。所以页面用 fetch（同源、自动带 cookie）取回来，
   * 再用 canvas 转成 PNG —— 平台默认头像是 SVG，Godot 解不了 SVG，浏览器能。
   *
   * 这是**只读**的补充字段：谁的手牌、谁是地主这些仍然只有服务器说了算。
   */
  function enrichAvatars(view) {
    if (!view || !Array.isArray(view.players)) return view;
    var out = Object.assign({}, view);
    out.players = view.players.map(function (player) {
      var id = player.id;
      var copy = Object.assign({}, player);
      copy.avatarData = avatarCache[id] || null;
      if (!copy.avatarData && id && !avatarLoading[id]) loadAvatar(id);
      return copy;
    });
    return out;
  }

  function loadAvatar(id) {
    avatarLoading[id] = true;
    fetch('/avatar/' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      })
      .then(function (blob) {
        return new Promise(function (resolve) {
          var url = URL.createObjectURL(blob);
          var img = new Image();
          img.onload = function () {
            var size = 96;
            var canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            var ctx = canvas.getContext('2d');
            // 居中裁成正方形（头像可能是竖图）
            var side = Math.min(img.width, img.height) || size;
            ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
            URL.revokeObjectURL(url);
            resolve(canvas.toDataURL('image/png'));
          };
          img.onerror = function () {
            URL.revokeObjectURL(url);
            resolve(null);
          };
          img.src = url;
        });
      })
      .then(function (dataUrl) {
        avatarLoading[id] = false;
        avatarCache[id] = dataUrl;
        // 头像到齐了再推一次（第一次推的时候大概率还没有）
        if (dataUrl && pendingView && tableReady) sendView(pendingView);
      })
      .catch(function () {
        avatarLoading[id] = false;
        avatarCache[id] = null;
      });
  }

  /* ============================== 离开 ============================== */

  function leaveRoom() {
    Net.send(T.ROOM_LEAVE, {});
    hideStage();
    pendingView = null;
  }

  stageLeave.addEventListener('click', function () {
    // 对局中离开 = 本局作废（没有 AI 能接管手牌，见 games/ddz/README.md）
    var room = myRoom();
    if (room && room.view) {
      if (!window.confirm('对局中退出，这一局会作废，剩下两个人得重开。确定退出？')) return;
    }
    leaveRoom();
  });

  /* ============================== 启动 ============================== */

  function boot() {
    if (!Net) {
      panel.textContent = '页面没加载全（缺 net.js），刷新一下试试';
      return;
    }
    mount();
    window.addEventListener('resize', updateRotateHint);
    window.addEventListener('orientationchange', function () {
      setTimeout(updateRotateHint, 120);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();