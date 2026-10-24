"""Loguru HTTP/WS 日志的安全性与去重回归测试。"""

import logging
import re

import pytest
from loguru import logger
from starlette.requests import Request
from starlette.responses import JSONResponse

from app import logging_config as logging_module
from app.logging_config import (
    InterceptHandler,
    _patch_uvicorn_loggers,
    redact_sensitive_data,
)
from app.main import access_log_middleware


@pytest.fixture()
def captured_logs():
    records = []
    sink_id = logger.add(
        lambda message: records.append(dict(message.record)),
        level='DEBUG',
    )
    yield records
    logger.remove(sink_id)


def _request(path: str, query: str = '') -> Request:
    return Request({
        'type': 'http',
        'asgi': {'version': '3.0'},
        'http_version': '1.1',
        'method': 'GET',
        'scheme': 'http',
        'path': path,
        'raw_path': path.encode(),
        'query_string': query.encode(),
        'root_path': '',
        'headers': [],
        'client': ('127.0.0.1', 12345),
        'server': ('testserver', 80),
    })


async def _ok(_request: Request):
    return JSONResponse({'ok': True})


@pytest.mark.asyncio
async def test_rejoin_code_is_never_emitted_by_http_or_uvicorn_ws(captured_logs):
    secret = 'AB12-CD34'
    await access_log_middleware(
        _request('/api/example', f'rejoin_code={secret}&source=test'),
        _ok,
    )

    # Uvicorn 的 WS protocol 使用 uvicorn.error 输出包含完整 query 的请求行。
    _patch_uvicorn_loggers()
    logging.getLogger('uvicorn.error').info(
        '127.0.0.1:12345 - "WebSocket '
        f'/ws/room/ROOM01?rejoin_code={secret}" [accepted]'
    )

    rendered = '\n'.join(record['message'] for record in captured_logs)
    assert secret not in rendered
    assert 'rejoin_code=***' in rendered


def test_oauth_credentials_are_redacted_from_logs():
    rendered = redact_sensitive_data(
        'GET /api/login/callback?code=secret-code&state=secret-state '
        'code_verifier=secret-verifier&access_token=secret-token '
        'Authorization: Bearer secret-bearer')

    for secret in (
        'secret-code', 'secret-state', 'secret-verifier', 'secret-token', 'secret-bearer',
    ):
        assert secret not in rendered
    assert rendered.count('***') == 5


def test_console_sink_disables_exception_local_diagnostics(monkeypatch):
    add_calls = []

    class FakeLogger:
        def remove(self):
            return None

        def add(self, *args, **kwargs):
            add_calls.append(kwargs)
            return 1

        def warning(self, *args, **kwargs):
            return None

    monkeypatch.setattr(logging_module, 'logger', FakeLogger())
    monkeypatch.setattr(logging_module, '_CONFIGURED', False)
    monkeypatch.setattr(logging_module, '_patch_uvicorn_loggers', lambda: None)
    monkeypatch.setattr(logging_module.logging, 'basicConfig', lambda **kwargs: None)
    monkeypatch.setenv('LOG_TO_FILE', '0')

    logging_module.configure_logging()

    assert len(add_calls) == 1
    assert add_calls[0]['backtrace'] is False
    assert add_calls[0]['diagnose'] is False


@pytest.mark.asyncio
async def test_http_request_log_contains_request_id(captured_logs):
    await access_log_middleware(_request('/api/request-id'), _ok)

    access_records = [
        record for record in captured_logs
        if record['message'].startswith('HTTP GET /api/request-id ')
    ]
    assert len(access_records) == 1
    request_id = access_records[0]['extra'].get('request_id')
    assert re.fullmatch(r'[0-9a-f]{12}', request_id or '')


@pytest.mark.asyncio
async def test_uvicorn_access_log_is_not_duplicated(captured_logs):
    _patch_uvicorn_loggers()
    _patch_uvicorn_loggers()
    access_logger = logging.getLogger('uvicorn.access')

    assert len(access_logger.handlers) == 1
    assert isinstance(access_logger.handlers[0], InterceptHandler)
    assert access_logger.propagate is False

    await access_log_middleware(_request('/api/single-access-log'), _ok)
    access_logger.info(
        '127.0.0.1:12345 - "GET /api/single-access-log HTTP/1.1" 200'
    )

    matching = [
        record for record in captured_logs
        if '/api/single-access-log' in record['message']
    ]
    assert len(matching) == 1
    assert matching[0]['message'].startswith('HTTP GET ')
