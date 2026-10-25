import { OUTDOOR_SPACE } from './grid'
import type { House } from './hd2d/layout'
import type { HdScene } from './hd2d/scene'
import { standUpright } from './upright'

type Point = [number, number]

/**
 * 立体场景里房子的开合：选中的人或化身所在的房间、放大后镜头中心所在的房间掀开屋顶；
 * 其余房子盖着屋顶，里面的道具藏起来，人只留名字。房间名盖着屋顶时放在屋顶上方，掀开后回到房间上沿。
 */
export class RoomCovers {
  private open = new Set<string>()
  /** 上次交给立体场景的开合，null 表示要重新交 */
  private key: string | null = null
  private readonly labels = new Map<string, { label: Element; house: House }>()

  constructor(private readonly spaceAt: (p: Point) => string) {}

  /** 立体场景起来后记下每栋房子的名字标签 */
  attach(svg: SVGSVGElement, houses: House[]) {
    for (const house of houses) {
      const label = svg.querySelector(`[data-room="${CSS.escape(house.id)}"]`)
      if (label) this.labels.set(house.id, { label, house })
    }
    this.key = null
  }

  /** 俯角或道具变了：下次 update 时重新交给立体场景 */
  reset() {
    this.key = null
  }

  /** focus 里的点所在的房间掀开；和上次交给立体场景的不同时返回 true */
  update(focus: (Point | undefined)[]) {
    const open = new Set<string>()
    for (const p of focus) {
      const space = p && this.spaceAt(p)
      if (space && space !== OUTDOOR_SPACE) open.add(space)
    }
    this.open = open
    const key = [...open].sort().join('|')
    if (key === this.key) return false
    this.key = key
    return true
  }

  /** 这一点被屋顶盖着：在房间里，而且这间没掀开 */
  readonly covered = (p: Point) => {
    const space = this.spaceAt(p)
    return space !== OUTDOOR_SPACE && !this.open.has(space)
  }

  /** 开合交给立体场景，房间名跟着屋顶或墙顶的高度走 */
  apply(hd: HdScene, project: (point: Point) => Point) {
    hd.setOpenRooms(this.open)
    for (const [id, { label, house }] of this.labels) {
      const corners = [
        [house.x, house.y],
        [house.x + house.w, house.y],
        [house.x, house.y + house.h],
        [house.x + house.w, house.y + house.h],
      ] as Point[]
      const view = corners.map(project)
      const [x] = project([house.x + house.w / 2, house.y + house.h / 2])
      const rise = this.open.has(id)
        ? house.y - hd.roomTop(house)
        : house.y + (house.alongX ? house.h / 2 : 0) - hd.roofTop(house)
      let top = Math.min(...view.map((p) => p[1])) - rise
      if (!this.open.has(id)) {
        const ridge: Point[] = house.alongX
          ? [
              [house.x, house.y + house.h / 2],
              [house.x + house.w, house.y + house.h / 2],
            ]
          : [
              [house.x + house.w / 2, house.y],
              [house.x + house.w / 2, house.y + house.h],
            ]
        const wallRise = (rise * house.wallH) / (house.wallH + house.ridge)
        top = Math.min(
          ...view.map((p) => p[1] - wallRise),
          ...ridge.map((p) => project(p)[1] - rise)
        )
      }
      label.setAttribute('x', String(x))
      label.setAttribute('y', String(top - 18))
      standUpright(label, 1 / hd.verticalScale)
    }
  }
}
