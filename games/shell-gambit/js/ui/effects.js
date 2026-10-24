/**
 * Shell Gambit — 视觉特效
 *
 * 所有动画都只改 transform / opacity（GPU 合成），并配合 Web Animations API，
 * 做完即移除 DOM 节点，不在页面上留垃圾，保证多人对局也不卡。
 */

import { sfx } from './audio.js';

const fxLayer = () => document.getElementById('fx-layer');
const toastLayer = () => document.getElementById('toast-layer');

/* ------------------------------ 特效开关 ------------------------------ */

/*
 * 特效开关的值也在**平台那一份偏好**里（`FrpUI.prefs`，见 shared/ui/ui.js 与
 * docs/GAME-SPEC.md §7）：以前这里自己存 `sg.fx`，和平台设置栏各存各的，
 * 就会出现"平台关着、游戏里还闪"。现在只读/写那一份，老键由平台在第一次读时迁移。
 * 拿不到平台脚本时按"开着"算 —— 少一个偏好对象不该让整页特效全没。
 */
const prefs = () => (globalThis.FrpUI && globalThis.FrpUI.prefs) || null;

let fxEnabled = prefs() ? !!prefs().fx() : true;

export const isFxEnabled = () => fxEnabled;

/** 开/关特效（**写回平台那一份偏好**）。关掉后仍保留文字事件流与横幅提示，只是不再有动画。 */
export function setFxEnabled(on) {
  fxEnabled = !!on;
  const p = prefs();
  if (p) p.setFx(fxEnabled);
}

/**
 * 平台那边改了偏好之后，把值**同步**进来（app.js 的 `bindPrefs()` 订阅时调）。
 * ⚠️ 不写回 prefs（订阅回调再写回会转圈）。
 */
export function syncFxPrefs(on) {
  fxEnabled = !!on;
}

/** 元素中心点（视口坐标） */
export function centerOf(el) {
  if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * 扔东西：从 A 飞向 B，命中后在 B 上炸开。
 * @param {Element} fromEl
 * @param {Element} toEl
 * @param {'egg'|'flower'} kind
 */
export function flyProjectile(fromEl, toEl, kind) {
  if (!fxEnabled) return;
  const layer = fxLayer();
  if (!layer) return;
  const a = centerOf(fromEl);
  const b = centerOf(toEl);

  const el = document.createElement('div');
  el.className = 'fx-projectile';
  el.textContent = kind === 'egg' ? '🥚' : '🌸';
  el.style.left = `${a.x}px`;
  el.style.top = `${a.y}px`;
  layer.appendChild(el);

  sfx.play('throw');

  // 抛物线：水平线性 + 垂直用两段关键帧制造弧线
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const arc = Math.min(120, Math.abs(dx) * 0.28 + 40);
  const spin = (Math.random() > 0.5 ? 1 : -1) * (360 + Math.random() * 360);

  const anim = el.animate(
    [
      { transform: 'translate(0,0) scale(0.7) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - arc}px) scale(1) rotate(${spin * 0.5}deg)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.95) rotate(${spin}deg)`, opacity: 1 },
    ],
    { duration: Math.max(320, Math.min(700, Math.abs(dx) + Math.abs(dy))) , easing: 'cubic-bezier(.35,.55,.6,1)' }
  );

  anim.onfinish = () => {
    el.remove();
    burst(toEl, kind);
  };
  anim.oncancel = () => el.remove();
}

/** 命中绽放 / 碎裂 */
export function burst(atEl, kind) {
  if (!fxEnabled) return;
  const layer = fxLayer();
  if (!layer) return;
  const { x, y } = centerOf(atEl);

  const el = document.createElement('div');
  el.className = `fx-burst ${kind}`;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  layer.appendChild(el);

  sfx.play(kind === 'egg' ? 'splat' : 'boom');

  const anim = el.animate(
    [
      { transform: 'scale(0.3)', opacity: 0.95 },
      { transform: 'scale(1.5)', opacity: 0.5, offset: 0.55 },
      { transform: 'scale(2.1)', opacity: 0 },
    ],
    { duration: 380, easing: 'ease-out' }
  );
  anim.onfinish = () => el.remove();
  anim.oncancel = () => el.remove();

  // 被砸中的头像抖一下
  if (atEl) {
    atEl.animate(
      [
        { transform: 'translateX(0) rotate(0)' },
        { transform: 'translateX(-5px) rotate(-6deg)', offset: 0.3 },
        { transform: 'translateX(4px) rotate(5deg)', offset: 0.6 },
        { transform: 'translateX(0) rotate(0)' },
      ],
      { duration: 340, easing: 'ease-out' }
    );
  }
}

/** 枪口火光 */
export function muzzleFlash(atEl) {
  if (!fxEnabled) return;
  const layer = fxLayer();
  if (!layer) return;
  const { x, y } = centerOf(atEl);
  const el = document.createElement('div');
  el.className = 'fx-muzzle';
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  layer.appendChild(el);
  const anim = el.animate(
    [
      { transform: 'scale(0.4)', opacity: 1 },
      { transform: 'scale(1.25)', opacity: 0.65, offset: 0.4 },
      { transform: 'scale(1.5)', opacity: 0 },
    ],
    { duration: 300, easing: 'ease-out' }
  );
  anim.onfinish = () => el.remove();
  anim.oncancel = () => el.remove();
}

/** 伤害数字 */
export function damageNumber(atEl, text) {
  if (!fxEnabled) return;
  const layer = fxLayer();
  if (!layer) return;
  const { x, y } = centerOf(atEl);
  const el = document.createElement('div');
  el.className = 'fx-damage';
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y - 14}px`;
  el.style.transform = 'translate(-50%, -50%)';
  layer.appendChild(el);
  const anim = el.animate(
    [
      { transform: 'translate(-50%,-50%) scale(0.6)', opacity: 0 },
      { transform: 'translate(-50%,-90%) scale(1.25)', opacity: 1, offset: 0.25 },
      { transform: 'translate(-50%,-160%) scale(1)', opacity: 0 },
    ],
    { duration: 900, easing: 'ease-out' }
  );
  anim.onfinish = () => el.remove();
  anim.oncancel = () => el.remove();
}

/** 整屏震动（开枪时） */
export function shakeApp() {
  if (!fxEnabled) return;
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.remove('shake');
  // 强制重排，保证连续两次开枪都能重新触发动画
  void app.offsetWidth;
  app.classList.add('shake');
  setTimeout(() => app.classList.remove('shake'), 400);
}

/** 中央大字横幅 */
export function banner(text, color) {
  const el = document.getElementById('banner');
  if (!el) return;
  el.textContent = text;
  el.style.color = color || 'var(--text)';
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

/** 底部提示条 */
export function toast(text, kind) {
  const layer = toastLayer();
  if (!layer) return;
  const el = document.createElement('div');
  el.className = `toast${kind ? ` ${kind}` : ''}`;
  el.textContent = text;
  layer.appendChild(el);

  // 最多同时显示 3 条
  while (layer.children.length > 3) layer.firstElementChild.remove();

  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 260);
  }, kind === 'error' ? 3600 : 2400);
}

/** 结果弹窗 */
export function showModal({ title, body, html, onMount, actions }) {
  const layer = document.getElementById('modal-layer');
  if (!layer) return;
  layer.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'modal';
  const h = document.createElement('h3');
  h.textContent = title;
  box.appendChild(h);

  if (html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    box.appendChild(wrap);
  } else if (body) {
    const p = document.createElement('p');
    p.innerHTML = body;
    box.appendChild(p);
  }

  const acts = document.createElement('div');
  acts.className = 'modal-actions';
  for (const a of actions || []) {
    const b = document.createElement('button');
    b.className = a.primary ? 'primary-btn' : 'ghost-btn';
    b.textContent = a.label;
    b.addEventListener('click', () => {
      hideModal();
      a.onClick?.();
    });
    acts.appendChild(b);
  }
  if (acts.children.length) box.appendChild(acts);

  layer.appendChild(box);
  layer.hidden = false;
  onMount?.(box);
}

export function hideModal() {
  const layer = document.getElementById('modal-layer');
  if (!layer) return;
  layer.hidden = true;
  layer.innerHTML = '';
}