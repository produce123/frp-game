package com.aitown.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import java.net.URLEncoder;

/**
 * 外壳只做系统层的事：启动本机服务、承载页面、返回键、前后台切换、系统栏颜色。
 * 界面都在页面里（frontend/），与电脑版是同一套代码。
 */
public class MainActivity extends Activity {
    private static final int FILE_REQUEST = 41;
    private static final int NIGHT = 0xFF111412;
    private static final int PAPER = 0xFFF5F4F0;

    private FrameLayout root;
    private WebView web;
    private View splash;
    private TextView status;
    private ValueCallback<Uri[]> fileCallback;
    private long lastBackAt;
    private boolean loaded;

    /** 手机只做竖屏；平板和展开的折叠屏（最短边 ≥ 600dp）横竖都可以，页面按宽度换布局。
     *  折叠屏开合时界面不重建（见清单的 configChanges），所以每次尺寸变化都重新判断一次。 */
    private void lockOrientation(Configuration config) {
        int wanted = config.smallestScreenWidthDp < 600
                ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        if (getRequestedOrientation() != wanted) setRequestedOrientation(wanted);
    }

    @Override
    public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        lockOrientation(config);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        lockOrientation(getResources().getConfiguration());
        root = new FrameLayout(this);
        root.setBackgroundColor(NIGHT);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        splash = buildSplash();
        root.addView(splash, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        fitSystemBars();
        setBars(NIGHT, false);
        configureWeb();
        registerBack();
        startTown();
    }

    private View buildSplash() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(NIGHT);
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.mipmap.ic_launcher);
        int size = (int) (96 * getResources().getDisplayMetrics().density);
        box.addView(logo, new LinearLayout.LayoutParams(size, size));
        status = new TextView(this);
        status.setTextColor(0xFFAAB0AA);
        status.setTextSize(14);
        status.setGravity(Gravity.CENTER);
        status.setPadding(48, 36, 48, 0);
        status.setText("正在准备小镇…");
        box.addView(status);
        return box;
    }

    /** Android 11 起自己按系统栏与键盘让出边距；更早的版本由 adjustResize 处理。 */
    private void fitSystemBars() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsets.CONSUMED;
        });
    }

    /** 系统栏跟着页面换底色：选图页是深色，游戏页是浅色。 */
    @SuppressWarnings("deprecation")
    private void setBars(int color, boolean lightBackground) {
        root.setBackgroundColor(color);
        Window window = getWindow();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            window.setStatusBarColor(color);
            window.setNavigationBarColor(color);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(lightBackground ? light : 0, light);
            }
        } else {
            int flags = lightBackground
                    ? View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                    : 0;
            window.getDecorView().setSystemUiVisibility(flags);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWeb() {
        // 只有调试包能在 chrome://inspect 里调试页面；发布包关着，别人连上电脑也看不到页面内部
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // 游戏界面按设计尺寸排版，不跟随系统字体放大，免得按钮和抽屉被挤坏
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " AITownAndroid/" + versionName());
        web.setBackgroundColor(Color.TRANSPARENT);
        web.addJavascriptInterface(new Bridge(), "TownAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost())) return false;
                // 外部链接交给系统浏览器
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!loaded && url.startsWith("http://127.0.0.1")) {
                    loaded = true;
                    splash.animate().alpha(0f).setDuration(220).withEndAction(() -> splash.setVisibility(View.GONE));
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // 页面进程被系统回收：重建界面，世界由本机服务保留
                recreate();
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.d("TownWeb", message.message() + " @" + message.sourceId() + ":" + message.lineNumber());
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_REQUEST);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    private void startTown() {
        new Thread(() -> {
            try {
                String url = TownRuntime.get(this).start();
                runOnUiThread(() -> web.loadUrl(url));
            } catch (Exception e) {
                Log.e("TownRuntime", "start failed", e);
                runOnUiThread(() -> status.setText("小镇服务没有启动：" + e.getMessage() + "\n请完全退出后重新打开。"));
            }
        }, "town-start").start();
    }

    private void registerBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBack();
    }

    /** 先交给页面一层层关（键盘、弹出层、抽屉、整页）；页面没有可关的，再按一次退出。 */
    private void handleBack() {
        if (!loaded) {
            finish();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return !!(window.townBack&&window.townBack())}catch(e){return false}})()",
                value -> {
                    if ("true".equals(value)) return;
                    long now = System.currentTimeMillis();
                    if (now - lastBackAt < 2000) {
                        finish();
                    } else {
                        lastBackAt = now;
                        Toast.makeText(this, "再按一次返回退出", Toast.LENGTH_SHORT).show();
                    }
                });
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 切到后台：页面让世界暂停并保存，回来时恢复原来的速度
        if (loaded) web.evaluateJavascript("window.townLifecycle&&window.townLifecycle('pause')", null);
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        if (!loaded) return;
        // 切到后台时本机服务可能被系统回收：重新启动它，回到刚才的页面，页面会自己把小镇重新打开
        if (!TownRuntime.get(this).alive()) restartTown();
        else web.evaluateJavascript("window.townLifecycle&&window.townLifecycle('resume')", null);
    }

    private void restartTown() {
        Uri page = Uri.parse(web.getUrl() == null ? "/" : web.getUrl());
        String next = (page.getEncodedPath() == null ? "/" : page.getEncodedPath())
                + (page.getEncodedQuery() == null ? "" : "?" + page.getEncodedQuery());
        new Thread(() -> {
            try {
                String url = TownRuntime.get(this).start() + "&next=" + URLEncoder.encode(next, "UTF-8");
                runOnUiThread(() -> web.loadUrl(url));
            } catch (Exception e) {
                Log.e("TownRuntime", "restart failed", e);
                runOnUiThread(() -> Toast.makeText(this, "小镇服务没有启动：" + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }, "town-restart").start();
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) TownRuntime.get(this).stop();
        web.destroy();
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_REQUEST && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    /** 页面可调用的系统能力，只有这几样。 */
    private final class Bridge {
        @JavascriptInterface
        public void systemBars(String tier) {
            boolean night = "night".equals(tier);
            runOnUiThread(() -> setBars(night ? NIGHT : PAPER, !night));
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(MainActivity.this::finish);
        }

        /** 现在用的是按流量计费的网络（手机流量、热点）：下载内置模型前先问，自动更新等 Wi-Fi */
        @JavascriptInterface
        public boolean metered() {
            ConnectivityManager network = getSystemService(ConnectivityManager.class);
            return network != null && network.isActiveNetworkMetered();
        }
    }
}
