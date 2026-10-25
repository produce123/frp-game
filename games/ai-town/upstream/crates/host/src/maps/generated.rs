//! 生成器产出的 schema 1 地图（生成器第 2 版起）的严格几何校验；导入的美术地图不走这里。
use super::geometry::{bounds_disjoint, distance, segment_intersection, Point, Rect, EPS};
use super::model::{Edge, Layout, MapDocument, Region, Space, OUTDOOR_SPACE};
use crate::HostError;
use kernel::Topology;
use std::collections::{BTreeMap, BTreeSet};

/// 以下五项与 scripts/mapgen/budget.mjs 的 PARAMETERS 一致。
const CELL_SIZE: f64 = 20.0;
const SVG_UNITS_PER_MINUTE: f64 = 144.0;
const MAX_NODES: usize = 256;
const MAX_EDGES: usize = 512;
const MAX_CELLS: usize = 500_000;
/// 道路宽度范围（SVG 单位）。
const ROAD_WIDTH: std::ops::RangeInclusive<f64> = 1.0..=200.0;
/// 路段耗时写入时保留四位小数，允许的舍入误差。
const MINUTES_TOLERANCE: f64 = 0.000_051;
/// 两条道路的交点离共同节点在这个距离内算作真实路口。
const JUNCTION_TOLERANCE: f64 = 0.01;
/// 区域实际面积至少要达到预算的这个比例。
const MIN_AREA_RATIO: f64 = 0.85;

type Cells = BTreeSet<(i64, i64)>;

struct Room<'a> {
    id: &'a str,
    rect: Rect,
}

struct Segment<'a> {
    a: Point,
    b: Point,
    edge: &'a str,
    from: &'a str,
    to: &'a str,
}

pub(super) fn validate(doc: &MapDocument, topo: &Topology) -> Result<(), HostError> {
    let layout = &doc.layout;
    let canvas = Rect {
        x: 0.0,
        y: 0.0,
        w: layout.canvas.width,
        h: layout.canvas.height,
    };
    let rooms = unfolded_rooms(layout, topo, &canvas)?;
    let nodes: BTreeMap<&str, Point> = layout
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), [n.x, n.y]))
        .collect();
    let segments = check_edges(layout, topo, &nodes, &rooms)?;
    check_crossings(&segments, &nodes)?;
    let regions = check_regions(layout, &canvas, &rooms)?;
    let cells: usize = regions.values().map(|c| c.len()).sum();
    if cells > MAX_CELLS || nodes.len() > MAX_NODES || layout.edges.len() > MAX_EDGES {
        return Err(HostError::Map(format!(
            "生成地图超过几何规模上限：{cells} 个单元、{} 个节点、{} 条路段",
            nodes.len(),
            layout.edges.len()
        )));
    }
    check_arrivals(layout, topo, &nodes, &regions)?;
    check_marks_in_bounds(layout, &canvas)?;
    check_props_in_regions(layout, topo, &regions)
}

/// 房间按显示变换摊到画布坐标；不越界、互不重叠、门位一致。
fn unfolded_rooms<'a>(
    layout: &'a Layout,
    topo: &Topology,
    canvas: &Rect,
) -> Result<Vec<Room<'a>>, HostError> {
    let mut rooms: Vec<Room> = Vec::new();
    for s in &layout.spaces {
        let scale = s.unfold.scale;
        let rect = Rect {
            x: s.unfold.offset_x + s.bounds.x * scale,
            y: s.unfold.offset_y + s.bounds.y * scale,
            w: s.bounds.width * scale,
            h: s.bounds.height * scale,
        };
        if rect.x < 0.0 || rect.y < 0.0 || rect.x + rect.w > canvas.w || rect.y + rect.h > canvas.h
        {
            return Err(HostError::Map(format!(
                "layout.spaces 中 {} 越出画布",
                s.id
            )));
        }
        if let Some(other) = rooms.iter().find(|r| r.rect.overlaps(&rect)) {
            return Err(HostError::Map(format!(
                "layout.spaces 中 {} 与 {} 重叠",
                s.id, other.id
            )));
        }
        check_door(s, &rect, topo)?;
        rooms.push(Room { id: &s.id, rect });
    }
    Ok(rooms)
}

/// 有对外通道的房间必须有门；门的室内外两个位置重合并落在房间边上。
fn check_door(s: &Space, rect: &Rect, topo: &Topology) -> Result<(), HostError> {
    let (local, door) = match (s.door_inside_local, s.door_outside) {
        (None, None) => {
            if topo.passages.iter().any(|p| p.a == s.id || p.b == s.id) {
                return Err(HostError::Map(format!(
                    "layout.spaces 中 {} 有对外通道但没有门位",
                    s.id
                )));
            }
            return Ok(());
        }
        (Some(local), Some(door)) => (local, door),
        _ => {
            return Err(HostError::Map(format!(
                "layout.spaces 中 {} 的 door_inside_local 与 door_outside 必须同时给出",
                s.id
            )))
        }
    };
    let scale = s.unfold.scale;
    let unfolded = [
        s.unfold.offset_x + local[0] * scale,
        s.unfold.offset_y + local[1] * scale,
    ];
    let to_edge = (door[0] - rect.x)
        .abs()
        .min((door[0] - rect.x - rect.w).abs())
        .min((door[1] - rect.y).abs())
        .min((door[1] - rect.y - rect.h).abs());
    if distance(unfolded, door) > EPS || !rect.contains(door) || to_edge > EPS {
        return Err(HostError::Map(format!(
            "layout.spaces 中 {} 的门位室内外不一致或不在房间边上",
            s.id
        )));
    }
    Ok(())
}

/// 每条路段：宽度合法、端点贴节点、耗时等于折线长度换算、不穿房间；返回全部线段供交叉检查。
fn check_edges<'a>(
    layout: &'a Layout,
    topo: &Topology,
    nodes: &BTreeMap<&str, Point>,
    rooms: &[Room],
) -> Result<Vec<Segment<'a>>, HostError> {
    let mut segments = Vec::new();
    for e in &layout.edges {
        let width = e
            .width
            .ok_or_else(|| HostError::Map(format!("layout.edges 中 {} 缺少 width", e.id)))?;
        if !ROAD_WIDTH.contains(&width) {
            return Err(HostError::Map(format!(
                "layout.edges 中 {} 的 width 无效：{width}",
                e.id
            )));
        }
        let [first, .., last] = e.polyline.as_slice() else {
            return Err(HostError::Map(format!(
                "layout.edges 中 {} 的 polyline 少于两个点",
                e.id
            )));
        };
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
            if distance(*at, p) > EPS {
                return Err(HostError::Map(format!(
                    "layout.edges 中 {} 的折线端点偏离 {field} {node}",
                    e.id
                )));
            }
        }
        check_minutes(e, topo)?;
        for pair in e.polyline.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            check_room_clearance(e, width, a, b, rooms)?;
            segments.push(Segment {
                a,
                b,
                edge: &e.id,
                from: &e.from_node,
                to: &e.to_node,
            });
        }
    }
    Ok(segments)
}

fn check_minutes(e: &Edge, topo: &Topology) -> Result<(), HostError> {
    let minutes = topo
        .locales
        .get(&e.id)
        .and_then(|l| l.minutes)
        .ok_or_else(|| {
            HostError::Map(format!("layout.edges 中 {} 对应的处所缺少 minutes", e.id))
        })?;
    let length: f64 = e.polyline.windows(2).map(|p| distance(p[0], p[1])).sum();
    let expected = length / SVG_UNITS_PER_MINUTE;
    if minutes <= 0.0 || (minutes - expected).abs() > MINUTES_TOLERANCE {
        return Err(HostError::Map(format!(
            "layout.edges 中 {} 的耗时 {minutes} 与折线长度换算的 {expected:.4} 不一致",
            e.id
        )));
    }
    Ok(())
}

/// 道路中心线不能穿房间；道路宽度也不能侵入不与它相连的房间。
fn check_room_clearance(
    e: &Edge,
    width: f64,
    a: Point,
    b: Point,
    rooms: &[Room],
) -> Result<(), HostError> {
    for room in rooms {
        if room.rect.crossed_by(a, b) {
            return Err(HostError::Map(format!(
                "layout.edges 中 {} 穿过房间 {}",
                e.id, room.id
            )));
        }
        let attached = e.from_locale == room.id || e.to_locale == room.id;
        if !attached && room.rect.expanded(width / 2.0).crossed_by(a, b) {
            return Err(HostError::Map(format!(
                "layout.edges 中 {} 的路宽侵入房间 {}",
                e.id, room.id
            )));
        }
    }
    Ok(())
}

/// 不同路段的线段相交时，交点必须是它们共同节点所在的位置。
fn check_crossings(segments: &[Segment], nodes: &BTreeMap<&str, Point>) -> Result<(), HostError> {
    for (i, a) in segments.iter().enumerate() {
        for b in &segments[..i] {
            if a.edge == b.edge || bounds_disjoint((a.a, a.b), (b.a, b.b)) {
                continue;
            }
            let Some(p) = segment_intersection((a.a, a.b), (b.a, b.b)) else {
                continue;
            };
            let shared_junction = [a.from, a.to].iter().any(|id| {
                (*id == b.from || *id == b.to)
                    && nodes
                        .get(id)
                        .is_some_and(|q| distance(*q, p) < JUNCTION_TOLERANCE)
            });
            if !shared_junction {
                return Err(HostError::Map(format!(
                    "layout.edges 中 {} 与 {} 相交但没有共同路口",
                    a.edge, b.edge
                )));
            }
        }
    }
    Ok(())
}

fn is_road(r: &Region) -> bool {
    r.kind.as_deref() == Some("road")
}

fn cell_of(p: Point, cell_size: f64) -> (i64, i64) {
    (
        (p[0] / cell_size).floor() as i64,
        (p[1] / cell_size).floor() as i64,
    )
}

/// 每个区域：网格尺寸固定、单元合法、非道路区域形状合规、四邻连通。
fn check_regions<'a>(
    layout: &'a Layout,
    canvas: &Rect,
    rooms: &[Room],
) -> Result<BTreeMap<&'a str, Cells>, HostError> {
    let mut regions = BTreeMap::new();
    let mut occupied = Cells::new();
    for r in &layout.regions {
        if r.cell_size != CELL_SIZE {
            return Err(HostError::Map(format!(
                "layout.regions 中 {} 的 cell_size 必须是 {CELL_SIZE}",
                r.id
            )));
        }
        let cells = region_cells(r, canvas, rooms, &mut occupied)?;
        if !is_road(r) {
            check_region_shape(r, &cells)?;
        }
        check_connected(r, &cells)?;
        regions.insert(r.id.as_str(), cells);
    }
    Ok(regions)
}

/// 单元在网格上、不越界、不重复；非道路区域互不重叠且不压房间。
fn region_cells(
    r: &Region,
    canvas: &Rect,
    rooms: &[Room],
    occupied: &mut Cells,
) -> Result<Cells, HostError> {
    let mut cells = Cells::new();
    for p in &r.cells {
        let on_grid = p[0].fract() == 0.0 && p[1].fract() == 0.0 && p[0] >= 0.0 && p[1] >= 0.0;
        let inside =
            (p[0] + 1.0) * r.cell_size <= canvas.w && (p[1] + 1.0) * r.cell_size <= canvas.h;
        let c = (p[0] as i64, p[1] as i64);
        if !on_grid || !inside || !cells.insert(c) {
            return Err(HostError::Map(format!(
                "layout.regions 中 {} 的单元 [{}, {}] 重复、越界或不在网格上",
                r.id, p[0], p[1]
            )));
        }
        if is_road(r) {
            continue;
        }
        if !occupied.insert(c) {
            return Err(HostError::Map(format!(
                "layout.regions 中 {} 的单元 [{}, {}] 与其他区域重叠",
                r.id, c.0, c.1
            )));
        }
        let cell = Rect {
            x: p[0] * r.cell_size,
            y: p[1] * r.cell_size,
            w: r.cell_size,
            h: r.cell_size,
        };
        if let Some(room) = rooms.iter().find(|room| room.rect.overlaps(&cell)) {
            return Err(HostError::Map(format!(
                "layout.regions 中 {} 的单元 [{}, {}] 压住房间 {}",
                r.id, c.0, c.1, room.id
            )));
        }
    }
    Ok(cells)
}

/// 非道路区域：标签落在区域内，面积不低于预算比例。
fn check_region_shape(r: &Region, cells: &Cells) -> Result<(), HostError> {
    let label = r
        .label_anchor
        .ok_or_else(|| HostError::Map(format!("layout.regions 中 {} 缺少 label_anchor", r.id)))?;
    if !cells.contains(&cell_of(label, r.cell_size)) {
        return Err(HostError::Map(format!(
            "layout.regions 中 {} 的 label_anchor 不在区域内",
            r.id
        )));
    }
    let budget = r
        .area_budget
        .ok_or_else(|| HostError::Map(format!("layout.regions 中 {} 缺少 area_budget", r.id)))?;
    let area = cells.len() as f64 * r.cell_size * r.cell_size;
    if budget <= 0.0 || area < budget * MIN_AREA_RATIO {
        return Err(HostError::Map(format!(
            "layout.regions 中 {} 的面积 {area} 不足预算 {budget} 的 {MIN_AREA_RATIO}",
            r.id
        )));
    }
    Ok(())
}

/// 区域单元四邻连通。
fn check_connected(r: &Region, cells: &Cells) -> Result<(), HostError> {
    let Some(&first) = cells.first() else {
        return Err(HostError::Map(format!(
            "layout.regions 中 {} 没有单元",
            r.id
        )));
    };
    let mut left = cells.clone();
    left.remove(&first);
    let mut queue = vec![first];
    while let Some((x, y)) = queue.pop() {
        for p in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] {
            if left.remove(&p) {
                queue.push(p);
            }
        }
    }
    if !left.is_empty() {
        return Err(HostError::Map(format!(
            "layout.regions 中 {} 的单元不连通",
            r.id
        )));
    }
    Ok(())
}

/// 每处地点的到达点：显示坐标与节点坐标重合，且落在所属室外区域内。
fn check_arrivals(
    layout: &Layout,
    topo: &Topology,
    nodes: &BTreeMap<&str, Point>,
    regions: &BTreeMap<&str, Cells>,
) -> Result<(), HostError> {
    let marks: BTreeMap<&str, Point> = layout
        .stations
        .iter()
        .map(|m| (m.id.as_str(), [m.x, m.y]))
        .collect();
    for place in &topo.places {
        let station = topo.stations.get(&place.arrival_station).ok_or_else(|| {
            HostError::Map(format!(
                "地点 {} 的到达点 {} 不存在",
                place.locale, place.arrival_station
            ))
        })?;
        let mark = marks.get(station.id.as_str()).ok_or_else(|| {
            HostError::Map(format!(
                "到达点 {} 在 layout.stations 中没有坐标",
                station.id
            ))
        })?;
        let node = station.node.as_deref();
        let at = node
            .and_then(|n| nodes.get(n))
            .ok_or_else(|| HostError::Map(format!("到达点 {} 的节点没有坐标", station.id)))?;
        if distance(*mark, *at) > EPS {
            return Err(HostError::Map(format!(
                "到达点 {} 的坐标偏离节点",
                station.id
            )));
        }
        if let Some(cells) = regions.get(place.locale.as_str()) {
            if !cells.contains(&cell_of(*mark, CELL_SIZE)) {
                return Err(HostError::Map(format!(
                    "到达点 {} 不在区域 {} 内",
                    station.id, place.locale
                )));
            }
        }
    }
    Ok(())
}

/// 道具与落脚点标记：室外的在画布内，室内的在所属房间的本地边界内。
fn check_marks_in_bounds(layout: &Layout, canvas: &Rect) -> Result<(), HostError> {
    let props = layout.props.iter().map(|m| ("props", m));
    let stations = layout.stations.iter().map(|m| ("stations", m));
    for (field, m) in props.chain(stations) {
        let p = [m.x, m.y];
        if m.space == OUTDOOR_SPACE {
            if !canvas.contains_exact(p) {
                return Err(HostError::Map(format!(
                    "layout.{field} 中 {} 越出画布",
                    m.id
                )));
            }
            continue;
        }
        let room = layout
            .spaces
            .iter()
            .find(|s| s.id == m.space)
            .ok_or_else(|| {
                HostError::Map(format!(
                    "layout.{field} 中 {} 的 space {} 不存在",
                    m.id, m.space
                ))
            })?;
        let b = &room.bounds;
        let local = Rect {
            x: b.x,
            y: b.y,
            w: b.width,
            h: b.height,
        };
        if !local.contains_exact(p) {
            return Err(HostError::Map(format!(
                "layout.{field} 中 {} 不在房间 {} 的范围内",
                m.id, m.space
            )));
        }
    }
    Ok(())
}

/// 室外道具的标记落在所属区域的单元内。
fn check_props_in_regions(
    layout: &Layout,
    topo: &Topology,
    regions: &BTreeMap<&str, Cells>,
) -> Result<(), HostError> {
    for p in topo.props() {
        let Some(cells) = regions.get(p.locale.as_str()) else {
            continue;
        };
        let mark =
            layout.props.iter().find(|m| m.id == p.id).ok_or_else(|| {
                HostError::Map(format!("道具 {} 缺少显示标记（layout.props）", p.id))
            })?;
        if !cells.contains(&cell_of([mark.x, mark.y], CELL_SIZE)) {
            return Err(HostError::Map(format!(
                "道具 {} 的标记不在区域 {} 内",
                p.id, p.locale
            )));
        }
    }
    Ok(())
}
