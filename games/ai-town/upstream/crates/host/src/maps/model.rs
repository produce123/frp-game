//! 地图文档的类型化视图：校验前先反序列化，之后的检查不再按键索引 JSON。
//! 不加 deny_unknown_fields：生成器和导入地图都带展示用的附加字段
//! （name、kind、appearance、place_name、views、buildings、center 等）。
use super::geometry::Point;
use serde::de::IgnoredAny;
use serde::Deserialize;
use serde_json::Value;

/// 道具与落脚点标记放在室外画布上时的 space 取值；也作为行走地图的室外空间交给内核。
pub(super) const OUTDOOR_SPACE: &str = "town_outdoor";
/// 步行速度：每分钟 12 米。行走地图与运行时新通路的时长都按它，内核从行走地图读取。
pub(super) const WALK_METRES_PER_MINUTE: f64 = 12.;
/// 道具操作点的落脚点编号前缀：道具 x 的操作点是 use_x。交给内核的拓扑时填入。
pub(super) const PROP_STATION_PREFIX: &str = "use_";

pub(super) type Point3 = [f64; 3];

#[derive(Deserialize)]
pub(super) struct MapDocument {
    pub schema_version: u64,
    pub style_id: String,
    pub style_version: u64,
    pub content_hash: Option<String>,
    /// 逻辑拓扑交给 kernel 解析；这里保留原文用于输出和编号重复检查。
    pub topology: Value,
    pub layout: Layout,
    pub generation: Option<Generation>,
    /// schema 2 的三维空间数据；原文要原样并入输出，类型化解析在 spatial 模块内做。
    pub spatial: Option<Value>,
    pub assets: Option<Assets>,
}

/// 拓扑各集合的编号，只用于重复检查。
#[derive(Deserialize)]
pub(super) struct TopologyIds {
    pub locales: Vec<Identified>,
    pub passages: Vec<Identified>,
    pub stations: Vec<Identified>,
    pub props: Vec<Identified>,
}

#[derive(Deserialize)]
pub(super) struct Identified {
    pub id: String,
}

#[derive(Deserialize)]
pub(super) struct Generation {
    pub generator_version: u64,
}

#[derive(Deserialize)]
pub(super) struct Layout {
    pub canvas: Canvas,
    pub regions: Vec<Region>,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub spaces: Vec<Space>,
    pub stations: Vec<Mark>,
    pub props: Vec<Mark>,
}

#[derive(Deserialize)]
pub(super) struct Canvas {
    pub width: f64,
    pub height: f64,
}

/// 室外区域：网格单元列表；生成器还写 label_anchor 与 area_budget。
#[derive(Deserialize)]
pub(super) struct Region {
    pub id: String,
    pub kind: Option<String>,
    pub cell_size: f64,
    pub cells: Vec<Point>,
    pub label_anchor: Option<Point>,
    pub area_budget: Option<f64>,
}

/// 图节点在画布上的位置。
#[derive(Deserialize)]
pub(super) struct Node {
    pub id: String,
    pub x: f64,
    pub y: f64,
}

/// 道具或落脚点的显示标记；space 是室外画布或所属房间。
#[derive(Deserialize)]
pub(super) struct Mark {
    pub id: String,
    pub space: String,
    pub x: f64,
    pub y: f64,
}

/// 路段折线；from_locale/to_locale 是两端的驻留处所。
#[derive(Deserialize)]
pub(super) struct Edge {
    pub id: String,
    pub from_node: String,
    pub to_node: String,
    pub from_locale: String,
    pub to_locale: String,
    pub polyline: Vec<Point>,
    /// 道路宽度（SVG 单位），生成器写入。
    pub width: Option<f64>,
}

/// 室内房间：本地边界加摊开到画布的变换，门位可缺省。
#[derive(Deserialize)]
pub(super) struct Space {
    pub id: String,
    pub bounds: Bounds,
    pub unfold: Unfold,
    pub door_outside: Option<Point>,
    pub door_inside_local: Option<Point>,
}

#[derive(Deserialize)]
pub(super) struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Deserialize)]
pub(super) struct Unfold {
    pub scale: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}

#[derive(Deserialize)]
pub(super) struct Assets {
    pub id: String,
    pub version: u64,
    pub files: Value,
}

/// schema 2 的三维空间数据：地图校验和行走地图编译都读这一份。已发布的现成海岛地图早于
/// 地图生成器，没有地形与植被，这两项可以缺省；严格校验（生成器产出的地图）要求有地形。
#[derive(Deserialize)]
pub(super) struct Spatial {
    pub version: u64,
    pub units: String,
    pub svg_units_per_metre: f64,
    #[serde(default)]
    pub terrain: Option<Terrain>,
    pub nodes: Vec<SpatialNode>,
    pub routes: Vec<Route>,
    pub props: Vec<SpatialProp>,
    pub stations: Vec<SpatialStation>,
    pub floors: Vec<Floor>,
    #[serde(default)]
    pub vegetation: Vec<Plant>,
}

#[derive(Deserialize)]
pub(super) struct Terrain {
    pub columns: u64,
    pub rows: u64,
    pub step: f64,
    pub heights: Vec<f64>,
    /// 陆地标记只检查长度。
    pub land: Vec<IgnoredAny>,
    /// 海面高度（米），低于它的格点是水。没写时为 0。
    #[serde(default)]
    pub sea_level: f64,
}

/// 一棵树或一块石头；有碰撞半径的挡路。
#[derive(Deserialize)]
pub(super) struct Plant {
    pub id: String,
    pub position: Point3,
    #[serde(default)]
    pub collider_radius: Option<f64>,
}

#[derive(Deserialize)]
pub(super) struct SpatialNode {
    pub id: String,
    pub position: Point3,
}

/// 三维路线；id 与 layout.edges、topology.locales 同名。
#[derive(Deserialize)]
pub(super) struct Route {
    pub id: String,
    pub from: String,
    pub to: String,
    pub from_locale: String,
    pub to_locale: String,
    /// 室内通道所属的活动空间；室外道路没有。
    pub owner: Option<String>,
    pub points: Vec<Point3>,
    pub length: f64,
    pub minutes: f64,
    /// 路面宽度（米）。
    pub width: f64,
}

#[derive(Deserialize)]
pub(super) struct SpatialProp {
    pub id: String,
    pub locale: String,
    pub position: Point3,
    pub anchor: Point3,
    pub footprint: [f64; 2],
}

#[derive(Deserialize)]
pub(super) struct SpatialStation {
    pub id: String,
    pub position: Point3,
}

/// 地点的活动空间在 x/z 平面上的范围。
#[derive(Deserialize)]
pub(super) struct Floor {
    pub id: String,
    pub bounds: FloorBounds,
    pub indoor: bool,
}

#[derive(Deserialize)]
pub(super) struct FloorBounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
