"""火山主用、百度降级、YAML 配置与 TTS 缓存测试（不访问外网）。"""

import asyncio
import base64
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

import httpx
import pytest

from app.local_tts.service import LocalTtsGatewayService
from app.tts.baidu import BaiduTtsClient
from app.tts.cache import TtsDiskCache
from app.tts.config import (
    BaiduProviderConfig,
    BaiduVoiceConfig,
    LocalTtsConfig,
    TtsCacheBucketConfig,
    TtsCacheConfig,
    TtsConfig,
    TtsConfigError,
    TtsProvidersConfig,
    TtsRuntimeConfig,
    VolcengineProviderConfig,
    load_tts_config,
)
from app.tts.provider import TtsProviderError
from app.tts.fixed_lines import (
    fixed_line_voice_candidates,
    resolve_fixed_line_tts_request,
)
from app.tts.service import TtsService, normalize_tts_text, tts_cache_key
from app.tts.volcengine import VolcengineTtsClient


def config(tmp_path: Path) -> TtsConfig:
    return TtsConfig(
        enabled=True,
        runtime=TtsRuntimeConfig(
            total_timeout_s=2.0, concurrency=2,
            negative_ttl_s=30.0, provider_cooldown_s=60.0),
        cache=TtsCacheConfig(
            room=TtsCacheBucketConfig(
                dir=tmp_path / 'tts-cache', max_mb=16, ttl_days=30),
            local=TtsCacheBucketConfig(
                dir=tmp_path / 'local-cache', max_mb=16, ttl_days=30),
        ),
        local_gateway=LocalTtsConfig(
            enabled=True, rate_limit_per_minute=60,
            allowed_voice_keys=('custom_voice',)),
        providers=TtsProvidersConfig(
            volcengine=VolcengineProviderConfig(
                enabled=True, api_key='volc-key', timeout_s=2.0),
            baidu=BaiduProviderConfig(
                enabled=True, api_key='baidu-key', secret_key='baidu-secret',
                timeout_s=2.0, voice=BaiduVoiceConfig(voice_id=0)),
        ),
    )


class FakeProvider:
    cache_version = 1

    def __init__(self, provider_id: str, *, audio: bytes = b'ID3-audio',
                 error: Exception | None = None, delay: float = 0.01,
                 timeout_s: float = 1.0):
        self.provider_id = provider_id
        self.audio = audio
        self.error = error
        self.delay = delay
        self.timeout_s = timeout_s
        self.available = True
        self.calls = 0

    def profile_for(self, style, voice_key):
        return {'style': style, 'voiceKey': voice_key, 'voiceId': f'{self.provider_id}-voice'}

    def cache_identity(self, profile):
        return dict(profile)

    def profile_id(self, profile):
        return profile['voiceId']

    async def synthesize(self, text, profile):
        self.calls += 1
        await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return self.audio

    async def close(self):
        pass


def test_yaml_credentials_are_loaded_and_redacted(tmp_path):
    secrets = tmp_path / 'secrets'
    secrets.mkdir()
    (secrets / 'volc.txt').write_text(
        'apikey：volc-secret-value\nappid：legacy-app\nAccessToken：legacy-token\n',
        encoding='utf-8')
    (secrets / 'baidu.txt').write_text(
        'API Key：baidu-api-value\nSecret Key：baidu-secret-value\n', encoding='utf-8')
    path = tmp_path / 'tts.yml'
    path.write_text('''
version: 1
enabled: true
providers:
  volcengine:
    enabled: true
    credential_file: secrets/volc.txt
  baidu:
    enabled: true
    credential_file: secrets/baidu.txt
''', encoding='utf-8')
    cfg = load_tts_config(path)
    assert cfg.available is True
    assert cfg.providers.volcengine.api_key.get_secret_value() == 'volc-secret-value'
    assert cfg.providers.baidu.secret_key.get_secret_value() == 'baidu-secret-value'
    assert 'volc-secret-value' not in repr(cfg)
    assert 'baidu-secret-value' not in repr(cfg)


def test_yaml_rejects_unknown_fields(tmp_path):
    path = tmp_path / 'tts.yml'
    path.write_text('version: 1\nenabled: false\nunknown: true\n', encoding='utf-8')
    with pytest.raises(TtsConfigError, match='invalid TTS config'):
        load_tts_config(path)


def test_missing_yaml_disables_tts(tmp_path):
    cfg = load_tts_config(tmp_path / 'missing.yml')
    assert cfg.enabled is False
    assert cfg.available is False


def test_baidu_fallback_uses_one_voice_for_all_styles(tmp_path):
    cfg = config(tmp_path).providers.baidu
    client = BaiduTtsClient(cfg, httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(500))))
    try:
        aggressive = client.profile_for('激进', 'deepseek')
        cold = client.profile_for('高冷', 'relay_gpt')
        assert aggressive == cold == cfg.voice
        assert aggressive.voice_id == 0
    finally:
        asyncio.run(client.close())


@pytest.mark.asyncio
async def test_volcengine_v3_sse_request_and_audio_chunks(tmp_path):
    requests = []
    first = base64.b64encode(b'ID3-').decode()
    second = base64.b64encode(b'audio').decode()

    async def handler(request: httpx.Request):
        requests.append(request)
        body = (
            f'data: {json.dumps({"code": 20000000, "data": first})}\n\n'
            f'data: {json.dumps({"code": 20000000, "data": second})}\n\n')
        return httpx.Response(200, text=body, headers={'Content-Type': 'text/event-stream'})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = VolcengineTtsClient(config(tmp_path).providers.volcengine, http)
    profile = client.profile_for('激进', 'deepseek')
    assert await client.synthesize('稳住。', profile) == b'ID3-audio'
    request = requests[0]
    assert request.headers['x-api-key'] == 'volc-key'
    assert request.headers['x-api-resource-id'] == 'seed-tts-2.0'
    payload = json.loads(request.content)
    assert payload['req_params']['speaker'] == 'zh_female_vv_uranus_bigtts'
    assert payload['req_params']['audio_params'] == {
        'format': 'mp3', 'speech_rate': 15,
        'loudness_rate': 10, 'bit_rate': 64000,
    }
    assert payload['req_params']['sample_rate'] == 24000
    await http.aclose()


@pytest.mark.asyncio
async def test_volcengine_business_error_is_provider_error(tmp_path):
    async def handler(request: httpx.Request):
        body = f'data: {json.dumps({"code": 55000000, "message": "bad speaker"})}\n\n'
        return httpx.Response(200, text=body)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = VolcengineTtsClient(config(tmp_path).providers.volcengine, http)
    with pytest.raises(TtsProviderError, match='55000000'):
        await client.synthesize('稳住。', client.profile_for('稳健', 'default'))
    await http.aclose()


@pytest.mark.asyncio
async def test_baidu_client_caches_token_and_accepts_audio_response(tmp_path):
    calls = []

    async def handler(request: httpx.Request):
        calls.append(str(request.url))
        if 'oauth' in str(request.url):
            return httpx.Response(200, json={'access_token': 'token', 'expires_in': 3600})
        return httpx.Response(200, content=b'ID3-audio', headers={'Content-Type': 'audio/mp3'})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = BaiduTtsClient(config(tmp_path).providers.baidu, http)
    voice = client.profile_for('稳健', 'default')
    assert await client.synthesize('稳住。', voice) == b'ID3-audio'
    assert await client.synthesize('再来。', voice) == b'ID3-audio'
    assert sum('oauth' in url for url in calls) == 1
    await http.aclose()


def test_text_normalization_and_provider_are_part_of_cache_key(tmp_path):
    cfg = config(tmp_path)
    text = normalize_tts_text('  AI  打出癞子  ')
    assert text == '人工智能 打出赖子'
    volc = FakeProvider('volcengine')
    baidu = FakeProvider('baidu')
    profile = volc.profile_for('稳健', 'default')
    steady, _ = tts_cache_key(text, '稳健', volc, profile)
    steady_again, _ = tts_cache_key(text, '稳健', volc, profile)
    fallback, _ = tts_cache_key(text, '稳健', baidu, baidu.profile_for('稳健', 'default'))
    namespaced, _ = tts_cache_key(text, '稳健', volc, profile, 'llm-anime-cache-v1')
    namespaced_v2, _ = tts_cache_key(text, '稳健', volc, profile, 'llm-anime-cache-v2')
    assert steady == steady_again
    assert steady != fallback
    assert len({steady, namespaced, namespaced_v2}) == 3


@pytest.mark.asyncio
async def test_primary_success_does_not_call_fallback(tmp_path):
    primary = FakeProvider('volcengine', audio=b'ID3-volc')
    fallback = FakeProvider('baidu', audio=b'ID3-baidu')
    service = TtsService(config(tmp_path), providers={
        'volcengine': primary, 'baidu': fallback,
    })
    audio = await service.ensure_audio('这一手稳住。', '稳健', 'deepseek')
    assert audio is not None and audio.provider == 'volcengine'
    assert primary.calls == 1 and fallback.calls == 0
    await service.close()


@pytest.mark.asyncio
async def test_primary_failure_automatically_falls_back_to_baidu(tmp_path):
    primary = FakeProvider(
        'volcengine', error=TtsProviderError('network', 'down', cooldown=True))
    fallback = FakeProvider('baidu', audio=b'ID3-baidu')
    service = TtsService(config(tmp_path), providers={
        'volcengine': primary, 'baidu': fallback,
    })
    audio = await service.ensure_audio('火山故障。', '稳健', 'default')
    assert audio is not None and audio.provider == 'baidu'
    assert primary.calls == 1 and fallback.calls == 1
    assert service.stats['fallbacks'] == 1
    await service.close()


@pytest.mark.asyncio
async def test_primary_timeout_preserves_budget_for_baidu_fallback(tmp_path):
    primary = FakeProvider('volcengine', delay=0.2, timeout_s=0.02)
    fallback = FakeProvider('baidu', audio=b'ID3-baidu')
    service = TtsService(config(tmp_path), providers={
        'volcengine': primary, 'baidu': fallback,
    })
    audio = await service.ensure_audio('超时降级。', '稳健')
    assert audio is not None and audio.provider == 'baidu'
    assert primary.calls == 1 and fallback.calls == 1
    await service.close()


@pytest.mark.asyncio
async def test_provider_circuit_skips_repeated_primary_failures(tmp_path):
    primary = FakeProvider(
        'volcengine', error=TtsProviderError('quota', 'quota', cooldown=True))
    fallback = FakeProvider('baidu')
    service = TtsService(config(tmp_path), providers={
        'volcengine': primary, 'baidu': fallback,
    })
    assert (await service.ensure_audio('第一句。', '稳健')).provider == 'baidu'
    assert (await service.ensure_audio('第二句。', '稳健')).provider == 'baidu'
    assert primary.calls == 1
    assert fallback.calls == 2
    assert service.stats['circuitSkips'] >= 1
    await service.close()


@pytest.mark.asyncio
async def test_primary_recovers_instead_of_sticking_to_cached_fallback(tmp_path):
    primary = FakeProvider(
        'volcengine', audio=b'ID3-volc',
        error=TtsProviderError('network', 'down', cooldown=True))
    fallback = FakeProvider('baidu', audio=b'ID3-baidu')
    service = TtsService(config(tmp_path), providers={
        'volcengine': primary, 'baidu': fallback,
    })
    first = await service.ensure_audio('恢复测试。', '稳健')
    assert first is not None and first.provider == 'baidu'
    primary.error = None
    service._provider_cooldown.clear()
    service._negative.clear()
    recovered = await service.ensure_audio('恢复测试。', '稳健')
    assert recovered is not None and recovered.provider == 'volcengine'
    assert primary.calls == 2
    await service.close()


@pytest.mark.asyncio
async def test_singleflight_and_persistent_cache_call_primary_once(tmp_path):
    primary = FakeProvider('volcengine')
    fallback = FakeProvider('baidu')
    service = TtsService(config(tmp_path), providers={
        'volcengine': primary, 'baidu': fallback,
    })
    results = await asyncio.gather(*[
        service.ensure_audio('并发合成。', '稳健') for _ in range(10)
    ])
    assert primary.calls == 1 and fallback.calls == 0
    assert all(item is not None and item.provider == 'volcengine' for item in results)
    assert service.stats['singleflightWaits'] + service.stats['hits'] == 9
    cached = await service.ensure_audio('并发合成。', '稳健')
    assert cached is not None and cached.cached is True
    assert primary.calls == 1
    await service.close()


@pytest.mark.asyncio
async def test_local_tts_gateway_has_independent_cache_and_voice_allowlist(tmp_path):
    cfg = config(tmp_path)
    primary = FakeProvider('volcengine')
    fallback = FakeProvider('baidu')
    tts = TtsService(
        cfg, providers={'volcengine': primary, 'baidu': fallback},
        cache_config=cfg.cache.local)
    gateway = LocalTtsGatewayService(cfg, tts)
    try:
        assert gateway.cache.root == (tmp_path / 'local-cache').resolve()
        assert {
            'default', 'deepseek', 'qwen', 'kimi', 'gpt', 'relay_gpt',
            'doubao', 'minimax', 'claude', 'glm', 'custom_voice',
        } <= gateway.allowed_voice_keys
        assert gateway.normalize_voice_key('CUSTOM-VOICE') == 'custom_voice'
        assert gateway.normalize_voice_key('../bad') is None
    finally:
        await gateway.close()


def test_fixed_line_request_is_derived_from_catalog_and_has_safe_metadata():
    action = resolve_fixed_line_tts_request('  QWEN  ', 'chi')
    assert action is not None
    assert action.character_id == 'qwen'
    assert action.purpose == 'action'
    assert action.speech_source == 'fixed-line'
    assert action.text == '这张我吃。'
    assert action.style == '稳健'
    assert (action.voice_key, action.fallback_voice_key) == ('qwen', 'default')

    reaction = resolve_fixed_line_tts_request('unknown', 'loss')
    assert reaction is not None
    assert reaction.character_id == 'deepseek'
    assert reaction.purpose == 'round-reaction'
    assert reaction.text == '这局没吃饱，下局再来！'
    assert resolve_fixed_line_tts_request('qwen', '../arbitrary') is None


def test_fixed_line_voice_candidates_never_pass_illegal_or_unconfigured_values():
    request = resolve_fixed_line_tts_request('deepseek', 'peng')
    assert request is not None
    unsafe = replace(
        request,
        voice_key='../bad',
        fallback_voice_key='QWEN',
    )
    assert fixed_line_voice_candidates(
        unsafe, {'default', 'qwen', '../bad'},
    ) == ('qwen', 'default')
    assert fixed_line_voice_candidates(
        replace(unsafe, fallback_voice_key='missing'), {'default'},
    ) == ('default',)
    assert fixed_line_voice_candidates(unsafe, 'qwen') == ()


@pytest.mark.asyncio
async def test_fixed_line_tts_reuses_existing_text_voice_style_cache(tmp_path):
    primary = FakeProvider('volcengine')
    fallback = FakeProvider('baidu')
    service = TtsService(config(tmp_path), providers={
        'volcengine': primary,
        'baidu': fallback,
    })
    try:
        first = await service.ensure_fixed_line_audio('deepseek', 'chi')
        second = await service.ensure_fixed_line_audio('deepseek', 'chi')
        assert first is not None and second is not None
        assert first.request.purpose == 'action'
        assert first.voice_key == 'deepseek'
        assert first.audio.cache_key == second.audio.cache_key
        assert second.audio.cached is True
        assert primary.calls == 1
        assert fallback.calls == 0

        # 通用接口使用同一 text+voice+style 时命中同一份缓存；purpose 不分裂音频缓存。
        generic = await service.ensure_audio(
            first.request.text, first.request.style, first.voice_key)
        assert generic is not None and generic.cache_key == first.audio.cache_key
        assert generic.cached is True
        assert primary.calls == 1

        # 相同文案换 voice 会改变 profile/cache identity。
        other_voice = await service.ensure_audio(
            first.request.text, first.request.style, 'qwen')
        assert other_voice is not None
        assert other_voice.cache_key != first.audio.cache_key
        assert primary.calls == 2
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_fixed_line_tts_falls_back_to_configured_default_voice(tmp_path):
    cfg = config(tmp_path)
    only_default = cfg.providers.volcengine.voices['default']
    volc = cfg.providers.volcengine.model_copy(update={
        'voices': {'default': only_default},
    })
    cfg = cfg.model_copy(update={
        'providers': cfg.providers.model_copy(update={'volcengine': volc}),
    })
    primary = FakeProvider('volcengine')
    fallback = FakeProvider('baidu')
    service = TtsService(cfg, providers={
        'volcengine': primary,
        'baidu': fallback,
    })
    try:
        result = await service.ensure_fixed_line_audio('deepseek', 'zimo')
        assert result is not None
        assert result.voice_key == 'default'
        assert primary.calls == 1
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_disk_cache_round_trip_and_cleanup(tmp_path):
    cache = TtsDiskCache(tmp_path / 'cache', 16 * 1024 * 1024, 1)
    key = 'c' * 64
    item = await cache.put(
        key, b'ID3-old', provider='volcengine', voice_id='speaker',
        style='稳健', text_hash='d' * 64)
    loaded = await cache.get(key)
    assert loaded is not None and loaded.path.read_bytes() == b'ID3-old'
    old = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    with cache._connect() as conn:
        conn.execute('UPDATE tts_cache SET last_accessed_at=? WHERE cache_key=?', (old, key))
    result = await cache.cleanup()
    assert result['removed'] == 1
    assert not item.path.exists()
    assert cache.path_for_key('../secret') is None
