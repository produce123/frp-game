/*
 * 平台外壳：登录 / 注册 / 底部三栏（游戏 · 好友 · 设置）。
 *
 * 【本文件是"平台"的界面，不是任何游戏的界面。】
 * 游戏的界面在各 games/<slug>/ 里，通过 /games/<slug>/ 访问。
 *
 *   ✅ 注册 / 登录 / 登出、HttpOnly 会话
 *   ✅ 底部三栏切换（游戏 / 好友 / 设置）—— **网页内部切换，不跳转**
 *   ✅ WebSocket 连接、好友增删、在线状态实时刷新
 *   ✅ 好友"正在玩什么" + 一键进他的房
 *   ✅ 收到的邀请（由 shared/ui/room.js 统一弹，接受后跳到对应游戏页）
 *   ✅ 游戏卡片点进去 → /games/<slug>/
 *   ✅ 设置栏：音效 / 特效开关（接平台唯一那份偏好）、身份与复制 ID、
 *      登出、连接状态、「关于我」卡片
 *
 * 【三栏这件事为什么落在 app.js 里】
 *   切换只是"显示哪一块 DOM"，没有状态要存、没有網路要发 —— 于是没理由新开一个文件。
 *   三栏的 DOM 在 web/index.html（#panel-games / #panel-friends / #panel-settings），
 *   底部图标在 #tabbar；本文件只负责"点哪个图标就显示哪一栏、顺便把小红点算对"。
 */
(function () {
  'use strict';

  var P = window.FrpProtocol;
  var T = P.T;
  var UI = window.FrpUI;
  var Net = window.GameNet;

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    me: null,
    friends: [],
    /** 别人发给我的待处理申请：[{id,name}]，来自 friends 快照的 incoming */
    incoming: [],
    /** 我发出去、还没被处理的申请：[{id,name}]，来自 friends 快照的 outgoing */
    outgoing: [],
    /** 服务器上已经接好的游戏 slug 列表 */
    available: [],
    /** 首页搜索框里的词（已经 trim + 小写） */
    gameQuery: '',
    /** 首页人数筛选：null = 全部，否则 '1'..'4' 或 '5+' */
    gamePlayers: null,
  };

  /**
   * 「账号判定」的纪元。任何一次**已经把这个人判成登录了**的动作都会 +1，
   * 让在此之前发出去的探测结果原地作废。
   *
   * 为什么必须有这个：boot() 一上来就探 GET /api/me，未登录时服务端回 401。
   * 手快（或密码管理器自动填充）时登录请求可能先返回、那个 401 才姗姗来迟，
   * 于是迟到的 catch 把界面**从平台翻回登录页** —— 界面停在登录页，而 GameNet.me
   * 已经是本人了（实际已登录）。加重试解决不了这个：重试只会再拿一个同样过期的结果。
   * 根因是"迟到的旧结果覆盖了新状态"，所以这里给每次判定发一张"身份证"，
   * 只有**最新的那次**才被允许改界面。详见 boot() 与 adoptMe()。
   */
  var authEpoch = 0;

  /**
   * 认下"这是我的账号"：纪元 +1（在途的旧探测全部作废），存下身份。
   * 界面切换由调用方决定 —— 注册要先弹「抄下你的 ID」再进平台。
   */
  function adoptMe(data) {
    authEpoch += 1;
    state.me = data.me;
    state.available = data.games || [];

    /*
     * 顺手把"我是谁"记进浏览器（localStorage 的 `frp.me`，见 shared/net/net.js 的
     * 「身份记忆」那一节）。
     *
     * 为什么在这儿记：平台首页和每个游戏页是**两个网页**，点进游戏是一次整页跳转，
     * 而游戏页的身份本来只能等 WebSocket 的 `ready` —— 公网那次握手要 2~3 秒，
     * 用户看到的是"正在确认身份…"（用户第 5 条反馈）。谁先拿到身份就记一下，
     * 游戏页一打开就能先把名字/ID 画出来。
     *
     * ⚠️ 这**只是显示层的提前**：⛔ 不许拿 cachedMe() 当登录态、也不许拿它填 `Net.me`。
     *    登录态永远由服务端说了算 —— tests/login-race.browser.mjs 钉着
     *    "迟到的 401 不许把界面翻回登录页"这条红线。
     *    /api/me 成功、/api/login、/api/register 都走这里，所以三处一起记住了。
     */
    if (typeof Net.rememberMe === 'function') Net.rememberMe(state.me);
  }

  /* ============================== 屏幕切换 ============================== */

  function showScreen(name) {
    $('screen-auth').classList.toggle('is-active', name === 'auth');
    $('screen-app').classList.toggle('is-active', name === 'app');
    window.scrollTo(0, 0);
  }

  function switchTab(which) {
    var isLogin = which === 'login';
    $('tab-login').classList.toggle('is-active', isLogin);
    $('tab-register').classList.toggle('is-active', !isLogin);
    $('form-login').classList.toggle('is-active', isLogin);
    $('form-register').classList.toggle('is-active', !isLogin);
  }

  /* ============================== 底部三栏 ============================== */

  /**
   * 三个栏目，**顺序就是底部栏从左到右的顺序**：游戏 / 好友 / 设置。
   * 游戏排最左且是默认栏（用户要求）。
   */
  var COLUMNS = ['games', 'friends', 'settings'];

  /** 当前在哪一栏（null = 还没进平台） */
  var column = null;
  /** 收"淡出中的那一栏"的定时器 */
  var columnTimer = null;

  function panelEl(name) { return $('panel-' + name); }
  function tabEl(name) { return $('tab-' + name); }

  /** 特效开关关掉时不做淡入淡出（用户关特效就是不想看动画）。 */
  function fxOn() {
    try { return UI.prefs.fx(); } catch (err) { return true; }
  }

  /**
   * 切到某一栏。
   *
   * ⚠️ **这是这个网页内部的切换，绝不跳转**（用户明确要求）：跳转会让 WebSocket
   *    断掉重连，用户先看到一个"正在连接服务器…"，而这里本来只是换个 DOM 块。
   * ⚠️ 动画只有淡入淡出，**没有横向滑动**（用户明确否掉了滑动，嫌晃眼）：
   *    新栏立刻显示 + 淡入，旧栏脱出文档流、盖在原地淡出再撤掉（见 style.css 的注释）。
   *    顺序反过来写（旧栏先淡完再显示新栏）会留出一段"谁都点不动"的窗口。
   * ⚠️ 进了好友栏就等于"看到了"：那颗小红点要清掉（见 renderFriendBadge）。
   */
  function showColumn(name) {
    if (COLUMNS.indexOf(name) === -1) return;

    if (column !== name) {
      // 手快连点两下时可能留下好几层幻影，先一次收干净
      var ghosts = document.querySelectorAll('.tab-panel.is-leaving');
      for (var i = 0; i < ghosts.length; i++) ghosts[i].classList.remove('is-leaving');

      var prev = column ? panelEl(column) : null;
      var next = panelEl(name);
      if (next) {
        next.classList.remove('is-leaving');
        next.classList.add('is-active');
      }
      // 旧栏：脱出文档流淡出。特效关掉时干脆不挂这个类 —— 它当场就没了
      if (prev && prev !== next && fxOn()) {
        prev.classList.add('is-leaving');
        if (columnTimer) clearTimeout(columnTimer);
        columnTimer = setTimeout(function () {
          columnTimer = null;
          var list = document.querySelectorAll('.tab-panel.is-leaving');
          for (var j = 0; j < list.length; j++) list[j].classList.remove('is-leaving');
        }, 240);
      }

      COLUMNS.forEach(function (n) {
        var tab = tabEl(n);
        var panel = panelEl(n);
        var on = n === name;
        if (panel && !on) panel.classList.remove('is-active');
        if (!tab) return;
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }

    column = name;
    // 注意：进好友栏 = "看到了里面的申请"，这一步在 renderFriendBadge 里顺手做掉
    renderFriendBadge();
    window.scrollTo(0, 0);
  }

  /* ------------------------------ 好友小红点 ------------------------------ */

  /**
   * 「好友」图标上那颗小红点（带数字）。
   *
   * 用户在游戏栏/设置栏时，别人发来的好友申请是**看不见**的，所以要有提醒；
   * 但提醒不能一直在 —— **进过好友栏（看到那一栏）就该消失**（用户要求）。
   *
   * 怎么算"看到过"：记下当时那份申请的指纹（`badgeSeenKey`），
   * 现在的指纹和它一样就不再提醒。用指纹而不是"清一个布尔值"的好处是：
   * 用户看过之后又来了**新的一条**，指纹变了，小红点会自己再冒出来。
   *
   * 数字就是**待处理申请的总数**（和好友栏里那一块的数量一致，见 state.incoming）。
   */
  var badgeSeenKey = '';

  function incomingKey() {
    return state.incoming
      .map(function (r) { return r.id; })
      .sort()
      .join(',');
  }

  function renderFriendBadge() {
    var badge = $('friend-badge');
    var tab = tabEl('friends');
    if (!badge || !tab) return;

    // 人就在好友栏里看着 —— 等于已经看到了
    if (column === 'friends') badgeSeenKey = incomingKey();

    var n = state.incoming.length;
    var show = n > 0 && incomingKey() !== badgeSeenKey;

    badge.hidden = !show;
    badge.textContent = String(n);
    tab.classList.toggle('has-badge', show);
    // 数字也得让读屏念得出来（图标上不放文字，只能靠 aria-label 说）
    tab.setAttribute('aria-label', show ? '好友，' + n + ' 条待处理的好友申请' : '好友');
  }

  function bindTabbar() {
    COLUMNS.forEach(function (name) {
      var tab = tabEl(name);
      if (tab) tab.addEventListener('click', function () { showColumn(name); });
    });
  }

  /* ============================== 渲染：我自己 ============================== */

  function renderMe() {
    if (!state.me) return;
    // 顶栏：头像 + 「你：X · ID Y」（用户要求顶栏也显示头像）
    var line = $('me-line');
    if (line) line.textContent = '你：' + state.me.name + ' · ID ' + state.me.id;
    renderMeAvatar();
    // 「设置」栏里的身份与复制 ID —— 那颗 ID 按钮原来长在顶栏上（点一下复制），搬过来
    $('set-name').textContent = state.me.name;
    $('me-id').querySelector('code').textContent = state.me.id;
  }

  /** 顶栏与设置栏里的头像（图片加载失败时退回名字首字）。 */
  function renderMeAvatar() {
    if (!state.me) return;
    var urls = [
      { el: $('me-avatar'), size: 32 },
      { el: $('set-avatar'), size: 64 },
    ];
    urls.forEach(function (item) {
      var box = item.el;
      if (!box) return;
      UI.clear(box);
      box.style.setProperty('--frp-avatar-size', item.size + 'px');
      var face = UI.el('span', { class: 'frp-avatar-face', text: [...String(state.me.name || '?')].slice(0, 2).join('') });
      if (state.me.avatar) {
        var img = UI.el('img', {
          class: 'frp-avatar-img',
          src: state.me.avatar,
          alt: '',
          draggable: 'false',
        });
        box.classList.add('has-img');
        box.appendChild(img);
      } else {
        box.classList.remove('has-img');
      }
      box.appendChild(face);
    });
  }

  /* ============================== 渲染：好友 ============================== */

  /**
   * slug → 游戏标题，用来把"正在玩什么"显示成人看得懂的名字。
   */
  function gameTitle(slug) {
    if (slug === 'noname') return '无名杀（三国杀）';
    // 狼人杀是缝合进来的上游项目，不在 window.GAMES 的"平台游戏"里（那张卡片用 href）
    if (slug === 'werewolf') return '狼人杀';
    if (slug === 'ddz') return '斗地主';
    if (slug === 'monopoly') return '大富翁';
    if (slug === 'mahjong') return '莲花广麻';
    if (slug === 'horizon') return '地平线赛车';
    if (slug === 'ai-town') return 'AI 小镇';
    var games = Array.isArray(window.GAMES) ? window.GAMES : [];
    for (var i = 0; i < games.length; i++) {
      if (games[i].slug === slug) return games[i].title;
    }
    return slug;
  }

  /**
   * 打开一个游戏页面。
   *
   * 用户明确要求（2026-11）：**所有游戏统一在新窗口打开**，不要把平台首页顶掉。
   * 以前只有 href 卡片是新窗口、平台游戏和好友「进入」是本页跳转 —— 两种行为混在一起。
   * 现在首页卡片、好友「进入」、邀请「接受」都走这里。
   *
   * `noopener` 不能省：不带的话新页面能通过 window.opener 反过来操作平台首页。
   */
  function openGame(url) {
    window.open(url, '_blank', 'noopener');
  }

  /**
   * 进一个游戏页面。
   *
   * ⚠️ 带 code 时会把房号放进 URL（`?join=XXXXXX`），由那个游戏的页面**真的发一条
   *    room.join** 去入座。
   *    这里踩过一次坑：原以为"跳到游戏页面，服务端会把房间状态补发过来"就够了 ——
   *    不够。补发只对**已经在座位上的人**（断线重连）成立；从好友列表点「进入」
   *    的人根本没入过座，跳过去只会看到一个空的"创建房间"界面。
   *    所以房号必须一路带过去，不能只跳页。
   *
   * 无名杀是另一种游戏（没有平台房间层），房号是**它自己的**，所以走 `?frpJoin=`：
   * 页面里的桥接脚本会读它、自动进房 / 观战。手机仍然走伪横屏外壳。
   */
  function enterGame(slug, code) {
    if (slug === 'noname') {
      var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      var url = coarse ? '/play/noname' : '/noname/';
      if (code) url += '?frpJoin=' + encodeURIComponent(code);
      openGame(url);
      return;
    }
    /*
     * 狼人杀：自己的 6 位数字房号 + 自己的入房页面。
     * 带房号时进 `/werewolf/join?number=…`，那个页面打开就自动入座
     * （好友的房免密码，服务端判断）。不带房号就是主页。
     */
    if (slug === 'werewolf') {
      openGame(code
        ? '/werewolf/join?number=' + encodeURIComponent(code)
        : '/werewolf/');
      return;
    }
    /*
     * 斗地主：页面在顶级地址 `/ddz/`（不是 /games/<slug>/），房号走平台的 `?join=`。
     * `href` 指向 `/play/ddz`（电脑打开外壳会自动回 `/ddz/`），全设备共用同一个入口。
     */
    if (slug === 'ddz') {
      openGame(code
        ? '/ddz/?join=' + encodeURIComponent(code)
        : '/ddz/');
      return;
    }
    /*
     * AI 小镇：房号是平台为某个镇生成的 6 位码（不是上游小镇 id）。
     * 带房号进 `/?room=`，选镇页会先向平台登记成员，再进房主的存档。
     */
    if (slug === 'ai-town') {
      openGame(code
        ? '/ai-town/?room=' + encodeURIComponent(code)
        : '/ai-town/');
      return;
    }
    /*
     * 大富翁：整份上游 Web 客户端（房间/邀请走平台，联机走 /monopoly-relay），
     * 页面在 /games/monopoly/；手机竖屏要横过来才好看 —— 手机走伪横屏外壳 `/play/monopoly`
     * （电脑打开外壳会自动跳回 /games/monopoly/）。
     * 判据只用 `(pointer: coarse)`：带触摸屏的 Windows 笔记本不该被当成手机。
     */
    if (slug === 'monopoly') {
      var coarse2 = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      var murl = coarse2 ? '/play/monopoly' : '/games/monopoly/';
      if (code) murl += '?join=' + encodeURIComponent(code);
      openGame(murl);
      return;
    }
    /*
     * 莲花广麻：整份上游 Web 客户端（Vue3 + Three.js），联机走它自己的 Python 后端；
     * 页面在顶级 `/mahjong/`，手机走伪横屏外壳 `/play/mahjong`
     * （电脑打开外壳会自动跳回 `/mahjong/`）。房号用平台的 `?join=`。
     */
    if (slug === 'mahjong') {
      var coarse3 = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      var jurl = coarse3 ? '/play/mahjong' : '/mahjong/';
      if (code) jurl += '?join=' + encodeURIComponent(code);
      openGame(jurl);
      return;
    }
    /*
     * 地平线赛车：页面在 `/games/horizon/`（平台游戏，房间走 rooms.mjs）。
     * 手机走伪横屏外壳 `/play/horizon`：3D 赛车是横屏画面，竖着拿触屏按键会挡住路。
     * 判据仍然只用 `(pointer: coarse)`（触摸屏笔记本不该被当成手机）。
     */
    if (slug === 'horizon') {
      var coarse4 = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      var hurl = coarse4 ? '/play/horizon' : '/games/horizon/';
      if (code) hurl += '?join=' + encodeURIComponent(code);
      openGame(hurl);
      return;
    }
    var url = '/games/' + encodeURIComponent(slug) + '/';
    if (code) url += '?join=' + encodeURIComponent(code);
    openGame(url);
  }

  function friendStatusText(friend) {
    if (!friend.online) return '离线';
    if (friend.playing) {
      var title = gameTitle(friend.playing.game);
      if (friend.playing.game === 'noname' && friend.playing.started) {
        // 已开局不一定能观战：房主可能在无名杀里关掉了「允许观战」
        return '正在玩 ' + title + (friend.playing.joinable ? '（可观战）' : '（已开局）');
      }
      // 狼人杀：没开局能直接进；开了局就进不去了（不做中途加入）
      if (friend.playing.game === 'werewolf' && friend.playing.started) {
        return '正在玩 ' + title + '（已开局）';
      }
      // 斗地主：同样开局就进不去（三个人就三个座位，牌早发完了）
      if (friend.playing.game === 'ddz' && friend.playing.started) {
        return '正在玩 ' + title + '（已开局）';
      }
      // 大富翁：开局后也进不去了（上游客人只能在房间里等开局）
      if (friend.playing.game === 'monopoly' && friend.playing.started) {
        return '正在玩 ' + title + '（已开局）';
      }
      // 莲花广麻：开局后真人进不去（上游只允许在大厅/已结束的房入座）
      if (friend.playing.game === 'mahjong' && friend.playing.started) {
        return '正在玩 ' + title + '（已开局）';
      }
      // AI 小镇没有"开局"，房主开着就能进；房主关了加入就只显示在玩
      if (friend.playing.game === 'ai-town') {
        return '正在玩 ' + title + (friend.playing.joinable ? '（可加入）' : '');
      }
      return '正在玩 ' + title;
    }
    return '在线';
  }

  function renderFriends() {
    var list = $('friend-list');
    UI.clear(list);
    state.friends = Net.friends.slice();

    var online = state.friends.filter(function (f) { return f.online; }).length;
    $('friends-count').textContent = state.friends.length
      ? online + ' / ' + state.friends.length + ' 人在线'
      : '0 人在线';
    $('friend-empty').hidden = state.friends.length > 0;

    renderRequests();

    state.friends.forEach(function (friend) {
      // 点他的 ID 复制
      var idButton = UI.el('button', {
        class: 'friend-id',
        type: 'button',
        title: '点一下复制他的 ID',
        onclick: function () { UI.copyText(friend.id, '他的 ID'); },
      }, [UI.el('code', { text: friend.id })]);

      var actions = [];

      // 他正开着房间等人 → 直接进去（比等他发邀请快一步）
      if (friend.playing && friend.playing.joinable) {
        var spectate = friend.playing.game === 'noname' && friend.playing.started;
        actions.push(UI.el('button', {
          class: 'friend-join',
          type: 'button',
          onclick: function () { enterGame(friend.playing.game, friend.playing.code); },
        }, spectate ? '观战' : '进入'));
      }

      actions.push(UI.el('button', {
        class: 'friend-remove',
        type: 'button',
        title: '删除好友',
        onclick: function () { removeFriend(friend); },
      }, '删'));

      list.appendChild(UI.el('li', {
        class: 'friend' + (friend.online ? ' is-online' : ''),
      }, [
        // 名字和 ID 一行，状态和按钮一行 —— 手机上 360px 宽塞不下单行
        UI.el('div', { class: 'friend-top' }, [
          UI.el('span', { class: 'dot', 'aria-hidden': 'true' }),
          window.FrpReact ? window.FrpReact.avatarEl({
            id: friend.id,
            name: friend.name,
            avatar: friend.avatar,
            size: 36,
            cls: 'friend-avatar',
          }) : null,
          UI.el('span', { class: 'friend-name', text: friend.name }),
          idButton,
        ]),
        UI.el('div', { class: 'friend-bottom' }, [
          UI.el('span', { class: 'friend-status', text: friendStatusText(friend) }),
          UI.el('div', { class: 'friend-actions' }, actions),
        ]),
      ]));
    });
  }

  /**
   * 好友面板里"申请"的两块：别人加我的（同意/拒绝）、我加别人的（撤回）。
   *
   * **没有待处理申请时整块隐藏**（连标题一起）—— 留一个空标题在那儿，
   * 用户会以为自己的申请丢了。隐藏用 `hidden` 属性，CSS 里配了 `[hidden]` 兜底。
   *
   * 视觉上沿用好友行那一套卡片/按钮样式，没有另造一套设计。
   */
  function renderRequests() {
    var incomingList = $('friend-incoming-list');
    var outgoingList = $('friend-outgoing-list');
    UI.clear(incomingList);
    UI.clear(outgoingList);

    state.incoming.forEach(function (who) {
      incomingList.appendChild(UI.el('li', { class: 'friend' }, [
        UI.el('div', { class: 'friend-top' }, [
          window.FrpReact ? window.FrpReact.avatarEl({
            id: who.id,
            name: who.name,
            avatar: who.avatar,
            size: 36,
            cls: 'friend-avatar',
          }) : null,
          UI.el('span', { class: 'friend-name', text: who.name }),
          UI.el('code', { class: 'friend-req-id', text: who.id }),
        ]),
        UI.el('div', { class: 'friend-bottom' }, [
          UI.el('span', { class: 'friend-status', text: '想加你为好友' }),
          UI.el('div', { class: 'friend-actions' }, [
            UI.el('button', {
              class: 'friend-accept',
              type: 'button',
              onclick: function () { answerRequest('accept', who); },
            }, '同意'),
            UI.el('button', {
              class: 'friend-decline',
              type: 'button',
              onclick: function () { answerRequest('decline', who); },
            }, '拒绝'),
          ]),
        ]),
      ]));
    });

    state.outgoing.forEach(function (who) {
      outgoingList.appendChild(UI.el('li', { class: 'friend' }, [
        UI.el('div', { class: 'friend-top' }, [
          window.FrpReact ? window.FrpReact.avatarEl({
            id: who.id,
            name: who.name,
            avatar: who.avatar,
            size: 36,
            cls: 'friend-avatar',
          }) : null,
          UI.el('span', { class: 'friend-name', text: who.name }),
          UI.el('code', { class: 'friend-req-id', text: who.id }),
        ]),
        UI.el('div', { class: 'friend-bottom' }, [
          UI.el('span', { class: 'friend-status', text: '等待对方同意' }),
          UI.el('div', { class: 'friend-actions' }, [
            UI.el('button', {
              class: 'friend-cancel',
              type: 'button',
              title: '撤回这条申请',
              onclick: function () { answerRequest('cancel', who); },
            }, '撤回'),
          ]),
        ]),
      ]));
    });

    $('friend-incoming').hidden = state.incoming.length === 0;
    $('friend-outgoing').hidden = state.outgoing.length === 0;

    // 申请一变就要重算那颗小红点（待处理数 + 有没有"新来的"）
    renderFriendBadge();
  }

  /* ============================== 渲染：游戏 ============================== */

  /*
   * 首页游戏列表（2026-11 用户要求）：
   *   · 顶部一行搜索框 + 右边一颗圆形「筛」按钮，点开按人数缩小范围；
   *   · 按标题首字母（拼音）分组排序，最右侧一列完整 A–Z 字母表；
   *   · 每个游戏的介绍不超过 35 个字（数据在 games.js，用例钉着）。
   *
   * 字母表为什么是完整 26 个：用户要的就是通讯录那种字母表。有游戏的字母是
   * ≥44px 的按钮（可点跳转），没游戏的字母是灰色小字（不可点、也不是 tab 停靠点）。
   */

  var PLAYER_FILTERS = [
    { value: 'all', label: '全部' },
    { value: '1', label: '1 人' },
    { value: '2', label: '2 人' },
    { value: '3', label: '3 人' },
    { value: '4', label: '4 人' },
    { value: '5+', label: '5 人以上' },
  ];
  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  function playerRange(game) {
    var min = Number(game.minPlayers) || 1;
    var max = Number(game.maxPlayers) || min;
    return min === max ? min + ' 人' : min + '–' + max + ' 人';
  }

  function gameMatches(game, query, players) {
    if (players) {
      var min = Number(game.minPlayers) || 1;
      var max = Number(game.maxPlayers) || min;
      if (players === '5+') {
        if (max < 5) return false;
      } else {
        var n = Number(players);
        if (!(min <= n && n <= max)) return false;
      }
    }
    if (!query) return true;
    var hay = [
      game.title,
      game.desc,
      (game.tags || []).join(' '),
      playerRange(game),
    ].join(' ').toLowerCase();
    return hay.indexOf(query) !== -1;
  }

  function sortedGames(games) {
    return games.slice().sort(function (a, b) {
      var la = String(a.letter || '#').toUpperCase();
      var lb = String(b.letter || '#').toUpperCase();
      if (la !== lb) return la < lb ? -1 : 1;
      // 同首字母内按拼音（浏览器自带 ICU，不引第三方拼音库）
      return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
    });
  }

  function renderGames() {
    var grid = $('game-grid');
    var rail = $('game-letters');
    if (!grid || !rail) return;
    UI.clear(grid);
    UI.clear(rail);

    var all = Array.isArray(window.GAMES) ? window.GAMES : [];
    var query = state.gameQuery;
    var players = state.gamePlayers;
    var shown = sortedGames(all.filter(function (game) {
      return gameMatches(game, query, players);
    }));

    var filtering = Boolean(query) || Boolean(players);
    $('games-count').textContent = filtering
      ? shown.length + ' / ' + all.length + ' 个'
      : all.length + ' 个';

    if (!all.length) {
      grid.appendChild(UI.el('p', { class: 'empty', text: '还没有游戏。在 /assets/js/games.js 里加一条就会出现。' }));
      renderLetterRail([]);
      return;
    }
    if (!shown.length) {
      grid.appendChild(UI.el('p', { class: 'empty', text: '没有符合条件的游戏。' }));
      grid.appendChild(UI.el('button', {
        class: 'btn btn-small',
        type: 'button',
        onclick: resetGameFilters,
      }, '清空搜索和筛选'));
      renderLetterRail([]);
      return;
    }

    // 按字母分组：同组共用一个字母标题，卡片保持原来的 .game-card 结构
    var groups = {};
    shown.forEach(function (game) {
      var letter = String(game.letter || '#').toUpperCase();
      (groups[letter] = groups[letter] || []).push(game);
    });

    var present = Object.keys(groups).sort();
    present.forEach(function (letter) {
      var section = UI.el('section', {
        class: 'game-group',
        'data-letter': letter,
      }, [
        UI.el('h3', {
          class: 'game-letter',
          id: 'game-letter-' + letter,
          text: letter,
        }),
      ]);
      var cards = UI.el('div', { class: 'game-group-cards' });
      groups[letter].forEach(function (game) {
        cards.appendChild(gameCard(game));
      });
      section.appendChild(cards);
      grid.appendChild(section);
    });

    renderLetterRail(present);
    requestAnimationFrame(updateActiveLetter);
  }

  function gameCard(game) {
    // 两种卡片：
    //   · 平台的游戏（有 slug）—— 要在服务器上"接着"才点得动，点了进房间；
    //   · 外部托管页（有 href，比如 /noname/）—— 不是平台的游戏、服务器里没有它的房间层。
    // 两种都**新窗口打开**（用户要求统一）。
    // ⛔ href 卡片**不许**写成 slug：slug 会被当成 /games/<slug>/ 去拼。
    var href = typeof game.href === 'string' && game.href ? game.href : null;
    var ready = Boolean(href) || state.available.indexOf(game.slug) !== -1;

    var actions = UI.el('div', { class: 'card-actions' }, [
      UI.el('button', {
        class: 'btn' + (ready ? ' btn-primary' : ''),
        type: 'button',
        disabled: !ready,
        onclick: function () {
          if (!ready) {
            UI.toast('这个游戏还没接上服务器', 'info');
            return;
          }
          if (href) {
            openGame(href);
            return;
          }
          enterGame(game.slug);
        },
      }, ready ? '开始游戏' : '还没接上服务器'),
    ]);

    var tags = UI.el('div', { class: 'card-tags' });
    (game.tags || []).forEach(function (tag) {
      tags.appendChild(UI.el('span', { class: 'pill', text: tag }));
    });
    tags.appendChild(UI.el('span', { class: 'pill', text: playerRange(game) }));

    var body = UI.el('div', { class: 'card-body' }, [
      UI.el('h3', { text: game.title }),
      game.desc ? UI.el('p', { text: game.desc }) : null,
      tags.childNodes.length ? tags : null,
      actions,
    ]);

    return UI.el('article', {
      class: 'game-card' + (ready ? '' : ' is-offline'),
    }, [
      UI.el('div', { class: 'card-icon', 'aria-hidden': 'true', text: game.icon || '🎮' }),
      body,
    ]);
  }

  function renderLetterRail(present) {
    var rail = $('game-letters');
    UI.clear(rail);
    var have = {};
    present.forEach(function (letter) { have[letter] = true; });

    ALPHABET.forEach(function (letter) {
      if (have[letter]) {
        rail.appendChild(UI.el('button', {
          class: 'letter-btn',
          type: 'button',
          text: letter,
          'data-letter': letter,
          'aria-label': '跳到 ' + letter + ' 开头的游戏',
          onclick: function () { scrollToLetter(letter); },
        }));
      } else {
        rail.appendChild(UI.el('span', {
          class: 'letter-off',
          'aria-hidden': 'true',
          text: letter,
        }));
      }
    });
  }

  function scrollToLetter(letter) {
    var head = $('game-letter-' + letter);
    if (!head) return;
    try {
      head.scrollIntoView({ behavior: fxOn() ? 'smooth' : 'auto', block: 'start' });
    } catch (err) {
      head.scrollIntoView();
    }
  }

  /** 滚动时把当前所在分组的字母点亮（纯装饰，失败也不影响任何功能）。 */
  var letterSpyQueued = false;
  function scheduleLetterSpy() {
    if (letterSpyQueued) return;
    letterSpyQueued = true;
    requestAnimationFrame(function () {
      letterSpyQueued = false;
      updateActiveLetter();
    });
  }

  function updateActiveLetter() {
    var rail = $('game-letters');
    if (!rail) return;
    var buttons = rail.querySelectorAll('.letter-btn');
    if (!buttons.length) return;
    var sections = document.querySelectorAll('#game-grid .game-group');
    if (!sections.length) return;

    var active = sections[0].getAttribute('data-letter');
    for (var i = 0; i < sections.length; i += 1) {
      if (sections[i].getBoundingClientRect().top <= 120) {
        active = sections[i].getAttribute('data-letter');
      } else {
        break;
      }
    }
    for (var j = 0; j < buttons.length; j += 1) {
      var on = buttons[j].getAttribute('data-letter') === active;
      buttons[j].classList.toggle('is-active', on);
      if (on) buttons[j].setAttribute('aria-current', 'true');
      else buttons[j].removeAttribute('aria-current');
    }
  }

  function setPlayersFilter(value) {
    state.gamePlayers = value === 'all' ? null : value;
    var chips = $('game-filter-chips');
    if (chips) {
      Array.prototype.forEach.call(chips.children, function (chip) {
        var on = chip.getAttribute('data-value') === value;
        chip.classList.toggle('is-active', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    var button = $('game-filter');
    if (button) button.classList.toggle('is-active', state.gamePlayers !== null);
    renderGames();
  }

  function closeFilter() {
    var pop = $('game-filter-pop');
    var button = $('game-filter');
    if (!pop || !button) return;
    pop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  function resetGameFilters() {
    state.gameQuery = '';
    var search = $('game-search');
    if (search) search.value = '';
    setPlayersFilter('all');
    renderGames();
  }

  function bindGamesToolbar() {
    var search = $('game-search');
    if (search) {
      search.addEventListener('input', function () {
        state.gameQuery = String(search.value || '').trim().toLowerCase();
        renderGames();
      });
    }

    var chips = $('game-filter-chips');
    if (chips) {
      PLAYER_FILTERS.forEach(function (filter) {
        chips.appendChild(UI.el('button', {
          class: 'filter-chip',
          type: 'button',
          'data-value': filter.value,
          'aria-pressed': filter.value === 'all' ? 'true' : 'false',
          onclick: function () {
            setPlayersFilter(filter.value);
            closeFilter();
          },
        }, filter.label));
      });
    }

    var button = $('game-filter');
    if (button) {
      button.addEventListener('click', function (event) {
        event.stopPropagation();
        var pop = $('game-filter-pop');
        if (!pop) return;
        var open = pop.hidden;
        pop.hidden = !open;
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }

    // 点空白处 / 按 Esc 收起筛选气泡
    document.addEventListener('click', function (event) {
      var pop = $('game-filter-pop');
      if (!pop || pop.hidden) return;
      if (pop.contains(event.target)) return;
      if (button && (button === event.target || button.contains(event.target))) return;
      closeFilter();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeFilter();
    });

    window.addEventListener('scroll', scheduleLetterSpy, { passive: true });
  }

  /* ============================== 好友操作 ============================== */

  function addFriend(rawId) {
    var id = P.normalizeCode(rawId, P.ID_LENGTH);
    if (!id) {
      UI.toast('ID 是 ' + P.ID_LENGTH + ' 位字母数字，请检查一下', 'error');
      return;
    }
    if (state.me && id === state.me.id) {
      UI.toast('那是你自己的 ID', 'error');
      return;
    }
    if (!Net.connected) {
      UI.toast('还没连上服务器，稍等一下再试', 'error');
      return;
    }

    // 现在按一下只是**发申请**，不是立刻成为好友 —— 所以提示必须说清楚，
    // 否则用户会以为已经加上了（这正是这次要改掉的那个误会）。
    // 对方也申请过我时，服务端会直接判成互相同意，提示也要跟着变。
    var mutual = state.incoming.some(function (r) { return r.id === id; });

    Net.send(T.FRIEND_ADD, { id: id });
    $('friend-id').value = '';

    if (mutual) UI.toast('对方也申请过你，你们已经是好友了', 'ok');
    else UI.toast('已发送好友申请，等对方同意', 'ok');
  }

  /** 处理一条申请：同意 / 拒绝 / 撤回。服务端回快照后界面自己会重画。 */
  function answerRequest(what, who) {
    if (!Net.connected) {
      UI.toast('还没连上服务器，稍等一下再试', 'error');
      return;
    }
    if (what === 'accept') Net.send(T.FRIEND_ACCEPT, { id: who.id });
    else if (what === 'decline') Net.send(T.FRIEND_DECLINE, { id: who.id });
    else Net.send(T.FRIEND_CANCEL, { id: who.id });
  }

  function removeFriend(friend) {
    if (!UI.confirmText('确定删掉好友「' + friend.name + '」吗？')) return;
    Net.send(T.FRIEND_REMOVE, { id: friend.id });
  }

  /* ============================== 连接状态 ============================== */

  /**
   * 「设置」栏里那一行连接状态（原来长在顶栏上，搬过来行为没变）。
   *
   * 为什么要有：公网链路上偶尔会把 WS 升级请求吞掉，GameNet 会在 connectTimeoutMs
   * 之后主动放弃并退避重连（见 shared/net/net.js 的 CONNECT_TIMEOUT_MS）。
   * 浏览器自己那 60 秒里界面一声不响，用户会以为页面卡死了 —— 所以把这段画出来。
   *
   * ⚠️ **只在没连上的时候出现**：连上之后整行藏掉，因为"已连接"这个信息平时没有价值。
   *    这是搬到设置栏之前就有的行为，别顺手改成常驻。
   * ⚠️ 两处 display 都要切：
   *      · `#conn-status` 自己 —— tests/login-race.browser.mjs 直接读它的 computed display
   *      · `#row-conn` 整行 —— 不然会剩下一个只有标题、右边空着的怪行
   * ⚠️ 必须用 style.display，不能只用 hidden 属性：.pill 设了 display: inline-flex，
   *    会盖掉浏览器默认的 [hidden]{display:none}（同样的坑见 .friend-group[hidden]）。
   */
  function renderConnStatus() {
    var el = $('conn-status');
    if (!el) return;
    var down = !Net.connected;
    el.style.display = down ? '' : 'none';
    var row = $('row-conn');
    if (row) row.style.display = down ? '' : 'none';
  }

  /* ============================== 设置栏：偏好开关 ============================== */

  /**
   * 音效 / 特效两个开关。
   *
   * 【为什么不是自己存一份 localStorage】
   * 平台只有**一份**偏好：`FrpUI.prefs`（存 `frp.prefs`，见 shared/ui/ui.js）。
   * 三个游戏里也有音效开关，它们都是这份偏好的入口 —— 各存各的就会出现
   * "平台里开着、进游戏是关的"这种打架局面（用户点名要求过）。
   * 所以这里：
   *   · 显示状态一律读 `sound()` / `fx()`（不缓存）
   *   · 点一下写 `setSound()` / `setFx()`（它会通知所有订阅者）
   *   · 再用 `prefs.on()` 订阅回来重画 —— 这样**另一个标签页**改了这边也会跟着变
   *
   * 特效开关还顺手管两件平台自己的事：
   *   · `FrpAnim.setEnabled(fx)` —— 演出队列：关掉之后一步占 0ms（游戏里的动画立刻演完）
   *   · `body.no-fx` —— 本页 CSS 靠它跳过栏目切换的淡入淡出
   */
  function renderSwitch(el, on) {
    if (!el) return;
    el.classList.toggle('is-on', on);
    el.setAttribute('aria-checked', on ? 'true' : 'false');
    el.textContent = on ? '开' : '关';
  }

  function syncPrefsUi() {
    var sound = UI.prefs.sound();
    var fx = UI.prefs.fx();
    renderSwitch($('switch-sound'), sound);
    renderSwitch($('switch-fx'), fx);

    var Anim = window.FrpAnim;
    if (Anim && typeof Anim.setEnabled === 'function') Anim.setEnabled(fx);
    document.body.classList.toggle('no-fx', !fx);
  }

  function bindPrefs() {
    var soundSwitch = $('switch-sound');
    var fxSwitch = $('switch-fx');
    // 读现在的值再取反 —— 状态的**唯一来源**是 prefs，按钮自己不存任何东西
    if (soundSwitch) {
      soundSwitch.addEventListener('click', function () {
        UI.prefs.setSound(!UI.prefs.sound());
      });
    }
    if (fxSwitch) {
      fxSwitch.addEventListener('click', function () {
        UI.prefs.setFx(!UI.prefs.fx());
      });
    }
    UI.prefs.on(syncPrefsUi);
    syncPrefsUi();
  }

  /* ============================== 头像 ============================== */

  /**
   * 上传前先在浏览器里压成 256×256（居中裁成正方形）。
   * 为什么在客户端压：服务端零第三方依赖，不想为"缩图"引入 sharp 之类；
   * 而手机原图动辄几 MB，直接传既慢又会被 2 MB 上限挡下来。
   */
  function compressAvatar(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || '')) {
        reject(new Error('请选择一张图片'));
        return;
      }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var size = 256;
          var canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          var ctx = canvas.getContext('2d');
          var scale = Math.max(size / img.width, size / img.height);
          var w = img.width * scale;
          var h = img.height * scale;
          ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
          URL.revokeObjectURL(url);
          canvas.toBlob(function (blob) {
            if (blob) resolve(blob);
            else reject(new Error('图片处理失败，换一张试试'));
          }, 'image/webp', 0.9);
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(new Error('图片处理失败，换一张试试'));
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('这张图片打不开，换一张试试'));
      };
      img.src = url;
    });
  }

  /** 真正发请求：POST 原始图片字节 / DELETE 恢复默认。 */
  function avatarRequest(method, blob) {
    var init = { method: method, credentials: 'same-origin' };
    if (blob) {
      init.body = blob;
      init.headers = { 'content-type': blob.type || 'image/png' };
    }
    return fetch('/api/avatar', init).then(function (res) {
      return res.json().catch(function () {
        throw new Error('服务端返回了非 JSON 内容（HTTP ' + res.status + '）');
      }).then(function (data) {
        if (!res.ok || data.ok === false) throw new Error(data.message || '上传失败');
        return data;
      });
    });
  }

  function applyMe(data) {
    state.me = data.me;
    if (typeof Net.rememberMe === 'function') Net.rememberMe(state.me);
    renderMe();
  }

  function uploadAvatar(file) {
    compressAvatar(file).then(function (blob) {
      return avatarRequest('POST', blob);
    }).then(function (data) {
      applyMe(data);
      UI.toast('头像已更新', 'ok');
    }).catch(function (err) {
      UI.toast(err.message, 'error');
    });
  }

  function resetAvatar() {
    if (!UI.confirmText('恢复成默认头像？')) return;
    avatarRequest('DELETE').then(function (data) {
      applyMe(data);
      UI.toast('已恢复默认头像', 'ok');
    }).catch(function (err) {
      UI.toast(err.message, 'error');
    });
  }

  /** 改名字：ID 不变，好友关系不变；房间座位和无名杀会跟着刷新。 */
  function renameMe() {
    if (!state.me) return;
    var next = window.prompt('新的名字（1–10 个字符，中文 / emoji 都行）', state.me.name);
    if (next === null) return;
    var check = P.validateName(next);
    if (!check.ok) {
      UI.toast(check.message, 'error');
      return;
    }
    if (check.name === state.me.name) return;
    Net.api('/api/name', { name: check.name }).then(function (data) {
      applyMe(data);
      UI.toast('名字已更新', 'ok');
    }).catch(function (err) {
      UI.toast(err.message, 'error');
    });
  }

  /* ============================== 登录后的回跳 ============================== */

  /**
   * 无名杀没登录时会被服务端 302 到 `/?return=<原地址>`，登录完要回去。
   *
   * 只接受**本站路径**（以单个 `/` 开头、不是 `//host`），避免被拼成一个跳去外站的链接。
   */
  function returnTarget() {
    var raw = new URLSearchParams(window.location.search).get('return');
    if (!raw || raw.charAt(0) !== '/') return null;
    // 只接受站内路径。`//evil.com` 是协议相对地址；`/\evil.com` 更阴 ——
    // 浏览器 URL 解析器会把反斜杠当斜杠，等价于 `//evil.com`。
    if (raw.charAt(1) === '/' || raw.indexOf('\\') !== -1) return null;
    return raw;
  }

  function goReturnTarget() {
    var target = returnTarget();
    if (!target) return;
    if (target === window.location.pathname + window.location.search) return;
    window.location.replace(target);
  }

  /* ============================== 进入平台 ============================== */

  function enterApp() {
    renderMe();
    renderFriends();
    renderGames();
    // 默认落在最左那一栏：游戏（用户要求）
    showColumn('games');
    showScreen('app');

    Net.on(T.READY, function (msg) {
      state.me = msg.me;
      renderMe();
    });
    Net.on(T.FRIENDS, function (msg) {
      // friends 是**全量**快照：已接受的好友 + 两个方向的待处理申请
      state.incoming = msg.incoming || [];
      state.outgoing = msg.outgoing || [];
      renderFriends();
    });
    Net.on(T.ERROR, function (msg) { UI.toast(msg.message, 'error'); });
    Net.on('close', function () {
      // 自动重连由 GameNet 负责，这里只提示一句
      renderConnStatus();
      UI.toast('与服务器的连接断了，正在重连…', 'error', 2600);
    });
    // 建连超时（多半是公网那段链路把升级请求吞了）：GameNet 会自己退避重连，
    // 用户什么都不用做，所以只提示一句 + 「设置」栏里那一行连接状态。
    Net.on('timeout', function (msg) {
      renderConnStatus();
      UI.toast('连接服务器超时（' + Math.round(msg.ms / 1000) + ' 秒没连上），正在重试…', 'error', 3000);
    });
    Net.on('connecting', renderConnStatus);
    Net.on('open', renderConnStatus);

    // 收到邀请时的弹窗由共用组件统一处理；在平台上接受就跳到那个游戏的页面
    if (window.FrpRoom) {
      window.FrpRoom.handleInvites({
        goToGame: enterGame,
        gameTitle: gameTitle,
      });
    }

    Net.connect();
    // connect() 是同步发起建连的，这时 connected 还是 false —— 先把状态画对
    renderConnStatus();

    // 从无名杀登录门 / 邀请深链过来的：回原地址（带 frpJoin 的会继续自动进房）
    goReturnTarget();
  }

  /* ============================== 登录 / 注册 ============================== */

  function bindAuthForms() {
    $('tab-login').addEventListener('click', function () { switchTab('login'); });
    $('tab-register').addEventListener('click', function () { switchTab('register'); });

    $('form-login').addEventListener('submit', function (event) {
      event.preventDefault();
      var id = $('login-id').value.trim();
      var password = $('login-password').value;
      if (!id || !password) { UI.toast('ID 和密码都要填', 'error'); return; }

      Net.api('/api/login', { id: id, password: password }).then(function (data) {
        $('login-password').value = '';
        adoptMe(data);
        enterApp();
      }).catch(function (err) {
        UI.toast(err.message, 'error');
      });
    });

    $('form-register').addEventListener('submit', function (event) {
      event.preventDefault();
      var name = $('register-name').value.trim();
      var password = $('register-password').value;
      var again = $('register-password2').value;

      var nameCheck = P.validateName(name);
      if (!nameCheck.ok) { UI.toast(nameCheck.message, 'error'); return; }
      var pwCheck = P.validatePassword(password);
      if (!pwCheck.ok) { UI.toast(pwCheck.message, 'error'); return; }
      // 没有密码找回渠道，所以确认框是唯一的防手滑手段
      if (password !== again) { UI.toast('两次输入的密码不一样', 'error'); return; }

      Net.api('/api/register', { name: nameCheck.name, password: password }).then(function (data) {
        $('register-password').value = '';
        $('register-password2').value = '';
        // 先认下账号（顺手让在途的旧探测作废），但界面要等用户抄完 ID 再切
        adoptMe(data);
        showIdModal(data.me.id, function () { enterApp(); });
      }).catch(function (err) {
        UI.toast(err.message, 'error');
      });
    });
  }

  /** 注册成功后必须让用户看到并抄下 ID —— 这是唯一一次机会。 */
  function showIdModal(id, done) {
    var modal = $('modal-id');
    var button = $('new-id');
    button.textContent = id;
    button.onclick = function () { UI.copyText(id, '你的 ID'); };
    modal.hidden = false;

    $('btn-id-done').onclick = function () {
      modal.hidden = true;
      done();
    };

    // 顺带把 ID 填进登录框，方便下次
    $('login-id').value = id;
  }

  /* ============================== 启动 ============================== */

  function bindChrome() {
    // 「设置」栏里那颗 ID 按钮：点一下复制（原来长在顶栏上，行为没变）
    $('me-id').addEventListener('click', function () {
      if (state.me) UI.copyText(state.me.id, '你的 ID');
    });

    /* 头像：选图 → 客户端压缩 → 上传；恢复默认是 DELETE。 */
    var avatarFile = $('avatar-file');
    var avatarPick = $('avatar-pick');
    if (avatarPick && avatarFile) {
      avatarPick.addEventListener('click', function () { avatarFile.click(); });
      avatarFile.addEventListener('change', function () {
        var file = avatarFile.files && avatarFile.files[0];
        if (file) uploadAvatar(file);
        avatarFile.value = '';
      });
    }
    var avatarReset = $('avatar-reset');
    if (avatarReset) avatarReset.addEventListener('click', resetAvatar);
    var renameButton = $('rename-me');
    if (renameButton) renameButton.addEventListener('click', renameMe);

    $('btn-logout').addEventListener('click', function () {
      Net.api('/api/logout', {}).then(function () {
        Net.close();
        // 顺手把记着的身份一起忘掉（localStorage 的 `frp.me`）。
        // 为什么必须忘：那是一份"显示用"的缓存，留着的话登出后重新打开页面
        // 会先闪出上一个账号的名字/ID（虽然服务端马上会把它纠正过来）。
        if (typeof Net.forgetMe === 'function') Net.forgetMe();
        window.location.reload();
      }).catch(function () {
        window.location.reload();
      });
    });

    $('form-friend-add').addEventListener('submit', function (event) {
      event.preventDefault();
      addFriend($('friend-id').value);
    });
  }

  function boot() {
    bindAuthForms();
    bindChrome();
    bindTabbar();
    bindPrefs();
    bindGamesToolbar();
    // 平台外壳所有按钮/链接的点击音（用户第 4 条反馈）。
    // 只接一次、接在 document 上：button / a[href] / role=tab / 勾选框 / [data-frp-click]
    // 自动生效，disabled 和 [data-frp-nosound] 自动静音 —— 所以这里不用给每个按钮写代码。
    // ⚠️ 游戏页面**不要**调它（游戏有自己的音效包，接了会同一下响两声）。
    if (UI && UI.sound && typeof UI.sound.bindClicks === 'function') UI.sound.bindClicks(document);
    renderConnStatus();

    // 已登录就直接进平台；没登录（401）就停在登录页。
    //
    // ⚠️ epoch 是这条探测的"身份证"。用户可能在它回来之前就自己登录了
    //    （手快 / 密码管理器自动填充）—— 那时 adoptMe() 已经把 authEpoch 加过 1，
    //    这个迟到的 401 就必须**原地作废**，不许再把界面翻回登录页。
    //    没有这一步就会出现"界面停在登录页，但 GameNet.me 已经是本人了"。
    var epoch = authEpoch;

    Net.api('/api/me').then(function (data) {
      if (epoch !== authEpoch) return;   // 已经登录了，这条探测过期
      adoptMe(data);
      enterApp();
    }).catch(function () {
      if (epoch !== authEpoch) return;   // 同上：晚到的 401 不许翻转界面
      // 真的没登录（不是晚到的那条）：记着的身份也清掉 —— 会话已经过期了，
      // 留着只会让游戏页先闪出一个早就没登录的名字。
      // ⚠️ 必须写在这条守卫**里面**：放到外面就会在"迟到的 401"那一次
      //    把刚登录的人的身份抹掉（tests/login-race.browser.mjs 钉着这条）。
      if (typeof Net.forgetMe === 'function') Net.forgetMe();
      showScreen('auth');
    });
  }

  boot();
})();