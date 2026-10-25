//! 控制租约：哪个连接在控制化身或附身目标、控制代次、断线恢复凭据与心跳。只在内存里。
use std::time::{Duration, Instant};

/// 心跳超过这么久没来就算断线。
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(15);
/// 断线后在这么久内可以凭恢复凭据接回，过了就交还控制。
const RECONNECT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub(super) struct Lease {
    pub connection: u64,
    /// 控制代次：每次授予都换新的，命令与输入都要带上。
    pub epoch: String,
    /// 断线恢复凭据。
    pub token: String,
    heartbeat: Instant,
    disconnected: Option<Instant>,
}

fn secret() -> String {
    format!("{:032x}", rand::random::<u128>())
}

impl Lease {
    /// 新租约：新的控制代次与恢复凭据。
    pub fn grant(connection: u64) -> Self {
        Self {
            connection,
            epoch: secret(),
            token: secret(),
            heartbeat: Instant::now(),
            disconnected: None,
        }
    }
    pub fn online(&self) -> bool {
        self.disconnected.is_none()
    }
    /// 这个连接持有租约且在线。
    pub fn held_by(&self, connection: u64) -> bool {
        self.connection == connection && self.online()
    }
    /// 命令或输入带的控制代次有效：同一连接、同一代次、在线。
    pub fn admits(&self, connection: u64, epoch: &str) -> bool {
        self.held_by(connection) && self.epoch == epoch
    }
    pub fn beat(&mut self) {
        self.heartbeat = Instant::now();
    }
    pub fn disconnect(&mut self, at: Instant) {
        self.disconnected = Some(at);
    }
    /// 在线但心跳超时：记为断线，返回 true。
    pub fn lapse(&mut self, now: Instant) -> bool {
        let lapsed = self.online() && self.heartbeat.elapsed() > HEARTBEAT_TIMEOUT;
        if lapsed {
            self.disconnect(now);
        }
        lapsed
    }
    /// 断线已超过恢复窗口。
    pub fn expired(&self) -> bool {
        self.disconnected
            .is_some_and(|at| at.elapsed() > RECONNECT_TIMEOUT)
    }
    /// 断线后在恢复窗口内、凭据对得上，可以接回。
    pub fn resumable_with(&self, token: &str) -> bool {
        self.token == token
            && self
                .disconnected
                .is_some_and(|at| at.elapsed() <= RECONNECT_TIMEOUT)
    }
}
