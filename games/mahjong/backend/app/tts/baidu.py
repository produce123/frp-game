"""百度短文本在线语音合成客户端（单音色故障降级）。"""

import asyncio
import json
import time
from typing import Optional

import httpx

from app.tts.config import BaiduProviderConfig, BaiduVoiceConfig
from app.tts.provider import TtsProviderError


TOKEN_URL = 'https://aip.baidubce.com/oauth/2.0/token'
TTS_URL = 'https://tsn.baidu.com/text2audio'
MAX_AUDIO_BYTES = 1_048_576


class BaiduTtsClient:
    provider_id = 'baidu'
    cache_version = 2

    def __init__(self, config: BaiduProviderConfig,
                 client: Optional[httpx.AsyncClient] = None):
        self.config = config
        self._client = client or httpx.AsyncClient(trust_env=False)
        self._owns_client = client is None
        self._token = ''
        self._token_expires_at = 0.0
        self._token_lock = asyncio.Lock()

    @property
    def available(self) -> bool:
        return self.config.available

    @property
    def timeout_s(self) -> float:
        return self.config.timeout_s

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def profile_for(self, style: str, voice_key: str) -> BaiduVoiceConfig:
        # 降级链只保留一个中性音色；style/voiceKey 不再改变百度发音人。
        return self.config.voice

    def cache_identity(self, profile: BaiduVoiceConfig) -> dict[str, object]:
        return {
            'voiceId': profile.voice_id,
            'format': 'mp3',
            'speed': profile.speed,
            'pitch': profile.pitch,
            'volume': profile.volume,
            'emotion': profile.emotion,
        }

    def profile_id(self, profile: BaiduVoiceConfig) -> str:
        return str(profile.voice_id)

    async def _access_token(self) -> str:
        now = time.monotonic()
        if self._token and now < self._token_expires_at:
            return self._token
        async with self._token_lock:
            now = time.monotonic()
            if self._token and now < self._token_expires_at:
                return self._token
            try:
                response = await self._client.post(
                    TOKEN_URL,
                    data={
                        'grant_type': 'client_credentials',
                        'client_id': self.config.api_key.get_secret_value(),
                        'client_secret': self.config.secret_key.get_secret_value(),
                    },
                    timeout=self.config.timeout_s,
                )
                response.raise_for_status()
                payload = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise TtsProviderError(
                    'auth', f'百度 TTS 鉴权失败: {type(exc).__name__}', cooldown=True) from exc
            token = payload.get('access_token') if isinstance(payload, dict) else None
            if not isinstance(token, str) or not token:
                error = payload.get('error_description') if isinstance(payload, dict) else None
                raise TtsProviderError(
                    'auth', f'百度 TTS 未返回 access_token: {error or "unknown"}',
                    cooldown=True)
            expires_in = payload.get('expires_in', 2_592_000)
            try:
                ttl = max(300.0, float(expires_in) - 300.0)
            except (TypeError, ValueError):
                ttl = 86_400.0
            self._token = token
            self._token_expires_at = time.monotonic() + ttl
            return token

    async def synthesize(self, text: str, voice: BaiduVoiceConfig) -> bytes:
        token = await self._access_token()
        form = {
            'tex': text,
            'tok': token,
            'cuid': self.config.cuid,
            'ctp': '1',
            'lan': 'zh',
            'spd': str(voice.speed),
            'pit': str(voice.pitch),
            'vol': str(voice.volume),
            'per': str(voice.voice_id),
            'aue': '3',
        }
        if voice.emotion:
            form['text_ctrl'] = json.dumps({'emo': voice.emotion}, ensure_ascii=False)
        try:
            response = await self._client.post(
                TTS_URL,
                data=form,
                timeout=self.config.timeout_s,
            )
            response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise TtsProviderError('timeout', '百度 TTS 请求超时', cooldown=True) from exc
        except httpx.HTTPError as exc:
            raise TtsProviderError(
                'network', f'百度 TTS HTTP 失败: {type(exc).__name__}', cooldown=True) from exc
        content_type = response.headers.get('content-type', '').lower()
        body = response.content
        if not content_type.startswith('audio/'):
            try:
                payload = response.json()
                err_no = payload.get('err_no') or payload.get('error_code')
                err_msg = payload.get('err_msg') or payload.get('error_msg') or 'unknown'
            except ValueError:
                err_no, err_msg = None, 'invalid response'
            raise TtsProviderError(
                'provider', f'百度 TTS 合成失败 err={err_no}: {err_msg}', cooldown=True)
        if not body or len(body) > MAX_AUDIO_BYTES:
            raise TtsProviderError(
                'provider', f'百度 TTS 音频大小异常: {len(body)} bytes', cooldown=True)
        return body
