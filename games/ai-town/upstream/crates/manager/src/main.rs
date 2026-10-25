//! 本机小镇管理服务。手机版由应用壳启动并握着它的 stdin：壳退出，管道关闭，
//! 本服务让各世界保存后退出。参数见 manager::Options。
fn main() {
    if let Err(error) = run() {
        eprintln!("[town-manager] {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    host::process::install_shutdown_handler().map_err(|e| format!("安装退出信号处理失败：{e}"))?;
    let options = manager::Options::parse(std::env::args().skip(1))?;
    if options.stop_on_stdin_close {
        host::process::stop_when_stdin_closes();
    }
    manager::run(options)
}
