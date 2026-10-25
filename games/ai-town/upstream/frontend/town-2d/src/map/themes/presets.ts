// 地图风格名单：建镇参数 environment.preset 的取值和建镇页上的风格卡片。
// 前端按它挑风格包（themes/index.ts），建镇服务按它校验参数：scripts/mapgen/spec.mjs 直接引用本文件，
// 所以这里不能有运行时 import。加一种风格：这里加一项，再在 themes/ 里写风格包并登记到 index.ts。
export const STYLE_PRESETS = [
  {
    id: 'coastal-village',
    /** 对应的风格包 */
    theme: 'village',
    name: '海岸乡镇',
    description: '山水地形、住宅与公共建筑',
    /** 建镇页卡片上的图标和底色 */
    icon: '⌂',
    swatch: 'rgba(126, 170, 132, 0.25)',
  },
  {
    id: 'wasteland',
    theme: 'wasteland',
    name: '末日废土',
    description: '干海床、铁皮房与搁浅的锈船',
    icon: '⌂',
    swatch: 'rgba(176, 134, 92, 0.22)',
  },
  {
    id: 'frozen',
    theme: 'frozen',
    name: '冰封雪镇',
    description: '冰原、雪松与冻住的港口',
    icon: '❄',
    swatch: 'rgba(156, 192, 222, 0.24)',
  },
] as const

export type ThemeId = (typeof STYLE_PRESETS)[number]['theme']

/** 没有预设的默认小镇和旧存档用的风格 */
export const DEFAULT_PRESET = STYLE_PRESETS[0]
