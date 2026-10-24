"""断线重连 / 重进码限速 —— Phase 8 测试补充

覆盖（对应开发计划 Phase 8 验收「断线托管/重连恢复全链路验证」）：
- 重进码 30s 窗口内限速：同一码连续失败 5 次 → 第 6 次 REJOIN_RATE_LIMITED
- 成功恢复座位后清零失败计数：合法重连不被限速
- 断线 → AI 托管对局继续 → 换浏览器/新连接凭重进码恢复座位与控制权

断线托管本身（on_disconnect → 立即 AI 代打）与 rejoin 恢复在 test_ws.py 已有覆盖，
此处聚焦限速新行为与「控制权归还」的重连场景。
"""

import asyncio
import json

import httpx
import pytest
import websockets
import websockets.asyncio.client  # noqa: F401
import websockets.exceptions

from tests.test_ws import (
    prepare_room,
    read_until,
    recv_json,
    safe_close,
    wait_until,
    ws_url,
)
from app.game.room import room_registry as rooms


async def ws_handshake(base: str, room_id: str, code: str) -> str:
    """发起一次 WS 握手并返回 rejoin_err 错误码（不建连接对象，发完即关）。"""
    ws = await websockets.asyncio.client.connect(ws_url(base, room_id, code))
    try:
        msg = await read_until(ws, 'rejoin_err', timeout=5)
        return msg['code']
    finally:
        await safe_close(ws)


@pytest.mark.asyncio
async def test_rejoin_rate_limited_after_repeated_failures(server, fresh_rooms):
    """同一错误重进码 5 次失败 → 第 6 次被限速（REJOIN_RATE_LIMITED）。"""
    room, _ = await prepare_room('RECONN1', 1, ['小李'])
    codes = []
    for _ in range(5):
        codes.append(await ws_handshake(server['ws'], 'RECONN1', 'XXXX-XXXX'))
    assert codes == ['INVALID_REJOIN_CODE'] * 5
    # 第 6 次：仍在 30s 窗口内 → 限速
    limited = await ws_handshake(server['ws'], 'RECONN1', 'XXXX-XXXX')
    assert limited == 'REJOIN_RATE_LIMITED'


@pytest.mark.asyncio
async def test_rejoin_rate_reset_after_successful_resume(server, fresh_rooms):
    """成功恢复座位后清零失败计数：合法重连（即使之前失败过）不被限速。"""
    room, codes = await prepare_room('RECONN2', 1, ['小王'])
    code = codes['小王']
    # 限速窗口中已有 4 次尝试：成功握手应清零，后续重进不受累积计数影响。
    import time
    room._rejoin_attempts[code] = [time.monotonic()] * 4
    a = await websockets.asyncio.client.connect(ws_url(server['ws'], 'RECONN2', code))
    try:
        ok = await read_until(a, 'rejoin_ok')
        assert ok['seat'] == 0
        assert code not in room._rejoin_attempts
        a2 = await websockets.asyncio.client.connect(ws_url(server['ws'], 'RECONN2', code))
        try:
            ok2 = await read_until(a2, 'rejoin_ok')
            assert ok2['seat'] == 0 and ok2['rejoin'] is True
            assert code not in room._rejoin_attempts
        finally:
            await safe_close(a2)
    finally:
        await safe_close(a)


@pytest.mark.asyncio
async def test_reconnect_restores_control_after_ai_takeover(server, fresh_rooms):
    """断线期间 AI 托管推进对局；重连恢复原座位，且控制权归还（再次收到回合请求）。

    注入放慢的 pace（AI 每回合 ~650ms 思考 + 节奏延迟），使断线-重连窗口内
    对局仍在进行：本家下个回合请求会重新发给客户端（而非继续由 AI 代打）。
    """
    pace = {k: 150 for k in (
        'afterDiscardToNextTurn', 'afterClaimGang', 'afterClaimPeng',
        'afterKongSettle', 'beforeRobKong', 'betweenRobKongs', 'skipDrawPengDelay',
        'openingDelayStart', 'openingDelay', 'redKongDraw',
    )}
    room = rooms.create('RECONN3', mode='east', capacity=1, turn_timeout=2.0, pace=pace)
    seat, _, state = room.join_or_rejoin('老赵')
    room.ready_seat(seat)
    code = state.rejoin_code
    a = await websockets.asyncio.client.connect(ws_url(server['ws'], 'RECONN3', code))
    try:
        await read_until(a, 'rejoin_ok')
        async with httpx.AsyncClient(base_url=server['http']) as http:
            await http.post('/api/rooms/RECONN3/start')
        # 开局就绪屏障（pace 非空）：客户端发牌动画结束 → opening_done
        await read_until(a, 'state_snapshot')
        await a.send(json.dumps({'type': 'opening_done'}))
        await read_until(a, 'turn_request', timeout=15)
        # 断线（未响应首回合）→ 座位转 AI 托管，对局继续推进
        await a.close()
        await wait_until(lambda: not room.seats[seat].controller.connected)
    finally:
        await safe_close(a)

    # 新连接（模拟换浏览器）凭原重进码恢复：rejoin_ok + 全量快照 + 控制权归还
    a2 = await websockets.asyncio.client.connect(ws_url(server['ws'], 'RECONN3', code))
    try:
        ok = await read_until(a2, 'rejoin_ok')
        assert ok['seat'] == seat and ok['rejoin'] is True
        snap = await read_until(a2, 'state_snapshot')
        own = snap['players'][seat]
        assert all(t is not None for t in own['hand']), '重连后应看到自己的完整手牌'
        # 控制权归还（内部标志）：重连后座位标记为在线
        assert room.seats[seat].controller.connected is True
        # 本家下个回合请求会发给客户端（而非 AI 代打）——读取到即证明。
        # 期间可能跨局结算：像真实客户端一样响应 continue / 开局屏障。
        got_turn = False
        while True:
            msg = await recv_json(a2, timeout=30)
            kind = msg.get('kind')
            if kind == 'turn_request':
                got_turn = True
                await a2.send(json.dumps({'type': 'discard', 'handIndex': 0}))
                break
            if kind == 'hand_result':
                await a2.send(json.dumps({'type': 'continue'}))
            elif kind == 'round_start':
                await a2.send(json.dumps({'type': 'opening_done'}))
            elif kind == 'match_finished':
                break
        assert got_turn, '重连后未收到本家回合请求（控制权未归还）'
    finally:
        await safe_close(a2)
