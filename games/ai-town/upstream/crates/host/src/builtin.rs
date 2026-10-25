//! 内置模型：游戏自己的小模型，选了就能用，不填地址和密钥。推理程序 llama.cpp 的 llama-server 随应用带，
//! 模型文件 model.gguf 第一次用到时下载到用户数据目录（下载和更新见 builtin_store.rs）；村民第一次用到时
//! 由世界进程在本机起服务，世界进程退出时服务跟着停。
//!
//! 题面不交给 llama.cpp 的聊天模板：它会重排工具定义的键、改写小数，解析工具调用时要求必填参数在前、
//! 默认一次只收一个调用，都和训练时不一样。题面和回复在 agent::builtin 按训练模板处理，这里只管
//! 服务进程和本机的 /completion。
use crate::application::{self, Application};
use agent::{
    builtin,
    completion::{self, ModelError},
    conversation::Usage,
};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

/// 村民绑定的服务编号。不写进 providers.json：应用带着内置模型就能选。
pub const PROVIDER: &str = "builtin";
/// 给玩家看的服务名。
pub const NAME: &str = "内置模型";
/// 模型和游戏对得上的格式号：训练时的题面模板（agent::builtin）、工具定义的写法、推理程序的版本，任何一处
/// 改得旧模型用不了、或者新模型离不开新游戏时加一。发布清单里每个版本都记着格式号，游戏只取自己这一号的。
pub const FORMAT: u32 = 1;
const SERVER: &str = if cfg!(windows) {
    "llama-server.exe"
} else {
    "llama-server"
};
pub(crate) const MODEL: &str = "model.gguf";
/// 并行槽和村民请求的并发上限一致；上下文所有槽共用，一次请求最多 3.2 万 token。
const SLOTS: &str = "4";
const CONTEXT: &str = "131072";
/// 采样参数和训练后实跑评测时一致。
const TEMPERATURE: f64 = 0.6;
const TOP_P: f64 = 0.9;
const TOP_K: u64 = 20;
/// 模型载入（第一次还要编译 GPU 程序）最多等这么久。
const START_TIMEOUT: Duration = Duration::from_secs(120);

/// 服务外面套一层 sh：stdin 是连着世界进程的管道，世界进程不管怎样退出（含被强杀），管道一断就停掉
/// 服务；服务自己退出时 sh 也退出，下一次请求重新起。后台命令的 stdin 会被换成 /dev/null，所以先存到 3 号。
/// Windows 上没有 sh，服务放进一个作业，作业句柄一关就结束（process::end_with_handle）。
#[cfg(not(windows))]
const WATCH: &str = r#"exec 3<&0; "$@" 3<&- & pid=$!; (read -r _ <&3; kill $pid) & reader=$!; wait $pid; kill $reader 2>/dev/null"#;
#[cfg(target_os = "android")]
const SHELL: &str = "/system/bin/sh";
#[cfg(not(any(target_os = "android", windows)))]
const SHELL: &str = "/bin/sh";

/// 应用带没带推理程序。带着就能选内置模型，模型文件还没下载时村民先等着。
pub fn supported(app: &Application) -> bool {
    Path::new(&app.builtin_model_path).join(SERVER).is_file()
}

/// 世界进程里推理程序和模型文件的位置，开镇时设一次。
struct Paths {
    server: PathBuf,
    model: PathBuf,
}

static PATHS: OnceLock<Paths> = OnceLock::new();

/// 开镇时记下推理程序和模型文件的位置；应用没带推理程序时返回 false，设定里不出现内置模型。
pub fn configure(app: &Application) -> bool {
    if !supported(app) {
        return false;
    }
    let _ = PATHS.set(Paths {
        server: Path::new(&app.builtin_model_path).join(SERVER),
        model: Path::new(app.builtin_store()).join(MODEL),
    });
    true
}

/// 模型文件在不在：还没下载完或删掉了时，用它的村民等着。每拍都问，一秒内的结果直接用。
pub fn ready() -> bool {
    static SEEN: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
    let mut seen = SEEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, ready)) = *seen {
        if at.elapsed() < Duration::from_secs(1) {
            return ready;
        }
    }
    let ready = PATHS.get().is_some_and(|paths| paths.model.is_file());
    *seen = Some((Instant::now(), ready));
    ready
}

/// 模型文件是哪一份：新版下载好时整个换掉文件，修改时间和大小跟着变。
fn stamp(model: &Path) -> Option<(SystemTime, u64)> {
    let meta = fs::metadata(model).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// 服务还在用换下来的旧模型：新版是小镇开着时下好的，要重启服务才用得上。
pub fn stale() -> bool {
    let Some(paths) = PATHS.get() else {
        return false;
    };
    let mut running = RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    running.as_mut().is_some_and(|server| {
        matches!(server.child.try_wait(), Ok(None))
            && stamp(&paths.model).is_some_and(|now| Some(now) != server.stamp)
    })
}

/// 停掉服务，下一次请求用现在的模型文件重新起。正在等回复的村民这一次算失败，稍后重试。
pub fn restart() {
    *RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

/// 放开就停掉服务的东西：sh 的 stdin（握着不写，见 WATCH），Windows 上是装着服务的作业。
#[cfg(not(windows))]
type Guard = std::process::ChildStdin;
#[cfg(windows)]
type Guard = std::os::windows::io::OwnedHandle;

struct Running {
    base: String,
    child: Child,
    /// 起服务时模型文件是哪一份，见 stale。
    stamp: Option<(SystemTime, u64)>,
    guard: Option<Guard>,
}

impl Drop for Running {
    fn drop(&mut self) {
        // 关掉管道（sh 停掉服务后自己退出）或作业；回收它，不留僵尸进程
        self.guard.take();
        let _ = self.child.wait();
    }
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

/// 一次补全：题面按训练模板渲染，送 /completion，生成的文字整理成 OpenAI 格式的回复。
pub fn complete(body: &Value) -> Result<Value, ModelError> {
    let prompt = builtin::prompt(body)?;
    let paths = PATHS
        .get()
        .ok_or_else(|| ModelError::NotSent(format!("这个版本没有带{NAME}")))?;
    if !paths.model.is_file() {
        return Err(ModelError::NotSent(format!("{NAME}还没下载好")));
    }
    let base = ensure(paths)?;
    let request = json!({
        "prompt": &prompt,
        "n_predict": body["max_tokens"].as_u64().unwrap_or(2048),
        "temperature": TEMPERATURE,
        "top_p": TOP_P,
        "top_k": TOP_K,
        "stop": [builtin::STOP],
        "cache_prompt": true,
    });
    let response: Value = match ureq::post(&format!("{base}/completion"))
        .timeout(Duration::from_secs(300))
        .send_json(request)
    {
        Ok(response) => response
            .into_json()
            .map_err(|e| ModelError::Network(format!("读取内置模型的回复失败：{e}")))?,
        Err(ureq::Error::Status(code, response)) => {
            let detail = response.into_string().unwrap_or_default();
            return Err(completion::http_error(code, &detail));
        }
        Err(ureq::Error::Transport(e)) => {
            forget_if_stopped();
            return Err(ModelError::Network(format!("内置模型没有响应：{e}")));
        }
    };
    let timings = &response["timings"];
    let cached = timings["cache_n"].as_u64().unwrap_or(0);
    let evaluated = timings["prompt_n"].as_u64().unwrap_or(0);
    let usage = Usage {
        input_tokens: cached + evaluated,
        output_tokens: timings["predicted_n"].as_u64().unwrap_or(0),
        cache_hit_tokens: cached,
        cache_miss_tokens: evaluated,
    };
    Ok(builtin::chat_response(
        &prompt,
        &body["tools"],
        response["content"].as_str().unwrap_or_default(),
        response["stop_type"] == "limit",
        usage,
    ))
}

/// 服务在跑就用它，没起或已经退出就（重新）起一个。起服务时其他请求在锁上等着。
fn ensure(paths: &Paths) -> Result<String, ModelError> {
    let mut running = RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(server) = running.as_mut() {
        if matches!(server.child.try_wait(), Ok(None)) {
            return Ok(server.base.clone());
        }
    }
    *running = None;
    let server = start(paths)?;
    let base = server.base.clone();
    *running = Some(server);
    Ok(base)
}

/// 连不上时看一眼服务还在不在；不在了就忘掉，下一次请求重新起。
fn forget_if_stopped() {
    let mut running = RUNNING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if running
        .as_mut()
        .is_some_and(|server| !matches!(server.child.try_wait(), Ok(None)))
    {
        *running = None;
    }
}

fn start(paths: &Paths) -> Result<Running, ModelError> {
    let fail = |message: String| ModelError::NotSent(format!("内置模型没能启动：{message}"));
    let port = TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map_err(|e| fail(format!("找不到空闲端口：{e}")))?
        .port();
    let logs = application::log_dir();
    let log_path = logs.join("builtin-model.log");
    let log = fs::create_dir_all(&logs)
        .and_then(|()| File::options().create(true).append(true).open(&log_path))
        .map_err(|e| fail(format!("打不开日志 {}：{e}", log_path.display())))?;
    let output = log
        .try_clone()
        .map_err(|e| fail(format!("打不开日志 {}：{e}", log_path.display())))?;
    #[cfg(not(windows))]
    let mut command = Command::new(SHELL);
    #[cfg(not(windows))]
    command.args(["-c", WATCH, "sh"]).arg(&paths.server);
    #[cfg(windows)]
    let mut command = Command::new(&paths.server);
    command
        .arg("-m")
        .arg(&paths.model)
        .args(["--host", "127.0.0.1", "--port", &port.to_string()])
        .args([
            "-ngl",
            "99",
            "-c",
            CONTEXT,
            "-np",
            SLOTS,
            "-kvu",
            "--no-webui",
        ])
        // 村民的题面开头都是同一段系统提示和工具定义，按默认门槛会挤进别人的槽位；这个模型的线性注意力
        // 状态退不回中途，换了槽就得整段重读。门槛提高到 0.85，同一位村民才回到自己的槽位
        .args(["--slot-prompt-similarity", "0.85"]);
    // 手机只用 CPU：留两个核给系统和界面
    if cfg!(target_os = "android") {
        let cores = std::thread::available_parallelism().map_or(4, |n| n.get());
        command.args(["-t", &cores.saturating_sub(2).clamp(2, 4).to_string()]);
    }
    // Windows 不能替换或删除映射着的文件：不让它 mmap，载入后就不占着模型，新版下好时照样换得上。
    // 新版 llama.cpp 用 --load-mode，旧的 --no-mmap 已移除。
    if cfg!(windows) {
        command.args(["--load-mode", "none"]);
    }
    let mut child = crate::process::no_console(&mut command)
        .stdin(Stdio::piped())
        .stdout(output)
        .stderr(log)
        .spawn()
        .map_err(|e| fail(e.to_string()))?;
    #[cfg(not(windows))]
    let guard = child.stdin.take();
    #[cfg(windows)]
    let guard = match crate::process::end_with_handle(&child) {
        Ok(job) => Some(job),
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(fail(e.to_string()));
        }
    };
    let mut server = Running {
        base: format!("http://127.0.0.1:{port}"),
        child,
        stamp: stamp(&paths.model),
        guard,
    };
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if !matches!(server.child.try_wait(), Ok(None)) {
            return Err(fail(format!("服务退出了，详情见 {}", log_path.display())));
        }
        let health = ureq::get(&format!("{}/health", server.base))
            .timeout(Duration::from_secs(2))
            .call();
        if health.is_ok() {
            return Ok(server);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(fail(format!(
        "{} 秒内没有就绪，详情见 {}",
        START_TIMEOUT.as_secs(),
        log_path.display()
    )))
}
