//! 动作组的账本：回执写进人物自己的动作组与日记。已完成的世界变化不回滚，未开始的依赖项明确取消。
use crate::{action_state::ActionBinding, actor::Actor};
use protocol::{ActionResult, ActionStatus, FactKind, GroupStatus};

impl Actor {
    /// 当前动作结算回执；未成功时取消队列里后续的跟踪动作。
    /// 返回已成功完成的阅读事件编号，由世界记入阅读结果。
    pub(crate) fn finish_tracked_action(
        &mut self,
        now: f64,
        status: ActionStatus,
        changes: Vec<String>,
        reason: Option<String>,
    ) -> Option<u64> {
        let binding = self.current.action.take()?;
        let started_at = Some(self.current.started_at);
        let reading =
            self.record_action_result(binding.result(started_at, now, status, changes, reason));
        if std::mem::take(&mut self.actions.cancel_after_current) {
            self.cancel_queued_actions(now, "重新安排，取消尚未开始的步骤");
        } else if status != ActionStatus::Succeeded {
            self.cancel_queued_actions(now, "前置动作未完成，取消后续步骤");
        }
        reading
    }

    /// 覆盖安排：使在途回复失效，为未完成动作结算唯一的中断回执，清空队列。
    pub(crate) fn interrupt_actions(&mut self, now: f64, reason: &str) {
        self.actions.bump_revision();
        let was_running = self.current.action.is_some();
        let elapsed = (now - self.current.started_at).max(0.0);
        self.finish_tracked_action(
            now,
            ActionStatus::Interrupted,
            vec![crate::outcome::elapsed(elapsed)],
            Some(reason.into()),
        );
        // 命令可能刚入队，尚未开始第一项。
        for group in self.actions.groups.values_mut() {
            if group.status == GroupStatus::Running {
                group.status = GroupStatus::Interrupted;
            }
        }
        self.cancel_queued_actions(now, reason);
        if was_running {
            self.reset_idle(now, false);
        }
    }

    /// 回执涉及的对象：所在处所、道具、背包操作的物品和容器。
    fn result_objects(&self, result: &ActionResult) -> Vec<String> {
        let mut objects = vec![self.locus.locale.clone()];
        objects.extend(result.prop_id.clone());
        let op = self
            .actions
            .groups
            .get(&result.group_id)
            .and_then(|group| group.actions.get(group.results.len()))
            .and_then(|d| d.inventory.as_ref());
        if let Some(op) = op {
            objects.extend(op.items().iter().cloned());
            match op {
                protocol::InventoryAction::Take { source, .. } => objects.push(source.clone()),
                protocol::InventoryAction::Store { container, .. }
                | protocol::InventoryAction::Retrieve { container, .. } => {
                    objects.push(container.clone())
                }
                _ => {}
            }
        }
        objects
    }

    fn record_action_result(&mut self, mut result: ActionResult) -> Option<u64> {
        let text = result.reason.as_ref().map_or_else(
            || result.changes.join("；"),
            |r| format!("{}：{r}", result.verb),
        );
        let mut objects = self.result_objects(&result);
        // 刚写入的阅读回执带正文来源，动作事件沿用同一来源。
        let readable = self
            .journal
            .events
            .last()
            .filter(|e| e.at == result.ended_at && e.text == text)
            .and_then(|e| e.readable.clone());
        objects.extend(readable.as_ref().map(|source| source.id.clone()));
        let reading_event = readable.is_some();
        let event_id = self.journal.fact(
            result.ended_at,
            FactKind::Action,
            text,
            objects,
            Some(result.action_id.clone()),
            readable,
        );
        result.event_ids.push(event_id);
        let status = result.status;
        let group = self
            .actions
            .groups
            .get_mut(&result.group_id)
            .expect("跟踪动作必有动作组");
        group.results.push(result);
        match status {
            ActionStatus::Failed => group.status = GroupStatus::Failed,
            ActionStatus::Interrupted => group.status = GroupStatus::Interrupted,
            _ => {}
        }
        if group.results.len() == group.actions.len() && group.status == GroupStatus::Running {
            group.status = if group
                .results
                .iter()
                .all(|r| r.status == ActionStatus::Succeeded)
            {
                GroupStatus::Succeeded
            } else {
                GroupStatus::Interrupted
            };
        }
        (reading_event && status == ActionStatus::Succeeded).then_some(event_id)
    }

    pub(crate) fn cancel_queued_actions(&mut self, now: f64, reason: &str) {
        let queued = std::mem::take(&mut self.plan);
        for item in queued {
            if let (_, Some(binding)) = item.into_parts() {
                self.record_action_result(binding.result(
                    None,
                    now,
                    ActionStatus::Cancelled,
                    vec![],
                    Some(reason.into()),
                ));
            }
        }
    }
}

impl ActionBinding {
    fn result(
        self,
        started_at: Option<f64>,
        ended_at: f64,
        status: ActionStatus,
        changes: Vec<String>,
        reason: Option<String>,
    ) -> ActionResult {
        ActionResult {
            action_id: self.action_id,
            group_id: self.group_id,
            prop_id: self.draft.prop_id,
            verb: self.draft.intent.verb,
            started_at,
            ended_at,
            status,
            changes,
            reason,
            event_ids: vec![],
        }
    }
}
