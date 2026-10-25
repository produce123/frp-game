//! 本轮相关的记忆：先从材料里取出焦点（涉及的对象与文字），再据此选主题页与自动记忆。
//! 主题页按焦点文字里提到的地点、道具和村民计分；自动记忆按焦点对象查索引。
use super::ResidentRuntime;
use crate::{
    event,
    memory::{distinct_records, MemoryRecord, RecallQuery},
    session::{GoalCondition, Session},
    AgentError,
};
use kernel::World;
use serde_json::{json, Value};
use std::collections::BTreeSet;

/// 每轮最多附带的主题页数。
const RELATED_NOTES: usize = 3;
/// 主题正文进入提示词的截断长度。
const NOTE_EXCERPT_CHARS: usize = 1000;
/// 每个焦点对象最多取的记忆数，以及去重后的总数上限。
const MEMORIES_PER_OBJECT: usize = 2;
const MEMORIES_TOTAL: usize = 6;

/// 一轮材料的焦点。
pub(super) struct Focus {
    /// 涉及对象的编号：事件 objects、在场的人、眼前道具、当前地点、开放目标的地点。
    pub objects: Vec<String>,
    /// 用来匹配主题页的原文。
    pub text: String,
}

impl Focus {
    /// 生活决策：从本轮观察取。
    pub fn of_observation(s: &Session, observation: &Value) -> Self {
        let strings = |value: &Value, key: &str| -> Vec<String> {
            value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item[key].as_str().map(str::to_string))
                .collect()
        };
        let mut objects: Vec<String> = Vec::new();
        for event in observation["events"].as_array().into_iter().flatten() {
            objects.extend(
                event["objects"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|o| o.as_str().map(str::to_string)),
            );
        }
        objects.extend(strings(&observation["people_here"], "id"));
        objects.extend(strings(&observation["visible_props"], "id"));
        objects.extend(observation["locale"].as_str().map(str::to_string));
        for goal in s.goals.values().filter(|g| g.status.is_open()) {
            if let GoalCondition::Action { locale, .. } = &goal.condition {
                objects.push(locale.clone());
            }
        }
        let mut seen = BTreeSet::new();
        objects.retain(|o| seen.insert(o.clone()));
        Self {
            objects,
            text: observation.to_string(),
        }
    }
    /// 整理轮次：从本批经历取。
    pub fn of_episodes(episodes: &[&MemoryRecord]) -> Self {
        let mut objects: Vec<String> = episodes.iter().flat_map(|m| m.objects.clone()).collect();
        objects.sort();
        objects.dedup();
        Self {
            objects,
            text: episodes
                .iter()
                .map(|e| e.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}

/// 地图上所有地点、道具和村民的名字与编号。
fn entity_names(world: &World) -> Vec<String> {
    let mut entities: Vec<String> = world
        .topo
        .places
        .iter()
        .flat_map(|p| [p.name.clone(), p.locale.clone()])
        .chain(
            world
                .topo
                .props()
                .iter()
                .flat_map(|p| [p.name.clone(), p.id.clone()]),
        )
        .chain(world.actor_ids().into_iter().flat_map(|id| {
            let name = world.actor(&id).map(|a| a.name.clone()).unwrap_or_default();
            [name, id]
        }))
        .filter(|e| e.chars().count() >= 2)
        .collect();
    entities.sort();
    entities.dedup();
    entities
}

/// 焦点文字与开放目标标题里出现的地点、道具和村民，凡在主题正文或标题中也出现的各计 1 分；
/// 主题来源事件发生在当前地点另加 1 分。`omit_shown` 时跳过本段会话已展示且未更新的主题。
pub(super) fn related_notes(
    world: &World,
    s: &Session,
    focus: &Focus,
    omit_shown: bool,
) -> Vec<Value> {
    let Some(actor) = world.actor(&s.actor_id) else {
        return vec![];
    };
    let locale = actor.locus.locale.as_str();
    let mut context = focus.text.clone();
    for goal in s.goals.values().filter(|g| g.status.is_open()) {
        context.push('\n');
        context.push_str(&goal.title);
    }
    let entities = entity_names(world);
    let mentioned: Vec<&String> = entities
        .iter()
        .filter(|e| context.contains(e.as_str()))
        .collect();
    let mut ranked: Vec<_> = s
        .notebook
        .pages
        .values()
        .filter(|p| p.path != "self.md")
        .map(|p| {
            let here = p
                .evidence
                .iter()
                .filter_map(|id| event(actor, *id))
                .any(|e| e.objects.iter().any(|o| o == locale));
            let hits = mentioned
                .iter()
                .filter(|e| p.text.contains(e.as_str()) || p.title.contains(e.as_str()))
                .count();
            (hits + usize::from(here), p)
        })
        .filter(|(score, _)| *score > 0)
        .collect();
    ranked.sort_by(|(a, x), (b, y)| b.cmp(a).then_with(|| y.updated_at.total_cmp(&x.updated_at)));
    ranked
        .into_iter()
        .filter(|(_, p)| {
            !omit_shown
                || !s
                    .shown
                    .shown_notes
                    .contains(&format!("{}@{}", p.path, p.revision))
        })
        .take(RELATED_NOTES)
        .map(|(_, p)| {
            json!({
                "path": p.path,
                "title": p.title,
                "revision": p.revision,
                "text": p.text.chars().take(NOTE_EXCERPT_CHARS).collect::<String>(),
                "status": p.status,
                "sources": p.evidence
            })
        })
        .collect()
}

impl ResidentRuntime {
    /// 自动记忆按焦点对象取，每个对象最多几条，去重后有总数上限。已展示过的不重复；
    /// 来源事件还在会话原文里的也不带，模型看得到原文。
    pub(super) fn context_memories(
        &mut self,
        s: &Session,
        focus: &Focus,
    ) -> Result<Vec<MemoryRecord>, AgentError> {
        let mut records = Vec::new();
        for object in &focus.objects {
            records.extend(self.index.recall(
                &s.actor_id,
                &s.memory,
                &RecallQuery {
                    object: Some(object.clone()),
                    limit: Some(MEMORIES_PER_OBJECT),
                    ..Default::default()
                },
            )?);
        }
        let folded = s.cursors.folded_through;
        Ok(distinct_records(
            records.iter().filter(|m| {
                !s.shown.shown_memory_ids.contains(&m.memory_id)
                    && m.event_ids.iter().all(|id| *id <= folded)
            }),
            MEMORIES_TOTAL,
        )
        .into_iter()
        .cloned()
        .collect())
    }
}
