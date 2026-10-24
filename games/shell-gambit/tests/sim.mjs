/*
 * Shell Gambit — AI 自对弈压力测试。
 *
 * 跑：node games/shell-gambit/tests/sim.mjs            （每种人数 3000 局）
 *     node games/shell-gambit/tests/sim.mjs 20000      （每种人数 20000 局）
 *
 * 它在找四类东西，任何一类出现都以非零码退出：
 *   1. 非法动作 —— AI 提交了引擎会拒绝的棋（说明"合法操作的唯一来源"被绕过了）
 *   2. 死锁     —— 某一步走完，当前玩家没有任何合法动作
 *   3. 状态损坏 —— 28 张牌不守恒、血量越界、回合指向不该行动的人…
 *   4. 覆盖率与偏向 —— 7 种道具/8 类事件必须都出现过；胜率不能偏向某个座位
 *   5. 复现性   —— 同种子必须得到完全一样的一局（否则 BUG 没法复现）
 *
 * ⚠️ 这个文件是**零依赖的普通脚本**（不是 node:test）：
 *    它的价值在于能跑几万局、并把统计打出来给人看，node:test 不适合干这个。
 *    原项目的同名文件就是这个形态，搬过来只改了 import 路径。
 */

import { applyAction, checkInvariants, createGame, remainingCounts } from '../js/engine/engine.js';
import { aiDecide, aiDecideFromView, createAiMemory } from '../js/ai/ai.js';
import { viewFor } from '../js/view.js';

const STEP_LIMIT = 4000; // 单局最大步数，超过即判定为疑似死锁

/**
 * 跑一局，返回统计数据。
 * @param {number} n 玩家人数
 * @param {number} seed 随机种子
 */
export function runGame(n, seed, { onIssue, viaView = false } = {}) {
  const players = Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    name: `AI${i + 1}`,
  }));
  const state = createGame({ players, seed });
  const memories = {};
  for (const p of state.players) memories[p.id] = createAiMemory();

  const stats = {
    seed, players: n, steps: 0, turns: 0, rounds: 0, winner: null,
    itemsUsed: {}, events: {}, issues: [],
  };

  const issue = (msg) => {
    stats.issues.push(msg);
    if (onIssue) onIssue(msg);
  };

  let guard = 0;
  while (state.phase === 'playing') {
    if (guard++ >= STEP_LIMIT) {
      issue(`超过 ${STEP_LIMIT} 步仍未结束（疑似死锁）`);
      break;
    }
    const pid = state.turn;
    if (!pid) { issue('没有当前回合玩家'); break; }

    // viaView：让 AI 走「客户端视图」那条路（aiDecideFromView），
    // 用来证明"只看裁剪过的数据也能把整局打完"——这正是单机人机对局的路径。
    const decision = viaView
      ? decideFromView(state, pid, memories[pid])
      : aiDecide(state, pid, memories[pid]);
    if (!decision) {
      issue(`AI 在还有合法动作时返回了 null（${pid}）`);
      break;
    }

    const before = {
      turn: state.turn,
      seq: state.seq,
      counts: JSON.stringify(remainingCounts(state)),
    };
    const res = applyAction(state, pid, decision.action);
    if (!res.ok) {
      issue(`AI 提交了非法动作: ${JSON.stringify(decision.action)} → ${res.error}`);
      break;
    }

    // 每一步都必须真正推进状态，否则就是死循环
    if (state.seq === before.seq) {
      issue(`动作没有产生任何事件（状态未推进）: ${JSON.stringify(decision.action)}`);
      break;
    }

    const bad = checkInvariants(state);
    if (bad.length) { issue(`不变量被打破: ${bad.join('; ')}`); break; }

    stats.steps++;
    for (const e of res.events) {
      stats.events[e.t] = (stats.events[e.t] || 0) + 1;
      if (e.t === 'use') stats.itemsUsed[e.item] = (stats.itemsUsed[e.item] || 0) + 1;
    }
  }

  stats.turns = state.turnNo;
  stats.rounds = state.round;
  stats.winner = state.winner;

  if (!stats.issues.length) {
    const alive = state.players.filter((p) => p.alive);
    if (state.phase !== 'over') issue('循环结束但对局未结束');
    else if (alive.length !== 1) issue(`对局结束但存活人数为 ${alive.length}`);
    else if (state.winner !== alive[0].id) issue('胜者与唯一存活玩家不一致');
  }

  return stats;
}

/** 从裁剪过的视图决策 —— 与 js/ui/match.js 里单机 AI 走的是同一条路 */
function decideFromView(state, pid, memory) {
  // 故意的：**先过 viewFor，再交给 AI**。AI 这里拿不到引擎的完整 state。
  return aiDecideFromView(viewFor(state, pid), memory, state.rng.next);
}

/* ----------------------------- 批量跑 ----------------------------- */

function main() {
  const perCount = Number(process.argv[2] || 3000);
  const startTime = Date.now();

  console.log(`Shell Gambit 自对弈测试：每种人数 ${perCount} 局\n`);

  const allIssues = [];
  const itemCoverage = {};
  const eventCoverage = {};

  for (const n of [2, 3, 4]) {
    const t0 = Date.now();
    const wins = {};
    let turnSum = 0, roundSum = 0, stepSum = 0;

    for (let i = 0; i < perCount; i++) {
      // 种子覆盖不同量级，避免随机性只集中在某一区间
      const seed = (i * 2654435761 + n * 40503) >>> 0;
      const s = runGame(n, seed);
      if (s.issues.length) for (const msg of s.issues) allIssues.push(`[${n}人 seed=${seed}] ${msg}`);
      wins[s.winner] = (wins[s.winner] || 0) + 1;
      turnSum += s.turns;
      roundSum += s.rounds;
      stepSum += s.steps;
      for (const [k, v] of Object.entries(s.itemsUsed)) itemCoverage[k] = (itemCoverage[k] || 0) + v;
      for (const [k, v] of Object.entries(s.events)) eventCoverage[k] = (eventCoverage[k] || 0) + v;
    }

    const ms = Date.now() - t0;
    const winList = Object.entries(wins)
      .sort()
      .map(([k, v]) => `${k}:${((v / perCount) * 100).toFixed(1)}%`)
      .join('  ');
    console.log(
      `  ${n} 人局 × ${perCount}：平均 ${(turnSum / perCount).toFixed(1)} 回合 / ` +
        `${(roundSum / perCount).toFixed(1)} 轮 / ${(stepSum / perCount).toFixed(1)} 步  ` +
        `(${(ms / 1000).toFixed(1)}s)`
    );
    console.log(`      胜率分布（按玩家 id）：${winList}`);

    // 胜率不能偏向某个座位：原项目定的判据是"2 人 50/50、3 人各 1/3、4 人各 1/4"，
    // 这里放宽到 ±6 个百分点（样本只有几千局，卡太死会因为噪声随机翻红）。
    const ideal = 1 / n;
    for (const [id, count] of Object.entries(wins)) {
      const rate = count / perCount;
      if (Math.abs(rate - ideal) > 0.06) {
        allIssues.push(`[${n}人] ${id} 胜率 ${(rate * 100).toFixed(1)}% 偏离理论值 ${(ideal * 100).toFixed(1)}% 过多`);
      }
    }
  }

  console.log('\n道具使用覆盖（全部 7 种都应当出现）：');
  const ITEM_NAMES = {
    magnifier: '放大镜', inverter: '逆转器', adrenaline: '肾上腺素', beer: '啤酒',
    handsaw: '手锯', cigarette: '香烟', handcuffs: '手铐',
  };
  for (const [k, label] of Object.entries(ITEM_NAMES)) {
    const v = itemCoverage[k] || 0;
    console.log(`  ${label.padEnd(6, '　')} ${String(v).padStart(8)} 次  ${v > 0 ? '✓' : '✗ 未被使用！'}`);
    if (v === 0) allIssues.push(`道具「${k}」在 ${perCount * 3} 局中从未被 AI 使用（覆盖面不足）`);
  }

  console.log('\n事件覆盖：');
  const EVENT_NAMES = {
    round: '新一轮装填', turn: '回合开始发牌', shoot: '开枪', use: '使用道具',
    elim: '玩家被淘汰', skip: '手铐跳过回合', recycle: '弃牌堆回收', over: '对局结束',
  };
  for (const [k, label] of Object.entries(EVENT_NAMES)) {
    const v = eventCoverage[k] || 0;
    console.log(`  ${label.padEnd(12, '　')} ${String(v).padStart(8)} 次  ${v > 0 ? '✓' : '✗ 未覆盖！'}`);
    if (v === 0) allIssues.push(`事件「${k}」从未发生（覆盖面不足）`);
  }

  // 复现性：同样种子必须得到完全一样的对局
  console.log('\n复现性检查（相同种子必须完全一致）：');
  let reproOk = true;
  for (const n of [2, 3, 4]) {
    for (const seed of [1, 7, 12345, 999983]) {
      const a = runGame(n, seed);
      const b = runGame(n, seed);
      if (a.winner !== b.winner || a.steps !== b.steps || a.rounds !== b.rounds || a.turns !== b.turns) {
        allIssues.push(`[${n}人 seed=${seed}] 不可复现：${a.winner}/${a.steps} vs ${b.winner}/${b.steps}`);
        reproOk = false;
      }
    }
  }
  console.log(reproOk ? '  ✓ 全部一致' : '  ✗ 存在不一致');

  // 「只看裁剪视图也能打完」—— 这是单机人机对局走的那条路，必须单独验一遍
  console.log('\n视图路径检查（AI 只吃 viewFor 的结果，也能把整局打完）：');
  let viewPathBad = 0;
  for (const n of [2, 3, 4]) {
    for (let i = 0; i < 200; i++) {
      const s = runGame(n, (i * 7919 + n) >>> 0, { viaView: true });
      if (s.issues.length) { viewPathBad++; for (const m of s.issues) allIssues.push(`[视图路径 ${n}人] ${m}`); }
    }
  }
  console.log(viewPathBad === 0 ? '  ✓ 600 局全部正常结束' : `  ✗ 有 ${viewPathBad} 局出问题`);

  const total = Date.now() - startTime;
  console.log(`\n总耗时 ${(total / 1000).toFixed(1)}s`);

  if (allIssues.length) {
    console.log(`\n✗ 发现 ${allIssues.length} 个问题：`);
    const uniq = [...new Set(allIssues)];
    for (const m of uniq.slice(0, 40)) console.log(`  - ${m}`);
    if (uniq.length > 40) console.log(`  ... 另有 ${uniq.length - 40} 类`);
    process.exit(1);
  }
  console.log('\n✓ 全部对局健康：无非法动作、无死锁、无不变量破坏、道具与事件全覆盖、胜率无偏向。');
}

await await main();