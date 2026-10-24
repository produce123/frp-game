"""REST API 集成测试 —— 房间生命周期 + 战绩落库

对应开发计划 Phase 6 验收：
- 房间生命周期完整：创建 → 加入 → 准备 → 开局 → 结算 → 战绩落库
- 对局结束后可查询历史战绩与牌谱
- 并发创建/加入房间无竞态（房间 ID 唯一，座位互斥）

storage 用临时 SQLite 库（monkeypatch），避免污染默认库文件。
start 走 REST（uvicorn 事件循环），对局 AI 补位自动打完。
"""

import asyncio
import json
import time
from types import SimpleNamespace

import httpx
import pytest

from app.game.room import room_registry as rooms


@pytest.fixture()
def temp_storage(tmp_path, monkeypatch):
    """临时 SQLite 库，替换 api 层全局 storage（写盘隔离）。"""
    from app.storage.db import Storage
    s = Storage(str(tmp_path / 'test.db'))
    s.init()
    import app.api.rooms as rooms_api
    import app.api.matches as matches_api
    import app.api.moderation as moderation_api
    monkeypatch.setattr(rooms_api, 'storage', s)
    monkeypatch.setattr(matches_api, 'storage', s)
    monkeypatch.setattr(moderation_api, 'storage', s)
    return s


@pytest.mark.asyncio
async def test_tts_cached_audio_endpoint(server, tmp_path, monkeypatch):
    from app.tts.cache import TtsDiskCache

    cache = TtsDiskCache(tmp_path / 'tts-cache', 16 * 1024 * 1024, 30)
    key = 'a' * 64
    await cache.put(
        key, b'ID3-audio', provider='baidu', voice_id='0',
        style='稳健', text_hash='b' * 64)
    monkeypatch.setattr(
        'app.api.tts.get_tts_service',
        lambda: SimpleNamespace(cache=cache),
    )
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        response = await http.get(f'/api/tts/audio/{key}.mp3')
        assert response.status_code == 200
        assert response.headers['content-type'].startswith('audio/mpeg')
        assert response.content == b'ID3-audio'
        assert (await http.get('/api/tts/audio/not-a-key.mp3')).status_code == 404


@pytest.mark.asyncio
async def test_local_tts_gateway_validates_profile_and_returns_cached_audio_url(
        server, tmp_path, monkeypatch):
    from app.api.local_tts import reset_local_tts_rate_limit_for_tests
    from app.tts.cache import TtsDiskCache

    cache = TtsDiskCache(tmp_path / 'local-tts-cache', 16 * 1024 * 1024, 30)
    key = 'c' * 64
    await cache.put(
        key, b'ID3-local-audio', provider='baidu', voice_id='4196',
        style='高冷', text_hash='d' * 64)

    class FakeLocalTts:
        available = True
        rate_limit_per_minute = 60

        def __init__(self):
            self.cache = cache
            self.calls = []

        def normalize_voice_key(self, value):
            return value if value in {'deepseek', 'relay_gpt'} else None

        async def ensure_audio(self, text, voice_key, style, cache_identity=''):
            self.calls.append((text, voice_key, style, cache_identity))
            return SimpleNamespace(cache_key=key, cached=True)

    service = FakeLocalTts()
    reset_local_tts_rate_limit_for_tests()
    monkeypatch.setattr('app.api.local_tts.get_local_tts_service', lambda: service)
    cache_identity = json.dumps([
        'llm-anime-fixed-tts', 1, 1, 'deepseek', 'chi', 'action',
        '这一手稳住。', 'deepseek', 'speaker', 'default', 'fallback', '稳健',
    ], ensure_ascii=False, separators=(',', ':'))
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        response = await http.post('/api/local-tts/synthesize', json={
            'text': '这一手稳住。', 'voiceKey': 'deepseek', 'style': '稳健',
            'cacheIdentity': cache_identity,
        })
        assert response.status_code == 200
        assert response.json() == {
            'cacheKey': key,
            'audioUrl': f'/api/local-tts/audio/{key}.mp3',
            'cached': True,
        }
        assert service.calls == [('这一手稳住。', 'deepseek', '稳健', cache_identity)]
        audio = await http.get(f'/api/local-tts/audio/{key}.mp3')
        assert audio.status_code == 200
        assert audio.content == b'ID3-local-audio'
        denied = await http.post('/api/local-tts/synthesize', json={
            'text': '测试。', 'voiceKey': 'unknown', 'style': '稳健',
        })
        assert denied.status_code == 400
        invalid_cache = await http.post('/api/local-tts/synthesize', json={
            'text': '测试。', 'voiceKey': 'deepseek', 'style': '稳健',
            'cacheIdentity': 'arbitrary-cache-split',
        })
        assert invalid_cache.status_code == 422
        # 版本段递增必须继续被接受：硬编码具体版本号会让新版前端整体 422（2026-09-19 实测踩到）。
        bumped = json.dumps([
            'llm-anime-fixed-tts', 1, 2, 'deepseek', 'chi', 'action',
            '这一手稳住。', 'deepseek', 'speaker', 'default', 'fallback', '稳健',
        ], ensure_ascii=False, separators=(',', ':'))
        bumped_response = await http.post('/api/local-tts/synthesize', json={
            'text': '这一手稳住。', 'voiceKey': 'deepseek', 'style': '稳健',
            'cacheIdentity': bumped,
        })
        assert bumped_response.status_code == 200
        for bad_identity in (
            json.dumps(['llm-anime-fixed-tts', 0, 1] + [None] * 9),        # 版本不是正整数
            json.dumps(['llm-anime-fixed-tts', 1, '1'] + [None] * 9),      # 版本是字符串
            json.dumps(['llm-anime-fixed-tts', True, 1] + [None] * 9),     # 布尔不是版本
            json.dumps(['other-marker', 1, 1] + [None] * 9),               # 非约定标记
            json.dumps(['llm-anime-fixed-tts', 1, 1]),                     # 段数不足
        ):
            rejected = await http.post('/api/local-tts/synthesize', json={
                'text': '测试。', 'voiceKey': 'deepseek', 'style': '稳健',
                'cacheIdentity': bad_identity,
            })
            assert rejected.status_code == 422
        too_long = await http.post('/api/local-tts/synthesize', json={
            'text': '太' * 31, 'voiceKey': 'deepseek', 'style': '稳健',
        })
        assert too_long.status_code == 422


@pytest.mark.asyncio
async def test_local_tts_gateway_allows_local_dev_and_vibehub_origins(server):
    async with httpx.AsyncClient(base_url=server['http'], trust_env=False) as http:
        # gamesvibe.app 是平台当前域名（2026-09-14 起旧域名 lumigrav.space 彻底弃用）。
        # 不含它时大模型主题的 TTS 会被 CORS 拦掉，表现为"没有语音"。
        for origin in ('http://127.0.0.1:5181', 'https://gamesvibe.app', 'https://play.gamesvibe.app'):
            response = await http.options('/api/local-tts/synthesize', headers={
                'Origin': origin,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type',
            })
            assert response.status_code == 200
            assert response.headers['access-control-allow-origin'] == origin
        # 旧域名与相似域必须被拦（避免正则写成 contains 式误放行）。
        for origin in ('https://notgamesvibe.app', 'https://room.lumigrav.space'):
            blocked = await http.options('/api/local-tts/synthesize', headers={
                'Origin': origin,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type',
            })
            assert 'access-control-allow-origin' not in blocked.headers


async def wait_until(cond, timeout=30.0, interval=0.05) -> None:
    """轮询等待条件成立（跨线程读 room 状态时用）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return
        await asyncio.sleep(interval)
    raise AssertionError(f'等待超时（{timeout}s）: 条件未成立')


class _FlakyStorage:
    """真实存储包装：前 fail_until 次 insert_round_result 抛错后恢复（模拟落库抖动）。"""

    def __init__(self, real, fail_until: int):
        self._real = real
        self._fail_until = fail_until
        self.fail_count = 0

    def __getattr__(self, name):
        return getattr(self._real, name)

    def insert_round_result(self, match_id, round_data):
        if self.fail_count < self._fail_until:
            self.fail_count += 1
            raise RuntimeError('模拟落库故障')
        return self._real.insert_round_result(match_id, round_data)


# ─── 创建 / 查询 ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_and_get_room(server, fresh_rooms, temp_storage):
    async with httpx.AsyncClient(base_url=server['http']) as http:
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 4})
        assert resp.status_code == 200
        data = resp.json()
        room_id = data['roomId']
        assert len(room_id) == 6
        assert data['mode'] == 'east'
        assert data['capacity'] == 4
        assert data['status'] == 'lobby'
        assert data['seats'] == [None, None, None, None]  # 4 个空座
        # 场次身份（契约 C）：未开局 → 无场次、未结束、phase 回退房间 status
        assert data['matchId'] is None
        assert data['matchFinished'] is False
        assert data['phase'] == 'lobby'

        # GET 房间信息
        resp = await http.get(f'/api/rooms/{room_id}')
        assert resp.status_code == 200
        detail = resp.json()
        assert detail['roomId'] == room_id
        assert detail['matchId'] is None
        assert detail['matchFinished'] is False
        assert detail['phase'] == 'lobby'

        # 未知房间 → 404
        resp = await http.get('/api/rooms/ZZZZZZ')
        assert resp.status_code == 404
        assert resp.json()['detail']['code'] == 'ROOM_NOT_FOUND'


@pytest.mark.asyncio
async def test_room_count_limit(server, fresh_rooms, temp_storage):
    """本服务器最多 4 个房间：第 5 个创建 → 409 ROOM_LIMIT_REACHED。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        created = []
        for _ in range(4):
            resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2})
            assert resp.status_code == 200, resp.text
            created.append(resp.json()['roomId'])
        assert len(set(created)) == 4

        # 第 5 个 → 房间已满
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2})
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'ROOM_LIMIT_REACHED'


@pytest.mark.asyncio
async def test_dead_task_playing_room_is_stuck_until_swept(server, fresh_rooms, temp_storage):
    """僵尸对局房（playing + 任务已死）：close / start 双双 409，sweep 后解冻。

    这正是 2026-09-20 事故里后端那一半：房间卡在 playing，玩家无法关闭房间
    （ROOM_PLAYING）、也无法重开（ROOM_CLOSED），并长期占用房间槽位。
    """
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        joined = (await http.post(f'/api/rooms/{room_id}/join',
                                  json={'nickname': '甲'})).json()
        seat_action = {'seat': joined['seat'], 'rejoinCode': joined['rejoinCode']}

        room = rooms.get(room_id)
        assert room is not None
        # 造僵尸：status=playing 但没有任何驱动任务能推进这场对局
        room.status = 'playing'
        room.game_task = None

        # 两条路都堵死（都是 409，但错误码不同）
        resp = await http.request('DELETE', f'/api/rooms/{room_id}', json=seat_action)
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'ROOM_PLAYING'
        resp = await http.post(f'/api/rooms/{room_id}/start')
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'ROOM_CLOSED'
        # 房间也不会被 TTL 回收（playing 豁免）——只能靠看门狗那条通道
        assert rooms.sweep_expired() == []

        # 看门狗口径（REST 线程池：allow_cancel=False）→ 僵尸被强制收尾
        assert rooms.sweep_stalled() == [room_id]
        assert room.status == 'finished'

        # close 恢复可用（此前永久 409 ROOM_PLAYING）
        resp = await http.request('DELETE', f'/api/rooms/{room_id}', json=seat_action)
        assert resp.status_code == 200, resp.text
        assert resp.json()['closed'] is True
        assert rooms.get(room_id) is None


@pytest.mark.asyncio
async def test_create_room_reclaims_overdue_zombie_rooms(server, fresh_rooms, temp_storage):
    """建房时顺带回收「过期 + 僵尸」房：否则槽位被占满，玩家看到「房间已满」而实际没有活房间。"""
    import time as _time

    async with httpx.AsyncClient(base_url=server['http']) as http:
        # 灌满 4 个房间，全部打成「过期僵尸」：playing 豁免 TTL，没有任务能推进
        for _ in range(4):
            room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
            room = rooms.get(room_id)
            room.status = 'playing'
            room.game_task = None
            room.deadline = _time.monotonic() - 1

        # 第 5 个建房：先拍掉僵尸房、再按 TTL 回收释放槽位 → 成功而不是 ROOM_LIMIT_REACHED
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2})
        assert resp.status_code == 200, resp.text
        assert len(resp.json()['roomId']) == 6


@pytest.mark.asyncio
async def test_room_meta_count(server, fresh_rooms, temp_storage, monkeypatch):
    """GET /api/rooms/meta 返回在册房间数与上限，随建房递增（大厅「剩余房间」数据源）。

    llmAvailable 为服务端能力探测：本用例 monkeypatch 为 False 保证与开发机
    backend/.env（可能已配置 LLM）无关。
    """
    monkeypatch.setattr('app.api.rooms.llm_server_available', lambda: False)
    monkeypatch.setattr('app.api.rooms.load_llm_providers', lambda: {})
    async with httpx.AsyncClient(base_url=server['http']) as http:
        resp = await http.get('/api/rooms/meta')
        assert resp.status_code == 200
        assert resp.json() == {'active': 0, 'max': 4, 'llmAvailable': False, 'llmProviders': []}

        for _ in range(2):
            resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2})
            assert resp.status_code == 200, resp.text
        resp = await http.get('/api/rooms/meta')
        assert resp.json() == {'active': 2, 'max': 4, 'llmAvailable': False, 'llmProviders': []}


@pytest.mark.asyncio
async def test_create_rejected_when_player_in_room(server, fresh_rooms, temp_storage):
    """已在房间占座的登录身份再创建房间 → 409 ALREADY_IN_ROOM；离房后可再建。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room1 = (await http.post('/api/rooms', json={'mode': 'east', 'capacity': 4})).json()['roomId']
        http.cookies.set('lgm_wakudemo_session', 'guest-A')
        join = (await http.post(f'/api/rooms/{room1}/join',
                                json={'nickname': '甲', 'playerId': 'guest-A'})).json()

        # 同一登录身份已在 room1 占座 → 再建新房被拒（playerId 字段已被忽略）
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 4, 'playerId': 'guest-A'})
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'ALREADY_IN_ROOM'

        # 未占座的其他身份可正常创建
        http.cookies.set('lgm_wakudemo_session', 'guest-B')
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 4, 'playerId': 'guest-B'})
        assert resp.status_code == 200

        # 离房后可再创建
        await http.post(f'/api/rooms/{room1}/leave',
                        json={'seat': join['seat'], 'rejoinCode': join['rejoinCode']})
        http.cookies.set('lgm_wakudemo_session', 'guest-A')
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 4, 'playerId': 'guest-A'})
        assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_join_rejected_when_player_in_another_room(server, fresh_rooms, temp_storage):
    """已在房间占座的登录身份加入另一个房间 → 409 ALREADY_IN_ROOM。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room1 = (await http.post('/api/rooms', json={'mode': 'east', 'capacity': 4})).json()['roomId']
        room2 = (await http.post('/api/rooms', json={'mode': 'east', 'capacity': 4})).json()['roomId']
        http.cookies.set('lgm_wakudemo_session', 'guest-A')
        await http.post(f'/api/rooms/{room1}/join', json={'nickname': '甲', 'playerId': 'guest-A'})

        resp = await http.post(f'/api/rooms/{room2}/join',
                               json={'nickname': '甲', 'playerId': 'guest-A'})
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'ALREADY_IN_ROOM'


@pytest.mark.asyncio
async def test_human_avatar_persists_ai_unchanged(server, fresh_rooms, temp_storage,
                                                  stub_avatar_fetch):
    """真人头像：首次进房从外部 API 取并落库（跨房间稳定）；AI 空座头像保持 PLAYER_SEED 不变。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2})).json()['roomId']
        joins = {}
        for nickname, pid in (('甲', 'guest-1'), ('乙', 'guest-2')):
            http.cookies.set('lgm_wakudemo_session', pid)
            resp = await http.post(f'/api/rooms/{room_id}/join',
                                   json={'nickname': nickname, 'playerId': pid})
            assert resp.status_code == 200, resp.text
            joins[nickname] = resp.json()

        seeds = rooms.get(room_id)._seeds()
        # 真人（0/1 座）：头像来自 stub 且各自不同；AI 空座（2/3）保持 PLAYER_SEED 固定
        assert seeds[0]['avatar'] == 'https://example.com/avatar/fake-1.jpg'
        assert seeds[1]['avatar'] == 'https://example.com/avatar/fake-2.jpg'
        assert seeds[2]['avatar'] == 'avatars/shisan.svg'
        assert seeds[3]['avatar'] == 'avatars/young-master.svg'
        assert stub_avatar_fetch['n'] == 2   # 只在首次进房取图

        # 持久化落库 + 跨房间复用（同一登录身份不再重新取图）。
        # 一人只能在一间房（ALREADY_IN_ROOM）：甲先离房（乙仍在座，原房间保留）后，
        # 甲才能用同一身份另开新房。
        assert temp_storage.get_player_avatar('wakudemo-guest-1') == 'https://example.com/avatar/fake-1.jpg'
        await http.post(f'/api/rooms/{room_id}/leave',
                        json={'seat': joins['甲']['seat'], 'rejoinCode': joins['甲']['rejoinCode']})
        http.cookies.set('lgm_wakudemo_session', 'guest-1')
        room2 = (await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2})).json()['roomId']
        await http.post(f'/api/rooms/{room2}/join', json={'nickname': '甲', 'playerId': 'guest-1'})
        seeds2 = rooms.get(room2)._seeds()
        assert seeds2[0]['avatar'] == 'https://example.com/avatar/fake-1.jpg'
        assert stub_avatar_fetch['n'] == 2   # 复用已存头像，未再取图


@pytest.mark.asyncio
async def test_join_leave_room(server, fresh_rooms, temp_storage):
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']

        # join 甲 → seat 0 + rejoinCode
        http.cookies.set('lgm_wakudemo_session', 'p-1')
        resp = await http.post(f'/api/rooms/{room_id}/join', json={
            'nickname': '甲', 'characterId': '  ＱＷＥＮ  ',
        })
        assert resp.status_code == 200
        join_a = resp.json()
        assert join_a['seat'] == 0
        assert join_a['rejoin'] is False
        assert join_a['characterId'] == 'qwen'
        assert len(join_a['rejoinCode']) == 9  # XXXX-XXXX

        # 乙加入 seat 1；非法角色不是协议错误，安全回退 DeepSeek。
        http.cookies.set('lgm_wakudemo_session', 'p-2')
        join_b = (await http.post(f'/api/rooms/{room_id}/join',
                                  json={'nickname': '乙', 'characterId': '../gpt'})).json()
        assert join_b['characterId'] == 'deepseek'

        # bounded string：过长值仍由请求模型拒绝。
        too_long = await http.post(f'/api/rooms/{room_id}/join', json={
            'nickname': '丙', 'characterId': 'q' * 65,
        })
        assert too_long.status_code == 422

        # 房间信息反映座位占用
        seats = (await http.get(f'/api/rooms/{room_id}')).json()['seats']
        assert seats[0] == {
            'seat': 0, 'nickname': '甲', 'characterId': 'qwen',
            'ready': False, 'connected': False,
        }
        assert seats[1] == {
            'seat': 1, 'nickname': '乙', 'characterId': 'deepseek',
            'ready': False, 'connected': False,
        }

        # 非房主（乙）leave 释放座位，房间保留
        resp = await http.post(f'/api/rooms/{room_id}/leave',
                               json={'seat': 1, 'rejoinCode': join_b['rejoinCode']})
        assert resp.status_code == 200
        seats = (await http.get(f'/api/rooms/{room_id}')).json()['seats']
        assert seats[0] is not None
        assert seats[1] is None


@pytest.mark.asyncio
async def test_full_room_rejects_join(server, fresh_rooms, temp_storage):
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        for idx, nickname in enumerate(('甲', '乙')):
            http.cookies.set('lgm_wakudemo_session', f'p-{idx + 1}')
            resp = await http.post(f'/api/rooms/{room_id}/join', json={'nickname': nickname})
            assert resp.status_code == 200, resp.text
        # 第三人 → ROOM_FULL
        http.cookies.set('lgm_wakudemo_session', 'p-3')
        resp = await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '丙'})
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'ROOM_FULL'


@pytest.mark.asyncio
async def test_join_rejects_duplicate_nickname(server, fresh_rooms, temp_storage):
    """昵称查重：房间内已有同名玩家占座 → NICKNAME_TAKEN。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        http.cookies.set('lgm_wakudemo_session', 'p-1')
        resp = await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '甲'})
        assert resp.status_code == 200
        # 同名再占（另一登录身份）→ 拒绝
        http.cookies.set('lgm_wakudemo_session', 'p-2')
        resp = await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '甲'})
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'NICKNAME_TAKEN'
        # 不同名可正常加入
        http.cookies.set('lgm_wakudemo_session', 'p-3')
        resp = await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '乙'})
        assert resp.status_code == 200


@pytest.mark.asyncio
async def test_creator_leave_in_lobby_keeps_room_and_transfers(server, fresh_rooms, temp_storage):
    """房主在非对局中离开 → 房间保留、房主顺延给下一座位（2026-09-10 用户决定）。

    此前「非对局中房主离开即解散」，会让前端「返回大厅」的暂离/退出误解散整间房。
    现在只有「全员离开」「房主显式关闭房间」「房间限时回收」才解散。
    """
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        http.cookies.set('lgm_wakudemo_session', 'p-1')
        join_a = (await http.post(f'/api/rooms/{room_id}/join',
                                  json={'nickname': '甲'})).json()
        http.cookies.set('lgm_wakudemo_session', 'p-2')
        join_b = (await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '乙'})).json()
        info = (await http.get(f'/api/rooms/{room_id}')).json()
        assert info['creatorSeat'] == 0

        # 房主（甲）在 lobby 离开 → 房间保留，房主顺延给乙
        resp = await http.post(f'/api/rooms/{room_id}/leave',
                               json={'seat': 0, 'rejoinCode': join_a['rejoinCode']})
        assert resp.status_code == 200
        info = (await http.get(f'/api/rooms/{room_id}')).json()
        assert info['creatorSeat'] == join_b['seat']

        # 最后一人离开 → 房间才解散
        resp = await http.post(f'/api/rooms/{room_id}/leave',
                               json={'seat': join_b['seat'], 'rejoinCode': join_b['rejoinCode']})
        assert resp.status_code == 200
        resp = await http.get(f'/api/rooms/{room_id}')
        assert resp.status_code == 404
        assert resp.json()['detail']['code'] == 'ROOM_NOT_FOUND'


@pytest.mark.asyncio
async def test_non_creator_leave_keeps_room(server, fresh_rooms, temp_storage):
    """非房主离开 → 房间保留、房主不变。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        http.cookies.set('lgm_wakudemo_session', 'p-1')
        await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '甲'})
        http.cookies.set('lgm_wakudemo_session', 'p-2')
        join_b = (await http.post(f'/api/rooms/{room_id}/join',
                                  json={'nickname': '乙'})).json()

        resp = await http.post(f'/api/rooms/{room_id}/leave',
                               json={'seat': join_b['seat'], 'rejoinCode': join_b['rejoinCode']})
        assert resp.status_code == 200
        info = (await http.get(f'/api/rooms/{room_id}')).json()
        assert info['creatorSeat'] == 0
        assert info['seats'][0] is not None
        assert info['seats'][1] is None


@pytest.mark.asyncio
async def test_creator_leave_during_match_keeps_room(server, fresh_rooms, temp_storage):
    """对局中房主离开 → 房间保留（AI 代打），房主转移给下一座位。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 4})).json()['roomId']
        joins = {}
        for idx, nickname in enumerate(('甲', '乙', '丙', '丁')):
            http.cookies.set('lgm_wakudemo_session', f'p-{idx + 1}')
            joins[nickname] = (await http.post(
                f'/api/rooms/{room_id}/join', json={'nickname': nickname})).json()
        room = rooms.get(room_id)
        assert room is not None
        # 模拟对局进行中（不真实开局，避免 pace={} 下对局秒结束的时序竞争）
        room.status = 'playing'

        # 房主（甲，seat 0）对局中离开 → 不散房（仍有其他玩家）
        resp = await http.post(f'/api/rooms/{room_id}/leave',
                               json={'seat': joins['甲']['seat'],
                                     'rejoinCode': joins['甲']['rejoinCode']})
        assert resp.status_code == 200
        assert rooms.get(room_id) is not None
        info = (await http.get(f'/api/rooms/{room_id}')).json()
        assert info['status'] == 'playing'
        assert info['creatorSeat'] != joins['甲']['seat']   # 房主已转移


@pytest.mark.asyncio
async def test_close_room_creator_only(server, fresh_rooms, temp_storage):
    """DELETE 房间：仅创建者可关；对局中拒绝；关闭后房间移除。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        http.cookies.set('lgm_wakudemo_session', 'p-1')
        join_a = (await http.post(f'/api/rooms/{room_id}/join',
                                  json={'nickname': '甲'})).json()
        http.cookies.set('lgm_wakudemo_session', 'p-2')
        join_b = (await http.post(f'/api/rooms/{room_id}/join',
                                  json={'nickname': '乙'})).json()

        # 非创建者（乙）关闭 → 403
        resp = await http.request('DELETE', f'/api/rooms/{room_id}',
                                  json={'seat': 1, 'rejoinCode': join_b['rejoinCode']})
        assert resp.status_code == 403
        assert resp.json()['detail']['code'] == 'NOT_CREATOR'

        # 创建者关闭 → 房间移除
        resp = await http.request('DELETE', f'/api/rooms/{room_id}',
                                  json={'seat': 0, 'rejoinCode': join_a['rejoinCode']})
        assert resp.status_code == 200
        assert resp.json()['closed'] is True
        assert rooms.get(room_id) is None
        resp = await http.get(f'/api/rooms/{room_id}')
        assert resp.status_code == 404


@pytest.mark.asyncio
async def test_close_room_rejected_while_playing(server, fresh_rooms, temp_storage):
    """对局中（playing）关闭房间 → ROOM_PLAYING。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        joins = {}
        for idx, nickname in enumerate(('甲', '乙')):
            http.cookies.set('lgm_wakudemo_session', f'p-{idx + 1}')
            joins[nickname] = (await http.post(
                f'/api/rooms/{room_id}/join', json={'nickname': nickname})).json()
        for join in joins.values():
            await http.post(f'/api/rooms/{room_id}/ready',
                            json={'seat': join['seat'], 'rejoinCode': join['rejoinCode']})
        room = rooms.get(room_id)
        room.pace = {}
        resp = await http.post(f'/api/rooms/{room_id}/start')
        assert resp.status_code == 200
        assert room.status == 'playing'

        resp = await http.request('DELETE', f'/api/rooms/{room_id}',
                                  json={'seat': joins['甲']['seat'],
                                        'rejoinCode': joins['甲']['rejoinCode']})
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'ROOM_PLAYING'


# ─── 准备 / 开局 ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_start_without_ready_rejected(server, fresh_rooms, temp_storage):
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        join_a = (await http.post(f'/api/rooms/{room_id}/join',
                                  json={'nickname': '甲'})).json()
        # 未 ready → start 拒绝
        resp = await http.post(f'/api/rooms/{room_id}/start')
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'NOT_ALL_READY'

        # ready 后 start 成功
        resp = await http.post(f'/api/rooms/{room_id}/ready',
                               json={'seat': 0, 'rejoinCode': join_a['rejoinCode']})
        assert resp.status_code == 200
        assert resp.json()['ready'] is True
        resp = await http.post(f'/api/rooms/{room_id}/start')
        assert resp.status_code == 200, resp.text

        # 重复 start → ALREADY_STARTED
        resp = await http.post(f'/api/rooms/{room_id}/start')
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'ALREADY_STARTED'


@pytest.mark.asyncio
async def test_start_with_per_seat_llm_providers(server, fresh_rooms, temp_storage, monkeypatch):
    """start 携带 llmSeats（providerId）：未知 id/重复座位 → 409 INVALID_LLM_SEATS；
    合法 id 装配到对应空位（LLMPlayer 各自 config + 种子显示名/头像）；响应不含 key。"""
    from app.game.llm_player import LLMPlayer
    from app.game.player import AIPlayer
    from app.llm.config import LlmProvider
    providers = {
        'ds': LlmProvider('ds', 'DeepSeek', 'https://api.deepseek.com/v1',
                          'sk-server-ds', 'deepseek-chat', '话痨'),
        'kimi': LlmProvider('kimi', 'Kimi', 'https://api.moonshot.cn/v1',
                            'sk-server-kimi', 'kimi-k2', '稳健', '小K'),
    }
    monkeypatch.setattr('app.api.rooms.load_llm_providers', lambda: providers)
    monkeypatch.setattr('app.api.rooms.llm_server_available', lambda: True)
    monkeypatch.setattr('app.game.room.load_llm_providers', lambda: providers)
    monkeypatch.setattr('app.game.room.llm_server_available', lambda: True)
    monkeypatch.setattr('app.api.rooms.default_provider_id', lambda: 'ds')
    async with httpx.AsyncClient(base_url=server['http']) as http:
        meta = (await http.get('/api/rooms/meta')).json()
        assert meta['llmAvailable'] is True
        public = {item['id']: item for item in meta['llmProviders']}
        assert set(public) == {'ds', 'kimi'}
        assert 'sk-server' not in str(meta)          # key 不下发
        assert public['kimi']['nickname'] == '小K'
        assert public['kimi']['avatar'] == 'img/llm/kimi/llm-avatar-wenjian.png'
        assert public['kimi']['styles'] == ['激进', '稳健', '话痨', '高冷']

        # 联机开关与单机设置完全独立：房间未显式启用时，开局不能靠 llmSeats 暗中开启。
        disabled_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        http.cookies.set('lgm_wakudemo_session', 'p-1')
        disabled_join = (await http.post(f'/api/rooms/{disabled_id}/join',
                                         json={'nickname': '乙'})).json()
        await http.post(f'/api/rooms/{disabled_id}/ready',
                        json={'seat': 0, 'rejoinCode': disabled_join['rejoinCode']})
        resp = await http.post(f'/api/rooms/{disabled_id}/start', json={
            'llmSeats': [{'seat': 1, 'providerId': 'ds'}]})
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'LLM_NOT_ENABLED'

        # 另一登录身份创建启用 LLM 的房间（身份 p-1 仍在上一房间占座）
        http.cookies.set('lgm_wakudemo_session', 'p-2')
        room_id = (await http.post('/api/rooms',
                                   json={'capacity': 2, 'llmEnabled': True})).json()['roomId']
        join_a = (await http.post(f'/api/rooms/{room_id}/join',
                                  json={'nickname': '甲'})).json()
        await http.post(f'/api/rooms/{room_id}/ready',
                        json={'seat': 0, 'rejoinCode': join_a['rejoinCode']})

        # 重复座位 → 409
        resp = await http.post(f'/api/rooms/{room_id}/start', json={'llmSeats': [
            {'seat': 1, 'providerId': 'ds'}, {'seat': 1, 'providerId': 'kimi'}]})
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'INVALID_LLM_SEATS'

        # 未知 providerId → 409
        resp = await http.post(f'/api/rooms/{room_id}/start',
                               json={'llmSeats': [{'seat': 1, 'providerId': 'ghost'}]})
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'INVALID_LLM_SEATS'

        # 合法：每个已配置模型都可按座位覆盖四种策略；座位 2 未指定 → 服务端默认。
        resp = await http.post(f'/api/rooms/{room_id}/start', json={'llmSeats': [
            {'seat': 1, 'providerId': 'ds', 'style': '激进'},
            {'seat': 3, 'providerId': 'kimi', 'style': '高冷'}]})
        assert resp.status_code == 200, resp.text
        assert 'sk-server' not in resp.text

        room = rooms.get(room_id)
        assert room.effective_llm_enabled is True
        controllers = room.manager.controllers
        assert isinstance(controllers[1], LLMPlayer)
        assert controllers[1].config.api_key == 'sk-server-ds'
        assert controllers[1].config.style == '激进'
        assert isinstance(controllers[3], LLMPlayer)
        assert controllers[3].config.api_key == 'sk-server-kimi'
        assert isinstance(controllers[2], LLMPlayer)
        assert controllers[2].config.api_key == 'sk-server-ds'   # 默认提供商
        seeds = room._seeds()
        assert controllers[3].config.style == '高冷'
        assert seeds[1]['name'] == '大肥鱼（激进）'
        assert seeds[1]['avatar'] == 'img/llm/deepseek/llm-avatar-jijin.png'
        assert seeds[3]['name'] == '小K（高冷）'
        assert seeds[3]['avatar'] == 'img/llm/kimi/llm-avatar-gaoleng.png'
        # 房间详情响应不含 key
        detail = await http.get(f'/api/rooms/{room_id}')
        assert detail.status_code == 200
        assert 'sk-server' not in detail.text


@pytest.mark.asyncio
async def test_room_lifecycle_persists_match(server, fresh_rooms, temp_storage):
    """创建 → 加入 ×2 → 准备 ×2 → 开局 → 对局打完 → 战绩落库可查询。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        joins = {}
        for idx, nickname in enumerate(('甲', '乙')):
            http.cookies.set('lgm_wakudemo_session', f'p-{idx + 1}')
            joins[nickname] = (await http.post(
                f'/api/rooms/{room_id}/join', json={'nickname': nickname})).json()

        # 准备
        for nickname, join in joins.items():
            resp = await http.post(f'/api/rooms/{room_id}/ready',
                                   json={'seat': join['seat'],
                                         'rejoinCode': join['rejoinCode']})
            assert resp.status_code == 200

        # 开局（客户端未连接，座位由 AI 托管，对局自动打完）
        room = rooms.get(room_id)
        assert room is not None and room.status == 'lobby'
        # REST 创建默认注入 PLAY_PACE（真人节奏）；本测试只验证落库链路，跳过节奏加速
        room.pace = {}
        resp = await http.post(f'/api/rooms/{room_id}/start')
        assert resp.status_code == 200, resp.text

        assert room.status == 'playing'
        await wait_until(lambda: room.status == 'finished', timeout=30)
        assert room.manager.match_finished
        assert room.match_id is not None

        # 场次身份（契约 C）：整场结束后 REST 必须能自证「已结束 + 是哪一场」
        detail = await http.get(f'/api/rooms/{room_id}')
        assert detail.status_code == 200
        assert detail.json()['matchFinished'] is True
        assert detail.json()['phase'] == 'finished'
        assert detail.json()['matchId'] == room.match_id

        # 战绩落库：房间对局列表
        resp = await http.get(f'/api/rooms/{room_id}/matches')
        assert resp.status_code == 200
        matches = resp.json()['matches']
        assert len(matches) == 1
        match_id = matches[0]['id']
        assert matches[0]['finalScores'] is not None

        # 单场详情：至少 1 局结算明细
        resp = await http.get(f'/api/matches/{match_id}')
        assert resp.status_code == 200
        detail = resp.json()
        assert detail['roomId'] == room_id
        assert len(detail['rounds']) >= 1
        first_round = detail['rounds'][0]['result']
        assert 'winner' in first_round
        # 存储格式（RoomSession._map_round_result）：分数流水 + 结算后分数
        assert 'deltas' in first_round
        assert 'scores_after' in first_round

        # 个人统计：参与玩家有场次记录
        for nickname in ('甲', '乙'):
            resp = await http.get(f'/api/players/{nickname}/stats')
            assert resp.status_code == 200
            stats = resp.json()
            assert stats['matches'] == 1
            assert stats['hands'] == len(detail['rounds'])

        # 未知对局 → 404
        resp = await http.get('/api/matches/does-not-exist')
        assert resp.status_code == 404
        assert resp.json()['detail']['code'] == 'MATCH_NOT_FOUND'


@pytest.mark.asyncio
async def test_db_outage_does_not_abort_match(server, fresh_rooms, temp_storage, monkeypatch):
    """落库失败不应中断整场：失败入队补写，对局照常打完且全部结算落库。"""
    flaky = _FlakyStorage(temp_storage, fail_until=1)
    import app.api.rooms as rooms_api
    monkeypatch.setattr(rooms_api, 'storage', flaky)

    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        joins = {}
        for idx, nickname in enumerate(('甲', '乙')):
            http.cookies.set('lgm_wakudemo_session', f'p-{idx + 1}')
            joins[nickname] = (await http.post(
                f'/api/rooms/{room_id}/join', json={'nickname': nickname})).json()
        for nickname, join in joins.items():
            resp = await http.post(f'/api/rooms/{room_id}/ready',
                                   json={'seat': join['seat'],
                                         'rejoinCode': join['rejoinCode']})
            assert resp.status_code == 200

        # 开局即注入故障存储：首局 insert_round_result 必失败（fail_until=1）
        room = rooms.get(room_id)
        assert room is not None and room.status == 'lobby'
        room.pace = {}
        resp = await http.post(f'/api/rooms/{room_id}/start')
        assert resp.status_code == 200, resp.text

        # 首局落库失败仍应打完对局，而不是进入 error 中断
        await wait_until(lambda: room.status == 'finished', timeout=30)
        assert room.manager.match_finished
        assert flaky.fail_count == 1

        # 失败的结算已随后续落库机会补写：全部局在库里（含东1局）
        resp = await http.get(f'/api/rooms/{room_id}/matches')
        matches = resp.json()['matches']
        assert len(matches) == 1
        detail = (await http.get(f'/api/matches/{matches[0]["id"]}')).json()
        assert len(detail['rounds']) >= 1
        assert '东1局' in [r['round'] for r in detail['rounds']]


@pytest.mark.asyncio
async def test_room_can_restart_after_match(server, fresh_rooms, temp_storage):
    """对局结束后房间保留（finished）且**准备态保留**，可以直接再开一局。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        joins = {}
        for idx, nickname in enumerate(('甲', '乙')):
            http.cookies.set('lgm_wakudemo_session', f'p-{idx + 1}')
            joins[nickname] = (await http.post(
                f'/api/rooms/{room_id}/join', json={'nickname': nickname})).json()
        room = rooms.get(room_id)
        assert room is not None
        room.pace = {}

        async def ready_and_start():
            for j in joins.values():
                # 显式 ready=true：准备态在一场结束后保留，toggle 会把已准备翻成未准备。
                resp = await http.post(f'/api/rooms/{room_id}/ready',
                                       json={'seat': j['seat'], 'rejoinCode': j['rejoinCode'],
                                             'ready': True})
                assert resp.status_code == 200
            resp = await http.post(f'/api/rooms/{room_id}/start')
            assert resp.status_code == 200, resp.text
            assert room.status == 'playing'
            await wait_until(lambda: room.game_task is not None and room.game_task.done(), timeout=30)
            assert room.status == 'finished'

        # 第一场
        await ready_and_start()
        assert rooms.get(room_id) is not None   # 房间保留，未被释放
        # 对局结束：准备态保留（2026-09-10 用户决定：不必全员重新点准备）
        assert all(s.ready is True for s in room.seats if s is not None)

        # 再开一局
        await ready_and_start()
        assert rooms.get(room_id) is not None

        # 两场均已落库
        resp = await http.get(f'/api/rooms/{room_id}/matches')
        assert resp.status_code == 200
        assert len(resp.json()['matches']) == 2


@pytest.mark.asyncio
async def test_non_creator_can_rejoin_finished_room(server, fresh_rooms, temp_storage):
    """对局结束后（finished）非房主离开后可重新加入房间（打下一场）。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        joins = {}
        for idx, nickname in enumerate(('甲', '乙')):
            http.cookies.set('lgm_wakudemo_session', f'p-{idx + 1}')
            joins[nickname] = (await http.post(
                f'/api/rooms/{room_id}/join', json={'nickname': nickname})).json()
        for j in joins.values():
            await http.post(f'/api/rooms/{room_id}/ready',
                            json={'seat': j['seat'], 'rejoinCode': j['rejoinCode']})
        room = rooms.get(room_id)
        assert room is not None
        room.pace = {}
        await http.post(f'/api/rooms/{room_id}/start')
        await wait_until(lambda: room.status == 'finished', timeout=30)

        # 非房主（乙）离房
        resp = await http.post(f'/api/rooms/{room_id}/leave',
                               json={'seat': joins['乙']['seat'],
                                     'rejoinCode': joins['乙']['rejoinCode']})
        assert resp.status_code == 200

        # 重新加入 finished 房间 → 放行，占回原空座
        http.cookies.set('lgm_wakudemo_session', 'p-2')
        resp = await http.post(f'/api/rooms/{room_id}/join', json={'nickname': '乙'})
        assert resp.status_code == 200, resp.text
        rejoin = resp.json()
        assert rejoin['rejoin'] is False
        assert rejoin['seat'] == joins['乙']['seat']
        assert rooms.get(room_id) is not None

        # 房主身份未被转移
        info = (await http.get(f'/api/rooms/{room_id}')).json()
        assert info['creatorSeat'] == joins['甲']['seat']


@pytest.mark.asyncio
async def test_all_leave_releases_room(server, fresh_rooms, temp_storage):
    """全员离开（非对局中）→ 房间立即释放，不占槽位。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        joins = {}
        for idx, nickname in enumerate(('甲', '乙')):
            http.cookies.set('lgm_wakudemo_session', f'p-{idx + 1}')
            joins[nickname] = (await http.post(
                f'/api/rooms/{room_id}/join', json={'nickname': nickname})).json()
        # 非房主先离 → 房间保留
        await http.post(f'/api/rooms/{room_id}/leave',
                        json={'seat': joins['乙']['seat'], 'rejoinCode': joins['乙']['rejoinCode']})
        assert rooms.get(room_id) is not None
        # 最后一人（此时已是房主）再离 → 房间解散
        await http.post(f'/api/rooms/{room_id}/leave',
                        json={'seat': joins['甲']['seat'], 'rejoinCode': joins['甲']['rejoinCode']})
        assert rooms.get(room_id) is None


@pytest.mark.asyncio
async def test_all_exit_mid_match_releases_room(server, fresh_rooms, temp_storage):
    """对局进行中全员退出 → 房间立即释放（不等到对局结束、不占槽位）。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        joins = {}
        for idx, nickname in enumerate(('甲', '乙')):
            http.cookies.set('lgm_wakudemo_session', f'p-{idx + 1}')
            joins[nickname] = (await http.post(
                f'/api/rooms/{room_id}/join', json={'nickname': nickname})).json()
        for j in joins.values():
            await http.post(f'/api/rooms/{room_id}/ready',
                            json={'seat': j['seat'], 'rejoinCode': j['rejoinCode']})
        room = rooms.get(room_id)
        assert room is not None
        room.pace = {}
        await http.post(f'/api/rooms/{room_id}/start')
        assert room.status == 'playing'

        # 全员退出（房主先退 → AI 代打房间保留；最后一人退 → 立即释放）
        for nickname in ('甲', '乙'):
            await http.post(f'/api/rooms/{room_id}/leave',
                            json={'seat': joins[nickname]['seat'],
                                  'rejoinCode': joins[nickname]['rejoinCode']})
        # 房间应立刻被释放（无论对局是否已打完），不等到 60 分钟 deadline
        assert rooms.get(room_id) is None


@pytest.mark.asyncio
async def test_expired_room_released_after_match(server, fresh_rooms, temp_storage):
    """对局中超过 60 分钟限时 → 等对局结束自动释放房间。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        joins = {}
        for idx, nickname in enumerate(('甲', '乙')):
            http.cookies.set('lgm_wakudemo_session', f'p-{idx + 1}')
            joins[nickname] = (await http.post(
                f'/api/rooms/{room_id}/join', json={'nickname': nickname})).json()
        for join in joins.values():
            await http.post(f'/api/rooms/{room_id}/ready',
                            json={'seat': join['seat'], 'rejoinCode': join['rejoinCode']})

        room = rooms.get(room_id)
        assert room is not None
        room.pace = {}
        # 模拟：对局已持续超过限时（deadline 拨到过去）
        room.deadline = time.monotonic() - 1
        resp = await http.post(f'/api/rooms/{room_id}/start')
        assert resp.status_code == 200, resp.text
        assert room.status == 'playing'

        # 对局结束后房间自动释放（不等待房主手动解散）
        await wait_until(lambda: rooms.get(room_id) is None, timeout=30)
        assert room.status == 'closed'


@pytest.mark.asyncio
async def test_stats_by_player_id(server, fresh_rooms, temp_storage):
    """按匿名身份（playerId / guestId）查战绩：身份锚点而非昵称。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        for nickname, pid in (('甲', 'guest-A'), ('乙', 'guest-B')):
            http.cookies.set('lgm_wakudemo_session', pid)
            j = (await http.post(f'/api/rooms/{room_id}/join',
                                 json={'nickname': nickname, 'playerId': pid})).json()
            await http.post(f'/api/rooms/{room_id}/ready',
                            json={'seat': j['seat'], 'rejoinCode': j['rejoinCode']})
        room = rooms.get(room_id)
        room.pace = {}
        await http.post(f'/api/rooms/{room_id}/start')
        await wait_until(lambda: room.status == 'finished', timeout=30)

        resp = await http.get('/api/players/by-id/wakudemo-guest-A/stats')
        assert resp.status_code == 200
        stats = resp.json()
        assert stats['playerId'] == 'wakudemo-guest-A'
        assert stats['matches'] == 1
        assert stats['hands'] >= 1

        # 登录身份战绩（/api/me/stats）：与 by-id 一致
        http.cookies.set('lgm_wakudemo_session', 'guest-A')
        me = await http.get('/api/me/stats')
        assert me.status_code == 200
        assert me.json()['playerId'] == 'wakudemo-guest-A'
        assert me.json()['matches'] == 1

        # guest-B 各算各的，不与 guest-A 混淆
        resp_b = await http.get('/api/players/by-id/wakudemo-guest-B/stats')
        assert resp_b.json()['matches'] == 1

        # 未参与过对局的 playerId → 全 0
        resp_c = await http.get('/api/players/by-id/guest-nobody/stats')
        assert resp_c.json()['matches'] == 0 and resp_c.json()['hands'] == 0


@pytest.mark.asyncio
async def test_stats_survive_leaving_room(server, fresh_rooms, temp_storage):
    """离房后战绩仍在：match_players 开局记录参赛身份（room_seats 离房即删，不能作战绩真源）。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        joins = {}
        for nickname, pid in (('甲', 'guest-A'), ('乙', 'guest-B')):
            http.cookies.set('lgm_wakudemo_session', pid)
            joins[nickname] = (await http.post(f'/api/rooms/{room_id}/join',
                                               json={'nickname': nickname, 'playerId': pid})).json()
        for j in joins.values():
            await http.post(f'/api/rooms/{room_id}/ready',
                            json={'seat': j['seat'], 'rejoinCode': j['rejoinCode']})
        room = rooms.get(room_id)
        room.pace = {}
        await http.post(f'/api/rooms/{room_id}/start')
        await wait_until(lambda: room.status == 'finished', timeout=30)
        # 对局结束后全部离房 → room_seats 行被删。
        # 先离非房主（乙），再离最后一人（甲）→ 房间即从注册表移除，
        # 其余玩家将无法再对该房间发请求。
        for j in reversed(list(joins.values())):
            await http.post(f'/api/rooms/{room_id}/leave',
                            json={'seat': j['seat'], 'rejoinCode': j['rejoinCode']})
        assert temp_storage._conn().execute(
            'SELECT COUNT(*) AS c FROM room_seats').fetchone()['c'] == 0
        # 战绩仍可查（match_players 持久，联机身份 wakudemo-<uid>）
        resp = await http.get('/api/players/by-id/wakudemo-guest-A/stats')
        stats = resp.json()
        assert stats['matches'] == 1 and stats['hands'] >= 1
        resp_b = await http.get('/api/players/by-id/wakudemo-guest-B/stats')
        assert resp_b.json()['matches'] == 1
