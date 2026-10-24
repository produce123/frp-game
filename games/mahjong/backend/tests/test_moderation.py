"""风控测试 —— 登录身份 playerId / 封禁 / 举报（Phase 8 P1，见开发计划 §10）

- join 落库 room_seats.player_id（联机身份 = wakudemo-<uid>，由登录会话推导）
- 被 ban 的 playerId：join 被拒（BANNED）；解封后恢复
- WS 重连握手同样查禁（resume_by_code）
- admin ban/unban 端点 + 举报端点（举报人由登录会话推导）
- 旧库迁移：无 player_id 列的房间表 init() 后补列
"""

import asyncio
import json
from urllib.parse import quote

import httpx
import pytest
import websockets
import websockets.asyncio.client

from tests.test_api import temp_storage  # noqa: F401 复用临时库 fixture
from app.game.room import room_registry as rooms


def ws_url(base_ws: str, room_id: str, code: str) -> str:
    return f'{base_ws}/ws/room/{room_id}?rejoin_code={quote(code)}'


async def read_until(ws, kind: str, timeout=8.0) -> dict:
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout)
        msg = json.loads(raw)
        if msg.get('kind') == kind:
            return msg


@pytest.mark.asyncio
async def test_join_carries_player_id(server, fresh_rooms, temp_storage):
    """join 按登录身份落库 room_seats.player_id（wakudemo-<uid>）。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        http.cookies.set('lgm_wakudemo_session', 'guest-abc123')
        resp = await http.post(f'/api/rooms/{room_id}/join',
                               json={'nickname': '甲', 'playerId': 'guest-abc123'})
        assert resp.status_code == 200
        assert resp.json()['playerId'] == 'wakudemo-guest-abc123'
        row = temp_storage._conn().execute(
            'SELECT player_id FROM room_seats WHERE room_id = ?', (room_id,)).fetchone()
        assert row['player_id'] == 'wakudemo-guest-abc123'


@pytest.mark.asyncio
async def test_banned_player_join_rejected(server, fresh_rooms, temp_storage):
    """被封禁的登录身份加入 → 409 BANNED；解封后恢复。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        await http.post('/api/admin/bans', json={
            'scope': 'player', 'target': 'wakudemo-guest-evil',
            'reason': '赌博引流', 'bannedBy': 'admin'})
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        http.cookies.set('lgm_wakudemo_session', 'guest-evil')
        resp = await http.post(f'/api/rooms/{room_id}/join',
                               json={'nickname': '赌徒', 'playerId': 'guest-evil'})
        assert resp.status_code == 409
        assert resp.json()['detail']['code'] == 'BANNED'
        # 解封后可加入
        await http.request('DELETE', '/api/admin/bans/player/wakudemo-guest-evil')
        resp = await http.post(f'/api/rooms/{room_id}/join',
                               json={'nickname': '赌徒', 'playerId': 'guest-evil'})
        assert resp.status_code == 200


@pytest.mark.asyncio
async def test_banned_player_ws_rejoin_rejected(server, fresh_rooms, temp_storage):
    """重连握手同样查禁：座位 player_id 被封 → rejoin_err BANNED。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        http.cookies.set('lgm_wakudemo_session', 'guest-rejoin')
        j = (await http.post(f'/api/rooms/{room_id}/join',
                             json={'nickname': '甲', 'playerId': 'guest-rejoin'})).json()
        # 封禁后，凭已签发重进码重连 → BANNED
        await http.post('/api/admin/bans', json={
            'scope': 'player', 'target': 'wakudemo-guest-rejoin'})
    ws = await websockets.asyncio.client.connect(
        ws_url(server['ws'], room_id, j['rejoinCode']))
    try:
        err = await read_until(ws, 'rejoin_err')
        assert err['code'] == 'BANNED'
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_report_endpoint(server, fresh_rooms, temp_storage):
    """举报端点写入 reports 表（举报人 = 登录身份 wakudemo-<uid>）。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        http.cookies.set('lgm_wakudemo_session', 'guest-good')
        resp = await http.post('/api/reports', json={
            'roomId': 'RPT1',
            'reporterPlayerId': 'guest-good',
            'targetPlayerId': 'guest-bad',
            'targetName': '老六',
            'reason': '对局中辱骂',
        })
        assert resp.status_code == 200
        row = temp_storage._conn().execute(
            'SELECT * FROM reports WHERE room_id = ?', ('RPT1',)).fetchone()
        assert row['reporter'] == 'wakudemo-guest-good'
        assert row['target'] == 'guest-bad'
        assert row['target_name'] == '老六'


@pytest.mark.asyncio
async def test_report_resolves_player_id_by_nickname(server, fresh_rooms, temp_storage):
    """举报只带昵称时，服务端按房间反查座位 player_id（便于封禁落地）。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        room_id = (await http.post('/api/rooms', json={'capacity': 2})).json()['roomId']
        http.cookies.set('lgm_wakudemo_session', 'guest-bad')
        await http.post(f'/api/rooms/{room_id}/join',
                        json={'nickname': '老六', 'playerId': 'guest-bad'})
        http.cookies.set('lgm_wakudemo_session', 'guest-good')
        resp = await http.post('/api/reports', json={
            'roomId': room_id,
            'reporterPlayerId': 'guest-good',
            'targetName': '老六',
            'reason': '作弊',
        })
        assert resp.status_code == 200
        row = temp_storage._conn().execute(
            'SELECT target FROM reports WHERE room_id = ?', (room_id,)).fetchone()
        assert row['target'] == 'wakudemo-guest-bad'   # 按昵称反查出被举报者 player_id


def test_room_seats_migration(tmp_path):
    """旧库迁移：已存在的 room_seats 表 init() 后补 player_id 列。"""
    from app.storage.db import Storage
    path = str(tmp_path / 'old.db')
    # 先建旧版表（无 player_id）
    import sqlite3
    conn = sqlite3.connect(path)
    conn.execute('CREATE TABLE room_seats (room_id TEXT, seat INTEGER, nickname TEXT, '
                 'rejoin_code TEXT, disconnected_at DATETIME, PRIMARY KEY (room_id, seat))')
    conn.commit()
    conn.close()
    # init() 触发迁移
    s = Storage(path)
    s.init()
    cols = {r[1] for r in s._conn().execute('PRAGMA table_info(room_seats)').fetchall()}
    assert 'player_id' in cols
    # 幂等：再次 init 不报错
    s.init()
