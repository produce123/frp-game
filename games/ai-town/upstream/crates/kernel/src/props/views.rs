//! 道具的只读投影（设定中心道具页）。
use super::action_description;
use crate::{topology::Prop, World};
use protocol::{LegacyVerbView, PropActionEntry, PropView, SpatialOverridesView};

fn prop_view(w: &World, p: &Prop) -> PropView {
    let actions = p
        .verbs
        .iter()
        .map(|v| match &v.action {
            Some(a) => PropActionEntry::Defined(protocol::PropActionView {
                remaining: Some(w.props.supply_remaining(&p.id, a)),
                ..action_description(a)
            }),
            None => PropActionEntry::Legacy(LegacyVerbView {
                conditions: vec!["到达道具所属地点".into()],
                effects: vec![],
                id: v.verb.clone(),
                label: v.verb.clone(),
                minutes: v.duration_minutes,
                result: "旧格式活动".into(),
            }),
        })
        .collect();
    let walk_position = if w.topo.navigation.is_none() {
        w.avatar_prop_spot(&p.id).map(|p| p.locus())
    } else {
        None
    };
    PropView {
        actions,
        board: p.board.clone(),
        bulletin_board: p.bulletin_board,
        custom: w.props.is_placed(&p.id),
        definition: p.definition.clone(),
        id: p.id.clone(),
        locale: p.locale.clone(),
        location: w.inventory.location(&p.id).cloned(),
        location_name: w.inventory.location_name(&w.topo, &w.actors, &p.id),
        name: p.name.clone(),
        occupants: w.prop_occupants(&p.id),
        on_map: w.inventory.on_map(&w.props, &p.id),
        portable: p.portable,
        position: w.inventory.position(&w.topo, &p.id),
        readable: p.readable.as_ref().map(crate::content::Text::metadata),
        stack_limit: p.stack_limit,
        storage_slots: p.storage_slots,
        walk_position,
        withdrawn: p.withdrawn,
    }
}

impl World {
    /// 未移除的全部道具。
    pub fn prop_views(&self) -> Vec<PropView> {
        self.topo
            .props()
            .iter()
            .filter(|p| !self.props.is_removed(&p.id))
            .map(|p| prop_view(self, p))
            .collect()
    }

    /// 运行期空间覆盖与墓碑，随修订号一起给客户端；没有空间地图时为 None。
    pub fn spatial_overrides(&self) -> Option<SpatialOverridesView> {
        self.topo.navigation.as_ref().map(|s| SpatialOverridesView {
            overrides: s.overrides.values().cloned().collect(),
            removed: self.props.removed.clone(),
            revision: s.navigation_revision,
        })
    }
}
