//! 双方明确同意的互动。邀请与回应是命令，实际活动和最终结果由世界决定。
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InteractionKind {
    Talk,
    Give { items: Vec<String> },
    Serve { prop_id: String, verb: String },
}
impl InteractionKind {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Talk => "交谈",
            Self::Give { .. } => "赠予物品",
            Self::Serve { .. } => "招待用餐",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum InteractionCommand {
    Join {
        interaction_id: String,
        message: String,
    },
    Say {
        interaction_id: String,
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
    },
    Listen {
        interaction_id: String,
    },
    Leave {
        interaction_id: String,
        message: String,
    },
    Offer {
        partner_id: String,
        interaction: InteractionKind,
        message: String,
    },
    Reply {
        interaction_id: String,
        accept: bool,
        message: String,
    },
    Cancel {
        interaction_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionStatus {
    Offered,
    Running,
    Succeeded,
    Declined,
    Cancelled,
    Expired,
    Interrupted,
}
impl InteractionStatus {
    pub fn terminal(self) -> bool {
        !matches!(self, Self::Offered | Self::Running)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Interaction {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<crate::ChatState>,
    pub id: String,
    pub initiator: String,
    pub partner: String,
    pub locale: String,
    pub kind: InteractionKind,
    pub message: String,
    pub reply: Option<String>,
    pub accepted: Option<bool>,
    pub status: InteractionStatus,
    pub created_at: f64,
    pub expires_at: f64,
    pub started_at: Option<f64>,
    pub ended_at: Option<f64>,
    pub duration_minutes: f64,
    pub changes: Vec<String>,
    pub reason: Option<String>,
    pub event_ids: BTreeMap<String, Vec<u64>>,
}
impl Interaction {
    pub fn includes(&self, actor: &str) -> bool {
        self.initiator == actor
            || self.partner == actor
            || self
                .chat
                .as_ref()
                .is_some_and(|c| c.ever_members.contains(actor))
    }
}
