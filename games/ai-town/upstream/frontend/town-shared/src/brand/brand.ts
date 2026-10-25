// 小镇标志：一栋像素小房子和带三个点的对话气泡。网页图标、选图页标志都用它；
// 安卓启动图标是同一张图生成的矢量图（android/app/src/main/res/drawable/ic_launcher_*.xml）。
import logo from './logo.svg'

export const logoUrl = logo

/** 浏览器标签页上的图标 */
export function installFavicon() {
  const link =
    document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link')
  link.rel = 'icon'
  link.type = 'image/svg+xml'
  link.href = logo
  document.head.append(link)
}
