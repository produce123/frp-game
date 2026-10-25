//! 可携带道具保留身份；这张位置表是它们运行期位置的唯一来源。
//! 规则在这里和 transfer.rs（都是 `impl Inventory`），世界入口在 commands.rs。
mod commands;
mod transfer;
pub(crate) mod views;
use crate::error::{KernelError, Result};
use crate::{
    actor::{Actor, Actors},
    interactions::Interactions,
    props::Props,
    topology::{Prop, Topology},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
pub(crate) use transfer::Surroundings;

/// 背包格数。
pub const CAPACITY: usize = 8;
/// 一次转移或赠予最多几件。
pub const MAX_TRANSFER: usize = CAPACITY * 5;

/// 可携带道具的位置；线上与存档共用 protocol 的定义。
pub use protocol::ItemLocation as Location;

/// 存档只存位置表；修订号是运行期状态，每次转移加一，host 据此决定是否重发道具列表。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inventory {
    pub locations: BTreeMap<String, Location>,
    #[serde(skip)]
    pub(crate) revision: u64,
}

impl Inventory {
    /// 每次转移加一；host 据此决定是否重发道具列表。
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn location(&self, id: &str) -> Option<&Location> {
        self.locations.get(id)
    }
    pub fn carried_by(&self, prop: &str, actor: &str) -> bool {
        matches!(self.locations.get(prop), Some(Location::Carried {actor: owner}) if owner == actor)
    }
    /// 没有被移除、也没有被拿走或存起来：还在地图上。
    pub fn on_map(&self, props: &Props, id: &str) -> bool {
        !props.is_removed(id)
            && !matches!(
                self.locations.get(id),
                Some(Location::Carried { .. } | Location::Stored { .. })
            )
    }
    pub(crate) fn stores_anything(&self, container: &str) -> bool {
        self.locations
            .values()
            .any(|l| matches!(l, Location::Stored { container: c } if c == container))
    }
    pub(crate) fn forget(&mut self, id: &str) {
        self.locations.remove(id);
    }
    pub(crate) fn bump(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }
    /// 在地图上、就在这个处所：没被拿走、存起或移除。拾取与存取的来源只算这一种，
    /// 随身的东西不能再拾取。
    pub fn on_map_at(&self, props: &Props, prop: &Prop, locale: &str) -> bool {
        self.on_map(props, &prop.id) && prop.locale == locale
    }
    /// 眼前或随身：未撤下，要么本人持有，要么在地图上的这个处所。
    /// 使用道具、施用效果、看容器和化身视图里的道具都按这一种。
    pub fn at_hand(&self, props: &Props, actor: &str, prop: &Prop, locale: &str) -> bool {
        !prop.withdrawn && (self.carried_by(&prop.id, actor) || self.on_map_at(props, prop, locale))
    }
    /// 叠放键：身份和状态完全相同才叠在一起，正文、效果或剩余补给不同的绝不合并。
    pub(crate) fn stack_key(props: &Props, p: &Prop) -> String {
        let supplies: Vec<_> = p
            .verbs
            .iter()
            .map(|v| {
                v.action
                    .as_ref()
                    .and_then(|a| props.supply_remaining(&p.id, a))
            })
            .collect();
        serde_json::json!([
            p.definition,
            p.name,
            p.readable,
            p.verbs,
            supplies,
            p.verbs
                .iter()
                .any(|v| v.action.as_ref().is_some_and(|a| a.supply.is_some()))
                .then_some(&p.id)
        ])
        .to_string()
    }
    pub(crate) fn stack_limit(p: &Prop) -> usize {
        p.stack_limit.clamp(1, crate::props::MAX_STACK) as usize
    }
    pub(crate) fn slots_used<'a>(props: &Props, items: impl Iterator<Item = &'a Prop>) -> usize {
        let mut groups: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        for p in items {
            let e = groups
                .entry(Self::stack_key(props, p))
                .or_insert((0, Self::stack_limit(p)));
            e.0 += 1;
        }
        groups.values().map(|(n, limit)| n.div_ceil(*limit)).sum()
    }
    pub(crate) fn check_capacity(
        &self,
        topo: &Topology,
        props: &Props,
        dest: &Location,
        incoming: &[String],
    ) -> Result<()> {
        let capacity = match dest {
            Location::Carried { .. } => CAPACITY,
            Location::Stored { container } => props.item(topo, container)?.storage_slots as usize,
            Location::Ground { .. } => return Ok(()),
        };
        let items = topo.props().iter().filter(|p| {
            !p.withdrawn && (self.locations.get(&p.id) == Some(dest) || incoming.contains(&p.id))
        });
        ensure!(
            Self::slots_used(props, items) <= capacity,
            KernelError::inventory("目标容量不足，未转移任何物品")
        );
        Ok(())
    }
    pub(crate) fn set_location(
        &mut self,
        topo: &mut Topology,
        props: &mut Props,
        id: &str,
        dest: Location,
    ) {
        let locale = match &dest {
            Location::Ground { locale, .. } => locale.clone(),
            _ => String::new(),
        };
        props.set_locale(topo, id, locale);
        self.locations.insert(id.into(), dest);
    }
    /// 存档恢复：位置表整体换上，道具地点跟着对齐。
    pub(crate) fn apply(&mut self, topo: &mut Topology, inventory: Inventory) {
        for (id, loc) in &inventory.locations {
            if let Some(p) = topo.prop_mut(id) {
                p.locale = match loc {
                    Location::Ground { locale, .. } => locale.clone(),
                    _ => String::new(),
                };
            }
        }
        self.locations = inventory.locations;
    }
    pub(crate) fn validate(
        &self,
        topo: &Topology,
        props: &Props,
        actors: &Actors,
        removed: &BTreeSet<String>,
    ) -> Result<()> {
        // 键 → (容量, 物品)
        let mut groups: BTreeMap<String, (usize, Vec<&Prop>)> = BTreeMap::new();
        for (id, loc) in &self.locations {
            let p = topo
                .prop(id)
                .ok_or_else(|| KernelError::snapshot("背包引用了不存在的道具"))?;
            ensure!(
                p.portable
                    && p.board.is_none()
                    && !p.bulletin_board
                    && !removed.contains(id)
                    && !p.withdrawn,
                KernelError::snapshot("背包包含不可携带或已删除的道具")
            );
            match loc {
                Location::Carried { actor } => {
                    ensure!(
                        actors.contains_key(actor),
                        KernelError::snapshot("物品持有者不存在")
                    );
                    groups
                        .entry(format!("actor:{actor}"))
                        .or_insert((CAPACITY, vec![]))
                        .1
                        .push(p);
                }
                Location::Stored { container } => {
                    let c = topo
                        .prop(container)
                        .ok_or_else(|| KernelError::snapshot("存放容器不存在"))?;
                    ensure!(
                        c.storage_slots > 0
                            && !c.portable
                            && !removed.contains(container)
                            && !self.locations.contains_key(container),
                        KernelError::snapshot("存放容器无效")
                    );
                    groups
                        .entry(format!("container:{container}"))
                        .or_insert((c.storage_slots as usize, vec![]))
                        .1
                        .push(p);
                }
                Location::Ground { locale, station } => ensure!(
                    topo.is_dwell(locale) && topo.station_in(station, locale),
                    KernelError::snapshot("物品落地点无效")
                ),
            }
        }
        for (cap, items) in groups.into_values() {
            ensure!(
                Self::slots_used(props, items.into_iter()) <= cap,
                KernelError::snapshot("存档背包或容器超出容量")
            );
        }
        Ok(())
    }
}

/// 住宅里的物品只有住户能拿取和存取。
pub(crate) fn check_property_access(topo: &Topology, actor: &Actor, locale: &str) -> Result<()> {
    let residential = topo
        .places
        .iter()
        .any(|p| p.locale == locale && p.residential);
    ensure!(
        !residential || actor.home.as_deref() == Some(locale),
        KernelError::inventory("只能拿取或存取自己住宅内的物品")
    );
    Ok(())
}

/// 物品没有被别人的当前动作或进行中的赠予引用。和道具占用不同，这里连走向操作点的路上、
/// 背包操作里点名的物品都算，防止同一件东西被两个人同时转移。
pub(crate) fn item_idle(
    actors: &Actors,
    interactions: &Interactions,
    actor: &str,
    id: &str,
) -> Result<()> {
    let busy = actors.iter().any(|(other, a)| {
        other != actor && {
            let in_action = a.current.action.as_ref().is_some_and(|b| {
                b.uses_prop(id)
                    || b.draft
                        .inventory
                        .as_ref()
                        .is_some_and(|i| i.items().iter().any(|p| p == id))
            });
            let in_gift = a
                .current
                .interaction
                .as_ref()
                .and_then(|key| interactions.get(key))
                .is_some_and(|i| {
                    matches!(&i.kind, protocol::InteractionKind::Give { items } if items.iter().any(|p| p == id))
                });
            in_action || in_gift
        }
    });
    ensure!(
        !busy,
        KernelError::inventory("物品正在被其他村民使用或转移")
    );
    Ok(())
}

pub(crate) fn check_items(topo: &Topology, props: &Props, items: &[String]) -> Result<()> {
    ensure!(
        !items.is_empty()
            && items.len() <= MAX_TRANSFER
            && items.iter().collect::<BTreeSet<_>>().len() == items.len(),
        KernelError::inventory(format!("一次须选择 1–{MAX_TRANSFER} 件不同物品"))
    );
    for id in items {
        ensure!(
            props.item(topo, id)?.portable,
            KernelError::inventory("该道具不可放入背包")
        );
    }
    Ok(())
}
