"""SQLite 连接、建表与兼容迁移。"""

import os
import sqlite3
from typing import Optional

from loguru import logger

from .base import BaseStorage, load_schema


_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# frp-game 补丁：测试/多实例可以指定独立库，避免和线上 data/mahjong.db 互相污染。
DEFAULT_DB_PATH = os.environ.get('MAHJONG_DB_PATH') or os.path.join(_BASE_DIR, 'data', 'mahjong.db')
_SCHEMA = load_schema('schema_sqlite.sql')


class SQLiteStorage(BaseStorage):
    """每次操作创建短连接的 SQLite 存储适配器。"""

    placeholder = '?'

    def __init__(self, db_path: Optional[str] = None):
        self.path = db_path or DEFAULT_DB_PATH
        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def init(self) -> None:
        logger.info(f"数据库后端: SQLite 路径={self.path}")
        with self._conn() as conn:
            conn.executescript(_SCHEMA)
            self._migrate(conn)

    @staticmethod
    def _migrate(conn: sqlite3.Connection) -> None:
        """旧库补列：CREATE TABLE IF NOT EXISTS 不会修改已存在表。"""
        columns = {
            row['name']
            for row in conn.execute('PRAGMA table_info(room_seats)').fetchall()
        }
        if 'player_id' not in columns:
            conn.execute('ALTER TABLE room_seats ADD COLUMN player_id TEXT')
        room_columns = {row['name'] for row in conn.execute('PRAGMA table_info(rooms)').fetchall()}
        if 'ruleset_id' not in room_columns:
            conn.execute("ALTER TABLE rooms ADD COLUMN ruleset_id TEXT NOT NULL DEFAULT 'lotus-classic'")
        match_columns = {row['name'] for row in conn.execute('PRAGMA table_info(matches)').fetchall()}
        if 'ruleset_id' not in match_columns:
            conn.execute("ALTER TABLE matches ADD COLUMN ruleset_id TEXT NOT NULL DEFAULT 'lotus-classic'")


# 原有名称保持兼容；新代码可使用更明确的 SQLiteStorage。
Storage = SQLiteStorage
