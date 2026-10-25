import type { BuildingKind } from '../buildings'

/** 室内北墙和隔墙：墙纸两色竖条、下半截护墙板、线脚和踢脚线 */
export interface InteriorPalette {
  paper: string
  stripe: string
  panel: string
  trim: string
}

/** 各功能房间里的颜色和地板；陈设的画法在 hd2d/interior.ts，地板的画法在 pixel/terrain.ts */
export interface InteriorColors {
  walls: Record<BuildingKind, InteriorPalette>
  /** 住处和会客的地方中间铺的地毯；不在表里的不铺 */
  rugs: Partial<Record<BuildingKind, string>>
  /** 地板：住处木地板，图书馆深色木地板，诊所白瓷砖，食堂和咖啡馆棋盘格，工坊和仓库粗木板，
   *  公所石板，其余陶砖 */
  floors: Record<
    BuildingKind,
    'wood' | 'darkwood' | 'tile' | 'checker' | 'rough' | 'stone' | 'terracotta'
  >
}

/** 目前三种风格共用的一套 */
export const INTERIORS: InteriorColors = {
  walls: {
    home: { paper: '#e9dcc0', stripe: '#e0cfae', panel: '#8c6444', trim: '#5e4230' },
    townhall: { paper: '#d6d0c0', stripe: '#cdc6b4', panel: '#566480', trim: '#39445a' },
    library: { paper: '#8a7458', stripe: '#806b50', panel: '#5a3f2c', trim: '#3e2a1c' },
    colonnade: { paper: '#dcd4c0', stripe: '#d2c9b3', panel: '#8e887c', trim: '#5e5950' },
    clinic: { paper: '#eef2f0', stripe: '#e4ebe8', panel: '#cfe3e0', trim: '#9ab8b4' },
    canteen: { paper: '#e8d6b0', stripe: '#dfcaa0', panel: '#a4583e', trim: '#6f3028' },
    cafe: { paper: '#f0dada', stripe: '#e6c8c8', panel: '#4f7a6a', trim: '#34554a' },
    shop: { paper: '#e6d7b5', stripe: '#dccaa2', panel: '#8a6a44', trim: '#5e442f' },
    workshop: { paper: '#b08a62', stripe: '#a47e58', panel: '#7a5a3c', trim: '#4e3826' },
    warehouse: { paper: '#8f806c', stripe: '#857662', panel: '#6a5c4a', trim: '#443a2e' },
    inn: { paper: '#dfe3cf', stripe: '#d4d9c2', panel: '#6b4a34', trim: '#452f22' },
    hotel: { paper: '#e3ecdf', stripe: '#d6e2d0', panel: '#2f5a50', trim: '#1f3d36' },
    club: { paper: '#5b4a6a', stripe: '#6a5779', panel: '#3a2e44', trim: '#26202e' },
    theatre: { paper: '#6a2a2e', stripe: '#5e2428', panel: '#3a1a1c', trim: '#c9a04e' },
    lighthouse: { paper: '#dfe7ee', stripe: '#d2dde6', panel: '#44566e', trim: '#2c3a4c' },
  },
  rugs: {
    home: '#8e3f33',
    inn: '#5b7352',
    hotel: '#2f5a50',
    club: '#6a5779',
    townhall: '#44566e',
    library: '#6f3028',
    theatre: '#8a2830',
  },
  floors: {
    home: 'wood',
    library: 'darkwood',
    colonnade: 'darkwood',
    clinic: 'tile',
    canteen: 'checker',
    cafe: 'checker',
    workshop: 'rough',
    warehouse: 'rough',
    townhall: 'stone',
    shop: 'terracotta',
    inn: 'terracotta',
    club: 'terracotta',
    theatre: 'terracotta',
    hotel: 'terracotta',
    lighthouse: 'terracotta',
  },
}
