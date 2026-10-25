/** 立体场景里地面随俯角倾斜，SVG 视口纵向被压扁；立着的文字和标记按这个比例纵向拉回原样。
 *  平面地图横竖比例一致，返回 1 */
export function uprightRatio(element: SVGGraphicsElement) {
  const m = element.getScreenCTM()
  return m && m.a && m.d ? Math.abs(m.a / m.d) : 1
}

/** 立着的文字（地名、房间名、道具名、村民名字和动作）纵向拉回 k 倍：基线（y 属性）不动，字往上长。
 *  改了 y 或 k 都要再调一次。用 SVG 的 transform 属性，不用 CSS 的 transform-box: fill-box：
 *  WebKit（mac 版）给带 x、y 的 <text> 算 fill-box 时丢了位置，拉伸以原点为准，越往南的字漂得越远 */
export function standUpright(text: Element, k: number) {
  const y = Number(text.getAttribute('y')) || 0
  const transform = k === 1 ? null : `matrix(1 0 0 ${k} 0 ${y * (1 - k)})`
  if (text.getAttribute('transform') === transform) return
  if (transform) text.setAttribute('transform', transform)
  else text.removeAttribute('transform')
}
