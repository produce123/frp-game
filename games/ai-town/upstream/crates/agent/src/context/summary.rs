//! 摘录先按证据类型和新旧选择，再按发生顺序展示；预算不足不等于后面的事没发生。
use crate::{
    conversation::{Message, Role},
    prompts,
    tools::ToolName,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub(super) const SECTION_CHARS: usize = 2000;
const OVERFLOW_CHARS: usize = 80;

fn clip(text: &str, chars: usize) -> String {
    text.chars()
        .take(chars)
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect()
}

/// 摘录及其优先级：0 最先保留。
type Excerpt = (u8, String);

#[derive(Default)]
struct Collector<'a> {
    excerpts: Vec<Excerpt>,
    event_ids: BTreeSet<u64>,
    times: Vec<f64>,
    /// 调用编号到工具名，供工具结果摘录使用。
    names: BTreeMap<&'a str, &'a str>,
}

impl<'a> Collector<'a> {
    fn user(&mut self, message: &Message) {
        let observation = match serde_json::from_str::<Value>(&message.content) {
            Ok(value) if value.get("observation").is_some() => value["observation"].clone(),
            _ => {
                let line = format!(
                    "{}{}",
                    prompts::SUMMARY_PROMPT_PREFIX,
                    clip(&message.content, 200)
                );
                self.excerpts.push((2, line));
                return;
            }
        };
        if let Some(at) = observation["sim_minutes"].as_f64() {
            self.times.push(at);
        }
        for event in observation["events"].as_array().into_iter().flatten() {
            let Some(event_id) = event["event_id"].as_u64() else {
                continue;
            };
            let text = event["text"].as_str().unwrap_or_default();
            if !self.event_ids.insert(event_id) || text.trim().is_empty() {
                continue;
            }
            let reading = event.get("readable").is_some_and(|v| !v.is_null());
            let priority = match event["kind"].as_str() {
                Some("readable" | "notice" | "speech" | "job" | "interaction") => 0,
                _ if reading => 0,
                _ => 1,
            };
            let source = event
                .get("readable")
                .filter(|v| !v.is_null())
                .map(|v| {
                    format!(
                        "〔来源 {}；版本 {}〕",
                        v["id"].as_str().unwrap_or_default(),
                        v["version"].as_str().unwrap_or_default()
                    )
                })
                .unwrap_or_default();
            let line = format!(
                "事件 #{event_id} {}{source}：{}",
                kernel::clock_string(event["at"].as_f64().unwrap_or(0.0)),
                clip(text, 200)
            );
            self.excerpts.push((priority, line));
        }
    }
    fn assistant(&mut self, message: &'a Message) {
        for call in &message.calls {
            self.names.insert(call.id.as_str(), call.name.as_str());
        }
        if !message.content.is_empty() {
            let line = format!(
                "{}{}",
                prompts::SUMMARY_THOUGHT_PREFIX,
                clip(&message.content, 120)
            );
            self.excerpts.push((3, line));
        }
    }
    fn tool(&mut self, message: &Message) {
        let call_id = message.call_id.as_deref().unwrap_or_default();
        let name = self.names.get(call_id).copied().unwrap_or_default();
        let value: Value = serde_json::from_str(&message.content).unwrap_or_default();
        let reading = name == ToolName::ReadContent.as_str()
            || value.get("reading_result").is_some()
            || value["result"].get("reading_result").is_some();
        if reading {
            let id = value
                .get("event_id")
                .unwrap_or(&value["result"]["event_id"]);
            self.excerpts.push((2, prompts::summary_reading(id)));
            return;
        }
        let failed = value["ok"] == false;
        let priority = if failed || name == ToolName::SetGoal.as_str() {
            0
        } else {
            2
        };
        let line = prompts::summary_tool(call_id, name, &clip(&message.content, 300));
        self.excerpts.push((priority, line));
    }
}

/// 折叠一批消息的摘要文本，以及其中最后一个事件的编号。
pub(super) fn summarize(messages: &[Message], id: u64) -> (String, Option<u64>) {
    let mut collector = Collector::default();
    for message in messages {
        match message.role {
            Role::User => collector.user(message),
            Role::Assistant => collector.assistant(message),
            Role::Tool => collector.tool(message),
            Role::System => {}
        }
    }
    let last_event = collector.event_ids.last().copied();
    let range = match (collector.event_ids.first(), collector.event_ids.last()) {
        (Some(a), Some(b)) => format!("事件 #{a}—#{b}"),
        _ => prompts::SUMMARY_NO_EVENTS.into(),
    };
    let span = match (collector.times.first(), collector.times.last()) {
        (Some(a), Some(b)) => format!(
            "，{}—{}",
            kernel::clock_string(*a),
            kernel::clock_string(*b)
        ),
        _ => String::new(),
    };
    let mut text = prompts::summary_header(id, &range, &span);
    let total = collector.excerpts.len();
    let mut ranked: Vec<_> = collector.excerpts.into_iter().enumerate().collect();
    // 同等类型优先保留后来的事实，避免开头的普通记录挤掉后面的关键变化。
    ranked.sort_by(|(i, (a, _)), (j, (b, _))| a.cmp(b).then_with(|| j.cmp(i)));
    let mut used = text.chars().count() + OVERFLOW_CHARS;
    let mut selected = Vec::new();
    for (index, (_, line)) in ranked {
        let cost = line.chars().count() + 1;
        if used + cost <= SECTION_CHARS {
            used += cost;
            selected.push((index, line));
        }
    }
    selected.sort_by_key(|(index, _)| *index);
    let omitted = total - selected.len();
    for (_, line) in selected {
        text.push('\n');
        text.push_str(&line);
    }
    if omitted > 0 {
        text.push_str(&prompts::summary_omitted(omitted));
    }
    (text, last_event)
}
