//! 化身的每拍处理：控制目标死亡或断线超时就交还，附身的村民走到了就交给玩家，二维地图按方向移动，
//! 交谈轮到玩家太久没说话就代为倾听。
use crate::{network::Clients, runtime::Runtime};
use protocol::InteractionCommand;
use std::time::{Duration, Instant};

/// 二维地图的方向输入超过这么久没更新就停下。
const INPUT_TIMEOUT: Duration = Duration::from_millis(350);
/// 交谈轮到玩家后等这么久（或玩家已断线）就代为倾听，不让整场交谈卡住。
const TURN_WAIT: Duration = Duration::from_secs(60);

impl Runtime {
    pub(crate) fn avatar_tick(&mut self, clients: &Clients) {
        self.avatar_tick_host(clients);
        self.avatar_tick_guests();
    }

    fn avatar_tick_host(&mut self, _clients: &Clients) {
        let now = Instant::now();
        let elapsed = self
            .avatar_control
            .last_tick
            .replace(now)
            .map(|last| now.duration_since(last))
            .unwrap_or_default();
        if self
            .world
            .possessed()
            .is_some_and(|a| a.needs.incapacitated() && a.needs.body.dead)
        {
            self.release_player_safely();
            return;
        }
        // 附身的村民走到了：交给玩家。存盘失败时撤回，下一拍再试；失败日志由检查点记。
        if self.world.possession_arrived() {
            let _ = self.transact(|rt| {
                rt.world.activate_possession();
                Ok::<_, std::convert::Infallible>(())
            });
        }
        let Some(lease) = self.avatar_control.lease.as_mut() else {
            return;
        };
        if lease.lapse(now) {
            self.avatar_control.halt();
        }
        let Some(lease) = self.avatar_control.lease.as_ref() else {
            return;
        };
        if lease.expired() {
            self.release_player_safely();
            return;
        }
        let online = lease.online();
        if self.save_failed || self.speed <= 0. || !self.world_settings.ready() {
            self.avatar_control.halt();
            return;
        }
        self.walk(online);
        self.listen_when_turn_waits(online, elapsed);
    }

    /// 按最近的方向输入走一拍；输入过期或断线就原地不动。
    fn walk(&mut self, online: bool) {
        let fresh = self
            .avatar_control
            .input_at
            .is_some_and(|at| at.elapsed() <= INPUT_TIMEOUT);
        let direction = if online && fresh {
            self.avatar_control.direction
        } else {
            [0., 0.]
        };
        // 撞墙之类走不动时原地不动，不需要回执。
        let _ = self.world.avatar_move(direction, 0.1 * self.normal_pace());
    }

    /// 访客的移动：各走各自的方向输入，输入过期或世界暂停就停下。
    fn avatar_tick_guests(&mut self) {
        let connections: Vec<u64> = self.guests.keys().copied().collect();
        for connection in connections {
            let Some(mut guest) = self.guests.remove(&connection) else {
                continue;
            };
            let fresh = guest
                .control
                .input_at
                .is_some_and(|at| at.elapsed() <= INPUT_TIMEOUT);
            let direction =
                if fresh && self.speed > 0. && !self.save_failed && self.world_settings.ready() {
                    guest.control.direction
                } else {
                    guest.control.halt();
                    [0., 0.]
                };
            self.world.set_active_actor(Some(guest.actor.clone()));
            let _ = self.world.avatar_move(direction, 0.1 * self.normal_pace());
            self.world.set_active_actor(None);
            self.guests.insert(connection, guest);
        }
    }

    /// 交谈轮到玩家：同一次轮到（同一聊天、同一动作版本）累计等待，超时或断线就代为倾听。
    fn listen_when_turn_waits(&mut self, online: bool, elapsed: Duration) {
        let actor = self.world.player_id().to_owned();
        let turn = self
            .world
            .active_chat(&actor)
            .filter(|_| self.world.chat_turn(&actor))
            .map(|i| {
                let revision = self.world.actor(&actor).map_or(0, |a| a.actions.revision);
                (i.id.clone(), revision)
            });
        let Some((id, revision)) = turn else {
            self.avatar_control.turn = None;
            return;
        };
        let waited = match &self.avatar_control.turn {
            Some((old, r, d)) if *old == id && *r == revision => *d + elapsed,
            _ => Duration::ZERO,
        };
        self.avatar_control.turn = Some((id.clone(), revision, waited));
        if online && waited < TURN_WAIT {
            return;
        }
        let command_id = format!("control/auto-listen/{:032x}", rand::random::<u128>());
        // 轮次已经过去等情况下倾听会被拒绝，这时什么也不用做。
        let _ = self.world.avatar_interact(
            &command_id,
            revision,
            &InteractionCommand::Listen { interaction_id: id },
        );
        self.avatar_control.turn = None;
        // 存盘失败由检查点自己记日志，下一拍再存。
        let _ = self.checkpoint(true);
    }
}
