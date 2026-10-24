/*
 * 斗地主 —— 服务端接入层（平台游戏模块）。
 *
 * 【它只做三件事】
 *   1. 把房间层的座位表交给引擎（座位号 = 入座顺序）；
 *   2. 把操作意图转成引擎调用；
 *   3. 把引擎状态按人裁剪成 view（`viewFor` 在引擎里，这里只是转发）。
 *
 * 规则一行都不在这里 —— 全在 `games/ddz/js/engine/**`（纯逻辑，零浏览器 API）。
 *
 * 【和上游的关系】
 * 上游是 blmz/GODOT-DouDiZhu（Godot 4.4，见 games/ddz/README.md）：
 * **牌桌（界面）用它的网页导出**（`games/ddz/table/`，在 iframe 里只负责画），
 * 规则按它的口径搬到服务器（`games/ddz/js/engine/**`）。
 * 上一版自己画的 HTML 牌桌已经被用户否掉，见 docs/DECISIONS.md D40（取代 D35）。
 *
 * 【没有电脑】
 * 用户明确拍板：**不做人机**（上游也没有 AI）。所以 `meta.maxBots = 0`：
 * 房间层不会显示「添加人机」、`botAdd` 也会被拒。三个人必须都是真人。
 *
 * 接口约定见 docs/ARCHITECTURE.md「游戏模块接口（服务器权威）」。
 */

import { createGame } from '../../games/ddz/js/engine/game.js';

export const meta = {
  slug: 'ddz',
  title: '斗地主',
  icon: '🃏',
  /**
   * minPlayers = 3、minSeats = 3：斗地主是**固定三人**牌桌。
   * 没有电脑补位（maxBots = 0），所以"真人下限"和"总座位下限"就是同一个数，
   * 两个都写 3 —— 房间层的「开始游戏」按 minSeats 灰着，服务端按 minSeats 拒绝。
   */
  minPlayers: 3,
  minSeats: 3,
  maxPlayers: 3,
  /**
   * maxBots = 0：这个游戏没有电脑座位。
   * `shared/ui/room.js` 据此不画「＋ 添加人机」，`server/rooms.mjs` 的 `botAdd` 直接拒绝。
   * 字段是**通用**的（不认具体游戏），以后哪个游戏能做 AI 就把数写大。
   */
  maxBots: 0,
  /**
   * 开局之后不许进人（用户拍板，沿用狼人杀口径：不做中途加入、不做观战）。
   * 斗地主更硬：牌已经发完了，第四个人进来没地方坐。
   */
  allowMidJoin: false,
};

/**
 * 建一局。
 *
 * @param {Array<{id:string,name:string,avatar?:string,isHost:boolean,isBot?:boolean}>} players
 *        房间层给的座位表。**顺序就是座位号**（房主是第一个入座的，但不因此先叫地主 ——
 *        先叫的人由引擎随机决定）。
 * @param {object} [options] 本游戏**没有**任何设置项（座位数固定三人），传什么都忽略。
 */
export function createMatch(players, options) {
  void options;

  if (!Array.isArray(players) || players.length !== 3) {
    throw new Error(`斗地主刚好 3 个人：现在 ${Array.isArray(players) ? players.length : 0} 个座位`);
  }
  if (players.some((p) => p && p.isBot)) {
    // 防御性第二道闸：meta.maxBots = 0 时房间层不会造人机座位，走到这儿说明有人绕过了房间层
    throw new Error('斗地主没有电脑：要 3 个真人才能开局');
  }

  const game = createGame({
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar || '',
      isBot: false,
    })),
  });

  return {
    viewFor(playerId) {
      return game.viewFor(playerId);
    },
    act(playerId, action) {
      return game.act(playerId, action);
    },
    addPlayer() {
      return false;
    },
    removePlayer(playerId) {
      return game.removePlayer(playerId);
    },
    isOver() {
      return game.isOver();
    },
    result() {
      return game.result();
    },
    /** 仅供测试与调试（房间层不用）。 */
    _state: game,
  };
}