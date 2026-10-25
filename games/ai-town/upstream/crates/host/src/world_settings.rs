//! 每个运行世界的设定，随世界存档保存。地图包只定义场景与资源。
use crate::HostError;
use serde::{Deserialize, Serialize};
use std::ops::RangeInclusive;

pub const MAX_WORLDVIEW_CHARS: usize = 6_000;
/// 平台新镇默认的世界观：不让玩家卡在"请先设置世界观"才能进自己的小镇。
/// 玩家在设定里改过之后以存档里的为准。
pub const DEFAULT_WORLDVIEW: &str =
    "这是一个安静的小镇：广场、集市、图书馆和河畔公园都在步行范围内。居民彼此认识，过着普通的日子，愿意和外来的人聊天。";
/// 人设加公共知识（世界观）合计的字数上限，直接沿用 Agent 会话指令上限。
pub use agent::runtime::INSTRUCTIONS_MAX_CHARS;
/// 世界速度（模拟分钟 / 现实秒）的允许范围；启动参数、命令和存档都按它检查。
pub const SPEED_RANGE: RangeInclusive<f64> = 0.0..=600.0;

/// 村民的会话指令：人设接公共知识（世界观），中间一个换行。人设与世界观的拼法只在这里。
pub fn instructions(persona: &str, worldview: &str) -> String {
    format!("{persona}\n{worldview}")
}

/// `instructions` 拼出来的字数，与 INSTRUCTIONS_MAX_CHARS 比较。
pub fn instructions_chars(persona: &str, worldview: &str) -> usize {
    persona.chars().count() + 1 + worldview.chars().count()
}

pub fn valid_speed(speed: f64) -> bool {
    speed.is_finite() && SPEED_RANGE.contains(&speed)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorldSettings {
    pub worldview: String,
    pub revision: u64,
    /// 旧存档里开发用「手动验证」模式的开关。这个模式已经删掉，只为读得进旧存档，不再使用也不再写出
    #[serde(default, rename = "autonomous", skip_serializing)]
    _autonomous: bool,
}

impl WorldSettings {
    pub fn ready(&self) -> bool {
        !self.worldview.trim().is_empty()
    }
    pub fn validate(&self) -> Result<(), HostError> {
        if self.worldview.chars().count() > MAX_WORLDVIEW_CHARS {
            return Err(HostError::Config(format!(
                "世界观最多 {MAX_WORLDVIEW_CHARS} 字"
            )));
        }
        Ok(())
    }
}
