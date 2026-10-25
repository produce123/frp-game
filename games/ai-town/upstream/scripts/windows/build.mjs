// 打包 Windows 版：在 Mac 上用 mingw 交叉编译成 x86_64 的 Windows 程序。构建前端与 Rust（世界进程、管理服务、
// windows/ 的应用壳），带上 WebView2 的加载器，整理成文件夹再压成 zip：解压后双击「AI小镇.exe」，不用安装。
// 用 scripts/builtin-model/build.mjs --windows 编过内置模型的推理程序时一起打进包；模型文件不进包，用到时下载。
// 需要：rustup target add x86_64-pc-windows-gnu --toolchain 1.88.0；brew install mingw-w64。
// 用法：node scripts/windows/build.mjs [--skip-web] [--skip-rust]
// 产物：target/windows/AI小镇/（解压出来的样子）与 target/windows/ai-town-<版本>-windows-x64.zip。
// 没有代码签名：别的电脑第一次打开时 SmartScreen 会拦一下，点「更多信息 → 仍要运行」。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageAppBundle } from '../app-bundle.mjs'
import { MINGW, windowsDlls, windowsSystemDll } from './dlls.mjs'
import { makeIcon } from './icon.mjs'
import { zipFolder } from './zip.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const out = path.join(root, 'target/windows')
const work = path.join(out, 'work')
const args = process.argv.slice(2)
const TARGET = 'x86_64-pc-windows-gnu'
const TOOLCHAIN = '1.88.0'
const APP_NAME = 'AI小镇'
/** 应用壳单独一个工作区（windows/），编译目录也分开 */
const SHELL_TARGET = path.join(root, 'target/windows-app')
/** Rust 产物名 → 包里 resources\ 下的名字（windows/src/runtime.rs 按这个名字找） */
const BINARIES = [
  ['host', 'town-host.exe'],
  ['town-manager', 'town-manager.exe'],
]
const LLAMA_SERVER = 'llama-server.exe'

function run(command, list, extra = {}) {
  console.log(`$ ${command} ${list.join(' ')}`)
  execFileSync(command, list, { stdio: 'inherit', cwd: root, ...extra })
}

function checkTools() {
  const list = ['target', 'list', '--installed', '--toolchain', TOOLCHAIN]
  const installed = execFileSync('rustup', list, { encoding: 'utf8' })
  if (!installed.split('\n').includes(TARGET))
    throw Error(`缺少 Rust 的 Windows 目标：rustup target add ${TARGET} --toolchain ${TOOLCHAIN}`)
  try {
    execFileSync(`${MINGW}-gcc`, ['--version'], { stdio: 'ignore' })
  } catch {
    throw Error('缺少 mingw 交叉编译器：brew install mingw-w64')
  }
}

function cargoEnv(extra = {}) {
  const key = TARGET.toUpperCase().replaceAll('-', '_')
  return {
    ...process.env,
    [`CARGO_TARGET_${key}_LINKER`]: `${MINGW}-gcc`,
    [`CC_${TARGET.replaceAll('-', '_')}`]: `${MINGW}-gcc`,
    [`AR_${TARGET.replaceAll('-', '_')}`]: `${MINGW}-ar`,
    ...extra,
  }
}

function buildRust(version, icon) {
  const env = cargoEnv()
  const release = ['build', '--locked', '--release', '--target', TARGET]
  run('cargo', [...release, '-p', 'host', '--bin', 'host'], { env })
  run('cargo', [...release, '-p', 'manager', '--bin', 'town-manager'], { env })
  run(
    'cargo',
    [
      `+${TOOLCHAIN}`,
      ...release,
      '--manifest-path',
      path.join(root, 'windows/Cargo.toml'),
      '--target-dir',
      SHELL_TARGET,
    ],
    { env: cargoEnv({ AI_TOWN_WINDOWS_ICON: icon, AI_TOWN_VERSION: version }) }
  )
}

/** WebView2 的加载器：GNU 工具链下应用壳动态链接它，放在 exe 旁边。微软允许随应用分发，webview2-com-sys 自带一份 */
function webview2Loader() {
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      [
        `+${TOOLCHAIN}`,
        'metadata',
        '--format-version',
        '1',
        '--locked',
        '--manifest-path',
        path.join(root, 'windows/Cargo.toml'),
        '--filter-platform',
        TARGET,
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }
    )
  )
  const sys = metadata.packages.find((p) => p.name === 'webview2-com-sys')
  if (!sys) throw Error('应用壳的依赖里没有 webview2-com-sys')
  const loader = path.join(path.dirname(sys.manifest_path), 'x64/WebView2Loader.dll')
  if (!fs.existsSync(loader)) throw Error(`没找到 ${loader}`)
  return loader
}

/** Windows 上不能用的文件名、只差大小写的文件名（NTFS 不分大小写，会互相覆盖） */
function checkNames(files) {
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i
  const seen = new Map()
  for (const file of files) {
    for (const part of file.split('/'))
      if (/[<>:"|?*\\]/.test(part) || /[. ]$/.test(part) || reserved.test(part))
        throw Error(`Windows 上不能用的文件名：${file}`)
    const key = file.toLowerCase()
    if (seen.has(key))
      throw Error(`只差大小写的两个文件在 Windows 上会互相覆盖：${seen.get(key)}、${file}`)
    seen.set(key, file)
  }
}

/**
 * AI小镇\ 里：AI小镇.exe 和 WebView2Loader.dll；resources\ 放命令行程序、页面、数据和启动页图标。
 * 内置模型的推理程序放在自带数据的 app\builtin-model\，管理服务把这个目录告诉世界进程。
 */
function assemble(splashIcon) {
  const app = path.join(out, APP_NAME)
  fs.rmSync(app, { recursive: true, force: true })
  const resources = path.join(app, 'resources')
  fs.mkdirSync(resources, { recursive: true })
  fs.copyFileSync(
    path.join(SHELL_TARGET, TARGET, 'release/AITown.exe'),
    path.join(app, `${APP_NAME}.exe`)
  )
  fs.copyFileSync(webview2Loader(), path.join(app, 'WebView2Loader.dll'))
  for (const [name, packed] of BINARIES)
    run(`${MINGW}-strip`, [
      '-o',
      path.join(resources, packed),
      path.join(root, 'target', TARGET, 'release', `${name}.exe`),
    ])
  const files = stageAppBundle(resources)
  checkNames(files)
  fs.writeFileSync(path.join(resources, 'icon.png'), splashIcon)
  const server = path.join(root, 'target/builtin-model-windows', LLAMA_SERVER)
  const builtin = fs.existsSync(server)
  if (builtin) {
    fs.mkdirSync(path.join(resources, 'app/builtin-model'), { recursive: true })
    fs.copyFileSync(server, path.join(resources, 'app/builtin-model', LLAMA_SERVER))
  }
  return { app, files: files.length, builtin }
}

/** 包里每个程序都只能依赖系统自带的 DLL（应用壳另外依赖旁边的 WebView2Loader.dll） */
function checkDlls(app) {
  const programs = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(exe|dll)$/i.test(entry.name)) programs.push(full)
    }
  }
  walk(app)
  for (const program of programs) {
    if (path.basename(program) === 'WebView2Loader.dll') continue
    const foreign = windowsDlls(program).filter(
      (dll) => !windowsSystemDll(dll) && dll !== 'webview2loader.dll'
    )
    if (foreign.length)
      throw Error(
        `${path.relative(out, program)} 还依赖这些 DLL，换台电脑打不开：${foreign.join('、')}`
      )
  }
}

function main() {
  checkTools()
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  fs.rmSync(work, { recursive: true, force: true })
  fs.mkdirSync(work, { recursive: true })
  const icon = path.join(work, 'app.ico')
  const splashIcon = makeIcon(root, icon)
  if (!args.includes('--skip-web')) run('corepack', ['pnpm', 'build'])
  if (!args.includes('--skip-rust')) buildRust(version, icon)
  const { app, files, builtin } = assemble(splashIcon)
  checkDlls(app)
  console.log(
    builtin
      ? '已带上内置模型的推理程序'
      : '没有编内置模型的推理程序（node scripts/builtin-model/build.mjs --windows），这个包不能用内置模型'
  )
  const zip = path.join(out, `ai-town-${version}-windows-x64.zip`)
  fs.rmSync(zip, { force: true })
  const zipped = zipFolder(app, zip)
  const mb = (fs.statSync(zip).size / 1048576).toFixed(1)
  console.log(`\n文件夹：${path.relative(root, app)}（数据包 ${files} 个文件）`)
  console.log(`zip：${path.relative(root, zip)}（${mb} MB，${zipped} 个文件，版本 ${version}）`)
  console.log('没有代码签名：别的电脑第一次打开时 SmartScreen 会拦一下，点「更多信息 → 仍要运行」')
}

main()
