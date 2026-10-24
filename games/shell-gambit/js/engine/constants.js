/**
 * Shell Gambit — 全局常量与道具定义
 *
 * 本文件不依赖任何浏览器 API，Node 与浏览器共用。
 */

/** 生命值上限 */
export const MAX_HP = 5;
/** 开局生命值 */
export const START_HP = 5;
/** 开局每人发牌数 */
export const START_HAND = 2;
/** 手牌上限（超过则不再发牌） */
export const MAX_HAND = 4;
/** 摸牌堆少于该数量时，回收弃牌堆 */
export const RECYCLE_THRESHOLD = 4;

/** 子弹类型 */
export const SHELL_LIVE = 'live';   // 实弹
export const SHELL_BLANK = 'blank'; // 空弹

/** 手锯加成后的伤害 */
export const SAW_DAMAGE = 2;
export const BASE_DAMAGE = 1;

/**
 * 道具定义。
 * needsTarget: 使用时是否需要指定一名其他存活玩家。
 * selfOnly:    只能对自己生效（用于 UI 提示与 AI 评估）。
 */
export const ITEM_INFO = {
  magnifier: {
    name: '放大镜',
    icon: 'magnifier',
    desc: '查看当前这一发是实弹还是空弹（只有你能看到）。',
    needsTarget: false,
    selfOnly: true,
  },
  inverter: {
    name: '逆转器',
    icon: 'inverter',
    desc: '反转当前这一发子弹的真假（实弹变空弹，空弹变实弹）。',
    needsTarget: false,
    selfOnly: true,
  },
  adrenaline: {
    name: '肾上腺素',
    icon: 'adrenaline',
    desc: '从一名对手手中随机偷取一张道具并立刻使用。',
    needsTarget: true,
    selfOnly: false,
  },
  beer: {
    name: '啤酒',
    icon: 'beer',
    desc: '退出当前枪膛里的第一发子弹（子弹类型公开）。',
    needsTarget: false,
    selfOnly: true,
  },
  handsaw: {
    name: '手锯',
    icon: 'handsaw',
    desc: '锯短枪管：下一发实弹伤害翻倍。打出空弹则浪费。',
    needsTarget: false,
    selfOnly: true,
  },
  cigarette: {
    name: '香烟',
    icon: 'cigarette',
    desc: '恢复 1 点生命值（上限 5，满血使用则浪费）。',
    needsTarget: false,
    selfOnly: true,
  },
  handcuffs: {
    name: '手铐',
    icon: 'handcuffs',
    desc: '封锁一名对手的下一回合。',
    needsTarget: true,
    selfOnly: false,
  },
};

/** 全部道具 id（顺序即 UI 展示顺序） */
export const ALL_ITEMS = Object.keys(ITEM_INFO);

/** 每种道具的份数 */
export const COPIES_PER_ITEM = 4;

/** 牌堆总张数：28 */
export const TOTAL_CARDS = ALL_ITEMS.length * COPIES_PER_ITEM;

/*
 * 这里原本还有「花朵与鸡蛋」（REACTIONS）—— **已删除**。
 *
 * 为什么删得掉：它原来承载在自建的 HostSession/ClientSession 之上，
 * 是"没有服务器时，顺手做一条广播通道互相扔东西"的产物。
 * 搬进平台后联机层换成 shared/net/net.js，而平台的协议
 * （shared/protocol.mjs 的 T）里**没有**这条消息类型；
 * 要加就得改 shared/ 和 docs/ARCHITECTURE.md —— 那是别人的文件。
 * 平台的"扔鸡蛋"是平台自己的一层能力，游戏不该自己再发明一套。见 DECISIONS.md D4/D6。
 */

/** 回合内允许的最大连续操作次数（防御性上限，避免任何死循环） */
export const MAX_ACTIONS_PER_TURN = 200;

/** 一局游戏内允许的最大操作总数（防御性上限） */
export const MAX_TOTAL_ACTIONS = 20000;