//! 村民决策：持续会话、工具调度、目标与记忆。
//! 本 crate 不碰网络。查询读取本人的世界投影，身体动作与互动进入 kernel 命令校验。

pub mod budget;
pub mod builtin;
pub mod completion;
pub mod context;
pub mod conversation;
mod error;
pub mod interaction;
pub mod labels;
pub mod looks;
pub mod memory;
pub mod notebook;
pub mod observation;
pub mod prompts;
pub mod runtime;
pub mod session;
pub mod tools;
pub mod view;

pub use error::AgentError;
use kernel::{world::Actor, World};

pub(crate) const NO_RESIDENT: &str = "村民不存在";

/// 按编号取村民；不存在时返回统一的错误文案。
pub(crate) fn resident<'w>(world: &'w World, id: &str) -> Result<&'w Actor, AgentError> {
    world
        .actor(id)
        .ok_or_else(|| AgentError::NotFound(NO_RESIDENT.into()))
}

/// 事件按编号递增存放，可二分查找。
pub(crate) fn event(actor: &Actor, id: u64) -> Option<&protocol::WorldFact> {
    let events = &actor.journal.events;
    events
        .binary_search_by_key(&id, |e| e.event_id)
        .ok()
        .map(|i| &events[i])
}
