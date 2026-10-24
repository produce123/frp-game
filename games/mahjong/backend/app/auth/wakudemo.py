"""WakuDemo OAuth 2.0 Authorization Code + PKCE 服务端实现。"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import math
import os
import re
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx
from dotenv import load_dotenv
from loguru import logger


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {'1', 'true', 'yes', 'on'}:
        return True
    if normalized in {'0', 'false', 'no', 'off'}:
        return False
    return default


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return -1.0


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return -1


def _is_loopback_host(hostname: str) -> bool:
    if hostname == 'localhost' or hostname.endswith('.localhost'):
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _valid_http_url(value: str, *, base_url: bool = False,
                    allow_fragment: bool = False) -> bool:
    """仅接受无 userinfo 的 HTTPS URL；HTTP 只允许本机联调。"""
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return False
    try:
        parts = urlsplit(value)
        hostname = (parts.hostname or '').lower()
        # 访问 port 属性会校验非法端口（例如 :abc 或超出 65535）。
        _ = parts.port
    except ValueError:
        return False
    if parts.scheme not in {'http', 'https'} or not parts.netloc or not hostname:
        return False
    if parts.username is not None or parts.password is not None:
        return False
    if any(ord(ch) > 127 for ch in hostname):
        return False
    if parts.scheme == 'http' and not _is_loopback_host(hostname):
        return False
    if not allow_fragment and parts.fragment:
        return False
    if base_url and (parts.path not in {'', '/'} or parts.query or parts.fragment):
        return False
    return True


def _normalized_origin(value: str, *, allow_fragment: bool = False) -> str | None:
    if not _valid_http_url(value, allow_fragment=allow_fragment):
        return None
    parts = urlsplit(value)
    hostname = (parts.hostname or '').lower()
    host = f'[{hostname}]' if ':' in hostname else hostname
    port = parts.port
    if port is not None and not (
            (parts.scheme == 'https' and port == 443)
            or (parts.scheme == 'http' and port == 80)):
        host = f'{host}:{port}'
    return f'{parts.scheme}://{host}'


@dataclass(frozen=True)
class WakuDemoOAuthConfig:
    client_id: str
    base_url: str
    redirect_uri: str
    frontend_url: str
    scope: str = 'account.read'
    request_timeout_seconds: float = 10.0
    pending_ttl_seconds: int = 600
    fallback_token_ttl_seconds: int = 3600
    max_session_ttl_seconds: int = 86400
    max_pending_authorizations: int = 1024
    login_rate_limit_per_minute: int = 30
    cookie_name: str = 'lgm_wakudemo_session'
    transaction_cookie_name: str = 'lgm_wakudemo_oauth_tx'
    cookie_secure: bool = True
    cookie_samesite: str = 'none'
    # 仅本地开发联调：无真实会话时按客户端 playerId 推导测试身份，绕过 OAuth。
    # 生产环境严禁开启（联机鉴权会完全失效）。
    login_bypass: bool = False

    @classmethod
    def from_env(cls) -> 'WakuDemoOAuthConfig':
        # auth 模块可独立复用，不依赖 storage 模块的导入副作用来加载 backend/.env。
        load_dotenv(Path(__file__).resolve().parents[2] / '.env', override=False)
        return cls(
            client_id=os.getenv('WAKUDEMO_CLIENT_ID', '').strip(),
            base_url=os.getenv('WAKUDEMO_BASE_URL', '').strip().rstrip('/'),
            redirect_uri=os.getenv('WAKUDEMO_REDIRECT_URI', '').strip(),
            frontend_url=os.getenv('WAKUDEMO_FRONTEND_URL', '').strip(),
            scope=os.getenv('WAKUDEMO_SCOPE', 'account.read').strip(),
            request_timeout_seconds=_env_float('WAKUDEMO_TIMEOUT_SECONDS', 10.0),
            pending_ttl_seconds=_env_int('WAKUDEMO_PENDING_TTL_SECONDS', 600),
            fallback_token_ttl_seconds=_env_int('WAKUDEMO_TOKEN_TTL_SECONDS', 3600),
            max_session_ttl_seconds=_env_int(
                'WAKUDEMO_MAX_SESSION_TTL_SECONDS', 86400),
            max_pending_authorizations=_env_int('WAKUDEMO_MAX_PENDING', 1024),
            login_rate_limit_per_minute=_env_int(
                'WAKUDEMO_LOGIN_RATE_LIMIT_PER_MINUTE', 30),
            cookie_name=os.getenv('WAKUDEMO_COOKIE_NAME', 'lgm_wakudemo_session').strip(),
            transaction_cookie_name=os.getenv(
                'WAKUDEMO_TRANSACTION_COOKIE_NAME', 'lgm_wakudemo_oauth_tx').strip(),
            cookie_secure=_env_bool('WAKUDEMO_COOKIE_SECURE', True),
            cookie_samesite=os.getenv('WAKUDEMO_COOKIE_SAMESITE', 'none').strip().lower(),
            login_bypass=_env_bool('WAKUDEMO_LOGIN_BYPASS', False),
        )

    @property
    def configured(self) -> bool:
        if not (self.client_id and self.base_url and self.redirect_uri and self.frontend_url):
            return False
        if '<' in self.client_id or '>' in self.client_id or self.scope != 'account.read':
            return False
        if not _valid_http_url(self.base_url, base_url=True):
            return False
        if not _valid_http_url(self.redirect_uri):
            return False
        if not _valid_http_url(self.frontend_url, allow_fragment=True):
            return False
        if not math.isfinite(self.request_timeout_seconds) \
                or self.request_timeout_seconds <= 0 or self.pending_ttl_seconds <= 0:
            return False
        if self.fallback_token_ttl_seconds <= 0 or self.max_session_ttl_seconds <= 0:
            return False
        if self.max_pending_authorizations <= 0 or self.login_rate_limit_per_minute < 0:
            return False
        redirect_host = (urlsplit(self.redirect_uri).hostname or '').lower()
        frontend_host = (urlsplit(self.frontend_url).hostname or '').lower()
        if not self.cookie_secure and not (
                _is_loopback_host(redirect_host) and _is_loopback_host(frontend_host)):
            return False
        return self.cookie_settings_valid

    @property
    def cookie_settings_valid(self) -> bool:
        if self.cookie_samesite not in {'lax', 'strict', 'none'}:
            return False
        if self.cookie_samesite == 'none' and not self.cookie_secure:
            return False
        cookie_name_pattern = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
        if not cookie_name_pattern.fullmatch(self.cookie_name):
            return False
        if not cookie_name_pattern.fullmatch(self.transaction_cookie_name):
            return False
        return self.cookie_name != self.transaction_cookie_name

    @property
    def browser_origins(self) -> frozenset[str]:
        origins = (
            _normalized_origin(self.frontend_url, allow_fragment=True),
            _normalized_origin(self.redirect_uri),
        )
        return frozenset(origin for origin in origins if origin is not None)

    @property
    def frontend_origin(self) -> str | None:
        return _normalized_origin(self.frontend_url, allow_fragment=True)

    @property
    def authorize_url(self) -> str:
        return f'{self.base_url}/oauth/authorize'

    @property
    def token_url(self) -> str:
        return f'{self.base_url}/api/v1/integrations/wakudemo/auth/token'

    @property
    def account_url(self) -> str:
        return f'{self.base_url}/api/v1/integrations/wakudemo/auth/account'


@dataclass
class PendingAuthorization:
    state: str = field(repr=False)
    code_verifier: str = field(repr=False)
    expires_at: float


@dataclass
class AuthenticatedSession:
    access_token: str = field(repr=False)
    account: dict[str, Any]
    expires_at: float


class WakuDemoOAuthError(Exception):
    def __init__(self, code: str, status_code: int = 400):
        super().__init__(code)
        self.code = code
        self.status_code = status_code


def generate_code_verifier() -> str:
    """生成 RFC 7636 允许字符集内、长度 43-128 的高熵 verifier。"""
    return secrets.token_urlsafe(64)[:96]


def create_s256_challenge(code_verifier: str) -> str:
    digest = hashlib.sha256(code_verifier.encode('ascii')).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b'=').decode('ascii')


_STANDARD_OAUTH_ERRORS = frozenset({
    'invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client',
    'unsupported_grant_type', 'invalid_scope', 'temporarily_unavailable', 'server_error',
})


def _safe_oauth_error(response: httpx.Response) -> str:
    """只提取可安全写日志的标准错误码，绝不记录第三方响应原文。"""
    try:
        payload = response.json()
    except ValueError:
        return 'unknown'
    value = payload.get('error') if isinstance(payload, dict) else None
    return value if value in _STANDARD_OAUTH_ERRORS else 'unknown'


class WakuDemoOAuthService:
    """服务端 OAuth 会话仓库。

    access token 只存在服务端内存，浏览器 Cookie 仅保存不可推导的随机 ID。
    OAuth 临时事务与登录会话使用不同 Cookie，失败回调不会注销已有登录。
    多 worker 部署时应将事务/防重放/会话状态替换为共享 Redis 存储。
    """

    def __init__(self, config: WakuDemoOAuthConfig, client: httpx.AsyncClient | None = None):
        self.config = config
        self._client = client
        self._pending: dict[str, PendingAuthorization] = {}
        self._sessions: dict[str, AuthenticatedSession] = {}
        self._used_codes: dict[str, float] = {}
        self._login_attempts: dict[str, deque[float]] = {}
        self._lock = threading.RLock()

    def ensure_configured(self) -> None:
        if not self.config.configured:
            raise WakuDemoOAuthError('oauth_not_configured', 503)

    def _cleanup(self, now: float) -> None:
        self._pending = {key: item for key, item in self._pending.items() if item.expires_at > now}
        self._sessions = {key: item for key, item in self._sessions.items() if item.expires_at > now}
        self._used_codes = {key: expiry for key, expiry in self._used_codes.items() if expiry > now}
        cutoff = now - 60.0
        for client_key, attempts in list(self._login_attempts.items()):
            while attempts and attempts[0] <= cutoff:
                attempts.popleft()
            if not attempts:
                self._login_attempts.pop(client_key, None)

    def _check_login_rate_limit(self, client_key: str | None, now: float) -> None:
        if not client_key or self.config.login_rate_limit_per_minute == 0:
            return
        attempts = self._login_attempts.setdefault(client_key, deque())
        if len(attempts) >= self.config.login_rate_limit_per_minute:
            raise WakuDemoOAuthError('oauth_rate_limited', 429)
        attempts.append(now)

    def begin(self, old_transaction_id: str | None = None,
              client_key: str | None = None) -> tuple[str, str]:
        self.ensure_configured()
        now = time.time()
        transaction_id = secrets.token_urlsafe(32)
        state = secrets.token_urlsafe(32)
        verifier = generate_code_verifier()
        with self._lock:
            self._cleanup(now)
            self._check_login_rate_limit(client_key, now)
            # 同一浏览器重新发起授权时只作废旧事务，不影响现有登录会话。
            self._pending.pop(old_transaction_id or '', None)
            if len(self._pending) >= self.config.max_pending_authorizations:
                raise WakuDemoOAuthError('oauth_temporarily_unavailable', 503)
            self._pending[transaction_id] = PendingAuthorization(
                state=state,
                code_verifier=verifier,
                expires_at=now + self.config.pending_ttl_seconds,
            )
        query = urlencode({
            'client_id': self.config.client_id,
            'redirect_uri': self.config.redirect_uri,
            'response_type': 'code',
            'scope': self.config.scope,
            'state': state,
            'code_challenge': create_s256_challenge(verifier),
            'code_challenge_method': 'S256',
        })
        return f'{self.config.authorize_url}?{query}', transaction_id

    def consume_pending(self, transaction_id: str | None, state: str | None,
                        code: str | None) -> PendingAuthorization:
        now = time.time()
        code_hash = hashlib.sha256((code or '').encode()).hexdigest()
        with self._lock:
            self._cleanup(now)
            pending = self._pending.get(transaction_id or '')
            if pending is None:
                if code and code_hash in self._used_codes:
                    raise WakuDemoOAuthError('authorization_code_already_used')
                raise WakuDemoOAuthError('authorization_request_expired')
            if not state or not re.fullmatch(r'[A-Za-z0-9_-]{43}', state) \
                    or not secrets.compare_digest(pending.state, state):
                # 不消费当前事务：旧标签页/恶意回调不能破坏较新的合法授权流程。
                raise WakuDemoOAuthError('state_mismatch')
            if code and code_hash in self._used_codes:
                self._pending.pop(transaction_id or '', None)
                raise WakuDemoOAuthError('authorization_code_already_used')
            self._pending.pop(transaction_id or '', None)
            if code:
                self._used_codes[code_hash] = now + self.config.pending_ttl_seconds
            return pending

    def delete_pending(self, transaction_id: str | None) -> None:
        with self._lock:
            self._pending.pop(transaction_id or '', None)

    async def exchange_code(self, code: str, verifier: str) -> tuple[str, int, dict[str, Any]]:
        timeout = httpx.Timeout(self.config.request_timeout_seconds)
        owns_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=timeout, trust_env=False)
        try:
            try:
                token_response = await client.post(self.config.token_url, data={
                    'grant_type': 'authorization_code',
                    'code': code,
                    'client_id': self.config.client_id,
                    'redirect_uri': self.config.redirect_uri,
                    'code_verifier': verifier,
                }, timeout=timeout, follow_redirects=False)
            except httpx.TimeoutException as exc:
                raise WakuDemoOAuthError('token_endpoint_timeout', 504) from exc
            except httpx.HTTPError as exc:
                raise WakuDemoOAuthError('token_endpoint_unavailable', 502) from exc

            if token_response.status_code != 200:
                provider_error = _safe_oauth_error(token_response)
                logger.warning(
                    'WakuDemo token 端点拒绝: status={} error={}',
                    token_response.status_code, provider_error)
                if token_response.status_code == 429:
                    raise WakuDemoOAuthError('token_endpoint_rate_limited', 503)
                if token_response.status_code >= 500 \
                        or provider_error in {'temporarily_unavailable', 'server_error'}:
                    raise WakuDemoOAuthError('token_endpoint_unavailable', 502)
                if provider_error == 'invalid_client':
                    raise WakuDemoOAuthError('oauth_client_rejected', 502)
                if token_response.status_code == 401:
                    # 实测平台用 401 表示授权码无效/过期（400 才表示 client 无效）
                    raise WakuDemoOAuthError(
                        'pkce_or_authorization_code_rejected', 401)
                if provider_error == 'invalid_grant':
                    raise WakuDemoOAuthError(
                        'pkce_or_authorization_code_rejected', 401)
                raise WakuDemoOAuthError('token_request_rejected', 502)
            try:
                token_body = token_response.json()
            except ValueError as exc:
                raise WakuDemoOAuthError('invalid_token_response', 502) from exc
            access_token = token_body.get('access_token') if isinstance(token_body, dict) else None
            if not isinstance(access_token, str) or not access_token or len(access_token) > 16384:
                raise WakuDemoOAuthError('missing_access_token', 502)
            token_type = token_body.get('token_type')
            if token_type is not None and (
                    not isinstance(token_type, str) or token_type.lower() != 'bearer'):
                raise WakuDemoOAuthError('unsupported_token_type', 502)
            raw_expires_in = token_body.get('expires_in')
            if raw_expires_in is None:
                expires_in = self.config.fallback_token_ttl_seconds
            else:
                try:
                    if isinstance(raw_expires_in, bool):
                        raise ValueError
                    expires_in = int(raw_expires_in)
                except (TypeError, ValueError, OverflowError) as exc:
                    raise WakuDemoOAuthError('invalid_token_response', 502) from exc
                if expires_in <= 0:
                    raise WakuDemoOAuthError('access_token_expired', 401)
            expires_in = min(expires_in, self.config.max_session_ttl_seconds)

            try:
                account_response = await client.get(
                    self.config.account_url,
                    headers={'Authorization': f'Bearer {access_token}'},
                    timeout=timeout,
                    follow_redirects=False,
                )
            except httpx.TimeoutException as exc:
                raise WakuDemoOAuthError('account_endpoint_timeout', 504) from exc
            except httpx.HTTPError as exc:
                raise WakuDemoOAuthError('account_endpoint_unavailable', 502) from exc
            if account_response.status_code in {401, 403}:
                raise WakuDemoOAuthError('access_token_rejected', 401)
            if account_response.status_code != 200:
                logger.warning(
                    'WakuDemo account 端点错误: status={}', account_response.status_code)
                if account_response.status_code == 429:
                    raise WakuDemoOAuthError('account_endpoint_rate_limited', 503)
                if account_response.status_code >= 500:
                    raise WakuDemoOAuthError('account_endpoint_unavailable', 502)
                raise WakuDemoOAuthError('account_endpoint_error', 502)
            try:
                account = account_response.json()
            except ValueError as exc:
                raise WakuDemoOAuthError('invalid_account_response', 502) from exc
            if not isinstance(account, dict):
                raise WakuDemoOAuthError('invalid_account_response', 502)
            return access_token, expires_in, account
        finally:
            if owns_client:
                await client.aclose()

    def create_session(self, access_token: str, expires_in: int,
                       account: dict[str, Any]) -> str:
        now = time.time()
        session_id = secrets.token_urlsafe(32)
        with self._lock:
            self._cleanup(now)
            self._sessions[session_id] = AuthenticatedSession(
                access_token=access_token,
                account=account,
                expires_at=now + expires_in,
            )
        return session_id

    def get_session(self, session_id: str | None) -> AuthenticatedSession | None:
        now = time.time()
        with self._lock:
            self._cleanup(now)
            return self._sessions.get(session_id or '')

    def delete_session(self, session_id: str | None) -> None:
        with self._lock:
            self._sessions.pop(session_id or '', None)


_service: WakuDemoOAuthService | None = None


def get_wakudemo_oauth_service() -> WakuDemoOAuthService:
    global _service
    if _service is None:
        _service = WakuDemoOAuthService(WakuDemoOAuthConfig.from_env())
    return _service
