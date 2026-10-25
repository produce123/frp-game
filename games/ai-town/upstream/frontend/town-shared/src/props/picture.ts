// 道具图：地图登记一个按道具定义编号取图的函数；取不到或还没加载完时显示图标。
import { gameIcon } from '../game/icons'

let propArtwork: (reference: string) => string | undefined = () => undefined
/** 已经加载过的图：列表重画时直接放图，不再先闪一下图标 */
const loaded = new Set<string>()

export function registerPropArtwork(resolve: typeof propArtwork) {
  propArtwork = resolve
}

export function propPicture(reference: string, fallback = 'bag') {
  const frame = document.createElement('span')
  frame.className = 'game-prop-picture'
  const url = propArtwork(reference)
  if (!url) {
    frame.append(gameIcon(fallback))
    return frame
  }
  const img = document.createElement('img')
  img.alt = ''
  img.src = url
  if (loaded.has(url)) {
    frame.append(img)
    return frame
  }
  frame.append(gameIcon(fallback))
  img.addEventListener(
    'load',
    () => {
      loaded.add(url)
      frame.replaceChildren(img)
    },
    { once: true }
  )
  return frame
}
