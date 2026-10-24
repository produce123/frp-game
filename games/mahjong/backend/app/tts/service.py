"""TTS 路由：火山主用、百度降级、缓存、single-flight 与熔断。"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import hashlib
import json
import re
import time
import unicodedata
from typing import Any, Mapping, Optional

from loguru import logger

from app.tts.baidu import BaiduTtsClient
from app.tts.cache import CachedAudio, TtsDiskCache
from app.tts.config import (
    TtsCacheBucketConfig,
    TtsConfig,
    load_tts_config,
    normalize_voice_key,
)
from app.tts.fixed_lines import (
    FixedLineTtsRequest,
    fixed_line_voice_candidates,
    resolve_fixed_line_tts_request,
)
from app.tts.provider import TtsProvider, TtsProviderError
from app.tts.volcengine import VolcengineTtsClient


NORMALIZATION_VERSION = 1
CLEANUP_INTERVAL_S = 6 * 60 * 60


@dataclass(frozen=True)
class TtsAudio:
    cache_key: str
    path: str
    cached: bool
    size_bytes: int
    provider: str

    @property
    def audio_url(self) -> str:
        return f'/api/tts/audio/{self.cache_key}.mp3'


@dataclass(frozen=True)
class FixedLineTtsAudio:
    """固定文案合成结果及其安全路由元数据。"""

    request: FixedLineTtsRequest
    voice_key: str
    audio: TtsAudio


@dataclass(frozen=True)
class _SynthesisPlan:
    provider: TtsProvider
    profile: Any
    cache_key: str
    text_hash: str


def normalize_tts_text(text: str) -> str:
    value = unicodedata.normalize('NFKC', text or '')
    value = re.sub(r'\s+', ' ', value).strip()
    replacements = {
        'AI': '人工智能',
        '癞子': '赖子',
    }
    for source, target in replacements.items():
        value = value.replace(source, target)
    return value[:30]


def tts_cache_key(text: str, style: str, provider: TtsProvider,
                  profile: Any, cache_namespace: str = '') -> tuple[str, str]:
    text_hash = hashlib.sha256(text.encode('utf-8')).hexdigest()
    payload = {
        'provider': provider.provider_id,
        'providerVersion': provider.cache_version,
        'normalizationVersion': NORMALIZATION_VERSION,
        'text': text,
        'style': style,
        **provider.cache_identity(profile),
    }
    if cache_namespace:
        payload['cacheNamespace'] = cache_namespace
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest(), text_hash


class TtsService:
    def __init__(self, config: Optional[TtsConfig] = None,
                 providers: Optional[Mapping[str, TtsProvider]] = None,
                 cache: Optional[TtsDiskCache] = None,
                 cache_config: Optional[TtsCacheBucketConfig] = None):
        self.config = config or load_tts_config()
        self.providers: dict[str, TtsProvider] = dict(providers or {
            'volcengine': VolcengineTtsClient(self.config.providers.volcengine),
            'baidu': BaiduTtsClient(self.config.providers.baidu),
        })
        bucket = cache_config or self.config.cache.room
        self.cache = cache or TtsDiskCache(
            bucket.dir, bucket.max_mb * 1024 * 1024, bucket.ttl_days)
        self._semaphore = asyncio.Semaphore(self.config.runtime.concurrency)
        self._lock = asyncio.Lock()
        self._inflight: dict[str, asyncio.Task[Optional[TtsAudio]]] = {}
        self._negative: dict[str, float] = {}
        self._provider_cooldown: dict[str, float] = {}
        self._last_cleanup = 0.0
        self.stats = {
            'requests': 0, 'hits': 0, 'misses': 0, 'generated': 0,
            'errors': 0, 'singleflightWaits': 0, 'negativeHits': 0,
            'circuitSkips': 0, 'fallbacks': 0,
            'volcengineGenerated': 0, 'baiduGenerated': 0,
        }

    @property
    def available(self) -> bool:
        return self.config.enabled and any(
            (provider := self.providers.get(name)) is not None and provider.available
            for name in self.config.provider_names
        )

    @property
    def available_providers(self) -> tuple[str, ...]:
        return tuple(
            name for name in self.config.provider_names
            if (provider := self.providers.get(name)) is not None and provider.available
        )

    async def close(self) -> None:
        tasks = list(self._inflight.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        seen: set[int] = set()
        for provider in self.providers.values():
            if id(provider) in seen:
                continue
            seen.add(id(provider))
            await provider.close()

    def stats_snapshot(self) -> dict[str, int]:
        return dict(self.stats)

    def _plans(self, text: str, style: str, voice_key: str,
               cache_namespace: str = '') -> list[_SynthesisPlan]:
        plans = []
        for name in self.config.provider_names:
            provider = self.providers.get(name)
            if provider is None:
                continue
            profile = provider.profile_for(style, voice_key)
            cache_key, text_hash = tts_cache_key(
                text, style, provider, profile, cache_namespace)
            plans.append(_SynthesisPlan(provider, profile, cache_key, text_hash))
        return plans

    def _skip_reason(self, plan: _SynthesisPlan, now: float) -> str:
        if not plan.provider.available:
            return 'unavailable'
        if self._provider_cooldown.get(plan.provider.provider_id, 0) > now:
            return 'circuit'
        if self._negative.get(plan.cache_key, 0) > now:
            return 'negative'
        return ''

    async def _preferred_cached(self, plans: list[_SynthesisPlan]) -> Optional[TtsAudio]:
        now = time.monotonic()
        for plan in plans:
            cached = await self.cache.get(plan.cache_key)
            if cached is not None:
                self.stats['hits'] += 1
                return self._result(cached, plan.provider.provider_id)
            reason = self._skip_reason(plan, now)
            if reason:
                if reason == 'circuit':
                    self.stats['circuitSkips'] += 1
                elif reason == 'negative':
                    self.stats['negativeHits'] += 1
                continue
            # 首选 provider 健康但未命中时应先尝试生成，不能被旧降级缓存永久黏住。
            break
        return None

    async def ensure_audio(self, text: str, style: str,
                           provider_id: str = '', *,
                           cache_namespace: str = '') -> Optional[TtsAudio]:
        if not self.available:
            return None
        normalized = normalize_tts_text(text)
        if not normalized:
            return None
        voice_key = normalize_voice_key(provider_id) or 'default'
        plans = self._plans(normalized, style, voice_key, cache_namespace)
        if not plans:
            return None
        self.stats['requests'] += 1
        cached = await self._preferred_cached(plans)
        if cached is not None:
            return cached
        route_key = '|'.join(plan.cache_key for plan in plans)
        creator = False
        async with self._lock:
            task = self._inflight.get(route_key)
            if task is None:
                creator = True
                self.stats['misses'] += 1
                task = asyncio.create_task(
                    self._generate_chain(plans, normalized, style))
                self._inflight[route_key] = task
            else:
                self.stats['singleflightWaits'] += 1
        try:
            return await asyncio.shield(task)
        finally:
            if creator:
                async with self._lock:
                    if self._inflight.get(route_key) is task:
                        self._inflight.pop(route_key, None)

    async def ensure_fixed_line_audio(
        self,
        character_id: object,
        line_key: object,
    ) -> Optional[FixedLineTtsAudio]:
        """使用角色白名单、固定稳健风格和现有缓存合成动作/赛后文案。

        主音色不可用或合成失败时仅尝试 catalog 的替代音色/default；所有候选
        必须存在于当前 TTS 配置白名单。缓存仍由 ``ensure_audio`` 统一负责。
        """

        request = resolve_fixed_line_tts_request(character_id, line_key)
        if request is None:
            return None
        voices = fixed_line_voice_candidates(request, self.config.voice_keys)
        for voice_key in voices:
            audio = await self.ensure_audio(
                request.text,
                request.style,
                '' if voice_key == 'default' else voice_key,
            )
            if audio is not None:
                return FixedLineTtsAudio(request=request, voice_key=voice_key, audio=audio)
        return None

    async def _generate_chain(self, plans: list[_SynthesisPlan], text: str,
                              style: str) -> Optional[TtsAudio]:
        deadline = time.monotonic() + self.config.runtime.total_timeout_s
        attempted = 0
        for index, plan in enumerate(plans):
            now = time.monotonic()
            cached = await self.cache.get(plan.cache_key)
            if cached is not None:
                self.stats['hits'] += 1
                if index > 0:
                    self.stats['fallbacks'] += 1
                return self._result(cached, plan.provider.provider_id)
            reason = self._skip_reason(plan, now)
            if reason:
                if reason == 'circuit':
                    self.stats['circuitSkips'] += 1
                elif reason == 'negative':
                    self.stats['negativeHits'] += 1
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            attempted += 1
            try:
                async with self._semaphore:
                    audio = await asyncio.wait_for(
                        plan.provider.synthesize(text, plan.profile),
                        timeout=min(remaining, plan.provider.timeout_s))
                cached = await self.cache.put(
                    plan.cache_key, audio,
                    provider=plan.provider.provider_id,
                    voice_id=plan.provider.profile_id(plan.profile),
                    style=style, text_hash=plan.text_hash)
                self.stats['generated'] += 1
                counter = f'{plan.provider.provider_id}Generated'
                if counter in self.stats:
                    self.stats[counter] += 1
                if index > 0:
                    self.stats['fallbacks'] += 1
                self._provider_cooldown.pop(plan.provider.provider_id, None)
                await self._maybe_cleanup()
                return self._result(cached, plan.provider.provider_id)
            except asyncio.TimeoutError:
                error = TtsProviderError(
                    'timeout', f'{plan.provider.provider_id} TTS 总预算超时', cooldown=True)
                self._record_failure(plan, error)
            except TtsProviderError as exc:
                self._record_failure(plan, exc)
            except (OSError, ValueError):
                error = TtsProviderError(
                    'runtime', f'{plan.provider.provider_id} TTS 运行失败', cooldown=True)
                self._record_failure(plan, error)
        if attempted == 0:
            self.stats['negativeHits'] += 1
        return None

    def _record_failure(self, plan: _SynthesisPlan, exc: TtsProviderError) -> None:
        now = time.monotonic()
        self.stats['errors'] += 1
        self._negative[plan.cache_key] = now + self.config.runtime.negative_ttl_s
        if exc.cooldown:
            self._provider_cooldown[plan.provider.provider_id] = (
                now + self.config.runtime.provider_cooldown_s)
        logger.bind(
            tts_provider=plan.provider.provider_id,
            tts_error=exc.kind,
        ).warning('TTS provider 合成失败，尝试故障降级')

    async def _maybe_cleanup(self) -> None:
        now = time.monotonic()
        if now - self._last_cleanup < CLEANUP_INTERVAL_S:
            return
        self._last_cleanup = now
        result = await self.cache.cleanup()
        if result['removed']:
            logger.bind(tts_cache_cleanup=result).info('TTS 缓存清理完成')

    @staticmethod
    def _result(cached: CachedAudio, provider: str) -> TtsAudio:
        return TtsAudio(
            cache_key=cached.cache_key,
            path=str(cached.path),
            cached=cached.cached,
            size_bytes=cached.size_bytes,
            provider=provider,
        )


_service: Optional[TtsService] = None


def get_tts_service() -> TtsService:
    global _service
    if _service is None:
        _service = TtsService()
    return _service


def reset_tts_service_for_tests() -> None:
    global _service
    _service = None
