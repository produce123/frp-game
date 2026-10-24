/*
 * 界面主控：屏幕切换、棋盘渲染、本地/人机对局流程、音效与特效开关。
 *
 * 【这一版新加的东西，改之前先看】
 *   1. **演出队列**（`queueSteps` / `playStep`）：一步棋不再"啪"地一次成型。
 *      走子用 FLIP 滑动（先把新棋盘画出来，再把刚画出来的那个棋子从原来的位置
 *      平移回 0），吃子再叠一层"碎掉"的残影 + 吃子音效。每一步占 460ms。
 *      ⚠️ 串行、不快进、**没有点击跳过**（用户明确要求）—— 队列本身在
 *      /shared/ui/anim.js（平台提供，三个游戏共用一套），本文件只决定
 *      "这一步演什么、演多久"。
 *   2. **不做本地预演 + 演出期间锁住输入**（docs/DECISIONS.md D10）。
 *      点下去到服务器回包之间，本机**不播任何动画、不出任何音效** —— 原来那套
 *      "乐观起手"（`playOptimisticStart`：目标格高亮 + 棋子一弹 + 起手音）已经
 *      **整段删除**：用户实测快速连点会把画面演成"所有人都被打死了"。
 *      与此同时，演出期间（`FrpAnim.busy()` 为真）点棋盘一律当没点（`animBusy()`），
 *      连"选中棋子 / 显示可走点"都不做 —— 那张盘马上要变，让用户在过时的画面上
 *      选来选去只会更乱；`body.frp-anim-busy` 由各游戏自己的 CSS 接（见 style.css）。
 *   3. **本地人机与联机共用同一套渲染 + 演出**：`renderGameBoard(paint)` /
 *      `updateGameUI(paint)` 都多了一个可选参数 —— 演出中途要画"中间画面"，
 *      而那个画面**不是**权威局面。不传就是当前的 `gameState`。
 *   4. **对阵条**（`renderVersusBar`）：两个座位各一个头像圆，点得动（扔鸡蛋 /
 *      送鲜花由平台接管，本游戏一行都不写）。人机的名字和 id 来自房间成员列表
 *      （`room.state.members[].isBot`），**不是** view —— view 里刻意没有名字，
 *      更没有"谁是电脑"这种字段（见 js/view.js 与 tests/ai-fill.test.mjs）。
 *   5. **音效 / 特效开关**：状态只读写**平台那一份**（`FrpUI.prefs`），接上
 *      FrpReact.setSound/setFx 与 FrpAnim.setEnabled，并且 AudioManager 自己认这个开关。
 *      ⚠️ 音效与特效是**两个**开关：回放一步的音效只认 `AudioManager.enabled`，
 *      特效关掉（`animEnabled()` 为假、动画不滑）时不该把声音一起掐掉。
 *   6. **首页身份行**（`renderMeLine`）：`你：X · ID Y`，ID 点一下复制。
 *      先用 `GameNet.cachedMe()` **立刻**画出来，`ready` 到了再以 `GameNet.me` 对齐
 *      （公网握手 2~3 秒，等它就有"我是谁？"的空白期）。
 *   7. **演出期间不再暗屏**：`body.frp-anim-busy` 只留 `pointer-events: none`，
 *      提示改成棋盘右下角外侧一行小字（纯 CSS 伪元素，见 style.css）。
 *      JS 那道闸 `animBusy()` 一个字没动 —— 那才是真正拦得住点击的防线。
 *
 * 【界面只读 view 这条铁律没变】
 * 本地人机手里有完整 state，但渲染函数只读"局面"本身；联机时那个 GameState 是
 * `stateFromView(服务端发下来的 view)` 造的。演出快照（boardSnapshot）也只是
 * 把**已经能看到的局面**复制一份，不含任何额外信息。
 */

let currentScreen = 'menu';
let gameMode = null;
let playerSide = CANNON;
let aiDifficulty = 'normal';
let gameState = null;
let editorState = null;
let editorMode = null;
let editorTool = 'cannon';
let customPositions = null;
let customSource = null;
let boardElement = null;
let cellSize = 60;

/* ---- 演出（动画队列）用到的临时状态，全都可以清空重建 ---- */
/** 最近一次画出来的格子（FLIP 要拿 DOM 元素；重画棋盘时被换掉） */
let lastCells = null;

// 本地 / 人机 / 在线三种模式共用同一套"预设 + 自定义"状态，按模式下标取用。
const selectedPreset = { local: 0, ai: 0, online: 0 };
const SETUP_SCREEN = { local: 'local-setup', ai: 'ai-setup', online: 'online-ready' };

/** 一步演出占多久（毫秒）。350~550 是"看得清、又不拖"的区间，取中间值。 */
const STEP_MS = 460;

function showScreen(name) {
  AudioManager.playClick();
  // ⚠️ 屏幕的"当前"类名统一是 `is-active`（平台外壳、Shell Gambit、BladeSteed 都用它）。
  // 本游戏原来叫 `active`，已改齐 —— 别改回去，否则 check-game 认不出当前屏幕。
  // （下面的 `.tool-btn` 用 `active` 是编辑器里的工具选中，跟屏幕无关，保持原样。）
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('is-active'));
  const screen = document.getElementById('screen-' + name);
  if (screen) {
    screen.classList.add('is-active');
    currentScreen = name;
  }

  const presetMode = { 'local-setup': 'local', 'ai-setup': 'ai', 'online-ready': 'online' }[name];
  if (presetMode) renderPresetMaps(presetMode);
}

function renderPresetMaps(mode) {
  const container = document.getElementById('preset-maps-' + mode);
  if (!container) return;
  container.innerHTML = '';
  PRESET_MAPS.forEach((map, i) => {
    const btn = document.createElement('button');
    btn.className = 'preset-map-btn' + (selectedPreset[mode] === i ? ' selected' : '');
    btn.innerHTML = `<span class="map-name">${map.name}</span><span class="map-desc">${map.desc}</span>`;
    btn.onclick = () => {
      AudioManager.playClick();
      selectedPreset[mode] = i;
      renderPresetMaps(mode);
      document.getElementById('board-width-' + mode).value = map.width;
      document.getElementById('board-height-' + mode).value = map.height;
      document.getElementById('cannon-count-' + mode).value = map.cannons.length;
      document.getElementById('ghost-count-' + mode).value = map.ghosts.length;
    };
    container.appendChild(btn);
  });
}

function selectSide(side) {
  AudioManager.playClick();
  playerSide = side === 'cannon' ? CANNON : GHOST;
  document.getElementById('side-cannon').classList.toggle('selected', side === 'cannon');
  document.getElementById('side-ghost').classList.toggle('selected', side === 'ghost');
}

function selectDifficulty(diff) {
  AudioManager.playClick();
  aiDifficulty = diff;
  document.querySelectorAll('.difficulty-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('diff-' + diff).classList.add('selected');
}

function showEditor(mode) {
  AudioManager.playClick();
  editorMode = mode;
  const w = parseInt(document.getElementById('board-width-' + mode).value) || 6;
  const h = parseInt(document.getElementById('board-height-' + mode).value) || 6;

  editorState = new GameState(w, h);
  customSource = mode;

  const preset = PRESET_MAPS[selectedPreset[mode]];

  if (preset.width === w && preset.height === h) {
    for (const [r, c] of preset.cannons) editorState.placeCannon(r, c);
    for (const [r, c] of preset.ghosts) editorState.placeGhost(r, c);
  }

  editorTool = 'cannon';
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tool-cannon').classList.add('active');

  renderEditorBoard();
  showScreen('editor');
}

function selectTool(tool) {
  AudioManager.playClick();
  editorTool = tool;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tool-' + tool).classList.add('active');
}

/**
 * 按容器的真实可用空间算格子边长。
 *
 * ⚠️ 这里曾经用 window.innerWidth 减一个魔数来估算，在手机上会算大：
 * 棋盘是 flex 子项（flex-shrink 默认为 1），可用宽度不够时棋盘会被压扁，
 * 而画布是 width:100%（跟着一起缩放）、格子却是按 px 绝对定位的（不跟着动），
 * 于是棋子相对网格整体偏移、越靠边越明显 —— 这就是"手机端棋子对不上十字交点"。
 * 所以：宽度必须量容器的内容盒，且棋盘在 CSS 里设为 flex:none（不可压缩）。
 *
 * 高度那一段是"视口高度 - 棋盘以外的部分"（遍历容器的其它子元素），所以往对局屏里
 * **加行**（对阵条、底下那排开关）是安全的：棋盘会自己让出空间，不会顶出屏幕。
 */
function fitCellSize(wrapper, w, h, maxCell) {
  const style = getComputedStyle(wrapper);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const availW = (wrapper.clientWidth || window.innerWidth) - padX;

  // 高度不能量 wrapper：它是 flex:1，高度取决于棋盘自身，量它就成了循环计算。
  // 改成"视口高度 - 棋盘以外的部分"。
  let chrome = padY;
  const container = wrapper.parentElement;
  if (container) {
    for (const child of container.children) {
      if (child !== wrapper) chrome += child.getBoundingClientRect().height;
    }
    const containerStyle = getComputedStyle(container);
    chrome += parseFloat(containerStyle.paddingTop) + parseFloat(containerStyle.paddingBottom);
  }
  const availH = window.innerHeight - chrome;

  return Math.max(16, Math.min(Math.floor(availW / w), Math.floor(availH / h), maxCell));
}

/**
 * 铺好一块棋盘：设尺寸、画网格、生成 w×h 个格子，返回 cells[r][c]。
 * 位图按 DPR 放大再缩放回来，网格在高分屏上才清晰（之后都用 CSS 像素坐标画）。
 */
function buildBoard(board, w, h, cs) {
  cellSize = cs;
  document.documentElement.style.setProperty('--cell-size', cs + 'px');
  // 棋盘的行列数也挂在 :root 上，只给 CSS 用：演出期间那行小字是按**棋盘**的右下角
  // 外侧定位的（棋盘在 wrapper 里居中，wrapper 的右下角在方屏机型上会压在棋盘上，
  // 那就遮住棋子了）。见 style.css 的 body.frp-anim-busy .board-wrapper::after。
  document.documentElement.style.setProperty('--board-w', w);
  document.documentElement.style.setProperty('--board-h', h);
  board.style.width = (w * cs) + 'px';
  board.style.height = (h * cs) + 'px';
  board.innerHTML = '';

  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.className = 'board-canvas';
  canvas.width = Math.round(w * cs * dpr);
  canvas.height = Math.round(h * cs * dpr);
  board.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawGridLines(ctx, w, h, cs);

  const cells = [];
  for (let r = 0; r < h; r++) {
    const row = [];
    for (let c = 0; c < w; c++) {
      const cell = document.createElement('div');
      cell.className = 'board-cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.style.width = cs + 'px';
      cell.style.height = cs + 'px';
      cell.style.left = (c * cs) + 'px';
      cell.style.top = (r * cs) + 'px';
      board.appendChild(cell);
      row.push(cell);
    }
    cells.push(row);
  }
  return cells;
}

/** 往格子里放棋子（或空点）。返回放进去的棋子元素，空点返回 null。 */
function placePieceInCell(cell, piece, cs) {
  if (piece === EMPTY) {
    const dot = document.createElement('div');
    dot.className = 'cell-dot';
    cell.appendChild(dot);
    return null;
  }
  const element = document.createElement('div');
  element.className = 'piece ' + (piece === CANNON ? 'cannon' : 'ghost');
  element.textContent = piece === CANNON ? '💣' : '👻';
  element.style.fontSize = Math.floor(cs * 0.45) + 'px';
  cell.appendChild(element);
  return element;
}

/**
 * 取某格的棋子。渲染函数吃的东西有两种：
 *   · 引擎的 GameState（本地对局）
 *   · 演出快照（联机时"我那一手之后"的中间画面，纯数据，只有 board 数组）
 * 所以统一走这里，别直接 `st.board[r][c]`（快照没有 getPiece，引擎有边界检查）。
 */
function pieceAt(st, r, c) {
  if (!st) return EMPTY;
  return st.getPiece ? st.getPiece(r, c) : st.board[r][c];
}

function countPieces(st, piece) {
  if (!st) return 0;
  let n = 0;
  for (let r = 0; r < st.height; r++) {
    for (let c = 0; c < st.width; c++) if (pieceAt(st, r, c) === piece) n++;
  }
  return n;
}

/**
 * 把当前局面拍一张纯数据快照，交给演出队列。
 *
 * 【为什么必须快照，而不是演出时现读 gameState】
 * 队列是串行的，而引擎**不会等动画**：本地人机的电脑那一手可能在第一步动画还在播的
 * 时候就算完并落到 gameState 里了。那时再读 gameState，第一步会画出"两步之后"的盘
 * —— 动画就成了假的。快照把"那一刻的画面"钉死，演出期间谁改 gameState 都不影响它。
 */
function boardSnapshot(gs) {
  return {
    width: gs.width,
    height: gs.height,
    board: gs.board.map(row => row.slice()),
    currentTurn: gs.currentTurn,
    gameOver: Boolean(gs.gameOver),
    winner: gs.winner,
    lastMove: gs.lastMove ? {
      fromR: gs.lastMove.fromR, fromC: gs.lastMove.fromC,
      toR: gs.lastMove.toR, toC: gs.lastMove.toC,
    } : null,
    selectedPiece: gs.selectedPiece ? { r: gs.selectedPiece.r, c: gs.selectedPiece.c } : null,
    validMoves: (gs.validMoves || []).map(m => ({ r: m.r, c: m.c, capture: Boolean(m.capture) })),
  };
}

function renderEditorBoard() {
  const board = document.getElementById('editor-board');
  const w = editorState.width;
  const h = editorState.height;
  const cs = fitCellSize(board.parentElement, w, h, 60);
  const cells = buildBoard(board, w, h, cs);

  let cannonCount = 0;
  let ghostCount = 0;

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const piece = editorState.getPiece(r, c);
      if (piece === CANNON) cannonCount++;
      else if (piece === GHOST) ghostCount++;
      placePieceInCell(cells[r][c], piece, cs);

      cells[r][c].onclick = () => {
        AudioManager.playClick();
        if (editorTool === 'cannon') {
          editorState.board[r][c] = editorState.board[r][c] === CANNON ? EMPTY : CANNON;
        } else if (editorTool === 'ghost') {
          editorState.board[r][c] = editorState.board[r][c] === GHOST ? EMPTY : GHOST;
        } else {
          editorState.board[r][c] = EMPTY;
        }
        renderEditorBoard();
      };
    }
  }

  document.getElementById('editor-cannon-count').textContent = cannonCount;
  document.getElementById('editor-ghost-count').textContent = ghostCount;
}

function drawGridLines(ctx, w, h, cs) {
  ctx.strokeStyle = '#8b6914';
  ctx.lineWidth = 1;

  const pad = cs / 2;

  for (let r = 0; r < h; r++) {
    ctx.beginPath();
    ctx.moveTo(pad, r * cs + pad);
    ctx.lineTo((w - 1) * cs + pad, r * cs + pad);
    ctx.stroke();
  }
  for (let c = 0; c < w; c++) {
    ctx.beginPath();
    ctx.moveTo(c * cs + pad, pad);
    ctx.lineTo(c * cs + pad, (h - 1) * cs + pad);
    ctx.stroke();
  }

  ctx.fillStyle = '#5a4510';
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      ctx.beginPath();
      ctx.arc(c * cs + pad, r * cs + pad, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function backFromEditor() {
  AudioManager.playClick();
  showScreen(SETUP_SCREEN[editorMode] || 'menu');
}

function confirmEditor() {
  AudioManager.playClick();
  customPositions = {
    width: editorState.width,
    height: editorState.height,
    board: editorState.board.map(row => [...row])
  };
  showScreen(SETUP_SCREEN[editorMode] || 'menu');
  // 在线模式下开了编辑器：房间的准备区是靠 FrpRoom 画的，得让它**强制**重画一遍
  // 才看得到"当前用的是自定义地图"（它按指纹去重，而这张盘不在指纹里）。
  if (editorMode === 'online' && typeof refreshOnlineSetup === 'function') refreshOnlineSetup();
}

function startLocalGame() {
  AudioManager.playClick();
  gameMode = 'local';

  if (customPositions && customSource === 'local') {
    initGameFromCustom();
  } else {
    initGameFromPreset(PRESET_MAPS[selectedPreset.local]);
  }
}

function startAIGame() {
  AudioManager.playClick();
  gameMode = 'ai';

  if (customPositions && customSource === 'ai') {
    initGameFromCustom();
  } else {
    initGameFromPreset(PRESET_MAPS[selectedPreset.ai]);
  }
}

function initGameFromPreset(preset) {
  resetPlaybackState();
  gameState = new GameState(preset.width, preset.height);
  for (const [r, c] of preset.cannons) gameState.placeCannon(r, c);
  for (const [r, c] of preset.ghosts) gameState.placeGhost(r, c);
  showScreen('game');
  renderGameBoard();
  updateGameUI();
  checkAIFirstMove();
}

function initGameFromCustom() {
  if (!customPositions) return;
  resetPlaybackState();
  gameState = new GameState(customPositions.width, customPositions.height);
  gameState.board = customPositions.board.map(row => [...row]);
  showScreen('game');
  renderGameBoard();
  updateGameUI();
  checkAIFirstMove();
}

function checkAIFirstMove() {
  if (gameMode === 'ai' && gameState.currentTurn !== playerSide) {
    scheduleAIMove(500);
  }
}

/**
 * 画棋盘。
 * @param {object} [paint] 要画的局面；不传就是当前的 `gameState`。
 *        演出中途会传一张快照（联机的"我那一手之后"那种中间画面）。
 */
function renderGameBoard(paint) {
  const st = paint || gameState;
  const board = document.getElementById('game-board');
  if (!board || !st) return null;

  const w = st.width;
  const h = st.height;
  const cs = fitCellSize(board.parentElement, w, h, 80);
  const cells = buildBoard(board, w, h, cs);

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const cell = cells[r][c];
      const pieceElement = placePieceInCell(cell, pieceAt(st, r, c), cs);

      if (pieceElement && st.selectedPiece &&
          st.selectedPiece.r === r && st.selectedPiece.c === c) {
        pieceElement.classList.add('selected');
      }

      const isValidMove = (st.validMoves || []).find(m => m.r === r && m.c === c);
      if (isValidMove) {
        cell.classList.add(isValidMove.capture ? 'capture-highlight' : 'highlight');
      }

      if (st.lastMove && st.lastMove.toR === r && st.lastMove.toC === c) {
        cell.classList.add('last-move');
      }

      cell.onclick = () => handleCellClick(r, c);
    }
  }

  lastCells = cells;   // FLIP 要拿这里的 DOM 元素
  return cells;
}

/** 画对局信息（回合 / 剩余棋子 / 对阵条）。同样可以吃一张演出快照。 */
function updateGameUI(paint) {
  const st = paint || gameState;
  if (!st) return;

  const turnText = document.getElementById('turn-text');
  const turnInd = document.getElementById('turn-indicator');
  const ghostRem = document.getElementById('ghost-remaining');
  const cannonRem = document.getElementById('cannon-remaining');

  if (st.currentTurn === CANNON) {
    turnText.textContent = '💣 大炮方回合';
    turnInd.className = 'turn-indicator cannon-turn';
  } else {
    turnText.textContent = '👻 小鬼方回合';
    turnInd.className = 'turn-indicator ghost-turn';
  }

  ghostRem.textContent = '👻 ×' + countPieces(st, GHOST);
  cannonRem.textContent = '💣 ×' + countPieces(st, CANNON);

  renderVersusBar(st);
}

/* ============================== 对阵条（头像） ============================== */

/**
 * 两个座位各一个头像圆。
 *
 * 【名字和 id 从哪来】
 * **联机**：房间成员列表（`GameNet.room.members`）——它带 `name` 与 `isBot`，
 * 人机是单字名的灰色座位。房主执哪一方来自房间的 `options.hostSide`（服务端
 * 在 `room.state` 里给的是**开局时合并过的**那一份，所以它和实际阵营一致）。
 * ⚠️ **不要**从 view 里找名字：view 的字段表是钉死的（width/height/board/
 * currentTurn/gameOver/winner/lastMove/mySide），加字段会让 rules.test.mjs 的
 * 哨兵用例当场红，而且"谁是电脑"这种东西本来就不该进棋盘报文。
 *
 * **单机**：没有 id、也没有名字（本作单机不显示名字），所以画的是**不可点**的
 * 位置标记（你 / 电脑，或者大炮方 / 小鬼方）—— 用户明确允许这条退路。
 * 别为了这个去改引擎或往 view 里塞名字。
 */
function renderVersusBar(st) {
  const bar = document.getElementById('versus-bar');
  if (!bar || !st) return;
  bar.innerHTML = '';

  const seats = versusSeats();
  if (seats) {
    bar.appendChild(seatNode(seats.mine, st));
    bar.appendChild(versusTag());
    bar.appendChild(seatNode(seats.other, st));
    return;
  }

  // 单机：两个不带互动的标记
  const local = localSeats();
  bar.appendChild(pipNode(local.mine, st));
  bar.appendChild(versusTag());
  bar.appendChild(pipNode(local.other, st));
}

/**
 * 联机时的两个座位（[我, 对手]）。
 * 拿不到（还没连上 / 我不在成员列表里）就返回 null，退回单机那种纯标记。
 */
function versusSeats() {
  if (gameMode !== 'online') return null;
  const Net = window.GameNet;
  const me = Net && Net.me;
  const room = Net && Net.room;
  if (!me || !room || !Array.isArray(room.members)) return null;

  // 阵营规则：房主执 hostSide，另一个座位自动执另一方（和人机座位同一条规则）
  const hostSide = room.options && room.options.hostSide === 'ghost' ? 'ghost' : 'cannon';
  const sideOf = (m) => (m.id === room.hostId ? hostSide : (hostSide === 'cannon' ? 'ghost' : 'cannon'));

  const mine = room.members.find((m) => m.id === me.id);
  const other = room.members.find((m) => m.id !== me.id);
  if (!mine || !other) return null;

  return {
    mine: { id: mine.id, name: mine.name, avatar: mine.avatar || '', isBot: Boolean(mine.isBot), side: sideOf(mine) },
    other: { id: other.id, name: other.name, avatar: other.avatar || '', isBot: Boolean(other.isBot), side: sideOf(other) },
  };
}

/** 单机（本地 / 人机）的两个位置标记。 */
function localSeats() {
  if (gameMode === 'ai') {
    return {
      mine: { label: '你', side: window.sideToName(playerSide) },
      other: { label: '电脑', side: playerSide === CANNON ? 'ghost' : 'cannon' },
    };
  }
  return {
    mine: { label: '大炮方', side: 'cannon' },
    other: { label: '小鬼方', side: 'ghost' },
  };
}

function versusTag() {
  const tag = document.createElement('span');
  tag.className = 'vs-vs';
  tag.textContent = 'VS';
  return tag;
}

/** 一个可点的座位（联机）。互动本身（扔鸡蛋 / 送鲜花）由 /shared/ui/react.js 全包。 */
function seatNode(seat, st) {
  const node = document.createElement('div');
  node.className = 'vs-seat' + (st.currentTurn === seat.side ? ' is-turn' : '');

  const React = window.FrpReact;
  if (React && typeof React.avatarEl === 'function') {
    node.appendChild(React.avatarEl({ id: seat.id, name: seat.name, avatar: seat.avatar, isBot: seat.isBot, size: 48 }));
  } else {
    // 平台脚本没挂上也不该空白：退回一个纯文字圆（不可点，但看得见对手是谁）
    node.appendChild(plainPip(seat.name));
  }

  const label = document.createElement('span');
  label.className = 'vs-label';
  label.textContent = seat.name + ' · ' + (seat.side === 'cannon' ? '💣 大炮' : '👻 小鬼');
  node.appendChild(label);
  return node;
}

/** 单机的一个座位（不可点）。 */
function pipNode(seat, st) {
  const node = document.createElement('div');
  node.className = 'vs-seat' + (st.currentTurn === seat.side ? ' is-turn' : '');
  node.appendChild(plainPip(seat.side === 'cannon' ? '💣' : '👻'));

  const label = document.createElement('span');
  label.className = 'vs-label';
  label.textContent = seat.label;
  node.appendChild(label);
  return node;
}

function plainPip(text) {
  const pip = document.createElement('span');
  pip.className = 'vs-pip';
  pip.textContent = text;
  return pip;
}

/* ============================== 演出（动画队列） ============================== */

/** 特效开着吗（特效开关 + 系统的 prefers-reduced-motion 都算）。 */
function animEnabled() {
  const Fx = window.FrpAnim;
  if (Fx && typeof Fx.isEnabled === 'function') return Fx.isEnabled();
  return prefs.fx;
}

/**
 * 演出队列还没排空吗（平台 /shared/ui/anim.js 的 `busy()`）。
 *
 * 【为什么点棋盘要先看它】演出是异步的，而服务端那一帧**早就把回合推进过了** ——
 * 不锁的话玩家能一边看动画一边接着操作：他看到的是"我这一手之前"的画面，
 * 点出来的却是"已经轮到我"的下一手，画面和操作错位（用户第 2 条反馈）。
 * 所以在过时的画面上**连"选中棋子 / 显示可走点"都不做**：这张盘马上就要变。
 * 决定与教训见 docs/DECISIONS.md D10、docs/GAME-SPEC.md §4「演出期间锁输入」。
 *
 * ⚠️ 发消息那条线（js/ui/online.js 的 `submitOnlineMove`）**必须自己再判一次**：
 * 它直接调 `Net.send`，走的不是平台 `ctx.act`（平台在那里面兜了一层 busy 判断）。
 */
function animBusy() {
  const Fx = window.FrpAnim;
  return Boolean(Fx && typeof Fx.busy === 'function' && Fx.busy());
}

/**
 * 把若干"演出步"按顺序播完（串行、不快进、没有跳过）。
 *
 * 队列本身在 /shared/ui/anim.js —— 三个游戏共用，本游戏只负责
 * "每一步演什么、占多久"（playStep 的返回值）。走完最后一步会自动补一个
 * `settle` 步：把画面画回**权威局面**（演出中途用的是快照），并处理
 * 结算 / 人机的下一手。
 *
 * @param {Array<{kind:'move', state:object, capturedPiece?:number|null}>} steps
 */
function queueSteps(steps) {
  const items = (steps || []).concat([{ kind: 'settle' }]);
  const Fx = window.FrpAnim;
  if (Fx && typeof Fx.push === 'function') {
    Fx.push(items, playStep);
    return;
  }
  // 平台脚本没挂上（理论上不会）：至少别把局面卡住，直接按顺序画完
  items.forEach(playStep);
}

/** 演一步。返回这一步要占多少毫秒（0 = 立刻走下一步）。 */
function playStep(step) {
  if (!step) return 0;

  if (step.kind === 'settle') {
    renderGameBoard();
    updateGameUI();
    afterPlayback();
    return 0;
  }

  // kind === 'move'：先画（新棋子必须在 DOM 里才谈得上 FLIP），再动
  const st = step.state;
  renderGameBoard(st);
  updateGameUI(st);
  return playMoveAnimation(st.lastMove, step.capturedPiece);
}

/*
 * 回放一步的音效。
 *
 * 【为什么吃子和走子分开响】用户第 3 条反馈："就是没有吃子的声音了"。
 * 吃子那一步（大炮隔着恰好一个空格跳吃）响 `playCapture()`（更闷更重的一下），
 * 普通走子响 `playMove()`。**不叠着响**：两个音一起出来会糊成一片。
 *
 * ⚠️ 只认 `AudioManager.enabled`（每个 playXxx() 第一行自己 return）——
 * 特效开关关掉时动画不滑，但那不该把声音一起掐掉，两个开关是分开的。
 * ⚠️ 空走一步 `capturedPiece` 是 null，所以"没吃到子的那一步"绝不会响吃子音。
 */
function playStepSound(capturedPiece) {
  if (capturedPiece) AudioManager.playCapture();
  else AudioManager.playMove();
}

/**
 * 走子滑动 + 吃子碎掉的残影。
 *
 * 【为什么是"先画完再动"（FLIP）】
 * buildBoard 每次都是 `innerHTML = ''` 全清重建，所以 DOM 里**没有**"移动前"的那个
 * 棋子，CSS 的 transition 也没有起点可补间 —— 直接改样式只会"啪"地出现在终点。
 * 做法是：新棋盘已经画好了（棋子在落点上），把落点那个棋子先用 transform 拉回
 * **原来的格子**，再动回 0。视觉上就是从起点滑到终点。
 */
function playMoveAnimation(move, capturedPiece) {
  // 音效先于"特效开关"判断：特效关了（不滑、不碎）也照样该有落子 / 吃子声。
  playStepSound(capturedPiece);

  if (!move || !lastCells || !animEnabled()) return 0;
  const cell = lastCells[move.toR] && lastCells[move.toR][move.toC];
  if (!cell) return 0;

  const cs = cellSize;
  const dx = (move.fromC - move.toC) * cs;
  const dy = (move.fromR - move.toR) * cs;

  let moved = false;
  const piece = cell.querySelector('.piece');
  if (piece) {
    try {
      piece.animate([
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: 'translate(0, 0)' },
      ], { duration: STEP_MS, easing: 'cubic-bezier(.22,.61,.36,1)' });
      moved = true;
    } catch (err) {
      moved = false;   // 老浏览器没有 WAAPI：直接显示终态，不滑
    }
  }

  if (capturedPiece) {
    spawnCaptureFx(cell, capturedPiece, cs);
    moved = true;      // 残影本身也要占这一步的时间
  }

  return moved ? STEP_MS : 0;
}

/** 被吃掉的子：在那一格叠一个瞬间的残影，放大、旋转、淡出。 */
function spawnCaptureFx(cell, pieceType, cs) {
  const board = document.getElementById('game-board');
  if (!board || !cell) return;

  const fx = document.createElement('div');
  fx.className = 'capture-fx ' + (pieceType === CANNON ? 'cannon' : 'ghost');
  fx.textContent = pieceType === CANNON ? '💣' : '👻';
  fx.style.width = cs + 'px';
  fx.style.height = cs + 'px';
  fx.style.left = cell.style.left;
  fx.style.top = cell.style.top;
  fx.style.fontSize = Math.floor(cs * 0.45) + 'px';
  board.appendChild(fx);

  const remove = () => { if (fx.parentNode) fx.parentNode.removeChild(fx); };
  try {
    const anim = fx.animate([
      { transform: 'scale(1) rotate(0deg)', opacity: 1 },
      { transform: 'scale(1.35) rotate(16deg)', opacity: 0.65, offset: 0.6 },
      { transform: 'scale(0.3) rotate(42deg)', opacity: 0 },
    ], { duration: 420, easing: 'ease-out' });
    anim.onfinish = remove;
    anim.oncancel = remove;
  } catch (err) {
    remove();
  }
  // 兜底：这一步演完时画面会被重画（残影不在新棋盘里，但它在 board 上挂着），
  // 万一 onfinish 没触发（元素被摘掉时有些浏览器不回调），也不能留个孤儿节点
  setTimeout(remove, 1200);
}

/**
 * 一次演出走完之后：判终局、给本地人机排下一手。
 * 结算弹窗刻意放在**动画之后**弹 —— 不然最后一手还没滑到位，遮罩就盖下来了。
 */
function afterPlayback() {
  if (!gameState) return;
  if (gameState.gameOver) {
    showGameOverIfNeeded();
    return;
  }
  // 本地人机：轮到电脑就排它那一手（"思考停顿"是刻意的，别删 —— 瞬间刷屏看不清发生了什么）
  if (gameMode === 'ai' && gameState.currentTurn !== playerSide) scheduleAIMove(400);
}

function showGameOverIfNeeded() {
  const modal = document.getElementById('game-over-modal');
  if (!modal || modal.style.display === 'flex') return;
  handleGameOver();
}

/** 换局 / 离开房间时把演出的临时状态清干净（"再来一局"必须清，否则上局的签名会挡住新的一手）。 */
function resetPlaybackState() {
  lastCells = null;
  if (window.FrpAnim && typeof window.FrpAnim.clear === 'function') window.FrpAnim.clear();
  if (typeof resetOnlinePlayback === 'function') resetOnlinePlayback();
}

/* ============================== 点击 → 操作 ============================== */

function handleCellClick(r, c) {
  // 演出期间一律当没点（连"选中棋子 / 显示可走点"都不做）：这张盘马上要变。
  // 见 animBusy() 的说明与 docs/DECISIONS.md D10。
  if (animBusy()) return;
  if (!gameState || gameState.gameOver) return;

  if (gameMode === 'ai' && gameState.currentTurn !== playerSide) return;
  if (gameMode === 'online' && gameState.currentTurn !== playerSide) return;

  const piece = gameState.getPiece(r, c);

  if (gameState.selectedPiece) {
    const isValidMove = gameState.validMoves.find(m => m.r === r && m.c === c);
    if (isValidMove) {
      if (gameMode === 'online') {
        // 联机：把这一手翻译成一条 room.act 交给 js/ui/online.js 的 submitOnlineMove。
        // **这里什么都不演**（不做本地预演）：发得出去也只是"发出去了"，
        // 画面上"我这一手"由服务器回放的那一步演出来（docs/DECISIONS.md D10）。
        submitOnlineMove(gameState.selectedPiece.r, gameState.selectedPiece.c, r, c);
        return;
      }

      const result = gameState.movePiece(r, c);
      if (result) {
        playLocalMove(result);
        return;
      }
    }

    if (piece === gameState.currentTurn) {
      AudioManager.playSelect();
      gameState.selectPiece(r, c);
      renderGameBoard();
      return;
    }

    gameState.deselectPiece();
    renderGameBoard();
    return;
  }

  if (piece === gameState.currentTurn) {
    AudioManager.playSelect();
    if (gameState.selectPiece(r, c)) {
      renderGameBoard();
    } else {
      setStatus('该棋子无法移动');
    }
  }
}

/**
 * 本地（含人机）走完一步：排一步演出。
 * 快照是**走完之后**的局面，所以画出来就是终态，再对 lastMove 做 FLIP。
 */
function playLocalMove(result) {
  const move = gameState.lastMove;
  if (!move) {
    renderGameBoard();
    updateGameUI();
    return;
  }
  const captured = Boolean(result && result.captured);
  queueSteps([{
    kind: 'move',
    state: boardSnapshot(gameState),
    // result.piece 是**走子方**，被吃掉的永远是另一方
    capturedPiece: captured ? (result.piece === CANNON ? GHOST : CANNON) : null,
  }]);
}

/**
 * 安排电脑走子。困难档会占着主线程算 1.5 秒，所以先把"思考中"画到屏幕上，
 * 等浏览器真的绘完这一帧（两层 rAF）再开始算，否则看起来就像卡死了。
 */
function scheduleAIMove(delay = 500) {
  setTimeout(() => {
    setStatus('🤔 电脑思考中…');
    requestAnimationFrame(() => requestAnimationFrame(doAIMove));
  }, delay);
}

function doAIMove() {
  if (!gameState || gameState.gameOver) return;

  const aiSide = gameState.currentTurn;
  const move = AIPlayer.makeMove(gameState, aiSide, aiDifficulty);

  if (!move) {
    gameState.currentTurn = gameState.currentTurn === CANNON ? GHOST : CANNON;
    gameState.checkWinCondition();
    if (gameState.gameOver) {
      showGameOverIfNeeded();
      return;
    }
    renderGameBoard();
    updateGameUI();
    return;
  }

  gameState.selectPiece(move.from.r, move.from.c);
  const result = gameState.movePiece(move.to.r, move.to.c);

  if (result) {
    playLocalMove(result);
  } else {
    // 引擎说这手不合法（理论上不会走到）：至少别让界面停在旧画面上
    renderGameBoard();
    updateGameUI();
  }
}

function setStatus(msg) {
  document.getElementById('game-status').textContent = msg;
  setTimeout(() => {
    document.getElementById('game-status').textContent = '';
  }, 2000);
}

function handleGameOver() {
  const modal = document.getElementById('game-over-modal');
  const title = document.getElementById('game-over-title');
  const message = document.getElementById('game-over-message');

  if (gameState.winner === CANNON) {
    title.textContent = '💣 大炮方获胜！';
    message.textContent = '大炮成功消灭了足够多的小鬼！';
    if (gameMode === 'ai') {
      playerSide === CANNON ? AudioManager.playWin() : AudioManager.playLose();
    } else if (gameMode === 'online') {
      playerSide === CANNON ? AudioManager.playWin() : AudioManager.playLose();
    } else {
      AudioManager.playWin();
    }
  } else {
    title.textContent = '👻 小鬼方获胜！';
    message.textContent = '小鬼成功围堵了所有大炮！';
    if (gameMode === 'ai') {
      playerSide === GHOST ? AudioManager.playWin() : AudioManager.playLose();
    } else if (gameMode === 'online') {
      playerSide === GHOST ? AudioManager.playWin() : AudioManager.playLose();
    } else {
      AudioManager.playWin();
    }
  }

  modal.style.display = 'flex';
}

function restartGame() {
  AudioManager.playClick();
  document.getElementById('game-over-modal').style.display = 'none';
  gameState = null;
  resetPlaybackState();

  if (gameMode === 'local') {
    initGameFromPreset(PRESET_MAPS[selectedPreset.local]);
  } else if (gameMode === 'ai') {
    initGameFromPreset(PRESET_MAPS[selectedPreset.ai]);
  } else if (gameMode === 'online') {
    // 联机时局面在服务器手里，所以"再来一局"是请求服务器把房间放回等待态，
    // 只有房主有权限（服务端还会再校验一次）。实现在 js/ui/online.js。
    requestOnlineRestart();
  }
}

function backToMenu() {
  AudioManager.playClick();
  document.getElementById('game-over-modal').style.display = 'none';
  closeRoom(true);
  gameState = null;
  resetPlaybackState();
  showLobbyEntry();
  showScreen('menu');
}

function confirmQuit() {
  if (confirm('确定要退出当前对局吗？')) {
    AudioManager.playClick();
    closeRoom(true);
    gameState = null;
    resetPlaybackState();
    showLobbyEntry();
    showScreen('menu');
  }
}

/* ============================== 音效 / 特效开关 ============================== */

/*
 * 平台硬指标（docs/GAME-SPEC.md §7）：每个游戏都要有"音效 / 特效"两个开关。
 *
 * 【值存在**平台那一份**里，本作不再自己存】（用户要求："平台设置栏里有总开关，
 * 游戏里的开关跟随它，两处不会打架"）
 *
 * 只有一份偏好，在 `shared/ui/ui.js` 的 `FrpUI.prefs` 里（localStorage 的 `frp.prefs`）。
 * 本作原来自己存 `cg.sound` / `cg.fx` —— 那样会出现"平台开着、游戏关着"或者反过来，
 * 用户看到的是"我明明在设置里关了，进游戏还是响"。现在本作只是这份偏好的**另一个入口**：
 *
 *   · 打开页面：`FrpUI.prefs.sound()/fx()` 读出来，应用到下面那三处；
 *   · 点本作的开关：调 `FrpUI.prefs.setSound(b)/setFx(b)`（平台设置栏会同步）；
 *   · 别处（平台设置栏 / 另一个标签页）改了：`FrpUI.prefs.on(cb)` 订回来跟着变。
 *
 * ⚠️ **老键 `cg.sound` / `cg.fx` 不要删**：平台侧在"用户从来没设过"时会拿它们推默认值
 *    （老用户的设置因此不会丢），那是 `FrpUI.prefs` 的迁移逻辑，本作一个字节都不再写。
 * ⚠️ 不要接 `FrpUI.sound.bindClicks()`：本作自己的按钮**已经有音效**
 *    （`showScreen()` 等地方各响一次），再接一遍会响两声。
 *
 * 三个地方要一起认这个值，缺一个就是"假开关"：
 *   · AudioManager.enabled        —— 本作自己合成的音效
 *   · FrpReact.setSound/setFx     —— 平台那套互动的音效与飞行动画
 *   · FrpAnim.setEnabled          —— 演出队列的时长（关掉 = 立刻演完，不拖时间）
 */
const prefs = { sound: true, fx: true };

function applyPrefs() {
  AudioManager.enabled = prefs.sound;
  if (window.FrpReact) {
    window.FrpReact.setSound(prefs.sound);
    window.FrpReact.setFx(prefs.fx);
  }
  if (window.FrpAnim && typeof window.FrpAnim.setEnabled === 'function') {
    window.FrpAnim.setEnabled(prefs.fx);
  }
  document.body.classList.toggle('no-fx', !prefs.fx);

  // 两处按钮（菜单 + 棋盘底栏）用 data-pref 认领，一起改文案与 aria 状态
  document.querySelectorAll('[data-pref]').forEach((btn) => {
    const key = btn.getAttribute('data-pref');
    const on = Boolean(prefs[key]);
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = key === 'sound'
      ? (on ? '🔊 音效' : '🔇 音效关')
      : (on ? '✨ 特效' : '✨ 特效关');
  });
}

/** 从平台那一份读回来并应用（打开页面时调一次；之后靠订阅）。 */
function loadPrefs() {
  const P = window.FrpUI && window.FrpUI.prefs;
  if (P) {
    prefs.sound = P.sound();
    prefs.fx = P.fx();
  } else {
    // 平台脚本没挂上（理论上不会）：退回"音效开、特效跟着系统的减少动画走"
    prefs.sound = true;
    try {
      prefs.fx = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (err) { prefs.fx = true; }
  }
  applyPrefs();
}

/**
 * 订阅平台那一份偏好：在平台设置栏（或另一个标签页）改了，本作要**跟着变**。
 * 回调里带的就是最新的两个值，直接照它重接一遍即可。
 */
function bindPrefSync() {
  const P = window.FrpUI && window.FrpUI.prefs;
  if (!P || typeof P.on !== 'function') return;
  P.on((snapshot) => {
    prefs.sound = Boolean(snapshot.sound);
    prefs.fx = Boolean(snapshot.fx);
    applyPrefs();
  });
}

/** 点本作的开关：写回平台那一份（订阅回调会立刻把三处接好，所以这里不直接改 prefs）。 */
function setPref(key, on) {
  if (key !== 'sound' && key !== 'fx') return;
  const P = window.FrpUI && window.FrpUI.prefs;
  if (!P) return;
  if (key === 'sound') P.setSound(on);
  else P.setFx(on);
}

function bindPrefButtons() {
  // 事件代理：按钮在两块屏幕里各有一份，而且是死 DOM，不需要逐个挂
  document.addEventListener('click', (event) => {
    const btn = event.target && event.target.closest ? event.target.closest('[data-pref]') : null;
    if (!btn) return;
    const key = btn.getAttribute('data-pref');
    setPref(key, !prefs[key]);
    if (prefs.sound) AudioManager.playClick();   // 开着音效时给一声反馈（关掉的那一下要安静）
  });
}

/* ============================== 首页身份行（你：X · ID Y） ============================== */

/*
 * 【为什么要有这一行】用户发现本作首页没有名字/ID，而另外两个游戏都有 —— 三个游戏得一样。
 * 名字和 ID 都来自平台账号（docs/GAME-SPEC.md §6），游戏里**不许**再出现输入名字的界面。
 *
 * 【为什么不等 WebSocket】游戏页是一次整页跳转，公网那次握手要 2~3 秒。这几秒里等
 * `ready` 才画，用户看到的就是"我是谁？"的空白（另外两个游戏还因此在 2~3 秒内点开始
 * 被误判成"还没登录"——本作没有那道拦截，所以只有空白这一半问题）。所以：
 *   · 先拿 `GameNet.cachedMe()`（浏览器里记着的那份，见 shared/net/net.js）**立刻**画出来；
 *   · `ready` 到了再用 `GameNet.me` 对齐 —— **服务端说的才算数**，缓存只是显示层的提前。
 *
 * ⚠️ **不要**拿 cachedMe 去填 `GameNet.me`，也不要拿它判断登录态：
 *    平台外壳的登录竞态（迟到的 401 不许把界面翻回登录页）就是靠"me 只有服务端说了才算"
 *    成立的（shared/net/net.js 里写着这条）。
 */
let menuMeId = null;   // 复制要复制**纯 ID**（按钮上写的是 "ID X"），所以另存一份

function renderMeLine() {
  const nameEl = document.getElementById('menu-me-name');
  const idEl = document.getElementById('menu-me-id');
  if (!nameEl || !idEl) return;

  const Net = window.GameNet;
  const me = (Net && Net.me) ||
    (Net && typeof Net.cachedMe === 'function' ? Net.cachedMe() : null) ||
    null;

  if (!me) {
    // 真的没登录（或者身份已被 forgetMe 清掉）：按钮禁用，别让用户点了没反应
    menuMeId = null;
    nameEl.textContent = '正在确认身份…';
    idEl.textContent = 'ID —';
    idEl.disabled = true;
    return;
  }
  menuMeId = me.id;
  nameEl.textContent = '你：' + (me.name || '');
  idEl.textContent = 'ID ' + me.id;
  idEl.disabled = false;
}

function copyMenuMeId() {
  if (!menuMeId) return;
  // 用平台共用的复制（HTTP 下 navigator.clipboard 不可用，它有退路，见 shared/ui/ui.js）
  window.FrpUI.copyText(menuMeId, '玩家 ID');
}

function bindMeLine() {
  renderMeLine();
  const idEl = document.getElementById('menu-me-id');
  if (idEl) idEl.addEventListener('click', copyMenuMeId);
  // 身份变化（真的 ready 到了 / 名字或 ID 变了）就重画那一行
  const Net = window.GameNet;
  if (Net && typeof Net.on === 'function') Net.on('ready', renderMeLine);
}

/* app.js 是最后一个加载的脚本（defer），DOM 已经解析完，可以直接干 */
loadPrefs();
bindPrefSync();
bindPrefButtons();
bindMeLine();