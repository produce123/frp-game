/**
 * BladeSteed — 合法动作推导（唯一实现）
 *
 * 引擎校验、UI 亮暗按钮、AI 动作空间，三边都调用这一个函数。
 * 好处很直接：规则只会写错一次，也不可能出现
 * 「UI 让玩家点了、引擎却拒了」或者「AI 走了一个非法操作」这类分歧。
 *
 * 只依赖公开信息（阶段 / 当前行动者 / 玩家的血量装备位置），
 * 所以把「裁剪后的视图」直接丢进来也完全正确 —— AI 因此拿不到任何额外情报。
 */

import { ACT, PHASE, isCity } from './constants.js';

/**
 * @param {{phase:string,current:string|null,players:{id:string,alive:boolean,knife:boolean,horse:boolean,place:string}[]}} state
 * @param {string} pid
 * @returns {{type:string,target?:string}[]}
 */
export function legalActionsFrom(state, pid) {
  const out = [];
  if (!state || state.phase !== PHASE.ACTION || state.current !== pid) return out;
  const players = state.players || [];
  const me = players.find((p) => p.id === pid);
  if (!me || !me.alive) return out;

  if (isCity(me.place)) {
    // 城内才能买装备（任意城都可以，含别人的城）
    if (!me.knife) out.push({ type: ACT.BUY_KNIFE });
    if (!me.horse) out.push({ type: ACT.BUY_HORSE });
    // 出城：无需任何前置条件
    out.push({ type: ACT.MOVE_OUT });
  } else {
    // 野外：可以指定进任意一个人的城（含自己的城、含已出局者的城——城永久存在）
    for (const c of players) out.push({ type: ACT.MOVE_IN, target: c.id });
  }

  for (const t of players) {
    if (t.id === me.id || !t.alive) continue;
    if (t.place !== me.place) continue; // 刀：必须同一位置
    if (me.knife) out.push({ type: ACT.KNIFE, target: t.id });
    // 踹：必须已买马，且双方同在同一【城内】
    if (me.horse && isCity(me.place)) out.push({ type: ACT.KICK, target: t.id });
  }

  // 永远留一个「结束行动」兜底，保证任何局面都不会卡死
  out.push({ type: ACT.PASS });
  return out;
}

/** 某个动作此刻是否合法（引擎校验用） */
export function isActionLegal(state, pid, action) {
  const type = action && action.type;
  const target = (action && action.target) || null;
  return legalActionsFrom(state, pid).some((a) => a.type === type && (a.target || null) === target);
}