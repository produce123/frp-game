-- 莲花广麻 · PostgreSQL schema（Supabase pooler / 任意 PG）
-- 对应 app/storage/db.py 的 PostgresStorage。
-- 注意：TIMESTAMPTZ + now()；局标签列用 TEXT 而非 INTEGER
--（SQLite 动态类型可容忍字符串，PostgreSQL 严格类型会拒绝）。

CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  nickname    TEXT NOT NULL UNIQUE,
  avatar      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  mode        TEXT NOT NULL CHECK (mode IN ('east','hanchan')),
  ruleset_id  TEXT NOT NULL DEFAULT 'lotus-classic',
  capacity    INTEGER NOT NULL DEFAULT 4,
  status      TEXT NOT NULL DEFAULT 'lobby',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS matches (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  mode         TEXT NOT NULL,
  ruleset_id   TEXT NOT NULL DEFAULT 'lotus-classic',
  start_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_at       TIMESTAMPTZ,
  final_scores TEXT
);

CREATE TABLE IF NOT EXISTS round_results (
  id          TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL REFERENCES matches(id),
  round       TEXT NOT NULL,          -- 局标签（如 '东1局'）
  result_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id  TEXT NOT NULL REFERENCES matches(id),
  seat      INTEGER NOT NULL,
  player_id TEXT,
  nickname  TEXT NOT NULL,
  PRIMARY KEY (match_id, seat)
);

CREATE TABLE IF NOT EXISTS room_seats (
  room_id         TEXT NOT NULL REFERENCES rooms(id),
  seat            INTEGER NOT NULL,
  nickname        TEXT NOT NULL,
  rejoin_code     TEXT NOT NULL,
  player_id       TEXT,
  disconnected_at TIMESTAMPTZ,
  PRIMARY KEY (room_id, seat)
);

CREATE TABLE IF NOT EXISTS bans (
  scope      TEXT NOT NULL,
  target     TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  banned_by  TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, target)
);

CREATE TABLE IF NOT EXISTS player_avatars (
  player_id  TEXT PRIMARY KEY,      -- 匿名身份（guestId），跨房间/场次稳定
  avatar     TEXT NOT NULL,         -- 头像图片 URL（外部 API 获取后落库持久化）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL DEFAULT '',
  reporter    TEXT NOT NULL DEFAULT '',
  target      TEXT NOT NULL DEFAULT '',
  target_name TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 纯娱乐声明同意记录：按匿名身份（guestId）记住「首次确认」，跨浏览器/设备有效。
CREATE TABLE IF NOT EXISTS disclaimer_agreements (
  player_id  TEXT PRIMARY KEY,
  version    INTEGER NOT NULL DEFAULT 1,
  agreed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_matches_room ON matches(room_id);
CREATE INDEX IF NOT EXISTS idx_round_results_match ON round_results(match_id);
