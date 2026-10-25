//! 观察仪的目录记忆查询；与每次广播的 Agent 状态分开，正文和来源按需分页。
use crate::GoalStatus;
use serde::{Deserialize, Serialize};

/// 主题页认识的可信状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteStatus {
    Candidate,
    Supported,
    Rejected,
}
impl NoteStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Candidate => "候选认识",
            Self::Supported => "有多次经历支持",
            Self::Rejected => "已被新证据否定",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotebookCategory {
    #[default]
    Recent,
    People,
    Places,
    Lessons,
    SelfKnowledge,
    Goals,
    Events,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NotebookQuery {
    pub category: NotebookCategory,
    pub search: String,
    pub offset: usize,
    /// 从摘要关联入口跳到对应条目所在的一页。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focus: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotebookSection {
    Text,
    Sources,
    History,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotebookDetailQuery {
    pub key: String,
    pub version: String,
    pub section: NotebookSection,
    #[serde(default)]
    pub offset: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookLink {
    pub key: String,
    pub title: String,
    pub category: NotebookCategory,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookEntry {
    pub key: String,
    /// 世界代次、会话和条目版本。后续分段读取不得混用更新前后的正文。
    pub version: String,
    pub category: NotebookCategory,
    pub title: String,
    pub text: String,
    pub text_chars: usize,
    pub at: f64,
    pub day: Option<i64>,
    /// 主题页（人、地方、知识、自我认识）的可信状态；其他条目为空
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_status: Option<NoteStatus>,
    /// 目标条目的状态；其他条目为空
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_status: Option<GoalStatus>,
    pub source_count: usize,
    pub history_count: usize,
    pub pending: bool,
    pub next_steps: Vec<String>,
    pub reason: String,
    pub related: Vec<NotebookLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookCount {
    pub category: NotebookCategory,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookView {
    pub sim_minutes: f64,
    pub last_reflection_at: Option<f64>,
    pub reflecting: bool,
    pub retry_after: Option<f64>,
    pub pending_events: usize,
    pub counts: Vec<NotebookCount>,
    pub offset: usize,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub entries: Vec<NotebookEntry>,
    pub recent_updates: Vec<NotebookLink>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookDetail {
    pub key: String,
    pub version: String,
    pub section: NotebookSection,
    pub offset: usize,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub text: String,
    pub entries: Vec<NotebookEntry>,
}
