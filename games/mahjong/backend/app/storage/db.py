"""存储后端兼容门面与运行时选择。

业务调用继续从本模块导入 ``Storage``、``PostgresStorage`` 或共享
``storage``；公共 CRUD 位于 :mod:`app.storage.base`，数据库方言差异分别
位于 SQLite/PostgreSQL 适配器中。
"""

import os
from typing import Optional
from urllib.parse import quote

from dotenv import load_dotenv

from .base import _new_id, _now
# frp-game 补丁：PostgreSQL 适配器按需导入（psycopg 只在真的配了 PG_PASSWORD 时才需要）。
# 本平台固定用 SQLite，不装 psycopg 也能起。
from .sqlite import DEFAULT_DB_PATH, SQLiteStorage, Storage


_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 环境变量优先，backend/.env 仅作回退。
load_dotenv(os.path.join(_BASE_DIR, '.env'))


_PG_DEFAULTS = {
    'PG_HOST': '127.0.0.1',
    'PG_PORT': '6543',
    'PG_USER': '******',
    'PG_DATABASE': '******',
}


def postgres_dsn() -> Optional[str]:
    """从环境变量构造 PostgreSQL DSN；无密码时回退 SQLite。"""
    password = os.environ.get('PG_PASSWORD')
    if not password:
        return None
    host = os.environ.get('PG_HOST', _PG_DEFAULTS['PG_HOST'])
    port = os.environ.get('PG_PORT', _PG_DEFAULTS['PG_PORT'])
    user = os.environ.get('PG_USER', _PG_DEFAULTS['PG_USER'])
    database = os.environ.get('PG_DATABASE', _PG_DEFAULTS['PG_DATABASE'])
    user_encoded = quote(user, safe='')
    password_encoded = quote(password, safe='')
    return (
        f'postgresql://{user_encoded}:{password_encoded}'
        f'@{host}:{port}/{database}'
    )


def _resolve_storage():
    dsn = postgres_dsn()
    return PostgresStorage(dsn) if dsn else Storage()


storage = _resolve_storage()


__all__ = [
    'DEFAULT_DB_PATH',
    'PostgresStorage',
    'SQLiteStorage',
    'Storage',
    'postgres_dsn',
    'storage',
]
