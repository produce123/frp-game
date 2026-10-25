//! 内置模型：题面要和训练时一字不差，回复要按模型实际的写法读出全部调用。
use agent::{
    builtin,
    conversation::{ModelReply, Usage},
};
use serde_json::{json, Value};

#[test]
fn builtin_prompt_matches_training_template() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/builtin_prompt.json")).unwrap();
    let prompt = builtin::prompt(&fixture["request"]).unwrap();
    assert_eq!(prompt, fixture["prompt"].as_str().unwrap());
}

/// 模型按参数名的字母序写，可选的 message 夹在必填参数中间；一次回复带两个调用。
/// 化身发起的交谈编号模型只抄出中间一段，按题面换回这场交谈的完整编号。
#[test]
fn builtin_reply_keeps_every_call_and_parameter() {
    let tools = json!([
        {"type": "function", "function": {"name": "interact", "parameters": {"properties": {
            "interaction_id": {"type": "string"}, "message": {"type": "string"},
            "operation": {"type": "string"}, "to": {"type": "string"}}}}},
        {"type": "function", "function": {"name": "wait_for", "parameters": {"properties": {
            "minutes": {"type": "number"}, "reason": {"type": "string"}}}}},
    ]);
    // 先前那场交谈和这场同一个化身，编号前半段相同；模型抄的是这场
    let prompt = r#"<|im_start|>user
{"interaction":{"id":"control/58e6f89d/8","status":"ended"}}<|im_end|>
<|im_start|>user
{"chat":{"id":"control/58e6f89d/9","members":["player_avatar","resident_001"],"turn":"resident_001"}}<|im_end|>"#;
    let text = "雨小了，先跟阿雅说一声。\n\n<tool_call>\n<function=interact>\n\
        <parameter=interaction_id>\n58e6f89d\n</parameter>\n<parameter=message>\n等雨停了一起去渡口。\n</parameter>\n\
        <parameter=operation>\nsay\n</parameter>\n<parameter=to>\nplayer_avatar\n</parameter>\n\
        </function>\n</tool_call>\n<tool_call>\n<function=wait_for>\n<parameter=minutes>\n30\n</parameter>\n\
        <parameter=reason>\n42\n</parameter>\n</function>\n</tool_call>";
    let usage = Usage {
        input_tokens: 1000,
        output_tokens: 80,
        cache_hit_tokens: 900,
        cache_miss_tokens: 100,
    };
    let response = builtin::chat_response(prompt, &tools, text, false, usage);
    let reply = ModelReply::from_chat_completion(&response).unwrap();
    assert_eq!(reply.thought, "雨小了，先跟阿雅说一声。");
    assert_eq!(reply.calls.len(), 2);
    assert_eq!(
        reply.calls[0].arguments,
        json!({"interaction_id": "control/58e6f89d/9", "message": "等雨停了一起去渡口。",
            "operation": "say", "to": "player_avatar"})
    );
    // 类型照工具定义：number 按 JSON 读，string 即使写成数字也原样收
    assert_eq!(
        reply.calls[1].arguments,
        json!({"minutes": 30, "reason": "42"})
    );
    assert_eq!(reply.usage, Some(usage));
}
