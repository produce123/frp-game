// 捏人：挑发型、衣服、颜色（头发可以渐变到另一种发梢色）、头上脸上的配件，再在 4×4 小格里点出衣服上的花纹；
// 也能一键换一整套奇特形象。
// 四个朝向和走路都用游戏的像素画法出（town-2d 的 villagerSprite.ts，经 portraits.ts 登记进来），
// 这里只管挑选和预览。色板与「用模型生成」人物时的可选项一致（crates/agent/src/looks.rs）。
import { button, el } from '../dom'
import { villagerArt, type Facing, type VillagerArt } from '../portraits'
import type {
  BeardStyle,
  FaceGear,
  HairStyle,
  Headwear,
  HeldItem,
  Outfit,
  VillagerLook,
} from '../protocol'
import './look.css'

const WHITE = '#f4f6f4'
const CREAM = '#ece4d2'

const HAIRS: [HairStyle, string][] = [
  ['short', '短发'],
  ['spiky', '刺头'],
  ['split', '中分'],
  ['crop', '寸头'],
  ['bob', '齐耳'],
  ['long', '长发'],
  ['parted', '中分长'],
  ['bun', '丸子'],
  ['ponytail', '马尾'],
  ['twintail', '双马尾'],
  ['afro', '爆炸头'],
  ['mohawk', '莫西干'],
  ['bald', '光头'],
  ['twin_buns', '双髻'],
  ['curls', '螺发'],
  ['scallion', '大葱头'],
  ['m_bangs', 'M刘海'],
  ['m_long', 'M刘海长发'],
]
/** 随机一套只从日常的发型里挑 */
const ODD_HAIRS: HairStyle[] = ['afro', 'mohawk', 'bald', 'twin_buns', 'curls', 'scallion']
const OUTFITS: [Outfit, string][] = [
  ['jacket', '夹克'],
  ['coat', '大衣'],
  ['suit', '西装'],
  ['overalls', '背带裤'],
  ['tee', '短袖'],
  ['hoodie', '卫衣'],
  ['cardigan', '开衫裙'],
  ['dress', '连衣裙'],
  ['apron', '围裙'],
  ['book', '抱书'],
  ['bikini', '比基尼'],
  ['swim_trunks', '泳裤'],
]
/** 随机一套不挑泳装 */
const SWIMWEAR: Outfit[] = ['bikini', 'swim_trunks']
const COSTUMES: [Outfit, string][] = [
  ['robe', '长袍'],
  ['clown', '小丑服'],
  ['space', '宇航服'],
  ['armor', '盔甲'],
  ['skeleton', '骷髅服'],
  ['tiger_skirt', '虎皮裙'],
  ['bellyband', '肚兜'],
  ['kasaya', '袈裟'],
  ['general', '将军甲'],
]
/** 头上戴的：草帽是单独的开关，和其余几样只能戴一样 */
type HeadChoice = 'none' | 'straw' | Headwear
const HEADWEARS: [HeadChoice, string][] = [
  ['none', '不戴'],
  ['straw', '草帽'],
  ['top_hat', '礼帽'],
  ['wizard_hat', '巫师帽'],
  ['chef_hat', '厨师帽'],
  ['crown', '王冠'],
  ['halo', '光环'],
  ['cat_ears', '猫耳'],
  ['bunny_ears', '兔耳'],
  ['horns', '恶魔角'],
  ['antennae', '触角'],
  ['circlet', '紧箍'],
  ['pig_ears', '猪耳朵'],
  ['aureole', '佛光'],
  ['scholar_cap', '纶巾'],
  ['topknot_crown', '束发冠'],
  ['feather_crown', '翎冠'],
  ['official_hat', '官帽'],
]
const FACES: ['none' | FaceGear, string][] = [
  ['none', '不戴'],
  ['glasses', '眼镜'],
  ['sunglasses', '墨镜'],
  ['eye_patch', '眼罩'],
  ['clown_nose', '红鼻子'],
  ['monkey_face', '猴脸'],
  ['pig_snout', '猪鼻子'],
  ['forehead_dot', '眉心红点'],
]
const headOf = (look: VillagerLook): HeadChoice => (look.hat ? 'straw' : (look.headwear ?? 'none'))
function withHead(look: VillagerLook, head: HeadChoice): VillagerLook {
  const next = { ...look }
  delete next.hat
  delete next.headwear
  if (head === 'straw') next.hat = true
  else if (head !== 'none') next.headwear = head
  return next
}
/** 胡子：络腮胡是单独的开关，和其余几种只能留一样 */
type BeardChoice = 'none' | 'full' | BeardStyle
const BEARDS: [BeardChoice, string][] = [
  ['none', '不留'],
  ['full', '络腮胡'],
  ['long', '长须'],
  ['bushy', '虬髯'],
  ['goatee', '山羊胡'],
]
const beardOf = (look: VillagerLook): BeardChoice =>
  look.beard ? 'full' : (look.beard_style ?? 'none')
function withBeard(look: VillagerLook, beard: BeardChoice): VillagerLook {
  const next = { ...look }
  delete next.beard
  delete next.beard_style
  if (beard === 'full') next.beard = true
  else if (beard !== 'none') next.beard_style = beard
  return next
}
const HELD: ['none' | HeldItem, string][] = [
  ['none', '空手'],
  ['fan', '羽扇'],
  ['guandao', '偃月刀'],
  ['snake_spear', '蛇矛'],
  ['spear', '长枪'],
  ['halberd', '画戟'],
  ['golden_staff', '金箍棒'],
  ['rake', '钉耙'],
]
function withHeld(look: VillagerLook, held: 'none' | HeldItem): VillagerLook {
  const next = { ...look }
  if (held === 'none') delete next.held
  else next.held = held
  return next
}
function withFace(look: VillagerLook, face: 'none' | FaceGear): VillagerLook {
  const next = { ...look }
  if (face === 'none') delete next.face
  else next.face = face
  return next
}

type ColorKey =
  'hair_color' | 'hair_tip' | 'eye_color' | 'skin' | 'top' | 'apron' | 'bottom' | 'accent'
interface ColorRow {
  key: ColorKey
  label: string
  colors: [string, string][]
  /** 只在这种衣服下出现 */
  outfit?: Outfit
}
const HAIR_COLORS: [string, string][] = [
  ['#2a2626', '黑'],
  ['#3e3a4c', '紫黑'],
  ['#5a3626', '深棕'],
  ['#7a4a2e', '栗色'],
  ['#9a5e34', '棕'],
  ['#c89060', '浅棕'],
  ['#d8a040', '金'],
  ['#c0bab0', '灰白'],
  ['#eeece6', '雪白'],
  ['#c8463a', '红'],
  ['#e890b0', '粉'],
  ['#4a7ad8', '蓝'],
  ['#4aa86a', '绿'],
  ['#8a5ac8', '紫'],
]
/** 发梢渐变的「不渐变」：色块写「无」，选了就去掉 hair_tip */
const NO_TIP = ''
const COLOR_ROWS: ColorRow[] = [
  { key: 'hair_color', label: '发色', colors: HAIR_COLORS },
  { key: 'hair_tip', label: '发梢渐变', colors: [[NO_TIP, '不渐变'], ...HAIR_COLORS] },
  {
    key: 'eye_color',
    label: '眼睛',
    colors: [
      ['#4c77da', '蓝'],
      ['#c07a30', '琥珀'],
      ['#4c9a6a', '绿'],
      ['#8a70b0', '紫'],
      ['#6a4a2a', '棕'],
      ['#e0c050', '金'],
      ['#d83a3a', '红'],
    ],
  },
  {
    key: 'skin',
    label: '肤色',
    colors: [
      ['#f6ece0', '白皙'],
      ['#ecd4bc', '小麦'],
      ['#d9a77c', '健康'],
      ['#a8714d', '深色'],
      ['#fbfaf6', '雪白'],
      ['#9fd68a', '绿'],
      ['#9cc4ec', '蓝'],
      ['#c4a8e0', '紫'],
      ['#b4b8bc', '灰'],
      ['#f2bfb2', '粉'],
      ['#e6c068', '金'],
      ['#c0503e', '枣红'],
      ['#8a6250', '黝黑'],
    ],
  },
  {
    key: 'top',
    label: '上衣',
    colors: [
      ['#3c4a7a', '藏青'],
      ['#58b078', '草绿'],
      ['#52b8aa', '青绿'],
      ['#d8883a', '橙'],
      ['#c88a8e', '粉'],
      ['#8a70b0', '紫'],
      ['#b07a5a', '棕'],
      ['#86826e', '灰绿'],
      ['#e8c070', '鹅黄'],
      [WHITE, '白'],
      ['#d84a3a', '红'],
      ['#2e2e36', '黑'],
      ['#aab2ba', '银灰'],
    ],
  },
  {
    key: 'apron',
    label: '围裙',
    outfit: 'apron',
    colors: [
      [CREAM, '米白'],
      ['#58b078', '绿'],
      ['#d8883a', '橙'],
      ['#7aa09a', '灰青'],
      ['#c8a868', '卡其'],
      ['#8a6a48', '棕'],
      ['#aaa2b6', '灰紫'],
    ],
  },
  {
    key: 'bottom',
    label: '下装',
    colors: [
      ['#4a4a50', '深灰'],
      ['#3c4a7a', '藏青'],
      ['#5a4a3a', '棕'],
      ['#6a5a40', '土黄'],
      ['#3a3a44', '黑'],
      ['#7a8a7c', '灰绿'],
      ['#e8e6e0', '白'],
      ['#b8403a', '红'],
      ['#d0a848', '黄'],
    ],
  },
  {
    key: 'accent',
    label: '点缀',
    colors: [
      ['#e44a4e', '红'],
      ['#e8c070', '黄'],
      ['#58b078', '绿'],
      ['#4c77da', '蓝'],
      ['#8a70b0', '紫'],
      [WHITE, '白'],
      ['#2e2e36', '黑'],
    ],
  },
]

type Accessory = 'ahoge' | 'clip' | 'headband'
const ACCESSORIES: [Accessory, string][] = [
  ['ahoge', '呆毛'],
  ['clip', '发卡'],
  ['headband', '头巾'],
]

const PATTERN_PRESETS: [string, string[]][] = [
  ['无', ['....', '....', '....', '....']],
  ['横条', ['####', '....', '####', '....']],
  ['竖条', ['#.#.', '#.#.', '#.#.', '#.#.']],
  ['格子', ['#.#.', '.#.#', '#.#.', '.#.#']],
  ['圆点', ['#...', '....', '..#.', '....']],
  ['小心形', ['#.#.', '###.', '.#..', '....']],
]
const PATTERN_COLORS: [string, string][] = [
  [WHITE, '白'],
  [CREAM, '米白'],
  ['#e44a4e', '红'],
  ['#e8c070', '黄'],
  ['#4c77da', '蓝'],
  ['#2e2e36', '黑'],
  ['#58b078', '绿'],
]
const EMPTY_ROWS = PATTERN_PRESETS[0][1]

const FACINGS: [Facing, string][] = [
  ['down', '正面'],
  ['right', '侧面'],
  ['up', '背面'],
  ['left', '另一侧'],
]
/** 预览走路：每帧这么多毫秒 */
const STEP_MS = 180

const STRIPES = ['####', '....', '####', '....']
/** 一键换上的整套奇特形象；颜色都在色板里 */
// prettier-ignore
const PRESETS: [string, VillagerLook][] = [
  ['小丑', { hair: 'afro', outfit: 'clown', hair_color: '#c8463a', eye_color: '#4c77da', skin: '#fbfaf6', top: '#d84a3a', bottom: '#d0a848', accent: '#4c77da', face: 'clown_nose' }],
  ['外星人', { hair: 'bald', outfit: 'space', hair_color: '#2a2626', eye_color: '#d83a3a', skin: '#9fd68a', top: WHITE, bottom: '#e8e6e0', accent: '#e44a4e', headwear: 'antennae' }],
  ['机器人', { hair: 'bald', outfit: 'armor', hair_color: '#2a2626', eye_color: '#4c77da', skin: '#b4b8bc', top: '#aab2ba', bottom: '#4a4a50', accent: '#e8c070', headwear: 'antennae', face: 'sunglasses' }],
  ['巫师', { hair: 'short', outfit: 'robe', hair_color: '#c0bab0', eye_color: '#8a70b0', skin: '#f6ece0', top: '#8a70b0', bottom: '#3a3a44', accent: '#e8c070', headwear: 'wizard_hat', beard: true }],
  ['海盗', { hair: 'short', outfit: 'jacket', hair_color: '#2a2626', eye_color: '#6a4a2a', skin: '#d9a77c', top: WHITE, bottom: '#3a3a44', accent: '#e44a4e', headband: '#e44a4e', beard: true, face: 'eye_patch', pattern: { on: 'top', color: '#e44a4e', rows: STRIPES } }],
  ['天使', { hair: 'long', outfit: 'robe', hair_color: '#d8a040', eye_color: '#4c77da', skin: '#f6ece0', top: WHITE, bottom: '#e8e6e0', accent: '#e8c070', headwear: 'halo' }],
  ['恶魔', { hair: 'spiky', outfit: 'suit', hair_color: '#2a2626', eye_color: '#d83a3a', skin: '#c4a8e0', top: '#2e2e36', bottom: '#3a3a44', accent: '#e44a4e', headwear: 'horns' }],
  ['国王', { hair: 'short', outfit: 'robe', hair_color: '#d8a040', eye_color: '#4c77da', skin: '#f6ece0', top: '#d84a3a', bottom: '#d0a848', accent: '#4c77da', headwear: 'crown', beard: true }],
  ['骑士', { hair: 'crop', outfit: 'armor', hair_color: '#5a3626', eye_color: '#4c77da', skin: '#ecd4bc', top: '#aab2ba', bottom: '#4a4a50', accent: '#e44a4e' }],
  ['宇航员', { hair: 'short', outfit: 'space', hair_color: '#3e3a4c', eye_color: '#4c77da', skin: '#f6ece0', top: WHITE, bottom: '#e8e6e0', accent: '#e44a4e' }],
  ['骷髅', { hair: 'bald', outfit: 'skeleton', hair_color: '#2a2626', eye_color: '#d83a3a', skin: '#fbfaf6', top: '#2e2e36', bottom: '#3a3a44', accent: WHITE }],
  ['朋克', { hair: 'mohawk', outfit: 'jacket', hair_color: '#e890b0', eye_color: '#6a4a2a', skin: '#f6ece0', top: '#2e2e36', bottom: '#3a3a44', accent: '#e44a4e', face: 'sunglasses' }],
  ['厨师', { hair: 'short', outfit: 'apron', hair_color: '#5a3626', eye_color: '#6a4a2a', skin: '#ecd4bc', top: WHITE, bottom: '#4a4a50', accent: '#e44a4e', apron: CREAM, headwear: 'chef_hat', beard: true }],
  ['猫耳娘', { hair: 'twintail', outfit: 'dress', hair_color: '#e890b0', eye_color: '#e0c050', skin: '#f6ece0', top: '#c88a8e', bottom: '#3a3a44', accent: WHITE, headwear: 'cat_ears' }],
  ['孙悟空', { hair: 'spiky', outfit: 'tiger_skirt', hair_color: '#9a5e34', eye_color: '#e0c050', skin: '#f2bfb2', top: '#e8c070', bottom: '#3a3a44', accent: '#e44a4e', headwear: 'circlet', face: 'monkey_face', held: 'golden_staff' }],
  ['猪八戒', { hair: 'crop', outfit: 'robe', hair_color: '#2a2626', eye_color: '#6a4a2a', skin: '#f2bfb2', top: '#2e2e36', bottom: '#3c4a7a', accent: '#e44a4e', headwear: 'pig_ears', face: 'pig_snout', held: 'rake' }],
  ['哪吒', { hair: 'twin_buns', outfit: 'bellyband', hair_color: '#2a2626', eye_color: '#6a4a2a', skin: '#f6ece0', top: '#d84a3a', bottom: '#e8e6e0', accent: '#e44a4e', face: 'forehead_dot' }],
  ['如来佛', { hair: 'curls', outfit: 'kasaya', hair_color: '#4a7ad8', eye_color: '#6a4a2a', skin: '#e6c068', top: '#d84a3a', bottom: '#d0a848', accent: '#e8c070', headwear: 'aureole', face: 'forehead_dot' }],
  ['唐僧', { hair: 'bald', outfit: 'kasaya', hair_color: '#2a2626', eye_color: '#6a4a2a', skin: '#f6ece0', top: '#d84a3a', bottom: '#d0a848', accent: '#e8c070' }],
  ['诸葛亮', { hair: 'short', outfit: 'robe', hair_color: '#2a2626', eye_color: '#6a4a2a', skin: '#f6ece0', top: WHITE, bottom: '#3a3a44', accent: '#2e2e36', collar: '#2e2e36', headwear: 'scholar_cap', beard_style: 'long', held: 'fan' }],
  ['关羽', { hair: 'short', outfit: 'robe', hair_color: '#2a2626', eye_color: '#6a4a2a', skin: '#c0503e', top: '#58b078', bottom: '#3a3a44', accent: '#58b078', headwear: 'scholar_cap', beard_style: 'long', held: 'guandao' }],
  ['张飞', { hair: 'spiky', outfit: 'general', hair_color: '#2a2626', eye_color: '#6a4a2a', skin: '#8a6250', top: '#2e2e36', bottom: '#3a3a44', accent: '#e44a4e', beard_style: 'bushy', held: 'snake_spear' }],
  ['刘备', { hair: 'short', outfit: 'robe', hair_color: '#2a2626', eye_color: '#6a4a2a', skin: '#f6ece0', top: '#e8c070', bottom: '#d0a848', accent: '#e44a4e', headwear: 'official_hat', beard_style: 'long' }],
  ['曹操', { hair: 'short', outfit: 'robe', hair_color: '#2a2626', eye_color: '#6a4a2a', skin: '#fbfaf6', top: '#2e2e36', bottom: '#3a3a44', accent: '#e44a4e', headwear: 'official_hat', beard_style: 'goatee' }],
  ['周瑜', { hair: 'short', outfit: 'general', hair_color: '#2a2626', eye_color: '#6a4a2a', skin: '#f6ece0', top: '#aab2ba', bottom: '#4a4a50', accent: '#e44a4e', headwear: 'topknot_crown' }],
  ['赵云', { hair: 'short', outfit: 'general', hair_color: '#2a2626', eye_color: '#6a4a2a', skin: '#f6ece0', top: WHITE, bottom: '#e8e6e0', accent: WHITE, headwear: 'topknot_crown', held: 'spear' }],
  ['吕布', { hair: 'short', outfit: 'general', hair_color: '#2a2626', eye_color: '#6a4a2a', skin: '#f6ece0', top: '#e8c070', bottom: '#4a4a50', accent: '#e44a4e', headwear: 'feather_crown', held: 'halberd' }],
]

const pick = <T>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]

/** 随手来一套：日常的发型衣服全挑，颜色都从色板里挑，不戴头饰；花纹留着，那是玩家自己画的 */
function randomLook(keep: VillagerLook): VillagerLook {
  const color = (key: ColorKey) => pick(COLOR_ROWS.find((r) => r.key === key)!.colors)[0]
  const outfit = pick(OUTFITS.filter(([o]) => !SWIMWEAR.includes(o)))[0]
  return {
    hair: pick(HAIRS.filter(([h]) => !ODD_HAIRS.includes(h)))[0],
    outfit,
    hair_color: color('hair_color'),
    eye_color: color('eye_color'),
    skin: keep.skin,
    top: color('top'),
    bottom: color('bottom'),
    accent: color('accent'),
    ...(outfit === 'apron' ? { apron: color('apron') } : {}),
    ...(keep.pattern ? { pattern: keep.pattern } : {}),
  }
}

/** 编辑器还没拿到画法（地图没加载）时的起步长相 */
export const FALLBACK_LOOK: VillagerLook = {
  hair: 'short',
  outfit: 'jacket',
  hair_color: '#5a3626',
  eye_color: '#4c77da',
  skin: '#f6ece0',
  top: '#3c4a7a',
  bottom: '#4a4a50',
  accent: '#e44a4e',
}

/** 编号对应的长相：捏过的照原样，预制村民固定，其余按编号随机 */
export function lookFor(key: string): VillagerLook {
  return villagerArt()?.lookOf(key) ?? structuredClone(FALLBACK_LOOK)
}

function canvas(width: number, height: number, className: string) {
  const c = el('canvas', '', className)
  c.width = width
  c.height = height
  return c
}

/** 缩略图从正面站姿里裁的一块 [x, y, 宽, 高]，放到 23×23 小图的 [x, y]：头上脸上取头肩，衣服取身子。
 *  帧顶留了 6 行给往上竖的头发：发型从帧顶裁起，大葱头的叶子才看得全；其余从头顶上方 3 行裁 */
const HAIR_CROP = [1, 0, 23, 23, 0, 0] as const
const HEAD_CROP = [1, 3, 23, 23, 0, 0] as const
const BODY_CROP = [1, 22, 23, 12, 0, 5] as const
/** 手里拿的：整个人连兵器一起画，缩略图是竖的 */
const FULL_CROP = [0, 3, 25, 31, 0, 0] as const

function thumb(
  art: VillagerArt,
  target: HTMLCanvasElement,
  look: VillagerLook,
  crop: readonly [number, number, number, number, number, number]
) {
  const [w, h] = art.frame
  const frame = canvas(w, h, '')
  art.drawFrame(frame.getContext('2d')!, look, 'down', 0, 0, 0)
  const ctx = target.getContext('2d')!
  ctx.clearRect(0, 0, target.width, target.height)
  ctx.imageSmoothingEnabled = false
  const [sx, sy, sw, sh, dx, dy] = crop
  ctx.drawImage(frame, sx, sy, sw, sh, dx, dy, sw, sh)
}

export interface LookEditor {
  root: HTMLElement
  value(): VillagerLook
  set(look: VillagerLook): void
  /** 页面重新挂上后让预览接着走 */
  wake(): void
}

/** 捏人编辑器：改了就调 onChange；value() 读出当前长相（没画花纹时不带 pattern） */
export function createLookEditor(initial: VillagerLook, onChange: () => void): LookEditor {
  const art = villagerArt()
  let look: VillagerLook = structuredClone(initial)
  /** 每行起步时的颜色不在色板里（预制村民的专属色）时，留一个色块能点回去 */
  let original: VillagerLook = structuredClone(initial)
  const root = el('div', '', 'look-editor')
  if (!art) {
    root.append(el('p', '地图加载后才能捏人', 'dim'))
    return { root, value: () => structuredClone(look), set: (next) => (look = next), wake() {} }
  }
  const [W, H] = art.frame
  const change = (mutate: () => void) => {
    mutate()
    render()
    onChange()
  }

  // ---- 预览：四个朝向原地走 ----
  const stage = el('div', '', 'look-stage')
  const previews = FACINGS.map(([facing, label]) => {
    const c = canvas(W, H, 'look-sprite')
    const fig = el('figure')
    fig.append(c, el('figcaption', label))
    stage.append(fig)
    return { facing, c }
  })
  const random = button('随机一套', () => change(() => (look = randomLook(look))))
  random.className = 'look-random'

  // ---- 发型、衣服：缩略图按当前颜色画 ----
  const hairButtons = HAIRS.map(([hair, label]) => {
    const c = canvas(23, 23, 'look-thumb')
    const b = button('', () => change(() => (look.hair = hair)))
    b.className = 'look-option'
    b.append(c, el('span', label))
    return { hair, b, c }
  })
  const outfitButtons = [...OUTFITS, ...COSTUMES].map(([outfit, label]) => {
    const c = canvas(23, 23, 'look-thumb')
    const b = button('', () =>
      change(() => {
        look.outfit = outfit
        if (outfit !== 'apron') delete look.apron
      })
    )
    b.className = 'look-option'
    b.append(c, el('span', label))
    return { outfit, b, c }
  })
  // ---- 头上、脸上：缩略图画的是戴上以后的头 ----
  const headButtons = HEADWEARS.map(([head, label]) => {
    const c = canvas(23, 23, 'look-thumb')
    const b = button('', () => change(() => (look = withHead(look, head))))
    b.className = 'look-option'
    b.append(c, el('span', label))
    return { head, b, c }
  })
  const faceButtons = FACES.map(([face, label]) => {
    const c = canvas(23, 23, 'look-thumb')
    const b = button('', () => change(() => (look = withFace(look, face))))
    b.className = 'look-option'
    b.append(c, el('span', label))
    return { face, b, c }
  })
  const beardButtons = BEARDS.map(([beard, label]) => {
    const c = canvas(23, 23, 'look-thumb')
    const b = button('', () => change(() => (look = withBeard(look, beard))))
    b.className = 'look-option'
    b.append(c, el('span', label))
    return { beard, b, c }
  })
  const heldButtons = HELD.map(([held, label]) => {
    const c = canvas(25, 31, 'look-thumb tall')
    const b = button('', () => change(() => (look = withHeld(look, held))))
    b.className = 'look-option'
    b.append(c, el('span', label))
    return { held, b, c }
  })
  // ---- 整套形象：一键换上；花纹换成那一套的（没有就清掉） ----
  const presetLooks = PRESETS.map(([label, preset]) =>
    button(label, () => change(() => (look = structuredClone(preset))))
  )

  // ---- 颜色 ----
  const colorRows = COLOR_ROWS.map((row) => {
    const label = el('span', row.label, 'look-row-label')
    const swatches = el('div', '', 'look-swatches')
    swatches.setAttribute('role', 'group')
    swatches.setAttribute('aria-label', row.label)
    return { row, label, swatches }
  })
  const current = (key: ColorKey) =>
    key === 'apron'
      ? (look.apron ?? CREAM)
      : key === 'hair_tip'
        ? (look.hair_tip ?? NO_TIP)
        : (look[key] as string)
  const setColor = (key: ColorKey, color: string) =>
    change(() => {
      if (key === 'accent') {
        // 头巾和发饰跟着点缀色走
        if (look.headband) look.headband = color
        delete look.ornament
      }
      if (key === 'apron') look.apron = color
      else if (key === 'hair_tip') {
        if (color === NO_TIP) delete look.hair_tip
        else look.hair_tip = color
      } else look[key] = color
    })
  const swatch = (key: ColorKey, color: string, name: string) => {
    const b = button(color === NO_TIP ? '无' : '', () => setColor(key, color))
    b.className = color === NO_TIP ? 'look-swatch none' : 'look-swatch'
    if (color !== NO_TIP) b.style.background = color
    b.title = name
    b.setAttribute('aria-label', name)
    b.dataset.color = color.toLowerCase()
    return b
  }
  /** 色块只在起步时建一次（换长相时重建），点了不换按钮，键盘焦点留在原处 */
  function buildSwatches() {
    for (const { row, swatches } of colorRows) {
      const start =
        row.key === 'apron'
          ? (original.apron ?? CREAM)
          : row.key === 'hair_tip'
            ? (original.hair_tip ?? NO_TIP)
            : (original[row.key] as string)
      const known = row.colors.some(([c]) => c.toLowerCase() === start.toLowerCase())
      swatches.replaceChildren(
        ...(known ? [] : [swatch(row.key, start, `${row.label}：原来的颜色`)]),
        ...row.colors.map(([c, name]) => swatch(row.key, c, `${row.label}：${name}`))
      )
    }
  }

  // ---- 配饰 ----
  const accessoryButtons = ACCESSORIES.map(([key, label]) => {
    const b = button(label, () =>
      change(() => {
        if (key === 'headband') {
          if (look.headband) delete look.headband
          else look.headband = look.accent
        } else if (look[key]) delete look[key]
        else look[key] = true
      })
    )
    b.className = 'look-toggle'
    return { key, b }
  })

  // ---- 花纹 ----
  const rowsOf = () => look.pattern?.rows ?? EMPTY_ROWS
  const patternColor = () => look.pattern?.color ?? WHITE
  const patternOn = () => look.pattern?.on ?? 'top'
  /** 改花纹：全空就不带花纹 */
  const setPattern = (rows: string[], color = patternColor(), on = patternOn()) => {
    if (rows.every((r) => !r.includes('#'))) delete look.pattern
    else look.pattern = { on, color, rows }
  }
  const grid = el('div', '', 'look-grid')
  grid.setAttribute('role', 'group')
  grid.setAttribute('aria-label', '4×4 花纹，点格子画')
  const cells: { b: HTMLButtonElement; x: number; y: number }[] = []
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      const b = button('', () =>
        change(() => {
          const rows = [...rowsOf()]
          const row = [...rows[y]]
          row[x] = row[x] === '#' ? '.' : '#'
          rows[y] = row.join('')
          setPattern(rows)
        })
      )
      b.setAttribute('aria-label', `第 ${y + 1} 行第 ${x + 1} 格`)
      cells.push({ b, x, y })
      grid.append(b)
    }
  const presetButtons = PATTERN_PRESETS.map(([label, rows]) =>
    button(label, () => change(() => setPattern([...rows])))
  )
  const patternSwatches = PATTERN_COLORS.map(([color, name]) => {
    const b = button('', () =>
      change(() => {
        // 还没画格子时先铺横条，点了颜色马上看得到
        setPattern(look.pattern ? rowsOf() : [...PATTERN_PRESETS[1][1]], color)
      })
    )
    b.className = 'look-swatch'
    b.style.background = color
    b.title = name
    b.setAttribute('aria-label', `花纹色：${name}`)
    return { color, b }
  })
  const targetButtons = (
    [
      ['top', '画在上衣'],
      ['bottom', '画在下装'],
    ] as const
  ).map(([on, label]) => ({
    on,
    b: button(label, () =>
      change(() => {
        if (look.pattern) look.pattern.on = on
      })
    ),
  }))

  // ---- 排版 ----
  const section = (title: string, ...children: HTMLElement[]) => {
    const s = el('div', '', 'look-part')
    s.append(el('h4', title), ...children)
    return s
  }
  const hairGrid = el('div', '', 'look-options')
  hairGrid.append(...hairButtons.map((h) => h.b))
  const outfitGrid = el('div', '', 'look-options')
  outfitGrid.append(...outfitButtons.slice(0, OUTFITS.length).map((o) => o.b))
  const costumeGrid = el('div', '', 'look-options')
  costumeGrid.append(...outfitButtons.slice(OUTFITS.length).map((o) => o.b))
  const headGrid = el('div', '', 'look-options')
  headGrid.append(...headButtons.map((h) => h.b))
  const faceGrid = el('div', '', 'look-options')
  faceGrid.append(...faceButtons.map((f) => f.b))
  const beardGrid = el('div', '', 'look-options')
  beardGrid.append(...beardButtons.map((b) => b.b))
  const heldGrid = el('div', '', 'look-options')
  heldGrid.append(...heldButtons.map((h) => h.b))
  const presetRow = el('div', '', 'look-toggles')
  presetRow.append(...presetLooks)
  const colors = el('div', '', 'look-colors')
  for (const r of colorRows) colors.append(r.label, r.swatches)
  const toggles = el('div', '', 'look-toggles')
  toggles.append(...accessoryButtons.map((a) => a.b))
  const presets = el('div', '', 'look-toggles')
  presets.append(...presetButtons)
  const patternColors = el('div', '', 'look-swatches')
  patternColors.setAttribute('role', 'group')
  patternColors.setAttribute('aria-label', '花纹色')
  patternColors.append(...patternSwatches.map((s) => s.b))
  const targets = el('div', '', 'look-toggles')
  targets.append(...targetButtons.map((t) => t.b))
  const patternSide = el('div', '', 'look-pattern-side')
  patternSide.append(presets, patternColors, targets)
  const pattern = el('div', '', 'look-pattern')
  pattern.append(grid, patternSide)
  const head = el('div', '', 'look-head')
  head.append(stage, random)
  root.append(
    head,
    section('整套形象（一键换上，再接着改）', presetRow),
    section('发型', hairGrid),
    section('衣服', outfitGrid),
    section('奇装异服', costumeGrid),
    section('颜色', colors),
    section('头上', headGrid),
    section('脸上', faceGrid),
    section('胡子', beardGrid),
    section('手里', heldGrid),
    section('配饰', toggles),
    section('花纹（点格子画，跟着衣服走）', pattern)
  )

  function render() {
    // 发型缩略图不戴帽子，衣服缩略图一律寸头：只看这一样，不被别的盖住
    for (const h of hairButtons) {
      thumb(art!, h.c, withHead({ ...look, hair: h.hair }, 'none'), HAIR_CROP)
      h.b.setAttribute('aria-pressed', String(look.hair === h.hair))
    }
    for (const o of outfitButtons) {
      thumb(art!, o.c, { ...look, outfit: o.outfit, hair: 'crop' }, BODY_CROP)
      o.b.setAttribute('aria-pressed', String(look.outfit === o.outfit))
    }
    for (const h of headButtons) {
      thumb(art!, h.c, withHead(look, h.head), HEAD_CROP)
      h.b.setAttribute('aria-pressed', String(headOf(look) === h.head))
    }
    for (const f of faceButtons) {
      thumb(art!, f.c, withFace(look, f.face), HEAD_CROP)
      f.b.setAttribute('aria-pressed', String((look.face ?? 'none') === f.face))
    }
    for (const b of beardButtons) {
      thumb(art!, b.c, withBeard(look, b.beard), HEAD_CROP)
      b.b.setAttribute('aria-pressed', String(beardOf(look) === b.beard))
    }
    for (const h of heldButtons) {
      thumb(art!, h.c, withHeld(look, h.held), FULL_CROP)
      h.b.setAttribute('aria-pressed', String((look.held ?? 'none') === h.held))
    }
    for (const { row, label, swatches } of colorRows) {
      label.hidden = swatches.hidden = !!row.outfit && row.outfit !== look.outfit
      const now = current(row.key).toLowerCase()
      for (const b of swatches.querySelectorAll<HTMLButtonElement>('button'))
        b.setAttribute('aria-pressed', String(b.dataset.color === now))
    }
    for (const a of accessoryButtons) a.b.setAttribute('aria-pressed', String(!!look[a.key]))
    const rows = rowsOf()
    const base = patternOn() === 'bottom' ? look.bottom : look.top
    for (const { b, x, y } of cells) {
      const on = rows[y][x] === '#'
      b.style.background = on ? patternColor() : base
      b.setAttribute('aria-pressed', String(on))
    }
    for (const s of patternSwatches)
      s.b.setAttribute('aria-pressed', String(!!look.pattern && s.color === look.pattern.color))
    for (const t of targetButtons) {
      t.b.disabled = !look.pattern
      t.b.setAttribute('aria-pressed', String(!!look.pattern && patternOn() === t.on))
    }
    drawPreview()
  }

  // 预览按时间换帧；不在页面上就停，重新挂上由 wake() 接着走
  const still = matchMedia('(prefers-reduced-motion: reduce)')
  let frame = -1
  let timer = 0
  function drawPreview(next = frame < 0 ? 0 : frame) {
    frame = next
    for (const p of previews) {
      const ctx = p.c.getContext('2d')!
      ctx.clearRect(0, 0, W, H)
      art!.drawFrame(ctx, look, p.facing, still.matches ? 0 : frame, 0, 0)
    }
  }
  function tick() {
    timer = 0
    if (!root.isConnected || still.matches) return
    drawPreview((frame + 1) % 4)
    timer = window.setTimeout(tick, STEP_MS)
  }
  function wake() {
    if (!timer && !still.matches) timer = window.setTimeout(tick, STEP_MS)
  }
  buildSwatches()
  render()
  // 挂到页面上之后才开始走
  requestAnimationFrame(wake)

  return {
    root,
    value() {
      const out = structuredClone(look)
      if (out.pattern && out.pattern.rows.every((r) => !r.includes('#'))) delete out.pattern
      return out
    },
    set(next) {
      look = structuredClone(next)
      original = structuredClone(next)
      buildSwatches()
      render()
    },
    wake,
  }
}
