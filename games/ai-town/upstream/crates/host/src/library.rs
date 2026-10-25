//! 村民库：内置模板随项目发布，自定义模板存在用户数据目录，所有小镇共用一份。
//! 模板只是初始设定，不是生活过的人。
use crate::HostError;
use protocol::{Appearance, ResidentTemplate, TemplateFields};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

pub const PERSONA_MAX_CHARS: usize = 4_000;
/// 模板姓名与入村姓名共用的字数上限。
pub const NAME_MAX_CHARS: usize = 20;
const INTRO_MAX_CHARS: usize = 80;
const TAGS_MAX: usize = 8;
const TAG_MAX_CHARS: usize = 12;
/// 村民库目录名：内置模板在 config/ 下，自定义模板在用户数据目录下。
pub const LIBRARY_DIR: &str = "resident-library";

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct LibraryState {
    #[serde(default)]
    archived_builtin: BTreeSet<String>,
}

pub struct Library {
    builtin: BTreeMap<String, ResidentTemplate>,
    custom: BTreeMap<String, ResidentTemplate>,
    /// 自定义模板（templates/）和隐藏内置模板的记录（state.json）所在目录；
    /// None 表示不落盘（--no-save），自定义模板只在本次运行有效。
    root: Option<PathBuf>,
    state: LibraryState,
}

/// 旧版每个小镇把自定义模板存在自己的目录里（towns/<id>/resident-library/），别的小镇看不到。
/// 返回和 `town_dir` 同级的各小镇（含它自己）里还留着的旧村民库，交给 `Library::load` 收进共用库。
pub fn legacy_libraries(town_dir: &Path) -> Vec<PathBuf> {
    let Some(towns) = town_dir.parent() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(towns) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path().join(LIBRARY_DIR))
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    dirs
}

impl Library {
    /// `builtin_dir` 里每个 *.json 是一份模板；`root` 是自定义模板目录，None 表示不落盘。
    /// `legacy` 是旧版各小镇自己的村民库：里面的模板复制进 `root`（见 adopt），原文件不动。
    pub fn load(
        builtin_dir: &Path,
        root: Option<&Path>,
        legacy: &[PathBuf],
    ) -> Result<Self, HostError> {
        let mut builtin = BTreeMap::new();
        if builtin_dir.is_dir() {
            for entry in fs::read_dir(builtin_dir).map_err(|e| HostError::Library(e.to_string()))? {
                let path = entry.map_err(|e| HostError::Library(e.to_string()))?.path();
                if path.extension().is_some_and(|x| x == "json") {
                    let mut t = read_template(&path)?;
                    t.builtin = true;
                    t.archived = false;
                    builtin.insert(t.template_id.clone(), t);
                }
            }
        }
        let root = root.map(Path::to_path_buf);
        let mut custom = BTreeMap::new();
        let mut state = LibraryState::default();
        if let Some(root) = &root {
            let templates = root.join("templates");
            if templates.is_dir() {
                for entry in
                    fs::read_dir(&templates).map_err(|e| HostError::Library(e.to_string()))?
                {
                    let path = entry.map_err(|e| HostError::Library(e.to_string()))?.path();
                    if path.extension().is_some_and(|x| x == "json") {
                        let mut t = read_template(&path)?;
                        t.builtin = false;
                        custom.insert(t.template_id.clone(), t);
                    }
                }
            }
            if let Ok(text) = fs::read_to_string(root.join("state.json")) {
                state = serde_json::from_str(&text).map_err(|e| {
                    HostError::Library(format!("村民库状态文件损坏，原文件已保留：{e}"))
                })?;
            }
        }
        let mut library = Self {
            builtin,
            custom,
            root,
            state,
        };
        if library.root.is_some() {
            for dir in legacy {
                library.adopt(dir);
            }
        }
        for (id, t) in &mut library.builtin {
            t.archived = library.state.archived_builtin.contains(id);
        }
        Ok(library)
    }

    /// 把旧版某个小镇自己的村民库收进来：共用库里没有、或旧版更新的模板才复制；隐藏过的内置模板合并。
    /// 旧文件原样保留；读不了的跳过并记日志，不挡住开镇。
    fn adopt(&mut self, legacy: &Path) {
        let mut templates: Vec<PathBuf> = fs::read_dir(legacy.join("templates"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        templates.sort();
        for path in templates {
            let mut t = match read_template(&path) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("[host] 旧村民模板没有收进村民库：{e}");
                    continue;
                }
            };
            let newer = self
                .custom
                .get(&t.template_id)
                .is_none_or(|c| c.version < t.version);
            if !newer || self.builtin.contains_key(&t.template_id) {
                continue;
            }
            t.builtin = false;
            if let Err(e) = self.persist(&t) {
                eprintln!("[host] 旧村民模板 {} 没能存进村民库：{e}", path.display());
            }
            self.custom.insert(t.template_id.clone(), t);
        }
        let old = fs::read_to_string(legacy.join("state.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<LibraryState>(&text).ok());
        if let Some(old) = old {
            let before = self.state.archived_builtin.len();
            self.state.archived_builtin.extend(old.archived_builtin);
            if self.state.archived_builtin.len() != before {
                if let Err(e) = self.persist_state() {
                    eprintln!("[host] 村民库的隐藏记录没能保存：{e}");
                }
            }
        }
    }

    pub fn root_display(&self) -> String {
        self.root
            .as_ref()
            .map(|r| r.display().to_string())
            .unwrap_or_else(|| "本次运行不落盘".into())
    }

    pub fn all(&self) -> impl Iterator<Item = &ResidentTemplate> {
        self.builtin.values().chain(self.custom.values())
    }

    pub fn get(&self, id: &str) -> Option<&ResidentTemplate> {
        self.builtin.get(id).or_else(|| self.custom.get(id))
    }

    /// 新建或修改自定义模板。内置模板不可改，用「复制并修改」生成自定义模板。
    pub fn save(
        &mut self,
        template_id: Option<&str>,
        expected_version: Option<u64>,
        fields: TemplateFields,
    ) -> Result<ResidentTemplate, HostError> {
        validate_fields(&fields)?;
        let template = match template_id {
            None => ResidentTemplate {
                template_id: new_template_id(),
                version: 1,
                builtin: false,
                archived: false,
                fields,
            },
            Some(id) => {
                if self.builtin.contains_key(id) {
                    return Err(HostError::Library(
                        "内置人物不能直接修改，请用「复制并修改」".into(),
                    ));
                }
                let current = self
                    .custom
                    .get(id)
                    .ok_or_else(|| HostError::Library("模板不存在".into()))?;
                if expected_version != Some(current.version) {
                    return Err(HostError::Library(format!(
                        "模板已被改成第 {} 版，请刷新后再改",
                        current.version
                    )));
                }
                ResidentTemplate {
                    version: current.version + 1,
                    fields,
                    ..current.clone()
                }
            }
        };
        self.persist(&template)?;
        self.custom
            .insert(template.template_id.clone(), template.clone());
        Ok(template)
    }

    pub fn archive(
        &mut self,
        id: &str,
        expected_version: u64,
        archived: bool,
    ) -> Result<ResidentTemplate, HostError> {
        if let Some(t) = self.builtin.get_mut(id) {
            if t.version != expected_version {
                return Err(HostError::Library("模板版本不符，请刷新后再试".into()));
            }
            if archived {
                self.state.archived_builtin.insert(id.into());
            } else {
                self.state.archived_builtin.remove(id);
            }
            t.archived = archived;
            let t = t.clone();
            self.persist_state()?;
            return Ok(t);
        }
        let current = self
            .custom
            .get(id)
            .ok_or_else(|| HostError::Library("模板不存在".into()))?;
        if current.version != expected_version {
            return Err(HostError::Library(format!(
                "模板已被改成第 {} 版，请刷新后再试",
                current.version
            )));
        }
        let template = ResidentTemplate {
            version: current.version + 1,
            archived,
            ..current.clone()
        };
        self.persist(&template)?;
        self.custom.insert(id.into(), template.clone());
        Ok(template)
    }

    fn persist(&self, template: &ResidentTemplate) -> Result<(), HostError> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let path = root
            .join("templates")
            .join(format!("{}.json", template.template_id));
        let text = serde_json::to_string_pretty(template)
            .map_err(|e| HostError::Library(e.to_string()))?;
        crate::persistence::atomic_write(&path, text.as_bytes())
    }

    fn persist_state(&self) -> Result<(), HostError> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let text = serde_json::to_string_pretty(&self.state)
            .map_err(|e| HostError::Library(e.to_string()))?;
        crate::persistence::atomic_write(&root.join("state.json"), text.as_bytes())
    }
}

fn read_template(path: &Path) -> Result<ResidentTemplate, HostError> {
    let text = fs::read_to_string(path)
        .map_err(|e| HostError::Library(format!("读取 {} 失败：{e}", path.display())))?;
    let t: ResidentTemplate = serde_json::from_str(&text).map_err(|e| {
        HostError::Library(format!(
            "模板文件 {} 损坏，原文件已保留：{e}",
            path.display()
        ))
    })?;
    if t.template_id.trim().is_empty() || t.version == 0 {
        return Err(HostError::Library(format!(
            "模板文件 {} 缺少编号或版本",
            path.display()
        )));
    }
    validate_fields(&t.fields)
        .map_err(|e| HostError::Library(format!("模板文件 {}：{e}", path.display())))?;
    Ok(t)
}

fn new_template_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("custom_{nanos:x}")
}

/// 姓名 1–20 字，介绍不超过 80 字，渲染后的人设不超过 4,000 字；不能带疑似密钥。
pub fn validate_fields(fields: &TemplateFields) -> Result<(), HostError> {
    let name = fields.name.trim();
    if name.is_empty() || name.chars().count() > NAME_MAX_CHARS {
        return Err(HostError::Library(format!(
            "姓名须为 1–{NAME_MAX_CHARS} 个字符"
        )));
    }
    if fields.intro.chars().count() > INTRO_MAX_CHARS {
        return Err(HostError::Library(format!(
            "一句话介绍不超过 {INTRO_MAX_CHARS} 字"
        )));
    }
    if fields.tags.len() > TAGS_MAX
        || fields
            .tags
            .iter()
            .any(|t| t.trim().is_empty() || t.chars().count() > TAG_MAX_CHARS)
    {
        return Err(HostError::Library(format!(
            "标签最多 {TAGS_MAX} 个，每个 1–{TAG_MAX_CHARS} 字"
        )));
    }
    if let Some(look) = &fields.appearance.look {
        look.check().map_err(HostError::Library)?;
    }
    let persona = render_persona(fields);
    if persona.chars().count() > PERSONA_MAX_CHARS {
        return Err(HostError::Library(format!(
            "人设合计不超过 {PERSONA_MAX_CHARS} 字"
        )));
    }
    crate::config::check_no_secret(&persona)
}

/// 由字段生成人设 markdown。背景标为入村前的自述设定，不写成小镇里发生过的事。
pub fn render_persona(f: &TemplateFields) -> String {
    let name = f.name.trim();
    let mut out = format!("# {name}\n姓名：{name}\n");
    for (label, value) in [("性别", &f.gender), ("年龄", &f.age)] {
        if !value.trim().is_empty() {
            out.push_str(&format!("{label}：{}\n", value.trim()));
        }
    }
    if !f.intro.trim().is_empty() {
        out.push_str(&format!("一句话介绍：{}\n", f.intro.trim()));
    }
    let tags: Vec<&str> = f
        .tags
        .iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect();
    if !tags.is_empty() || !f.personality.trim().is_empty() {
        out.push_str("\n性格：");
        if !tags.is_empty() {
            out.push_str(&tags.join("、"));
        }
        if !f.personality.trim().is_empty() {
            if !tags.is_empty() {
                out.push('；');
            }
            out.push_str(f.personality.trim());
        }
        out.push('\n');
    }
    if !f.speech.trim().is_empty() {
        out.push_str(&format!("说话方式：{}\n", f.speech.trim()));
    }
    if !f.background.trim().is_empty() {
        out.push_str(&format!(
            concat!(
                "\n## 背景\n{}\n\n以上是来到小镇之前的自述设定，不是小镇里发生过的事。",
                "这是本人来到小镇的第一天，具体日期以入村记录为准。\n"
            ),
            f.background.trim()
        ));
    }
    if !f.drives.trim().is_empty() || !f.interests.trim().is_empty() {
        out.push_str("\n## 驱动力与兴趣\n");
        if !f.drives.trim().is_empty() {
            out.push_str(&format!("驱动力：{}\n", f.drives.trim()));
        }
        if !f.interests.trim().is_empty() {
            out.push_str(&format!("兴趣与生活偏好：{}\n", f.interests.trim()));
        }
    }
    if !f.occupation.trim().is_empty() {
        out.push_str(&format!(
            "\n## 职业背景\n{}\n这只是背景，不自动拥有资源、职位、收入或专属权限。\n",
            f.occupation.trim()
        ));
    }
    out
}

const MARKERS: [&str; 7] = ["dot", "tree", "leaf", "book", "hammer", "bowl", "wave"];
const COLORS: [&str; 7] = [
    "#b4691e", "#2f7a57", "#b8a02e", "#327975", "#6a675a", "#c77a2a", "#3d4650",
];

/// 模型生成的字段按村民库的规则收拾：介绍与标签截到上限，地图标记按姓名固定选，
/// 模型挑的长相保留，再整体校验。
pub fn tidy_generated(mut fields: TemplateFields) -> Result<TemplateFields, HostError> {
    fields.intro = fields.intro.chars().take(INTRO_MAX_CHARS).collect();
    fields.tags = fields
        .tags
        .into_iter()
        .take(TAGS_MAX)
        .map(|t| t.chars().take(TAG_MAX_CHARS).collect())
        .collect();
    fields.appearance = Appearance {
        look: fields.appearance.look.take(),
        ..appearance_for(&fields.name)
    };
    validate_fields(&fields)?;
    Ok(fields)
}

/// 固定回复模式下的生成结果：不调用模型，只把描述整理成可保存的字段，供离线检查。
pub fn mock_generated(brief: &str, taken_names: &[String]) -> Result<TemplateFields, HostError> {
    let mut name = String::from("新村民");
    let mut n = 1;
    while taken_names.iter().any(|t| t == &name) {
        n += 1;
        name = format!("新村民{n}");
    }
    let fields = TemplateFields {
        // 离线也挑一套长相，捏人的界面不连模型也能检查
        appearance: Appearance {
            look: Some(agent::looks::look_from_choices(&json!({}), &name)),
            ..appearance_for(&name)
        },
        name,
        age: "30".into(),
        gender: String::new(),
        intro: brief.chars().take(INTRO_MAX_CHARS).collect(),
        tags: vec!["离线生成".into()],
        personality: format!("按描述行事：{brief}"),
        speech: "平和。".into(),
        background: "离线生成的占位背景，没有连接模型。".into(),
        drives: "过好每一天。".into(),
        interests: brief.to_string(),
        occupation: String::new(),
    };
    validate_fields(&fields)?;
    Ok(fields)
}

fn appearance_for(name: &str) -> Appearance {
    let hash = name
        .bytes()
        .fold(7usize, |h, b| h.wrapping_mul(31).wrapping_add(b as usize));
    Appearance {
        marker: MARKERS[hash % MARKERS.len()].into(),
        color: COLORS[(hash / 7) % COLORS.len()].into(),
        profile: None,
        look: None,
    }
}
