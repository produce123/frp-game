//! 只在旧存档读取边界处理已移除的委托；新世界和新命令不保留委托模型。
//! 历史文字、事件编号和已完成动作保留，未完成的依赖链明确中断。
use crate::HostError;
use serde_json::{json, Value};
use std::collections::BTreeSet;

const REASON: &str = "委托功能已移除，结束相关动作与目标；已发生的时间、身体变化和历史记录保留";

pub(super) fn migrate(saved: &mut Value) -> Result<bool, HostError> {
    if saved.pointer("/world/jobs").is_none() {
        return Ok(false);
    }
    let world = saved
        .get_mut("world")
        .ok_or_else(|| HostError::Save("旧存档缺少世界".into()))?;
    let now = world["minutes"]
        .as_f64()
        .ok_or_else(|| HostError::Save("旧存档时间无效".into()))?;
    let deliveries: BTreeSet<String> = world["interactions"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, i)| i["kind"]["kind"] == "deliver")
        .map(|(id, _)| id.clone())
        .collect();
    if let Some(items) = world["interactions"].as_object_mut() {
        items.retain(|id, _| !deliveries.contains(id));
    }
    let affected = migrate_actors(world, &deliveries, now)?;
    world
        .as_object_mut()
        .ok_or_else(|| HostError::Save("旧世界无效".into()))?
        .remove("jobs");
    let notices = migrate_sessions(saved, &deliveries, &affected);
    for (id, text) in notices {
        let actor = saved["world"]["actors"]
            .get_mut(&id)
            .ok_or_else(|| HostError::Save("旧会话对应人物不存在".into()))?;
        fact(actor, now, "observation", text, None)?;
    }
    Ok(true)
}

/// 取消带委托的动作组、去掉交付互动，返回受影响的人物编号。
fn migrate_actors(
    world: &mut Value,
    deliveries: &BTreeSet<String>,
    now: f64,
) -> Result<BTreeSet<String>, HostError> {
    let mut affected = BTreeSet::new();
    let actors = world["actors"]
        .as_object_mut()
        .ok_or_else(|| HostError::Save("旧存档人物表无效".into()))?;
    for (id, actor) in actors.iter_mut() {
        let groups: Vec<String> = actor["actions"]["groups"]
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, g)| {
                g["status"] == "running"
                    && g["actions"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|d| !d["job_id"].is_null()))
            })
            .map(|(id, _)| id.clone())
            .collect();
        let delivery = actor["current"]["interaction"]
            .as_str()
            .is_some_and(|id| deliveries.contains(id));
        for group in &groups {
            cancel_group(actor, group, now)?;
        }
        if !groups.is_empty() || delivery {
            affected.insert(id.clone());
            // 行走到一半时也保留 locus，后续寻路从当前位置继续。
            actor["current"] = json!({
                "verb": "停留", "locale": actor["locus"]["locale"], "participants": [id],
                "started_at": now, "kind": {"Placeholder": {"cond": "Never"}}, "action": null,
            });
            if let Some(plan) = actor["plan"].as_array_mut() {
                plan.retain(|q| {
                    !q["action"]["group_id"]
                        .as_str()
                        .is_some_and(|g| groups.iter().any(|id| id == g))
                });
            }
            let revision = actor["actions"]["revision"].as_u64().unwrap_or(0);
            actor["actions"]["revision"] = json!(revision
                .checked_add(1)
                .ok_or_else(|| HostError::Save("动作版本溢出".into()))?);
        }
        // 明确移除持久化命令的旧字段；在线 ActionDraft 仍拒绝未知参数。
        strip_job_ids(actor);
    }
    Ok(affected)
}

/// 会话里去掉委托目标、补齐交付对象的工具结果，返回要写进日志的通知。
fn migrate_sessions(
    saved: &mut Value,
    deliveries: &BTreeSet<String>,
    affected: &BTreeSet<String>,
) -> Vec<(String, String)> {
    let mut notices = Vec::new();
    let Some(sessions) = saved
        .pointer_mut("/resident_agent/runtime/sessions")
        .and_then(Value::as_object_mut)
    else {
        return notices;
    };
    for (actor, session) in sessions {
        let mut removed = Vec::new();
        if let Some(goals) = session["goals"].as_object_mut() {
            goals.retain(|_, goal| {
                let obsolete = goal["condition"]["kind"] == "product"
                    || (goal["condition"]["kind"] == "interaction"
                        && goal["condition"]["interaction_id"]
                            .as_str()
                            .is_some_and(|id| deliveries.contains(id)));
                if obsolete {
                    removed.push(goal.clone());
                }
                !obsolete
            });
        }
        // 交付对象已移除：补齐等待中的工具结果，保持会话的调用/结果配对。
        let mut replies = Vec::new();
        if let Some(pending) = session["pending"].as_array_mut() {
            pending.retain(|p| {
                let obsolete = p["kind"] == "interaction"
                    && p["interaction_id"]
                        .as_str()
                        .is_some_and(|id| deliveries.contains(id));
                if obsolete {
                    replies.push(json!({
                        "role": "tool",
                        "content": json!({"status": "interrupted", "reason": REASON}).to_string(),
                        "calls": [], "call_id": p["call"]["id"],
                    }));
                }
                !obsolete
            });
        }
        if let Some(messages) = session["messages"].as_array_mut() {
            messages.extend(replies);
        }
        let touched = affected.contains(actor) || !removed.is_empty();
        if touched {
            session["sleep"] = Value::Null;
        }
        session["known_tokens"] = Value::Null;
        session["sent_goals_digest"] = json!(0);
        if touched {
            let text = if removed.is_empty() {
                REASON.to_string()
            } else {
                format!("{REASON}。原目标记录：{}", Value::Array(removed))
            };
            notices.push((actor.clone(), text));
        }
    }
    notices
}

fn strip_job_ids(value: &mut Value) {
    match value {
        Value::Object(o) => {
            o.remove("job_id");
            for v in o.values_mut() {
                strip_job_ids(v);
            }
        }
        Value::Array(a) => {
            for v in a {
                strip_job_ids(v);
            }
        }
        _ => {}
    }
}

fn fact(
    actor: &mut Value,
    now: f64,
    kind: &str,
    text: String,
    action_id: Option<String>,
) -> Result<u64, HostError> {
    let events = actor["journal"]["events"]
        .as_array_mut()
        .ok_or_else(|| HostError::Save("旧存档事件表无效".into()))?;
    let id = events
        .last()
        .and_then(|e| e["event_id"].as_u64())
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| HostError::Save("事件编号溢出".into()))?;
    events.push(
        json!({"event_id":id,"at":now,"kind":kind,"text":text,"objects":[],"action_id":action_id}),
    );
    Ok(id)
}

fn cancel_group(actor: &mut Value, id: &str, now: f64) -> Result<(), HostError> {
    let group = actor["actions"]["groups"][id].clone();
    let actions = group["actions"]
        .as_array()
        .ok_or_else(|| HostError::Save("旧动作组无效".into()))?;
    let done = group["results"]
        .as_array()
        .ok_or_else(|| HostError::Save("旧动作回执无效".into()))?
        .len();
    if done >= actions.len() {
        return Err(HostError::Save("旧动作组完成状态不一致".into()));
    }
    let mut results = Vec::new();
    for (i, action) in actions.iter().enumerate().skip(done) {
        let action_id = format!("{id}/{i}");
        let running = actor["current"]["action"]["action_id"] == action_id;
        let event = fact(actor, now, "action", REASON.into(), Some(action_id.clone()))?;
        results.push(json!({
            "action_id": action_id, "group_id": id, "prop_id": action["prop_id"],
            "verb": action["intent"]["verb"],
            "started_at": if running { actor["current"]["started_at"].clone() } else { Value::Null },
            "ended_at": now, "status": if running { "interrupted" } else { "cancelled" },
            "changes": [], "reason": REASON, "event_ids": [event],
        }));
    }
    let group = &mut actor["actions"]["groups"][id];
    group["results"]
        .as_array_mut()
        .ok_or_else(|| HostError::Save("旧回执无效".into()))?
        .extend(results);
    group["status"] = json!("interrupted");
    Ok(())
}
