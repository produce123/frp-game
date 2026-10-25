// 一句话建镇时模型给的世界观建议：第一次进这个小镇时开局向导和首次对话框默认用它。
// 建议和小镇一起存在管理服务那边（creation.json，随小镇条目发来），换设备、换成 mac 版也还在；
// 更早建的小镇只记在当时那台设备的本地存储里，照旧读。
import type { TownCreation } from './mapDocument'

const key = (town: string) => `town:worldview:${town}`
const fromTown = new Map<string, string>()

/** 进小镇时登记它条目里带的建镇说明 */
export function useTownCreation(town: string, creation: TownCreation | null | undefined) {
  if (creation?.worldview.trim()) fromTown.set(town, creation.worldview.trim())
}

/** 建镇时的世界观建议；没有时为空串 */
export function townWorldview(town: string): string {
  const stored = fromTown.get(town)
  if (stored) return stored
  try {
    return localStorage.getItem(key(town)) ?? ''
  } catch {
    return ''
  }
}
