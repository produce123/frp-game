// AI小镇 Windows 版的应用壳：启动本机小镇服务，用一个 WebView2 窗口承载页面（与电脑版、手机版、mac 版
// 同一套前端）。打包见 scripts/windows/build.mjs，只在 mac 上交叉编译成 x86_64-pc-windows-gnu。
#![windows_subsystem = "windows"]

#[cfg(windows)]
mod runtime;
#[cfg(windows)]
mod system;
#[cfg(windows)]
mod window;

#[cfg(windows)]
fn main() {
    // 窗口程序没有控制台，出错时会一声不响地消失：弹个框说明，详情记进 logs\app.log
    std::panic::set_hook(Box::new(|info| {
        runtime::log_app(&format!("应用壳出错：{info}"));
        let payload = info.payload();
        let reason = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_default();
        system::alert(&format!("AI小镇遇到问题，需要关闭。\n\n{reason}"));
    }));
    if let Err(message) = window::run() {
        runtime::log_app(&message);
        system::alert(&message);
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("这是 Windows 版的应用壳：用 node scripts/windows/build.mjs 编译打包");
}
