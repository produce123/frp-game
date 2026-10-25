// 道具动作的时长与效果说明换成按小时的写法。服务端的原文同时给村民 Agent 看，这里只改界面显示。

/** 每分钟的量换算成每小时：不小于 1 取整数，小于 1 保留一位小数 */
export function perHour(perMinute: number): string {
  const hourly = perMinute * 60
  return hourly >= 1 ? String(Math.round(hourly)) : String(Number(hourly.toFixed(1)))
}

/** 能整除小时的写「8 小时」，其余写分钟 */
export function durationText(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`
}

/** 「精力每分钟恢复 0.15625 点，…」改成「每小时恢复约 9 点精力，…」；其他说明原样返回 */
export function effectText(text: string): string {
  return text.replace(/^(.+?)每分钟恢复 ([\d.]+) 点/, (_, need: string, value: string) => {
    const hourly = perHour(Number(value))
    const rounded = Math.abs(Number(hourly) - Number(value) * 60) > 1e-9
    return `每小时恢复${rounded ? '约' : ''} ${hourly} 点${need}`
  })
}

/** 每个动作都成立的通用条件：不提供信息，界面不显示 */
const commonConditions = new Set([
  '道具在当前地点或本人背包中',
  '道具未被其他居民占用',
  '完成规定时长',
])

/** 只留真正限制使用的条件（供餐时段、自己的住宅、施用对象） */
export function limitTexts(conditions: string[]): string[] {
  return conditions.filter((c) => !commonConditions.has(c))
}

/** 服务端「结果」说明同时给 Agent 看，口吻偏系统；界面上换成玩家读得懂的话。空串表示没有值得显示的内容 */
const resultCopy: Record<string, string> = {
  '记录实际进行的活动；没有额外物品产出': '',
  记录餐次与菜单: '',
  '只记录查询活动，目前没有具体查询资料': '居民会在这里查阅资料，暂时没有可读的具体内容。',
  '完成后可访问这本书的正文；记忆由本人决定': '读完后可以翻阅全文，是否记住由居民自己决定。',
  完成后可访问这条公告的正文: '读完后可以看到公告全文。',
  '提交书名、正文，完成后在此处生成书籍': '写完后，这本书会留在这里。',
}

export function resultText(text: string): string {
  return text in resultCopy ? resultCopy[text] : text
}
