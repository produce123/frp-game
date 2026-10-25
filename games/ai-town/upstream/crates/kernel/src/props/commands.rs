//! 道具放置与移除的入口：校验交给 `Props`，这里串起拓扑、空间覆盖、作品与可供性。
use super::Placement;
use crate::error::{KernelError, Result};
use crate::{navigation, World};

impl World {
    pub fn place_prop(&mut self, placement: Placement) -> Result<()> {
        if let Some(old) = self.props.placed.get(&placement.instance.id) {
            ensure!(
                old == &placement,
                KernelError::props("实例编号已存在，不能覆盖")
            );
            return Ok(());
        }
        crate::props::check_room(self.topo.props().len(), 1)?;
        let prop = self.props.validate_placement(&self.topo, &placement)?;
        self.topo
            .check_board(prop.board.as_deref(), &prop.locale, prop.readable.as_ref())?;
        if let Some(v) = navigation::plan_override(self, &prop)? {
            self.topo
                .install_override(v, navigation::walk_speed(self.walk_map.as_deref())?)?;
        }
        let walk_position = if self.topo.navigation.is_none() && self.walk_map.is_some() {
            Some(
                self.plan_walk_prop(&prop.locale, &self.props.walk_positions)
                    .ok_or_else(|| KernelError::navigation("没有可用的二维道具位置"))?,
            )
        } else {
            None
        };
        if let Some(spot) = walk_position {
            self.props.walk_positions.insert(prop.id.clone(), spot);
        }
        self.contents.capture(&prop);
        self.props.insert(&mut self.topo, placement, prop);
        self.affordances.rebuild(&self.topo);
        Ok(())
    }

    /// 移除道具只留下墓碑：正在用它的人被中断，历史位置和路线仍然有效。
    /// 要中断的人比道具占用更广：当前在用（含招待用餐）、当前动作或队列里的动作点名了它。
    pub fn remove_prop(&mut self, id: &str) -> Result<()> {
        if self.props.is_removed(id) {
            return Ok(());
        }
        self.props.check_removal(&self.topo, &self.inventory, id)?;
        let affected: Vec<_> = self
            .actors
            .values()
            .filter(|a| {
                crate::physiology::body_spot(self, a).is_some_and(|s| s.prop == id)
                    || a.current.action.as_ref().is_some_and(|b| b.uses_prop(id))
                    || a.plan
                        .iter()
                        .any(|q| q.binding().is_some_and(|b| b.uses_prop(id)))
            })
            .map(|a| a.id.clone())
            .collect();
        for actor in affected {
            self.interrupt_actions(&actor, "目标道具已移除");
        }
        self.inventory.forget(id);
        self.props.withdraw(&mut self.topo, id);
        self.affordances.rebuild(&self.topo);
        self.topo.bump_navigation_revision();
        Ok(())
    }
}
