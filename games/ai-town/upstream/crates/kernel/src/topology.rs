//! 拓扑：MapDocument.topology 逻辑数据的加载与派生结构（节点图、处所索引）。
//! 这里的"节点"是纯拓扑实体（图的顶点），不含任何坐标——坐标在 atlas-2d 里。

use crate::error::{KernelError, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

mod entry;
pub use entry::EntryPoint;

/// 处所类型：驻留（可停留、可作目的地）或穿过（路段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocaleKind {
    Dwell,
    Transit,
}

/// 落脚点类型：地点到达点或道具操作位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StationKind {
    Arrival,
    Slot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Locale {
    pub id: String,
    pub name: String,
    pub kind: LocaleKind,
    #[serde(default)]
    pub minutes: Option<f64>,
    #[serde(default)]
    pub from_node: Option<String>,
    #[serde(default)]
    pub to_node: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Passage {
    pub id: String,
    pub a: String,
    pub b: String,
    pub node_a: String,
    pub node_b: String,
    pub minutes: f64,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Station {
    pub id: String,
    pub locale: String,
    pub name: String,
    pub kind: StationKind,
    #[serde(default)]
    pub node: Option<String>,
    #[serde(default)]
    pub activity_id: Option<String>,
    #[serde(default)]
    pub pose_family: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Place {
    pub name: String,
    pub locale: String,
    pub arrival_station: String,
    #[serde(rename = "type")]
    pub place_type: String,
    /// 是否可分配为住宅；与用于展示的地点类型无关。
    #[serde(default)]
    pub residential: bool,
    pub summary: String,
    /// 眼前可见的东西（广场：公告栏、花坛、路灯），进提示词的【周围】
    #[serde(default)]
    pub visible_features: Vec<String>,
}

/// 三餐时段（分钟，当日）与菜单；编译产物给出，缺省为空 = 不限时供餐（测试拓扑）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MealWindow {
    pub name: String,
    pub start: f64,
    pub end: f64,
    pub menu: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prop {
    #[serde(default)]
    pub portable: bool,
    #[serde(default = "crate::props::one")]
    pub stack_limit: u32,
    #[serde(default)]
    pub storage_slots: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition: Option<String>,
    #[serde(default)]
    pub board: Option<String>,
    #[serde(default)]
    pub readable: Option<crate::content::Text>,
    #[serde(default)]
    pub bulletin_board: bool,
    #[serde(default)]
    pub withdrawn: bool,
    pub id: String,
    pub name: String,
    /// 道具定义里的说明，村民观察和 inspect 时能看到。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    pub locale: String,
    pub verbs: Vec<PropVerb>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropVerb {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<crate::props::Action>,
    pub verb: String,
    #[serde(default)]
    pub duration_minutes: Option<f64>,
    #[serde(default)]
    pub effects: BTreeMap<String, f64>,
}

#[derive(Debug, Deserialize)]
struct TopologyFile {
    #[serde(default)]
    navigation: Option<crate::navigation::space::Space>,
    #[serde(default)]
    precise_navigation: bool,
    #[serde(default)]
    entry: Option<EntryPoint>,
    locales: Vec<Locale>,
    passages: Vec<Passage>,
    stations: Vec<Station>,
    places: Vec<Place>,
    props: Vec<serde_json::Value>,
    #[serde(default)]
    meals: Vec<MealWindow>,
}

/// 节点图上的一条链接。
#[derive(Debug, Clone)]
pub struct Link {
    pub to_node: String,
    pub minutes: f64,
    pub via: Via,
}

#[derive(Debug, Clone)]
pub enum Via {
    /// 穿过型处所（路段）
    Edge { locale: String },
    /// 门通道（穿门时长折入相邻路段，见 path.rs）
    Door { passage: String },
}

#[derive(Debug, Clone)]
pub struct Topology {
    pub navigation: Option<crate::navigation::space::Space>,
    pub precise_navigation: bool,
    /// 新人入口；缺省时由加入流程从有效地点中随机选择。
    pub entry: Option<EntryPoint>,
    pub locales: BTreeMap<String, Locale>,
    pub passages: Vec<Passage>,
    pub stations: BTreeMap<String, Station>,
    pub places: Vec<Place>,
    /// 道具表按地图顺序保存；编号查找走 `prop_index`，增删时同步维护。
    props: Vec<Prop>,
    prop_index: BTreeMap<String, usize>,
    pub meals: Vec<MealWindow>,
    /// node -> 所属驻留处所
    pub node_locale: BTreeMap<String, String>,
    /// 驻留处所 -> 其节点集
    pub locale_nodes: BTreeMap<String, Vec<String>>,
    /// 节点图
    pub graph: BTreeMap<String, Vec<Link>>,
    /// 驻留处所 -> 默认落脚点（地点到达点优先，否则字典序第一个）
    pub default_station: BTreeMap<String, String>,
    /// 道具操作点落脚点编号的前缀：道具 x 的操作点是「前缀 + x」。这是地图数据的约定，
    /// 由 host 加载地图后填入；为 None 时地图没有道具操作点。
    pub prop_station_prefix: Option<String>,
}

impl Topology {
    /// 道具实例按 `catalog` 展开；道具库由调用方从数据文件读入，内核不内嵌任何数据。
    pub fn from_json(json: &str, catalog: &crate::props::Catalog) -> Result<Self> {
        let f: TopologyFile =
            serde_json::from_str(json).map_err(|e| KernelError::topology(e.to_string()))?;
        let props = parse_props(f.props, &f.locales, catalog)?;
        let locales: BTreeMap<String, Locale> =
            f.locales.into_iter().map(|l| (l.id.clone(), l)).collect();
        let stations: BTreeMap<String, Station> =
            f.stations.into_iter().map(|s| (s.id.clone(), s)).collect();

        let mut node_locale = index_node_locales(&f.passages)?;
        // 没有对外通道的地点也有真实的到达节点。
        for s in stations.values().filter(|s| {
            locales
                .get(&s.locale)
                .is_some_and(|l| l.kind == LocaleKind::Dwell)
        }) {
            if let Some(node) = &s.node {
                if node_locale
                    .get(node)
                    .is_some_and(|locale| locale != &s.locale)
                {
                    return Err(KernelError::topology(format!(
                        "落脚点 {} 的节点不属于 {}",
                        s.id, s.locale
                    )));
                }
                node_locale.insert(node.clone(), s.locale.clone());
            }
        }
        let locale_nodes = index_locale_nodes(&node_locale);
        let mut graph = build_graph(&locales, &f.passages)?;
        for node in node_locale.keys() {
            graph.entry(node.clone()).or_default();
        }
        let default_station = default_stations(&stations, &f.places);

        let prop_index = index_props(&props);
        let topo = Topology {
            navigation: f.navigation,
            precise_navigation: f.precise_navigation,
            entry: f.entry,
            locales,
            passages: f.passages,
            stations,
            places: f.places,
            props,
            prop_index,
            meals: f.meals,
            node_locale,
            locale_nodes,
            graph,
            default_station,
            prop_station_prefix: None,
        };
        topo.validate_entry_sites()?;
        for p in &topo.props {
            topo.check_board(p.board.as_deref(), &p.locale, p.readable.as_ref())
                .map_err(|e| KernelError::context(format!("道具 {} 的公告关联无效：", p.id), e))?;
        }
        Ok(topo)
    }

    /// 公告必须挂在同一地点、未撤下的公告栏上；书籍与其他道具不能挂公告栏。
    pub fn check_board(
        &self,
        board: Option<&str>,
        locale: &str,
        content: Option<&crate::content::Text>,
    ) -> Result<()> {
        let bulletin = content.is_some_and(|t| t.kind == crate::content::Kind::Bulletin);
        if bulletin != board.is_some() {
            return Err(KernelError::topology(
                "公告必须关联公告栏，书籍或其他道具不能绑定公告栏",
            ));
        }
        if let Some(id) = board {
            let valid = self
                .prop(id)
                .is_some_and(|p| p.locale == locale && p.bulletin_board && !p.withdrawn);
            if !valid {
                return Err(KernelError::topology("公告栏不存在或不在同一地点"));
            }
        }
        Ok(())
    }

    /// 落脚点存在且属于这个处所。
    pub fn station_in(&self, station: &str, locale: &str) -> bool {
        self.stations
            .get(station)
            .is_some_and(|s| s.locale == locale)
    }

    pub fn is_dwell(&self, locale: &str) -> bool {
        self.locales
            .get(locale)
            .is_some_and(|l| l.kind == LocaleKind::Dwell)
    }

    pub fn prop(&self, id: &str) -> Option<&Prop> {
        self.prop_index.get(id).map(|i| &self.props[*i])
    }

    pub fn prop_mut(&mut self, id: &str) -> Option<&mut Prop> {
        self.prop_index.get(id).map(|i| &mut self.props[*i])
    }

    /// 全部道具，按地图顺序（含已撤下的）。
    pub fn props(&self) -> &[Prop] {
        &self.props
    }

    /// 逐件修改，不增删；顺序和编号不变，索引仍然有效。
    pub(crate) fn props_mut(&mut self) -> impl Iterator<Item = &mut Prop> {
        self.props.iter_mut()
    }

    pub(crate) fn push_prop(&mut self, prop: Prop) {
        self.prop_index.insert(prop.id.clone(), self.props.len());
        self.props.push(prop);
    }

    pub(crate) fn remove_prop(&mut self, id: &str) {
        self.props.retain(|p| p.id != id);
        self.prop_index = index_props(&self.props);
    }

    pub fn place_of(&self, locale: &str) -> Option<&Place> {
        self.places.iter().find(|p| p.locale == locale)
    }

    pub fn locale_name(&self, locale: &str) -> String {
        self.locales
            .get(locale)
            .map(|l| l.name.clone())
            .unwrap_or_else(|| locale.to_string())
    }

    /// 全图连通性检查（内容门槛用）：从任一节点可达全部节点。
    pub fn connected_node_count_from(&self, start: &str) -> usize {
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut stack = vec![start];
        while let Some(n) = stack.pop() {
            if !seen.insert(n) {
                continue;
            }
            if let Some(links) = self.graph.get(n) {
                for l in links {
                    stack.push(&l.to_node);
                }
            }
        }
        seen.len()
    }
}

/// 道具表：实例格式按道具库展开，旧格式直接读取；编号唯一且所属地点必须是驻留处所。
fn parse_props(
    values: Vec<serde_json::Value>,
    locales: &[Locale],
    catalog: &crate::props::Catalog,
) -> Result<Vec<Prop>> {
    let mut props = Vec::new();
    let mut prop_ids = BTreeSet::new();
    for value in values {
        let p: Prop = if value.get("definition").is_some() && value.get("verbs").is_none() {
            let instance = serde_json::from_value(value)
                .map_err(|e| KernelError::topology(format!("道具实例格式错误：{e}")))?;
            catalog.resolve(&instance)?
        } else {
            serde_json::from_value(value)
                .map_err(|e| KernelError::topology(format!("旧道具格式错误：{e}")))?
        };
        if !crate::props::stack_and_slots_valid(p.stack_limit, p.storage_slots)
            || (p.portable && (p.storage_slots > 0 || p.bulletin_board || p.board.is_some()))
        {
            return Err(KernelError::topology("道具携带、叠放或容器属性无效"));
        }
        if !prop_ids.insert(p.id.clone())
            || !locales
                .iter()
                .any(|l| l.id == p.locale && l.kind == LocaleKind::Dwell)
        {
            return Err(KernelError::topology(format!(
                "道具 {} 编号重复或所属地点无效",
                p.id
            )));
        }
        props.push(p);
    }
    Ok(props)
}

fn index_props(props: &[Prop]) -> BTreeMap<String, usize> {
    props
        .iter()
        .enumerate()
        .map(|(i, p)| (p.id.clone(), i))
        .collect()
}

fn index_node_locales(passages: &[Passage]) -> Result<BTreeMap<String, String>> {
    // node -> 驻留处所：由边端通道（node_a == node_b，b 是驻留侧）与门通道两端共同给出
    let mut node_locale: BTreeMap<String, String> = BTreeMap::new();
    let mut put = |node: &str, locale: &str| -> Result<()> {
        match node_locale.get(node) {
            Some(old) if old != locale => Err(KernelError::topology(format!(
                "节点 {node} 的处所归属冲突：{old} vs {locale}"
            ))),
            _ => {
                node_locale.insert(node.to_string(), locale.to_string());
                Ok(())
            }
        }
    };
    for p in passages {
        if p.node_a == p.node_b {
            // 边端通道：a 是穿过型，b 是驻留型
            put(&p.node_a, &p.b)?;
        } else {
            put(&p.node_a, &p.a)?;
            put(&p.node_b, &p.b)?;
        }
    }

    Ok(node_locale)
}

fn index_locale_nodes(node_locale: &BTreeMap<String, String>) -> BTreeMap<String, Vec<String>> {
    let mut locale_nodes: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (n, l) in node_locale {
        locale_nodes.entry(l.clone()).or_default().push(n.clone());
    }

    locale_nodes
}

fn build_graph(
    locales: &BTreeMap<String, Locale>,
    passages: &[Passage],
) -> Result<BTreeMap<String, Vec<Link>>> {
    let mut graph: BTreeMap<String, Vec<Link>> = BTreeMap::new();
    for l in locales.values() {
        if l.kind == LocaleKind::Transit {
            let (a, b) = (
                l.from_node
                    .clone()
                    .ok_or_else(|| KernelError::topology("transit 缺 from_node"))?,
                l.to_node
                    .clone()
                    .ok_or_else(|| KernelError::topology("transit 缺 to_node"))?,
            );
            let m = l
                .minutes
                .ok_or_else(|| KernelError::topology("transit 缺 minutes"))?;
            graph.entry(a.clone()).or_default().push(Link {
                to_node: b.clone(),
                minutes: m,
                via: Via::Edge {
                    locale: l.id.clone(),
                },
            });
            graph.entry(b).or_default().push(Link {
                to_node: a,
                minutes: m,
                via: Via::Edge {
                    locale: l.id.clone(),
                },
            });
        }
    }
    for p in passages {
        if p.node_a != p.node_b {
            for (x, y) in [(&p.node_a, &p.node_b), (&p.node_b, &p.node_a)] {
                graph.entry(x.clone()).or_default().push(Link {
                    to_node: y.clone(),
                    minutes: p.minutes,
                    via: Via::Door {
                        passage: p.id.clone(),
                    },
                });
            }
        }
    }
    // 确定性：邻接表排序
    for links in graph.values_mut() {
        links.sort_by(|a, b| a.to_node.cmp(&b.to_node));
    }

    Ok(graph)
}

fn default_stations(
    stations: &BTreeMap<String, Station>,
    places: &[Place],
) -> BTreeMap<String, String> {
    let mut default_station: BTreeMap<String, String> = BTreeMap::new();
    for st in stations.values() {
        default_station
            .entry(st.locale.clone())
            .or_insert_with(|| st.id.clone());
    }
    for pl in places {
        default_station.insert(pl.locale.clone(), pl.arrival_station.clone());
    }

    default_station
}
