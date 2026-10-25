// Windows 本机源码入口：复用系统 .NET Framework 编译器，产物留在项目根目录供双击启动。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeIcon } from './icon.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const work = path.join(root, '.local/launcher-build')
const output = path.join(root, 'AI小镇启动.exe')

if (process.platform !== 'win32') throw Error('本机启动器需要在 Windows 上构建。')
const windows = process.env.SystemRoot || 'C:\\Windows'
const compiler = ['Framework64', 'Framework']
  .map((directory) => path.join(windows, 'Microsoft.NET', directory, 'v4.0.30319/csc.exe'))
  .find((candidate) => fs.existsSync(candidate))
if (!compiler) throw Error('找不到 Windows 自带的 .NET Framework C# 编译器。')
fs.mkdirSync(work, { recursive: true })
const icon = path.join(work, 'launcher.ico')
const staged = path.join(work, 'AI小镇启动.exe')
makeIcon(root, icon)
const result = spawnSync(
  compiler,
  [
    '/nologo',
    '/target:winexe',
    '/platform:anycpu',
    '/optimize+',
    '/utf8output',
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    `/win32icon:${icon}`,
    `/out:${staged}`,
    path.join(root, 'scripts/windows/LocalLauncher.cs'),
  ],
  { cwd: root, stdio: 'inherit', windowsHide: true }
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
fs.copyFileSync(staged, output)
console.log(`已生成：${output}`)
