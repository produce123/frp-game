"""WakuDemo OAuth 登录入口、回调和服务端会话 API。"""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from loguru import logger

from app.auth.wakudemo import WakuDemoOAuthError, get_wakudemo_oauth_service

router = APIRouter(prefix='/api/login', tags=['auth'])


def _redirect_url(base: str, result: str, error: str | None = None) -> str:
    parts = urlsplit(base)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query['wakudemo_login'] = result
    if error:
        query['wakudemo_error'] = error
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _harden_auth_response(response: Response) -> Response:
    """认证响应不可缓存，也不得把 callback URL 作为 Referer 泄露。"""
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


def _auth_error_response(code: str, status_code: int) -> Response:
    return _harden_auth_response(JSONResponse(
        {'detail': {'code': code}}, status_code=status_code))


def _set_session_cookie(response: Response, session_id: str, max_age: int) -> None:
    config = get_wakudemo_oauth_service().config
    if not config.cookie_settings_valid:
        return
    response.set_cookie(
        key=config.cookie_name,
        value=session_id,
        max_age=max_age,
        path='/',
        secure=config.cookie_secure,
        httponly=True,
        samesite=config.cookie_samesite,  # type: ignore[arg-type]
    )


def _delete_session_cookie(response: Response) -> None:
    config = get_wakudemo_oauth_service().config
    if not config.cookie_settings_valid:
        return
    response.delete_cookie(
        key=config.cookie_name,
        path='/',
        secure=config.cookie_secure,
        httponly=True,
        samesite=config.cookie_samesite,  # type: ignore[arg-type]
    )


def _set_transaction_cookie(response: Response, transaction_id: str, max_age: int) -> None:
    config = get_wakudemo_oauth_service().config
    if not config.cookie_settings_valid:
        return
    response.set_cookie(
        key=config.transaction_cookie_name,
        value=transaction_id,
        max_age=max_age,
        path='/api/login',
        secure=config.cookie_secure,
        httponly=True,
        # Authorization Code 默认通过顶层 GET 回调；Lax 足够且少依赖第三方 Cookie。
        samesite='lax',
    )


def _delete_transaction_cookie(response: Response) -> None:
    config = get_wakudemo_oauth_service().config
    if not config.cookie_settings_valid:
        return
    response.delete_cookie(
        key=config.transaction_cookie_name,
        path='/api/login',
        secure=config.cookie_secure,
        httponly=True,
        samesite='lax',
    )


def _browser_origin_allowed(request: Request) -> bool:
    """浏览器跨域读会话时只信任配置中的前端和回调 origin。"""
    origin = request.headers.get('origin')
    if origin is None:
        return True
    return origin in get_wakudemo_oauth_service().config.browser_origins


def _account_summary(account: dict[str, Any]) -> dict[str, Any]:
    """兼容审核期尚未最终确认的账户字段，不向前端暴露 token。"""
    account_id = None
    for key in ('uid', 'id', 'account_id', 'user_id'):
        candidate = account.get(key)
        if isinstance(candidate, bool) or not isinstance(candidate, (str, int)):
            continue
        normalized = str(candidate).strip()
        if 0 < len(normalized) <= 128:
            account_id = normalized
            break
    display_name = None
    for key in ('displayName', 'display_name', 'nickname', 'username', 'name'):
        candidate = account.get(key)
        if isinstance(candidate, str) and candidate.strip():
            display_name = candidate.strip()[:120]
            break
    avatar_url = None
    for key in ('avatarUrl', 'avatar_url', 'avatar'):
        candidate = account.get(key)
        if isinstance(candidate, str) and candidate.strip():
            avatar_url = candidate.strip()[:2048]
            break
    return {
        'id': account_id,
        'displayName': display_name,
        'avatarUrl': avatar_url,
    }


@router.get('/wakudemo')
async def begin_wakudemo_login(request: Request):
    service = get_wakudemo_oauth_service()
    try:
        authorize_url, transaction_id = service.begin(
            request.cookies.get(service.config.transaction_cookie_name),
            request.client.host if request.client else 'unknown',
        )
    except WakuDemoOAuthError as exc:
        # 登录由整页跳转触发；只要前端地址本身有效，就把配置/容量错误带回 UI。
        if service.config.frontend_origin:
            response = RedirectResponse(
                _redirect_url(service.config.frontend_url, 'error', exc.code),
                status_code=302,
            )
            _delete_transaction_cookie(response)
            return _harden_auth_response(response)
        return _auth_error_response(exc.code, exc.status_code)
    response = RedirectResponse(authorize_url, status_code=302)
    _set_transaction_cookie(response, transaction_id, service.config.pending_ttl_seconds)
    return _harden_auth_response(response)


@router.get('/callback')
async def wakudemo_login_callback(
    request: Request,
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
):
    service = get_wakudemo_oauth_service()
    transaction_id = request.cookies.get(service.config.transaction_cookie_name)
    existing_session_id = request.cookies.get(service.config.cookie_name)
    preserve_transaction_cookie = False
    try:
        if any(len(request.query_params.getlist(name)) > 1
               for name in ('code', 'state', 'error')):
            preserve_transaction_cookie = True
            raise WakuDemoOAuthError('invalid_authorization_response')
        if (code and len(code) > 8192) or (state and len(state) > 256) \
                or (error and len(error) > 128):
            preserve_transaction_cookie = True
            raise WakuDemoOAuthError('invalid_authorization_response')
        if code and error:
            service.consume_pending(transaction_id, state, None)
            raise WakuDemoOAuthError('invalid_authorization_response')
        if error:
            # RFC 6749：授权请求带了 state，错误回调也必须原样返回并严格校验。
            service.consume_pending(transaction_id, state, None)
            error_code = ('authorization_cancelled' if error == 'access_denied'
                          else 'authorization_failed')
            raise WakuDemoOAuthError(error_code)
        pending = service.consume_pending(transaction_id, state, code)
        if not code:
            raise WakuDemoOAuthError('missing_authorization_code')
        access_token, expires_in, account = await service.exchange_code(
            code, pending.code_verifier)
        account_summary = _account_summary(account)
        if account_summary['id'] is None:
            raise WakuDemoOAuthError('invalid_account_response', 502)
        # 授权成功后轮换随机会话 ID，防止登录前会话固定。
        authenticated_session_id = service.create_session(
            access_token, expires_in, account_summary)
    except WakuDemoOAuthError as exc:
        logger.warning('WakuDemo OAuth 登录失败: {}', exc.code)
        if service.config.frontend_origin:
            response = RedirectResponse(
                _redirect_url(service.config.frontend_url, 'error', exc.code),
                status_code=302,
            )
        else:
            response = JSONResponse(
                {'detail': {'code': exc.code}}, status_code=exc.status_code)
        # state 不匹配可能来自旧标签页；保留当前较新的 OAuth 事务 Cookie。
        if exc.code != 'state_mismatch' and not preserve_transaction_cookie:
            _delete_transaction_cookie(response)
        return _harden_auth_response(response)

    service.delete_session(existing_session_id)
    response = RedirectResponse(
        _redirect_url(service.config.frontend_url, 'success'), status_code=302)
    _set_session_cookie(response, authenticated_session_id, expires_in)
    _delete_transaction_cookie(response)
    return _harden_auth_response(response)


@router.get('/session')
async def get_login_session(request: Request):
    # frp-game 补丁：托管在平台下时，登录身份由平台 Node 网关注入。
    # 页面**没有自己的登录入口**，账号就是平台首页那个账号。
    from app.api.deps import frp_trusted_identity
    trusted = frp_trusted_identity(request)
    if trusted is not None:
        return _harden_auth_response(JSONResponse({
            'authenticated': True,
            'account': {
                'id': trusted.uid,
                'displayName': trusted.display_name,
                'avatarUrl': trusted.avatar_url,
            },
        }))
    service = get_wakudemo_oauth_service()
    # 真实登录态必须校验浏览器 Origin；开发旁路模式无真实凭据，跳过该校验。
    if not service.config.login_bypass and not _browser_origin_allowed(request):
        return _auth_error_response('auth_origin_not_allowed', 403)
    session = service.get_session(request.cookies.get(service.config.cookie_name))
    if session is None:
        if service.config.login_bypass:
            # 仅本地开发：无真实会话也返回已登录，跳过 OAuth 联调。
            return _harden_auth_response(JSONResponse({
                'authenticated': True,
                'account': {'id': 'dev-bypass', 'displayName': '本地开发账号',
                            'avatarUrl': None},
            }))
        response = JSONResponse({'authenticated': False})
        if request.cookies.get(service.config.cookie_name):
            _delete_session_cookie(response)
        return _harden_auth_response(response)
    return _harden_auth_response(JSONResponse({
        'authenticated': True,
        'account': _account_summary(session.account),
    }))


@router.post('/logout')
async def logout(request: Request):
    service = get_wakudemo_oauth_service()
    content_type = request.headers.get('content-type', '').partition(';')[0].strip().lower()
    if content_type != 'application/json' or not _browser_origin_allowed(request):
        return _auth_error_response('csrf_check_failed', 403)
    service.delete_session(request.cookies.get(service.config.cookie_name))
    response = JSONResponse({'authenticated': False})
    _delete_session_cookie(response)
    return _harden_auth_response(response)
