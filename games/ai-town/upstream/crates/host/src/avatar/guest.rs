//! 平台联机的访客化身：每个 guest 连接有自己的控制租约和 actor。
//! 房主那条路径（`avatar_control`）完全不动；这里只在处理访客消息时临时把租约和
//! `world.active_actor` 切过去，处理完再换回来，避免同一张地图上互相抢控制权。
use super::{command::AvatarRequest, Control, GuestControl};
use crate::{network::Clients, runtime::Runtime};
use kernel::avatar;
use protocol::{AvatarResultCode, ClientMsg, ServerMsg};

impl Runtime {
    fn guest_actor(&self, connection: u64) -> String {
        if let Some(user) = self
            .identities
            .get(&connection)
            .map(|i| i.user.as_str())
            .filter(|u| !u.is_empty())
        {
            return avatar::guest_id(user);
        }
        format!("{}conn-{connection}", avatar::GUEST_PREFIX)
    }

    /// 访客的 Avatar 命令：换入访客租约和 actor，复用房主的命令事务/存盘/回执。
    pub(super) fn guest_avatar_command(
        &mut self,
        connection: u64,
        mut request: AvatarRequest,
        clients: &Clients,
    ) {
        // 名字用平台账号名，避免客人自己在客户端改昵称后，房主头顶看到的名字和平台对不上。
        if let protocol::AvatarCommand::Enter { name, .. }
        | protocol::AvatarCommand::Profile { name, .. } = &mut request.command
        {
            if let Some(platform) = self
                .identities
                .get(&connection)
                .map(|i| i.name.trim())
                .filter(|n| !n.is_empty())
            {
                *name = platform.to_owned();
            }
        }
        // 访客不能再附身村民：他们已经是自己的化身，附身会让同一世界出现第二个
        // 玩家控制目标，也会把村民写进房主存档。
        if matches!(request.command, protocol::AvatarCommand::Possess { .. }) {
            self.guest_avatar_result(
                connection,
                request.request_id,
                false,
                AvatarResultCode::Occupied,
                "访客不能再附身村民",
                clients,
            );
            return;
        }
        let actor = self.guest_actor(connection);
        let mut guest = self
            .guests
            .remove(&connection)
            .unwrap_or_else(|| GuestControl {
                actor: actor.clone(),
                control: Control::default(),
            });
        guest.actor = actor.clone();
        let host_control = std::mem::take(&mut self.avatar_control);
        self.avatar_control = guest.control;
        self.world.set_active_actor(Some(actor));
        self.avatar_command(connection, request, clients);
        self.world.set_active_actor(None);
        guest.control = std::mem::take(&mut self.avatar_control);
        self.avatar_control = host_control;
        if guest.control.held() {
            self.guests.insert(connection, guest);
        }
    }

    /// 网络层把方向输入单独攒起来，模拟线程每拍取；这里按身份分给房主或访客的租约。
    pub(crate) fn avatar_input_from(&mut self, connection: u64, input: ClientMsg) {
        if self
            .identities
            .get(&connection)
            .is_some_and(|i| i.is_guest())
        {
            self.guest_avatar_input(connection, input);
        } else {
            self.avatar_input(connection, input);
        }
    }

    /// 访客方向输入：同样临时换入它的租约，让 `avatar_input` 的校验走自己的租约。
    pub(super) fn guest_avatar_input(&mut self, connection: u64, input: ClientMsg) {
        let Some(actor) = self.guests.get(&connection).map(|g| g.actor.clone()) else {
            return;
        };
        let mut guest = self.guests.remove(&connection).expect("刚查过");
        let host_control = std::mem::take(&mut self.avatar_control);
        self.avatar_control = guest.control;
        self.world.set_active_actor(Some(actor));
        self.avatar_input(connection, input);
        self.world.set_active_actor(None);
        guest.control = std::mem::take(&mut self.avatar_control);
        self.avatar_control = host_control;
        self.guests.insert(connection, guest);
    }

    /// 访客只能读公共视图，不能改世界设置、限流、模型或村民；房主的存档要留在房主手里。
    pub(super) fn guest_command(&mut self, connection: u64, message: ClientMsg, clients: &Clients) {
        let allowed = matches!(
            message,
            ClientMsg::GetChatHistory { .. }
                | ClientMsg::GetWorldSettings
                | ClientMsg::GetProps
                | ClientMsg::GetModelConfig
                | ClientMsg::GetAgentConfig { .. }
                | ClientMsg::GetPopulation
                | ClientMsg::GetUsage
                | ClientMsg::GetResidentLibrary { .. }
                | ClientMsg::GetResidentTemplate { .. }
                | ClientMsg::PreviewResidentJoin { .. }
                | ClientMsg::GetResidentJoinResult { .. }
                | ClientMsg::GetDiary { .. }
                | ClientMsg::GetNotebook { .. }
                | ClientMsg::GetNotebookDetail { .. }
                | ClientMsg::GetAgentLimits
        );
        if allowed {
            self.command(connection, message, clients);
        } else {
            crate::network::send_to(
                clients,
                connection,
                &crate::runtime::error_msg("访客只能控制自己的化身；世界设置由房主管理".into()),
            );
        }
    }

    /// 访客断线：交还自己的化身（离场、不存档），返回 true 表示已处理。
    pub(super) fn guest_disconnect(&mut self, connection: u64) -> bool {
        let Some(guest) = self.guests.remove(&connection) else {
            return false;
        };
        let host_control = std::mem::take(&mut self.avatar_control);
        self.avatar_control = guest.control;
        self.world.set_active_actor(Some(guest.actor));
        self.release_player_safely();
        self.world.set_active_actor(None);
        self.avatar_control = host_control;
        true
    }

    /// 给每个在线访客发它自己的化身状态；临时换租约是为了复用房主的状态计算。
    pub(super) fn publish_guests(&mut self, clients: &Clients) {
        let connections: Vec<u64> = self.guests.keys().copied().collect();
        for connection in connections {
            let Some(mut guest) = self.guests.remove(&connection) else {
                continue;
            };
            let host_control = std::mem::take(&mut self.avatar_control);
            self.avatar_control = guest.control;
            self.world.set_active_actor(Some(guest.actor.clone()));
            let state = self.avatar_session(connection);
            self.world.set_active_actor(None);
            guest.control = std::mem::take(&mut self.avatar_control);
            self.avatar_control = host_control;
            crate::network::send_to(clients, connection, &ServerMsg::AvatarState { state });
            if guest.control.held() {
                self.guests.insert(connection, guest);
            }
        }
    }

    fn guest_avatar_result(
        &self,
        connection: u64,
        request_id: String,
        ok: bool,
        code: AvatarResultCode,
        message: &str,
        clients: &Clients,
    ) {
        crate::network::send_to(
            clients,
            connection,
            &ServerMsg::AvatarResult {
                request_id,
                ok,
                code,
                message: message.into(),
                state: self.guest_session(connection, &self.guest_actor(connection)),
            },
        );
    }

    fn guest_session(&self, connection: u64, actor: &str) -> protocol::AvatarSession {
        let _ = connection;
        // 不换租约，只把视图算成这个 actor；进入被拒时也能回一个可渲染的状态。
        let view = self.world.avatar_view_for(actor);
        protocol::AvatarSession {
            view: protocol::AvatarSight::Own(view),
            world_id: self.population.world_id.clone(),
            speed: self.normal_pace(),
            controlled: false,
            occupied: true,
            recent: None,
            goals: None,
            lease: None,
            client_positions: false,
            walk: None,
            position: None,
        }
    }
}
