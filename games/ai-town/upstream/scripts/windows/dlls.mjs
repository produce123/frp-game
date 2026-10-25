// Windows 程序依赖哪些 DLL。包里的程序只能依赖 Windows 10 起系统自带的（UCRT 的 api-ms-win-crt-* 也算），
// 不然换台电脑就打不开；mingw 的 libgcc、libstdc++、libwinpthread 都要静态链接进去。
import { execFileSync } from 'node:child_process'

/** Homebrew 的 mingw-w64 交叉编译工具的前缀 */
export const MINGW = 'x86_64-w64-mingw32'

const SYSTEM = new Set(
  [
    'advapi32',
    'bcrypt',
    'bcryptprimitives',
    'combase',
    'comctl32',
    'comdlg32',
    'crypt32',
    'dbghelp',
    'dwmapi',
    'gdi32',
    'imm32',
    'kernel32',
    'msvcrt',
    'ntdll',
    'ole32',
    'oleaut32',
    'psapi',
    'secur32',
    'shell32',
    'shlwapi',
    'user32',
    'userenv',
    'uxtheme',
    'version',
    'winmm',
    'ws2_32',
  ].map((name) => `${name}.dll`)
)

/** 程序导入的 DLL（小写、去重） */
export function windowsDlls(file) {
  const text = execFileSync(`${MINGW}-objdump`, ['-p', file], {
    encoding: 'utf8',
    maxBuffer: 256 << 20,
  })
  return [...new Set([...text.matchAll(/DLL Name: (\S+)/g)].map((m) => m[1].toLowerCase()))]
}

export const windowsSystemDll = (dll) => SYSTEM.has(dll.toLowerCase()) || /^api-ms-win-/i.test(dll)
