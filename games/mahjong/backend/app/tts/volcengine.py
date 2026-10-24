"""火山引擎豆包语音合成 V3 HTTP SSE 客户端。"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
import json
from typing import Optional
import uuid

import httpx

from app.tts.config import VolcengineProviderConfig
from app.tts.provider import TtsProviderError


MAX_AUDIO_BYTES = 1_048_576
SUCCESS_CODES = {0, 20_000_000, '0', '20000000'}


@dataclass(frozen=True)
class VolcengineVoiceProfile:
    resource_id: str
    speaker: str
    audio_format: str
    sample_rate: int
    bit_rate: int
    speech_rate: int
    pitch_rate: int
    loudness_rate: int


class VolcengineTtsClient:
    provider_id = 'volcengine'
    cache_version = 1

    def __init__(self, config: VolcengineProviderConfig,
                 client: Optional[httpx.AsyncClient] = None):
        self.config = config
        self._client = client or httpx.AsyncClient(trust_env=False)
        self._owns_client = client is None

    @property
    def available(self) -> bool:
        return self.config.available

    @property
    def timeout_s(self) -> float:
        return self.config.timeout_s

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def profile_for(self, style: str, voice_key: str) -> VolcengineVoiceProfile:
        voice = self.config.voice_for(voice_key)
        style_config = self.config.style_for(style)
        audio = self.config.audio
        return VolcengineVoiceProfile(
            resource_id=self.config.resource_id,
            speaker=voice.speaker,
            audio_format=audio.format,
            sample_rate=audio.sample_rate,
            bit_rate=audio.bit_rate,
            speech_rate=style_config.speech_rate,
            pitch_rate=style_config.pitch_rate,
            loudness_rate=style_config.loudness_rate,
        )

    def cache_identity(self, profile: VolcengineVoiceProfile) -> dict[str, object]:
        return {
            'resourceId': profile.resource_id,
            'speaker': profile.speaker,
            'format': profile.audio_format,
            'sampleRate': profile.sample_rate,
            'bitRate': profile.bit_rate,
            'speechRate': profile.speech_rate,
            'pitchRate': profile.pitch_rate,
            'loudnessRate': profile.loudness_rate,
        }

    def profile_id(self, profile: VolcengineVoiceProfile) -> str:
        return profile.speaker

    def _headers(self) -> dict[str, str]:
        headers = {
            'Content-Type': 'application/json',
            'X-Api-Resource-Id': self.config.resource_id,
            'X-Api-Request-Id': str(uuid.uuid4()),
        }
        api_key = self.config.api_key.get_secret_value()
        if api_key:
            headers['X-Api-Key'] = api_key
        else:
            headers['X-Api-App-Id'] = self.config.app_id.get_secret_value()
            headers['X-Api-Access-Key'] = self.config.access_token.get_secret_value()
        return headers

    def _body(self, text: str, profile: VolcengineVoiceProfile) -> dict:
        additions = {
            'post_process': {'pitch': profile.pitch_rate},
            'disable_markdown_filter': True,
            'enable_latex_tn': False,
        }
        return {
            'user': {'uid': self.config.uid},
            'req_params': {
                'text': text,
                'speaker': profile.speaker,
                'sample_rate': profile.sample_rate,
                'audio_params': {
                    'format': profile.audio_format,
                    'speech_rate': profile.speech_rate,
                    'loudness_rate': profile.loudness_rate,
                    'bit_rate': profile.bit_rate,
                },
                'additions': json.dumps(additions, separators=(',', ':')),
            },
        }

    async def synthesize(self, text: str, profile: VolcengineVoiceProfile) -> bytes:
        chunks: list[bytes] = []
        total = 0
        try:
            async with self._client.stream(
                'POST', self.config.endpoint,
                headers=self._headers(), json=self._body(text, profile),
                timeout=self.config.timeout_s,
            ) as response:
                if response.status_code >= 400:
                    await response.aread()
                    kind = 'auth' if response.status_code in (401, 403) else (
                        'quota' if response.status_code == 429 else 'network')
                    raise TtsProviderError(
                        kind, f'火山 TTS HTTP {response.status_code}', cooldown=True)
                async for line in response.aiter_lines():
                    if not line.startswith('data:'):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == '[DONE]':
                        continue
                    try:
                        payload = json.loads(raw)
                    except json.JSONDecodeError as exc:
                        raise TtsProviderError(
                            'protocol', '火山 TTS 返回无效 SSE JSON', cooldown=True) from exc
                    code = payload.get('code', 0) if isinstance(payload, dict) else None
                    if code not in SUCCESS_CODES:
                        message = payload.get('message', '') if isinstance(payload, dict) else ''
                        raise TtsProviderError(
                            'provider', f'火山 TTS 合成失败 code={code}: {str(message)[:160]}',
                            cooldown=True)
                    encoded = payload.get('data') if isinstance(payload, dict) else None
                    if not encoded:
                        continue
                    try:
                        chunk = base64.b64decode(encoded, validate=True)
                    except (ValueError, binascii.Error) as exc:
                        raise TtsProviderError(
                            'protocol', '火山 TTS 返回无效音频 Base64', cooldown=True) from exc
                    total += len(chunk)
                    if total > MAX_AUDIO_BYTES:
                        raise TtsProviderError(
                            'provider', f'火山 TTS 音频大小异常: {total} bytes', cooldown=True)
                    chunks.append(chunk)
        except TtsProviderError:
            raise
        except httpx.TimeoutException as exc:
            raise TtsProviderError('timeout', '火山 TTS 请求超时', cooldown=True) from exc
        except httpx.HTTPError as exc:
            raise TtsProviderError(
                'network', f'火山 TTS HTTP 失败: {type(exc).__name__}', cooldown=True) from exc
        if not chunks:
            raise TtsProviderError('provider', '火山 TTS 未返回音频', cooldown=True)
        return b''.join(chunks)
