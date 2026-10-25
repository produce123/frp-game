//! 世界检查点与各村民文件版本共同提交；坏档不会被新世界覆盖。
use crate::HostError;
use crate::{
    agent_worker::AgentSave,
    fnv::{fnv1a, FNV_OFFSET},
    population::Population,
    world_settings::{valid_speed, WorldSettings},
};
use kernel::{World, WorldSnapshot};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

mod migration;
mod residents;
mod retired_commissions;
use migration::{Backup, SCHEMA_VERSION};
use residents::{ResidentStore, Residents};

const AUTOSAVE_INTERVAL: Duration = Duration::from_secs(1);
/// 缺省存档文件名；村民记忆目录按它旁边的 residents/ 投影。
pub const SAVE_FILE_NAME: &str = "world.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveFile {
    #[serde(default)]
    world_settings: WorldSettings,
    schema_version: u32,
    world_key: String,
    speed: f64,
    world: WorldSnapshot,
    #[serde(default)]
    resident_agent: Option<AgentSave>,
    #[serde(default)]
    resident_files: Residents,
    /// v3 起的人口登记；旧档没有，由启动配置迁移。
    #[serde(default)]
    population: Option<Population>,
}

/// 恢复结果：速度、世界设定、Agent 会话与人口登记（旧档为 None，交给调用者迁移）。
/// Agent 会话只是存档里的数据，恢复成运行器由调用方做一次，这里不重复恢复。
/// 世界设定交给调用方保管，存盘时再传回来，存档对象自己不留副本。
#[derive(Debug)]
pub struct Restored {
    pub speed: f64,
    pub world_settings: WorldSettings,
    pub agent: Option<AgentSave>,
    pub population: Option<Population>,
}

pub struct SaveStore {
    path: PathBuf,
    world_key: String,
    /// 规范化后的场景定义；v1/v2 旧档的兼容标识还要把人物身份算进去，从它重新算。
    definition: Option<serde_json::Value>,
    /// 旧档兼容标识表的路径；只在遇到身体字段升级前的存档时读取。
    compatibility: Option<PathBuf>,
    _lock: File,
    previous: Vec<u8>,
    last_check: Instant,
    residents: ResidentStore,
}

/// 独立运行数据目录里的存档文件。
pub fn default_save_path() -> Result<PathBuf, HostError> {
    Ok(crate::application::data_root()?.join(SAVE_FILE_NAME))
}

/// 规范化的场景定义：道具按目录展开、忽略排版、去掉只影响新加入者的入口。
fn world_definition(
    topology: &str,
    catalog: &kernel::props::Catalog,
) -> Result<serde_json::Value, HostError> {
    kernel::Topology::from_json(topology, catalog)?;
    let mut definition = catalog.world_definition(topology)?;
    // 入口只影响新加入者；已有村民恢复其保存的位置。
    if let Some(object) = definition.as_object_mut() {
        object.remove("entry");
    }
    Ok(definition)
}

/// FNV-1a 检测场景定义变化（不用于安全认证）。
/// `resident` 只有旧档（v1/v2）的兼容标识才带人物身份；v3 起人口是存档自己的状态，传空。
fn key_of(definition: &serde_json::Value, resident: &[&str]) -> String {
    let text = serde_json::json!([definition, resident]).to_string();
    format!("physiology-v1:{:016x}", fnv1a(text.as_bytes(), FNV_OFFSET))
}

pub fn world_key(
    topology: &str,
    resident: &[&str],
    catalog: &kernel::props::Catalog,
) -> Result<String, HostError> {
    Ok(key_of(&world_definition(topology, catalog)?, resident))
}

impl SaveStore {
    /// 用给定标识打开；旧档兼容标识不可用（测试与工具用）。
    pub fn open(path: &Path, world_key: String) -> Result<Self, HostError> {
        let path = std::path::absolute(path).map_err(|e| HostError::Save(e.to_string()))?;
        let parent = path
            .parent()
            .ok_or_else(|| HostError::Save("存档需要文件路径".into()))?;
        fs::create_dir_all(parent)
            .map_err(|e| HostError::Save(format!("创建存档目录失败：{e}")))?;
        let path = parent
            .canonicalize()
            .map_err(|e| HostError::Save(e.to_string()))?
            .join(
                path.file_name()
                    .ok_or_else(|| HostError::Save("存档需要文件名".into()))?,
            );
        if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(HostError::Save(
                "存档文件不能是符号链接，请使用实际文件路径".into(),
            ));
        }
        let lock = private_file(&sidecar(&path, ".lock"), false)
            .map_err(|e| HostError::Save(format!("打开存档锁失败：{e}")))?;
        crate::process::lock_save(&lock).map_err(|e| {
            HostError::Save(format!(
                "无法独占存档 {}，可能有另一个 host 正在使用：{e}",
                path.display()
            ))
        })?;
        let residents = ResidentStore::new(&path);
        Ok(Self {
            residents,
            path,
            world_key,
            definition: None,
            compatibility: None,
            _lock: lock,
            previous: Vec::new(),
            last_check: Instant::now(),
        })
    }

    /// 按场景定义打开：标识从定义算出，v1/v2 旧档按含人物身份的兼容标识识别。
    /// `compatibility` 是旧档兼容标识表，遇到身体字段升级前的存档才读。
    pub fn open_world(
        path: &Path,
        topology: &str,
        catalog: &kernel::props::Catalog,
        compatibility: &Path,
    ) -> Result<Self, HostError> {
        let definition = world_definition(topology, catalog)?;
        let mut store = Self::open(path, key_of(&definition, &[]))?;
        store.definition = Some(definition);
        store.compatibility = Some(compatibility.to_path_buf());
        Ok(store)
    }

    /// 兼容标识表原文；没有配置路径或文件缺失都是错误，不会把旧档当成不匹配悄悄拒绝。
    fn compatibility_table(&self) -> Result<String, HostError> {
        let path = self
            .compatibility
            .as_ref()
            .ok_or_else(|| HostError::Save("此存档打开方式不支持旧档兼容标识表".into()))?;
        fs::read_to_string(path)
            .map_err(|e| HostError::Save(format!("读取兼容标识表 {} 失败：{e}", path.display())))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 只有不存在才返回 None；错误向上传递，阻止新世界覆盖旧档。
    pub fn restore_bundle(&mut self, world: &mut World) -> Result<Option<Restored>, HostError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => {
                return Err(HostError::Save(format!(
                    "读取存档 {} 失败：{e}",
                    self.path.display()
                )))
            }
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
            HostError::Save(format!(
                "存档 {} 损坏或格式不兼容，原文件已保留：{e}",
                self.path.display()
            ))
        })?;
        let migrated = migration::migrate(value)?;
        let mut saved = migrated.file;
        let legacy = migrated.from_version < 3; // v3 起身份已由人口登记单独管理；v4 不改变地图标识。
        self.check_identity(
            &saved,
            legacy,
            migrated.backups.contains(&Backup::Physiology),
        )?;
        if !valid_speed(saved.speed) {
            return Err(HostError::Save("存档速度无效，原文件已保留".into()));
        }
        // v1 的记忆内嵌在会话里，下一次检查点才拆成文件。
        if migrated.from_version >= 2 {
            self.residents
                .hydrate(&saved.resident_files, &mut saved.resident_agent)?;
        }
        let weather_id = saved
            .population
            .as_ref()
            .map(|p| p.world_id.as_str())
            .unwrap_or(&saved.world_key);
        saved.world.migrate_weather(world.weather(), weather_id)?;
        world.restore_snapshot(saved.world)?;
        if world
            .weather()
            .map(|weather| weather.view.clone())
            .is_some_and(|v| v.world_id != weather_id)
        {
            return Err(HostError::Save(
                "天气所属世界与存档人口不一致，原文件已保留".into(),
            ));
        }
        if let Some(population) = &saved.population {
            population.validate_against(
                world,
                saved.resident_agent.as_ref().map(|a| &a.runtime.sessions),
            )?;
        }
        for backup in &migrated.backups {
            self.write_backup(backup, &bytes, &saved.resident_files)?;
        }
        if migrated.from_version >= 2 {
            self.residents.publish(&saved.resident_files)?;
        }
        saved.world_settings.validate()?;
        self.previous = bytes;
        Ok(Some(Restored {
            speed: saved.speed,
            world_settings: saved.world_settings,
            agent: saved.resident_agent,
            population: saved.population,
        }))
    }

    /// 存档必须是同一张地图、同一套规则；旧档还把人物身份算进标识。
    fn check_identity(
        &self,
        saved: &SaveFile,
        legacy: bool,
        body_migrated: bool,
    ) -> Result<(), HostError> {
        let identities = saved.world.identities();
        let expected = match (&self.definition, legacy) {
            (Some(definition), true) => {
                let flat: Vec<&str> = identities
                    .iter()
                    .flat_map(|(id, home)| [id.as_str(), home.as_str()])
                    .collect();
                key_of(definition, &flat)
            }
            _ => self.world_key.clone(),
        };
        let known_upgrade = body_migrated
            && migration::known_upgrade(
                &self.compatibility_table()?,
                &saved.world_key,
                &self.world_key,
                legacy,
                &identities,
            )?;
        if saved.world_key != expected && !known_upgrade {
            return Err(HostError::Save(format!(
                "存档 {} 的版本、地图、规则或村民身份不匹配，原文件已保留；请使用匹配配置或 --save-file 指定新文件",
                self.path.display()
            )));
        }
        Ok(())
    }

    /// 迁移前把原始存档及其引用的记忆对象完整留存。
    fn write_backup(
        &self,
        backup: &Backup,
        bytes: &[u8],
        files: &Residents,
    ) -> Result<(), HostError> {
        let dir = sidecar(&self.path, backup.suffix());
        self.residents.backup(&dir, bytes, files)?;
        if let Some(name) = backup.extra_file() {
            fs::write(dir.join(name), self.compatibility_table()?).map_err(|e| {
                HostError::Save(format!("写迁移备份 {} 失败：{e}", dir.join(name).display()))
            })?;
        }
        eprintln!("[host] {}：{}", backup.label(), dir.display());
        Ok(())
    }

    /// `force` 为假时按周期节流；节流只在这一处判断。返回 false 表示这次被节流、没有写。
    /// Agent 会话要整份克隆，`resident_agent` 在节流判断之后才调用。
    pub fn checkpoint_bundle(
        &mut self,
        world: &World,
        speed: f64,
        world_settings: &WorldSettings,
        population: Option<&Population>,
        resident_agent: impl FnOnce() -> Option<AgentSave>,
        force: bool,
    ) -> Result<bool, HostError> {
        if !force && self.last_check.elapsed() < AUTOSAVE_INTERVAL {
            return Ok(false);
        }
        let mut resident_agent = resident_agent();
        let resident_files = self.residents.stage(world, &mut resident_agent)?;
        let saved = SaveFile {
            world_settings: world_settings.clone(),
            schema_version: SCHEMA_VERSION,
            resident_files,
            world_key: self.world_key.clone(),
            speed,
            world: world.snapshot(),
            resident_agent,
            population: population.cloned(),
        };
        let bytes = serde_json::to_vec(&saved)
            .map_err(|e| HostError::Save(format!("编码存档失败：{e}")))?;
        if bytes != self.previous {
            if let Err(error) = atomic_write(&self.path, &bytes) {
                // rename 之后目录 fsync 仍可能失败。已可读的提交不可再按“未提交”回滚内存。
                if !fs::read(&self.path).is_ok_and(|committed| committed == bytes) {
                    return Err(error);
                }
                eprintln!("[host] 存档已替换，但目录同步失败，断电持久性未确认：{error}");
            }
            self.previous = bytes;
        }
        // world.json 与不可变对象已经提交；可读目录是可重建投影。
        // 投影失败不能让命令回滚到已不再属于磁盘的旧世界，下一次检查点会重试。
        if let Err(error) = self.residents.publish(&saved.resident_files) {
            eprintln!("[host] 存档已提交，居民可读目录待重建：{error}");
        }
        self.last_check = Instant::now();
        Ok(true)
    }
}

fn private_file(path: &Path, truncate: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(truncate);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

/// 全 host 唯一的原子写入：临时文件 + fsync + rename，再 fsync 目录；不跟随符号链接，
/// 文件权限 0600。父目录不存在时创建。
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), HostError> {
    write_atomically(path, bytes)
        .map_err(|e| HostError::Io(format!("写入 {} 失败：{e}", path.display())))
}

fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    fs::create_dir_all(dir)?;
    let temporary = sidecar(path, ".tmp");
    let mut file = private_file(&temporary, true)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    #[cfg(unix)]
    File::open(dir)?.sync_all()?;
    Ok(())
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}
