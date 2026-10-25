export interface LabelRect {
  x: number
  y: number
  width: number
  height: number
}

/** 只在数值空间避让；隐藏的 SVG 返回零尺寸时不反复测量 DOM。 */
export function placeAbove(box: LabelRect, occupied: LabelRect[], gap: number): LabelRect {
  const placed = { x: box.x, y: box.y, width: box.width, height: box.height }
  if (box.width <= 0 || box.height <= 0) return placed
  for (;;) {
    const overlap = occupied.find(
      (r) =>
        placed.x < r.x + r.width + gap &&
        placed.x + placed.width + gap > r.x &&
        placed.y < r.y + r.height + gap &&
        placed.y + placed.height + gap > r.y
    )
    if (!overlap) return placed
    placed.y = Math.min(placed.y, overlap.y) - placed.height - gap
  }
}
