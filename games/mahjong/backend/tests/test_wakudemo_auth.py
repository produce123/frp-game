"""WakuDemo OAuth 2.0 + PKCE 集成测试（外部接口全部 Mock）。"""

from dataclasses import replace
import re
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI
from loguru import logger

from app.api import auth as auth_api
from app.auth import wakudemo as oauth_module
from app.auth.wakudemo import (
    WakuDemoOAuthConfig,
    WakuDemoOAuthError,
    WakuDemoOAuthService,
    create_s256_challenge,
)


def config() -> WakuDemoOAuthConfig:
    return WakuDemoOAuthConfig(
        client_id='client-under-review',
        base_url='https://waku.example',
        redirect_uri='http://localhost:8000/api/login/callback',
        frontend_url='http://localhost:5173/',
        cookie_secure=False,
        cookie_samesite='lax',
    )


def test_begin_builds_s256_authorization_request():
    service = WakuDemoOAuthService(config())
    location, session_id = service.begin()
    query = parse_qs(urlsplit(location).query)

    assert urlsplit(location).path == '/oauth/authorize'
    assert query['client_id'] == ['client-under-review']
    assert query['redirect_uri'] == ['http://localhost:8000/api/login/callback']
    assert query['response_type'] == ['code']
    assert query['scope'] == ['account.read']
    assert query['code_challenge_method'] == ['S256']
    assert re.fullmatch(r'[A-Za-z0-9_-]{43}', query['state'][0])
    assert re.fullmatch(r'[A-Za-z0-9_-]{43,128}', query['code_challenge'][0])

    pending = service.consume_pending(session_id, query['state'][0], 'one-time-code')
    assert re.fullmatch(r'[A-Za-z0-9_-]{43,128}', pending.code_verifier)
    assert query['code_challenge'][0] == create_s256_challenge(pending.code_verifier)


def test_state_mismatch_and_reused_code_are_rejected():
    service = WakuDemoOAuthService(config())
    location, session_id = service.begin()
    state = parse_qs(urlsplit(location).query)['state'][0]

    with pytest.raises(WakuDemoOAuthError, match='state_mismatch'):
        service.consume_pending(session_id, 'wrong-state', 'code-a')

    # 错误 state 不得消费合法事务；正确回调仍能继续。
    service.consume_pending(session_id, state, 'code-a')
    with pytest.raises(WakuDemoOAuthError, match='authorization_code_already_used'):
        service.consume_pending(session_id, state, 'code-a')

    second_url, second_transaction_id = service.begin()
    second_state = parse_qs(urlsplit(second_url).query)['state'][0]
    with pytest.raises(WakuDemoOAuthError, match='authorization_code_already_used'):
        service.consume_pending(second_transaction_id, second_state, 'code-a')
    with pytest.raises(WakuDemoOAuthError, match='authorization_request_expired'):
        service.consume_pending(second_transaction_id, second_state, 'different-code')


def test_new_login_transaction_survives_an_old_tab_callback():
    service = WakuDemoOAuthService(config())
    first_url, first_transaction_id = service.begin()
    first_state = parse_qs(urlsplit(first_url).query)['state'][0]
    second_url, second_transaction_id = service.begin(first_transaction_id)
    second_state = parse_qs(urlsplit(second_url).query)['state'][0]

    with pytest.raises(WakuDemoOAuthError, match='state_mismatch'):
        # 浏览器只会发送最新 transaction cookie，但旧标签页携带旧 state。
        service.consume_pending(second_transaction_id, first_state, 'old-code')
    service.consume_pending(second_transaction_id, second_state, 'new-code')


def test_non_ascii_state_is_rejected_without_consuming_transaction():
    service = WakuDemoOAuthService(config())
    location, transaction_id = service.begin()
    valid_state = parse_qs(urlsplit(location).query)['state'][0]

    with pytest.raises(WakuDemoOAuthError, match='state_mismatch'):
        service.consume_pending(transaction_id, '汉字-state', 'code-a')
    service.consume_pending(transaction_id, valid_state, 'code-a')


def test_expired_authorization_and_token_session_are_removed(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(oauth_module.time, 'time', lambda: now[0])
    cfg = config()
    service = WakuDemoOAuthService(cfg)

    location, browser_session_id = service.begin()
    state = parse_qs(urlsplit(location).query)['state'][0]
    now[0] += cfg.pending_ttl_seconds + 1
    with pytest.raises(WakuDemoOAuthError, match='authorization_request_expired'):
        service.consume_pending(browser_session_id, state, 'late-code')

    session_id = service.create_session('server-token', 1, {'id': 'account-1'})
    assert service.get_session(session_id) is not None
    now[0] += 2
    assert service.get_session(session_id) is None


@pytest.mark.asyncio
async def test_token_exchange_is_form_encoded_and_account_uses_bearer():
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request):
        requests.append(request)
        if request.url.path.endswith('/token'):
            return httpx.Response(200, json={'access_token': 'server-only-token', 'expires_in': 900})
        return httpx.Response(200, json={'id': 42, 'nickname': '莲花玩家'})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    service = WakuDemoOAuthService(config(), client)
    try:
        token, expires_in, account = await service.exchange_code('auth-code', 'pkce-verifier')
    finally:
        await client.aclose()

    form = parse_qs(requests[0].content.decode())
    assert requests[0].headers['content-type'].startswith('application/x-www-form-urlencoded')
    assert form == {
        'grant_type': ['authorization_code'],
        'code': ['auth-code'],
        'client_id': ['client-under-review'],
        'redirect_uri': ['http://localhost:8000/api/login/callback'],
        'code_verifier': ['pkce-verifier'],
    }
    assert requests[1].headers['authorization'] == 'Bearer server-only-token'
    assert (token, expires_in, account['id']) == ('server-only-token', 900, 42)


@pytest.mark.asyncio
async def test_network_timeout_and_pkce_failure_are_mapped():
    async def timeout_handler(request: httpx.Request):
        raise httpx.ReadTimeout('slow', request=request)

    timeout_client = httpx.AsyncClient(transport=httpx.MockTransport(timeout_handler))
    service = WakuDemoOAuthService(config(), timeout_client)
    with pytest.raises(WakuDemoOAuthError, match='token_endpoint_timeout'):
        await service.exchange_code('code', 'verifier')
    await timeout_client.aclose()

    reject_client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(400, json={'error': 'invalid_grant'})))
    service = WakuDemoOAuthService(config(), reject_client)
    with pytest.raises(WakuDemoOAuthError, match='pkce_or_authorization_code_rejected'):
        await service.exchange_code('code', 'bad-verifier')
    await reject_client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(('status', 'payload', 'expected'), [
    (302, {}, 'token_request_rejected'),
    (400, {'error': 'invalid_request'}, 'token_request_rejected'),
    (400, {'error': 'temporarily_unavailable'}, 'token_endpoint_unavailable'),
    (401, {'error': 'invalid_client'}, 'oauth_client_rejected'),
    (401, {'message': 'Invalid or expired authorization code.'},
     'pkce_or_authorization_code_rejected'),
    (429, {'error': 'temporarily_unavailable'}, 'token_endpoint_rate_limited'),
    (503, {'error': 'server_error'}, 'token_endpoint_unavailable'),
])
async def test_token_http_failures_are_classified_without_logging_secrets(
        status, payload, expected):
    secret = 'must-never-reach-logs'
    messages: list[str] = []
    sink_id = logger.add(lambda message: messages.append(message.record['message']))
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(status, json={**payload, 'access_token': secret})))
    try:
        with pytest.raises(WakuDemoOAuthError, match=expected):
            await WakuDemoOAuthService(config(), client).exchange_code('code', 'verifier')
    finally:
        await client.aclose()
        logger.remove(sink_id)

    assert secret not in '\n'.join(messages)


@pytest.mark.asyncio
@pytest.mark.parametrize(('token_payload', 'expected'), [
    ({}, 'missing_access_token'),
    ({'access_token': 'token', 'token_type': 'MAC'}, 'unsupported_token_type'),
    ({'access_token': 'token', 'expires_in': 0}, 'access_token_expired'),
    ({'access_token': 'token', 'expires_in': 'not-a-number'}, 'invalid_token_response'),
    ({'access_token': 'token', 'expires_in': 'Infinity'}, 'invalid_token_response'),
])
async def test_invalid_token_payloads_are_rejected(token_payload, expected):
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=token_payload)))
    try:
        with pytest.raises(WakuDemoOAuthError, match=expected):
            await WakuDemoOAuthService(config(), client).exchange_code('code', 'verifier')
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_account_timeout_and_http_failures_are_classified():
    async def timeout_on_account(request: httpx.Request):
        if request.url.path.endswith('/token'):
            return httpx.Response(200, json={'access_token': 'token'})
        raise httpx.ReadTimeout('slow account', request=request)

    timeout_client = httpx.AsyncClient(transport=httpx.MockTransport(timeout_on_account))
    try:
        with pytest.raises(WakuDemoOAuthError, match='account_endpoint_timeout'):
            await WakuDemoOAuthService(config(), timeout_client).exchange_code('code', 'verifier')
    finally:
        await timeout_client.aclose()

    async def account_unavailable(request: httpx.Request):
        if request.url.path.endswith('/token'):
            return httpx.Response(200, json={'access_token': 'token'})
        return httpx.Response(503, json={'message': 'private provider detail'})

    unavailable_client = httpx.AsyncClient(
        transport=httpx.MockTransport(account_unavailable))
    try:
        with pytest.raises(WakuDemoOAuthError, match='account_endpoint_unavailable'):
            await WakuDemoOAuthService(config(), unavailable_client).exchange_code(
                'code', 'verifier')
    finally:
        await unavailable_client.aclose()

    async def account_redirect(request: httpx.Request):
        if request.url.path.endswith('/token'):
            return httpx.Response(200, json={'access_token': 'token'})
        return httpx.Response(302, headers={'Location': 'https://other.example/account'})

    redirect_client = httpx.AsyncClient(transport=httpx.MockTransport(account_redirect))
    try:
        with pytest.raises(WakuDemoOAuthError, match='account_endpoint_error'):
            await WakuDemoOAuthService(config(), redirect_client).exchange_code(
                'code', 'verifier')
    finally:
        await redirect_client.aclose()


@pytest.mark.asyncio
async def test_provider_expiry_is_bounded_by_server_session_ttl():
    async def provider(request: httpx.Request):
        if request.url.path.endswith('/token'):
            return httpx.Response(200, json={
                'access_token': 'token', 'expires_in': 999999,
            })
        return httpx.Response(200, json={'uid': 1})

    client = httpx.AsyncClient(transport=httpx.MockTransport(provider))
    try:
        service = WakuDemoOAuthService(
            replace(config(), max_session_ttl_seconds=120), client)
        _, expires_in, _ = await service.exchange_code('code', 'verifier')
    finally:
        await client.aclose()
    assert expires_in == 120


def test_pending_authorizations_are_bounded():
    service = WakuDemoOAuthService(replace(config(), max_pending_authorizations=1))
    _, transaction_id = service.begin()
    with pytest.raises(WakuDemoOAuthError, match='oauth_temporarily_unavailable'):
        service.begin()
    # 同一浏览器重新发起会先替换旧事务，因此不占用额外容量。
    service.begin(transaction_id)


def test_login_start_is_rate_limited_per_client(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(oauth_module.time, 'time', lambda: now[0])
    service = WakuDemoOAuthService(replace(config(), login_rate_limit_per_minute=1))
    service.begin(client_key='192.0.2.1')
    with pytest.raises(WakuDemoOAuthError, match='oauth_rate_limited'):
        service.begin(client_key='192.0.2.1')
    service.begin(client_key='192.0.2.2')
    now[0] += 61
    service.begin(client_key='192.0.2.1')


@pytest.mark.asyncio
async def test_start_configuration_error_returns_to_frontend(monkeypatch):
    service = WakuDemoOAuthService(replace(config(), client_id=''))
    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service', lambda: service)
    app = FastAPI()
    app.include_router(auth_api.router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://backend.test',
        follow_redirects=False,
    ) as client:
        response = await client.get('/api/login/wakudemo')
        assert response.status_code == 302
        assert response.headers['location'] == (
            'http://localhost:5173/?wakudemo_login=error&wakudemo_error=oauth_not_configured')
        assert 'no-store' in response.headers['cache-control']


@pytest.mark.asyncio
async def test_complete_callback_keeps_token_server_side(monkeypatch):
    async def provider(request: httpx.Request):
        if request.url.path.endswith('/token'):
            return httpx.Response(200, json={
                'access_token': 'never-send-to-browser',
                'token_type': 'Bearer',
                'expires_in': 600,
            })
        return httpx.Response(200, json={
            'uid': 'waku-7', 'display_name': '阿莲', 'email': 'do-not-store@example.test',
        })

    provider_client = httpx.AsyncClient(transport=httpx.MockTransport(provider))
    service = WakuDemoOAuthService(config(), provider_client)
    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service', lambda: service)
    app = FastAPI()
    app.include_router(auth_api.router)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url='http://backend.test',
        follow_redirects=False,
    ) as client:
        start = await client.get('/api/login/wakudemo')
        query = parse_qs(urlsplit(start.headers['location']).query)
        transaction_cookie = client.cookies.get(config().transaction_cookie_name)
        assert transaction_cookie
        assert client.cookies.get(config().cookie_name) is None
        assert 'no-store' in start.headers['cache-control']
        start_cookie = start.headers['set-cookie'].lower()
        assert config().transaction_cookie_name.lower() in start_cookie
        assert 'httponly' in start_cookie
        assert 'samesite=lax' in start_cookie

        callback = await client.get('/api/login/callback', params={
            'code': 'single-use',
            'state': query['state'][0],
        })
        assert callback.status_code == 302
        assert 'wakudemo_login=success' in callback.headers['location']
        authenticated_session_id = client.cookies.get(config().cookie_name)
        assert authenticated_session_id
        assert authenticated_session_id != transaction_cookie
        assert client.cookies.get(config().transaction_cookie_name) is None
        assert 'no-store' in callback.headers['cache-control']
        assert callback.headers['referrer-policy'] == 'no-referrer'
        stored = service.get_session(authenticated_session_id)
        assert stored is not None
        assert stored.account == {
            'id': 'waku-7', 'displayName': '阿莲', 'avatarUrl': None,
        }
        assert 'never-send-to-browser' not in repr(stored)
        assert 'do-not-store@example.test' not in repr(stored)

        session = await client.get('/api/login/session')
        assert session.json() == {
            'authenticated': True,
            'account': {'id': 'waku-7', 'displayName': '阿莲', 'avatarUrl': None},
        }
        assert 'never-send-to-browser' not in session.text

        repeated = await client.get('/api/login/callback', params={
            'code': 'single-use',
            'state': query['state'][0],
        })
        assert 'authorization_code_already_used' in repeated.headers['location']
        # 重放 callback 只清 OAuth 事务，不能注销当前有效登录。
        assert (await client.get('/api/login/session')).json()['authenticated'] is True

        logout = await client.post('/api/login/logout', headers={
            'Content-Type': 'application/json',
            'Origin': 'http://localhost:5173',
        })
        assert logout.json() == {'authenticated': False}
        assert 'no-store' in logout.headers['cache-control']
        assert (await client.get('/api/login/session')).json() == {'authenticated': False}

    await provider_client.aclose()


@pytest.mark.asyncio
async def test_cancelling_reauthentication_preserves_existing_login(monkeypatch):
    service = WakuDemoOAuthService(config())
    old_session_id = service.create_session(
        'old-server-token', 600,
        {'id': 'waku-old', 'displayName': '旧账号', 'avatarUrl': None},
    )
    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service', lambda: service)
    app = FastAPI()
    app.include_router(auth_api.router)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://backend.test',
        follow_redirects=False,
    ) as client:
        client.cookies.set(config().cookie_name, old_session_id)
        start = await client.get('/api/login/wakudemo')
        state = parse_qs(urlsplit(start.headers['location']).query)['state'][0]
        cancelled = await client.get('/api/login/callback', params={
            'error': 'access_denied', 'state': state,
        })
        assert 'wakudemo_error=authorization_cancelled' in cancelled.headers['location']
        assert client.cookies.get(config().cookie_name) == old_session_id
        session = await client.get('/api/login/session')
        assert session.json()['authenticated'] is True
        assert session.json()['account']['id'] == 'waku-old'


@pytest.mark.asyncio
async def test_account_without_stable_id_does_not_create_session(monkeypatch):
    async def provider(request: httpx.Request):
        if request.url.path.endswith('/token'):
            return httpx.Response(200, json={'access_token': 'server-token'})
        return httpx.Response(200, json={'displayName': '缺少 UID'})

    provider_client = httpx.AsyncClient(transport=httpx.MockTransport(provider))
    service = WakuDemoOAuthService(config(), provider_client)
    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service', lambda: service)
    app = FastAPI()
    app.include_router(auth_api.router)
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url='http://backend.test',
            follow_redirects=False,
        ) as client:
            start = await client.get('/api/login/wakudemo')
            state = parse_qs(urlsplit(start.headers['location']).query)['state'][0]
            callback = await client.get('/api/login/callback', params={
                'code': 'code-without-account-id', 'state': state,
            })
            assert 'wakudemo_error=invalid_account_response' in callback.headers['location']
            assert client.cookies.get(config().cookie_name) is None
            assert (await client.get('/api/login/session')).json() == {
                'authenticated': False,
            }
    finally:
        await provider_client.aclose()


@pytest.mark.asyncio
async def test_expired_session_cookie_is_deleted(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(oauth_module.time, 'time', lambda: now[0])
    service = WakuDemoOAuthService(config())
    session_id = service.create_session(
        'expired-token', 1,
        {'id': 'waku-1', 'displayName': None, 'avatarUrl': None},
    )
    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service', lambda: service)
    app = FastAPI()
    app.include_router(auth_api.router)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://backend.test',
    ) as client:
        client.cookies.set(
            config().cookie_name, session_id, domain='backend.test', path='/')
        now[0] += 2
        response = await client.get('/api/login/session')
        assert response.json() == {'authenticated': False}
        assert 'no-store' in response.headers['cache-control']
        assert 'max-age=0' in response.headers['set-cookie'].lower()
        assert client.cookies.get(config().cookie_name) is None


@pytest.mark.asyncio
async def test_session_origin_and_logout_csrf_are_enforced(monkeypatch):
    service = WakuDemoOAuthService(config())
    session_id = service.create_session(
        'server-token', 600,
        {'id': 'waku-1', 'displayName': None, 'avatarUrl': None},
    )
    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service', lambda: service)
    app = FastAPI()
    app.include_router(auth_api.router)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://backend.test',
    ) as client:
        client.cookies.set(config().cookie_name, session_id)
        blocked_session = await client.get('/api/login/session', headers={
            'Origin': 'https://evil.example',
        })
        assert blocked_session.status_code == 403
        assert blocked_session.headers['cache-control'] == 'no-store'
        invalid_content_type = await client.post('/api/login/logout', headers={
            'Content-Type': 'text/plain',
            'Origin': 'http://localhost:5173',
        })
        assert invalid_content_type.status_code == 403
        assert invalid_content_type.headers['cache-control'] == 'no-store'
        blocked_origin = await client.post('/api/login/logout', headers={
            'Content-Type': 'application/json',
            'Origin': 'https://evil.example',
        })
        assert blocked_origin.status_code == 403
        assert blocked_origin.headers['cache-control'] == 'no-store'
        assert service.get_session(session_id) is not None
        allowed = await client.post('/api/login/logout', headers={
            'Content-Type': 'application/json; charset=utf-8',
            'Origin': 'http://localhost:5173',
        })
        assert allowed.status_code == 200
        assert service.get_session(session_id) is None


@pytest.mark.asyncio
async def test_cancelled_authorization_is_reported(monkeypatch):
    service = WakuDemoOAuthService(config())
    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service', lambda: service)
    app = FastAPI()
    app.include_router(auth_api.router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://backend.test',
        follow_redirects=False,
    ) as client:
        start = await client.get('/api/login/wakudemo')
        state = parse_qs(urlsplit(start.headers['location']).query)['state'][0]
        response = await client.get('/api/login/callback', params={
            'error': 'access_denied', 'state': state,
        })
        assert 'wakudemo_error=authorization_cancelled' in response.headers['location']


@pytest.mark.asyncio
async def test_cancelled_authorization_without_state_is_rejected(monkeypatch):
    service = WakuDemoOAuthService(config())
    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service', lambda: service)
    app = FastAPI()
    app.include_router(auth_api.router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://backend.test',
        follow_redirects=False,
    ) as client:
        await client.get('/api/login/wakudemo')
        response = await client.get('/api/login/callback', params={'error': 'access_denied'})
        assert 'wakudemo_error=state_mismatch' in response.headers['location']
        # 缺失 state 的旧/恶意回调不能破坏仍在进行的合法事务。
        assert client.cookies.get(config().transaction_cookie_name)


@pytest.mark.asyncio
async def test_cancelled_authorization_with_wrong_state_is_rejected(monkeypatch):
    service = WakuDemoOAuthService(config())
    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service', lambda: service)
    app = FastAPI()
    app.include_router(auth_api.router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://backend.test',
        follow_redirects=False,
    ) as client:
        start = await client.get('/api/login/wakudemo')
        state = parse_qs(urlsplit(start.headers['location']).query)['state'][0]
        response = await client.get('/api/login/callback', params={
            'error': 'access_denied', 'state': 'wrong-state',
        })
        assert 'wakudemo_error=state_mismatch' in response.headers['location']
        assert client.cookies.get(config().transaction_cookie_name)
        valid_cancel = await client.get('/api/login/callback', params={
            'error': 'access_denied', 'state': state,
        })
        assert 'wakudemo_error=authorization_cancelled' in valid_cancel.headers['location']
        assert client.cookies.get(config().transaction_cookie_name) is None


@pytest.mark.asyncio
async def test_code_and_error_response_consumes_and_clears_transaction(monkeypatch):
    service = WakuDemoOAuthService(config())
    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service', lambda: service)
    app = FastAPI()
    app.include_router(auth_api.router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://backend.test',
        follow_redirects=False,
    ) as client:
        start = await client.get('/api/login/wakudemo')
        state = parse_qs(urlsplit(start.headers['location']).query)['state'][0]
        response = await client.get('/api/login/callback', params={
            'code': 'unexpected-code', 'error': 'access_denied', 'state': state,
        })
        assert 'wakudemo_error=invalid_authorization_response' in response.headers['location']
        assert client.cookies.get(config().transaction_cookie_name) is None


def test_account_summary_prefers_platform_camel_case_fields():
    summary = auth_api._account_summary(
        {'id': 'wrong-generic-id', 'uid': 10086, 'username': 'player',
         'displayName': '玩家'})
    assert summary == {'id': '10086', 'displayName': '玩家', 'avatarUrl': None}
    fallback = auth_api._account_summary({'uid': 7, 'displayName': '   ',
                                          'username': 'fallback-name'})
    assert fallback['displayName'] == 'fallback-name'


def test_configured_rejects_placeholder_and_invalid_urls():
    base = dict(client_id='c', base_url='https://waku.example',
                redirect_uri='https://game.example/callback',
                frontend_url='https://game.example/')
    assert WakuDemoOAuthConfig(**base).configured is True
    assert WakuDemoOAuthConfig(**{**base, 'client_id': ''}).configured is False
    assert WakuDemoOAuthConfig(**{**base, 'base_url': ''}).configured is False
    assert WakuDemoOAuthConfig(
        **{**base, 'base_url': 'https://请替换为-wakudemo-平台域名'}).configured is False
    assert WakuDemoOAuthConfig(**{**base, 'base_url': 'not-a-url'}).configured is False
    assert WakuDemoOAuthConfig(
        **{**base, 'base_url': 'http://waku.example'}).configured is False
    assert WakuDemoOAuthConfig(
        **{**base, 'base_url': 'https://user:pass@waku.example'}).configured is False
    assert WakuDemoOAuthConfig(
        **{**base, 'frontend_url': 'http://game.example'}).configured is False
    assert WakuDemoOAuthConfig(**{**base, 'scope': 'account.write'}).configured is False
    assert WakuDemoOAuthConfig(
        **{**base, 'transaction_cookie_name': 'lgm_wakudemo_session'}).configured is False
    assert WakuDemoOAuthConfig(
        **{**base, 'request_timeout_seconds': -1}).configured is False
    assert WakuDemoOAuthConfig(
        **{**base, 'request_timeout_seconds': float('nan')}).configured is False
    assert WakuDemoOAuthConfig(
        **{**base, 'request_timeout_seconds': float('inf')}).configured is False
    assert WakuDemoOAuthConfig(**{**base, 'cookie_secure': False,
                                  'cookie_samesite': 'lax'}).configured is False
    local = {**base,
             'redirect_uri': 'http://localhost:8000/api/login/callback',
             'frontend_url': 'http://LOCALHOST:5173/',
             'cookie_secure': False, 'cookie_samesite': 'lax'}
    local_config = WakuDemoOAuthConfig(**local)
    assert local_config.configured is True
    assert local_config.frontend_origin == 'http://localhost:5173'
    canonical_origin = WakuDemoOAuthConfig(
        **{**base, 'frontend_url': 'https://GAME.example:443/path'}).frontend_origin
    assert canonical_origin == 'https://game.example'


@pytest.mark.asyncio
async def test_invalid_cookie_configuration_fails_without_500(monkeypatch):
    service = WakuDemoOAuthService(replace(
        config(), cookie_name='invalid cookie name', cookie_samesite='invalid'))
    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service', lambda: service)
    app = FastAPI()
    app.include_router(auth_api.router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://backend.test',
        follow_redirects=False,
    ) as client:
        response = await client.get('/api/login/wakudemo')
        assert response.status_code == 302
        assert 'wakudemo_error=oauth_not_configured' in response.headers['location']
        assert response.headers['cache-control'] == 'no-store'


@pytest.mark.asyncio
async def test_invalid_frontend_callback_returns_json_without_redirect_loop(monkeypatch):
    service = WakuDemoOAuthService(replace(config(), frontend_url=''))
    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service', lambda: service)
    app = FastAPI()
    app.include_router(auth_api.router)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url='http://backend.test',
        follow_redirects=False,
    ) as client:
        response = await client.get('/api/login/callback', params={
            'code': 'unusable-code', 'state': 'x' * 43,
        })
        assert response.status_code == 400
        assert 'location' not in response.headers
        assert response.json()['detail']['code'] == 'authorization_request_expired'
        assert response.headers['cache-control'] == 'no-store'
