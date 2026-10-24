"""TTS provider 的最小公共协议与安全错误类型。"""

from __future__ import annotations

from typing import Any, Protocol


class TtsProviderError(RuntimeError):
    def __init__(self, kind: str, message: str, *, cooldown: bool = True):
        super().__init__(message)
        self.kind = kind
        self.cooldown = cooldown


class TtsProvider(Protocol):
    provider_id: str
    cache_version: int

    @property
    def available(self) -> bool: ...

    @property
    def timeout_s(self) -> float: ...

    def profile_for(self, style: str, voice_key: str) -> Any: ...

    def cache_identity(self, profile: Any) -> dict[str, object]: ...

    def profile_id(self, profile: Any) -> str: ...

    async def synthesize(self, text: str, profile: Any) -> bytes: ...

    async def close(self) -> None: ...
