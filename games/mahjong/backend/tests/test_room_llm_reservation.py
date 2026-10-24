"""预留座位：房主为某空位显式选择模型 ⇒ 该座预留给大模型，真人不可占。

产品语义（2026-09 确认）：「自动选择」= 真人可占（空着由默认提供商补位）；
房主**显式选择模型** = 该座预留给大模型，真人加入时跳过，开局按该模型装配。

三层覆盖：
- 经典房间（RoomSession）：join 跳过预留座、SEAT_OCCUPIED/INVALID_SEAT 校验、取消预留即放行真人；
- 血流房间（BloodFlowRoomSession）：同契约 + 预留进 llm_seats（其余空位仍走默认提供商）；
- REST：写/清预留端点（房主身份校验）+ 房间信息下发 reservedSeats + 真人被拒的
  SEATS_RESERVED（不是笼统的「房间已满」）+ 开局装配（预留座 LLM、其余空位默认提供商）；
- 状态闸：对局中（playing）拒绝 ROOM_CLOSED，**终局（finished）允许改/清预留**
  ——前端房间面板在整场结束后放开模型编辑入口，接口必须放行（2026-09-30 前端口径）。
"""

import httpx
import pytest

import app.game.room as room_module
from app.game.llm_player import LLMPlayer
from app.game.room import RoomError, room_registry as rooms
from app.llm.config import LlmProvider
from tests.test_api import wait_until

PROVIDERS = {
    'ds': LlmProvider('ds', 'DeepSeek', 'https://api.deepseek.com/v1', 'sk-ds',
                      'deepseek-chat', '话痨'),
    'kimi': LlmProvider('kimi', 'Kimi', 'https://api.moonshot.cn/v1', 'sk-kimi',
                        'kimi-k2', '稳健', '小K'),
}
RESERVED_1 = [{'seat': 1, 'providerId': 'kimi', 'style': '高冷'}]


@pytest.fixture(autouse=True)
def _clear_registry():
    rooms.clear()
    yield
    rooms.clear()


@pytest.fixture()
def providers(monkeypatch):
    """服务端注册表 + 能力探测 + 默认提供商：经典 / 血流 / REST 三处入口同名打桩。"""
    import app.api.rooms as rooms_api
    import app.game.room as room_module
    import app.llm.config as llm_config
    monkeypatch.setattr(llm_config, 'load_llm_providers', lambda: PROVIDERS)
    monkeypatch.setattr(llm_config, 'default_provider_id', lambda: 'ds')
    monkeypatch.setattr(llm_config, 'llm_server_available', lambda: True)
    monkeypatch.setattr(room_module, 'load_llm_providers', lambda: PROVIDERS)
    monkeypatch.setattr(room_module, 'default_provider_id', lambda: 'ds')
    monkeypatch.setattr(room_module, 'llm_server_available', lambda: True)
    monkeypatch.setattr(rooms_api, 'load_llm_providers', lambda: PROVIDERS)
    monkeypatch.setattr(rooms_api, 'default_provider_id', lambda: 'ds')
    return PROVIDERS


@pytest.fixture()
def temp_storage(tmp_path, monkeypatch):
    """临时 SQLite 库替换 api 层全局 storage（与 test_api.py 同口径）。"""
    from app.storage.db import Storage
    s = Storage(str(tmp_path / 'test.db'))
    s.init()
    import app.api.rooms as rooms_api
    monkeypatch.setattr(rooms_api, 'storage', s)
    return s


def test_classic_reserved_seat_skips_human_and_clearing_frees_it(providers):
    room = rooms.create('RES-C', mode='east', capacity=4,
                        ruleset_id='lotus-classic', pace=0, llm_enabled=True)
    assert room.join_or_rejoin('甲', None, 'p1')[0] == 0
    room.set_reserved_seat(1, 'kimi', '高冷')
    assert room.join_or_rejoin('乙', None, 'p2')[0] == 2, '预留座应被真人跳过'
    assert room.join_or_rejoin('丙', None, 'p3')[0] == 3
    # 真人没占满 capacity=4，但只剩预留座 → 专用错误码
    with pytest.raises(RoomError) as blocked:
        room.join_or_rejoin('丁', None, 'p4')
    assert str(blocked.value) == 'SEATS_RESERVED'
    # 房主改回「自动选择」= 取消预留 → 真人立刻能占该座
    room.set_reserved_seat(1, None)
    assert room.reserved_seats == {}
    assert room.join_or_rejoin('丁', None, 'p4')[0] == 1


def test_classic_reserved_seat_rejects_occupied_and_out_of_range(providers):
    room = rooms.create('RES-C2', mode='east', capacity=4,
                        ruleset_id='lotus-classic', pace=0, llm_enabled=True)
    room.join_or_rejoin('甲', None, 'p1')
    with pytest.raises(RoomError) as occupied:
        room.set_reserved_seat(0, 'kimi')
    assert str(occupied.value) == 'SEAT_OCCUPIED'   # 真人座位不给预留
    with pytest.raises(RoomError) as invalid:
        room.set_reserved_seat(4, 'kimi')
    assert str(invalid.value) == 'INVALID_SEAT'


def test_blood_flow_reserved_seat_skips_human_and_uses_reserved_provider(providers):
    room = rooms.create('RES-BF', mode='east', capacity=4,
                        ruleset_id='lotus-blood-flow', pace=0, llm_enabled=True)
    assert room.join_or_rejoin('甲', None, 'p1')[0] == 0
    room.set_reserved_seat(1, 'kimi', '高冷')
    assert room.join_or_rejoin('乙', None, 'p2')[0] == 2
    room._resolve_llm_seats([], 'ds')
    assert room.llm_seats[1].api_key == 'sk-kimi'
    assert room.llm_seats[1].style == '高冷'
    assert room._seat_identity[1]['name'] == '小K（高冷）'
    assert 0 not in room.llm_seats          # 真人座位不派大模型
    assert room.llm_seats[3].api_key == 'sk-ds'   # 未预留空位仍走默认提供商
    # 取消预留 → 该座回落默认提供商
    room.set_reserved_seat(1, None)
    room._resolve_llm_seats([], 'ds')
    assert room.llm_seats[1].api_key == 'sk-ds'


@pytest.mark.asyncio
async def test_reserve_endpoint_blocks_humans_and_start_uses_reserved_model(
        server, fresh_rooms, providers, temp_storage):
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        http.cookies.set('lgm_wakudemo_session', 'p-1')
        room_id = (await http.post('/api/rooms',
                                   json={'capacity': 4, 'llmEnabled': True})).json()['roomId']
        host = (await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '房主'})).json()
        assert host['seat'] == 0
        # 未知提供商 → 拒绝（key 与 id 一并校验）
        bad = await http.post(f'/api/rooms/{room_id}/llm-seats', json={
            'seat': 0, 'rejoinCode': host['rejoinCode'], 'reserveSeat': 1, 'providerId': 'ghost'})
        assert bad.status_code == 409
        assert bad.json()['detail']['code'] == 'INVALID_LLM_SEATS'
        # 房主为第 2 座显式选择模型 = 预留
        resp = await http.post(f'/api/rooms/{room_id}/llm-seats', json={
            'seat': 0, 'rejoinCode': host['rejoinCode'], 'reserveSeat': 1,
            'providerId': 'kimi', 'style': '高冷'})
        assert resp.status_code == 200, resp.text
        assert resp.json()['reservedSeats'] == RESERVED_1
        assert 'sk-kimi' not in resp.text
        info = (await http.get(f'/api/rooms/{room_id}')).json()
        assert info['reservedSeats'] == RESERVED_1
        # 真人加入跳过预留座，落到下一个空座
        http.cookies.set('lgm_wakudemo_session', 'p-2')
        second = (await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '乙'})).json()
        assert second['seat'] == 2
        # 非房主不能改预留
        forbid = await http.post(f'/api/rooms/{room_id}/llm-seats', json={
            'seat': 2, 'rejoinCode': second['rejoinCode'], 'reserveSeat': 1, 'providerId': 'ds'})
        assert forbid.status_code == 403
        assert forbid.json()['detail']['code'] == 'NOT_CREATOR'
        # 真人已占的座位不能预留（不存在「把真人挤走」的语义）
        occupied = await http.post(f'/api/rooms/{room_id}/llm-seats', json={
            'seat': 0, 'rejoinCode': host['rejoinCode'], 'reserveSeat': 2, 'providerId': 'ds'})
        assert occupied.status_code == 409
        assert occupied.json()['detail']['code'] == 'SEAT_OCCUPIED'
        http.cookies.set('lgm_wakudemo_session', 'p-3')
        third = (await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '丙'})).json()
        assert third['seat'] == 3
        # 第四个真人：真人没占满但只剩预留座 → SEATS_RESERVED
        http.cookies.set('lgm_wakudemo_session', 'p-4')
        blocked = await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '丁'})
        assert blocked.status_code == 409
        assert blocked.json()['detail']['code'] == 'SEATS_RESERVED'
        # 全员准备 → 开局：预留座（1）装配 kimi，其余空位无（0/2/3 都是真人）
        for seat, code in ((0, host['rejoinCode']), (2, second['rejoinCode']),
                           (3, third['rejoinCode'])):
            ready = await http.post(f'/api/rooms/{room_id}/ready',
                                    json={'seat': seat, 'rejoinCode': code})
            assert ready.status_code == 200
        started = await http.post(f'/api/rooms/{room_id}/start', json={})
        assert started.status_code == 200, started.text
        room = rooms.get(room_id)
        controllers = room.manager.controllers
        assert [type(item).__name__ for item in controllers] == [
            'RemotePlayer', 'LLMPlayer', 'RemotePlayer', 'RemotePlayer']
        assert controllers[1].config.api_key == 'sk-kimi'
        assert controllers[1].config.style == '高冷'
        seeds = room._seeds()
        assert seeds[1]['name'] == '小K（高冷）'
        assert seeds[1]['playerKind'] == 'llm'


@pytest.mark.asyncio
async def test_clearing_reservation_lets_human_take_that_seat_at_start(
        server, fresh_rooms, providers, temp_storage):
    """取消预留后真人可以占该座，且开局按入参（此处为空）装配：空位走默认提供商。"""
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        http.cookies.set('lgm_wakudemo_session', 'q-1')
        room_id = (await http.post('/api/rooms',
                                   json={'capacity': 4, 'llmEnabled': True})).json()['roomId']
        host = (await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '房主'})).json()
        reserve = await http.post(f'/api/rooms/{room_id}/llm-seats', json={
            'seat': 0, 'rejoinCode': host['rejoinCode'], 'reserveSeat': 1, 'providerId': 'kimi'})
        assert reserve.status_code == 200
        # 省略 providerId = 取消预留
        cleared = await http.post(f'/api/rooms/{room_id}/llm-seats', json={
            'seat': 0, 'rejoinCode': host['rejoinCode'], 'reserveSeat': 1})
        assert cleared.status_code == 200
        assert cleared.json()['reservedSeats'] == []
        assert rooms.get(room_id).reserved_seats == {}
        http.cookies.set('lgm_wakudemo_session', 'q-2')
        second = (await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '乙'})).json()
        assert second['seat'] == 1, '取消预留后真人应能占回第 2 座'
        for seat, code in ((0, host['rejoinCode']), (1, second['rejoinCode'])):
            ready = await http.post(f'/api/rooms/{room_id}/ready',
                                    json={'seat': seat, 'rejoinCode': code})
            assert ready.status_code == 200
        started = await http.post(f'/api/rooms/{room_id}/start', json={})
        assert started.status_code == 200, started.text
        room = rooms.get(room_id)
        controllers = room.manager.controllers
        assert [type(item).__name__ for item in controllers] == [
            'RemotePlayer', 'RemotePlayer', 'LLMPlayer', 'LLMPlayer']
        assert controllers[2].config.api_key == 'sk-ds'   # 未预留 → 服务端默认提供商
        assert controllers[3].config.api_key == 'sk-ds'


@pytest.mark.asyncio
async def test_reserve_endpoint_works_for_blood_flow_room(
        server, fresh_rooms, providers, temp_storage):
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        http.cookies.set('lgm_wakudemo_session', 'b-1')
        room_id = (await http.post('/api/rooms', json={
            'capacity': 4, 'llmEnabled': True,
            'rulesetId': 'lotus-blood-flow'})).json()['roomId']
        host = (await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '房主'})).json()
        assert host['seat'] == 0
        resp = await http.post(f'/api/rooms/{room_id}/llm-seats', json={
            'seat': 0, 'rejoinCode': host['rejoinCode'], 'reserveSeat': 1, 'providerId': 'ds'})
        assert resp.status_code == 200, resp.text
        assert resp.json()['reservedSeats'] == [{'seat': 1, 'providerId': 'ds', 'style': None}]
        assert rooms.get(room_id).reserved_seats == {1: {'providerId': 'ds', 'style': ''}}
        http.cookies.set('lgm_wakudemo_session', 'b-2')
        second = (await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '乙'})).json()
        assert second['seat'] == 2, '血流房间同契约：真人跳过预留座'


class OfflineLlmPlayer(LLMPlayer):
    """全程不触网的 LLMPlayer：_decide 恒回退启发式（真类的既有 fallback 路径）。

    终局用例要真实打完整场到 finished；测试注册表里的 provider 是假 key，
    真 LLMPlayer 会逐决策发起注定失败的 HTTP 请求。装配（config/provider_id/
    isinstance）与真类完全一致，仅决策走 AIPlayer 启发式，够把整场打完。
    """

    async def _decide(self, built, ctx):
        return None


@pytest.mark.asyncio
async def test_reserve_endpoint_allows_changes_after_match_finished(
        server, fresh_rooms, providers, temp_storage, monkeypatch):
    """终局（finished）允许改/清预留：前端在整场结束后放开空位模型编辑入口，接口不得拒绝。

    状态闸在共享 REST 端点（rooms.py reserve_llm_seat）：lobby/finished 放行、
    playing 拒绝 ROOM_CLOSED，经典/血流房间同一口径。本用例用经典房间真实打完
    一整场，并断言终局改的预留对下一场生效（重开按房间级预留兜底装配）。
    """
    monkeypatch.setattr(room_module, 'LLMPlayer', OfflineLlmPlayer)
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        http.cookies.set('lgm_wakudemo_session', 'f-1')
        room_id = (await http.post('/api/rooms',
                                   json={'capacity': 4, 'llmEnabled': True})).json()['roomId']
        host = (await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '房主'})).json()
        assert host['seat'] == 0
        room = rooms.get(room_id)
        room.pace = {}   # 跳过真人节奏：本用例需要当场把整场打完
        ready = await http.post(f'/api/rooms/{room_id}/ready',
                                json={'seat': 0, 'rejoinCode': host['rejoinCode'], 'ready': True})
        assert ready.status_code == 200
        started = await http.post(f'/api/rooms/{room_id}/start', json={})
        assert started.status_code == 200, started.text
        assert room.status == 'playing'
        # 对局中：前端编辑入口关闭，接口同口径拒绝（状态闸先于座位校验）
        playing = await http.post(f'/api/rooms/{room_id}/llm-seats', json={
            'seat': 0, 'rejoinCode': host['rejoinCode'], 'reserveSeat': 1, 'providerId': 'kimi'})
        assert playing.status_code == 409
        assert playing.json()['detail']['code'] == 'ROOM_CLOSED'
        # 打完整场 → 终局（空位由 OfflineLlmPlayer 补位，房主座位断线 AI 托管）
        # 120s 上限与 test_blood_flow_room 全机器人整场同口径：冷启动/负载高时 60s 不够。
        await wait_until(lambda: room.status == 'finished', timeout=120)
        info = (await http.get(f'/api/rooms/{room_id}')).json()
        assert info['status'] == 'finished' and info['matchFinished'] is True
        # 终局写预留 → 接受（前端「终局可调整提供商」入口不能被拒）
        resp = await http.post(f'/api/rooms/{room_id}/llm-seats', json={
            'seat': 0, 'rejoinCode': host['rejoinCode'], 'reserveSeat': 1,
            'providerId': 'kimi', 'style': '高冷'})
        assert resp.status_code == 200, resp.text
        assert resp.json()['reservedSeats'] == RESERVED_1
        assert (await http.get(f'/api/rooms/{room_id}')).json()['reservedSeats'] == RESERVED_1
        # 终局清预留 → 接受，且与大厅同契约：真人立刻能占回该座（finished 房可加入）
        cleared = await http.post(f'/api/rooms/{room_id}/llm-seats', json={
            'seat': 0, 'rejoinCode': host['rejoinCode'], 'reserveSeat': 1})
        assert cleared.status_code == 200
        assert cleared.json()['reservedSeats'] == []
        http.cookies.set('lgm_wakudemo_session', 'f-2')
        second = (await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '乙'})).json()
        assert second['seat'] == 1, '终局清预留后真人应能占回该座'
        # 非房主在终局同样不能改预留（身份校验不随终局放松）
        forbid = await http.post(f'/api/rooms/{room_id}/llm-seats', json={
            'seat': 1, 'rejoinCode': second['rejoinCode'], 'reserveSeat': 2, 'providerId': 'ds'})
        assert forbid.status_code == 403
        assert forbid.json()['detail']['code'] == 'NOT_CREATOR'
        # 房主再写预留 → 重开一局：不带 llmSeats 入参也要按房间级预留装配（终局改动生效）
        again = await http.post(f'/api/rooms/{room_id}/llm-seats', json={
            'seat': 0, 'rejoinCode': host['rejoinCode'], 'reserveSeat': 2,
            'providerId': 'kimi', 'style': '高冷'})
        assert again.status_code == 200
        assert again.json()['reservedSeats'] == [{'seat': 2, 'providerId': 'kimi', 'style': '高冷'}]
        for seat, code in ((0, host['rejoinCode']), (1, second['rejoinCode'])):
            ready = await http.post(f'/api/rooms/{room_id}/ready',
                                    json={'seat': seat, 'rejoinCode': code, 'ready': True})
            assert ready.status_code == 200
        rematch = await http.post(f'/api/rooms/{room_id}/start', json={})
        assert rematch.status_code == 200, rematch.text
        controllers = room.manager.controllers
        assert [type(item).__name__ for item in controllers[:2]] == [
            'RemotePlayer', 'RemotePlayer']
        assert isinstance(controllers[2], LLMPlayer)
        assert controllers[2].config.api_key == 'sk-kimi'   # 终局改的预留给下一场装配
        assert controllers[2].config.style == '高冷'
        assert isinstance(controllers[3], LLMPlayer)
        assert controllers[3].config.api_key == 'sk-ds'     # 未预留空位仍走默认提供商
