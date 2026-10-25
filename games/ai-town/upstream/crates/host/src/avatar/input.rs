//! HD-2D 化身只上报移动方向，由世界校验并推进位置。
use crate::runtime::Runtime;
use protocol::ClientMsg;
use std::time::Instant;

impl Runtime {
    pub(crate) fn avatar_input(&mut self, connection: u64, input: ClientMsg) {
        let ClientMsg::AvatarInput {
            world_id,
            epoch,
            sequence,
            navigation_revision,
            direction,
            pose,
        } = input
        else {
            return;
        };
        if world_id != self.population.world_id
            || self.check_control(connection, &epoch).is_err()
            || sequence <= self.avatar_control.input_sequence
        {
            return;
        }
        self.avatar_control.input_sequence = sequence;
        // 旧 3D 客户端的位姿请求仍可解析，但不能改变世界位置。
        if pose.is_some()
            || navigation_revision != self.world.topo.navigation_revision().unwrap_or(1)
            || direction.iter().any(|v| !v.is_finite() || v.abs() > 1.)
        {
            self.avatar_control.halt();
            return;
        }
        self.avatar_control.direction = direction;
        self.avatar_control.input_at = Some(Instant::now());
    }
}
