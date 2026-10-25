//! schema 2：校验保存下来的三维几何，以及它与逻辑拓扑、二维投影的一致性。
use super::geometry::{distance, Point, Rect, EPS};
use super::manifest::Manifest;
use super::model::{
    Assets, Edge, Layout, MapDocument, Point3, Route, Spatial, SpatialProp, Terrain,
    PROP_STATION_PREFIX,
};
use crate::HostError;
use kernel::Topology;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::ops::{Range, RangeInclusive};

const SPATIAL_VERSION: u64 = 1;
const UNITS: &str = "metres";
/// 三维坐标与尺寸的绝对值上限（米）。
const MAX_METRES: f64 = 100_000.0;
/// 地形网格每个方向至少两个采样点；步长上限（米）。
const MIN_TERRAIN_AXIS: u64 = 2;
const MAX_TERRAIN_STEP: f64 = 100.0;
/// 地形高度范围（米）。
const TERRAIN_HEIGHT: Range<f64> = -10.0..100.0;
const MAX_ROUTES: usize = 8192;
const ROUTE_POINTS: RangeInclusive<usize> = 2..=256;
/// 路线分钟数与长度换算允许的误差。
const MINUTES_TOLERANCE: f64 = 0.0001;
/// 坡度计算时水平距离的下限，避免除零。
const MIN_RUN: f64 = 0.01;
/// 坡度允许比生成参数略高，吸收地形采样的舍入。
const SLOPE_TOLERANCE: f64 = 0.01;
/// 家具占地上限（米）。
const MAX_FOOTPRINT: f64 = 5.0;
/// 路线点低于这个高度视为进入水域（米）。
const MIN_ROUTE_HEIGHT: f64 = 0.3;

/// 家具连同人物半径构成的障碍框，anchor 是操作位置。
struct Obstacle<'a> {
    id: &'a str,
    locale: &'a str,
    rect: Rect,
    anchor: Point,
}

struct FloorArea {
    rect: Rect,
    indoor: bool,
}

/// 三维点投到 x/z 平面。
fn ground(p: Point3) -> Point {
    [p[0], p[2]]
}

fn bounded(p: Point3) -> bool {
    p.iter().all(|v| v.is_finite() && v.abs() < MAX_METRES)
}

pub(super) fn validate(
    document: &Value,
    doc: &MapDocument,
    topo: &Topology,
    manifest: &Manifest,
) -> Result<(), HostError> {
    let raw = doc
        .spatial
        .as_ref()
        .ok_or_else(|| HostError::Map("schema 2 地图缺少 spatial".into()))?;
    let spatial = Spatial::deserialize(raw)
        .map_err(|e| HostError::Map(format!("spatial 字段格式错误：{e}")))?;
    check_header(&spatial, topo, doc.assets.as_ref(), manifest)?;
    let bytes = serde_json::to_vec(document)
        .map_err(|e| HostError::Map(e.to_string()))?
        .len();
    check_limits(&spatial, bytes, manifest)?;
    let terrain = spatial
        .terrain
        .as_ref()
        .ok_or_else(|| HostError::Map("spatial 缺少 terrain".into()))?;
    check_terrain(terrain, manifest)?;
    let positions = node_positions(&spatial)?;
    check_routes(&spatial, &doc.layout, topo, &positions, manifest)?;
    let floors = floor_areas(&spatial, topo)?;
    let obstacles = check_props(&spatial, &floors, topo, manifest)?;
    check_obstacle_overlaps(&obstacles)?;
    check_route_clearance(&spatial, &floors, &obstacles)
}

/// 版本、单位、比例与资源清单必须与场景包清单一致。
fn check_header(
    spatial: &Spatial,
    topo: &Topology,
    assets: Option<&Assets>,
    manifest: &Manifest,
) -> Result<(), HostError> {
    if spatial.version != SPATIAL_VERSION {
        return Err(HostError::Map(format!(
            "spatial.version 不支持：{}",
            spatial.version
        )));
    }
    if spatial.units != UNITS {
        return Err(HostError::Map(format!(
            "spatial.units 不支持：{}",
            spatial.units
        )));
    }
    let scale = manifest.parameters.svg_units_per_metre;
    if spatial.svg_units_per_metre != scale {
        return Err(HostError::Map(format!(
            "spatial.svg_units_per_metre 必须是 {scale}"
        )));
    }
    if !topo.precise_navigation {
        return Err(HostError::Map(
            "topology.precise_navigation 必须为 true".into(),
        ));
    }
    let assets = assets.ok_or_else(|| HostError::Map("schema 2 地图缺少 assets".into()))?;
    if assets.id != manifest.id {
        return Err(HostError::Map(format!("assets.id 不支持：{}", assets.id)));
    }
    if assets.version != manifest.version || assets.files != manifest.files {
        return Err(HostError::Map(
            "assets 的版本或文件清单与场景资源清单不一致".into(),
        ));
    }
    Ok(())
}

fn check_limits(spatial: &Spatial, bytes: usize, manifest: &Manifest) -> Result<(), HostError> {
    let p = &manifest.parameters;
    if bytes > p.max_bytes {
        return Err(HostError::Map(format!(
            "地图数据 {bytes} 字节超过上限 {}",
            p.max_bytes
        )));
    }
    if spatial.nodes.is_empty() || spatial.nodes.len() > p.max_nav_nodes {
        return Err(HostError::Map(format!(
            "spatial.nodes 数量无效：{}（上限 {}）",
            spatial.nodes.len(),
            p.max_nav_nodes
        )));
    }
    if spatial.vegetation.len() > p.max_instances {
        return Err(HostError::Map(format!(
            "spatial.vegetation 数量 {} 超过上限 {}",
            spatial.vegetation.len(),
            p.max_instances
        )));
    }
    if spatial.routes.len() > MAX_ROUTES {
        return Err(HostError::Map(format!(
            "spatial.routes 数量 {} 超过上限 {MAX_ROUTES}",
            spatial.routes.len()
        )));
    }
    Ok(())
}

/// 网格每个方向至少两个采样点，总采样数不超过清单上限，heights/land 长度等于采样数。
fn check_terrain(t: &Terrain, manifest: &Manifest) -> Result<(), HostError> {
    let size_error = || {
        HostError::Map(format!(
            "spatial.terrain 规模无效：{} 列 × {} 行",
            t.columns, t.rows
        ))
    };
    if t.columns < MIN_TERRAIN_AXIS || t.rows < MIN_TERRAIN_AXIS {
        return Err(size_error());
    }
    let cells = t.columns.checked_mul(t.rows).ok_or_else(size_error)?;
    if cells > manifest.parameters.max_heightfield {
        return Err(size_error());
    }
    let cells = cells as usize;
    if t.heights.len() != cells || t.land.len() != cells {
        return Err(HostError::Map(format!(
            "spatial.terrain 的 heights/land 长度必须是 {cells}"
        )));
    }
    if !(t.step > 0.0 && t.step < MAX_TERRAIN_STEP) {
        return Err(HostError::Map(format!(
            "spatial.terrain.step 无效：{}",
            t.step
        )));
    }
    if let Some(h) = t.heights.iter().find(|h| !TERRAIN_HEIGHT.contains(h)) {
        return Err(HostError::Map(format!(
            "spatial.terrain.heights 含无效高度 {h}"
        )));
    }
    Ok(())
}

fn node_positions(spatial: &Spatial) -> Result<BTreeMap<&str, Point3>, HostError> {
    let mut positions = BTreeMap::new();
    for n in &spatial.nodes {
        if !bounded(n.position) {
            return Err(HostError::Map(format!(
                "spatial.nodes 中 {} 的 position 超出范围",
                n.id
            )));
        }
        if positions.insert(n.id.as_str(), n.position).is_some() {
            return Err(HostError::Map(format!(
                "spatial.nodes 存在重复 ID {}",
                n.id
            )));
        }
    }
    Ok(positions)
}

fn check_routes(
    spatial: &Spatial,
    layout: &Layout,
    topo: &Topology,
    positions: &BTreeMap<&str, Point3>,
    manifest: &Manifest,
) -> Result<(), HostError> {
    let edges: BTreeMap<&str, &Edge> = layout.edges.iter().map(|e| (e.id.as_str(), e)).collect();
    for r in &spatial.routes {
        check_route_locales(r, topo)?;
        check_route_endpoints(r, positions)?;
        check_route_length(r, manifest)?;
        check_route_topology(r, topo)?;
        let edge = edges.get(r.id.as_str()).ok_or_else(|| {
            HostError::Map(format!(
                "spatial.routes 中 {} 在 layout.edges 中没有二维投影",
                r.id
            ))
        })?;
        check_route_projection(r, edge, manifest)?;
        check_route_slope(r, manifest)?;
    }
    Ok(())
}

/// 路线两端的处所必须是 topology.locales 里的编号。
fn check_route_locales(r: &Route, topo: &Topology) -> Result<(), HostError> {
    for (field, locale) in [("from_locale", &r.from_locale), ("to_locale", &r.to_locale)] {
        if !topo.locales.contains_key(locale) {
            return Err(HostError::Map(format!(
                "spatial.routes 中 {} 的 {field} 引用了不存在的处所 {locale}",
                r.id
            )));
        }
    }
    Ok(())
}

/// 点数在范围内、坐标合法，首尾点与 from/to 节点重合。
fn check_route_endpoints(r: &Route, positions: &BTreeMap<&str, Point3>) -> Result<(), HostError> {
    if !ROUTE_POINTS.contains(&r.points.len()) {
        return Err(HostError::Map(format!(
            "spatial.routes 中 {} 的点数无效：{}",
            r.id,
            r.points.len()
        )));
    }
    let [first, .., last] = r.points.as_slice() else {
        return Err(HostError::Map(format!(
            "spatial.routes 中 {} 少于两个点",
            r.id
        )));
    };
    if !r.points.iter().all(|p| bounded(*p)) {
        return Err(HostError::Map(format!(
            "spatial.routes 中 {} 含超出范围的坐标",
            r.id
        )));
    }
    for (field, node, p) in [("from", &r.from, *first), ("to", &r.to, *last)] {
        let at = positions.get(node.as_str()).ok_or_else(|| {
            HostError::Map(format!(
                "spatial.routes 中 {} 的 {field} {node} 不是空间节点",
                r.id
            ))
        })?;
        if distance(*at, p) > EPS {
            return Err(HostError::Map(format!(
                "spatial.routes 中 {} 的端点偏离节点 {node}",
                r.id
            )));
        }
    }
    Ok(())
}

fn check_route_length(r: &Route, manifest: &Manifest) -> Result<(), HostError> {
    let length: f64 = r.points.windows(2).map(|ps| distance(ps[0], ps[1])).sum();
    let minutes = length / manifest.parameters.metres_per_minute;
    if (minutes - r.minutes).abs() > MINUTES_TOLERANCE || (r.length - length).abs() > EPS {
        return Err(HostError::Map(format!(
            "spatial.routes 中 {} 的 length/minutes 与折线不一致",
            r.id
        )));
    }
    Ok(())
}

fn check_route_topology(r: &Route, topo: &Topology) -> Result<(), HostError> {
    let l = topo.locales.get(&r.id).ok_or_else(|| {
        HostError::Map(format!(
            "spatial.routes 中 {} 在 topology.locales 中没有处所",
            r.id
        ))
    })?;
    if l.from_node.as_deref() != Some(&r.from)
        || l.to_node.as_deref() != Some(&r.to)
        || l.minutes != Some(r.minutes)
    {
        return Err(HostError::Map(format!(
            "spatial.routes 中 {} 的端点或耗时与 topology.locales 不一致",
            r.id
        )));
    }
    Ok(())
}

/// 二维折线逐点等于三维路线在 x/z 平面上按比例的投影。
fn check_route_projection(r: &Route, edge: &Edge, manifest: &Manifest) -> Result<(), HostError> {
    let scale = manifest.parameters.svg_units_per_metre;
    if edge.polyline.len() != r.points.len() {
        return Err(HostError::Map(format!(
            "spatial.routes 中 {} 的点数与 layout.edges 的折线不同",
            r.id
        )));
    }
    for (xy, p) in edge.polyline.iter().zip(&r.points) {
        if (xy[0] / scale - p[0]).abs() > EPS || (xy[1] / scale - p[2]).abs() > EPS {
            return Err(HostError::Map(format!(
                "spatial.routes 中 {} 的二维投影与空间坐标不一致",
                r.id
            )));
        }
    }
    Ok(())
}

fn check_route_slope(r: &Route, manifest: &Manifest) -> Result<(), HostError> {
    let limit = manifest.parameters.max_slope + SLOPE_TOLERANCE;
    for ps in r.points.windows(2) {
        let (a, b) = (ps[0], ps[1]);
        let run = (a[0] - b[0]).hypot(a[2] - b[2]).max(MIN_RUN);
        if (a[1] - b[1]).abs() / run > limit {
            return Err(HostError::Map(format!(
                "spatial.routes 中 {} 的坡度超过 {limit}",
                r.id
            )));
        }
    }
    Ok(())
}

/// 每处地点一个活动空间，返回其平面矩形与室内标记。
fn floor_areas<'a>(
    spatial: &'a Spatial,
    topo: &Topology,
) -> Result<BTreeMap<&'a str, FloorArea>, HostError> {
    let mut floors = BTreeMap::new();
    for f in &spatial.floors {
        let b = &f.bounds;
        if ![b.x, b.y, b.w, b.h]
            .iter()
            .all(|v| v.is_finite() && v.abs() < MAX_METRES)
        {
            return Err(HostError::Map(format!(
                "spatial.floors 中 {} 的 bounds 超出范围",
                f.id
            )));
        }
        if b.w <= 0.0 || b.h <= 0.0 {
            return Err(HostError::Map(format!(
                "spatial.floors 中 {} 的面积必须为正",
                f.id
            )));
        }
        let rect = Rect {
            x: b.x,
            y: b.y,
            w: b.w,
            h: b.h,
        };
        let area = FloorArea {
            rect,
            indoor: f.indoor,
        };
        if floors.insert(f.id.as_str(), area).is_some() {
            return Err(HostError::Map(format!(
                "spatial.floors 存在重复 ID {}",
                f.id
            )));
        }
    }
    if floors.len() != topo.places.len() {
        return Err(HostError::Map(format!(
            "spatial.floors 有 {} 个，topology.places 有 {} 处",
            floors.len(),
            topo.places.len()
        )));
    }
    Ok(floors)
}

/// 家具：编号唯一、在所属活动空间内、有匹配的操作点；返回带人物半径的障碍框。
fn check_props<'a>(
    spatial: &'a Spatial,
    floors: &BTreeMap<&str, FloorArea>,
    topo: &Topology,
    manifest: &Manifest,
) -> Result<Vec<Obstacle<'a>>, HostError> {
    let stations: BTreeMap<&str, Point3> = spatial
        .stations
        .iter()
        .map(|s| (s.id.as_str(), s.position))
        .collect();
    let mut ids = BTreeSet::new();
    let mut obstacles = Vec::new();
    for prop in &spatial.props {
        if !ids.insert(prop.id.as_str()) {
            return Err(HostError::Map(format!(
                "spatial.props 存在重复 ID {}",
                prop.id
            )));
        }
        let floor = floors.get(prop.locale.as_str()).ok_or_else(|| {
            HostError::Map(format!(
                "spatial.props 中 {} 的 locale {} 没有活动空间",
                prop.id, prop.locale
            ))
        })?;
        let footprint = check_footprint(prop, floor)?;
        check_operation_point(prop, &stations)?;
        obstacles.push(Obstacle {
            id: &prop.id,
            locale: &prop.locale,
            rect: footprint.expanded(manifest.parameters.actor_radius),
            anchor: ground(prop.anchor),
        });
    }
    if ids.len() != topo.props().len() {
        return Err(HostError::Map(format!(
            "spatial.props 有 {} 件，topology.props 有 {} 件",
            ids.len(),
            topo.props().len()
        )));
    }
    Ok(obstacles)
}

/// 占地矩形（x/z 平面）；家具两对角与操作位置都要在活动空间内。
fn check_footprint(prop: &SpatialProp, floor: &FloorArea) -> Result<Rect, HostError> {
    if !bounded(prop.position) || !bounded(prop.anchor) {
        return Err(HostError::Map(format!(
            "spatial.props 中 {} 的坐标超出范围",
            prop.id
        )));
    }
    let [w, d] = prop.footprint;
    if !(w > 0.0 && d > 0.0 && w <= MAX_FOOTPRINT && d <= MAX_FOOTPRINT) {
        return Err(HostError::Map(format!(
            "spatial.props 中 {} 的 footprint 无效",
            prop.id
        )));
    }
    let rect = Rect {
        x: prop.position[0] - w / 2.0,
        y: prop.position[2] - d / 2.0,
        w,
        h: d,
    };
    if !floor.rect.contains([rect.x, rect.y])
        || !floor.rect.contains([rect.x + w, rect.y + d])
        || !floor.rect.contains(ground(prop.anchor))
    {
        return Err(HostError::Map(format!(
            "spatial.props 中 {} 的家具或操作位置越出活动空间 {}",
            prop.id, prop.locale
        )));
    }
    Ok(rect)
}

/// 每件家具有一个操作点（编号是前缀加家具编号），位置与 anchor 一致。
fn check_operation_point(
    prop: &SpatialProp,
    stations: &BTreeMap<&str, Point3>,
) -> Result<(), HostError> {
    let id = format!("{PROP_STATION_PREFIX}{}", prop.id);
    let at = stations
        .get(id.as_str())
        .ok_or_else(|| HostError::Map(format!("spatial.props 中 {} 缺少操作点 {id}", prop.id)))?;
    if distance(*at, prop.anchor) > EPS {
        return Err(HostError::Map(format!(
            "spatial.stations 中 {id} 的位置与家具 anchor 不一致"
        )));
    }
    Ok(())
}

/// 同一活动空间内：障碍框互不重叠，操作位置不落在任何家具（含自身）的障碍框里。
fn check_obstacle_overlaps(obstacles: &[Obstacle]) -> Result<(), HostError> {
    for (i, a) in obstacles.iter().enumerate() {
        for (j, b) in obstacles.iter().enumerate() {
            if a.locale != b.locale {
                continue;
            }
            if (j != i && a.rect.overlaps(&b.rect)) || b.rect.contains(a.anchor) {
                return Err(HostError::Map(format!(
                    "活动空间 {} 内家具 {} 与 {} 的占地或操作位置相互穿插",
                    a.locale, a.id, b.id
                )));
            }
        }
    }
    Ok(())
}

/// 路线不进水域、不穿家具；室内路线留在所属活动空间内，室外路线不穿房屋。
fn check_route_clearance(
    spatial: &Spatial,
    floors: &BTreeMap<&str, FloorArea>,
    obstacles: &[Obstacle],
) -> Result<(), HostError> {
    for r in &spatial.routes {
        if r.points.iter().any(|p| p[1] < MIN_ROUTE_HEIGHT) {
            return Err(HostError::Map(format!(
                "spatial.routes 中 {} 进入水域",
                r.id
            )));
        }
        let owner = r
            .owner
            .as_deref()
            .map(|id| {
                floors.get(id).map(|f| (id, f)).ok_or_else(|| {
                    HostError::Map(format!(
                        "spatial.routes 中 {} 的 owner {id} 没有活动空间",
                        r.id
                    ))
                })
            })
            .transpose()?;
        for ab in r.points.windows(2) {
            let (a, b) = (ground(ab[0]), ground(ab[1]));
            if let Some(o) = obstacles.iter().find(|o| o.rect.crossed_by(a, b)) {
                return Err(HostError::Map(format!(
                    "spatial.routes 中 {} 穿过家具 {}",
                    r.id, o.id
                )));
            }
            match owner {
                Some((id, floor)) => {
                    if !floor.rect.contains(a) || !floor.rect.contains(b) {
                        return Err(HostError::Map(format!(
                            "spatial.routes 中 {} 越出活动空间 {id}",
                            r.id
                        )));
                    }
                }
                None => {
                    if let Some((id, _)) = floors
                        .iter()
                        .find(|(_, f)| f.indoor && f.rect.crossed_by(a, b))
                    {
                        return Err(HostError::Map(format!(
                            "spatial.routes 中 {} 穿过房屋 {id}",
                            r.id
                        )));
                    }
                }
            }
        }
    }
    Ok(())
}
