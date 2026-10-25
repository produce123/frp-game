//! 地图文档只在边界处校验一次，内核只拿到拓扑。道具库与场景包都由调用方运行期读入。
use crate::HostError;
use kernel::props::Catalog;
use kernel::topology::LocaleKind;
use kernel::Topology;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

mod generated;
mod geometry;
pub mod manifest;
mod model;
pub mod placement;
mod spatial;
pub mod walk;

pub use manifest::Manifest;

/// 运行世界用的拓扑：内核解析拓扑 JSON，host 再填上地图数据里道具操作点的编号规则。
pub fn runtime_topology(json: &str, catalog: &Catalog) -> Result<Topology, HostError> {
    let mut topo = Topology::from_json(json, catalog)?;
    topo.prop_station_prefix = Some(model::PROP_STATION_PREFIX.into());
    Ok(topo)
}

/// 校验通过的地图：交给内核的拓扑 JSON，以及场景包清单（schema 2 才有）。
pub struct ValidatedMap {
    pub topology: String,
    pub manifest: Option<Manifest>,
}

use geometry::{distance, Point};
use model::{Edge, Layout, MapDocument, TopologyIds, OUTDOOR_SPACE};

/// schema 1 只有二维数据，schema 2 另带三维空间数据。
const SPATIAL_SCHEMA_VERSION: u64 = 2;
const STYLE_ID: &str = "svg-town-v1";
const STYLE_VERSION: u64 = 1;
/// 生成器从这一版起产出的几何要过严格校验。
const STRICT_GENERATOR_VERSION: u64 = 2;
/// 二维坐标绝对值上限（SVG 单位）。
const MAX_COORDINATE: f64 = 1_000_000.0;
const MAX_CANVAS_SIZE: f64 = 100_000.0;
const MAX_CELL_SIZE: f64 = 1000.0;
const MAX_REGION_CELLS: usize = 500_000;
/// 导入的美术地图里，路段折线端点离节点标记允许的最大距离（SVG 像素）。
const ENDPOINT_TOLERANCE: f64 = 40.0;

fn normalized(value: &Value) -> Value {
    match value {
        Value::Array(a) => Value::Array(a.iter().map(normalized).collect()),
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, v)| (k.clone(), normalized(v))).collect())
        }
        Value::Number(n) if n.is_f64() => {
            let x = n.as_f64().unwrap();
            if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_991.0 {
                Value::from(x as i64)
            } else {
                value.clone()
            }
        }
        _ => value.clone(),
    }
}

pub fn hash(document: &Value) -> String {
    let mut value = normalized(document);
    value.as_object_mut().unwrap().remove("content_hash");
    format!("{:x}", Sha256::digest(serde_json::to_vec(&value).unwrap()))
}

/// 校验整份地图，返回交给内核的拓扑 JSON（schema 2 时并入 spatial 作为 navigation）。
/// `scene_assets` 是场景包目录；地图 assets.id 指向其中一个子目录的清单。
pub fn validate(
    document: &Value,
    catalog: &Catalog,
    scene_assets: &Path,
) -> Result<ValidatedMap, HostError> {
    check_hd2d(document)?;
    let doc = MapDocument::deserialize(document)
        .map_err(|e| HostError::Map(format!("地图字段格式错误：{e}")))?;
    check_supported(&doc)?;
    if doc.content_hash.as_deref() != Some(hash(document).as_str()) {
        return Err(HostError::Map("地图摘要与实际内容不符".into()));
    }
    let manifest = doc
        .assets
        .as_ref()
        .map(|a| manifest::load(scene_assets, &a.id))
        .transpose()?;
    let json = serde_json::to_string(&doc.topology).map_err(|e| HostError::Map(e.to_string()))?;
    let topo = Topology::from_json(&json, catalog)?;
    check_unique_topology_ids(&doc.topology)?;
    let layout = &doc.layout;
    check_canvas_and_marks(layout)?;
    check_regions(layout)?;
    check_spaces(layout)?;
    check_edges(layout, &topo)?;
    let surfaces: BTreeSet<&str> = layout
        .regions
        .iter()
        .map(|r| r.id.as_str())
        .chain(layout.spaces.iter().map(|s| s.id.as_str()))
        .collect();
    check_prop_marks(layout, &topo, &surfaces)?;
    check_station_marks(layout, &topo)?;
    check_places(&topo, &surfaces)?;
    check_graph(&topo)?;
    let strict = doc
        .generation
        .as_ref()
        .is_some_and(|g| g.generator_version >= STRICT_GENERATOR_VERSION);
    if strict {
        if doc.schema_version == SPATIAL_SCHEMA_VERSION {
            let manifest = manifest
                .as_ref()
                .ok_or_else(|| HostError::Map("schema 2 地图缺少 assets".into()))?;
            spatial::validate(document, &doc, &topo, manifest)?;
        } else {
            generated::validate(&doc, &topo)?;
        }
    }
    let topology = if doc.schema_version == SPATIAL_SCHEMA_VERSION {
        let spatial = doc
            .spatial
            .ok_or_else(|| HostError::Map("schema 2 地图缺少 spatial".into()))?;
        let mut topology = doc.topology;
        topology
            .as_object_mut()
            .ok_or_else(|| HostError::Map("topology 不是对象".into()))?
            .insert("navigation".into(), spatial);
        serde_json::to_string(&topology).map_err(|e| HostError::Map(e.to_string()))?
    } else {
        json
    };
    Ok(ValidatedMap { topology, manifest })
}

pub(super) fn check_hd2d(document: &Value) -> Result<(), HostError> {
    let views = &document["views"];
    let retired = !document["renderer"].is_null()
        || views["default"].as_str().is_some_and(|view| view != "2d")
        || views["available"]
            .as_array()
            .is_some_and(|items| items.iter().any(|v| v != "2d"));
    if retired {
        return Err(HostError::Map(
            "独立 3D 版本已停用，旧存档保留，请使用 HD-2D 地图".into(),
        ));
    }
    Ok(())
}

fn check_supported(doc: &MapDocument) -> Result<(), HostError> {
    if !(1..=SPATIAL_SCHEMA_VERSION).contains(&doc.schema_version)
        || doc.style_id != STYLE_ID
        || doc.style_version != STYLE_VERSION
    {
        return Err(HostError::Map("地图格式或样式版本不受支持".into()));
    }
    if doc.schema_version == SPATIAL_SCHEMA_VERSION && doc.spatial.is_none() {
        return Err(HostError::Map("schema 2 地图缺少 spatial".into()));
    }
    Ok(())
}

fn unique_ids<'a>(field: &str, ids: impl Iterator<Item = &'a str>) -> Result<(), HostError> {
    let mut seen = BTreeSet::new();
    for id in ids {
        if !seen.insert(id) {
            return Err(HostError::Map(format!("{field} 存在重复 ID {id}")));
        }
    }
    Ok(())
}

fn check_unique_topology_ids(topology: &Value) -> Result<(), HostError> {
    let ids = TopologyIds::deserialize(topology)
        .map_err(|e| HostError::Map(format!("topology 字段格式错误：{e}")))?;
    for (name, items) in [
        ("locales", &ids.locales),
        ("passages", &ids.passages),
        ("stations", &ids.stations),
        ("props", &ids.props),
    ] {
        unique_ids(
            &format!("topology.{name}"),
            items.iter().map(|i| i.id.as_str()),
        )?;
    }
    Ok(())
}

fn bounded(v: f64) -> bool {
    v.is_finite() && v.abs() < MAX_COORDINATE
}

fn coordinate_ok(p: Point) -> bool {
    p.iter().all(|v| bounded(*v))
}

/// 标记坐标在范围内且编号不重复。
fn check_marks<'a>(
    field: &str,
    marks: impl Iterator<Item = (&'a str, Point)>,
) -> Result<(), HostError> {
    let mut seen = BTreeSet::new();
    for (id, p) in marks {
        if !coordinate_ok(p) {
            return Err(HostError::Map(format!("{field} 中 {id} 的坐标无效")));
        }
        if !seen.insert(id) {
            return Err(HostError::Map(format!("{field} 存在重复 ID {id}")));
        }
    }
    Ok(())
}

fn check_canvas_and_marks(layout: &Layout) -> Result<(), HostError> {
    for (name, size) in [
        ("width", layout.canvas.width),
        ("height", layout.canvas.height),
    ] {
        if !(size > 0.0 && size <= MAX_CANVAS_SIZE) {
            return Err(HostError::Map(format!("layout.canvas.{name} 无效：{size}")));
        }
    }
    check_marks(
        "layout.nodes",
        layout.nodes.iter().map(|n| (n.id.as_str(), [n.x, n.y])),
    )?;
    check_marks(
        "layout.stations",
        layout.stations.iter().map(|m| (m.id.as_str(), [m.x, m.y])),
    )?;
    check_marks(
        "layout.props",
        layout.props.iter().map(|m| (m.id.as_str(), [m.x, m.y])),
    )
}

fn check_regions(layout: &Layout) -> Result<(), HostError> {
    for r in &layout.regions {
        if !(r.cell_size > 0.0 && r.cell_size <= MAX_CELL_SIZE) {
            return Err(HostError::Map(format!(
                "layout.regions 中 {} 的 cell_size 无效：{}",
                r.id, r.cell_size
            )));
        }
        if r.cells.is_empty() || r.cells.len() > MAX_REGION_CELLS {
            return Err(HostError::Map(format!(
                "layout.regions 中 {} 的 cells 数量无效：{}",
                r.id,
                r.cells.len()
            )));
        }
        if !r.cells.iter().all(|c| coordinate_ok(*c)) {
            return Err(HostError::Map(format!(
                "layout.regions 中 {} 的 cells 坐标无效",
                r.id
            )));
        }
    }
    Ok(())
}

fn check_spaces(layout: &Layout) -> Result<(), HostError> {
    for s in &layout.spaces {
        let (b, u) = (&s.bounds, &s.unfold);
        if ![b.x, b.y, b.width, b.height].iter().all(|v| bounded(*v)) {
            return Err(HostError::Map(format!(
                "layout.spaces 中 {} 的 bounds 无效",
                s.id
            )));
        }
        if ![u.scale, u.offset_x, u.offset_y]
            .iter()
            .all(|v| bounded(*v))
        {
            return Err(HostError::Map(format!(
                "layout.spaces 中 {} 的 unfold 无效",
                s.id
            )));
        }
        if u.scale <= 0.0 || b.width <= 0.0 || b.height <= 0.0 {
            return Err(HostError::Map(format!(
                "layout.spaces 中 {} 的尺寸必须为正",
                s.id
            )));
        }
    }
    Ok(())
}

/// 路段两端的处所必须是 topology.locales 里的编号（曾有生成器把节点编号写进 to_locale）。
fn check_edge_locales(e: &Edge, topo: &Topology) -> Result<(), HostError> {
    for (field, locale) in [("from_locale", &e.from_locale), ("to_locale", &e.to_locale)] {
        if !topo.locales.contains_key(locale) {
            return Err(HostError::Map(format!(
                "layout.edges 中 {} 的 {field} 引用了不存在的处所 {locale}",
                e.id
            )));
        }
    }
    Ok(())
}

/// 折线至少两点、坐标在范围内，两端落在对应节点标记附近。
fn check_polyline(e: &Edge, nodes: &BTreeMap<&str, Point>) -> Result<(), HostError> {
    let [first, .., last] = e.polyline.as_slice() else {
        return Err(HostError::Map(format!(
            "layout.edges 中 {} 的 polyline 少于两个点",
            e.id
        )));
    };
    if !e.polyline.iter().all(|p| coordinate_ok(*p)) {
        return Err(HostError::Map(format!(
            "layout.edges 中 {} 的 polyline 坐标无效",
            e.id
        )));
    }
    for (field, node, p) in [
        ("from_node", &e.from_node, *first),
        ("to_node", &e.to_node, *last),
    ] {
        let at = nodes.get(node.as_str()).ok_or_else(|| {
            HostError::Map(format!(
                "layout.edges 中 {} 的 {field} {node} 没有节点坐标",
                e.id
            ))
        })?;
        if distance(*at, p) > ENDPOINT_TOLERANCE {
            return Err(HostError::Map(format!(
                "layout.edges 中 {} 的折线端点离 {field} {node} 太远",
                e.id
            )));
        }
    }
    Ok(())
}

/// 每条显示路段对应一条同名逻辑路段且端点一致；每条逻辑路段恰有一条显示路段。
fn check_edges(layout: &Layout, topo: &Topology) -> Result<(), HostError> {
    let nodes: BTreeMap<&str, Point> = layout
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), [n.x, n.y]))
        .collect();
    let mut seen = BTreeSet::new();
    for e in &layout.edges {
        check_edge_locales(e, topo)?;
        let road = topo.locales.get(&e.id).ok_or_else(|| {
            HostError::Map(format!("layout.edges 中 {} 没有对应的逻辑路段", e.id))
        })?;
        if road.kind != LocaleKind::Transit
            || road.from_node.as_deref() != Some(&e.from_node)
            || road.to_node.as_deref() != Some(&e.to_node)
        {
            return Err(HostError::Map(format!(
                "layout.edges 中 {} 的端点与 topology.locales 不一致",
                e.id
            )));
        }
        if !seen.insert(e.id.as_str()) {
            return Err(HostError::Map(format!("layout.edges 存在重复 ID {}", e.id)));
        }
        check_polyline(e, &nodes)?;
    }
    for road in topo.locales.values() {
        if road.kind == LocaleKind::Transit && !seen.contains(road.id.as_str()) {
            return Err(HostError::Map(format!("逻辑路段 {} 缺少显示折线", road.id)));
        }
    }
    Ok(())
}

/// 每件道具有且仅有一个标记，所在处所有显示区域，标记的 space 是室外或所属处所。
fn check_prop_marks(
    layout: &Layout,
    topo: &Topology,
    surfaces: &BTreeSet<&str>,
) -> Result<(), HostError> {
    let marks: BTreeMap<&str, &model::Mark> =
        layout.props.iter().map(|m| (m.id.as_str(), m)).collect();
    for p in topo.props() {
        let mark = marks
            .get(p.id.as_str())
            .ok_or_else(|| HostError::Map(format!("道具 {} 缺少显示标记（layout.props）", p.id)))?;
        if !surfaces.contains(p.locale.as_str()) {
            return Err(HostError::Map(format!(
                "道具 {} 所在处所 {} 没有显示区域",
                p.id, p.locale
            )));
        }
        if mark.space != OUTDOOR_SPACE && mark.space != p.locale {
            return Err(HostError::Map(format!(
                "layout.props 中 {} 的 space {} 与所属处所 {} 不符",
                p.id, mark.space, p.locale
            )));
        }
    }
    if let Some(extra) = marks.keys().find(|id| topo.prop(id).is_none()) {
        return Err(HostError::Map(format!(
            "layout.props 中 {extra} 没有对应的道具"
        )));
    }
    Ok(())
}

fn check_station_marks(layout: &Layout, topo: &Topology) -> Result<(), HostError> {
    let marks: BTreeSet<&str> = layout.stations.iter().map(|m| m.id.as_str()).collect();
    for station in topo.stations.values() {
        if !marks.contains(station.id.as_str()) {
            return Err(HostError::Map(format!(
                "落脚点 {} 缺少显示标记（layout.stations）",
                station.id
            )));
        }
    }
    Ok(())
}

/// 至少一处地点；每处地点有显示区域、是驻留处所、到达点在同一处所且有节点。
fn check_places(topo: &Topology, surfaces: &BTreeSet<&str>) -> Result<(), HostError> {
    if topo.places.is_empty() {
        return Err(HostError::Map("地图至少需要一处活动地点".into()));
    }
    for p in &topo.places {
        if !surfaces.contains(p.locale.as_str()) {
            return Err(HostError::Map(format!("地点 {} 没有显示区域", p.locale)));
        }
        let arrival_ok = topo
            .stations
            .get(&p.arrival_station)
            .is_some_and(|s| s.locale == p.locale);
        if !topo.is_dwell(&p.locale) || !arrival_ok || !topo.locale_nodes.contains_key(&p.locale) {
            return Err(HostError::Map(format!(
                "地点 {} 缺少有效的到达位置",
                p.locale
            )));
        }
    }
    Ok(())
}

/// 节点图连通；通道两端是已知处所且耗时合法。
fn check_graph(topo: &Topology) -> Result<(), HostError> {
    let Some(first) = topo.graph.keys().next() else {
        return Err(HostError::Map("地图缺少通路".into()));
    };
    if topo.connected_node_count_from(first) != topo.graph.len() {
        return Err(HostError::Map("存在不可到达的地点".into()));
    }
    for p in &topo.passages {
        if !topo.locales.contains_key(&p.a) || !topo.locales.contains_key(&p.b) {
            return Err(HostError::Map(format!("通道 {} 引用了不存在的处所", p.id)));
        }
        if !p.minutes.is_finite() || p.minutes < 0.0 {
            return Err(HostError::Map(format!(
                "通道 {} 的耗时无效：{}",
                p.id, p.minutes
            )));
        }
    }
    Ok(())
}
