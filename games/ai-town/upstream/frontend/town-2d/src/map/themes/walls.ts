import type { WallStyle } from '../buildings'

type Shades = readonly [string, string, string]

/** 墙面材质的颜色；画法（砖缝、木纹、波纹、补丁）在 hd2d/textures.ts。风格包用 MapTheme.walls 选用 */
export interface WallColors {
  /** 各材质的三档底色，中间一档也是山墙和掀开屋顶后外墙的颜色 */
  shades: Record<WallStyle, Shades>
  /** 刷漆木板房按房子编号挑一种漆色 */
  paints: readonly Shades[]
  /** 集装箱按房子编号挑一种漆色 */
  containers: readonly Shades[]
  /** 铁皮墙、集装箱、拼板墙和铁皮屋顶上的锈 */
  rust: Shades
  /** 木墙的木纹、竖木板的板缝、砖缝、石缝 */
  woodGrain: string
  plankGap: string
  brickMortar: string
  stoneMortar: string
  /** 水泥墙从墙顶往下的水渍、裂缝、补过的两色灰浆 */
  concreteStain: string
  concreteCrack: string
  concretePatch: readonly [string, string]
  /** 拼板墙的板缝和另外两种板：刷绿漆的板、木板（另两种是铁皮底色和锈） */
  scrapSeam: string
  scrapBoards: readonly [Shades, Shades]
  /** 灰泥墙的木框架、刷漆木板房两头和檐下的白色包边 */
  timber: string
  trim: string
}

/** 目前三种风格共用的一套 */
export const WALL_COLORS: WallColors = {
  shades: {
    plaster: ['#e6dcc6', '#ddd2ba', '#d4c8ae'],
    wood: ['#9a7550', '#8c6a47', '#a47e58'],
    stone: ['#b7b1a4', '#a9a395', '#c2bcae'],
    brick: ['#a8614a', '#9b5741', '#b36b53'],
    clean: ['#eeebe3', '#e6e2d8', '#f3f1ea'],
    pastel: ['#e8cbc0', '#e0bfb4', '#eed5cc'],
    plank: ['#7e6448', '#735a40', '#8a6e50'],
    tin: ['#8a8e8e', '#74787a', '#a3a7a5'],
    container: ['#8a3a2a', '#7a3224', '#9a4632'],
    concrete: ['#8c8880', '#7e7a72', '#99958c'],
    scrap: ['#6c706e', '#5c6062', '#7a7e7c'],
    painted: ['#9a3a2e', '#8a2e24', '#a8463a'],
  },
  // 北欧红、赭黄、灰蓝、奶白、墨绿
  paints: [
    ['#9a3a2e', '#8a2e24', '#a8463a'],
    ['#c49446', '#b8893a', '#cc9e52'],
    ['#4a6886', '#3e5a78', '#56769a'],
    ['#ddd6c6', '#d4ccbc', '#e4dece'],
    ['#56785a', '#4a6a4e', '#628466'],
  ],
  // 锈红、褪色的蓝、军绿
  containers: [
    ['#8a3a2a', '#7a3224', '#9a4632'],
    ['#3e5e7a', '#34506a', '#4a6c88'],
    ['#4e6a4a', '#425a3e', '#5a7856'],
  ],
  rust: ['#6e3a1e', '#8a4a24', '#a55f2e'],
  woodGrain: '#5f452f',
  plankGap: '#4e3a28',
  brickMortar: '#7b4535',
  stoneMortar: '#8a8478',
  concreteStain: '#5e5a54',
  concreteCrack: '#57534c',
  concretePatch: ['#8a6a4a', '#9a7856'],
  scrapSeam: '#3a3632',
  scrapBoards: [
    ['#4f6a5a', '#5f7a68', '#6a8672'],
    ['#7a5a3a', '#6a4c30', '#8a6844'],
  ],
  timber: '#6b4b34',
  trim: '#ece8e0',
}
