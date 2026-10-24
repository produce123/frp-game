import { coversAllDraws, waitingTiles } from '../lotusRules'
import { BLOOD_FLOW_CONFIG } from './config'
import { forecastWinIncome, unseenCounts } from './incomeForecast'
import { postKongState } from './kongState'
import { visibleTiles, type BloodFlowSeatView } from './seatView'
import type { BloodFlowAction } from './state'

/** 任意听的确定杠开：不读取未来牌墙，逐张检查本座不可见的补牌。 */
export function preferredAnyWaitKong(view: BloodFlowSeatView, actions: readonly BloodFlowAction[]) {
  if (view.window?.kind !== 'turn' || view.window.source.kind !== 'draw' || view.wallCount <= 0) return null
  const kongs = actions.filter(action => action.kind === 'concealed-kong' || action.kind === 'wind-kong')
  if (!kongs.length) return null
  const player = view.players[view.seat]
  const before = player.hand.filter((_, index) => index !== player.drawnTileIndex)
  const counts = unseenCounts(visibleTiles(view)).filter(entry => entry.count > 0)
  const unseen = counts.reduce((sum, entry) => sum + entry.count, 0)
  if (!unseen) return null
  const current = view.ownActions.some(action => action.kind === 'win') ? view.ownScore : null
  const immediateWin = (current?.paymentPerPayer ?? 0) * 3
  const normalWin = current ? forecastWinIncome(before, player.melds, view.jokers, view.window.source.tile, 'self-draw') : 0
  let best: { action: BloodFlowAction; income: number } | null = null
  for (const action of kongs) {
    // 暗杠/风杠不能被抢；补杠需要另算抢杠风险，不使用这一保证杠开的策略。
    if (action.kind !== 'concealed-kong' && action.kind !== 'wind-kong') continue
    const post = postKongState({ kind: action.kind, hand: player.hand, melds: player.melds,
      tile: action.kind === 'concealed-kong' ? action.tile : undefined })
    if (!post || !coversAllDraws(waitingTiles(post.hand, post.melds.length, view.jokers),
      [...post.hand, ...post.melds.flatMap(m => m.tiles)])) continue
    let bloom = 0, safe = true
    for (const { tile, count } of counts) {
      const after = forecastWinIncome(post.hand, post.melds, view.jokers, tile, 'self-draw')
      const replacement = forecastWinIncome(post.hand, post.melds, view.jokers, tile, 'kong-bloom')
      // 平时保护后续续胡的牌型收益；仅剩末张时，只比较这次杠开的期望收益。
      const baseline = Math.max(normalWin, forecastWinIncome(before, player.melds, view.jokers, tile, 'self-draw'))
      if (!replacement || (view.wallCount > 1 && after < baseline)) {
        safe = false; break
      }
      bloom += count / unseen * replacement
    }
    if (!safe) continue
    const payment = action.kind === 'wind-kong' ? 'wind' : 'concealed'
    const income = bloom + BLOOD_FLOW_CONFIG.basePoints * BLOOD_FLOW_CONFIG.kongPayments[payment] * 3
    if (income < immediateWin) continue
    if (!best || income > best.income) best = { action, income }
  }
  return best?.action ?? null
}
