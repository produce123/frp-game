/*
 * 前端网络层 —— **三个游戏和平台外壳共用这一份**。
 *
 * 职责：一条 WebSocket（自动重连）+ 一点 HTTP API 包装。
 * 它**不认识任何消息类型**（类型常量在 /shared/protocol.mjs，见 window.FrpProtocol.T），
 * 只是个收发管道 —— 这样以后加游戏不用碰这个文件。
 *
 * 为什么写成经典全局脚本而不是 ES Module：
 * Cannon Goblin 是"全局函数 + 内联 onclick"的经典脚本结构（见它的 AGENTS.md），
 * 经典脚本无法 import 模块。写成全局脚本，三种加载风格的游戏都能用同一份。
 *
 * 用法：
 *   <script type="module" src="/shared/protocol.mjs"></script>
 *   <script defer src="/shared/net/net.js"></script>
 *   GameNet.on(FrpProtocol.T.ROOM_STATE, function (msg) { … });
 *   GameNet.send(FrpProtocol.T.ROOM_JOIN, { code: 'ABC123' });
 */
(function (root) {
  'use strict';

  /** type -> handler[] */
  var handlers = Object.create(null);

  var socket = null;
  /** 正在建连的候选连接（竞速时可能同时有两条）。见 RACE_DELAY_MS。 */
  var candidates = [];
  var attempts = 0;
  var reconnectTimer = null;
  var stopped = false;
  /** 建连计时器：见 net.connectTimeoutMs 的说明 */
  var connectTimer = null;
  /** 竞速计时器：见 net.raceDelayMs 的说明 */
  var raceTimer = null;
  /** 心跳计时器：见 net.pingEveryMs 的说明 */
  var pingTimer = null;
  /** 已经发过一句 ping，还没等到 pong */
  var pingOutstanding = false;

  /**
   * 建连超时的默认值（毫秒）。
   *
   * 为什么必须有这一条：公网链路上「浏览器 → Cloudflare → 隧道节点」这一段偶尔会把
   * WebSocket 的升级请求**吞掉** —— TCP 连上了、101 永远不回来，浏览器自己也不报错，
   * 要等它 ~60 秒的握手超时才抛 `frame-error: Connection closed before receiving a
   * handshake response`。公网实测约 12%（66 次新建失败 8 次），本机直连 `127.0.0.1:7891`
   * 9 次 0 失败 —— 所以卡的是那一段，不归我们管（升级请求根本进不了 data/server.log）。
   *
   * 我们修不了那一段，但可以不让人干等一分钟：到点还没 `open` 就主动放弃这条连接，
   * 走**现有的**退避重连（scheduleReconnect），一切照旧，不另起一套重连。
   *
   * 取 9 秒的理由：正常公网建连在 1 秒内完成（实测 +1965ms 建对象 → 101 成功那次
   * 也就 1 秒出头），9 秒足够宽松、不会误杀慢连接，又远小于 60。
   */
  var CONNECT_TIMEOUT_MS = 9000;

  /**
   * 建连**竞速**：发起之后这么久还没 open，就并行再开一条，谁先通就用谁。
   *
   * 为什么要有：公网实测约 12% 的新建连接会把升级请求**吞掉**（见上面 CONNECT_TIMEOUT_MS），
   * 那一次要等满 9 秒才放弃重试。玩家感受到的是"点了网页 9 秒没反应"。
   * 吞掉是概率事件，所以同时开两条只有约 1.4% 的概率两条都被吞 ——
   * 大多数情况下第二条在 1 秒内就通，用户几乎察觉不到那一次失败。
   *
   * 代价：偶尔会多一条**用不上**的连接（赢的那条留下，输的那条当场关掉）。
   * 隧道那头看到的是一次"连上又断开"，无副作用。
   * 设成 0 就关掉竞速（测试里会这么用）。
   */
  var RACE_DELAY_MS = 2500;

  /**
   * 应用层心跳间隔。
   *
   * 浏览器的 WebSocket API **发不出**协议层的 ping（那套 API 里根本没有），
   * 所以"这条连接还活着吗"只能靠一条普通消息问。用途有两个：
   *   1. 长时间等对手（比如 60 秒超时等待）时保持链路有数据，别被中间那段掐掉；
   *   2. 真的半死不活时（socket 还是 open，但对面已经不理了）能在 15 秒内发现并重连 ——
   *      不然用户会一直盯着一个"看起来连着、实际什么都没发生"的界面。
   */
  var PING_EVERY_MS = 25000;

  /** 发过 ping 之后这么久还没 pong，就认为这条连接死了。 */
  var PONG_GRACE_MS = 15000;

  var net = {
    /** 自己的身份，登录后由 ready 消息填充：{ id, name } */
    me: null,
    /** 好友列表：[{ id, name, online, playing }]，playing 见下 */
    friends: [],
    /** 当前房间状态（含裁剪过的 view），不在房间时为 null */
    room: null,
    /** WebSocket 是否连着 */
    connected: false,
    /** 正在建连（已发起、还没 open）。界面拿它画「正在连接服务器…」 */
    connecting: false,
    /**
     * 建连超时（毫秒）：这么久还没 open 就主动放弃这条连接、走退避重连。
     * 默认见上面 CONNECT_TIMEOUT_MS 的说明；测试会改小它，好把用例跑快。
     */
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    /** 建连竞速的等待时间（毫秒），0 = 关掉竞速。见 RACE_DELAY_MS。 */
    raceDelayMs: RACE_DELAY_MS,
    /** 心跳间隔（毫秒），0 = 不发心跳。见 PING_EVERY_MS。 */
    pingEveryMs: PING_EVERY_MS,
    /** 发过 ping 之后这么久还没 pong 就认定这条连接死了（毫秒）。测试会改小它。 */
    pongGraceMs: PONG_GRACE_MS,
    /** 最近一次 ping/pong 测出来的往返毫秒数（还没测出来时是 null） */
    latencyMs: null,
  };

  /* ------------------------------ 事件 ------------------------------ */

  function on(type, fn) {
    if (typeof fn !== 'function') return net;
    (handlers[type] || (handlers[type] = [])).push(fn);
    return net;
  }

  function off(type, fn) {
    var list = handlers[type];
    if (!list) return net;
    if (!fn) { delete handlers[type]; return net; }
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return net;
  }

  function emit(type, msg) {
    var list = handlers[type];
    if (!list || !list.length) return;
    // 复制一份再遍历：处理器里可能会 off 掉自己
    for (var i = 0, copy = list.slice(); i < copy.length; i++) {
      try {
        copy[i](msg);
      } catch (err) {
        // 一个处理器炸了不该影响别的处理器
        if (root.console) console.error('[GameNet] 处理 ' + type + ' 时出错', err);
      }
    }
  }

  /* ------------------------------ 状态维护 ------------------------------ */

  function absorb(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    var T = root.FrpProtocol && root.FrpProtocol.T;

    /*
     * 心跳回执**先判**：它是一条网络层自己的消息，和"这个文件不认识任何消息类型"
     * 那条规矩一样是刻意的例外（保活必须有一条具体消息，浏览器没有更底层的 ping）。
     * 类型名带兜底字符串，是因为测试会把本文件放进一个**没有 FrpProtocol** 的沙箱里跑。
     */
    if (msg.t === ((T && T.PONG) || 'pong')) {
      if (typeof msg.ts === 'number') net.latencyMs = Math.max(0, Date.now() - msg.ts);
      pingOutstanding = false;
      return;
    }

    if (!T || msg.t === T.READY) {
      if (msg.me) {
        net.me = msg.me;
        rememberMe(msg.me);
      }
    } else if (msg.t === T.FRIENDS) {
      // 全量替换。服务端只有在列表真的变了的时候才推，所以这里不用做 diff。
      // 每项形如 { id, name, online, playing: {game,code,phase,joinable}|null }
      net.friends = msg.list || [];
    } else if (msg.t === T.ROOM_STATE) {
      // 房间永远有房号，所以 `code` 为空就等于"我不在房里了"。
      // 服务端在有人离开时会专门给他补发一条 `{t:'room.state', code:null}` ——
      // 少了这个判断，离开房间的人会一直停在房间界面上（界面以为还在房里）。
      net.room = msg.code ? msg : null;
    }
  }

  /* ------------------------------ 连接 ------------------------------ */

  function wsUrl() {
    var proto = root.location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + root.location.host + '/ws';
  }

  function clearConnectTimer() {
    if (connectTimer) { root.clearTimeout(connectTimer); connectTimer = null; }
  }

  function clearRaceTimer() {
    if (raceTimer) { root.clearTimeout(raceTimer); raceTimer = null; }
  }

  function clearPingTimer() {
    if (pingTimer) { root.clearTimeout(pingTimer); pingTimer = null; }
  }

  /** 把一条候选连接从状态里摘干净：回调全摘掉、关掉它，之后它再说什么都不算数。 */
  function discard(ws) {
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(); } catch (err) { /* 已经断了 */ }
  }

  /**
   * 起一条候选连接。**竞速**就是"同时有好几条候选"，谁先 open 谁算数。
   * （不竞速时这里只会被调用一次，行为和以前完全一样。）
   */
  function openCandidate() {
    var ws = new root.WebSocket(wsUrl());
    candidates.push(ws);
    // socket 始终指向"最新那条候选"：connect() 的守卫、以及外部读 readyState 都靠它。
    socket = ws;

    ws.onopen = function () { adopt(ws); };
    ws.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        if (root.console) console.error('[GameNet] 收到非法 JSON', event.data);
        return;
      }
      absorb(msg);
      emit(msg.t, msg);
    };
    ws.onclose = function () {
      var i = candidates.indexOf(ws);
      if (i >= 0) candidates.splice(i, 1);
      // 这条候选是**输掉的那条**（赢家已经产生）—— 关掉它是预期行为，什么都不做
      //
      // ⚠️ 这里必须写 `net.connected`：曾经写成裸 `connected`（一个不存在的变量），
      //    于是**每次断开都在这句话上抛 ReferenceError**，后面的"标记断开 / 广播 close /
      //    安排重连"三件事一件都不会做 —— 表现是"掉线之后再也不自动重连，
      //    界面还一直显示已连接"，只有刷新页面才好。是 tests/shared.browser.mjs
      //    那条"页面不许有控制台报错"的断言在真浏览器里抓到的。
      if (net.connected && socket !== ws) return;
      if (candidates.length) return;   // 还有别的候选在连，等它们
      clearConnectTimer();
      clearRaceTimer();
      net.connected = false;
      net.connecting = false;
      socket = null;
      emit('close', {});
      scheduleReconnect();
    };
    ws.onerror = function () {
      // onclose 一定会跟着来，重连逻辑统一放在那里
    };
    return ws;
  }

  /** 谁先 open 谁赢：赢家留下，其它候选当场摘掉并关闭。 */
  function adopt(ws) {
    var others = candidates.filter(function (c) { return c !== ws; });
    candidates = [ws];
    for (var i = 0; i < others.length; i++) discard(others[i]);

    clearConnectTimer();
    clearRaceTimer();
    socket = ws;
    attempts = 0;
    net.connected = true;
    net.connecting = false;
    startPing();
    emit('open', {});
  }

  /**
   * 建连超时：到点了还没有任何一条候选通，当它不会再有结果处理。
   *
   * 只做三件事：把所有候选从状态里摘干净、然后走**现成的**退避重连。
   * 不碰重连策略本身（scheduleReconnect 里的 0.5/1/2/4/5 秒退避原样保留）。
   */
  function giveUpConnecting(ms) {
    connectTimer = null;
    if (net.connected) return;    // 这段时间里已经通了，别误杀

    var dead = candidates;
    candidates = [];
    // ⚠️ 必须先把 socket 摘掉：候选多半还停在 CONNECTING（readyState 0），
    //    而 connect() 开头那句守卫看到 CONNECTING 就直接 return ——
    //    不摘掉的话重连会空转，页面永远停在「正在连接服务器…」。
    socket = null;
    net.connected = false;
    net.connecting = false;
    for (var i = 0; i < dead.length; i++) discard(dead[i]);

    emit('timeout', { ms: ms });
    scheduleReconnect();
  }

  /**
   * 心跳：定时问一句"还在吗"。
   * 上一次的 ping 迟迟没有 pong（`net.pongGraceMs`）就认为这条连接死了 ——
   * 主动 close()，让 onclose 那条现成的路去重连。
   */
  function startPing() {
    clearPingTimer();
    pingOutstanding = false;
    if (!(net.pingEveryMs > 0)) return;

    var sentAt = 0;
    var graceMs = function () {
      var g = Number(net.pongGraceMs);
      return Number.isFinite(g) && g >= 0 ? g : PONG_GRACE_MS;
    };
    var beat = function () {
      pingTimer = null;
      if (!net.connected || !socket || socket.readyState !== 1) return;
      if (pingOutstanding) {
        var grace = graceMs();
        if (Date.now() - sentAt < grace) {
          // 还没到判定时间：再等一会儿（心跳间隔可能比宽限期短）
          pingTimer = root.setTimeout(beat, Math.max(50, sentAt + grace - Date.now()));
          return;
        }
        // 上一句还没人应：这条连接是"看起来连着、实际没人理"，重连
        if (root.console) console.warn('[GameNet] 心跳没有回应，判定这条连接已死，重连');
        var dead = socket;
        socket = null;
        net.connected = false;
        net.connecting = false;
        candidates = [];
        pingOutstanding = false;
        discard(dead);
        emit('close', {});
        scheduleReconnect();
        return;
      }
      pingOutstanding = true;
      sentAt = Date.now();
      // ⚠️ 本文件刻意"不认识任何消息类型"（见文件头），只有这一处例外：
      //    保活必须发一条**具体**的消息，浏览器那边没有更底层的 ping 可用。
      var PT = (root.FrpProtocol && root.FrpProtocol.T) || {};
      send(PT.PING || 'ping', { ts: sentAt });
      // 下一次检查取"心跳间隔"和"宽限期"里更短的那个：
      // 否则 25 秒一跳 + 15 秒宽限，第一次发现断链要等到 50 秒，太迟。
      var grace = graceMs();
      pingTimer = root.setTimeout(beat, grace > 0 ? Math.min(net.pingEveryMs, grace) : net.pingEveryMs);
    };

    // 先等一个间隔再问第一句：刚连上就 ping 是浪费
    pingTimer = root.setTimeout(beat, net.pingEveryMs);
  }

  function connect() {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return net;
    stopped = false;

    net.connecting = true;
    emit('connecting', {});

    candidates = [];
    openCandidate();

    // 建连计时：到点还没有任何一条通，就当这条连接被链路吞了（见 CONNECT_TIMEOUT_MS）
    clearConnectTimer();
    var ms = net.connectTimeoutMs > 0 ? net.connectTimeoutMs : CONNECT_TIMEOUT_MS;
    connectTimer = root.setTimeout(function () { giveUpConnecting(ms); }, ms);

    // 竞速：发起之后 RACE_DELAY_MS 还没通，就并行再开一条，谁先通用谁。
    clearRaceTimer();
    var race = Number(net.raceDelayMs);
    if (race > 0 && race < ms) {
      raceTimer = root.setTimeout(function () {
        raceTimer = null;
        if (net.connected || !net.connecting) return;
        if (root.console) console.info('[GameNet] 建连偏慢，并行再开一条（谁先通用谁）');
        openCandidate();
      }, race);
    }

    return net;
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    attempts += 1;
    // 退避：0.5s、1s、2s、4s，封顶 5s
    var delay = Math.min(500 * Math.pow(2, attempts - 1), 5000);
    reconnectTimer = root.setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function close() {
    stopped = true;
    if (reconnectTimer) { root.clearTimeout(reconnectTimer); reconnectTimer = null; }
    clearConnectTimer();
    clearRaceTimer();
    clearPingTimer();
    pingOutstanding = false;
    var dead = candidates;
    candidates = [];
    if (socket && dead.indexOf(socket) === -1) dead.push(socket);
    socket = null;
    for (var i = 0; i < dead.length; i++) discard(dead[i]);
    net.connected = false;
    net.connecting = false;
  }

  /* ---------------- 断网 / 切网 / 回前台：别干等退避，立刻再试 ---------------- */

  /**
   * 立刻重连（跳过退避等待）。
   *
   * 手机上是常态：切到 4G、从后台回前台、Wi-Fi 换热点。浏览器给 `onclose` 的时机
   * 并不固定（有的几百毫秒，有的几秒），退避还要再等 0.5~5 秒 —— 这几秒在用户眼里
   * 就是"点了没反应"。
   *
   * ⚠️ 这里**不动**任何被用例钉住的数字（9 秒建连超时 / 2.5 秒竞速 / 25 秒心跳 /
   *    15 秒宽限），退避策略本身也没变：只是把"已经该重连"的时刻提前。
   */
  function nudge() {
    if (stopped || net.connected || net.connecting) return;
    if (reconnectTimer) {
      root.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    attempts = 0;
    connect();
  }

  if (root.addEventListener) {
    // 网络恢复：立刻连
    root.addEventListener('online', nudge);

    /*
     * 回到前台：连着的时候先**探一下活**。
     *
     * 手机锁屏久了，socket 常常还是 open 状态、对面其实早断了 —— 这种情况下
     * 不主动问一句，用户会对着一个"看起来连着"的界面干等。发一条 ping，
     * 宽限期（pongGraceMs）到了没回应就走现成的"心跳判死 → 重连"。
     */
    if (root.document && root.document.addEventListener) {
      root.document.addEventListener('visibilitychange', function () {
        if (root.document.visibilityState !== 'visible') return;
        if (net.connected) {
          var PT = (root.FrpProtocol && root.FrpProtocol.T) || {};
          send(PT.PING || 'ping', { ts: Date.now() });
          return;
        }
        nudge();
      });
    }
  }

  /* ------------------------------ 发送 ------------------------------ */

  /** 上次提示"还没连上"的时间，见 noteUnsent()。 */
  var lastUnsentAt = 0;

  /**
   * 还没连上就发消息：以前**完全静默**返回 false，界面上看起来就是"点了没反应"
   * （`docs/NEXT.md` 里挂了很久的那条）。现在最多每 4 秒提示一次。
   *
   * 用平台现成的 `FrpUI.toast`；没有 UI 的页面（测试沙箱 / 纯游戏页）退回 console.warn，
   * 这样网络层本身仍然不依赖 UI。
   *
   * ⚠️ 心跳不提示：那是网络层自己的事，不该弹给用户。
   */
  function noteUnsent(type) {
    var PT = (root.FrpProtocol && root.FrpProtocol.T) || {};
    if (type === (PT.PING || 'ping')) return;
    var now = Date.now();
    if (now - lastUnsentAt < 4000) return;
    lastUnsentAt = now;
    if (root.FrpUI && typeof root.FrpUI.toast === 'function') {
      root.FrpUI.toast('还没连上服务器，稍等一下…', 'info', 3000);
    } else if (root.console) {
      console.warn('[GameNet] 还没连上，这条消息没发出去：' + type);
    }
  }

  function send(type, payload) {
    if (!socket || socket.readyState !== 1) {
      noteUnsent(type);
      return false;
    }
    var msg = { t: type };
    if (payload) {
      for (var key in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) msg[key] = payload[key];
      }
    }
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ------------------------------ HTTP API ------------------------------ */

  /*
   * ------------------------------ 身份记忆 ------------------------------
   *
   * 为什么要有：平台首页（游戏列表）和每个游戏页是**两个不同的网页**，
   * 点进游戏是一次整页跳转。游戏页的身份本来只能等 WebSocket 的 `ready` ——
   * 公网那次握手要 2~3 秒，用户看到的是"正在确认身份…"，而且这几秒里点
   * "开始对局"会被误判成"还没登录"（实测真会弹那句提示）。
   *
   * 所以：**谁先把身份拿到手，就顺手记在浏览器里**（平台外壳的 /api/me、
   * WebSocket 的 ready 都算），游戏页一打开先用记着的那份把界面画出来，
   * 等真正的 `ready` 到了再对齐。**这只是显示层的提前**，权限仍然全在服务端：
   * 身份对不上/登录已过期时，服务端该拒就拒，页面拿到 401 要 forgetMe() 清掉。
   *
   * ⚠️ 刻意**不**拿它去填 `net.me`：平台外壳的登录竞态（迟到的 401 不许把界面
   *    翻回登录页，见 tests/login-race.browser.mjs）就是靠"me 只有服务端说了才算"
   *    成立的。预填会把它变成"先信本地、后信服务端"，那条用例立刻红。
   */

  var ME_KEY = 'frp.me';

  function meStore() {
    try { return root.localStorage || null; } catch (err) { return null; }
  }

  /** 记下"我是谁"。字段只留 id / name（多余的别往里塞）。 */
  function rememberMe(me) {
    if (!me || !me.id) return;
    var store = meStore();
    if (!store) return;
    try {
      store.setItem(ME_KEY, JSON.stringify({ id: me.id, name: me.name || '' }));
    } catch (err) { /* 隐私模式写不进去就算了 */ }
  }

  /** 读回记着的身份，没有/坏了都返回 null。 */
  function cachedMe() {
    var store = meStore();
    if (!store) return null;
    var raw = null;
    try { raw = store.getItem(ME_KEY); } catch (err) { return null; }
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (data && typeof data.id === 'string' && data.id) {
        return { id: data.id, name: typeof data.name === 'string' ? data.name : '' };
      }
    } catch (err) { /* 坏了当成没有 */ }
    return null;
  }

  /** 忘掉记着的身份（登出、401 时调）。 */
  function forgetMe() {
    net.me = null;
    var store = meStore();
    if (!store) return;
    try { store.removeItem(ME_KEY); } catch (err) { /* 同上 */ }
  }

  /**
   * 调一个 /api/ 接口。失败时抛 Error，message 是服务端给的中文原因（可直接显示）。
   * 恒定 same-origin + credentials，所以 HttpOnly 会话 cookie 会自动带上。
   */
  function api(path, body) {
    return root.fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () {
        throw new Error('服务端返回了非 JSON 内容（HTTP ' + res.status + '）');
      }).then(function (data) {
        if (!res.ok || data.ok === false) throw new Error(data.message || ('请求失败（HTTP ' + res.status + '）'));
        return data;
      });
    });
  }

  /* ------------------------------ 小工具 ------------------------------ */

  /**
   * 复制文本。
   * HTTP 下 navigator.clipboard 是 undefined（只在安全上下文可用），
   * 而本项目可能通过 http://<公网地址> 访问，所以必须有退路。
   */
  function copy(text) {
    var value = String(text == null ? '' : text);

    if (root.navigator && root.navigator.clipboard && root.isSecureContext) {
      return root.navigator.clipboard.writeText(value).then(function () { return true; }, function () {
        return legacyCopy(value);
      });
    }
    return Promise.resolve(legacyCopy(value));
  }

  function legacyCopy(value) {
    try {
      var area = root.document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      root.document.body.appendChild(area);
      area.select();
      var ok = root.document.execCommand('copy');
      root.document.body.removeChild(area);
      return ok;
    } catch (err) {
      return false;
    }
  }

  net.on = on;
  net.off = off;
  net.send = send;
  net.connect = connect;
  net.close = close;
  net.api = api;
  net.copy = copy;
  net.rememberMe = rememberMe;
  net.cachedMe = cachedMe;
  net.forgetMe = forgetMe;

  root.GameNet = net;
})(typeof window !== 'undefined' ? window : globalThis);