import type { Appearance } from 'town-shared/props/types'
/** 这些区域类型不在地图上写名字 */
export const unlabeledRegions = new Set(['road'])
const appearances: Record<string, Appearance> = {
  'core:bed@1': { glyph: 'bed', color: '#b79a70' },
  'core:bed@2': { glyph: 'bed', color: '#b79a70' },
  'core:reading_desk@1': { glyph: 'book', color: '#91b297' },
  'core:coffee_machine@1': { glyph: 'machine', color: '#879caa' },
  'core:coffee_machine@2': { glyph: 'machine', color: '#879caa' },
  'core:drinking_water@1': { glyph: 'machine', color: '#80a8b8' },
  'core:medical_kit@1': { glyph: 'box', color: '#b4c9b2' },
  'core:revival_stone@1': { glyph: 'box', color: '#b9a0c5' },
}
for (let i = 1; i <= 11; i++) appearances[`core:book-${i}@1`] = { glyph: 'book', color: '#a5bf9f' }
export function styleAppearance(reference: string): Appearance | undefined {
  return appearances[reference]
}
