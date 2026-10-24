"""LLM 牌桌发言准入：性格冷却、关键台词优先与短句压缩。"""

from __future__ import annotations

import re
import time
from typing import Callable

GLOBAL_NORMAL_COOLDOWN_S = 6.0
STYLE_NORMAL_COOLDOWN_S = {
    '话痨': 8.0,
    '激进': 12.0,
    '稳健': 16.0,
    '高冷': 24.0,
}
STYLE_NORMAL_EVERY = {
    '话痨': 2,
    '激进': 3,
    '稳健': 4,
    '高冷': 6,
}
MAX_SPEECH_CHARS = 16
BACKSTAGE_TERMS = (
    '引擎', '候选', '编号', '模型', '系统', '提示词', '基线', '默认建议', '默认参考',
    '人工智能', '程序', '算法', '规则摘要', 'choice', 'message', 'json',
)
INTERNAL_MARKER_PATTERN = re.compile(r'(?:^|[^A-Za-z])AI(?:$|[^A-Za-z])|[A-Z]\d+', re.I)


class LlmSpeechPolicy:
    def __init__(self, now: Callable[[], float] = time.monotonic):
        self._now = now
        self.reset()

    def reset(self) -> None:
        self._last_global = float('-inf')
        self._last_seat: dict[int, float] = {}
        self._normal_attempts: dict[int, int] = {}

    def admit(self, seat: int, style: str, priority: str = 'normal',
              mandatory: bool = False) -> bool:
        current = self._now()
        if mandatory:
            return True
        if priority == 'important':
            self._last_global = current
            self._last_seat[seat] = current
            return True
        seat_cooldown = STYLE_NORMAL_COOLDOWN_S.get(style, STYLE_NORMAL_COOLDOWN_S['稳健'])
        if current - self._last_global < GLOBAL_NORMAL_COOLDOWN_S:
            return False
        if current - self._last_seat.get(seat, float('-inf')) < seat_cooldown:
            return False
        attempt = self._normal_attempts.get(seat, 0) + 1
        self._normal_attempts[seat] = attempt
        every = STYLE_NORMAL_EVERY.get(style, STYLE_NORMAL_EVERY['稳健'])
        if (attempt - 1) % every != 0:
            return False
        self._last_global = current
        self._last_seat[seat] = current
        return True


def compact_speech_text(text: str) -> str:
    normalized = ' '.join((text or '').strip().split())
    if not normalized:
        return ''
    lowered = normalized.lower()
    if any(term.lower() in lowered for term in BACKSTAGE_TERMS) \
            or INTERNAL_MARKER_PATTERN.search(normalized):
        return ''
    endings = [normalized.find(mark) for mark in ('。', '！', '？', '!', '?')]
    endings = [index for index in endings if index >= 0]
    if endings:
        normalized = normalized[:min(endings) + 1]
    return normalized[:MAX_SPEECH_CHARS].strip()
