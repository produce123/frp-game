/*
 * 共用房间界面 —— 三个游戏共用的那一套。
 *
 * 【为什么要有这个文件】
 * 用户学会一个游戏的"建房 / 邀请好友 / 开始"，就应该会玩下一个。
 * 所以房间外壳（房号、成员、邀请、开始、离开）**由平台提供**，
 * 各游戏只负责画"自己的设置区"和"自己的棋盘"。
 * 见 docs/ARCHITECTURE.md 的「在线界面的两条 DOM 契约」。
 *
 * 【游戏怎么用】只有两个调用：
 *
 *   FrpRoom.mount({
 *     container:  document.getElementById('online-panel'),  // 必填，挂在哪
 *     game:       'cannon-goblin',                          // 必填，本游戏的 slug
 *     renderGame: function (host, view, ctx) { … },         // 必填：把裁剪过的 view 画出来
 *     renderSetup: function (host, ctx) { … },              // 选填：房主的设置区
 *     options:    { … },                                    // 选填：设置的初始值
 *   });
 *   FrpRoom.handleInvites({ goToGame: fn, gameTitle: fn });  // 收到邀请时弹窗
 *
 * 【ctx 里有什么】见下面的 makeCtx()。
 *
 * ⚠️ 本文件是经典全局脚本（同 net.js / ui.js），因为 Cannon Goblin 是经典脚本结构。
 * ⚠️ **不要在游戏里另写一套房间界面** —— 那就是"这个不像亲生的"的来源。
 */
(function (root) {
  'use strict';

  var P = root.FrpProtocol;
  var UI = root.FrpUI;
  var Net = root.GameNet;
  var T = P.T;
  /** 互动与头像（扔鸡蛋/鲜花、圆环配色）都归它 */
  var React = root.FrpReact;

  /** mount 时的配置 */
  var cfg = null;
  /** 房间界面的内容容器（平台外壳画在里面） */
  var panel = null;
  /** 房主可改的设置，开局时随 room.start 发出去 */
  var options = {};
  /** 邀请好友面板里勾中了谁 */
  var picked = Object.create(null);
  var invitesBound = false;
  var roomBound = false;
  /**
   * 上一次画出来时的"输入指纹"。
   *
   * 为什么要有：每次 `room.state` 都会把整块面板**清空重画**，而游戏的对局区也在里面
   * （`renderGame` 会重画牌桌）。服务端在某些情况下会连着推几条内容一样的消息
   * （比如有人掉线又上来），重画一次棋盘是白费的 —— 手机上表现为闪一下、费电。
   * 指纹照"面板看到的所有输入"算：房间状态 + 好友在线状态 + 本地设置 + 勾选。
   * **本地改动一律走 `render(true)` 强制重画**，不然会出现"点了没反应"。
   */
  var lastKey = null;
  var dirty = true;

  /* ============================== 小工具 ============================== */

  function myId() { return Net.me && Net.me.id; }
  function room() { return Net.room; }

  /** 面板"看到"的输入变了没有。任何一项变了都要重画。 */
  function fingerprint() {
    var r = room();
    var parts = [];
    if (!r) {
      parts.push('out');
    } else {
      parts.push(r.code, r.game, r.hostId, r.phase);
      parts.push(JSON.stringify(r.members || []));
      parts.push(JSON.stringify(r.view === undefined ? null : r.view));
      parts.push(String(r.minSeats), String(r.maxSeats));
      // maxBots = 0 的游戏不画「添加人机」；这个数变了界面就得重画
      parts.push(String(r.maxBots));
    }
    parts.push(JSON.stringify(options));
    parts.push(Object.keys(picked).filter(function (k) { return picked[k]; }).sort().join(','));
    parts.push((Net.friends || []).map(function (f) { return f.id + (f.online ? '1' : '0'); }).join(','));
    // 自己的身份也要算进去：READY 一到，头像圆环会从"别人"变成"自己"（蓝的）
    parts.push(myId() || '');
    parts.push(Net.connected ? '1' : '0');
    return parts.join('|');
  }

  /**
   * 从 URL 里取"要加入的房号"（`?join=XXXXXX`）。
   * 平台首页点「进入」时会带上它，见 web/assets/js/app.js 的 enterGame()。
   * 取不到就返回 null —— 正常打开游戏页面时就是这种情况，不该有任何副作用。
   */
  function joinCodeFromUrl() {
    try {
      var raw = new URLSearchParams(root.location.search).get('join');
      if (!raw) return null;
      var code = P.normalizeCode(raw);
      return code || null;
    } catch (err) {
      return null;
    }
  }

  /** 我在的房间是不是"本游戏的"。（别人的房可能属于别的游戏） */
  function myRoom() {
    var r = room();
    if (!r || !cfg) return null;
    return r.game === cfg.game ? r : null;
  }

  function isHost() {
    var r = myRoom();
    return Boolean(r && myId() && r.hostId === myId());
  }

  function onlineFriends() {
    return (Net.friends || []).filter(function (f) { return f.online; });
  }

  function el(tag, attrs, children) { return UI.el(tag, attrs, children); }

  function button(label, cls, onClick, disabled) {
    return el('button', {
      class: 'frp-btn ' + (cls || ''),
      type: 'button',
      disabled: Boolean(disabled),
      onclick: onClick,
    }, label);
  }

  /* ============================== 给游戏用的上下文 ============================== */

  function makeCtx() {
    var r = myRoom();
    var seats = r ? (r.members || []).length : 0;
    return {
      room: room(),
      isHost: isHost(),
      me: Net.me,
      friends: Net.friends,
      /** 房主设置项的当前值（改它用 setOption） */
      options: options,
      setOption: setOption,
      /** 发一个操作意图给服务端 */
      act: act,
      start: start,
      leave: leave,
      reset: reset,
      /** 总座位（真人 + 人机）。人机也是座位，见 docs/ARCHITECTURE.md 的「游戏模块接口」。 */
      seats: seats,
      minSeats: r && r.minSeats ? r.minSeats : (cfg && cfg.minPlayers) || 1,
      maxSeats: r && r.maxSeats ? r.maxSeats : seats,
      /** 邀请勾选中的好友（游戏一般不用管，平台外壳自己画） */
      inviteSelected: inviteSelected,
    };
  }

  function setOption(key, value) {
    options[key] = value;
    render(true);      // 本地改动必须强制重画（指纹里也带着 options，但别依赖它）
  }

  /**
   * 发一个操作意图给服务端。
   *
   * ⚠️ **返回值必须原样传出去**（`true` = 真的写进 socket 了，`false` = 还没连上/链路没了）。
   * 游戏要靠它决定"这一下算不算数"。
   *
   * ⚠️ **演出期间一律返回 false**：服务端那一帧已经把回合推进过了，而画面还在一步步演完 ——
   * 这段时间必须锁住输入，否则玩家会"看着动画连着操作"，看到的和实际的对不上
   * （用户第 2 条反馈）。判据是 `shared/ui/anim.js` 的 `busy()`
   * （同时会给 `<body>` 挂 `frp-anim-busy`，游戏用自己的 CSS 把按钮变灰）。
   * 这里是**兜底**：游戏自己的提交口子也该判一次 —— 它们才是真正发消息的人。
   */
  function act(action) {
    var Anim = root.FrpAnim;
    if (Anim && typeof Anim.busy === 'function' && Anim.busy()) return false;
    return Net.send(T.ROOM_ACT, { act: action });
  }

  function start() {
    // onStart 让游戏在最后关头把设置项补全（比如从编辑器全局变量里取自定义地图）。
    // 有它就不需要"往 options 里同步塞值再触发重画"那种来回绕的写法。
    var finalOptions = options;
    if (typeof cfg.onStart === 'function') {
      try {
        var extra = cfg.onStart(makeCtx());
        if (extra && typeof extra === 'object') finalOptions = extra;
      } catch (err) {
        if (root.console) console.error('[FrpRoom] onStart 出错，改用现有设置', err);
      }
    }
    Net.send(T.ROOM_START, { options: finalOptions });
  }

  function leave() {
    Net.send(T.ROOM_LEAVE, {});
    picked = Object.create(null);
  }

  function reset() {
    Net.send(T.ROOM_RESET, {});
  }

  function inviteSelected() {
    var to = Object.keys(picked).filter(function (id) { return picked[id]; });
    if (!to.length) { UI.toast('先勾上要邀请的好友', 'error'); return; }
    Net.send(T.INVITE_SEND, { to: to, code: myRoom() ? myRoom().code : '' });
    picked = Object.create(null);
    UI.toast('邀请发出去了（只发给了在线的好友）', 'ok');
    render(true);
  }

  /* ============================== 渲染 ============================== */

  /**
   * @param {boolean} [force] 强制重画（本地改动一律走这个；服务端推送走指纹去重）
   */
  function render(force) {
    if (!panel) return;
    if (force) dirty = true;

    var key = fingerprint();
    if (!dirty && key === lastKey) return;
    lastKey = key;
    dirty = false;

    UI.clear(panel);

    var r = myRoom();

    if (!r) {
      // 不在这局里 —— 可能是"别人邀请我进了另一个游戏的房"，提示一下再给入口
      var other = room();
      if (other) {
        panel.appendChild(el('p', { class: 'frp-room-note' }, [
          '你正在玩的是另一个游戏（' + other.game + '），点下面离开那边的房间。',
        ]));
        panel.appendChild(el('div', { class: 'frp-room-actions' }, [
          button('离开那个房间', 'frp-btn-ghost', leave),
        ]));
        return;
      }
      panel.appendChild(renderIdle());
      return;
    }

    if (r.phase === 'waiting') { panel.appendChild(renderWaiting(r)); return; }
    panel.appendChild(renderPlaying(r));
  }

  /* ---------- 未在房间：两个入口 ---------- */

  function renderIdle() {
    var input = el('input', {
      class: 'frp-input',
      type: 'text',
      inputmode: 'latin',
      autocapitalize: 'characters',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: String(P.ROOM_CODE_LENGTH + 2),
      placeholder: P.ROOM_CODE_LENGTH + ' 位房间号',
      'aria-label': '房间号',
    });

    var form = el('form', { class: 'frp-room-joinform' }, [
      input,
      button('加入', '', function () {}),
    ]);
    // 用 form 的 submit 才能让手机键盘的"前往"和回车都生效
    form.querySelector('button').type = 'submit';
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      joinByCode(input.value);
    });

    return el('div', { class: 'frp-room-idle' }, [
      button('创建房间', 'frp-btn-primary frp-btn-wide', function () {
        Net.send(T.ROOM_CREATE, { game: cfg.game, options: options });
      }),
      el('p', { class: 'frp-room-or', text: '或者' }),
      form,
    ]);
  }

  function joinByCode(raw) {
    var code = P.normalizeCode(raw);
    if (!code) {
      UI.toast('房间号是 ' + P.ROOM_CODE_LENGTH + ' 位字母数字', 'error');
      return;
    }
    Net.send(T.ROOM_JOIN, { code: code });
  }

  /* ---------- 等待开局 ---------- */

  function renderWaiting(r) {
    var host = isHost();
    var box = el('div', { class: 'frp-room-waiting' });
    var members = r.members || [];
    var seats = members.length;
    var minSeats = r.minSeats || cfg.minPlayers || 1;
    var maxSeats = r.maxSeats || seats;

    /* 房间号 */
    box.appendChild(el('div', { class: 'frp-room-code' }, [
      el('span', { class: 'frp-room-code-label', text: '房间号' }),
      el('button', {
        class: 'frp-room-code-value',
        type: 'button',
        title: '点一下复制房间号',
        onclick: function () { UI.copyText(r.code, '房间号'); },
      }, [el('code', { text: r.code })]),
      el('span', { class: 'frp-room-code-hint', text: '念给朋友或直接邀请' }),
    ]));

    /*
     * 成员（真人 + 人机都在这儿）。
     *
     * 人机**坐在座位上**（用户明确要求）：所以它和真人一样占一行、一样有头像，
     * 只是圆环是灰的、带一个「人机」标签 —— 玩家一眼能看出谁不是人，
     * 又不会误以为"来了个陌生人"。
     * 点头像可以对它扔鸡蛋/鲜花（`data-frp-avatar` 由 FrpReact 接管）。
     */
    box.appendChild(el('ul', { class: 'frp-room-members' }, members.map(function (m) {
      var tags = [];
      if (m.id === r.hostId) tags.push(el('span', { class: 'frp-room-tag', text: '房主' }));
      if (m.id === myId()) tags.push(el('span', { class: 'frp-room-tag frp-room-tag-me', text: '你' }));
      if (m.isBot) tags.push(el('span', { class: 'frp-room-tag frp-room-tag-bot', text: '人机' }));

      /*
       * ⚠️ 一行里「人机」只许出现**一次**。「人机」标签（`.frp-room-tag-bot`）就是那个标记，
       * 所以：
       *   · id 那一格只在**真人**身上出现（那是"单字名会重名，靠 ID 认人"用的）；
       *   · 右边那一格对**人机**留空（房主看到的是「移除」按钮，不是文字）。
       * 以前是三处都写：`虎 … 虎 人机 人机 人机`（刀马那边报上来的观感问题）。
       */
      var right;
      if (m.isBot && host) {
        // 房主能移除人机（按错了、或者想换个配置）。非房主看到的是只读文字。
        right = button('移除', 'frp-btn-ghost frp-room-bot-remove', function () {
          Net.send(T.ROOM_BOT_REMOVE, { id: m.id });
        });
      } else if (m.isBot) {
        right = el('span', { class: 'frp-room-member-state' });   // 人机、又不是房主：标签已经说明了一切
      } else {
        right = el('span', {
          class: 'frp-room-member-state',
          text: m.online ? '在线' : '掉线中',
        });
      }

      var cells = [
        el('span', { class: 'frp-room-avatar-hit' }, [React ? React.avatarEl({
          id: m.id,
          name: m.name,
          avatar: m.avatar || '',
          isBot: Boolean(m.isBot),
          size: 44,
        }) : el('span', { class: 'frp-avatar is-human', text: m.name })]),
        el('span', { class: 'frp-room-member-name', text: m.name }),
      ];
      if (!m.isBot) cells.push(el('code', { class: 'frp-room-member-id', text: m.id }));

      return el('li', {
        class: 'frp-room-member' + (m.online ? ' is-online' : '') + (m.isBot ? ' is-bot' : ''),
      }, cells.concat(tags, [right]));
    })));

    /* 座位数与「添加人机」——按一下加一个，所见即所得（用户明确要求） */
    // maxBots = 0 的游戏（比如斗地主）**没有电脑**：连按钮和"人机由房主添加"都不画，
    // 否则玩家会一直点一个点了没反应的按钮。null/undefined = 老游戏，没有上限。
    var maxBots = (r.maxBots === null || r.maxBots === undefined) ? Infinity : r.maxBots;
    var seatBar = [];
    seatBar.push(el('span', { class: 'frp-room-seat-count', text: '座位 ' + seats + ' / ' + maxSeats }));
    if (maxBots > 0) {
      if (host) {
        seatBar.push(button('＋ 添加人机', 'frp-btn-ghost frp-room-bot-add', function () {
          Net.send(T.ROOM_BOT_ADD, {});
        }, seats >= maxSeats));
      } else {
        seatBar.push(el('span', { class: 'frp-room-note frp-room-seat-note', text: '人机由房主添加' }));
      }
    }
    box.appendChild(el('div', { class: 'frp-room-seats' }, seatBar));

    if (seats < minSeats) {
      box.appendChild(el('p', {
        // 座位相关的提示单独带一个类名：`.frp-room-note` 在邀请区也有一份，
        // 自动化里用 `.frp-room-note` 泛查会永远为真（刀马的用例踩过一次假通过）。
        class: 'frp-room-note frp-room-seat-note',
        text: '至少要 ' + minSeats + ' 个座位才能开始（现在 ' + seats + ' 个）。'
          + (maxBots <= 0
            ? '把房间号发给朋友，等他们进来。'
            : (host ? '按「添加人机」补一个，或者等朋友进来。' : '等房主补个人机，或者再叫个人来。')),
      }));
    }

    /* 设置区：游戏自己画 */
    if (cfg.renderSetup) {
      var setupHost = el('div', { class: 'frp-room-setup' });
      box.appendChild(setupHost);
      try {
        cfg.renderSetup(setupHost, makeCtx());
      } catch (err) {
        setupHost.appendChild(el('p', { class: 'frp-room-note', text: '设置区画不出来：' + err.message }));
        if (root.console) console.error('[FrpRoom] renderSetup 出错', err);
      }
    }

    /* 邀请好友 */
    box.appendChild(renderInvite());

    /* 底部操作 */
    var actions = [];
    if (host) {
      // 「开始游戏」亮不亮看**座位数**（人机也算座位），不是看真人人数 ——
      // 一个人 + 1 个人机是正常玩法，按钮不能灰着（平台游戏接口约定）。
      actions.push(button('开始游戏', 'frp-btn-primary', start, seats < minSeats));
    } else {
      actions.push(el('span', { class: 'frp-room-wait-hint', text: '等房主开始' }));
    }
    actions.push(button('离开', 'frp-btn-ghost', leave));
    box.appendChild(el('div', { class: 'frp-room-actions' }, actions));

    return box;
  }

  /** 一键批量邀请：勾上若干个在线好友，一次发出去。 */
  function renderInvite() {
    var friends = onlineFriends();
    var wrap = el('div', { class: 'frp-room-invite' });

    if (!friends.length) {
      wrap.appendChild(el('p', {
        class: 'frp-room-note',
        text: (Net.friends || []).length ? '好友都不在线，暂时没法邀请' : '还没有好友，先去平台首页加一个',
      }));
      return wrap;
    }

    var list = el('div', { class: 'frp-room-friends' , hidden: true });

    function rebuildOpen() {
      var open = list.hidden;
      list.hidden = !open;
      toggle.textContent = open ? '收起好友' : '邀请好友（' + friends.length + ' 人在线）';
    }

    var toggle = button('邀请好友（' + friends.length + ' 人在线）', 'frp-btn-ghost', rebuildOpen);

    friends.forEach(function (f) {
      var box = el('input', {
        type: 'checkbox',
        class: 'frp-check',
        'data-friend': f.id,
        'aria-label': '邀请 ' + f.name,
      });
      box.checked = Boolean(picked[f.id]);
      box.addEventListener('change', function () { picked[f.id] = box.checked; });

      list.appendChild(el('label', { class: 'frp-room-friend' }, [
        box,
        el('span', { class: 'frp-room-friend-name', text: f.name }),
        el('code', { class: 'frp-room-friend-id', text: f.id }),
      ]));
    });

    list.appendChild(el('div', { class: 'frp-room-friend-actions' }, [
      button('全选在线好友', 'frp-btn-ghost', function () {
        // 按 data-friend 记，别用显示名字 —— 名字可能重名，ID 才是身份
        list.querySelectorAll('input[type=checkbox]').forEach(function (c) {
          c.checked = true;
          picked[c.getAttribute('data-friend')] = true;
        });
        render(true);
      }),
      button('发送邀请', 'frp-btn-primary', inviteSelected),
    ]));

    wrap.appendChild(toggle);
    wrap.appendChild(list);
    return wrap;
  }

  /* ---------- 对局中 / 已结束 ---------- */

  function renderPlaying(r) {
    var box = el('div', { class: 'frp-room-playing' });

    // 顶栏：房间号 + 离开（对局中也要能退）
    box.appendChild(el('div', { class: 'frp-room-bar' }, [
      el('span', { class: 'frp-room-bar-code', text: r.code }),
      el('span', { class: 'frp-room-bar-spacer' }),
      el('span', {
        class: 'frp-room-bar-state',
        text: r.phase === 'over' ? '本局结束' : '对局中',
      }),
    ]));

    var gameHost = el('div', { class: 'frp-room-game' });
    box.appendChild(gameHost);
    try {
      cfg.renderGame(gameHost, r.view, makeCtx());
    } catch (err) {
      gameHost.appendChild(el('p', { class: 'frp-room-note', text: '棋盘画不出来：' + err.message }));
      if (root.console) console.error('[FrpRoom] renderGame 出错', err);
    }

    if (r.phase === 'over') {
      var actions = [];
      if (isHost()) actions.push(button('再来一局', 'frp-btn-primary', reset));
      else actions.push(el('span', { class: 'frp-room-wait-hint', text: '等房主再开一局' }));
      actions.push(button('离开', 'frp-btn-ghost', leave));
      box.appendChild(el('div', { class: 'frp-room-actions' }, actions));
    } else {
      box.appendChild(el('div', { class: 'frp-room-actions' }, [
        button('离开（对局仍在进行）', 'frp-btn-ghost', leave),
      ]));
    }

    return box;
  }

  /* ============================== 挂载 ============================== */

  function mount(config) {
    cfg = config || {};
    if (!cfg.container) throw new Error('FrpRoom.mount 需要一个 container');
    if (!cfg.game) throw new Error('FrpRoom.mount 需要一个 game');
    if (typeof cfg.renderGame !== 'function') throw new Error('FrpRoom.mount 需要 renderGame');

    panel = cfg.container;
    options = cfg.options ? JSON.parse(JSON.stringify(cfg.options)) : {};

    // ⚠️ 必须在这儿把 WebSocket 连上。
    // 平台首页是 web/assets/js/app.js 调的 connect()，游戏页面**没有那个文件** ——
    // 所以游戏页面如果自己不连，就会表现成：界面全都画得出来（静态 DOM 在），
    // 点"创建房间"却永远没反应，控制台还一声不响（消息发不出去，也收不到 room.state）。
    // 这个 bug 真的发生过一次（tests/room.browser.mjs 抓到的），所以放在 mount 里 ——
    // 房间外壳是游戏页面唯一的必需品，挂上它就等于"这个页面要联机"。
    // connect() 本身是幂等的（net.js 里已经连上就不会再连一条）。
    if (!Net.connected && typeof Net.connect === 'function') Net.connect();

    // `?join=XXXXXX` —— 从平台好友列表点「进入」跳过来时带的房号（见 web/assets/js/app.js）。
    // 必须**等连上再发**：还没连上就发消息会被直接丢掉，界面看起来毫无反应。
    // 放在 mount 里而不是各游戏的 online.js 里，这样第四个游戏也不会漏。
    var pending = joinCodeFromUrl();
    if (pending) {
      var tryJoin = function () {
        if (!pending) return;
        if (room()) { pending = null; return; }        // 已经坐在某个房里了，别抢
        if (!Net.connected) return;                     // 还没连上，等下次事件
        var code = P.normalizeCode(pending);
        pending = null;
        if (code) Net.send(T.ROOM_JOIN, { code: code });
        else if (root.console) console.warn('[FrpRoom] URL 里的房号看不懂，忽略：' + pending);
      };
      Net.on('open', tryJoin);
      Net.on(T.READY, tryJoin);
      tryJoin();
    }

    // 房间状态由 net.js 统一维护（Net.room），这里只跟着重画
    if (!roomBound) {
      roomBound = true;
      Net.on(T.ROOM_STATE, function () { render(); });
      Net.on(T.FRIENDS, function () { render(); });
      Net.on(T.READY, function () { render(); });
      /*
       * 服务端的拒绝必须有提示。
       *
       * ⚠️ 游戏页面**不加载** web/assets/js/app.js（那是平台外壳），所以在这之前
       * **没有任何人**负责显示 `error` 消息 —— 服务端每拒一次（"还没轮到你"、
       * "开局失败：…"、"这局已经开始"）在游戏页里都是"点了没反应"，
       * 控制台也一声不响。大炮轰小鬼的补位功能就是这么撞上它的。
       *
       * 平台外壳自己有一条同样的监听（app.js），而它**不调 mount()**（只调
       * handleInvites），所以这里加不会弹两次。**新游戏不要再自己加这一条。**
       */
      Net.on(T.ERROR, function (msg) {
        if (msg && msg.message) UI.toast(msg.message, 'error');
      });
    }
    render();
    return api;
  }

  function unmount() {
    panel = null;
    cfg = null;
  }

  /* ============================== 收到的邀请 ============================== */

  /**
   * 处理别人发来的邀请。平台外壳和每个游戏页面都调一次。
   * @param {object} [opts]
   * @param {(slug: string) => void} [opts.goToGame] 跳到某个游戏的页面
   * @param {(slug: string) => string} [opts.gameTitle]
   */
  function handleInvites(opts) {
    if (invitesBound) return;
    invitesBound = true;
    var config = opts || {};

    Net.on(T.INVITE, function (msg) {
      if (!msg || !msg.from) return;
      var title = config.gameTitle ? config.gameTitle(msg.game) : msg.game;

      var card = el('div', { class: 'frp-invite-card', role: 'dialog' }, [
        el('div', { class: 'frp-invite-text', text: '「' + msg.from.name + '」邀请你玩 ' + title }),
      ]);

      var timer = root.setTimeout(function () { remove(); }, 30_000);

      function remove() {
        root.clearTimeout(timer);
        if (card.parentNode) card.parentNode.removeChild(card);
      }

      function reply(accept) {
        remove();
        // 接受时服务端会直接把名额留好，所以这里只需要跳过去
        Net.send(T.INVITE_REPLY, {
          from: msg.from.id,
          code: msg.code,
          accept: accept,
          // 无名杀的房号不是平台 6 位短码，服务端要靠 game 分辨走哪条路
          game: msg.game || '',
        });
        if (!accept) return;
        if (cfg && cfg.game === msg.game) return;   // 已经在这个游戏页面上，状态会自己刷出来
        if (config.goToGame) config.goToGame(msg.game, msg.code);
      }

      card.appendChild(el('div', { class: 'frp-invite-actions' }, [
        button('进入', 'frp-btn-primary', function () { reply(true); }),
        button('忽略', 'frp-btn-ghost', function () { reply(false); }),
      ]));

      root.document.body.appendChild(card);
    });
  }

  var api = {
    mount: mount,
    unmount: unmount,
    handleInvites: handleInvites,
    render: render,
    /** 房主当前设置的只读快照。游戏读它来画"你选了什么"。 */
    get options() { return options; },
  };
  root.FrpRoom = api;
})(typeof window !== 'undefined' ? window : globalThis);