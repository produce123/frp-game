"""TTS 磁盘缓存：MP3 文件 + SQLite 元数据 + TTL/LRU 清理。"""

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import re
import sqlite3
import tempfile


KEY_RE = re.compile(r'^[0-9a-f]{64}$')


@dataclass(frozen=True)
class CachedAudio:
    cache_key: str
    path: Path
    size_bytes: int
    cached: bool


class TtsDiskCache:
    def __init__(self, root: Path, max_bytes: int, ttl_days: int):
        self.root = root.resolve()
        self.max_bytes = max_bytes
        self.ttl_days = ttl_days
        self.db_path = self.root / 'index.sqlite3'
        self.tmp_dir = self.root / 'tmp'
        self.root.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA journal_mode=WAL')
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute('''
                CREATE TABLE IF NOT EXISTS tts_cache (
                    cache_key TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    voice_id TEXT NOT NULL,
                    style TEXT NOT NULL,
                    text_hash TEXT NOT NULL,
                    relative_path TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    hit_count INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    last_accessed_at TEXT NOT NULL
                )
            ''')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_tts_cache_access ON tts_cache(last_accessed_at)')

    def path_for_key(self, cache_key: str) -> Path | None:
        if not KEY_RE.fullmatch(cache_key):
            return None
        return self.root / cache_key[:2] / cache_key[2:4] / f'{cache_key}.mp3'

    async def get(self, cache_key: str) -> CachedAudio | None:
        return await asyncio.to_thread(self._get_sync, cache_key)

    def _get_sync(self, cache_key: str) -> CachedAudio | None:
        path = self.path_for_key(cache_key)
        if path is None:
            return None
        with self._connect() as conn:
            row = conn.execute(
                'SELECT relative_path, size_bytes, last_accessed_at FROM tts_cache WHERE cache_key=?',
                (cache_key,),
            ).fetchone()
            if row is None:
                return None
            stored_path = (self.root / row['relative_path']).resolve()
            if self.root not in stored_path.parents or not stored_path.is_file():
                conn.execute('DELETE FROM tts_cache WHERE cache_key=?', (cache_key,))
                return None
            try:
                last_access = datetime.fromisoformat(row['last_accessed_at'])
            except ValueError:
                last_access = datetime.fromtimestamp(0, tz=timezone.utc)
            if last_access < datetime.now(timezone.utc) - timedelta(days=self.ttl_days):
                stored_path.unlink(missing_ok=True)
                conn.execute('DELETE FROM tts_cache WHERE cache_key=?', (cache_key,))
                return None
            now = datetime.now(timezone.utc).isoformat()
            conn.execute(
                'UPDATE tts_cache SET hit_count=hit_count+1,last_accessed_at=? WHERE cache_key=?',
                (now, cache_key),
            )
            return CachedAudio(cache_key, stored_path, int(row['size_bytes']), True)

    async def put(self, cache_key: str, audio: bytes, *, provider: str,
                  voice_id: str, style: str, text_hash: str) -> CachedAudio:
        return await asyncio.to_thread(
            self._put_sync, cache_key, audio, provider, voice_id, style, text_hash)

    def _put_sync(self, cache_key: str, audio: bytes, provider: str,
                  voice_id: str, style: str, text_hash: str) -> CachedAudio:
        destination = self.path_for_key(cache_key)
        if destination is None:
            raise ValueError('invalid cache key')
        destination.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(prefix=f'{cache_key}.', suffix='.part', dir=self.tmp_dir)
        try:
            with os.fdopen(fd, 'wb') as handle:
                handle.write(audio)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, destination)
        finally:
            try:
                Path(temp_name).unlink(missing_ok=True)
            except OSError:
                pass
        now = datetime.now(timezone.utc).isoformat()
        relative_path = destination.relative_to(self.root).as_posix()
        with self._connect() as conn:
            conn.execute('''
                INSERT INTO tts_cache (
                    cache_key,provider,voice_id,style,text_hash,relative_path,mime_type,
                    size_bytes,hit_count,created_at,last_accessed_at
                ) VALUES (?,?,?,?,?,?,?, ?,0,?,?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    relative_path=excluded.relative_path,
                    size_bytes=excluded.size_bytes,
                    last_accessed_at=excluded.last_accessed_at
            ''', (
                cache_key, provider, voice_id, style, text_hash, relative_path,
                'audio/mpeg', len(audio), now, now,
            ))
        return CachedAudio(cache_key, destination, len(audio), False)

    async def cleanup(self) -> dict[str, int]:
        return await asyncio.to_thread(self._cleanup_sync)

    def _cleanup_sync(self) -> dict[str, int]:
        removed = 0
        removed_bytes = 0
        cutoff = (datetime.now(timezone.utc) - timedelta(days=self.ttl_days)).isoformat()
        with self._connect() as conn:
            rows = conn.execute(
                'SELECT cache_key,relative_path,size_bytes,last_accessed_at FROM tts_cache '
                'ORDER BY last_accessed_at ASC').fetchall()
            keep = []
            for row in rows:
                path = (self.root / row['relative_path']).resolve()
                expired = row['last_accessed_at'] < cutoff
                if expired or self.root not in path.parents or not path.is_file():
                    if self.root in path.parents:
                        path.unlink(missing_ok=True)
                    conn.execute('DELETE FROM tts_cache WHERE cache_key=?', (row['cache_key'],))
                    removed += 1
                    removed_bytes += int(row['size_bytes'])
                else:
                    keep.append(row)
            total = sum(int(row['size_bytes']) for row in keep)
            for row in keep:
                if total <= self.max_bytes:
                    break
                path = (self.root / row['relative_path']).resolve()
                if self.root in path.parents:
                    path.unlink(missing_ok=True)
                conn.execute('DELETE FROM tts_cache WHERE cache_key=?', (row['cache_key'],))
                size = int(row['size_bytes'])
                total -= size
                removed += 1
                removed_bytes += size
        return {'removed': removed, 'removedBytes': removed_bytes}
