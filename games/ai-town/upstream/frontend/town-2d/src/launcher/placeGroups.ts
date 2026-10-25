// 建镇页的地点分组：逐项设置的卡片和一句话规划交给模型的地点表都按这份名单。
// 模板里还有旋转亭、神庙遗迹、阶台、摩天轮、方尖碑，它们孤零零杵在草地上、体量比民房还大，已经下架，
// 名单里不列，模型也就不会用。建镇服务经 scripts/mapgen/plan.mjs 直接引用本文件，所以这里不能有运行时 import。
export const PLACE_GROUPS = [
  {
    id: 'everyday',
    name: '住宅与公共建筑',
    hint: '住宅和日常服务可按需重复',
    kinds: [
      'home',
      'townhall',
      'warehouse',
      'inn',
      'hotel',
      'library',
      'colonnade',
      'clinic',
      'canteen',
      'cafe',
      'workshop',
      'club',
    ],
  },
  {
    id: 'landmarks',
    name: '地标与游乐设施',
    hint: '',
    kinds: ['theatre', 'lighthouse', 'fountain'],
  },
  {
    id: 'outdoor',
    name: '户外空间',
    hint: '用来组织街区与居民活动',
    kinds: ['plaza', 'garden', 'park', 'market', 'harbor', 'area'],
  },
] as const

/** 建镇页能选的地点种类，按卡片顺序 */
export const OFFERED_KINDS: readonly string[] = PLACE_GROUPS.flatMap((g) => g.kinds)
