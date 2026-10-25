//! 场景资源清单：spatial 校验用到的公共参数与文件列表，运行时放置用到的模型表。
//! 运行期从场景包目录读取；外观集编号来自地图的 assets.id，Rust 侧不写死任何一个。
use crate::HostError;
use serde::Deserialize;
use serde_json::Value;
use std::{collections::BTreeMap, path::Path};

#[derive(Deserialize, Clone)]
pub struct Manifest {
    pub id: String,
    pub version: u64,
    /// 文件名到字节数与摘要的表，与地图 assets.files 逐字比较。
    pub files: Value,
    pub parameters: Parameters,
    /// 道具定义编号（不带版本）→ 模型与占地；缺项用通用模型。
    #[serde(default)]
    pub props: BTreeMap<String, ModelSpec>,
}

/// 生成器与校验共用的参数；与 scripts/mapgen 读的是同一份文件。
#[derive(Deserialize, Clone)]
pub struct Parameters {
    pub svg_units_per_metre: f64,
    pub actor_radius: f64,
    pub max_slope: f64,
    pub metres_per_minute: f64,
    pub max_heightfield: u64,
    pub max_instances: usize,
    pub max_nav_nodes: usize,
    pub max_bytes: usize,
}

#[derive(Deserialize, Clone)]
pub struct ModelSpec {
    pub model: String,
    pub footprint: [f64; 2],
}

/// 读取 `<场景包目录>/<外观集>/manifest.json`。
pub fn load(scene_assets_dir: &Path, id: &str) -> Result<Manifest, HostError> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(HostError::Map(format!("assets.id 不支持：{id}")));
    }
    let path = scene_assets_dir.join(id).join("manifest.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| HostError::Map(format!("读取场景资源清单 {} 失败：{e}", path.display())))?;
    serde_json::from_str(&text)
        .map_err(|e| HostError::Map(format!("场景资源清单 {} 格式错误：{e}", path.display())))
}
