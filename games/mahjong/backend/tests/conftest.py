"""共享测试 fixture —— 真实 uvicorn 服务 + 房间注册表清理

test_ws.py / test_api.py 共用：
- server：后台线程起一个真实 uvicorn，返回 {http, ws} 基础地址
- fresh_rooms：每测例清空房间注册表（取消残留游戏任务）

重要：游戏开局（RoomSession.start）必须通过 REST 路由触发 —— REST async 路由
在 uvicorn 事件循环执行，game_task 因此绑定 uvicorn 循环，与 WS 处理器一致。
测试直接调用 room.start() 会把 game_task 绑定到 pytest 循环，与 uvicorn 跨循环死锁。
"""

import os
from pathlib import Path
import tempfile
import threading
import time

import pytest
import uvicorn

# 测试静默：在导入 app.main（loguru 配置运行）之前设置，不落文件、不刷屏。
# setdefault 保留开发者/CI 显式指定的环境变量。
os.environ.setdefault('LOG_TO_FILE', '0')
os.environ.setdefault('LOG_LEVEL', 'WARNING')
# 测试关掉常驻房间看门狗（0 = 关闭）：否则后台清扫会与用例抢房间、造成 flaky。
# 看门狗行为全部由测试直调 rooms.sweep_stalled() 覆盖，不依赖后台任务。
# 必须在下面 `from app.main import app` 之前设置——常量在模块导入时读取。
os.environ.setdefault('ROOM_WATCHDOG_INTERVAL', '0')
# 测试服务只监听本机；避免开发机系统代理截获 127.0.0.1 请求并返回 503。
for _proxy_key in ('NO_PROXY', 'no_proxy'):
    _hosts = [item.strip() for item in os.environ.get(_proxy_key, '').split(',') if item.strip()]
    for _host in ('127.0.0.1', 'localhost'):
        if _host not in _hosts:
            _hosts.append(_host)
    os.environ[_proxy_key] = ','.join(_hosts)

# 测试严禁读取开发机真实 TTS YAML/凭据；服务 fixture 使用系统临时缓存。
from app.tts import config as tts_config
_test_tts_root = Path(tempfile.gettempdir()) / 'lianhua-test-tts'
_test_tts_root.mkdir(parents=True, exist_ok=True)
_test_tts_config = _test_tts_root / 'disabled.yml'
_test_tts_config.write_text(
    'version: 1\nenabled: false\ncache:\n'
    f'  room: {{dir: "{(_test_tts_root / "room").as_posix()}", max_mb: 16, ttl_days: 1}}\n'
    f'  local: {{dir: "{(_test_tts_root / "local").as_posix()}", max_mb: 16, ttl_days: 1}}\n',
    encoding='utf-8')
tts_config.DEFAULT_CONFIG_FILE = _test_tts_config

from app.main import app
from app.game.room import room_registry as rooms


@pytest.fixture(scope='module')
def server():
    """后台线程起一个真实 uvicorn 服务，返回 {http, ws} 基础地址。"""
    config = uvicorn.Config(app, host='127.0.0.1', port=0, log_level='warning')
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not getattr(server, 'started', False):
        if time.time() > deadline:
            thread.join(timeout=0)
            raise RuntimeError('uvicorn 启动超时')
        time.sleep(0.02)
    port = server.servers[0].sockets[0].getsockname()[1]
    yield {'http': f'http://127.0.0.1:{port}', 'ws': f'ws://127.0.0.1:{port}'}
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture()
def fresh_rooms():
    """每测例清空房间注册表（取消残留的游戏任务）。"""
    rooms.clear()
    yield
    rooms.clear()


@pytest.fixture(autouse=True)
def stub_avatar_fetch(monkeypatch):
    """头像获取不触网：按调用次数返回固定 URL，并统计调用次数供断言。

    外部头像 API（api.ruseo.cn）在测试里不可依赖；monkeypatch 掉
    app.game.avatars.fetch_random_avatar 后，经典房间与血流房间的 join 流程都照常走
    「首次取图 → 落库 → 复用」逻辑。
    """
    from app.game import avatars as avatars_module
    calls = {'n': 0}

    def _fake_avatar():
        calls['n'] += 1
        return f'https://example.com/avatar/fake-{calls["n"]}.jpg'

    monkeypatch.setattr(avatars_module, 'fetch_random_avatar', _fake_avatar)
    return calls


@pytest.fixture(autouse=True)
def stub_wakudemo_login(monkeypatch):
    """默认登录态：REST 测试视为已登录，session Cookie 值即 uid（无 Cookie 用 default）。

    联机接口现在强制登录；存量测试通过本桩获得默认身份。需要显式验证
    401 / 身份绑定的测试可自行 monkeypatch app.api.deps.get_wakudemo_oauth_service
    覆盖本桩（后应用的 patch 生效）。
    """
    from types import SimpleNamespace

    import app.api.deps as deps

    class _FakeService:
        config = SimpleNamespace(cookie_name='lgm_wakudemo_session', login_bypass=False)

        def get_session(self, session_id):
            uid = session_id or 'default'
            return SimpleNamespace(account={
                'id': uid, 'displayName': f'玩家-{uid}', 'avatarUrl': None,
            })

    monkeypatch.setattr(deps, 'get_wakudemo_oauth_service', lambda: _FakeService())
