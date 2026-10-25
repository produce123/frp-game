//! 生理的世界入口：状况与复活命令，道具效果结算，能力变化后的活动处置，以及测试摆身体状态的直接设值。
use super::{body_spot, check_body_use, check_condition, check_revival, check_values, Rates};
use crate::error::{KernelError, Result};
use crate::{
    needs::{Abilities, NeedValues},
    props::{Action, InstantEffect, Need},
    World,
};
use protocol::{
    Alert, BodyConditionKind as C, BodyEventKind, DeathCause, NeedsTuning, PhysiologySwitches,
};

impl World {
    pub fn body_view(&self, id: &str) -> Option<protocol::BodyView> {
        let a = self.actors.get(id)?;
        let mut v = a.needs.view(a.needs.causes(body_spot(self, a)));
        v.revision = a.actions.revision;
        Some(v)
    }

    pub fn physiology(&self) -> PhysiologySwitches {
        self.physiology
    }

    /// 改世界级生理开关：不改任何数值；能力因此变化的人照常结算（中断或恢复活动）。
    pub fn set_physiology(&mut self, switches: PhysiologySwitches) {
        if self.physiology == switches {
            return;
        }
        self.physiology = switches;
        for id in self.actor_ids() {
            let was = self.actors[&id].needs.abilities();
            self.actor_mut(&id).needs.switches = switches;
            if !self.actors[&id].is_avatar() {
                self.reconcile_body(&id, was, "世界设定修改", DeathCause::default());
            }
        }
    }

    /// 改需求参数：先按规则校验，再应用；不重置当前值。
    pub fn tune_needs(&mut self, id: &str, tuning: NeedsTuning) -> Result<()> {
        tuning
            .validate(&self.need_rules)
            .map_err(KernelError::physiology)?;
        let a = self
            .actors
            .get_mut(id)
            .ok_or_else(|| KernelError::NoSuchActor(id.into()))?;
        a.needs.tuning = tuning;
        Ok(())
    }

    /// 测试用：只改饱腹和精力，见 `set_body_values`。
    pub fn set_need_values(
        &mut self,
        id: &str,
        fullness: Option<f64>,
        energy: Option<f64>,
    ) -> Result<()> {
        self.set_body_values(id, fullness, energy, None, None)
    }

    /// 时间片推进后的身体结算：紧急提醒、损害通知、能力变化。
    pub(crate) fn advance_needs(&mut self, dt: f64, rates: Vec<(String, Rates)>) {
        for (id, r) in rates {
            if self.actors[&id].needs.body.dead {
                continue;
            }
            let was = self.actors[&id].needs.abilities();
            let (urgent, notices) = self.actor_mut(&id).needs.advance(&r, dt);
            let a = &self.actors[&id];
            if urgent
                && a.actions.agent_controlled
                && (a.current.interaction.is_some()
                    || a.actions
                        .groups
                        .values()
                        .any(|g| g.status == protocol::GroupStatus::Running))
            {
                self.interrupt_actions(&id, "身体需求紧急，重新考虑当前安排");
            }
            for notice in notices {
                self.body_event(&id, BodyEventKind::Pressure, "生理变化", notice, None);
            }
            let n = &self.actors[&id].needs;
            if (n.health.value <= 0.0 && !n.body.dead) || n.abilities() != was {
                let spot = body_spot(self, &self.actors[&id]);
                let source = n.causes(spot).join("；");
                let cause = n.death_cause(spot);
                self.reconcile_body(&id, was, &source, cause);
            }
        }
    }

    /// 生命事件进历史、日记和观察日志；alert 是需要提示卡时的细节。
    pub(crate) fn body_event(
        &mut self,
        id: &str,
        kind: BodyEventKind,
        source: &str,
        text: String,
        alert: Option<Alert>,
    ) {
        let now = self.minutes;
        let a = self.actor_mut(id);
        let log = a.body_event(now, kind, source, text, alert.clone());
        let info = a.event_info().with_alert(alert);
        self.log(info, log);
    }

    /// 结算死亡与能力转换：中断不再能做的活动，记生命事件。cause 是随时间推进的损害来源，
    /// 死亡时作为提示卡的细节；能力转换时健康危重也要提示。
    pub(crate) fn reconcile_body(
        &mut self,
        id: &str,
        was: Abilities,
        source: &str,
        cause: DeathCause,
    ) {
        let now_minutes = self.minutes;
        let n = &mut self.actor_mut(id).needs;
        let died = n.settle_death();
        let now = n.abilities();
        let reason = n.limitation().to_string();
        if !died && now == was {
            return;
        }
        let alert = if died {
            Some(Alert::Death(cause))
        } else {
            n.critical().then_some(Alert::Critical)
        };
        // 包括恢复能力在内都使旧观察失效，死亡前回复不能在复活后执行。
        self.actor_mut(id).actions.bump_revision();
        let labor_spot = body_spot(self, &self.actors[id]).is_some_and(|s| s.labor);
        if died
            || now.incapacitated
            || (!now.can_move && self.actors[id].current.is_travel())
            || (!now.can_labor && labor_spot)
        {
            self.interrupt_actions(id, &reason);
            let a = self.actor_mut(id);
            a.reset_idle(now_minutes, false);
            if now.incapacitated {
                a.current.verb = if died { "死亡" } else { "无法自主活动" }.into();
            }
        }
        if !now.incapacitated && was.incapacitated {
            self.actor_mut(id).reset_idle(now_minutes, false);
        }
        self.body_event(
            id,
            if died {
                BodyEventKind::Death
            } else {
                BodyEventKind::Ability
            },
            source,
            if died {
                format!("健康耗尽，死亡。原因：{source}")
            } else {
                reason
            },
            alert,
        );
    }

    /// 测试用：直接设身体数值，摆出要验证的状态；None 表示不改。游戏里没有这个入口。
    pub fn set_body_values(
        &mut self,
        id: &str,
        f: Option<f64>,
        e: Option<f64>,
        w: Option<f64>,
        h: Option<f64>,
    ) -> Result<()> {
        let values = NeedValues {
            fullness: f,
            energy: e,
            water: w,
            health: h,
        };
        check_values(values)?;
        let n = &mut self
            .actors
            .get_mut(id)
            .ok_or_else(|| KernelError::NoSuchActor(id.into()))?
            .needs;
        let was = n.abilities();
        n.set_values(values)?;
        self.body_event(
            id,
            BodyEventKind::Experiment,
            "受控实验",
            "受控实验设置身体数值；不追溯计算损害".into(),
            None,
        );
        self.reconcile_body(id, was, "受控实验设置健康", DeathCause::default());
        Ok(())
    }

    pub fn apply_condition(
        &mut self,
        id: &str,
        kind: C,
        severity: f64,
        source: &str,
    ) -> Result<()> {
        check_condition(severity, source)?;
        let now = self.minutes;
        self.actors
            .get_mut(id)
            .ok_or_else(|| KernelError::NoSuchActor(id.into()))?
            .needs
            .add_condition(now, kind, severity, source)?;
        self.body_event(
            id,
            BodyEventKind::Condition,
            source,
            format!("出现{}；重复发生程度相加，上限 3", kind.label()),
            Some(Alert::Condition { condition: kind }),
        );
        Ok(())
    }

    pub fn cure_condition(&mut self, id: &str, kind: C, source: &str) -> Result<()> {
        self.actors
            .get_mut(id)
            .ok_or_else(|| KernelError::NoSuchActor(id.into()))?
            .needs
            .cure(kind)?;
        self.body_event(
            id,
            BodyEventKind::Cure,
            source,
            format!("解除{}，已损失的健康不自动补回", kind.label()),
            None,
        );
        Ok(())
    }

    pub fn revive(
        &mut self,
        id: &str,
        values: [f64; 4],
        clear_conditions: bool,
        source: &str,
    ) -> Result<()> {
        check_revival(values, source)?;
        self.actors
            .get_mut(id)
            .ok_or_else(|| KernelError::NoSuchActor(id.into()))?
            .needs
            .revive(values, clear_conditions)?;
        self.interrupt_actions(id, "复活后重新观察");
        let now = self.minutes;
        self.actor_mut(id).reset_idle(now, false);
        self.body_event(
            id,
            BodyEventKind::Revive,
            source,
            format!(
                "由 {source} 复活；{}原身体状况",
                if clear_conditions { "清除" } else { "保留" }
            ),
            None,
        );
        Ok(())
    }

    /// 定时道具动作完成时的身体结算：消耗补给、施加完成效果、通知双方。
    pub(crate) fn finish_body_use(&mut self, id: &str) -> Result<Vec<String>> {
        let Some(spot) = body_spot(self, &self.actors[id]).cloned() else {
            return Ok(vec![]);
        };
        let Some(action) = spot.action.clone() else {
            return Ok(vec![]);
        };
        if action.on_complete.is_empty() {
            return Ok(vec![]);
        }
        let a = &self.actors[id];
        let locale = a.locus.locale.clone();
        let recipient = a
            .current
            .action
            .as_ref()
            .and_then(|b| b.draft.recipient.clone());
        let source: String = format!("{}使用{}／{}", a.name, spot.prop_name, action.label)
            .chars()
            .take(240)
            .collect();
        a.needs.check_action(false, Some(&spot))?;
        check_body_use(self, id, &locale, &spot.prop, &action, recipient.as_deref())?;
        let target = recipient.unwrap_or_else(|| id.to_string());
        let was = self.actors[&target].needs.abilities();
        // 全部参数及动态条件已检查；此后无异步点，消耗和效果同一个世界事务完成。
        let mut changes = Vec::new();
        if let Some(s) = &action.supply {
            let remaining = self.props.consume_supply(&spot.prop, &action, 1);
            changes.push(crate::outcome::supply_used(s.cost, remaining));
        }
        changes.extend(self.apply_instant_effects(&target, &action, &source)?);
        if action.consumes_item {
            self.consume_carried_prop(&spot.prop);
        }
        self.reconcile_body(&target, was, &source, DeathCause::default());
        self.body_event(
            &target,
            BodyEventKind::Prop,
            &source,
            format!("{source}：{}", changes.join("；")),
            None,
        );
        if target != id {
            self.notify(&target, format!("接受{source}：{}", changes.join("；")));
            let text = format!(
                "对{}施用完成：{}",
                self.actors[&target].name,
                changes.join("；")
            );
            self.notify(id, text);
        }
        Ok(changes)
    }

    fn apply_instant_effects(
        &mut self,
        target: &str,
        action: &Action,
        source: &str,
    ) -> Result<Vec<String>> {
        let mut changes = Vec::new();
        for e in &action.on_complete {
            match e {
                InstantEffect::Restore { need, amount } => {
                    let gained = self.actor_mut(target).needs.restore(*need, *amount);
                    changes.push(crate::outcome::restored(
                        &self.actors[target].name,
                        *need,
                        gained,
                    ));
                }
                // 健康机制关闭时，状况既不新增也不解除。
                InstantEffect::ApplyCondition { .. } | InstantEffect::CureCondition { .. }
                    if !self.actors[target].needs.on(Need::Health) => {}
                InstantEffect::ApplyCondition {
                    condition,
                    severity,
                } => {
                    self.apply_condition(target, *condition, *severity, source)?;
                    changes.push(crate::outcome::condition_applied(condition.label()));
                }
                InstantEffect::CureCondition { condition } => {
                    self.cure_condition(target, *condition, source)?;
                    changes.push(crate::outcome::condition_cured(condition.label()));
                }
                InstantEffect::Revive {
                    values,
                    clear_conditions,
                } => {
                    self.revive(target, *values, *clear_conditions, source)?;
                    changes.push(crate::outcome::REVIVED.into());
                }
            }
        }
        Ok(changes)
    }

    /// 每轮推进前复查进行中的活动：身体能力或道具状态不再满足就物理性失败。
    pub(crate) fn check_ongoing_body_actions(&mut self) {
        for id in self.actor_ids() {
            let a = &self.actors[&id];
            if a.needs.incapacitated() {
                continue;
            }
            let spot = body_spot(self, a);
            let reason = a
                .needs
                .check_action(a.current.is_travel(), spot)
                .err()
                .or_else(|| {
                    let (s, action) = spot.and_then(|s| s.action.as_ref().map(|a| (s, a)))?;
                    let recipient = a
                        .current
                        .action
                        .as_ref()
                        .and_then(|b| b.draft.recipient.as_deref());
                    check_body_use(self, &id, &a.locus.locale, &s.prop, action, recipient).err()
                });
            if let Some(reason) = reason {
                self.fail_current(&id, self.minutes, reason.to_string());
            }
        }
    }
}
