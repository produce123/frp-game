//! 无字段枚举的 serde 线上名。展示文案在 protocol 各枚举的 `label()` 里。

use serde::Serialize;

/// 无字段枚举序列化出的字符串，例如 `FactKind::Notice` → `notice`。记忆索引存它，工具 schema 列它。
pub fn wire_name<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .expect("无字段枚举序列化为字符串")
}
