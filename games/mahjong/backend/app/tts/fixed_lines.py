"""``llmAnime`` 固定动作/赛后文案的安全 TTS 请求解析。

本模块只接受角色 catalog 中的文案槽位，并从 catalog 取得文案、音色与稳健
风格。``purpose`` 是连接级路由元数据，不属于音频内容；缓存身份继续由标准化
文案、voice profile、稳健风格及 provider 版本决定，以便与现有 TTS 缓存复用。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast

from app.game.anime_characters import (
    ANIME_ACTION_LINE_KEYS,
    ANIME_VOICE_LINE_KEYS,
    AnimeVoiceLineKey,
    CharacterId,
    anime_character_profile,
)
from app.tts.config import normalize_voice_key


FixedLinePurpose = Literal['action', 'round-reaction']

# 显式动作键集合（不再按 ANIME_VOICE_LINE_KEYS 的位置切片：加变体键时位置会变）。
_ACTION_LINE_KEYS = frozenset(ANIME_ACTION_LINE_KEYS)


@dataclass(frozen=True, slots=True)
class FixedLineTtsRequest:
    """已从白名单解析、可安全交给缓存 TTS 的内容请求。"""

    purpose: FixedLinePurpose
    speech_source: Literal['fixed-line']
    character_id: CharacterId
    line_key: AnimeVoiceLineKey
    text: str
    style: Literal['稳健']
    voice_key: str
    fallback_voice_key: str


def resolve_fixed_line_tts_request(
    character_id: object,
    line_key: object,
) -> FixedLineTtsRequest | None:
    """解析固定文案请求；未知角色回退 DeepSeek，未知槽位拒绝。"""

    if not isinstance(line_key, str) or line_key not in ANIME_VOICE_LINE_KEYS:
        return None
    safe_line_key = cast(AnimeVoiceLineKey, line_key)
    profile = anime_character_profile(character_id)
    purpose: FixedLinePurpose = (
        'action' if safe_line_key in _ACTION_LINE_KEYS else 'round-reaction'
    )
    return FixedLineTtsRequest(
        purpose=purpose,
        speech_source='fixed-line',
        character_id=profile.id,
        line_key=safe_line_key,
        text=profile.lines[safe_line_key],
        style='稳健',
        voice_key=profile.voice_key,
        fallback_voice_key=profile.fallback_voice_key,
    )


def fixed_line_voice_candidates(
    request: FixedLineTtsRequest,
    allowed_voice_keys: object,
) -> tuple[str, ...]:
    """按主音色→替代音色→default 返回去重后的白名单候选。

    任何非法、未配置或非字符串 voice 都会被跳过，绝不透传到 provider。
    """

    if not isinstance(allowed_voice_keys, (set, frozenset, tuple, list)):
        return ()
    allowed = {
        normalized
        for value in allowed_voice_keys
        if isinstance(value, str) and (normalized := normalize_voice_key(value))
    }
    candidates: list[str] = []
    for value in (request.voice_key, request.fallback_voice_key, 'default'):
        normalized = normalize_voice_key(value)
        if normalized and normalized in allowed and normalized not in candidates:
            candidates.append(normalized)
    return tuple(candidates)
