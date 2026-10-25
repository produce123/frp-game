// Android SDK 与 NDK 的位置，打 APK 和编内置模型的推理程序共用。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 与 android/app/build.gradle.kts 的 minSdk 一致 */
export const MIN_API = 26

export function sdkDir() {
  const dir =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk')
  if (!fs.existsSync(dir)) throw Error(`找不到 Android SDK：${dir}（可设置 ANDROID_HOME）`)
  return dir
}

/** 版本号按数字比较，取装好的最新 NDK。 */
export function ndkDir(sdk) {
  if (process.env.ANDROID_NDK_HOME) return process.env.ANDROID_NDK_HOME
  const base = path.join(sdk, 'ndk')
  const versions = fs.existsSync(base) ? fs.readdirSync(base).filter((v) => /^\d+\./.test(v)) : []
  if (!versions.length) throw Error(`没有安装 NDK：${base}`)
  const key = (v) => v.split('.').map(Number)
  versions.sort((a, b) => {
    const [x, y] = [key(a), key(b)]
    for (let i = 0; i < Math.max(x.length, y.length); i++)
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
    return 0
  })
  return path.join(base, versions.at(-1))
}
