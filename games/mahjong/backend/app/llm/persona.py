"""LLM 玩家形象 —— 供应商文件夹 / 默认昵称 / 策略头像（对齐前端 persona.ts）。

联机空位携带每座配置（baseUrl/apiKey/model/style/nickname）时，由服务端按
供应商 Base URL 推导英文文件夹名与默认昵称（DeepSeek=大肥鱼），并按策略
输出头像路径与显示名「昵称（策略）」，与前端单机人机展示规则一致。
素材：img/llm/<folder>/llm-avatar-<策略>.png（裁剪产物）。
"""

import re
from typing import Optional

from app.llm.reasoning import infer_provider_type

_STYLE_FILES = {
    '激进': 'llm-avatar-jijin.png',
    '稳健': 'llm-avatar-wenjian.png',
    '话痨': 'llm-avatar-huayao.png',
    '高冷': 'llm-avatar-gaoleng.png',
}

# (Base URL 匹配, 英文文件夹名, 默认昵称)；与前端 persona.ts PROVIDER_PROFILES 对齐
_PROFILES = [
    (re.compile(r'api\.deepseek\.com', re.I), 'deepseek', '大肥鱼'),
    (re.compile(r'api\.moonshot\.cn', re.I), 'kimi', 'Kimi'),
    (re.compile(r'dashscope\.aliyuncs\.com', re.I), 'qwen', '千问'),
    (re.compile(r'volces\.com|ark\.cn-beijing', re.I), 'doubao', '豆包'),
    (re.compile(r'api\.minimax\.chat', re.I), 'minimax', 'MiniMax'),
    (re.compile(r'api\.openai\.com', re.I), 'gpt', 'GPT'),
    (re.compile(r'open\.bigmodel\.cn', re.I), 'glm', '智谱'),
    (re.compile(r'api\.anthropic\.com', re.I), 'claude', 'Claude'),
]

_ID_PROFILES = {
    'deepseek': ('deepseek', '大肥鱼'),
    'kimi': ('kimi', 'Kimi'),
    'moonshot': ('kimi', 'Kimi'),
    'qwen': ('qwen', '千问'),
    'doubao': ('doubao', '豆包'),
    'minimax': ('minimax', 'MiniMax'),
    'gpt': ('gpt', 'GPT'),
    'openai': ('gpt', 'GPT'),
    'glm': ('glm', '智谱'),
    'claude': ('claude', 'Claude'),
    'anthropic': ('claude', 'Claude'),
}


def _profile_from_id(provider_id: str) -> tuple[str, str] | None:
    """代理 Base URL 无法识别时，从 provider id 的安全 token 推导形象。"""
    tokens = [item for item in re.split(r'[^a-z0-9]+', (provider_id or '').lower()) if item]
    for token in reversed(tokens):
        if token in _ID_PROFILES:
            return _ID_PROFILES[token]
    return None


def provider_folder(base_url: str, avatar_folder: str = '', provider_id: str = '',
                    model: str = '', provider_type: str = '') -> str:
    """供应商头像文件夹：显式配置 > 官方 URL > 模型/类型 > provider id > custom。"""
    override = (avatar_folder or '').strip().lower()
    if override and re.fullmatch(r'[a-z0-9_-]+', override):
        return override
    for pattern, folder, _ in _PROFILES:
        if pattern.search(base_url or ''):
            return folder
    effective_type = provider_type if provider_type and provider_type != 'custom' else \
        infer_provider_type(base_url, model, provider_id)
    if effective_type == 'openai':
        return 'gpt'
    if effective_type in _ID_PROFILES:
        return _ID_PROFILES[effective_type][0]
    inferred = _profile_from_id(provider_id)
    if inferred:
        return inferred[0]
    return 'custom'


def default_nickname(base_url: str, fallback: str = 'AI玩家', provider_id: str = '') -> str:
    """供应商默认昵称；未知供应商回退 fallback。"""
    for pattern, _, nickname in _PROFILES:
        if pattern.search(base_url or ''):
            return nickname
    inferred = _profile_from_id(provider_id)
    if inferred:
        return inferred[1]
    return fallback or 'AI玩家'


def style_file(style: Optional[str]) -> str:
    """策略 → 头像文件名（未知策略回退稳健），对齐前端 STYLE_AVATARS。"""
    return _STYLE_FILES.get(style or '稳健', _STYLE_FILES['稳健'])


def avatar_url(base_url: str, style: Optional[str], avatar_folder: str = '',
               provider_id: str = '') -> str:
    """头像相对 URL（前端以 BASE_URL 解析）：img/llm/<folder>/<策略文件>。"""
    return f'img/llm/{provider_folder(base_url, avatar_folder, provider_id)}/{style_file(style)}'


def display_name(nickname: str, style: Optional[str]) -> str:
    """对局显示名：昵称（策略），如「大肥鱼（激进）」。"""
    return f'{nickname}（{style or "稳健"}）'
