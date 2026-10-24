"""血流端到端冒烟：headless WS 双客户端打完整东风场（本地开发免登录）。

只起全新后端（默认 :8011，不占 8000/4173），REST 建 lotus-blood-flow 房间
→ join×2 真人 + 2 EV 代打补位 → 准备 → 开局 → 自动打完整场
→ 校验快照形状 / 分数守恒(8000) / 墙尽结算 / 有胡记录 / 无错误消息。

用法：
    cd backend
    PYTHONIOENCODING=utf-8 .venv/Scripts/python scripts/smoke_blood_flow.py
退出码 0 = 通过。
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

PORT = int(os.environ.get('BF_SMOKE_PORT', '8011'))


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


def choose(view: dict) -> dict:
    """按快照 ownActions 选择合法动作（与后端房间测试同口径）。"""
    actions = view.get('ownActions') or []
    win = next((a for a in actions if a['kind'] == 'win'), None)
    if win:
        return win
    if view['public']['seats'][view['seat']]['locked']:
        drawn = view['players'][view['seat']]['drawnTileIndex']
        return {'kind': 'discard', 'index': drawn}
    discards = [a for a in actions if a['kind'] == 'discard']
    if discards:
        hand = view['players'][view['seat']]['hand']
        ordinary = [a for a in discards if hand[a['index']] not in {*view['jokers'], 'white'}]
        return (ordinary or discards)[0]
    return {'kind': 'pass'}


async def auto_player(ws, name: str) -> dict:
    """自动玩家：bf_snapshot 里有窗口就按 choose 提交动作；直到 matchFinished。"""
    snapshots = 0
    actions = 0
    windows = set()
    continued: set[int] = set()
    errors = []
    kinds: dict[str, int] = {}
    final = None
    handled = None
    while True:
        raw = await asyncio.wait_for(ws.recv(), 60.0)
        msg = json.loads(raw)
        kind = msg.get('kind')
        kinds[kind] = kinds.get(kind, 0) + 1
        if kind == 'bf_snapshot':
            snapshots += 1
            view = msg.get('view') or {}
            windows.add((view.get('roundId'), view.get('window') and view['window'].get('id')))
            if msg.get('opening'):
                # 开局动画就绪回执（服务端屏障）。
                await ws.send(json.dumps({'kind': 'opening_done', 'round': msg.get('round')}))
            if (view.get('public') or {}).get('roundResult') \
                    and (msg.get('round') or 0) not in continued:
                # 局间过场回执：确认进入下一局（末局无需，服务端忽略）。
                continued.add(msg.get('round') or 0)
                await ws.send(json.dumps({'kind': 'continue', 'round': msg.get('round')}))
            if view.get('window') and view.get('ownActions'):
                window_id = view['window']['id']
                if window_id != handled:
                    handled = window_id
                    action = choose(view)
                    await ws.send(json.dumps({
                        'kind': 'action',
                        'windowId': window_id,
                        'stateVersion': view['window']['version'],
                        'action': action,
                    }))
                    actions += 1
            if msg.get('matchFinished') and msg.get('roundResult'):
                final = msg['roundResult']
                return {'snapshots': snapshots, 'actions': actions,
                        'windows': len(windows), 'errors': errors, 'final': final,
                        'kinds': kinds}
        elif kind == 'error':
            errors.append(msg.get('code'))


async def play_full_match(base_http: str, base_ws: str) -> dict:
    async with httpx.AsyncClient(base_url=base_http) as http:
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2,
                                                   'rulesetId': 'lotus-blood-flow'})
        assert resp.status_code == 200, resp.text
        rid = resp.json()['roomId']
        joins = []
        for index, name in enumerate(('甲', '乙')):
            # 本地开发旁路按请求体 playerId 推导身份：两个客户端用不同身份占座。
            j = (await http.post(f'/api/rooms/{rid}/join',
                                 json={'nickname': name, 'playerId': f'smoke-bf-{index}'})).json()
            joins.append(j)
            await http.post(f'/api/rooms/{rid}/ready',
                            json={'seat': j['seat'], 'rejoinCode': j['rejoinCode']})
        room = rooms.get(rid)
        assert room is not None and room.ruleset_id == 'lotus-blood-flow', '房间规则集不是 lotus-blood-flow'
        room.pace = 0  # 冒烟提速：跳过演出节奏
        ws = [await websockets.asyncio.client.connect(
            f'{base_ws}/ws/room/{rid}?rejoin_code={quote(j["rejoinCode"])}') for j in joins]
        try:
            await http.post(f'/api/rooms/{rid}/start')
            results = await asyncio.wait_for(
                asyncio.gather(*(auto_player(w, n) for w, n in zip(ws, ('甲', '乙')))), timeout=180)
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

        print('[2/3] 双客户端打完整血流东风场')
        result = await play_full_match(base_http, base_ws)
        final = result['final']
        total = sum(final['endingScores'])
        print(f"      房间 {result['roomId']}  快照 {result['snapshots']}  动作 {result['actions']}  "
              f"窗口 {result['windows']}  消息种类 {result['kinds']}  错误 {result['errors']}")
        print(f"      endingScores={final['endingScores']}  winCounts={final['winCounts']}  "
              f"total={total}  reason={final['reason']}")

        assert result['errors'] == [], f'对局中出现错误消息: {result["errors"]}'
        assert len(final['endingScores']) == 4, '座位数异常'
        assert total == 8000, f'分数不守恒: {total} != 8000'
        assert final['reason'] == 'wall-exhausted', f'结算原因异常: {final["reason"]}'
        assert sum(final['winCounts']) > 0, '整场没有任何胡记录'
        assert result['snapshots'] > 50 and result['actions'] > 50, '快照/动作数量异常（客户端未参与）'

        print('[3/3] 通过：血流完整东风场双客户端无异常，墙尽结算与分数守恒均校验通过')
        return 0


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception as exc:
        import traceback
        traceback.print_exc()
        print(f'\n血流冒烟失败：{exc}')
        raise SystemExit(1)
