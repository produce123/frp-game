/*
 * 在线对局的界面层 —— **服务器裁决**（docs/GAME-SPEC.md）。
 *
 * 【和原来的区别，改之前先看】
 * 原来这个游戏是"两端各自重放一手棋"：房主把 move 发给对手，双方各跑一遍
 * 同一个 GameState。那套方案存在的唯一理由是玩家没有服务器（见源 AGENTS.md）。
 * 现在有服务器了，所以：
 *   · 房间号、成员、邀请、开局、**加人机** —— 全部交给 /shared/ui/room.js
 *   · 规则由**服务器**跑（server/games/cannon-goblin.mjs），客户端只拿 view
 *   · 公共 MQTT broker、WebRTC 打洞、通路降级、QoS0 补偿、2 秒全量重播 —— **整段删掉**
 *
 * 【本文件负责什么】
 *   1. 往房间的准备区里填本游戏自己的设置项：选边 + 选地图 + 地图编辑器
 *      （人机的座位由平台的房间外壳画：「＋ 添加人机」/「移除」，本游戏不画那个开关）
 *   2. 把服务器下发的 view 拆成"要演的几步"，交给 app.js 的演出队列
 *   3. 把点击翻译成 `room.act` 发出去；**演出期间一律不发**（当成没点，见下）
 *
 * 【不做本地预演 + 演出期间锁输入】（docs/DECISIONS.md D10）
 *   点下去到服务器回包之间，本机**不播任何动画、不出任何音效** —— 原来那套
 *   "发出去就乐观演起手"已经整段删除（用户实测快速连点会把画面演成
 *   "所有人都被打死了"）。画面上"我这一手"由服务端回放的那一步演出来。
 *   同时 `submitOnlineMove` 发消息之前先判 `FrpAnim.busy()`：演出没排空就返回 false
 *   （不发消息、不改界面状态）。⚠️ **这个判断必须自己做**：本文件直接调 `Net.send`，
 *   不走平台 `ctx.act`（平台在那里面兜了一层 busy 判断，这里没有那层兜底）。
 *
 * 【界面只读 view 是怎么做到的】
 * `stateFromView(view)` 用 view 造一个 GameState，渲染函数照旧吃它。
 * 所以客户端手里**永远只有 view 里的信息** —— 这是刻意设计的，不要图省事
 * 把服务器的完整 state 传进来（大炮轰小鬼本来就没有隐藏信息，但以后加了就晚了）。
 * ⚠️ 对阵条上的"谁是电脑"来自**房间成员列表**（`room.state.members[].isBot`），
 * 那不是 view、也不进棋盘报文 —— 见 app.js 的 versusSeats()。
 */

(function () {
  'use strict';

  var P = window.FrpProtocol;
  var T = P.T;
  var Net = window.GameNet;
  var UI = window.FrpUI;
  var Room = window.FrpRoom;

  /** 最近一次 room.state（含 members / hostId / phase / view） */
  var onlineState = null;
  /** FrpRoom 给游戏的上下文（对局中才有） */
  var onlineCtx = null;

  /* ============================== 演出用的游标 ============================== */

  /**
   * 上一帧的 view（纯数据）。
   * 【为什么需要它】服务器**从来不把中间那一帧发下来** —— 真人走完一手、人机在同一
   * 次 act 里被跑完，客户端收到的是"两步之后"的结果。要逐步演完，就得自己拿
   * "上一帧的盘 + 我点的那一手"算一张中间画面出来（scaffoldAfterMine）。
   */
  var lastView = null;
  /** 上一次演过的 lastMove 签名。服务端会重推内容一样的 room.state，同一步不许演两遍。 */
  var lastMoveKey = null;
  /**
   * 我点下去、服务器还没回的那一手。
   *
   * 【现在只服务**回放**，跟本地预演无关了】本地预演已整段删除（docs/DECISIONS.md D10），
   * 但它**不能一起删**：服务器**从来不发中间那一帧** —— 真人走完一手、人机在同一次
   * act 里被跑完，view 里的 `lastMove` 只剩**最后**那一手（人机的），"我那一手"
   * 根本没有报文能还原。所以要演"我这一手"的滑动 / 吃子碎裂，只能靠这里记下的
   * 坐标 + 上一帧的 view 拼一张中间画面（见 planSteps 与 scaffoldAfterMine）。
   * 它同时还是"服务端到底收没收下我这一手"的判据（takePendingMine）。
   *
   * ⚠️ 它**不是**权威状态：不吃子、不换回合、不挪棋子，只用来拼画面。
   */
  var pendingMine = null;

  /** 换局 / 离开房间时清零（"再来一局"必须清，否则上一局的签名会挡住新一局的第一步）。 */
  function resetOnlinePlayback() {
    lastView = null;
    lastMoveKey = null;
    pendingMine = null;
  }

  function meId() { return Net.me && Net.me.id; }

  /** 房主才能决定地图和"再来一局"。**不要**用 playerSide 判断 —— 房主可能选了小鬼方。 */
  function isOnlineHost() {
    return Boolean(onlineState && meId() && onlineState.hostId === meId());
  }

  function el(tag, attrs, children) { return UI.el(tag, attrs, children); }

  /**
   * 无提示音地切屏。
   * 不用 app.js 的 showScreen()：它会放点击音，而这里是"服务器把房间状态推过来"的
   * 自动切换，不该响；而且它在模拟器/无头浏览器里可能因为 WebAudio 还没解锁而报警告。
   */
  function forceScreen(name) {
    document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('is-active'); });
    var node = document.getElementById('screen-' + name);
    if (node) node.classList.add('is-active');
    currentScreen = name;
  }

  /* ============================== 准备区（本游戏自己的设置） ============================== */

  /**
   * FrpRoom 把准备区的一块交给我们画，见 shared/ui/room.js 的 renderSetup。
   * 房主能改，客人只读。
   *
   * ⚠️ **人机不在这里画**。人机现在是房间的**座位**：房主在平台外壳上按「＋ 添加人机」
   * 就多一个座位、成员列表里立刻出现一个灰色虚线圈的单字头像，开局时房间层把它和
   * 真人一起塞进 `createMatch(players, options)`。
   * 本游戏原来的「电脑补位」开关（`data-aifill` + `options.aiFill`）**已整段作废并删除**：
   * 那条契约里"游戏自己偷偷补座位"和"人机不算房间成员"都不作数了。
   */
  function renderSetup(host, ctx) {
    var isHost = ctx.isHost;

    /* ---- 选边 ---- */
    var hostSide = ctx.options.hostSide === 'ghost' ? 'ghost' : 'cannon';
    var guestSide = hostSide === 'cannon' ? 'ghost' : 'cannon';

    var sideRow = el('div', { class: 'cg-setup-row' });
    [['cannon', '💣 大炮方'], ['ghost', '👻 小鬼方']].forEach(function (pair) {
      var side = pair[0];
      sideRow.appendChild(el('button', {
        class: 'side-btn' + (isHost ? (hostSide === side ? ' selected' : '') : (guestSide === side ? ' selected' : '')),
        type: 'button',
        disabled: !isHost,
        onclick: function () {
          AudioManager.playClick();
          ctx.setOption('hostSide', side);
        },
      }, pair[1]));
    });

    host.appendChild(el('div', { class: 'setup-section' }, [
      el('h3', { text: isHost ? '你执哪一方' : '你的阵营' }),
      sideRow,
      el('p', {
        class: 'frp-room-note',
        text: isHost
          ? '大炮方先手。对手自动拿另一方。'
          : '房主执' + (hostSide === 'cannon' ? '大炮方' : '小鬼方') + '，你执' + (guestSide === 'cannon' ? '大炮方' : '小鬼方'),
      }),
    ]));

    /* ---- 选地图 ---- */
    var mapRow = el('div', { class: 'cg-map-list' });
    var chosen = Number(ctx.options.preset);
    if (!Number.isInteger(chosen) || chosen < 0 || chosen >= PRESET_MAPS.length) chosen = 0;

    PRESET_MAPS.forEach(function (map, i) {
      mapRow.appendChild(el('button', {
        class: 'preset-map-btn' + (chosen === i && !usingCustom() ? ' selected' : ''),
        type: 'button',
        disabled: !isHost,
        onclick: function () {
          AudioManager.playClick();
          selectedPreset.online = i;
          syncMapInputs(map);
          ctx.setOption('preset', i);
        },
      }, [
        el('span', { class: 'map-name', text: map.name }),
        el('span', { class: 'map-desc', text: map.desc }),
      ]));
    });

    var mapBox = el('div', { class: 'setup-section' }, [
      el('h3', { text: isHost ? '地图（你说了算）' : '地图（房主选的）' }),
      mapRow,
    ]);

    if (isHost) {
      mapBox.appendChild(el('button', {
        class: 'action-btn',
        type: 'button',
        onclick: function () { showEditor('online'); },
      }, '编辑初始位置'));
    }

    if (usingCustom()) {
      mapBox.appendChild(el('p', {
        class: 'frp-room-note',
        text: '当前使用编辑器摆的 ' + customPositions.width + '×' + customPositions.height + ' 自定义地图',
      }));
      if (isHost) {
        mapBox.appendChild(el('button', {
          class: 'frp-btn frp-btn-ghost',
          type: 'button',
          onclick: function () {
            customPositions = null;
            customSource = null;
            ctx.setOption('custom', null);
          },
        }, '改回预设地图'));
      }
    }

    host.appendChild(mapBox);
  }

  function usingCustom() {
    return Boolean(customPositions && customSource === 'online');
  }

  /**
   * 地图编辑器确认之后，准备区要重画一遍才看得到"当前用的是自定义地图"。
   *
   * ⚠️ 必须 `render(true)` **强制**重画：FrpRoom 现在会按"输入指纹"去重，
   * 而编辑器改的是本文件的全局变量（`customPositions`），不在指纹里 ——
   * 走普通 `render()` 会被当成"没变"而跳过，界面就成了"点了没反应"。
   * 由 app.js 的 `confirmEditor()` 调（那边才知道编辑器是不是在线模式下开的）。
   */
  function refreshOnlineSetup() {
    if (Room && typeof Room.render === 'function') Room.render(true);
  }

  /** 地图编辑器（showEditor）要读 #board-width-online / #board-height-online。 */
  function syncMapInputs(map) {
    var w = document.getElementById('board-width-online');
    var h = document.getElementById('board-height-online');
    if (w) w.value = map.width;
    if (h) h.value = map.height;
  }

  /**
   * 点"开始游戏"时，把本游戏的设置项交给服务端。
   * 走 FrpRoom 的 onStart 钩子，而不是往 ctx.options 里塞 ——
   * 自定义地图是编辑器写进全局变量的，塞进去要来回同步，绕。
   *
   * ⚠️ 这里**没有 aiFill 了**：人机座位由房间层管理（`room.state.members[].isBot`），
   * 开局时房间层自己把它们拼进 players 交给 createMatch。
   */
  function collectOptions() {
    var out = {
      hostSide: onlineStatePresetSide(),
      preset: Number.isInteger(selectedPreset.online) ? selectedPreset.online : 0,
    };
    if (usingCustom()) out.custom = customPositions;
    return out;
  }

  /** 房主当前选的边。存在 FrpRoom 的 options 里，这里读回来。 */
  function onlineStatePresetSide() {
    var o = Room && Room.options ? Room.options : null;
    return o && o.hostSide === 'ghost' ? 'ghost' : 'cannon';
  }

  /* ============================== 对局 ============================== */

  /**
   * FrpRoom 把服务器的 view 交过来，我们用原来的渲染函数画出来。
   * ⚠️ 界面只吃 view（docs/GAME-SPEC.md 铁律二）。
   */
  function renderGame(_host, view, ctx) {
    onlineCtx = ctx;
    gameMode = 'online';
    playerSide = window.nameToSide(view.mySide) === GHOST ? GHOST : CANNON;

    // view → GameState。渲染函数一行都不用改，但它们拿到的信息只来自 view。
    gameState = window.stateFromView(view);

    if (currentScreen !== 'game') forceScreen('game');

    /*
     * 一次推送里可能有**两步**（我一手 + 人机一手，服务端同步跑完才广播），
     * 所以这里不直接画，而是拆成几步交给演出队列逐步演完。
     * 空数组也会排一个收尾步：把画面画回权威局面 + 判终局
     * （结算弹窗刻意等动画演完才弹，否则最后一手还没滑到位遮罩就盖下来了）。
     */
    if (typeof window.queueSteps === 'function') window.queueSteps(planSteps(view));
  }

  /**
   * 把一次 view 翻译成"要演的几步"。
   * @returns {Array<{kind:'move', state:object, capturedPiece:number|null}>}
   */
  function planSteps(view) {
    var prev = lastView;
    lastView = view;

    var lm = view.lastMove;
    var steps = [];
    var mine = takePendingMine(view, lm);

    // 第一步：我那一手。服务器没发过中间帧，所以拿"上一帧的盘 + 我点的那一手"自己算一张。
    // ⚠️ 这就是 pendingMine 现在唯一的用途：**回放**，不是本地预演。
    if (mine && prev) {
      steps.push({
        kind: 'move',
        state: scaffoldAfterMine(prev, mine),
        capturedPiece: victimOf(mine),
      });
    }

    // 第二步：服务器最后落下的那一手（人机回的，或者对手真人的）。
    // 靠 lastMove 的签名判重 —— 内容一样的 room.state 会被服务端重推，同一步不许演两遍。
    var key = lm ? [lm.fromR, lm.fromC, lm.toR, lm.toC].join(',') : null;
    if (lm && key !== lastMoveKey) {
      lastMoveKey = key;
      steps.push({
        kind: 'move',
        state: window.boardSnapshot(gameState),
        capturedPiece: victimOf(lm),
      });
    }

    return steps;
  }

  /**
   * 我点的那一手到底生效了没有 —— **服务回放的第一步就是靠它认出来的**。
   *
   * 【为什么要查】服务端可能把它拒了（还没轮到你 / 走法不合法）—— 那时**不会有**
   * 新的 room.state 推下来（拒绝走的是 error 消息），所以不能只靠"收到新 view"来判断。
   * 拿 view 里的盘对一下：我的子确实落在目标格、起点确实空出来了，才算生效。
   * 对不上就**不演**（下一次 room.state 会把真实局面画出来，不需要回滚）。
   *
   * 查出来的是"我那一手"（不是预演）：planSteps 拿它 + 上一帧的 view 拼中间画面，
   * 好让"我这一手"也有滑动 / 吃子碎裂动画 —— 服务器不发中间帧，只能自己拼。
   */
  function takePendingMine(view, lm) {
    var p = pendingMine;
    pendingMine = null;
    if (!p) return null;
    if (Date.now() - p.at > 4000) return null;   // 太久没回音：多半被拒了

    var myPiece = playerSide;
    var enemy = myPiece === CANNON ? GHOST : CANNON;

    var dest = view.board[p.toR] ? view.board[p.toR][p.toC] : undefined;
    var fromPiece = view.board[p.fromR] ? view.board[p.fromR][p.fromC] : undefined;

    // 落点站着我的子 = 生效了；紧接着被对手吃掉也算（落点就是对手那一手的终点）
    var destOk = dest === myPiece ||
      (dest === enemy && lm && lm.fromR === p.toR && lm.fromC === p.toC);
    // 起点空了 = 我的子确实走了；对手刚好走进我原来的格子也算
    var fromOk = fromPiece === EMPTY ||
      (fromPiece === enemy && lm && lm.toR === p.fromR && lm.toC === p.fromC);

    if (!destOk || !fromOk) return null;
    return { fromR: p.fromR, fromC: p.fromC, toR: p.toR, toC: p.toC };
  }

  /**
   * "我这一手之后"的中间画面：上一帧的盘 + 把我那一手落上去。
   *
   * ⚠️ 这是**纯画面**，不进 gameState、不回传给服务端 —— 权威局面永远是
   * `stateFromView(最新 view)`。所以它不违反"不许本地改权威状态"。
   */
  function scaffoldAfterMine(prev, move) {
    var board = prev.board.map(function (row) { return row.slice(); });
    var piece = board[move.fromR][move.fromC];
    board[move.toR][move.toC] = piece;             // 吃子就是直接盖掉落点上那个子
    board[move.fromR][move.fromC] = EMPTY;
    return {
      width: prev.width,
      height: prev.height,
      board: board,
      // 我走完了 → 轮到对手。回合提示也跟着走，两步连起来看才是连贯的。
      currentTurn: window.nameToSide(prev.currentTurn) === CANNON ? GHOST : CANNON,
      gameOver: false,
      winner: null,
      lastMove: { fromR: move.fromR, fromC: move.fromC, toR: move.toR, toC: move.toC },
      selectedPiece: null,
      validMoves: [],
    };
  }

  /**
   * 这一步吃没吃到子，被吃的是谁。
   *
   * 【为什么可以直接推出被吃的是小鬼】规则里**只有大炮能吃子**，而且吃子就是
   * "隔着恰好一个空格跳过去" = 一步跨 2 格（横竖各一格那种一格走法跨 1 格）。
   * 所以"跨了 2 格"就一定是大炮吃了一个小鬼 —— 不用去比对上一帧的盘。
   * （规则见 js/engine/rules.js 的 getCaptureMoves；改规则这里要跟着改。）
   */
  function victimOf(move) {
    var jump = Math.abs(move.toR - move.fromR) + Math.abs(move.toC - move.fromC);
    return jump >= 2 ? GHOST : null;
  }

  /**
   * 把一次点击变成一个操作意图发给服务器。**这是本文件唯一碰协议的地方。**
   *
   * 【两道判断，缺一不可】
   *   1. **演出期间不发**（`FrpAnim.busy()`）：队列没排空说明画面还在演"上一手"，
   *      而服务端那一帧早把回合推进过了 —— 这时候发出去就是"在过时的画面上操作"。
   *      返回 false = 当成没点（不发消息、不改界面状态）。用户明确接受这点延迟
   *      （"卡一点就卡一点没事的"）。决定见 docs/DECISIONS.md D10。
   *      ⚠️ 平台 `ctx.act()` 里也有同样的判断，但本文件**不走它**，所以必须自己判。
   *   2. **发得出去才算数**：`Net.send` 返回 false（没连上）就当没发生过。
   *
   * 【为什么直接调 Net.send 而不用 ctx.act】两者发出去的报文**一模一样**（`{ act }`），
   * 但直接调少一层间接（`ctx` 是房间外壳给的，本游戏不想依赖它的实现细节），
   * 而且要的就是 `Net.send` 那个布尔返回值。
   *
   * 📌 记录：改造当时 `ctx.act` **丢掉了 `Net.send` 的返回值**（内部 send 了但没 return），
   * 所以那时是"不得不绕过它"。这条已经作为平台问题上报并修复
   * （`shared/ui/room.js` 的 `act()` 现在原样返回），新游戏用 `ctx.act` 就行；
   * 本文件保留直接调用，免得把上面那两道判断的语义绑在平台实现上。
   *
   * ⚠️ **本函数不播任何东西**（不做本地预演）：这里只记下"我点的那一手"，
   * 等服务器的 view 回来时用它拼出回放的第一步（planSteps 的 `takePendingMine`）。
   */
  function submitOnlineMove(fromR, fromC, toR, toC) {
    if (gameMode !== 'online' || !onlineCtx) return false;
    if (animBusy()) return false;      // 演出没演完，当成没点

    var act = { kind: 'move', from: { r: fromR, c: fromC }, to: { r: toR, c: toC } };
    var sent = Net.send(T.ROOM_ACT, { act: act });
    if (!sent) return false;

    // 记下我这一手，等服务器回音时用它演"我那一手"（见 planSteps）。
    // 只做视觉：不吃子、不换回合、不动权威局面。
    pendingMine = { fromR: fromR, fromC: fromC, toR: toR, toC: toC, at: Date.now() };
    return true;
  }

  /** 演出队列没排空吗（平台 /shared/ui/anim.js）。见 submitOnlineMove 的说明。 */
  function animBusy() {
    var Fx = window.FrpAnim;
    return Boolean(Fx && typeof Fx.busy === 'function' && Fx.busy());
  }

  /* ============================== 与 app.js 的接口 ============================== */

  function enterOnline() {
    AudioManager.playClick();
    forceScreen('online-ready');
    if (Room) Room.render();
  }

  function closeRoom(_notify) {
    if (Net.room) Net.send(T.ROOM_LEAVE, {});
    onlineCtx = null;
    resetOnlinePlayback();
  }

  /**
   * app.js 的 backToMenu / confirmQuit 会调它。
   * 现在不需要做事：房间状态一清，FrpRoom 会自己画回"建房 / 加入"。
   */
  function showLobbyEntry() {
    /* 故意留空，见上面的说明 */
  }

  /** 再来一局：服务器裁决，只有房主能按（服务端也会再校验一次）。 */
  function requestOnlineRestart() {
    if (!Net.room) return false;
    if (!isOnlineHost()) {
      setStatus('等房主再开一局');
      return true;
    }
    Net.send(T.ROOM_RESET, {});
    return true;
  }

  /* ============================== 启动 ============================== */

  function goToGame(slug) {
    if (slug === 'cannon-goblin') { forceScreen('online-ready'); return; }
    window.location.href = '/games/' + encodeURIComponent(slug) + '/';
  }

  function gameTitle(slug) {
    var games = Array.isArray(window.GAMES) ? window.GAMES : [];
    for (var i = 0; i < games.length; i++) if (games[i].slug === slug) return games[i].title;
    return slug;
  }

  Net.on(T.ROOM_STATE, function (msg) {
    onlineState = msg;
    /*
     * 不在房里 / 回到等待态（房主按了「再来一局」）时，演出的游标必须清零。
     * 不清的话：上一局最后那一手的签名还在 lastMoveKey 里，而新一局的第一步
     * 很可能**恰好**是同一对坐标（棋盘就那么几格），于是新一局的第一步不演了。
     */
    if (!msg.code || msg.phase === 'waiting') resetOnlinePlayback();
    // 被别人邀请进来、或刷新页面回到座位上：直接带到在线界面，别让人停在菜单上找
    if (currentScreen === 'menu') forceScreen('online-ready');
  });

  /**
   * 服务端拒掉的原因由**共用房间外壳**统一显示（`shared/ui/room.js` 里那条
   * `Net.on(T.ERROR, …)` → `FrpUI.toast`）。游戏页不需要自己再监听一次 ——
   * 再监听会弹两条一模一样的提示条。
   *
   * ⚠️ 也别为了"知道哪一手被拒了"在这上面挂监听：演出层是靠 view 里的真实局面
   * 判断那一手生没生效的（takePendingMine），不依赖 error 消息。
   */

  Net.on('close', function () {
    // 断线由 GameNet 自动重连；重连后服务端会补发 room.state，座位不丢
    onlineCtx = null;
  });

  function boot() {
    var panel = document.getElementById('online-panel');
    if (!panel) return;

    Room.mount({
      container: panel,
      game: 'cannon-goblin',
      /*
       * minPlayers 在这里的含义是**真人**下限（房间层只数真人）：一个人也能开局，
       * 前提是房里还有个人机座位（人机也是座位）。
       * ⚠️ 决定「开始游戏」亮不亮的是**总座位数**，那个数由服务端给
       * （`room.state.minSeats` = meta.minSeats = 2，见 shared/ui/room.js 的 renderWaiting）。
       */
      minPlayers: 1,
      renderSetup: renderSetup,
      renderGame: renderGame,
      onStart: collectOptions,
    });

    Room.handleInvites({ goToGame: goToGame, gameTitle: gameTitle });

    syncMapInputs(PRESET_MAPS[0]);
  }

  // 脚本走 defer，执行时 DOM 已经解析完，可以直接挂
  boot();

  /* 暴露给 app.js 与内联 onclick 用（经典脚本之间靠全局名字互相调用）。 */
  Object.assign(window, {
    enterOnline: enterOnline,
    isOnlineHost: isOnlineHost,
    submitOnlineMove: submitOnlineMove,
    closeRoom: closeRoom,
    showLobbyEntry: showLobbyEntry,
    requestOnlineRestart: requestOnlineRestart,
    resetOnlinePlayback: resetOnlinePlayback,
    refreshOnlineSetup: refreshOnlineSetup,
  });
})();