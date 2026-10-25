//! 人口与村民库的线上类型：模板、登记、加入命令的结构化结果。人设全文只按需查询，不进 roster。
use serde::{Deserialize, Serialize};

/// 外观只是地图上的区分标记和像素小人的长相，不承载任何规则。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Appearance {
    #[serde(default)]
    pub marker: String,
    #[serde(default)]
    pub color: String,
    /// 三维客户端的形象档案编号；为空时由客户端按姓名或加入顺序选择默认形象。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// 捏出来的像素小人；没有时客户端按模板编号挑长相（预制村民是固定长相，自定义的按编号随机）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub look: Option<VillagerLook>,
}

/// 捏人：发型、衣服、颜色、配饰和衣服上 4×4 的花纹。四个朝向和走路都由客户端现有的像素画法出，
/// 这里只存挑了什么。颜色都是 #rrggbb；领口、围裙、腰带、发饰、头巾的颜色缺省时客户端用默认色或点缀色。
/// 奇装异服、奇特发型、头饰和脸上的配件让小丑、外星人、巫师这类角色也捏得出来。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VillagerLook {
    pub hair: HairStyle,
    pub outfit: Outfit,
    pub hair_color: String,
    /// 发梢颜色：有这一项时头发从发根的 hair_color 渐变到它（大葱头这类往上长的发型，发梢在上面）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hair_tip: Option<String>,
    pub eye_color: String,
    pub skin: String,
    /// 上衣
    pub top: String,
    /// 裤子或裙子
    pub bottom: String,
    /// 点缀：领巾、发饰、头巾
    pub accent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apron: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub belt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ornament: Option<String>,
    /// 头巾的颜色；有这一项就戴头巾
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headband: Option<String>,
    /// 草帽；和 headwear 只能有一样
    #[serde(default, skip_serializing_if = "is_false")]
    pub hat: bool,
    /// 呆毛
    #[serde(default, skip_serializing_if = "is_false")]
    pub ahoge: bool,
    /// 发卡
    #[serde(default, skip_serializing_if = "is_false")]
    pub clip: bool,
    /// 络腮胡；和 beard_style 只能有一样
    #[serde(default, skip_serializing_if = "is_false")]
    pub beard: bool,
    /// 草帽以外头上戴的
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headwear: Option<Headwear>,
    /// 脸上戴的
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub face: Option<FaceGear>,
    /// 络腮胡以外的胡子
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub beard_style: Option<BeardStyle>,
    /// 手里拿的：羽扇或兵器
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held: Option<HeldItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<LookPattern>,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HairStyle {
    Short,
    Spiky,
    Split,
    Crop,
    Bob,
    Long,
    Parted,
    Bun,
    Ponytail,
    Twintail,
    Afro,
    Mohawk,
    Bald,
    TwinBuns,
    Curls,
    /// 大葱头：一把叶子似的头发往上竖，额头露出来，鬓边垂两缕
    Scallion,
    /// M 刘海：齐耳短发，刘海从中间分开，下沿是锯齿的 M
    MBangs,
    /// M 刘海长发：M 刘海配垂到腰的长直发，耳边往外翘
    MLong,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outfit {
    Jacket,
    Coat,
    Cardigan,
    Dress,
    Apron,
    Book,
    Suit,
    Overalls,
    Tee,
    Hoodie,
    Robe,
    Clown,
    Space,
    Armor,
    Skeleton,
    TigerSkirt,
    Bellyband,
    Kasaya,
    Bikini,
    SwimTrunks,
    General,
}

/// 头上戴的：耳朵、角、触角、光环、王冠、几种帽子，以及紧箍、猪耳朵、佛光（草帽另有开关）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Headwear {
    CatEars,
    BunnyEars,
    Horns,
    Antennae,
    Halo,
    Crown,
    TopHat,
    WizardHat,
    ChefHat,
    Circlet,
    PigEars,
    Aureole,
    ScholarCap,
    TopknotCrown,
    FeatherCrown,
    OfficialHat,
}

/// 脸上戴的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FaceGear {
    Glasses,
    Sunglasses,
    EyePatch,
    ClownNose,
    MonkeyFace,
    PigSnout,
    ForeheadDot,
}

/// 络腮胡以外的胡子：长须、虬髯、山羊胡。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BeardStyle {
    Long,
    Bushy,
    Goatee,
}

/// 手里拿的：羽扇和几样兵器。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeldItem {
    Fan,
    Guandao,
    SnakeSpear,
    Spear,
    Halberd,
    GoldenStaff,
    Rake,
}

/// 衣服上的花纹：4×4 小格平铺在上衣或下装上，跟着衣服走。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LookPattern {
    pub on: PatternTarget,
    pub color: String,
    /// 4 行，每行 4 个字符：# 是花纹色，. 露出衣服原色
    pub rows: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatternTarget {
    Top,
    Bottom,
}

/// 花纹的边长
pub const PATTERN_SIZE: usize = 4;

/// 颜色写成 #rrggbb
pub fn is_hex_color(text: &str) -> bool {
    text.len() == 7 && text.starts_with('#') && text[1..].chars().all(|c| c.is_ascii_hexdigit())
}

impl VillagerLook {
    /// 颜色都是 #rrggbb，花纹正好 4×4、只用 # 和 .，草帽和别的头饰只戴一样，胡子只留一种；不合格时说明哪一项。
    pub fn check(&self) -> Result<(), String> {
        if self.hat && self.headwear.is_some() {
            return Err("草帽和别的头饰只能戴一样".into());
        }
        if self.beard && self.beard_style.is_some() {
            return Err("胡子只能留一种".into());
        }
        let colors = [
            ("发色", Some(&self.hair_color)),
            ("发梢颜色", self.hair_tip.as_ref()),
            ("眼睛颜色", Some(&self.eye_color)),
            ("肤色", Some(&self.skin)),
            ("上衣颜色", Some(&self.top)),
            ("下装颜色", Some(&self.bottom)),
            ("点缀颜色", Some(&self.accent)),
            ("领口颜色", self.collar.as_ref()),
            ("围裙颜色", self.apron.as_ref()),
            ("腰带颜色", self.belt.as_ref()),
            ("发饰颜色", self.ornament.as_ref()),
            ("头巾颜色", self.headband.as_ref()),
            ("花纹颜色", self.pattern.as_ref().map(|p| &p.color)),
        ];
        for (label, color) in colors {
            if let Some(color) = color.filter(|c| !is_hex_color(c)) {
                return Err(format!("{label}「{color}」不是 #rrggbb 格式"));
            }
        }
        if let Some(pattern) = &self.pattern {
            let square = pattern.rows.len() == PATTERN_SIZE
                && pattern.rows.iter().all(|row| {
                    row.chars().count() == PATTERN_SIZE && row.chars().all(|c| c == '#' || c == '.')
                });
            if !square {
                return Err(format!(
                    "花纹须为 {PATTERN_SIZE} 行、每行 {PATTERN_SIZE} 个 # 或 ."
                ));
            }
        }
        Ok(())
    }
}

/// 村民模板的可编辑字段（§4.2）。都是文字倾向，不产生资源、职位或权限。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TemplateFields {
    pub name: String,
    #[serde(default)]
    pub age: String,
    #[serde(default)]
    pub gender: String,
    #[serde(default)]
    pub intro: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub personality: String,
    #[serde(default)]
    pub speech: String,
    #[serde(default)]
    pub background: String,
    #[serde(default)]
    pub drives: String,
    #[serde(default)]
    pub interests: String,
    #[serde(default)]
    pub occupation: String,
    #[serde(default)]
    pub appearance: Appearance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResidentTemplate {
    pub template_id: String,
    pub version: u64,
    pub builtin: bool,
    #[serde(default)]
    pub archived: bool,
    pub fields: TemplateFields,
}

/// 模板在当前世界里的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TemplateStatus {
    /// 可加入
    Available,
    /// 已在村中
    Joined,
    /// 已归档
    Archived,
}

/// 村民库筛选：全部 / 预制 / 自定义。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LibraryKind {
    #[default]
    All,
    Builtin,
    Custom,
}

/// 村民库卡片：浏览用的摘要，附当前世界里的状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateCard {
    pub template_id: String,
    pub version: u64,
    pub builtin: bool,
    pub archived: bool,
    pub name: String,
    pub intro: String,
    pub tags: Vec<String>,
    pub appearance: Appearance,
    pub status: TemplateStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resident_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LibraryFilter {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub kind: LibraryKind,
    #[serde(default)]
    pub include_archived: bool,
}

/// 当前世界里的一位居民的登记（不含人设全文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResidentRegistration {
    pub id: String,
    pub name: String,
    pub home: Option<String>,
    pub home_name: String,
    /// None 表示原有居民，入村时间未知。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joined_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joined_clock: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_version: Option<u64>,
    #[serde(default)]
    pub appearance: Appearance,
    /// 这位村民用的模型；还没选时不写。页面据此分清「没选模型」和「选了但服务还没连上」
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<crate::ModelChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HomeView {
    pub locale: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occupant: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PopulationView {
    pub world_id: String,
    pub revision: u64,
    pub residents: Vec<ResidentRegistration>,
    pub homes: Vec<HomeView>,
    /// 固定入口地点名；None 表示加入时从有效地点随机选择，缺省不阻止加入
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinPreview {
    pub ok: bool,
    pub problems: Vec<String>,
    pub template_id: String,
    pub template_version: u64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_name: Option<String>,
    pub entry_name: String,
    pub clock: String,
    pub persona_chars: usize,
    pub free_homes: Vec<HomeView>,
}

/// 一次加入操作的结果；同一操作编号重复到达返回同一份。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinOutcome {
    pub op_id: String,
    pub ok: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resident_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joined_at: Option<f64>,
    pub revision: u64,
}
