import AppKit
import WebKit

/// 页面里设定的「全屏」管的是这个窗口的系统全屏（和绿色按钮、⌃⌘F 一样）：换页面不退出，也不会
/// 盖住页面里开着的弹层。网页自己的全屏（requestFullscreen）在 WKWebView 里是另开一层只装这一页，
/// 进游戏一换页就退出，所以不开。页面 postMessage({fullscreen: true/false}) 切换、postMessage({})
/// 只问现在的状态，回复是切换后的状态；窗口进出全屏（包括按绿色按钮）时页面收到 town:fullscreen 事件。
/// 页面那头见 frontend/town-shared/src/platform.ts 的 windowFullscreen。
private final class WindowBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var window: NSWindow?
    weak var web: WKWebView?
    private var observers: [NSObjectProtocol] = []

    func watch(_ window: NSWindow, _ web: WKWebView) {
        self.window = window
        self.web = web
        for (name, on) in [
            (NSWindow.didEnterFullScreenNotification, true),
            (NSWindow.didExitFullScreenNotification, false),
        ] {
            observers.append(
                NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) {
                    [weak self] _ in
                    self?.web?.evaluateJavaScript(
                        "dispatchEvent(new CustomEvent('town:fullscreen', { detail: \(on) }))")
                })
        }
    }

    func userContentController(
        _ controller: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let window else { return replyHandler(false, nil) }
        let current = window.styleMask.contains(.fullScreen)
        guard let body = message.body as? [String: Any], let wanted = body["fullscreen"] as? Bool
        else { return replyHandler(current, nil) }
        if wanted != current { window.toggleFullScreen(nil) }
        replyHandler(wanted, nil)
    }
}

/// 主窗口：页面铺满，启动时盖一层启动画面，页面第一次加载完再揭开。
/// 外壳只做系统层的事：弹窗、选文件、下载、外部链接交给系统浏览器、窗口全屏；界面都在页面里（frontend/）。
final class TownWindowController: NSWindowController, WKNavigationDelegate, WKUIDelegate,
    WKDownloadDelegate
{
    private static let night = NSColor(srgbRed: 0x11 / 255, green: 0x14 / 255, blue: 0x12 / 255, alpha: 1)

    private let runtime: TownRuntime
    private let web: WKWebView
    private let splash = NSView()
    private let status = NSTextField(labelWithString: "正在准备小镇…")
    private var loaded = false
    private var lastRestart: Date?
    private var titleObservation: NSKeyValueObservation?
    private let bridge: WindowBridge

    init(runtime: TownRuntime) {
        self.runtime = runtime
        let config = WKWebViewConfiguration()
        // 背景音乐打开页面就试着播放
        config.mediaTypesRequiringUserActionForPlayback = []
        let bridge = WindowBridge()
        config.userContentController.addScriptMessageHandler(
            bridge, contentWorld: .page, name: "townWindow")
        self.bridge = bridge
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        config.applicationNameForUserAgent = "AITownMac/\(version ?? "0")"
        web = WKWebView(frame: .zero, configuration: config)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "AI小镇"
        window.minSize = NSSize(width: 480, height: 420)
        window.backgroundColor = Self.night
        window.tabbingMode = .disallowed
        window.center()
        window.setFrameAutosaveName("TownWindow")
        super.init(window: window)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.underPageBackgroundColor = Self.night
        titleObservation = web.observe(\.title) { [weak window] web, _ in
            if let title = web.title, !title.isEmpty { window?.title = title }
        }
        let content = NSView()
        content.addSubview(web)
        content.addSubview(splash)
        for view in [web, splash] {
            view.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
                view.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                view.topAnchor.constraint(equalTo: content.topAnchor),
                view.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            ])
        }
        buildSplash()
        window.contentView = content
        bridge.watch(window, web)
        runtime.onUnexpectedExit = { [weak self] code in self?.serviceDied(code) }
    }

    required init?(coder: NSCoder) { nil }

    private func buildSplash() {
        splash.wantsLayer = true
        splash.layer?.backgroundColor = Self.night.cgColor
        let logo = NSImageView(image: NSApp.applicationIconImage)
        logo.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            logo.widthAnchor.constraint(equalToConstant: 96),
            logo.heightAnchor.constraint(equalToConstant: 96),
        ])
        status.textColor = NSColor(srgbRed: 0xAA / 255, green: 0xB0 / 255, blue: 0xAA / 255, alpha: 1)
        status.font = .systemFont(ofSize: 14)
        status.alignment = .center
        status.maximumNumberOfLines = 4
        status.preferredMaxLayoutWidth = 420
        let stack = NSStackView(views: [logo, status])
        stack.orientation = .vertical
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        splash.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: splash.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: splash.centerYAnchor),
        ])
    }

    /// 启动画面盖回来并显示一句话：启动失败、退出时保存中
    func showSplash(_ text: String) {
        status.stringValue = text
        splash.alphaValue = 1
        splash.isHidden = false
    }

    func start(next: String? = nil) {
        runtime.start(next: next) { [weak self] result in
            switch result {
            case .success(let url): self?.web.load(URLRequest(url: url))
            case .failure(let error):
                self?.showSplash("小镇服务没有启动：\(error.localizedDescription)\n请处理后重新打开应用。")
            }
        }
    }

    /// 管理服务意外退出：重新启动它，回到刚才的页面，页面会自己把小镇重新连上。
    /// 十秒内又退出就不再重试，免得来回重启。
    private func serviceDied(_ code: Int32) {
        if let last = lastRestart, Date().timeIntervalSince(last) < 10 {
            showSplash("小镇服务意外退出了（\(code)），请重新打开应用。")
            return
        }
        lastRestart = Date()
        var next: String?
        if let url = web.url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            next = parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
        }
        start(next: next)
    }

    @objc func reloadPage(_ sender: Any?) {
        web.reload()
    }

    private static func isLocal(_ url: URL) -> Bool {
        ["blob", "data", "about"].contains(url.scheme ?? "")
            || ["127.0.0.1", "localhost"].contains(url.host ?? "")
    }

    // MARK: 导航

    func webView(
        _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        // 外部链接交给系统浏览器；页面里嵌的框架照常加载
        if !Self.isLocal(url) && action.targetFrame?.isMainFrame != false {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !loaded, let url = webView.url, Self.isLocal(url) else { return }
        loaded = true
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.22
            splash.animator().alphaValue = 0
        }, completionHandler: { [weak self] in self?.splash.isHidden = true })
    }

    func webView(
        _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        if !loaded { showSplash("页面没有打开：\(error.localizedDescription)") }
    }

    /// 页面进程被系统回收：重新载入，世界由本机服务保留
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: 下载（道具库导出等）

    func webView(
        _ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func webView(
        _ webView: WKWebView, navigationResponse: WKNavigationResponse,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload, decideDestinationUsing response: URLResponse,
        suggestedFilename: String, completionHandler: @escaping (URL?) -> Void
    ) {
        guard let window else { return completionHandler(nil) }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { answer in
            guard answer == .OK, let url = panel.url else { return completionHandler(nil) }
            // 存储面板已经问过要不要替换；目标文件还在的话下载会失败
            try? FileManager.default.removeItem(at: url)
            completionHandler(url)
        }
    }

    // MARK: 页面弹窗、选文件、新窗口

    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "好")
        present(alert) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        present(alert) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(
        _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?, initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = field
        present(alert) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
    ) {
        guard let window else { return completionHandler(nil) }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    /// target=_blank 与 window.open：本机页面在当前窗口打开，外部链接交给系统浏览器
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url {
            if Self.isLocal(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    private func present(_ alert: NSAlert, _ done: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window, window.attachedSheet == nil {
            alert.beginSheetModal(for: window, completionHandler: done)
        } else {
            done(alert.runModal())
        }
    }
}
