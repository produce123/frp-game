//! 入口和住宅属于拓扑；这里筛选有效位置，随机抽取由 host 在加入事务中执行。
use super::{LocaleKind, Topology};
use crate::error::{KernelError, Result};
use crate::path::{route, StartPoint};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EntryPoint {
    pub locale: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub station: Option<String>,
}

impl Topology {
    /// 无住宅的人物在固定入口或有效公共地点出现；位置与住宅分开选择。
    pub fn spawn_candidates(&self, home: Option<&str>) -> Result<Vec<EntryPoint>> {
        if let Some(home) = home {
            return self.entry_candidates(home);
        }
        if let Some(entry) = &self.entry {
            return Ok(vec![self.resolve_entry(entry)?]);
        }
        let candidates: Vec<_> = self
            .places
            .iter()
            .filter(|p| !p.residential)
            .filter_map(|p| {
                self.resolve_entry(&EntryPoint {
                    locale: p.locale.clone(),
                    station: Some(p.arrival_station.clone()),
                })
                .ok()
            })
            .collect();
        if candidates.is_empty() {
            return Err(KernelError::topology("没有有效出生位置"));
        }
        Ok(candidates)
    }

    /// 解析到具体落脚点；显式配置错误不会退回随机选择。
    fn resolve_entry(&self, entry: &EntryPoint) -> Result<EntryPoint> {
        if !self.is_dwell(&entry.locale) {
            return Err(KernelError::topology(format!(
                "入口处所 {} 不存在或不可停留",
                entry.locale
            )));
        }
        let station = entry
            .station
            .as_ref()
            .or_else(|| self.default_station.get(&entry.locale))
            .ok_or_else(|| {
                KernelError::topology(format!("处所 {} 没有落脚点，无法安置", entry.locale))
            })?;
        if !self.station_in(station, &entry.locale) {
            return Err(KernelError::topology(format!(
                "入口落脚点 {station} 不存在或不属于 {}",
                entry.locale
            )));
        }
        Ok(EntryPoint {
            locale: entry.locale.clone(),
            station: Some(station.clone()),
        })
    }

    pub(super) fn validate_entry_sites(&self) -> Result<()> {
        if let Some(entry) = &self.entry {
            self.resolve_entry(entry)?;
        }
        for home in self.places.iter().filter(|p| p.residential) {
            self.resolve_entry(&EntryPoint {
                locale: home.locale.clone(),
                station: Some(home.arrival_station.clone()),
            })
            .map_err(|e| KernelError::context(format!("住宅「{}」配置无效：", home.name), e))?;
        }
        Ok(())
    }

    /// 固定入口返回一个位置；未配置则返回能到家的公共地点，各地点使用默认落脚点。
    /// 不把任何其他住宅作为随机候选；没有合适公共地点时落在自己的住宅。
    /// 此方法不抽签、不改世界，预览和提交共用同一套检查。
    pub fn entry_candidates(&self, home: &str) -> Result<Vec<EntryPoint>> {
        if !self.place_of(home).is_some_and(|p| p.residential) {
            return Err(KernelError::topology(format!(
                "「{}」不是可分配住宅",
                self.locale_name(home)
            )));
        }
        let own_home = self.resolve_entry(&EntryPoint {
            locale: home.into(),
            station: None,
        })?;
        let reaches_home = |entry: &EntryPoint| {
            route(
                self,
                &StartPoint::Dwell {
                    locale: entry.locale.clone(),
                },
                home,
                own_home.station.as_deref(),
            )
        };
        if let Some(entry) = &self.entry {
            let entry = self.resolve_entry(entry)?;
            reaches_home(&entry).map_err(|e| {
                KernelError::context(
                    format!("从入口到「{}」没有可行路线：", self.locale_name(home)),
                    e,
                )
            })?;
            return Ok(vec![entry]);
        }
        let mut candidates = Vec::new();
        for locale in self
            .locales
            .values()
            .filter(|l| l.kind == LocaleKind::Dwell)
        {
            if locale.id == home || self.place_of(&locale.id).is_some_and(|p| p.residential) {
                continue;
            }
            if let Ok(entry) = self.resolve_entry(&EntryPoint {
                locale: locale.id.clone(),
                station: None,
            }) {
                if reaches_home(&entry).is_ok() {
                    candidates.push(entry);
                }
            }
        }
        if candidates.is_empty() {
            candidates.push(own_home);
        }
        Ok(candidates)
    }
}
