//! 把地图文档编译成化身的行走地图：可走的面、障碍、落脚点、道具位置与门。不改地图或存档哈希。
use super::geometry::Point;
use super::model::{
    Layout, MapDocument, Plant, Route, Space, Spatial, OUTDOOR_SPACE, WALK_METRES_PER_MINUTE,
};
use crate::HostError;
use kernel::avatar::{Area, Obstacle, Portal, Spot, Surface, WalkMap};
use kernel::Topology;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

/// 旧二维地图道路以 144 SVG 单位/模拟分钟烘焙，对齐每分钟 12 米的步行速度。
const LEGACY_UNITS_PER_METRE: f64 = 12.;
/// 二维路段没写宽度时的路宽（SVG 单位）。
const DEFAULT_ROAD_WIDTH: f64 = 18.;
/// 二维道具图标只是功能标记，占地按这个半宽（米）算，不推断家具尺寸。
const MARK_HALF_METRES: f64 = 0.30;
/// 门槛两侧短通道的宽度（米）。
const THRESHOLD_WIDTH: f64 = 1.2;

/// 二维坐标换算成米。有三维数据时房间已摊开到画布，房间内坐标先加上房间的偏移。
struct Frame<'a> {
    units: f64,
    unfolded: Option<&'a [Space]>,
}

impl Frame<'_> {
    fn point(&self, p: Point) -> Point {
        [p[0] / self.units, p[1] / self.units]
    }

    fn in_space(&self, space: &str, p: Point) -> Point {
        match self
            .unfolded
            .and_then(|rooms| rooms.iter().find(|r| r.id == space))
        {
            Some(r) => self.point([p[0] + r.unfold.offset_x, p[1] + r.unfold.offset_y]),
            None => self.point(p),
        }
    }
}

pub fn compile(document: &Value, topo: &Topology) -> Result<Option<WalkMap>, HostError> {
    super::check_hd2d(document)?;
    let doc = MapDocument::deserialize(document).map_err(|e| HostError::Map(e.to_string()))?;
    let spatial = doc
        .spatial
        .as_ref()
        .map(Spatial::deserialize)
        .transpose()
        .map_err(|e| HostError::Map(format!("spatial 字段格式错误：{e}")))?;
    let layout = &doc.layout;
    let frame = Frame {
        units: spatial
            .as_ref()
            .map_or(LEGACY_UNITS_PER_METRE, |s| s.svg_units_per_metre),
        unfolded: spatial.as_ref().map(|_| layout.spaces.as_slice()),
    };
    let mut map = WalkMap {
        version: 1,
        svg_units_per_metre: frame.units,
        metres_per_minute: WALK_METRES_PER_MINUTE,
        outdoor_space: OUTDOOR_SPACE.into(),
        terrain: topo.navigation.as_ref().and_then(|s| s.terrain.clone()),
        sea_level: spatial
            .as_ref()
            .and_then(|s| s.terrain.as_ref())
            .map_or(0., |t| t.sea_level),
        ..Default::default()
    };
    let routes = spatial.as_ref().map_or(&[][..], |s| s.routes.as_slice());
    if let Some(s) = &spatial {
        add_vegetation(&mut map, &s.vegetation);
    }
    add_areas(&mut map, layout, &frame, topo);
    add_roads(&mut map, layout, &frame, routes);
    add_marks(&mut map, layout, &frame, topo);
    if let Some(s) = &spatial {
        add_spatial_marks(&mut map, layout, s);
    }
    add_doors(&mut map, layout, &frame, topo);
    if map.stations.is_empty() || map.surfaces.is_empty() {
        return Ok(None);
    }
    Ok(Some(map))
}

/// 有碰撞半径的树和石头挡路。
fn add_vegetation(map: &mut WalkMap, plants: &[Plant]) {
    for p in plants {
        let Some(radius) = p.collider_radius.filter(|r| r.is_finite() && *r > 0.) else {
            continue;
        };
        map.obstacles.push(Obstacle {
            id: format!("vegetation:{}", p.id),
            spot: Spot {
                locale: String::new(),
                space: OUTDOOR_SPACE.into(),
                position: [p.position[0], p.position[2]],
            },
            half: [radius, radius],
        });
    }
}

/// 驻留处所的地面：室外区域按网格，房间按矩形。
fn add_areas(map: &mut WalkMap, layout: &Layout, frame: &Frame, topo: &Topology) {
    for r in layout.regions.iter().filter(|r| topo.is_dwell(&r.id)) {
        map.surfaces.push(Surface {
            locale: r.id.clone(),
            space: OUTDOOR_SPACE.into(),
            area: Area::Cells {
                size: r.cell_size / frame.units,
                cells: r
                    .cells
                    .iter()
                    .map(|p| (p[0] as i32, p[1] as i32))
                    .collect::<BTreeSet<_>>(),
            },
        });
    }
    for room in layout.spaces.iter().filter(|r| topo.is_dwell(&r.id)) {
        let b = &room.bounds;
        map.surfaces.push(Surface {
            locale: room.id.clone(),
            space: room.id.clone(),
            area: Area::Rect {
                min: frame.in_space(&room.id, [b.x, b.y]),
                max: frame.in_space(&room.id, [b.x + b.width, b.y + b.height]),
            },
        });
    }
}

/// 室外路段连成道路，有三维路线时用路线的点和宽度；室内通道属于对应房间，不在这里加。
fn add_roads(map: &mut WalkMap, layout: &Layout, frame: &Frame, routes: &[Route]) {
    for edge in &layout.edges {
        let route = routes.iter().find(|r| r.id == edge.id);
        if route.is_some_and(|r| r.owner.is_some()) {
            continue;
        }
        let (points, width) = match route {
            Some(r) => (r.points.iter().map(|p| [p[0], p[2]]).collect(), r.width),
            None => (
                edge.polyline.iter().map(|p| frame.point(*p)).collect(),
                edge.width.unwrap_or(DEFAULT_ROAD_WIDTH) / frame.units,
            ),
        };
        map.surfaces.push(Surface {
            locale: edge.id.clone(),
            space: OUTDOOR_SPACE.into(),
            area: Area::Corridor { points, width },
        });
    }
}

/// 二维图上的落脚点和道具标记；拓扑里没有的跳过。
fn add_marks(map: &mut WalkMap, layout: &Layout, frame: &Frame, topo: &Topology) {
    for st in &layout.stations {
        let Some(t) = topo.stations.get(&st.id) else {
            continue;
        };
        map.stations.insert(
            st.id.clone(),
            Spot {
                locale: t.locale.clone(),
                space: st.space.clone(),
                position: frame.in_space(&st.space, [st.x, st.y]),
            },
        );
    }
    for prop in &layout.props {
        let Some(t) = topo.prop(&prop.id) else {
            continue;
        };
        let spot = Spot {
            locale: t.locale.clone(),
            space: prop.space.clone(),
            position: frame.in_space(&prop.space, [prop.x, prop.y]),
        };
        map.props.insert(prop.id.clone(), spot.clone());
        map.obstacles.push(Obstacle {
            id: prop.id.clone(),
            spot,
            half: [MARK_HALF_METRES, MARK_HALF_METRES],
        });
    }
}

/// 三维数据里的道具与落脚点覆盖二维标记：道具按锚点定位、按占地挡路，落脚点换成三维位置。
fn add_spatial_marks(map: &mut WalkMap, layout: &Layout, spatial: &Spatial) {
    for p in &spatial.props {
        let space = if layout.spaces.iter().any(|r| r.id == p.locale) {
            p.locale.clone()
        } else {
            OUTDOOR_SPACE.into()
        };
        let spot = Spot {
            locale: p.locale.clone(),
            space,
            position: [p.anchor[0], p.anchor[2]],
        };
        map.props.insert(p.id.clone(), spot.clone());
        map.obstacles.retain(|o| o.id != p.id);
        map.obstacles.push(Obstacle {
            id: p.id.clone(),
            spot: Spot {
                position: [p.position[0], p.position[2]],
                ..spot
            },
            half: [p.footprint[0] / 2., p.footprint[1] / 2.],
        });
    }
    for st in &spatial.stations {
        if let Some(spot) = map.stations.get_mut(&st.id) {
            spot.position = [st.position[0], st.position[2]];
        }
    }
}

/// 房间的门：拓扑里有可通行通道的才算门，门外、门内各留一段短通道，再加进出两个传送口。
fn add_doors(map: &mut WalkMap, layout: &Layout, frame: &Frame, topo: &Topology) {
    for room in &layout.spaces {
        let (Some(outside), Some(inside)) = (room.door_outside, room.door_inside_local) else {
            continue;
        };
        // 图上看起来像门的装饰不能穿越。
        let Some(passage) = topo.passages.iter().find(|p| {
            (p.a == room.id || p.b == room.id) && p.capabilities.iter().any(|c| c == "通行")
        }) else {
            continue;
        };
        let outer = if passage.a == room.id {
            &passage.b
        } else {
            &passage.a
        };
        let from = Spot {
            locale: outer.clone(),
            space: OUTDOOR_SPACE.into(),
            position: frame.point(outside),
        };
        let to = Spot {
            locale: room.id.clone(),
            space: room.id.clone(),
            position: frame.in_space(&room.id, inside),
        };
        // 短通道让角色能走到门口，本身不连通两个空间。
        for spot in [&from, &to] {
            map.surfaces.push(Surface {
                locale: spot.locale.clone(),
                space: spot.space.clone(),
                area: Area::Corridor {
                    points: vec![spot.position, spot.position],
                    width: THRESHOLD_WIDTH,
                },
            });
        }
        map.portals.push(Portal {
            id: format!("{}:enter", room.id),
            label: format!("进入{}", topo.locale_name(&room.id)),
            from: from.clone(),
            to: to.clone(),
        });
        map.portals.push(Portal {
            id: format!("{}:exit", room.id),
            label: "走出建筑".into(),
            from: to,
            to: from,
        });
    }
}

/// 默认地图过去由 manager 单独保存道具显示位置；一次性导入，不重写旧文件。
pub fn restore_prop_positions(
    world: &mut kernel::World,
    save: Option<&std::path::Path>,
) -> Result<(), HostError> {
    if !world.needs_walk_prop_layout() {
        return Ok(());
    }
    #[derive(Deserialize)]
    struct Mark {
        space: String,
        x: f64,
        y: f64,
    }
    let units = world.walk_map.as_ref().unwrap().svg_units_per_metre;
    let mut positions = std::collections::BTreeMap::new();
    if let Some(file) = save
        .and_then(|p| p.parent())
        .map(|p| p.join("prop-layout.json"))
    {
        match std::fs::read(&file) {
            Ok(bytes) => {
                let marks: std::collections::BTreeMap<String, Mark> =
                    serde_json::from_slice(&bytes)
                        .map_err(|e| HostError::Map(format!("读取已有二维道具布局失败：{e}")))?;
                positions.extend(
                    marks
                        .into_iter()
                        .map(|(id, p)| (id, (p.space, [p.x / units, p.y / units]))),
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(HostError::Map(format!("读取已有二维道具布局失败：{e}"))),
        }
    }
    world
        .restore_walk_props(positions)
        .map_err(|e| HostError::Map(e.to_string()))
}
