"""单机模式 LLM 透传网关 —— 给「不支持浏览器跨域」的供应商开一条自家通道。

背景（2026-09-18 实测：`curl -X OPTIONS` 带站点 Origin 打预检）：
- 千问 Token Plan `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
  预检直接 401，且响应不带任何 `Access-Control-*` 头；
- 同域名的 Anthropic 兼容路径 `/apps/anthropic/v1/messages` 同样 401、无 CORS 头；
- Coding Plan `https://coding.dashscope.aliyuncs.com/v1` 同样 401、无 CORS 头。
  这些套餐端点面向 Claude Code / Cursor 这类能填自定义 Base URL 的 CLI 工具，
  不面向浏览器；官方也明确 Token Plan / Coding Plan / 按量付费三套凭证与 Base URL
  完全隔离、不可混用，所以「换个地址」也绕不过去。
  对照：按量付费 `dashscope.aliyuncs.com/compatible-mode/v1` 回 `access-control-allow-origin: *`，
  `api.deepseek.com` 会回显请求 Origin，因此单机直连这两类端点一直可用。

单机模式（`src/game/llm/client.ts`）是**浏览器直连供应商**，无 CORS 的端点必须
经过一个会回 CORS 头的自家服务：本模块。网关的 CORSMiddleware 已放行站点域名与
`*.gamesvibe.app`（见 `app/main.py`），所以 master 与 vibehub 两个发布域都覆盖。

安全边界（改动本文件时务必保持）：
- 上游由服务端白名单决定，客户端只能传 id、**不能传 URL** —— 避免本端点变成
  人人可用的 SSRF 跳板。
- Key 由客户端自带并原样透传给上游：服务端不保存、不写日志、不回显。
- 请求体与响应体不改写（尽量与直连逐位一致），SSE 原样流式回传并置
  `X-Accel-Buffering: no`；否则前置 openresty 会缓冲，前端 40s 决策预算被代理吃掉。

环境变量：
- `LLM_RELAY_UPSTREAMS`：追加/覆盖上游白名单，形如
  `id=https://host/path,id2=https://host2/path`（id 限小写字母数字与连字符，最长 32）。
- `LLM_RELAY_RATE_LIMIT_PER_MINUTE`：单 IP 每分钟请求上限，缺省 600（非法或 ≤0 用缺省）。
"""

import json
import os
import re
import time
from collections import defaultdict, deque
from typing import Optional
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

router = APIRouter(prefix='/api/llm/relay', tags=['llm-relay'])

# 缺省上游只放「浏览器直连确定被 CORS 拦」的套餐端点：其余端点浏览器能直连，
# 不需要绕网关（少一跳，也少一次 key 过境）。
DEFAULT_UPSTREAMS: dict[str, str] = {
    'token-plan': 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
}
UPSTREAMS_ENV = 'LLM_RELAY_UPSTREAMS'
RATE_LIMIT_ENV = 'LLM_RELAY_RATE_LIMIT_PER_MINUTE'
DEFAULT_RATE_LIMIT_PER_MINUTE = 600
# 单次请求体上限：麻将决策请求只有几百字节～几 KB，64KB 足够且挡住滥用。
MAX_BODY_BYTES = 64 * 1024
# 读超时给足：深思决策本身可能跑几十秒；前端有 40s 预算自行中止。
UPSTREAM_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)

_ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,31}$')
_USERINFO_RE = re.compile(r'^[a-z][a-z0-9+.-]*://[^/@]*@', re.I)

_requests: dict[str, deque[float]] = defaultdict(deque)
_shared: Optional[httpx.AsyncClient] = None


def _normalize_upstream(value: str) -> Optional[str]:
    """只接受无 userinfo、无空白的 https 地址；本机回环允许 http（与 app/llm/client.py 同口径）。

    上游本来就是服务端配置，这里仍然按最严收口：非 https 的外网地址一律忽略，
    避免环境变量写错后把 key 明文发出去。
    """
    url = value.strip().rstrip('/')
    if not url or _USERINFO_RE.match(url) or any(ch.isspace() for ch in url):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in ('http', 'https') or not parts.hostname:
        return None
    if parts.scheme == 'http' and parts.hostname not in ('localhost', '127.0.0.1', '::1'):
        return None
    return url


def load_relay_upstreams() -> dict[str, str]:
    """上游白名单：缺省 + 环境变量覆盖（每次调用重读，部署后可热改）。"""
    upstreams = dict(DEFAULT_UPSTREAMS)
    for item in os.environ.get(UPSTREAMS_ENV, '').split(','):
        item = item.strip()
        if not item or '=' not in item:
            continue
        upstream_id, _, url = item.partition('=')
        upstream_id = upstream_id.strip().lower()
        normalized = _normalize_upstream(url)
        if normalized and _ID_RE.fullmatch(upstream_id):
            upstreams[upstream_id] = normalized
    return upstreams


def load_relay_rate_limit() -> int:
    """单 IP 每分钟上限；麻将一局 4 个 LLM 座位都可能走这条通道，缺省给宽。"""
    raw = os.environ.get(RATE_LIMIT_ENV, '').strip()
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_RATE_LIMIT_PER_MINUTE
    return value if value > 0 else DEFAULT_RATE_LIMIT_PER_MINUTE


def get_relay_client() -> httpx.AsyncClient:
    """共享 client：进程级单例，应用退出时显式关闭。"""
    global _shared
    if _shared is None:
        _shared = httpx.AsyncClient(
            timeout=UPSTREAM_TIMEOUT, limits=httpx.Limits(max_connections=16))
    return _shared


async def close_relay_client() -> None:
    global _shared
    if _shared is not None:
        await _shared.aclose()
        _shared = None


def _check_rate_limit(client_ip: str, limit: int) -> None:
    now = time.monotonic()
    bucket = _requests[client_ip]
    cutoff = now - 60.0
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) >= limit:
        raise HTTPException(status_code=429, detail={'code': 'LLM_RELAY_RATE_LIMITED'})
    bucket.append(now)


def _is_json_object(body: bytes) -> bool:
    if not body:
        return False
    try:
        return isinstance(json.loads(body), dict)
    except (TypeError, ValueError, UnicodeDecodeError):
        return False


async def _read_capped_body(request: Request) -> bytes:
    """按块读并即时截断：不能先 await request.body() 再判长度（无 content-length 时可被撑爆内存）。"""
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail={'code': 'LLM_RELAY_BODY_TOO_LARGE'})
    return bytes(body)


async def _stream_upstream(response: httpx.Response):
    """原样回传（含上游错误响应体）：前端需要看到供应商的真实错误文本，才能提示用户。"""
    try:
        async for chunk in response.aiter_raw():
            yield chunk
    finally:
        await response.aclose()


@router.post('/{upstream_id}/chat/completions')
async def relay_chat_completions(upstream_id: str, request: Request):
    """透传一次 chat/completions 调用：`/api/llm/relay/<id>/chat/completions`。"""
    resolved_id = upstream_id.strip().lower()
    upstream = load_relay_upstreams().get(resolved_id) \
        if _ID_RE.fullmatch(resolved_id) else None
    if upstream is None:
        raise HTTPException(status_code=404, detail={'code': 'LLM_RELAY_UPSTREAM_UNKNOWN'})

    authorization = request.headers.get('authorization', '').strip()
    if not authorization.lower().startswith('bearer ') \
            or len(authorization) <= len('bearer '):
        raise HTTPException(status_code=401, detail={'code': 'LLM_RELAY_KEY_REQUIRED'})

    declared = request.headers.get('content-length', '').strip()
    if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail={'code': 'LLM_RELAY_BODY_TOO_LARGE'})
    body = await _read_capped_body(request)
    if not _is_json_object(body):
        raise HTTPException(status_code=400, detail={'code': 'LLM_RELAY_BODY_INVALID'})

    client_ip = request.client.host if request.client else 'unknown'
    _check_rate_limit(client_ip, load_relay_rate_limit())

    # 只带上协议必需的头：不转发 Origin / Referer / Cookie，避免把浏览器凭据带给上游。
    client = get_relay_client()
    upstream_request = client.build_request(
        'POST', f'{upstream}/chat/completions',
        headers={
            'content-type': 'application/json',
            'authorization': authorization,
            'accept': 'text/event-stream',
        },
        content=body,
    )
    try:
        response = await client.send(upstream_request, stream=True)
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504, detail={'code': 'LLM_RELAY_UPSTREAM_TIMEOUT'}) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail={'code': 'LLM_RELAY_UPSTREAM_UNREACHABLE'}) from exc

    return StreamingResponse(
        _stream_upstream(response),
        status_code=response.status_code,
        media_type=response.headers.get('content-type') or 'text/event-stream',
        headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'},
    )


def reset_llm_relay_rate_limit_for_tests() -> None:
    _requests.clear()
