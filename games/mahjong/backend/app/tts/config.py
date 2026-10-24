"""TTS YAML 配置、凭据文件加载与严格校验。"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal, Optional

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
    model_validator,
)
import yaml


BACKEND_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_FILE = BACKEND_ROOT / 'config' / 'tts.yml'
TTS_STYLES = ('激进', '稳健', '话痨', '高冷')
ProviderName = Literal['volcengine', 'baidu']


class TtsConfigError(RuntimeError):
    """TTS 配置文件缺失语法、结构或取值要求。"""


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', frozen=True)


class TtsRouteConfig(_StrictModel):
    primary: ProviderName = 'volcengine'
    fallback: Optional[ProviderName] = 'baidu'

    @model_validator(mode='after')
    def providers_must_differ(self):
        if self.fallback == self.primary:
            raise ValueError('route.fallback must differ from route.primary')
        return self


class TtsRuntimeConfig(_StrictModel):
    total_timeout_s: float = Field(default=7.0, ge=1.0, le=30.0)
    concurrency: int = Field(default=2, ge=1, le=8)
    negative_ttl_s: float = Field(default=30.0, ge=1.0, le=300.0)
    provider_cooldown_s: float = Field(default=60.0, ge=1.0, le=1800.0)


class TtsCacheBucketConfig(_StrictModel):
    dir: Path
    max_mb: int = Field(ge=16, le=4096)
    ttl_days: int = Field(ge=1, le=365)


class TtsCacheConfig(_StrictModel):
    room: TtsCacheBucketConfig = Field(default_factory=lambda: TtsCacheBucketConfig(
        dir=Path('data/tts-cache'), max_mb=256, ttl_days=30))
    local: TtsCacheBucketConfig = Field(default_factory=lambda: TtsCacheBucketConfig(
        dir=Path('data/local-tts-cache'), max_mb=128, ttl_days=30))


class LocalTtsConfig(_StrictModel):
    enabled: bool = True
    rate_limit_per_minute: int = Field(default=60, ge=1, le=600)
    allowed_voice_keys: tuple[str, ...] = ()

    @field_validator('allowed_voice_keys')
    @classmethod
    def validate_voice_keys(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        normalized = []
        for value in values:
            item = normalize_voice_key(value)
            if not item:
                raise ValueError(f'invalid local voice key: {value!r}')
            if item not in normalized:
                normalized.append(item)
        return tuple(normalized)


class VolcengineAudioConfig(_StrictModel):
    format: Literal['mp3'] = 'mp3'
    sample_rate: Literal[8000, 16000, 22050, 24000, 32000, 44100, 48000] = 24000
    bit_rate: int = Field(default=64000, ge=16000, le=320000)


class VolcengineVoiceConfig(_StrictModel):
    speaker: str = Field(min_length=1, max_length=120)

    @field_validator('speaker')
    @classmethod
    def validate_speaker(cls, value: str) -> str:
        item = value.strip()
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', item):
            raise ValueError('speaker contains unsupported characters')
        return item


class VolcengineStyleConfig(_StrictModel):
    speech_rate: int = Field(default=0, ge=-50, le=100)
    pitch_rate: int = Field(default=0, ge=-12, le=12)
    loudness_rate: int = Field(default=0, ge=-50, le=100)


def _default_volcengine_voices() -> dict[str, VolcengineVoiceConfig]:
    # 火山官方 V3 示例使用的 TTS 2.0 音色；部署可在 YAML 中按 voiceKey 替换。
    voice = VolcengineVoiceConfig(speaker='zh_female_vv_uranus_bigtts')
    return {
        'default': voice,
        'deepseek': voice,
        'qwen': voice,
        'kimi': voice,
        'doubao': voice,
        'gpt': voice,
        'relay_gpt': voice,
        'minimax': voice,
        'claude': voice,
        'glm': voice,
    }


def _default_volcengine_styles() -> dict[str, VolcengineStyleConfig]:
    return {
        '激进': VolcengineStyleConfig(speech_rate=15, pitch_rate=1, loudness_rate=10),
        '稳健': VolcengineStyleConfig(),
        '话痨': VolcengineStyleConfig(speech_rate=10, pitch_rate=1, loudness_rate=5),
        '高冷': VolcengineStyleConfig(speech_rate=-10, pitch_rate=-1, loudness_rate=-5),
    }


class VolcengineProviderConfig(_StrictModel):
    enabled: bool = False
    api_key: SecretStr = Field(default_factory=lambda: SecretStr(''))
    app_id: SecretStr = Field(default_factory=lambda: SecretStr(''))
    access_token: SecretStr = Field(default_factory=lambda: SecretStr(''))
    secret_key: SecretStr = Field(default_factory=lambda: SecretStr(''))
    credential_file: Optional[Path] = None
    endpoint: str = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse'
    resource_id: str = Field(default='seed-tts-2.0', min_length=1, max_length=80)
    uid: str = Field(default='lianhua-mahjong-server', min_length=1, max_length=80)
    timeout_s: float = Field(default=4.0, ge=1.0, le=20.0)
    audio: VolcengineAudioConfig = Field(default_factory=VolcengineAudioConfig)
    voices: dict[str, VolcengineVoiceConfig] = Field(default_factory=_default_volcengine_voices)
    styles: dict[str, VolcengineStyleConfig] = Field(default_factory=_default_volcengine_styles)

    @field_validator('endpoint')
    @classmethod
    def validate_endpoint(cls, value: str) -> str:
        endpoint = value.strip().rstrip('/')
        if not endpoint.startswith('https://'):
            raise ValueError('volcengine endpoint must use https')
        return endpoint

    @field_validator('resource_id')
    @classmethod
    def validate_resource_id(cls, value: str) -> str:
        item = value.strip()
        if not re.fullmatch(r'[A-Za-z0-9_.-]+', item):
            raise ValueError('invalid volcengine resource_id')
        return item

    @field_validator('voices')
    @classmethod
    def validate_voices(cls, values: dict[str, VolcengineVoiceConfig]):
        normalized: dict[str, VolcengineVoiceConfig] = {}
        for key, value in values.items():
            item = normalize_voice_key(key)
            if not item:
                raise ValueError(f'invalid volcengine voice key: {key!r}')
            normalized[item] = value
        if 'default' not in normalized:
            raise ValueError('volcengine voices must include default')
        return normalized

    @field_validator('styles')
    @classmethod
    def validate_styles(cls, values: dict[str, VolcengineStyleConfig]):
        unknown = set(values) - set(TTS_STYLES)
        if unknown:
            raise ValueError(f'unknown TTS styles: {sorted(unknown)}')
        if '稳健' not in values:
            raise ValueError('volcengine styles must include 稳健')
        return values

    @property
    def available(self) -> bool:
        return self.enabled and bool(
            self.api_key.get_secret_value()
            or (self.app_id.get_secret_value() and self.access_token.get_secret_value())
        )

    def voice_for(self, voice_key: str) -> VolcengineVoiceConfig:
        return self.voices.get(normalize_voice_key(voice_key)) or self.voices['default']

    def style_for(self, style: str) -> VolcengineStyleConfig:
        return self.styles.get(style) or self.styles['稳健']


class BaiduVoiceConfig(_StrictModel):
    voice_id: int = Field(default=0, ge=0, le=99999)
    speed: int = Field(default=5, ge=0, le=15)
    pitch: int = Field(default=5, ge=0, le=15)
    volume: int = Field(default=7, ge=0, le=15)
    emotion: Literal['', 'neutral', 'happy', 'down', 'angry', 'surprise', 'fear'] = ''


class BaiduProviderConfig(_StrictModel):
    enabled: bool = False
    api_key: SecretStr = Field(default_factory=lambda: SecretStr(''))
    secret_key: SecretStr = Field(default_factory=lambda: SecretStr(''))
    credential_file: Optional[Path] = None
    cuid: str = Field(default='lianhua-mahjong-server', min_length=1, max_length=60)
    timeout_s: float = Field(default=3.0, ge=1.0, le=20.0)
    voice: BaiduVoiceConfig = Field(default_factory=BaiduVoiceConfig)

    @property
    def available(self) -> bool:
        return self.enabled and bool(
            self.api_key.get_secret_value() and self.secret_key.get_secret_value())


class TtsProvidersConfig(_StrictModel):
    volcengine: VolcengineProviderConfig = Field(default_factory=VolcengineProviderConfig)
    baidu: BaiduProviderConfig = Field(default_factory=BaiduProviderConfig)

    def get(self, name: ProviderName):
        return self.volcengine if name == 'volcengine' else self.baidu


class TtsConfig(_StrictModel):
    version: Literal[1] = 1
    enabled: bool = False
    route: TtsRouteConfig = Field(default_factory=TtsRouteConfig)
    runtime: TtsRuntimeConfig = Field(default_factory=TtsRuntimeConfig)
    cache: TtsCacheConfig = Field(default_factory=TtsCacheConfig)
    local_gateway: LocalTtsConfig = Field(default_factory=LocalTtsConfig)
    providers: TtsProvidersConfig = Field(default_factory=TtsProvidersConfig)
    source_path: Path = Field(default=DEFAULT_CONFIG_FILE, exclude=True, repr=False)

    @property
    def available(self) -> bool:
        if not self.enabled:
            return False
        return any(self.providers.get(name).available for name in self.provider_names)

    @property
    def provider_names(self) -> tuple[ProviderName, ...]:
        names = [self.route.primary]
        if self.route.fallback is not None:
            names.append(self.route.fallback)
        return tuple(names)

    @property
    def voice_keys(self) -> frozenset[str]:
        return frozenset({'default', *self.providers.volcengine.voices})


def normalize_voice_key(value: str) -> str:
    item = str(value or '').strip().lower().replace('-', '_')
    return item if re.fullmatch(r'[a-z0-9_]{1,40}', item) else ''


def _resolve_relative(path: Optional[Path], base: Path) -> Optional[Path]:
    if path is None:
        return None
    return (path if path.is_absolute() else base / path).resolve()


def _read_credential_file(path: Optional[Path]) -> dict[str, str]:
    """读取标记式凭据文件；调用方和日志永不输出值。"""
    if path is None:
        return {}
    try:
        entries: dict[str, str] = {}
        unlabelled: list[str] = []
        for raw in path.read_text(encoding='utf-8-sig').splitlines():
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            separator = next((item for item in (':', '：', '=') if item in line), None)
            if separator is None:
                unlabelled.append(line)
                continue
            label, value = line.split(separator, 1)
            key = re.sub(r'[\s_-]+', '', label.strip().lower())
            if value.strip():
                entries[key] = value.strip()
        if unlabelled and 'apikey' not in entries:
            entries['apikey'] = unlabelled[0]
        return entries
    except OSError as exc:
        raise TtsConfigError(f'cannot read TTS credential file: {path}') from exc


def _secret(value: SecretStr, *fallbacks: str) -> SecretStr:
    current = value.get_secret_value().strip()
    if current:
        return SecretStr(current)
    return SecretStr(next((item.strip() for item in fallbacks if item and item.strip()), ''))


def _hydrate_credentials(config: TtsConfig, config_dir: Path) -> TtsConfig:
    volc = config.providers.volcengine
    volc_file = _resolve_relative(volc.credential_file, config_dir)
    volc_entries = _read_credential_file(volc_file)
    volc = volc.model_copy(update={
        'credential_file': volc_file,
        'api_key': _secret(volc.api_key, volc_entries.get('apikey', ''),
                           volc_entries.get('appkey', '')),
        'app_id': _secret(volc.app_id, volc_entries.get('appid', '')),
        'access_token': _secret(volc.access_token, volc_entries.get('accesstoken', '')),
        'secret_key': _secret(volc.secret_key, volc_entries.get('secretkey', '')),
    })

    baidu = config.providers.baidu
    baidu_file = _resolve_relative(baidu.credential_file, config_dir)
    baidu_entries = _read_credential_file(baidu_file)
    baidu = baidu.model_copy(update={
        'credential_file': baidu_file,
        'api_key': _secret(baidu.api_key, baidu_entries.get('apikey', '')),
        'secret_key': _secret(baidu.secret_key, baidu_entries.get('secretkey', '')),
    })

    providers = config.providers.model_copy(update={
        'volcengine': volc,
        'baidu': baidu,
    })
    return config.model_copy(update={'providers': providers})


def _resolve_cache_paths(config: TtsConfig) -> TtsConfig:
    room = config.cache.room.model_copy(update={
        'dir': _resolve_relative(config.cache.room.dir, BACKEND_ROOT),
    })
    local = config.cache.local.model_copy(update={
        'dir': _resolve_relative(config.cache.local.dir, BACKEND_ROOT),
    })
    return config.model_copy(update={
        'cache': config.cache.model_copy(update={'room': room, 'local': local}),
    })


def load_tts_config(config_file: Optional[Path] = None) -> TtsConfig:
    path = (config_file or DEFAULT_CONFIG_FILE).resolve()
    if not path.is_file():
        return _resolve_cache_paths(TtsConfig(source_path=path))
    try:
        raw = yaml.safe_load(path.read_text(encoding='utf-8-sig'))
    except (OSError, yaml.YAMLError) as exc:
        raise TtsConfigError(f'cannot parse TTS config: {path}') from exc
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise TtsConfigError('TTS config root must be a mapping')
    try:
        config = TtsConfig.model_validate({**raw, 'source_path': path})
    except ValueError as exc:
        raise TtsConfigError(f'invalid TTS config: {exc}') from exc
    config = _hydrate_credentials(config, path.parent)
    return _resolve_cache_paths(config)
