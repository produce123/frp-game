"""4 个真实 WebSocket 客户端打完整东风场（端到端对局）

Phase 8 验收补充：全座位真人（无 AI 补位）的完整对局闭环。
验证：
- 4 个座位均为真实 RemotePlayer（连接上即真人，无 AI 顶替）
- 每个客户端都实际轮到自己回合（收到 turn_request 并出牌）
- 碰/杠/抢杠响应（claim / rob_kong → pass）与 4 人结算确认屏障（continue）正常
- 整场打完收到 match_finished，最终分数守恒（4 × 1000 = 4000）

默认快速节奏（REST 注入的 PLAY_PACE 被提速）保证 headless 可靠；
加 --real-pace 保留真人节奏（整场约 90s）。

用法：
    cd backend
    PYTHONIOENCODING=utf-8 .venv/Scripts/python scripts/smoke_4p.py [--real-pace]
"""

import argparse
import asyncio
import json
import os
import sys
import threading
import time
from urllib.parse import quote

# 脚本位于 backend/scripts/，把 backend/ 加进模块搜索路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx
import uvicorn
import websockets
import websockets.asyncio.client

from app.main import app
from app.game.player import AIPlayer, ClaimContext, RobKongContext, TurnContext
from app.game.room import room_registry as rooms

BACKEND_PORT = int(os.environ.get('SMOKE_BACKEND_PORT', '8010'))


def start_backend() -> None:
    config = uvicorn.Config(app, host='127.0.0.1', port=BACKEND_PORT, log_level='warning')
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not getattr(server, 'started', False):
        if time.time() > deadline:
            raise RuntimeError('uvicorn 启动超时')
        time.sleep(0.02)


def _turn_to_wire(action: dict, ctx: dict) -> dict:
    """AIPlayer 回合决策 → WS 协议动作（补杠需回填副露牌）。"""
    kind = action['kind']
    if kind == 'win':
        return {'type': 'hu'}
    if kind == 'added-kong':
        tile = ctx['melds'][action['meldIndex']]['tile']
        return {'type': 'gang', 'kind': 'added', 'tile': tile}
    if kind == 'concealed-kong':
        return {'type': 'gang', 'kind': 'concealed', 'tile': action['tile']}
    return {'type': 'discard', 'handIndex': action['handIndex']}


async def auto_player(name: str, ws) -> dict:
    """自动玩家：用服务端 AIPlayer 决策逻辑出牌（真实打出胡/杠/抢杠），
    结算确认以 continue_prompt 为准。

    返回 {turns, match: match_finished 消息}；turns > 0 证明该客户端确实轮到自己回合。
    """
    ai = AIPlayer()   # 0 延迟决策
    turns = 0
    while True:
        raw = await asyncio.wait_for(ws.recv(), 15.0)
        msg = json.loads(raw)
        kind = msg.get('kind')
        if kind == 'state_snapshot' and msg.get('phase') == 'opening':
            # 开局就绪屏障（真人节奏下启用）：发牌动画结束 → opening_done
            await ws.send(json.dumps({'type': 'opening_done'}))
        elif kind == 'turn_request':
            turns += 1
            action = await ai.request_turn(TurnContext(**msg['ctx']))
            await ws.send(json.dumps(_turn_to_wire(action, msg['ctx'])))
        elif kind == 'claim_request':
            action = await ai.request_claim(ClaimContext(**msg['ctx']))
            if action['kind'] == 'pass':
                await ws.send(json.dumps({'type': 'pass'}))
            else:
                await ws.send(json.dumps({'type': 'claim', 'action': action['kind']}))
        elif kind == 'rob_kong_request':
            decision = await ai.request_rob_kong(RobKongContext(**msg['ctx']))
            await ws.send(json.dumps({'type': 'hu'} if decision == 'win' else {'type': 'pass'}))
        elif kind == 'continue_prompt':
            await ws.send(json.dumps({'type': 'continue'}))
        elif kind == 'match_finished':
            return {'turns': turns, 'match': msg}


async def main(real_pace: bool) -> int:
    start_backend()
    base_http, base_ws = f'http://127.0.0.1:{BACKEND_PORT}', f'ws://127.0.0.1:{BACKEND_PORT}'
    print(f'后端 @ {base_http}  4 个真实 WS 客户端打完整东风场' + ('（真人节奏）' if real_pace else '（快速节奏）'))

    async with httpx.AsyncClient(base_url=base_http) as http:
        for _ in range(50):
            try:
                if (await http.get('/api/health')).json().get('status') == 'ok':
                    break
            except Exception:
                pass
            await asyncio.sleep(0.1)

        # 创建 capacity=4 房间 + join 4 人
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 4})
        assert resp.status_code == 200, resp.text
        rid = resp.json()['roomId']
        nicknames = ['甲', '乙', '丙', '丁']
        joins = []
        for name in nicknames:
            j = (await http.post(f'/api/rooms/{rid}/join', json={'nickname': name})).json()
            joins.append(j)
        assert {j['seat'] for j in joins} == {0, 1, 2, 3}, '4 人应占满 4 个座位'
        print(f'房间 {rid}：4 人占座 {[j["seat"] for j in joins]}')

        for j in joins:
            await http.post(f'/api/rooms/{rid}/ready',
                            json={'seat': j['seat'], 'rejoinCode': j['rejoinCode']})

        room = rooms.get(rid)
        if not real_pace:
            room.pace = {}   # 提速：跳过动画/确认屏障的长等待，headless 可靠

        # 连接 4 条 WS → 4 个座位都应为真实（connected=True）
        ws = [await websockets.asyncio.client.connect(
            f'{base_ws}/ws/room/{rid}?rejoin_code={quote(j["rejoinCode"])}') for j in joins]
        try:
            for seat, st in enumerate(room.seats):
                assert st is not None, f'座位 {seat} 应为真人占座'
            # 服务端 on_connect 在握手处理中异步执行，轮询等 4 座位全部连上
            deadline = time.time() + 10
            while not all(st.controller.connected for st in room.seats if st):
                assert time.time() < deadline, '4 座位 WS 未全部连接'
                await asyncio.sleep(0.05)
            print('4 个座位均为真人并全部连接')

            await http.post(f'/api/rooms/{rid}/start')
            timeout = 150 if real_pace else 60
            results = await asyncio.wait_for(
                asyncio.gather(*(auto_player(n, w) for n, w in zip(nicknames, ws))), timeout=timeout)
        finally:
            for w in ws:
                try:
                    await w.close()
                except Exception:
                    pass

    # 校验
    assert all(r and r['turns'] > 0 for r in results), '存在从未轮到回合的客户端'
    matches = [r['match'] for r in results]
    assert all(m and m.get('kind') == 'match_finished' for m in matches), '未全部收到 match_finished'
    final = matches[0]['finalScores']
    assert len(final) == 4, f'最终排名应含 4 人，实际 {len(final)}'
    assert sum(s['score'] for s in final) == 4000, f'分数不守恒: {sum(s["score"] for s in final)}'
    assert set(s['name'] for s in final) == set(nicknames), '最终排名应含全部 4 名玩家'

    print('\n=== 结果 ===')
    for name, r in zip(nicknames, results):
        print(f'  {name}: 回合数 {r["turns"]}')
    print(f'  finalScores = {[(s["name"], s["score"]) for s in final]}')
    print(f'  总分 = {sum(s["score"] for s in final)}（守恒 4000）')
    print('\n4 真人端到端对局通过：全座位真人、人人有回合、结算确认齐、整场东风场完整打完')
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='4 个真实 WS 客户端打完整东风场')
    parser.add_argument('--real-pace', action='store_true', help='保留真人节奏（整场约 90s）')
    args = parser.parse_args()
    try:
        raise SystemExit(asyncio.run(main(args.real_pace)))
    except Exception as exc:
        import traceback
        traceback.print_exc()
        print(f'\n4 真人端到端对局失败：{exc}')
        raise SystemExit(1)
