import type { Atlas } from 'town-shared/mapDocument'
import type { At } from 'town-shared/protocol'
import type { Appearance, PropView } from 'town-shared/props/types'
import { defaultAppearance } from 'town-shared/props/appearances'
import type { Spatial } from 'town-shared/spatial'
import { errorText } from 'town-shared/format'
import { api } from '../launcher/api'
import { OUTDOOR_SPACE } from './grid'

type Mark = Atlas['props'][number]

const readableAppearance: Appearance = { glyph: 'book', color: '#a5bf9f' }

/**
 * 道具画在平面图上的位置和样子。运行期的位置优先：有三维坐标的按米换算，落在落脚点的取站位，
 * 其余取 walk_position；没有运行期位置的用地图文件里的原位；地图文件里也没有的（运行中新建的），
 * 由小镇服务按所在地点分配并保存（/positions），下次打开还在同一处。地图文件里的原位只读不改。
 */
export class PropPositions {
  private request = 0
  private signature = ''
  /** 最近一次 /positions 返回的位置 */
  private assigned: Mark[] = []

  constructor(
    private readonly atlas: Atlas,
    private readonly position: (locale: string, at: At) => [number, number] | undefined,
    private readonly appearanceFor: (id: string, definition: string) => Appearance,
    private readonly spatial: Spatial | undefined,
    private readonly persistence: { townId: string; mapHash: string } | undefined,
    private readonly notify: (message: string) => void,
    /** 位置算好后交给地图去画；marks 里只有在地图上的道具 */
    private readonly apply: (marks: Mark[], props: PropView[]) => void
  ) {}

  update(props: PropView[]) {
    if (this.spatial) {
      const metre = this.spatial.svg_units_per_metre
      const base = this.spatial.props.map((p) => ({
        id: p.id,
        name: props.find((v) => v.id === p.id)?.name ?? p.id,
        place_name: '',
        space: OUTDOOR_SPACE,
        x: p.position[0] * metre,
        y: p.position[2] * metre,
      }))
      this.apply(this.marks(base, props), props)
      return
    }
    const known = (p: PropView) =>
      p.on_map === false || this.runtime(p) || this.atlas.props.some((m) => m.id === p.id)
    if (!this.persistence || props.every(known)) {
      this.apply(this.marks(this.atlas.props, props), props)
      return
    }
    const signature = JSON.stringify(
      props.map((p) => [p.id, p.locale, p.position, p.location]).sort()
    )
    if (signature === this.signature) {
      this.apply(this.marks(this.assigned, props), props)
      return
    }
    const request = ++this.request
    void api<{ positions: Mark[] }>(`/${encodeURIComponent(this.persistence.townId)}/positions`, {
      map_hash: this.persistence.mapHash,
      instances: props.map((p) => ({ id: p.id, locale: p.locale })),
    })
      .then((result) => {
        if (request !== this.request) return
        this.assigned = result.positions
        this.signature = signature
        this.apply(this.marks(this.assigned, props), props)
      })
      .catch((error) => {
        if (request === this.request) this.notify(`道具位置未能保存：${errorText(error)}`)
      })
  }

  /** 之后返回的 /positions 结果不再使用 */
  dispose() {
    this.request++
  }

  /** 运行期位置（地图坐标）；没有就返回 undefined */
  private runtime(p: PropView): [number, number] | undefined {
    const metre = this.spatial?.svg_units_per_metre
    if (p.position && metre) return [p.position[0] * metre, p.position[2] * metre]
    if (p.location?.kind === 'ground')
      return this.position(p.locale, { kind: 'station', station: p.location.station })
    if (p.walk_position) return this.position(p.walk_position.locale, p.walk_position.at)
    return undefined
  }

  /** 在 base 上换成运行期位置，去掉不在地图上的道具，定下名字和外观 */
  private marks(base: Mark[], props: PropView[]): Mark[] {
    const positions = [...base]
    for (const p of props) {
      const xy = this.runtime(p)
      if (!xy) continue
      const i = positions.findIndex((m) => m.id === p.id)
      if (i >= 0) positions.splice(i, 1)
      positions.push({
        id: p.id,
        name: p.name,
        place_name: '',
        space: OUTDOOR_SPACE,
        x: xy[0],
        y: xy[1],
      })
    }
    const marks: Mark[] = []
    for (const m of positions) {
      const p = props.find((v) => v.id === m.id)
      if (!p || p.on_map === false) continue
      const configured = this.appearanceFor(p.id, p.definition ?? '')
      marks.push({
        ...m,
        name: p.name,
        appearance:
          p.readable && configured === defaultAppearance ? readableAppearance : configured,
      })
    }
    return marks
  }
}
