// 生成器在 Node 和手机应用的网页里都会跑：清单用 JSON 模块导入，不读文件。
import sceneManifest from '../../data/scene-assets/pr10-village-v1/manifest.json' with { type: 'json' }

export const GENERATOR_VERSION = 4
// 唯一的外观集：spec.appearance_set、静态资源路由、3D 素材清单都以此为准（换外观集时上面的导入路径一起改）。
export const APPEARANCE_SET = 'pr10-village-v1'
export const manifest = sceneManifest
export const PARAMETERS = Object.freeze({
  version: 1,
  projection_steps: 256,
  repairs: 6,
  improvements: 2,
  route_states: 30000,
  total_route_states: 500000,
  max_nodes: 256,
  max_edges: 512,
  edge_points: 128,
  max_cells: 500000,
  max_ms: 20000,
  cell_size: 20,
  route_grid: 80,
  units_per_minute: 144,
})
// 布局手感参数，单位为 SVG 单位。改动任何一项都会改变所有种子的输出。
export const LAYOUT = Object.freeze({
  road_width: { main: 100, street: 80, access: 60 },
  // 街区与投影（districts.mjs）
  parcel_pad_x: 120, // 估算地块占地时在宽度方向加的留白
  parcel_pad_y: 220, // 估算地块占地时在高度方向加的留白，含门前空间
  canvas_margin_x: 100, // 候选中心到画布左右边缘的最小距离
  canvas_margin_top: 150, // 候选中心到画布上边缘的最小距离
  canvas_margin_bottom: 100, // 候选中心到画布下边缘的最小距离
  separation_x: 150, // 投影阶段两地块中心在 x 方向的最小间隔，加在半宽之和上
  separation_y: 210, // 同上，y 方向
  projection_margin_x: 80, // 投影阶段夹紧到画布时的左右边距
  projection_margin_top: 120,
  projection_margin_bottom: 80,
  // 地块（parcels.mjs）
  envelope_gap: 50, // 地块包络四周留白
  envelope_front: 80, // 地块包络在门前一侧额外留白
  canvas_edge: 40, // 包络到画布边缘的最小距离
  road_clearance: 32, // 地块矩形到道路边缘的最小距离
  setback_min: 55, // 建筑到道路边缘的最小退距
  setback_range: 90, // 街区密度越低退距越大，这是增加幅度
  // 道路与入口（roads.mjs）
  neighbour_gap_x: 130, // 支路候选：与已放置地块并排时的横向间隔
  neighbour_gap_y: 220, // 同上，纵向
  branch_offset: 145, // 支路前街线离地块中心的额外距离
  branch_half_extra: 160, // 支路前街线半长在地块半宽之外的额外长度
  door_inset: 70, // 门到建筑角的最小距离
  door_lead: 90, // 门外引道长度
  // 单地点场景（generate.mjs）
  standalone_margin: 200, // 单地点场景地块中心到画布原点的额外距离
})

// 一分钟步行对应的 SVG 单位：版本 1 固定为 units_per_minute；版本 2 由素材清单的米制参数换算。
export function unitsPerMinute(spec) {
  return spec.schema_version === 2
    ? manifest.parameters.svg_units_per_metre * manifest.parameters.metres_per_minute
    : PARAMETERS.units_per_minute
}
export const minutesFor = (spec, length) => length / unitsPerMinute(spec)

export class GenerationError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'GenerationError'
    this.code = code
    this.details = details
  }
}

export function budget(options = {}) {
  const caps = { ...PARAMETERS, ...options }
  const started = performance.now()
  const counts = { route_states: 0, projections: 0, repairs: 0, branches: 0 }
  return {
    caps,
    counts,
    check(stage) {
      if (performance.now() - started >= caps.max_ms)
        throw new GenerationError(
          'GENERATION_TIMEOUT',
          '地图生成超过计算时间，请减少地点或空间要求',
          { stage }
        )
    },
    route(stage) {
      if (++counts.route_states > caps.total_route_states)
        throw new GenerationError('GENERATION_BUDGET_EXCEEDED', '道路搜索达到计算上限', {
          stage,
          measured: counts.route_states,
          expected: caps.total_route_states,
        })
      if (!(counts.route_states % 128)) this.check(stage)
    },
  }
}
