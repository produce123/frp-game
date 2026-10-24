/*
 * 桥：把用 ES Module 写的引擎 / AI / 视图，挂回 window 上。
 *
 * 【为什么需要这么一个文件】
 * 这个游戏原本是"经典脚本 + 内联 onclick"的结构（见 AGENTS.md），
 * 经典脚本**不能 import 模块**。而引擎必须能被服务器 import（服务端权威裁决），
 * 所以引擎只能是 ES Module。
 *
 * 两边都要满足，就得有个桥：模块先加载，再由它把东西挂到 window 上，
 * 后面那些经典脚本（audio.js / app.js）照旧按全局名字用，**一行都不用改**。
 *
 * 【执行顺序为什么是对的】
 * `type="module"` 的脚本天然 defer；HTML 规定 defer 脚本与模块脚本
 * **按文档顺序**在解析结束后依次执行。所以 index.html 底部只要保持
 * protocol → bridge → net → ui → room → audio → app 这个顺序就没问题。
 * ⚠️ 把 bridge 挪到 app 后面，app.js 一开头读 CANNON 就会拿到 undefined。
 *
 * ⚠️ 这里刻意**不暴露裸全局给外部依赖**（源项目 AGENTS.md 里记过两次事故：
 * 裸 P2PConnection / 裸 normalizeRoomCode 导致内联 onclick 里的 async 报错被静默吞掉，
 * 点按钮毫无反应）。本文件挂的是游戏自己的东西，属于"我不挂就没人挂"的必需项。
 */

import { PRESET_MAPS, EMPTY, CANNON, GHOST, GameState } from './engine/rules.js';
import { AIPlayer } from './ai/ai.js';
import { viewFor, stateFromView, sideToName, nameToSide, otherSide } from './view.js';

Object.assign(window, {
  // 引擎（同一份文件，服务器也在 import 它）
  PRESET_MAPS, EMPTY, CANNON, GHOST, GameState,
  // 人机
  AIPlayer,
  // 视图层
  viewFor, stateFromView, sideToName, nameToSide, otherSide,
  // 给测试和排查用
  CannonGoblin: {
    GameState, AIPlayer, PRESET_MAPS, CANNON, GHOST,
    viewFor, stateFromView, otherSide,
  },
});