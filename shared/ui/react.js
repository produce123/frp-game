/*
 * 互动（扔鸡蛋 / 送鲜花）—— 平台层的一件共用能力。
 *
 * 【为什么在平台层，不在游戏里】
 * 三个游戏的原项目里都有一份"点别人头像扔东西"的实现（真撞过坑、也调过手感），
 * 但那是"没有服务器时顺手做的一条广播通道"，搬迁时按 平台旧约定 整块删掉了。
 * 现在平台有服务器、有房间，这件事应该做成**一件共用能力**：
 * 用户在任何一个游戏里学到的"点头像 → 扔鸡蛋"必须完全一样（平台统一约定）。
 *
 * 【游戏侧怎么接（只有三件事）】
 *   1. 想让它可点的地方加一个属性：`data-frp-avatar="<玩家 id>"`
 *      （可选 `data-frp-name="<单字名>"`）。任何人点它就会弹出「扔鸡蛋 / 送鲜花」。
 *      SVG 里也可以（`<g data-frp-avatar="…">`），热区自己保证 ≥44px。
 *   2. 画头像圆环时用本文件给的类名：`FrpReact.ringClass(id, isBot)`
 *      → 自己=蓝、其他真人=橙、人机=灰。颜色走 CSS 变量，见 shared/ui/ui.css。
 *   3. 自己的"音效 / 特效"开关接上：`FrpReact.setSound(on)` / `FrpReact.setFx(on)`。
 * 其余（弹菜单、抛物线飞行、碎裂特效、音效、被别人扔时的提示）本文件全包。
 *
 * 【"锁定式"交互 + 头像点击策略（设计文档 §9.6，2026-10 加，纯增量）】
 * 默认行为**一个字都没变**：不调下面这几个 API 的页面（另外三个游戏、房间准备界面、
 * 房间成员列表）和以前完全一样。
 *   · `FrpReact.arm('egg' | 'flower' | null)` —— 进入 / 切换 / 取消锁定态；
 *     锁定后点**别人**头像**直接扔**（不弹菜单，可连扔）；传别的值等于取消。
 *   · `FrpReact.armed()` —— 当前锁定态（`null` 或 kind）。
 *   · `FrpReact.setAvatarPolicy(fn)` —— 游戏接管头像点击：`fn(id) → 'menu' | 'throw' | 'game'`。
 *     `'game'` = 不碰事件、交还给游戏（游戏拿它开自己的武将/玩家信息面板）；
 *     `'throw'` = 直接扔当前锁定的东西并吞掉事件（没锁定就退回菜单）；
 *     `'menu'` = 老行为；传 `null` 注销。
 *   · 顶栏图标高亮：给按钮加 `data-frp-arm="egg"`（或 `flower`），`arm()` 会自己挂
 *     `.is-armed` 类并写 `aria-pressed`，样式在 ui.css 里（高不用自己写 CSS）。
 *
 * 鼠标点击与键盘（Enter / Space）走**同一条策略**，不会出现"只有鼠标生效"。
 * 点自己的头像是**放行**的（自己不能被扔；游戏要用这次点击开"我的武将"面板）。
 *
 * 【服务端是唯一发源地】
 * 发送走 `react.send`，服务端校验"目标在不在同一间房"之后**广播给房里每个人**
 * （含发起人）。发起人本地已经乐观播过一次，靠回执里的 `rid` 认出自己的回声、不重复播。
 *
 * 【刻意不做次数限制】（用户明确要求）
 * 只有两处技术性兜底，正常怎么点都碰不到：
 *   · 服务端：2 秒内超过 40 次就静默丢弃（防一个客户端把全房刷爆，见 rooms.mjs）
 *   · 客户端：同屏最多 20 个特效（防止手机上几百个 DOM 节点一起动）
 */
(function (root) {
  'use strict';

  var P = root.FrpProtocol;
  var UI = root.FrpUI;
  var Net = root.GameNet;
  var doc = root.document;

  /** 同屏特效上限（技术性兜底，见文件头） */
  var MAX_FX = 20;

  var fxEnabled = true;
  var soundEnabled = true;
  /**
   * 我最近几次乐观播放过的互动：`{to, kind, at}`。
   *
   * 服务端会把每一条广播给**房里每个人，包括发起人**（那是刻意的，见 D11），
   * 所以发起人要靠这个列表认出"这是我自己的回声"、不播第二遍。
   * ⚠️ 存的是一条**列表**而不是"最后一次"：手快的人一秒内能给好几个人各扔一个，
   *    只记最后一次的话，前几个的回声会被当成别人的、重复播一遍。
   */
  var ownSends = [];
  /** 只认这些字符：玩家 id 与 `bot:1` 这种座位 id */
  var SAFE_ID = /^[A-Za-z0-9:_-]{1,32}$/;

  /* ============================== 小工具 ============================== */

  function el(tag, attrs, children) { return UI.el(tag, attrs, children); }
  function ok(id) { return typeof id === 'string' && SAFE_ID.test(id); }
  function meId() { return Net.me && Net.me.id; }

  /** 头像圆环的类名：自己=蓝、其他真人=橙、人机=灰。 */
  function ringClass(id, isBot) {
    if (id && id === meId()) return 'frp-avatar is-me';
    return isBot ? 'frp-avatar is-bot' : 'frp-avatar is-human';
  }

  /**
   * 建一个可点头像（平台外壳与任何想省事的游戏都能直接用）。
   * @param {{id:string, name:string, avatar?:string, isBot?:boolean, size?:number, cls?:string}} who
   */
  function avatarEl(who) {
    var id = String((who && who.id) || '');
    if (!ok(id)) return el('span', {});
    var name = String((who && who.name) || '');
    var avatar = String((who && who.avatar) || '');
    var hasImg = /^\/avatar\/[A-Za-z0-9:._-]+(\?[^"'<>\s]*)?$/.test(avatar);
    var attrs = {
      class: ringClass(id, who.isBot) + (hasImg ? ' has-img' : '') + (who.cls ? ' ' + who.cls : ''),
      'data-frp-avatar': id,
      'data-frp-name': name,
      title: name + (who && who.isBot ? '（人机）' : ''),
      role: 'button',
      tabindex: '0',
      'aria-label': '对 ' + name + ' 做点什么',
    };
    if (who && who.size) attrs.style = '--frp-avatar-size:' + Number(who.size) + 'px';
    var children = [
      el('span', { class: 'frp-avatar-face', text: [...name].slice(0, 2).join('') || '?' }),
    ];
    if (hasImg) {
      // 图片加载失败（例如刚删了头像、或者旧缓存地址 404）时，退回名字首字：
      // 光把 <img> 藏掉不够 —— `.has-img` 会让 `.frp-avatar-face` 一直 display:none。
      var img = el('img', {
        class: 'frp-avatar-img',
        src: avatar,
        alt: '',
        loading: 'lazy',
        draggable: 'false',
      });
      img.addEventListener('error', function () {
        var box = img.parentNode;
        img.remove();
        if (box) box.classList.remove('has-img');
      });
      children.unshift(img);
    }
    return el('span', attrs, children);
  }

  /** 找一个**看得见**的头像元素（同一个 id 可能同时出现在房间列表和牌桌上）。 */
  function findAvatar(id) {
    if (!ok(id)) return null;
    var list = doc.querySelectorAll('[data-frp-avatar="' + id + '"]');
    for (var i = 0; i < list.length; i++) {
      var rect = list[i].getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return list[i];
    }
    return null;
  }

  function centerOf(node) {
    if (!node) {
      return { x: root.innerWidth / 2, y: root.innerHeight * 0.62 };
    }
    var r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /* ============================== 音效（现场合成，不要音频文件） ============================== */

  var actx = null;

  function unlockAudio() {
    try {
      if (!actx) {
        var Ctor = root.AudioContext || root.webkitAudioContext;
        if (!Ctor) return null;
        actx = new Ctor();
      }
      if (actx.state === 'suspended') actx.resume();
      return actx;
    } catch (err) {
      return null;
    }
  }

  function noiseBurst(dur, freq, gain) {
    var ctx = unlockAudio();
    if (!ctx) return;
    var frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = freq;
    var g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start();
  }

  function tone(freq, dur, gain, type, delay) {
    var ctx = unlockAudio();
    if (!ctx) return;
    var osc = ctx.createOscillator();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    var g = ctx.createGain();
    var t0 = ctx.currentTime + (delay || 0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function playSound(what) {
    if (!soundEnabled) return;
    try {
      if (what === 'throw') {
        // 出手：「嗖」一下（一段快速下滑的噪声）
        noiseBurst(0.16, 1400, 0.16);
        tone(520, 0.09, 0.05, 'triangle');
      } else if (what === 'egg') {
        // 鸡蛋：啪叽
        noiseBurst(0.22, 700, 0.3);
        tone(180, 0.14, 0.12, 'sawtooth');
      } else {
        // 鲜花：两声轻脆的铃
        tone(880, 0.22, 0.1, 'sine');
        tone(1320, 0.26, 0.07, 'sine', 0.08);
      }
    } catch (err) { /* 音效失败不该影响互动本身 */ }
  }

  /* ============================== 特效 ============================== */

  var layer = null;
  var liveFx = 0;

  function fxLayer() {
    if (layer && doc.body.contains(layer)) return layer;
    layer = el('div', { class: 'frp-fx-layer', 'aria-hidden': 'true' });
    doc.body.appendChild(layer);
    return layer;
  }

  function setFx(on) {
    fxEnabled = !!on;
  }

  /**
   * 抛物线的起点。
   *
   * ⚠️ 头像找不到时**不要**退回"屏幕中间"（原来就是这么写的）：一颗鸡蛋会凭空从
   * 版面正中出现，看起来像"路径不对"。人不见了多半是"对方在另一个屏幕上"，
   * 那就让它**从目标正上方落下来** —— 这是"有人从画外扔过来"的自然读法。
   */
  function originFor(fromEl, target) {
    if (fromEl) return centerOf(fromEl);
    var w = root.innerWidth || 360;
    return {
      x: Math.max(36, Math.min(w - 36, target.x)),
      y: Math.max(24, target.y - Math.min(260, (root.innerHeight || 640) * 0.34)),
    };
  }

  /**
   * 抛物线：从 A 飞向 B，命中后在 B 上炸开。动画时长跟着距离走，
   * 所以"近处的头像"不会飞得像慢动作。
   *
   * 【两个必须记住的坑】
   * 1. `translate(-50%,-50%)` 要写进**每一个关键帧**。CSS 里那句基线 transform
   *    会被 WAAPI 的关键帧整个覆盖 —— 覆盖掉之后元素是按**左上角**对准目标点的，
   *    于是鸡蛋和碎裂特效天然偏右下半个身位，砸不到头像中心
   *    （用户就是这么反馈的："没有扔到对方头像中心"）。
   * 2. 轨迹要在页面里**采样成一条二次贝塞尔**（而不是只给"中点抬高"三个关键帧）：
   *    三个关键帧之间的插值是直线，配上有回弹感的缓动曲线看着就别扭。
   *    采样 18 个点 + linear，弧线是数学上正确的那条。
   */
  function play(kind, fromId, toId) {
    if (liveFx >= MAX_FX) return;      // 技术性兜底（见文件头）
    if (!fxEnabled || (root.FrpAnim && root.FrpAnim.reducedMotion && root.FrpAnim.reducedMotion())) {
      return;
    }
    var meta = (P.REACT_KINDS && P.REACT_KINDS[kind]) || null;
    if (!meta) return;

    var fromEl = findAvatar(fromId);
    var toEl = findAvatar(toId);
    var b = centerOf(toEl);
    var a = originFor(fromEl, b);

    playSound('throw');

    var layerNode = fxLayer();
    var node = el('div', { class: 'frp-fx-projectile', text: meta.emoji });
    node.style.left = a.x + 'px';
    node.style.top = a.y + 'px';
    layerNode.appendChild(node);
    liveFx += 1;

    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    // 弧顶抬多高：跟着距离走，近处别抬成烟花，远处也别像平推
    var lift = Math.max(52, Math.min(190, dist * 0.42));
    var cx = a.x + dx * 0.5;
    var cy = a.y + dy * 0.5 - lift;
    var spin = (Math.random() > 0.5 ? 1 : -1) * (300 + Math.random() * 300);
    // 时长也跟距离走：480~900ms。原来最短 320ms，手机上快得像"闪一下"
    var dur = Math.max(480, Math.min(900, 300 + dist * 0.9));

    var frames = [];
    var STEPS = 18;
    for (var i = 0; i <= STEPS; i++) {
      var t = i / STEPS;
      var mt = 1 - t;
      var x = mt * mt * a.x + 2 * mt * t * cx + t * t * b.x;
      var y = mt * mt * a.y + 2 * mt * t * cy + t * t * b.y;
      frames.push({
        // ⚠️ 每个关键帧都要带上 -50%/-50%（见上面第 1 条）
        transform: 'translate(-50%,-50%) translate(' + (x - a.x).toFixed(2) + 'px,' + (y - a.y).toFixed(2) + 'px)'
          + ' scale(' + (1 + 0.22 * Math.sin(Math.PI * t)).toFixed(3) + ')'
          + ' rotate(' + (spin * t).toFixed(1) + 'deg)',
        offset: t,
      });
    }

    var done = function () {
      liveFx = Math.max(0, liveFx - 1);
      if (node.parentNode) node.parentNode.removeChild(node);
      burst(kind, toId, toEl);
    };

    try {
      var anim = node.animate(frames, { duration: dur, easing: 'linear' });
      anim.onfinish = done;
      anim.oncancel = done;
    } catch (err) {
      // 老浏览器没有 WAAPI：直接出结果，不飞
      done();
    }
  }

  /** 命中：碎裂 / 绽放 + 音效；目标是自己的时候再补一句提示。 */
  function burst(kind, toId, toEl) {
    var meta = (P.REACT_KINDS && P.REACT_KINDS[kind]) || null;
    if (!meta) return;
    // ⚠️ 现找一次：飞行要几百毫秒，这期间界面可能重画过（传进来的那个元素已经脱了 DOM，
    //    脱了 DOM 的元素 getBoundingClientRect() 全是 0 → 特效会炸在屏幕左上角）
    var node = findAvatar(toId) || toEl;
    var at = centerOf(node);

    var layerNode = fxLayer();
    var fx = el('div', { class: 'frp-fx-burst ' + (kind === 'egg' ? 'is-egg' : 'is-flower'), text: meta.emoji });
    fx.style.left = at.x + 'px';
    fx.style.top = at.y + 'px';
    layerNode.appendChild(fx);
    playSound(kind === 'egg' ? 'egg' : 'flower');

    var remove = function () {
      if (fx.parentNode) fx.parentNode.removeChild(fx);
    };
    try {
      // 同样：-50%/-50% 必须写在每一个关键帧里，否则碎裂会偏出头像
      var anim = fx.animate([
        { transform: 'translate(-50%,-50%) scale(0.35) rotate(-12deg)', opacity: 0.95 },
        { transform: 'translate(-50%,-50%) scale(1.5) rotate(10deg)', opacity: 0.5, offset: 0.55 },
        { transform: 'translate(-50%,-50%) scale(1.9) rotate(18deg)', opacity: 0 },
      ], { duration: 620, easing: 'ease-out' });
      anim.onfinish = remove;
      anim.oncancel = remove;
    } catch (err) {
      root.setTimeout(remove, 620);
    }

    if (toId === meId()) {
      UI.toast('你被扔了一个' + meta.label + meta.emoji, kind === 'egg' ? 'error' : 'ok', 1600);
    }
  }

  /* ============================== 锁定态 + 头像点击策略（§9.6） ============================== */

  /** 当前锁定态：`null` / `'egg'` / `'flower'`（两个图标天然互斥 —— 同一时刻只有一个值） */
  var armedKind = null;
  /** 游戏注册的头像点击策略（`null` = 没注册 = 老行为） */
  var avatarPolicy = null;
  /** 顶栏图标挂高亮用的属性（高亮样式在 ui.css 的 `[data-frp-arm].is-armed` 里） */
  var ARM_ATTR = 'data-frp-arm';

  /** 认得的 kind → 原样返回；别的（含 null / 空串 / 乱写）→ `null` = 取消锁定。 */
  function normalizeKind(kind) {
    if (kind === null || kind === undefined) return null;
    var k = String(kind);
    return (P.REACT_KINDS && P.REACT_KINDS[k]) ? k : null;
  }

  /**
   * 把锁定态刷到界面上：带 `data-frp-arm` 的元素，值等于当前 kind 的挂 `.is-armed`。
   * ⚠️ 只加 / 只减平台这一个类，**不动游戏自己的类名**（三个游戏各有各的图标样式）。
   */
  function syncArmedNodes() {
    var list = doc.querySelectorAll('[' + ARM_ATTR + ']');
    for (var i = 0; i < list.length; i++) {
      var node = list[i];
      var on = !!armedKind && String(node.getAttribute(ARM_ATTR)) === armedKind;
      var cls = String(node.className || '').split(/\s+/).filter(function (c) {
        return c && c !== 'is-armed';
      });
      if (on) cls.push('is-armed');
      node.className = cls.join(' ');
      node.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /**
   * 进入 / 切换 / 取消锁定态（同一个图标再点一次就是取消）。
   * @returns {string|null} 新的锁定态
   */
  function arm(kind) {
    armedKind = normalizeKind(kind);
    syncArmedNodes();
    return armedKind;
  }

  function armed() { return armedKind; }

  /** 游戏注册 / 注销头像点击策略（`fn(id) → 'menu' | 'throw' | 'game'`）。 */
  function setAvatarPolicy(fn) {
    avatarPolicy = (typeof fn === 'function') ? fn : null;
    return avatarPolicy;
  }

  /**
   * 头像被"点"（鼠标与键盘共用这一条）时该怎么办。
   *
   * 分支顺序是**契约**（设计文档 §9.6），不许调换：
   *   1. id 不合法 → 不吞，放行；
   *   2. 自己 → 不吞，放行（游戏要用这次点击开"我的武将"面板）；
   *   3. 注册了策略 → 按返回值：'game' 放行 / 'throw' 直接扔并吞掉 / 'menu' 老行为；
   *   4. 没注册策略 → 锁定了就扔，否则老行为。
   * @returns {boolean} true = 平台处理了（调用方要吞掉事件）；false = 交还页面
   */
  function handleAvatar(node) {
    var id = node.getAttribute('data-frp-avatar');
    if (!ok(id)) return false;                       // 1
    if (id === meId()) return false;                 // 2

    if (avatarPolicy) {                              // 3
      var verdict = null;
      // 策略是游戏写的代码：它抛异常也不能把这一下点击变成"点了没反应"
      try { verdict = avatarPolicy(id); } catch (err) { verdict = null; }
      if (verdict === 'game') return false;
      if (verdict === 'throw') {
        if (armedKind) { fire(id, armedKind); return true; }
        openMenu(node); return true;                // 没锁定就没东西可扔 → 老行为（别让点击变成死的）
      }
      openMenu(node); return true;                  // 'menu' 与认不出来的返回值
    }

    if (armedKind) { fire(id, armedKind); return true; }   // 4
    openMenu(node);
    return true;
  }

  /* ============================== 选择菜单 ============================== */

  var menu = null;

  function closeMenu() {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
    doc.removeEventListener('keydown', onKey, true);
    root.removeEventListener('scroll', closeMenu, true);
  }

  function onKey(event) {
    if (event.key === 'Escape') closeMenu();
  }

  /** 对某个人弹出「扔鸡蛋 / 送鲜花」（点任意头像都会走到这里）。 */
  function openMenu(targetEl) {
    var id = targetEl.getAttribute('data-frp-avatar');
    // 自己的头像不给菜单：对自己扔东西没有意义，弹出来只会让人困惑
    if (!ok(id) || id === meId()) return;
    var name = targetEl.getAttribute('data-frp-name') || '这个人';

    closeMenu();
    unlockAudio();     // 顺手解锁 WebAudio（必须在一次用户手势里）

    menu = el('div', { class: 'frp-react-menu', role: 'dialog', 'aria-label': '对 ' + name + ' 做点什么' }, [
      el('p', { class: 'frp-react-menu-title', text: '对「' + name + '」' }),
      el('div', { class: 'frp-react-menu-actions' }, [
        el('button', {
          class: 'frp-btn frp-react-btn', type: 'button',
          onclick: function () { fire(id, 'egg'); },
        }, ['🥚 扔鸡蛋']),
        el('button', {
          class: 'frp-btn frp-react-btn', type: 'button',
          onclick: function () { fire(id, 'flower'); },
        }, ['🌸 送鲜花']),
      ]),
      el('button', {
        class: 'frp-btn frp-btn-ghost frp-react-cancel', type: 'button',
        onclick: closeMenu,
      }, '取消'),
    ]);
    doc.body.appendChild(menu);

    // 贴着头像放，但要夹在屏幕里（手机上头像常常贴边）
    var r = targetEl.getBoundingClientRect();
    var box = menu.getBoundingClientRect();
    var left = Math.min(Math.max(8, r.left + r.width / 2 - box.width / 2), root.innerWidth - box.width - 8);
    var top = r.top - box.height - 10;
    if (top < 8) top = Math.min(r.bottom + 10, root.innerHeight - box.height - 8);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    doc.addEventListener('keydown', onKey, true);
    root.addEventListener('scroll', closeMenu, true);
  }

  /** 记一次"我这边已经播过了"（回声要靠它消费掉）。 */
  function noteOwnSend(to, kind) {
    ownSends.push({ to: to, kind: kind, at: Date.now() });
    if (ownSends.length > 12) ownSends.shift();
  }

  /** 这条是不是我自己的回声？（是的话消费掉、不重复播） */
  function takeOwnSend(to, kind) {
    var now = Date.now();
    for (var i = 0; i < ownSends.length; i++) {
      var s = ownSends[i];
      if (s.to === to && s.kind === kind && now - s.at < 8000) {
        ownSends.splice(i, 1);
        return true;
      }
    }
    // 顺手丢掉过期的，别让列表一直留着
    ownSends = ownSends.filter(function (s) { return now - s.at < 8000; });
    return false;
  }

  /**
   * 发出去：**先发消息，成了再播本地**（不等服务器回包）。
   *
   * ⚠️ 这里是"立刻有反应"，和**游戏动作**完全不是一回事 —— 别把两者混起来：
   *   · 互动（扔鸡蛋/鲜花）**没有权威状态**，最坏情况就是"多飞了一个鸡蛋"，
   *     画面永远不会和真实世界分家，所以发起人这边保留"点下去立刻飞"。
   *   · 游戏动作**有权威状态**（血量/回合/胜负），所以那边**不做本地预演** ——
   *     用户实测快速连点会把画面演成"所有人都被打死了"，完整教训见 D10。
   * `noteOwnSend` 是为了服务端把同一条广播回来时**不重复飞第二遍**。
   */
  function fire(to, kind) {
    closeMenu();
    if (!ok(to)) return;
    var mine = meId();
    // 连不上就别播了：播了服务器也不知道，界面会和真实世界对不上
    var sent = Net.send(P.T.REACT_SEND, { to: to, kind: kind });
    if (!sent) { UI.toast('还没连上服务器，稍等一下', 'error'); return; }
    // 自己的动画立刻出；服务端回执回来时靠 noteOwnSend 认出来、不重复播
    noteOwnSend(to, kind);
    play(kind, mine, to);
  }

  /* ============================== 接线 ============================== */

  var bound = false;

  function bind() {
    if (bound) return;
    bound = true;

    // 事件代理：头像被反复重画（三个游戏每次收到 view 都会重画），
    // 所以在 document 上听一次点击就够了，不要给每个头像挂监听。
    // ⚠️ 捕获阶段：`handleAvatar` 说"放行"时**一个字节都不许动事件**
    //    （尤其是别 preventDefault —— 那是"点了没反应"的根因）。
    doc.addEventListener('click', function (event) {
      var node = event.target && event.target.closest ? event.target.closest('[data-frp-avatar]') : null;
      if (!node) return;
      if (!handleAvatar(node)) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);

    // 键盘也能用（头像带 role=button / tabindex）—— **和鼠标同一条策略**
    doc.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var node = event.target && event.target.closest ? event.target.closest('[data-frp-avatar]') : null;
      if (!node) return;
      if (!handleAvatar(node)) return;
      event.preventDefault();     // 顺便挡掉 Space 滚动页面
      event.stopPropagation();
    }, true);

    // 第一次手势时把 AudioContext 建起来（浏览器要求）
    doc.addEventListener('pointerdown', function () { unlockAudio(); }, { once: true, capture: true });

    Net.on(P.T.REACT, function (msg) {
      if (!msg || !msg.from || !msg.kind) return;
      // 自己的回声：本地已经乐观播过了，别播第二遍
      if (msg.from.id === meId() && takeOwnSend(msg.to, msg.kind)) return;
      play(msg.kind, msg.from.id, msg.to);
    });
  }

  root.FrpReact = {
    bind: bind,
    ringClass: ringClass,
    avatarEl: avatarEl,
    openMenu: openMenu,
    play: play,
    setFx: setFx,
    setSound: function (on) { soundEnabled = !!on; },
    isFxEnabled: function () { return fxEnabled; },
    isSoundEnabled: function () { return soundEnabled; },
    // §9.6：锁定式互动 + 头像点击策略（不调这几个的页面 = 老行为）
    arm: arm,
    armed: armed,
    setAvatarPolicy: setAvatarPolicy,
    /** 顶栏图标重新渲染之后可以调一下（把高亮重新挂上）；平时 `arm()` 就够了 */
    syncArmed: syncArmedNodes,
  };

  // 脚本一加载就接上：`#online-panel` 里的头像可能在 bind() 之前就画好了，
  // 事件代理是听在 document 上的，所以什么时候接上都来得及。
  bind();
})(typeof window !== 'undefined' ? window : globalThis);