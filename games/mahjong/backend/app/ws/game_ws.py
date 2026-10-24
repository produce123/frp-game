"""WebSocket 游戏端点 —— /ws/room/{room_id}

流程（Phase 6：REST 接管房间生命周期，WS 只管实时游戏）：
1. 握手鉴权：query 携带 rejoin_code（REST join 签发）→ resume_by_code 恢复原座位
2. 绑定座位：注册出站队列 + 发送任务，下发 rejoin_ok + 全量快照
3. 开局由 REST POST /api/rooms/{id}/start 显式触发（本端点不再自动开局）
4. 接收循环：客户端动作 → handle_client_message（服务端权威校验）→ 拒绝回错误
5. 断线：on_disconnect 标记 + AI 托管；发送任务随连接关闭终止

发送采用「出站队列 + 后台发送任务」：广播/请求只入队，慢/断客户端不阻塞游戏主循环。
"""

import asyncio
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from loguru import logger

from app.game.room import (
    RoomError,
    build_snapshot,
    match_id_of,
    room_registry,
)

router = APIRouter()


async def _sender(queue: asyncio.Queue, websocket: WebSocket, room_id: str, seat: int) -> None:
    """后台发送任务：从出站队列取消息真正 send_json；连接断开即结束。"""
    try:
        while True:
            message = await queue.get()
            await websocket.send_json(message)
    except Exception:
        # 连接已断开，发送失败无需上报（游戏循环不感知）；DEBUG 留痕便于查错
        logger.bind(room_id=room_id, seat=seat).debug("WS 发送失败（连接断开，预期内）")


@router.websocket('/ws/room/{room_id}')
async def game_ws(websocket: WebSocket, room_id: str) -> None:
    await websocket.accept()
    start = time.perf_counter()

    rejoin_code = (websocket.query_params.get('rejoin_code') or '').strip()

    room = room_registry.get(room_id)
    if room is None:
        logger.bind(room_id=room_id).warning("WS 握手拒绝 ROOM_NOT_FOUND")
        await websocket.send_json({'kind': 'rejoin_err', 'code': 'ROOM_NOT_FOUND'})
        await websocket.close()
        return
    if not rejoin_code:
        logger.bind(room_id=room_id).warning("WS 握手拒绝 REJOIN_CODE_REQUIRED")
        await websocket.send_json({'kind': 'rejoin_err', 'code': 'REJOIN_CODE_REQUIRED'})
        await websocket.close()
        return
    # 重进码限速：30s 窗口内同一码最多 5 次握手（防重连风暴 / 顶号刷码）
    if not room.check_rejoin_rate(rejoin_code):
        logger.bind(room_id=room_id).warning("WS 握手拒绝 REJOIN_RATE_LIMITED")
        await websocket.send_json({'kind': 'rejoin_err', 'code': 'REJOIN_RATE_LIMITED'})
        await websocket.close()
        return
    try:
        seat, state = room.resume_by_code(rejoin_code)
    except RoomError as exc:
        logger.bind(room_id=room_id).warning(f"WS 握手拒绝 {exc}")
        await websocket.send_json({'kind': 'rejoin_err', 'code': str(exc)})
        await websocket.close()
        return
    room.reset_rejoin_rate(rejoin_code)  # 成功恢复座位：清零该码失败计数

    # 绑定座位：出站队列 + 后台发送任务
    queue: asyncio.Queue = asyncio.Queue()
    sender = asyncio.create_task(_sender(queue, websocket, room_id, seat))
    previous_socket = room.conn.register(seat, queue, sender, websocket)
    room.on_connect(seat)
    if previous_socket is not None:
        try:
            await previous_socket.close()
        except Exception:
            # 旧连接可能已被浏览器关闭；新连接已经成为唯一有效座位。
            pass
    logger.bind(room_id=room_id, seat=seat).info(f"WS 连接 昵称={state.nickname}")

    await room.conn.send_to_seat(seat, {
        'kind': 'rejoin_ok',
        'seat': seat,
        'rejoin': True,
        'roomId': room.room_id,
        # 本人参与的那场的唯一可靠来源：REST 的 matchId 会被下一场覆盖，
        # 且开局早期可能仍为 None（_persist_match_start 异步赋值）。
        'matchId': match_id_of(room),
        'mode': room.mode,
        'rulesetId': room.ruleset_id,
        'nickname': state.nickname,
        'characterId': state.character_id,
        'theme': room.table_theme,
        'rejoinCode': state.rejoin_code,
    })
    if room.ruleset_id == 'lotus-blood-flow':
        await room.conn.send_to_seat(seat, room.snapshot_for(seat))
    else:
        await room.conn.send_to_seat(seat, build_snapshot(room, seat))

    try:
        while True:
            message = await websocket.receive_json()
            if not room.conn.is_current_connection(seat, queue):
                await websocket.close()
                break
            ok, err = room.handle_client_message(seat, message)
            if not ok:
                logger.bind(room_id=room_id, seat=seat).warning(f"消息被拒 {err}")
                await room.conn.send_to_seat(seat, {'kind': 'error', 'code': err})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        duration = time.perf_counter() - start
        logger.bind(room_id=room_id, seat=seat).info(f"WS 断开 连接时长={duration:.1f}s")
        if room.conn.is_current_connection(seat, queue):
            room.on_disconnect(seat)
            room.conn.unregister(seat, queue)
        if not sender.done():
            sender.cancel()
