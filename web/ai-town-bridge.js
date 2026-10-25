/*
 * AI 小镇的平台桥（由 server/http.mjs 注入到 /ai-town/ 与 /ai-town/game.html）。
 *
 * 为什么不在上游源码里写：上游会整体重新构建，桥放在 web/ 里就不会被覆盖；
 * 而且它只做平台相关的事，不碰上游的世界逻辑：
 *   · 显示"你：昵称 + 头像"（账号就是平台首页那个）；
 *   · 房主开镇后每 15 秒上报"正在玩"，好友列表里才会出现「进入」；
 *   · 游戏内「邀请好友」（只列在线好友，和无名杀/麻将同一套）；
 *   · 回平台入口。
 *
 * 页面**不连平台 WebSocket**：平台首页始终在后台连着，邀请卡送得到；
 * 这里只走几条 REST，省一条连接和一套无关报文。
 */
(function () {
  'use strict';

  var me = window.__FRP_ME__ || null;
  if (!me || !me.id) return;

  var state = { room: null, joinable: true, count: 1, error: null, game: isGamePage() };
  // 账号胶囊收成贴边悬浮球：只记住当前这次打开的位置，刷新回左上角。
  var layout = { side: 'left', y: 0, open: false };
  var suppressClick = false;
  var heartbeat = null;
  var tries = 0;
  var fastTries = 0;

  function isGamePage() {
    return /\/game\.html$/i.test(location.pathname);
  }

  function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch('./api/platform/' + path, init).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || !data || data.ok === false) {
          throw new Error((data && (data.message || data.error)) || ('平台返回 ' + res.status));
        }
        return data;
      });
    });
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function mount() {
    if (document.getElementById('frp-ai-town')) return;
    var style = el('style');
    style.textContent = [
      // 平时只露半边球，点开才是账号/邀请卡片；卡片不占一条常驻横条。
      '#frp-ai-town{position:fixed;left:0;top:80px;z-index:2147483000;width:44px;height:44px;',
      'font:12px/1.3 system-ui,"Microsoft YaHei",sans-serif;touch-action:none;box-sizing:border-box;',
      '-webkit-user-select:none;user-select:none}',
      '#frp-ai-town .frp-ball{display:block;width:44px;height:44px;padding:0;border:0;border-radius:50%;overflow:hidden;',
      'background:rgba(18,20,24,.9);box-shadow:0 4px 18px rgba(0,0,0,.3);cursor:pointer;touch-action:none;',
      '-webkit-user-drag:none;user-drag:none}',
      '#frp-ai-town .frp-ball img{width:100%;height:100%;border-radius:50%;object-fit:cover;background:#333;display:block;',
      'pointer-events:none;-webkit-user-drag:none;user-drag:none}',
      '#frp-ai-town .frp-ball:active{transform:scale(.96)}',
      '#frp-ai-town .frp-panel{position:absolute;left:calc(100% + 8px);top:0;display:flex;align-items:center;gap:8px;',
      'padding:6px 9px 6px 6px;border-radius:999px;background:rgba(18,20,24,.78);color:#f5f0e6;',
      'box-shadow:0 4px 18px rgba(0,0,0,.25);backdrop-filter:blur(6px);max-width:min(78vw,340px);',
      'max-height:calc(100vh - 20px);overflow:auto;box-sizing:border-box}',
      '#frp-ai-town.frp-right .frp-panel{left:auto;right:calc(100% + 8px)}',
      '#frp-ai-town:not(.frp-open) .frp-panel{display:none!important}',
      '#frp-ai-town.frp-panel-up .frp-panel{top:auto;bottom:0}',
      '#frp-ai-town .frp-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:96px}',
      '#frp-ai-town .frp-panel button{border:0;border-radius:999px;padding:5px 9px;background:#e8c98a;color:#241a0b;',
      'font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}',
      '#frp-ai-town .frp-panel button.ghost{background:rgba(255,255,255,.14);color:#f5f0e6;font-weight:500}',
      '#frp-ai-town .frp-room{opacity:.78;white-space:nowrap}',
      '@media (max-width:600px){#frp-ai-town{width:38px;height:38px}#frp-ai-town .frp-ball{width:38px;height:38px}}',
      '#frp-ai-town-modal{position:fixed;inset:0;z-index:2147483001;background:rgba(8,10,14,.55);display:flex;',
      'align-items:center;justify-content:center;padding:18px;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif}',
      '#frp-ai-town-modal .panel{background:#1d2026;color:#f5f0e6;border-radius:16px;padding:16px;width:min(92vw,360px);',
      'max-height:80vh;overflow:auto;box-shadow:0 18px 50px rgba(0,0,0,.45)}',
      '#frp-ai-town-modal h3{margin:0 0 10px;font-size:15px}',
      '#frp-ai-town-modal .row{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px solid rgba(255,255,255,.08)}',
      '#frp-ai-town-modal .row img{width:26px;height:26px;border-radius:50%;object-fit:cover}',
      '#frp-ai-town-modal .row span{flex:1}',
      '#frp-ai-town-modal .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}',
      '#frp-ai-town-modal button{border:0;border-radius:999px;padding:8px 14px;background:#e8c98a;color:#241a0b;font:inherit;font-weight:600;cursor:pointer}',
      '#frp-ai-town-modal button.ghost{background:rgba(255,255,255,.14);color:#f5f0e6}',
      '#frp-ai-town-modal .hint{opacity:.7;font-size:12px;margin:6px 0 0}',
      // 世界速度和世界设定只归房主；客人保留观察/化身/居民面板。
      'html.frp-guest #speeds,html.frp-guest #open-settings{display:none!important}',
      // 空镇第一步是「邀请村民」，这一步也是房主的；客人是访客，不显示居民管理入口。
      'html.frp-guest[data-empty-town] #open-residents,html.frp-guest .residents-head-new,html.frp-guest .empty-town{display:none!important}',
      'html.frp-guest #open-residents{display:none!important}',
    ].join('\n');
    document.head.appendChild(style);

    var bar = el('div');
    bar.id = 'frp-ai-town';
    var ball = el('button', 'frp-ball');
    ball.type = 'button';
    ball.draggable = false;
    ball.title = '账号与邀请';
    ball.setAttribute('aria-label', '账号与邀请');
    ball.setAttribute('aria-expanded', 'false');
    ball.addEventListener('dragstart', function (event) { event.preventDefault(); });
    var img = el('img');
    img.alt = '';
    img.draggable = false;
    img.src = me.avatar || ('/avatar/' + encodeURIComponent(me.id));
    ball.append(img);

    var panel = el('div', 'frp-panel');
    var name = el('span', 'frp-name', me.name || '我');
    var room = el('span', 'frp-room', '');
    var invite = el('button', '', '邀请好友');
    invite.type = 'button';
    var back = el('button', 'ghost', '返回平台');
    back.type = 'button';
    back.onclick = function () {
      // 房主返回平台 = 保存并关镇（客人只会退出房间）；失败也照样回首页。
      api('close', { method: 'POST' }).catch(function () {}).then(function () { location.assign('/'); });
    };
    invite.onclick = openInvite;
    panel.append(name, room, invite, back);
    bar.append(ball, panel);
    document.body.appendChild(bar);

    state.nodes = { bar: bar, ball: ball, panel: panel, room: room, invite: invite };
    setupBall();
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function ballSize() {
    return (state.nodes && state.nodes.bar.offsetWidth) || 44;
  }

  /** 收起时半个球在屏幕外；展开时整球收回屏幕内，卡片贴着球。 */
  function placeBall() {
    if (!state.nodes) return;
    var node = state.nodes.bar;
    var size = ballSize();
    var maxY = Math.max(8, window.innerHeight - size - 8);
    var y = clamp(layout.y, 8, maxY);
    var left;
    if (layout.open) {
      left = layout.side === 'right' ? window.innerWidth - size - 10 : 10;
      left = clamp(left, 4, Math.max(4, window.innerWidth - size - 4));
      node.classList.toggle('frp-panel-up', y > window.innerHeight / 2);
    } else {
      left = layout.side === 'right' ? window.innerWidth - size / 2 : -size / 2;
      node.classList.remove('frp-panel-up');
    }
    node.style.left = left + 'px';
    node.style.top = y + 'px';
    node.classList.toggle('frp-right', layout.side === 'right');
    node.classList.toggle('frp-open', layout.open);
    state.nodes.ball.setAttribute('aria-expanded', layout.open ? 'true' : 'false');
  }

  function setOpen(open) {
    layout.open = open;
    placeBall();
  }

  /** 按住球拖动；松手吸附最近的左右边并恢复半隐藏。 */
  function setupBall() {
    var drag = null;
    var bar = state.nodes.bar;
    var ball = state.nodes.ball;
    // 默认像现在一样贴左上；只记住本次打开的位置，刷新回这里。
    layout.y = Math.min(120, Math.max(60, window.innerHeight * 0.12));
    placeBall();

    ball.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      var box = bar.getBoundingClientRect();
      drag = {
        id: event.pointerId,
        sx: event.clientX,
        sy: event.clientY,
        ox: event.clientX - box.left,
        oy: event.clientY - box.top,
        moved: false,
        left: box.left,
        top: box.top,
      };
      try { ball.setPointerCapture(event.pointerId); } catch (e) { /* 已经抬起 */ }
      event.stopPropagation();
    });

    ball.addEventListener('pointermove', function (event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        suppressClick = true;
        bar.classList.add('frp-dragging');
        layout.open = false;
        bar.classList.remove('frp-open');
        state.nodes.ball.setAttribute('aria-expanded', 'false');
      }
      var size = ballSize();
      var left = clamp(
        event.clientX - drag.ox,
        -size / 2,
        Math.max(-size / 2, window.innerWidth - size / 2)
      );
      var top = clamp(event.clientY - drag.oy, 4, Math.max(4, window.innerHeight - size - 4));
      bar.style.left = left + 'px';
      bar.style.top = top + 'px';
      drag.left = left;
      drag.top = top;
    });

    var finishDrag = function (event) {
      if (!drag || (event && event.pointerId !== drag.id)) return;
      var moved = drag.moved;
      var left = drag.left;
      var top = drag.top;
      try { ball.releasePointerCapture(drag.id); } catch (e) { /* 已经释放 */ }
      drag = null;
      bar.classList.remove('frp-dragging');
      if (moved) {
        layout.side = left + ballSize() / 2 < window.innerWidth / 2 ? 'left' : 'right';
        layout.y = top;
        layout.open = false;
        placeBall();
        setTimeout(function () { suppressClick = false; }, 0);
      }
    };
    ball.addEventListener('pointerup', finishDrag);
    ball.addEventListener('pointercancel', finishDrag);
    ball.addEventListener('click', function (event) {
      event.stopPropagation();
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      setOpen(!layout.open);
    });

    // 点卡片外面收起；点卡片内部（例如邀请按钮）不收起。
    document.addEventListener('pointerdown', function (event) {
      if (!layout.open) return;
      if (!bar.contains(event.target)) setOpen(false);
    }, true);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && layout.open) setOpen(false);
    });

    window.addEventListener('resize', function () {
      // 窗口变窄/转屏时别让球或卡片跑出屏幕。
      if (!layout.open) layout.y = clamp(layout.y, 8, Math.max(8, window.innerHeight - ballSize() - 8));
      placeBall();
    });
  }

  function paint() {
    if (!state.nodes) return;
    state.nodes.room.textContent = state.room
      ? ('房间 ' + state.room + ' · ' + state.count + ' 人' + (state.host === false ? ' · 联机' : ''))
      : '';
    // 客人不给邀请按钮；房主才拉人。
    var host = state.host !== false;
    document.documentElement.classList.toggle('frp-guest', state.host === false);
    state.nodes.invite.hidden = !state.room || !host;
    state.nodes.invite.textContent = state.joinable ? '邀请好友' : '邀请好友（已关闭加入）';
  }

  function report() {
    if (!state.room && !state.game) return;
    api('state', { method: 'POST', body: { joinable: state.joinable } }).then(function (data) {
      state.room = data.room;
      state.count = data.count || 1;
      state.joinable = data.joinable !== false;
      state.host = data.owner !== false;
      state.error = null;
      paint();
    }).catch(function (err) {
      // 还没开镇 / 客人页面：前 6 次 1 秒一次（刚进游戏时 open 还在路上），之后放慢
      state.error = err.message;
      tries++;
      if (tries < 120) setTimeout(report, fastTries++ < 6 ? 1000 : 3000);
    });
  }

  function openInvite() {
    if (!state.room) return;
    api('friends').then(function (data) {
      var friends = (data.friends || []).filter(function (f) { return f.online; });
      var modal = el('div');
      modal.id = 'frp-ai-town-modal';
      var panel = el('div', 'panel');
      panel.appendChild(el('h3', '', '邀请好友来这个小镇'));
      if (!friends.length) {
        panel.appendChild(el('p', 'hint', '现在没有在线好友。好友打开平台页面后，这里就会出现。'));
      } else {
        var picked = {};
        friends.forEach(function (f) {
          var row = el('label', 'row');
          var box = el('input');
          box.type = 'checkbox';
          box.onchange = function () { picked[f.id] = box.checked; };
          var avatar = el('img');
          avatar.src = f.avatar || ('/avatar/' + encodeURIComponent(f.id));
          avatar.alt = '';
          var span = el('span', '', f.name + (f.playing ? '（正在玩别的）' : ''));
          row.append(box, avatar, span);
          panel.appendChild(row);
        });
        var actions = el('div', 'actions');
        var cancel = el('button', 'ghost', '取消');
        cancel.onclick = function () { modal.remove(); };
        var send = el('button', '', '发送邀请');
        send.onclick = function () {
          var ids = Object.keys(picked).filter(function (id) { return picked[id]; });
          if (!ids.length) { panel.querySelector('.hint') || panel.appendChild(el('p', 'hint', '先勾一个好友。')); return; }
          send.disabled = true;
          api('invite', { method: 'POST', body: { to: ids } }).then(function (res) {
            modal.remove();
            var ok = (res.delivered || []).length;
            toast(ok ? ('已邀请 ' + ok + ' 人') : '没发出去：好友可能刚离线');
          }).catch(function (err) {
            send.disabled = false;
            toast('邀请失败：' + err.message);
          });
        };
        actions.append(cancel, send);
        panel.appendChild(actions);
      }
      var close = el('button', 'ghost', '关闭');
      close.onclick = function () { modal.remove(); };
      if (!friends.length) {
        var actions2 = el('div', 'actions');
        actions2.appendChild(close);
        panel.appendChild(actions2);
      }
      modal.appendChild(panel);
      modal.addEventListener('click', function (event) { if (event.target === modal) modal.remove(); });
      document.body.appendChild(modal);
    }).catch(function (err) { toast('好友列表读取失败：' + err.message); });
  }

  function toast(text) {
    var tip = el('div', '', text);
    tip.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483002;'
      + 'background:rgba(18,20,24,.9);color:#f5f0e6;padding:9px 14px;border-radius:999px;'
      + 'font:13px/1.3 system-ui,"Microsoft YaHei",sans-serif;max-width:86vw;text-align:center';
    document.body.appendChild(tip);
    setTimeout(function () { tip.remove(); }, 2600);
  }

  function boot() {
    mount();
    // 游戏页：先读一次房间状态（host 的 open 可能还在进行中，失败会自己重试）
    api('status').then(function (data) {
      if (data.room) {
        state.room = data.room.id;
        state.count = data.room.count || 1;
        state.joinable = data.room.joinable !== false;
        state.host = data.room.owner !== false;
        paint();
      }
      report();
      heartbeat = setInterval(report, 15000);
    }).catch(function () {
      // 选镇页还没有房间，等进入游戏后再上报
    });
    window.__FRP_AI_TOWN_STATE = function () {
      return { room: state.room, count: state.count, joinable: state.joinable, host: state.host, error: state.error };
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();