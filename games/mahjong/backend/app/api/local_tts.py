"""单机模式专用 TTS API；只接受白名单音色与短文本。"""

from collections import defaultdict, deque
import json
import re
import time
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator

from app.local_tts.service import get_local_tts_service
from app.tts.cache import KEY_RE


router = APIRouter(prefix='/api/local-tts', tags=['local-tts'])
_STYLE = Literal['激进', '稳健', '话痨', '高冷']
_VOICE_KEY_RE = re.compile(r'^[a-z0-9_-]{1,40}$')
_requests: dict[str, deque[float]] = defaultdict(deque)


def _is_identity_version(value: object) -> bool:
    """anime 固定文案身份的版本段只校验形状（1..1000 的正整数）。

    2026-09-19 修正：此前硬编码 ``parts[1] != 1 or parts[2] != 1``，于是一旦前端递增
    schema/cache 版本，**全部**固定台词合成会被 422 拒掉（前端单测发现不了，只有线上才暴露）。
    身份的具体版本号由前端持有（``ANIME_FIXED_TTS_*_VERSION``），后端只保证它是安全的形状。
    """

    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 1000


class LocalTtsRequest(BaseModel):
    text: str = Field(min_length=1, max_length=30)
    voiceKey: str = Field(min_length=1, max_length=40)
    style: _STYLE
    cacheIdentity: str = Field(default='', max_length=1000)

    @field_validator('text')
    @classmethod
    def clean_text(cls, value: str) -> str:
        cleaned = ' '.join(value.split())
        if not cleaned:
            raise ValueError('text is empty')
        return cleaned

    @field_validator('voiceKey')
    @classmethod
    def validate_voice_key(cls, value: str) -> str:
        normalized = value.strip().lower().replace('-', '_')
        if not _VOICE_KEY_RE.fullmatch(normalized):
            raise ValueError('invalid voiceKey')
        return normalized

    @field_validator('cacheIdentity')
    @classmethod
    def validate_cache_identity(cls, value: str) -> str:
        if not value:
            return ''
        try:
            parts = json.loads(value)
        except (TypeError, ValueError) as exc:
            raise ValueError('invalid cacheIdentity') from exc
        if not isinstance(parts, list) or len(parts) != 12 \
                or parts[0] != 'llm-anime-fixed-tts' \
                or not _is_identity_version(parts[1]) or not _is_identity_version(parts[2]):
            raise ValueError('invalid cacheIdentity')
        return value


def _check_rate_limit(client_ip: str, limit: int) -> None:
    now = time.monotonic()
    bucket = _requests[client_ip]
    cutoff = now - 60.0
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) >= limit:
        raise HTTPException(status_code=429, detail={'code': 'LOCAL_TTS_RATE_LIMITED'})
    bucket.append(now)


@router.post('/synthesize')
async def synthesize_local_tts(payload: LocalTtsRequest, request: Request):
    service = get_local_tts_service()
    if not service.available:
        raise HTTPException(status_code=503, detail={'code': 'LOCAL_TTS_UNAVAILABLE'})
    voice_key = service.normalize_voice_key(payload.voiceKey)
    if voice_key is None:
        raise HTTPException(status_code=400, detail={'code': 'LOCAL_TTS_VOICE_NOT_ALLOWED'})
    client_ip = request.client.host if request.client else 'unknown'
    _check_rate_limit(client_ip, service.rate_limit_per_minute)
    audio = await service.ensure_audio(
        payload.text, voice_key, payload.style, payload.cacheIdentity)
    if audio is None:
        raise HTTPException(status_code=503, detail={'code': 'LOCAL_TTS_SYNTHESIS_FAILED'})
    return {
        'cacheKey': audio.cache_key,
        'audioUrl': f'/api/local-tts/audio/{audio.cache_key}.mp3',
        'cached': audio.cached,
    }


@router.get('/audio/{cache_key}.mp3')
async def get_local_tts_audio(cache_key: str):
    if not KEY_RE.fullmatch(cache_key):
        raise HTTPException(status_code=404, detail={'code': 'LOCAL_TTS_AUDIO_NOT_FOUND'})
    cached = await get_local_tts_service().cache.get(cache_key)
    if cached is None:
        raise HTTPException(status_code=404, detail={'code': 'LOCAL_TTS_AUDIO_NOT_FOUND'})
    return FileResponse(
        cached.path,
        media_type='audio/mpeg',
        headers={
            'Cache-Control': 'public, max-age=2592000, immutable',
            'ETag': f'"{cache_key}"',
            'X-Content-Type-Options': 'nosniff',
        },
    )


def reset_local_tts_rate_limit_for_tests() -> None:
    _requests.clear()
