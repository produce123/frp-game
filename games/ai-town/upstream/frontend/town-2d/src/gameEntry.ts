import 'town-shared/style.css'
import shell from 'town-shared/gameShell.html?raw'
import { $ } from 'town-shared/dom'
import { errorText } from 'town-shared/format'
import { openMap } from './launcher/catalog'
import { joinRoom } from 'town-shared/platformAccount'
import { installPlatform } from 'town-shared/platform'
import { installSelects } from 'town-shared/design/select'
import { installFavicon } from 'town-shared/brand/brand'
installPlatform()
installSelects()
installFavicon()
document.body.innerHTML = shell

const params = new URLSearchParams(location.search)
const id = params.get('map')
const room = params.get('room')
if (!id) location.replace(new URL('./', location.href))
else {
  try {
    // 好友的深链：先向平台登记成员，再 open。平台会把这次 open 路由到房主的 manager，
    // 拿到的是房主的存档和世界，而不是这台电脑上自己那份。
    if (room) await joinRoom(room)
    $('game-loading-message').textContent = '正在连接世界并准备画面'
    const [entry, { startGame }] = await Promise.all([openMap(id), import('./main')])
    $('game-loading-message').textContent = '正在读取地图与场景缓存'
    await startGame(entry)
    $('game-loading').hidden = true
    $('obs-view').hidden = false
  } catch (error) {
    $('game-loading-title').textContent = '小镇加载失败'
    $('game-loading-message').textContent =
      error instanceof Error ? errorText(error) : '请重新加载，或返回小镇列表。'
    const retry = $('game-retry')
    retry.hidden = false
    retry.onclick = () => location.reload()
  }
}
