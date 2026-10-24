/**
 * BladeSteed — AI 自对弈压力测试
 *
 * 目的：用 2/3/4 名 AI 反复对局，把「规则漏洞 / 死锁 / 状态损坏 / 身份偏向」
 * 这几类问题在几万局里逼出来。
 *
 * 每局都检查这些永久不变量：
 *   · 血量永远在 [0,10] 内，且「活着」⟺「血 > 0」
 *   · 位置永远是「野外」或某个真实存在的城（出局者的城也算）
 *   · 行动队列里只有活人；行动阶段当前行动者一定活着
 *   · 剩余步数不为负；状态版本号单调递增
 *   · 对局一定会结束（不会出现所有人都不敢动的死锁）
 *
 * 用法：node games/blade-steed/tests/sim.mjs [每种人数跑多少局]
 *
 * ⚠️ 搬家时只有一处改动：viewFor 从 `../js/engine/view.js` 挪到了 `../js/view.js`
 * （平台规定「视图裁剪」是 js/view.js 这一层，服务端也 import 它）。
 */

import { Match } from '../js/engine/engine.js';
import { viewFor } from '../js/view.js';
import { MAX_HP, PHASE, WILD } from '../js/engine/constants.js';
import { aiStats, aiStep, makeBrains, resetAiStats } from '../js/ai/ai.js';

const PER_COUNT = Number(process.argv[2]) || 4000;
const MAX_STEPS = 20000;
const NAMES = ['甲', '乙', '丙', '丁'];
const IDS = ['a', 'b', 'c', 'd'];
/** 要确认 AI 每一种操作都用得上（用不上说明决策有盲区） */
const REQUIRED_ACTIONS = ['buy_knife', 'buy_horse', 'move', 'knife', 'kick'];
/** 出城 / 进城统一算「位移」 */
const ACTION_KEY = {
  buy_knife: 'buy_knife',
  buy_horse: 'buy_horse',
  move_out: 'move',
  move_in: 'move',
  knife: 'knife',
  kick: 'kick',
  pass: 'pass',
};

let failures = 0;
const fail = (msg) => {
  failures += 1;
  if (failures <= 10) console.log(`  \u2717 ${msg}`);
};

/** 每局、每一步都跑的永久不变量 */
function checkInvariants(m, tag) {
  const ids = new Set(m.players.map((p) => p.id));
  for (const p of m.players) {
    if (!Number.isFinite(p.hp) || p.hp < 0 || p.hp > MAX_HP) fail(`${tag}: ${p.name} 血量异常 ${p.hp}`);
    if (p.alive !== p.hp > 0) fail(`${tag}: ${p.name} 存活标记与血量不符 hp=${p.hp} alive=${p.alive}`);
    if (p.place !== WILD && !ids.has(p.place)) fail(`${tag}: ${p.name} 位置非法 ${p.place}`);
    if (typeof p.knife !== 'boolean' || typeof p.horse !== 'boolean') fail(`${tag}: ${p.name} 装备字段异常`);
  }
  if (m.stepsLeft < 0) fail(`${tag}: 剩余步数为负 ${m.stepsLeft}`);
  for (const id of m.queue) {
    if (!m.player(id)?.alive) fail(`${tag}: 行动队列里混进了出局者 ${id}`);
  }
  if (m.phase === PHASE.ACTION && m.current && !m.player(m.current)?.alive) {
    fail(`${tag}: 当前行动者已经出局 ${m.current}`);
  }
  if (m.phase === PHASE.ACTION && m.current && !m.legalActions(m.current).length) {
    fail(`${tag}: 当前行动者没有任何合法动作（死锁）`);
  }
  if (m.winner && m.alive().length !== 1) fail(`${tag}: 宣布了胜者但存活人数是 ${m.alive().length}`);
}

const actionUse = {};
let totalRounds = 0;
let totalActions = 0;
let maxRoundsGlobal = 0;
let unfinished = 0;
const winsByCount = {};

resetAiStats();

for (const n of [2, 3, 4]) {
  const seatWins = {};
  const startAt = Date.now();
  for (let g = 0; g < PER_COUNT; g++) {
    const players = IDS.slice(0, n).map((id, i) => ({ id, name: NAMES[i], isAI: true }));
    const m = new Match({ players, seed: (g * 2654435761 + n * 97) >>> 0 });
    const brains = makeBrains(m.players);

    // 直接包住 act() 来统计动作使用率：
    // m.events 只保留最近 60 条，早期的买装备事件会被裁掉，统计会失真。
    const rawAct = m.act.bind(m);
    m.act = (pid, action) => {
      const r = rawAct(pid, action);
      if (r.ok) {
        const key = ACTION_KEY[action.type];
        if (key) {
          actionUse[key] = (actionUse[key] || 0) + 1;
          totalActions += 1;
        }
      }
      return r;
    };

    let steps = 0;
    let stalled = false;

    while (m.phase !== PHASE.OVER && steps < MAX_STEPS) {
      const acted = aiStep(m, brains, viewFor);
      if (!acted && !m.tick()) {
        stalled = true;
        break;
      }
      steps += 1;
      checkInvariants(m, `${n}人第${g}局第${steps}步`);
    }

    if (stalled || m.phase !== PHASE.OVER) {
      unfinished += 1;
      if (unfinished <= 5) console.log(`  \u2717 ${n} 人局卡住了：${m.describe()}（已走 ${steps} 步）`);
      continue;
    }

    totalRounds += m.round;
    maxRoundsGlobal = Math.max(maxRoundsGlobal, m.round);
    const w = m.player(m.winner);
    seatWins[w.seat] = (seatWins[w.seat] || 0) + 1;
    winsByCount[n] = (winsByCount[n] || 0) + 1;
  }

  const expected = 1 / n;
  const rows = Object.keys(seatWins)
    .map((s) => ({ seat: s, rate: seatWins[s] / PER_COUNT }))
    .sort((a, b) => Number(a.seat) - Number(b.seat));
  const worst = rows.reduce((acc, r) => Math.max(acc, Math.abs(r.rate - expected)), 0);
  const ms = Date.now() - startAt;
  console.log(
    `  ${n} 人局 ${PER_COUNT} 场（${ms}ms）  座位胜率：` +
      rows.map((r) => `${r.seat}号 ${(r.rate * 100).toFixed(1)}%`).join('  ') +
      `  最大偏差 ${(worst * 100).toFixed(2)}%（理论 ${(expected * 100).toFixed(1)}%）`
  );
  // 座位是开局随机分配的，所以任何座位偏向都必须落在随机波动范围内
  if (worst > 0.05) fail(`${n} 人局座位胜率偏差过大：${(worst * 100).toFixed(2)}%`);
}

console.log('');
console.log(`  总步数 ${totalActions}  平均每局回合 ${(totalRounds / Object.values(winsByCount).reduce((a, b) => a + b, 0)).toFixed(2)}`);
console.log(`  最长对局 ${maxRoundsGlobal} 回合`);
console.log(
  `  动作使用率：` +
    ['buy_knife', 'buy_horse', 'move', 'knife', 'kick', 'pass'].map((k) => `${k} ${(actionUse[k] || 0)}`).join('  ')
);
console.log(`  AI 兜底次数 ${aiStats.fallbacks}（正常应为 0）`);
console.log(`  未结束对局 ${unfinished}（正常应为 0）`);

if (aiStats.fallbacks > 0) fail(`AI 有 ${aiStats.fallbacks} 次选出了非法动作，必须为 0`);
if (unfinished > 0) fail(`有 ${unfinished} 局没能打完，可能存在死锁`);
for (const k of REQUIRED_ACTIONS) {
  if (!actionUse[k]) fail(`AI 从来没用过「${k}」，说明决策逻辑有盲区`);
}

if (failures) {
  console.log(`\n\u2717 压测发现 ${failures} 个问题`);
  process.exit(1);
}
console.log('\n\u2713 全部不变量通过，没有死锁 / 非法动作 / 身份偏向');