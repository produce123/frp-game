"""服务端 LLM 配置 —— 环境变量（§9.2/§9.7 服务端多提供商）。

- 旧全局配置：LLM_ENABLED + LLM_API_BASE/KEY/MODEL/STYLE...（id=default 的单提供商，
  仅当未使用 LLM_PROVIDER_* 时作为兜底注册）
- 多提供商：LLM_PROVIDER_<ID>_{BASE_URL,API_KEY,MODEL,TYPE,STYLE,NICKNAME,TIMEOUT_MS,TIMEOUT_ENABLED,NAME,AVATAR_FOLDER}
  （ID 字母/数字/下划线，如 LLM_PROVIDER_DEEPSEEK_BASE_URL）——Key 全部在服务端，
  客户端只拿 id；建房/开局引用 providerId。
"""

import asyncio
import os
import re
from typing import Optional

from app.llm.reasoning import PROVIDER_TYPES, infer_provider_type, resolve_reasoning_policy

ENABLED_KEY = 'LLM_ENABLED'
BASE_URL_KEY = 'LLM_API_BASE'
API_KEY_KEY = 'LLM_API_KEY'
MODEL_KEY = 'LLM_MODEL'
TIMEOUT_S_KEY = 'LLM_TIMEOUT_S'
TIMEOUT_ENABLED_KEY = 'LLM_TIMEOUT_ENABLED'
POOL_TIMEOUT_S_KEY = 'LLM_POOL_TIMEOUT_S'
STYLE_KEY = 'LLM_STYLE'
CONCURRENCY_KEY = 'LLM_CONCURRENCY'
MAX_PER_ROOM_KEY = 'LLM_MAX_REQUESTS_PER_ROOM'

PROVIDER_PREFIX = 'LLM_PROVIDER_'
LLM_DECISION_TIMEOUT_S = 40.0


def is_qwen_thinking_model(base_url: str, model: str) -> bool:
    """百炼 Qwen 3.5–3.8 默认开启混合思考，麻将决策应使用非思考模式。"""
    result = resolve_reasoning_policy('', base_url, model)
    return result.provider_type == 'qwen' and result.mode == 'explicit-off'


class LlmServerConfig:
    def __init__(self,
                 enabled: bool = False,
                 base_url: str = '',
                 api_key: str = '',
                 model: str = '',
                 style: str = '稳健',
                 timeout_s: float = LLM_DECISION_TIMEOUT_S,
                 timeout_enabled: bool = True,
                 pool_timeout_s: float = 1.0,
                 concurrency: int = 4,
                 max_requests_per_room: int = 0,
                 provider_id: str = '',
                 provider_type: str = '',
                 ):
        self.enabled = enabled
        self.base_url = base_url
        self.api_key = api_key
        self.model = model
        self.style = style if style in ('激进', '稳健', '话痨', '高冷') else '稳健'
        self.timeout_s = timeout_s
        self.timeout_enabled = (timeout_enabled.strip().lower() != 'false') \
            if isinstance(timeout_enabled, str) else timeout_enabled
        self.pool_timeout_s = pool_timeout_s
        self.concurrency = concurrency
        self.max_requests_per_room = max_requests_per_room
        self.provider_id = provider_id
        self.provider_type = provider_type if provider_type in PROVIDER_TYPES else \
            infer_provider_type(base_url, model, provider_id)


LLM_STYLES = ('激进', '稳健', '话痨', '高冷')
_PROVIDER_SUFFIXES = (
    ('BASE_URL', 'base_url'), ('API_KEY', 'api_key'), ('MODEL', 'model'),
    ('STYLE', 'style'), ('NICKNAME', 'nickname'), ('TIMEOUT_MS', 'timeout_ms'),
    ('TIMEOUT_ENABLED', 'timeout_enabled'),
    ('AVATAR_FOLDER', 'avatar_folder'), ('NAME', 'name'), ('TYPE', 'provider_type'),
)


class LlmProvider:
    """服务端注册的提供商：Key 全部在服务端；客户端只使用 provider id。"""

    def __init__(self, provider_id: str, name: str = '', base_url: str = '',
                 api_key: str = '', model: str = '', style: str = '稳健',
                 nickname: str = '', timeout_ms: Optional[float] = None,
                 timeout_enabled: Optional[bool] = None,
                 avatar_folder: str = '', provider_type: str = ''):
        self.provider_id = provider_id
        self.name = name.strip() or provider_id
        self.base_url = base_url.strip()
        self.api_key = api_key.strip()
        self.model = model.strip()
        self.style = style if style in LLM_STYLES else '稳健'
        self.nickname = nickname.strip()
        self.timeout_ms = timeout_ms
        self.timeout_enabled = (timeout_enabled.strip().lower() != 'false') \
            if isinstance(timeout_enabled, str) else timeout_enabled
        self.avatar_folder = avatar_folder.strip()
        self.provider_type = provider_type if provider_type in PROVIDER_TYPES else \
            infer_provider_type(self.base_url, self.model, self.provider_id)

    def to_config(self, style_override: Optional[str] = None) -> LlmServerConfig:
        """转单次调用配置；座位可覆盖策略，模型/Key 仍来自服务端注册表。"""
        global_cfg = load_llm_config()
        timeout_s = global_cfg.timeout_s
        if self.timeout_ms:
            try:
                timeout_s = float(self.timeout_ms) / 1000.0
            except (TypeError, ValueError):
                timeout_s = global_cfg.timeout_s
        return LlmServerConfig(
            enabled=True,
            base_url=self.base_url,
            api_key=self.api_key,
            model=self.model,
            style=style_override if style_override in LLM_STYLES else self.style,
            timeout_s=max(0.5, min(timeout_s, 120.0)),
            timeout_enabled=global_cfg.timeout_enabled
            if self.timeout_enabled is None else self.timeout_enabled,
            pool_timeout_s=global_cfg.pool_timeout_s,
            concurrency=global_cfg.concurrency,
            max_requests_per_room=global_cfg.max_requests_per_room,
            provider_id=self.provider_id,
            provider_type=self.provider_type,
        )


def load_llm_config() -> LlmServerConfig:
    """从环境变量读取（每次调用重新读，部署后可热改；值很小无性能顾虑）。"""
    return LlmServerConfig(
        enabled=os.environ.get(ENABLED_KEY, 'false').strip().lower() == 'true',
        base_url=os.environ.get(BASE_URL_KEY, '').strip(),
        api_key=os.environ.get(API_KEY_KEY, '').strip(),
        model=os.environ.get(MODEL_KEY, '').strip(),
        style=os.environ.get(STYLE_KEY, '稳健').strip(),
        timeout_s=float(os.environ.get(TIMEOUT_S_KEY, '40')),
        timeout_enabled=os.environ.get(TIMEOUT_ENABLED_KEY, 'true').strip().lower() != 'false',
        pool_timeout_s=float(os.environ.get(POOL_TIMEOUT_S_KEY, '1')),
        concurrency=max(1, int(os.environ.get(CONCURRENCY_KEY, '4'))),
        max_requests_per_room=max(0, int(os.environ.get(MAX_PER_ROOM_KEY, '0'))),
    )


def _provider_env_entries() -> dict[str, dict]:
    """解析 LLM_PROVIDER_<ID>_<SUFFIX> 环境变量 → {id(小写): {字段: 值}}。"""
    entries: dict[str, dict] = {}
    for key, value in os.environ.items():
        if not key.startswith(PROVIDER_PREFIX):
            continue
        rest = key[len(PROVIDER_PREFIX):]
        for suffix, field in _PROVIDER_SUFFIXES:
            if rest.endswith('_' + suffix):
                provider_id = rest[:-(len(suffix) + 1)].lower()
                if provider_id:
                    entries.setdefault(provider_id, {})[field] = value
                break
    return entries


def load_llm_providers() -> dict[str, LlmProvider]:
    """服务端提供商注册表 {id: LlmProvider}；非法条目跳过。

    未配置 LLM_PROVIDER_* 时，旧全局配置（LLM_API_BASE/KEY/MODEL）作为
    id=default 的单提供商兜底注册（兼容既有部署）。
    """
    entries = _provider_env_entries()
    if not entries:
        legacy = load_llm_config()
        if legacy.enabled and legacy.base_url and legacy.api_key and legacy.model:
            return {'default': LlmProvider('default', '服务器默认', legacy.base_url,
                                           legacy.api_key, legacy.model, legacy.style)}
        return {}
    providers: dict[str, LlmProvider] = {}
    for provider_id, entry in entries.items():
        base_url = (entry.get('base_url') or '').strip()
        api_key = (entry.get('api_key') or '').strip()
        model = (entry.get('model') or '').strip()
        if not (base_url and api_key and model):
            continue
        timeout_ms = None
        if entry.get('timeout_ms'):
            try:
                timeout_ms = float(entry['timeout_ms'])
            except (TypeError, ValueError):
                timeout_ms = None
        providers[provider_id] = LlmProvider(
            provider_id=provider_id,
            name=(entry.get('name') or '').strip() or provider_id,
            base_url=base_url,
            api_key=api_key,
            model=model,
            style=(entry.get('style') or '稳健').strip(),
            nickname=(entry.get('nickname') or '').strip(),
            timeout_ms=timeout_ms,
            timeout_enabled=entry.get('timeout_enabled'),
            avatar_folder=(entry.get('avatar_folder') or '').strip(),
            provider_type=(entry.get('provider_type') or '').strip().lower(),
        )
    return providers


def default_provider_id() -> Optional[str]:
    """服务端默认提供商：显式 id=default 优先，否则注册表第一个。"""
    providers = load_llm_providers()
    if 'default' in providers:
        return 'default'
    return next(iter(providers), None)


def llm_server_available(cfg: Optional[LlmServerConfig] = None) -> bool:
    """服务端 LLM 能力：注册表非空（§9.3 llmAvailable）。"""
    return bool(load_llm_providers())


# 并发信号量（单进程语义，§9.6）；懒创建共享实例。
_semaphore: Optional[asyncio.Semaphore] = None


def llm_semaphore() -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(load_llm_config().concurrency)
    return _semaphore
