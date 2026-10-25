//! 有上限的地图校验与自然语言解析：提示词与回复解析在 agent::completion，这里只调模型通道。
//! 另有首页「设定」的模型服务读、存、测试（host::models）和内置模型的下载与更新（host::builtin_store），
//! 电脑版管理服务经这里调用。
use host::{application::Application, HostError};
use serde_json::{json, Value};
use std::io::{self, Read};

/// 标准输入最多读这么多字节。
const INPUT_MAX_BYTES: u64 = 16_000_000;
/// 小镇描述的字数上限。
const DESCRIPTION_MAX_CHARS: usize = 2000;

fn run() -> Result<Value, HostError> {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let mut input = String::new();
    io::stdin()
        .take(INPUT_MAX_BYTES + 1)
        .read_to_string(&mut input)
        .map_err(|e| HostError::Runtime(e.to_string()))?;
    if input.len() as u64 > INPUT_MAX_BYTES {
        return Err(HostError::Runtime("输入超过限制".into()));
    }
    let app = Application::load()?;
    match mode.as_str() {
        "validate" => validate(&app, &input),
        "options" => {
            let (target, provider) = active_model(&app)?;
            Ok(json!({"provider":provider,"model":target.model,"available":true}))
        }
        "parse" => plan(&app, &input),
        "models" => host::models::read(&app),
        "save-models" => host::models::write(&app, &request(&input)?),
        "test-model" => host::models::check(&app, &request(&input)?),
        "builtin-model" => host::builtin_store::status(&app),
        "builtin-model-check" => host::builtin_store::check(&app),
        "builtin-model-act" => host::builtin_store::act(&app, &request(&input)?),
        // 下载线程：下完、暂停或停在出错上才退出，由管理服务保证同时只有一个
        "builtin-model-download" => {
            host::builtin_store::work(&app);
            Ok(json!({ "ok": true }))
        }
        _ => Err(HostError::Runtime("未知地图操作".into())),
    }
}

fn request(input: &str) -> Result<Value, HostError> {
    serde_json::from_str(input).map_err(|e| HostError::Runtime(e.to_string()))
}

/// 校验一份完整地图：道具库按地图引用加载，再过 host 的地图校验。
fn validate(app: &Application, input: &str) -> Result<Value, HostError> {
    let d: Value = serde_json::from_str(input).map_err(|e| HostError::Map(e.to_string()))?;
    let catalog = host::props::PropLibrary::load(
        &app.prop_catalog_path,
        &app.legacy_prop_catalog_path,
        None,
        &d,
    )?
    .catalog;
    host::maps::validate(&d, &catalog, std::path::Path::new(&app.scene_assets_path))?;
    Ok(json!({"ok":true}))
}

/// 设定中心选的小镇工具模型，连同服务商的显示名。
fn active_model(app: &Application) -> Result<(host::llm::LlmTarget, String), HostError> {
    let providers = host::config::load_providers(&app.providers_path)?;
    let active = providers
        .active
        .as_ref()
        .ok_or_else(|| HostError::Config("请先在首页的「设定」里连接一个模型".into()))?;
    let name = providers
        .providers
        .iter()
        .find(|p| p.id == active.provider)
        .map(|p| p.name.clone())
        .ok_or_else(|| HostError::Config("服务商不存在".into()))?;
    let credentials = host::config::load_credentials(&app.credentials_path)?;
    let target = host::llm::LlmTarget::active(&providers, &credentials)
        .ok_or_else(|| HostError::Config("服务商不存在".into()))?;
    Ok((target, name))
}

/// 用自然语言描述让模型规划小镇，回复里补上模型、服务商与调用次数。
fn plan(app: &Application, input: &str) -> Result<Value, HostError> {
    let (target, provider) = active_model(app)?;
    let v: Value = serde_json::from_str(input).map_err(|e| HostError::Runtime(e.to_string()))?;
    let description = v["description"]
        .as_str()
        .ok_or_else(|| HostError::Runtime("请填写小镇描述".into()))?;
    if description.trim().is_empty() || description.chars().count() > DESCRIPTION_MAX_CHARS {
        return Err(HostError::Runtime(format!(
            "描述须为 1–{DESCRIPTION_MAX_CHARS} 字"
        )));
    }
    let kinds = agent::completion::plan_kinds(&v["templates"]).map_err(HostError::Runtime)?;
    let revision = agent::completion::plan_revision(&v).map_err(HostError::Runtime)?;
    let prompt =
        agent::completion::planner_prompt(&v["seed"], description, &kinds, revision.as_ref());
    let text = host::llm::chat_completion(&target, &prompt)?;
    let mut parsed = agent::completion::parse_plan(&text)?;
    parsed["model"] = json!(target.model);
    parsed["provider"] = json!(provider);
    parsed["calls"] = json!(1);
    Ok(parsed)
}

fn main() {
    match run() {
        Ok(v) => println!("{v}"),
        Err(error) => {
            println!("{}", json!({"error":error.to_string()}));
            std::process::exit(1);
        }
    }
}
