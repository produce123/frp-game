//! 「用模型生成」人物时顺手捏好长相：提示词里列出可选的发型、衣服和颜色，回复里的选择逐项对上，
//! 没给或对不上的项按姓名固定挑一个。可选项与网页捏人界面的色板一致
//! （frontend/town-shared/src/residents/look.ts），模型挑的颜色在界面上能对上色块。
use protocol::{BeardStyle, FaceGear, HairStyle, Headwear, HeldItem, Outfit, VillagerLook};
use serde_json::{json, Value};

/// 发型：编号、中文名；后面标了「随机」的是没给发型时按姓名挑的范围（男女都合适）
const HAIRS: [(&str, &str, bool); 18] = [
    ("short", "短发", true),
    ("spiky", "刺头", true),
    ("split", "中分短发", true),
    ("crop", "寸头", true),
    ("bob", "齐耳短发", true),
    ("long", "长发", false),
    ("parted", "中分长发", true),
    ("bun", "丸子头", false),
    ("ponytail", "马尾", true),
    ("twintail", "双马尾", false),
    ("afro", "爆炸头", false),
    ("mohawk", "莫西干", false),
    ("bald", "光头", false),
    ("twin_buns", "双髻（哪吒头）", false),
    ("curls", "螺发和肉髻（佛陀）", false),
    (
        "scallion",
        "大葱头（头发像一把葱往上竖，额头露出来）",
        false,
    ),
    (
        "m_bangs",
        "M 刘海齐耳短发（刘海从中间分开，下沿是锯齿）",
        false,
    ),
    ("m_long", "M 刘海长发（垂到腰，耳边往外翘）", false),
];
const OUTFITS: [(&str, &str, bool); 21] = [
    ("jacket", "夹克长裤", true),
    ("coat", "长大衣", true),
    ("suit", "西装领带", true),
    ("overalls", "背带裤", true),
    ("tee", "短袖短裤", true),
    ("hoodie", "卫衣", true),
    ("cardigan", "开衫短裙", false),
    ("dress", "连衣裙", false),
    ("apron", "衬衫配围裙", true),
    ("book", "长裙抱着书", false),
    ("bikini", "比基尼泳装（海边、游泳）", false),
    ("swim_trunks", "男式泳裤，光着上身（海边、游泳）", false),
    ("robe", "长袍", false),
    ("clown", "小丑服", false),
    ("space", "宇航服", false),
    ("armor", "盔甲", false),
    ("skeleton", "骷髅服", false),
    ("tiger_skirt", "虎皮裙配披风（孙悟空）", false),
    ("bellyband", "红肚兜、乾坤圈和混天绫（哪吒）", false),
    ("kasaya", "袈裟", false),
    ("general", "将军铠甲带护心镜和披风（三国武将）", false),
];
/// 头上戴的：straw 是草帽（另一个开关），其余对应 Headwear
const HEADWEARS: [(&str, &str, bool); 17] = [
    ("straw", "草帽", false),
    ("top_hat", "礼帽", false),
    ("wizard_hat", "巫师帽", false),
    ("chef_hat", "厨师帽", false),
    ("crown", "王冠", false),
    ("halo", "光环", false),
    ("cat_ears", "猫耳", false),
    ("bunny_ears", "兔耳", false),
    ("horns", "恶魔角", false),
    ("antennae", "触角", false),
    ("circlet", "金色紧箍（只有孙悟空戴）", false),
    ("pig_ears", "猪耳朵（猪八戒）", false),
    ("aureole", "头后的佛光（佛、菩萨）", false),
    ("scholar_cap", "纶巾，点缀色（诸葛亮、关羽等文士）", false),
    ("topknot_crown", "束发金冠（周瑜、赵云等年轻将领）", false),
    ("feather_crown", "插雉鸡翎的紫金冠（吕布）", false),
    ("official_hat", "带帽翅的黑官帽（曹操、刘备、文官）", false),
];
/// 胡子：full 是络腮胡（另一个开关），其余对应 BeardStyle
const BEARD_STYLES: [(&str, &str, bool); 4] = [
    ("full", "络腮胡", false),
    ("long", "三绺长须（关羽、诸葛亮、刘备）", false),
    ("bushy", "又粗又密的虬髯（张飞）", false),
    ("goatee", "八字胡加山羊胡（曹操）", false),
];
const HELD_ITEMS: [(&str, &str, bool); 7] = [
    ("fan", "羽扇（诸葛亮）", false),
    ("guandao", "青龙偃月刀（关羽）", false),
    ("snake_spear", "丈八蛇矛（张飞）", false),
    ("spear", "长枪（赵云）", false),
    ("halberd", "方天画戟（吕布）", false),
    ("golden_staff", "金箍棒（孙悟空）", false),
    ("rake", "九齿钉耙（猪八戒）", false),
];
const FACES: [(&str, &str, bool); 7] = [
    ("glasses", "眼镜", false),
    ("sunglasses", "墨镜", false),
    ("eye_patch", "眼罩", false),
    ("clown_nose", "小丑红鼻子", false),
    ("monkey_face", "猴脸和猴耳朵（孙悟空等猴子）", false),
    ("pig_snout", "猪鼻子（猪八戒）", false),
    ("forehead_dot", "眉心一点红（哪吒、佛、菩萨）", false),
];
type Palette = [(&'static str, &'static str)];
const HAIR_COLORS: &Palette = &[
    ("#2a2626", "黑"),
    ("#3e3a4c", "紫黑"),
    ("#5a3626", "深棕"),
    ("#7a4a2e", "栗色"),
    ("#9a5e34", "棕"),
    ("#c89060", "浅棕"),
    ("#d8a040", "金"),
    ("#c0bab0", "灰白"),
    ("#eeece6", "雪白"),
    ("#c8463a", "红"),
    ("#e890b0", "粉"),
    ("#4a7ad8", "蓝"),
    ("#4aa86a", "绿"),
    ("#8a5ac8", "紫"),
];
const EYE_COLORS: &Palette = &[
    ("#4c77da", "蓝"),
    ("#c07a30", "琥珀"),
    ("#4c9a6a", "绿"),
    ("#8a70b0", "紫"),
    ("#6a4a2a", "棕"),
    ("#e0c050", "金"),
    ("#d83a3a", "红"),
];
const SKINS: &Palette = &[
    ("#f6ece0", "白皙"),
    ("#ecd4bc", "小麦"),
    ("#d9a77c", "健康"),
    ("#a8714d", "深色"),
    ("#fbfaf6", "雪白"),
    ("#9fd68a", "绿"),
    ("#9cc4ec", "蓝"),
    ("#c4a8e0", "紫"),
    ("#b4b8bc", "灰"),
    ("#f2bfb2", "粉"),
    ("#e6c068", "金"),
    ("#c0503e", "枣红"),
    ("#8a6250", "黝黑"),
];
const TOPS: &Palette = &[
    ("#3c4a7a", "藏青"),
    ("#58b078", "草绿"),
    ("#52b8aa", "青绿"),
    ("#d8883a", "橙"),
    ("#c88a8e", "粉"),
    ("#8a70b0", "紫"),
    ("#b07a5a", "棕"),
    ("#86826e", "灰绿"),
    ("#e8c070", "鹅黄"),
    ("#f4f6f4", "白"),
    ("#d84a3a", "红"),
    ("#2e2e36", "黑"),
    ("#aab2ba", "银灰"),
];
const BOTTOMS: &Palette = &[
    ("#4a4a50", "深灰"),
    ("#3c4a7a", "藏青"),
    ("#5a4a3a", "棕"),
    ("#6a5a40", "土黄"),
    ("#3a3a44", "黑"),
    ("#7a8a7c", "灰绿"),
    ("#e8e6e0", "白"),
    ("#b8403a", "红"),
    ("#d0a848", "黄"),
];
const ACCENTS: &Palette = &[
    ("#e44a4e", "红"),
    ("#e8c070", "黄"),
    ("#58b078", "绿"),
    ("#4c77da", "蓝"),
    ("#8a70b0", "紫"),
    ("#f4f6f4", "白"),
    ("#2e2e36", "黑"),
];
const APRONS: &Palette = &[
    ("#ece4d2", "米白"),
    ("#58b078", "绿"),
    ("#d8883a", "橙"),
    ("#7aa09a", "灰青"),
    ("#c8a868", "卡其"),
    ("#8a6a48", "棕"),
    ("#aaa2b6", "灰紫"),
];
const ACCESSORIES: [(&str, &str); 3] = [
    ("clip", "戴发卡"),
    ("headband", "戴头巾"),
    ("ahoge", "头顶一撮呆毛"),
];

fn options(items: &[(&str, &str, bool)]) -> String {
    items
        .iter()
        .map(|(key, name, _)| format!("{key} {name}"))
        .collect::<Vec<_>>()
        .join("、")
}

fn colors(palette: &Palette) -> String {
    palette
        .iter()
        .map(|(hex, name)| format!("{hex} {name}"))
        .collect::<Vec<_>>()
        .join("、")
}

/// 提示词里 look 字段的写法：每项列出可选值，模型照人物的年龄、职业和气质挑。
pub fn look_prompt() -> String {
    let flags = ACCESSORIES
        .iter()
        .map(|(key, label)| format!("\"{key}\":\"{label}就写 true，否则 false\""))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"hair\":\"发型，从这些编号里选一个：{}\",\
\"outfit\":\"衣服，从这些编号里选一个：{}\",\
\"hair_color\":\"发色，选一个：{}\",\
\"hair_tip\":\"渐变发的发梢颜色，不渐变就写 none，否则选一个：{}\",\"eye_color\":\"眼睛颜色，选一个：{}\",\
\"skin\":\"肤色，选一个：{}\",\"top\":\"上衣颜色，选一个：{}\",\
\"bottom\":\"裤子或裙子颜色，选一个：{}\",\"accent\":\"点缀色（领巾、领带、发饰、绒球、角和触角），选一个：{}\",\
\"apron\":\"衣服选 apron 时的围裙颜色，选一个：{}\",\
\"headwear\":\"头上戴的，没有就写 none，否则选一个：{}\",\
\"face\":\"脸上戴的，没有就写 none，否则选一个：{}\",\
\"beard\":\"胡子，没有就写 none，否则选一个：{}\",\
\"held\":\"手里拿的，没有就写 none，否则选一个：{}\",{flags}}}",
        options(&HAIRS),
        options(&OUTFITS),
        colors(HAIR_COLORS),
        colors(HAIR_COLORS),
        colors(EYE_COLORS),
        colors(SKINS),
        colors(TOPS),
        colors(BOTTOMS),
        colors(ACCENTS),
        colors(APRONS),
        options(&HEADWEARS),
        options(&FACES),
        options(&BEARD_STYLES),
        options(&HELD_ITEMS),
    )
}

/// 按姓名定下来的挑选序列：同名同长相
struct Picker(u64);

impl Picker {
    fn new(seed: &str) -> Self {
        Self(seed.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
        }))
    }
    fn index(&mut self, n: usize) -> usize {
        let i = (self.0 % n as u64) as usize;
        self.0 = self.0 / n as u64 + 7919;
        i
    }
}

/// 选项编号或中文名对上的那一项；中文名只写了括号前那半截（「大葱头」）也算
fn chosen<'a>(value: &Value, items: &'a [(&'a str, &'a str, bool)]) -> Option<&'a str> {
    let text = value.as_str()?.trim();
    items
        .iter()
        .find(|(key, name, _)| {
            key.eq_ignore_ascii_case(text) || *name == text || name.split('（').next() == Some(text)
        })
        .map(|(key, _, _)| *key)
}

/// 色板里的颜色：写的是色板里的值或名字就用它；别的合法颜色取色板里最接近的
fn chosen_color(value: &Value, palette: &Palette) -> Option<&'static str> {
    let text = value.as_str()?.trim();
    if let Some((hex, _)) = palette
        .iter()
        .find(|(hex, name)| hex.eq_ignore_ascii_case(text) || *name == text)
    {
        return Some(hex);
    }
    let rgb = parse_rgb(text)?;
    palette
        .iter()
        .min_by_key(|(hex, _)| {
            let other = parse_rgb(hex).unwrap_or_default();
            rgb.iter()
                .zip(other)
                .map(|(a, b)| (i32::from(*a) - i32::from(b)).pow(2))
                .sum::<i32>()
        })
        .map(|(hex, _)| *hex)
}

fn parse_rgb(text: &str) -> Option<[u8; 3]> {
    if !protocol::is_hex_color(text) {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(&text[i..i + 2], 16).ok();
    Some([channel(1)?, channel(3)?, channel(5)?])
}

/// 模型回复里的 look（或任何 JSON 对象）整理成一套长相；缺的、对不上的项按 `seed`（姓名）挑。
pub fn look_from_choices(choices: &Value, seed: &str) -> VillagerLook {
    let mut pick = Picker::new(seed);
    let mut either = |value: &Value, items: &'static [(&'static str, &'static str, bool)]| {
        chosen(value, items).unwrap_or_else(|| {
            let usual: Vec<&str> = items.iter().filter(|i| i.2).map(|i| i.0).collect();
            usual[pick.index(usual.len())]
        })
    };
    let hair = either(&choices["hair"], &HAIRS);
    let outfit = either(&choices["outfit"], &OUTFITS);
    let mut color = |key: &str, palette: &'static Palette| -> String {
        chosen_color(&choices[key], palette)
            .unwrap_or_else(|| palette[pick.index(palette.len())].0)
            .to_string()
    };
    let hair_color = color("hair_color", HAIR_COLORS);
    // 渐变发：写了色板里的颜色、又和发色不一样才算；none 或没写就不渐变
    let hair_tip = chosen_color(&choices["hair_tip"], HAIR_COLORS)
        .filter(|tip| *tip != hair_color)
        .map(String::from);
    let eye_color = color("eye_color", EYE_COLORS);
    // 肤色没给时用第一种，不随机
    let skin = chosen_color(&choices["skin"], SKINS)
        .unwrap_or(SKINS[0].0)
        .to_string();
    let top = color("top", TOPS);
    let bottom = color("bottom", BOTTOMS);
    let accent = color("accent", ACCENTS);
    let apron =
        (outfit == "apron").then(|| chosen_color(&choices["apron"], APRONS).unwrap_or(APRONS[0].0));
    let flag = |key: &str| choices[key].as_bool().unwrap_or(false);
    // 草帽是单独的开关；旧写法的 "hat": true 也认
    let headwear = chosen(&choices["headwear"], &HEADWEARS);
    let hat = headwear == Some("straw") || (headwear.is_none() && flag("hat"));
    let headwear = headwear
        .filter(|key| *key != "straw")
        .and_then(|key| serde_json::from_value::<Headwear>(json!(key)).ok());
    let face = chosen(&choices["face"], &FACES)
        .and_then(|key| serde_json::from_value::<FaceGear>(json!(key)).ok());
    // 络腮胡是单独的开关；旧写法的 "beard": true 也认
    let beard_style = chosen(&choices["beard"], &BEARD_STYLES);
    let beard = beard_style == Some("full") || (beard_style.is_none() && flag("beard"));
    let beard_style = beard_style
        .filter(|key| *key != "full")
        .and_then(|key| serde_json::from_value::<BeardStyle>(json!(key)).ok());
    let held = chosen(&choices["held"], &HELD_ITEMS)
        .and_then(|key| serde_json::from_value::<HeldItem>(json!(key)).ok());
    VillagerLook {
        hair: serde_json::from_value::<HairStyle>(json!(hair)).unwrap_or(HairStyle::Short),
        outfit: serde_json::from_value::<Outfit>(json!(outfit)).unwrap_or(Outfit::Jacket),
        hair_color,
        hair_tip,
        eye_color,
        skin,
        top,
        bottom,
        headband: flag("headband").then(|| accent.clone()),
        accent,
        collar: None,
        apron: apron.map(String::from),
        belt: None,
        ornament: None,
        hat,
        ahoge: flag("ahoge"),
        clip: flag("clip"),
        beard,
        headwear,
        face,
        beard_style,
        held,
        pattern: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 模型写的编号、中文名、色板外的颜色都能对上；对不上的项按姓名挑，结果总是合格的长相
    #[test]
    fn model_choices_map_onto_the_palette() {
        let look = look_from_choices(
            &json!({"hair":"马尾","outfit":"apron","hair_color":"#2B2727","eye_color":"绿",
                "top":"#ffffff","bottom":"彩虹色","accent":"#e44a4e","apron":"橙","beard":true,
                "headband":true,"headwear":"猫耳","face":"sunglasses"}),
            "阿树",
        );
        assert_eq!(look.hair, HairStyle::Ponytail);
        assert_eq!(look.outfit, Outfit::Apron);
        assert_eq!(look.hair_color, "#2a2626", "取色板里最接近的");
        assert_eq!(look.eye_color, "#4c9a6a");
        assert_eq!(look.top, "#f4f6f4");
        assert!(BOTTOMS.iter().any(|(hex, _)| *hex == look.bottom));
        assert_eq!(look.apron.as_deref(), Some("#d8883a"));
        assert_eq!(look.headband.as_deref(), Some("#e44a4e"), "头巾用点缀色");
        assert!(look.beard && !look.hat);
        assert_eq!(look.headwear, Some(Headwear::CatEars));
        assert_eq!(look.face, Some(FaceGear::Sunglasses));
        look.check().unwrap();
        let straw = look_from_choices(&json!({"headwear":"straw","face":"none"}), "阿树");
        assert!(
            straw.hat && straw.headwear.is_none() && straw.face.is_none(),
            "草帽走单独的开关"
        );
        straw.check().unwrap();
        let general =
            look_from_choices(&json!({"beard":"bushy","held":"丈八蛇矛（张飞）"}), "翼德");
        assert!(!general.beard, "络腮胡以外的胡子走 beard_style");
        assert_eq!(general.beard_style, Some(BeardStyle::Bushy));
        assert_eq!(general.held, Some(HeldItem::SnakeSpear));
        general.check().unwrap();
        let tipped = look_from_choices(
            &json!({"hair":"大葱头","hair_color":"雪白","hair_tip":"绿"}),
            "阿葱",
        );
        assert_eq!(tipped.hair, HairStyle::Scallion);
        assert_eq!(
            tipped.hair_tip.as_deref(),
            Some("#4aa86a"),
            "发梢色也对上色板"
        );
        assert!(look.hair_tip.is_none(), "没写发梢色就不渐变");
        tipped.check().unwrap();
        let empty = look_from_choices(&json!({}), "阿树");
        assert_eq!(empty, look_from_choices(&json!({"hair":"猫耳"}), "阿树"));
        assert_eq!(empty.skin, "#f6ece0");
        empty.check().unwrap();
    }
}
