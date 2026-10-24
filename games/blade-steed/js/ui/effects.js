/**
 * BladeSteed — 特效层
 *
 * 设计原则：**只做便宜的事**。
 *   · 飞行物：一个 SVG 元素 + CSS transform 补间，浏览器走合成层，不占主线程
 *   · 爆开：用 Web Animations API 放射几颗粒子（最多 9 颗），动画结束立刻从 DOM 摘掉
 *   · 飘字 / 刀光：一段 CSS 动画，定时器到点删除
 * 全程没有 rAF 轮询、没有逐帧计算，所以手机上也稳。
 *
 * 关掉特效（body.no-fx）时，飞行物与粒子一律不创建，只保留必要的位移过渡。
 */

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export class Effects {
  /** @param {import('./map.js').MapBoard} board */
  constructor(board) {
    this.board = board;
    this.enabled = true;
    this._banner = null;
  }

  get fx() {
    return this.board.fx;
  }

  /* ------------------------------ 攻击特效 ------------------------------ */

  /** 刀光 */
  slash(pos) {
    if (!this.enabled) return;
    const g = el('g', { class: 'slash-g', transform: `translate(${pos.x}, ${pos.y})` });
    const line = el('path', { class: 'slash', d: 'M -16 -14 L 16 14', 'stroke-dasharray': '46', 'stroke-dashoffset': '46' });
    const line2 = el('path', { class: 'slash', d: 'M -14 15 L 15 -13', 'stroke-dasharray': '44', 'stroke-dashoffset': '44' });
    g.append(line, line2);
    this.fx.append(g);
    setTimeout(() => g.remove(), 380);
  }

  /** 踹击：一脚踢过去的弧线 */
  kick(fromPos, toPos) {
    if (!this.enabled) return;
    const g = el('g', { class: 'kick-g' });
    const midX = (fromPos.x + toPos.x) / 2;
    const midY = (fromPos.y + toPos.y) / 2;
    const foot = el('text', { class: 'fly-item', x: 0, y: 0 });
    foot.textContent = '🦶';
    g.append(foot);
    g.style.transform = `translate(${fromPos.x}px, ${fromPos.y}px)`;
    this.fx.append(g);
    foot.animate(
      [
        { transform: 'translate(0px,0px) scale(.8)', opacity: 0.6 },
        { transform: `translate(${midX - fromPos.x}px, ${midY - fromPos.y}px) scale(1.3)`, opacity: 1 },
        { transform: `translate(${toPos.x - fromPos.x}px, ${toPos.y - fromPos.y}px) scale(1)`, opacity: 0.9 },
      ],
      { duration: 340, easing: 'cubic-bezier(.3,.8,.4,1)', fill: 'forwards' }
    );
    setTimeout(() => g.remove(), 420);
  }

  /** 飘一个数字上去（伤害） */
  damage(pos, text, color) {
    if (!this.enabled) return;
    const t = el('text', { class: 'dmg-float', x: pos.x, y: pos.y - 18, fill: color || '#ff7b7b' });
    t.textContent = text;
    this.fx.append(t);
    setTimeout(() => t.remove(), 950);
  }

  /** 头像上方冒一行小字（买刀 / 出城 / 进城…） */
  pop(pos, text, color) {
    if (!this.enabled) return;
    const t = el('text', { class: 'pop-text', x: pos.x, y: pos.y - 20, fill: color || '#ffb454' });
    t.textContent = text;
    this.fx.append(t);
    setTimeout(() => t.remove(), 950);
  }

  /* ------------------------------ 中央横幅 ------------------------------ */

  /** 屏幕中央的播报（谁赢、几步、行动顺序…） */
  banner(text, ms = 1600) {
    if (!this._banner) {
      this._banner = document.createElement('div');
      this._banner.className = 'banner';
      document.body.append(this._banner);
    }
    const b = this._banner;
    b.textContent = text;
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
  }

  /** 清空所有还在飞的特效（比如重新开局时） */
  clear() {
    for (const node of [...this.fx.children]) node.remove();
  }
}