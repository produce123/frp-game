//! 道具实例的运行期状态：运行时放置、墓碑、出厂位置与有限补给余量。
use super::{Action, Placement};
use crate::error::{KernelError, Result};
use crate::{
    inventory::Inventory,
    topology::{Prop, Topology},
};
use std::collections::{BTreeMap, BTreeSet};

/// 补给余量表的键：`{道具}/{动作}`。
pub(crate) fn supply_key(prop: &str, action: &str) -> String {
    format!("{prop}/{action}")
}

/// 反解补给键为（道具，动作）。
pub(crate) fn split_supply_key(key: &str) -> Option<(&str, &str)> {
    key.rsplit_once('/')
}

#[derive(Debug, Clone, Default)]
pub struct Props {
    pub(crate) walk_positions: BTreeMap<String, crate::avatar::Spot>,
    /// 运行时放置的实例及其精确定义版本。
    pub(crate) placed: BTreeMap<String, Placement>,
    /// 已移除或已消耗的道具只留墓碑：可供性消失，历史位置对被中断的人仍然有效。
    pub(crate) removed: BTreeSet<String>,
    /// 地图自带道具的出厂地点；可携带道具被移动后由此恢复基础拓扑。
    pub(crate) base_locales: BTreeMap<String, String>,
    /// 有限补给余量；没有记录就是定义里的初始量。
    pub(crate) supplies: BTreeMap<String, u32>,
}

impl Props {
    pub(crate) fn from_topology(topo: &Topology) -> Self {
        Props {
            base_locales: topo
                .props()
                .iter()
                .map(|p| (p.id.clone(), p.locale.clone()))
                .collect(),
            ..Default::default()
        }
    }

    pub(crate) fn is_removed(&self, id: &str) -> bool {
        self.removed.contains(id)
    }

    pub(crate) fn is_placed(&self, id: &str) -> bool {
        self.placed.contains_key(id)
    }

    pub fn supply_remaining(&self, prop: &str, action: &Action) -> Option<u32> {
        action.supply.as_ref().map(|s| {
            self.supplies
                .get(&supply_key(prop, &action.id))
                .copied()
                .unwrap_or(s.initial)
        })
    }

    /// 从有限补给里扣掉 portions 份，返回剩余份数。调用方已检查过余量足够。
    pub(crate) fn consume_supply(&mut self, prop: &str, action: &Action, portions: u32) -> u32 {
        let cost = action.supply.as_ref().map_or(0, |s| s.cost) * portions;
        let remaining = self.supply_remaining(prop, action).unwrap_or(0) - cost;
        self.supplies
            .insert(supply_key(prop, &action.id), remaining);
        remaining
    }

    /// 仍存在、未撤下的道具。
    pub(crate) fn item<'a>(&self, topo: &'a Topology, id: &str) -> Result<&'a Prop> {
        topo.prop(id)
            .filter(|p| !p.withdrawn && !self.removed.contains(id))
            .ok_or_else(|| KernelError::props("物品不存在或已被消耗"))
    }

    pub(crate) fn validate_placement(
        &self,
        topo: &Topology,
        placement: &Placement,
    ) -> Result<Prop> {
        let taken = topo
            .props()
            .iter()
            .any(|p| p.id == placement.instance.id && !self.placed.contains_key(&p.id));
        ensure!(
            topo.is_dwell(&placement.instance.locale) && !taken,
            KernelError::props("道具地点无效，或实例编号已存在")
        );
        super::catalog::resolve(&placement.instance, &placement.definition)
    }

    /// 移除前的静态条件：道具存在、公告栏上没有作品、容器里没有物品。
    pub(crate) fn check_removal(
        &self,
        topo: &Topology,
        inventory: &Inventory,
        id: &str,
    ) -> Result<()> {
        ensure!(topo.prop(id).is_some(), KernelError::props("道具不存在"));
        ensure!(
            !topo
                .props()
                .iter()
                .any(|p| p.board.as_deref() == Some(id) && !self.removed.contains(&p.id)),
            KernelError::props("请先移除公告栏上的作品")
        );
        ensure!(
            !inventory.stores_anything(id),
            KernelError::props("请先取出容器中的物品")
        );
        Ok(())
    }

    /// 放进道具表并记下放置版本。
    pub(crate) fn insert(&mut self, topo: &mut Topology, placement: Placement, prop: Prop) {
        self.placed.insert(prop.id.clone(), placement);
        topo.push_prop(prop);
    }

    /// 只留墓碑：撤下、不再出现在可供性里。
    pub(crate) fn withdraw(&mut self, topo: &mut Topology, id: &str) {
        self.removed.insert(id.into());
        if let Some(p) = topo.prop_mut(id) {
            p.withdrawn = true;
        }
    }

    /// 改写道具所在地点；第一次移动时记下出厂地点。
    pub(crate) fn set_locale(&mut self, topo: &mut Topology, id: &str, locale: String) {
        let p = topo.prop_mut(id).expect("转移的物品在道具表中");
        self.base_locales
            .entry(id.into())
            .or_insert_with(|| p.locale.clone());
        p.locale = locale;
    }

    /// 地图自带的拓扑：道具位置回到出厂值，运行时放置的道具由存档重新给出。
    pub(crate) fn base_topology(&self, topo: &Topology) -> Topology {
        let mut base = topo.clone();
        for p in base.props_mut() {
            if let Some(locale) = self.base_locales.get(&p.id) {
                p.locale = locale.clone();
            }
        }
        base
    }
}
