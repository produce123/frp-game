/*
 * 协议常量 —— **前后端唯一的一份**。
 *
 * 两种加载方式都支持，靠的是一行都不需要构建：
 *   · Node 侧：      import { T } from '../shared/protocol.mjs'
 *   · 浏览器侧：     <script type="module" src="/shared/protocol.mjs"></script>
 *                    然后任何脚本读 window.FrpProtocol.T
 *
 * ⚠️ 浏览器里用它的脚本必须带 defer（或本身是 module）。原因是 module 脚本天然 defer，
 * 会晚于普通脚本执行；给普通脚本也加 defer，两者的顺序就和文档里写的一致了。
 *
 * 消息格式：一律 JSON 文本帧，信封是 { t: <类型>, ...其余字段 }。
 * 完整字段说明见 docs/ARCHITECTURE.md 的「消息协议」一节 —— 改这里也要改那里。
 */

/** 消息类型。改这里必须同步改 docs/ARCHITECTURE.md 的表格。 */
export const T = {
  /* -------- 客户端 → 服务端 -------- */
  ROOM_CREATE: 'room.create',   // { game, options? }
  ROOM_JOIN: 'room.join',       // { code }
  ROOM_LEAVE: 'room.leave',     // {}
  ROOM_START: 'room.start',     // {}            房主开局
  ROOM_RESET: 'room.reset',     // {}            房主在"本局结束"后再来一局（回等待态）
  ROOM_ACT: 'room.act',         // { act }       游戏操作意图
  // 人机座位（**房主**在准备区按一下加一个 / 移除一个）。
  // 人机现在是房间的**座位**，不是"游戏模块自己偷偷补的座位"——
  // 所以它出现在成员列表里，也会走房间层的座位上限与让位规则。
  // 见 docs/ARCHITECTURE.md 的「游戏模块接口」「人机座位」与 docs/DECISIONS.md D9。
  ROOM_BOT_ADD: 'room.bot.add',       // {}      按一下加 1 个人机座位
  ROOM_BOT_REMOVE: 'room.bot.remove', // { id }  移除指定人机座位
  REACT_SEND: 'react.send',     // { to, kind }  kind 见 REACT_KINDS（egg / flower）
  PING: 'ping',                 // { ts }        应用层保活 + 测延迟（浏览器发不出 WS 控制帧，只能走这里）
  FRIEND_ADD: 'friend.add',     // { id }        发一条好友申请（**不是**立刻成为好友）
  FRIEND_ACCEPT: 'friend.accept',   // { id }      同意对方发给我的申请（id = 申请人）
  FRIEND_DECLINE: 'friend.decline', // { id }      拒绝对方发给我的申请（id = 申请人）
  FRIEND_CANCEL: 'friend.cancel',   // { id }      撤回我自己发出的申请（id = 收件人）
  FRIEND_REMOVE: 'friend.remove', // { id }       删好友（双向的）
  INVITE_SEND: 'invite.send',   // { to: [id…], code }   一键批量邀请
                                // 人在狼人杀房里时也可以发（没有平台房间也一样，见 server/hub.mjs）
  INVITE_REPLY: 'invite.reply', // { from, code, accept, game? }
                                // game === 'noname' 时 code 是**无名杀自己的房号**，
                                // 服务端只转发、不入平台座位（见 server/hub.mjs）。
                                // game === 'werewolf' 时 code 是狼人杀的 6 位数字房号，同样只转发。

  /* -------- 服务端 → 客户端 -------- */
  READY: 'ready',               // { me:{id,name,avatar} }
  // 好友列表**全量**推送。在线状态变化、某人在哪个房间、申请被同意/拒绝/撤回，
  // 都是重推这一条 —— 好友就几个人，全量推比"只推变化量"少一套合并逻辑，
  // 也少一处能写错的地方。
  // list 只含**已接受**的好友；incoming 是别人发给我的待处理申请；
  // outgoing 是我发出去、还没被处理的申请。三处都带头像地址（avatar）。
  FRIENDS: 'friends',           // { list:[{id,name,avatar,online,playing}], incoming:[{id,name,avatar}], outgoing:[{id,name,avatar}] }
  ROOM_STATE: 'room.state',     // { code, game, hostId, phase, members, options, view,
                                //   minPlayers, minSeats, maxSeats, maxBots }
                                // maxBots：这个游戏最多能坐几个人机座位。0 = 没有电脑（斗地主），
                                // 界面据此不画「＋ 添加人机」；null = 老游戏，不限。
                                // 这个数只跟 meta 走，不认识任何具体游戏。
  // 别人对你（或你对他）扔了东西。**只发给同一间房里的人**，而且服务端是唯一发源地。
  // rid 是服务端递增的编号：发起人本地已经乐观播过一次，靠它认出自己的回声、不重复播。
  REACT: 'react',               // { from:{id,name,avatar}, to, kind, rid }
  INVITE: 'invite',             // { from:{id,name,avatar}, game, code }
                                // game === 'noname' 时 code 是无名杀房号，接受后由桥接脚本自动进房
  /*
   * 狼人杀的房间信号 —— `io.to(房号).emit(...)` 的转发，**只是"叮咚"**。
   * 客户端收到后自己再拉一次 `/api/werewolf/game/status`（按人裁剪过的），
   * 所以这条报文里不会有任何底牌。event 取值见 games/werewolf/frontend/shared/WSEvents.ts。
   */
  WW_EVENT: 'werewolf.event',   // { code, event, data }
  ERROR: 'error',               // { message }   中文原因，可直接显示
  PONG: 'pong',                 // { ts }        回应 ping，客户端据此算延迟
};

/**
 * 房间号字母表：**刻意排除 0 O 1 I L** —— 手抄和念读时最容易错的一批字符。
 * 沿用 Cannon Goblin 的既有约定（原 Shell Gambit 的 5 位纯数字方案已弃用）。
 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

/** 玩家 ID：同一套字母表，7 位 → 31^7 ≈ 275 亿种，碰撞概率可忽略。 */
export const ID_ALPHABET = ROOM_CODE_ALPHABET;
export const ID_LENGTH = 7;

/**
 * 显示名：**1–10 个字符**（按码点算，所以一个 emoji 算一个字）。允许重名。
 *
 * 原来卡死成"恰好 1 个字"（头像圆里就一个字）；用户后来要求能取 1–10 个字符，
 * 头像也改成可以上传图片，所以这里放宽。**人机名字仍是单字**（BOT_NAMES），
 * 它们不经过这个校验 —— 别把两边混在一起。
 */
export const NAME_MIN = 1;
export const NAME_MAX = 10;

/* ------------------------------------------------------------------ *
 * 人机座位
 * ------------------------------------------------------------------ */

/**
 * 人机座位的 id 前缀。
 * 用 `bot:` 是因为玩家 ID / 房间号的字母表里**没有冒号**，
 * 所以 `bot:1` 永远不可能和一个真人 ID 撞上（这条是硬保证，别改成下划线以外的字符）。
 */
export const BOT_ID_PREFIX = 'bot:';

/** 第 n 个座位的默认人机 id（n 从 1 开始）。 */
export function botId(n) {
  return BOT_ID_PREFIX + Math.max(1, Math.trunc(Number(n) || 1));
}

/** 这个 id 是不是人机座位。`rooms.mjs` 与界面都靠它分辨。 */
export function isBotId(id) {
  return typeof id === 'string' && id.startsWith(BOT_ID_PREFIX);
}

/**
 * 默认的单字人机名字池。
 *
 * 【为什么要单字】真人的名字现在是 **1–10 个码点**，但人机名字故意仍是单字：
 * 它要画进地图上那个小圆里，名字太长会把头像圆撑爆，也不利于"一眼看出是电脑"。
 *
 * 【为什么和两个游戏里的池子一样】贝壳赌局与刀马的单机人机用的就是这一批字
 * （各自的 `js/ai/ai.js` 里那串 `AI_NAME_POOL`）。在线补位沿用它，
 * 玩家看到的"电脑"和单机里是同一批脸。
 * 游戏可以用 `meta.botNames` 覆盖（大炮轰小鬼没有自己的池子，就用这一份）。
 */
export const BOT_NAMES = '虎狼鹰豹熊罴狮鲸鲨隼鸦蛇猿鹤龙'.split('');

/**
 * 从池子里挑一个**房间里还没人用**的单字名。
 * 全用完了就按序号往下发（允许重名，平台本来就允许重名）。
 */
export function pickBotName(pool, used, index) {
  const list = Array.isArray(pool) && pool.length ? pool : BOT_NAMES;
  const taken = used instanceof Set ? used : new Set(used || []);
  for (const name of list) {
    if (!taken.has(name)) return name;
  }
  return list[index % list.length];
}

/* ------------------------------------------------------------------ *
 * 互动（扔鸡蛋 / 送鲜花）
 * ------------------------------------------------------------------ */

/**
 * 互动种类。**完全不做次数限制**（用户明确要求）——
 * 服务端只保留一个很高的技术性防洪阈值（见 rooms.mjs 的 REACT_BURST），
 * 正常怎么点都碰不到它。
 */
export const REACT_KINDS = {
  egg: { label: '鸡蛋', emoji: '🥚' },
  flower: { label: '鲜花', emoji: '🌸' },
};

/** kind 合法吗（`react.send` 是客户端输入，必须校验）。 */
export function isReactKind(kind) {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(REACT_KINDS, kind);
}

/** 密码长度限制。上限是按 scrypt 的输入习惯给的，不需要更长。 */
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 72;

/** 会话 cookie 名与有效期（30 天）。 */
export const SESSION_COOKIE = 'sid';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;

/**
 * 把用户输入的短码归一化到字母表内：转大写、剔除字母表外的字符（空格、连字符等）。
 * 房间号和玩家 ID 都走这里，所以用户抄错大小写、多打一个空格都不会失败。
 */
export function normalizeCode(input, length = ROOM_CODE_LENGTH, alphabet = ID_ALPHABET) {
  const cleaned = String(input ?? '')
    .toUpperCase()
    .split('')
    .filter((ch) => alphabet.includes(ch))
    .join('');
  return cleaned.length === length ? cleaned : null;
}

/**
 * 校验显示名：**1–10 个码点**，且不能含空白或控制字符。
 * 允许 emoji（『🎮』算一个码点），中文/英文/数字混排都可以。
 */
export function validateName(input) {
  const name = String(input ?? '').trim();
  if (!name) return { ok: false, message: '名字不能是空的' };
  const points = [...name];
  if (points.length > NAME_MAX) return { ok: false, message: `名字最多 ${NAME_MAX} 个字符` };
  if (/[\s\u0000-\u001f\u007f]/u.test(name)) return { ok: false, message: '名字不能是空格或控制字符' };
  return { ok: true, name };
}

/** 校验密码。不做复杂度要求（没有找回渠道，越简单越不容易把自己锁在外面）。 */
export function validatePassword(input) {
  const password = String(input ?? '');
  if (password.length < PASSWORD_MIN) return { ok: false, message: `密码至少 ${PASSWORD_MIN} 位` };
  if (password.length > PASSWORD_MAX) return { ok: false, message: `密码最多 ${PASSWORD_MAX} 位` };
  return { ok: true, password };
}

// 浏览器侧：让普通脚本（带 defer）也能拿到这份常量。
if (typeof globalThis !== 'undefined') {
  globalThis.FrpProtocol = {
    T,
    ROOM_CODE_ALPHABET,
    ROOM_CODE_LENGTH,
    ID_ALPHABET,
    ID_LENGTH,
    NAME_MIN,
    NAME_MAX,
    BOT_ID_PREFIX,
    BOT_NAMES,
    REACT_KINDS,
    botId,
    isBotId,
    pickBotName,
    isReactKind,
    PASSWORD_MIN,
    PASSWORD_MAX,
    SESSION_COOKIE,
    normalizeCode,
    validateName,
    validatePassword,
  };
}