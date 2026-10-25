use super::WeatherState;
use crate::{
    affordance::Spot,
    error::{KernelError, Result},
    intent::Intent,
    props::{Effect, InstantEffect, Need},
    World,
};
use protocol::{Exposure, InteractionKind, WeatherContext, WeatherKind, WeatherPolicy};

fn essential(spot: Option<&Spot>) -> bool {
    let Some(s) = spot else {
        return false;
    };
    if let Some(action) = &s.action {
        action.on_complete.iter().any(|e| match e {
            InstantEffect::Restore {need, amount} => *amount > 0. && matches!(need, Need::Fullness | Need::Water | Need::Health),
            InstantEffect::CureCondition {..} | InstantEffect::Revive {..} => true,
            InstantEffect::ApplyCondition {..} => false,
        }) || action.during.iter().any(|e| matches!(e, Effect::RestoreNeed {need: Need::Fullness | Need::Water | Need::Health, per_minute, ..} if *per_minute > 0.))
    } else {
        s.fullness_rate > 0. || s.water_rate > 0. || s.health_rate > 0.
    }
}
impl WeatherState {
    /// 当前天气下能不能在这种位置久留：只有雷暴时的露天受限；`exempt` 是移动、进屋、
    /// 吃喝救助这类必要操作，雷暴也不拦。
    pub fn policy(&self, exposure: Exposure, exempt: bool) -> WeatherPolicy {
        let kind = self.view.kind;
        let blocked = kind == WeatherKind::Thunderstorm && exposure == Exposure::Outdoor && !exempt;
        let reason = match exposure {
            Exposure::Offstage => "当前不在世界中",
            Exposure::Unknown => "当前位置的室内外信息未确定",
            Exposure::Indoor => "当前在室内，天气不限制活动",
            Exposure::Outdoor if blocked => "雷暴期间不能露天久留；仍可移动、进屋、吃喝或救助",
            Exposure::Outdoor if exempt => "可移动、进屋或进行必要操作；露天久留另按当前天气检查",
            Exposure::Outdoor => match kind {
                WeatherKind::Clear => "天气适合户外活动",
                WeatherKind::Overcast => "阴天不限制活动",
                _ => "雨雪影响户外舒适性，可以继续，也可选择可达的室内地点",
            },
        };
        WeatherPolicy {
            allowed: !blocked,
            code: blocked.then_some(protocol::WeatherCode::WeatherUnsafe),
            reason: reason.into(),
        }
    }
}

impl World {
    /// 没有启用天气的地图不限制活动。
    fn weather_policy(&self, exposure: Exposure, exempt: bool) -> WeatherPolicy {
        match &self.weather {
            Some(w) => w.policy(exposure, exempt),
            None => WeatherPolicy {
                allowed: true,
                code: None,
                reason: String::new(),
            },
        }
    }
    pub(crate) fn check_weather_action(
        &self,
        actor: &str,
        intent: &Intent,
        locale: &str,
        spot: Option<&Spot>,
    ) -> Result<()> {
        let exposure = if self.actor(actor).is_some_and(|a| a.locus.locale == locale) {
            self.exposure_at(actor)
        } else {
            self.locale_exposure(locale)
        };
        let policy = self.weather_policy(exposure, intent.is_goto() || essential(spot));
        ensure!(
            policy.allowed,
            KernelError::weather(protocol::WeatherCode::WeatherUnsafe, policy.reason)
        );
        Ok(())
    }
    pub(crate) fn check_weather_chat(&self, actor: &str) -> Result<()> {
        let policy = self.weather_policy(self.exposure_at(actor), false);
        ensure!(
            policy.allowed,
            KernelError::weather(protocol::WeatherCode::WeatherUnsafe, policy.reason)
        );
        Ok(())
    }
    fn current_weather_exempt(&self, actor: &str) -> bool {
        let a = &self.actors[actor];
        if a.current.is_travel()
            || a.free_walk.is_some()
            || a.current.is_idle()
            || a.current.is_instant()
        {
            return true;
        }
        if let Some(id) = &a.current.interaction {
            // 招待吃饭与转交物品保留，不能因为雷暴阻断补给。
            return self
                .interactions
                .get(id)
                .is_some_and(|i| i.kind != InteractionKind::Talk);
        }
        if a.current
            .action
            .as_ref()
            .is_some_and(|b| b.draft.inventory.is_some())
        {
            return true;
        }
        let spot = a
            .current
            .action
            .as_ref()
            .and_then(|b| b.draft.prop_id.as_deref())
            .and_then(|p| self.affordances.for_prop(p, &a.current.verb))
            .or_else(|| self.affordances.spot(&a.locus.locale, &a.current.verb));
        essential(spot)
    }
    pub fn weather_context(&self, actor: &str) -> Option<WeatherContext> {
        let weather = self.weather.as_ref()?.view.clone();
        self.actor(actor)?;
        let exposure = self.exposure_at(actor);
        Some(WeatherContext {
            weather,
            exposure,
            activity: self.weather_policy(exposure, self.current_weather_exempt(actor)),
            indoor_alternatives: self.indoor_alternatives(actor),
        })
    }
    pub(crate) fn check_weather_activities(&mut self) {
        if !self
            .weather
            .as_ref()
            .is_some_and(|w| w.view.kind == WeatherKind::Thunderstorm)
        {
            return;
        }
        let ids: Vec<_> = self
            .actor_ids()
            .into_iter()
            .filter(|id| {
                !self.actors[id].needs.body.dead
                    && !self
                        .weather_policy(self.exposure_at(id), self.current_weather_exempt(id))
                        .allowed
            })
            .collect();
        for id in ids {
            // 同一聊天可能已因前一名成员离开而结束，必须重看当前活动。
            if self.current_weather_exempt(&id) {
                continue;
            }
            let reason = format!(
                "weather_unsafe：雷暴中断露天「{}」，可继续移动或自救",
                self.actors[&id].current.verb
            );
            if self.actors[&id].current.interaction.is_some() {
                self.interrupt_interaction(&id, &reason);
            } else {
                let now = self.minutes;
                let a = self.actor_mut(&id);
                a.interrupt_actions(now, &reason);
                a.reset_idle(now, false);
            }
            self.notify(&id, reason);
        }
    }
}
