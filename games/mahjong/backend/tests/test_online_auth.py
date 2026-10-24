"""联机登录鉴权集成测试 —— 登录依赖 / 身份绑定 / 头像优先级 / me 接口

覆盖决策：
- 房间创建/加入/meta/详情与举报必须登录（401 AUTH_REQUIRED）
- 座位操作（ready/leave 等）保持 rejoinCode 校验，不强制登录
- 联机身份 = wakudemo-<uid>（服务端推导，忽略客户端 playerId）
- 头像：登录会话 avatarUrl 优先；否则回退随机头像并落库
- /api/me/stats 与 /api/me/disclaimer-agreement 绑定登录身份
"""

from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.api import account as account_api
from app.api import matches as matches_api
from app.api import moderation as moderation_api
from app.api import rooms as rooms_api
from app.api import deps
from app.game.room import room_registry


@pytest.fixture()
def online_storage(monkeypatch):
    """临时 SQLite 库，替换各 api 模块的全局 storage。

    沙箱环境下 pytest tmp_path / tempfile 目录不可被 sqlite 写入，
    改用工作区内固定目录 + uuid 文件名。
    """
    import os
    import uuid

    from app.storage.db import Storage
    db_dir = os.path.join(os.getcwd(), '.test-dbs')
    os.makedirs(db_dir, exist_ok=True)
    s = Storage(os.path.join(db_dir, f'online-{uuid.uuid4().hex}.db'))
    s.init()
    for module in (rooms_api, matches_api, account_api, moderation_api):
        monkeypatch.setattr(module, 'storage', s)
    return s


@pytest.fixture()
def fake_auth(monkeypatch):
    """可编程的假登录服务：控制会话有效性、账户摘要与开发旁路开关。"""
    state = {
        'valid': True,
        'bypass': False,
        'account': {'id': '10086', 'displayName': '玩家', 'avatarUrl': None},
    }

    class FakeService:
        @property
        def config(self):
            return SimpleNamespace(
                cookie_name='lgm_wakudemo_session',
                login_bypass=state['bypass'],
            )

        def get_session(self, session_id):
            if not state['valid'] or not session_id:
                return None
            return SimpleNamespace(account=state['account'])

    service = FakeService()
    monkeypatch.setattr(deps, 'get_wakudemo_oauth_service', lambda: service)
    return state


@pytest.fixture()
def client(online_storage, fake_auth):
    app = FastAPI()
    app.include_router(rooms_api.router)
    app.include_router(matches_api.router)
    app.include_router(account_api.router)
    app.include_router(moderation_api.router)
    return app


COOKIE = {'lgm_wakudemo_session': 'session-token'}


# ─── 登录依赖 ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_room_endpoints_require_login(client, fake_auth):
    fake_auth['valid'] = False
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test') as http:
        r = await http.post('/api/rooms', json={'mode': 'east'})
        assert r.status_code == 401
        assert r.json()['detail']['code'] == 'AUTH_REQUIRED'

        r = await http.get('/api/rooms/meta')
        assert r.status_code == 401

        r = await http.get('/api/rooms/ABC123')
        assert r.status_code == 401

        r = await http.post('/api/rooms/ABC123/join', json={'nickname': '匿名'})
        assert r.status_code == 401

        r = await http.get('/api/me/stats')
        assert r.status_code == 401

        r = await http.get('/api/me/disclaimer-agreement')
        assert r.status_code == 401

        r = await http.post('/api/reports', json={'roomId': '', 'reason': 'x'})
        assert r.status_code == 401


# ─── 身份绑定 ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_join_binds_identity_to_wakudemo_uid_ignoring_client_player_id(
        client, fake_auth, fresh_rooms):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test', cookies=COOKIE) as http:
        r = await http.post('/api/rooms', json={'mode': 'east', 'playerId': 'fake-guest'})
        assert r.status_code == 200
        room_id = r.json()['roomId']

        # 客户端伪造 playerId 必须被忽略，身份由会话 uid 推导
        r = await http.post(f'/api/rooms/{room_id}/join',
                            json={'nickname': '阿莲', 'playerId': 'fake-guest'})
        assert r.status_code == 200
        body = r.json()
        assert body['playerId'] == 'wakudemo-10086'
        assert body['rejoinCode']

        room = room_registry.get(room_id)
        assert room is not None
        assert room.seats[body['seat']].player_id == 'wakudemo-10086'


@pytest.mark.asyncio
async def test_duplicate_occupancy_checks_login_identity(client, fake_auth, fresh_rooms):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test', cookies=COOKIE) as http:
        r1 = await http.post('/api/rooms', json={'mode': 'east'})
        r2 = await http.post('/api/rooms', json={'mode': 'east'})
        assert r1.status_code == 200 and r2.status_code == 200
        first = (await http.post(f"/api/rooms/{r1.json()['roomId']}/join",
                                 json={'nickname': '阿莲'})).json()
        # 异常退出后，同账号再进原房间应取回原座和重进码，包括对局中。
        same = await http.post(f"/api/rooms/{r1.json()['roomId']}/join",
                               json={'nickname': '新昵称', 'playerId': 'other'})
        assert same.status_code == 200
        assert same.json()['rejoin'] is True
        assert same.json()['seat'] == first['seat']
        assert same.json()['rejoinCode'] == first['rejoinCode']
        room_registry.get(r1.json()['roomId']).status = 'playing'
        playing = await http.post(f"/api/rooms/{r1.json()['roomId']}/join",
                                  json={'nickname': '阿莲'})
        assert playing.status_code == 200
        assert playing.json()['rejoinCode'] == first['rejoinCode']
        # 同一登录身份已在房间 → 开新房/跨房占座被拒（即使客户端换 playerId）
        r3 = await http.post('/api/rooms', json={'mode': 'east', 'playerId': 'other'})
        assert r3.status_code == 409
        assert r3.json()['detail']['code'] == 'ALREADY_IN_ROOM'
        r4 = await http.post(f"/api/rooms/{r2.json()['roomId']}/join",
                             json={'nickname': '阿莲2', 'playerId': 'other'})
        assert r4.status_code == 409
        assert r4.json()['detail']['code'] == 'ALREADY_IN_ROOM'


# ─── 头像优先级 ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_join_uses_platform_avatar_when_present(client, fake_auth, fresh_rooms,
                                                      stub_avatar_fetch):
    fake_auth['account'] = {
        'id': '10086', 'displayName': '玩家',
        'avatarUrl': 'https://cdn.wakudemo.cn/avatars/10086.png',
    }
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test', cookies=COOKIE) as http:
        r = await http.post('/api/rooms', json={'mode': 'east'})
        r = await http.post(f"/api/rooms/{r.json()['roomId']}/join",
                            json={'nickname': '阿莲'})
        assert r.status_code == 200
        room = room_registry.get(r.json()['roomId'])
        seat = room.seats[r.json()['seat']]
        assert seat.avatar == 'https://cdn.wakudemo.cn/avatars/10086.png'
        # 平台头像直接用，不触发随机头像抓取
        assert stub_avatar_fetch['n'] == 0


@pytest.mark.asyncio
async def test_join_falls_back_to_random_avatar(client, fake_auth, fresh_rooms,
                                                stub_avatar_fetch):
    fake_auth['account'] = {'id': '10086', 'displayName': '玩家', 'avatarUrl': None}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test', cookies=COOKIE) as http:
        r = await http.post('/api/rooms', json={'mode': 'east'})
        r = await http.post(f"/api/rooms/{r.json()['roomId']}/join",
                            json={'nickname': '阿莲'})
        room = room_registry.get(r.json()['roomId'])
        seat = room.seats[r.json()['seat']]
        assert seat.avatar.startswith('https://example.com/avatar/fake-')
        assert stub_avatar_fetch['n'] == 1


@pytest.mark.asyncio
async def test_join_rejects_non_http_avatar(client, fake_auth, fresh_rooms,
                                            stub_avatar_fetch):
    fake_auth['account'] = {
        'id': '10086', 'displayName': '玩家', 'avatarUrl': 'javascript:alert(1)',
    }
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test', cookies=COOKIE) as http:
        r = await http.post('/api/rooms', json={'mode': 'east'})
        r = await http.post(f"/api/rooms/{r.json()['roomId']}/join",
                            json={'nickname': '阿莲'})
        room = room_registry.get(r.json()['roomId'])
        seat = room.seats[r.json()['seat']]
        assert seat.avatar.startswith('https://example.com/avatar/fake-')
        assert stub_avatar_fetch['n'] == 1


# ─── 血流房间头像：与经典房间同源（同一 player_id → 同一张脸）────

async def _join_blood_flow_room(http) -> tuple[str, dict]:
    """建一个血流房间并加入，返回 (roomId, join 响应体)。"""
    created = await http.post('/api/rooms',
                              json={'mode': 'east', 'rulesetId': 'lotus-blood-flow'})
    assert created.status_code == 200
    room_id = created.json()['roomId']
    joined = await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '阿莲'})
    assert joined.status_code == 200
    return room_id, joined.json()


@pytest.mark.asyncio
async def test_blood_flow_join_uses_platform_avatar_and_persists(
        client, fake_auth, online_storage, fresh_rooms, stub_avatar_fetch):
    """平台登录头像优先：血流座位直接用平台头像并落库，不再取随机图。"""
    fake_auth['account'] = {
        'id': '10086', 'displayName': '玩家',
        'avatarUrl': 'https://cdn.wakudemo.cn/avatars/10086.png',
    }
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test', cookies=COOKIE) as http:
        room_id, body = await _join_blood_flow_room(http)

    seat = room_registry.get(room_id).seats[body['seat']]
    assert seat.avatar == 'https://cdn.wakudemo.cn/avatars/10086.png'
    assert stub_avatar_fetch['n'] == 0
    assert online_storage.get_player_avatar('wakudemo-10086') == \
        'https://cdn.wakudemo.cn/avatars/10086.png'


@pytest.mark.asyncio
async def test_blood_flow_reuses_avatar_persisted_by_classic_room(
        client, fake_auth, online_storage, fresh_rooms, stub_avatar_fetch):
    """回归：经典房间已落库的头像（无登录头像时取随机图），血流房间复用同一张。"""
    fake_auth['account'] = {'id': '10086', 'displayName': '玩家', 'avatarUrl': None}
    # 经典房间路径落库结果（等价于该账号先打过经典联机）
    online_storage.set_player_avatar('wakudemo-10086',
                                     'https://example.com/avatar/from-classic.jpg')

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test', cookies=COOKIE) as http:
        room_id, body = await _join_blood_flow_room(http)

    seat = room_registry.get(room_id).seats[body['seat']]
    assert seat.avatar == 'https://example.com/avatar/from-classic.jpg'
    assert stub_avatar_fetch['n'] == 0   # 复用落库头像，不再取随机图


@pytest.mark.asyncio
async def test_blood_flow_falls_back_to_random_avatar_and_persists(
        client, fake_auth, online_storage, fresh_rooms, stub_avatar_fetch):
    """无登录头像且无落库：首次取一次随机头像并落库（与经典房间同口径）。"""
    fake_auth['account'] = {'id': '10086', 'displayName': '玩家', 'avatarUrl': None}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test', cookies=COOKIE) as http:
        room_id, body = await _join_blood_flow_room(http)

    seat = room_registry.get(room_id).seats[body['seat']]
    assert seat.avatar.startswith('https://example.com/avatar/fake-')
    assert stub_avatar_fetch['n'] == 1
    assert online_storage.get_player_avatar('wakudemo-10086') == seat.avatar


# ─── 座位操作保持 rejoinCode（不强制登录）─────────────────

@pytest.mark.asyncio
async def test_seat_ops_keep_rejoin_code_without_login(client, fake_auth, fresh_rooms):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test', cookies=COOKIE) as http:
        r = await http.post('/api/rooms', json={'mode': 'east'})
        room_id = r.json()['roomId']
        r = await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '阿莲'})
        seat = r.json()['seat']
        rejoin_code = r.json()['rejoinCode']

        # 登录态失效（模拟 token 过期）：座位操作凭 rejoinCode 仍可用
        fake_auth['valid'] = False
        async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=client),
                base_url='http://test') as anon_http:
            r = await anon_http.post(f'/api/rooms/{room_id}/ready', json={
                'seat': seat, 'rejoinCode': rejoin_code, 'ready': True,
            })
            assert r.status_code == 200
            assert r.json()['ready'] is True

            r = await anon_http.post(f'/api/rooms/{room_id}/leave', json={
                'seat': seat, 'rejoinCode': rejoin_code,
            })
            assert r.status_code == 200


# ─── me 接口（战绩 / 免责声明）────────────────────────────

@pytest.mark.asyncio
async def test_me_stats_keyed_by_login_identity(client, fake_auth, online_storage):
    match_id = online_storage.create_match('r1', 'east')
    online_storage.upsert_match_players(match_id, [
        {'seat': 0, 'player_id': 'wakudemo-10086', 'nickname': '阿莲'},
    ])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test', cookies=COOKIE) as http:
        r = await http.get('/api/me/stats')
        assert r.status_code == 200
        assert r.json()['playerId'] == 'wakudemo-10086'
        # 客户端伪造路径里的 player_id 无法影响结果
        r2 = await http.get('/api/players/by-id/fake/stats')
        assert r2.status_code == 200
        assert r2.json()['playerId'] == 'fake'


@pytest.mark.asyncio
async def test_me_disclaimer_roundtrip(client, fake_auth):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test', cookies=COOKIE) as http:
        r = await http.get('/api/me/disclaimer-agreement')
        assert r.status_code == 200
        assert r.json() == {'playerId': 'wakudemo-10086', 'agreed': False}

        r = await http.put('/api/me/disclaimer-agreement', json={'version': 1})
        assert r.status_code == 200
        assert r.json()['agreed'] is True

        r = await http.get('/api/me/disclaimer-agreement')
        assert r.json()['agreed'] is True
        assert r.json()['version'] == 1


@pytest.mark.asyncio
async def test_report_uses_login_identity(client, fake_auth):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test', cookies=COOKIE) as http:
        r = await http.post('/api/reports', json={
            'roomId': '', 'reporterPlayerId': 'spoofed', 'reason': 'x',
        })
        assert r.status_code == 200
        assert r.json()['reported'] is True


# ─── 开发旁路（WAKUDEMO_LOGIN_BYPASS）────────────────────

@pytest.mark.asyncio
async def test_dev_bypass_skips_login_and_uses_client_player_id(
        client, fake_auth, fresh_rooms):
    """旁路开启且无会话：身份按客户端 playerId 推导，多身份可同房测试。"""
    fake_auth['bypass'] = True
    fake_auth['valid'] = False
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test') as http:
        # 未登录也能建房/加入
        r = await http.post('/api/rooms', json={'capacity': 2, 'playerId': 'dev-player-1'})
        assert r.status_code == 200, r.text
        room_id = r.json()['roomId']

        r = await http.post(f'/api/rooms/{room_id}/join',
                            json={'nickname': '甲', 'playerId': 'dev-player-1'})
        assert r.status_code == 200
        assert r.json()['playerId'] == 'wakudemo-dev-player-1'

        # 第二个旁路身份（另一浏览器/标签页的 guestId）可同房
        r = await http.post(f'/api/rooms/{room_id}/join',
                            json={'nickname': '乙', 'playerId': 'dev-player-2'})
        assert r.status_code == 200
        assert r.json()['playerId'] == 'wakudemo-dev-player-2'

        # 同身份回到原房间取回原座，而不是重复占座。
        r = await http.post(f'/api/rooms/{room_id}/join',
                            json={'nickname': '丙', 'playerId': 'dev-player-1'})
        assert r.status_code == 200
        assert r.json()['rejoin'] is True
        assert r.json()['seat'] == 0
        assert sum(seat is not None for seat in room_registry.get(room_id).seats) == 2


@pytest.mark.asyncio
async def test_dev_bypass_falls_back_to_fixed_identity(client, fake_auth, fresh_rooms):
    """旁路开启但未携带 playerId：使用固定 dev-bypass 身份。"""
    fake_auth['bypass'] = True
    fake_auth['valid'] = False
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client),
                                 base_url='http://test') as http:
        r = await http.post('/api/rooms', json={'capacity': 2})
        assert r.status_code == 200
        room_id = r.json()['roomId']
        r = await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '甲'})
        assert r.status_code == 200
        assert r.json()['playerId'] == 'wakudemo-dev-bypass'


@pytest.mark.asyncio
async def test_dev_bypass_session_reports_authenticated(monkeypatch):
    """旁路开启：/api/login/session 返回已登录（前端联机门禁放行）。"""
    import app.api.auth as auth_api

    class FakeAuthService:
        config = SimpleNamespace(
            cookie_name='lgm_wakudemo_session', login_bypass=True)

        def get_session(self, session_id):
            return None

    monkeypatch.setattr(auth_api, 'get_wakudemo_oauth_service',
                        lambda: FakeAuthService())
    app = FastAPI()
    app.include_router(auth_api.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                 base_url='http://test') as http:
        r = await http.get('/api/login/session')
        assert r.status_code == 200
        assert r.json() == {
            'authenticated': True,
            'account': {'id': 'dev-bypass', 'displayName': '本地开发账号',
                        'avatarUrl': None},
        }
