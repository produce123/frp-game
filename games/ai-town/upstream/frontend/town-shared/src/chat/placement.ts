// 台词气泡摆在哪：默认在说话人头顶，头顶有旁人或别的气泡就换到脚下、或左右错开，
// 在候选位置里选遮住别人最少的一个。坐标都是屏幕 CSS 像素。
import type { ScreenBox } from '../gameMap'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Placement {
  x: number
  y: number
  /** 气泡在说话人的上方还是下方；尾巴朝向说话人 */
  side: 'above' | 'below'
  /** 尾巴离气泡左边的距离 */
  tail: number
  /** 候选编号，下一帧优先沿用它，避免人一走动气泡就来回跳 */
  choice: number
}

/** 气泡与头顶名字的间距 */
const GAP = 12
/** 名字挂在头顶之上：4 像素间距加 16 像素字高，再留一点余量 */
const NAME_ABOVE_HEAD = 22
/** 脚底下状态标签占的高度 */
const TAG_BOTTOM = 34
/** 尾巴离气泡左右边沿的最小距离 */
const TAIL_EDGE = 15
/** 盖住说话人自己的面积按这个倍数计入代价 */
const OWN_WEIGHT = 20
/** 新位置比当前位置好过这么多（像素平方）才换 */
const SWITCH_GAIN = 800

/** 一个人占的屏幕范围：从头顶之上的名字到脚下的状态标签，宽度取立牌半宽（至少 14） */
export function personRect(box: ScreenBox): Rect {
  const half = Math.max(box.half, 14),
    top = box.top - NAME_ABOVE_HEAD
  return { x: box.x - half, y: top, w: half * 2, h: box.feet + TAG_BOTTOM - top }
}

function overlap(a: Rect, b: Rect) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** 候选顺序即偏好：先头顶居中，再头顶错开，最后脚下 */
const CHOICES: { side: Placement['side']; anchor: 'center' | 'left' | 'right'; bias: number }[] = [
  { side: 'above', anchor: 'center', bias: 0 },
  { side: 'above', anchor: 'left', bias: 100 },
  { side: 'above', anchor: 'right', bias: 100 },
  { side: 'below', anchor: 'center', bias: 400 },
  { side: 'below', anchor: 'left', bias: 500 },
  { side: 'below', anchor: 'right', bias: 500 },
]

/**
 * @param speaker 说话人
 * @param size 气泡大小
 * @param bounds 气泡只能放在这个范围里（留 8 像素边）
 * @param avoid 要躲开的：旁人的范围和已经摆好的气泡
 * @param previous 这个气泡上一帧的选择
 */
export function placeBubble(
  speaker: ScreenBox,
  size: { w: number; h: number },
  bounds: { left: number; top: number; right: number; bottom: number },
  avoid: Rect[],
  previous?: number
): Placement {
  const { w, h } = size
  const own = personRect(speaker)
  const headTop = own.y
  const tries = CHOICES.map((choice, index) => {
    const wanted =
      choice.anchor === 'center'
        ? speaker.x - w / 2
        : choice.anchor === 'left'
          ? speaker.x - TAIL_EDGE * 2
          : speaker.x - w + TAIL_EDGE * 2
    const x = Math.max(bounds.left + 8, Math.min(bounds.right - w - 8, wanted))
    const wantedY =
      choice.side === 'above' ? headTop - h - GAP : speaker.feet + TAG_BOTTOM + GAP / 2
    const y = Math.max(bounds.top + 8, Math.min(bounds.bottom - h - 8, wantedY))
    const rect = { x, y, w, h }
    // 被屏幕边缘压回来盖住说话人自己（名字或脸），比盖住旁人更糟
    let cost = choice.bias + overlap(rect, own) * OWN_WEIGHT
    for (const other of avoid) cost += overlap(rect, other)
    const tail = Math.max(TAIL_EDGE, Math.min(w - TAIL_EDGE, speaker.x - x))
    return { x, y, side: choice.side, tail, choice: index, cost }
  })
  const best = tries.reduce((a, b) => (b.cost < a.cost ? b : a))
  const kept = previous === undefined ? undefined : tries[previous]
  const pick = kept && kept.cost <= best.cost + SWITCH_GAIN ? kept : best
  return { x: pick.x, y: pick.y, side: pick.side, tail: pick.tail, choice: pick.choice }
}
