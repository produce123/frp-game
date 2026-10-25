// AI小镇 mac 版的应用壳：启动本机小镇服务，用一个窗口承载页面（与电脑版、手机版同一套前端）。
// 打包见 scripts/macos/build.mjs。
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let runtime = TownRuntime()
    private var controller: TownWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMenu()
        let controller = TownWindowController(runtime: runtime)
        controller.showWindow(nil)
        controller.start()
        self.controller = controller
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// 退出前让管理服务把小镇存好再走
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard runtime.running else { return .terminateNow }
        controller?.showSplash("正在保存小镇…")
        runtime.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }
}

/// 菜单栏：没有「编辑」菜单时页面里的输入框不能拷贝粘贴
private func makeMenu() -> NSMenu {
    let main = NSMenu()
    let name = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "AI小镇"
    func item(
        _ title: String, _ action: Selector?, _ key: String = "",
        _ modifiers: NSEvent.ModifierFlags = .command
    ) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        return item
    }
    @discardableResult
    func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
        let menu = NSMenu(title: title)
        items.forEach(menu.addItem)
        let top = NSMenuItem()
        top.submenu = menu
        main.addItem(top)
        return menu
    }
    submenu(name, [
        item("关于 \(name)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
        .separator(),
        item("隐藏 \(name)", #selector(NSApplication.hide(_:)), "h"),
        item("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
        item("全部显示", #selector(NSApplication.unhideAllApplications(_:))),
        .separator(),
        item("退出 \(name)", #selector(NSApplication.terminate(_:)), "q"),
    ])
    submenu("编辑", [
        item("撤销", Selector(("undo:")), "z"),
        item("重做", Selector(("redo:")), "z", [.command, .shift]),
        .separator(),
        item("剪切", #selector(NSText.cut(_:)), "x"),
        item("拷贝", #selector(NSText.copy(_:)), "c"),
        item("粘贴", #selector(NSText.paste(_:)), "v"),
        item("全选", #selector(NSText.selectAll(_:)), "a"),
    ])
    submenu("显示", [
        item("重新载入页面", #selector(TownWindowController.reloadPage(_:)), "r"),
        item("进入全屏幕", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    NSApp.windowsMenu = submenu("窗口", [
        item("最小化", #selector(NSWindow.performMiniaturize(_:)), "m"),
        item("缩放", #selector(NSWindow.performZoom(_:))),
        .separator(),
        item("关闭窗口", #selector(NSWindow.performClose(_:)), "w"),
    ])
    return main
}

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.regular)
NSApplication.shared.run()
