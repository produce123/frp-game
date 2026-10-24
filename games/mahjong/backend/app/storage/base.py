"""数据库无关的存储契约、CRUD 与结果映射。"""

from __future__ import annotations

import json
import os
import uuid
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any, Optional, Sequence


def load_schema(name: str) -> str:
    """读取 storage 目录下的 schema 文件。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
    with open(path, 'r', encoding='utf-8') as schema_file:
        return schema_file.read()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    """生成不可猜的对局、局结果和举报 ID。"""
    return uuid.uuid4().hex


def _row_value(row, key: str, default=None):
    """Read a field from sqlite3.Row, psycopg dict row, or test mapping."""
    try:
        return row[key]
    except (KeyError, IndexError):
        return default


def _decode_json(value: Optional[str]):
    return json.loads(value) if value else None


def map_match(row, rounds: Sequence) -> dict:
    """把数据库行转换成稳定的单场详情协议。"""
    return {
        'id': row['id'],
        'roomId': row['room_id'],
        'mode': row['mode'],
        'rulesetId': _row_value(row, 'ruleset_id', 'lotus-classic'),
        'startAt': row['start_at'],
        'endAt': row['end_at'],
        'finalScores': _decode_json(row['final_scores']),
        'rounds': [
            {'round': item['round'], 'result': json.loads(item['result_json'])}
            for item in rounds
        ],
    }


def map_match_summary(row) -> dict:
    """把数据库行转换成房间历史列表中的对局概览。"""
    return {
        'id': row['id'],
        'mode': row['mode'],
        'rulesetId': _row_value(row, 'ruleset_id', 'lotus-classic'),
        'startAt': row['start_at'],
        'endAt': row['end_at'],
        'finalScores': _decode_json(row['final_scores']),
    }


def aggregate_player_stats(rows: Sequence, match_seats: dict) -> dict:
    """从局结果行纯计算玩家场次、局数、胜局与净胜分。"""
    matches: set[str] = set()
    hands = wins = total_delta = 0
    for row in rows:
        seat = match_seats[row['match_id']]
        result = json.loads(row['result_json'])
        deltas = result.get('deltas', []) or []
        entry = next(
            (delta for delta in deltas if delta.get('playerIndex') == seat),
            None,
        )
        if entry is None:
            continue
        matches.add(row['match_id'])
        hands += 1
        if result.get('winner_index') == seat:
            wins += 1
        total_delta += entry.get('amount', 0) or 0
    return {
        'matches': len(matches),
        'hands': hands,
        'wins': wins,
        'totalDelta': total_delta,
    }


class BaseStorage(ABC):
    """SQLite 与 PostgreSQL 共享的同步存储实现。

    公共 SQL 使用 ``:p`` 作为内部参数标记，子类只需指定数据库驱动的
    ``placeholder``，并实现连接、建表与迁移。
    """

    placeholder: str

    @abstractmethod
    def _conn(self):
        raise NotImplementedError

    @abstractmethod
    def init(self) -> None:
        raise NotImplementedError

    def _sql(self, statement: str) -> str:
        return statement.replace(':p', self.placeholder)

    def _execute(self, conn, statement: str, params: Sequence[Any] = ()):
        return conn.execute(self._sql(statement), params)

    def _execute_many(self, conn, statement: str, params: Sequence[Sequence[Any]]) -> None:
        sql = self._sql(statement)
        for values in params:
            conn.execute(sql, values)

    # ── 玩家 ─────────────────────────────────────────────

    def create_player(self, nickname: str, avatar: str = '') -> None:
        with self._conn() as conn:
            self._execute(
                conn,
                'INSERT INTO players (id, nickname, avatar) VALUES (:p, :p, :p) '
                'ON CONFLICT (nickname) DO NOTHING',
                (_new_id(), nickname, avatar),
            )

    def get_player_avatar(self, player_id: str) -> str:
        with self._conn() as conn:
            row = self._execute(
                conn,
                'SELECT avatar FROM player_avatars WHERE player_id = :p',
                (player_id,),
            ).fetchone()
        return row['avatar'] if row else ''

    def set_player_avatar(self, player_id: str, avatar: str) -> None:
        with self._conn() as conn:
            self._execute(
                conn,
                'INSERT INTO player_avatars (player_id, avatar) VALUES (:p, :p) '
                'ON CONFLICT (player_id) DO UPDATE SET avatar = EXCLUDED.avatar',
                (player_id, avatar),
            )

    # ── 房间 ─────────────────────────────────────────────

    def create_room(self, room_id: str, mode: str, capacity: int,
                    ruleset_id: str = 'lotus-classic') -> None:
        with self._conn() as conn:
            self._execute(
                conn,
                'INSERT INTO rooms (id, mode, capacity, ruleset_id) VALUES (:p, :p, :p, :p)',
                (room_id, mode, capacity, ruleset_id),
            )

    def update_room_status(self, room_id: str, status: str) -> None:
        finished = _now() if status in ('finished', 'closed') else None
        with self._conn() as conn:
            self._execute(
                conn,
                'UPDATE rooms SET status = :p, '
                'finished_at = COALESCE(:p, finished_at) WHERE id = :p',
                (status, finished, room_id),
            )

    # ── 对局 ─────────────────────────────────────────────

    def create_match(self, room_id: str, mode: str,
                     ruleset_id: str = 'lotus-classic') -> str:
        match_id = _new_id()
        with self._conn() as conn:
            self._execute(
                conn,
                'INSERT INTO matches (id, room_id, mode, ruleset_id) VALUES (:p, :p, :p, :p)',
                (match_id, room_id, mode, ruleset_id),
            )
        return match_id

    def upsert_match_players(self, match_id: str, players: list) -> None:
        values = [
            (match_id, player['seat'], player.get('player_id'), player['nickname'])
            for player in players
        ]
        with self._conn() as conn:
            self._execute_many(
                conn,
                'INSERT INTO match_players (match_id, seat, player_id, nickname) '
                'VALUES (:p, :p, :p, :p) '
                'ON CONFLICT (match_id, seat) DO UPDATE SET '
                'player_id = EXCLUDED.player_id, nickname = EXCLUDED.nickname',
                values,
            )

    def finish_match(self, match_id: str, final_scores: list) -> None:
        with self._conn() as conn:
            self._execute(
                conn,
                'UPDATE matches SET end_at = :p, final_scores = :p WHERE id = :p',
                (_now(), json.dumps(final_scores, ensure_ascii=False), match_id),
            )

    def insert_round_result(self, match_id: str, round_data: dict) -> None:
        with self._conn() as conn:
            self._execute(
                conn,
                'INSERT INTO round_results (id, match_id, round, result_json) '
                'VALUES (:p, :p, :p, :p)',
                (
                    _new_id(),
                    match_id,
                    round_data.get('round', 0),
                    json.dumps(round_data, ensure_ascii=False),
                ),
            )

    # ── 座位 ─────────────────────────────────────────────

    def upsert_room_seat(
        self,
        room_id: str,
        seat: int,
        nickname: str,
        rejoin_code: str,
        player_id: Optional[str] = None,
    ) -> None:
        with self._conn() as conn:
            self._execute(
                conn,
                'INSERT INTO room_seats '
                '(room_id, seat, nickname, rejoin_code, player_id) '
                'VALUES (:p, :p, :p, :p, :p) '
                'ON CONFLICT (room_id, seat) DO UPDATE SET '
                'nickname = EXCLUDED.nickname, '
                'rejoin_code = EXCLUDED.rejoin_code, '
                'player_id = EXCLUDED.player_id',
                (room_id, seat, nickname, rejoin_code, player_id),
            )

    def remove_room_seat(self, room_id: str, seat: int) -> None:
        with self._conn() as conn:
            self._execute(
                conn,
                'DELETE FROM room_seats WHERE room_id = :p AND seat = :p',
                (room_id, seat),
            )

    # ── 封禁 / 举报 ──────────────────────────────────────

    def is_banned(self, scope: str, target: str) -> bool:
        with self._conn() as conn:
            row = self._execute(
                conn,
                'SELECT 1 FROM bans WHERE scope = :p AND target = :p',
                (scope, target),
            ).fetchone()
        return row is not None

    def ban_target(
        self,
        scope: str,
        target: str,
        reason: str = '',
        banned_by: str = '',
    ) -> None:
        with self._conn() as conn:
            self._execute(
                conn,
                'INSERT INTO bans (scope, target, reason, banned_by) '
                'VALUES (:p, :p, :p, :p) '
                'ON CONFLICT (scope, target) DO UPDATE SET '
                'reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by',
                (scope, target, reason, banned_by),
            )

    def unban(self, scope: str, target: str) -> None:
        with self._conn() as conn:
            self._execute(
                conn,
                'DELETE FROM bans WHERE scope = :p AND target = :p',
                (scope, target),
            )

    def add_report(
        self,
        room_id: str,
        reporter: str,
        target: str,
        target_name: str,
        reason: str,
    ) -> None:
        with self._conn() as conn:
            self._execute(
                conn,
                'INSERT INTO reports '
                '(id, room_id, reporter, target, target_name, reason) '
                'VALUES (:p, :p, :p, :p, :p, :p)',
                (_new_id(), room_id, reporter, target, target_name, reason),
            )

    # ── 声明同意 ─────────────────────────────────────────

    def get_disclaimer_agreement(self, player_id: str) -> Optional[dict]:
        with self._conn() as conn:
            row = self._execute(
                conn,
                'SELECT version, agreed_at FROM disclaimer_agreements '
                'WHERE player_id = :p',
                (player_id,),
            ).fetchone()
        if row is None:
            return None
        return {'version': row['version'], 'agreed_at': row['agreed_at']}

    def set_disclaimer_agreement(self, player_id: str, version: int) -> None:
        agreed_at = _now()
        with self._conn() as conn:
            self._execute(
                conn,
                'INSERT INTO disclaimer_agreements (player_id, version, agreed_at) '
                'VALUES (:p, :p, :p) '
                'ON CONFLICT (player_id) DO UPDATE SET '
                'version = EXCLUDED.version, agreed_at = EXCLUDED.agreed_at',
                (player_id, version, agreed_at),
            )

    # ── 查询 ─────────────────────────────────────────────

    def get_match(self, match_id: str) -> Optional[dict]:
        with self._conn() as conn:
            row = self._execute(
                conn,
                'SELECT * FROM matches WHERE id = :p',
                (match_id,),
            ).fetchone()
            if row is None:
                return None
            rounds = self._execute(
                conn,
                'SELECT round, result_json FROM round_results '
                'WHERE match_id = :p ORDER BY round',
                (match_id,),
            ).fetchall()
        return map_match(row, rounds)

    def list_room_matches(self, room_id: str) -> list[dict]:
        with self._conn() as conn:
            rows = self._execute(
                conn,
                'SELECT id, mode, ruleset_id, start_at, end_at, final_scores FROM matches '
                'WHERE room_id = :p ORDER BY start_at',
                (room_id,),
            ).fetchall()
        return [map_match_summary(row) for row in rows]

    def get_player_stats(self, nickname: str) -> dict:
        with self._conn() as conn:
            rows = self._execute(
                conn,
                'SELECT match_id, seat FROM match_players WHERE nickname = :p',
                (nickname,),
            ).fetchall()
            if not rows:
                return {
                    'nickname': nickname,
                    'matches': 0,
                    'hands': 0,
                    'wins': 0,
                    'totalDelta': 0,
                }
            match_seats = {row['match_id']: row['seat'] for row in rows}
            return {'nickname': nickname, **self._aggregate_stats(conn, match_seats)}

    def get_player_stats_by_id(self, player_id: str) -> dict:
        with self._conn() as conn:
            rows = self._execute(
                conn,
                'SELECT match_id, seat FROM match_players WHERE player_id = :p',
                (player_id,),
            ).fetchall()
            if not rows:
                return {
                    'playerId': player_id,
                    'matches': 0,
                    'hands': 0,
                    'wins': 0,
                    'totalDelta': 0,
                }
            match_seats = {row['match_id']: row['seat'] for row in rows}
            return {'playerId': player_id, **self._aggregate_stats(conn, match_seats)}

    def _aggregate_stats(self, conn, match_seats: dict) -> dict:
        match_ids = list(match_seats)
        if not match_ids:
            return aggregate_player_stats([], match_seats)
        placeholders = ','.join(':p' for _ in match_ids)
        rows = self._execute(
            conn,
            'SELECT match_id, result_json FROM round_results '
            f'WHERE match_id IN ({placeholders})',
            match_ids,
        ).fetchall()
        return aggregate_player_stats(rows, match_seats)
