/**
 * Shell Gambit — 图标
 *
 * 全部是内联 SVG（stroke 用 currentColor），不依赖任何图标库或图片文件，
 * 因此在 GitHub Pages 上零额外请求、任意分辨率都清晰。
 */

/**
 * 每种道具的绘制路径（24×24 视图框，描边风格）。
 * 手绘简化图形，保证在 26px 下也能一眼认出。
 */
const PATHS = {
  // 放大镜：一个圈加一个手柄
  magnifier: `
    <circle cx="10.5" cy="10.5" r="6.2" />
    <path d="M15.2 15.2 L20.5 20.5" />
    <path d="M8 12.6 a3.4 3.4 0 0 1 1.4-4.4" />`,
  // 逆转器：顺时针回转型箭头
  inverter: `
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20.5 3.6v5h-5" />
    <path d="M12 8.6v6.8" />
    <path d="M9.4 13.2 12 15.8l2.6-2.6" />`,
  // 肾上腺素：注射器
  adrenaline: `
    <path d="M14.6 3.4 20.6 9.4" />
    <path d="M17.8 6.6 8.2 16.2l-3.6 1 1-3.6 9.6-9.6z" />
    <path d="M9.6 8.8l5.6 5.6" />
    <path d="M3.4 20.6l2.2-2.2" />`,
  // 啤酒：杯子
  beer: `
    <path d="M6 5h9.5v14.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z" />
    <path d="M15.5 8.5h2.6a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2.6" />
    <path d="M6 9h9.5" />
    <path d="M9 3.2v1.6M12 3.2v1.6" />`,
  // 手锯：锯片加锯齿
  handsaw: `
    <path d="M3.5 15.5 L17 5.5 l3.5 3.2 L8 19.5z" />
    <path d="M7 17.2l1-1.3M10 15l1-1.3M13 12.8l1-1.3M16 10.6l1-1.3" />
    <path d="M3 20.5h6" />`,
  // 香烟：烟身加烟
  cigarette: `
    <rect x="3.2" y="13" width="12" height="5" rx="1" />
    <path d="M15.2 13h4.6v5h-4.6" />
    <path d="M10.5 13V9.4" />
    <path d="M13 4.2c1.8 1.2 1.6 2.6 0 3.6" />
    <path d="M16.4 3.6c2 1.4 1.8 3 0 4.2" />`,
  // 手铐：两个环加连接
  handcuffs: `
    <circle cx="7" cy="14" r="4.2" />
    <circle cx="17" cy="14" r="4.2" />
    <path d="M11.2 14h1.6" />
    <path d="M7 9.8V7.4M17 9.8V7.4" />`,
};

/** 鸡蛋 */
const EGG = `<path d="M12 3.2c3.4 0 6.2 5.8 6.2 9.9a6.2 6.2 0 0 1-12.4 0c0-4.1 2.8-9.9 6.2-9.9z" />`;

/** 鲜花：五瓣加花心 */
const FLOWER = `
  <circle cx="12" cy="12" r="2.4" />
  <circle cx="12" cy="6.2" r="3" />
  <circle cx="17.5" cy="10.2" r="3" />
  <circle cx="15.4" cy="16.6" r="3" />
  <circle cx="8.6" cy="16.6" r="3" />
  <circle cx="6.5" cy="10.2" r="3" />`;

/** 霰弹枪（对局 HUD 用） */
const SHOTGUN = `
  <path d="M2.5 9.5h14l5 2v2h-5l-2 3h-3l1-3h-10z" />
  <path d="M6 9.5v-2h4v2" />
  <circle cx="9" cy="14.5" r="2" />`;

const REGISTRY = { ...PATHS, egg: EGG, flower: FLOWER, shotgun: SHOTGUN };

/**
 * 生成一段 SVG。
 * @param {string} name 图标名
 * @param {number} [size] 边长（不传则由 CSS 控制）
 */
export function icon(name, size) {
  const body = REGISTRY[name];
  if (!body) return '';
  const dims = size ? ` width="${size}" height="${size}"` : '';
  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ` +
    `stroke-linecap="round" stroke-linejoin="round"${dims} aria-hidden="true">${body}</svg>`
  );
}

/** 头像配色索引：同一个 id 永远得到同一种颜色 */
export function colorIndex(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) {
    h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
  }
  return h % 4;
}