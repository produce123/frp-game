using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// 本机源码目录的入口；服务检测、模型和后台进程由 start-local.mjs 统一管理。
internal static class LocalLauncher
{
    private const string TownUrl = "http://127.0.0.1:5174/";
    private static readonly object LogLock = new object();
    private static string logPath;
    private static Mutex logMutex;
    private static string failureReason;

    [STAThread]
    private static int Main(string[] args)
    {
        bool headless = Array.IndexOf(args, "--headless") >= 0;
        bool noBrowser = Array.IndexOf(args, "--no-browser") >= 0;
        string root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        logPath = Path.Combine(root, ".local", "launcher", "launcher.log");
        try
        {
            logMutex = new Mutex(false, MutexName(root) + "-log");
            Directory.CreateDirectory(Path.GetDirectoryName(logPath));
            WriteLog("启动 AI小镇：" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            if (headless) return Run(root, noBrowser, null);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (ProgressWindow window = new ProgressWindow())
            {
                int exitCode = 1;
                window.Shown += delegate
                {
                    Thread worker = new Thread(delegate()
                    {
                        string error = null;
                        try { exitCode = Run(root, noBrowser, window.UpdateProgress); }
                        catch (Exception exception)
                        {
                            error = exception.Message;
                            TryLog(exception.ToString());
                        }
                        window.BeginInvoke((Action)delegate
                        {
                            if (exitCode != 0)
                                MessageBox.Show(window,
                                    (error ?? failureReason ?? "启动未完成，请查看日志中的具体原因。") +
                                    "\r\n\r\n日志：" + logPath,
                                    "AI小镇启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                            window.Close();
                        });
                    });
                    worker.IsBackground = true;
                    worker.Start();
                };
                Application.Run(window);
                return exitCode;
            }
        }
        catch (Exception exception)
        {
            TryLog(exception.ToString());
            if (!headless)
                MessageBox.Show(exception.Message + "\r\n\r\n日志：" + logPath,
                    "AI小镇启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally { if (logMutex != null) logMutex.Dispose(); }
    }

    private static int Run(string root, bool noBrowser, Action<string> progress)
    {
        string script = Path.Combine(root, "scripts", "windows", "start-local.mjs");
        if (!File.Exists(script))
            throw new FileNotFoundException("请把启动程序放在 AI小镇项目根目录；找不到启动脚本。", script);

        // 锁名只与项目绝对路径有关；重复双击先等前一次完成，再由脚本复用已有服务。
        using (Mutex mutex = new Mutex(false, MutexName(root)))
        {
            bool held = false;
            try
            {
                Report(progress, "正在检查本地服务……");
                try
                {
                    held = mutex.WaitOne(0);
                    if (!held)
                    {
                        Report(progress, "另一个启动窗口正在准备小镇，正在等待……");
                        held = mutex.WaitOne(TimeSpan.FromMinutes(10));
                    }
                }
                catch (AbandonedMutexException) { held = true; }
                if (!held) throw new TimeoutException("等待另一个启动窗口超时，请查看启动日志。");

                string node = FindNode();
                ProcessStartInfo start = new ProcessStartInfo(node,
                    Quote(script) + " --root " + Quote(root));
                start.WorkingDirectory = root;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.WindowStyle = ProcessWindowStyle.Hidden;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                start.StandardOutputEncoding = Encoding.UTF8;
                start.StandardErrorEncoding = Encoding.UTF8;
                bool ready = false;
                using (Process process = new Process())
                {
                    process.StartInfo = start;
                    process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs output)
                    {
                        if (output.Data == null) return;
                        TryLog(output.Data);
                        if (output.Data == "READY " + TownUrl) ready = true;
                        else if (progress != null) progress(output.Data);
                    };
                    process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs output)
                    {
                        if (output.Data != null)
                        {
                            TryLog("[stderr] " + output.Data);
                            if (!String.IsNullOrWhiteSpace(output.Data))
                                failureReason = output.Data.Length > 700 ? output.Data.Substring(0, 700) : output.Data;
                        }
                    };
                    if (!process.Start()) throw new InvalidOperationException("无法启动 Node.js。");
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    // 无参 WaitForExit 同时等待异步输出回调收尾，确保 READY 和错误均已写入日志。
                    process.WaitForExit();
                    if (process.ExitCode != 0) return process.ExitCode;
                }
                if (!ready) throw new InvalidOperationException("启动脚本已退出，但尚未确认小镇页面就绪。");
                if (!noBrowser)
                {
                    Report(progress, "小镇已就绪，正在打开浏览器……");
                    Process.Start(new ProcessStartInfo(TownUrl) { UseShellExecute = true });
                }
                return 0;
            }
            finally { if (held) mutex.ReleaseMutex(); }
        }
    }

    private static string FindNode()
    {
        string configured = Environment.GetEnvironmentVariable("AI_TOWN_NODE");
        if (!String.IsNullOrWhiteSpace(configured))
        {
            configured = Environment.ExpandEnvironmentVariables(configured.Trim().Trim('"'));
            if (File.Exists(configured)) return Path.GetFullPath(configured);
            throw new FileNotFoundException("AI_TOWN_NODE 指向的 Node.js 不存在：" + configured);
        }
        foreach (string variable in new string[] { "ProgramFiles", "ProgramFiles(x86)" })
        {
            string directory = Environment.GetEnvironmentVariable(variable);
            if (String.IsNullOrEmpty(directory)) continue;
            string candidate = Path.Combine(directory, "nodejs", "node.exe");
            if (File.Exists(candidate)) return candidate;
        }
        foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (String.IsNullOrWhiteSpace(directory)) continue;
            try
            {
                string candidate = Path.Combine(directory.Trim().Trim('"'), "node.exe");
                if (File.Exists(candidate)) return Path.GetFullPath(candidate);
            }
            catch (ArgumentException) { }
        }
        throw new FileNotFoundException("找不到 Node.js。请安装 Node.js 22.18 或更新版本，或设置 AI_TOWN_NODE。");
    }

    // CommandLineToArgvW 的反斜线规则；项目路径包含空格、中文或末尾反斜线都能完整传给 Node。
    private static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    private static string MutexName(string root)
    {
        using (SHA256 hash = SHA256.Create())
            return "Local\\AITownLauncher-" + BitConverter.ToString(hash.ComputeHash(
                Encoding.UTF8.GetBytes(root.TrimEnd('\\', '/').ToUpperInvariant()))).Replace("-", "");
    }

    private static void Report(Action<string> progress, string message)
    {
        WriteLog(message);
        if (progress != null) progress(message);
    }

    private static void WriteLog(string message)
    {
        lock (LogLock)
        {
            // 启动流程锁之外也有等待/失败日志；单独的日志锁避免两个 EXE 同时打开文件。
            bool held = false;
            try
            {
                if (logMutex != null)
                {
                    try { held = logMutex.WaitOne(TimeSpan.FromSeconds(10)); }
                    catch (AbandonedMutexException) { held = true; }
                    if (!held) throw new IOException("无法取得启动日志的写入锁。");
                }
                File.AppendAllText(logPath, message + Environment.NewLine, new UTF8Encoding(false));
            }
            finally { if (held) logMutex.ReleaseMutex(); }
        }
    }

    private static void TryLog(string message)
    {
        try { WriteLog(message); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private sealed class ProgressWindow : Form
    {
        private readonly Label status;

        public ProgressWindow()
        {
            Text = "AI小镇";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(460, 165);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ControlBox = false;
            Font = new Font("Microsoft YaHei UI", 10F);
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            BackColor = Color.FromArgb(247, 245, 239);
            Label title = new Label();
            title.Text = "正在准备 AI小镇";
            title.Font = new Font(Font.FontFamily, 15F, FontStyle.Bold);
            title.SetBounds(24, 19, 412, 32);
            Controls.Add(title);
            status = new Label();
            status.Text = "检查项目和本地模型……";
            status.SetBounds(24, 62, 412, 43);
            status.AutoEllipsis = true;
            Controls.Add(status);
            ProgressBar bar = new ProgressBar();
            bar.SetBounds(24, 119, 412, 16);
            bar.Style = ProgressBarStyle.Marquee;
            bar.MarqueeAnimationSpeed = 30;
            Controls.Add(bar);
        }

        public void UpdateProgress(string message)
        {
            if (!IsDisposed && IsHandleCreated)
                BeginInvoke((Action)delegate { status.Text = message; });
        }
    }
}
