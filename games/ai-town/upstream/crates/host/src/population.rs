//! 世界人口的登记表：谁在这个世界、住哪、用的哪份人设。人口是存档自己的动态状态，
//! 启动配置只在建新世界或迁移旧档时当种子。
use crate::fnv::{fnv1a, FNV_OFFSET};
use crate::HostError;
use kernel::World;
use protocol::{Appearance, JoinOutcome, ModelChoice, NeedsTuning, VillagerLook};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 加入操作的去重记录最多留这么多条，超出时淘汰最早的。
const JOIN_HISTORY: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registration {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub home: Option<String>,
    /// None 表示原有居民：入村时间无法证明，不补造入口经历。
    #[serde(default)]
    pub joined_at: Option<f64>,
    #[serde(default)]
    pub template_id: Option<String>,
    #[serde(default)]
    pub template_version: Option<u64>,
    /// 采用的人设快照；个人设定修改的是这一份，不回写模板。
    pub persona: String,
    #[serde(default)]
    pub appearance: Appearance,
    /// 村民自己的模型绑定；None 表示尚未配置，不能发起模型请求。
    /// 只保存 provider/model 引用，端点和密钥仍属于应用配置。
    #[serde(
        default,
        alias = "model_override",
        skip_serializing_if = "Option::is_none"
    )]
    pub model_binding: Option<ModelChoice>,
    /// 需求参数随登记保存，重置进度时重新应用。
    pub needs: NeedsTuning,
    /// 加入顺序，重置时按它重新安置。0 表示由登记表分配。
    #[serde(default)]
    pub order: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinRecord {
    /// 记录的先后，从 1 递增；旧档没有这个字段，读成 0，最先被淘汰。
    #[serde(default)]
    pub seq: u64,
    pub fingerprint: u64,
    pub outcome: JoinOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Population {
    /// 普通重启保留；重置进度或新建空村时更换，旧页面的加入命令因此失效。
    pub world_id: String,
    pub revision: u64,
    pub residents: BTreeMap<String, Registration>,
    /// 加入操作的去重记录：同号同内容返回原结果，同号不同内容拒绝。
    #[serde(default)]
    pub joins: BTreeMap<String, JoinRecord>,
    #[serde(default)]
    pub next_order: u64,
}

pub fn new_world_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("w{nanos:x}-{}", std::process::id())
}

/// 各段之间加一个分隔字节，避免「ab」+「c」与「a」+「bc」同值。
pub fn fingerprint(parts: &[&str]) -> u64 {
    parts.iter().fold(FNV_OFFSET, |hash, part| {
        fnv1a(&[0x1f], fnv1a(part.as_bytes(), hash))
    })
}

impl Population {
    pub fn fresh() -> Self {
        Self {
            world_id: new_world_id(),
            revision: 0,
            residents: BTreeMap::new(),
            joins: BTreeMap::new(),
            next_order: 0,
        }
    }

    /// 按加入顺序；旧档迁移来的人排在最前。
    pub fn ordered(&self) -> Vec<&Registration> {
        let mut all: Vec<_> = self.residents.values().collect();
        all.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
        all
    }

    /// 命令统一用 id；保留旧客户端的人名寻址。只有一位居民时可以省略。
    pub fn find(&self, target: Option<&str>) -> Result<&Registration, HostError> {
        match target {
            None => {
                if self.residents.len() == 1 {
                    Ok(self.residents.values().next().unwrap())
                } else if self.residents.is_empty() {
                    Err(HostError::Population("还没有村民".into()))
                } else {
                    Err(HostError::Population("请指定村民".into()))
                }
            }
            Some(target) => self
                .residents
                .values()
                .find(|r| r.id == target || r.name == target)
                .ok_or_else(|| HostError::Population(format!("查无此人：{target}"))),
        }
    }

    pub fn joined_from(&self, template_id: &str) -> Option<&Registration> {
        self.residents
            .values()
            .find(|r| r.template_id.as_deref() == Some(template_id))
    }

    /// 下一个没被占用的编号。不改状态：序号在 `insert` 时才推进，这样编号连续。
    /// `taken` 由调用方补充登记表以外的占用（例如世界里的旧人物）。
    pub fn allocate_id(&self, taken: impl Fn(&str) -> bool) -> String {
        (self.next_order + 1..)
            .map(|n| format!("resident_{n:03}"))
            .find(|id| !self.residents.contains_key(id) && !taken(id))
            .expect("编号序列无上限")
    }

    pub fn insert(&mut self, mut registration: Registration) {
        self.next_order += 1;
        if registration.order == 0 {
            registration.order = self.next_order;
        }
        self.revision += 1;
        self.residents.insert(registration.id.clone(), registration);
    }

    /// 换一位居民捏的长相；地图标记和颜色不动。没有这位居民时返回 None，名单版本跟着进一格。
    pub fn set_look(&mut self, id: &str, look: Option<VillagerLook>) -> Option<&Registration> {
        let registration = self.residents.get_mut(id)?;
        registration.appearance.look = look;
        self.revision += 1;
        Some(registration)
    }

    pub fn remember_join(&mut self, op_id: &str, fingerprint: u64, outcome: JoinOutcome) {
        let seq = self.joins.values().map(|r| r.seq).max().unwrap_or(0) + 1;
        self.joins.insert(
            op_id.to_string(),
            JoinRecord {
                seq,
                fingerprint,
                outcome,
            },
        );
        while self.joins.len() > JOIN_HISTORY {
            let oldest = self
                .joins
                .iter()
                .min_by_key(|(id, r)| (r.seq, *id))
                .map(|(id, _)| id.clone())
                .expect("记录超过上限，不会为空");
            self.joins.remove(&oldest);
        }
    }

    /// 登记表、世界人物与 Agent 会话必须成套：同一批 id，住宅和姓名一致。
    pub fn validate_against(
        &self,
        world: &World,
        sessions: Option<&BTreeMap<String, agent::session::Session>>,
    ) -> Result<(), HostError> {
        let ids: Vec<_> = self.residents.keys().cloned().collect();
        let residents: Vec<_> = world
            .actor_ids()
            .into_iter()
            .filter(|id| world.actor(id).is_some_and(|a| !a.is_avatar()))
            .collect();
        if ids != residents {
            return Err(HostError::Population(
                "存档的居民登记与世界人物不一致".into(),
            ));
        }
        if let Some(sessions) = sessions {
            if sessions.keys().ne(self.residents.keys()) {
                return Err(HostError::Population(
                    "存档的居民登记与 Agent 会话不一致".into(),
                ));
            }
        }
        for r in self.residents.values() {
            let actor = world
                .actor(&r.id)
                .ok_or_else(|| HostError::Population("登记指向未知村民".into()))?;
            if actor.home != r.home || actor.name.trim() != r.name.trim() || r.id != actor.id {
                return Err(HostError::Population(format!(
                    "居民 {} 的登记与世界人物不一致",
                    r.id
                )));
            }
        }
        Ok(())
    }
}
