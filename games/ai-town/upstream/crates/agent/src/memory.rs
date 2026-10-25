//! 长期记录与原始世界事件分开保存。只有自己的事件能成为记忆来源。
use crate::{event, tools::limits};
use kernel::World;
use protocol::{ActionResult, ActionStatus, FactKind, WorldFact};
pub use protocol::{EvidenceSource, MemoryKind, MemoryStatus};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

mod index;
pub use index::MemoryIndex;

/// 记忆正文进入提示词或检索结果时的截断长度。
pub const TEXT_PREVIEW_CHARS: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub memory_id: u64,
    pub actor_id: String,
    pub kind: MemoryKind,
    pub event_ids: Vec<u64>,
    pub at: f64,
    pub objects: Vec<String>,
    pub source: EvidenceSource,
    pub confidence: f64,
    pub status: MemoryStatus,
    pub text: String,
    pub protected: bool,
    pub replaces: Vec<u64>,
    pub key: String,
    pub revision: u64,
    /// 来源事件的种类；提炼出的认识与经验没有。
    #[serde(default)]
    pub fact_kind: Option<FactKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readable: Option<protocol::ReadableFact>,
}

/// 事件编号到事件的索引，整理一批回执时只建一次。
type Journal<'a> = BTreeMap<u64, &'a WorldFact>;

impl MemoryRecord {
    /// 阅读不按字数判断；短公告也可能直接改变下一步决定。
    pub fn has_content(&self) -> bool {
        self.readable.is_some()
            || matches!(
                self.fact_kind,
                Some(FactKind::Notice | FactKind::Speech | FactKind::Readable)
            )
            || self.text.chars().count() >= 40
    }
    fn blank(actor: &str, kind: MemoryKind, key: String) -> Self {
        Self {
            memory_id: 0,
            actor_id: actor.into(),
            kind,
            event_ids: vec![],
            at: 0.0,
            objects: vec![],
            source: EvidenceSource::Observed,
            confidence: 1.0,
            status: MemoryStatus::Active,
            text: String::new(),
            protected: false,
            replaces: vec![],
            key,
            revision: 0,
            fact_kind: None,
            readable: None,
        }
    }
    /// 原始经历：别人说的话记为转述，可信度减半。
    fn episode(actor: &str, event: &WorldFact, reported: bool) -> Self {
        Self {
            event_ids: vec![event.event_id],
            at: event.at,
            objects: event.objects.clone(),
            source: if reported {
                EvidenceSource::Reported
            } else {
                EvidenceSource::Observed
            },
            confidence: if reported { 0.5 } else { 1.0 },
            text: event.text.clone(),
            fact_kind: Some(event.kind),
            readable: event.readable.clone(),
            ..Self::blank(
                actor,
                MemoryKind::Episode,
                format!("event:{}", event.event_id),
            )
        }
    }
    /// 对某个对象最近一次动作结果的认识；失败结果受保护，直到同一动作成功。
    fn recognition(actor: &str, result: &ActionResult, key: String, journal: &Journal) -> Self {
        let text = match &result.reason {
            Some(reason) => format!(
                "最近一次尝试「{}」未完成：{reason}。这是当时的结果，不代表条件永远不变。",
                result.verb
            ),
            None => format!(
                "最近一次完成「{}」：{}",
                result.verb,
                result.changes.join("；")
            ),
        };
        let events = || result.event_ids.iter().filter_map(|id| journal.get(id));
        let mut objects: Vec<String> = events().flat_map(|e| e.objects.clone()).collect();
        objects.sort();
        objects.dedup();
        Self {
            event_ids: result.event_ids.clone(),
            at: result.ended_at,
            objects,
            text,
            protected: result.status != ActionStatus::Succeeded,
            readable: events().find_map(|e| e.readable.clone()),
            ..Self::blank(actor, MemoryKind::Recognition, key)
        }
    }
    /// 失败后的候选经验：再做同一动作前先检查条件。
    fn experience(actor: &str, result: &ActionResult, key: String, reason: &str) -> Self {
        Self {
            event_ids: result.event_ids.clone(),
            at: result.ended_at,
            source: EvidenceSource::Inferred,
            confidence: 0.5,
            status: MemoryStatus::Candidate,
            text: format!(
                "再次做「{}」前，应先检查相关条件。失败证据：{reason}。",
                result.verb
            ),
            protected: true,
            ..Self::blank(actor, MemoryKind::Experience, key)
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemoryStore {
    pub records: Vec<MemoryRecord>,
    pub ingested_cursor: u64,
    pub consolidated_cursor: u64,
    pub revision: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecallQuery {
    pub text: Option<String>,
    pub object: Option<String>,
    pub kind: Option<MemoryKind>,
    pub since: Option<f64>,
    pub until: Option<f64>,
    pub limit: Option<usize>,
}
impl RecallQuery {
    pub(crate) fn effective_limit(&self) -> usize {
        self.limit
            .unwrap_or(limits::RECALL_LIMIT_DEFAULT)
            .clamp(1, limits::RECALL_LIMIT_MAX)
    }
}

impl MemoryStore {
    pub fn ingest(&mut self, world: &World, actor: &str) {
        let Some(a) = world.actor(actor) else { return };
        for event in a.journal.events_after(self.ingested_cursor) {
            self.ingested_cursor = event.event_id;
            if event.text.trim().is_empty() {
                continue;
            }
            let reported = event.kind == FactKind::Speech
                && event.objects.first().is_some_and(|id| id != actor);
            // 同一次完成会同时产生旧日记和结构化回执；合并相同经历，保留两份原始来源。
            if let Some(last) = self.records.last_mut().filter(|m| {
                m.kind == MemoryKind::Episode
                    && m.at == event.at
                    && m.text == event.text
                    && (m.source == EvidenceSource::Reported) == reported
            }) {
                last.event_ids.push(event.event_id);
                last.objects.extend(event.objects.clone());
                last.objects.sort();
                last.objects.dedup();
                if event.readable.is_some() {
                    last.readable = event.readable.clone();
                }
                self.revision += 1;
                last.revision = self.revision;
                continue;
            }
            self.push(MemoryRecord::episode(actor, event, reported));
        }
    }

    /// 只处理新增动作回执；目标阶段结束、休息或日终调用，无新事件时不重复改写。
    pub fn consolidate(&mut self, world: &World, actor: &str) {
        self.ingest(world, actor);
        let Some(a) = world.actor(actor) else { return };
        let journal: Journal = a.journal.events.iter().map(|e| (e.event_id, e)).collect();
        let mut results: Vec<_> = a
            .actions
            .groups
            .values()
            .flat_map(|g| &g.results)
            .filter(|r| r.event_ids.iter().any(|id| *id > self.consolidated_cursor))
            .collect();
        results.sort_by_key(|r| r.event_ids.first().copied().unwrap_or(0));
        for result in results {
            // 阅读只保留客观 episode；主题认识由 Agent 自己提交。
            let reading = result
                .event_ids
                .iter()
                .any(|id| journal.get(id).is_some_and(|e| e.readable.is_some()));
            if result.status == ActionStatus::Cancelled || reading {
                continue;
            }
            self.note_result(actor, result, &journal);
        }
        self.consolidated_cursor = self.ingested_cursor;
    }

    /// 一条动作回执：更新「最近一次结果」的认识，失败时另记候选经验。
    fn note_result(&mut self, actor: &str, result: &ActionResult, journal: &Journal) {
        let object = result.prop_id.as_deref().unwrap_or(&result.verb);
        let key = format!("last_result:{object}:{}", result.verb);
        let replaces = self.retire(|r| {
            r.kind == MemoryKind::Recognition && r.key == key && r.status == MemoryStatus::Active
        });
        let failure_prefix = format!("failure:{object}:{}:", result.verb);
        if result.status == ActionStatus::Succeeded {
            self.unprotect(|m| {
                m.kind == MemoryKind::Experience
                    && m.protected
                    && m.key.starts_with(&failure_prefix)
            });
        }
        let mut record = MemoryRecord::recognition(actor, result, key, journal);
        record.replaces = replaces;
        self.push(record);
        if result.status != ActionStatus::Failed {
            return;
        }
        let reason = result.reason.as_deref().unwrap_or("未知原因");
        let key = format!("{failure_prefix}{reason}");
        if let Some(old) = self
            .records
            .iter_mut()
            .find(|r| r.kind == MemoryKind::Experience && r.key == key)
        {
            old.event_ids.extend(result.event_ids.iter().copied());
            old.event_ids.sort_unstable();
            old.event_ids.dedup();
            old.status = MemoryStatus::Active;
            old.confidence = 0.8;
            old.protected = true;
            old.at = result.ended_at;
            self.revision += 1;
            old.revision = self.revision;
        } else {
            self.push(MemoryRecord::experience(actor, result, key, reason));
        }
    }

    /// 把满足条件的记录标为已修正，返回它们的编号。
    fn retire(&mut self, select: impl Fn(&MemoryRecord) -> bool) -> Vec<u64> {
        let mut replaced = Vec::new();
        for old in self.records.iter_mut().filter(|r| select(r)) {
            self.revision += 1;
            old.status = MemoryStatus::Superseded;
            old.protected = false;
            old.revision = self.revision;
            replaced.push(old.memory_id);
        }
        replaced
    }
    fn unprotect(&mut self, select: impl Fn(&MemoryRecord) -> bool) {
        for old in self.records.iter_mut().filter(|r| select(r)) {
            self.revision += 1;
            old.protected = false;
            old.revision = self.revision;
        }
    }

    fn push(&mut self, mut record: MemoryRecord) {
        self.revision += 1;
        record.memory_id = self.records.len() as u64 + 1;
        record.revision = self.revision;
        self.records.push(record);
    }

    pub fn validate(&self, world: &World, actor: &str) -> Result<(), String> {
        let a = world.actor(actor).ok_or("记忆所属村民不存在")?;
        if self.consolidated_cursor > self.ingested_cursor
            || self.ingested_cursor > a.journal.cursor()
        {
            return Err("记忆事件游标超出世界事实".into());
        }
        for (i, record) in self.records.iter().enumerate() {
            if record.memory_id != i as u64 + 1
                || record.actor_id != actor
                || !(0.0..=1.0).contains(&record.confidence)
                || !record.at.is_finite()
                || record.at > world.minutes()
                || record.revision > self.revision
                || record.event_ids.is_empty()
                || record.event_ids.iter().any(|id| event(a, *id).is_none())
                || record
                    .replaces
                    .iter()
                    .any(|id| *id >= record.memory_id || *id == 0)
            {
                return Err("记忆身份、来源、修正关系或时间无效".into());
            }
        }
        Ok(())
    }
}

/// 检索和观察界面都不让同一件事的经历、认识、经验重复占用短列表。
pub(crate) fn distinct_records<'a>(
    records: impl IntoIterator<Item = &'a MemoryRecord>,
    limit: usize,
) -> Vec<&'a MemoryRecord> {
    let mut events = std::collections::BTreeSet::new();
    records
        .into_iter()
        .filter(|r| {
            if r.event_ids.iter().any(|id| events.contains(id)) {
                return false;
            }
            events.extend(r.event_ids.iter().copied());
            true
        })
        .take(limit)
        .collect()
}
