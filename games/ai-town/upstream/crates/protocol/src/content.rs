use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContentCommand {
    Detail {
        id: String,
    },
    Create {
        id: String,
        locale: String,
        title: String,
        author: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        board: Option<String>,
    },
    Revise {
        id: String,
        expected_version: u32,
        title: String,
        author: String,
        text: String,
    },
    Withdraw {
        id: String,
        expected_version: u32,
    },
}

/// 作品种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentKind {
    Book,
    Bulletin,
}

/// 作品来源：内置、玩家写的，或者哪位居民写的。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ContentOrigin {
    Builtin,
    Player,
    Resident { actor: String },
}

/// 一个作品版本的正文与署名（作品详情、化身在读的内容）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContentText {
    pub author: String,
    pub kind: ContentKind,
    #[serde(serialize_with = "crate::sorted")]
    pub origin: ContentOrigin,
    pub text: String,
    pub title: String,
    pub version: u32,
    pub work_id: String,
}

/// 作品版本的元数据：不含正文，带正文摘要（fingerprint）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContentMetadata {
    pub author: String,
    pub fingerprint: String,
    pub kind: ContentKind,
    #[serde(serialize_with = "crate::sorted")]
    pub origin: ContentOrigin,
    pub title: String,
    pub version: u32,
    pub work_id: String,
}

/// 书籍或公告的详情：当前版本正文与全部版本的元数据。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContentDetail {
    pub board: Option<String>,
    pub content: Option<ContentText>,
    pub id: String,
    pub locale: String,
    pub versions: Vec<ContentMetadata>,
    pub withdrawn: bool,
}
