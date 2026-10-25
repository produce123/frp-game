//! 记忆页的一行：主题页、历史版本、原始事件或目标，统一取键、分类、时间与正文。
use crate::{
    notebook::{summary_day, Page},
    session::{Goal, Session},
};
use protocol::{
    GoalStatus, NoteStatus, NotebookCategory as Category, NotebookEntry, NotebookLink, WorldFact,
};
use std::hash::{Hash, Hasher};

pub(super) const PREVIEW_CHARS: usize = 800;

#[derive(Clone, Copy)]
pub(super) enum Record<'a> {
    Page(&'a Page),
    Revision(&'a Page),
    Event(&'a WorldFact),
    Goal(&'a Goal),
}

pub(super) fn page_category(path: &str) -> Category {
    if path.starts_with("summaries/") {
        Category::Recent
    } else if path.starts_with("people/") {
        Category::People
    } else if path.starts_with("places/") {
        Category::Places
    } else if path.starts_with("lessons/") {
        Category::Lessons
    } else {
        Category::SelfKnowledge
    }
}

impl<'a> Record<'a> {
    pub(super) fn key(self) -> String {
        match self {
            Self::Page(p) => format!("page:{}", p.path),
            Self::Revision(p) => format!("revision:{}", p.revision),
            Self::Event(e) => format!("event:{}", e.event_id),
            Self::Goal(g) => format!("goal:{}", g.id),
        }
    }
    pub(super) fn category(self) -> Category {
        match self {
            Self::Page(p) | Self::Revision(p) => page_category(&p.path),
            Self::Event(_) => Category::Events,
            Self::Goal(_) => Category::Goals,
        }
    }
    pub(super) fn text(self) -> &'a str {
        match self {
            Self::Page(p) | Self::Revision(p) => &p.text,
            Self::Event(e) => &e.text,
            Self::Goal(g) => &g.commitment,
        }
    }
    pub(super) fn at(self) -> f64 {
        match self {
            Self::Page(p) | Self::Revision(p) => p.updated_at,
            Self::Event(e) => e.at,
            Self::Goal(g) => g.updated_at,
        }
    }
    pub(super) fn day(self) -> Option<i64> {
        match self {
            Self::Page(p) | Self::Revision(p) => summary_day(&p.path),
            Self::Event(e) => Some(kernel::calendar::day_index(e.at) + 1),
            Self::Goal(_) => None,
        }
    }
    pub(super) fn ordinal(self) -> u64 {
        match self {
            Self::Page(p) | Self::Revision(p) => p.revision,
            Self::Event(e) => e.event_id,
            Self::Goal(_) => 0,
        }
    }
    pub(super) fn sources(self) -> &'a [u64] {
        match self {
            Self::Page(p) | Self::Revision(p) => &p.evidence,
            Self::Event(_) => &[],
            Self::Goal(g) => &g.evidence,
        }
    }
    pub(super) fn title(self) -> String {
        match self {
            Self::Page(p) | Self::Revision(p) => p.title.clone(),
            Self::Goal(g) => g.title.clone(),
            Self::Event(e) => format!("{} · 经历 #{}", e.kind.label(), e.event_id),
        }
    }
    pub(super) fn link(self) -> NotebookLink {
        NotebookLink {
            key: self.key(),
            title: self.title(),
            category: self.category(),
        }
    }
    pub(super) fn ongoing(self) -> bool {
        matches!(self, Self::Goal(g) if g.status.is_open())
    }
    pub(super) fn matches(self, search: &str) -> bool {
        self.title().to_lowercase().contains(search)
            || self.text().to_lowercase().contains(search)
            || matches!(self, Self::Goal(g) if g.reason.to_lowercase().contains(search) || g.next_steps.iter().any(|s| s.to_lowercase().contains(search)))
    }
    /// 主题页（人、地方、知识、自我认识）的可信状态；摘要、事件和目标没有。
    fn note_status(self) -> Option<NoteStatus> {
        match self {
            Self::Page(p) | Self::Revision(p) if self.category() != Category::Recent => {
                Some(p.status)
            }
            _ => None,
        }
    }
    fn goal_status(self) -> Option<GoalStatus> {
        match self {
            Self::Goal(g) => Some(g.status),
            _ => None,
        }
    }
    pub(super) fn entry(self, s: &Session, epoch: u64) -> NotebookEntry {
        // 包含全部字段，避免同一分钟内目标改动或同标题正文更新混用旧详情。
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        match self {
            Self::Page(p) | Self::Revision(p) => p.revision.hash(&mut hash),
            Self::Event(e) => e.event_id.hash(&mut hash),
            Self::Goal(g) => serde_json::to_string(g).unwrap_or_default().hash(&mut hash),
        }
        let history_count = match self {
            Self::Page(p) => s
                .notebook
                .history
                .iter()
                .filter(|old| old.path == p.path)
                .count(),
            _ => 0,
        };
        NotebookEntry {
            key: self.key(),
            version: format!("{epoch}:{}:{:x}", s.id, hash.finish()),
            category: self.category(),
            title: self.title(),
            text: self.text().chars().take(PREVIEW_CHARS).collect(),
            text_chars: self.text().chars().count(),
            at: self.at(),
            day: self.day(),
            note_status: self.note_status(),
            goal_status: self.goal_status(),
            source_count: self.sources().len(),
            history_count,
            pending: matches!(self, Self::Event(e) if e.event_id > s.notebook.through_event),
            next_steps: match self {
                Self::Goal(g) if g.status.is_open() => g.next_steps.clone(),
                _ => vec![],
            },
            reason: match self {
                Self::Goal(g) => g.reason.clone(),
                _ => String::new(),
            },
            related: vec![],
        }
    }
}
