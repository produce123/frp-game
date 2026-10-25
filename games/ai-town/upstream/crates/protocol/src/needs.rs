//! 前后端共用的需求约束。参数的合法范围来自 `config/needs_rules.json`，由 host 在启动时读入并
//! 注入世界；前端读同一份文件。本 crate 不在编译期绑定它。
use serde::{Deserialize, Serialize};

/// 四项身体需求。内核按需求取值用 `needs::NeedValues`；复活效果的四项数值按 `ALL` 的顺序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Need {
    Fullness,
    Energy,
    Water,
    Health,
}
impl Need {
    pub const ALL: [Need; 4] = [Need::Fullness, Need::Energy, Need::Water, Need::Health];
    pub fn label(self) -> &'static str {
        match self {
            Self::Fullness => "饱腹",
            Self::Energy => "精力",
            Self::Water => "水分",
            Self::Health => "健康",
        }
    }
    /// 持续低值造成损害时的名称。
    pub fn shortage(self) -> &'static str {
        match self {
            Self::Fullness => "饥饿",
            Self::Energy => "过劳",
            Self::Water => "缺水",
            Self::Health => "健康损失",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedBand {
    Steady,
    Mild,
    Urgent,
    Collapse,
}

/// 一项身体需求的当前状态。band 用驱动文档的固定级名（正常/轻度/紧急/失控）。
/// text 是分级文字（「有点饿」），正常级为空——数值本身就是全部信息。
/// 前端按 kind 区分需求，need 是显示用的名字。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NeedState {
    pub kind: Need,
    pub need: String,
    pub value: f64,
    pub band: NeedBand,
    pub text: String,
}

/// 需求参数：衰减率与压力阈值，按人可调（个性在参数上的体现）。
/// 阈值语义：值低于 voiced 进「轻度」、低于 ring 进「紧急提醒」、低于 collapse 强制后果；
/// 紧急提醒触发后须回升过 ring_reset 才允许再次触发。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct NeedsTuning {
    /// 饱腹基础衰减（点/分钟，全天生效）
    pub fullness_decay: f64,
    /// 精力基础衰减（点/分钟，仅清醒时）
    pub energy_decay: f64,
    /// 劳作额外精力消耗（点/分钟，匀速，不按道具时长折算）
    pub labor_rate: f64,
    pub voiced: f64,
    pub ring: f64,
    pub ring_reset: f64,
    pub collapse: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ThresholdField {
    Collapse,
    Ring,
    RingReset,
    Voiced,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum Boundary {
    Value(f64),
    Field(ThresholdField),
}

impl Boundary {
    fn value(&self, tuning: &NeedsTuning) -> f64 {
        match self {
            Self::Value(value) => *value,
            Self::Field(ThresholdField::Collapse) => tuning.collapse,
            Self::Field(ThresholdField::Ring) => tuning.ring,
            Self::Field(ThresholdField::RingReset) => tuning.ring_reset,
            Self::Field(ThresholdField::Voiced) => tuning.voiced,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct ThresholdRule {
    lower: Boundary,
    upper: Boundary,
    inclusive: bool,
    /// 不满足时给用户看的原因；与前端用同一句。
    message: String,
}

/// 需求参数的合法范围：衰减率区间与阈值顺序。
#[derive(Debug, Clone, Deserialize)]
pub struct NeedRules {
    rate_min: f64,
    rate_max: f64,
    thresholds: Vec<ThresholdRule>,
}

impl NeedRules {
    /// 解析 `config/needs_rules.json` 的正文；前端只用的 `bands` 段被忽略。
    pub fn parse(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("需求规则文件无效：{e}"))
    }
}

impl NeedsTuning {
    pub fn band(&self, value: f64) -> NeedBand {
        if value >= self.voiced {
            NeedBand::Steady
        } else if value >= self.ring {
            NeedBand::Mild
        } else if value >= self.collapse {
            NeedBand::Urgent
        } else {
            NeedBand::Collapse
        }
    }

    pub fn validate(&self, rules: &NeedRules) -> Result<(), String> {
        let values = [
            self.fullness_decay,
            self.energy_decay,
            self.labor_rate,
            self.voiced,
            self.ring,
            self.ring_reset,
            self.collapse,
        ];
        if values.iter().any(|value| !value.is_finite()) {
            return Err("参数必须是有限数值".into());
        }
        if [self.fullness_decay, self.energy_decay, self.labor_rate]
            .iter()
            .any(|value| !(rules.rate_min..=rules.rate_max).contains(value))
        {
            return Err(format!(
                "衰减/劳作率须在 {}–{} 点/分钟",
                rules.rate_min, rules.rate_max
            ));
        }
        for rule in &rules.thresholds {
            let lower = rule.lower.value(self);
            let upper = rule.upper.value(self);
            let ordered = if rule.inclusive {
                lower <= upper
            } else {
                lower < upper
            };
            if !ordered {
                return Err(rule.message.clone());
            }
        }
        Ok(())
    }
}
