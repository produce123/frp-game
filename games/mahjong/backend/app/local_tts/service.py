"""单机 TTS 网关：独立缓存、音色白名单与共享 provider 路由。"""

from typing import Optional

from app.tts.config import TtsConfig, load_tts_config, normalize_voice_key
from app.tts.service import TtsAudio, TtsService


class LocalTtsGatewayService:
    """与联机 RoomSession 完全解耦的单机语音服务。"""

    def __init__(self, config: Optional[TtsConfig] = None,
                 tts: Optional[TtsService] = None):
        self.config = config or load_tts_config()
        self.tts = tts or TtsService(
            self.config, cache_config=self.config.cache.local)
        configured = {
            normalize_voice_key(item)
            for item in self.config.local_gateway.allowed_voice_keys
            if normalize_voice_key(item)
        }
        self.allowed_voice_keys = frozenset({
            'default', *self.config.voice_keys, *configured,
        })
        self.rate_limit_per_minute = self.config.local_gateway.rate_limit_per_minute

    @property
    def available(self) -> bool:
        return self.config.local_gateway.enabled and self.tts.available

    @property
    def cache(self):
        return self.tts.cache

    def normalize_voice_key(self, voice_key: str) -> Optional[str]:
        normalized = normalize_voice_key(voice_key)
        return normalized if normalized in self.allowed_voice_keys else None

    async def ensure_audio(self, text: str, voice_key: str,
                           style: str, cache_identity: str = '') -> Optional[TtsAudio]:
        normalized = self.normalize_voice_key(voice_key)
        if normalized is None or not self.available:
            return None
        provider_id = '' if normalized == 'default' else normalized
        return await self.tts.ensure_audio(
            text, style, provider_id, cache_namespace=cache_identity)

    async def close(self) -> None:
        await self.tts.close()


_service: Optional[LocalTtsGatewayService] = None


def get_local_tts_service() -> LocalTtsGatewayService:
    global _service
    if _service is None:
        _service = LocalTtsGatewayService()
    return _service


def reset_local_tts_service_for_tests() -> None:
    global _service
    _service = None
