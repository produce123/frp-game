//! 确定性最短路与行程编译。
//!
//! 世界层寻路只在节点图上做（Dijkstra，按分钟）；几何无关的耗时是让 2D 与 3D
//! 跑出同一个世界的机制。精确导航地图包含室内操作点，移动时间同样由内核推进。
//!
//! 穿门时长的计入方式：门不是处所，穿门期间 Locus 无处可停，因此把门的分钟**折入
//! 相邻路段**（走完边后在门口多耗 extra 分钟；wire 上表现为 Transit 进度短暂停驻）。
//! 若行程以门开始且前面没有路段，则原地等待 lead_wait 分钟后翻转处所。

use crate::error::{KernelError, Result};
use crate::topology::{Topology, Via};
use std::collections::BTreeMap;

/// 一段沿穿过型处所的移动。进度是"沿边定义方向的一维位置（分钟）"，
/// 正走 0→total，反走 total→0；wire 上的 elapsed 就是当前进度值本身。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Walk {
    pub edge: String,
    pub from_progress: f64,
    pub to_progress: f64,
    /// 该边的总分钟（进度的值域上界）
    pub total: f64,
    /// 折入的穿门分钟：走到头后原地再耗这么久
    pub extra: f64,
    /// 正在接近的驻留处所（wire 的 toward）
    pub toward: String,
}

impl Walk {
    pub fn duration(&self) -> f64 {
        (self.to_progress - self.from_progress).abs() + self.extra
    }
    /// 段内已耗 t 分钟时的进度值（到头后停驻）。
    pub fn progress_at(&self, t: f64) -> f64 {
        let span = (self.to_progress - self.from_progress).abs();
        if span <= f64::EPSILON {
            return self.to_progress;
        }
        let frac = (t / span).clamp(0.0, 1.0);
        self.from_progress + (self.to_progress - self.from_progress) * frac
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Journey {
    /// 起步穿门等待（原地，Locus 不变）
    pub lead_wait: f64,
    pub walks: Vec<Walk>,
    pub dest_locale: String,
    pub dest_station: String,
}

impl Journey {
    pub fn total_minutes(&self) -> f64 {
        self.lead_wait + self.walks.iter().map(Walk::duration).sum::<f64>()
    }

    /// 目的落脚点的位置。
    pub(crate) fn destination(&self) -> protocol::Locus {
        protocol::Locus {
            locale: self.dest_locale.clone(),
            at: protocol::At::Station {
                station: self.dest_station.clone(),
            },
        }
    }
}

/// 寻路起点：既可从驻留处所出发，也可从边上某进度处出发（中断掉头合法）。
#[derive(Debug, Clone)]
pub enum StartPoint {
    Station { station: String },
    Dwell { locale: String },
    Transit { edge: String, progress: f64 },
}

impl StartPoint {
    /// 从人物当前位置出发。精确导航时落脚点带节点，否则按处所出发。
    pub(crate) fn at(topo: &Topology, locus: &protocol::Locus) -> Self {
        match &locus.at {
            protocol::At::Station { station } if topo.precise_navigation => StartPoint::Station {
                station: station.clone(),
            },
            protocol::At::Transit { elapsed, .. } => StartPoint::Transit {
                edge: locus.locale.clone(),
                progress: *elapsed,
            },
            _ => StartPoint::Dwell {
                locale: locus.locale.clone(),
            },
        }
    }
}

pub fn route(
    topo: &Topology,
    start: &StartPoint,
    dest_locale: &str,
    dest_station: Option<&str>,
) -> Result<Journey> {
    let station = match dest_station {
        Some(s) => s.to_string(),
        None => topo
            .default_station
            .get(dest_locale)
            .cloned()
            .ok_or_else(|| KernelError::navigation(format!("处所 {dest_locale} 没有任何落脚点")))?,
    };

    // 已在目的处所：处所内移动归前端，行程为零
    if let StartPoint::Dwell { locale } = start {
        if locale == dest_locale {
            return Ok(Journey {
                lead_wait: 0.0,
                walks: vec![],
                dest_locale: dest_locale.to_string(),
                dest_station: station,
            });
        }
    }

    let seeds = start_seeds(topo, start)?;
    let targets = destination_nodes(topo, &station, dest_locale)?;
    let path = shortest_path(topo, &seeds, &targets, dest_locale)?;
    Ok(compile_journey(
        topo,
        &seeds[path.seed],
        path,
        dest_locale,
        station,
    ))
}

struct Seed {
    node: String,
    cost: f64,
    walk: Option<Walk>,
}

struct SearchPath {
    seed: usize,
    origin: String,
    steps: Vec<(String, Via)>,
}

fn start_seeds(topo: &Topology, start: &StartPoint) -> Result<Vec<Seed>> {
    let mut seeds: Vec<Seed> = Vec::new();
    match start {
        StartPoint::Station { station } => {
            let node = topo
                .stations
                .get(station)
                .and_then(|s| s.node.clone())
                .ok_or_else(|| KernelError::navigation("起点没有导航节点"))?;
            seeds.push(Seed {
                node,
                cost: 0.0,
                walk: None,
            });
        }
        StartPoint::Dwell { locale } => {
            for n in topo
                .locale_nodes
                .get(locale)
                .ok_or_else(|| KernelError::navigation(format!("处所 {locale} 无节点，无法出发")))?
            {
                seeds.push(Seed {
                    node: n.clone(),
                    cost: 0.0,
                    walk: None,
                });
            }
        }
        StartPoint::Transit { edge, progress } => {
            let l = topo
                .locales
                .get(edge)
                .ok_or_else(|| KernelError::navigation("未知路段"))?;
            let (a, b) = (
                l.from_node
                    .clone()
                    .ok_or_else(|| KernelError::navigation("路段缺端点"))?,
                l.to_node
                    .clone()
                    .ok_or_else(|| KernelError::navigation("路段缺端点"))?,
            );
            let total = l.minutes.unwrap_or(0.0);
            let p = progress.clamp(0.0, total);
            // 退回 from_node：进度 p→0；继续到 to_node：进度 p→total
            seeds.push(Seed {
                node: a.clone(),
                cost: p,
                walk: Some(Walk {
                    edge: edge.clone(),
                    from_progress: p,
                    to_progress: 0.0,
                    total,
                    extra: 0.0,
                    toward: topo.node_locale.get(&a).cloned().unwrap_or_default(),
                }),
            });
            seeds.push(Seed {
                node: b.clone(),
                cost: total - p,
                walk: Some(Walk {
                    edge: edge.clone(),
                    from_progress: p,
                    to_progress: total,
                    total,
                    extra: 0.0,
                    toward: topo.node_locale.get(&b).cloned().unwrap_or_default(),
                }),
            });
        }
    }

    Ok(seeds)
}

fn destination_nodes(topo: &Topology, station: &str, dest_locale: &str) -> Result<Vec<String>> {
    // 指定落脚点带节点则只用该节点，否则使用目的处所的全部节点
    let targets: Vec<String> =
        match topo.stations.get(station).and_then(|s| s.node.clone()) {
            Some(n) if topo.node_locale.get(&n).map(String::as_str) == Some(dest_locale) => vec![n],
            _ => topo.locale_nodes.get(dest_locale).cloned().ok_or_else(|| {
                KernelError::navigation(format!("处所 {dest_locale} 无节点，不可达"))
            })?,
        };

    Ok(targets)
}

#[derive(Clone)]
struct Entry {
    cost: f64,
    parent: Option<(String, Via)>, // (前驱节点, 经由)
    seed: usize,
}

fn shortest_path(
    topo: &Topology,
    seeds: &[Seed],
    targets: &[String],
    dest_locale: &str,
) -> Result<SearchPath> {
    // Dijkstra，确定性 tiebreak：代价 → 节点 id 字典序。节点数在百量级，O(V²) 足矣。
    let mut best: BTreeMap<String, Entry> = BTreeMap::new();
    for (i, seed) in seeds.iter().enumerate() {
        let n = &seed.node;
        let c = &seed.cost;
        let better = match best.get(n) {
            Some(e) => *c < e.cost,
            None => true,
        };
        if better {
            best.insert(
                n.clone(),
                Entry {
                    cost: *c,
                    parent: None,
                    seed: i,
                },
            );
        }
    }
    let mut done: BTreeMap<String, Entry> = BTreeMap::new();
    let goal: String = loop {
        // 取未定节点里代价最小者（并列取 id 最小——BTreeMap 迭代序保证）
        let pick = best
            .iter()
            .filter(|(n, _)| !done.contains_key(*n))
            .min_by(|(an, ae), (bn, be)| ae.cost.total_cmp(&be.cost).then_with(|| an.cmp(bn)))
            .map(|(n, e)| (n.clone(), e.clone()));
        let Some((node, entry)) = pick else {
            return Err(KernelError::navigation(format!("不可达：{dest_locale}")));
        };
        done.insert(node.clone(), entry.clone());
        if targets.contains(&node) {
            break node;
        }
        for link in topo.graph.get(&node).into_iter().flatten() {
            let nc = entry.cost + link.minutes;
            let better = match best.get(&link.to_node) {
                Some(e) => {
                    nc < e.cost - 1e-12
                        || (nc <= e.cost + 1e-12 && matches!(&e.parent, Some((p, _)) if node < *p))
                }
                None => true,
            };
            if better && !done.contains_key(&link.to_node) {
                best.insert(
                    link.to_node.clone(),
                    Entry {
                        cost: nc,
                        parent: Some((node.clone(), link.via.clone())),
                        seed: entry.seed,
                    },
                );
            }
        }
    };

    Ok(reconstruct_path(&done, goal))
}

fn reconstruct_path(done: &BTreeMap<String, Entry>, goal: String) -> SearchPath {
    // 回溯出 (via) 序列
    let mut vias: Vec<(String, Via)> = Vec::new(); // (到达节点, 经由)
    let mut cur = goal.clone();
    let seed_idx = done[&goal].seed;
    while let Some((prev, via)) = done[&cur].parent.clone() {
        vias.push((cur.clone(), via));
        cur = prev;
    }
    vias.reverse();

    SearchPath {
        seed: seed_idx,
        origin: cur,
        steps: vias,
    }
}

fn compile_journey(
    topo: &Topology,
    seed: &Seed,
    path: SearchPath,
    dest_locale: &str,
    station: String,
) -> Journey {
    // 编译为行程：门折入相邻路段
    let mut lead_wait = 0.0;
    let mut walks: Vec<Walk> = Vec::new();
    if let Some(lead) = seed.walk.clone() {
        if lead.duration() > f64::EPSILON {
            walks.push(lead);
        }
    }
    let mut entered = path.origin; // 回溯终点即真正使用的种子节点
    debug_assert_eq!(entered, seed.node);
    for (arrive, via) in path.steps {
        match via {
            Via::Edge { locale } => {
                let l = &topo.locales[&locale];
                let total = l.minutes.unwrap_or(0.0);
                let forward = l.from_node.as_deref() == Some(entered.as_str());
                walks.push(Walk {
                    edge: locale,
                    from_progress: if forward { 0.0 } else { total },
                    to_progress: if forward { total } else { 0.0 },
                    total,
                    extra: 0.0,
                    toward: topo.node_locale.get(&arrive).cloned().unwrap_or_default(),
                });
            }
            Via::Door { passage } => {
                let m = topo
                    .passages
                    .iter()
                    .find(|p| p.id == passage)
                    .map(|p| p.minutes)
                    .unwrap_or(0.0);
                match walks.last_mut() {
                    Some(w) => w.extra += m,
                    None => lead_wait += m,
                }
            }
        }
        entered = arrive;
    }

    Journey {
        lead_wait,
        walks,
        dest_locale: dest_locale.to_string(),
        dest_station: station,
    }
}
