' frp-game：悄悄启动服务端，不弹黑窗口。
' 由计划任务（登录时触发）调用，也可以手动双击。
' 路径从本文件的位置推出来，所以整个文件夹可以随便挪。

Option Explicit

Dim fso, sh, root, dataDir, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

' tools\run-hidden.vbs -> 上一级是 tools -> 再上一级是项目根目录
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

dataDir = fso.BuildPath(root, "data")
If Not fso.FolderExists(dataDir) Then
  fso.CreateFolder(dataDir)
End If

sh.CurrentDirectory = root

' 0 = 窗口隐藏；日志攒到 data\server.log，隧道出问题时能回头看
cmd = "cmd /c node """ & fso.BuildPath(root, "server\server.mjs") & """ >> """ & _
      fso.BuildPath(dataDir, "server.log") & """ 2>&1"

sh.Run cmd, 0, False