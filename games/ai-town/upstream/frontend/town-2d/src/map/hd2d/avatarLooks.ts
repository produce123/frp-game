import { closestColor } from 'town-shared/avatar/looks'
import type { Look } from './villagerSprite'
import { CLOTH_CREAM, CLOTH_WHITE } from '../palette'

// 化身可挑的几套像素小人。协议里化身只有一个颜色，每套对应一个固定颜色，
// 上衣就用这个颜色。发色和上衣色都不在村民用的颜色里，不会和村民撞脸。

const WHITE = CLOTH_WHITE
const CREAM = CLOTH_CREAM

// prettier-ignore
const LOOKS: readonly { color: string; look: Look }[] = [
  { color: '#387963', look: { hair: 'short', h: '#4a3228', e: '#4c9a6a', outfit: 'jacket', t: '#387963', c: CREAM, q: '#4a4a50' } },
  { color: '#b4691e', look: { hair: 'ponytail', x: '#f0d060', h: '#7a3a2a', e: '#c07a30', outfit: 'coat', t: '#b4691e', c: WHITE, q: '#3a3a44' } },
  { color: '#5f6f95', look: { hair: 'bob', h: '#e0c080', e: '#4c77da', outfit: 'cardigan', t: '#5f6f95', c: WHITE, q: '#3c3a4a' } },
  { color: '#a33d2b', look: { hair: 'spiky', h: '#1f2230', e: '#6a4a2a', outfit: 'jacket', t: '#a33d2b', c: '#f0e0c0', q: '#3a3a40' } },
  { color: '#8b6d3a', look: { hair: 'crop', hat: true, h: '#5a4030', e: '#5a4a3a', outfit: 'coat', t: '#8b6d3a', c: CREAM, q: '#4a4a44' } },
  { color: '#6b4d8a', look: { hair: 'twintail', x: '#e0c050', h: '#b05848', e: '#8a70b0', outfit: 'dress', t: '#6b4d8a', c: WHITE, a: '#e0c050', q: '#3a3a44' } },
  { color: '#2f7f8f', look: { hair: 'split', h: '#34405e', e: '#4a7a9a', outfit: 'jacket', t: '#2f7f8f', c: WHITE, q: '#3a3a44' } },
  { color: '#b0506e', look: { hair: 'bun', clip: true, x: '#f0d060', h: '#3a2a3a', e: '#6a5a8a', outfit: 'cardigan', t: '#b0506e', c: WHITE, q: '#3a3a44' } },
]

export const AVATAR_COLORS = LOOKS.map((l) => l.color)
const PREFIX = 'avatar-look:'

/** 化身颜色 → 长相编号；不是这几种颜色时取最接近的一套 */
export function avatarLookKey(color: string) {
  return PREFIX + closestColor(AVATAR_COLORS, color)
}

export function avatarLook(key: string): Look | undefined {
  return key.startsWith(PREFIX) ? LOOKS[Number(key.slice(PREFIX.length))]?.look : undefined
}
