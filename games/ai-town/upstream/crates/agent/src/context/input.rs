//! 模型输入的有界视图。原文属于本人会话，分页读取不会再次执行产生它的工具。
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// 单份工具结果的 JSON 字节上限；不是模型 token 数。
pub const ITEM_BYTES: usize = 8_000;
pub const PAGE_CHARS: usize = 1_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InputState {
    /// 服务端明确拒收后收紧的输入额度；成功和重启均不擅自放宽。
    pub ceiling: Option<u64>,
    pub rejections: u32,
    pub next_source: u64,
    #[serde(default)]
    pub summary_source: Option<u64>,
    /// 不进入模型窗口。host 在检查点中拆成个人来源文件。
    pub sources: BTreeMap<u64, Value>,
}

impl InputState {
    pub fn source(&mut self, value: &Value) -> u64 {
        // 常见的长地图/人设/工具返回保持同一引用，避免每轮改变稳定前缀。
        if let Some((id, _)) = self.sources.iter().find(|(_, old)| *old == value) {
            return *id;
        }
        self.next_source += 1;
        self.sources.insert(self.next_source, value.clone());
        self.next_source
    }

    /// 字节限制只作用于模型视图；不会修改或丢弃原文。
    pub fn bound(&mut self, value: Value, bytes: usize) -> Value {
        if value.to_string().len() <= bytes {
            return value;
        }
        let source = self.source(&value);
        let text = value.to_string();
        let mut preview = String::new();
        // JSON 再次序列化会转义，按最终对象长度校验。
        let mut result =
            json!({"context_source":source,"truncated":true,"total_bytes":text.len(),"preview":""});
        for ch in text.chars() {
            preview.push(ch);
            if preview.len() >= bytes.saturating_sub(256) / 2 {
                break;
            }
        }
        result["preview"] = json!(preview);
        while result.to_string().len() > bytes && !preview.is_empty() {
            preview.pop();
            result["preview"] = json!(preview);
        }
        result
    }

    pub fn read(&self, query: ReadSource) -> Result<Value, String> {
        if query.limit == 0 || query.limit > PAGE_CHARS || query.pointer.len() > 512 {
            return Err("来源读取 limit 须为 1–1000 字符，pointer 最多 512 字节".into());
        }
        let value = self
            .sources
            .get(&query.source)
            .ok_or("本人没有这份上下文来源")?;
        let value = value
            .pointer(&query.pointer)
            .ok_or("来源中不存在这个 JSON pointer")?;
        let text = value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        let total = text.chars().count();
        if query.offset > total {
            return Err("来源读取 offset 超出原文长度".into());
        }
        let page: String = text.chars().skip(query.offset).take(query.limit).collect();
        let end = query.offset + page.chars().count();
        Ok(
            json!({"source":query.source,"pointer":query.pointer,"text":page,"offset":query.offset,"next_offset":(end < total).then_some(end),"total_chars":total}),
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadSource {
    pub source: u64,
    #[serde(default)]
    pub pointer: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "page_chars")]
    pub limit: usize,
}
fn page_chars() -> usize {
    PAGE_CHARS
}

/// 工具的成功/失败标签始终保留，长度限制只处理结果正文。
pub fn tool_result(state: &mut InputState, mut value: Value) -> Value {
    if value.to_string().len() > ITEM_BYTES {
        if let Some(result) = value.get_mut("result") {
            *result = state.bound(result.take(), ITEM_BYTES - 512);
        }
        if value.to_string().len() > ITEM_BYTES {
            let ok = value.get("ok").cloned();
            let details = state.bound(value, ITEM_BYTES - 64);
            return match ok {
                Some(ok) => json!({"ok":ok,"details":details}),
                None => details,
            };
        }
    }
    value
}
