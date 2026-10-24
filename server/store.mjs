/*
 * 存储层：Node 24 内置的 node:sqlite。
 *
 * 为什么用 SQLite 而不是 JSON 文件：账号数据（密码哈希、好友关系）写坏了很难救，
 * 而 SQLite 自带事务和原子写，不用自己实现"临时文件 + rename"那套。
 * 而且它是 Node 24 内置的，不用 npm install 任何东西。
 *
 * 数据库文件在 data/frp-game.db，已 gitignore，**绝不提交**。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,      -- 玩家 ID：系统分配、全局唯一、不可更改
  name       TEXT NOT NULL,         -- 显示名：1–10 个字符，允许重复
  pw_hash    TEXT NOT NULL,         -- scrypt 哈希（hex）
  pw_salt    TEXT NOT NULL,         -- 每用户独立盐（hex）
  avatar     TEXT NOT NULL DEFAULT '', -- 上传头像的扩展名（png/jpg/webp/gif）；空 = 用默认生成头像
  avatar_at  INTEGER NOT NULL DEFAULT 0, -- 头像版本（秒/毫秒都行），拼在 URL 上破缓存
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,      -- 会话 id（HttpOnly cookie 里那个）
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS friends (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);

-- 好友申请（申请-同意制）。只存**单方向**的一条：from 想加 to。
-- 接受时才在 friends 里双向插两行，所以 listFriends 的语义一行都不用改。
-- (from_id, to_id) 唯一 → 同一个人重复申请不会堆出一串重复行。
CREATE TABLE IF NOT EXISTS friend_requests (
  from_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_id);

-- 对局记录（一局一行）。目前**只有狼人杀**在写。
-- detail 是 JSON 全量快照（每个人的身份、技能状态、投票、死亡原因），复盘页靠它重算事件；
-- 因为含隐藏信息，只允许**这一局的参与者**读（见 getGameRecord 的 userId 校验）。
-- game 列是通用的：以后三国杀的 PVE 战绩也放这张表，不要另开一套。
CREATE TABLE IF NOT EXISTS game_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  game       TEXT NOT NULL,
  room_code  TEXT NOT NULL,
  winner     TEXT NOT NULL,          -- WEREWOLF / VILLAGER ...（各游戏自己定义）
  started_at INTEGER NOT NULL,
  ended_at   INTEGER NOT NULL,
  detail     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_records_game ON game_records(game, ended_at);

-- 每局每人一行。查询"我的对局记录"走这张表，不用解 detail 里的 JSON。
CREATE TABLE IF NOT EXISTS game_record_players (
  record_id  INTEGER NOT NULL REFERENCES game_records(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  seat       INTEGER NOT NULL,
  name       TEXT NOT NULL,
  character  TEXT NOT NULL,
  alive      INTEGER NOT NULL,
  PRIMARY KEY (record_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_game_record_players_user ON game_record_players(user_id);
`;

/**
 * 老库升级。
 *
 * `CREATE TABLE IF NOT EXISTS` 不会给**已经存在的表**加列，所以头像这两列必须单独补。
 * 用 `PRAGMA table_info` 判断，重复执行是安全的（服务每次启动都会跑一遍）。
 */
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!cols.has('avatar')) {
    db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.has('avatar_at')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar_at INTEGER NOT NULL DEFAULT 0');
  }
}

export function openStore(dbPath = resolve(ROOT, 'data', 'frp-game.db')) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);

  const now = () => Date.now();

  return {
    db,
    path: dbPath,

    close() { db.close(); },

    /* ------------------------------ 用户 ------------------------------ */

    createUser({ id, name, pwHash, pwSalt }) {
      db.prepare(
        'INSERT INTO users (id, name, pw_hash, pw_salt, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(id, name, pwHash, pwSalt, now());
      return this.findUser(id);
    },

    findUser(id) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
    },

    /** 玩家 ID 是否已被占用（生成时用来避让，理论上概率极低）。 */
    userIdTaken(id) {
      return Boolean(db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
    },

    /**
     * 换头像（或恢复默认：ext 传空串）。
     * `avatar_at` 是版本号，URL 上带它才能让浏览器立刻换掉旧图。
     */
    setAvatar(id, ext) {
      db.prepare('UPDATE users SET avatar = ?, avatar_at = ? WHERE id = ?').run(ext || '', Date.now(), id);
      return this.findUser(id);
    },

    /** 改显示名（ID 不变、好友关系不变）。调用方负责 validateName。 */
    setName(id, name) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
      return this.findUser(id);
    },

    /* ------------------------------ 会话 ------------------------------ */

    createSession({ sid, userId }) {
      const t = now();
      db.prepare('INSERT INTO sessions (sid, user_id, created_at, seen_at) VALUES (?, ?, ?, ?)')
        .run(sid, userId, t, t);
    },

    findSession(sid) {
      const row = db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid);
      if (!row) return null;
      // 顺手刷新"最后活动时间"，不动 created_at
      db.prepare('UPDATE sessions SET seen_at = ? WHERE sid = ?').run(now(), sid);
      return row;
    },

    deleteSession(sid) {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    },

    /* ------------------------------ 好友 ------------------------------ */

    /**
     * 让他们**成为**好友：一次写两行（双向），所以读出好友列表时查单边即可。
     *
     * ⚠️ 这不是"加好友"这个动作本身 —— 协议层的 `friend.add` 现在只是**发一条申请**
     * （见 docs/DECISIONS.md D8）。只有对方同意、或两个人互相申请时，才会调到这里。
     * 这样 listFriends 的语义和上层所有代码都不用动。
     */
    addFriend(userId, friendId) {
      const t = now();
      const stmt = db.prepare(
        'INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)'
      );
      db.exec('BEGIN');
      try {
        stmt.run(userId, friendId, t);
        stmt.run(friendId, userId, t);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    removeFriend(userId, friendId) {
      const stmt = db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?');
      db.exec('BEGIN');
      try {
        stmt.run(userId, friendId);
        stmt.run(friendId, userId);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /** 某人的好友列表，带显示名与头像版本。 */
    listFriends(userId) {
      return db.prepare(`
        SELECT u.id AS id, u.name AS name, u.avatar AS avatar, u.avatar_at AS avatar_at
        FROM friends f JOIN users u ON u.id = f.friend_id
        WHERE f.user_id = ?
        ORDER BY u.name, u.id
      `).all(userId);
    },

    /* ------------------------------ 好友申请 ------------------------------ */

    /** 发一条申请 from → to。已经发过就什么也不做（(from,to) 是主键）。 */
    createFriendRequest(fromId, toId) {
      db.prepare(
        'INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)'
      ).run(fromId, toId, now());
    },

    /** 查某一条申请（单方向）。有就返回行，没有返回 null。 */
    findFriendRequest(fromId, toId) {
      return db.prepare(
        'SELECT * FROM friend_requests WHERE from_id = ? AND to_id = ?'
      ).get(fromId, toId) || null;
    },

    deleteFriendRequest(fromId, toId) {
      db.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').run(fromId, toId);
    },

    /**
     * 把两个人之间**两个方向**的申请都清掉。
     * 同意 / 拒绝 / 撤回 / 互相申请都要用它 —— 只清一个方向会留下半条幽灵申请，
     * 界面上就一直挂着一个点不动的"待处理"。
     */
    deleteFriendRequestsBetween(a, b) {
      db.prepare(
        'DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)'
      ).run(a, b, b, a);
    },

    /** **别人发给我的**待处理申请（带申请人显示名）。 */
    listIncomingRequests(userId) {
      return db.prepare(`
        SELECT u.id AS id, u.name AS name, u.avatar AS avatar, u.avatar_at AS avatar_at
        FROM friend_requests r JOIN users u ON u.id = r.from_id
        WHERE r.to_id = ?
        ORDER BY r.created_at, u.id
      `).all(userId);
    },

    /** **我发出去的**、还没被处理的申请（带收件人显示名）。 */
    listOutgoingRequests(userId) {
      return db.prepare(`
        SELECT u.id AS id, u.name AS name, u.avatar AS avatar, u.avatar_at AS avatar_at
        FROM friend_requests r JOIN users u ON u.id = r.to_id
        WHERE r.from_id = ?
        ORDER BY r.created_at, u.id
      `).all(userId);
    },

    /* ------------------------------ 对局记录 ------------------------------ */

    /**
     * 写一条对局记录（响应体见 SCHEMA 里的注释）。返回新记录的 id。
     *
     * @param {object} info
     * @param {string} info.game
     * @param {string} info.roomCode
     * @param {string} info.winner
     * @param {number} info.startedAt
     * @param {number} info.endedAt
     * @param {object} info.detail   任意可 JSON 序列化的全量快照
     * @param {Array<{id:string,seat:number,name:string,character:string,alive:boolean}>} info.players
     */
    insertGameRecord({ game, roomCode, winner, startedAt, endedAt, detail, players }) {
      const stmt = db.prepare(
        'INSERT INTO game_records (game, room_code, winner, started_at, ended_at, detail) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const seatStmt = db.prepare(
        'INSERT OR REPLACE INTO game_record_players (record_id, user_id, seat, name, character, alive) VALUES (?, ?, ?, ?, ?, ?)'
      );
      db.exec('BEGIN');
      try {
        const info = stmt.run(game, roomCode, winner, startedAt, endedAt, JSON.stringify(detail));
        const id = Number(info.lastInsertRowid);
        for (const p of players) {
          seatStmt.run(id, p.id, p.seat, p.name, p.character || '', p.alive ? 1 : 0);
        }
        db.exec('COMMIT');
        return id;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    /** 我的对局记录（新的在前）。不解 detail —— 列表页只需要一行摘要。 */
    listGameRecords(userId, game) {
      return db.prepare(`
        SELECT r.id AS id, r.game AS game, r.room_code AS room_code, r.winner AS winner,
               r.started_at AS started_at, r.ended_at AS ended_at,
               p.seat AS seat, p.character AS character, p.alive AS alive,
               (SELECT COUNT(*) FROM game_record_players x WHERE x.record_id = r.id) AS players_count
        FROM game_records r JOIN game_record_players p ON p.record_id = r.id
        WHERE p.user_id = ? AND r.game = ?
        ORDER BY r.ended_at DESC, r.id DESC
        LIMIT 200
      `).all(userId, game);
    },

    /**
     * 读一条对局记录（含复盘要用的全量快照）。
     * **只有这局的参与者能读**：detail 里有所有人的身份，不是公开信息。
     */
    getGameRecord(recordId, userId) {
      const row = db.prepare('SELECT * FROM game_records WHERE id = ?').get(recordId);
      if (!row) return null;
      const seat = db.prepare(
        'SELECT * FROM game_record_players WHERE record_id = ? AND user_id = ?'
      ).get(recordId, userId);
      if (!seat) return null;
      const players = db.prepare(
        'SELECT user_id, seat, name, character, alive FROM game_record_players WHERE record_id = ? ORDER BY seat'
      ).all(recordId);
      let detail = null;
      try {
        detail = JSON.parse(row.detail);
      } catch {
        detail = null;
      }
      return { ...row, detail, self: seat, players };
    },
  };
}