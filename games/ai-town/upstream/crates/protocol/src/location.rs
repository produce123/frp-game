//! 世界位置；Free 只由世界的化身移动器产生，Agent 意图仍不接收坐标。
use serde::{Deserialize, Serialize};

/// 处所内位置。Station = 落脚点；Transit = 穿过型处所内的一维进度。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum At {
    Free {
        space: String,
        /// 空间内 x/z 米制坐标；二维房间使用本地坐标。
        position: [f64; 2],
        /// 三维前端解算的地面高度和朝向；旧二维存档没有这两个字段。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        elevation: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        yaw: Option<f64>,
    },
    Station {
        station: String,
    },
    Transit {
        elapsed: f64,
        total: f64,
        toward: String,
    },
    Offstage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Locus {
    pub locale: String,
    pub at: At,
}
