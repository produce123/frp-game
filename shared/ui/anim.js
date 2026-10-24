/*
 * 演出队列 —— 「服务器一次推来好几步，界面得一步一步演完」这件事的唯一实现。
 *
 * 【为什么需要它】
 * 在线对局是服务端权威的：真人动一下之后，服务器会在**同一次** act 里把 AI 的整个回合
 * 同步跑完（这是刻意的，见 docs/DECISIONS.md D2 与 平台游戏接口约定：房间层没有定时器，
 * 一旦 AI 留在"思考中"的状态返回，全桌就永远停在"等待对手行动"）。
 * 于是客户端会**在一条报文里**收到好几步，而界面上原来是同步 for 循环一次全播 ——
 * 玩家看到的就是"特效一闪而过"。用户的原话就是这么提的。
 *
 * 这个文件把那串事件变成一条**串行时间轴**：一步演完再演下一步。
 * 每一步演多久由游戏自己决定（`stepFn` 的返回值），因为它才知道那个动画多长。
 *
 * 【刻意不做的事】
 *   · 不做"点击屏幕跳过"（用户明确说不要）——所以没有 skip 接口。
 *   · 不做快进（同上）。只有一条**技术性**兜底：积压超过 MAX_BACKLOG 步时，
 *     后面的立刻演完。它不是"跳过"，是防止一次几百条的极端报文把界面钉在演出里。
 *   · **不做"用户本地预演"**（曾经做过，已经删掉）：那时是"点下去先在本机演一遍，
 *     服务端回来再对齐"。用户实测反馈快速连点会把画面演成"所有人都被打死了"，
 *     而且预演和真正的结果会打架 —— 现在只有"服务器说了什么，就演什么"。
 *   · 不认识任何具体游戏：它只负责"按顺序、按时长"调用你给的函数。
 *
 * 【演出期间锁输入（配合用户的第 2 条反馈）】
 *   服务端那一帧已经把回合推进过了，所以演出还在放的时候，界面上其实已经"轮到你"。
 *   不锁的话玩家能一边看动画一边连着操作（画面和操作错位）。两个接口配合：
 *     · `FrpAnim.busy()` —— 游戏在**提交动作之前**判它，是 true 就别发（返回 false）
 *     · `body.frp-anim-busy` —— 演出期间平台给 `<body>` 加的这个类名，
 *       游戏用自己的 CSS 把动作按钮变灰/禁点
 *   代价是每次演出都要等它演完才能操作，用户明确接受（"卡一点就卡一点没事的"）。
 *
 * 用法（游戏侧）：
 *   var handle = FrpAnim.push(newSteps, function (step) {
 *     playSomething(step);      // 起一个动画 + 音效
 *     return 600;               // 这一步演 600ms
 *   });
 *   // 提交动作前：if (FrpAnim.busy()) return false;   // 演出没完，别让玩家操作
 *   // 牌桌被卸载时：handle.cancel()  → 这一批还没演的步作废（见 push 的说明）
 */
(function (root) {
  'use strict';

  /** 用户系统级关了动画（CSS 里那条 prefers-reduced-motion 的 JS 侧对应物） */
  var reduced = false;
  try {
    reduced = Boolean(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (err) { /* 老浏览器没有 matchMedia：当成"没关" */ }

  /** 特效总开关（游戏自己的"特效"按钮会调 setEnabled） */
  var enabled = true;
  /** 没写返回值时一步演多久 */
  var DEFAULT_MS = 520;

  /**
   * 积压上限：超过就把后面的立刻演完。
   * 24 步 × 0.5 秒 = 12 秒，已经远超任何正常回合；到这一步说明报文形状不对，
   * 宁可让演出失真也不能让界面一直卡在"还在演"。
   */
  var MAX_BACKLOG = 24;

  /** 待播的步：{ step, fn, batch } */
  var queue = [];
  var running = false;
  /** 上一次同步给 `<body>` 的"演出中"状态（避免每步都去动 class） */
  var busyFlag = false;

  /**
   * 把"演出中"写进 `<body class="frp-anim-busy">`。
   *
   * 【为什么要有它】演出是**异步**的，而服务端那一帧已经把回合推进过了：
   * 演出还没演完，界面上就已经是"轮到你"了 —— 玩家在这两三秒里能接着操作，
   * 造成"我看到的画面"和"我操作的局面"错位（用户反馈的原话：
   * "还没演完操作权就又回到用户层了，用户层几乎可以一直持续操作"）。
   * 所以演出期间要**锁住输入**：游戏在自己的提交口子上判 `FrpAnim.busy()`，
   * 再用 `body.frp-anim-busy` 把按钮变灰（各游戏自己的 CSS 写这条）。
   * 用户明确同意这点延迟："卡一点就卡一点没事的"。
   */
  function syncBusy() {
    var on = running || queue.length > 0;
    if (on === busyFlag) return;
    busyFlag = on;
    try {
      var body = root.document && root.document.body;
      if (body) body.classList.toggle('frp-anim-busy', on);
    } catch (err) { /* 没有 body（Node 侧）时忽略 */ }
  }

  /**
   * 一步实际演多久：特效关掉或者系统关了动画时一律 0
   * （音效由游戏自己判断，这里只管时间）。
   */
  function pace(ms) {
    var n = Number(ms);
    if (!Number.isFinite(n) || n < 0) n = DEFAULT_MS;
    if (!enabled || reduced) return 0;
    return n;
  }

  function run() {
    if (!queue.length) {
      running = false;
      syncBusy();
      return;
    }
    running = true;
    syncBusy();

    var item = queue.shift();
    var ms = 0;
    try {
      ms = pace(item.fn ? item.fn(item.step) : DEFAULT_MS);
    } catch (err) {
      if (root.console) console.error('[FrpAnim] 播放一步时出错（后面的步照旧）', err);
      ms = 0;
    }
    // 积压过多：把剩下的赶完（技术性兜底，见文件头）
    if (queue.length > MAX_BACKLOG) ms = 0;

    // 用 setTimeout 而不是同步递归：一步炸了也不会把整条链拖死
    root.setTimeout(run, ms > 0 ? ms : 0);
  }

  /**
   * 往队列里追加若干步。**串行**播放：上一次 push 的还没演完，这次的就排在后面。
   *
   * @param {any[]} steps
   * @param {(step:any) => number} fn 演这一步并返回它要占用的毫秒数
   * @returns {{cancel: () => void}} **取消句柄**：调 `cancel()` 就把这一批还没演的步撤掉。
   *
   * 【为什么要返回句柄】演出是异步的：一步可能排在 700ms 之后，那时候牌桌可能已经被
   * 卸载（玩家点了「离开」）或者已经换了一局。游戏若拿不到句柄，就只能自己在每一步里
   * 加一个"我已经死了"的旗子 —— 忘了加就是**控制台刷屏**（往已清空的宿主写 DOM，
   * 报 `Cannot read properties of null`），而且 Node 侧测试完全看不见（贝壳赌局踩过）。
   * 给了句柄之后，卸载时一句 `handle.cancel()` 就够了。
   */
  function push(steps, fn) {
    var batch = { alive: true };
    var handle = {
      cancel: function () {
        batch.alive = false;
        for (var i = queue.length - 1; i >= 0; i--) {
          if (queue[i].batch === batch) queue.splice(i, 1);
        }
      },
    };
    if (!steps || !steps.length || typeof fn !== 'function') return handle;
    for (var i = 0; i < steps.length; i++) queue.push({ step: steps[i], fn: fn, batch: batch });
    if (!running) run();
    syncBusy();
    return handle;
  }

  /** 队列里还有东西吗（**游戏要在提交动作之前判它**，见 syncBusy 的说明） */
  function busy() { return running || queue.length > 0; }

  /** 清空队列（换房间 / 重新开局时用；正在演的那一步由它自己收尾） */
  function clear() { queue.length = 0; syncBusy(); }

  var api = {
    push: push,
    busy: busy,
    clear: clear,
    /** 特效开关（游戏自己的开关调它） */
    setEnabled: function (on) { enabled = !!on; },
    isEnabled: function () { return enabled && !reduced; },
    /** 系统是否要求减少动画（游戏可以据此关掉自己的特效） */
    reducedMotion: function () { return reduced; },
    /** 把一步的时长换算成"实际要等多久"（0 = 立刻），游戏需要自己排期时用得上 */
    pace: pace,
  };

  root.FrpAnim = api;
})(typeof window !== 'undefined' ? window : globalThis);