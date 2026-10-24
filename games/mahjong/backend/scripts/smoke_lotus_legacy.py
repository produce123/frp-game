"""莲花麻将（lotus-legacy）端到端冒烟：headless WS 双客户端打完整东风场。

只起全新后端（默认 :8010），REST 建 lotus-legacy 房间 → join×2 真人 + 2 AI 补位
→ 准备 → 开局 → 自动打完整场 → 校验翻精牌/牌墙 134/分数守恒(8000)。

不占用户 8000/4173。退出码 0 = 通过。

用法：
    cd backend
    PYTHONIOENCODING=utf-8 .venv/Scripts/python scripts/smoke_lotus_legacy.py
"""

import asyncio
import json
import os
import sys
import threading
import time
from urllib.parse import quote

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

import httpx
import uvicorn
import websockets
import websockets.asyncio.client

from app.main import app
from app.game.room import room_registry as rooms

PORT = int(os.environ.get('LOTUS_SMOKE_PORT', '8010'))


def start_backend() -> None:
    config = uvicorn.Config(app, host='127.0.0.1', port=PORT, log_level='warning')
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not getattr(server, 'started', False):
        if time.time() > deadline:
            raise RuntimeError('uvicorn 启动超时')
        time.sleep(0.02)


async def auto_player(ws, name: str) -> dict:
    """自动玩家：turn → 弃 0；claim/rob → pass；continue_prompt → continue；直到 match_finished。"""
    snapshots = 0
    flip_tiles = set()
    wall_lengths = set()
    while True:
        raw = await asyncio.wait_for(ws.recv(), 15.0)
        msg = json.loads(raw)
        kind = msg.get('kind')
        if kind == 'state_snapshot':
            snapshots += 1
            if msg.get('flipTile'):
                flip_tiles.add(msg['flipTile'])
            if msg.get('wall') is not None:
                wall_lengths.add(len(msg['wall']))
        elif kind == 'turn_request':
            await ws.send(json.dumps({'type': 'discard', 'handIndex': 0}))
        elif kind in ('claim_request', 'rob_kong_request'):
            await ws.send(json.dumps({'type': 'pass'}))
        elif kind == 'continue_prompt':
            await ws.send(json.dumps({'type': 'continue'}))
        elif kind == 'match_finished':
            return {
                'finalScores': msg['finalScores'],
                'snapshots': snapshots,
                'flipTiles': flip_tiles,
                'wallLengths': wall_lengths,
            }


async def play_full_match(base_http: str, base_ws: str) -> dict:
    async with httpx.AsyncClient(base_url=base_http) as http:
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2,
                                                   'rulesetId': 'lotus-legacy'})
        assert resp.status_code == 200, resp.text
        rid = resp.json()['roomId']
        joins = []
        for index, name in enumerate(('甲', '乙')):
            # 本地开发旁路按请求体 playerId 推导身份：两个客户端用不同身份占座。
            j = (await http.post(f'/api/rooms/{rid}/join',
                                 json={'nickname': name, 'playerId': f'smoke-lg-{index}'})).json()
            joins.append(j)
            await http.post(f'/api/rooms/{rid}/ready',
                            json={'seat': j['seat'], 'rejoinCode': j['rejoinCode']})
        room = rooms.get(rid)
        assert room is not None and room.ruleset_id == 'lotus-legacy', '房间规则集不是 lotus-legacy'
        room.pace = {}   # 冒烟提速：跳过开局/结算屏障与 AI 思考延迟
        ws = [await websockets.asyncio.client.connect(
            f'{base_ws}/ws/room/{rid}?rejoin_code={quote(j["rejoinCode"])}') for j in joins]
        try:
            await http.post(f'/api/rooms/{rid}/start')
            results = await asyncio.wait_for(
                asyncio.gather(*(auto_player(w, n) for w, n in zip(ws, ('甲', '乙')))), timeout=90)
            return {'roomId': rid, **results[0]}
        finally:
            for w in ws:
                try:
                    await w.close()
                except Exception:
                    pass


async def main() -> int:
    print(f'[1/3] 启动全新后端 uvicorn :{PORT}')
    start_backend()
    base_http, base_ws = f'http://127.0.0.1:{PORT}', f'ws://127.0.0.1:{PORT}'
    async with httpx.AsyncClient(base_url=base_http) as http:
        deadline = time.time() + 10
        while True:
            try:
                if (await http.get('/api/health')).json().get('status') == 'ok':
                    break
            except Exception:
                pass
            if time.time() > deadline:
                raise RuntimeError('后端健康检查超时')
            await asyncio.sleep(0.1)

        print('[2/3] 双客户端打完整 lotus-legacy 东风场')
        result = await play_full_match(base_http, base_ws)
        scores = result['finalScores']
        total = sum(s['score'] for s in scores)
        print(f"      房间 {result['roomId']}  快照数 {result['snapshots']}  "
              f"翻精牌 {sorted(result['flipTiles'])}  墙长 {sorted(result['wallLengths'])}")
        print(f"      finalScores={[(s['name'], s['score']) for s in scores]}  total={total}")

        assert len(scores) == 4, f'座位数异常: {len(scores)}'
        assert total == 8000, f'分数不守恒: {total} != 8000'
        assert result['flipTiles'], '未观察到翻精牌'
        assert result['wallLengths'] and max(result['wallLengths']) <= 134, '牌墙长度异常'

        print('[3/3] 通过：lotus-legacy 完整东风场无异常，翻精/牌墙/分数守恒均校验通过')
        return 0


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception as exc:
        import traceback
        traceback.print_exc()
        print(f'\nlotus-legacy 冒烟失败：{exc}')
        raise SystemExit(1)
