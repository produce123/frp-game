// 花费估算：按服务商公布的价格（元 / 百万 token，按高峰时段取，宁高勿低）把用量换成钱。
// 只收录在官方价格页核实过的服务；没收录的服务界面上写「价格没有收录」，不猜。
// 价格会变：核实日期写在每一项旁边，变了改这里。
import type { ModelChoice } from './protocol'

/** 元 / 百万 token：缓存命中的输入、没命中的输入、输出 */
export interface Price {
  hit: number
  miss: number
  out: number
}

/** 服务 → 模型名里包含的关键字 → 价格；关键字为空的是这家服务的默认 */
const PRICES: Record<string, { match: string; price: Price }[]> = {
  // 内置模型在这台设备上跑，不花钱
  builtin: [{ match: '', price: { hit: 0, miss: 0, out: 0 } }],
  // api-docs.deepseek.com/zh-cn/quick_start/pricing，2026-10-05：flash 与旧名 deepseek-chat 同价；v4-pro 另算
  deepseek: [
    { match: 'pro', price: { hit: 0.3, miss: 9, out: 27 } },
    { match: '', price: { hit: 0.04, miss: 2, out: 8 } },
  ],
  // platform.kimi.com/docs/pricing/chat，2026-10-05：K3 另有缓存写入费，这里并进没命中的输入
  kimi: [
    { match: 'k3', price: { hit: 2, miss: 20, out: 100 } },
    { match: 'k2', price: { hit: 1.1, miss: 6.5, out: 27 } },
  ],
}

export function priceOf(choice: ModelChoice | null | undefined): Price | null {
  if (!choice) return null
  const model = choice.model.toLowerCase()
  return PRICES[choice.provider]?.find((p) => model.includes(p.match))?.price ?? null
}

/** 一段用量大约多少钱（元）。输出 token = 总数减输入，总数里含还没回来的请求预留，所以偏高一点 */
export function costOf(price: Price, usage: { input: number; hit: number; total: number }): number {
  const hit = Math.min(usage.hit, usage.input)
  const out = Math.max(0, usage.total - usage.input)
  return (hit * price.hit + (usage.input - hit) * price.miss + out * price.out) / 1e6
}

/** 实测：3 位村民玩一小时大约 820 万输入 token（八成七命中缓存）、30 万输出 token。
 *  那时没人等回复就快进；现在走路、交谈都按正常速度，一小时里的决定少了，按这个估偏高 */
const HOUR_OF_THREE = { input: 8.2e6, hit: 7.1e6, total: 8.5e6 }

/** 3 位村民玩一小时的大概花费，写成「¥2–5」；村民闲的时候少一半 */
export function hourRange(price: Price): string {
  const high = costOf(price, HOUR_OF_THREE)
  return roughRange(high / 2, high)
}

function roughRange(low: number, high: number) {
  if (high < 1) return '不到 ¥1'
  const step = high >= 20 ? 10 : 1
  const lo = Math.max(step === 1 ? 1 : 10, Math.floor(low / step) * step)
  const hi = Math.ceil(high / step) * step
  return lo >= hi ? `¥${hi}` : `¥${lo}–${hi}`
}

/** 金额：不到一分钱写「不到 ¥0.01」，其余保留两位 */
export function yuan(value: number): string {
  if (value <= 0) return '¥0'
  if (value < 0.01) return '不到 ¥0.01'
  return `¥${value.toFixed(2)}`
}

/** 每百万 token 大约多少钱：用来在「最多花多少」和 token 额度之间换算，按上面实测的用量比例 */
export function blendedPerMillion(price: Price): number {
  return (costOf(price, HOUR_OF_THREE) / HOUR_OF_THREE.total) * 1e6
}
