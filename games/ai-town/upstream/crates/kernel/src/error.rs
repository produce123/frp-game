//! 内核错误类型。每个变体对应一个子系统，携带的文案就是给前端和村民看的说明，
//! `Display` 原样输出。调用方保留这个类型传递，需要分类时按变体判断，不按文案。
use std::fmt;

/// 内核内部统一的返回类型；第二个参数留给少数用别的错误类型的函数。
pub type Result<T, E = KernelError> = std::result::Result<T, E>;

/// 命令被拒绝或数据不合法的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KernelError {
    /// 引用的村民不存在；携带请求里的编号，文案固定为「村民不存在」。
    NoSuchActor(String),
    /// 意图与动作命令：动词、落脚点、道具动作、动作组。
    Action(String),
    /// 天气控制与活动策略：机器码独立于显示文案。
    Weather {
        code: protocol::WeatherCode,
        reason: String,
    },
    /// 背包转移：拾取、存放、领取、赠送。
    Inventory(String),
    /// 双方互动：邀请、回应、聊天。
    Interaction(String),
    /// 身体与需求：状况、数值、效果施用。
    Physiology(String),
    /// 公告与书籍：张贴、修订、阅读、写作。
    Content(String),
    /// 道具库与道具实例：定义、版本、放置、移除。
    Props(String),
    /// 寻路与空间放置。
    Navigation(String),
    /// 场景包解析、入口与住宅配置。
    Topology(String),
    /// 安置与撤回。
    Population(String),
    /// 存档校验失败。
    Snapshot(String),
    /// 入镇申请被拒；列出全部不通过的规则，输出时用「；」连接。
    Admission(Vec<String>),
    /// 给内层错误加上下文前缀，例如「第 2 项：」。
    Context {
        prefix: String,
        source: Box<KernelError>,
    },
}

impl KernelError {
    pub(crate) fn weather(code: protocol::WeatherCode, reason: impl Into<String>) -> Self {
        Self::Weather {
            code,
            reason: reason.into(),
        }
    }
    pub(crate) fn action(reason: impl Into<String>) -> Self {
        Self::Action(reason.into())
    }
    pub(crate) fn inventory(reason: impl Into<String>) -> Self {
        Self::Inventory(reason.into())
    }
    pub(crate) fn interaction(reason: impl Into<String>) -> Self {
        Self::Interaction(reason.into())
    }
    pub(crate) fn physiology(reason: impl Into<String>) -> Self {
        Self::Physiology(reason.into())
    }
    pub(crate) fn content(reason: impl Into<String>) -> Self {
        Self::Content(reason.into())
    }
    pub(crate) fn props(reason: impl Into<String>) -> Self {
        Self::Props(reason.into())
    }
    pub(crate) fn navigation(reason: impl Into<String>) -> Self {
        Self::Navigation(reason.into())
    }
    pub(crate) fn topology(reason: impl Into<String>) -> Self {
        Self::Topology(reason.into())
    }
    pub(crate) fn population(reason: impl Into<String>) -> Self {
        Self::Population(reason.into())
    }
    pub(crate) fn snapshot(reason: impl Into<String>) -> Self {
        Self::Snapshot(reason.into())
    }
    pub(crate) fn context(prefix: impl Into<String>, source: KernelError) -> Self {
        Self::Context {
            prefix: prefix.into(),
            source: Box::new(source),
        }
    }
}

impl fmt::Display for KernelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Weather { code, reason } => write!(f, "{}：{reason}", code.as_str()),
            Self::NoSuchActor(_) => f.write_str("村民不存在"),
            Self::Action(reason)
            | Self::Inventory(reason)
            | Self::Interaction(reason)
            | Self::Physiology(reason)
            | Self::Content(reason)
            | Self::Props(reason)
            | Self::Navigation(reason)
            | Self::Topology(reason)
            | Self::Population(reason)
            | Self::Snapshot(reason) => f.write_str(reason),
            Self::Admission(problems) => f.write_str(&problems.join("；")),
            Self::Context { prefix, source } => write!(f, "{prefix}{source}"),
        }
    }
}

impl std::error::Error for KernelError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Context { source, .. } => Some(source.as_ref()),
            _ => None,
        }
    }
}
