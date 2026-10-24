/**
 * Shell Gambit — 视图裁剪的唯一入口（viewFor）
 *
 * 【这个文件在整体里的位置】
 * 界面、AI、网络**全都只吃这里吐出来的东西**。谁都不许直接读引擎的完整 state。
 * 这是 docs/GAME-SPEC.md 的「铁律二」，也是本作**唯一的防作弊手段** ——
 * 隐藏信息不是"前端不显示"，而是**报文里根本没有**。
 *
 * 【本作的隐藏信息，逐字段看一眼】
 *   · state.magazine.shells  —— 弹匣真实顺序。绝不外传。
 *     公开的只有 remainingCounts() 算出来的「还剩几发实弹 / 几发空弹」。
 *   · state.players[].hand    —— 别人的手牌内容。只外传 handCount。
 *   · state.knowledge         —— 放大镜情报。**只把"我自己"的那一份**放进 view.me.knows。
 *   · state.drawPile / discard 的顺序 —— 同样不外传，只给张数。
 *
 * 【日志上的"每一步补丁"（entry.s）走的是同一条裁剪口径】
 * 引擎（`engine.js` 的 pushEvent）给每条日志都挂了一份"**这一步之后**的公开状态补丁"，
 * 界面据此**按步走**（演到第几步画面就是第几步，见 js/ui/board.js）。那份补丁里有三样
 * 东西是"每个看的人各有一份"的，引擎按人存成表（`hands` / `legals` / `knows`），
 * **出报文之前必须由引擎的 `narrowLogEntry` 按 viewer 裁成单数** ——
 * 表和"单数"的差别就是"别人的手牌泄没泄"的差别。
 * `tests/rules.test.mjs` 有一条专门盯着这件事的用例（含"补丁里的字段"这层新数据）。
 *
 * **反过来，有一样东西是"看着像隐藏信息、其实不是"**：座位是不是电脑（`state.players[].isAi`）。
 * 人机是房间层的座位，房间成员列表里就写着「人机」，所以它属于公开身份，
 * 会作为 `players[].isAI` 下发 —— 界面靠它画圆环配色。它和上面四类的区别是：
 * 上面四类**放出去就等于让对手明牌**，这一条放出去只等于"你看见对面是电脑"，
 * 而这件事玩家本来就看得见。
 *
 * 【为什么要再包一层，而不是让 UI 直接 import 引擎的 viewFor】
 * 1. 引擎被迫保持"零 DOM、可被服务器 import"，裁剪这件事就只能在引擎里；
 *    但"裁剪口径"是接入合同（GAME-SPEC）的事，不是规则的事。包一层，
 *    将来要加"观战视图""复盘视图"时改这里，不用动引擎。
 * 2. UI 只有这一个 import 点，"忘了过 viewFor"这种事故从结构上就不可能发生 ——
 *    单机人机也走这里（GAME-SPEC 第 14 节点名警告过：
 *    单机手里有完整 state，图省事直接渲染就会出现"单机能看对手手牌"的漏洞）。
 *
 * ⚠️ 改规则时最容易犯的错：引擎加了字段，忘了同步这里的裁剪，
 *    于是新字段原样漏进公共视图。`tests/rules.test.mjs` 里有一条
 *    「视图不泄露」用例专门盯这件事 —— 加字段后它应该失败，改完再变绿。
 */

import { viewFor as engineViewFor } from './engine/engine.js';

export { viewFor as engineViewFor };

/**
 * 把权威状态裁剪成「playerId 这个人有权看到的那一份」。
 *
 * @param {object} state    引擎的完整权威状态（只有服务器 / 单机本地才有）
 * @param {string} playerId 看的人
 * @returns {object|null}   playerId 不在这局里时返回 null
 */
export function viewFor(state, playerId) {
  if (!state || !Array.isArray(state.players)) return null;
  if (!state.players.some((p) => p.id === playerId)) return null;
  const view = engineViewFor(state, playerId);
  if (!view) return null;

  /*
   * 座位上的**身份标记**：这一位是不是电脑。
   *
   * 【为什么它不算"泄露"】
   * 人机从这一版起是**房间层的座位**（GAME-SPEC §4），房间成员列表里就带着
   * 「人机」标签和灰色头像 —— 身份本来就是公开的，跟手牌、弹序不是一类东西。
   * 界面要靠它把圆环画成"自己=蓝 / 其他真人=橙 / 人机=灰"（用户点名要求三个游戏一致），
   * 而界面只吃视图，所以这个标记必须出现在视图里。
   *
   * 【为什么不靠名字猜】人机的名字来自各游戏自己的单字池（js/ai/ai.js 的
   * AI_NAME_POOL，由 meta.botNames 交给平台），和真人名字**是同一个字表**：
   * 「虎」既可能是真人玩家，也可能是人机。按名字判断从根上就是错的。
   *
   * 【为什么放在这一层，而不是让引擎的 viewFor 顺手带上】
   * 引擎的 viewFor 是"规则自己的公共视图"，裁剪口径是**接入合同**的事
   * （本文件顶部第 1 条），所以身份标记在这里加。字段名用 `isAI`，
   * 与 blade-steed 的同一处约定保持一致，三个游戏对同一个概念用同一个名字。
   * ⚠️ 名字叫 `isBot` 的是**房间层**的字段（`room.state.members[].isBot`），
   *    那个不进游戏视图 —— 视图字段清单见下面的 PUBLIC_PLAYER_FIELDS。
   *
   * ⚠️ 用 `state.players` 查而不是信任 view 里的顺序：座位条目是按座位号排过序的，
   *    两边必须按 id 对齐。
   */
  for (const pv of view.players) {
    const real = state.players.find((p) => p.id === pv.id);
    pv.isAI = !!(real && real.isAi);
  }
  return view;
}

/**
 * 视图里"公开可见"的字段清单。
 * `tests/rules.test.mjs` 用它来断言：**每个座位各裁剪一遍之后**，
 * 任何人的视图里都不许出现这些字段以外的隐藏内容。
 *
 * 它同时是新接续 AI 的说明书：想知道"什么算公开"就看这里。
 */
export const PUBLIC_FIELDS = Object.freeze([
  'seq', 'phase', 'round', 'turn', 'turnNo', 'winner', 'saw',
  'magazine', 'load', 'drawPileCount', 'discardCount', 'players', 'me', 'pending', 'log',
]);

/** 每个玩家条目上的公开字段（**没有 hand**，只有 handCount）。 */
export const PUBLIC_PLAYER_FIELDS = Object.freeze([
  'id', 'name', 'seat', 'hp', 'alive', 'handCount', 'cuffed',
  /*
   * 身份标记（是不是电脑）。它**是公开信息**：房间成员列表本来就把人机标出来
   * （`room.state.members[].isBot` + 灰色圆环），界面靠它画圆环配色。
   * 见上面 viewFor 里那一段"为什么它不算泄露"。
   */
  'isAI',
]);

/** 只有"我自己"能看到的那一份私有信息的字段。 */
export const PRIVATE_SELF_FIELDS = Object.freeze([
  'id', 'seat', 'hp', 'alive', 'hand', 'knows', 'legal',
]);

/**
 * 日志条目上那份"这一步之后的公开状态补丁"（`entry.s`）里**允许出现**的字段。
 *
 * 它同时是新接续 AI 的说明书：想知道"逐步演出的每一步能改画面上哪些东西"就看这里。
 * ⚠️ 引擎内部还有三张"按人存的表"（`hands` / `legals` / `knows`）与补丁同类，
 * 但它们在出报文前就被裁掉了：报文里只有下面这三个"单数"字段。
 */
export const PUBLIC_PATCH_FIELDS = Object.freeze([
  'seq', 'phase', 'round', 'turn', 'turnNo', 'saw', 'winner',
  'magazine', 'load', 'drawPileCount', 'discardCount', 'pending', 'players',
]);

/** 补丁里"只有本人能看"的三个字段（手牌 / 合法动作 / 放大镜情报）。 */
export const PRIVATE_PATCH_FIELDS = Object.freeze(['hand', 'legal', 'knows']);

/**
 * 补丁里每个"变了的人"会带的字段（**没有 name/seat/isAI**：那几样从头到尾不会变）。
 * 界面按 id 合并进自己那一份显示视图。
 */
export const PATCH_PLAYER_FIELDS = Object.freeze(['id', 'hp', 'alive', 'handCount', 'cuffed']);