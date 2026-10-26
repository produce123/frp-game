/*
 * 狼人杀 · 服务器权威引擎（纯 ESM，零第三方依赖）。
 *
 * 来历：规则与阶段照搬上游 `hanluolin/wolfcha-custom`（Apache-2.0）的前端逻辑引擎，
 * 但**执行位置从浏览器搬到了服务器**：身份、夜间行动、投票、警徽、结算全在这里算，
 * 客户端只拿按人裁剪过的视图（`viewFor`），永远拿不到别人的底牌。
 * 上游的 LLM / 角色人设 / TTS 全部去掉（用户要求），真人占满座位。
 *
 * 这一层**不认识 HTTP、不认识 WebSocket、不认识数据库**：
 *   · 谁进了哪间房由 `server/werewolf/index.mjs` 调用；
 *   · 状态一变就回调 `onChange(code)`，平台据此推 `T.WW_EVENT`；
 *   · 一局结束回调 `onGameEnd(room)`，平台据此写 `game_records`。
 *
 * 时间单位：全部毫秒。`timeoutScale` 只有测试会传（把 180 秒的发言缩成 0.18 秒）。
 */

import { randomInt } from 'node:crypto';

/** 阶段名与上游保持一致（客户端组件按这些名字选 UI）。 */
export const PHASE = {
  WAITING: 'WAITING',
  NIGHT_START: 'NIGHT_START',
  NIGHT_GUARD_ACTION: 'NIGHT_GUARD_ACTION',
  NIGHT_WOLF_ACTION: 'NIGHT_WOLF_ACTION',
  NIGHT_WOLF_BEAUTY_ACTION: 'NIGHT_WOLF_BEAUTY_ACTION',
  NIGHT_WITCH_ACTION: 'NIGHT_WITCH_ACTION',
  NIGHT_SEER_ACTION: 'NIGHT_SEER_ACTION',
  NIGHT_RESOLVE: 'NIGHT_RESOLVE',
  DAY_START: 'DAY_START',
  DAY_BADGE_SIGNUP: 'DAY_BADGE_SIGNUP',
  DAY_BADGE_SPEECH: 'DAY_BADGE_SPEECH',
  DAY_BADGE_ELECTION: 'DAY_BADGE_ELECTION',
  DAY_PK_SPEECH: 'DAY_PK_SPEECH',
  DAY_SPEECH: 'DAY_SPEECH',
  DAY_LAST_WORDS: 'DAY_LAST_WORDS',
  DAY_VOTE: 'DAY_VOTE',
  DAY_RESOLVE: 'DAY_RESOLVE',
  BADGE_TRANSFER: 'BADGE_TRANSFER',
  HUNTER_SHOOT: 'HUNTER_SHOOT',
  WHITE_WOLF_KING_BOOM: 'WHITE_WOLF_KING_BOOM',
  GAME_END: 'GAME_END',
};

/** 角色键（顺序固定，发牌前按这个顺序展开再洗牌）。 */
export const ROLE_KEYS = [
  'Werewolf',
  'WhiteWolfKing',
  'EvilKnight',
  'WolfKing',
  'WolfBeauty',
  'Seer',
  'Witch',
  'Hunter',
  'Guard',
  'Idiot',
  'Knight',
  'Elder',
  'Gravekeeper',
  'Villager',
];

/**
 * 每种人数的"标准配置"，只是建房时的默认值；房主可以完全自定义（D38）。
 * 4/5 与 13–18 是为了让房主能开小局/大局补的，不是平衡性推荐。
 */
export const ROLE_CONFIG = {
  4: ['Werewolf', 'Seer', 'Witch', 'Villager'],
  5: ['Werewolf', 'Werewolf', 'Seer', 'Witch', 'Villager'],
  6: ['Werewolf', 'Werewolf', 'Seer', 'Witch', 'Hunter', 'Villager'],
  7: ['Werewolf', 'Werewolf', 'Seer', 'Witch', 'Hunter', 'Villager', 'Villager'],
  8: ['Werewolf', 'Werewolf', 'Werewolf', 'Seer', 'Witch', 'Hunter', 'Villager', 'Villager'],
  9: ['Werewolf', 'Werewolf', 'Werewolf', 'Seer', 'Witch', 'Hunter', 'Villager', 'Villager', 'Villager'],
  10: ['Werewolf', 'Werewolf', 'WhiteWolfKing', 'Seer', 'Witch', 'Hunter', 'Guard', 'Villager', 'Villager', 'Villager'],
  11: ['Werewolf', 'Werewolf', 'Werewolf', 'WhiteWolfKing', 'Seer', 'Witch', 'Hunter', 'Guard', 'Idiot', 'Villager', 'Villager'],
  12: ['Werewolf', 'Werewolf', 'Werewolf', 'WhiteWolfKing', 'Seer', 'Witch', 'Hunter', 'Guard', 'Idiot', 'Villager', 'Villager', 'Villager'],
  13: ['Werewolf', 'Werewolf', 'Werewolf', 'WhiteWolfKing', 'Seer', 'Witch', 'Hunter', 'Guard', 'Idiot', 'Villager', 'Villager', 'Villager', 'Villager'],
  14: ['Werewolf', 'Werewolf', 'Werewolf', 'WhiteWolfKing', 'Seer', 'Witch', 'Hunter', 'Guard', 'Idiot', 'Villager', 'Villager', 'Villager', 'Villager', 'Villager'],
  15: ['Werewolf', 'Werewolf', 'Werewolf', 'Werewolf', 'WhiteWolfKing', 'Seer', 'Witch', 'Hunter', 'Guard', 'Idiot', 'Villager', 'Villager', 'Villager', 'Villager', 'Villager'],
  16: ['Werewolf', 'Werewolf', 'Werewolf', 'Werewolf', 'WhiteWolfKing', 'Seer', 'Witch', 'Hunter', 'Guard', 'Idiot', 'Villager', 'Villager', 'Villager', 'Villager', 'Villager', 'Villager'],
  17: ['Werewolf', 'Werewolf', 'Werewolf', 'Werewolf', 'Werewolf', 'WhiteWolfKing', 'Seer', 'Witch', 'Hunter', 'Guard', 'Idiot', 'Villager', 'Villager', 'Villager', 'Villager', 'Villager', 'Villager'],
  18: ['Werewolf', 'Werewolf', 'Werewolf', 'Werewolf', 'Werewolf', 'WhiteWolfKing', 'Seer', 'Witch', 'Hunter', 'Guard', 'Idiot', 'Villager', 'Villager', 'Villager', 'Villager', 'Villager', 'Villager', 'Villager'],
};

export const MIN_SEATS = 4;
export const MAX_SEATS = 18;

/**
 * 胜利条件（房主建房时选，用户 2026-10-25 拍板）：
 *   `side` 屠边 —— 狼人杀光所有**平民**或所有**神职**即胜（经典规则）
 *   `wipe` 屠城 —— 狼人必须杀光所有**好人**才胜
 * 好人胜永远是"狼人全部死亡"；同一夜双方全灭时好人优先胜。
 */
export const WIN_MODE_SIDE = 'side';
export const WIN_MODE_WIPE = 'wipe';
export const WIN_MODES = [WIN_MODE_SIDE, WIN_MODE_WIPE];

export function normalizeWinMode(value) {
  return value === WIN_MODE_WIPE ? WIN_MODE_WIPE : WIN_MODE_SIDE;
}

export function winModeName(mode) {
  return normalizeWinMode(mode) === WIN_MODE_WIPE ? '屠城' : '屠边';
}

/** 各阶段倒计时（毫秒，标称值；`timeoutScale` 会按比例缩）。 */
export const DURATION = {
  NIGHT_START: 4_000,
  NIGHT_ACTION: 60_000,
  NIGHT_RESOLVE: 3_000,
  DAY_START: 4_000,
  DAY_DEATH_GAP: 1_200,
  BADGE_SIGNUP: 45_000,
  BADGE_ELECTION: 45_000,
  SPEECH: 180_000,
  DAY_VOTE: 60_000,
  DAY_RESOLVE: 3_500,
  HUNTER_SHOOT: 45_000,
  BADGE_TRANSFER: 45_000,
  WWK_DECISION: 20_000,
  GAME_END_HOLD: 0,
};

/** 发言最少/最多字数（客户端也会拦，这里是服务端口径）。 */
export const SPEECH_MAX = 500;

/** 一局最长多久（之后整间房回收）；结算后保留多久（给复盘/再来一局）。 */
export const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
export const FINISHED_TTL_MS = 60 * 60 * 1000;

const ROLE_NAMES = {
  Werewolf: '狼人',
  WhiteWolfKing: '白狼王',
  EvilKnight: '恶夜骑士',
  WolfKing: '狼王',
  WolfBeauty: '狼美人',
  Seer: '预言家',
  Witch: '女巫',
  Hunter: '猎人',
  Guard: '守卫',
  Idiot: '白痴',
  Knight: '骑士',
  Elder: '长老',
  Gravekeeper: '守墓人',
  Villager: '平民',
};

export function roleName(role) {
  return ROLE_NAMES[role] || role;
}

const WOLF_ROLES = new Set(['Werewolf', 'WhiteWolfKing', 'EvilKnight', 'WolfKing', 'WolfBeauty']);

export function isWolfRole(role) {
  return WOLF_ROLES.has(role);
}

/** 好人神职（会受"长老被好人弄死"的全局失效影响；平民不受影响）。 */
export function isGoodGod(role) {
  return Boolean(role) && !isWolfRole(role) && role !== 'Villager';
}

/**
 * 校验房主给的角色配置。
 *
 * `roles` 可以是 { Werewolf: 3, Seer: 1, ... }（0 可省略），
 * 也可以直接是角色数组（等价于逐个数）。不传 = 用该人数的标准配置。
 *
 * 唯一的硬性规则（用户拍板）：**至少 1 只狼**、**总数正好等于座位数**；
 * 其余随便配 —— 双预言家、没女巫、很多白狼王都允许。
 *
 * @returns {{ok: true, counts: Record<string, number>, roles: string[]}
 *          | {ok: false, message: string}}
 */
export function validateRoleSetup(seats, roles, winMode = WIN_MODE_SIDE) {
  const total = Number(seats);
  if (!Number.isInteger(total) || total < MIN_SEATS || total > MAX_SEATS) {
    return { ok: false, message: `座位数要 ${MIN_SEATS}–${MAX_SEATS} 之间` };
  }

  const counts = Object.create(null);
  for (const key of ROLE_KEYS) counts[key] = 0;

  if (roles === undefined || roles === null) {
    for (const role of ROLE_CONFIG[total]) counts[role] += 1;
  } else if (Array.isArray(roles)) {
    for (const raw of roles) {
      const role = String(raw || '');
      if (!(role in counts)) return { ok: false, message: `不认识的角色：${role}` };
      counts[role] += 1;
    }
  } else if (typeof roles === 'object') {
    for (const [raw, rawCount] of Object.entries(roles)) {
      if (!(raw in counts)) return { ok: false, message: `不认识的角色：${raw}` };
      const n = Number(rawCount);
      if (!Number.isInteger(n) || n < 0 || n > total) {
        return { ok: false, message: `${roleName(raw)}的数量要是 0–${total} 的整数` };
      }
      counts[raw] = n;
    }
  } else {
    return { ok: false, message: '角色配置格式不对' };
  }

  let sum = 0;
  for (const key of ROLE_KEYS) sum += counts[key];
  if (sum !== total) {
    return { ok: false, message: `角色总数 ${sum} 个，和 ${total} 个座位对不上` };
  }
  // 狼阵营：狼人 / 白狼王 / 狼王 / 狼美人 / 恶夜骑士，任意一种都行（用户 2026-10-25 拍板）
  const wolfCount = ROLE_KEYS.filter((role) => isWolfRole(role)).reduce((n, role) => n + counts[role], 0);
  if (wolfCount < 1) {
    return { ok: false, message: '至少要放 1 个狼阵营角色（狼人 / 白狼王 / 狼王 / 狼美人 / 恶夜骑士）' };
  }
  // 屠边局：两边（平民、神职）都得有人，否则"屠边"没法判 —— 直接不让开房
  if (normalizeWinMode(winMode) === WIN_MODE_SIDE) {
    const villagerCount = counts.Villager;
    const godCount = ROLE_KEYS.filter((role) => isGoodGod(role)).reduce((n, role) => n + counts[role], 0);
    if (villagerCount < 1 || godCount < 1) {
      return {
        ok: false,
        message: `屠边局要同时有平民和神职（现在：平民 ${villagerCount} 个、神职 ${godCount} 个）`,
      };
    }
  }

  const list = [];
  for (const key of ROLE_KEYS) {
    for (let i = 0; i < counts[key]; i += 1) list.push(key);
  }
  return { ok: true, counts: { ...counts }, roles: list };
}

/** 给系统消息用的人话摘要，例如「3 狼人 · 1 预言家 · 4 平民」。 */
export function roleSetupSummary(counts) {
  return ROLE_KEYS.filter((role) => counts[role] > 0)
    .map((role) => `${counts[role]} ${roleName(role)}`)
    .join(' · ');
}

/** 洗牌（可注入 rng，测试里可复现）。 */
export function shuffle(list, rng = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 6 位数字房号：和旧狼人杀一致（平台 `normalizeCode` 只认字母码，所以狼人杀单独一条链路）。 */
function randomCode() {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += String(randomInt(10));
  return out;
}

function seatLabel(seat) {
  return `${seat + 1}号`;
}

/**
 * 引擎工厂。
 *
 * @param {object} [options]
 * @param {number} [options.timeoutScale] 倒计时缩放（只有测试传 0.1 之类）
 * @param {() => number} [options.rng] 随机源
 * @param {() => number} [options.now] 时钟
 * @param {(code: string) => void} [options.onChange] 房间状态变了（推 WS）
 * @param {(room: object) => void} [options.onGameEnd] 一局结束（写数据库）
 */
export function createWerewolfEngine(options = {}) {
  const {
    timeoutScale = 1,
    rng = Math.random,
    now = () => Date.now(),
    onChange = () => {},
    onGameEnd = () => {},
  } = options;

  /** code -> room */
  const rooms = new Map();
  /** userId -> code */
  const seatOf = new Map();
  /** code -> { timer, epoch } */
  const timers = new Map();

  let messageSeq = 0;
  const nextMessageId = () => `m${++messageSeq}`;

  /* ------------------------------ 计时器 ------------------------------ */

  function clearTimer(room) {
    const t = timers.get(room.code);
    if (t) {
      clearTimeout(t.timer);
      timers.delete(room.code);
    }
    room.deadline = 0;
  }

  /**
   * 当前阶段挂一个倒计时。`epoch` 保证"上一阶段的定时器"绝不会落到新阶段上
   * （狼人杀以前在这里吃过亏：房间删了状态机还在跑）。
   */
  function setPhase(room, phase, ms, onTimeout) {
    const g = room.game;
    if (!g) return;
    g.phase = phase;
    g.phaseStartedAt = now();
    clearTimer(room);
    const scaled = Math.max(0, Math.round(ms * timeoutScale));
    room.deadline = now() + scaled;
    const epoch = (g.epoch = (g.epoch || 0) + 1);
    const timer = setTimeout(() => {
      const entry = timers.get(room.code);
      if (!entry || entry.epoch !== epoch) return;
      timers.delete(room.code);
      if (!rooms.has(room.code) || room.game !== g) return;
      onTimeout();
    }, scaled);
    timer.unref?.();
    timers.set(room.code, { timer, epoch });
    changed(room);
  }

  function changed(room) {
    try {
      onChange(room.code);
    } catch {
      /* 推送失败不该影响游戏本身 */
    }
  }

  /* ------------------------------ 消息 ------------------------------ */

  function system(room, content) {
    const g = room.game;
    g.messages.push({
      id: nextMessageId(),
      seq: messageSeq,
      playerId: 'system',
      playerName: '主持人',
      content,
      timestamp: now(),
      day: g.day,
      phase: g.phase,
      isSystem: true,
    });
  }

  function speak(room, player, content, extra = {}) {
    const g = room.game;
    g.messages.push({
      id: nextMessageId(),
      seq: messageSeq,
      playerId: player.id,
      playerName: player.name,
      content,
      timestamp: now(),
      day: g.day,
      phase: g.phase,
      ...extra,
    });
  }

  /* ------------------------------ 玩家工具 ------------------------------ */

  const alive = (room) => room.game.players.filter((p) => p.alive);
  const byId = (room, id) => room.game.players.find((p) => p.id === id) || null;
  const bySeat = (room, seat) => room.game.players.find((p) => p.seat === seat) || null;
  const wolves = (room) => room.game.players.filter((p) => p.alive && isWolfRole(p.role));
  const goodSkillsOn = (room) => !room.game.goodSkillsDisabled;

  /**
   * 一个人出局。
   *
   * `reason` 决定"死了以后还能不能发动技能"以及"长老的死会不会封印好人神职"：
   *   wolf / milk / poison / vote / hunter / wolfKingShoot / knight / wwk / love / reflect
   * 只传座位时保持旧的默认行为（不触发特殊效果）。
   */
  function kill(room, seat, reason = '') {
    const p = bySeat(room, seat);
    if (!p || !p.alive) return null;
    p.alive = false;
    p.deathReason = reason;

    // 长老：被好人弄死 → 所有好人神职永久失去技能。
    // 被狼刀 / 奶穿 / 白狼王 / 狼美人殉情 / 反噬都不算"好人弄死"。
    if (p.role === 'Elder' && (['vote', 'poison', 'hunter', 'knight'].includes(reason) || p.abilities.poisoned)) {
      room.game.goodSkillsDisabled = true;
      for (const other of room.game.players) {
        if (isGoodGod(other.role)) {
          other.abilities.skillsBlocked = true;
          if (other.role === 'Hunter') other.abilities.hunterCanShoot = false;
        }
      }
    }

    // 猎人：被毒 / 奶穿 / 殉情时不能开枪；其余死法保持可开枪。
    if (p.role === 'Hunter' && (['poison', 'milk', 'love'].includes(reason) || p.abilities.poisoned)) {
      p.abilities.hunterCanShoot = false;
    }

    // 狼王：被毒、自爆、殉情不能开枪；最后一匹狼也不能开枪。
    if (p.role === 'WolfKing') {
      const aliveWolves = room.game.players.filter((x) => x.alive && isWolfRole(x.role)).length;
      p.abilities.wolfKingCanShoot =
        aliveWolves > 0 && !p.abilities.poisoned && !['poison', 'selfDestruct', 'love'].includes(reason);
    }

    return p;
  }

  /** 这个玩家现在能不能开枪（猎人 / 狼王共用一套开枪队列）。 */
  function canShootNow(player) {
    if (!player || player.abilities?.skillsBlocked) return false;
    if (player.role === 'Hunter') return Boolean(player.abilities.hunterCanShoot);
    if (player.role === 'WolfKing') return Boolean(player.abilities.wolfKingCanShoot);
    return false;
  }

  function checkWinner(room) {
    const g = room.game;
    const players = g.players;
    const aliveWolves = players.filter((p) => p.alive && p.alignment === 'wolf').length;
    // 狼全死 → 好人胜。放在最前面：同一夜"女巫毒死最后一只狼、自己也被刀"时双方全灭，
    // 按用户定的规则判好人胜。
    if (aliveWolves === 0) return 'village';
    const aliveGood = players.filter((p) => p.alive && p.alignment === 'village');
    if (aliveGood.length === 0) return 'wolf';

    if (normalizeWinMode(g.winMode) === WIN_MODE_WIPE) return null;

    // 屠边：平民、神职任一边被杀光就判狼胜（哪边开局没配，开房时就已经被拦住了）。
    const godsAlive = aliveGood.some((p) => isGoodGod(p.role));
    const villagersAlive = aliveGood.some((p) => p.role === 'Villager');
    if (g.winModeSides?.gods && !godsAlive) return 'wolf';
    if (g.winModeSides?.villagers && !villagersAlive) return 'wolf';
    return null;
  }

  /* ------------------------------ 建房 / 加入 ------------------------------ */

  function newCode() {
    for (let i = 0; i < 200; i += 1) {
      const code = randomCode();
      if (!rooms.has(code)) return code;
    }
    throw new Error('房号用光了（这不正常）');
  }

  function createRoom({ host, seats = 8, password = '', roles = null, sheriff = true, winMode = WIN_MODE_SIDE }) {
    if (!host || !host.id) return { ok: false, message: '还没登录' };
    const seatCount = Number(seats);
    const mode = normalizeWinMode(winMode);
    const setup = validateRoleSetup(seatCount, roles, mode);
    if (!setup.ok) return setup;
    const existing = seatOf.get(host.id);
    if (existing) {
      const left = leaveRoom(host.id);
      if (!left.ok) return left;
    }

    const code = newCode();
    const room = {
      code,
      hostId: host.id,
      seats: seatCount,
      roles: setup.counts,
      sheriff: sheriff !== false,
      winMode: mode,
      password: String(password || ''),
      members: new Map(),
      order: [],
      phase: 'waiting',
      game: null,
      createdAt: now(),
      startedAt: 0,
      endedAt: 0,
      deadline: 0,
    };
    rooms.set(code, room);
    room.members.set(host.id, {
      id: host.id,
      name: host.name,
      avatar: host.avatar || '',
      joinedAt: now(),
    });
    room.order.push(host.id);
    seatOf.set(host.id, code);
    changed(room);
    return { ok: true, code };
  }

  function joinRoom({ user, code, password = '', friendBypass = false }) {
    if (!user || !user.id) return { ok: false, message: '还没登录' };
    const room = rooms.get(String(code || '').trim());
    if (!room) return { ok: false, message: '房间不存在或已解散' };

    const already = room.members.get(user.id);
    if (already) {
      already.name = user.name;
      already.avatar = user.avatar || already.avatar || '';
      seatOf.set(user.id, room.code);
      changed(room);
      return { ok: true, code: room.code, seat: room.order.indexOf(user.id) };
    }

    if (room.phase !== 'waiting') return { ok: false, message: '这局已经开始，进不去了（狼人杀不支持中途加入）' };
    if (room.members.size >= room.seats) return { ok: false, message: `房间满了（${room.seats} 个座位）` };
    if (room.password && !friendBypass && String(password || '') !== room.password) {
      return { ok: false, message: '密码不对' };
    }

    const existing = seatOf.get(user.id);
    if (existing && existing !== room.code) {
      const left = leaveRoom(user.id);
      // 开局之后 leaveRoom 会拒绝：这时绝不能换房。否则旧局会留下一个没人认领的座位，
      // 而 seatOf 被新房间覆盖之后，旧局连"这个座位是谁"都查不回来了。
      if (!left || !left.ok) return left || { ok: false, message: '你还在另一局里，打完再来' };
    }

    room.members.set(user.id, {
      id: user.id,
      name: user.name,
      avatar: user.avatar || '',
      joinedAt: now(),
    });
    room.order.push(user.id);
    seatOf.set(user.id, room.code);
    changed(room);
    return { ok: true, code: room.code, seat: room.order.indexOf(user.id) };
  }

  function leaveRoom(userId) {
    const code = seatOf.get(userId);
    if (!code) return { ok: false, message: '你不在任何房间里' };
    const room = rooms.get(code);
    if (!room) {
      seatOf.delete(userId);
      return { ok: true };
    }
    if (room.phase === 'playing') return { ok: false, message: '开局之后不能退房，等这一局打完' };

    seatOf.delete(userId);
    room.members.delete(userId);
    room.order = room.order.filter((id) => id !== userId);
    if (room.members.size === 0) {
      destroyRoom(room);
      return { ok: true, closed: true };
    }
    if (room.hostId === userId) {
      room.hostId = room.order[0];
    }
    changed(room);
    return { ok: true };
  }

  /**
   * 房主在等待区踢人。
   *
   * 没有这个接口的话，等待区里关掉页面的人会永久占着座位（引擎不会因为掉线自动清座），
   * 房子就只能解散重开。
   */
  function kickPlayer(userId, targetId) {
    const code = seatOf.get(userId);
    const room = code ? rooms.get(code) : null;
    if (!room) return { ok: false, message: '你不在任何房间里' };
    if (room.hostId !== userId) return { ok: false, message: '只有房主能踢人' };
    if (room.phase !== 'waiting') return { ok: false, message: '开局之后不能踢人' };
    const id = String(targetId || '');
    if (!room.members.has(id)) return { ok: false, message: '这个人已经不在房间里了' };
    if (id === userId) return { ok: false, message: '不能踢自己' };
    seatOf.delete(id);
    room.members.delete(id);
    room.order = room.order.filter((x) => x !== id);
    changed(room);
    return { ok: true };
  }

  /**
   * 一局打完之后房主点「再来一局」：房间退回等候区，座位、人、配置全部保留。
   * 没有这个接口的话，结算页的两个按钮都只能把玩家留在原地（H3）。
   */
  function restartRoom(userId) {
    const code = seatOf.get(userId);
    const room = code ? rooms.get(code) : null;
    if (!room) return { ok: false, message: '你不在任何房间里' };
    if (room.phase !== 'over') return { ok: false, message: '这一局还没结束' };
    if (room.hostId !== userId) return { ok: false, message: '只有房主能开下一局' };
    clearTimer(room);
    room.game = null;
    room.phase = 'waiting';
    room.deadline = null;
    room.startedAt = null;
    room.endedAt = null;
    changed(room);
    return { ok: true };
  }

  function destroyRoom(room) {
    clearTimer(room);
    rooms.delete(room.code);
    if (room.game) {
      for (const p of room.game.players) {
        if (seatOf.get(p.id) === room.code) seatOf.delete(p.id);
      }
    }
    for (const id of room.members.keys()) {
      if (seatOf.get(id) === room.code) seatOf.delete(id);
    }
  }

  /* ------------------------------ 开局 ------------------------------ */

  function startGame(userId) {
    const code = seatOf.get(userId);
    const room = code ? rooms.get(code) : null;
    if (!room) return { ok: false, message: '你不在任何房间里' };
    if (room.hostId !== userId) return { ok: false, message: '只有房主能开始游戏' };
    if (room.phase !== 'waiting') return { ok: false, message: '这局已经开始了' };
    if (room.members.size !== room.seats) {
      return {
        ok: false,
        message: `还差 ${room.seats - room.members.size} 个人（${room.seats} 个座位要坐满才能发牌）`,
      };
    }

    const setup = validateRoleSetup(room.seats, room.roles, room.winMode);
    if (!setup.ok) return setup;
    const roles = shuffle(setup.roles, rng);
    const players = room.order.map((id, seat) => {
      const m = room.members.get(id);
      const role = roles[seat];
      return {
        id,
        seat,
        name: m.name,
        avatar: m.avatar || '',
        role,
        alignment: isWolfRole(role) ? 'wolf' : 'village',
        alive: true,
        isHost: id === room.hostId,
        // 每个玩家独立的能力状态：允许同一角色出现多个人（双女巫/双守卫…）
        abilities: {
          healUsed: false,
          poisonUsed: false,
          hunterCanShoot: true,
          idiotRevealed: false,
          wwkUsed: false,
          // 长老：两条命（只对"狼人夜刀"生效）
          elderLives: 2,
          // 骑士：一局只能决斗一次
          knightUsed: false,
          // 狼王：出局时是否允许开枪（kill() 按死因算）
          wolfKingCanShoot: false,
          // 狼美人：昨晚魅惑了谁（不能连续两晚同一个人）
          lastCharmTarget: null,
          // 殉情/毒杀等"不能发动技能"的标记
          skillsBlocked: false,
          poisoned: false,
        },
        lastGuardTarget: null,
        seerHistory: [],
        charmedSeat: null,
      };
    });

    room.phase = 'playing';
    room.startedAt = now();
    room.game = {
      epoch: 0,
      phase: PHASE.WAITING,
      phaseStartedAt: now(),
      day: 0,
      players,
      roles: setup.counts,
      winMode: normalizeWinMode(room.winMode),
      // 屠边要判"平民全死""神职全死"，哪边开局没配就不作为条件（正常开房时两边必有）
      winModeSides: {
        villagers: setup.counts.Villager > 0,
        gods: ROLE_KEYS.filter((role) => isGoodGod(role)).reduce((n, role) => n + setup.counts[role], 0) > 0,
      },
      sheriffEnabled: room.sheriff,
      goodSkillsDisabled: false,
      evilReflectUsed: false,
      exileThisDay: null,
      messages: [],
      speaker: null,
      speechOrder: [],
      speechIndex: 0,
      night: {},
      badge: {
        holderSeat: null,
        candidates: [],
        revoteCount: 0,
      },
      signup: {},
      votes: {},
      badgeVotes: {},
      voteHistory: {},
      nightHistory: {},
      pkTargets: [],
      pkSource: null,
      winner: null,
      endedAt: 0,
      recordId: null,
    };

    system(room, `游戏开始：${room.seats} 人局（${roleSetupSummary(setup.counts)}），身份已随机分配。`);
    system(
      room,
      normalizeWinMode(room.winMode) === WIN_MODE_WIPE
        ? '本局规则：屠城 —— 狼人杀光所有好人才算赢；好人杀光所有狼即赢。'
        : '本局规则：屠边 —— 狼人杀光所有平民、或杀光所有神职即算赢；好人杀光所有狼即赢。',
    );
    enterNight(room, 1);
    changed(room);
    return { ok: true };
  }

  /* ------------------------------ 夜晚 ------------------------------ */

  function enterNight(room, day) {
    const g = room.game;
    g.day = day;
    g.speaker = null;
    g.speechOrder = [];
    // 狼美人的魅惑只在当晚有效。以前这里不清：某晚没魅惑（超时或者空过），
    // 之后被放逐时仍会把更早一晚的人带走。
    for (const p of g.players) p.charmedSeat = null;
    g.night = {
      guardTargets: [],
      guardQueue: [],
      guardIndex: 0,
      wolfVotes: {},
      wolfBeautyQueue: [],
      wolfBeautyIndex: 0,
      witchQueue: [],
      witchIndex: 0,
      saved: false,
      poisons: [],
      seerQueue: [],
      seerIndex: 0,
      actor: null,
      deaths: [],
      survived: [],
      // 恶夜骑士：同一晚的查验/毒杀候选，结算时只反伤一个（预言家优先）
      evilSeers: [],
      evilPoisoners: [],
      // 长老封印之后守墓人就该看不见了。这里必须在**服务端**拦住，
      // 不能只靠前端自己不显示 —— viewFor 是唯一的防作弊手段。
      graveInfo:
        goodSkillsOn(room) && g.exileThisDay
          ? {
              day: g.exileThisDay.day,
              seat: g.exileThisDay.seat,
              name: g.exileThisDay.name,
              alignment: g.exileThisDay.alignment,
            }
          : null,
    };
    g.exileThisDay = null;
    g.pkTargets = [];
    g.pkSource = null;
    system(room, `第 ${day} 夜 · 天黑请闭眼`);
    setPhase(room, PHASE.NIGHT_START, DURATION.NIGHT_START, () => nightGuard(room));
  }

  /**
   * 守卫可能不止一个（房主可以配双守卫）。每个人依次睁眼、各自守一个人，
   * "不能连续两晚守同一人"也是每个人各自记（存在 player.lastGuardTarget 上）。
   */
  function nightGuard(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    g.night.guardQueue = goodSkillsOn(room)
      ? alive(room).filter((p) => p.role === 'Guard').map((p) => p.id)
      : [];
    g.night.guardIndex = 0;
    if (g.night.guardQueue.length === 0) return nightWolf(room);
    system(room, '守卫请睁眼，选择今晚要守护的人（不能连续两晚守护同一人）。');
    nextGuard(room);
  }

  function nextGuard(room) {
    const g = room.game;
    while (g.night.guardIndex < g.night.guardQueue.length) {
      const guard = byId(room, g.night.guardQueue[g.night.guardIndex]);
      if (!guard || !guard.alive) {
        g.night.guardIndex += 1;
        continue;
      }
      g.night.actor = guard.id;
      setPhase(room, PHASE.NIGHT_GUARD_ACTION, DURATION.NIGHT_ACTION, () => {
        g.night.actor = null;
        g.night.guardIndex += 1;
        nextGuard(room);
      });
      return;
    }
    g.night.actor = null;
    nightWolf(room);
  }

  function resolveWolfVotes(room) {
    const g = room.game;
    const votes = Object.values(g.night.wolfVotes || {});
    const counts = new Map();
    for (const seat of votes) counts.set(seat, (counts.get(seat) || 0) + 1);
    // 平票 = 空刀；只有一个最高票才刀得出去（真人各投各的，这里取多数）
    let best = null;
    let bestCount = 0;
    let tie = false;
    for (const [seat, count] of counts) {
      if (count > bestCount) {
        best = seat;
        bestCount = count;
        tie = false;
      } else if (count === bestCount) {
        tie = true;
      }
    }
    g.night.wolfTarget = tie || best === null ? undefined : best;
    nightWolfBeauty(room);
  }

  /* ---------------------------- 狼美人 ---------------------------- */

  function nightWolfBeauty(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    g.night.wolfBeautyQueue = alive(room).filter((p) => p.role === 'WolfBeauty').map((p) => p.id);
    g.night.wolfBeautyIndex = 0;
    if (g.night.wolfBeautyQueue.length === 0) return nightWitch(room);
    system(room, '狼美人请睁眼，单独魅惑一名玩家（不能连续两晚魅惑同一个人）。');
    nextWolfBeauty(room);
  }

  function nextWolfBeauty(room) {
    const g = room.game;
    while (g.night.wolfBeautyIndex < g.night.wolfBeautyQueue.length) {
      const beauty = byId(room, g.night.wolfBeautyQueue[g.night.wolfBeautyIndex]);
      if (!beauty || !beauty.alive) {
        g.night.wolfBeautyIndex += 1;
        continue;
      }
      g.night.actor = beauty.id;
      setPhase(room, PHASE.NIGHT_WOLF_BEAUTY_ACTION, DURATION.NIGHT_ACTION, () => {
        g.night.actor = null;
        g.night.wolfBeautyIndex += 1;
        nextWolfBeauty(room);
      });
      return;
    }
    g.night.actor = null;
    nightWitch(room);
  }

  function nightWolf(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    const team = wolves(room);
    if (team.length === 0) return nightWitch(room);
    g.night.wolfVotes = {};
    g.night.wolfSeats = team.map((p) => p.seat);
    system(room, '狼人请睁眼，商量今晚要刀谁（每人各投一票，按多数决定；平票算空刀）。');
    setPhase(room, PHASE.NIGHT_WOLF_ACTION, DURATION.NIGHT_ACTION, () => resolveWolfVotes(room));
  }

  /** 女巫也可能不止一个：各自一瓶解药、一瓶毒药，依次行动。 */
  function nightWitch(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    g.night.witchQueue = goodSkillsOn(room)
      ? alive(room).filter((p) => p.role === 'Witch').map((p) => p.id)
      : [];
    g.night.witchIndex = 0;
    g.night.saved = false;
    g.night.poisons = [];
    if (g.night.witchQueue.length === 0) return nightSeer(room);
    system(room, '女巫请睁眼，决定是否用药（解药和毒药各一瓶，同一晚只能用一瓶）。');
    nextWitch(room);
  }

  function nextWitch(room) {
    const g = room.game;
    while (g.night.witchIndex < g.night.witchQueue.length) {
      const witch = byId(room, g.night.witchQueue[g.night.witchIndex]);
      if (!witch || !witch.alive) {
        g.night.witchIndex += 1;
        continue;
      }
      const canHeal =
        !witch.abilities.healUsed && g.night.wolfTarget !== undefined && !g.night.saved;
      const canPoison = !witch.abilities.poisonUsed;
      if (!canHeal && !canPoison) {
        g.night.witchIndex += 1;
        continue;
      }
      g.night.actor = witch.id;
      g.night.witchOptions = { canHeal, canPoison };
      setPhase(room, PHASE.NIGHT_WITCH_ACTION, DURATION.NIGHT_ACTION, () => {
        g.night.actor = null;
        g.night.witchOptions = null;
        g.night.witchIndex += 1;
        nextWitch(room);
      });
      return;
    }
    g.night.actor = null;
    g.night.witchOptions = null;
    nightSeer(room);
  }

  /** 预言家也可能不止一个：各自查验、各自只看到自己的结果。 */
  function nightSeer(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    g.night.seerQueue = goodSkillsOn(room)
      ? alive(room).filter((p) => p.role === 'Seer').map((p) => p.id)
      : [];
    g.night.seerIndex = 0;
    if (g.night.seerQueue.length === 0) return nightResolve(room);
    system(room, '预言家请睁眼，选择今晚要查验的人。');
    nextSeer(room);
  }

  function nextSeer(room) {
    const g = room.game;
    while (g.night.seerIndex < g.night.seerQueue.length) {
      const seer = byId(room, g.night.seerQueue[g.night.seerIndex]);
      if (!seer || !seer.alive) {
        g.night.seerIndex += 1;
        continue;
      }
      g.night.actor = seer.id;
      setPhase(room, PHASE.NIGHT_SEER_ACTION, DURATION.NIGHT_ACTION, () => {
        g.night.actor = null;
        g.night.seerIndex += 1;
        nextSeer(room);
      });
      return;
    }
    g.night.actor = null;
    nightResolve(room);
  }

  function nightResolve(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    g.night.deaths = [];
    g.night.survived = [];
    const { wolfTarget, guardTargets, saved, poisons } = g.night;

    if (wolfTarget !== undefined) {
      const victim = bySeat(room, wolfTarget);
      if (victim && victim.role === 'EvilKnight') {
        // 恶夜骑士永久免疫夜间刀伤；不产生死讯。
      } else {
        const protectedByGuard = guardTargets.includes(wolfTarget);
        const savedByWitch = saved === true;
        if (protectedByGuard && savedByWitch) {
          // 守卫 + 解药同时生效 = 依然死亡（上游的"奶穿"规则）
          g.night.deaths.push({ seat: wolfTarget, reason: 'milk' });
        } else if (!protectedByGuard && !savedByWitch) {
          if (victim && victim.role === 'Elder' && victim.abilities.elderLives > 1) {
            // 长老第一条命：刀不死，也不进入死讯。
            victim.abilities.elderLives -= 1;
            g.night.survived.push({ seat: wolfTarget, reason: 'elder' });
          } else {
            g.night.deaths.push({ seat: wolfTarget, reason: 'wolf' });
          }
        }
      }
    }

    for (const poison of poisons) {
      const victim = bySeat(room, poison.seat);
      if (!victim || victim.role === 'EvilKnight') continue; // 恶夜骑士免疫毒伤
      victim.abilities.poisoned = true;
      // 长老封印的标记**不在这里**置位：要等天亮公布死讯时由 kill() 统一设置，
      // 否则 NIGHT_RESOLVE 那 3 秒里 goodSkillsDisabled 已经翻真，等于提前泄密。
      if (!g.night.deaths.some((d) => d.seat === poison.seat)) {
        g.night.deaths.push({ seat: poison.seat, reason: 'poison' });
      }
    }

    // 恶夜骑士的反伤：同一晚同时被验+毒，只弹预言家；反伤全局只触发一次。
    if (!g.evilReflectUsed) {
      const seer = byId(room, g.night.evilSeers[0]);
      const witch = byId(room, g.night.evilPoisoners[0]);
      const reflected = seer && seer.alive ? seer : witch && witch.alive ? witch : null;
      if (reflected) {
        g.evilReflectUsed = true;
        g.night.reflectTargetId = reflected.id;
      }
    }

    g.nightHistory[g.day] = {
      guardTargets,
      wolfTarget,
      saved,
      poisons,
      deaths: g.night.deaths,
    };
    setPhase(room, PHASE.NIGHT_RESOLVE, DURATION.NIGHT_RESOLVE, () => dayStart(room));
  }

  /* ------------------------------ 白天 ------------------------------ */

  function dayStart(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    g.exileThisDay = null;
    // 恶夜骑士的反伤在"次日天亮"结算；如果目标已经死了就不重复。
    if (g.night.reflectTargetId) {
      const target = byId(room, g.night.reflectTargetId);
      if (target && target.alive && !g.night.deaths.some((d) => d.seat === target.seat)) {
        g.night.deaths.push({ seat: target.seat, reason: 'reflect' });
      }
      g.night.reflectTargetId = null;
    }
    system(room, '天亮了。');
    setPhase(room, PHASE.DAY_START, DURATION.DAY_START, () => announceDeaths(room));
  }

  /** 宣布昨夜死讯（只报座位和名字，不报身份）。 */
  function announceDeaths(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    const deaths = g.night.deaths || [];
    const wolfVictim = deaths.find((d) => d.reason === 'wolf' || d.reason === 'milk');
    const poisonVictim = deaths.find((d) => d.reason === 'poison');
    const shooters = [];

    // 长老第一刀不死也算平安夜：如果播"X 被袭击但活了下来"，等于当众亮长老
    // （守卫救/女巫救都是平安夜，只有长老会留下这种痕迹）。
    if (deaths.length === 0) {
      system(room, '昨晚是平安夜。');
    } else {
      for (const death of deaths) {
        const p = kill(room, death.seat, death.reason);
        if (!p) continue;
        if (death.reason === 'reflect') {
          system(room, `天亮时，${seatLabel(p.seat)} ${p.name} 因恶夜骑士的反噬死亡。`);
        } else {
          system(room, `昨晚，${seatLabel(p.seat)} ${p.name} 死亡。`);
        }
      }
      // 同一夜可能同时死掉两匹狼：等所有死讯结算完，再判断狼王是不是最后一匹狼。
      const aliveWolves = g.players.filter((p) => p.alive && isWolfRole(p.role)).length;
      for (const death of deaths) {
        const p = bySeat(room, death.seat);
        if (!p) continue;
        if (p.role === 'WolfKing' && !p.alive && aliveWolves === 0) {
          p.abilities.wolfKingCanShoot = false;
        }
        if (canShootNow(p) && !shooters.includes(p)) shooters.push(p);
      }
    }
    g.night.pendingWolfVictim = wolfVictim ? wolfVictim.seat : undefined;
    g.night.pendingPoisonVictim = poisonVictim ? poisonVictim.seat : undefined;

    // 死讯一结算完就判输赢：某一方已经死光 → 立刻结束，
    // 死人不再开枪、不再移交警徽、也不进白天（用户 2026-10-25 定的"立刻"）。
    const decided = checkWinner(room);
    if (decided) {
      endGame(room, decided);
      return;
    }

    // 死讯公布完，先让夜里死的人各留一段遗言（用户 2026-10-26 拍板），
    // 再移交警徽 / 猎人开枪。
    const deadPlayers = deaths.map((d) => bySeat(room, d.seat)).filter((p) => p && !p.alive);
    setPhase(room, PHASE.DAY_START, DURATION.DAY_DEATH_GAP, () =>
      nightLastWords(room, deadPlayers, () => afterNightDeaths(room, { shooters }))
    );
  }

  function afterNightDeaths(room, ctx) {
    const g = room.game;
    const sheriffSeat = g.badge.holderSeat;
    const sheriff = sheriffSeat !== null ? bySeat(room, sheriffSeat) : null;
    const deadSheriff = sheriff && !sheriff.alive ? sheriff : null;

    const then = () => {
      if (ctx.shooters.length > 0) {
        shootPlayers(room, ctx.shooters, () => continueAfterDeaths(room));
        return;
      }
      continueAfterDeaths(room);
    };

    if (deadSheriff) {
      // 夜里死掉的警长先移交警徽，再由猎人开枪 / 进入讨论
      badgeTransfer(room, deadSheriff, then);
      return;
    }
    then();
  }

  function continueAfterDeaths(room) {
    if (room.phase !== 'playing') return;
    const winner = checkWinner(room);
    if (winner) return endGame(room, winner);
    startDayFlow(room);
  }

  function startDayFlow(room) {
    const g = room.game;
    // 第一天先选警长；房主关了警长、或已经选过，就直接讨论。
    if (g.day === 1 && g.sheriffEnabled && g.badge.holderSeat === null && !g.badge.torn) {
      badgeSignup(room);
      return;
    }
    daySpeech(room);
  }

  /* ------------------------------ 警长竞选 ------------------------------ */

  function badgeSignup(room) {
    const g = room.game;
    g.signup = {};
    g.badge.candidates = [];
    system(room, '警长竞选开始：想竞选警长的玩家请报名。');
    g.speaker = null;
    setPhase(room, PHASE.DAY_BADGE_SIGNUP, DURATION.BADGE_SIGNUP, () => finishSignup(room));
  }

  function finishSignup(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    const candidates = alive(room)
      .filter((p) => g.signup[p.id] === true)
      .map((p) => p.seat)
      .sort((a, b) => a - b);

    if (candidates.length === 0) {
      system(room, '没有人竞选警长，本局没有警长。');
      daySpeech(room);
      return;
    }
    if (candidates.length === 1) {
      const p = bySeat(room, candidates[0]);
      g.badge.holderSeat = candidates[0];
      system(room, `只有 ${seatLabel(p.seat)} ${p.name} 竞选，自动当选警长。`);
      daySpeech(room);
      return;
    }
    g.badge.candidates = candidates;
    system(room, `共有 ${candidates.length} 人竞选警长，竞选发言开始。`);
    badgeSpeech(room, candidates, { pk: false });
  }

  function speechStartSeat(room, seats) {
    const aliveSeats = alive(room).map((p) => p.seat).sort((a, b) => a - b);
    const pool = seats ? seats.filter((s) => aliveSeats.includes(s)) : aliveSeats;
    if (pool.length === 0) return null;
    return pool[Math.floor(rng() * pool.length)];
  }

  /** 候选人的发言顺序：从随机一位开始，按座位顺时针。 */
  function rotateSeats(seats, start) {
    const sorted = [...seats].sort((a, b) => a - b);
    const index = sorted.indexOf(start);
    if (index < 0) return sorted;
    return [...sorted.slice(index), ...sorted.slice(0, index)];
  }

  function badgeSpeech(room, candidates, { pk }) {
    const g = room.game;
    const order = rotateSeats(candidates, speechStartSeat(room, candidates));
    g.badge.candidates = candidates;
    g.speaker = order[0] ?? null;
    g.speechOrder = order;
    g.speechIndex = 0;
    if (pk) system(room, '平票候选人进入 PK 发言。');
    setPhase(room, pk ? PHASE.DAY_PK_SPEECH : PHASE.DAY_BADGE_SPEECH, DURATION.SPEECH, () =>
      nextBadgeSpeaker(room, { pk })
    );
  }

  function nextBadgeSpeaker(room, { pk }) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    g.speechIndex += 1;
    if (g.speechIndex >= g.speechOrder.length) {
      badgeElection(room, { pk });
      return;
    }
    g.speaker = g.speechOrder[g.speechIndex];
    setPhase(room, pk ? PHASE.DAY_PK_SPEECH : PHASE.DAY_BADGE_SPEECH, DURATION.SPEECH, () =>
      nextBadgeSpeaker(room, { pk })
    );
  }

  function badgeElection(room, { pk }) {
    const g = room.game;
    g.badgeVotes = {};
    g.speaker = null;
    const candidates = g.badge.candidates;
    const voters = alive(room).filter((p) => !candidates.includes(p.seat));
    g.badgeVoterSeats = voters.map((p) => p.seat);
    system(room, pk ? 'PK 结束，请未竞选的玩家重新投票。' : '竞选发言结束，请未竞选的玩家投票选举警长。');
    // 全员上警：一个能投票的人都没有，别让全场白等 45 秒
    if (voters.length === 0) {
      g.badge.holderSeat = null;
      g.badge.torn = true;
      system(room, '所有存活玩家都上了警，没有人能投票，警徽流失。');
      daySpeech(room);
      return;
    }
    setPhase(room, PHASE.DAY_BADGE_ELECTION, DURATION.BADGE_ELECTION, () => finishBadgeElection(room));
  }

  function finishBadgeElection(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    const candidates = new Set(g.badge.candidates);
    const counts = new Map();
    for (const [voterId, seat] of Object.entries(g.badgeVotes)) {
      if (!candidates.has(seat)) continue;
      counts.set(seat, (counts.get(seat) || 0) + 1);
    }
    let best = null;
    let bestCount = 0;
    let tie = false;
    for (const [seat, count] of counts) {
      if (count > bestCount) {
        best = seat;
        bestCount = count;
        tie = false;
      } else if (count === bestCount) {
        tie = true;
      }
    }

    // 所有人都弃票：本局没有警长
    if (counts.size === 0) {
      g.badge.holderSeat = null;
      g.badge.torn = true;
      system(room, '没有人得到有效票，警徽流失，本局没有警长。');
      daySpeech(room);
      return;
    }

    if (best !== null && !tie) {
      const p = bySeat(room, best);
      g.badge.holderSeat = best;
      // 竞选票型（公开）
      const results = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([seat, count]) => ({
          targetSeat: seat,
          targetName: bySeat(room, seat)?.name || '',
          voterSeats: Object.entries(g.badgeVotes)
            .filter(([, s]) => s === seat)
            .map(([id]) => byId(room, id))
            .filter(Boolean)
            .map((p2) => p2.seat),
          voteCount: count,
        }));
      system(room, `[VOTE_RESULT]${JSON.stringify({ title: '警长竞选投票', results })}`);
      system(room, `${seatLabel(best)} ${p.name} 当选警长（${bestCount} 票）。`);
      daySpeech(room);
      return;
    }

    // 平票：先 PK 再投一次；第二次还平票就撕毁警徽
    const revote = (g.badge.revoteCount || 0) + 1;
    g.badge.revoteCount = revote;
    if (revote >= 2) {
      g.badge.holderSeat = null;
      g.badge.torn = true;
      system(room, '警长竞选再次平票，警徽被撕毁，本局没有警长。');
      daySpeech(room);
      return;
    }
    const topSeats = [...counts.entries()]
      .filter(([, c]) => c === bestCount)
      .map(([seat]) => seat)
      .sort((a, b) => a - b);
    system(room, `警长竞选平票：${topSeats.map(seatLabel).join('、')}，进入 PK 发言。`);
    g.badge.candidates = topSeats;
    badgeSpeech(room, topSeats, { pk: true });
  }

  /* ------------------------------ 白天讨论 ------------------------------ */

  function daySpeech(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    const aliveSeats = alive(room).map((p) => p.seat).sort((a, b) => a - b);
    const sheriffSeat = g.badge.holderSeat;
    const sheriffAlive = sheriffSeat !== null && aliveSeats.includes(sheriffSeat);
    const deadSeat = g.night.pendingWolfVictim;

    let startSeat;
    if (sheriffAlive) {
      startSeat = nextAliveSeat(room, sheriffSeat, true);
    } else if (deadSeat !== undefined) {
      startSeat = nextAliveSeat(room, deadSeat, false);
    } else {
      startSeat = aliveSeats[0] ?? null;
    }

    let order = startSeat === null ? [] : rotateSeats(aliveSeats, startSeat);
    // 警长最后发言
    if (sheriffAlive) order = [...order.filter((s) => s !== sheriffSeat), sheriffSeat];

    g.speechOrder = order;
    g.speechIndex = 0;
    g.speaker = order[0] ?? null;
    system(room, '开始讨论。轮到你时请发言，说完点「结束发言」。');
    setPhase(room, PHASE.DAY_SPEECH, DURATION.SPEECH, () => nextDaySpeaker(room));
  }

  function nextAliveSeat(room, fromSeat, excludeSheriff) {
    const seats = alive(room)
      .map((p) => p.seat)
      .filter((s) => !(excludeSheriff && s === room.game.badge.holderSeat))
      .sort((a, b) => a - b);
    if (seats.length === 0) return null;
    return seats.find((s) => s > fromSeat) ?? seats[0];
  }

  function nextDaySpeaker(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    g.speechIndex += 1;
    if (g.speechIndex >= g.speechOrder.length) {
      dayVote(room);
      return;
    }
    g.speaker = g.speechOrder[g.speechIndex];
    setPhase(room, PHASE.DAY_SPEECH, DURATION.SPEECH, () => nextDaySpeaker(room));
  }

  /* ------------------------------ 放逐投票 ------------------------------ */

  function dayVote(room, { revote = false } = {}) {
    const g = room.game;
    g.votes = {};
    g.speaker = null;
    const voters = alive(room).filter((p) => {
      if (p.abilities.idiotRevealed && p.role === 'Idiot') return false;
      if (revote && g.pkTargets.includes(p.seat)) return false;
      return true;
    });
    g.voterSeats = voters.map((p) => p.seat);
    system(room, revote ? 'PK 结束，请重新投票。' : '请投票放逐一名玩家（可以弃票）。');
    setPhase(room, PHASE.DAY_VOTE, DURATION.DAY_VOTE, () => finishDayVote(room));
  }

  function finishDayVote(room) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    const counts = new Map();
    const sheriffSeat = g.badge.holderSeat;
    for (const [voterId, seat] of Object.entries(g.votes)) {
      const voter = byId(room, voterId);
      if (!voter || !voter.alive) continue;
      const target = bySeat(room, seat);
      if (!target || !target.alive) continue;
      if (voter.abilities.idiotRevealed && voter.role === 'Idiot') continue;
      const weight = voter.seat === sheriffSeat ? 1.5 : 1;
      counts.set(seat, (counts.get(seat) || 0) + weight);
    }

    let best = null;
    let bestCount = 0;
    const top = [];
    for (const [seat, count] of counts) {
      if (count > bestCount) {
        best = seat;
        bestCount = count;
      }
    }
    for (const [seat, count] of counts) {
      if (count === bestCount && bestCount > 0) top.push(seat);
    }

    g.voteHistory[g.day] = { ...g.votes };

    // 给客户端渲染「投票结果卡」：这里已经是公开信息（投完才公布）
    const results = [];
    for (const [seatStr, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      const seat = Number(seatStr);
      const target = bySeat(room, seat);
      if (!target) continue;
      const voterSeats = Object.entries(g.votes)
        .filter(([, s]) => s === seat)
        .map(([id]) => byId(room, id))
        .filter(Boolean)
        .map((p) => p.seat);
      results.push({ targetSeat: seat, targetName: target.name, voterSeats, voteCount: voterSeats.length, weight: count });
    }
    if (results.length > 0) {
      system(room, `[VOTE_RESULT]${JSON.stringify({ title: '放逐投票结果', results })}`);
    }

    if (best === null) {
      system(room, '本轮无人被放逐（全部弃票）。');
      return afterDayVote(room, null);
    }

    if (top.length > 1) {
      if (!g.pkSource) {
        g.pkTargets = top.sort((a, b) => a - b);
        g.pkSource = 'vote';
        system(room, `投票平票：${g.pkTargets.map(seatLabel).join('、')} 进入 PK 发言。`);
        // 平票的几个人依次发言，然后重新投票
        g.speechOrder = rotateSeats(g.pkTargets, speechStartSeat(room, g.pkTargets));
        g.speechIndex = 0;
        g.speaker = g.speechOrder[0];
        setPhase(room, PHASE.DAY_PK_SPEECH, DURATION.SPEECH, () => {
          const gg = room.game;
          gg.speechIndex += 1;
          if (gg.speechIndex >= gg.speechOrder.length) {
            dayVote(room, { revote: true });
            return;
          }
          gg.speaker = gg.speechOrder[gg.speechIndex];
          setPhase(room, PHASE.DAY_PK_SPEECH, DURATION.SPEECH, () => nextPkSpeaker(room));
        });
        return;
      }
      system(room, '再次平票，本轮无人被放逐。');
      return afterDayVote(room, null);
    }

    // 唯一最高票
    const seat = best;
    const victim = bySeat(room, seat);
    if (!victim) return afterDayVote(room, null);

    // 已经翻过牌的白痴：再被投出也不再死亡（用户 2026-10-26 拍板，B 选项）。
    // 免疫是"牌面已公开"的状态，不受长老封印影响。
    if (victim.role === 'Idiot' && victim.abilities.idiotRevealed) {
      system(room, `${seatLabel(seat)} ${victim.name} 已经翻过白痴牌，本轮放逐无效。`);
      return afterDayVote(room, null);
    }

    if (victim.role === 'Idiot' && !g.goodSkillsDisabled) {
      victim.abilities.idiotRevealed = true;
      system(room, `${seatLabel(seat)} ${victim.name} 被投出，但他翻开白痴牌，免于死亡（此后失去投票权）。`);
      return afterDayVote(room, null);
    }

    kill(room, seat, 'vote');
    g.exileThisDay = {
      day: g.day,
      seat,
      name: victim.name,
      alignment: victim.alignment,
    };
    system(room, `${seatLabel(seat)} ${victim.name} 被放逐（${bestCount} 票）。`);

    // 狼美人被公投放逐：被魅惑的人跟着殉情，且殉情者不能发动技能。
    if (victim.role === 'WolfBeauty' && victim.charmedSeat !== null) {
      const lover = bySeat(room, victim.charmedSeat);
      if (lover && lover.alive && lover.id !== victim.id) {
        lover.abilities.skillsBlocked = true;
        kill(room, lover.seat, 'love');
        system(room, `${seatLabel(lover.seat)} ${lover.name} 是狼美人魅惑的人，跟着殉情出局。`);
        // 殉情的如果正好是警长，先移交警徽再让狼美人留遗言
        if (badgeIfDead(room, lover, () => lastWords(room, victim))) return;
      }
    }
    lastWords(room, victim);
  }

  function nextPkSpeaker(room) {
    const g = room.game;
    g.speechIndex += 1;
    if (g.speechIndex >= g.speechOrder.length) {
      dayVote(room, { revote: true });
      return;
    }
    g.speaker = g.speechOrder[g.speechIndex];
    setPhase(room, PHASE.DAY_PK_SPEECH, DURATION.SPEECH, () => nextPkSpeaker(room));
  }

  function afterDayVote(room, executed) {
    const g = room.game;
    g.pkTargets = [];
    g.pkSource = null;
    const winner = checkWinner(room);
    if (winner) return endGame(room, winner);
    if (!executed) {
      enterNight(room, g.day + 1);
      return;
    }
    // executed 走的遗言流程（lastWords）会继续往下走
  }

  /* ------------------------------ 遗言 / 开枪 / 移交警徽 ------------------------------ */

  /**
   * 遗言。给了 `after` 就按它继续（夜里死的人走这条）；
   * 没给就是传统路径：警徽移交 → 猎人开枪 → 天黑。
   */
  function lastWords(room, player, after) {
    const g = room.game;
    g.speaker = player.seat;
    g.speechOrder = [player.seat];
    g.speechIndex = 0;
    g.lastWordsAfter = typeof after === 'function' ? after : null;
    system(room, `${seatLabel(player.seat)} ${player.name} 发表遗言。`);
    setPhase(room, PHASE.DAY_LAST_WORDS, DURATION.SPEECH, () => finishLastWords(room, player));
  }

  /** 遗言结束（点「结束发言」和超时都走这里）。 */
  function finishLastWords(room, player) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    const after = g.lastWordsAfter;
    g.lastWordsAfter = null;
    g.speaker = null;
    if (typeof after === 'function') {
      after();
      return;
    }
    afterLastWords(room, player || null);
  }

  /** 夜里死的人按顺序留遗言，说完再继续（移交警徽 / 猎人开枪）。 */
  function nightLastWords(room, queue, then) {
    if (room.phase !== 'playing') return;
    const player = queue.shift();
    if (!player) {
      then();
      return;
    }
    lastWords(room, player, () => nightLastWords(room, queue, then));
  }

  function afterLastWords(room, player) {
    const g = room.game;
    if (!player) {
      // 兜底：找不到人就直接往下走，别把整局卡死在遗言阶段
      continueAfterDeaths(room);
      return;
    }
    const sheriffSeat = g.badge.holderSeat;
    const then = () => afterExecuted(room, player);

    if (sheriffSeat === player.seat && !player.alive) {
      badgeTransfer(room, player, then);
      return;
    }
    then();
  }

  function afterExecuted(room, player) {
    const g = room.game;
    const winner = checkWinner(room);
    if (winner) return endGame(room, winner);
    if (canShootNow(player)) {
      // 白天被放逐的猎人/狼王：开完枪直接进入夜晚
      shootPlayers(room, [player], () => {
        const w = checkWinner(room);
        if (w) return endGame(room, w);
        enterNight(room, g.day + 1);
      });
      return;
    }
    enterNight(room, g.day + 1);
  }

  /** 依次处理多个猎人（房主可以配多个猎人；夜里可能同时死几个）。 */
  /** 猎人 / 狼王共用的开枪队列；可以连续排队，也能被枪杀后连锁。 */
  function shootPlayers(room, players, after = () => continueAfterDeaths(room)) {
    const queue = players.filter(canShootNow);
    const step = () => {
      const shooter = queue.shift();
      if (!shooter) {
        after();
        return;
      }
      if (!canShootNow(shooter)) {
        step();
        return;
      }
      shootPlayer(room, shooter, () => {
        const winner = checkWinner(room);
        if (winner) {
          endGame(room, winner);
          return;
        }
        step();
      });
    };
    step();
  }

  function shootPlayer(room, player, after) {
    const g = room.game;
    // 一枪只开一次：先消耗掉，防止同一个人在"夜死队列"和"链式开枪"里被排两次
    if (player.role === 'Hunter') player.abilities.hunterCanShoot = false;
    if (player.role === 'WolfKing') player.abilities.wolfKingCanShoot = false;
    g.pending = { type: 'shoot', seat: player.seat, role: player.role };
    g.hunterAfter = after;
    system(
      room,
      `${seatLabel(player.seat)} ${player.name} 是${roleName(player.role)}，请选择要带走的人（也可以不开枪）。`,
    );
    setPhase(room, PHASE.HUNTER_SHOOT, DURATION.HUNTER_SHOOT, () => {
      g.pending = null;
      const cont = g.hunterAfter;
      g.hunterAfter = null;
      if (typeof cont === 'function') cont();
    });
  }

  /**
   * 这个人已经死了、而且是警长 → 当场移交警徽，再继续 `then`。
   * 返回 true 表示后续流程已经被接管（调用方不要再自己往下走）。
   */
  function badgeIfDead(room, player, then) {
    const g = room.game;
    if (player && !player.alive && g.badge.holderSeat === player.seat) {
      badgeTransfer(room, player, then);
      return true;
    }
    return false;
  }

  function badgeTransfer(room, sheriff, after) {
    const g = room.game;
    g.pending = { type: 'badgeTransfer', seat: sheriff.seat };
    g.pendingAfter = after;
    system(room, `${seatLabel(sheriff.seat)} ${sheriff.name} 是警长，请移交警徽（也可以撕毁）。`);
    setPhase(room, PHASE.BADGE_TRANSFER, DURATION.BADGE_TRANSFER, () => {
      g.badge.holderSeat = null;
      g.pending = null;
      const cont = g.pendingAfter;
      g.pendingAfter = null;
      system(room, '警长没有移交，警徽自动撕毁。');
      if (typeof cont === 'function') cont();
      else continueAfterDeaths(room);
    });
  }

  /* ------------------------------ 狼王自爆 ------------------------------ */

  function wolfKingSelfDestruct(room, player) {
    const g = room.game;
    kill(room, player.seat, 'selfDestruct');
    g.phase = PHASE.WHITE_WOLF_KING_BOOM;
    system(room, `狼王 ${seatLabel(player.seat)} ${player.name} 自爆出局。`);
    const sheriffSeat = g.badge.holderSeat;
    if (sheriffSeat !== null) {
      const sheriff = bySeat(room, sheriffSeat);
      if (sheriff && !sheriff.alive) {
        g.badge.holderSeat = null;
        system(room, `警长 ${seatLabel(sheriffSeat)} 随之出局，警徽撕毁。`);
      }
    }
    const winner = checkWinner(room);
    if (winner) return endGame(room, winner);
    enterNight(room, g.day + 1);
  }

  /* ------------------------------ 骑士决斗 ------------------------------ */

  function knightDuel(room, knight, target) {
    const g = room.game;
    knight.abilities.knightUsed = true;
    if (isWolfRole(target.role)) {
      kill(room, target.seat, 'knight');
      system(
        room,
        `骑士 ${seatLabel(knight.seat)} ${knight.name} 翻牌决斗 ${seatLabel(target.seat)} ${target.name}：对方是${roleName(target.role)}，决斗成功，对方出局，立刻天黑。`,
      );
      const winner = checkWinner(room);
      if (winner) return endGame(room, winner);
      const toNight = () => {
        const w = checkWinner(room);
        if (w) return endGame(room, w);
        enterNight(room, g.day + 1);
      };
      const cont = () => {
        if (canShootNow(target)) {
          shootPlayers(room, [target], toNight);
        } else {
          toNight();
        }
      };
      // 被决斗死的狼如果戴着警徽，要当场移交
      if (!badgeIfDead(room, target, cont)) cont();
      return;
    }

    kill(room, knight.seat, 'knight');
    system(
      room,
      `骑士 ${seatLabel(knight.seat)} ${knight.name} 翻牌决斗 ${seatLabel(target.seat)} ${target.name}：对方是好人，骑士出局，白天继续。`,
    );
    const winner = checkWinner(room);
    if (winner) return endGame(room, winner);
    const cont = () => continueDayAfterKnight(room, knight);
    if (g.badge.holderSeat === knight.seat) {
      badgeTransfer(room, knight, cont);
    } else {
      cont();
    }
  }

  function continueDayAfterKnight(room, knight) {
    const g = room.game;
    if (room.phase !== 'playing') return;
    if (g.speaker !== knight.seat) return;
    if (g.phase === PHASE.DAY_PK_SPEECH) {
      nextPkSpeaker(room);
      return;
    }
    if (g.phase === PHASE.DAY_SPEECH) {
      nextDaySpeaker(room);
      return;
    }
    g.speaker = null;
  }

  /* ------------------------------ 白狼王自爆 ------------------------------ */

  /**
   * 规矩是「**先自爆、再带人**」：点自爆当场出局，然后给他 WWK_DECISION 秒点一个人带走；
   * 不点（或超时）就没人被带走。带走的人没有遗言，警长死了警徽直接撕毁。
   */
  function whiteWolfKingDetonate(room, player) {
    const g = room.game;
    player.abilities.wwkUsed = true;
    kill(room, player.seat, 'selfDestruct');
    g.speaker = null;
    g.pending = { type: 'wwkBoom', seat: player.seat };

    const sheriffSeat = g.badge.holderSeat;
    if (sheriffSeat !== null) {
      const sheriff = bySeat(room, sheriffSeat);
      if (sheriff && !sheriff.alive) {
        g.badge.holderSeat = null;
        system(room, `警长 ${seatLabel(sheriffSeat)} 随之出局，警徽撕毁。`);
      }
    }

    const winner = checkWinner(room);
    if (winner) {
      g.pending = null;
      return endGame(room, winner);
    }
    const seconds = Math.round(DURATION.WWK_DECISION / 1000);
    system(
      room,
      `白狼王 ${seatLabel(player.seat)} ${player.name} 自爆出局，他还能带走一个人（${seconds} 秒内选择，不选就没人被带走）。`,
    );
    setPhase(room, PHASE.WHITE_WOLF_KING_BOOM, DURATION.WWK_DECISION, () => {
      g.pending = null;
      system(room, `白狼王 ${seatLabel(player.seat)} ${player.name} 没有带走任何人。`);
      whiteWolfKingBoomDone(room, player, null);
    });
  }

  /** 白狼王这一轮全部结束：检查输赢 → 被带走的猎人/狼王开枪 → 直接进下一夜。 */
  function whiteWolfKingBoomDone(room, player, target) {
    const g = room.game;
    const winner = checkWinner(room);
    if (winner) return endGame(room, winner);
    // 被带走的猎人/狼王可以开枪（开完枪就进夜晚）
    if (canShootNow(target)) {
      shootPlayers(room, [target], () => {
        const w = checkWinner(room);
        if (w) return endGame(room, w);
        enterNight(room, g.day + 1);
      });
      return;
    }
    // 自爆结束白天，直接进入下一夜（跳过放逐投票）
    enterNight(room, g.day + 1);
  }

  /** 自爆之后点人要带走谁（`seat === null` = 谁也不带）。 */
  function whiteWolfKingPick(room, player, seat) {
    const g = room.game;
    g.pending = null;
    const target = seat === null || seat === undefined ? null : bySeat(room, Number(seat));
    if (target && target.alive && target.seat !== player.seat) {
      kill(room, target.seat, 'wwk');
      system(room, `白狼王 ${seatLabel(player.seat)} ${player.name} 带走了 ${seatLabel(target.seat)} ${target.name}。`);
      // 被带走的是警长就当场移交，别拖到第二天天亮
      if (badgeIfDead(room, target, () => whiteWolfKingBoomDone(room, player, target))) return;
      return whiteWolfKingBoomDone(room, player, target);
    }
    system(room, `白狼王 ${seatLabel(player.seat)} ${player.name} 没有带走任何人。`);
    return whiteWolfKingBoomDone(room, player, null);
  }

  /* ------------------------------ 结束 ------------------------------ */

  function endGame(room, winner) {
    const g = room.game;
    g.winner = winner;
    g.endedAt = now();
    room.endedAt = now();
    room.phase = 'over';
    clearTimer(room);
    system(room, winner === 'village' ? '游戏结束：好人阵营胜利。' : '游戏结束：狼人阵营胜利。');
    const reveal = {
      winner,
      players: g.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map((p) => ({ playerId: p.id, seat: p.seat, name: p.name, role: p.role, alive: p.alive })),
    };
    system(room, `[ROLE_REVEAL]${JSON.stringify(reveal)}`);
    g.phase = PHASE.GAME_END;
    try {
      onGameEnd(room);
    } catch (err) {
      console.error('[狼人杀] 结算回调失败：', err && err.message);
    }
    changed(room);
  }

  /* ------------------------------ 操作入口 ------------------------------ */

  function act(userId, action) {
    const code = seatOf.get(userId);
    const room = code ? rooms.get(code) : null;
    if (!room) return { ok: false, message: '你不在任何房间里' };
    const g = room.game;
    if (!g || room.phase !== 'playing') return { ok: false, message: '这一局还没开始' };
    const me = byId(room, userId);
    if (!me) return { ok: false, message: '你没有座位' };

    const type = String((action && action.type) || '');

    // 发言 / 结束发言：所有发言阶段共用
    if (type === 'speech') {
      if (!isSpeechPhase(g.phase)) return { ok: false, message: '现在不是发言时间' };
      // 遗言阶段允许"已经出局的人"说话；其余发言阶段必须活着
      if (!me.alive && g.phase !== PHASE.DAY_LAST_WORDS) return { ok: false, message: '你已经出局，不能发言' };
      if (g.speaker !== me.seat) return { ok: false, message: '还没轮到你发言' };
      const text = String(action.text || '').trim().slice(0, SPEECH_MAX);
      if (!text) return { ok: false, message: '说点什么再发' };
      speak(room, me, text, { isLastWords: g.phase === PHASE.DAY_LAST_WORDS });
      changed(room);
      return { ok: true };
    }

    if (type === 'endSpeech') {
      if (!isSpeechPhase(g.phase)) return { ok: false, message: '现在不是发言时间' };
      if (g.speaker !== me.seat) return { ok: false, message: '还没轮到你' };
      advanceSpeech(room);
      return { ok: true };
    }

    /*
     * 狼人夜间频道。
     *
     * 白天是全员听得见的 `speech`，这里是**只有狼队**看得到的文字 —— 引擎喊了
     * "商量今晚要刀谁"，总得有地方商量。消息带 `scope:'wolf'`，由 viewFor 按人裁剪，
     * 好人拿到的报文里根本不存在这些条目。
     */
    if (type === 'wolfChat') {
      if (g.phase !== PHASE.NIGHT_WOLF_ACTION) return { ok: false, message: '现在不是狼人交流的时间' };
      if (!me.alive || !isWolfRole(me.role)) return { ok: false, message: '只有狼人能用这个频道' };
      const text = String(action.text || '').trim().slice(0, SPEECH_MAX);
      if (!text) return { ok: false, message: '说点什么再发' };
      speak(room, me, text, { scope: 'wolf' });
      changed(room);
      return { ok: true };
    }

    // 夜晚动作
    if (g.phase === PHASE.NIGHT_GUARD_ACTION) {
      if (!me.alive || me.role !== 'Guard' || g.night.actor !== me.id) {
        return { ok: false, message: '现在不是你的行动' };
      }
      if (type !== 'guard') return { ok: false, message: '守卫请选择守护目标' };
      const seat = action.seat;
      if (seat !== null && seat !== undefined) {
        const target = bySeat(room, Number(seat));
        if (!target || !target.alive) return { ok: false, message: '这个座位不能守护' };
        if (me.lastGuardTarget === target.seat) return { ok: false, message: '不能连续两晚守护同一个人' };
        if (!g.night.guardTargets.includes(target.seat)) g.night.guardTargets.push(target.seat);
        me.lastGuardTarget = target.seat;
      } else {
        // 空守：今晚不守任何人。连守记录也要清掉，否则"不能连续两晚守同一人"
        // 会变成"隔一晚也不能守"。
        me.lastGuardTarget = null;
      }
      g.night.actor = null;
      g.night.guardIndex += 1;
      nextGuard(room);
      return { ok: true };
    }

    if (g.phase === PHASE.NIGHT_WOLF_ACTION) {
      if (!me.alive || !isWolfRole(me.role)) return { ok: false, message: '现在不是你的行动' };
      if (type !== 'wolf') return { ok: false, message: '狼人请选择目标' };
      if (action.seat === null || action.seat === undefined) {
        delete g.night.wolfVotes[me.id];
      } else {
        const target = bySeat(room, Number(action.seat));
        if (!target || !target.alive) return { ok: false, message: '这个座位不能刀' };
        if (target.seat === me.seat && ['EvilKnight', 'WolfBeauty'].includes(me.role)) {
          return { ok: false, message: '这个角色不能自刀' };
        }
        g.night.wolfVotes[me.id] = target.seat;
      }
      changed(room);
      const wolfIds = wolves(room).map((p) => p.id);
      if (wolfIds.every((id) => typeof g.night.wolfVotes[id] === 'number')) resolveWolfVotes(room);
      return { ok: true };
    }

    if (g.phase === PHASE.NIGHT_WOLF_BEAUTY_ACTION) {
      if (!me.alive || me.role !== 'WolfBeauty' || g.night.actor !== me.id) {
        return { ok: false, message: '现在不是你的行动' };
      }
      if (type !== 'charm') return { ok: false, message: '狼美人请选择魅惑目标（也可以空过）' };
      if (action.seat === null || action.seat === undefined) {
        // 空过：今晚谁也不魅惑。（以前这里会被 Number(null) = 0 当成 0 号座位）
        me.charmedSeat = null;
        g.night.actor = null;
        g.night.wolfBeautyIndex += 1;
        nextWolfBeauty(room);
        return { ok: true };
      }
      const target = bySeat(room, Number(action.seat));
      if (!target || !target.alive) return { ok: false, message: '这个座位不能魅惑' };
      if (target.seat === me.seat) return { ok: false, message: '不能魅惑自己' };
      if (me.abilities.lastCharmTarget === target.seat) {
        return { ok: false, message: '不能连续两晚魅惑同一个人' };
      }
      me.charmedSeat = target.seat;
      me.abilities.lastCharmTarget = target.seat;
      // 魅惑是暗牌：只写进她自己的私有视图，**不许**发系统消息
      // （以前这里 system("X 魅惑了 Y") 是全房广播，等于每晚把狼美人亮出来）
      g.night.actor = null;
      g.night.wolfBeautyIndex += 1;
      nextWolfBeauty(room);
      return { ok: true };
    }

    if (g.phase === PHASE.NIGHT_WITCH_ACTION) {
      if (!me.alive || me.role !== 'Witch' || g.night.actor !== me.id) {
        return { ok: false, message: '现在不是你的行动' };
      }
      if (type !== 'witch') return { ok: false, message: '女巫请选择用药' };
      const options = g.night.witchOptions || { canHeal: false, canPoison: false };
      const choose = String(action.action || 'pass');
      if (choose === 'save') {
        if (me.abilities.healUsed) return { ok: false, message: '解药已经用过了' };
        if (!options.canHeal) return { ok: false, message: '今晚已经有人救了，或者没有人被刀' };
        me.abilities.healUsed = true;
        g.night.saved = true;
      } else if (choose === 'poison') {
        if (me.abilities.poisonUsed) return { ok: false, message: '毒药已经用过了' };
        if (!options.canPoison) return { ok: false, message: '毒药已经用过了' };
        const target = bySeat(room, Number(action.seat));
        if (!target || !target.alive) return { ok: false, message: '这个座位不能毒' };
        if (target.seat === me.seat) return { ok: false, message: '不能毒自己' };
        me.abilities.poisonUsed = true;
        if (!g.night.poisons.some((p) => p.seat === target.seat)) {
          g.night.poisons.push({ seat: target.seat, by: me.id });
        }
        if (target.role === 'EvilKnight') g.night.evilPoisoners.push(me.id);
      }
      g.night.actor = null;
      g.night.witchOptions = null;
      g.night.witchIndex += 1;
      nextWitch(room);
      return { ok: true };
    }

    if (g.phase === PHASE.NIGHT_SEER_ACTION) {
      if (!me.alive || me.role !== 'Seer' || g.night.actor !== me.id) {
        return { ok: false, message: '现在不是你的行动' };
      }
      if (type !== 'seer') return { ok: false, message: '预言家请选择查验目标（也可以今晚不验）' };
      if (action.seat === null || action.seat === undefined) {
        // 空验：今晚不查。（以前这里会被 Number(null) = 0 当成 0 号座位）
        g.night.actor = null;
        g.night.seerIndex += 1;
        nextSeer(room);
        return { ok: true };
      }
      const target = bySeat(room, Number(action.seat));
      if (!target || !target.alive) return { ok: false, message: '这个座位不能查验' };
      if (target.seat === me.seat) return { ok: false, message: '不能查验自己' };
      const isWolf = isWolfRole(target.role);
      me.seerHistory.push({ targetSeat: target.seat, isWolf, day: g.day });
      if (target.role === 'EvilKnight') g.night.evilSeers.push(me.id);
      g.night.actor = null;
      g.night.seerIndex += 1;
      nextSeer(room);
      return { ok: true };
    }

    // 警长报名
    if (g.phase === PHASE.DAY_BADGE_SIGNUP) {
      if (!me.alive) return { ok: false, message: '你已经出局' };
      if (typeof g.signup[me.id] === 'boolean') return { ok: false, message: '你已经表过态了' };
      if (type !== 'signup') return { ok: false, message: '请选择是否竞选警长' };
      g.signup[me.id] = Boolean(action.wants);
      changed(room);
      if (alive(room).every((p) => typeof g.signup[p.id] === 'boolean')) finishSignup(room);
      return { ok: true };
    }

    // 警长投票
    if (g.phase === PHASE.DAY_BADGE_ELECTION) {
      if (!me.alive) return { ok: false, message: '你已经出局' };
      if (g.badge.candidates.includes(me.seat)) return { ok: false, message: '候选人不能投票' };
      if (typeof g.badgeVotes[me.id] === 'number') return { ok: false, message: '你已经投过了' };
      if (type !== 'badgeVote') return { ok: false, message: '请投票选警长' };
      if (action.seat === null || action.seat === undefined) {
        g.badgeVotes[me.id] = -1;
      } else {
        const seat = Number(action.seat);
        if (!g.badge.candidates.includes(seat)) return { ok: false, message: '只能投给竞选的人' };
        g.badgeVotes[me.id] = seat;
      }
      changed(room);
      const voterIds = alive(room)
        .filter((p) => !g.badge.candidates.includes(p.seat))
        .map((p) => p.id);
      if (voterIds.length > 0 && voterIds.every((id) => typeof g.badgeVotes[id] === 'number')) finishBadgeElection(room);
      return { ok: true };
    }

    // 放逐投票
    if (g.phase === PHASE.DAY_VOTE) {
      // 自爆可以打断投票；这两个动作必须放在"请投票"校验之前。
      if (type === 'wolfSelfDestruct' && me.alive && me.role === 'WolfKing') {
        wolfKingSelfDestruct(room, me);
        return { ok: true };
      }
      if (type === 'wwkBoom' && me.alive && me.role === 'WhiteWolfKing') {
        if (me.abilities.wwkUsed) return { ok: false, message: '已经自爆过了' };
        whiteWolfKingDetonate(room, me);
        return { ok: true };
      }
      if (!me.alive) return { ok: false, message: '你已经出局' };
      if (me.abilities.idiotRevealed && me.role === 'Idiot') return { ok: false, message: '翻牌白痴没有投票权' };
      if (g.pkTargets.length && g.pkTargets.includes(me.seat)) return { ok: false, message: 'PK 中的玩家不能投票' };
      if (typeof g.votes[me.id] === 'number') return { ok: false, message: '你已经投过了' };
      if (type !== 'vote') return { ok: false, message: '请投票' };
      if (action.seat === null || action.seat === undefined) {
        g.votes[me.id] = -1;
      } else {
        const target = bySeat(room, Number(action.seat));
        if (!target || !target.alive) return { ok: false, message: '这个座位不能投' };
        if (target.seat === me.seat) return { ok: false, message: '不能投自己' };
        // PK 复投只能投台上的人（以前能投台下第三人，还真能把他投出去）
        if (g.pkTargets.length > 0 && !g.pkTargets.includes(target.seat)) {
          return { ok: false, message: '这一轮只能投 PK 台上的玩家' };
        }
        g.votes[me.id] = target.seat;
      }
      changed(room);
      const voterIds = alive(room)
        .filter((p) => !(p.abilities.idiotRevealed && p.role === 'Idiot'))
        .filter((p) => !(g.pkTargets.length && g.pkTargets.includes(p.seat)))
        .map((p) => p.id);
      if (voterIds.length > 0 && voterIds.every((id) => typeof g.votes[id] === 'number')) finishDayVote(room);
      return { ok: true };
    }

    // 猎人 / 狼王开枪
    if (g.phase === PHASE.HUNTER_SHOOT) {
      if (!g.pending || g.pending.type !== 'shoot' || g.pending.seat !== me.seat) {
        return { ok: false, message: '现在不是你的行动' };
      }
      if (!['hunter', 'shoot'].includes(type)) return { ok: false, message: '请选择要带走的人' };
      const after = g.hunterAfter;
      let target = null;
      if (action.seat !== null && action.seat !== undefined) {
        target = bySeat(room, Number(action.seat));
        if (!target || !target.alive || target.seat === me.seat) {
          return { ok: false, message: '这个座位不能开枪' };
        }
      }
      g.hunterAfter = null;
      g.pending = null;
      const shooterName = roleName(me.role);
      if (target) {
        kill(room, target.seat, me.role === 'WolfKing' ? 'wolfKingShoot' : 'hunter');
        system(room, `${shooterName} ${seatLabel(me.seat)} ${me.name} 开枪带走了 ${seatLabel(target.seat)} ${target.name}。`);
      } else {
        system(room, `${shooterName} ${seatLabel(me.seat)} ${me.name} 没有开枪。`);
      }
      // 被带走的如果也是猎人/狼王，继续连锁开枪
      const cont = () => {
        if (canShootNow(target)) {
          shootPlayer(room, target, after);
        } else if (typeof after === 'function') {
          after();
        } else {
          continueAfterDeaths(room);
        }
      };
      // 被枪杀的如果是警长，警徽当场移交（以前要拖到第二天天亮）
      if (!badgeIfDead(room, target, cont)) cont();
      return { ok: true };
    }

    // 移交警徽
    if (g.phase === PHASE.BADGE_TRANSFER) {
      if (!g.pending || g.pending.type !== 'badgeTransfer' || g.pending.seat !== me.seat) {
        return { ok: false, message: '现在不是你的行动' };
      }
      if (type !== 'transfer') return { ok: false, message: '请选择警徽去向' };
      let transferSeat = null;
      if (action.seat !== null && action.seat !== undefined) {
        const target = bySeat(room, Number(action.seat));
        if (!target || !target.alive) return { ok: false, message: '只能移交给活着的玩家' };
        transferSeat = target.seat;
      }
      g.pending = null;
      if (transferSeat === null) {
        g.badge.holderSeat = null;
        system(room, `${seatLabel(me.seat)} ${me.name} 撕毁了警徽。`);
      } else {
        const target = bySeat(room, transferSeat);
        g.badge.holderSeat = target.seat;
        system(room, `${seatLabel(me.seat)} ${me.name} 把警徽移交给 ${seatLabel(target.seat)} ${target.name}。`);
      }
      // 移交完继续原本的后续流程
      const after = g.pendingAfter;
      g.pendingAfter = null;
      if (typeof after === 'function') after();
      else continueAfterDeaths(room);
      return { ok: true };
    }

    // 骑士翻牌决斗
    if (type === 'knight') {
      if (!me.alive || me.role !== 'Knight') return { ok: false, message: '只有骑士能决斗' };
      if (me.abilities.knightUsed) return { ok: false, message: '这一局已经决斗过了' };
      if (!goodSkillsOn(room)) return { ok: false, message: '好人神职技能已被长老封印' };
      if (![PHASE.DAY_SPEECH, PHASE.DAY_PK_SPEECH].includes(g.phase)) {
        return { ok: false, message: '现在不能决斗（只能在警下、放逐投票前）' };
      }
      const target = bySeat(room, Number(action.seat));
      if (!target || !target.alive) return { ok: false, message: '选择要决斗的人' };
      if (target.seat === me.seat) return { ok: false, message: '不能决斗自己' };
      knightDuel(room, me, target);
      return { ok: true };
    }

    // 狼王自爆
    if (type === 'wolfSelfDestruct') {
      if (!me.alive || me.role !== 'WolfKing') return { ok: false, message: '只有狼王能自爆' };
      if (![PHASE.DAY_SPEECH, PHASE.DAY_BADGE_SPEECH, PHASE.DAY_PK_SPEECH, PHASE.DAY_VOTE].includes(g.phase)) {
        return { ok: false, message: '现在不能自爆' };
      }
      wolfKingSelfDestruct(room, me);
      return { ok: true };
    }

    // 白狼王自爆之后：点一个人带走（也可以选"不带走"）。
    // 注意要放在"自爆"判断之前：这时候他人已经死了，`me.alive` 是 false。
    if (g.phase === PHASE.WHITE_WOLF_KING_BOOM) {
      if (!g.pending || g.pending.type !== 'wwkBoom' || g.pending.seat !== me.seat) {
        return { ok: false, message: '现在不是你的行动' };
      }
      if (type !== 'wwkBoom') return { ok: false, message: '请选择要带走的人' };
      whiteWolfKingPick(room, me, action.seat ?? null);
      return { ok: true };
    }

    // 白狼王自爆（先自爆，之后在 WHITE_WOLF_KING_BOOM 阶段点人）
    if (type === 'wwkBoom') {
      if (!me.alive || me.role !== 'WhiteWolfKing') return { ok: false, message: '只有白狼王能自爆' };
      if (me.abilities.wwkUsed) return { ok: false, message: '已经自爆过了' };
      if (![PHASE.DAY_SPEECH, PHASE.DAY_BADGE_SPEECH, PHASE.DAY_PK_SPEECH, PHASE.DAY_VOTE].includes(g.phase)) {
        return { ok: false, message: '现在不能自爆' };
      }
      whiteWolfKingDetonate(room, me);
      return { ok: true };
    }

    return { ok: false, message: '现在不能做这个操作' };
  }

  function isSpeechPhase(phase) {
    return [PHASE.DAY_BADGE_SPEECH, PHASE.DAY_PK_SPEECH, PHASE.DAY_SPEECH, PHASE.DAY_LAST_WORDS].includes(phase);
  }

  function advanceSpeech(room) {
    const g = room.game;
    if (g.phase === PHASE.DAY_BADGE_SPEECH || g.phase === PHASE.DAY_PK_SPEECH) {
      nextBadgeSpeaker(room, { pk: g.phase === PHASE.DAY_PK_SPEECH });
      return;
    }
    if (g.phase === PHASE.DAY_SPEECH) {
      nextDaySpeaker(room);
      return;
    }
    if (g.phase === PHASE.DAY_LAST_WORDS) {
      finishLastWords(room, bySeat(room, g.speaker));
    }
  }

  /* ------------------------------ 视图 ------------------------------ */

  function lobbySnapshot(room, viewerId) {
    return {
      code: room.code,
      seats: room.seats,
      roles: { ...room.roles },
      sheriff: room.sheriff !== false,
      winMode: normalizeWinMode(room.winMode),
      hostId: room.hostId,
      started: room.phase !== 'waiting',
      phase: room.phase,
      password: Boolean(room.password),
      me: {
        id: viewerId,
        seat: room.order.indexOf(viewerId),
        isHost: room.hostId === viewerId,
      },
      players: room.order.map((id, seat) => {
        const m = room.members.get(id);
        return {
          id,
          seat,
          name: m ? m.name : '（已离开）',
          avatar: m ? m.avatar : '',
          isHost: id === room.hostId,
        };
      }),
    };
  }

  function viewFor(userId, opts = {}) {
    const code = seatOf.get(userId);
    const room = code ? rooms.get(code) : null;
    if (!room) return null;
    if (room.phase === 'waiting') {
      return { code: room.code, phase: PHASE.WAITING, lobby: lobbySnapshot(room, userId) };
    }
    const g = room.game;
    const me = byId(room, userId);
    if (!me) return null;

    const ended = g.phase === PHASE.GAME_END;
    /*
     * 谁看得到谁的身份：
     *   · 自己 —— 当然看得到；
     *   · 终局 —— 全部公开；
     *   · **狼队友给狼人** —— 夜里要合刀，这是狼人本来就该知道的信息
     *     （前端靠它给队友挂「狼队」标记、把协作面板的队友列全）。
     * 好人一律只拿得到自己的那张牌。
     */
    const meIsWolf = isWolfRole(me.role);
    const players = g.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((p) => ({
        playerId: p.id,
        seat: p.seat,
        displayName: p.name,
        avatar: p.avatar || '',
        alive: p.alive,
        isHost: p.isHost,
        isHuman: true,
        ...(ended || p.id === userId || (meIsWolf && isWolfRole(p.role))
          ? { role: p.role, alignment: p.alignment }
          : {}),
        // 白痴翻牌是当众宣布过的公开信息（前端据此把他置灰、投票进度条才算得对）
        idiotRevealed: Boolean(p.abilities.idiotRevealed),
      }));

    const base = {
      code: room.code,
      phase: g.phase,
      day: g.day,
      startedAt: room.startedAt,
      deadline: room.deadline,
      phaseStartedAt: g.phaseStartedAt,
      duration: room.deadline ? Math.max(0, room.deadline - g.phaseStartedAt) : 0,
      players,
      messages: messagesFor(room, me, opts.since),
      // 已经产生的最大消息序号，客户端拿它当"我收到哪儿了"
      messagesSeq: messageSeq,
      currentSpeakerSeat: g.speaker,
      speechOrder: g.speechOrder.slice(),
      badge: {
        holderSeat: g.badge.holderSeat,
        candidates: g.badge.candidates.slice(),
      },
      aliveCount: players.filter((p) => p.alive).length,
      // 平票 PK 时台上的人，前端据此把其他人置灰
      pkTargets: g.pkTargets.slice(),
      sheriffEnabled: g.sheriffEnabled,
      // 本局胜利条件（公开信息，顶栏/结算页都要显示）
      winMode: normalizeWinMode(g.winMode),
      goodSkillsDisabled: g.goodSkillsDisabled,
      self: {
        id: me.id,
        seat: me.seat,
        name: me.name,
        avatar: me.avatar || '',
        role: me.role,
        alignment: me.alignment,
        alive: me.alive,
        isHost: me.isHost,
        vote: g.votes[me.id] === undefined ? null : g.votes[me.id],
        badgeVote: g.badgeVotes[me.id] === undefined ? null : g.badgeVotes[me.id],
        signup: typeof g.signup[me.id] === 'boolean' ? g.signup[me.id] : null,
      },
      winner: g.winner,
      endedAt: g.endedAt || room.endedAt || 0,
      recordId: g.recordId || null,
      // 已投/已表态的座位是公开信息（投给谁不公开）
      votedSeats: Object.entries(g.votes)
        .filter(([, seat]) => typeof seat === 'number')
        .map(([id]) => byId(room, id))
        .filter(Boolean)
        .map((p) => p.seat),
      badgeVotedSeats: Object.entries(g.badgeVotes)
        .filter(([, seat]) => typeof seat === 'number')
        .map(([id]) => byId(room, id))
        .filter(Boolean)
        .map((p) => p.seat),
      signupDecided: alive(room).filter((p) => typeof g.signup[p.id] === 'boolean').map((p) => p.seat),
      signupCandidates: alive(room).filter((p) => g.signup[p.id] === true).map((p) => p.seat),
      roleReveal:
        ended && g.winner
          ? { winner: g.winner, players: g.players.map((p) => ({ seat: p.seat, name: p.name, role: p.role, alive: p.alive })) }
          : null,
      can: legalActions(room, me, userId),
      private: privateInfo(room, me, userId),
    };
    return base;
  }

  /** 一次最多回传多少条历史消息（整局重传会把报文越拖越大）。 */
  const MESSAGES_PAGE = 200;

  /**
   * 该玩家看得到的消息。三件事：
   *   1. 狼人夜间频道（`scope === 'wolf'`）只发给狼人；
   *   2. 给了 `since` 就只发这之后的新消息（增量，不再整份重传）；
   *   3. 没给 `since`（刚打开页面/刷新）就发最近 MESSAGES_PAGE 条。
   */
  function messagesFor(room, me, since) {
    const g = room.game;
    const wolfViewer = isWolfRole(me.role);
    const visible = g.messages.filter((m) => !m.scope || (m.scope === 'wolf' && wolfViewer));
    const after = Number(since);
    if (Number.isFinite(after) && after > 0) return visible.filter((m) => Number(m.seq || 0) > after);
    return visible.slice(-MESSAGES_PAGE);
  }

  function legalActions(room, me, userId) {
    const g = room.game;
    const can = {
      speech: false,
      endSpeech: false,
      guard: false,
      wolf: false,
      witch: false,
      seer: false,
      signup: false,
      badgeVote: false,
      vote: false,
      hunter: false,
      transfer: false,
      wwkBoom: false,
      wolfBeauty: false,
      knight: false,
      wolfSelfDestruct: false,
    };
    // 遗言：人已经死了，但还能说话
    if (g.phase === PHASE.DAY_LAST_WORDS && g.speaker === me.seat) {
      can.speech = true;
      can.endSpeech = true;
    }
    // 猎人中枪 / 警长移交：动作发生在"人已经死了"之后
    if (g.phase === PHASE.HUNTER_SHOOT && g.pending && g.pending.type === 'shoot' && g.pending.seat === me.seat) {
      can.hunter = true;
    }
    if (
      g.phase === PHASE.BADGE_TRANSFER &&
      g.pending &&
      g.pending.type === 'badgeTransfer' &&
      g.pending.seat === me.seat
    ) {
      can.transfer = true;
    }
    // 白狼王自爆之后挑人：动作发生在"人已经死了"之后
    if (
      g.phase === PHASE.WHITE_WOLF_KING_BOOM &&
      g.pending &&
      g.pending.type === 'wwkBoom' &&
      g.pending.seat === me.seat
    ) {
      can.wwkBoom = true;
    }
    // 遗言阶段是"已经出局的人"在说话，所以这条要排在 alive 判断之前：
    // 否则夜里死的人拿不到 can.speech，界面不给输入框，只能干等 180 秒。
    if (isSpeechPhase(g.phase) && g.speaker === me.seat && (me.alive || g.phase === PHASE.DAY_LAST_WORDS)) {
      can.speech = true;
      can.endSpeech = true;
      if (g.phase === PHASE.DAY_LAST_WORDS) can.lastWords = true;
    }
    if (!me.alive) return can;
    if (g.phase === PHASE.NIGHT_GUARD_ACTION && g.night.actor === me.id) can.guard = true;
    if (g.phase === PHASE.NIGHT_WOLF_ACTION && isWolfRole(me.role)) can.wolf = true;
    if (g.phase === PHASE.NIGHT_WOLF_BEAUTY_ACTION && g.night.actor === me.id) can.wolfBeauty = true;
    if (g.phase === PHASE.NIGHT_WITCH_ACTION && g.night.actor === me.id) can.witch = true;
    if (g.phase === PHASE.NIGHT_SEER_ACTION && g.night.actor === me.id) can.seer = true;
    if (g.phase === PHASE.DAY_BADGE_SIGNUP && typeof g.signup[me.id] !== 'boolean') can.signup = true;
    if (
      g.phase === PHASE.DAY_BADGE_ELECTION &&
      !g.badge.candidates.includes(me.seat) &&
      typeof g.badgeVotes[me.id] !== 'number'
    ) {
      can.badgeVote = true;
    }
    if (
      g.phase === PHASE.DAY_VOTE &&
      !(me.abilities.idiotRevealed && me.role === 'Idiot') &&
      !g.pkTargets.includes(me.seat) &&
      typeof g.votes[me.id] !== 'number'
    ) {
      can.vote = true;
    }
    if (g.phase === PHASE.HUNTER_SHOOT && g.pending && g.pending.type === 'shoot' && g.pending.seat === me.seat) {
      can.hunter = true;
    }
    if (
      g.phase === PHASE.BADGE_TRANSFER &&
      g.pending &&
      g.pending.type === 'badgeTransfer' &&
      g.pending.seat === me.seat
    ) {
      can.transfer = true;
    }
    if (
      me.role === 'WhiteWolfKing' &&
      !me.abilities.wwkUsed &&
      [PHASE.DAY_SPEECH, PHASE.DAY_BADGE_SPEECH, PHASE.DAY_PK_SPEECH, PHASE.DAY_VOTE].includes(g.phase)
    ) {
      can.wwkBoom = true;
    }
    if (
      me.role === 'WolfKing' &&
      [PHASE.DAY_SPEECH, PHASE.DAY_BADGE_SPEECH, PHASE.DAY_PK_SPEECH, PHASE.DAY_VOTE].includes(g.phase)
    ) {
      can.wolfSelfDestruct = true;
    }
    if (
      me.role === 'Knight' &&
      goodSkillsOn(room) &&
      !me.abilities.knightUsed &&
      [PHASE.DAY_SPEECH, PHASE.DAY_PK_SPEECH].includes(g.phase)
    ) {
      can.knight = true;
    }
    return can;
  }

  function privateInfo(room, me, userId) {
    const g = room.game;
    const info = {
      role: me.role,
      roleName: roleName(me.role),
      alignment: me.alignment,
      wolfTeammates: [],
      seerHistory: [],
      witch: null,
      guard: null,
      hunterCanShoot: me.abilities.hunterCanShoot,
      idiotRevealed: me.abilities.idiotRevealed,
      wwkUsed: me.abilities.wwkUsed,
      skillsBlocked: Boolean(me.abilities.skillsBlocked),
      elderLives: me.abilities.elderLives,
      knightUsed: me.abilities.knightUsed,
      wolfKingCanShoot: Boolean(me.abilities.wolfKingCanShoot),
      wolfBeauty: me.role === 'WolfBeauty'
        ? { lastTarget: me.abilities.lastCharmTarget ?? null, charmedSeat: me.charmedSeat ?? null }
        : null,
      grave: me.role === 'Gravekeeper'
        ? {
            disabled: Boolean(g.goodSkillsDisabled),
            day: g.night.graveInfo?.day ?? null,
            seat: g.night.graveInfo?.seat ?? null,
            name: g.night.graveInfo?.name ?? null,
            alignment: g.night.graveInfo?.alignment ?? null,
          }
        : null,
      evilReflectUsed: Boolean(g.evilReflectUsed),
    };
    if (isWolfRole(me.role)) {
      info.wolfTeammates = g.players
        .filter((p) => p.id !== me.id && isWolfRole(p.role))
        .map((p) => ({ seat: p.seat, name: p.name, alive: p.alive }));
      info.wolfVotes = Object.fromEntries(
        Object.entries(g.night.wolfVotes || {}).map(([id, seat]) => [id, seat])
      );
    }
    if (me.role === 'Seer') info.seerHistory = (me.seerHistory || []).slice();
    if (me.role === 'Witch') {
      info.witch = {
        healUsed: me.abilities.healUsed,
        poisonUsed: me.abilities.poisonUsed,
        victimSeat: g.night.wolfTarget !== undefined ? g.night.wolfTarget : null,
        canHeal: Boolean(g.night.witchOptions?.canHeal && g.night.actor === me.id),
        canPoison: Boolean(g.night.witchOptions?.canPoison && g.night.actor === me.id),
      };
    }
    if (me.role === 'Guard') info.guard = { lastTarget: me.lastGuardTarget ?? null };
    return info;
  }

  /* ------------------------------ 平台需要的摘要 ------------------------------ */

  function presenceOf(userId) {
    const code = seatOf.get(userId);
    const room = code ? rooms.get(code) : null;
    if (!room) return null;
    const started = room.phase !== 'waiting';
    return {
      game: 'werewolf',
      code: room.code,
      phase: room.phase === 'waiting' ? 'waiting' : room.phase === 'over' ? 'over' : 'playing',
      joinable: room.phase === 'waiting' && room.members.size < room.seats,
      started,
      count: room.members.size,
      seats: room.seats,
    };
  }

  function roomOf(userId) {
    const code = seatOf.get(userId);
    return code ? rooms.get(code) || null : null;
  }

  function snapshot(code) {
    const room = rooms.get(String(code || ''));
    return room ? lobbySnapshot(room, room.hostId) : null;
  }

  /** 大厅视图：按查看者裁剪（房主标记、自己的座位）。 */
  function roomInfo(code, viewerId) {
    const room = rooms.get(String(code || ''));
    return room ? lobbySnapshot(room, String(viewerId || '')) : null;
  }

  function playerIdsOf(code) {
    const room = rooms.get(String(code || ''));
    return room ? room.order.slice() : [];
  }

  function attachRecord(code, recordId) {
    const room = rooms.get(String(code || ''));
    if (room && room.game) room.game.recordId = recordId;
  }

  /** 定时清扫：大厅闲置 12 小时、结束的房间留 1 小时。 */
  function sweep(nowMs = now()) {
    for (const room of [...rooms.values()]) {
      const ttl = room.phase === 'over' ? FINISHED_TTL_MS : ROOM_TTL_MS;
      const last = room.phase === 'over' ? room.endedAt || room.startedAt : room.startedAt || room.createdAt;
      if (nowMs - last > ttl) destroyRoom(room);
    }
  }

  function reset() {
    for (const room of [...rooms.values()]) destroyRoom(room);
    rooms.clear();
    seatOf.clear();
    for (const entry of timers.values()) clearTimeout(entry.timer);
    timers.clear();
  }

  function stats() {
    return [...rooms.values()].map((r) => ({
      code: r.code,
      phase: r.phase,
      seats: r.seats,
      count: r.members.size,
      day: r.game ? r.game.day : 0,
      gamePhase: r.game ? r.game.phase : null,
    }));
  }

  return {
    // 房间
    createRoom,
    joinRoom,
    leaveRoom,
    kickPlayer,
    startGame,
    restartRoom,
    destroyRoom,
    // 游戏
    act,
    viewFor,
    presenceOf,
    roomOf,
    snapshot,
    roomInfo,
    playerIdsOf,
    attachRecord,
    // 维护
    sweep,
    reset,
    stats,
    // 常量（测试/接口层复用）
    PHASE,
    ROLE_CONFIG,
    DURATION,
  };
}