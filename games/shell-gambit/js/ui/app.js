/**
 * Shell Gambit — 界面主控（接入平台后的版本）
 *
 * 【和原项目的差别，改之前先读】
 * 原项目的 `js/ui/app.js` 同时干四件事：屏幕切换、名字录入、房间大厅、对局渲染，
 * 还直接跟 `js/net/session.js`（MQTT / WebRTC / 房主裁决）绑在一起。
 * 搬进平台之后：
 *   · **联机层整个删掉** —— 房间号、成员、邀请、开局都由 shared/ui/room.js（FrpRoom）负责；
 *     WebSocket 收发包由 shared/net/net.js（GameNet）负责。见 DECISIONS.md D1。
 *   · **名字界面整个删掉** —— 名字与 ID 来自平台账号，`GameNet.me` → `{id, name}`。见 D5。
 *   · **服务端是权威** —— 客户端只做两件事：把 view 画出来、把玩家的操作翻成 act 发出去。
 *   · **对局渲染抽到 js/ui/board.js** —— 单机与联机共用同一份渲染代码（铁律二）。
 *
 * 【这个文件现在只剩三件事】屏幕切换、单机人机对局的驱动、把 FrpRoom 和 board 接起来。
 *
 * 依赖方向：games/* → shared/*。这里读的是 shared 那边的**经典全局脚本**
 * （window.FrpProtocol / GameNet / FrpUI / FrpRoom），所以用法是 `globalThis.GameNet`。
 */

import { ALL_ITEMS, ITEM_INFO } from '../engine/constants.js';
import { pickAiName } from '../ai/ai.js';
import { animBusy, mountBoard, syncPlatformToggles } from './board.js';
import { sfx, bindClickSounds } from './audio.js';
import { isFxEnabled, setFxEnabled, syncFxPrefs, toast } from './effects.js';
import { icon } from './icons.js';
import { createLocalMatch } from './match.js';

/** 本游戏的 slug。必须与 server/games/shell-gambit.mjs 的 meta.slug 完全一致。 */
const SLUG = 'shell-gambit';
const AI_DELAY_MS = 950;

const $ = (id) => document.getElementById(id);

/** 平台那边的全局脚本。取的时候判空，免得脚本没加载完就报 "cannot read of undefined"。 */
const P = () => globalThis.FrpProtocol;
const GameNet = () => globalThis.GameNet;
const FrpUI = () => globalThis.FrpUI;
const FrpRoom = () => globalThis.FrpRoom;

const state = {
  /** 单机对局驱动器；联机时为 null */
  match: null,
  /** 当前牌桌渲染器 */
  board: null,
  /** 牌桌当前挂在哪个来源上：'local' | 'online' */
  boardOwner: null,
  /** 联机时 FrpRoom 每次渲染给我的最新 view */
  roomView: null,
};

/** 单机对局的"电脑在想什么"提示条（元素懒创建，所以状态放在外面） */
const aiHintBox = { el: null, timer: null };

/* ------------------------------------------------------------------ *
 * 屏幕切换
 * ------------------------------------------------------------------ */

function show(id) {
  for (const s of document.querySelectorAll('.screen')) {
    s.classList.toggle('is-active', s.id === `screen-${id}`);
  }
}

function toastMsg(text, kind) {
  const ui = FrpUI();
  if (ui) ui.toast(text, kind);
  else toast(text, kind);
}

/* ------------------------------------------------------------------ *
 * 单机人机对局（**本地跑**，GAME-SPEC 第 14 节）
 * ------------------------------------------------------------------ */

/** /api/me 拿到的身份（页面一打开就有；仍然是服务端给的，不是猜的） */
let fetchedMe = null;

/**
 * 浏览器里**记着**的那份身份（`GameNet.cachedMe()`，localStorage 的 `frp.me`）。
 *
 * 【为什么要有它】平台首页和游戏页是**两个不同的网页**，点进游戏是一次整页跳转；
 * 而公网那次 WebSocket 握手实测要 **2~3 秒**（D13）。这段窗口里原来名字和 ID 是空的，
 * 用户第 5 条反馈说的就是这个。平台外壳拿到 /api/me 或 ready 时会顺手记一份，
 * 游戏页一打开就先拿它把界面画出来 —— 名字/ID **立刻**就有。
 */
let rememberedMe = null;

/**
 * 我是谁 —— 给**逻辑**用（开局、复制 ID 这些要动真格的地方）。
 *
 * 顺序（见 `docs/DECISIONS.md` D13 与 `docs/GAME-SPEC.md` 第 6 节）：
 *   ① `GameNet.me`  —— WebSocket 的 ready 认出来的那一份，**唯一权威**
 *      （房间/好友那套东西认的就是它）；
 *   ② `cachedMe()`  —— 平台记在浏览器里的那一份（进页面**立刻**就有）；
 *   ③ `/api/me` 的结果 —— 打开页面时那条 HTTP，通常比 WebSocket 先回来。
 *
 * ⛔ **缓存只用于显示 + 本地单机开局，绝不参与"我登录了没有"的判断**：
 *    · 它**不写进** `GameNet.me`（平台的登录竞态靠"me 只有服务端说了才算"成立，D13）；
 *    · 它不参与任何权限判断：会话过期时 `/api/me` 返回 401 → 照样回登录页；
 *      联机动作一律由服务端裁决（"还没轮到你""你不在这一局里"这些都是服务器说的）；
 *    · 拿它开局的那一局是**单机人机对局**，整局跑在本机，不向服务器要任何权限。
 */
function myIdentity() {
  const net = GameNet();
  const me = net && net.me;
  if (me && me.id && me.name) return me;
  if (rememberedMe && rememberedMe.id) return rememberedMe;
  return fetchedMe;
}

function startLocalGame(playerCount) {
  const me = myIdentity();
  if (!me) { toastMsg('还没连上平台，稍等一下再试', 'error'); return; }

  leaveEverything();

  const aiNames = [];
  for (let i = 1; i < playerCount; i++) aiNames.push(pickAiName([me.name, ...aiNames]));

  const match = createLocalMatch({
    me,
    playerCount,
    aiNames,
    aiDelayMs: AI_DELAY_MS,
    // 回调里拿到的一定是 viewFor(state, me.id) 的结果 —— 不是引擎的完整 state。
    onUpdate: (view, info) => {
      if (state.board) state.board.render(view);
      if (info && info.aiReason) showAiHint(info);
    },
  });

  state.match = match;
  show('game');
  mountBoardFor('local');
  state.board.render(match.viewFor(me.id));
  // 座位随机，开局可能直接轮到 AI —— 必须主动推一把，否则界面会干等
  match.start();
}

/** 显示"电脑在想什么"（只用于单机；联机时 AI 在服务器上，玩家看不到理由） */
function showAiHint(info) {
  const host = $('screen-game');
  if (!host) return;
  if (!aiHintBox.el) {
    aiHintBox.el = document.createElement('div');
    aiHintBox.el.className = 'ai-hint';
    host.appendChild(aiHintBox.el);
  }
  aiHintBox.el.textContent = `电脑：${info.aiReason}`;
  aiHintBox.el.classList.add('is-on');
  clearTimeout(aiHintBox.timer);
  aiHintBox.timer = setTimeout(() => { if (aiHintBox.el) aiHintBox.el.classList.remove('is-on'); }, 2000);
}

/* ------------------------------------------------------------------ *
 * 牌桌的挂载 / 卸载
 * ------------------------------------------------------------------ */

/**
 * 建一张新的牌桌。
 * 每次进入对局都重建：座位、事件序号、临时选中的道具都要回到干净状态，
 * 复用旧的那张会带着上一局的座位 DOM。
 */
function mountBoardFor(owner) {
  const host = $('screen-game');
  if (state.board) { state.board.dispose(); state.board = null; }
  state.boardOwner = owner;
  // 对局记录的展开状态记在本地（原项目的既有约定）
  try { host.dataset.feedOpen = localStorage.getItem('sg.feedOpen') === 'on' ? 'on' : 'off'; }
  catch { host.dataset.feedOpen = 'off'; }

  state.board = mountBoard({
    host,
    onAct: (action) => submitAction(action),
    onInfo: (text) => toastMsg(text),
    onLeave: () => leaveGame(),
  });
}

/** 玩家点了一个操作：单机本地提交，联机把意图发出去（服务器裁决） */
function submitAction(action) {
  /*
   * ⚠️ **演出期间一律不发**（`docs/DECISIONS.md` D10，本游戏唯一的 `room.act` 出口）。
   *
   * 服务端那一帧早就把回合推进过了，而画面上一次 act 带回来的好几步还要
   * 450–700ms 一步一步演完 —— 这段时间玩家看见的是"上一步"。
   * 不锁的话就是用户报的那句"还没演完操作权就又回到用户层了"。
   *
   * 牌桌的 `doAction()` 已经判过一次（那一次是为了"不改界面状态"）；
   * 这里是**真正发消息的人**，所以再判一次：将来多出一条调用路径也发不出去。
   * 判据本体在 board.js 的 `animBusy()`（导出复用，不抄第二份）。
   *
   * 房间级操作（开始 / 离开 / 邀请 / 加人机）不走这里 —— 它们和演出无关，不受影响。
   */
  if (animBusy()) return false;

  if (state.boardOwner === 'online') {
    // FrpRoom 的 api 里没有暴露 act，所以这里直接用协议常量发一条 room.act ——
    // 报文结构见 docs/ARCHITECTURE.md 的「消息协议」表。
    return GameNet().send(P().T.ROOM_ACT, { act: action });
  }
  const res = state.match && state.match.submit(action);
  if (res && res.ok === false) toastMsg(res.message || '这个操作现在不能做', 'error');
  // 返回值语义：true = 真的交出去了，false = 没交出去（演出锁挡下 / 单机本地已同步处理完）。
  // 牌桌现在**不**拿它决定任何演出（本地预演已经删掉，见 docs/DECISIONS.md D10）。
  return false;
}

function leaveGame() {
  if (state.boardOwner === 'online') {
    GameNet().send(P().T.ROOM_LEAVE, {});
    state.roomView = null;
    leaveEverything();
    show('online');
    return;
  }
  leaveEverything();
  show('home');
  toastMsg('已退出对局');
}

/** 清掉单机对局与牌桌（联机时不碰房间 —— 那由 FrpRoom 管） */
function leaveEverything() {
  if (state.match) { state.match.dispose(); state.match = null; }
  if (state.board) { state.board.dispose(); state.board = null; }
  state.boardOwner = null;
  state.roomView = null;
  if (aiHintBox.el) { aiHintBox.el.remove(); aiHintBox.el = null; }
  const host = $('screen-game');
  if (host) host.innerHTML = '';
}

/* ------------------------------------------------------------------ *
 * 联机：全部交给 FrpRoom（房间号、成员、邀请、开始、再来一局）
 * ------------------------------------------------------------------ */

function bindOnline() {
  const room = FrpRoom();
  if (!room) { toastMsg('房间组件没加载出来，刷新一下页面试试', 'error'); return; }

  /** 收到别人发的邀请时弹一下（跨游戏的跳转由平台外壳负责，这里只处理本游戏页内） */
  room.handleInvites({
    goToGame: (slug) => { if (slug === SLUG) show('online'); },
    gameTitle: (slug) => (slug === SLUG ? 'Shell Gambit' : slug),
  });

  room.mount({
    container: $('online-panel'),
    game: SLUG,
    /*
     * minPlayers 与 server/games/shell-gambit.mjs 的 meta.minPlayers 必须一致（=1）。
     * 房间层用它数**真人**下限（`players.length < meta.minPlayers` → 拒绝开局）。
     *
     * ⚠️ 决定「开始游戏」灰不灰的**不是它**了：`room.js` 先看 `minSeats`（座位数
     * 含人机，见 meta.minSeats = 2），只有老版本没有 `minSeats` 时才回退到这个数。
     * 所以一个人建房时按钮是灰的（座位 1 / 2），按一下「＋ 添加人机」才解禁 ——
     * 想让它一个人就能开，正确做法是**加人机座位**，不是把这个数写小。
     */
    minPlayers: 1,

    /**
     * ⚠️ 这里**没有** `options`，也**没有** `renderSetup` —— 本作在准备区
     * 一个设置项都没有，这是刻意的。
     *
     * 【原来那个"补几个电脑"的控件为什么删掉了】
     * 从这一版起，人机是**房间的座位**：房主在准备区按一下平台外壳画的
     * 「＋ 添加人机」就多一个座位，`shared/ui/room.js` 统一画（含「移除」），
     * 服务端 `server/games/shell-gambit.mjs` 只把 `players` 里 `isBot === true`
     * 的座位当成 AI 座位。所以：
     *   · 游戏这边**没有**可选的设置项了 —— `options.aiFill` 整条通路已作废；
     *   · 留一个空的 renderSetup 只会画出一个空的 `.frp-room-setup` 框；
     *   · 更要命的是留一个"补几个"的控件会和服务端的座位表对不上
     *     （玩家点 3、房里却只有 1 个人机座位，界面就开始撒谎）。
     *
     * 【座位数够不够由谁说了算】
     * 平台：`meta.minSeats = 2`（总座位下限）随 room.state 下来，`room.js` 用它
     * 决定「开始游戏」灰不灰、以及那句"至少要 2 个座位"。
     * 一个人建房时「开始游戏」是**灰的**（座位 1 / 2），点不动 —— 这一条和
     * `minPlayers: 1` 不冲突：minPlayers 管"几个真人"，minSeats 管"几个座位"。
     */

    /**
     * 对局中/已结束：把服务器给的 view 画出来。
     * `host` 是 FrpRoom 给的容器，但我们要独占整个对局屏，
     * 所以真正渲染到 #screen-game，FrpRoom 那个容器留空。
     * （FrpRoom 会在 room.state 到达时调用它，所以这里同时负责切屏 ——
     *   不再另开一个 ROOM_STATE 监听去切，否则同一帧会渲染两次。）
     */
    renderGame: (_host, view) => {
      show('game');
      renderOnlineView(view);
    },
  });

  // 回等待态（刚建房 / 房主按了"再来一局"）时切回在线屏
  GameNet().on(P().T.ROOM_STATE, (msg) => {
    if (!msg || msg.game !== SLUG) return;
    if (state.match) return; // 单机对局中，别被房间消息打断（正常情况下也不会有房间）
    if (msg.phase === 'waiting') {
      state.roomView = null;
      show('online');
    }
  });
}

/**
 * 画联机的对局。
 *
 * ⚠️ 进来的一定是**服务器 viewFor 裁剪过的 view**（FrpRoom 从 room.state 里取），
 *    界面这边没有任何机会读到引擎状态 —— 联机模式的防作弊就是靠这一点。
 * ⚠️ 「再来一局」之后服务器会把 phase 打回 waiting、view 变 null，
 *    下一次开局是一条全新的 room.state；因为它带着 frame 从头开始的 log，
 *    所以这里只要在 view 的 seq 变小/换局时重建牌桌就行。
 */
function renderOnlineView(view) {
  if (!view) return;
  const freshGame = state.roomView && view.seq < (state.roomView.seq || 0);
  state.roomView = view;
  if (state.boardOwner !== 'online' || freshGame) mountBoardFor('online');
  state.board.render(view);
}

/* ------------------------------------------------------------------ *
 * 规则页 / 设置 / 身份显示
 * ------------------------------------------------------------------ */

function renderRules() {
  const items = ALL_ITEMS.map(
    (id) => `
    <div class="item-row">${icon(ITEM_INFO[id].icon)}
      <div><b>${ITEM_INFO[id].name}</b><br />${ITEM_INFO[id].desc}</div>
    </div>`
  ).join('');

  $('rules-body').innerHTML = `
    <h3>基础玩法</h3>
    <ul>
      <li>2–4 人，每人 <b>5 点生命</b>，开局随机分配 1–4 号座位。</li>
      <li>每<b>轮</b>随机装填一批「实弹 / 空弹」混合弹序，<b>两种弹药各剩多少是公开的，先后顺序保密</b>。</li>
      <li>轮到你就摸牌，然后选择【对自己开枪】或【对别人开枪】。</li>
      <li><b>空弹打自己</b>：不掉血，并且<b>保留回合</b>，可以继续操作。</li>
      <li>实弹命中扣 1 点血（锯短枪管时扣 2 点），血量归零立即淘汰。</li>
      <li>弹匣打空后自动重新装填，<b>从 1 号座位开始新一轮</b>（1 号已出局则由下一个存活座位开始）。</li>
      <li>最后活下来的唯一玩家获胜。</li>
    </ul>

    <h3>摸牌规则</h3>
    <ul>
      <li>牌堆共 28 张（每种道具各 4 张）。</li>
      <li>开局每人 2 张；之后每个回合摸 2 张，<b>全局第一回合只摸 1 张</b>。</li>
      <li>手牌上限 4 张：回合开始前有 3 张就只发 1 张，已有 4 张则不发。</li>
      <li>摸牌堆少于 4 张时，弃牌堆重新洗匀后放到摸牌堆<b>底部</b>。</li>
    </ul>

    <h3>道具</h3>
    ${items}

    <h3>几个容易记错的细节</h3>
    <ul>
      <li>放大镜看到的情报<b>只有自己知道</b>，别人看不到。</li>
      <li>逆转器是公开动作：原本知道这一发的人，会同步知道它被反转了。</li>
      <li>手锯只对<b>下一发</b>有效，打出空弹就浪费了；已经锯过不能重复锯。</li>
      <li>香烟回血上限 5 点，满血使用等于浪费一张牌。</li>
      <li>肾上腺素偷不到对手的肾上腺素（防止无限循环）；偷到手铐会再让你选一次目标。</li>
      <li>手铐不能铐自己，也不能铐已经被铐住的人。</li>
    </ul>

    <h3>在线对局</h3>
    <ul>
      <li>服务器是权威：你的每一次操作都发到服务器判定，再把<b>只属于你的视图</b>发回来。</li>
      <li>弹匣顺序、别人的手牌、别人用放大镜看到的结果，<b>根本不会出现在任何报文里</b>。</li>
      <li>人不够也能开局：房主在准备界面按「<b>＋ 添加人机</b>」补座位（按一下多一个，
        加错了按成员那一行的「移除」），<b>座位满 2 个</b>就能开始。
        人机坐在座位上，名字是单字（和单机人机是同一批字），圆环是<b>灰色</b>的 ——
        自己＝蓝、其他真人＝橙、人机＝灰。</li>
      <li>点头像可以扔鸡蛋 / 送鲜花（连人机也能扔），两边都会看到。</li>
      <li>联机时有人掉线，他的座位由电脑接管，这局能继续打完。</li>
    </ul>

    <h3>关于 AI</h3>
    <p>AI 与真人看到的信息完全一样：只有公开的血量、手牌张数、剩余弹药数量，
    以及自己用放大镜看到的结果。它<b>读不到弹匣顺序，也读不到别人的手牌</b>，
    打分逻辑也<b>不看谁是真人谁是电脑</b>（座位身份是公开信息：圆环的颜色就摆在那里），
    因此它不会针对或保护任何人。</p>
  `;
}

function refreshToggleLabels() {
  const s = $('toggle-sound');
  const f = $('toggle-fx');
  if (s) s.textContent = `🔊 音效：${sfx.enabled ? '开' : '关'}`;
  if (f) f.textContent = `✨ 特效：${isFxEnabled() ? '开' : '关'}`;
  // 本地存的开关状态要**立刻**告诉平台层（扔鸡蛋/鲜花的音效、逐条演出的时长
  // 都归 shared/ui/react.js 与 anim.js 管）。实现与理由在 board.js 里，
  // 那边对局内菜单的两个开关也调同一个函数。
  syncPlatformToggles();
}

function bindSettings() {
  $('toggle-sound').addEventListener('click', () => {
    // 取反之后**写回平台那一份偏好**（FrpUI.prefs），不是自己存一个键 ——
    // 各存各的就会出现"平台设置栏关着、游戏里还响"（用户点名不许打架，见下）
    sfx.setEnabled(!sfx.enabled);
    refreshToggleLabels();
  });
  $('toggle-fx').addEventListener('click', () => {
    setFxEnabled(!isFxEnabled());
    refreshToggleLabels();
  });
}

/**
 * 音效 / 特效：**平台只有一份偏好**（`FrpUI.prefs`，见 `shared/ui/ui.js` 与 GAME-SPEC §7）。
 *
 * 【为什么必须订阅，而不是只在加载时读一次】平台设置栏（平台外壳那一页）和游戏里
 * 这两个开关写的是**同一个 localStorage 键**（`frp.prefs`）。谁改了都要立刻反映到这里：
 *   · 平台设置栏里关了音效 → 进游戏页读一次就是关的（加载时读，上面那两行）；
 *   · 在游戏页里改 → `setEnabled()` 写回同一份；
 *   · 另一个标签页改了 → `prefs.on()` 的回调也会把这边对齐（浏览器同源事件除外，
 *     这里靠的是同一个页面里的订阅；跨标签页那一条由平台外壳负责）。
 * ⚠️ 回调里只**同步值 + 重画按钮文字**，不再写回 prefs（写回会转圈）。
 * ⚠️ 顺便把值转告平台层（`syncPlatformToggles()`）：扔鸡蛋的音效、逐条演出的时长
 *    归 shared/ui/react.js 与 anim.js 管，不转告就成了"游戏关了、平台还在响"。
 */
function bindPrefs() {
  const ui = FrpUI();
  if (!ui || !ui.prefs) return;   // 平台脚本没加载（理论上不会）：保持默认值
  const apply = () => {
    sfx.syncPrefs(ui.prefs.sound());
    syncFxPrefs(ui.prefs.fx());
    refreshToggleLabels();
  };
  apply();                 // 先按存着的那份把开关摆正
  ui.prefs.on(apply);      // 之后谁改了都跟着走（返回的退订函数本页不需要）
}

function bindNavigation() {
  document.addEventListener('click', (event) => {
    const go = event.target.closest('[data-go]');
    if (go) {
      sfx.ensure();
      const target = go.dataset.go;
      // 进"在线对局"前不需要再问名字 —— 身份来自账号
      if (target === 'online' && state.match) leaveEverything();
      show(target);
      return;
    }
    const back = event.target.closest('[data-back]');
    if (back) {
      sfx.ensure();
      if (back.dataset.back === 'home') leaveEverything();
      show(back.dataset.back);
    }
  });

  $('ai-counts').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-players]');
    if (!btn) return;
    sfx.ensure();
    startLocalGame(Number(btn.dataset.players));
  });

  $('home-id').addEventListener('click', () => {
    const me = myIdentity();
    if (me) FrpUI().copyText(me.id, '玩家 ID');
  });
}

/** 页面上显示"你是谁"。名字与 ID 都来自平台账号，游戏里没有任何输入框。 */
function showIdentity() {
  const me = myIdentity();
  if (!me) return;
  $('home-name').textContent = me.name;
  $('home-id').textContent = `ID ${me.id}`;
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */

export async function init() {
  bindClickSounds(document);
  bindNavigation();
  bindSettings();
  renderRules();

  const net = GameNet();

  /*
   * ① **先把"记着的身份"画到屏幕上**（第一件事做）。
   *
   * 【为什么排在最前面】游戏页是一次整页跳转，公网那次 WebSocket 握手实测要 2~3 秒：
   * 这段时间里用户看到的是空名字，点「人机对局」还会被误判成"还没连上平台"并弹一句假提示
   * （D13 里记的就是这个真 bug）。平台外壳拿到 /api/me 或 ready 时顺手把身份记在了浏览器里，
   * 这里先拿它把名字/ID 顶上去 —— `myIdentity()` 的顺序是
   * **GameNet.me（权威）→ 缓存 → /api/me 的结果**，所以下面那两条路照旧会把它对齐。
   *
   * ⛔ 缓存**只用于显示**（和本地单机开局的兜底身份）：不写进 GameNet.me、不判断登录态。
   *    服务端说了才算 —— 下面 `/api/me` 401 照样回登录页。
   */
  const remembered = net && typeof net.cachedMe === 'function' ? net.cachedMe() : null;
  if (remembered && remembered.id) {
    rememberedMe = remembered;
    showIdentity();
  }

  /*
   * ② 音效 / 特效偏好：读平台那一份，并订阅它的变化（实现与理由见 bindPrefs）。
   * 放在这里（而不是更早）是因为它要重画首页那两个开关的文字。
   */
  bindPrefs();
  refreshToggleLabels();

  // 手机端首次点击解锁音频；顺手挡掉移动端双击缩放
  document.addEventListener('pointerdown', () => sfx.ensure(), { once: true });
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

  /*
   * ⚠️ 必须先 connect()，否则后面全是哑的。
   *
   * `/shared/net/net.js` 只**定义**连接能力，不会自己连 —— 平台外壳调的是
   * web/assets/js/app.js 里的 Net.connect()，游戏页必须自己调一次
   * （blade-steed 也是在它的 app.js 里调的）。
   *
   * 漏了这一行的后果是**静默的**、而且很能骗人：
   *   · 名字和 ID 照样显示得出来（那是 /api/me 给的，不走 WebSocket）
   *   · 单机人机对局也照常能玩（纯本地）
   *   · 只有点「创建房间」时才炸 —— GameNet.send() 发现 socket 不是 open 就
   *     直接返回 false，什么也没发出去，界面就干等在"创建房间"那一屏上，
   *     而且**一个报错都没有**。这个坑就是浏览器测试趟出来的。
   *
   * connect() 是幂等的（socket 已经在 connecting/open 时直接返回），
   * 所以放在最前面，重连逻辑交给 net.js 自己管。
   */
  if (net) net.connect();

  /*
   * 身份有三个来源，按这个顺序用（`myIdentity()` 里就是这三步），缺一个都会出问题：
   *
   *  · `GameNet.me`（WebSocket 的 ready）—— **唯一权威**，房间/好友那套东西认的身份；
   *  · `GameNet.cachedMe()`（浏览器里记着的那份）—— 上面 ① 已经用它把界面画出来了；
   *  · `/api/me`（HTTP）—— **页面一打开就能知道"我是谁"**。
   *    只靠 WebSocket 的 ready 是不够的：游戏页是一个新页面，GameNet 进来时 WebSocket
   *    还没连上；而 ready 是连接就绪时**推一次**的消息，如果页面在它之后才注册监听
   *    （或者错过了那一次推送），名字就会一直停在占位符上。
   *    这里的坑是实测撞出来的：单机开局拿不到身份就直接弹"还没连上平台"。
   *
   * 顺带：/api/me 返回 401 说明没登录 → 回平台首页登录（D5：必须登录才能进站）。
   * ⚠️ 这一条**只认服务端的回答**，缓存再新也不算数（缓存只用于显示，见 myIdentity）。
   */
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.status === 401) { location.replace('/'); return; }
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && data.me) {
        fetchedMe = data.me;
        showIdentity();
      }
    }
  } catch { /* 网络抖动就不跳，后面靠 WebSocket 的 ready 再认一次 */ }

  bindOnline();

  if (net) {
    net.on(P().T.READY, showIdentity);
    if (net.me) showIdentity();

    // 已经在一个属于本游戏的房间里（比如从平台首页的好友卡片点进来的）→ 直接去该去的屏
    const room = net.room;
    if (room && room.game === SLUG) {
      if (room.phase === 'waiting') {
        show('online');
      } else {
        show('game');
        renderOnlineView(room.view);
      }
    }
  }

  // 自动化测试等这个标记，避免在事件绑定完成前点击
  document.body.dataset.sgReady = '1';
}