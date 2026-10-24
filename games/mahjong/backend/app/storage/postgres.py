"""PostgreSQL 连接、建表与兼容迁移。"""

import time

import psycopg
from loguru import logger
from psycopg.rows import dict_row

from .base import BaseStorage, load_schema


_SCHEMA = load_schema('schema_postgres.sql')

# 建连阶段重试：Supabase pooler 偶发 DNS/连接抖动，单次失败会让对局结算落库
# 异常、整场驱动终止（见 game/room.py:_drive）。建连幂等，重试无副作用。
_CONNECT_ATTEMPTS = 3
_CONNECT_BACKOFF = 0.5   # 秒，每次尝试后翻倍


class PostgresStorage(BaseStorage):
    """Supabase pooler 或任意 PostgreSQL 的同步存储适配器。"""

    placeholder = '%s'

    def __init__(self, dsn: str):
        self.dsn = dsn

    def _conn(self) -> psycopg.Connection:
        """带退避重试的同步连接；仅重试建连阶段的瞬时失败。"""
        for attempt in range(1, _CONNECT_ATTEMPTS + 1):
            try:
                return psycopg.connect(self.dsn, row_factory=dict_row)
            except psycopg.OperationalError as exc:
                if attempt >= _CONNECT_ATTEMPTS:
                    raise
                delay = _CONNECT_BACKOFF * (2 ** (attempt - 1))
                logger.warning(
                    f"数据库连接失败（第 {attempt}/{_CONNECT_ATTEMPTS} 次），"
                    f"{delay:.1f}s 后重试: {exc}"
                )
                time.sleep(delay)
        raise AssertionError('unreachable')

    def init(self) -> None:
        logger.info("数据库后端: PostgreSQL")
        with self._conn() as conn:
            for statement in _SCHEMA.split(';'):
                statement = statement.strip()
                if statement:
                    conn.execute(statement)
            self._migrate(conn)

    @staticmethod
    def _migrate(conn: psycopg.Connection) -> None:
        row = conn.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'room_seats' AND column_name = 'player_id'"
        ).fetchone()
        if row is None:
            conn.execute('ALTER TABLE room_seats ADD COLUMN player_id TEXT')
        for table in ('rooms', 'matches'):
            row = conn.execute(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name = %s AND column_name = 'ruleset_id'",
                (table,),
            ).fetchone()
            if row is None:
                conn.execute(
                    f"ALTER TABLE {table} ADD COLUMN ruleset_id TEXT NOT NULL DEFAULT 'lotus-classic'"
                )
