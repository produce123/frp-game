//! 动作账本和队列一起验证，拒绝恢复缺组、重复编号或无法对应原动作的状态。
use crate::error::{KernelError, Result};
use crate::{
    action_state::{ActionBinding, ActionState, GROUP_LIMIT},
    actor::Actor,
};
use protocol::{ActionGroup, ActionStatus, GroupStatus};
use std::collections::BTreeSet;

pub(crate) fn validate(actor: &Actor, now: f64) -> Result<()> {
    // 先确认事件按编号递增：后面按编号二分查找回执的事件。
    validate_events(actor, now)?;
    let state = &actor.actions;
    let mut pending = validate_bindings(actor)?;
    let mut running = 0;
    for (id, group) in &state.groups {
        validate_group(id, group, actor, now)?;
        if group.status == GroupStatus::Running {
            running += 1;
            ensure!(
                group.results.len() < group.actions.len()
                    && group
                        .results
                        .iter()
                        .all(|r| r.status == ActionStatus::Succeeded)
                    && (group.results.len()..group.actions.len())
                        .all(|i| pending.remove(&ActionBinding::id_for(id, i))),
                KernelError::snapshot("存档未完成动作组与执行队列不一致")
            );
        } else {
            ensure!(
                group.results.len() == group.actions.len()
                    && (group.status != GroupStatus::Succeeded
                        || group
                            .results
                            .iter()
                            .all(|r| r.status == ActionStatus::Succeeded)),
                KernelError::snapshot("存档动作组缺少最终回执")
            );
        }
    }
    ensure!(
        running <= 1 && pending.is_empty(),
        KernelError::snapshot("同一村民存在多组并行身体动作")
    );
    Ok(())
}

/// 当前活动和队列里的每个动作都要对应所属动作组里同一位置的原草案；返回未完成的动作编号。
fn validate_bindings(actor: &Actor) -> Result<BTreeSet<String>> {
    let state: &ActionState = &actor.actions;
    let mut pending = BTreeSet::new();
    let bindings = actor
        .current
        .action
        .iter()
        .chain(actor.plan.iter().filter_map(|q| q.binding()));
    for binding in bindings {
        let group = state
            .groups
            .get(&binding.group_id)
            .ok_or_else(|| KernelError::snapshot("存档动作缺少所属动作组"))?;
        let matching_draft = group
            .actions
            .iter()
            .enumerate()
            .find(|(i, _)| binding.action_id == ActionBinding::id_for(&group.id, *i))
            .is_some_and(|(_, d)| *d == binding.draft);
        ensure!(
            group.status == GroupStatus::Running
                && (state.agent_controlled || actor.is_avatar())
                && matching_draft,
            KernelError::snapshot("存档活动编号、参数或执行状态不一致")
        );
        ensure!(
            pending.insert(binding.action_id.clone()),
            KernelError::snapshot("存档队列里动作编号重复")
        );
    }
    Ok(pending)
}

fn validate_group(id: &str, group: &ActionGroup, actor: &Actor, now: f64) -> Result<()> {
    ensure!(
        id == group.id
            && !id.is_empty()
            && !group.actions.is_empty()
            && group.actions.len() <= GROUP_LIMIT
            && group.accepted_at.is_finite()
            && group.accepted_at <= now
            && group.results.len() <= group.actions.len(),
        KernelError::snapshot("存档动作组无效")
    );
    for (i, result) in group.results.iter().enumerate() {
        let draft = &group.actions[i];
        let events_match = !result.event_ids.is_empty()
            && result.event_ids.iter().all(|id| {
                actor
                    .journal
                    .event(*id)
                    .is_some_and(|e| e.action_id.as_ref() == Some(&result.action_id))
            });
        ensure!(
            result.action_id == ActionBinding::id_for(id, i)
                && result.group_id == id
                && result.verb == draft.intent.verb
                && result.prop_id == draft.prop_id
                && result.ended_at.is_finite()
                && result.ended_at <= now
                && !result
                    .started_at
                    .is_some_and(|s| !s.is_finite() || s > result.ended_at)
                && events_match,
            KernelError::snapshot("存档动作回执与原命令或事件不一致")
        );
    }
    Ok(())
}

fn validate_events(actor: &Actor, now: f64) -> Result<()> {
    let mut previous = 0;
    for event in &actor.journal.events {
        ensure!(
            event.event_id > previous && event.at.is_finite() && event.at <= now,
            KernelError::snapshot("存档事件编号或时间无效")
        );
        previous = event.event_id;
    }
    Ok(())
}
