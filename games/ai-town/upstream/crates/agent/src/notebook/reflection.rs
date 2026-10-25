//! reflect 工具的提交：先全部校验，再一次写入；一次失败不留下半份摘要或推进游标。
use super::{day_path, valid_path, NoteStatus, Page, ReflectionBatch};
use crate::{event, memory::MemoryKind, prompts, resident, session::Session, tools::limits};
use kernel::World;
use serde::Deserialize;
use std::collections::BTreeSet;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReflectionUpdate {
    pub through_event: u64,
    pub summary: String,
    pub notes: Vec<NoteUpdate>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteUpdate {
    pub path: String,
    pub title: String,
    pub text: String,
    pub event_ids: Vec<u64>,
    pub status: NoteStatus,
    #[serde(default)]
    pub reading_quotes: Vec<ReadingQuote>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadingQuote {
    pub event_id: u64,
    pub text: String,
}

fn check_note(
    world: &World,
    session: &Session,
    batch: &ReflectionBatch,
    note: &NoteUpdate,
) -> Result<(), String> {
    let actor = resident(world, &session.actor_id).map_err(|e| e.to_string())?;
    if !valid_path(&note.path)
        || note.title.trim().is_empty()
        || note.title.chars().count() > limits::NOTE_TITLE_CHARS
        || note.text.trim().is_empty()
        || note.text.chars().count() > limits::NOTE_TEXT_CHARS
        || note.event_ids.is_empty()
        || note.event_ids.len() > limits::NOTE_EVENT_IDS_MAX
    {
        return Err("主题路径、正文或来源数量无效".into());
    }
    if note
        .event_ids
        .iter()
        .any(|id| *id > batch.through || event(actor, *id).is_none_or(|e| e.text.trim().is_empty()))
        || !note.event_ids.iter().any(|id| batch.event_ids.contains(id))
    {
        return Err("提炼必须引用本人已有的原始经历，且包含本批新证据".into());
    }
    let cites_reading = note
        .event_ids
        .iter()
        .any(|id| event(actor, *id).is_some_and(|e| e.readable.is_some()));
    if cites_reading && note.reading_quotes.is_empty() {
        return Err("引用阅读内容须提供 reading_quotes，核对实际读过版本的原文".into());
    }
    if note.reading_quotes.len() > limits::QUOTES_MAX {
        return Err(format!("每条笔记最多 {} 段摘录", limits::QUOTES_MAX));
    }
    for quote in &note.reading_quotes {
        let reading = world
            .contents()
            .reading_result(&session.actor_id, quote.event_id)
            .map_err(|e| e.to_string())?;
        if !note.event_ids.contains(&quote.event_id)
            || quote.text.trim().is_empty()
            || quote.text.chars().count() > limits::QUOTE_CHARS
            || !reading.content.text.contains(&quote.text)
        {
            return Err("摘录不属于引用的实际阅读正文".into());
        }
    }
    let occurrences = session
        .memory
        .records
        .iter()
        .filter(|m| {
            m.kind == MemoryKind::Episode
                && m.event_ids.iter().any(|id| note.event_ids.contains(id))
        })
        .count();
    if note.status == NoteStatus::Supported && occurrences < 2 {
        return Err("一件事的重复回执不是重复验证；支持中的认识至少需要两次不同经历".into());
    }
    Ok(())
}

fn check_update(
    world: &World,
    session: &Session,
    batch: &ReflectionBatch,
    update: &ReflectionUpdate,
) -> Result<(), String> {
    if update.through_event != batch.through
        || update.summary.trim().is_empty()
        || update.summary.chars().count() > limits::REFLECT_SUMMARY_CHARS
        || update.notes.len() > limits::NOTES_MAX
    {
        return Err("整理进度、摘要或主题数量无效".into());
    }
    let mut paths = BTreeSet::new();
    for note in &update.notes {
        if !paths.insert(&note.path) {
            return Err("主题路径、正文或来源数量无效".into());
        }
        check_note(world, session, batch, note)?;
    }
    Ok(())
}

pub fn apply_reflection(
    world: &World,
    session: &mut Session,
    update: ReflectionUpdate,
) -> Result<(), String> {
    let batch = session
        .notebook
        .request
        .clone()
        .ok_or("当前没有待提交的增量整理")?;
    check_update(world, session, &batch, &update)?;
    let now = world.minutes();
    for note in update.notes {
        replace(
            session,
            Page {
                path: note.path,
                title: note.title,
                text: note.text,
                evidence: note.event_ids,
                status: note.status,
                updated_at: now,
                revision: 0,
            },
        );
    }
    let path = day_path(batch.day);
    let previous = session.notebook.pages.get(&path);
    let text = match previous {
        Some(p) => {
            p.text.clone()
                + &prompts::day_summary_section(batch.from + 1, batch.through, &update.summary)
        }
        None => update.summary,
    };
    let mut evidence = previous.map(|p| p.evidence.clone()).unwrap_or_default();
    evidence.extend(batch.event_ids);
    evidence.sort_unstable();
    evidence.dedup();
    replace(
        session,
        Page {
            path,
            title: prompts::day_summary_title(batch.day),
            text,
            evidence,
            status: NoteStatus::Candidate,
            updated_at: now,
            revision: 0,
        },
    );
    let book = &mut session.notebook;
    book.through_event = batch.through;
    book.last_reflection_at = now;
    book.failures = 0;
    book.retry_after = now;
    book.request = None;
    book.reading_dialogue.clear();
    Ok(())
}
fn replace(session: &mut Session, mut page: Page) {
    session.notebook.revision += 1;
    page.revision = session.notebook.revision;
    if let Some(old) = session.notebook.pages.insert(page.path.clone(), page) {
        session.notebook.history.push(old);
    }
}
