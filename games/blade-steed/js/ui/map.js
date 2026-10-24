/**
 * BladeSteed — 战场地图（SVG）
 *
 * 规则里「位置」只有两种：某人的城内 / 野外。
 * 地图把它画成：中间一片【野外】，四周环绕 N 座【城】（N = 本局人数）。
 * 开局随机分配的座位号决定谁在哪座城，头像就摆在他当前所在的位置上。
 *
 * 为什么要用 SVG 而不是 canvas：
 *   · 血量条 / 装备标记 / 飘字都是普通 DOM，改属性就行，不用自己写绘制
 *   · 位置变化直接改 transform，浏览器自己补间，动画平滑且不占主线程
 *   · 缩放自适应，手机/电脑一套代码（只用 viewBox 里的用户坐标，不量像素）
 *
 * 【互动（扔鸡蛋 / 鲜花）怎么来的】
 * 搬家时删掉了自己那套互动（原项目靠一条"没有服务器时"的广播通道），
 * 现在它是**平台的一件共用能力**（shared/ui/react.js）：只要给元素加上
 * `data-frp-avatar="<玩家 id>"`（可选 `data-frp-name="<单字名>"`），
 * 平台就在 document 上做事件代理 —— 弹菜单、抛物线、碎裂特效、提示条全包。
 * 所以本文件**一行互动代码都没有**，只有那两个属性（SVG 的 `<g>` 也能命中 closest）。
 *
 * 【圆环配色是语义，不是装饰】
 * 自己=蓝 / 其他真人=橙 / 人机=灰，和 `FrpReact.ringClass(id, isBot)` 同一套判定
 * （ui.css 里 `.frp-avatar` 用的也是这三个色）。SVG 的 `.tok-face` 就是那个圈，
 * 所以颜色落在它的 stroke 上（见 css/style.css）。
 */

const NS = 'http://www.w3.org/2000/svg';

/*
 * 【用户坐标与缩放：为什么这里不再是一个写死的 viewBox】
 *
 * 用户报过「手机端地图和头像太小」。根因是**画布比内容大**：
 * 原来 viewBox 写死 400×340，而 2 人局的内容只有 340×104（两座城左右排开），
 * 于是 SVG 按 min(容器宽/400, 容器高/340) 缩放之后，地图在 360×640 的手机上
 * 只占中间一条小带子（实测：地图 332×294、头像直径 20.6px）。
 *
 * 现在：图形中心固定 (CX, CY)，**每局的 viewBox 由 `_viewBox()` 紧贴内容算出来**
 * （城 / 野外 / 头像热区都算进去，再留一点边距），内容因此能吃到容器。
 * 2 人局的城还从"左右"改成"斜对角"——左右排是横带，竖屏手机上永远缩得很小。
 *
 * ⚠️ 仍然只用 viewBox 用户坐标，**绝不量像素**（不调用 getBoundingClientRect）：
 *    联机第一次渲染时这个 SVG 还没插进文档，量出来全是 0（见 js/ui/board.js 的注释）。
 * ⚠️ 改这些数字之后**必须重跑** `tests/browser.size.mjs`（四个视口的实测数字）
 *    和 `tests/browser.e2e.mjs` 的 avatarHotzones（热区 ≥44px）。
 */
const CX = 200;
const CY = 170;

/** 不同人数下的布局参数（用户坐标） */
const LAYOUT = {
  // 2 人：斜对角排开（原来是 180/0 = 左右，内容是一条扁带子）
  2: { cityR: 42, dist: 92, wildR: 40, angles: [-135, 45] },
  3: { cityR: 38, dist: 88, wildR: 40, angles: [-90, 30, 150] },
  4: { cityR: 38, dist: 88, wildR: 40, angles: [-90, 0, 90, 180] },
};

/**
 * 头像**脸**的半径（视觉）。
 * ⚠️ 它和点击热区（HIT_R）是两件事：脸负责好看，热区负责"手指点得到"。
 *    脸变大之后热区只能跟着变大或不变，**绝不许变小**（平台硬指标 ≥44px）。
 */
const AVATAR_R = 17;
const HP_Y = 21;
const HP_W = 36;
const HP_H = 7;
const EQ_Y = 32;
/** 同一地点有多人时的环形站位半径（要容得下更大的脸，不然头像会叠在一起） */
const RING_R = 24;
/**
 * 点击热区半径（**用户坐标**，不是像素）。
 *
 * ⚠️ 平台上"可点区域 ≥44px"是硬指标，而 SVG 会被缩放到容器里
 * （preserveAspectRatio="xMidYMid meet" → 实际缩放 = min(容器宽/viewBox宽, 容器高/viewBox高)）。
 * HIT_R=26（用户坐标直径 52）在**已实测的四个视口**里最小的那一个是 360×640 的
 * 单机 4 人局 = **61.8px**（联机 2 人局同视口 68.3px）—— 具体数字见
 * tests/browser.size.mjs 每次跑出来的表。
 * ⚠️ 没有实测的是"联机 4 人局"（`browser.size.mjs` 只量单机 4 人与联机 2 人）：
 *    它的内容比 2 人局大、缩放系数更小，真要改到那种桌型，先补一条实测再说。
 * 这就是为什么它比视觉半径（AVATAR_R=17）大一圈。
 * ⚠️ 改 HIT_R、改 viewBox、改地图容器高度**都必须重跑** tests/browser.size.mjs。
 */
const HIT_R = 26;
/** viewBox 在内容之外留的边距（用户坐标）：别让最边上的城/血条贴着地图边框 */
const PAD = 6;
/** 头像里那行名字最多占多宽（用户坐标；头像圆直径 2 × AVATAR_R = 34）。
 *  名字超过一个字就用 textLength 压进这个宽度里（平台昵称可能是好几个字）。
 *  压字形而不是量像素，符合本文件"只用 viewBox"的约定。 */
const CHAR_MAX_W = 30;

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** 单人/多人站在同一个地点时的环形分布 */
function ringOffsets(count, radius) {
  if (count <= 0) return [];
  if (count === 1) return [{ dx: 0, dy: 0 }];
  const start = -Math.PI / 2 - (count === 2 ? Math.PI / 2 : 0);
  return Array.from({ length: count }, (_, i) => {
    const a = start + (i * 2 * Math.PI) / count;
    return { dx: Math.cos(a) * radius, dy: Math.sin(a) * radius };
  });
}

/**
 * 这个头像的圆环该是什么颜色（返回一个类名）：自己=蓝 / 其他真人=橙 / 人机=灰。
 *
 * 判定**借平台的手**（`FrpReact.ringClass(id, isBot)`，它认识"谁是我"），
 * 这样三个游戏的规则不可能分叉。但它的返回值是 `frp-avatar is-me|is-human|is-bot`
 * —— `.frp-avatar` 那个类带着 border / 尺寸，套到 SVG 的 `<g>` 上会把图形毁掉，
 * 所以这里只取状态那一段。
 * 平台脚本万一没加载（react.js 挂了）就自己按 selfId 判一次，不能让地图画不出来。
 */
function ringState(id, isBot, selfId) {
  // 「是不是我」本地就有答案（selfId 是渲染时一路带下来的），先判掉 —— 不依赖平台脚本、
  // 也不依赖 Net.me 到没到，自己永远是蓝的。
  if (id === selfId) return 'is-me';
  const React = typeof window !== 'undefined' ? window.FrpReact : null;
  if (React && typeof React.ringClass === 'function') {
    const cls = String(React.ringClass(id, !!isBot) || '');
    if (cls.indexOf('is-bot') >= 0) return 'is-bot';
    if (cls.indexOf('is-human') >= 0) return 'is-human';
  }
  // react.js 没加载（或它改了类名）时的兜底：身份来自视图的 isAI（见 js/view.js）。
  return isBot ? 'is-bot' : 'is-human';
}

export class MapBoard {
  /** @param {SVGElement} svg */
  constructor(svg) {
    this.svg = svg;
    // 真正的 viewBox 每局按人数算（见 _viewBox）；这里先给一个占位，
    // 免得首帧（还没 render）显示成"没有画布"。
    this.svg.setAttribute('viewBox', `${CX - 150} ${CY - 150} 300 300`);

    // 分层：静态底图 / 头像 / 特效（特效永远在最上面）
    this.baseLayer = el('g', { class: 'layer-base' });
    this.tokenLayer = el('g', { class: 'layer-tokens' });
    this.fxLayer = el('g', { class: 'layer-fx' });
    this.svg.replaceChildren(this.baseLayer, this.tokenLayer, this.fxLayer);

    /** pid → { g, face, char, hpFill, hpText, eqKnife, eqHorse } */
    this.nodes = new Map();
    /** pid → {x,y} 当前坐标（特效要用） */
    this.pos = new Map();
    this.signature = '';
    this.selfId = null;
  }

  /** 特效挂在这一层上 */
  get fx() {
    return this.fxLayer;
  }

  /** 某个头像此刻的坐标 */
  posOf(pid) {
    return this.pos.get(pid) || { x: CX, y: CY };
  }

  /** 某个头像「上一步」的坐标（特效回放用） */
  prevPosOf(pid) {
    return (this.prevPos && this.prevPos.get(pid)) || this.posOf(pid);
  }

  /* ------------------------------ 底图 ------------------------------ */

  /**
   * 这一局的 viewBox：**紧贴内容**（野外 / 各座城 / 头像的热区）算出来的。
   *
   * 为什么要算：viewBox 写死的话，"内容占多少"完全看人数 —— 2 人局原来是一条
   * 340×104 的横带，缩放系数被那个 400×340 的画布压到 0.8 左右，头像只有 20px。
   * 紧贴内容之后同样的容器能放大 30% 以上（实测数字见 tests/browser.size.mjs）。
   *
   * ⚠️ 半径要取 `max(cityR, RING_R + HIT_R)`：同一个地点站了好几个人时，
   *    他们按 RING_R 环形分布，最外面那个的热区还会再往外伸 HIT_R ——
   *    不把它算进去，边上的头像会被 SVG 视口裁掉（看得见摸不着）。
   * ⚠️ 纯用户坐标计算，不量像素（本文件的铁律，见文件头）。
   */
  _viewBox(layout, bySeat) {
    const spotR = Math.max(layout.cityR, RING_R + HIT_R);
    let rx = Math.max(layout.wildR, spotR);
    let ry = rx;
    bySeat.forEach((p, i) => {
      const a = (layout.angles[i] * Math.PI) / 180;
      rx = Math.max(rx, Math.abs(Math.cos(a)) * layout.dist + spotR);
      ry = Math.max(ry, Math.abs(Math.sin(a)) * layout.dist + spotR);
    });
    return `${CX - rx - PAD} ${CY - ry - PAD} ${(rx + PAD) * 2} ${(ry + PAD) * 2}`;
  }

  _buildBase(players) {
    const n = Math.max(2, Math.min(4, players.length));
    const layout = LAYOUT[n];
    const sig = `${n}:${players.map((p) => p.id).sort().join(',')}`;
    if (sig === this.signature) return layout;
    this.signature = sig;

    const bySeat = [...players].sort((a, b) => a.seat - b.seat);
    this.baseLayer.replaceChildren();

    // 画布跟着这一局的内容走（人数变了 viewBox 就变，见 _viewBox）
    this.svg.setAttribute('viewBox', this._viewBox(layout, bySeat));

    // 野外（中间那块公共区域）
    this.baseLayer.append(el('circle', { class: 'wild-ring', cx: CX, cy: CY, r: layout.wildR }));
    const wildName = el('text', { class: 'wild-name', x: CX, y: CY - layout.wildR + 14 });
    wildName.textContent = '野 外';
    this.baseLayer.append(wildName);
    this.wildLabelY = CY - layout.wildR + 14;

    // 每座城（城属于玩家，永久存在）
    this.cityPos = new Map();
    bySeat.forEach((p, i) => {
      const a = (layout.angles[i] * Math.PI) / 180;
      const x = CX + Math.cos(a) * layout.dist;
      const y = CY + Math.sin(a) * layout.dist;
      this.cityPos.set(p.id, { x, y, r: layout.cityR });
      this.baseLayer.append(el('circle', { class: 'city-ring', cx: x, cy: y, r: layout.cityR, 'data-city': p.id }));
    });
    this.layout = layout;
    return layout;
  }

  /* ------------------------------ 头像 ------------------------------ */

  _makeToken(p) {
    /*
     * `data-frp-avatar` 是**平台互动**的入口（扔鸡蛋 / 送鲜花，见 shared/ui/react.js）：
     * 它的事件代理挂在 document 上、用 closest('[data-frp-avatar]') 找目标，
     * 所以 SVG 的 <g> 一样好使 —— 前提是热区够大（`.tok-hit` 的半径见 HIT_R）。
     * 点了自己的头像不会有菜单（react.js 里直接 return），所以自己那份留着没有副作用。
     */
    const g = el('g', { class: 'token', 'data-pid': p.id, 'data-frp-avatar': p.id, 'data-frp-name': p.name });
    // 透明的大热区：手机上也好点（实际像素尺寸见 HIT_R 的注释）
    const hit = el('circle', { cx: 0, cy: 0, r: HIT_R, fill: 'transparent', class: 'tok-hit', 'data-pid': p.id });
    const face = el('circle', { class: 'tok-face', cx: 0, cy: 0, r: AVATAR_R });
    /*
     * 平台头像：画在脸那个圆里（clipPath 裁成圆），所以圆环 / 血条 / 装备都不受影响。
     * 地址只从房间成员列表拿 —— viewFor 里没有 avatar，也别往视图里加。
     */
    const clipId = 'tok-clip-' + String(p.id).replace(/[^A-Za-z0-9_-]/g, '_');
    const defs = el('defs');
    const clip = el('clipPath', { id: clipId });
    clip.append(el('circle', { cx: 0, cy: 0, r: AVATAR_R }));
    defs.append(clip);
    const img = el('image', {
      class: 'tok-img',
      x: -AVATAR_R,
      y: -AVATAR_R,
      width: AVATAR_R * 2,
      height: AVATAR_R * 2,
      preserveAspectRatio: 'xMidYMid slice',
      'clip-path': `url(#${clipId})`,
    });
    const char = el('text', { class: 'tok-char', x: 0, y: 0 });
    const hpbg = el('rect', { class: 'tok-hpbg', x: -HP_W / 2, y: HP_Y, width: HP_W, height: HP_H, rx: 3.4 });
    const hpFill = el('rect', { class: 'tok-hpfill', x: -HP_W / 2 + 0.8, y: HP_Y + 0.8, width: HP_W - 1.6, height: HP_H - 1.6, rx: 2.8 });
    const hpText = el('text', { class: 'tok-hptext', x: 0, y: HP_Y + HP_H / 2 + 0.7 });
    const eqKnife = el('text', { class: 'eq', x: -10, y: EQ_Y });
    const eqHorse = el('text', { class: 'eq', x: 10, y: EQ_Y });
    eqKnife.textContent = '刀';
    eqHorse.textContent = '马';

    /*
     * 这里**不挂任何监听**：点头像的互动由平台统一接管
     * （shared/ui/react.js 在 document 上做事件代理，认的是上面那个 data-frp-avatar）。
     * 自己再挂一份，就会出现两套菜单/两次特效。
     */
    g.append(hit, face, img, char, defs, hpbg, hpFill, hpText, eqKnife, eqHorse);
    return { g, face, img, char, hpFill, hpText, eqKnife, eqHorse, hpbg, hit };
  }

  /** 头像地址只从房间成员列表取（viewFor 里没有 avatar 字段，别加）。 */
  _avatarUrlOf(id) {
    const net = window.GameNet;
    const members = (net && net.room && net.room.members) || [];
    const m = members.find((x) => String(x.id) === String(id));
    return (m && m.avatar) || '';
  }

  /** 有头像就显示图片、藏掉单字；没有就还原成单字圆。 */
  _syncAvatarImage(node, id) {
    const url = this._avatarUrlOf(id);
    if (url) {
      if (node.img.getAttribute('href') !== url) node.img.setAttribute('href', url);
      node.img.style.display = '';
      node.char.style.display = 'none';
    } else {
      node.img.style.display = 'none';
      node.char.style.display = '';
    }
  }

  /**
   * 按一帧视图刷新地图。
   * @param {object} view viewFor(...) 的结果
   * @param {string} selfId
   */
  render(view, selfId) {
    if (!view) return;
    this.selfId = selfId;
    // 记下「这一步之前」的坐标：攻击特效要用它来确定「打之前那人站在哪」
    // （否则等渲染完再去问，人已经被踹到野外了）
    this.prevPos = new Map(this.pos);
    const players = view.players;
    const layout = this._buildBase(players);

    // 1) 每个位置上有哪些人（决定环形站位）
    const groups = new Map();
    for (const p of players) {
      const key = p.place === 'wild' ? 'wild' : `city:${p.place}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    const alive = players.filter((p) => p.alive).length;
    this.aliveCount = alive;

    // 2) 逐人更新
    const seen = new Set();
    for (const p of players) {
      seen.add(p.id);
      let node = this.nodes.get(p.id);
      if (!node) {
        node = this._makeToken(p);
        this.nodes.set(p.id, node);
        this.tokenLayer.append(node.g);
      }

      const key = p.place === 'wild' ? 'wild' : `city:${p.place}`;
      const group = groups.get(key);
      // 同一地点按座位号排一下，位置才稳定，不会每次刷新都换人
      group.sort((a, b) => a.seat - b.seat);
      const idx = group.findIndex((x) => x.id === p.id);
      const offs = ringOffsets(group.length, group.length === 1 ? 0 : RING_R);
      const off = offs[idx] || { dx: 0, dy: 0 };

      let base;
      if (p.place === 'wild') base = { x: CX, y: CY };
      else base = this.cityPos.get(p.place) || { x: CX, y: CY };
      const x = base.x + off.dx;
      const y = base.y + off.dy;
      this.pos.set(p.id, { x, y });

      // 位置变化靠 CSS transition 补间，所以只要改 transform —— 外面就看到了「走过去」的动画
      node.g.setAttribute('transform', `translate(${x}, ${y})`);

      node.char.textContent = p.name;
      this._syncAvatarImage(node, p.id);
      // 名字超过一个字（平台昵称可能是好几个字）就压进头像圆里：
      // 靠 SVG 的 textLength + spacingAndGlyphs 缩放字形，不量像素（本文件的铁律）。
      const multi = p.name.length > 1;
      node.char.setAttribute('class', multi ? 'tok-char is-long' : 'tok-char');
      if (multi) {
        node.char.setAttribute('textLength', String(CHAR_MAX_W));
        node.char.setAttribute('lengthAdjust', 'spacingAndGlyphs');
      } else {
        node.char.removeAttribute('textLength');
        node.char.removeAttribute('lengthAdjust');
      }
      // 平台互动用同一个名字（弹菜单时显示「对「虎」」）；名字不会中途变，但跟着重画一次最省心
      node.g.setAttribute('data-frp-name', p.name);
      const cls = ['token'];
      if (p.id === selfId) cls.push('is-me');
      if (!p.alive) cls.push('is-dead');
      // 人机座位（联机房间里「＋ 添加人机」加出来的）：灰圈 + 虚线圈 + 灰名字。
      // 这个字段只有**发给玩家的那一档**视图里有（js/view.js 顶部），所以单机人机的
      // 牌桌完全不受影响 —— 单机没有电脑标记是刻意的（见 docs/GAME-SPEC.md §4）。
      if (p.isAI) cls.push('is-ai', 'is-bot');
      // 圆环的语义色（自己=蓝 / 其他真人=橙 / 人机=灰）跟 FrpReact.ringClass 同一套判定：
      // 直接用它的结论，别在这里再写一遍"谁是自己"的规则。
      cls.push(ringState(p.id, !!p.isAI, selfId));
      if (view.current === p.id && view.phase === 'action') cls.push('is-current');
      node.g.setAttribute('class', cls.join(' '));

      // 血量条
      const ratio = Math.max(0, Math.min(1, p.hp / 10));
      node.hpFill.setAttribute('width', Math.max(0, (HP_W - 1.6) * ratio));
      node.hpFill.setAttribute('class', `tok-hpfill${ratio <= 0.3 ? ' low' : ratio <= 0.6 ? ' warn' : ''}`);
      node.hpText.textContent = p.alive ? String(p.hp) : '✕';

      // 装备亮暗
      node.eqKnife.setAttribute('class', `eq${p.knife ? ' has' : ''}`);
      node.eqHorse.setAttribute('class', `eq${p.horse ? ' has' : ''}`);

      node.g.style.opacity = p.alive ? '1' : '0.4';
    }

    // 3) 清掉已经不在名单里的人
    for (const [pid, node] of [...this.nodes]) {
      if (seen.has(pid)) continue;
      node.g.remove();
      this.nodes.delete(pid);
      this.pos.delete(pid);
    }

    // 4) 记下当前行动者，供外部（比如「轮到你了」的提示）查询
    this.currentPid = view.phase === 'action' ? view.current : null;
  }

  /** 高亮某个头像（被攻击时抖一下） */
  shake(pid) {
    const node = this.nodes.get(pid);
    if (!node) return;
    node.g.classList.remove('shake');
    // 强制回流，保证同一个动画能连续播两次
    void node.g.getBoundingClientRect();
    node.g.classList.add('shake');
    setTimeout(() => node.g.classList.remove('shake'), 360);
  }
}