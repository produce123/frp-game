//! 内置模型的题面与回复。内置模型是用村民的真实请求微调的小模型，题面必须和训练时一字不差：
//! 这里把 OpenAI 格式的请求按训练用的聊天模板（Qwen3.5 的 XML 工具调用格式，训练仓库的
//! template/town.jinja）渲染成题面，再把生成的文字解析回 OpenAI 格式的回复，后面照常走
//! `ModelReply::from_chat_completion`。
//!
//! 训练时模板由 Python 的 Jinja 渲染，所以对象一律照游戏发来的键序（serde_json 按字母序），
//! 非字符串的值按 `json.dumps` 的写法：分隔用 ", " 和 ": "，中文不转义，整数值的小数带 ".0"。
//! 改模板要两边一起改，并拿考卷题面逐字比对。
use crate::{completion::ModelError, conversation::Usage};
use serde_json::{json, Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

/// 有工具时系统段开头的工具说明，原样照抄模板。
const TOOLS_OPEN: &str =
    "<|im_start|>system\n# Tools\n\nYou have access to the following functions:\n\n<tools>";
const TOOLS_CLOSE: &str = "\n</tools>\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n<parameter=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter>\n</function>\n</tool_call>\n\n<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n- Required parameters MUST be specified\n- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n</IMPORTANT>";
/// 生成提示：不开思考，和每轮 assistant 一样带空思考块。
const GENERATION: &str = "<|im_start|>assistant\n<think>\n\n</think>\n\n";
/// 生成到这里停。
pub const STOP: &str = "<|im_end|>";

/// 请求（messages、tools）渲染成题面，末尾是生成提示。
pub fn prompt(body: &Value) -> Result<String, ModelError> {
    let bad = |message: &str| ModelError::NotSent(format!("内置模型的题面拼不出来：{message}"));
    let messages = body["messages"]
        .as_array()
        .filter(|m| !m.is_empty())
        .ok_or_else(|| bad("没有消息"))?;
    let role = |i: usize| messages[i]["role"].as_str().unwrap_or_default();
    let mut out = String::new();
    let system = (role(0) == "system").then(|| content(&messages[0]["content"]));
    match body["tools"].as_array().filter(|tools| !tools.is_empty()) {
        Some(tools) => {
            out += TOOLS_OPEN;
            for tool in tools {
                out.push('\n');
                py_json(tool, &mut out);
            }
            out += TOOLS_CLOSE;
            if let Some(text) = system.as_deref().filter(|t| !t.is_empty()) {
                out += "\n\n";
                out += text;
            }
            out += "<|im_end|>\n";
        }
        None => {
            if let Some(text) = &system {
                out += &format!("<|im_start|>system\n{text}<|im_end|>\n");
            }
        }
    }
    let query = messages.iter().any(|m| {
        let text = content(&m["content"]);
        m["role"] == "user"
            && !(text.starts_with("<tool_response>") && text.ends_with("</tool_response>"))
    });
    if !query {
        return Err(bad("没有用户消息"));
    }
    for (i, message) in messages.iter().enumerate() {
        let mut text = content(&message["content"]);
        match role(i) {
            "system" if i == 0 => {}
            "system" => return Err(bad("系统消息不在开头")),
            "user" => out += &format!("<|im_start|>user\n{text}<|im_end|>\n"),
            "assistant" => {
                let mut reasoning = message["reasoning_content"].as_str().map(str::to_owned);
                if reasoning.is_none() && text.contains("</think>") {
                    let before = text.split("</think>").next().unwrap_or_default();
                    let thinking = before.trim_end_matches('\n').rsplit("<think>").next();
                    reasoning = thinking.map(|t| t.trim_start_matches('\n').to_owned());
                    let after = text.rsplit("</think>").next().unwrap_or_default();
                    text = after.trim_start_matches('\n').to_owned();
                }
                let reasoning = reasoning.unwrap_or_default();
                let reasoning = py_trim(&reasoning);
                out += &format!("<|im_start|>assistant\n<think>\n{reasoning}\n</think>\n\n{text}");
                for (n, call) in message["tool_calls"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let function = call.get("function").unwrap_or(call);
                    let name = function["name"].as_str().unwrap_or_default();
                    out += match (n, py_trim(&text).is_empty()) {
                        (0, false) => "\n\n<tool_call>\n<function=",
                        (0, true) => "<tool_call>\n<function=",
                        _ => "\n<tool_call>\n<function=",
                    };
                    out += name;
                    out += ">\n";
                    for (key, value) in &arguments(&function["arguments"]) {
                        out += &format!("<parameter={key}>\n");
                        match value {
                            Value::String(s) => out += s,
                            other => py_json(other, &mut out),
                        }
                        out += "\n</parameter>\n";
                    }
                    out += "</function>\n</tool_call>";
                }
                out += "<|im_end|>\n";
            }
            "tool" => {
                if i > 0 && role(i - 1) != "tool" {
                    out += "<|im_start|>user";
                }
                out += &format!("\n<tool_response>\n{text}\n</tool_response>");
                if i + 1 == messages.len() || role(i + 1) != "tool" {
                    out += "<|im_end|>\n";
                }
            }
            other => return Err(bad(&format!("不认识的消息角色 {other}"))),
        }
    }
    out += GENERATION;
    Ok(out)
}

/// 生成的文字整理成 OpenAI 格式的回复：第一个 <tool_call> 之前是心声，之后每段是一次调用。
/// 参数照工具定义分类型：字符串原样收，其余按 JSON 解析，解析不了的留成字符串交给工具校验退回。
/// `prompt` 是这次的题面，用来对回交谈编号；`truncated` 是生成到了长度上限；
/// usage 照 DeepSeek 的字段写，「消耗」页能算缓存命中。
pub fn chat_response(
    prompt: &str,
    tools: &Value,
    text: &str,
    truncated: bool,
    usage: Usage,
) -> Value {
    let mut parts = text.split("<tool_call>");
    let thought = py_trim(parts.next().unwrap_or_default());
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64);
    let calls: Vec<Value> = parts
        .filter_map(|part| {
            let body = part.split("</tool_call>").next().unwrap_or_default();
            let (_, rest) = body.split_once("<function=")?;
            let (name, rest) = rest.split_once('>')?;
            let rest = rest.split("</function>").next().unwrap_or_default();
            let mut arguments = parameters(name.trim(), rest, tools);
            if let Some(Value::String(id)) = arguments.get("interaction_id") {
                if let Some(whole) = whole_id(id, prompt) {
                    arguments.insert("interaction_id".into(), Value::String(whole));
                }
            }
            Some((name.trim().to_owned(), arguments))
        })
        .enumerate()
        .map(|(n, (name, arguments))| {
            json!({
                "id": format!("call_{stamp:x}_{n}"),
                "type": "function",
                "function": {"name": name, "arguments": Value::Object(arguments).to_string()},
            })
        })
        .collect();
    let finish = if !calls.is_empty() {
        "tool_calls"
    } else if truncated {
        "length"
    } else {
        "stop"
    };
    let mut message = json!({"role": "assistant", "content": thought});
    if !calls.is_empty() {
        message["tool_calls"] = Value::Array(calls);
    }
    json!({
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {
            "prompt_tokens": usage.input_tokens,
            "completion_tokens": usage.output_tokens,
            "prompt_cache_hit_tokens": usage.cache_hit_tokens,
            "prompt_cache_miss_tokens": usage.cache_miss_tokens,
        },
    })
}

/// 交谈编号只能照抄题面。训练数据里没有化身发起的交谈，模型见到 control/…/9 这样的编号时
/// 只抄出中间一段，这时换回题面里包含这一段的完整编号；同一个化身的几场交谈前半段相同，取最后提到的
/// 那场。太短的片段不换，免得对上别的交谈。补上化身交谈的训练数据后删掉。
fn whole_id(id: &str, prompt: &str) -> Option<String> {
    if id.chars().count() < 8 || id.contains('"') || prompt.contains(&format!("\"{id}\"")) {
        return None;
    }
    prompt
        .match_indices(id)
        .filter_map(|(at, _)| {
            let start = prompt[..at].rfind('"').map_or(0, |i| i + 1);
            let end = prompt[at..].find('"').map_or(prompt.len(), |i| at + i);
            // 只认题面里作为编号出现的字符串（"id":"…"、"interaction_id":"…"）
            prompt[..start]
                .ends_with("id\":\"")
                .then(|| prompt[start..end].to_owned())
        })
        .last()
}

/// 一次调用里的 <parameter=名>\n值\n</parameter>，顺序不限、可选参数可以夹在必填参数中间。
fn parameters(function: &str, mut rest: &str, tools: &Value) -> Map<String, Value> {
    let schema = tools
        .as_array()
        .into_iter()
        .flatten()
        .map(|tool| tool.get("function").unwrap_or(tool))
        .find(|f| f["name"] == function)
        .map(|f| &f["parameters"]["properties"]);
    let mut arguments = Map::new();
    while let Some((_, after)) = rest.split_once("<parameter=") {
        let Some((key, after)) = after.split_once('>') else {
            break;
        };
        let (raw, next) = after.split_once("</parameter>").unwrap_or((after, ""));
        let raw = raw.strip_prefix('\n').unwrap_or(raw);
        let raw = raw.strip_suffix('\n').unwrap_or(raw);
        let string_only = schema.is_some_and(|s| {
            let kind = &s[key.trim()]["type"];
            kind == "string"
                || kind
                    .as_array()
                    .is_some_and(|k| k.len() == 1 && k[0] == "string")
        });
        let value = if string_only {
            Value::String(raw.to_owned())
        } else {
            serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_owned()))
        };
        arguments.insert(key.trim().to_owned(), value);
        rest = next;
    }
    arguments
}

/// 消息正文：字符串原样，分段的拼起文字段，再按 Python 的 strip 去掉首尾空白。
fn content(value: &Value) -> String {
    match value {
        Value::String(s) => py_trim(s).to_owned(),
        Value::Array(items) => py_trim(
            &items
                .iter()
                .filter_map(|item| item["text"].as_str())
                .collect::<String>(),
        )
        .to_owned(),
        _ => String::new(),
    }
}

/// 线上的参数是 JSON 字符串，训练数据里是解析后的对象。
fn arguments(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::String(s) => serde_json::from_str(s).unwrap_or_default(),
        _ => Map::new(),
    }
}

/// Python 的 str.strip()：比 Rust 的 trim 多去掉 \x1c–\x1f 这几个分隔符。
fn py_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || ('\x1c'..='\x1f').contains(&c))
}

/// Python 的 json.dumps(value, ensure_ascii=False)。
fn py_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match (n.as_i64(), n.as_u64(), n.as_f64()) {
            (Some(i), _, _) => out.push_str(&i.to_string()),
            (_, Some(u), _) => out.push_str(&u.to_string()),
            (_, _, Some(f)) => out.push_str(&py_float(f)),
            _ => out.push_str(&n.to_string()),
        },
        // 转义规则两边一样：引号、反斜杠和控制字符，其余原样
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                py_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push_str(": ");
                py_json(item, out);
            }
            out.push('}');
        }
    }
}

/// Python 的 repr(float)：最短能还原的数字；指数在 -4..16 之间写成小数，整数值补 ".0"，
/// 其余写成 1e+16、1.5e-05 这样。
fn py_float(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let shortest = format!("{f:e}");
    let (mantissa, exp) = shortest.split_once('e').unwrap_or((&shortest, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let (sign, mantissa) = match mantissa.strip_prefix('-') {
        Some(m) => ("-", m),
        None => ("", mantissa),
    };
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    if (-4..16).contains(&exp) {
        let point = exp + 1;
        if point <= 0 {
            format!("{sign}0.{}{digits}", "0".repeat((-point) as usize))
        } else if point as usize >= digits.len() {
            let zeros = "0".repeat(point as usize - digits.len());
            format!("{sign}{digits}{zeros}.0")
        } else {
            let (int, frac) = digits.split_at(point as usize);
            format!("{sign}{int}.{frac}")
        }
    } else {
        let (first, rest) = digits.split_at(1);
        let mantissa = if rest.is_empty() {
            first.to_owned()
        } else {
            format!("{first}.{rest}")
        };
        let exp_sign = if exp < 0 { '-' } else { '+' };
        format!("{sign}{mantissa}e{exp_sign}{:02}", exp.abs())
    }
}
