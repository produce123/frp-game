//! 身体动作的命令入口：Agent 动作组整组校验后入队；覆盖安排时结算中断回执。校验规则在 action_check.rs，账本在 action_results.rs。
use crate::action_check::{check_draft, normalize_drafts};
use crate::action_state::{ActionBinding, QueuedAction, GROUP_LIMIT};
use crate::error::{KernelError, Result};
use crate::intent::Intent;
use crate::path::{route, StartPoint};
use crate::{actor::Actor, world::Activity, World, ID_MAX_BYTES};
use protocol::{ActionDraft, ActionGroup, GroupStatus, ThoughtView, TriggerInfo};

impl World {
    /// 把居民交给 Agent 决策：尚未完成的旧安排按中断结算，队列随之清空。已经启用时不做任何事。
    pub fn enable_agent(&mut self, actor: &str) -> Result<()> {
        let a = self
            .actors
            .get(actor)
            .ok_or_else(|| KernelError::NoSuchActor(actor.into()))?;
        ensure!(
            !a.is_avatar(),
            KernelError::action("化身不能切换居民决策模式")
        );
        if a.actions.agent_controlled {
            return Ok(());
        }
        self.interrupt_actions(actor, "切换决策模式");
        self.actor_mut(actor).actions.agent_controlled = true;
        Ok(())
    }

    pub fn action_group(&self, actor: &str, group_id: &str) -> Option<&ActionGroup> {
        self.actors.get(actor)?.actions.groups.get(group_id)
    }

    /// command_id 由会话生成且不能复用；重送相同命令只读取原回执。
    pub fn run_actions(
        &mut self,
        actor: &str,
        command_id: &str,
        revision: u64,
        drafts: &[ActionDraft],
    ) -> Result<ActionGroup> {
        self.run_actions_from(actor, command_id, revision, drafts, false)
    }

    pub(crate) fn run_actions_from(
        &mut self,
        actor: &str,
        command_id: &str,
        revision: u64,
        drafts: &[ActionDraft],
        player: bool,
    ) -> Result<ActionGroup> {
        let drafts = normalize_drafts(&self.topo, drafts);
        let a = self
            .actors
            .get(actor)
            .ok_or_else(|| KernelError::NoSuchActor(actor.into()))?;
        ensure!(
            a.player_controlled() == player && a.controllable(),
            KernelError::action("该村民尚未启用 Agent")
        );
        if let Some(previous) = a.resent_group(command_id, &drafts)? {
            return Ok(previous);
        }
        a.check_new_group(command_id, revision, &drafts)?;
        let accepted = self.check_group(actor, command_id, &drafts)?;
        let group = ActionGroup {
            id: command_id.into(),
            accepted_at: self.minutes,
            actions: drafts,
            results: vec![],
            status: GroupStatus::Running,
        };
        let now = self.minutes;
        let a = self.actor_mut(actor);
        a.actions.groups.insert(command_id.into(), group.clone());
        if player {
            a.actions.player_groups.insert(command_id.into());
        }
        a.plan = accepted.into();
        a.current = Activity::instant_stay(actor, now, a.locus.locale.clone());
        // 安装队列不消费通知。只有运行器能确认它实际处理过的事件游标。
        Ok(group)
    }

    /// 逐项校验并推算位置：前往改变后续动作的执行处所，路线也在这里预查。
    fn check_group(
        &self,
        actor: &str,
        command_id: &str,
        drafts: &[ActionDraft],
    ) -> Result<Vec<QueuedAction>> {
        let a = &self.actors[actor];
        let bridge = if !a.player_controlled() && matches!(a.locus.at, protocol::At::Free { .. }) {
            Some(self.free_route(actor)?)
        } else {
            None
        };
        let origin = bridge
            .as_ref()
            .map(|r| protocol::Locus {
                locale: r.points.last().unwrap().locale.clone(),
                at: protocol::At::Station {
                    station: r.station.clone(),
                },
            })
            .unwrap_or_else(|| a.locus.clone());
        let mut start = StartPoint::at(&self.topo, &origin);
        let mut locale = origin.locale;
        let mut accepted = Vec::new();
        for (i, draft) in drafts.iter().enumerate() {
            let (intent, _spot) = check_draft(self, actor, draft, &locale)
                .map_err(|e| KernelError::context(format!("第 {} 项：", i + 1), e))?;
            if let Intent::Goto {
                locale: destination,
                station,
            } = &intent
            {
                route(&self.topo, &start, destination, station.as_deref())?;
                locale = destination.clone();
                start = StartPoint::Dwell {
                    locale: locale.clone(),
                };
            }
            accepted.push(QueuedAction::Tracked {
                intent,
                action: Box::new(ActionBinding {
                    action_id: ActionBinding::id_for(command_id, i),
                    group_id: command_id.into(),
                    draft: draft.clone(),
                }),
            });
        }
        Ok(accepted)
    }

    /// 覆盖安排时使在途回复失效，并为未完成动作结算唯一的中断回执。
    pub fn interrupt_actions(&mut self, actor: &str, reason: &str) {
        self.interrupt_interaction(actor, reason);
        let now = self.minutes;
        if let Some(a) = self.actors.get_mut(actor) {
            a.interrupt_actions(now, reason);
        }
    }

    /// 记下村民随决定留下的想法（自述）。不校验、不动世界、不清记忆；空白文本不记。
    pub fn note_thought(
        &mut self,
        actor_id: &str,
        text: &str,
        trigger: &str,
    ) -> Option<ThoughtView> {
        self.note_decision(actor_id, text, &TriggerInfo::text(trigger), true)
    }

    /// 只记进想法记录、不给地图心声：比如这一轮只是在查看或记目标。
    pub fn note_quiet_thought(
        &mut self,
        actor_id: &str,
        text: &str,
        trigger: &str,
    ) -> Option<ThoughtView> {
        self.note_decision(actor_id, text, &TriggerInfo::text(trigger), false)
    }

    fn note_decision(
        &mut self,
        actor_id: &str,
        text: &str,
        info: &TriggerInfo,
        voiced: bool,
    ) -> Option<ThoughtView> {
        let now = self.minutes;
        let a = self.actors.get_mut(actor_id)?;
        a.journal.note_decision(text, now, info, voiced)?;
        a.journal.view()
    }
}

impl Actor {
    /// 用过的命令编号：动作相同是重送，返回原回执；动作不同报错。没用过返回 None。
    fn resent_group(
        &self,
        command_id: &str,
        drafts: &[ActionDraft],
    ) -> Result<Option<ActionGroup>> {
        let Some(previous) = self.actions.groups.get(command_id) else {
            return Ok(None);
        };
        ensure!(
            previous.actions == drafts,
            KernelError::action("命令编号已用于不同动作，拒绝重复执行")
        );
        Ok(Some(previous.clone()))
    }

    /// 能不能接一组新动作：按当前修订号提交、身体能行动、不在双方活动里、没有执行中的动作组，
    /// 编号与组长在上限内，背包转移单独成组。
    fn check_new_group(
        &self,
        command_id: &str,
        revision: u64,
        drafts: &[ActionDraft],
    ) -> Result<()> {
        ensure!(
            self.actions.revision == revision,
            KernelError::action("安排已改变，请重新观察")
        );
        ensure!(
            !self.needs.incapacitated(),
            KernelError::physiology(self.needs.limitation())
        );
        ensure!(
            self.current.interaction.is_none(),
            KernelError::action("正在参与双方活动，请等待结果或先取消互动")
        );
        ensure!(
            !self
                .actions
                .groups
                .values()
                .any(|g| g.status == GroupStatus::Running),
            KernelError::action("已有身体动作执行中，请等待结果或先中断")
        );
        ensure!(
            !command_id.is_empty()
                && command_id.len() <= ID_MAX_BYTES
                && !drafts.is_empty()
                && drafts.len() <= GROUP_LIMIT,
            KernelError::action(format!(
                "命令编号须在 1–{ID_MAX_BYTES} 字节内，动作组须含 1–{GROUP_LIMIT} 项"
            ))
        );
        ensure!(
            drafts.len() == 1 || drafts.iter().all(|d| d.inventory.is_none()),
            KernelError::action("背包转移请单独提交，完成后重新观察物品")
        );
        Ok(())
    }
}
