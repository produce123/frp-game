// 调用额度页的大数字：显示时整万写成「200 万」，其余带千分位；输入接受纯数字、千分位和「万」。

/** 输入框里显示的写法 */
export function formatLimit(value: number): string {
  if (value >= 10000 && value % 10000 === 0) return `${(value / 10000).toLocaleString('en-US')} 万`
  return value.toLocaleString('en-US')
}

/** 用量这类不需要精确的数字：一万以上折成「48 万」「3.2 万」 */
export function roughCount(value: number): string {
  if (value < 10000) return value.toLocaleString('en-US')
  const wan = value / 10000
  return `${Number(wan.toFixed(wan < 100 ? 1 : 0)).toLocaleString('en-US')} 万`
}

/** 读输入框：去掉空格和千分位逗号，末尾「万」乘一万；读不出来返回 NaN */
export function parseLimit(text: string): number {
  const plain = text.replace(/[\s,，]/g, '')
  const match = /^(\d+(?:\.\d+)?)(万?)$/.exec(plain)
  if (!match) return NaN
  const value = Number(match[1]) * (match[2] ? 10000 : 1)
  return Math.round(value * 1e6) / 1e6
}
