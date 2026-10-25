//! 本机小镇服务：启动 resources\ 里的 Rust 管理服务（town-manager.exe，由它按需启动世界进程
//! town-host.exe），页面从 127.0.0.1 打开。这里握着管理服务的 stdin：应用无论怎样结束（包括被强行结束），
//! 管道关闭，管理服务让各世界保存后退出。和 mac 版的 macos/TownRuntime.swift 是同一套做法。
use crate::{system, window::Event};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tao::event_loop::EventLoopProxy;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

/// 固定端口：页面的本地存储按来源区分，端口变了偏好与提示状态就丢了。被占用时管理服务往后找。
const PORT: u16 = 47821;
const START_TIMEOUT: Duration = Duration::from_secs(20);

/// 应用自己的目录 %LOCALAPPDATA%\MyAiTown：小镇数据默认放这里，日志和页面缓存也在它下面。
pub fn home() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| Path::new(&p).join("AppData\\Local")))
        .unwrap_or_else(std::env::temp_dir)
        .join("MyAiTown")
}

/// 小镇数据目录，和电脑版、mac 版一样可以用 AI_TOWN_HOME 改。
pub fn data_root() -> PathBuf {
    match std::env::var_os("AI_TOWN_HOME") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home(),
    }
}

pub fn log_file() -> PathBuf {
    home().join("logs").join("manager.log")
}

/// 应用壳自己的问题记在 logs\app.log（管理服务的在 manager.log），测试的人把 logs 文件夹发回来就能查
pub fn log_app(line: &str) {
    let path = home().join("logs").join("app.log");
    let _ = path.parent().map(fs::create_dir_all);
    if let Ok(mut file) = File::options().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// 应用自带的程序和数据在 AI小镇.exe 旁边的 resources\（scripts/windows/build.mjs 组装）。
fn resources() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("找不到应用自己的位置：{e}"))?;
    let dir = exe.with_file_name("resources");
    if !dir.join("town-manager.exe").is_file() {
        return Err("应用不完整：没有找到 resources 文件夹里的程序，请把压缩包整个重新解压".into());
    }
    Ok(dir)
}

pub struct Runtime {
    proxy: EventLoopProxy<Event>,
    /// 第几次启动：重启以后，上一个进程晚到的消息不算数。
    generation: u64,
    /// 管理服务的 stdin：只握着不写，放开它（或应用退出）管理服务就保存退出。
    input: Option<ChildStdin>,
    alive: bool,
}

impl Runtime {
    pub fn new(proxy: EventLoopProxy<Event>) -> Self {
        Self {
            proxy,
            generation: 0,
            input: None,
            alive: false,
        }
    }

    pub fn running(&self) -> bool {
        self.alive
    }

    /// 是不是这一次启动的进程发来的消息
    pub fn current(&self, generation: u64) -> bool {
        generation == self.generation
    }

    /// 启动管理服务。就绪（或失败）和退出都以 Event::Started / Event::Exited 报回窗口；
    /// next 是进门后要去的页面。
    pub fn start(&mut self, next: Option<String>) -> Result<(), String> {
        let resources = resources()?;
        let root = data_root();
        fs::create_dir_all(&root).map_err(|e| format!("建不了数据目录 {}：{e}", root.display()))?;
        let log_path = log_file();
        let log = log_path
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| File::options().create(true).append(true).open(&log_path))
            .map_err(|e| format!("打不开日志 {}：{e}", log_path.display()))?;
        let secret = system::random_hex();
        let ready = std::env::temp_dir().join(format!("ai-town-manager-{}.json", &secret[..8]));
        let mut child = Command::new(resources.join("town-manager.exe"))
            .arg("--root")
            .arg(&root)
            .arg("--app")
            .arg(resources.join("app"))
            .arg("--web")
            .arg(resources.join("web"))
            .arg("--host-bin")
            .arg(resources.join("town-host.exe"))
            .args(["--port", &PORT.to_string()])
            .arg("--ready-file")
            .arg(&ready)
            .args(["--session-secret", &secret, "--max-running", "1"])
            .arg("--stop-on-stdin-close")
            .stdin(Stdio::piped())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("小镇服务没能启动：{e}"))?;
        self.generation += 1;
        self.input = child.stdin.take();
        self.alive = true;
        let (generation, proxy) = (self.generation, self.proxy.clone());
        thread::spawn(move || {
            let result = wait_ready(&mut child, &ready)
                .map(|port| session_url(port, &secret, next.as_deref()));
            let _ = fs::remove_file(&ready);
            let _ = proxy.send_event(Event::Started { generation, result });
            let code = child.wait().ok().and_then(|status| status.code());
            let _ = proxy.send_event(Event::Exited { generation, code });
        });
        Ok(())
    }

    /// 关掉 stdin，管理服务让世界保存后自己退出，退出时窗口收到 Event::Exited。
    pub fn stop(&mut self) {
        self.input = None;
    }

    /// 这一次启动的进程退出了
    pub fn exited(&mut self) {
        self.input = None;
        self.alive = false;
    }
}

/// 等管理服务写出就绪文件（原子写入），读到的 pid 不是这次启动的进程就继续等；超时就结束它。
fn wait_ready(child: &mut Child, ready: &Path) -> Result<u16, String> {
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            let code = status.code().unwrap_or(-1);
            return Err(last_log_line().unwrap_or_else(|| format!("小镇服务启动失败（{code}）")));
        }
        let info = fs::read(ready)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        if let Some(info) = info.filter(|info| info["pid"] == child.id()) {
            if let Some(port) = info["port"].as_u64().and_then(|p| u16::try_from(p).ok()) {
                return Ok(port);
            }
        }
        thread::sleep(Duration::from_millis(60));
    }
    let _ = child.kill();
    Err("小镇服务启动超时".into())
}

/// 带会话口令的入口：管理服务种下 Cookie 后转到 next
fn session_url(port: u16, secret: &str, next: Option<&str>) -> String {
    let mut url = format!("http://127.0.0.1:{port}/__session?k={secret}");
    if let Some(next) = next {
        url.push_str("&next=");
        for byte in next.bytes() {
            if byte.is_ascii_alphanumeric() || b"-._~/".contains(&byte) {
                url.push(byte as char);
            } else {
                url.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    url
}

/// 管理服务启动失败时日志最后一行是原因（例如数据目录已被别的小镇服务占用）
fn last_log_line() -> Option<String> {
    let mut file = File::open(log_file()).ok()?;
    let size = file.seek(SeekFrom::End(0)).ok()?;
    file.seek(SeekFrom::Start(size.saturating_sub(4096))).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let line = text.lines().rev().find(|line| !line.trim().is_empty())?;
    Some(line.trim().replace("[town-manager] ", ""))
}
