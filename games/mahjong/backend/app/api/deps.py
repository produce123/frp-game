"""联机接口统一登录鉴权依赖。

WakuDemo 登录后，联机身份一律由服务端从登录会话推导（uid），不再信任客户端
提交的 playerId / guestId。身份键统一为 ``wakudemo-<uid>``，避免与历史匿名
guestId 冲突；封禁、防占房、战绩与头像都绑定该键。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import unquote

from fastapi import HTTPException, Request

from app.auth.wakudemo import get_wakudemo_oauth_service

AUTH_REQUIRED = 'AUTH_REQUIRED'

# frp-game 补丁：平台 Node 进程是本机的可信网关。它把**已经登录的平台账号**写进
# 这三个头再转发过来，而且 Python 只监听 127.0.0.1（公网摸不到这个端口），
# 所以浏览器/公网请求不可能自己伪造身份。只有平台 Node 进程会带 FRP_TRUSTED_HEADERS=1。
FRP_TRUSTED_HEADERS = os.getenv('FRP_TRUSTED_HEADERS', 'False') == 'True'


@dataclass(frozen=True)
class AuthenticatedUser:
    """从 WakuDemo 会话推导出的联机玩家身份。"""

    uid: str
    display_name: Optional[str]
    avatar_url: Optional[str]

    @property
    def player_id(self) -> str:
        return f'wakudemo-{self.uid}'


def frp_trusted_identity(request: Request) -> Optional[AuthenticatedUser]:
    """平台网关注入的已登录身份（昵称是百分号编码的 UTF-8，避免 HTTP 头非 ASCII）。"""
    if not FRP_TRUSTED_HEADERS:
        return None
    uid = (request.headers.get('x-frp-user-id') or '').strip()
    if not uid:
        return None
    name = unquote(request.headers.get('x-frp-user-name') or '').strip() or None
    avatar = (request.headers.get('x-frp-user-avatar') or '').strip() or None
    return AuthenticatedUser(uid=uid, display_name=name, avatar_url=avatar or None)


async def require_wakudemo_login(request: Request) -> AuthenticatedUser:
    """联机接口鉴权：无有效登录会话 → 401 AUTH_REQUIRED。

    平台托管时身份来自本机网关的头（平台账号）；否则退回 WakuDemo OAuth 会话。
    本地开发（WAKUDEMO_LOGIN_BYPASS=true）且无真实会话时，按客户端提交的
    playerId 推导测试身份（非法/缺失时用 dev-bypass），跳过 OAuth 流程。
    """
    trusted = frp_trusted_identity(request)
    if trusted is not None:
        return trusted
    service = get_wakudemo_oauth_service()
    session = service.get_session(request.cookies.get(service.config.cookie_name))
    if session is not None:
        account: dict[str, Any] = session.account or {}
        uid = account.get('id')
        if not isinstance(uid, str) or not uid:
            raise HTTPException(status_code=401, detail={'code': AUTH_REQUIRED})
        display_name = account.get('displayName')
        avatar_url = account.get('avatarUrl')
        return AuthenticatedUser(
            uid=uid,
            display_name=display_name if isinstance(display_name, str) else None,
            avatar_url=avatar_url if isinstance(avatar_url, str) else None,
        )
    if service.config.login_bypass:
        return AuthenticatedUser(
            uid=await _bypass_uid(request),
            display_name='本地开发账号',
            avatar_url=None,
        )
    raise HTTPException(status_code=401, detail={'code': AUTH_REQUIRED})


async def _bypass_uid(request: Request) -> str:
    """开发旁路身份：优先客户端 playerId（保持多开/多身份测试体验），否则固定值。"""
    try:
        payload = await request.json()
    except Exception:
        return 'dev-bypass'
    if isinstance(payload, dict):
        candidate = payload.get('playerId')
        if isinstance(candidate, str) and candidate.strip() \
                and len(candidate) <= 64 \
                and all(ord(ch) < 128 for ch in candidate):
            return candidate.strip()
    return 'dev-bypass'
