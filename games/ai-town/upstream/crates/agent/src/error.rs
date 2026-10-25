//! agent 的错误类型：按来源分类，文案就是给用户或日志看的说明，`Display` 原样输出。
//! 模型调用失败是 `completion::ModelError`，工具调用被退回是 `tools::ToolError`，都不在这里。
use kernel::KernelError;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum AgentError {
    /// 内核拒绝或内核数据问题；保留内核的分类。
    Kernel(KernelError),
    /// 找不到村民或会话。
    NotFound(String),
    /// 人设与公共知识超长，或连同规则和当前状态放不进模型窗口。
    Instructions(String),
    /// 额度设置不合法，或运行中不能改的项被改了。
    Limits(String),
    /// 存档里的会话状态与世界对不上，不能恢复。
    Restore(String),
    /// 记忆索引出错。
    Memory(String),
    /// 这次请求准备不了：上下文放不下、工具调用没有配对。
    Context(String),
    /// 记忆页的查询不合法或记录已变。
    Query(String),
}

impl fmt::Display for AgentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Kernel(error) => write!(f, "{error}"),
            Self::NotFound(message)
            | Self::Instructions(message)
            | Self::Limits(message)
            | Self::Restore(message)
            | Self::Memory(message)
            | Self::Context(message)
            | Self::Query(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for AgentError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Kernel(error) => Some(error),
            _ => None,
        }
    }
}

impl From<KernelError> for AgentError {
    fn from(error: KernelError) -> Self {
        Self::Kernel(error)
    }
}
