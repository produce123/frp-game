//! 主窗口：WebView2 铺满窗口，先显示启动页，管理服务就绪后打开游戏页。
//! 外壳只做系统层的事：窗口全屏、页面的确认框、外部链接交给默认浏览器、退出前等小镇保存；
//! 界面都在页面里（frontend/）。选文件和下载用 WebView2 自带的。和 mac 版 macos/TownWindow.swift 对应。
use crate::{
    runtime::{self, Runtime},
    system::{self, TITLE, WINDOW_CLASS},
};
use serde_json::Value;
use std::{
    cell::RefCell,
    time::{Duration, Instant},
};
use tao::{
    dpi::{LogicalSize, PhysicalPosition},
    event::{Event as TaoEvent, WindowEvent},
    event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy},
    platform::windows::{IconExtWindows, WindowBuilderExtWindows, WindowExtWindows},
    window::{Fullscreen, Icon, Window, WindowBuilder},
};
use webview2_com::{
    take_pwstr,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Deferral, ICoreWebView2ScriptDialogOpeningEventArgs,
        COREWEBVIEW2_SCRIPT_DIALOG_KIND, COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT,
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD,
    },
    ScriptDialogOpeningEventHandler,
};
use windows_core::PWSTR;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDOK, MB_ICONINFORMATION, MB_ICONQUESTION, MB_OK, MB_OKCANCEL,
};
use wry::{
    NewWindowResponse, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows,
    WebViewExtWindows,
};

/// 窗口收到的消息：管理服务那边（runtime.rs）和页面那边（WebView2 的回调）都转成它，在主线程处理。
pub enum Event {
    /// 管理服务就绪（带会话口令的入口地址）或没能启动（原因）
    Started {
        generation: u64,
        result: Result<String, String>,
    },
    /// 管理服务退出了（退出码）
    Exited { generation: u64, code: Option<i32> },
    /// 退出时等保存等到了上限
    StopTimeout,
    /// 页面经 window.ipc 发来的消息（见 BRIDGE）
    Page(String),
    /// 页面标题变了
    Title(String),
    /// 页面要在新窗口打开本机页面：就在这个窗口里打开
    Open(String),
    /// 页面弹了确认框，排在 DIALOGS 里等着显示
    Dialog,
}

const NIGHT: (u8, u8, u8, u8) = (0x11, 0x14, 0x12, 0xff);
/// 退出时等世界保存的上限；超时也放行，管理服务会自己存完再退出
const STOP_TIMEOUT: Duration = Duration::from_secs(15);

/// 页面那头的窗口桥（frontend/town-shared/src/platform.ts 的 windowFullscreen 用它）：和 mac 版的
/// webkit.messageHandlers.townWindow 一样，postMessage({fullscreen}) 切换、postMessage({}) 只问现在的
/// 状态，回复是切换后的状态；窗口进出全屏时页面收到 town:fullscreen 事件。
/// WebView2 自带的浏览器快捷键（查找、打印、另存为……）都关了，F11 全屏和 F5 / Ctrl+R 重新载入在这里补上。
const BRIDGE: &str = r#"(() => {
  if (window.townWindow) return
  const waiting = new Map()
  let last = 0
  const send = (message) => window.ipc.postMessage(JSON.stringify(message))
  window.townWindowReply = (id, on) => {
    waiting.get(id)?.(on)
    waiting.delete(id)
  }
  window.townWindow = {
    postMessage: (message) =>
      new Promise((resolve) => {
        const id = ++last
        waiting.set(id, resolve)
        send({ ...message, id })
      }),
  }
  addEventListener(
    'keydown',
    (event) => {
      const reload = event.key === 'F5' || (event.ctrlKey && !event.altKey && event.code === 'KeyR')
      if (event.key === 'F11') send({ toggle: true })
      else if (reload && location.protocol === 'http:') location.reload()
      else return
      event.preventDefault()
    },
    true
  )
})()"#;

thread_local! {
    /// 页面弹的确认框：WebView2 的回调里不能开模态框（会重入），先记下来，回到主循环再问
    static DIALOGS: RefCell<Vec<(ICoreWebView2ScriptDialogOpeningEventArgs, ICoreWebView2Deferral)>> =
        const { RefCell::new(Vec::new()) };
}

pub fn run() -> Result<(), String> {
    if system::already_running(&runtime::data_root().to_string_lossy()) {
        system::activate_existing();
        return Ok(());
    }
    let event_loop = EventLoopBuilder::<Event>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = build_window(&event_loop)?;
    let icon = splash_icon();
    let mut context = WebContext::new(Some(runtime::home().join("WebView2")));
    let webview = match build_webview(&window, &mut context, &proxy, icon.as_deref()) {
        Ok(webview) => webview,
        Err(error) => {
            runtime::log_app(&format!("WebView2 没能启动：{error}"));
            system::offer_webview2(&error);
            return Ok(());
        }
    };
    window.set_visible(true);
    let mut app = App {
        runtime: Runtime::new(proxy.clone()),
        window,
        webview,
        _context: context,
        proxy,
        icon,
        serving: false,
        quitting: false,
        last_restart: None,
    };
    app.start(None);
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            TaoEvent::UserEvent(event) => app.handle(event, flow),
            TaoEvent::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => app.close(flow),
            _ => {}
        }
    })
}

/// 默认 1280×820，屏幕小（比如 1366×768 的笔记本）就缩到放得下，放在屏幕正中。先不显示，页面背景铺好再显示。
fn build_window(event_loop: &EventLoop<Event>) -> Result<Window, String> {
    let (mut width, mut height) = (1280.0, 820.0);
    if let Some(monitor) = event_loop.primary_monitor() {
        let screen = monitor.size().to_logical::<f64>(monitor.scale_factor());
        width = f64::min(width, screen.width * 0.92);
        height = f64::min(height, screen.height * 0.86);
    }
    let icon = Icon::from_resource(1, None).ok();
    let window = WindowBuilder::new()
        .with_title(TITLE)
        .with_inner_size(LogicalSize::new(width, height))
        .with_min_inner_size(LogicalSize::new(480.0, 420.0))
        .with_visible(false)
        .with_window_icon(icon.clone())
        .with_taskbar_icon(icon)
        .with_window_classname(WINDOW_CLASS)
        // 拖放交给 WebView2：两边都接的话页面收不到拖进来的文件
        .with_drag_and_drop(false)
        .build(event_loop)
        .map_err(|e| format!("打不开窗口：{e}"))?;
    if let Some(monitor) = window.current_monitor() {
        let (screen, origin, size) = (monitor.size(), monitor.position(), window.outer_size());
        let x = origin.x + (screen.width as i32 - size.width as i32) / 2;
        let y = origin.y + (screen.height as i32 - size.height as i32) / 2;
        window.set_outer_position(PhysicalPosition::new(x.max(origin.x), y.max(origin.y)));
    }
    Ok(window)
}

fn build_webview(
    window: &Window,
    context: &mut WebContext,
    proxy: &EventLoopProxy<Event>,
    icon: Option<&str>,
) -> Result<WebView, String> {
    let (page, opens, titles) = (proxy.clone(), proxy.clone(), proxy.clone());
    let webview = WebViewBuilder::new_with_web_context(context)
        .with_html(splash("正在准备小镇…", icon))
        .with_background_color(NIGHT)
        .with_initialization_script_for_main_only(BRIDGE, true)
        .with_ipc_handler(move |request| {
            let _ = page.send_event(Event::Page(request.into_body()));
        })
        // 外部链接交给默认浏览器；本机页面照常打开
        .with_navigation_handler(|url| {
            local(&url) || {
                system::open_external(&url);
                false
            }
        })
        // target=_blank 与 window.open：本机页面在这个窗口打开，外部链接交给默认浏览器
        .with_new_window_req_handler(move |url, _| {
            if local(&url) {
                let _ = opens.send_event(Event::Open(url));
            } else {
                system::open_external(&url);
            }
            NewWindowResponse::Deny
        })
        .with_document_title_changed_handler(move |title| {
            let _ = titles.send_event(Event::Title(title));
        })
        // 背景音乐打开页面就试着播放
        .with_autoplay(true)
        .with_clipboard(true)
        .with_general_autofill_enabled(false)
        .with_browser_accelerator_keys(false)
        .build(window)
        .map_err(|e| e.to_string())?;
    watch_dialogs(&webview, proxy.clone()).map_err(|e| e.to_string())?;
    Ok(webview)
}

/// 页面的 alert / confirm 用系统提示框，标题是应用名；WebView2 自带的那种标题是网页地址。
fn watch_dialogs(webview: &WebView, wake: EventLoopProxy<Event>) -> windows_core::Result<()> {
    let core = webview.webview();
    unsafe {
        core.Settings()?.SetAreDefaultScriptDialogsEnabled(false)?;
        let handler = ScriptDialogOpeningEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let deferral = args.GetDeferral()?;
                DIALOGS.with(|queue| queue.borrow_mut().push((args, deferral)));
                let _ = wake.send_event(Event::Dialog);
            }
            Ok(())
        }));
        let mut token = 0;
        core.add_ScriptDialogOpening(&handler, &mut token)
    }
}

struct App {
    runtime: Runtime,
    window: Window,
    webview: WebView,
    /// 页面数据目录（%LOCALAPPDATA%\MyAiTown\WebView2），和页面活得一样久
    _context: WebContext,
    proxy: EventLoopProxy<Event>,
    /// 启动页上的图标（base64 的 PNG）
    icon: Option<String>,
    /// 游戏页已经打开过：之后管理服务退出算意外
    serving: bool,
    quitting: bool,
    last_restart: Option<Instant>,
}

impl App {
    fn start(&mut self, next: Option<String>) {
        if let Err(message) = self.runtime.start(next) {
            self.failed(&message);
        }
    }

    fn failed(&self, message: &str) {
        runtime::log_app(&format!("小镇服务没有启动：{message}"));
        self.show_splash(&format!(
            "小镇服务没有启动：{message}\n请处理后重新打开应用。"
        ));
    }

    /// 启动页盖回来并显示一句话：启动失败、退出时保存中
    fn show_splash(&self, status: &str) {
        let _ = self
            .webview
            .load_html(&splash(status, self.icon.as_deref()));
    }

    fn handle(&mut self, event: Event, flow: &mut ControlFlow) {
        match event {
            // 启动途中关了窗口：已经在等它保存退出，不再打开游戏页
            Event::Started { generation, result }
                if self.runtime.current(generation) && !self.quitting =>
            {
                match result {
                    Ok(url) => {
                        self.serving = true;
                        let _ = self.webview.load_url(&url);
                    }
                    Err(message) => {
                        self.runtime.stop();
                        self.failed(&message);
                    }
                }
            }
            Event::Exited { generation, code } if self.runtime.current(generation) => {
                self.runtime.exited();
                if self.quitting {
                    *flow = ControlFlow::Exit;
                } else if std::mem::take(&mut self.serving) {
                    self.service_died(code);
                }
            }
            Event::StopTimeout if self.quitting => *flow = ControlFlow::Exit,
            Event::Page(message) => self.page_message(&message),
            Event::Title(title) => {
                let title = title.trim();
                self.window
                    .set_title(if title.is_empty() { TITLE } else { title });
            }
            Event::Open(url) => {
                let _ = self.webview.load_url(&url);
            }
            Event::Dialog => self.show_dialogs(),
            _ => {}
        }
    }

    /// 管理服务意外退出：重新启动它，回到刚才的页面，页面会自己把小镇重新连上。
    /// 十秒内又退出就不再重试，免得来回重启。
    fn service_died(&mut self, code: Option<i32>) {
        if self
            .last_restart
            .is_some_and(|at| at.elapsed() < Duration::from_secs(10))
        {
            let code = code.map_or_else(|| "?".into(), |c| c.to_string());
            self.show_splash(&format!("小镇服务意外退出了（{code}），请重新打开应用。"));
            return;
        }
        self.last_restart = Some(Instant::now());
        let next = self.webview.url().ok().and_then(|url| local_path(&url));
        self.start(next);
    }

    /// 退出前让管理服务把小镇存好再走：盖上启动页，等它退出
    fn close(&mut self, flow: &mut ControlFlow) {
        if !self.runtime.running() {
            *flow = ControlFlow::Exit;
            return;
        }
        if std::mem::replace(&mut self.quitting, true) {
            return;
        }
        self.show_splash("正在保存小镇…");
        self.runtime.stop();
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            std::thread::sleep(STOP_TIMEOUT);
            let _ = proxy.send_event(Event::StopTimeout);
        });
    }

    /// 窗口桥的消息：{ id, fullscreen? } 切换或询问全屏并回复；{ toggle: true } 是 F11
    fn page_message(&mut self, message: &str) {
        let Ok(message) = serde_json::from_str::<Value>(message) else {
            return;
        };
        let now = self.window.fullscreen().is_some();
        let wanted = if message["toggle"] == true {
            Some(!now)
        } else {
            message["fullscreen"].as_bool()
        };
        if let Some(on) = wanted.filter(|on| *on != now) {
            self.window
                .set_fullscreen(on.then_some(Fullscreen::Borderless(None)));
            let _ = self.webview.evaluate_script(&format!(
                "dispatchEvent(new CustomEvent('town:fullscreen', {{ detail: {on} }}))"
            ));
        }
        if let Some(id) = message["id"].as_u64() {
            let on = self.window.fullscreen().is_some();
            let _ = self
                .webview
                .evaluate_script(&format!("window.townWindowReply?.({id}, {on})"));
        }
    }

    /// 页面的 alert / confirm：系统提示框挂在主窗口上，确认框按「确定」才算同意
    fn show_dialogs(&self) {
        let pending = DIALOGS.with(|queue| std::mem::take(&mut *queue.borrow_mut()));
        let owner = self.window.hwnd() as *mut std::ffi::c_void;
        let title = system::wide(TITLE);
        for (args, deferral) in pending {
            unsafe {
                let mut kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND::default();
                let mut message = PWSTR::null();
                let _ = args.Kind(&mut kind);
                let _ = args.Message(&mut message);
                let text = system::wide(take_pwstr(message));
                let accept = if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD {
                    true
                } else if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT {
                    MessageBoxW(
                        owner,
                        text.as_ptr(),
                        title.as_ptr(),
                        MB_OK | MB_ICONINFORMATION,
                    );
                    false
                } else {
                    let style = MB_OKCANCEL | MB_ICONQUESTION;
                    MessageBoxW(owner, text.as_ptr(), title.as_ptr(), style) == IDOK
                };
                if accept {
                    let _ = args.Accept();
                }
                let _ = deferral.Complete();
            }
        }
    }
}

/// 本机页面（管理服务、启动页、页面里生成的 blob）照常在窗口里打开
fn local(url: &str) -> bool {
    let url = url.to_ascii_lowercase();
    ["about:", "data:", "blob:"]
        .iter()
        .any(|s| url.starts_with(s))
        || ["127.0.0.1", "localhost"].iter().any(|host| {
            url.strip_prefix("http://")
                .and_then(|rest| rest.strip_prefix(host))
                .is_some_and(|rest| rest.is_empty() || rest.starts_with([':', '/']))
        })
}

/// 本机页面地址里的路径和查询（重启管理服务后回到这里）
fn local_path(url: &str) -> Option<String> {
    if !local(url) || !url.starts_with("http") {
        return None;
    }
    let rest = &url["http://".len()..];
    Some(
        rest.find('/')
            .map_or_else(|| "/".into(), |at| rest[at..].into()),
    )
}

/// 启动页：深色底、应用图标和一句状态
fn splash(status: &str, icon: Option<&str>) -> String {
    let text = status
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let logo = icon.map_or_else(String::new, |data| {
        format!(r#"<img src="data:image/png;base64,{data}" alt="">"#)
    });
    format!(
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{TITLE}</title><style>
html,body{{margin:0;height:100%;background:#111412;color:#aab0aa;user-select:none;cursor:default;
font:14px/1.7 "Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif}}
body{{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px}}
img{{width:96px;height:96px}}p{{margin:0 24px;max-width:420px;text-align:center;white-space:pre-line}}
</style></head><body>{logo}<p>{text}</p></body></html>"#
    )
}

/// resources\icon.png（打包时画好）转成 base64，放进启动页
fn splash_icon() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let bytes = std::fs::read(exe.with_file_name("resources").join("icon.png")).ok()?;
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                TABLE[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    Some(out)
}
