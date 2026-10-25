//! 请求台账：最近 500 次模型请求的时间、耗时、token 与结果，随会话状态存档。
//! 只记村民的生活决策与记忆整理；不含生成人物、连接测试这类用户操作。
//! 种类与结果用 protocol 的枚举，线上与存档同一套值。
use super::ResidentRuntime;
use crate::{
    conversation::Usage,
    session::{RequestStamp, Session},
    view::actor_name,
};
use kernel::World;
use protocol::RequestView;
pub use protocol::{RequestKind, RequestStatus};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const LEDGER_LIMIT: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestRecord {
    pub id: u64,
    pub actor_id: String,
    pub kind: RequestKind,
    pub sim_minutes: f64,
    /// 发出时的现实时间（Unix 秒），由 poll 的调用方传入。
    pub sent_at: u64,
    pub reserved_tokens: u64,
    pub estimated_tokens: u64,
    pub status: RequestStatus,
    /// 工具名、错误或退回原因
    pub detail: String,
    #[serde(default)]
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub input_tokens: Option<u64>,
    #[serde(default)]
    pub output_tokens: Option<u64>,
    #[serde(default)]
    pub cache_hit_tokens: Option<u64>,
}

impl RequestRecord {
    /// 消耗页的一行：台账记录加上村民姓名与展示时钟。姓名要查世界，所以不是 `From`。
    pub fn view(&self, world: &World) -> RequestView {
        RequestView {
            id: self.id,
            resident_id: self.actor_id.clone(),
            resident: actor_name(world, &self.actor_id),
            kind: self.kind,
            clock: kernel::clock_string(self.sim_minutes),
            sim_minutes: self.sim_minutes,
            sent_at: self.sent_at,
            reserved_tokens: self.reserved_tokens,
            estimated_tokens: self.estimated_tokens,
            status: self.status,
            detail: self.detail.clone(),
            latency_ms: self.latency_ms,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_hit_tokens: self.cache_hit_tokens,
        }
    }
}

impl ResidentRuntime {
    pub fn requests(&self) -> &VecDeque<RequestRecord> {
        &self.state.requests
    }

    /// 编号随请求递增，台账按编号有序，二分查找。
    fn ledger_entry(&mut self, id: u64) -> Option<&mut RequestRecord> {
        let index = self
            .state
            .requests
            .binary_search_by_key(&id, |r| r.id)
            .ok()?;
        self.state.requests.get_mut(index)
    }

    pub(super) fn ledger_open(
        &mut self,
        s: &Session,
        stamp: &RequestStamp,
        kind: RequestKind,
        estimated: u64,
    ) {
        self.state.requests.push_back(RequestRecord {
            id: stamp.id,
            actor_id: s.actor_id.clone(),
            kind,
            sim_minutes: stamp.sim_minutes,
            sent_at: self.wall_clock,
            reserved_tokens: stamp.reserved_tokens,
            estimated_tokens: estimated,
            status: RequestStatus::InFlight,
            detail: String::new(),
            latency_ms: None,
            input_tokens: None,
            output_tokens: None,
            cache_hit_tokens: None,
        });
        while self.state.requests.len() > LEDGER_LIMIT {
            self.state.requests.pop_front();
        }
    }

    pub(super) fn ledger_reply(&mut self, id: u64, latency_ms: u64, usage: Option<&Usage>) {
        if let Some(r) = self.ledger_entry(id) {
            r.latency_ms = Some(latency_ms);
            if let Some(u) = usage {
                r.input_tokens = Some(u.input_tokens);
                r.output_tokens = Some(u.output_tokens);
                r.cache_hit_tokens = Some(u.cache_hit_tokens);
            }
        }
    }

    pub(super) fn ledger_close(
        &mut self,
        id: u64,
        status: RequestStatus,
        detail: impl Into<String>,
    ) {
        if let Some(r) = self.ledger_entry(id) {
            r.status = status;
            r.detail = detail.into();
        }
    }
}
