"""TTS 缓存音频只读接口；不提供任意文本合成入口。"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.tts.cache import KEY_RE
from app.tts.service import get_tts_service


router = APIRouter(prefix='/api/tts', tags=['tts'])


@router.get('/audio/{cache_key}.mp3')
async def get_tts_audio(cache_key: str):
    if not KEY_RE.fullmatch(cache_key):
        raise HTTPException(status_code=404, detail={'code': 'TTS_AUDIO_NOT_FOUND'})
    cached = await get_tts_service().cache.get(cache_key)
    if cached is None:
        raise HTTPException(status_code=404, detail={'code': 'TTS_AUDIO_NOT_FOUND'})
    return FileResponse(
        cached.path,
        media_type='audio/mpeg',
        headers={
            'Cache-Control': 'public, max-age=2592000, immutable',
            'ETag': f'"{cache_key}"',
            'X-Content-Type-Options': 'nosniff',
        },
    )
