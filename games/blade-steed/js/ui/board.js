/**
 * BladeSteed — 牌桌视图（地图 + 状态条 + 播报 + 行动面板）
 *
 * 这个文件只干一件事：**把一份裁剪过的 view 画出来**，并把点击翻译成「意图信封」。
 * 它不碰引擎、不碰网络、也不知道现在是单机还是联机 —— 谁拿到 view、把信封发给谁，
 * 由 js/ui/app.js 决定（单机发给 LocalMatch，联机交给 js/ui/online.js 的 act()）。
 * 所以「单机一套渲染、联机另一套渲染」这种典型分叉在这里不可能出现（docs/GAME-SPEC.md 铁律二）。
 *
 * 「有哪些操作可以点」一律来自 engine/rules.js 的 legalActionsFrom(view, selfId) ——
 * 和引擎校验、AI 决策空间是同一份实现，所以不会出现「按钮点得动但服务端拒绝」（铁律三）。
 *
 * ⚠️ 联机时这个视图会被 FrpRoom **反复重画**：房间层每次收到 room.state 都会
 * 清空容器再调 renderGame。所以这里刻意不自己造 DOM 容器，而是由调用方把一个
 * **常驻的根元素**（app.js 的 this.onlineRoot）交给它 —— 每次只是把根元素重新挂到
 * 新容器里。重建 DOM 会砍断正在播的飞刀/飘字动画，也会让头像的位移补间重新开始。
 *
 * 【时间轴：只有一条，服务端说了什么就演什么】
 *   · 服务器一次推来好几条事件（它必须把 AI 整轮跑完）→ `_queueSteps` 交给
 *     shared/ui/anim.js 的 `FrpAnim.push` **逐条串行**演完（用户第 1 条需求）。
 *   · **逐步同步**（用户报的"对方的刀、马已经亮起来了""位置移动直接瞬移过去了"）：
 *     每一步先把它自己的公开状态补丁（`ev.s`，引擎算好的"这一步之后的状态"）贴到
 *     **显示视图**上再重画，所以演到第几步，血量/装备/位置/回合/行动面板/播报就是第几步；
 *     整批演完、队列真空之后再用**权威视图**整体对账一次。见 docs/DECISIONS.md D14。
 *     ⛔ 贴的是服务器给的数字，客户端**绝不照事件自己算**（那是重写一遍规则，违反铁律三）。
 *   · ⚠️ **不做本地预演**（曾经做过，已整段删除）：点下去到服务器回包之间，
 *     本机不播任何动画、不出任何音效 —— 画面上"我这一手"由服务端回放的那一步演出来。
 *     为什么删：用户实测快速连点会把画面演成"所有人都被打死了"（本地时间轴和回放叠在一起），
 *     见 docs/DECISIONS.md D10。
 *   · ⚠️ **演出期间锁住输入**：`FrpAnim.busy()` 为真时，所有动作入口（`_blocked()`）
 *     一律当成没点 —— 不发消息、不播声音、不改界面（用户第 2 条需求）。
 *     权威数据（血量/回合/胜负）永远等服务器推来的视图。
 */

import { MapBoard } from './map.js';
import { Effects } from './effects.js';
import { ACT, PHASE, RPS_LABEL, WILD } from '../engine/constants.js';
import { legalActionsFrom } from '../engine/rules.js';

const RPS_EMOJI = { rock: '✊', scissors: '✌️', paper: '✋' };

/**
 * 每一条事件该演多久（毫秒）。
 *
 * 用户的要求：**450~700ms，一步演完再演下一步**，而且不许快进、不许点击跳过
 * （所以这里只给时长，别的什么都不做）。时长按"这条事件在屏幕上有多热闹"给：
 * 砍 / 踹 / 出局 / 终局最长（有刀光、飞脚、飘血、震屏、横幅），
 * 买装备 / 走位中等，回合与出拳登记最短（只是点亮一个标记 + 一个短音）。
 *
 * ⚠️ 别把 turn / rps-pick 调长：一轮猜拳里它们出现最多次，
 *    一次推送里常常几十条，调长了整场演出就拖到十几秒（平台侧还有 MAX_BACKLOG 兜底）。
 * ⚠️ 演出期间输入是**锁住**的（见 `_blocked()`）：这些时长就是玩家要等的时长，
 *    别顺手再往上加。
 * ⚠️ 导出它是给 `tests/rules.test.mjs` 用的：那条"队列空的那一刻剩余时间 ≥ 标称限时的 90%"
 *    的用例要拿真实步长把一轮演出加起来，和 `REPLAY_BUFFER_MS` / `*_TIMEOUT_MS` 对一下账。
 *    它是纯函数（不碰 DOM），所以 Node 里 import 本文件也没问题。
 */
export function stepMs(ev) {
  switch (ev.t) {
    case 'knife':
    case 'kick':
    case 'down':
    case 'over':
      return 700;
    case 'rps-reveal':
    case 'mini-reveal':
      return 650;
    case 'buy':
    case 'move':
      return 600;
    case 'order':
      return 550;
    default:
      // turn / rps-start / rps-pick / mini-start / mini-pick / pass / round / join / auto-pick
      return 450;
  }
}

/**
 * 演出队列还在放吗？
 *
 * 平台的 `shared/ui/anim.js` 在队列没排空时 `busy()` 为真，同时给 `<body>` 挂
 * `frp-anim-busy`。**所有会发消息的动作入口都要先问它**（用户第 2 条需求 /
 * docs/DECISIONS.md D10）：服务端那一帧早就把回合推进过了，画面还在演的时候接着点，
 * 看到的画面和实际局面就会错位。
 *
 * 导出成模块级函数是刻意的：`BoardView` 的所有点击口子和 `js/ui/online.js` 的发送口子
 * （那边走 `GameNet.send`，见它的注释）共用同一份判定，不会出现"按钮灰着但消息照样发"。
 * ⚠️ 平台脚本没加载（`window.FrpAnim` 不在）时返回 false = 不锁：
 *    那种情况下根本没有演出队列，锁住等于把游戏锁死。
 */
export function animBusy() {
  const anim = window.FrpAnim;
  return !!(anim && typeof anim.busy === 'function' && anim.busy());
}

function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

export class BoardView {
  /**
   * @param {HTMLElement} root 常驻根元素（调用方负责把它挂到当前容器里）
   * @param {object} opts
   * @param {(act:object)=>void} opts.onAct 把一个意图信封发出去
   * @param {import('./audio.js').AudioKit} opts.audio
   * @param {HTMLElement} [opts.menuButton] 顶栏左侧的按钮（单机用来开对局菜单；联机由房间外壳提供）
   * @param {() => void} [opts.onHome] 结束面板里「回到首页」的动作（不传就只显示结果）
   */
  constructor(root, { onAct, audio, menuButton = null, onHome = null }) {
    this.root = root;
    this.onAct = onAct;
    this.audio = audio;
    this.onHome = onHome;

    this.lastEventId = 0;
    this.lastLogId = 0;
    this.orderDraft = null;
    this.orderKey = '';
    this._orderSel = null;
    this._deadlineAt = 0;
    this.view = null;
    /*
     * **权威视图**（服务器最新推来的那一份，只在对账时用一次）。
     * 和 `this.view`（显示视图）分开是逐步同步的地基 —— 见 render 的注释。
     */
    this.authView = null;
    /** 已经**贴过补丁**的最后一条事件编号（补丁是差量，只有正好接得上时才敢贴） */
    this._appliedId = 0;
    /** 对账定时器（"队列什么时候真的空了"只有平台队列自己知道，见 _scheduleReconcile） */
    this._reconcileTimer = null;
    this.selfId = null;

    this.root.classList.add('board');

    // 地图：SVG 只用 viewBox 里的用户坐标，不量像素 ——
    // 所以哪怕此刻根元素还没插进文档，画出来也是对的（联机时就是这样）。
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'map');
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.svg.setAttribute('aria-label', '战场地图');
    this.board = new MapBoard(this.svg);
    this.fx = new Effects(this.board);

    this.els = {
      phase: h('span', { class: 'pill', text: '猜拳' }),
      round: h('span', { class: 'pill ghost', text: '第 1 回合' }),
      timer: h('span', { class: 'timer' }, [h('span', { text: '—' })]),
      log: h('div', { class: 'log-strip' }),
      panel: h('div', { class: 'action-panel' }),
    };

    this.root.replaceChildren(
      h('div', { class: 'board-top' }, [
        menuButton,
        h('div', { class: 'board-status' }, [this.els.phase, this.els.round]),
        this.els.timer,
      ]),
      h('div', { class: 'map-wrap' }, [this.svg]),
      h('div', { class: 'board-bottom' }, [this.els.log, this.els.panel])
    );
  }

  /* ============================== 渲染 ============================== */

  /**
   * 收到一帧新视图（服务器说现在是这样）。
   *
   * 【为什么**不**在这里立刻把整块牌桌按最终状态画出来】
   * 老写法是 `this.view = view` 然后整块重画，只有"特效 + 播报"排进演出队列 ——
   * 于是演出还要演两三秒，画面早就是结算后的样子了：用户报的"对方的刀、马已经亮起来了"
   * "位置移动直接瞬移过去了"就是这个（地图靠 CSS transition 补间，坐标在收到消息的**那一瞬间**
   * 就改了，补间发生在演出之前）。见 docs/DECISIONS.md D14 / GAME-SPEC §4「逐步同步」。
   *
   * 现在把这条报文里的**新事件**按 id 升序交给串行队列，每一步先把它自己的补丁
   * （`ev.s`，引擎算好的"这一步之后的公开状态"）贴到**显示视图**上再重画 ——
   * 演到第几步，血量 / 装备 / 位置 / 回合 / 行动面板就是第几步的样子。
   * 整批演完、**队列真的空了**之后，再用权威视图整体对账一次（兜住补丁没覆盖到的字段）。
   *
   * ⛔ 对账**不许插队**：队列还在演的时候又来了新视图，只把它记成新的权威视图、把新事件
   *    接着排到队尾，绝不在半路拿它重画（那正是"演到一半突然跳到结果"）。
   *
   * @param {object} view viewFor(...) 的产物
   * @param {string} selfId 我是谁
   */
  render(view, selfId) {
    this.selfId = selfId;
    if (!view) return;
    this.authView = view;

    /*
     * ⚠️ 一进来先把播报条钉回**最新一条**。
     *
     * 联机牌桌的容器每一帧都会被房间外壳清掉重建（`shared/ui/room.js` 的 render 每次
     * `UI.clear(panel)` 再调 `renderGame`），而我们的根元素是**常驻**的（见 js/ui/online.js）——
     * 它"被拔出来再插回去"的那一瞬间，浏览器会把它内部所有滚动位置**清零**：
     * 对局记录当场跳回最旧的一条，要等下一步演出追加上新行时才又滚回最新一条。
     * 用户原话：「"演出中"时对局记录会自动上滑至第一条记录，导致对局记录总是在
     * 最新的一条与最旧的一条之间来回跳转」—— 说的就是每来一帧就跳一次。
     * 见 `_pinLog()`。
     */
    this._pinLog();

    // 权威时限先记下来（显示要等演出演完，见 tickTimer 的"演出中"分支）
    this._syncDeadline(view);

    const events = view.events || [];
    const maxId = events.length ? events[events.length - 1].id : 0;
    const rolledBack = maxId > 0 && maxId < this.lastEventId;

    /*
     * ⚠️ **接上正在进行的对局**：这三种情况一律**不排队回放**，直接把权威视图画出来，
     * 游标设到当前窗口的最后一条（相当于"你已经看过了"），只有"从上一帧之后新增的事件"才排队演。
     *
     *   ① 首次挂载（手里还没有任何视图）；
     *   ② 游标是 0（单机「重新开局」会先 reset() 把游标清零）；
     *   ③ **事件编号回退**（联机「再来一局」会建一个全新的引擎，编号从 0 重来）。
     *
     * 【为什么必须这样】补丁是"相对上一条事件"的差量，而这三种情况下我们手里那份视图是
     * **最终状态**、事件窗口里却还挂着几十条旧事件：照旧一条条排队，既会莫名演上几十秒，
     * 又会把补丁叠在最终状态上 —— 血量/位置会算出**错的数**。聊胜于无的"重播历史"没人要。
     */
    if (!this.view || this.lastEventId === 0 || rolledBack) {
      this._adopt(view, maxId);
      return;
    }

    const fresh = events.filter((e) => e.id > this.lastEventId);
    this.lastEventId = maxId || this.lastEventId;

    if (!fresh.length) {
      // 这一帧没有新事件（重连补发 / 只是房间成员变了）：没有要演的，直接对齐（队列空了再对齐）
      if (animBusy()) this._scheduleReconcile();
      else this._reconcile();
      return;
    }

    /*
     * 老服务端兜底：服务端进程里可能还留着**没有补丁的旧引擎**（页面文件是从磁盘现取的，
     * 引擎模块却是进程启动时 import 进内存的），那种报文一条 `s` 都没有。
     * 这时**保持改动前的行为**：立刻按最终状态画出来、特效照旧逐条演 ——
     * 否则前端一更新、服务端还没重启的那段时间，玩家会看到"画面停在上一步不动"。
     */
    if (!fresh.some((e) => e.s) && !animBusy()) {
      this._reconcile();
      this._queueSteps(fresh);
      return;
    }

    this._queueSteps(fresh);
    this._scheduleReconcile();
  }

  /** 视图是纯 JSON（GAME-SPEC 要求），深拷一份即可 —— 权威对象一个字节都不许改。 */
  _copyView(view) {
    return JSON.parse(JSON.stringify(view));
  }

  /**
   * 把一帧当作"显示基线"：显示视图 = 权威视图的一份拷贝，游标推到窗口最后一条，**不排队回放**。
   * 首次挂载 / 重新开局 / 事件编号回退走这里（理由见 render）。
   */
  _adopt(view, maxId) {
    this.lastEventId = maxId;
    this._appliedId = maxId;
    this.view = this._copyView(view);
    this._paintBoard(this.view);
    this._renderLog(this.view); // 播报全给：这一帧本来就"已经发生过了"
    // 这一帧没有要演的东西（首次挂载 / 重开一局），倒计时立刻按权威时限显示
    this.tickTimer(true);
  }

  /**
   * 用**权威视图**整体重画一次（对账 / 没有事件可演 / 第一帧）。
   * 为什么必须有它：补丁只带"变了的东西"，兜不住任何没覆盖到的字段（中途进人、补丁缺失…）；
   * 演出走完再整体对一次，画面就一定和服务器一致。
   */
  _reconcile() {
    if (!this.authView) return;
    this.view = this._copyView(this.authView);
    this._appliedId = this.lastEventId;
    this._paintBoard(this.view);
    this._renderLog(this.view);
    this.tickTimer(true);
  }

  /**
   * 对账排期：**等队列真的空掉**再用权威视图收口。
   *
   * 【为什么不能按"演出总时长"定时】队列是平台管的，它有没有排空只有 `FrpAnim.busy()` 知道：
   * 中间可能又插进来一批新事件（甚至测试自己塞的占位步），按总时长定时一定会插队 ——
   * 那就成了"演到一半突然跳到结果"。
   *
   * 【为什么是 60ms 的小步轮询】平台队列没有"排空回调"，而 `busy()` 在**正在演的那一步内部**
   * 也是 true（running 还没复位），所以必须隔一会儿再看一眼。它只在"有一批账要收"的时候活着，
   * 收完就停，不是常驻定时器。
   */
  _scheduleReconcile() {
    if (this._reconcileTimer !== null) return;
    const tick = () => {
      this._reconcileTimer = null;
      if (animBusy()) {
        this._reconcileTimer = setTimeout(tick, 60);
        return;
      }
      this._reconcile();
    };
    this._reconcileTimer = setTimeout(tick, 60);
  }

  /**
   * 按**显示视图**把地图 / 顶部状态 / 行动面板重画一次。
   * 每演一步都会调它 —— 这就是"演到第几步，画面就是第几步"。
   *
   * ⚠️ 计时器**不在这里动**：演出期间它显示"演出中"，队列空了才由 `tickTimer()` 显示
   *    服务器给的真实剩余（见那里的注释）。
   * ⚠️ 没有任何 `getBoundingClientRect`：联机第一次渲染时这块 DOM 还没插进文档，
   *    量出来全是 0（地图那头只认 viewBox 用户坐标，见 js/ui/map.js）。
   */
  _paintBoard(view) {
    if (!view) return;
    this.board.render(view, this.selfId);
    this.els.phase.textContent = this._phaseText(view);
    this.els.phase.classList.toggle('hot', view.phase === PHASE.ACTION && view.current === this.selfId);
    this.els.round.textContent = `第 ${view.round} 回合`;
    this._renderPanel(view);
  }

  _name(pid) {
    const p = (this.view.players || []).find((x) => x.id === pid);
    return p ? p.name : '?';
  }

  /** 这个座位是电脑吗。`isAI` 只有**发给玩家的那一档**视图里才有（见 js/view.js 顶部），
   *  所以单机人机（本地裸 viewFor）永远是 false —— 单机牌桌不会出现电脑标记。 */
  _isAi(pid) {
    const p = (this.view.players || []).find((x) => x.id === pid);
    return !!(p && p.isAI);
  }

  _phaseText(view) {
    if (view.phase === PHASE.OVER) return '本局结束';
    if (view.phase === PHASE.RPS) return '猜拳';
    if (view.phase === PHASE.ORDER) {
      const m = view.mini;
      if (m && m.decider) return m.decider === this.selfId ? '你来定顺序' : `${this._name(m.decider)} 定顺序`;
      return '小猜拳';
    }
    if (view.phase === PHASE.ACTION) {
      return view.current === this.selfId ? `你的行动 · 剩 ${view.stepsLeft} 步` : `${this._name(view.current)} 行动中`;
    }
    return '';
  }

  /**
   * 视图里带的是「还剩多少毫秒」（服务器**发报文那一刻**算出来的），这里换算成本机的绝对时刻。
   *
   * 【死线只在收到权威帧时对齐 —— 队列排空之后**绝不**再"起算"一遍】
   * 一个很容易想到、但必须否掉的写法是："演出演完了，拿 `actionDeadlineIn` 从头数一遍"。
   * 那等于把演出的这几秒**加**回给玩家：服务器（和别的客户端）的钟一秒都没停，
   * 只是本机把数字往后推了 —— 屏幕上还剩 8 秒时，服务端那边其实已经到点，
   * 下一次催办（js/ui/online.js 的 scheduleTick 按 `pendingInMs()` 排的）发出去就对不上号。
   * 所以这里只做一件事：把服务器说的"还剩多少"记成"本机什么时候到点"，之后一秒都不加。
   * 演出那几秒由服务器每段限时多给的 `REPLAY_BUFFER_MS` 垫掉（见 constants.js）；
   * **显示**上则等队列排空（`tickTimer()` 的"演出中"分支），所以玩家看到的第一眼
   * 就是扣掉演出之后的真实剩余。
   */
  _syncDeadline(view) {
    let inMs = null;
    if (view.phase === PHASE.RPS && view.rps) inMs = view.rps.deadlineIn;
    else if (view.phase === PHASE.ORDER && view.mini) inMs = view.mini.deadlineIn;
    else if (view.phase === PHASE.ACTION) inMs = view.actionDeadlineIn;
    this._deadlineAt = inMs == null ? 0 : Date.now() + inMs;
  }

  /**
   * 当前阶段还剩多少毫秒（没阶段就是 null）；联机时 online.js 靠它决定什么时候催服务器。
   *
   * ⚠️ 这里读的是**权威视图**的阶段（不是显示视图）：演出还在演的时候，显示视图可能还停在
   *    上一步，而"要不要催服务器"必须看服务器现在到底在哪个阶段 —— 最后一手刚好把这一局
   *    打完时再发 tick，服务端只会回一条「现在不能操作」的提示条（见 online.js 的注释）。
   */
  pendingInMs() {
    const v = this.authView || this.view;
    if (!v || v.phase === PHASE.OVER || !this._deadlineAt) return null;
    return Math.max(0, this._deadlineAt - Date.now());
  }

  /**
   * 每 200ms 由外面调一次，只动那一个数字。
   *
   * 【演出期间不显示在跑的倒计时】演出还没演完时，这个数字在动、玩家却点不了
   * （动作入口被 `FrpAnim.busy()` 锁着）—— 那比不显示更让人困惑。所以队列没排空时
   * 一律显示"演出中"；**队列一空立刻显示服务器给的真实剩余**（`_syncDeadline` 换算出来的
   * `_deadlineAt`，⛔ 本机绝不自己加时间）。
   * 服务器那边每一段限时都已经多给了 `REPLAY_BUFFER_MS`（见 constants.js），
   * 演出这几秒本来就不算玩家的思考时间。
   */
  tickTimer(force) {
    const el = this.els.timer;
    if (animBusy()) {
      el.classList.remove('urgent');
      el.classList.add('busy');
      if (el.firstChild.textContent !== '演出中') el.firstChild.textContent = '演出中';
      return;
    }
    el.classList.remove('busy');
    const left = this._deadlineAt - Date.now();
    const v = this.authView || this.view;
    if (!this._deadlineAt || !v || v.phase === PHASE.OVER || left <= -1000) {
      el.classList.add('idle');
      el.classList.remove('urgent');
      el.firstChild.textContent = '—';
      return;
    }
    const sec = Math.max(0, Math.ceil(left / 1000));
    el.classList.remove('idle');
    el.classList.toggle('urgent', left <= 3000);
    if (el.firstChild.textContent !== String(sec)) {
      el.firstChild.textContent = String(sec);
      if (force !== true && left <= 3000 && sec > 0) this.audio.play('tick');
    }
  }

  /**
   * 把播报条钉在**最新一条**上。
   *
   * 【为什么要单独一个方法】直接写 `scrollTop = scrollHeight` 在两种时刻会**无声失效**：
   *   ① 根元素还没插进文档（联机第一次渲染就是这样：`renderGame` 跑的时候容器还没进
   *      文档，见 AGENTS.md 第 4 条）—— 没有布局盒，写进去等于没写；
   *   ② 刚被"拔出来又插回去"（房间外壳每帧都清面板重画）—— 那一刻滚动位置被浏览器清零，
   *      而这期间并没有新播报要追加，`_renderLog` 会**直接 return**，于是记录就停在
   *      最旧的那一条上，直到下一步演出才滚回最新（用户实机报的"来回跳转"）。
   * 所以：能写就写，写不了（不在文档里）就排一帧回调，等外壳把它挂上去之后再钉。
   */
  _pinLog() {
    const el = this.els.log;
    if (!el) return;
    const pin = () => { el.scrollTop = el.scrollHeight; };
    pin();
    if (!el.isConnected) requestAnimationFrame(pin);
  }

  /**
   * 播报条：**按步出现**。
   *
   * @param {object} view 显示视图（它的 `log` 是这一帧权威视图里的那一段）
   * @param {number} [upTo] 只显示编号 ≤ 它的那些条（演出每走到一步，事件会带上来
   *        `ev.logUpTo` = "这一刻已经写好到哪一条播报"）。不传 = 全显示
   *        （首次挂载 / 对账时用：那些播报本来就"已经发生过了"）。
   *
   * ⚠️ 游标 `lastLogId` 只推进到**真正显示出来的最后一条**（不是这一帧的最后一条）——
   *    推错了的话，后面几步的播报会被当成"旧的"而永远不显示。
   */
  _renderLog(view, upTo = Infinity) {
    const all = view.log || [];
    if (!all.length) return;
    // 编号变小 = 换了一局（重新开局会让编号从头开始），旧游标必须清掉，
    // 否则新一局的播报会被当成"旧的"而一条都不显示。
    if (all[all.length - 1].id < this.lastLogId) {
      this.lastLogId = 0;
      this.els.log.replaceChildren();
    }
    const lines = all.filter((l) => l.id > this.lastLogId && l.id <= upTo);
    if (!lines.length) return;
    this.lastLogId = lines[lines.length - 1].id;
    for (const l of lines) this.els.log.append(h('div', { class: 'log-line', text: l.text }));
    while (this.els.log.children.length > 40) this.els.log.firstChild.remove();
    this._pinLog();
  }

  /** 清空播报/游标（重新开局用：事件编号会从头开始，留着旧游标会把新事件全当成旧的） */
  reset() {
    this.lastEventId = 0;
    this.lastLogId = 0;
    this._appliedId = 0;
    this.authView = null;
    if (this._reconcileTimer !== null) {
      clearTimeout(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    this.orderDraft = null;
    this.orderKey = '';
    this._orderSel = null;
    this.els.log.replaceChildren();
    this.fx.clear();
  }

  /* ============================== 逐步演出 ============================== */

  /**
   * 把这一帧的新事件排进平台的串行演出队列。
   *
   * 服务端一次推来几十条是常态：它必须把 AI 的整轮同步跑完（否则全桌会停在"等待对手行动"，
   * 见 server/games/blade-steed.mjs 的文件头）。`FrpAnim.push` 是**串行**的：我们这一条演完
   * （并返回它该占多少毫秒）才轮到下一条。它**不做快进、也没有"点击跳过"**（用户明确不要），
   * 唯一的例外是积压超过 24 条的技术性兜底（防一条坏报文把界面钉死）。
   *
   * ⚠️ 队列没排空时**所有动作入口都是锁住的**（`_blocked()` + body.frp-anim-busy 的 CSS）：
   *    服务端那一帧早就把回合推进过了，画面还在演的时候接着点，看到的画面和实际局面就会错位
   *    （用户第 2 条反馈，见 docs/DECISIONS.md D10）。
   */
  _queueSteps(steps) {
    if (!steps.length) return;
    const anim = window.FrpAnim;
    if (!anim || typeof anim.push !== 'function') {
      // 平台脚本没加载（缓存里只有旧版页面之类）：至少别把事件丢掉
      for (const ev of steps) this._playStep(ev);
      this.tickTimer(true);
      return;
    }
    anim.push(steps, (ev) => this._playStep(ev));
    /*
     * ⚠️ 排完队**立刻**把计时器重画一次，别等 200ms 的那次轮询（app.js 里的 setInterval）。
     * 不这么做的话：render() 先按权威时限写出数字、同一次任务里才把演出排进队列，
     * 于是这批演出刚开演的头 0~200ms 里，屏幕上还挂着那个数字（而这个数字正在被
     * "演出期间锁输入"挡着的玩家盯着）—— 用户报的"动画还没播完就开始倒计时"里
     * 最刺眼的那一下就是它。现在排队 → 立刻重画 → 显示"演出中"。
     */
    this.tickTimer(true);
  }

  /**
   * 演一步：**贴补丁 → 重画整块牌桌 → 播报走到这一步 → 演特效与音效**，返回这一步占多少毫秒。
   *
   * 顺序是有讲究的：先贴补丁再重画，特效才知道"这一步之后大家站在哪"；
   * 播报用这一步的 `logUpTo` 卡住，所以文字和数字是同一个节奏。
   */
  _playStep(ev) {
    if (!this.view) return 0;
    if (this._applyStepPatch(ev)) this._appliedId = ev.id;
    this._paintBoard(this.view);
    this._renderLog(this.view, ev.logUpTo);
    // 服务器推来的每一步都照旧演出来 —— 包括我自己那一手（不做本地预演，所以不会重复）
    this._playOne(ev);
    return stepMs(ev);
  }

  /**
   * 把"这一步之后的公开状态补丁"贴到**显示视图**上。返回 true = 真贴上去了。
   *
   * 【为什么必须"链子接得上"才贴】补丁是**差量**（只记相对上一条事件变了的字段），
   * 所以只有当显示视图正好停在上一条（`this._appliedId` 就是上一条的编号）时它才是完整的信息。
   * 接不上有三种正常情况：事件窗口滑走了（老条目被裁掉）、这是换局/重连后的第一帧、
   * 服务端还没带补丁。那种时候**只演特效、数字不动**，最后由队列排空后的对账收口 ——
   * 半路硬贴只会把画面拼成一个谁也没见过的状态（比如血停在 5、装备却已经是新的）。
   *
   * ⚠️ 一条贴不上，后面几条也就都别贴了（它们同样是"相对上一条"的差量）：
   *    `_appliedId` 不推进，后面每一条都对不上号，自动全跳过 —— 这正是"缺一条就交给对账"。
   */
  _applyStepPatch(ev) {
    if (!ev || !ev.s || !this.view) return false;
    if (ev.id !== this._appliedId + 1) return false;
    this._applyPatch(this.view, ev.s);
    return true;
  }

  /**
   * 把一个补丁盖到**显示视图**上（只改补丁里提到的字段）。
   *
   * ⚠️ 绝不许拿它去改权威视图：D10 的铁律是"**绝不在本地改权威状态**"。
   *    显示视图是权威视图的一份深拷贝（`_copyView`），改坏了下一帧对账就修回来。
   * ⚠️ 贴的是**服务器算好的数字**，不是界面照事件自己推的 —— 规则只有一份（在引擎里），
   *    在界面里重算一遍就是违反铁律三。
   */
  _applyPatch(target, s) {
    for (const k of ['phase', 'round', 'current', 'stepsLeft', 'winner']) {
      if (k in s) target[k] = s[k];
    }
    // 这几个是"整份替换"（引擎给的就是完整值，不是差量）
    if (Array.isArray(s.mainWinners)) target.mainWinners = s.mainWinners.slice();
    if (s.steps) target.steps = { ...s.steps };
    if (Array.isArray(s.queue)) target.queue = s.queue.slice();
    if (Array.isArray(s.players)) {
      // 补丁里的 players 是"变了的那几个人"，按 id 合进显示视图
      for (const changed of s.players) {
        const cur = (target.players || []).find((p) => p.id === changed.id);
        // 找不到 = 中途有人进来（allowMidJoin）：这一步先不画他，
        // 等队列空了用权威视图对账时他的头像就会出来（一两秒的事，不值得为它做特例）
        if (cur) Object.assign(cur, changed);
      }
    }
    // rps / mini 是"这个猜拳窗口的完整公开状态"，所以是**覆盖** ready 这类整张表；
    // 用合并是为了保住 deadlineIn（补丁里不带它，它由 render 时的权威视图负责）
    if (s.rps) target.rps = target.rps ? { ...target.rps, ...s.rps } : { ...s.rps };
    if (s.mini) target.mini = target.mini ? { ...target.mini, ...s.mini } : { ...s.mini };
  }

  _playOne(ev) {
    const nameOf = (pid) => this._name(pid);
    const me = this.selfId;

    switch (ev.t) {
      case 'rps-reveal': {
        this.audio.play('reveal');
        if (!ev.winners || !ev.winners.length) this.fx.banner('无人获胜，重新猜拳');
        else if (ev.winners.length === 1) this.fx.banner(`${nameOf(ev.winners[0])} 获胜 · 2 步行动`);
        else this.fx.banner(`${ev.winners.map(nameOf).join('、')} 获胜 · 各 1 步`);
        break;
      }
      case 'mini-reveal': {
        this.audio.play('reveal');
        if (ev.winners && ev.winners.length === 1) this.fx.banner(`${nameOf(ev.winners[0])} 赢得小猜拳`);
        else this.fx.banner('小猜拳平局，再来一次');
        break;
      }
      case 'order-decider':
        this.fx.banner(`${nameOf(ev.decider)} 来决定行动顺序`);
        break;
      case 'order':
        this.fx.banner(`行动顺序：${ev.order.map(nameOf).join(' → ')}`);
        break;
      case 'turn':
        if (ev.pid !== me) this.audio.play('turn');
        break;
      case 'buy':
        this.audio.play('buy');
        this.fx.pop(this.board.posOf(ev.pid), ev.item === 'knife' ? '＋刀' : '＋马');
        break;
      case 'move':
        // 出城 / 进城：只有位置变了（地图那头靠 CSS 补间"走"过去），这里补一个提示字
        this.audio.play('click');
        this.fx.pop(this.board.posOf(ev.pid), ev.to === WILD ? '出城' : '进城');
        break;
      case 'knife': {
        this.audio.play('slash');
        const p = this.board.prevPosOf(ev.target);
        this.fx.slash(p);
        this.fx.damage(p, '-1');
        this.board.shake(ev.target);
        setTimeout(() => this.audio.play('hurt'), 90);
        break;
      }
      case 'kick': {
        this.audio.play('kick');
        const p = this.board.prevPosOf(ev.target);
        this.fx.kick(this.board.posOf(ev.pid), p);
        this.fx.damage(p, '-3');
        this.board.shake(ev.target);
        setTimeout(() => this.audio.play('hurt'), 110);
        break;
      }
      case 'down':
        this.audio.play('down');
        this.fx.banner(`${nameOf(ev.pid)} 出局！`);
        break;
      case 'pass':
        // 结束行动：一个轻轻的收尾音，别用重音效 —— 一轮里它可能出现好几次
        this.audio.play('click');
        break;
      case 'rps-pick':
        /*
         * 「我出拳了」那一声（原项目是点按钮时立刻 `play('pick')`，见原 `js/ui/app.js`
         * 第 720~723 行）。用户要求删掉本地预演之后，那一声跟着没了 —— 而这一步在回放里
         * 本来**不播声**，于是出拳变成全程静音（是 captain 收口时发现的，不是漏看）。
         *
         * 现在按"**音效跟着权威确认走**"补回来：服务器收下我的拳、回放走到 `rps-pick`
         * 这一步时才响（比原来晚一个来回，但绝不会出现"演了却没生效"）。
         * ⚠️ **只响我自己那一票**：别人的拳（含人机的）本来就不该让我听见，
         *    而且一轮里所有人都出拳，全响就是四声连击。
         */
        if (ev.pid === me) this.audio.play('pick');
        break;
      case 'over':
        this.audio.play(ev.winner === me ? 'win' : 'lose');
        this.fx.banner(ev.winner ? `${nameOf(ev.winner)} 是本局赢家！` : '本局无人存活', 2200);
        break;
      default:
        break;
    }
  }

  /* ============================== 演出期间锁输入 ============================== */

  /**
   * 现在能不能提交操作？**演出队列没排空就不能**（`FrpAnim.busy()` 为真 → 返回 true）。
   *
   * 为什么必须锁（用户第 2 条反馈 / docs/DECISIONS.md D10）：
   *   服务端是**同步**把 AI 整轮跑完再推回来的（见 server/games/blade-steed.mjs），
   *   所以"演出还在放"的时候，报文里的回合其实早就推进过了 ——
   *   这时候玩家还能接着点，就会出现"我一边看动画、局面一边往前走"的错位；
   *   再叠上连点，画面看起来就是"所有人被打死了"。
   *   用户的取舍：**宁可等演出演完再操作**（"卡一点就卡一点没事的"）。
   *
   * ⚠️ 这道口子是**本游戏自己的提交口子**（平台在 `ctx.act()` 里也兜了一层 busy，
   *    但本游戏走的是 `GameNet.send`，见 js/ui/online.js）—— 不能只靠平台那层。
   * ⚠️ 平台脚本没加载（`window.FrpAnim` 不在）时**不锁**：那种情况下也没有演出队列，
   *    锁住等于把游戏锁死。
   * ⚠️ 只锁**会发消息的动作**（出拳 / 排顺序 / 花一步行动）；对局菜单、房间壳上的
   *    开始 / 离开 / 邀请 / 加人机一概不经过这里。
   */
  _blocked() {
    return animBusy();
  }

  /* ============================== 行动面板 ============================== */

  _renderPanel(view) {
    const panel = this.els.panel;
    panel.replaceChildren();

    if (view.phase === PHASE.OVER) panel.append(this._panelOver(view));
    else if (view.phase === PHASE.RPS) panel.append(this._panelRps(view, view.rps));
    else if (view.phase === PHASE.ORDER) panel.append(this._panelOrder(view));
    else if (view.phase === PHASE.ACTION) panel.append(this._panelAction(view));
  }

  _me(view) {
    return (view.players || []).find((p) => p.id === this.selfId) || null;
  }

  _readyRow(view, ready, ids) {
    const row = h('div', { class: 'ready-row' });
    for (const id of ids) {
      // 名字本身可能和某个真人重名（人机的名字来自单字池），所以身份靠 is-ai 虚线边 + data-pid：
      // 前者给玩家看，后者给"服务端回放我出拳时把这一格点亮"用（ready 字段来自视图）。
      const cls = `ready-chip${ready[id] ? ' on' : ''}${this._isAi(id) ? ' is-ai' : ''}`;
      row.append(
        h('span', {
          class: cls,
          'data-pid': id,
          text: `${this._name(id)}${ready[id] ? ' 已出' : ' …'}`,
        })
      );
    }
    return row;
  }

  /** 猜拳 / 小猜拳的按钮面板 */
  _panelRps(view, pool) {
    const box = h('div', { class: 'action-panel' });
    const me = this._me(view);
    const ids = pool.candidates ? pool.candidates : view.players.filter((p) => p.alive).map((p) => p.id);

    if (me && me.alive && (!pool.candidates || pool.candidates.includes(this.selfId))) {
      const row = h('div', { class: 'rps-row' });
      for (const c of view.rpsChoices || ['rock', 'scissors', 'paper']) {
        const btn = h('button', {
          class: `rps-btn${pool.myChoice === c ? ' is-picked' : ''}`,
          type: 'button',
          'data-rps': c,
          disabled: pool.myChoice ? true : null,
        }, [h('span', { class: 'emoji', text: RPS_EMOJI[c] }), h('span', { text: RPS_LABEL[c] })]);
        btn.addEventListener('click', () => {
          // 演出没排空 → 当成没点（不发消息、不出音效、不改界面，见 _blocked）
          if (this._blocked()) return;
          // ⚠️ 这里**不再**立刻播「出拳」音：点下去到服务器回包之间本机不播任何音效
          //    （用户第 1 条要求）。出拳这一步的表现由服务端回放的 rps-pick 那一步负责。
          this.onAct({ kind: 'rps', choice: c });
        });
        row.append(btn);
      }
      box.append(
        h('div', {
          class: 'panel-title',
          text: pool.myChoice ? `你出了【${RPS_LABEL[pool.myChoice]}】，等其他人…` : '出拳！',
        }),
        row
      );
    } else {
      box.append(
        h('div', {
          class: 'panel-title',
          text: me && !me.alive ? '你已出局，可以继续看完这一局' : '等其他人出拳…',
        })
      );
    }
    box.append(this._readyRow(view, pool.ready || {}, ids));
    return box;
  }

  /** 决胜者排顺序（点两个人交换位置） */
  _panelOrder(view) {
    const box = h('div', { class: 'action-panel' });
    const m = view.mini;
    const aliveWinners = view.mainWinners.filter((id) => view.players.find((p) => p.id === id)?.alive);

    if (!m || m.decider !== this.selfId) {
      if (m && m.candidates && m.candidates.includes(this.selfId) && !m.decider) {
        return this._panelRps(view, m);
      }
      box.append(
        h('div', {
          class: 'waiting',
          text: m && m.decider
            ? `等 ${this._name(m.decider)} 决定 ${aliveWinners.length} 人的行动顺序…`
            : '等小猜拳结果…',
        })
      );
      return box;
    }

    const key = `${view.round}:${m.round}:${aliveWinners.join(',')}`;
    if (this.orderKey !== key || !this.orderDraft || this.orderDraft.length !== aliveWinners.length) {
      this.orderKey = key;
      this.orderDraft = aliveWinners.slice();
      this._orderSel = null;
    }
    box.append(h('div', { class: 'panel-title', text: '点两个人交换位置，第一位最先行动' }));

    const list = h('div', { class: 'order-list' });
    this.orderDraft.forEach((pid, idx) => {
      const item = h('div', { class: `order-item${this._orderSel === idx ? ' is-sel' : ''}` }, [
        h('span', { class: 'idx', text: String(idx + 1) }),
        h('span', { text: `${this._name(pid)}${pid === this.selfId ? '（你）' : ''}` }),
        h('span', { class: 'swaphint', text: this._orderSel === idx ? '再点一个交换' : '点击选择' }),
      ]);
      item.addEventListener('click', () => {
        // 交换顺序只是**本地的草稿编辑**（不发任何消息），所以它不算"提交"；
        // 但演出期间照样锁住：面板里的草稿等演出演完再改，免得和回放打架。
        if (this._blocked()) return;
        this.audio.play('click');
        if (this._orderSel == null || this._orderSel === idx) {
          this._orderSel = this._orderSel === idx ? null : idx;
        } else {
          const a = this._orderSel;
          [this.orderDraft[a], this.orderDraft[idx]] = [this.orderDraft[idx], this.orderDraft[a]];
          this._orderSel = null;
        }
        this._renderPanel(view);
      });
      list.append(item);
    });
    box.append(list);

    const order = this.orderDraft.slice();
    box.append(
      h('button', {
        class: 'act-btn hot wide',
        type: 'button',
        text: '✅ 就按这个顺序',
        onclick: () => {
          if (this._blocked()) return;   // 演出期间当成没点（"就按这个顺序"会真的发消息）
          this._orderSel = null;
          this.onAct({ kind: 'order', order });
        },
      })
    );
    return box;
  }

  /** 行动按钮：**全部来自 legalActionsFrom**（和引擎校验同一份实现） */
  _panelAction(view) {
    const box = h('div', { class: 'action-panel' });
    const me = this._me(view);

    if (view.current !== this.selfId) {
      box.append(
        h('div', {
          class: 'waiting',
          text: `等 ${this._name(view.current)} 行动中…（还剩 ${view.stepsLeft} 步）`,
        })
      );
      return box;
    }

    const acts = legalActionsFrom(view, this.selfId);
    if (!acts.length) {
      box.append(h('div', { class: 'waiting', text: '没有可做的操作' }));
      return box;
    }

    box.append(h('div', { class: 'panel-title', text: `轮到你行动，还剩 ${view.stepsLeft} 步 · 每步只能做一件事` }));

    const grid = h('div', { class: 'act-grid' });
    for (const a of acts) {
      const [title, sub] = this._actionLabel(a);
      const cls =
        a.type === ACT.PASS
          ? 'act-btn wide'
          : a.type === ACT.KICK || a.type === ACT.KNIFE
            ? 'act-btn danger'
            : a.type === ACT.BUY_KNIFE || a.type === ACT.BUY_HORSE
              ? 'act-btn hot'
              : 'act-btn';
      const btn = h('button', { class: cls, type: 'button' }, [
        h('span', { text: title }),
        sub ? h('span', { class: 'sub', text: sub }) : null,
      ]);
      btn.addEventListener('click', () => {
        // 演出没排空 → 当成没点（不发消息、不出音效、不改界面，见 _blocked）。
        // ⚠️ 这里也**不再**立刻播点击音：点下去到服务器回包之间本机不播任何音效
        //    （用户第 1 条要求）。这一手的声音由服务端回放的 buy/move/knife/kick/pass
        //    那一步负责（见 _playOne）。
        if (this._blocked()) return;
        this.onAct({ kind: 'act', type: a.type, target: a.target });
      });
      grid.append(btn);
    }
    box.append(grid);
    if (me && acts.some((a) => a.type === ACT.PASS)) {
      box.append(h('div', { class: 'panel-title', text: '「结束行动」会放弃剩下的步数' }));
    }
    return box;
  }

  _actionLabel(a) {
    const n = (pid) => this._name(pid);
    switch (a.type) {
      case ACT.BUY_KNIFE:
        return ['🔪 买刀', '解锁【刀】· 永久'];
      case ACT.BUY_HORSE:
        return ['🐴 买马', '解锁【踹】· 永久'];
      case ACT.MOVE_OUT:
        return ['🚶 出城', '去野外'];
      case ACT.MOVE_IN:
        return [`🏯 进 ${n(a.target)}的城`, ''];
      case ACT.KNIFE:
        return [`🔪 刀 ${n(a.target)}`, '-1 血'];
      case ACT.KICK:
        return [`🦶 踹 ${n(a.target)}`, '-3 血 + 踢出城'];
      case ACT.PASS:
        return ['✋ 结束行动', ''];
      default:
        return [a.type, ''];
    }
  }

  _panelOver(view) {
    const box = h('div', { class: 'action-panel' });
    const win = view.winner;
    box.append(
      h('div', {
        class: 'waiting',
        text: win
          ? `🏆 ${this._name(win)} 是本局赢家${win === this.selfId ? '（就是你！）' : ''}`
          : '本局无人存活',
      })
    );
    if (this.onHome) {
      box.append(
        h('button', {
          class: 'act-btn wide',
          type: 'button',
          text: '🏠 回到首页',
          onclick: () => {
            this.audio.play('click');
            this.onHome();
          },
        })
      );
    }
    return box;
  }
}