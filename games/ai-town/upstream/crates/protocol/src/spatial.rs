//! 精确导航地图上运行时放置的道具：位置、占地与从地点入口过去的通路。
//! 既写进存档，也随修订号发给客户端。
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// 米制三维坐标（x、高度、z）。
pub type Point3 = [f64; 3];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PropPosition {
    pub id: String,
    pub locale: String,
    pub model: String,
    pub position: Point3,
    pub anchor: Point3,
    pub yaw: f64,
    pub footprint: [f64; 2],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Route {
    pub id: String,
    pub from: String,
    pub to: String,
    pub from_locale: String,
    pub to_locale: String,
    pub width: f64,
    pub points: Vec<Point3>,
    pub length: f64,
    pub minutes: f64,
    pub indoor: bool,
    #[serde(default)]
    pub owner: Option<String>,
}

/// 一件运行时道具的位置与它的通路。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpatialOverride {
    pub prop: PropPosition,
    pub route: Route,
}

/// 运行期空间覆盖与已移除道具，随导航修订号一起给客户端。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpatialOverridesView {
    #[serde(serialize_with = "crate::sorted")]
    pub overrides: Vec<SpatialOverride>,
    pub removed: BTreeSet<String>,
    pub revision: u64,
}
