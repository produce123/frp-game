//! 本地模型偶尔多编码一层 JSON 或漏掉 actions 包装；只调整无歧义的结构，
//! 不补齐破损 JSON、不猜地点/动词，也不丢弃未知字段。之后仍走协议和世界校验。
use super::{Actions, ToolError, ToolErrorKind, INTENT_FIELDS, INVALID_ARGUMENTS};
use crate::conversation::UniqueJson;
use serde_json::{json, Value};

pub(super) fn decode(arguments: &Value) -> Result<Actions, ToolError> {
    normalize(arguments).and_then(|value| super::decode(&value)).map_err(|mut error| {
        error.message.push_str(
            "；格式：{\"actions\":[{\"intent\":{\"verb\":\"前往\",\"locale\":\"地点ID\"}}]}。actions 是数组，intent 是对象；地点ID 须替换为已知地点的真实 id。",
        );
        error
    })
}

fn normalize(arguments: &Value) -> Result<Value, ToolError> {
    let mut value = arguments.clone();
    if value.get("actions").is_none() && value.get("intent").is_some() {
        // 整个单项草案一起包装，prop_id 等字段不丢失，未知字段也仍会被拒绝。
        value = json!({"actions": [value]});
    }
    let Some(actions) = value.get_mut("actions") else {
        return Ok(value);
    };
    decode_json_string(actions, "actions")?;
    let Some(actions) = actions.as_array_mut() else {
        return Ok(value);
    };
    for action in actions {
        let Some(fields) = action.as_object_mut() else {
            continue;
        };
        let Some(intent) = fields.get_mut("intent") else {
            continue;
        };
        decode_json_string(intent, "intent")?;
        if !intent.is_object() {
            continue;
        }
        for field in INTENT_FIELDS {
            if !fields.contains_key(field) {
                continue;
            }
            // 两层同时写同一字段时不能选择其中一个；即使值相同也要求模型消除重复。
            if fields["intent"].get(field).is_some() {
                return Err(ToolError::new(
                    ToolErrorKind::InvalidArguments,
                    format!("{INVALID_ARGUMENTS}：{field} 在动作与 intent 中重复，请只保留 intent 内的一份"),
                ));
            }
            let misplaced = fields.remove(field).expect("字段已经检查存在");
            fields.get_mut("intent").expect("intent 已经检查存在")[field] = misplaced;
        }
    }
    Ok(value)
}

fn decode_json_string(value: &mut Value, field: &str) -> Result<(), ToolError> {
    if let Some(text) = value.as_str() {
        *value = serde_json::from_str::<UniqueJson>(text)
            .map_err(|error| {
                ToolError::new(
                    ToolErrorKind::InvalidArguments,
                    format!("{INVALID_ARGUMENTS}：{field} 内的 JSON 不完整或无效：{error}"),
                )
            })?
            .0;
    }
    Ok(())
}
