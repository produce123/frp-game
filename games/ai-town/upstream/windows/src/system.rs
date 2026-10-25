//! 和系统打交道的几件小事：提示框、只开一个、用默认浏览器打开链接、随机口令。
use std::{
    ffi::OsStr,
    os::windows::ffi::OsStrExt,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_ALREADY_EXISTS},
    Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG},
    System::Threading::CreateMutexW,
    UI::{
        Shell::ShellExecuteW,
        WindowsAndMessaging::{
            FindWindowW, IsIconic, MessageBoxW, SetForegroundWindow, ShowWindow, IDYES,
            MB_ICONERROR, MB_ICONWARNING, MB_OK, MB_YESNO, SW_RESTORE, SW_SHOWNORMAL,
        },
    },
};

pub const TITLE: &str = "AI小镇";
/// 主窗口的窗口类名：再次打开应用时按它找到已经开着的窗口。
pub const WINDOW_CLASS: &str = "MyAiTownWindow";
/// 微软的 WebView2 运行时下载页（常青版引导程序）
const WEBVIEW2_DOWNLOAD: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

/// 以 0 结尾的 UTF-16，给 Win32 的 W 系列函数用
pub fn wide(text: impl AsRef<OsStr>) -> Vec<u16> {
    text.as_ref().encode_wide().chain([0]).collect()
}

pub fn alert(message: &str) {
    let (text, title) = (wide(message), wide(TITLE));
    unsafe {
        MessageBoxW(
            null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        )
    };
}

/// 系统没有 WebView2 运行时（少数一直没更新的 Windows 10）：问要不要去下载
pub fn offer_webview2(detail: &str) {
    let message = format!(
        "AI小镇需要微软的 WebView2 运行时来显示画面，这台电脑上没有找到。\n\n\
         现在去下载安装吗？装好后重新打开 AI小镇。\n\n（{detail}）"
    );
    let (text, title) = (wide(message), wide(TITLE));
    let style = MB_YESNO | MB_ICONWARNING;
    if unsafe { MessageBoxW(null_mut(), text.as_ptr(), title.as_ptr(), style) } == IDYES {
        open_external(WEBVIEW2_DOWNLOAD);
    }
}

/// 同一个数据目录已经有一个应用开着。第一次调用时占住一个系统互斥量，不关，进程退出时系统收回。
pub fn already_running(data_root: &str) -> bool {
    // 互斥量的名字里不能有反斜杠：数据目录取个摘要
    let hash = data_root
        .to_lowercase()
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
            (h ^ b as u64).wrapping_mul(0x100_0000_01b3)
        });
    let name = wide(format!("Local\\MyAiTown.{hash:016x}"));
    let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
    !handle.is_null() && unsafe { GetLastError() } == ERROR_ALREADY_EXISTS
}

/// 把已经开着的主窗口叫到前面（最小化了就还原）
pub fn activate_existing() {
    let class = wide(WINDOW_CLASS);
    let hwnd = unsafe { FindWindowW(class.as_ptr(), null()) };
    if hwnd.is_null() {
        return;
    }
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd);
    }
}

/// 外部链接交给默认浏览器；只认网页地址，别的协议（file:、自定义协议）一律不开
pub fn open_external(url: &str) {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return;
    }
    let (verb, file) = (wide("open"), wide(url));
    unsafe {
        ShellExecuteW(
            null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        )
    };
}

/// 32 位十六进制随机串：页面进门用的会话口令
pub fn random_hex() -> String {
    let mut bytes = [0u8; 16];
    let flags = BCRYPT_USE_SYSTEM_PREFERRED_RNG;
    let status = unsafe { BCryptGenRandom(null_mut(), bytes.as_mut_ptr(), 16, flags) };
    assert!(status >= 0, "系统随机数不可用：{status:#x}");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
