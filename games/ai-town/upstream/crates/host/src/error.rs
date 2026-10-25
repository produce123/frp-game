//! host 的错误类型：按来源分类，文案就是给用户或日志看的说明，`Display` 原样输出。
//! 内核、村民运行器与模型调用的错误原样保留各自的类型，需要分类时按变体判断，不按文案。
use agent::{completion::ModelError, AgentError};
use kernel::KernelError;
use std::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum HostError {
    /// 内核拒绝了命令或数据不合法。
    Kernel(KernelError),
    /// 村民运行器报错。
    Agent(AgentError),
    /// 模型调用失败（连接测试、生成人物、规划地图）。
    Model(ModelError),
    /// 写文件失败（存档、配置、村民库、道具库都走同一个原子写入）。
    Io(String),
    /// 应用配置、服务商配置与密钥、需求与天气规则。
    Config(String),
    /// 地图文件与场景包。
    Map(String),
    /// 存档的读写、迁移与恢复。
    Save(String),
    /// 村民库。
    Library(String),
    /// 道具库。
    Props(String),
    /// 人口登记。
    Population(String),
    /// 启动参数、监听端口、后台任务。
    Runtime(String),
    /// 客户端命令不符合 host 的规则：版本冲突、字段不合规、找不到对象。
    Rejected(String),
}

impl fmt::Display for HostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Kernel(error) => write!(f, "{error}"),
            Self::Agent(error) => write!(f, "{error}"),
            Self::Model(error) => write!(f, "{error}"),
            Self::Io(message)
            | Self::Config(message)
            | Self::Map(message)
            | Self::Save(message)
            | Self::Library(message)
            | Self::Props(message)
            | Self::Population(message)
            | Self::Runtime(message)
            | Self::Rejected(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for HostError {}

impl From<KernelError> for HostError {
    fn from(error: KernelError) -> Self {
        Self::Kernel(error)
    }
}

impl From<AgentError> for HostError {
    fn from(error: AgentError) -> Self {
        Self::Agent(error)
    }
}

impl From<ModelError> for HostError {
    fn from(error: ModelError) -> Self {
        Self::Model(error)
    }
}
