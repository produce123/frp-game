use crate::error::{KernelError, Result};
use protocol::WeatherKind;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WeatherRules {
    pub version: String,
    pub minimum_minutes: u32,
    pub maximum_minutes: u32,
    pub order: [WeatherKind; 7],
    pub transitions: [[u32; 7]; 7],
}
impl WeatherRules {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == "weather-v1",
            KernelError::snapshot("天气规则版本不支持")
        );
        ensure!(
            self.minimum_minutes >= 1
                && self.maximum_minutes >= self.minimum_minutes
                && self.maximum_minutes <= 1440,
            KernelError::snapshot("天气检查间隔无效")
        );
        ensure!(
            self.order == WeatherKind::ALL,
            KernelError::snapshot("天气枚举顺序无效")
        );
        ensure!(
            self.transitions
                .iter()
                .all(|r| r.iter().map(|n| u64::from(*n)).sum::<u64>() == 100),
            KernelError::snapshot("天气转移概率必须每行合计 100")
        );
        Ok(())
    }
}
