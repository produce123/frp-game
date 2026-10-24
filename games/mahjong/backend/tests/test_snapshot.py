"""state_snapshot 广播集成测试 —— Phase 7 前端对接的协议基础

验证 GameManager 在每个状态变更后广播 per-seat 快照：
1. 回合请求（turn_request）之前必然收到 state_snapshot（客户端先拿到手牌再决策）
2. 快照中本人手牌可见、他人手牌隐藏（null 占位）
3. 弃牌后快照带 lastDiscard；结算后快照带 result + winPresentation
"""

import asyncio
import json
from urllib.parse import quote

import httpx
import pytest
import websockets
import websockets.asyncio.client  # noqa: F401

from app.game.room import room_registry as rooms


async def prepare_room(room_id: str, capacity: int, nicknames: list,
                       mode: str = 'east', turn_timeout: float = 5.0,
                       ruleset_id: str = 'lotus-classic'):
    """建房间 + join + ready（不 start），返回 (room, {nickname: rejoin_code})。"""
    room = rooms.create(
        room_id, mode=mode, capacity=capacity, turn_timeout=turn_timeout,
        ruleset_id=ruleset_id,
    )
    codes = {}
    for nickname in nicknames:
        seat, _, state = room.join_or_rejoin(nickname)
        room.ready_seat(seat)
        codes[nickname] = state.rejoin_code
    return room, codes


def ws_url(base: str, room_id: str, rejoin_code: str) -> str:
    return f'{base}/ws/room/{room_id}?rejoin_code={quote(rejoin_code)}'


async def ws_connect(base: str, room_id: str, rejoin_code: str):
    """模块级共享 uvicorn：上个测试残留的对局任务收尾可能短暂占用事件循环，
    握手超时放宽到 30s，避免时序抖动误伤（健康路径毫秒级完成）。"""
    return await websockets.asyncio.client.connect(
        ws_url(base, room_id, rejoin_code), open_timeout=30)


async def recv_json(ws, timeout=8.0) -> dict:
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def safe_close(ws) -> None:
    if ws is not None:
        try:
            await ws.close()
        except Exception:
            pass


async def collect_until(ws, kinds: set, timeout=20.0) -> list[dict]:
    """连续读消息，直到出现 kinds 中任一 kind；返回期间收到的全部消息。"""
    collected = []
    while True:
        msg = await recv_json(ws, timeout=timeout)
        collected.append(msg)
        if msg.get('kind') in kinds:
            return collected


async def auto_player(ws, timeout=20.0) -> None:
    """自动玩家：turn_request → 弃 0；claim/rob_kong → pass，直到对局结束。"""
    while True:
        msg = await recv_json(ws, timeout=timeout)
        kind = msg.get('kind')
        if kind == 'turn_request':
            await ws.send(json.dumps({'type': 'discard', 'handIndex': 0}))
        elif kind in ('claim_request', 'rob_kong_request'):
            await ws.send(json.dumps({'type': 'pass'}))


async def read_until(ws, kind: str, timeout=20.0) -> dict:
    while True:
        msg = await recv_json(ws, timeout=timeout)
        if msg.get('kind') == kind:
            return msg


@pytest.mark.asyncio
async def test_snapshot_precedes_turn_request(server, fresh_rooms):
    """回合请求前必有一份 state_snapshot，且只对本人显示手牌。"""
    room, codes = await prepare_room('SNAP1', 1, ['本家'])
    a = await ws_connect(server['ws'], 'SNAP1', codes['本家'])
    try:
        await read_until(a, 'rejoin_ok')
        async with httpx.AsyncClient(base_url=server['http']) as http:
            resp = await http.post('/api/rooms/SNAP1/start')
            assert resp.status_code == 200, resp.text
        # 收集到首个 turn_request 之前的所有消息（包含 rejoin_ok / 多次快照）
        msgs = await collect_until(a, {'turn_request'})
        snapshots = [m for m in msgs if m.get('kind') == 'state_snapshot']
        assert snapshots, f'turn_request 前未收到任何 state_snapshot: {[m.get("kind") for m in msgs]}'
        # 最新一份快照：本人手牌可见（dealer=0 为本家），他人手牌隐藏
        snap = snapshots[-1]
        own = snap['players'][0]
        assert all(t is not None for t in own['hand']), '本人手牌应可见'
        for seat in (1, 2, 3):
            other = snap['players'][seat]
            assert all(t is None for t in other['hand']), f'座位 {seat} 手牌应隐藏'
        # 快照携带该局基础状态
        assert snap['round'] >= 1 and snap['dealer'] == 0
        assert isinstance(snap['wallCount'], int)
        # 牌山整墙：数组长度与 wallCount 一致，元素为牌字符串（3D 牌山渲染数据源）
        assert 0 <= snap['wallCount'] <= 136
        assert len(snap['wall']) == snap['wallCount']
        assert all(isinstance(t, str) and t for t in snap['wall'])
        assert set(snap['wall']) <= {'white'}, '进行中快照不得暴露未摸牌牌面'
    finally:
        await safe_close(a)


@pytest.mark.asyncio
async def test_snapshot_carries_last_discard(server, fresh_rooms):
    """弃牌后广播的快照带 lastDiscard（前端高亮最近弃牌）。"""
    room, codes = await prepare_room('SNAP2', 1, ['阿东'])
    a = await ws_connect(server['ws'], 'SNAP2', codes['阿东'])
    try:
        await read_until(a, 'rejoin_ok')
        async with httpx.AsyncClient(base_url=server['http']) as http:
            await http.post('/api/rooms/SNAP2/start')
        # 读到第一张带 lastDiscard 的快照
        deadline = asyncio.get_event_loop().time() + 20
        snap = None
        while asyncio.get_event_loop().time() < deadline:
            msg = await recv_json(a)
            if msg.get('kind') == 'state_snapshot' and msg.get('lastDiscard'):
                snap = msg
                break
            # 自动代打推进，避免客户端无响应超时
            if msg.get('kind') == 'turn_request':
                await a.send(json.dumps({'type': 'discard', 'handIndex': 0}))
            elif msg.get('kind') in ('claim_request', 'rob_kong_request'):
                await a.send(json.dumps({'type': 'pass'}))
        assert snap is not None, '未收到携带 lastDiscard 的快照'
        ld = snap['lastDiscard']
        assert ld.get('tile') and isinstance(ld.get('from'), int)
        assert snap['players'][ld['from']]['discards'][-1] == ld['tile']
    finally:
        await safe_close(a)


@pytest.mark.asyncio
async def test_snapshot_after_hand_result(server, fresh_rooms):
    """结算后快照带 phase=settled / result / winPresentation，且先于 hand_result 到达。"""
    room, codes = await prepare_room('SNAP3', 1, ['老纪'])
    a = await ws_connect(server['ws'], 'SNAP3', codes['老纪'])
    try:
        await read_until(a, 'rejoin_ok')
        async with httpx.AsyncClient(base_url=server['http']) as http:
            await http.post('/api/rooms/SNAP3/start')
        # 打到第一局结算，收集消息（期间自动代打）
        collected = []
        while True:
            msg = await recv_json(a, timeout=20)
            collected.append(msg)
            kind = msg.get('kind')
            if kind == 'turn_request':
                await a.send(json.dumps({'type': 'discard', 'handIndex': 0}))
            elif kind in ('claim_request', 'rob_kong_request'):
                await a.send(json.dumps({'type': 'pass'}))
            elif kind == 'hand_result':
                break
        settled = [m for m in collected
                   if m.get('kind') == 'state_snapshot' and m.get('phase') == 'settled']
        assert settled, 'hand_result 前未收到 phase=settled 的快照'
        snap = settled[-1]
        assert snap['result'] is not None, 'settled 快照应携带 result'
        if snap['result'].get('draw'):
            assert snap['winPresentation'] is None, '流局快照不应携带 winPresentation'
        else:
            assert snap['winPresentation'] is not None, '胡牌快照应携带 winPresentation'
            wp = snap['winPresentation']
            assert 'winnerIndex' in wp and 'tile' in wp
    finally:
        await safe_close(a)


@pytest.mark.asyncio
async def test_settled_snapshot_reveals_all_hands(server, fresh_rooms):
    """结算快照亮出全部玩家手牌（赢牌翻牌展示三家），进行中仍只显示本人。"""
    room, codes = await prepare_room('SNAP5', 1, ['纪伯'])
    a = await ws_connect(server['ws'], 'SNAP5', codes['纪伯'])
    try:
        await read_until(a, 'rejoin_ok')
        async with httpx.AsyncClient(base_url=server['http']) as http:
            await http.post('/api/rooms/SNAP5/start')
        # 打到第一局结算，收集消息（期间自动代打）
        settled_snap = None
        while True:
            msg = await recv_json(a, timeout=20)
            kind = msg.get('kind')
            if kind == 'turn_request':
                await a.send(json.dumps({'type': 'discard', 'handIndex': 0}))
            elif kind in ('claim_request', 'rob_kong_request'):
                await a.send(json.dumps({'type': 'pass'}))
            elif kind == 'state_snapshot' and msg.get('phase') == 'settled':
                settled_snap = msg
            elif kind == 'hand_result':
                break
        assert settled_snap is not None, '未收到 phase=settled 的快照'
        # 结算快照：三家手牌全部可见（白板/翻牌展示需要真实牌面）
        for player in settled_snap['players']:
            assert player['hand'], f'结算快照手牌不应为空: 座位 {player["seat"]}'
            assert all(t is not None for t in player['hand']), \
                f'结算快照手牌应亮出真实牌面: 座位 {player["seat"]}'
    finally:
        await safe_close(a)


@pytest.mark.asyncio
async def test_round_start_carries_dice(server, fresh_rooms):
    """开局广播 round_start：携带骰子值，先于发牌快照到达；快照亦带同款骰子。"""
    room, codes = await prepare_room('SNAP4', 1, ['小骰'])
    a = await ws_connect(server['ws'], 'SNAP4', codes['小骰'])
    try:
        await read_until(a, 'rejoin_ok')
        async with httpx.AsyncClient(base_url=server['http']) as http:
            await http.post('/api/rooms/SNAP4/start')
        # 收集到 round_start 为止（跳过连上时的 lobby 快照）
        msgs = await collect_until(a, {'round_start'})
        rs = msgs[-1]
        assert rs['kind'] == 'round_start'
        assert rs['matchStarted'] is True, '首局 matchStarted 应为 True'
        assert rs['round'] == 1 and rs['dealer'] == 0
        dice = rs['dice']
        assert isinstance(dice, list) and len(dice) == 2
        assert all(isinstance(v, int) and 1 <= v <= 6 for v in dice), f'骰子值应在 [1,6]: {dice}'
        assert 'secondDice' not in rs, '经典玩法不应触发第二次投骰动画'
        # 紧随其后的发牌快照携带同款骰子（重连/兜底用）
        snap = await read_until(a, 'state_snapshot')
        assert snap['dice'] == dice, '发牌快照骰子应与 round_start 一致'
        expected_break = ([0, 102, 68, 34][(sum(dice) - 1) % 4] + min(dice) * 2) % 136
        assert snap['wallBreakIndex'] == expected_break
    finally:
        await safe_close(a)


@pytest.mark.asyncio
async def test_lotus_legacy_round_start_carries_second_dice(server, fresh_rooms):
    """莲花麻将 round_start 在第一轮发牌前携带第二颗骰子。"""
    room, codes = await prepare_room(
        'SNAP6', 1, ['二骰'], ruleset_id='lotus-legacy',
    )
    a = await ws_connect(server['ws'], 'SNAP6', codes['二骰'])
    try:
        await read_until(a, 'rejoin_ok')
        async with httpx.AsyncClient(base_url=server['http']) as http:
            await http.post('/api/rooms/SNAP6/start')
        msgs = await collect_until(a, {'round_start'})
        rs = msgs[-1]
        second_dice = rs['secondDice']
        assert isinstance(second_dice, list) and len(second_dice) == 2
        assert all(isinstance(v, int) and 1 <= v <= 6 for v in second_dice)
        assert isinstance(rs['flipTile'], str) and rs['flipTile']
        assert isinstance(rs['flipStack'], int)
        assert isinstance(rs['flipSeat'], int) and 0 <= rs['flipSeat'] < 4
    finally:
        await safe_close(a)


@pytest.mark.asyncio
async def test_lotus_legacy_two_clients_share_authoritative_opening(server, fresh_rooms):
    """莲花联机两端收到一致的翻精开局数据，发牌后仍只收到牌墙背面占位。"""
    room, codes = await prepare_room(
        'SNAP7', 2, ['庄家', '下家'], ruleset_id='lotus-legacy',
    )
    clients = [
        await ws_connect(server['ws'], 'SNAP7', codes[name])
        for name in ('庄家', '下家')
    ]
    try:
        await asyncio.gather(*(read_until(ws, 'rejoin_ok') for ws in clients))
        async with httpx.AsyncClient(base_url=server['http']) as http:
            response = await http.post('/api/rooms/SNAP7/start')
            assert response.status_code == 200, response.text

        starts = await asyncio.gather(*(read_until(ws, 'round_start') for ws in clients))
        for field in ('dice', 'secondDice', 'flipTile', 'flipStack', 'flipSeat'):
            assert starts[0][field] == starts[1][field], field
        assert starts[0]['secondDice'] != starts[0]['dice'] or starts[0]['flipTile']

        await asyncio.gather(*(ws.send(json.dumps({'type': 'opening_done'})) for ws in clients))
        snapshots = await asyncio.gather(*(read_until(ws, 'state_snapshot') for ws in clients))
        for snap in snapshots:
            assert snap['rulesetId'] == 'lotus-legacy'
            assert set(snap['wall']) <= {'white'}
    finally:
        await asyncio.gather(*(safe_close(ws) for ws in clients))
