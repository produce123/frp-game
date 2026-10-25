//! 可复用道具定义与地图实例。此模块没有文件系统或客户端几何依赖。
pub(crate) mod catalog;
mod commands;
mod description;
mod state;
pub(crate) mod views;
use crate::error::{KernelError, Result};
pub use catalog::Catalog;
pub use description::{action_description, action_description_for, capabilities};
use serde::{Deserialize, Serialize};
pub(crate) use state::split_supply_key;
pub use state::Props;
use std::collections::{BTreeMap, BTreeSet};

/// 一个世界里道具实例的总数上限（地图自带加运行时放置）。
pub const MAX_PROPS: usize = 4096;
/// 一件道具最多几个动作。
pub const MAX_ACTIONS: usize = 8;
/// 一叠最多几件；容器最多几格。
pub const MAX_STACK: u32 = 5;
pub const MAX_STORAGE_SLOTS: u32 = 80;

/// 叠放上限与容器格数在允许范围内。道具定义和地图里的旧格式道具共用。
pub(crate) fn stack_and_slots_valid(stack_limit: u32, storage_slots: u32) -> bool {
    (1..=MAX_STACK).contains(&stack_limit) && storage_slots <= MAX_STORAGE_SLOTS
}

/// 道具总数上限：已有 existing 件，再放进 incoming 件。
pub(crate) fn check_room(existing: usize, incoming: usize) -> Result<()> {
    ensure!(
        existing + incoming <= MAX_PROPS,
        KernelError::props(format!("当前世界道具数量已达上限 {MAX_PROPS}"))
    );
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    pub id: String,
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub portable: bool,
    #[serde(default = "one", skip_serializing_if = "is_one")]
    pub stack_limit: u32,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub storage_slots: u32,
    pub actions: Vec<Action>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readable: Option<crate::content::Text>,
    #[serde(default)]
    pub bulletin_board: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub id: String,
    pub label: String,
    pub duration_minutes: f64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub consumes_item: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portion_name: Option<String>,
    #[serde(default)]
    pub during: Vec<Effect>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub on_complete: Vec<InstantEffect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supply: Option<Supply>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub recipient: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub rest: bool,
    #[serde(default)]
    pub completion: Completion,
    #[serde(default)]
    pub conditions: Vec<Condition>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Effect {
    RestoreNeed {
        need: Need,
        per_minute: f64,
        pause_decay: bool,
    },
    Labor,
}
/// 四项身体需求，定义在 protocol：名册的需求条与道具效果都按它区分。
pub use protocol::Need;
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Supply {
    pub initial: u32,
    pub cost: u32,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InstantEffect {
    Restore {
        need: Need,
        amount: f64,
    },
    ApplyCondition {
        condition: protocol::BodyConditionKind,
        severity: f64,
    },
    CureCondition {
        condition: protocol::BodyConditionKind,
    },
    Revive {
        values: [f64; 4],
        clear_conditions: bool,
    },
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Completion {
    #[default]
    #[serde(alias = "inspect_goods")]
    Activity,
    Sleep,
    Meal,
    ReadBook,
    ReadBulletin,
    WriteBook,
    Research,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Condition {
    MealWindow,
    OwnHome,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Instance {
    pub id: String,
    pub definition: String,
    pub locale: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board: Option<String>,
}
/// 存档保存所放置的精确版本，库升级或删除不替换已放入世界的定义。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    pub instance: Instance,
    pub definition: Definition,
}

pub fn identifier(value: &str, namespaced: bool) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_:-".contains(&b))
        && (!namespaced || value.split(':').count() == 2 && value.split(':').all(|s| !s.is_empty()))
}
pub(crate) fn one() -> u32 {
    1
}
fn is_one(n: &u32) -> bool {
    *n == 1
}
fn is_zero(n: &u32) -> bool {
    *n == 0
}
impl Definition {
    pub fn reference(&self) -> String {
        format!("{}@{}", self.id, self.version)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            identifier(&self.id, true) && self.version > 0 && self.version <= 1_000_000,
            KernelError::props("道具编号须为 namespace:name，版本须为正整数")
        );
        ensure!(
            !self.name.trim().is_empty()
                && self.name.chars().count() <= 80
                && self.description.chars().count() <= 1000,
            KernelError::props("道具名称须为 1–80 字，说明最多 1000 字")
        );
        ensure!(
            stack_and_slots_valid(self.stack_limit, self.storage_slots)
                && !(self.portable && self.fixed_only()),
            KernelError::props("叠放上限须为 1–5；容器最多 80 格，容器和公告设施不能携带")
        );
        ensure!(
            self.actions.len() <= MAX_ACTIONS,
            KernelError::props(format!("每件道具最多 {MAX_ACTIONS} 个动作"))
        );
        if let Some(text) = &self.readable {
            text.validate()?;
        }
        let mut ids = BTreeSet::new();
        let mut labels = BTreeSet::new();
        for a in &self.actions {
            ensure!(
                identifier(&a.id, false)
                    && ids.insert(&a.id)
                    && !a.label.trim().is_empty()
                    && a.label.chars().count() <= 40
                    && labels.insert(&a.label)
                    && crate::intent::BuiltinVerb::parse(&a.label).is_none(),
                KernelError::props("动作编号和名称须有效、唯一，不能覆盖基础动作")
            );
            a.validate(self)?;
        }
        Ok(())
    }
    /// 容器和公告设施只能固定放置。
    fn fixed_only(&self) -> bool {
        self.storage_slots > 0
            || self.bulletin_board
            || self
                .readable
                .as_ref()
                .is_some_and(|t| t.kind == crate::content::Kind::Bulletin)
    }
}
impl Action {
    fn validate(&self, owner: &Definition) -> Result<()> {
        self.validate_portion(owner)?;
        self.validate_reading(owner)?;
        ensure!(
            self.duration_minutes.is_finite() && (1.0..=1440.0).contains(&self.duration_minutes),
            KernelError::props("动作时长须在 1–1440 分钟内")
        );
        ensure!(
            self.during.len() <= 5 && self.on_complete.len() <= 8 && self.conditions.len() <= 2,
            KernelError::props("动作效果或条件超限")
        );
        self.validate_during()?;
        ensure!(
            !self.recipient || (self.during.is_empty() && !self.on_complete.is_empty()),
            KernelError::props("对他人施用须使用完成时效果，不能包含持续效果")
        );
        if let Some(supply) = &self.supply {
            ensure!(
                supply.initial <= 1_000_000
                    && supply.cost > 0
                    && supply.cost <= 1_000_000
                    && !self.on_complete.is_empty()
                    && self.during.is_empty(),
                KernelError::props("有限补给须在完成时统一消耗和生效，数量不得超过一百万")
            );
        }
        self.validate_on_complete()?;
        ensure!(
            self.completion != Completion::Meal || self.conditions.contains(&Condition::MealWindow),
            KernelError::props("用餐动作必须检查供餐时段")
        );
        Ok(())
    }
    /// 消耗自身与领取单份只对可携带、有限补给的道具成立。
    fn validate_portion(&self, owner: &Definition) -> Result<()> {
        ensure!(
            !self.consumes_item
                || (owner.portable && self.supply.is_none() && !self.on_complete.is_empty()),
            KernelError::props("消耗自身仅用于可携带、无独立补给且有完成效果的道具")
        );
        if let Some(name) = &self.portion_name {
            ensure!(
                !name.trim().is_empty()
                    && name.chars().count() <= 80
                    && self.supply.is_some()
                    && !self.on_complete.is_empty()
                    && !self.consumes_item
                    && self.completion == Completion::Activity,
                KernelError::props("领取单份须填写 1–80 字名称，并使用有限补给及普通完成效果")
            );
        }
        Ok(())
    }
    /// 阅读动作要有对应正文；阅读和写作不带施用或消耗结算。
    fn validate_reading(&self, owner: &Definition) -> Result<()> {
        use crate::content::Kind;
        let expected = match self.completion {
            Completion::ReadBook => Some(Kind::Book),
            Completion::ReadBulletin => Some(Kind::Bulletin),
            _ => None,
        };
        ensure!(
            expected.is_none() || owner.readable.as_ref().map(|t| t.kind) == expected,
            KernelError::props("阅读动作必须定义对应的具体正文")
        );
        ensure!(
            !(expected.is_some() || self.completion == Completion::WriteBook)
                || (!self.recipient && self.on_complete.is_empty() && self.supply.is_none()),
            KernelError::props("阅读和写作不能组合施用或消耗结算")
        );
        Ok(())
    }
    fn validate_during(&self) -> Result<()> {
        let mut kinds = BTreeSet::new();
        for e in &self.during {
            let key = match e {
                Effect::RestoreNeed {
                    need, per_minute, ..
                } => {
                    ensure!(
                        per_minute.is_finite() && (0.001..=100.0).contains(per_minute),
                        KernelError::props("恢复速度须在 0.001–100 点/分钟内")
                    );
                    match need {
                        Need::Energy => "energy",
                        Need::Fullness => "fullness",
                        Need::Water => "water",
                        Need::Health => "health",
                    }
                }
                Effect::Labor => "labor",
            };
            ensure!(
                kinds.insert(key),
                KernelError::props("同一动作不能重复定义同类效果")
            );
        }
        Ok(())
    }
    fn validate_on_complete(&self) -> Result<()> {
        let revives = self
            .on_complete
            .iter()
            .filter(|e| matches!(e, InstantEffect::Revive { .. }))
            .count();
        ensure!(
            revives == 0 || (revives == 1 && self.on_complete.len() == 1 && self.during.is_empty()),
            KernelError::props("复活必须作为独立的原子效果")
        );
        for e in &self.on_complete {
            match e {
                InstantEffect::Restore { amount, .. } => ensure!(
                    amount.is_finite() && (0.001..=100.0).contains(amount),
                    KernelError::props("恢复量须为 0.001–100")
                ),
                InstantEffect::ApplyCondition { severity, .. } => ensure!(
                    severity.is_finite() && (1.0..=3.0).contains(severity),
                    KernelError::props("状况程度须为 1–3")
                ),
                InstantEffect::Revive { values, .. } => ensure!(
                    values
                        .iter()
                        .all(|v| v.is_finite() && (1.0..=100.0).contains(v)),
                    KernelError::props("复活后四项数值须为 1–100")
                ),
                InstantEffect::CureCondition { .. } => {}
            }
        }
        Ok(())
    }
}
