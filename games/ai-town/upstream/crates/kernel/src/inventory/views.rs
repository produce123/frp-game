//! 背包与容器的只读投影。
use super::*;
use crate::World;
use protocol::{InventorySlot, InventoryView, StoredItem};

impl Inventory {
    pub(crate) fn location_name(
        &self,
        topo: &Topology,
        actors: &Actors,
        id: &str,
    ) -> Option<String> {
        match self.locations.get(id)? {
            Location::Carried { actor } => actors.get(actor).map(|a| a.name.clone()),
            Location::Stored { container } => topo.prop(container).map(|p| p.name.clone()),
            Location::Ground { locale, .. } => Some(topo.locale_name(locale)),
        }
    }
    /// 放下的物品画在既有的静止锚点上；不改写历史路线。
    pub(crate) fn position(&self, topo: &Topology, id: &str) -> Option<[f64; 3]> {
        let Location::Ground { locale, station } = self.locations.get(id)? else {
            return None;
        };
        topo.point(
            locale,
            &protocol::At::Station {
                station: station.clone(),
            },
        )
    }
}

impl World {
    /// 一个人的背包：同样的物品按叠放上限分格。
    pub fn inventory_view(&self, actor: &str) -> InventoryView {
        let mut groups: BTreeMap<String, Vec<&Prop>> = BTreeMap::new();
        for p in self
            .topo
            .props()
            .iter()
            .filter(|p| !p.withdrawn && self.inventory.carried_by(&p.id, actor))
        {
            groups
                .entry(Inventory::stack_key(&self.props, p))
                .or_default()
                .push(p);
        }
        let mut slots = Vec::new();
        for items in groups.values() {
            for stack in items.chunks(Inventory::stack_limit(items[0])) {
                let p = stack[0];
                slots.push(InventorySlot {
                    actions: p
                        .verbs
                        .iter()
                        .filter_map(|v| v.action.as_ref())
                        .map(|a| crate::props::action_description_for(a, self.physiology()))
                        .collect(),
                    definition: p.definition.clone(),
                    items: stack.iter().map(|p| p.id.clone()).collect(),
                    name: p.name.clone(),
                    quantity: stack.len(),
                    readable: p.readable.as_ref().map(crate::content::Text::metadata),
                });
            }
        }
        InventoryView {
            capacity: CAPACITY,
            used: slots.len(),
            slots,
        }
    }

    /// 本人看得到的容器里存着的物品；够不着或进不了别人家时为空。
    pub fn container_items(&self, actor: &str, container: &str) -> Vec<StoredItem> {
        let w = self;
        let Some(p) = w.topo.prop(container).filter(|p| p.storage_slots > 0) else {
            return vec![];
        };
        let Some(a) = w.actors.get(actor) else {
            return vec![];
        };
        if !w.inventory.at_hand(&w.props, &a.id, p, &a.locus.locale)
            || check_property_access(&w.topo, a, &p.locale).is_err()
        {
            return vec![];
        }
        w.topo
            .props()
            .iter()
            .filter(|p| {
                !p.withdrawn
                    && matches!(
                        w.inventory.location(&p.id),
                        Some(Location::Stored { container: c }) if c == container
                    )
            })
            .map(|p| StoredItem {
                definition: p.definition.clone(),
                id: p.id.clone(),
                name: p.name.clone(),
            })
            .collect()
    }
}
