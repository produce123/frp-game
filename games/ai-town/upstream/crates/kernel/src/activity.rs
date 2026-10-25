//! 活动状态及其时间推进。只修改自身进度和位置；完成后的世界后果由 World 处理。
use crate::intent::{BuiltinVerb, StopCond};
use crate::path::{Journey, Walk};
use crate::{is_daylight, DAWN, DAY, DUSK};
use protocol::{ActivityKind, At, VerbKind};
use std::collections::BTreeSet;

/// 时间比较的容差（分钟）：累计推进带来的浮点误差在这个量级以下视为已到。
const EPSILON: f64 = 1e-9;

// ---------- 活动 ----------

/// 人物行为的唯一载体。交谈、赠予等共同互动也是一个活动，不另设对话状态。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Activity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<crate::intent::Intent>,
    pub verb: String,
    /// 活动开始时所在的处所（移动中以 locus 为准）
    pub locale: String,
    /// 参与者集合。双人活动由同一互动编号关联，双方同步开始、完成或中断。
    pub participants: BTreeSet<String>,
    pub started_at: f64,
    pub kind: ActKind,
    #[serde(default)]
    pub action: Option<crate::action_state::ActionBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<crate::content::Pending>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum ActKind {
    /// 无进度语义：站立、旁听、发呆。多耗一秒无世界后果。
    Placeholder { cond: StopCond },
    /// 有进度语义：移动。
    Travel {
        journey: Journey,
        stage: TravelStage,
    },
    /// 有进度语义：定时活动（工作/睡觉）。
    Timed { cond: StopCond },
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum TravelStage {
    /// 起步穿门：原地等待，Locus 不变
    Lead { left: f64 },
    /// 第 idx 段路，段内已耗 t 分钟
    Walking { idx: usize, t: f64 },
}

impl Activity {
    pub(crate) fn advancing(&self) -> bool {
        !matches!(self.kind, ActKind::Placeholder { .. })
    }
    pub(crate) fn kind(&self) -> ActivityKind {
        if self.advancing() {
            ActivityKind::Advancing
        } else {
            ActivityKind::Placeholder
        }
    }
    pub(crate) fn is_travel(&self) -> bool {
        matches!(self.kind, ActKind::Travel { .. })
    }
    /// 动作种类：互动与背包操作按安装它们的来源，其余按活动形态。
    pub(crate) fn verb_kind(&self) -> VerbKind {
        if self.interaction.is_some() {
            return VerbKind::Interaction;
        }
        if self
            .action
            .as_ref()
            .is_some_and(|b| b.draft.inventory.is_some())
        {
            return VerbKind::Inventory;
        }
        match self.kind {
            ActKind::Travel { .. } => VerbKind::Goto,
            ActKind::Placeholder { .. } => VerbKind::Stay,
            ActKind::Timed { .. } => VerbKind::Prop,
        }
    }
    /// 无期占位：空等或交谈，只能由外部事件结束。
    pub(crate) fn is_open_ended(&self) -> bool {
        matches!(
            self.kind,
            ActKind::Placeholder {
                cond: StopCond::Never
            }
        )
    }
    /// 无期空等且不在互动里：等待新计划。
    pub(crate) fn is_idle(&self) -> bool {
        self.is_open_ended() && self.interaction.is_none()
    }
    /// 零时长占位：立刻结束、不写执行记录，只用来接上队首。
    pub(crate) fn is_instant(&self) -> bool {
        matches!(self.kind, ActKind::Placeholder { cond: StopCond::Duration(d) } if d == 0.0)
    }
}

impl Activity {
    pub(crate) fn new(id: &str, now: f64, locale: String, verb: &str, kind: ActKind) -> Self {
        Self {
            pending: None,
            verb: verb.into(),
            locale,
            participants: [id.to_string()].into(),
            started_at: now,
            kind,
            action: None,
            interaction: None,
            content: None,
        }
    }

    /// 零时长占位，动词只用于失败通知的文案。
    pub(crate) fn instant(id: &str, now: f64, locale: String, verb: &str) -> Self {
        Self::new(
            id,
            now,
            locale,
            verb,
            ActKind::Placeholder {
                cond: StopCond::Duration(0.0),
            },
        )
    }

    /// 零时长停留：下一步就接上队首。
    pub(crate) fn instant_stay(id: &str, now: f64, locale: String) -> Self {
        Self::instant(id, now, locale, BuiltinVerb::Stay.label())
    }

    pub(crate) fn waiting(id: &str, now: f64, locale: String) -> Self {
        Self::new(
            id,
            now,
            locale,
            BuiltinVerb::Stay.label(),
            ActKind::Placeholder {
                cond: StopCond::Never,
            },
        )
    }
}

/// 行程剩余分钟：起步等待加未走完的路段。
pub(crate) fn travel_minutes_left(journey: &Journey, stage: &TravelStage) -> f64 {
    let walks = |from: usize| {
        journey.walks[from..]
            .iter()
            .map(Walk::duration)
            .sum::<f64>()
    };
    match stage {
        TravelStage::Lead { left } => left + walks(0),
        TravelStage::Walking { idx, t } => walks(*idx) - t,
    }
    .max(0.0)
}

impl Activity {
    pub(crate) fn remaining(&self, now: f64) -> Option<f64> {
        match &self.kind {
            ActKind::Placeholder { cond } | ActKind::Timed { cond } => cond_minutes_left(cond, now),
            ActKind::Travel { journey, stage } => Some(travel_minutes_left(journey, stage)),
        }
    }

    /// 把当前活动推进至多 left 分钟。
    pub(crate) fn advance(&mut self, locus: &mut protocol::Locus, now: f64, left: f64) -> Advance {
        match &mut self.kind {
            ActKind::Placeholder { cond } | ActKind::Timed { cond } => {
                match cond_minutes_left(cond, now) {
                    None => Advance::Ongoing, // 无期占位：时间流走，无世界后果
                    Some(remain) if remain <= left + EPSILON => Advance::Done,
                    Some(remain) => {
                        if let StopCond::Duration(m) = cond {
                            *m = remain - left;
                        }
                        Advance::Ongoing
                    }
                }
            }
            ActKind::Travel { journey, stage } => advance_travel(journey, stage, locus, left),
        }
    }
}

fn advance_travel(
    journey: &Journey,
    stage: &mut TravelStage,
    locus: &mut protocol::Locus,
    left: f64,
) -> Advance {
    let mut budget = left;
    loop {
        match stage {
            TravelStage::Lead { left: wait } => {
                if *wait > budget {
                    *wait -= budget;
                    return Advance::Ongoing;
                }
                budget -= *wait;
                if journey.walks.is_empty() {
                    // 纯穿门行程：翻转处所即到达
                    return Advance::Done;
                }
                *stage = TravelStage::Walking { idx: 0, t: 0.0 };
                *locus = walk_locus(&journey.walks[0], 0.0);
            }
            TravelStage::Walking { idx, t } => {
                let w = &journey.walks[*idx];
                let remain = w.duration() - *t;
                if remain > budget {
                    *t += budget;
                    *locus = walk_locus(w, *t);
                    return Advance::Ongoing;
                }
                budget -= remain;
                if *idx + 1 < journey.walks.len() {
                    *idx += 1;
                    *t = 0.0;
                    *locus = walk_locus(&journey.walks[*idx], 0.0);
                } else {
                    return Advance::Done;
                }
            }
        }
    }
}

/// 距离下一次谓词满足还有多少分钟；已满足则为 0。
pub(crate) fn cond_minutes_left(cond: &StopCond, now: f64) -> Option<f64> {
    let tod = now.rem_euclid(DAY);
    match cond {
        StopCond::Duration(m) => Some(*m),
        StopCond::Dawn => {
            if is_daylight(now) {
                Some(0.0)
            } else {
                Some((DAWN - tod).rem_euclid(DAY))
            }
        }
        StopCond::Dusk => {
            if !is_daylight(now) {
                Some(0.0)
            } else {
                Some(DUSK - tod)
            }
        }
        StopCond::Never => None,
    }
}

pub(crate) fn walk_at(w: &Walk, t: f64) -> At {
    At::Transit {
        elapsed: w.progress_at(t),
        total: w.total,
        toward: w.toward.clone(),
    }
}

/// 路段上走了 t 分钟时的位置。
pub(crate) fn walk_locus(w: &Walk, t: f64) -> protocol::Locus {
    protocol::Locus {
        locale: w.edge.clone(),
        at: walk_at(w, t),
    }
}

pub(crate) enum Advance {
    /// 本步耗尽，活动未完
    Ongoing,
    /// 活动在本时间片结束时完成
    Done,
}
