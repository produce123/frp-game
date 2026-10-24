"""单机模式 LLM 透传网关测试 —— 白名单 / 透传保真 / SSE 流式 / 限额。

起因：千问 Token Plan（`token-plan.cn-beijing.maas.aliyuncs.com`）与 Coding Plan
对浏览器预检直接 401、不带任何 CORS 头，单机模式（浏览器直连供应商）无法调用，
故在自家后端加一条白名单透传通道。

约定：上游一律用 httpx.MockTransport 的假上游，测试不触网、不依赖真实 key。
"""

import json

import httpx
import pytest


class _ChunkStream(httpx.AsyncByteStream):
    """假上游的分块响应体：用来证明网关是逐块回传而不是攒完再吐。"""

    def __init__(self, chunks):
        self.chunks = list(chunks)

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk

    async def aclose(self):
        return None


def _patch_upstream(monkeypatch, handler):
    """把路由里的共享 client 换成 MockTransport 假上游，返回收到的请求列表。

    MockTransport 的 handler 必须是同步函数（即便是 AsyncClient 也一样）。
    """
    seen = []

    def _handle(request):
        seen.append(request)
        return handler(request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(_handle))
    monkeypatch.setattr('app.api.llm_relay.get_relay_client', lambda: client)
    return seen


def _ok_sse(chunks):
    return lambda _request: httpx.Response(
        200, stream=_ChunkStream(chunks), headers={'content-type': 'text/event-stream'})


async def _chunked_body(count: int):
    """分块发送的请求体（不带 content-length）：验证服务端在流式读取中截断。"""
    for _ in range(count):
        yield b' ' * 8192


def _json_response(status: int, payload: dict) -> httpx.Response:
    """假上游的 JSON 响应：必须用异步流，网关才能 aiter_raw 逐块回传。"""
    return httpx.Response(
        status, stream=_ChunkStream([json.dumps(payload).encode()]),
        headers={'content-type': 'application/json'})


def test_default_upstreams_exclude_pay_as_you_go_endpoints():
    """缺省白名单只放浏览器直连被拦的套餐端点；按量付费/官方端点能直连，不绕网关。"""
    from app.api.llm_relay import load_relay_upstreams

    upstreams = load_relay_upstreams()
    assert upstreams['token-plan'] == (
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
    assert not any('dashscope.aliyuncs.com' in url for url in upstreams.values())
    assert not any('api.deepseek.com' in url for url in upstreams.values())


def test_env_can_add_and_override_upstreams_and_rejects_bad_values(monkeypatch):
    from app.api.llm_relay import load_relay_upstreams

    monkeypatch.setenv('LLM_RELAY_UPSTREAMS', ','.join([
        'coding=https://coding.dashscope.aliyuncs.com/v1',          # 新增
        'token-plan=https://example.com/compatible-mode/v1',        # 覆盖缺省
        'loopback=http://127.0.0.1:8899/v1',                        # 本机回环允许 http（本地联调）
        'insecure=http://example.com/v1',                           # 非 https 外网 → 忽略
        'userinfo=https://key@example.com/v1',                      # userinfo → 忽略
        'Bad_ID=https://example.com/v1',                            # id 非法 → 忽略
        'nourl',                                                    # 无 = → 忽略
    ]))

    upstreams = load_relay_upstreams()
    assert upstreams['coding'] == 'https://coding.dashscope.aliyuncs.com/v1'
    assert upstreams['token-plan'] == 'https://example.com/compatible-mode/v1'
    assert upstreams['loopback'] == 'http://127.0.0.1:8899/v1'
    assert 'insecure' not in upstreams
    assert 'userinfo' not in upstreams
    assert 'bad_id' not in upstreams
    assert 'nourl' not in upstreams


@pytest.mark.asyncio
async def test_relay_rejects_unknown_or_traversal_upstream_ids(server, monkeypatch):
    """客户端只能传白名单 id：未知 id、编码过的路径穿越、内嵌 URL 一律 404，且不打上游。"""
    from app.api.llm_relay import reset_llm_relay_rate_limit_for_tests

    reset_llm_relay_rate_limit_for_tests()
    seen = _patch_upstream(monkeypatch, _ok_sse([b'data: [DONE]\n\n']))
    paths = (
        '/api/llm/relay/ghost/chat/completions',
        '/api/llm/relay/..%2F..%2Fevil/chat/completions',
        '/api/llm/relay/https:%2F%2Fevil.example%2Fv1/chat/completions',
        '/api/llm/relay/TOKEN_PLAN/chat/completions',
    )
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        for path in paths:
            response = await http.post(
                path, headers={'Authorization': 'Bearer sk-sp-test'},
                json={'model': 'qwen3.6-plus', 'messages': []})
            # 路径可能被客户端/路由归一化后连路由都不匹配，那也算拦住了；
            # 关键是绝不能把任何请求打到上游。
            assert response.status_code == 404, path
            detail = response.json().get('detail')
            if isinstance(detail, dict):
                assert detail['code'] == 'LLM_RELAY_UPSTREAM_UNKNOWN'
    assert seen == []


@pytest.mark.asyncio
async def test_relay_requires_bearer_key(server, monkeypatch):
    """Key 由客户端自带：缺失或非 Bearer 一律 401，避免网关被当成匿名代理。"""
    from app.api.llm_relay import reset_llm_relay_rate_limit_for_tests

    reset_llm_relay_rate_limit_for_tests()
    seen = _patch_upstream(monkeypatch, _ok_sse([b'data: [DONE]\n\n']))
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        for headers in ({}, {'Authorization': 'Basic abc'}, {'Authorization': 'Bearer'}):
            response = await http.post(
                '/api/llm/relay/token-plan/chat/completions',
                headers=headers, json={'model': 'qwen3.6-plus', 'messages': []})
            assert response.status_code == 401
            assert response.json()['detail']['code'] == 'LLM_RELAY_KEY_REQUIRED'
    assert seen == []


@pytest.mark.asyncio
async def test_relay_forwards_key_and_streams_upstream_sse_verbatim(server, monkeypatch):
    """透传保真：上游 URL / Authorization / 请求体原样过去，SSE 逐块原样回来且不缓冲。"""
    from app.api.llm_relay import reset_llm_relay_rate_limit_for_tests

    reset_llm_relay_rate_limit_for_tests()
    chunks = [
        b'data: {"choices":[{"delta":{"content":"\\u5f20"}}]}\n\n',
        b'data: {"choices":[{"delta":{"content":"\\u4e09"}}]}\n\n',
        b'data: [DONE]\n\n',
    ]
    seen = _patch_upstream(monkeypatch, _ok_sse(chunks))
    payload = {
        'model': 'qwen3.6-plus',
        'messages': [{'role': 'user', 'content': 'ping'}],
        'stream': True,
        'enable_thinking': False,
    }
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        response = await http.post(
            '/api/llm/relay/token-plan/chat/completions',
            headers={'Authorization': 'Bearer sk-sp-test-key'}, json=payload)
        assert response.status_code == 200
        assert response.content == b''.join(chunks)
        assert response.headers['content-type'].startswith('text/event-stream')
        assert response.headers['x-accel-buffering'] == 'no'
        assert 'sk-sp-test-key' not in response.text

    assert len(seen) == 1
    upstream = seen[0]
    assert str(upstream.url) == (
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions')
    assert upstream.headers['authorization'] == 'Bearer sk-sp-test-key'
    # 不把浏览器凭据带给上游。
    assert 'origin' not in upstream.headers
    assert 'cookie' not in upstream.headers
    assert json.loads(upstream.content) == payload


@pytest.mark.asyncio
async def test_relay_passes_upstream_error_status_and_body_through(server, monkeypatch):
    """上游错误要原样透出（状态码 + 文本），前端才能显示供应商的真实报错。"""
    from app.api.llm_relay import reset_llm_relay_rate_limit_for_tests

    reset_llm_relay_rate_limit_for_tests()
    body = {'error': {'message': 'Invalid API key provided', 'type': 'invalid_request_error'}}
    _patch_upstream(monkeypatch, lambda _request: _json_response(401, body))
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        response = await http.post(
            '/api/llm/relay/token-plan/chat/completions',
            headers={'Authorization': 'Bearer sk-sp-bad-key'},
            json={'model': 'qwen3.6-plus', 'messages': []})
        assert response.status_code == 401
        assert response.json() == body


@pytest.mark.asyncio
async def test_relay_maps_unreachable_upstream_to_502(server, monkeypatch):
    from app.api.llm_relay import reset_llm_relay_rate_limit_for_tests

    reset_llm_relay_rate_limit_for_tests()

    def _boom(_request):
        raise httpx.ConnectError('connection refused')

    _patch_upstream(monkeypatch, _boom)
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        response = await http.post(
            '/api/llm/relay/token-plan/chat/completions',
            headers={'Authorization': 'Bearer sk-sp-test-key'},
            json={'model': 'qwen3.6-plus', 'messages': []})
        assert response.status_code == 502
        assert response.json()['detail']['code'] == 'LLM_RELAY_UPSTREAM_UNREACHABLE'


@pytest.mark.asyncio
async def test_relay_caps_body_size_and_rejects_non_object_json(server, monkeypatch):
    from app.api.llm_relay import reset_llm_relay_rate_limit_for_tests

    reset_llm_relay_rate_limit_for_tests()
    seen = _patch_upstream(monkeypatch, _ok_sse([b'data: [DONE]\n\n']))
    headers = {'Authorization': 'Bearer sk-sp-test-key',
               'Content-Type': 'application/json'}
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        # 带 content-length 的超大请求体：读之前就挡掉。
        declared = await http.post(
            '/api/llm/relay/token-plan/chat/completions', headers=headers,
            content=b'{' + b' ' * (70 * 1024))
        assert declared.status_code == 413
        assert declared.json()['detail']['code'] == 'LLM_RELAY_BODY_TOO_LARGE'
        # 不带 content-length（分块传输）时也要在流式读取中截断。
        chunked = await http.post(
            '/api/llm/relay/token-plan/chat/completions', headers=headers,
            content=_chunked_body(12))
        assert chunked.status_code == 413
        # 非 JSON 对象直接 400。
        for raw in (b'not json', b'[1, 2, 3]'):
            invalid = await http.post(
                '/api/llm/relay/token-plan/chat/completions', headers=headers, content=raw)
            assert invalid.status_code == 400
            assert invalid.json()['detail']['code'] == 'LLM_RELAY_BODY_INVALID'
    assert seen == []


@pytest.mark.asyncio
async def test_relay_rate_limits_per_ip(server, monkeypatch):
    from app.api.llm_relay import reset_llm_relay_rate_limit_for_tests

    reset_llm_relay_rate_limit_for_tests()
    monkeypatch.setenv('LLM_RELAY_RATE_LIMIT_PER_MINUTE', '2')
    _patch_upstream(monkeypatch, _ok_sse([b'data: [DONE]\n\n']))
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        for _ in range(2):
            allowed = await http.post(
                '/api/llm/relay/token-plan/chat/completions',
                headers={'Authorization': 'Bearer sk-sp-test-key'},
                json={'model': 'qwen3.6-plus', 'messages': []})
            assert allowed.status_code == 200
        limited = await http.post(
            '/api/llm/relay/token-plan/chat/completions',
            headers={'Authorization': 'Bearer sk-sp-test-key'},
            json={'model': 'qwen3.6-plus', 'messages': []})
        assert limited.status_code == 429
        assert limited.json()['detail']['code'] == 'LLM_RELAY_RATE_LIMITED'
    reset_llm_relay_rate_limit_for_tests()


@pytest.mark.asyncio
async def test_relay_preflight_allows_both_deploy_origins(server):
    """master（EdgeOne 自有域）与 vibehub（平台域）都要能跨源调用本通道。"""
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        for origin in ('https://lianhuaguangdongmahjong.guoguo-labs.online',
                       'https://gamesvibe.app', 'https://apps.gamesvibe.app'):
            response = await http.options(
                '/api/llm/relay/token-plan/chat/completions', headers={
                    'Origin': origin,
                    'Access-Control-Request-Method': 'POST',
                    'Access-Control-Request-Headers': 'authorization,content-type',
                })
            assert response.status_code == 200
            assert response.headers['access-control-allow-origin'] == origin
        blocked = await http.options(
            '/api/llm/relay/token-plan/chat/completions', headers={
                'Origin': 'https://notgamesvibe.app',
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'authorization,content-type',
            })
        assert 'access-control-allow-origin' not in blocked.headers
