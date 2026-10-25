//! 人口：身份唯一、住宅独占、从入口出现。世界只做校验与安置，不决定谁能入住，也不安排入村脚本。
use crate::error::{KernelError, Result};
use crate::{
    actor::Actor,
    path::{route, StartPoint},
    Event, World,
};

/// 一次安置请求。`entry` 为 None 时直接安置在家（场景初始化与测试）。新人加入先通过拓扑选择入口。
pub struct Admission<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub home: Option<&'a str>,
    pub entry: Option<Entry<'a>>,
}

pub struct Entry<'a> {
    pub locale: &'a str,
    pub station: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeSlot {
    pub locale: String,
    pub name: String,
    pub occupant: Option<String>,
}

impl World {
    /// 可分配住宅：地点标记 residential=true，按地点表顺序；占用按现有村民的家统计。
    pub fn homes(&self) -> Vec<HomeSlot> {
        self.topo
            .places
            .iter()
            .filter(|p| p.residential)
            .map(|p| HomeSlot {
                locale: p.locale.clone(),
                name: p.name.clone(),
                occupant: self
                    .actors
                    .values()
                    .find(|a| a.home.as_deref() == Some(p.locale.as_str()))
                    .map(|a| a.id.clone()),
            })
            .collect()
    }

    /// 干跑一次安置：把所有不通过的规则一起列出，供预览使用；不改世界。
    /// 身份、姓名、住宅、入口的规则只有这一份，`admit` 也走这里。
    pub fn check_admission(&self, a: &Admission) -> Result<(), Vec<String>> {
        let mut problems = Vec::new();
        let id = a.id.trim();
        let name = a.name.trim();
        if id.is_empty() || name.is_empty() {
            problems.push("村民编号和姓名不能为空".into());
        }
        if self.actors.contains_key(id) {
            problems.push(format!("村民编号 {id} 已存在"));
        }
        if self.actors.values().any(|a| a.name.trim() == name) {
            problems.push(format!("当前世界已有叫「{name}」的村民，请改一个入村姓名"));
        }
        if let Some(home) = a.home {
            if !self.topo.is_dwell(home) {
                problems.push(format!("住宅处所 {home} 不存在"));
            }
        }
        let locale = match &a.entry {
            None => match a.home {
                Some(home) => Some(home),
                None => {
                    problems.push("没有住宅时必须指定出生位置".into());
                    None
                }
            },
            Some(entry) => {
                self.entry_problems(entry, a.home, &mut problems);
                Some(entry.locale)
            }
        };
        if let Some(locale) = locale.filter(|l| self.topo.is_dwell(l)) {
            let station = a.entry.as_ref().and_then(|e| e.station);
            if let Err(error) = self.entry_station(locale, station) {
                problems.push(error.to_string());
            }
        }
        if problems.is_empty() {
            Ok(())
        } else {
            Err(problems)
        }
    }

    /// 从入口出现或直接安置在家。拒绝覆盖已有身份；从入口来的人必须有独占的可分配住宅和可行路线。
    pub fn admit(&mut self, a: Admission) -> Result<()> {
        self.check_admission(&a).map_err(KernelError::Admission)?;
        let id = a.id.trim();
        let name = a.name.trim();
        let home_name = a.home.map(|home| self.topo.locale_name(home));
        let (locale, entry_name) = match &a.entry {
            None => (a.home.unwrap_or_default().to_string(), None),
            Some(entry) => (
                entry.locale.to_string(),
                Some(self.topo.locale_name(entry.locale)),
            ),
        };
        let station = self.entry_station(&locale, a.entry.as_ref().and_then(|e| e.station))?;
        let mut actor = Actor::waiting(id, name, &locale, station, self.minutes);
        actor.home = a.home.map(str::to_string);
        actor.needs.switches = self.physiology;
        let log = match (&entry_name, &home_name) {
            (Some(entry_name), Some(home_name)) => {
                // 日志和记忆页会原样显示这一句：用第三人称、不写地点编号（观察里另有 home）
                actor.journal.record(
                    self.minutes,
                    format!(
                        "{name}从{entry_name}来到小镇，住在「{home_name}」。这是{name}来到小镇的第一天。"
                    ),
                );
                format!("{name} 从{entry_name}来到小镇，住在「{home_name}」")
            }
            (Some(entry_name), None) => {
                actor.journal.record(
                    self.minutes,
                    format!("{name}在「{entry_name}」出现，没有分配住宅，可以在场景里的各处活动。"),
                );
                format!("{name} 在「{entry_name}」就位")
            }
            (None, _) => format!("{name} 在 {} 就位", self.topo.locale_name(&locale)),
        };
        let info = actor.event_info();
        self.actors.insert(id.to_string(), actor);
        self.log(info, log);
        Ok(())
    }

    /// 入口存在；有住宅时住宅须可分配、未被占用、从入口可达。
    fn entry_problems(&self, entry: &Entry, home: Option<&str>, problems: &mut Vec<String>) {
        if !self.topo.is_dwell(entry.locale) {
            problems.push(format!("入口处所 {} 不存在", entry.locale));
        }
        let Some(home) = home else {
            return;
        };
        let home_name = self.topo.locale_name(home);
        if !self.topo.place_of(home).is_some_and(|p| p.residential) {
            problems.push(format!("「{home_name}」不是可分配住宅"));
            return;
        }
        if let Some(other) = self
            .actors
            .values()
            .find(|x| x.home.as_deref() == Some(home))
        {
            problems.push(format!(
                "「{home_name}」已被 {} 占用，请重新选择",
                other.name
            ));
        }
        if !self.topo.is_dwell(entry.locale) {
            return;
        }
        let start = StartPoint::Dwell {
            locale: entry.locale.into(),
        };
        if let Err(e) = route(&self.topo, &start, home, None) {
            problems.push(format!("从入口到「{home_name}」没有可行路线：{e}"));
        }
    }

    /// 指定的落脚点须属于该处所；未指定时用处所的默认落脚点。
    fn entry_station(&self, locale: &str, station: Option<&str>) -> Result<String> {
        match station {
            Some(station) => {
                ensure!(
                    self.topo.station_in(station, locale),
                    KernelError::population(format!("入口落脚点 {station} 不属于 {locale}"))
                );
                Ok(station.to_string())
            }
            None => self
                .topo
                .default_station
                .get(locale)
                .cloned()
                .ok_or_else(|| {
                    KernelError::population(format!("处所 {locale} 没有落脚点，无法安置"))
                }),
        }
    }

    /// 取走安置等操作立刻产生的事件，让 host 不用等下一次推进就能转发日志。
    pub fn take_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    /// 固定入口的显示名；地图没有配置入口时为 None。
    pub fn entry_name(&self) -> Option<String> {
        self.topo
            .entry
            .as_ref()
            .map(|e| self.topo.locale_name(&e.locale))
    }
}
