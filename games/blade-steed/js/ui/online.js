/**
 * BladeSteed — 在线对局（房间胶水）
 *
 * 这一层只干三件事：
 *   1. 挂房间外壳：房号 / 成员 / 邀请 / 开始 / 离开**全部由 /shared/ui/room.js 画**，
 *      本文件一行房间界面都不写。
 *   2. 往外壳里填本游戏自己的两块内容：准备区的设置项（`renderSetup`）和牌桌（`renderGame`）。
 *   3. 对接服务端：点击 → 意图信封 → `GameNet.send(room.act)`（见下面的 act()）；
 *      服务端发来的 `view` → `BoardView`。
 *
 * ⚠️ **不做本地预演**（点下去到服务器回包之间本机不演任何东西），
 *    而且**演出没排空时所有动作入口都锁住**（`FrpAnim.busy()`）——
 *    两件事的决定与教训见 docs/DECISIONS.md D10。
 *
 * 牌桌渲染、行动按钮、特效**都复用单机那一套**（js/ui/board.js）——
 * 单机与联机只是"谁在推进引擎"不同，界面代码一模一样（docs/GAME-SPEC.md 铁律二）。
 *
 * ⚠️ 本文件与 js/ui/app.js 一样只在浏览器里跑（会读 window），
 *    不像 js/engine/**、js/ai/** 那样需要零 DOM。
 */

import { BoardView, animBusy } from './board.js';
import { PHASE } from '../engine/constants.js';

const { GameNet, FrpRoom, FrpUI, FrpProtocol } = window;
const T = FrpProtocol.T;

/** 别的游戏的标题（只有收到好友邀请、且邀请的是别的游戏时才会用到） */
const GAME_TITLES = {
  'cannon-goblin': '大炮轰小鬼',
  'shell-gambit': 'Shell Gambit',
  'blade-steed': '刀马 BladeSteed',
};

export class OnlineMode {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container 给 FrpRoom 用的容器（#online-panel）
   * @param {import('./audio.js').AudioKit} opts.audio
   * @param {() => ({id:string,name:string}|null)} opts.me 我是谁（身份可能比这个模块晚到，所以取函数）
   * @param {(on:boolean)=>void} [opts.onFxChange] 不传也行
   * @param {(screenId:string)=>void} opts.showScreen 切屏幕（收到邀请时跳到在线对局页）
   */
  constructor({ container, audio, me, showScreen }) {
    this.container = container;
    this.audio = audio;
    this.me = me;
    this.showScreen = showScreen;

    /** 联机牌桌的**常驻根元素**（见下面 renderGame 的注释，绝不能每次重建） */
    this.root = null;
    this.board = null;
    this.ctx = null;
    this.fxEnabled = true;
    this._tickTimer = null;
    this._selfId = null;
  }

  /* ------------------------------ 挂载 ------------------------------ */

  mount() {
    FrpRoom.mount({
      container: this.container,
      game: 'blade-steed',
      // 房间层数的是**真人**座位：1 = 一个人点「创建房间」也能建，座位由「＋ 添加人机」补够
      // （见 docs/GAME-SPEC.md §4 与 server/games/blade-steed.mjs 的 meta）。
      // 少传这个数字的话，房里只有 1 个人时「开始游戏」是亮的，点了会被房间层拒。
      minPlayers: 1,
      // 设置的初始值：中途可以进人。**没有 aiFill** —— 人机是房间的座位，由房间壳加（见 _renderSetup）。
      options: { allowMidJoin: true },
      renderSetup: (host, ctx) => this._renderSetup(host, ctx),
      renderGame: (host, view, ctx) => this._renderGame(host, view, ctx),
    });

    FrpRoom.handleInvites({
      gameTitle: (slug) => GAME_TITLES[slug] || slug,
      goToGame: (slug) => {
        if (slug === 'blade-steed') this.showScreen('screen-online');
        else window.location.href = '/games/' + encodeURIComponent(slug) + '/';
      },
    });
  }

  /** 特效开关跟着全局偏好走 */
  setFx(on) {
    this.fxEnabled = !!on;
    if (this.board) this.board.fx.enabled = this.fxEnabled;
  }

  /* ------------------------------ 准备区（本游戏的设置项） ------------------------------ */

  /**
   * 画本游戏自己的设置区。房号 / 成员 / **人机座位** / 邀请 / 开始 / 离开
   * 一律由 `/shared/ui/room.js` 画 —— 连那个「＋ 添加人机」也是它画的，本文件一行都不碰。
   * 这里只剩一项：**对局中途允许别人进来**。
   *
   * ⚠️ 原来这里还有一排「补几个电脑」（`ctx.setOption('aiFill', n)`，服务端读 `options.aiFill`）
   *    —— 那一套**已作废**（用户明确要求，见 docs/DECISIONS.md D9）：
   *    人机现在是**房间的座位**，房主按一下房间壳上的「＋ 添加人机」就多一个座位，
   *    服务端读的是 `players[].isBot`（server/games/blade-steed.mjs）。
   *    再画一排"补几个"就等于给了玩家两个互相打架的入口，而且"选了几个"根本看不见。
   *
   * ⚠️ 「座位够不够」的提示也由房间壳负责了（它会写"至少要 N 个座位才能开始…按「添加人机」补一个"）。
   *    这里只在**座位已经够了**的时候补一句"可以开了"，别把同一句话说两遍。
   */
  _renderSetup(host, ctx) {
    /*
     * 设置项的"当前值"分两种人：
     *   · 房主：本地那份就是他选的（点「开始游戏」时才随 room.start 发给服务端）
     *   · 别人：本地那份是**上一个房间**留下的老值，得看这个房间当前的设置
     *     （room.state 里带着服务端的 room.options）
     * 不分开的话，客人会看到"上一个房间的允许/不允许"这种跟自己房间毫无关系的状态。
     */
    const shown = (key, fallback) => {
      const from = ctx.isHost ? ctx.options[key] : (ctx.room && ctx.room.options ? ctx.room.options[key] : undefined);
      return from === undefined ? fallback : from;
    };
    const allowMid = shown('allowMidJoin', true) !== false;

    // 座位数（真人 + 人机）由房间层给（ctx.seats / minSeats / maxSeats）——
    // 它数得比我们准：人机也是座位，两个都算。
    const seats = Number(ctx.seats) || 0;
    const minSeats = Number(ctx.minSeats) || 2;
    const maxSeats = Number(ctx.maxSeats) || 4;

    const segBtn = (label, active, value, key) =>
      FrpUI.el(
        'button',
        {
          class: `seg-btn${active ? ' is-on' : ''}`,
          type: 'button',
          disabled: ctx.isHost ? null : true, // 服务端还会再校验一次，这里只是别让人白点
          onclick: () => {
            this.audio.play('click');
            ctx.setOption(key, value);
          },
        },
        label
      );

    /*
     * 座位不够时**不说"点开始试试"**，而是明确指向上面那个按钮 ——
     * 这一步点下去会被房间层拒（提示条："座位不够：…按「添加人机」补一个"），
     * 事前说清比事后弹一条红字好。
     */
    const startHint =
      seats < minSeats
        ? `台上现在 ${seats} 个座位：按房间号旁边的「＋ 添加人机」补一个，或者等朋友进来（至少要 ${minSeats} 个座位才能开局）。`
        : `座位够了（${seats} / ${maxSeats}）—— 点下面的「开始游戏」就能开。`;

    host.append(
      FrpUI.el('div', { class: 'setup' }, [
        FrpUI.el('p', { class: 'field-label', text: '本局设置' }),

        FrpUI.el('p', { class: 'setup-label', text: '对局中途允许别人进来' }),
        FrpUI.el('div', { class: 'seg' }, [
          segBtn('允许', allowMid, true, 'allowMidJoin'),
          segBtn('不允许', !allowMid, false, 'allowMidJoin'),
        ]),
        FrpUI.el('p', {
          class: 'hint',
          text: '中途进来的人从下一个猜拳回合开始参与。改成「不允许」之后，这一局就进不来了。',
        }),

        FrpUI.el('p', {
          class: 'hint',
          // 人机的名字是**公开**的（契约 docs/GAME-SPEC.md §4）：来自单字池（虎/狼/鹰…），
          // 头像再画灰圈 + 虚线 —— 玩家一眼就该看出哪个座位是人机，不用猜。
          text: ctx.isHost
            ? '人机也是座位：按「＋ 添加人机」加一个，按「移除」撤掉。它用单字名字（虎/狼/鹰…），头像画灰圈 + 虚线，一眼看得出不是人。'
            : '人机也是座位（由房主添加/移除），它用单字名字（虎/狼/鹰…），头像画灰圈 + 虚线。',
        }),

        FrpUI.el('p', { class: 'hint', text: startHint }),
      ])
    );
  }

  /* ------------------------------ 牌桌 ------------------------------ */

  /**
   * ⚠️ 这个方法每次收到 room.state 都会被调一次，而房间层**每次都会清空容器**。
   * 所以这里绝不重建牌桌：root 是常驻的，只是被搬进新容器。
   * （重建会砍断正在播的特效，也会让头像的位移补间重新开始。）
   */
  _renderGame(host, view, ctx) {
    this.ctx = ctx;
    const me = this.me();
    const selfId = me ? me.id : null;
    this._selfId = selfId;

    if (!this.root) {
      this.root = document.createElement('div');
      this.root.className = 'online-board';
      this.board = new BoardView(this.root, {
        onAct: (act) => this.act(act),
        audio: this.audio,
      });
      this.board.fx.enabled = this.fxEnabled;
    }
    host.append(this.root);
    this.board.render(view, selfId);
    this.scheduleTick();
  }

  /**
   * 把一个意图信封交给房间层发出去（服务端 tick 后会广播新状态）。
   *
   * ⚠️ 这里**直接用 GameNet.send**，而不是 `this.ctx.act(act)`。
   * 原因只有一个：返回值告诉我们"这条消息真的发出去了吗"，而上层需要知道
   * （发失败要能如实返回 false）。`ctx.act` 内部就是同一句
   * `Net.send(T.ROOM_ACT, { act })`（shared/ui/room.js），协议完全没变。
   *
   * ⚠️ **演出没排空时不发**（用户第 2 条需求 / docs/DECISIONS.md D10）：
   * 服务端那一帧早就把回合推进过了，画面还在演的时候接着操作，看到的和实际局面就错位。
   * 平台的 `ctx.act()` 里也兜了这一层，但本游戏走的是 `GameNet.send` ——
   * **自己这个口子必须自己判**（游戏才是真正发消息的那个人）。
   * ⚠️ 唯一的例外是 `{kind:'tick'}`：它不是玩家点的，是"这一阶段快到点了"的催办
   * （见下面的 scheduleTick）。锁住它只会让超时白白晚几秒，而且 tick 不改局面。
   *
   * @param {object} act 意图信封
   * @returns {boolean} 真的发出去了吗
   */
  act(act) {
    if (!this.ctx) return false;
    if (!(act && act.kind === 'tick') && animBusy()) return false;
    return GameNet.send(T.ROOM_ACT, { act }) === true;
  }

  /**
   * 超时催办。
   *
   * 平台的房间层**不替游戏驱动时钟**（server/rooms.mjs 里没有 tick 钩子），
   * 所以「猜拳 10 秒不出拳就随机代出」这类规则要有人来推。
   * 做法：本阶段快到点时，客户端自己发一条 {kind:'tick'}，服务端 tick 后广播新状态。
   * 每个客户端都会排这个定时器 —— 谁醒着谁推，所以房主切后台也不会把全桌卡死。
   *
   * ⚠️ 只在**到点前**排一次，不要写成每秒心跳：房间层每次广播都会让所有客户端重画牌桌，
   *    每秒心跳等于每秒重画一次，手机上又烫又费电。
   *
   * ⚠️ **演出没演完就先别排**（用户第 1 条需求：演出那几秒不该算进思考时间）。
   *    演出期间界面上根本不显示在跑的倒计时（board.js 的 tickTimer 显示"演出中"），
   *    这时候按剩余时间排定时器，等于"玩家还没看见倒计时，催办就已经在路上了"。
   *    所以：先每 120ms 看一眼队列，**等它真空了再按服务器给的真实剩余去排**
   *    （⛔ 绝不自己加时间，`pendingInMs()` 读的是视图里的权威时限）。
   * ⚠️ 也**不要锁 `{kind:'tick'}`**（它是演出期间唯一允许发出去的消息，见 act()）：
   *    锁了只会让超时白白晚几秒，那正是 D14 明确不接受的做法。
   */
  scheduleTick() {
    clearTimeout(this._tickTimer);
    this._tickTimer = null;
    if (!this.board || !this.ctx) return;
    // 读**权威视图**的阶段：显示视图还停在演出中的那一步，不能拿它判断"该不该催"
    const view = this.board.authView || this.board.view;
    if (!view || view.phase === PHASE.OVER) return;

    if (animBusy()) {
      this._tickTimer = setTimeout(() => {
        this._tickTimer = null;
        this.scheduleTick();
      }, 120);
      return;
    }

    const inMs = this.board.pendingInMs();
    if (inMs == null) return;

    this._tickTimer = setTimeout(() => {
      this._tickTimer = null;
      const room = GameNet.room;
      if (!room || room.phase !== 'playing') return;
      const v = this.board && (this.board.authView || this.board.view);
      if (!v || v.phase === PHASE.OVER) return;
      const left = this.board.pendingInMs();
      // 还没到点（时钟偏差 / 刚才的广播里有新时限）→ 重新排，别连发
      if (left != null && left > 300) {
        this.scheduleTick();
        return;
      }
      this.act({ kind: 'tick' });
    }, Math.max(500, inMs + 400));
  }

  /* ------------------------------ 平台的坑 ------------------------------ */

  /*
   * 【历史记录，已经被平台修好了 —— 所以这里没有代码】
   *
   * 2026-10 那会儿，点了房间里的「离开」之后，服务端只把新状态推给**还留在房里的人**
   * （server/rooms.mjs 的 broadcastState 只遍历 room.members），离开的人永远收不到
   * 「你已经不在房里了」这条消息：房间界面停在原地，`GameNet.room` 一直是旧对象，
   * 再点一次只会弹「你不在任何房间里」，只能手动刷新。
   *
   * 当时在本文件里加过一个兜底（点过「离开」1.2 秒后如果没有任何新状态就重载页面）。
   * 后来平台在 `rooms.leave()` 里补了一条定向消息给离开的人
   * （`deliver(playerId, { t: T.ROOM_STATE, code: null })`，注释里写着是 check-game 的
   * 浏览器段抓到的），客户端会干净地清掉 `GameNet.room`、房间面板回到入口态 ——
   * 兜底就删掉了（留着反而可能在正常离房时误重载页面）。
   *
   * 教训：游戏侧兜底平台 bug 的时候，一定要写清"平台修好之后把这段删掉"，
   * 否则它会变成一段没人敢动的死代码。
   */
}