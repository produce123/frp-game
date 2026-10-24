"""WebSocket 端到端集成测试 —— 真实 uvicorn 服务 + websockets 客户端

对应开发计划 Phase 5 验收（Phase 6 起 REST 接管房间生命周期）：
- 两个真实 WebSocket 客户端凭 rejoin_code 连入同一房间并完成一场（其余座位 AI）
- 非法动作（过期 / 错误类型）被拒绝并返回错误码
- 断线：AI 托管，对局继续；重连（重进码）恢复原座位与控制权
- 重进码错误被拒绝
- 回合超时自动代打（AI 决策）

房间生命周期（创建 / join / ready / start）由 REST 层驱动：start 走 HTTP 路由，
确保 game_task 创建在 uvicorn 事件循环（与 WS 处理器同循环）。WS 端点只负责
凭 rejoin_code 恢复座位。
"""

import asyncio
import json
from urllib.parse import quote

import httpx
import pytest
import websockets
import websockets.asyncio.client  # noqa: F401 确保 asyncio 客户端子模块加载
import websockets.exceptions

from app.game.room import room_registry as rooms


# ─── 房间/连接辅助 ────────────────────────────────────────

async def prepare_room(room_id: str, capacity: int, nicknames: list,
                       mode: str = 'east', turn_timeout: float = 5.0):
    """建房间 + join 全部昵称 + 全部 ready（不 start）。返回 (room, {nickname: rejoin_code})。

    start 由测试在客户端 WS 连接之后再触发（走 REST，保证 game_task 创建在
    uvicorn 事件循环，且对局开始时客户端已在线、能全程参与）。
    """
    room = rooms.create(room_id, mode=mode, capacity=capacity, turn_timeout=turn_timeout)
    codes = {}
    for nickname in nicknames:
        seat, _, state = room.join_or_rejoin(nickname)
        room.ready_seat(seat)
        codes[nickname] = state.rejoin_code
    return room, codes


def ws_url(base: str, room_id: str, rejoin_code: str) -> str:
    return f'{base}/ws/room/{room_id}?rejoin_code={quote(rejoin_code)}'


async def recv_json(ws, timeout=8.0) -> dict:
    raw = await asyncio.wait_for(ws.recv(), timeout)
    return json.loads(raw)


async def safe_close(ws) -> None:
    """幂等关闭：已断开的连接 close() 直接返回。"""
    if ws is not None:
        try:
            await ws.close()
        except Exception:
            pass


async def read_until(ws, kind: str, timeout=15.0) -> dict:
    """连续读消息直到出现指定 kind（跳过中间消息）。"""
    while True:
        msg = await recv_json(ws, timeout=timeout)
        if msg.get('kind') == kind:
            return msg


async def auto_player(ws, timeout=8.0) -> dict:
    """自动玩家：turn_request → 弃 0；claim/rob_kong → pass；hand_result → 确认；直到 match_finished。"""
    rejoin = None
    try:
        while True:
            msg = await recv_json(ws, timeout=timeout)
            kind = msg.get('kind')
            if kind == 'rejoin_ok':
                rejoin = msg
            elif kind == 'turn_request':
                await ws.send(json.dumps({'type': 'discard', 'handIndex': 0}))
            elif kind in ('claim_request', 'rob_kong_request'):
                await ws.send(json.dumps({'type': 'pass'}))
            elif kind == 'hand_result':
                # 结算确认屏障：点「继续」才能进下一局
                await ws.send(json.dumps({'type': 'continue'}))
            elif kind == 'match_finished':
                return {'rejoin': rejoin, 'finalScores': msg.get('finalScores')}
    except (TimeoutError, websockets.exceptions.ConnectionClosed):
        return {'rejoin': rejoin, 'finalScores': None}


async def play_until_hand(ws, timeout=20.0) -> dict:
    """自动打到第一局结算：turn_request → 弃 0；claim/rob_kong → pass。"""
    while True:
        msg = await recv_json(ws, timeout=timeout)
        kind = msg.get('kind')
        if kind == 'turn_request':
            await ws.send(json.dumps({'type': 'discard', 'handIndex': 0}))
        elif kind in ('claim_request', 'rob_kong_request'):
            await ws.send(json.dumps({'type': 'pass'}))
        elif kind == 'hand_result':
            return msg


async def wait_until(cond, timeout=10.0, interval=0.02) -> None:
    """轮询等待条件成立（跨线程读 room 状态时用）。"""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if cond():
            return
        await asyncio.sleep(interval)
    raise AssertionError(f'等待超时（{timeout}s）: 条件未成立')


# ─── 测试用例 ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_two_clients_complete_a_match(server, fresh_rooms):
    """两个真实客户端连入同一房间（其余座位 AI），完整打完一场东风场。"""
    room, codes = await prepare_room('TEST1', 2, ['张三', '李四'])
    a = await websockets.asyncio.client.connect(ws_url(server['ws'], 'TEST1', codes['张三']))
    b = await websockets.asyncio.client.connect(ws_url(server['ws'], 'TEST1', codes['李四']))
    try:
        # 连接后立即 start（此时客户端已注册、connected=True）；
        # auto_player 从连接开始读，自行记录 rejoin_ok
        async with httpx.AsyncClient(base_url=server['http']) as http:
            resp = await http.post('/api/rooms/TEST1/start')
            assert resp.status_code == 200, resp.text
        results = await asyncio.wait_for(
            asyncio.gather(auto_player(a), auto_player(b)), timeout=40)
        # 两个玩家各占一个座位，座位互斥
        seats = {r['rejoin']['seat'] for r in results}
        assert seats == {0, 1}
        # 都收到 match_finished 与最终分数
        for r in results:
            assert r['finalScores'] is not None, f'未收到 match_finished: {r}'
        # 整场结束，分数守恒（起始各 1000）
        assert sum(s['score'] for s in results[0]['finalScores']) == 4000
        assert room.status == 'finished'
        assert room.manager is not None and room.manager.match_finished
    finally:
        await safe_close(a)
        await safe_close(b)


@pytest.mark.asyncio
async def test_invalid_action_rejected(server, fresh_rooms):
    """回合提示窗口内发送错误类型的动作 → INVALID_ACTION，且 pending 未被消费。"""
    room, codes = await prepare_room('TEST2', 1, ['小王'])
    a = await websockets.asyncio.client.connect(ws_url(server['ws'], 'TEST2', codes['小王']))
    try:
        ok = await read_until(a, 'rejoin_ok')
        assert ok['seat'] == 0
        async with httpx.AsyncClient(base_url=server['http']) as http:
            await http.post('/api/rooms/TEST2/start')
        await read_until(a, 'turn_request', timeout=10)
        # 回合请求期间发 claim 消息 → 类型不符
        await a.send(json.dumps({'type': 'claim', 'action': 'pass'}))
        err = await read_until(a, 'error', timeout=5)
        assert err['code'] == 'INVALID_ACTION'
        # pending 未被消费：补一个合法出牌，对局继续到第一局结算
        await a.send(json.dumps({'type': 'discard', 'handIndex': 0}))
        hr = await play_until_hand(a, timeout=20)
        assert hr['result'] is not None and 'winner' in hr['result']
    finally:
        await safe_close(a)


@pytest.mark.asyncio
async def test_ping_gets_pong(server, fresh_rooms):
    """客户端 ping → 服务端回 pong（前端据此测 RTT → 信号质量显示）。"""
    room, codes = await prepare_room('PING1', 1, ['老张'])
    a = await websockets.asyncio.client.connect(ws_url(server['ws'], 'PING1', codes['老张']))
    try:
        await read_until(a, 'rejoin_ok')
        await a.send(json.dumps({'type': 'ping'}))
        msg = await read_until(a, 'pong')
        assert msg['kind'] == 'pong'
    finally:
        await safe_close(a)


@pytest.mark.asyncio
async def test_stale_action_rejected_before_game(server, fresh_rooms):
    """无待处理请求时（游戏未开局）的动作 → STALE_ACTION。"""
    # capacity=2：只 join 1 人且未 ready/start → 游戏不会开局 → 无 pending
    room = rooms.create('TEST3', mode='east', capacity=2, turn_timeout=5)
    seat, _, state = room.join_or_rejoin('阿强')
    assert seat == 0
    a = await websockets.asyncio.client.connect(ws_url(server['ws'], 'TEST3', state.rejoin_code))
    try:
        await read_until(a, 'rejoin_ok')
        await read_until(a, 'state_snapshot')
        await a.send(json.dumps({'type': 'discard', 'handIndex': 0}))
        err = await read_until(a, 'error', timeout=5)
        assert err['code'] == 'STALE_ACTION'
    finally:
        await safe_close(a)


@pytest.mark.asyncio
async def test_disconnect_takeover_and_rejoin(server, fresh_rooms):
    """断线 → AI 托管、对局继续；重进码重连恢复原座位；错误重进码被拒。"""
    room, codes = await prepare_room('TEST4', 1, ['老赵'])
    a = await websockets.asyncio.client.connect(ws_url(server['ws'], 'TEST4', codes['老赵']))
    try:
        ok = await read_until(a, 'rejoin_ok')
        seat = ok['seat']
        assert seat == 0
        # 未开局：尚无场次身份（房间无 storage，match_id 保持 None）
        assert ok['matchId'] is None
        async with httpx.AsyncClient(base_url=server['http']) as http:
            await http.post('/api/rooms/TEST4/start')
        # 等到第一次回合请求，证明对局已开始
        await read_until(a, 'turn_request', timeout=10)
        # 断线：座位控制器应转为断开（AI 托管）
        await a.close()
        await wait_until(lambda: not room.seats[seat].controller.connected)
        # 断线后对局继续，直至整场结束
        await wait_until(lambda: room.status in ('finished', 'error'), timeout=30)
        assert room.status == 'finished', f'断线后对局未完成: {room.status}'
        assert room.manager.match_finished
    finally:
        await safe_close(a)

    # 正确重进码 → 恢复原座位 + 全量快照（自己的手牌完整、他人手牌隐藏）
    room.match_id = 'm-ws-1'
    a2 = await websockets.asyncio.client.connect(ws_url(server['ws'], 'TEST4', codes['老赵']))
    try:
        ok2 = await read_until(a2, 'rejoin_ok')
        assert ok2['seat'] == seat and ok2['rejoin'] is True
        # 本人参与的那场靠 rejoin_ok 锚定：REST 的 matchId 会被下一场覆盖，
        # 而内存 match_id 是权威（本房无 storage，直接写内存态验证接线）。
        assert ok2['matchId'] == 'm-ws-1'
        snap = await read_until(a2, 'state_snapshot')
        assert snap['matchId'] == 'm-ws-1'
        own = snap['players'][seat]
        assert all(t is not None for t in own['hand']), '重连后应看到自己的完整手牌'
        other_seat = (seat + 1) % 4
        assert all(t is None for t in snap['players'][other_seat]['hand']), '他人手牌应隐藏'
    finally:
        await a2.close()

    # 错误重进码 → 拒绝
    a3 = await websockets.asyncio.client.connect(ws_url(server['ws'], 'TEST4', 'XXXX-XXXX'))
    try:
        err = await read_until(a3, 'rejoin_err')
        assert err['code'] == 'INVALID_REJOIN_CODE'
    finally:
        await a3.close()


@pytest.mark.asyncio
async def test_turn_timeout_autoplay(server, fresh_rooms):
    """回合超时（客户端不响应）→ AI 自动代打，对局仍能推进到第一局结算。"""
    room, codes = await prepare_room('TEST5', 1, ['闷声'], turn_timeout=0.05)
    a = await websockets.asyncio.client.connect(ws_url(server['ws'], 'TEST5', codes['闷声']))
    try:
        ok = await read_until(a, 'rejoin_ok')
        assert ok['seat'] == 0
        async with httpx.AsyncClient(base_url=server['http']) as http:
            await http.post('/api/rooms/TEST5/start')
        # 客户端全程不响应任何 turn_request，仅读取消息；超时代打应让对局推进
        hr = await read_until(a, 'hand_result', timeout=40)
        assert hr['result'] is not None and 'winner' in hr['result']
    finally:
        await safe_close(a)


@pytest.mark.asyncio
async def test_rejoin_code_same_as_original_seat(server, fresh_rooms):
    """重进码是稳定身份：同一玩家第二次加入（占座）仍可用原码恢复，不另占新座。"""
    room = rooms.create('TEST6', mode='east', capacity=2, turn_timeout=5)
    seat, _, state = room.join_or_rejoin('小明')
    assert seat == 0
    try:
        a = await websockets.asyncio.client.connect(ws_url(server['ws'], 'TEST6', state.rejoin_code))
        ok = await read_until(a, 'rejoin_ok')
        assert ok['rejoin'] is True and ok['seat'] == 0
        # 原连接还未被判定断线时，同一码也可接管；旧连接迟到退出不能断开新连接。
        a2 = await websockets.asyncio.client.connect(ws_url(server['ws'], 'TEST6', state.rejoin_code))
        try:
            ok2 = await read_until(a2, 'rejoin_ok', timeout=5)
            assert ok2['seat'] == 0 and ok2['rejoin'] is True
            await safe_close(a)
            assert room.seats[0].controller.connected is True
            await a2.send('{"type":"ping"}')
            pong = await read_until(a2, 'pong', timeout=5)
            assert pong['kind'] == 'pong'
        finally:
            await safe_close(a2)
    finally:
        await safe_close(a)
