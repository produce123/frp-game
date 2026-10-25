// 从锁定的依赖生成随安装包分发的许可，包含构建工具；未编入某个平台的依赖不因此成为产物内容。
// 先 pnpm install --frozen-lockfile；Cargo 会按锁文件取得缺少的源码。缺声明就失败，不静默漏掉。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const records = new Map()
const read = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
const json = (file) => JSON.parse(read(file))
function notices(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => /^(licen[cs]e|copying|copyright|notice)([._-]|$)/i.test(name))
    .sort()
    .filter((name) => fs.statSync(path.join(dir, name)).isFile())
    .map((name) => `${name}\n\n${read(path.join(dir, name)).trim()}`)
}
function add(key, license, source, texts) {
  if (!texts.length) throw Error(`${key} 缺少许可原文，请核对上游后补齐`)
  records.set(
    key,
    `${key}\nLicense: ${license || 'see text'}\nSource: ${source}\n\n${texts.join('\n\n')}`
  )
}
for (const [manifest, target] of [
  ['Cargo.toml', 'aarch64-apple-darwin'],
  ['Cargo.toml', 'aarch64-linux-android'],
  ['Cargo.toml', 'x86_64-pc-windows-gnu'],
  ['Cargo.toml', 'x86_64-unknown-linux-gnu'],
  ['windows/Cargo.toml', 'x86_64-pc-windows-gnu'],
]) {
  const meta = JSON.parse(
    execFileSync(
      'cargo',
      [
        '+1.88.0',
        'metadata',
        '--locked',
        '--format-version',
        '1',
        '--manifest-path',
        manifest,
        '--filter-platform',
        target,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }
    )
  )
  const active = new Set(meta.resolve.nodes.map((node) => node.id))
  for (const pkg of meta.packages) {
    if (!pkg.source || !active.has(pkg.id)) continue
    const key = `Cargo: ${pkg.name}@${pkg.version}`
    if (records.has(key)) continue
    const dir = path.dirname(pkg.manifest_path)
    const texts = notices(dir)
    if (pkg.license_file) texts.push(read(path.resolve(dir, pkg.license_file)))
    // 这三份 crate 未打包仓库根 LICENSE；按 .cargo_vcs_info.json 指定提交补存上游原文。
    if (pkg.name.startsWith('webview2-com')) {
      const expected = {
        'webview2-com': '0.39.1',
        'webview2-com-sys': '0.39.1',
        'webview2-com-macros': '0.8.1',
      }
      if (expected[pkg.name] !== pkg.version) throw Error(`${key} 已升级，请重新核对上游许可`)
      texts.push(
        read(
          path.join(
            root,
            'licenses',
            pkg.name.endsWith('-macros') ? 'WEBVIEW2-MACROS.txt' : 'WEBVIEW2.txt'
          )
        )
      )
    }
    add(key, pkg.license, `https://crates.io/crates/${pkg.name}/${pkg.version}`, texts)
  }
}
// pnpm 的当前平台安装树；仅纳入包本身，不跟随依赖软链重复扫描。
const store = path.join(root, 'node_modules/.pnpm')
for (const entry of fs.readdirSync(store).sort()) {
  const modules = path.join(store, entry, 'node_modules')
  if (!fs.existsSync(modules)) continue
  for (const name of fs.readdirSync(modules).sort()) {
    const base = path.join(modules, name)
    if (fs.lstatSync(base).isSymbolicLink()) continue
    const dirs = name.startsWith('@')
      ? fs.readdirSync(base).map((sub) => path.join(base, sub))
      : [base]
    for (const dir of dirs) {
      if (fs.lstatSync(dir).isSymbolicLink() || !fs.existsSync(path.join(dir, 'package.json')))
        continue
      const pkg = json(path.join(dir, 'package.json'))
      const texts = notices(dir)
      const parent = pkg.name.startsWith('@esbuild/')
        ? 'esbuild'
        : pkg.name.startsWith('@rolldown/binding-')
          ? 'rolldown'
          : null
      if (parent && !texts.length)
        texts.push(...notices(path.join(store, `${parent}@${pkg.version}`, 'node_modules', parent)))
      add(
        `npm: ${pkg.name}@${pkg.version}`,
        pkg.license,
        `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`,
        texts
      )
    }
  }
}
const header =
  'AI 小镇第三方依赖许可\n\n由 node scripts/third-party-notices.mjs 从锁文件与依赖原文生成。\n包含受支持构建目标的 Rust 依赖及本机安装的前端依赖和构建工具；并非每个安装包都包含全部依赖。\n这些依赖保留各自许可，不受项目非商业限制。llama.cpp、模型、素材声明另见同目录文件。\n'
fs.writeFileSync(
  path.join(root, 'licenses/DEPENDENCIES.txt'),
  header +
    '\n' +
    [...records]
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([, value]) => value)
      .join('\n\n' + '='.repeat(72) + '\n\n') +
    '\n'
)
console.log(`已记录 ${records.size} 个第三方依赖`)
