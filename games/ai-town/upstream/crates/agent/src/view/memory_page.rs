//! 面向人的记忆页。只读 Notebook 与本人的原始事件，不整理、不调用模型、不改索引。
mod record;
use crate::{runtime::ResidentRuntime, session::Session, AgentError};
use kernel::World;
use protocol::{
    NotebookCategory as Category, NotebookCount, NotebookDetail, NotebookDetailQuery,
    NotebookQuery, NotebookSection, NotebookView,
};
use record::Record;

const PAGE_SIZE: usize = 12;
const TEXT_CHARS: usize = 4000;
const SEARCH_CHARS: usize = 200;
/// 每条最近记录附带的相关主题数；首页展示的最近更新主题数。
const RELATED_LINKS: usize = 3;
const CATEGORIES: [Category; 7] = [
    Category::Recent,
    Category::People,
    Category::Places,
    Category::Lessons,
    Category::SelfKnowledge,
    Category::Goals,
    Category::Events,
];

fn records<'a>(s: &'a Session, w: &'a World) -> Vec<Record<'a>> {
    let mut rows: Vec<_> = s
        .notebook
        .pages
        .values()
        .filter(|p| !p.text.trim().is_empty())
        .map(Record::Page)
        .chain(s.goals.values().map(Record::Goal))
        .collect();
    if let Some(a) = w.actor(&s.actor_id) {
        rows.extend(
            a.journal
                .events
                .iter()
                .filter(|e| !e.text.trim().is_empty())
                .map(Record::Event),
        );
    }
    rows.sort_by(|a, b| {
        b.ongoing()
            .cmp(&a.ongoing())
            .then_with(|| b.at().total_cmp(&a.at()))
            .then_with(|| b.ordinal().cmp(&a.ordinal()))
            .then_with(|| a.key().cmp(&b.key()))
    });
    rows
}

fn range(offset: usize, total: usize, limit: usize) -> (usize, usize, Option<usize>) {
    let start = offset.min(total);
    let end = start.saturating_add(limit).min(total);
    (start, end, (end < total).then_some(end))
}

/// 列表页要显示的行：按分类或搜索词筛选；最近页按天再按时间排序。
fn select_rows<'a>(all: &[Record<'a>], query: &NotebookQuery) -> Vec<Record<'a>> {
    let search = query.search.trim().to_lowercase();
    let mut rows: Vec<_> = all
        .iter()
        .copied()
        .filter(|r| {
            if search.is_empty() {
                r.category() == query.category
            } else {
                r.matches(&search)
            }
        })
        .collect();
    if search.is_empty() && query.category == Category::Recent {
        rows.sort_by(|a, b| {
            b.day()
                .cmp(&a.day())
                .then_with(|| b.at().total_cmp(&a.at()))
        });
    }
    rows
}

/// 页起点：聚焦某条时跳到它所在页；删改或重置后请求旧页码时退回最后一页，而不是留下有总数的空白页。
fn page_offset(rows: &[Record], query: &NotebookQuery) -> usize {
    let focused = query
        .focus
        .as_ref()
        .and_then(|key| rows.iter().position(|r| r.key() == *key))
        .map(|index| index / PAGE_SIZE * PAGE_SIZE);
    focused
        .unwrap_or(query.offset)
        .min(rows.len().saturating_sub(1) / PAGE_SIZE * PAGE_SIZE)
}

impl ResidentRuntime {
    pub fn notebook_view(
        &self,
        world: &World,
        actor: &str,
        query: &NotebookQuery,
    ) -> Result<Option<NotebookView>, AgentError> {
        if query.search.chars().count() > SEARCH_CHARS {
            return Err(AgentError::Query(format!(
                "搜索词请控制在 {SEARCH_CHARS} 字以内"
            )));
        }
        let Some(s) = self.session(actor) else {
            return Ok(None);
        };
        let all = records(s, world);
        let counts = CATEGORIES
            .into_iter()
            .map(|category| NotebookCount {
                category,
                count: all.iter().filter(|r| r.category() == category).count(),
            })
            .collect();
        let rows = select_rows(&all, query);
        let offset = page_offset(&rows, query);
        let (_, end, next_offset) = range(offset, rows.len(), PAGE_SIZE);
        let topics: Vec<_> = all
            .iter()
            .copied()
            .filter(|r| matches!(r, Record::Page(_)) && r.category() != Category::Recent)
            .collect();
        let entries = rows[offset..end]
            .iter()
            .map(|r| {
                let mut e = r.entry(s, self.state().epoch);
                if r.category() == Category::Recent {
                    e.related = topics
                        .iter()
                        .filter(|p| p.sources().iter().any(|id| r.sources().contains(id)))
                        .take(RELATED_LINKS)
                        .map(|r| r.link())
                        .collect();
                }
                e
            })
            .collect();
        Ok(Some(NotebookView {
            sim_minutes: world.minutes(),
            last_reflection_at: (s.notebook.through_event > 0)
                .then_some(s.notebook.last_reflection_at),
            reflecting: s.in_flight.is_some() && s.notebook.request.is_some(),
            retry_after: (s.notebook.failures > 0).then_some(s.notebook.retry_after),
            pending_events: all
                .iter()
                .filter(|r| matches!(r, Record::Event(e) if e.event_id > s.notebook.through_event))
                .count(),
            counts,
            offset,
            total: rows.len(),
            next_offset,
            entries,
            recent_updates: topics
                .into_iter()
                .take(RELATED_LINKS)
                .map(Record::link)
                .collect(),
        }))
    }

    pub fn notebook_detail(
        &self,
        world: &World,
        actor: &str,
        query: &NotebookDetailQuery,
    ) -> Result<NotebookDetail, AgentError> {
        let s = self
            .session(actor)
            .ok_or_else(|| AgentError::NotFound("该居民还没有记忆会话".into()))?;
        // key 只匹配本会话中的对象，不接受磁盘路径或另一位居民的目录。
        let record = records(s, world)
            .into_iter()
            .chain(s.notebook.history.iter().map(Record::Revision))
            .find(|r| r.key() == query.key)
            .ok_or_else(|| AgentError::Query("这条记录已不存在，请刷新记忆页".into()))?;
        let entry = record.entry(s, self.state().epoch);
        if entry.version != query.version {
            return Err(AgentError::Query("这条记录已更新，请刷新后重新展开".into()));
        }
        let mut detail = NotebookDetail {
            key: query.key.clone(),
            version: entry.version,
            section: query.section,
            offset: 0,
            total: 0,
            next_offset: None,
            text: String::new(),
            entries: vec![],
        };
        let mut rows: Vec<_> = match query.section {
            NotebookSection::Text => {
                let total = record.text().chars().count();
                let (start, end, next) = range(query.offset, total, TEXT_CHARS);
                detail.text = record
                    .text()
                    .chars()
                    .skip(start)
                    .take(end - start)
                    .collect();
                detail.offset = start;
                detail.total = total;
                detail.next_offset = next;
                return Ok(detail);
            }
            NotebookSection::Sources => world
                .actor(actor)
                .into_iter()
                .flat_map(|a| &a.journal.events)
                .filter(|e| record.sources().contains(&e.event_id))
                .map(Record::Event)
                .collect(),
            NotebookSection::History => match record {
                Record::Page(p) => s
                    .notebook
                    .history
                    .iter()
                    .filter(|old| old.path == p.path)
                    .map(Record::Revision)
                    .collect(),
                _ => vec![],
            },
        };
        rows.sort_by(|a, b| {
            b.at()
                .total_cmp(&a.at())
                .then_with(|| b.ordinal().cmp(&a.ordinal()))
        });
        let (start, end, next) = range(query.offset, rows.len(), PAGE_SIZE);
        detail.offset = start;
        detail.total = rows.len();
        detail.next_offset = next;
        detail.entries = rows[start..end]
            .iter()
            .map(|r| r.entry(s, self.state().epoch))
            .collect();
        Ok(detail)
    }
}
