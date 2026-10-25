//! 可供性索引：从编译产物的道具表（topology.json 的 props）派生
//! 「在哪个处所能做什么」。动词封闭集合 = { 前往, 停留 } ∪ 道具动作词
//! 动词封闭集合和道具动作由当前内容数据派生。
//!
//! 效果换算（对老项目离散等级效果的读法，2026-09-01 拍板，不变）：
//! - 减「饿」的动作 → 饱腹恢复；减「困/累」的动作 → 精力恢复。
//!   恢复类 1 个等级步进 = 25 标量点，按道具时长折成每分钟速率。
//! - 加「困/累」的动作 → 劳作：按居民需求参数里的 labor_rate 匀速额外耗精力，不按道具时长折算。
//!
//! 同一处所同一动作词有多件道具时，按道具 id 排序取首个（确定性）。

use crate::props::{Action, Effect, InstantEffect, Need};
use crate::topology::{Prop, PropVerb, Topology};
use std::collections::{BTreeMap, BTreeSet};

/// 恢复类换算：老项目 1 个等级步进 = 25 标量点（0–100 刻度）。
pub const RESTORE_STEP: f64 = 25.0;

/// 一件能做的事：在某处所用某道具做某动作。
#[derive(Debug, Clone)]
pub struct Spot {
    pub prop: String,
    pub prop_name: String,
    pub verb: String,
    /// 道具标称时长（意图缺省时长取它）
    pub minutes: f64,
    /// 饱腹每分钟恢复（> 0 才有意义）
    pub fullness_rate: f64,
    /// 精力每分钟恢复（> 0 才有意义）
    pub energy_rate: f64,
    pub water_rate: f64,
    pub health_rate: f64,
    pub pause_water_decay: bool,
    /// 劳作：额外耗精力
    pub labor: bool,
    pub action: Option<Action>,
    pub pause_energy_decay: bool,
    pub pause_fullness_decay: bool,
}

impl Spot {
    /// 旧格式动词按「饿/困/累」效果折算；带 action 的按 during 效果取值。
    fn from_verb(p: &Prop, v: &PropVerb) -> Self {
        let hunger: f64 = v.effects.get("饿").copied().unwrap_or(0.0);
        let rest: f64 = v.effects.get("困").copied().unwrap_or(0.0)
            + v.effects.get("累").copied().unwrap_or(0.0);
        let minutes = v.duration_minutes.unwrap_or(30.0).max(1.0);
        let restore = |level: f64| {
            if level < 0.0 {
                level.abs() * RESTORE_STEP / minutes
            } else {
                0.0
            }
        };
        let mut spot = Spot {
            action: v.action.clone(),
            water_rate: 0.0,
            health_rate: 0.0,
            pause_water_decay: false,
            pause_energy_decay: rest < 0.0,
            pause_fullness_decay: false,
            prop: p.id.clone(),
            prop_name: p.name.clone(),
            verb: v.verb.clone(),
            minutes,
            fullness_rate: restore(hunger),
            energy_rate: restore(rest),
            labor: hunger > 0.0 || rest > 0.0,
        };
        if let Some(action) = &v.action {
            spot.fullness_rate = 0.0;
            spot.energy_rate = 0.0;
            spot.labor = false;
            spot.pause_energy_decay = false;
            for effect in &action.during {
                spot.apply_effect(effect);
            }
        }
        spot
    }

    fn apply_effect(&mut self, effect: &Effect) {
        match effect {
            Effect::RestoreNeed {
                need,
                per_minute,
                pause_decay,
            } => {
                let (rate, pause) = match need {
                    Need::Energy => (&mut self.energy_rate, Some(&mut self.pause_energy_decay)),
                    Need::Fullness => (
                        &mut self.fullness_rate,
                        Some(&mut self.pause_fullness_decay),
                    ),
                    Need::Water => (&mut self.water_rate, Some(&mut self.pause_water_decay)),
                    Need::Health => (&mut self.health_rate, None),
                };
                *rate = *per_minute;
                if let Some(pause) = pause {
                    *pause = *pause_decay;
                }
            }
            Effect::Labor => self.labor = true,
        }
    }

    /// 餐饮动作：过程中或完成时恢复饱腹。招待用餐只接受这类动作。
    pub fn restores_fullness(&self) -> bool {
        self.fullness_rate > 0.0
            || self.action.as_ref().is_some_and(|a| {
                a.on_complete.iter().any(|e| {
                    matches!(
                        e,
                        InstantEffect::Restore {
                            need: Need::Fullness,
                            ..
                        }
                    )
                })
            })
    }
}

#[derive(Debug, Default)]
pub struct Affordances {
    by_prop: BTreeMap<(String, String), Spot>,
    /// (处所, 动作词) → 道具
    spots: BTreeMap<(String, String), Spot>,
    /// 处所 → 能做的事（按道具 id 顺序，首次出现的动作词）
    by_locale: BTreeMap<String, Vec<Spot>>,
    /// 全部道具动作词（封闭集合的数据部分）
    pub verbs: BTreeSet<String>,
    /// 道具表改动发生在活动结算中途、回执还要读旧定义：先标记，活动完成后再重建。
    dirty: bool,
}

impl Affordances {
    pub fn build(topo: &Topology) -> Self {
        let mut aff = Affordances::default();
        let mut props: Vec<_> = topo.props().iter().filter(|p| !p.withdrawn).collect();
        props.sort_by(|a, b| a.id.cmp(&b.id));
        for p in props {
            for v in &p.verbs {
                let spot = Spot::from_verb(p, v);
                aff.by_prop
                    .insert((p.id.clone(), v.verb.clone()), spot.clone());
                aff.verbs.insert(v.verb.clone());
                let key = (p.locale.clone(), v.verb.clone());
                if !aff.spots.contains_key(&key) {
                    aff.by_locale
                        .entry(p.locale.clone())
                        .or_default()
                        .push(spot.clone());
                    aff.spots.insert(key, spot);
                }
            }
        }
        aff
    }

    /// 道具表改动后立刻重建索引。
    pub(crate) fn rebuild(&mut self, topo: &Topology) {
        *self = Self::build(topo);
    }

    pub(crate) fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub(crate) fn rebuild_if_dirty(&mut self, topo: &Topology) {
        if self.dirty {
            self.rebuild(topo);
        }
    }

    pub fn for_prop(&self, prop: &str, verb: &str) -> Option<&Spot> {
        self.by_prop.get(&(prop.into(), verb.into()))
    }

    pub fn spot(&self, locale: &str, verb: &str) -> Option<&Spot> {
        self.spots.get(&(locale.to_string(), verb.to_string()))
    }

    /// 指定道具时按道具查，否则按处所查。
    pub fn lookup(&self, prop: Option<&str>, locale: &str, verb: &str) -> Option<&Spot> {
        match prop {
            Some(id) => self.for_prop(id, verb),
            None => self.spot(locale, verb),
        }
    }

    /// 动作词对应的道具动作定义（旧格式动词没有）。
    pub fn action(&self, prop: Option<&str>, locale: &str, verb: &str) -> Option<&Action> {
        self.lookup(prop, locale, verb)?.action.as_ref()
    }

    pub fn has(&self, locale: &str, verb: &str) -> bool {
        self.spot(locale, verb).is_some()
    }

    /// 某处所能做的事（空切片 = 什么都没有，只能停留）
    pub fn options(&self, locale: &str) -> &[Spot] {
        self.by_locale
            .get(locale)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    pub fn is_verb(&self, verb: &str) -> bool {
        self.verbs.contains(verb)
    }
}
