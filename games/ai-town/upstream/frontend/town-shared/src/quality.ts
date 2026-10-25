// 地图画质：只影响本机画面，存在浏览器里。「自动」在触屏设备上用「中」，省电、不容易发热。
import { isTouch } from './platform'

export type QualityChoice = 'auto' | 'high' | 'mid' | 'low'
export type Quality = Exclude<QualityChoice, 'auto'>

const KEY = 'town-2d:hd-quality'
const CHOICES: QualityChoice[] = ['auto', 'high', 'mid', 'low']

export const qualityLabels: Record<QualityChoice, string> = {
  auto: '自动',
  high: '高',
  mid: '中',
  low: '低',
}
export const qualityNotes: Record<QualityChoice, string> = {
  auto: '按设备选：手机、平板用「中」，电脑用「高」',
  high: '最高 2 倍分辨率，阴影、泛光、移轴模糊都开',
  mid: '最高 1.5 倍分辨率，效果照常',
  low: '1 倍分辨率，关掉泛光和移轴模糊；像素画面几乎看不出差别，最省电',
}

export function storedQuality(): QualityChoice {
  try {
    const value = localStorage.getItem(KEY) as QualityChoice | null
    return value && CHOICES.includes(value) ? value : 'auto'
  } catch {
    return 'auto'
  }
}

export function saveQuality(choice: QualityChoice) {
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    // 存储不可用时只本次生效
  }
}

/** 实际用的档位 */
export function effectiveQuality(choice = storedQuality()): Quality {
  return choice === 'auto' ? (isTouch() ? 'mid' : 'high') : choice
}

/** 这一档的像素比上限 */
export function pixelRatioCap(quality: Quality) {
  return quality === 'high' ? 2 : quality === 'mid' ? 1.5 : 1
}
