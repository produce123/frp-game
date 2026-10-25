package com.aitown.app;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;

/**
 * 本机小镇服务：应用自带的页面与数据第一次运行时解到私有目录，再启动 Rust 管理服务
 * （libtownmanager.so，由它按需启动世界进程 libtownhost.so）。页面从 127.0.0.1 打开。
 * 带着内置模型推理程序的包，世界进程在村民第一次用到时自己起推理服务；模型文件由管理服务下载到 home/。
 * 本类握着管理服务的 stdin：应用进程无论怎样结束，管道关闭，管理服务让各世界保存后退出。
 */
final class TownRuntime {
    private static final String TAG = "TownRuntime";
    /** 固定端口：页面的本地存储按来源区分，端口变了偏好与提示状态就丢了。 */
    private static final int PORT = 47821;
    private static TownRuntime instance;

    private final Context context;
    private Process manager;
    private int port;
    private String secret;

    private TownRuntime(Context context) {
        this.context = context.getApplicationContext();
    }

    static synchronized TownRuntime get(Context context) {
        if (instance == null) instance = new TownRuntime(context);
        return instance;
    }

    /** 启动（或复用）管理服务，返回带会话口令的首页地址。耗时操作，不能在主线程调用。 */
    synchronized String start() throws Exception {
        if (manager == null || !manager.isAlive()) launch();
        return "http://127.0.0.1:" + port + "/__session?k=" + secret;
    }

    /** 管理服务还在跑：切到后台久了可能被系统回收 */
    synchronized boolean alive() {
        return manager != null && manager.isAlive();
    }

    /** 关闭 stdin，管理服务让世界保存后自行退出。 */
    synchronized void stop() {
        if (manager == null) return;
        try {
            manager.getOutputStream().close();
        } catch (IOException ignored) {
        }
        manager = null;
    }

    private void launch() throws Exception {
        File bundle = installBundle();
        File home = new File(context.getFilesDir(), "home");
        if (!home.isDirectory() && !home.mkdirs()) throw new IOException("无法创建数据目录");
        try {
            linkBuiltinModel(new File(bundle, "app"), home);
        } catch (IOException e) {
            // 内置模型用不了不挡着开镇：设定里不出现它，在线模型照常能用
            Log.e(TAG, "builtin model unavailable", e);
        }
        String libs = context.getApplicationInfo().nativeLibraryDir;
        File ready = new File(context.getCacheDir(), "manager-ready.json");
        //noinspection ResultOfMethodCallIgnored
        ready.delete();
        secret = randomHex();
        ProcessBuilder builder = new ProcessBuilder(
                libs + "/libtownmanager.so",
                "--root", home.getAbsolutePath(),
                "--app", new File(bundle, "app").getAbsolutePath(),
                "--web", new File(bundle, "web").getAbsolutePath(),
                "--host-bin", libs + "/libtownhost.so",
                "--port", String.valueOf(PORT),
                "--ready-file", ready.getAbsolutePath(),
                "--session-secret", secret,
                "--max-running", "1",
                "--stop-on-stdin-close");
        builder.environment().put("HOME", home.getAbsolutePath());
        builder.redirectErrorStream(true);
        builder.redirectOutput(ProcessBuilder.Redirect.appendTo(new File(home, "manager.log")));
        manager = builder.start();
        long deadline = System.currentTimeMillis() + 20000;
        while (System.currentTimeMillis() < deadline) {
            if (!manager.isAlive()) throw new IOException("小镇服务启动失败（" + manager.exitValue() + "）");
            if (ready.isFile()) {
                try {
                    JSONObject info = new JSONObject(readText(ready));
                    port = info.getInt("port");
                    return;
                } catch (Exception partial) {
                    // 就绪文件是原子写入的；读到半份说明还没写完，下一轮再读
                }
            }
            Thread.sleep(60);
        }
        manager.destroy();
        throw new IOException("小镇服务启动超时");
    }

    /**
     * 自带数据按安装时间分版本解压：更新安装后换新目录，旧目录删掉。
     * 用户数据（存档、密钥、日志）在 home/，不受影响。
     */
    private File installBundle() throws Exception {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        File root = new File(context.getFilesDir(), "bundle");
        File bundle = new File(root, String.valueOf(info.lastUpdateTime));
        File done = new File(bundle, ".installed");
        if (done.isFile()) return bundle;
        File[] old = root.listFiles();
        if (old != null) for (File f : old) deleteTree(f);
        AssetManager assets = context.getAssets();
        String list;
        try (InputStream in = assets.open("bundle/files.txt")) {
            list = readText(in);
        }
        byte[] buffer = new byte[64 * 1024];
        for (String line : list.split("\n")) {
            String path = line.trim();
            if (path.isEmpty()) continue;
            File target = new File(bundle, path);
            File parent = target.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs())
                throw new IOException("无法创建目录 " + parent);
            try (InputStream in = assets.open("bundle/" + path);
                 OutputStream out = new FileOutputStream(target)) {
                int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            }
        }
        Files.write(done.toPath(), new byte[0]);
        Log.i(TAG, "bundle installed: " + bundle);
        return bundle;
    }

    /**
     * 内置模型的推理程序（打包时编了才有）：在自带数据的 app/builtin-model/ 里放一个指向它的软链接——
     * 管理服务把这个目录告诉世界进程，和电脑版的目录一样。推理程序要留在 nativeLibraryDir 里才能执行，
     * 更新安装后路径会变，每次启动都重链。模型文件由管理服务下载到 home/builtin-model/。
     */
    private void linkBuiltinModel(File app, File home) throws IOException {
        File server = new File(context.getApplicationInfo().nativeLibraryDir, "libllamaserver.so");
        if (!server.isFile()) return;
        File dir = new File(app, "builtin-model");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("无法创建内置模型目录");
        relink(server, new File(dir, "llama-server"));
        adoptBundledModel(new File(home, "builtin-model"));
    }

    private static void relink(File target, File link) throws IOException {
        //noinspection ResultOfMethodCallIgnored
        link.delete();
        Files.createSymbolicLink(link.toPath(), target.toPath());
    }

    /**
     * 早先的包把模型带在安装包里、解到 files/model/：挪进下载目录接着用，不用再下几百 MB。
     * 它是哪一版由管理服务第一次看清单时核对。
     */
    private void adoptBundledModel(File store) throws IOException {
        File old = new File(new File(context.getFilesDir(), "model"), "model.gguf");
        if (!old.isFile()) return;
        File model = new File(store, "model.gguf");
        if (!model.isFile()) {
            if (!store.isDirectory() && !store.mkdirs()) throw new IOException("无法创建内置模型目录");
            if (!old.renameTo(model)) throw new IOException("内置模型搬不过去");
            Log.i(TAG, "builtin model adopted: " + model);
        }
        deleteTree(old.getParentFile());
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static String readText(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    private static String readText(InputStream in) throws IOException {
        StringBuilder text = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) text.append(line).append('\n');
        }
        return text.toString();
    }

    private static String randomHex() {
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format("%02x", b));
        return hex.toString();
    }
}
