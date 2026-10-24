/**
 * Shell Gambit — 牌桌渲染（单机与联机**共用同一份**）
 *
 * 【为什么必须共用】
 * GAME-SPEC 铁律二：界面只读裁剪过的 view，而且单机与联机走同一套渲染代码。
 * 这里只认 view 这一个入参 —— 单机时调用方传的是 `match.viewFor(me.id)`，
 * 联机时传的是服务器 room.state 里的 view。两者结构完全一样，
 * 所以"单机能看对手手牌、联机看不到"这类漏洞在这个结构下不可能出现。
 *
 * 【这一版的核心：**逐步同步**（演到第几步，画面就是第几步）】
 * 以前 `render(nextView)` 一收到状态就立刻把整块牌桌按**最终**状态画出来，只有"播报 + 特效"
 * 排进队列 —— 于是演出还要演 2.7 秒，画面早就是结算后的样子（用户报的就是这个）。
 * 现在牌桌手里有**两份**视图：
 *   · `authView` 权威视图（服务器最新那一份，只在对账时用）
 *   · `view`     显示视图（画面此刻照着画的那一份 = 权威视图 + 已经演到的那些补丁）
 * 每一步把该条日志的补丁（`entry.s`，引擎给的"这一步之后的公开状态"）贴到显示视图上、
 * 重画整块牌桌，再演特效与音效；整批演完、**队列真的空了**之后用权威视图对账一次。
 * 枪响到谁谁才掉血，弹药数 / 手牌 / 轮到谁 / 回合数 / 锯子 / 胜负全部跟着演出走。
 *
 * 【它不碰网络、不碰引擎】
 * 玩家操作一律通过 onAct 回调交出去；联机时上层接的是
 * `FrpRoom` 给的 ctx.act（最终变成 room.act 报文），单机时接的是本地 match.submit。
 *
 * ⚠️ 本文件是 ES Module（不是经典全局脚本），所以不写 window.ShellBoard 这类命名空间；
 *    GAME-SPEC 第 9 节的"命名空间"要求是针对**经典脚本**的。
 */

import { ITEM_INFO, MAX_HP } from '../engine/constants.js';
import { colorIndex, icon } from './icons.js';
import { sfx } from './audio.js';
import {
  banner,
  damageNumber,
  hideModal,
  isFxEnabled,
  muzzleFlash,
  setFxEnabled,
  shakeApp,
  showModal,
} from './effects.js';

/** 渲染 HTML 前先转义：名字来自账号（可能被别人取成 `<img>` 之类），不能当标记插进去 */
const escapeHtml = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const shellName = (s) => (s === 'live' ? '实弹' : '空弹');

/**
 * 平台那边的经典全局脚本（`/shared/ui/anim.js` 与 `/shared/ui/react.js`）。
 * 取的时候判空：脚本没加载完就调会 "cannot read of undefined"，
 * 而这两样都只是"锦上添花"，缺了也不该把整张牌桌弄崩。
 */
const FrpAnim = () => globalThis.FrpAnim;
const FrpReact = () => globalThis.FrpReact;

/**
 * 演出队列还没排空吗？—— **这是本作唯一的"输入锁"判据**
 * （`docs/DECISIONS.md` D10、`docs/GAME-SPEC.md` 第 4 节「演出期间锁输入」）。
 *
 * 【为什么要锁】服务端是权威：一次 `room.act` 里它会把 AI 的整个回合同步跑完
 * （见 `server/games/shell-gambit.mjs` 的 `runAi`），所以**回包那一帧的回合已经推进过了**，
 * 而画面上那几步还要 450–700ms 一步一步演完。这段时间里玩家看见的是"上一步"，
 * 手里的操作权却已经是"下一步"——不锁的结果就是用户报的那句
 * "还没演完操作权就又回到用户层了，用户层几乎可以一直持续操作"。
 * 代价是每次演出都要等它演完才能点，用户明确接受（"卡一点就卡一点没事的"）。
 *
 * 【判空的姿势】平台脚本是 defer 加载的，正常这时一定在；仍然判空 ——
 * 拿不到 `FrpAnim` 时只能放行（不然整张牌桌会永远点不动）。
 *
 * 【CSS 那一半】演出期间平台会给 `<body>` 挂 `frp-anim-busy`，
 * 由 `css/style.css` 把动作控件变灰并 `pointer-events: none`（见那里的第 7 节）。
 * 导出它，是为了让 `app.js`（真正发消息的那个人）判同一件事，不抄第二份实现。
 */
export function animBusy() {
  const anim = FrpAnim();
  return !!(anim && typeof anim.busy === 'function' && anim.busy());
}

/**
 * 把本作的"音效 / 特效"开关**转告平台层**。
 *
 * 【为什么必须转告】点头像扔鸡蛋/鲜花是平台实现的（`shared/ui/react.js`），
 * 逐条演出是平台实现的（`shared/ui/anim.js`），它们各有自己的开关变量。
 * 游戏不调这几个 setter，玩家关掉「音效」之后**扔鸡蛋照样响** ——
 * 界面上的开关就成了摆设。
 *
 * 调它的地方有三处：页面初始化（本地存的开关状态要立刻同步，见 app.js 的
 * refreshToggleLabels）、首页那两个开关、以及对局内菜单里那两个（本文件）。
 * 导出它，是为了让 app.js 不用抄一份一模一样的。
 */
export function syncPlatformToggles() {
  const react = FrpReact();
  const anim = FrpAnim();
  // 平台脚本是 defer 加载的，正常这时一定在；仍然判空 —— 少一个开关不该让整页崩。
  if (react) {
    react.setSound(sfx.enabled);
    react.setFx(isFxEnabled());
  }
  if (anim) anim.setEnabled(isFxEnabled());
}

/**
 * 把牌桌挂到一个容器上。
 *
 * @param {object} opts
 * @param {HTMLElement} opts.host        容器（会被清空并接管）
 * @param {(action:object) => boolean} opts.onAct 玩家点了一个操作，交出去
 *        （返回 true = 真的发出去了；牌桌**不**再拿这个返回值做任何演出，
 *          本地预演已经删掉 —— 见 doAction 与 docs/DECISIONS.md D10）
 * @param {(reason:string) => void} [opts.onInfo] 给上层的提示（不会打断操作）
 * @param {() => void} [opts.onLeave]    要离开对局时回调（单机=回首页；联机=FrpRoom 负责）
 * @returns {{ render(view):void, dispose():void, refreshSettings():void }}
 */
export function mountBoard({ host, onAct, onInfo, onLeave }) {
  /**
   * **显示视图**：画面此刻照着画的那一份。
   * 它是"权威视图 + 已经演到的那些补丁"，**永远是自己的一个拷贝**（权威对象一个字节都不许改，
   * 它是服务器说了算的东西，改了就等于本地改权威状态 —— D10 的铁律）。
   */
  let view = null;
  /**
   * **权威视图**：服务器最新推来的那一份，只在对账时用一次。
   * 为什么要留两份：演出是异步的，一条补丁只描述"这一步之后"，
   * 而服务器可能已经推了更新的帧；演到一半就拿最新的帧重画 = 用户看到
   * "演到一半突然跳到结果"，所以对账必须等到这一批演完（见 reconcile）。
   */
  let authView = null;
  let myId = null;
  /** 需要二次选目标的道具（肾上腺素偷到手铐 / 手铐 / 肾上腺素） */
  let targetingItem = null;
  let lastEventN = 0;
  /**
   * 这张牌桌已经被卸掉了（`dispose()` 置位）。
   * 逐条演出是**异步**的，一步可能排在 700ms 之后 —— 那时候玩家可能已经离开对局
   * 或者开了新的一局，宿主 DOM 早就被清空了。所有异步的演出都要先看这个旗子。
   */
  let disposed = false;
  let overShown = false;
  /** 对账的定时器（"队列什么时候真的空"只有平台队列自己知道，见 scheduleReconcile） */
  let reconcileTimer = null;
  const seatEls = new Map();

  host.innerHTML = `
    <header class="hud">
      <div class="hud-left"><span class="hud-round">第 <b class="js-round">1</b> 轮</span></div>
      <div class="hud-mag">
        <span class="chip chip-live"><i></i>实弹 <b class="js-live">0</b></span>
        <span class="chip chip-blank"><i></i>空弹 <b class="js-blank">0</b></span>
        <span class="chip chip-saw js-saw" hidden>已锯枪管 ×2</span>
      </div>
      <div class="hud-right">
        <button class="icon-btn tiny js-menu" type="button" aria-label="菜单" title="菜单">☰</button>
      </div>
    </header>
    <div class="table">
      <div class="seats js-seats"></div>
      <div class="feed-box js-feed-box">
        <button class="feed-toggle js-feed-toggle" type="button" aria-expanded="false">
          <span>对局记录</span><i class="feed-chevron"></i>
        </button>
        <div class="feed js-feed" aria-live="polite"></div>
      </div>
      <!-- ⚠️ id="banner" 是 effects.js 的 banner() 认的那个 id。
           少了它，演出里的"砰！实弹命中""第 2 轮""使用 手锯"这些横幅
           **全部静默丢弃**（banner() 找不到元素就直接 return），
           而逐条演出看起来就像什么都没发生 —— 这是搬迁时漏掉的一处。 -->
      <div class="banner js-banner" id="banner"></div>
    </div>
    <footer class="controls">
      <div class="hand js-hand"></div>
      <div class="actions js-actions"></div>
      <div class="turn-hint js-turn-hint"></div>
    </footer>`;

  const $ = (sel) => host.querySelector(sel);
  const seatsBox = $('.js-seats');
  const feedBox = $('.js-feed');
  const actionsBox = $('.js-actions');
  const handBox = $('.js-hand');
  const hintBox = $('.js-turn-hint');

  /* ------------------------------ 对局记录 ------------------------------ */

  // 展开状态记本地，玩家展开过就一直保持展开（原项目的既有约定）
  const feedOpenKey = 'sg.feedOpen';
  setFeedOpen(host.dataset.feedOpen === 'on');

  function setFeedOpen(open) {
    host.querySelector('.js-feed-box').classList.toggle('is-open', !!open);
    host.querySelector('.js-feed-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) feedBox.scrollTop = feedBox.scrollHeight;
  }

  $('.js-feed-toggle').addEventListener('click', () => {
    const open = !$('.js-feed-box').classList.contains('is-open');
    setFeedOpen(open);
    try { localStorage.setItem(feedOpenKey, open ? 'on' : 'off'); } catch { /* 隐私模式下会抛 */ }
  });

  function feedAdd(text, cls) {
    const box = $('.js-feed-box');
    // 牌桌已经被卸掉（dispose 清空了宿主）时不许再往里写 —— 见 playStep 的说明
    if (!box || !feedBox.isConnected) return;
    const el = document.createElement('div');
    el.className = `feed-item${cls ? ` ${cls}` : ''}`;
    el.textContent = text;
    feedBox.appendChild(el);
    while (feedBox.children.length > 60) feedBox.firstElementChild.remove();
    if (box.classList.contains('is-open')) feedBox.scrollTop = feedBox.scrollHeight;
  }

  /* ------------------------------ 菜单（音效 / 特效 / 离开） ------------------------------ */

  function refreshSettings() {
    /* 供上层在对局外改过开关之后同步按钮文案（目前没有入口，留着备用） */
  }

  $('.js-menu').addEventListener('click', () => {
    sfx.ensure();
    showModal({
      title: '菜单',
      body: '<p>音效与特效只影响你自己的设备，不影响对局。</p>',
      actions: [
        { label: '继续游戏', primary: true, onClick: () => {} },
        {
          label: `🔊 音效：${sfx.enabled ? '开' : '关'}`,
          onClick: () => {
            sfx.setEnabled(!sfx.enabled);
            syncPlatformToggles();
            if (onInfo) onInfo(`音效已${sfx.enabled ? '开启' : '关闭'}`);
          },
        },
        {
          label: `✨ 特效：${isFxEnabled() ? '开' : '关'}`,
          onClick: () => {
            setFxEnabled(!isFxEnabled());
            syncPlatformToggles();
            if (onInfo) onInfo(`特效已${isFxEnabled() ? '开启' : '关闭'}`);
          },
        },
        { label: '离开对局', onClick: () => onLeave && onLeave() },
      ],
    });
  });

  /* ------------------------------ 渲染 ------------------------------ */

  /**
   * 服务器推来一份新视图。
   *
   * 【为什么**不**在这里立刻画出来（这一版改的就是它）】
   * 老写法是 `view = nextView` 之后把整块牌桌按**最终**状态画一遍，只有"播报 + 特效"
   * 排进演出队列。于是演出还在一步一步演（一次回包实测 2.7 秒、分 5 次长起来），
   * 画面早就是结算后的样子了 —— 用户报的"动画还没播放完，对方的血量就已经是结算状态、
   * 血量等参数与动画不同步"就是这个。
   *
   * 现在把这条报文里的**新日志**按 n 升序交给串行队列，每一步都把"这一步之后的公开状态
   * 补丁"（`entry.s`，引擎给的）贴到**显示视图**上再重画整块牌桌 —— 演到第几步，
   * 画面就是第几步：枪响到谁谁才掉血，弹药数 / 手牌 / 轮到谁 / 回合数 / 锯子 / 胜负
   * 全都跟着演出走。整批演完、队列真的空了之后，再用**权威视图**整体对账一次
   * （兜住任何补丁没覆盖到的字段）。
   *
   * ⚠️ 对账**不许插队**：队列还在演的时候来了新视图，只把它记成新的权威视图、
   *    把新事件接着排到队尾，绝不在半路拿它重画（那正是"演到一半突然跳到结果"）。
   */
  function render(nextView) {
    if (!nextView) return;
    authView = nextView;
    if (authView.me && authView.me.id) myId = authView.me.id;

    const { fresh, reset } = takeFreshEvents(authView);

    /*
     * 第一帧（刚挂上牌桌）与**序号回退**（换了一局 / 中途刷新重进这一局 / 重连）：
     * 默认**一条旧条目都不回放**，直接把权威视图画出来，游标已经在 takeFreshEvents 里
     * 对齐到"窗口最后一条的 n"（= 相当于"这些你已经看过了"）。
     *
     * 【为什么默认必须这样，不能"照旧排队演一遍"】
     * 补丁是**差量**："这一步之后的公开状态"只记相对**上一条**事件变了的字段。
     * 而这两种情况下客户端手里**往往**没有那条基线：
     *   · 打了一半才挂上牌桌时，第一份视图是**当前**（已经打到一半）的状态，
     *     而日志窗口里还挂着几十条旧条目，游标却从 0 开始；
     *   · "再来一局"之后 `seq` 从 0 重来，旧游标比新序号还大。
     * 把那些旧条目的补丁叠在**最终状态**上，算出来的血量点 / 弹药数就是**错的数**
     * （补丁只说"谁变了"，不说"原来是多少"）；顺带还会莫名其妙演上好几十秒。
     *
     * ⚠️ **唯一的例外是"这一局的第一步就在窗口里"**（`openingSteps()` 判得出**基线**）——
     *    那时从头发演是对的，而且是必要的：见下面那段"开局回放"。
     *
     * ⚠️ 换局时**必须强制重画**（`reconcile(true)`）：`seq` 回退之后权威视图比显示视图小，
     *    对账那句"显示视图已经追平就不用画了"会把旧一局的画面留在屏幕上。
     */
    if (!view || reset) {
      /*
       * 【开局回放】首次挂载 / 换局时，如果日志窗口**正好从这一局的第一步开始**
       * （第一条的 `n === 1`），那第一条补丁就是**全量快照** —— `patchBase` 按 state 对象存，
       * 一局的第一条取不到基线，天然全量（见 engine.js 的 pushEvent / diffPatch，
       * `tests/rules.test.mjs` 的「开局基线」用例逐字段钉着它）。基线是有的，
       * 所以这条路可以从头一条条叠上来，**把开局演给人看**。
       *
       * 【为什么值得为它破例】服务端在**广播之前**就把人机的整个回合同步跑完了
       * （见 server/games/shell-gambit.mjs 的文件头：房间层没有"稍后再推一次"的机制），
       * 于是"1 号位先行动"那几步发生在玩家拿到第一帧**之前**。不回放的话，玩家一进对局
       * 就已经轮到自己 —— 用户实机报的"我明明在 3 号位，却是第一个行动"就是这条
       * （座位没错、回合也没错，是**开场那几步根本没演给人看**）。
       *
       * 【判据不成立时照旧】打了一半才进来 / 重连：日志窗口已经滑走，第一条不是 `n === 1`，
       * 没有基线就一条都不许叠 —— 走下面那条"只画结果"的老路。
       */
      const opening = openingSteps(authView);
      if (opening) {
        playOpening(opening);
        return;
      }
      reconcile(true);
      return;
    }

    if (!fresh.length) {
      // 这一帧没有新事件（重连补发 / 只是房间成员变了）：没有要演的，直接对齐权威视图
      if (!animBusy()) reconcile();
      else scheduleReconcile();
      return;
    }

    /*
     * 老服务端兜底：服务端进程里可能还留着**没有补丁的旧引擎**（页面文件是从磁盘现取的，
     * 引擎模块却是进程启动时 import 进内存的），那种报文一条 `s` 都没有。
     * 这时**保持原来的行为**：立刻把最终状态画出来、特效照旧逐条演 ——
     * 否则前端一更新、服务端还没重启的那段时间，玩家会看到"画面停在上一步不动"。
     */
    if (!fresh.some((e) => e.s) && !animBusy()) {
      reconcile();
      queueSteps(fresh);
      return;
    }

    queueSteps(fresh);
    scheduleReconcile();
  }

  /**
   * 按**显示视图**把整块牌桌重画一次（回合数 / 弹药数 / 锯子 / 血量点 / 手牌 / 动作区 /
   * 播报文字都在这里；特效与音效不在这里，那是 handleEvent 的事）。
   *
   * 它有两个调用点：演每一步时（贴完补丁画一次）、以及玩家点开/取消"选目标"时重画一次
   * （那时不涉及新事件，只是界面状态变了）。
   */
  function paint(v) {
    if (!v) return;
    view = v;

    host.querySelector('.js-round').textContent = view.round;
    host.querySelector('.js-live').textContent = view.magazine.live;
    host.querySelector('.js-blank').textContent = view.magazine.blank;
    host.querySelector('.js-saw').hidden = !view.saw;
    host.dataset.seq = String(view.seq);
    renderKnowledgeChip();
    renderSeats();
    renderHand();
    renderActions();

    if (view.phase === 'over' && !overShown) {
      overShown = true;
      showResult();
    }
    if (view.phase !== 'over') overShown = false;
  }

  /** 视图是纯 JSON（GAME-SPEC 要求），深拷一份即可 —— 权威对象一个字节都不许改。 */
  const copyView = (v) => JSON.parse(JSON.stringify(v));

  /**
   * 用**权威视图**整体重画一次（对账 / 没有事件可演 / 第一帧 / 换局）。
   *
   * @param {boolean} [force] true = 不管显示视图走到哪儿都重画。
   *        换局（`seq` 回退）时必须强制：那时权威视图的 `seq` 比显示视图**小**，
   *        下面那句"已经追平就不用画"会把上一局的画面留在屏幕上。
   */
  function reconcile(force) {
    if (!authView) return;
    // 显示视图已经追平（甚至更新，说明来的是一帧旧的）：不必白画一遍
    if (!force && view && view.seq >= authView.seq) return;
    paint(copyView(authView));
  }

  /**
   * 对账排期：**等队列真的空掉**再用权威视图收口。
   *
   * 【为什么不能直接排一个"演出总时长"的定时器】队列是平台管的，它有没有排空只有
   * `FrpAnim.busy()` 知道：中间可能又插进来一批新事件（甚至测试自己塞的占位步），
   * 按总时长定时一定会插队 —— 那就是"演到一半突然跳到结果"。
   *
   * 【为什么是 60ms 的小步轮询】只能这样：平台队列没有"排空"回调，
   * `busy()` 在**正在演的那一步内部**也还是 true（running 还没复位），
   * 所以必须在一步之外再看一眼。它只在"有一批账要收"的时候活着，
   * 收完就停，不是常驻定时器。
   */
  function scheduleReconcile() {
    if (reconcileTimer !== null || disposed) return;
    const tick = () => {
      reconcileTimer = null;
      if (disposed) return;                                    // 牌桌已卸：什么都不碰
      if (animBusy()) { reconcileTimer = setTimeout(tick, 60); return; }  // 还在演，接着等
      reconcile();
    };
    reconcileTimer = setTimeout(tick, 60);
  }

  /**
   * 挑出"比自己演到的位置更新"的日志条目（按 n 升序，口径与老版本一字不差）。
   * ⚠️ 顺序、数量、去重三条不许变：`log` 里 `n > lastEventN` 的那些，最后把
   *    `lastEventN` 推到这一帧的最后一条。
   *
   * @returns {{fresh:object[], reset:boolean}}
   *   `fresh` = 要排队的**新增**条目（升序）；`reset` = 这一帧是"换了一局 / 重连"，
   *   序号从头开始（游标清零）。`reset` 为真时 `fresh` 一律是空的 ——
   *   调用方（render）**只画权威视图、不回放旧条目**，理由写在那里。
   */
  function takeFreshEvents(v) {
    const log = v.log || [];
    if (!log.length) return { fresh: [], reset: false };
    /*
     * 单机换局 / 联机重连后 seq 可能回退：游标清零。
     * 但清零**不等于**"窗口里那几十条旧条目都是新事件" —— 那会把补丁叠在错的基线上，
     * 所以 reset 这一帧默认不回放任何东西（见 render 里那段说明；唯一的例外是
     * `openingSteps()` 认得出基线的时候，那时从头演是对的）。
     */
    const reset = lastEventN > 0 && log[log.length - 1].n < lastEventN;
    const lastN = log[log.length - 1].n;
    if (reset) {
      lastEventN = lastN; // 游标对齐到窗口最后一条 = "这些都已经看过了"
      return { fresh: [], reset: true };
    }

    const fresh = [];
    for (const e of log) if (e.n > lastEventN) fresh.push(e);
    lastEventN = lastN;
    return { fresh, reset: false };
  }

  /**
   * 这一帧能不能**从这一局的第一步开始演**（首次挂载 / 换局时的"开局回放"）？
   *
   * 判据只有一条：**日志的第一条就是这一局的第一步（`n === 1`）而且带着补丁** ——
   * 那一条的补丁是全量快照（基线），差量才叠得上去。理由与用户反馈的对应关系
   * 写在 `render()` 里那段"开局回放"里。
   *
   * @returns {object[]|null} 能就返回整段日志（升序），不能就 null（走"只画结果"那条路）
   */
  function openingSteps(v) {
    const log = (v && v.log) || [];
    // 只有开场那一条（`n === 1` 的"第 1 轮"）：没有"我错过的东西"可演，别白拖半秒
    if (log.length < 2) return null;
    if (log[0].n !== 1 || !log[0].s) return null;
    return log;
  }

  /**
   * 把这一局的开头**一条条演出来**（首次挂载 / 换局）。
   *
   * 先把第一条的补丁（**全量**）贴到权威视图的拷贝上当地板，再让队列把整段日志走一遍：
   * 于是"第 1 轮 → 1 号位摸牌 → 1 号位开枪 → … → 轮到我"全都演得出来。
   *
   * ⚠️ `view.seq` 先退回 0：`applyStepPatch` 只肯把 `n === seq + 1` 的补丁贴上去
   *    （差量必须首尾相接），而队列的第一条正是 `n === 1`。它的内容已经在地板里了，
   *    再贴一遍是**幂等**的（同一条全量补丁），换来的是一条不断的链子。
   */
  function playOpening(steps) {
    view = copyView(authView);
    applyPatch(view, steps[0].s);
    view.seq = 0;
    paint(view);
    queueSteps(steps);
    scheduleReconcile();
  }

  /** 把一批步骤排进平台的串行演出队列（平台脚本没挂上时退回同步播，别丢事件）。 */
  function queueSteps(steps) {
    if (!steps.length) return;
    const anim = FrpAnim();
    if (anim) anim.push(steps, (e) => playStep(e));
    else for (const e of steps) playStep(e);
  }

  /** 「已知下一发」提示条：**只有自己**用放大镜看得到 */
  function renderKnowledgeChip() {
    const box = host.querySelector('.hud-mag');
    let chip = box.querySelector('.js-known');
    const knows = view.me && view.me.knows;
    if (!knows) { if (chip) chip.remove(); return; }
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'chip js-known';
      box.appendChild(chip);
    }
    chip.className = `chip js-known ${knows === 'live' ? 'chip-live' : 'chip-blank'}`;
    chip.textContent = `已知下一发：${knows === 'live' ? '实弹' : '空弹'}`;
  }

  function legal() { return (view && view.me && view.me.legal) || []; }

  function renderSeats() {
    const seen = new Set();
    const pend = new Set(legal().filter((a) => a.type === 'target').map((a) => a.targetId));
    const itemTargets = new Set(
      targetingItem
        ? legal().filter((a) => a.type === 'use' && a.item === targetingItem).map((a) => a.targetId)
        : []
    );

    for (const p of view.players) {
      seen.add(p.id);
      let el = seatEls.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'seat';
        el.innerHTML = `
          <span class="seat-seat"></span>
          <span class="badge" hidden></span>
          <div class="avatar"></div>
          <div class="seat-name"></div>
          <div class="hp"></div>
          <div class="seat-meta"></div>`;
        el.addEventListener('click', () => onSeatClick(p.id));
        seatsBox.appendChild(el);
        seatEls.set(p.id, el);
      }

      el.classList.toggle('is-turn', view.turn === p.id && view.phase === 'playing');
      el.classList.toggle('is-me', p.id === myId);
      el.classList.toggle('is-dead', !p.alive);
      el.classList.toggle('is-targetable', p.alive && p.id !== myId && (pend.has(p.id) || itemTargets.has(p.id)));

      el.querySelector('.seat-seat').textContent = `${p.seat} 号`;
      syncAvatar(el.querySelector('.avatar'), p);
      el.querySelector('.seat-name').textContent = p.id === myId ? `${p.name}（我）` : p.name;

      const hp = el.querySelector('.hp');
      if (hp.children.length !== MAX_HP) {
        hp.innerHTML = '';
        for (let i = 0; i < MAX_HP; i++) hp.appendChild(document.createElement('i'));
      }
      [...hp.children].forEach((pip, i) => pip.classList.toggle('off', i >= p.hp));

      el.querySelector('.seat-meta').textContent = `🂠 ${p.handCount}`;

      const badge = el.querySelector('.badge');
      if (p.cuffed) {
        badge.hidden = false;
        badge.className = 'badge cuffed';
        badge.textContent = '手铐';
      } else if (!p.alive) {
        badge.hidden = false;
        badge.className = 'badge';
        badge.textContent = '出局';
      } else {
        badge.hidden = true;
      }
    }

    for (const [id, el] of [...seatEls]) {
      if (!seen.has(id)) { el.remove(); seatEls.delete(id); }
    }
  }

  /**
   * 头像：文字 + **语义圆环** + 平台互动属性。
   *
   * 【圆环颜色是语义，不是装饰】自己＝蓝、其他真人＝橙、人机＝灰。
   * 类名问平台要（`FrpReact.ringClass`），配色写在 `shared/ui/ui.css` 里 ——
   * 用户点名要求三个游戏一致，所以本作**不许**在自己的 CSS 里另定这三色。
   *
   * 【人机怎么判定】只看 `p.isAI` —— 那是 js/view.js 从 `state.players[].isAi`
   * 加上去的身份标记（人机是房间的座位，联机时来自 `players[].isBot`）。
   * ⚠️ **不许按名字猜**：人机的单字名字和真人名字用的是同一个字表
   * （js/ai/ai.js 的 AI_NAME_POOL），「虎」既可能是玩家也可能是电脑。
   * 视图里没有 `isAI` 时一律当真人（橙）—— 那是老报文的兜底，宁可错成橙。
   *
   * 【data-color 那套四色轮换去哪了】原来它画的是**边框**，现在边框归语义色，
   * 它降级成头像**底色**（见 css/style.css）：既保留"每个人有点自己的颜色"，
   * 又不会把"谁是电脑"这条信息盖掉。
   *
   * 【互动（扔鸡蛋/鲜花）】平台的事件代理认 `data-frp-avatar`，
   * 加上这两个属性就自动可点 —— 抛物线、碎裂、音效、被扔的提示都不用本作写一行。
   * 热区就是头像本身（52px，≥44px 的硬指标）。
   */
  /** 头像地址只从房间成员列表取（viewFor 里没有 avatar 字段，别加）。 */
  function avatarUrlOf(id) {
    const net = window.GameNet;
    const members = (net && net.room && net.room.members) || [];
    const m = members.find((x) => String(x.id) === id);
    return (m && m.avatar) || '';
  }

  /** 在头像圆里放一张图片；没有头像就还原成纯文字圆。 */
  function syncAvatarImage(av, url) {
    let img = av.querySelector('.frp-avatar-img');
    if (!url) {
      if (img) img.remove();
      av.classList.remove('has-img');
      return;
    }
    if (!img) {
      img = document.createElement('img');
      img.className = 'frp-avatar-img';
      img.alt = '';
      img.loading = 'lazy';
      av.appendChild(img);
    }
    if (img.getAttribute('src') !== url) img.src = url;
    av.classList.add('has-img');
  }

  function syncAvatar(av, p) {
    const id = String(p.id || '');
    const isBot = !!p.isAI;
    const react = FrpReact();
    const ring = react
      ? react.ringClass(id, isBot)
      : `frp-avatar ${isBot ? 'is-bot' : 'is-human'}`;
    const cls = `avatar ${ring}`;
    if (av.className !== cls) av.className = cls;

    if (av.textContent !== p.name) {
      av.textContent = p.name || '?';
      av.dataset.color = String(colorIndex(id || p.name || '?'));
    }
    // 平台头像：房间成员列表里才有（viewFor 里刻意不放 avatar，别往视图里加）。
    // 放在 textContent 之后 —— 上面那句会把子节点一起清掉。
    syncAvatarImage(av, avatarUrlOf(id));
    av.setAttribute('data-frp-avatar', id);
    av.setAttribute('data-frp-name', String(p.name || ''));
    // 键盘也能用（平台在 document 上听 Enter/Space，认的也是这个属性）
    av.setAttribute('role', 'button');
    av.setAttribute('tabindex', '0');
    av.setAttribute('aria-label', `对 ${p.name || '这个座位'} 扔鸡蛋 / 送鲜花`);
  }

  function onSeatClick(pid) {
    if (!view) return;
    // 演出期间当成没点：这一下可能清掉 targetingItem（改界面状态），也可能发消息
    if (animBusy()) return;
    const pending = legal().find((a) => a.type === 'target' && a.targetId === pid);
    if (pending) return doAction({ type: 'target', targetId: pid });

    if (targetingItem) {
      const use = legal().find((a) => a.type === 'use' && a.item === targetingItem && a.targetId === pid);
      if (use) {
        targetingItem = null;
        return doAction({ type: 'use', item: use.item, targetId: pid });
      }
    }
  }

  function renderHand() {
    handBox.innerHTML = '';
    const hand = (view.me && view.me.hand) || [];

    if (!hand.length) {
      const p = document.createElement('div');
      p.className = 'hand-empty';
      p.textContent = view.me && view.me.alive === false ? '你已出局' : '没有手牌';
      handBox.appendChild(p);
      return;
    }

    for (const item of hand) {
      const info = ITEM_INFO[item];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'card';
      btn.innerHTML = `${icon(info.icon)}<span>${info.name}</span>`;
      btn.disabled = !legal().some((a) => a.type === 'use' && a.item === item);
      btn.classList.toggle('is-picked', targetingItem === item);
      btn.addEventListener('click', () => onCardClick(item));
      handBox.appendChild(btn);
    }
  }

  function onCardClick(item) {
    sfx.ensure();
    if (!view) return;
    /*
     * 演出期间当成没点。这里**必须先判**：需要二次选目标的道具（手铐 / 肾上腺素）
     * 走的是下面的 `targetingItem` 分支 —— 它不发消息，但会改界面状态
     * （卡片点亮、动作区换成"选目标"）。那同样算"点动了"，会加重"画面和操作错位"。
     */
    if (animBusy()) return;
    if (!legal().some((a) => a.type === 'use' && a.item === item)) return;

    if (ITEM_INFO[item].needsTarget) {
      targetingItem = targetingItem === item ? null : item;
      if (targetingItem) onInfo && onInfo(`选择「${ITEM_INFO[item].name}」的目标`);
      paint(view);   // 只是界面状态变了（点亮卡片、动作区换成"选目标"），不涉及新事件
      return;
    }
    doAction({ type: 'use', item });
  }

  function makeActBtn(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', () => { sfx.ensure(); onClick(); });
    return b;
  }

  function renderActions() {
    actionsBox.innerHTML = '';
    const me = view.me;

    if (view.phase === 'over') {
      hintBox.textContent = '本局结束';
      hintBox.classList.remove('is-mine');
      return;
    }
    if (!me || !me.alive) {
      hintBox.textContent = '你已出局，观战中';
      hintBox.classList.remove('is-mine');
      return;
    }
    if (view.turn !== myId) {
      const cur = view.players.find((p) => p.id === view.turn);
      hintBox.textContent = `等待 ${cur ? cur.name : '对手'} 行动…`;
      hintBox.classList.remove('is-mine');
      return;
    }

    hintBox.classList.add('is-mine');

    // ① 需要二次指定目标（肾上腺素偷到手铐）
    const pendingTargets = legal().filter((a) => a.type === 'target');
    if (pendingTargets.length) {
      hintBox.textContent = '偷到了手铐，选择要锁住的人';
      for (const a of pendingTargets) {
        const p = view.players.find((x) => x.id === a.targetId);
        actionsBox.appendChild(
          makeActBtn(`🔒 锁住 ${p ? p.name : '?'}`, 'act-btn shoot', () => doAction(a))
        );
      }
      return;
    }

    // ② 道具选目标模式
    if (targetingItem) {
      hintBox.textContent = `选择「${ITEM_INFO[targetingItem].name}」的目标`;
      for (const a of legal().filter((x) => x.type === 'use' && x.item === targetingItem)) {
        const p = view.players.find((x) => x.id === a.targetId);
        actionsBox.appendChild(
          makeActBtn(`→ ${p ? p.name : '?'}`, 'act-btn shoot', () => {
            targetingItem = null;
            doAction(a);
          })
        );
      }
      actionsBox.appendChild(
        makeActBtn('取消', 'act-btn cancel', () => { targetingItem = null; paint(view); })
      );
      return;
    }

    // ③ 正常回合：按钮**全部由引擎给的 legal 驱动**，不可能出现引擎会拒绝的按钮
    const shoots = legal().filter((a) => a.type === 'shoot');
    const selfShot = shoots.find((a) => a.targetId === myId);
    if (selfShot) {
      const known = me.knows;
      const label =
        known === 'blank' ? '对自己开枪（已知空弹）'
          : known === 'live' ? '对自己开枪（已知实弹！）'
            : '对自己开枪';
      actionsBox.appendChild(makeActBtn(label, 'act-btn self', () => doAction(selfShot)));
    }
    for (const a of shoots) {
      if (a.targetId === myId) continue;
      const p = view.players.find((x) => x.id === a.targetId);
      actionsBox.appendChild(makeActBtn(`打 ${p ? p.name : '?'}`, 'act-btn shoot', () => doAction(a)));
    }

    hintBox.textContent = me.hand.length ? '也可以先用手牌' : '没有手牌，直接开枪';
  }

  /**
   * 统一的动作出口：把"意图"交给上层。
   *
   * 【不做本地预演】点下去到服务器回包之间，**本机不播任何动画、不出任何音效** ——
   * 画面上"我这一手"完全由服务端回放的那一步演出来（见 playStep / handleEvent）。
   *
   * 老版本在这里演一遍"起手"（枪口火光 + 音效），用户实测**快速连点会把画面演成
   * "所有人都被打死了"**：预演和回放是两条时间轴，叠在一起就乱。整段删掉，
   * 决定与教训见 `docs/DECISIONS.md` D10；`docs/GAME-SPEC.md` 第 12 节把它列进了禁止清单。
   *
   * 【演出期间锁输入】这里是**所有发 `room.act` 入口的总闸**（开枪 / 用道具 / 二次选目标
   * 的按钮都汇到它）。`animBusy()` 为真时**当成没点**：不调 `onAct`（不发消息）、
   * 也不改界面状态（`targetingItem` 一个字节都不动）。不锁的话玩家能"看着动画连着操作" ——
   * 服务端那一帧早就把回合推进过了，画面却还在演上一步，看到的和实际的对不上。
   * 同一条判据在 `app.js` 的 `submitAction()` 里还有一道（它才是真正发消息的人）。
   * 房间级操作（开始 / 离开 / 邀请 / 加人机）不走这里，不受影响。
   *
   * ⚠️ **单机也走这条路**，所以单机同样锁得住：本地结果虽然是同步回来的，
   *    演出队列照样要演 450–700ms（两种模式共用同一张牌桌，见 AGENTS.md 第 3.2 节）。
   *
   * @returns {boolean} true = 真的交出去了；false = 被演出锁挡下（当成没点）
   */
  function doAction(action) {
    if (animBusy()) return false;
    targetingItem = null;
    onAct(action);
    return true;
  }

  /* ------------------------------ 逐步演出 ------------------------------ */

  const nameOf = (id) => (view.players.find((p) => p.id === id) || {}).name || '?';

  /**
   * 把"这一步之后的公开状态补丁"贴到**显示视图**上。返回 true = 真贴上去了。
   *
   * 【为什么必须"链子接得上"才贴】补丁是**差量**（只记相对上一条日志变了的字段），
   * 所以只有当显示视图正好停在上一条（`view.seq === e.n - 1`）时它才是完整的信息。
   * 接不上有三种正常情况：日志窗口滑走了（老条目被裁掉）、这是换局/重连后的第一帧、
   * 服务端还没带补丁。那种时候**只演特效、数字不动**，最后由队列排空后的对账收口 ——
   * 半路硬贴只会把画面变成一个谁也见过的状态（比如血量停在 5、弹药数却是新的）。
   *
   * ⚠️ 一条贴不上，后面几条也就都别贴了（它们都是"相对上一条"的差量），
   *    这正是"缺一条就交给对账"的完整含义。
   */
  function applyStepPatch(e) {
    if (!e || !e.s || !view) return false;
    if (e.n !== (view.seq || 0) + 1) return false;
    applyPatch(view, e.s);
    return true;
  }

  /**
   * 把一个补丁盖到**显示视图**上（浅覆盖：只改补丁里提到的字段）。
   *
   * ⚠️ 绝不许拿它去改权威视图：D10 的铁律是"**绝不在本地改权威状态**"，
   *    显示视图是它的一份拷贝（`copyView`），改坏了下一帧对账就修回来。
   */
  function applyPatch(target, s) {
    for (const k of ['seq', 'phase', 'round', 'turn', 'turnNo', 'saw', 'winner', 'drawPileCount', 'discardCount']) {
      if (k in s) target[k] = s[k];
    }
    if (s.magazine) target.magazine = { ...target.magazine, ...s.magazine };
    if (s.load) target.load = { ...target.load, ...s.load };
    if ('pending' in s) target.pending = s.pending;
    if (s.players) {
      // 补丁里的 players 是"变了的那几个人"（数组，按 id 找），不是完整座位表
      for (const changed of s.players) {
        const cur = target.players.find((p) => p.id === changed.id);
        if (cur) Object.assign(cur, changed);
      }
    }
    if (target.me) {
      if ('hand' in s) target.me.hand = Array.isArray(s.hand) ? s.hand.slice() : [];
      if ('legal' in s) target.me.legal = Array.isArray(s.legal) ? s.legal.slice() : [];
      if ('knows' in s) target.me.knows = s.knows;
      // 视图里血量/存活有两份（players[] 与 me），必须一起跟着走
      const mine = target.players.find((p) => p.id === target.me.id);
      if (mine) { target.me.hp = mine.hp; target.me.alive = mine.alive; }
    }
  }

  /**
   * 演一步：**贴补丁 → 重画整块牌桌 → 演特效与音效**，返回这一步占多少毫秒。
   *
   * ⚠️ **牌桌被卸掉之后，还排在队列里的步必须立刻作废**。
   * 这是"逐条演出"带来的新风险：老写法是同步 for 循环，`handleEvent` 一定在
   * 这一帧的 DOM 上跑；现在它可能 700ms 之后才轮到 —— 那时候玩家可能已经
   * 点了「离开对局」（`dispose()` 把宿主 `innerHTML` 清空）或者开了新的一局
   * （`mountBoardFor` 先 dispose 再重建）。那时再去 `feedAdd()` / 查座位，
   * 就是在一个已经被清空的宿主上写 DOM：轻则控制台报
   * `Cannot read properties of null (reading 'classList')`（实测撞到过），
   * 重则把上一局的事件演到新牌桌上。
   * 返回 0 = "这一步不占时间"，队列会一路快速排空。
   */
  function playStep(e) {
    if (disposed || !view) return 0;
    applyStepPatch(e);
    paint(view);
    handleEvent(e);
    return eventMs(e);
  }

  /**
   * 每一步演多久。
   * 用户的要求是"逐条演完、不快进"，但也不许慢到无聊：450–700ms。
   * 分量重的（实弹命中、出局）长一点，播报类的（摸牌、回收）短一点。
   */
  function eventMs(e) {
    switch (e.t) {
      case 'shoot': return e.shell === 'live' ? 700 : 560;
      case 'elim': return 650;
      case 'use': return 560;
      case 'skip': return 520;
      case 'round': return 520;
      case 'recycle': return 480;
      case 'turn': return 450;
      case 'over': return 480;
      default: return 520;
    }
  }

  function findAvatarEl(pid) {
    const seat = seatEls.get(pid);
    return seat ? seat.querySelector('.avatar') : null;
  }

  /**
   * 演一条事件（音效 / 特效 / 对局记录）。
   *
   * 【没有"跳过起手"这回事了】老版本有两个开关 `skipOpen` / `openSound`：
   * 本地预演已经把扣扳机那一下的火光/音效演过了，回放同一条时就跳过它、只补结果。
   * 预演整段删掉之后，**火光和音效只在这里出**（服务端说了什么就演什么），
   * 那两个开关一起删了 —— 留着就是"恒为 false 的半死代码"，
   * 而且最恶心的失败方式是"某个音效被永久吞掉"却没人看得出来。
   * 现在每一条事件都**照常演**：该出火光出火光、该出音效出音效。
   *
   * 【底部提示弹窗（`onInfo`）为什么从这里删掉了】用户实机反馈：
   * "行动时屏幕下方会出现「放大镜：下一发是实弹」「虎 被戴上铐」这种提示弹窗
   *  挡住我的操作按钮"。这两条原来在这里调 `onInfo` → 平台提示条（`position:fixed; bottom`），
   * 正好压在牌桌的动作区上。它们要说的信息**都已经在别处**：
   * 放大镜结果在 HUD 的「已知下一发」提示条上（`renderKnowledgeChip`），
   * 两个动作本身在「对局记录」里各有一行。**别再往这里加底部弹窗**。
   * （保留的 `onInfo` 调用只剩"用户自己点出来的"那两处：选目标提示、菜单里的开关提示。）
   *
   * @param {object} e 引擎的公开事件（见 engine.js 的 pushEvent）
   */
  function handleEvent(e) {
    switch (e.t) {
      case 'round':
        sfx.play('round');
        banner(`第 ${e.round} 轮`, 'var(--gold)');
        feedAdd(`第 ${e.round} 轮 · 实弹 ${e.live} / 空弹 ${e.blank}`, 'item');
        break;
      case 'turn':
        if (e.drew > 0) feedAdd(`${nameOf(e.player)} 摸了 ${e.drew} 张牌`);
        break;
      case 'recycle':
        feedAdd(`弃牌堆回收重洗（${e.count} 张）`);
        break;
      case 'use': {
        const label = (ITEM_INFO[e.item] || {}).name || e.item;
        // 道具音**只在这里出**（本地预演已经删掉，见 doAction 的说明）
        sfx.play(sfxForItem(e.item));
        banner(label, 'var(--gold)');
        let extra = e.target ? ` → ${nameOf(e.target)}` : '';
        if (e.item === 'beer') extra = ` · 退出一发${shellName(e.ejected)}`;
        if (e.item === 'cigarette' && !e.healed) extra = ' · 满血浪费了';
        if (e.item === 'adrenaline') {
          extra = e.stolen
            ? ` → 偷到 ${(ITEM_INFO[e.stolen] || {}).name || e.stolen}${e.wasted ? '（无合法目标，浪费）' : ''}`
            : ' → 对方没有手牌';
        }
        feedAdd(`${nameOf(e.player)} 使用 ${label}${extra}`, 'item');
        /*
         * ⚠️ 这里原来还有两条底部提示弹窗（`放大镜：下一发是…` / `… 被戴上铐`），
         *    已经删掉：它们压在动作区上挡按钮，而信息在 HUD 的「已知下一发」
         *    提示条和「对局记录」里本来就有。见 handleEvent 头顶那段说明。
         */
        break;
      }
      case 'shoot': {
        const who = `${nameOf(e.player)} ${e.self ? '对自己' : `对 ${nameOf(e.target)}`} 开枪`;
        if (e.shell === 'live') {
          /*
           * 火光 + 枪声 + 命中判定、伤害数字、震动、横幅、对局记录**都在这里出**。
           * 老版本因为本地预演已经闪过火光，这里带一个 skipOpen 判断；
           * 预演删掉之后，**这一条就是"我那一手"唯一的演出**，一个都不许省
           * （省掉的话玩家会看到"枪响了但没人掉血"，或者"点了没反应"）。
           */
          muzzleFlash(findAvatarEl(e.player));
          sfx.play('shoot');
          shakeApp();
          const target = findAvatarEl(e.target);
          if (target) {
            const seat = target.closest('.seat');
            if (seat) {
              seat.classList.add('is-hit');
              setTimeout(() => seat.classList.remove('is-hit'), 460);
            }
            damageNumber(target, `-${e.damage}`);
          }
          banner(e.self ? '砰！自己中弹' : '砰！实弹命中', 'var(--live)');
          feedAdd(`${who} · 实弹 -${e.damage}${e.saw ? '（锯短枪管）' : ''}`, 'live');
        } else {
          // 空弹：这一声"咔"是结果，只在这里出（本地预演已经删掉）
          sfx.play('blank');
          banner('咔！空弹', 'var(--blank)');
          feedAdd(`${who} · 空弹`, 'blank');
        }
        break;
      }
      case 'elim':
        sfx.play('hurt');
        banner(`${nameOf(e.player)} 出局`, 'var(--text-dim)');
        feedAdd(`${nameOf(e.player)} 被淘汰`, 'live');
        break;
      case 'skip':
        sfx.play('cuff');
        banner(`${nameOf(e.player)} 被锁住`, 'var(--gold)');
        feedAdd(`${nameOf(e.player)} 被手铐跳过回合`, 'item');
        break;
      case 'over':
        sfx.play(e.winner === myId ? 'win' : 'lose');
        break;
      default:
        break;
    }
  }

  function sfxForItem(item) {
    switch (item) {
      case 'magnifier': return 'info';
      case 'inverter': return 'invert';
      case 'handsaw': return 'saw';
      case 'cigarette': return 'heal';
      case 'handcuffs': return 'cuff';
      default: return 'card';
    }
  }

  /* ------------------------------ 结算 ------------------------------ */

  /**
   * 结算横幅与记录。
   * ⚠️ 它现在由 `paint()` 在"显示视图的 phase 变成 over 的那一刻"调用 ——
   *    也就是说**最后一条决定了胜负的补丁贴上之后**才弹出来，不是服务器一推就弹。
   *    读的是显示视图（画面上那份），不是权威视图：逐步渲染下两者在演出期间本来就不一样。
   */
  function showResult() {
    const winner = view.players.find((p) => p.id === view.winner);
    const iWon = view.winner === myId;
    // 胜利与否**只看 view**（view.winner 是公开信息）—— 界面拿不到、也不需要引擎的 result()
    banner(iWon ? '你活到了最后' : `${winner ? winner.name : '无人'} 获胜`, 'var(--gold)');
    feedAdd(iWon ? '🏆 你活到了最后' : `对局结束 · ${winner ? winner.name : '无人'} 获胜`, 'item');
  }

  return {
    render,
    refreshSettings,
    dispose() {
      hideModal();
      disposed = true;   // 排在演出队列里的步也会看到它，立刻作废（见 playStep）
      // 对账的小定时器也要停：牌桌都卸了，再去重画就是往已清空的宿主里写 DOM
      if (reconcileTimer !== null) { clearTimeout(reconcileTimer); reconcileTimer = null; }
      seatEls.clear();
      host.innerHTML = '';
    },
  };
}