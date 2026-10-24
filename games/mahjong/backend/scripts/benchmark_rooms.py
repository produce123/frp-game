"""单 Uvicorn worker 并发房间压测基准（Phase 8 验收）

模拟 N 个房间并发（每房 2 个真实 WebSocket 玩家 + 2 个 AI 补位），测量：
- 房间创建吞吐（REST POST /api/rooms 延迟）
- 整场对局完成率与耗时（WS 驱动的东风场）
- 负载期间的 REST 延迟（GET /api/rooms/{id}）

对应开发计划 Phase 8 验收「压测：模拟 N 个房间并发，单 worker 无崩溃、
响应延迟在阈值内」。GameManager 为 CPU 轻量状态机，瓶颈在 WS 连接数——
本基准以每房 2 条 WS 连接逼近该瓶颈。

用法：
    cd backend
    PYTHONIOENCODING=utf-8 .venv/Scripts/python scripts/benchmark_rooms.py [N]
        N = 房间数（默认 8，即 16 条并发 WS 连接）
"""

import argparse
import asyncio
import json
import os
import statistics
import sys
import threading
import time
from urllib.parse import quote

# 脚本位于 backend/scripts/，把 backend/ 加进模块搜索路径以导入 app
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx
import uvicorn
import websockets
import websockets.asyncio.client

from app.main import app
from app.game.room import room_registry as rooms


# ─── uvicorn 后台线程（复用 conftest 的启动方式）──────────────

def start_server() -> str:
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
    return f'http://127.0.0.1:{port}', f'ws://127.0.0.1:{port}'


# ─── WS 客户端辅助 ──────────────────────────────────────────

def ws_url(base_ws: str, room_id: str, code: str) -> str:
    return f'{base_ws}/ws/room/{room_id}?rejoin_code={quote(code)}'


async def recv_json(ws, timeout: float) -> dict:
    raw = await asyncio.wait_for(ws.recv(), timeout)
    return json.loads(raw)


async def auto_player(ws) -> None:
    """自动玩家：turn → 弃 0；claim/rob → pass；结算确认以 continue_prompt 为准；直到 match_finished。

    注意：不能以 hand_result 触发 continue —— 房间用真实 storage 时，_drive 在广播
    hand_result 后还有一次 to_thread(_persist_round) 线程切换，此刻发的 continue 会
    落在确认屏障建立之前被丢弃。continue_prompt 是屏障建立后的权威确认提示。
    """
    while True:
        msg = await recv_json(ws, 8.0)
        kind = msg.get('kind')
        if kind == 'turn_request':
            await ws.send(json.dumps({'type': 'discard', 'handIndex': 0}))
        elif kind in ('claim_request', 'rob_kong_request'):
            await ws.send(json.dumps({'type': 'pass'}))
        elif kind == 'continue_prompt':
            await ws.send(json.dumps({'type': 'continue'}))
        elif kind == 'match_finished':
            return


# ─── 单房间压测：创建 + join×2 + WS 连接 + start + 打完 ───────

async def run_room(http: httpx.AsyncClient, base_ws: str, idx: int) -> dict:
    t0 = time.perf_counter()
    resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2})
    create_lat = time.perf_counter() - t0
    assert resp.status_code == 200, resp.text
    rid = resp.json()['roomId']

    joins = []
    for name in ('甲', '乙'):
        j = (await http.post(f'/api/rooms/{rid}/join', json={'nickname': name})).json()
        joins.append(j)
        await http.post(f'/api/rooms/{rid}/ready',
                        json={'seat': j['seat'], 'rejoinCode': j['rejoinCode']})

    # REST 创建注入 PLAY_PACE（真人节奏）；压测只关心并发容量 → 提速跳过动画延迟
    room = rooms.get(rid)
    if room is not None:
        room.pace = {}

    ws_conns = []
    for j in joins:
        ws_conns.append(await websockets.asyncio.client.connect(
            ws_url(base_ws, rid, j['rejoinCode'])))

    t_start = time.perf_counter()
    resp = await http.post(f'/api/rooms/{rid}/start')
    assert resp.status_code == 200, resp.text
    await asyncio.wait_for(asyncio.gather(*(auto_player(w) for w in ws_conns)), timeout=60)
    match_time = time.perf_counter() - t_start

    t0 = time.perf_counter()
    await http.get(f'/api/rooms/{rid}')
    get_lat = time.perf_counter() - t0

    for w in ws_conns:
        try:
            await w.close()
        except Exception:
            pass
    return {'roomId': rid, 'createLat': create_lat, 'matchTime': match_time, 'getLat': get_lat}


async def main(n_rooms: int) -> int:
    base_http, base_ws = start_server()
    print(f'单 Uvicorn worker @ {base_http}  房间数 = {n_rooms}（每房 2 条 WS，共 {n_rooms * 2} 条并发 WS）')
    rooms.clear()
    t_begin = time.perf_counter()
    client = httpx.AsyncClient(base_url=base_http)
    results = await asyncio.gather(*(run_room(client, base_ws, i) for i in range(n_rooms)))
    await client.aclose()
    total = time.perf_counter() - t_begin

    ok = [r for r in results if r]
    failed = n_rooms - len(ok)
    creates = [r['createLat'] for r in ok]
    matches = [r['matchTime'] for r in ok]
    gets = [r['getLat'] for r in ok]

    print('\n=== 结果 ===')
    print(f'完成房间      : {len(ok)}/{n_rooms}' + (f'  ← {failed} 失败!' if failed else ''))
    print(f'总耗时        : {total:.2f}s')
    print(f'创建延迟 (ms) : avg {statistics.mean(creates)*1000:.1f}  max {max(creates)*1000:.1f}')
    print(f'整场对局 (s)  : avg {statistics.mean(matches):.2f}  max {max(matches):.2f}')
    print(f'负载期 GET 延迟(ms): avg {statistics.mean(gets)*1000:.1f}  max {max(gets)*1000:.1f}')
    for r in results:
        if not r:
            print('  !! 有房间未完成（并发下崩溃/超时）')

    if failed:
        print('\n压测未通过：存在失败房间')
        return 1
    if max(gets) > 1.0:
        print(f'\n⚠ 负载期 REST 延迟超过 1s（max {max(gets)*1000:.0f}ms）——并发容量接近上限')
    else:
        print('\n压测通过：单 worker 并发房间无崩溃，负载期 REST 延迟在阈值内')
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='单 worker 并发房间压测')
    parser.add_argument('n', nargs='?', type=int, default=8, help='房间数（默认 8）')
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args.n)))
