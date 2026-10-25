//! 与传输无关的会话消息。原生工具和 JSON 兼容端点都转换为这一种协议。
pub use crate::completion::ModelError;
use serde::{de, Deserialize, Serialize};

/// 一次回复的自述字数、工具调用个数与单个调用参数的字节上限。
pub(crate) const THOUGHT_MAX_CHARS: usize = 4000;
const CALLS_MAX: usize = 8;
const ARGUMENTS_MAX_BYTES: usize = 16_000;
use serde_json::{json, Value};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
    #[serde(default)]
    pub calls: Vec<ToolCall>,
    pub call_id: Option<String>,
}

impl Message {
    pub fn text(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            calls: vec![],
            call_id: None,
        }
    }
    pub fn result(id: &str, value: Value) -> Self {
        Self {
            role: Role::Tool,
            content: value.to_string(),
            calls: vec![],
            call_id: Some(id.into()),
        }
    }
    pub fn wire(&self) -> Value {
        let mut value = json!({"role":self.role,"content":self.content});
        if !self.calls.is_empty() {
            value["tool_calls"] = Value::Array(self.calls.iter().map(|call| json!({
                "id":call.id,"type":"function","function":{"name":call.name,"arguments":call.arguments.to_string()}
            })).collect());
        }
        if let Some(id) = &self.call_id {
            value["tool_call_id"] = json!(id);
        }
        value
    }
}

/// 服务商返回的真实计量。DeepSeek 的 prompt_tokens 等于命中加未命中；缺字段记 0。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_hit_tokens: u64,
    #[serde(default)]
    pub cache_miss_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelReply {
    pub thought: String,
    pub calls: Vec<ToolCall>,
    pub usage: Option<Usage>,
}

impl ModelReply {
    pub fn from_chat_completion(value: &Value) -> Result<Self, ModelError> {
        let bad = |message: &str| ModelError::Reply(message.into());
        let message = value
            .pointer("/choices/0/message")
            .ok_or_else(|| bad("响应缺少 assistant 消息"))?;
        let thought = message["content"].as_str().unwrap_or_default().to_string();
        let mut calls = Vec::new();
        if let Some(items) = message["tool_calls"].as_array() {
            for item in items {
                if item["type"].as_str() != Some("function") {
                    return Err(bad("不支持的工具调用类型"));
                }
                let function = &item["function"];
                let arguments = function["arguments"]
                    .as_str()
                    .ok_or_else(|| bad("工具参数不是 JSON 字符串"))?;
                calls.push(ToolCall {
                    id: item["id"]
                        .as_str()
                        .ok_or_else(|| bad("工具调用缺少 id"))?
                        .into(),
                    name: function["name"]
                        .as_str()
                        .ok_or_else(|| bad("工具调用缺少名称"))?
                        .into(),
                    arguments: serde_json::from_str(arguments)
                        .map_err(|e| ModelError::Reply(format!("工具参数 JSON 无效：{e}")))?,
                });
            }
        }
        let usage = Usage::from_chat_completion(value);
        let result = Self {
            thought,
            calls,
            usage,
        };
        result.validate()?;
        Ok(result)
    }

    pub fn validate(&self) -> Result<(), ModelError> {
        if self.thought.chars().count() > THOUGHT_MAX_CHARS || self.calls.len() > CALLS_MAX {
            return Err(ModelError::Reply("模型回复超过长度或工具数量上限".into()));
        }
        let mut ids = BTreeSet::new();
        for call in &self.calls {
            if call.id.is_empty()
                || call.id.len() > 96
                || !ids.insert(&call.id)
                || call.name.len() > 64
                || !call.arguments.is_object()
                || call.arguments.to_string().len() > ARGUMENTS_MAX_BYTES
            {
                return Err(ModelError::Reply(
                    "工具编号重复、参数类型错误或调用过长".into(),
                ));
            }
        }
        Ok(())
    }
}

/// 请求正文字节数，每条消息另加 8 字节角色开销；配合校准系数换算成 token。
pub fn wire_bytes(messages: &[Message]) -> u64 {
    messages
        .iter()
        .map(|m| m.wire().to_string().len() as u64 + 8)
        .sum()
}

/// 请求前的估算；服务商返回 usage 后以真实计量结算，并据此校准系数。
pub fn estimate_tokens(bytes: u64, bytes_per_token: f64) -> u64 {
    (bytes as f64 / bytes_per_token).ceil() as u64
}

impl Usage {
    pub fn from_chat_completion(value: &Value) -> Option<Self> {
        let usage = value.get("usage")?;
        Some(Self {
            input_tokens: usage["prompt_tokens"].as_u64()?,
            output_tokens: usage["completion_tokens"].as_u64()?,
            cache_hit_tokens: usage["prompt_cache_hit_tokens"].as_u64().unwrap_or(0),
            cache_miss_tokens: usage["prompt_cache_miss_tokens"].as_u64().unwrap_or(0),
        })
    }
    pub fn total(&self) -> u64 {
        self.input_tokens.saturating_add(self.output_tokens)
    }
}

// 新增的 JSON 兼容入口共用；原生工具解析保持不变。直接解析为 Value 会静默保留重复键的最后一个值，
// 例如两个 locale 会改变模型动作；递归检查对象键后才允许进入既有协议解析。
pub(crate) struct UniqueJson(pub(crate) Value);

impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D: de::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> de::Visitor<'de> for JsonVisitor {
            type Value = UniqueJson;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("不包含重复字段的 JSON")
            }

            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson(value.into()))
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson(value.into()))
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson(value.into()))
            }

            fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
                Ok(UniqueJson(value.into()))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson(value.into()))
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Null))
            }

            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(UniqueJson(value)) = seq.next_element()? {
                    values.push(value);
                }
                Ok(UniqueJson(Value::Array(values)))
            }

            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom(format!("重复字段 {key}")));
                    }
                    let UniqueJson(value) = map.next_value()?;
                    values.insert(key, value);
                }
                Ok(UniqueJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}
