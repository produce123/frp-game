/**
 * BladeSteed — 规则常量
 *
 * 这里的每一条都对应规则书里的一句话，改规则只改这里。
 */

/** 每位玩家固定 10 滴血 */
export const MAX_HP = 10;

/** 一刀固定扣 1 滴血 */
export const KNIFE_DAMAGE = 1;

/** 一踹固定扣 3 滴血 */
export const KICK_DAMAGE = 3;

/**
 * 一个房间至少要几个**真人**才允许开局。
 *
 * 1 = 一个人点「创建房间」也能开：座位不够时由 `server/games/blade-steed.mjs`
 * 用 AI 补位凑够（见 docs/GAME-SPEC.md §4「AI 补位」）。房间层只认这个数字，
 * 它数的是真人座位，**看不见 AI**。
 *
 * ⚠️ 别拿它当「引擎能开打的最小座位数」——那是下面的 MIN_SEATS。
 */
export const MIN_PLAYERS = 1;

/**
 * 引擎真正能开打的**座位**下限（真人 + AI 座位一起数）。
 *
 * 为什么不能是 1：猜拳要有人可赢，桌上只有 1 个座位时永远分不出胜负，
 * 那一局会无限重猜（`_rpsWinners` 只出现 1 种手势 = 无人获胜）。
 * 所以 `_init` 卡在这个数上，而"一个人开局"由接入层的 AI 自动补位来满足。
 */
export const MIN_SEATS = 2;

/** 座位上限：地图上最多画 4 座城 */
export const MAX_PLAYERS = 4;

/** 位置：'wild' 表示野外（全局唯一的一片公共区域）；其余值是「城主的 playerId」 */
export const WILD = 'wild';

/** 猜拳手势 */
export const RPS = ['rock', 'paper', 'scissors'];

/** 手势克制关系：BEATS[a] = b 表示 a 赢 b */
export const BEATS = {
  rock: 'scissors',
  scissors: 'paper',
  paper: 'rock',
};

/** 手势中文名 */
export const RPS_LABEL = { rock: '石头', scissors: '剪刀', paper: '布' };

/** 阶段 */
export const PHASE = {
  RPS: 'rps', // 所有人同步猜拳
  ORDER: 'order', // 多人获胜：小猜拳定决胜者，决胜者排行动顺序
  ACTION: 'action', // 赢家按顺序花行动步数
  OVER: 'over', // 分出胜负
};

/** 动作类型（每个动作恰好消耗 1 步） */
export const ACT = {
  BUY_KNIFE: 'buy_knife', // 买刀（仅城内）
  BUY_HORSE: 'buy_horse', // 买马（仅城内）
  MOVE_OUT: 'move_out', // 出城：城内 → 野外
  MOVE_IN: 'move_in', // 进城：野外 → 指定某个城
  KNIFE: 'knife', // 刀：同位置，-1 血
  KICK: 'kick', // 踹：同在城内，-3 血并踢到野外
  PASS: 'pass', // 主动结束剩余步数
};

/** 动作中文名（播报 / 按钮都用它） */
export const ACT_LABEL = {
  [ACT.BUY_KNIFE]: '买刀',
  [ACT.BUY_HORSE]: '买马',
  [ACT.MOVE_OUT]: '出城',
  [ACT.MOVE_IN]: '进城',
  [ACT.KNIFE]: '刀',
  [ACT.KICK]: '踹',
  [ACT.PASS]: '结束行动',
};

/** 装备中文名 */
export const ITEM_LABEL = { knife: '刀', horse: '马' };

/** 一个人获胜：2 步行动 */
export const STEPS_SOLO = 2;
/** 多人获胜：每人 1 步 */
export const STEPS_MULTI = 1;

/**
 * 演出缓冲：每一段限时都多给客户端这么多毫秒。
 *
 * 【为什么要有它】服务器一次推来的不是"一条事件"，而是**一整轮**：
 * 它必须把 AI 的整个回合同步跑完（见 server/games/blade-steed.mjs 的文件头），
 * 客户端再按 `js/ui/board.js` 一条一条演出来（砍人 700ms、买装备 600ms…）。
 * 用户第 1 条反馈就是"动画还没播完就开始倒计时" —— 演出这几秒**不该算在玩家的思考时间里**。
 *
 * 所以：显示上等演出演完才开始倒数（`board.js` 的 `tickTimer`），
 * 服务器这边每段限时统一 +2 秒，把 1~2 秒的演出垫掉。
 *
 * ⚠️ 这个数字是**给演出留的**，不是"把难度调松一点"。改大之前先看
 * `tests/rules.test.mjs` 里那条"队列空的那一刻剩余时间 ≥ 标称限时的 90%"的用例：
 * 它拿这个常量当上下界。
 * ⚠️ 用户当时建议的是 1 秒，captain 建议 2 秒，最终按 **2 秒**做：
 * 一轮演出 3~5 条事件是常态（600ms × 5 ≈ 3 秒），1 秒垫不住。
 */
export const REPLAY_BUFFER_MS = 2000;

/** 猜拳超时（超时由系统随机代出）。含演出缓冲，见 REPLAY_BUFFER_MS。 */
export const RPS_TIMEOUT_MS = 10000 + REPLAY_BUFFER_MS;
/** 决胜者排行动顺序的超时（超时按座位号兜底排序）。含演出缓冲。 */
export const ORDER_TIMEOUT_MS = 15000 + REPLAY_BUFFER_MS;
/** 单步行动超时（超时自动结束剩余步数，避免挂机卡局）。含演出缓冲。 */
export const ACTION_TIMEOUT_MS = 60000 + REPLAY_BUFFER_MS;
/** 状态帧里最多保留多少条事件 / 播报 */
export const KEEP_LOG = 60;
export const KEEP_EVENTS = 60;

/**
 * 单字名的校验/规整（isValidName / normalizeName）在这里被**删掉了**：
 * 名字现在来自平台账号（单字名在注册时定死，见 docs/DECISIONS.md D5），
 * 游戏内不再有输入名字的地方。留着它们只会引诱后人在游戏里再问一次名字。
 */

/** 判断某个位置是不是「城内」 */
export function isCity(place) {
  return place !== WILD;
}