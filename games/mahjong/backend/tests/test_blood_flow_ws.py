"""血流 WebSocket 端到端冒烟 —— 真实 uvicorn + websockets 双客户端打完整东风场。

对齐 test_ws.py 的托管方式（conftest 的 server fixture，REST 走 /start 保证
game_task 绑定 uvicorn 循环）。校验：快照形状、真人动作回路、墙尽结算、
分数守恒(8000)、有胡记录、无错误消息。本地开发免登录（登录桩按 Cookie 区分身份）。
"""

import asyncio
import json
from urllib.parse import quote

import httpx
import pytest
import websockets
import websockets.asyncio.client  # noqa: F401

from app.core.blood_flow.config import BLOOD_FLOW_CONFIG
from app.game.room import room_registry as rooms


def choose(view: dict) -> dict:
    """按快照 ownActions 选择合法动作（与后端房间测试同口径）。"""
    actions = view.get('ownActions') or []
    win = next((a for a in actions if a['kind'] == 'win'), None)
    if win:
        return win
    if view['public']['seats'][view['seat']]['locked']:
        # 胡后也可收到杠响应；测试客户端必须按当前合法动作提交。
        return next((a for a in actions if a['kind'] in ('gang', 'concealed-kong', 'added-kong', 'wind-kong')),
                    next((a for a in actions if a['kind'] == 'discard'), {'kind': 'pass'}))
    discards = [a for a in actions if a['kind'] == 'discard']
    if discards:
        hand = view['players'][view['seat']]['hand']
        ordinary = [a for a in discards if hand[a['index']] not in {*view['jokers'], 'white'}]
        return (ordinary or discards)[0]
    return {'kind': 'pass'}


async def auto_player(ws, timeout: float = 30.0) -> dict:
    """自动玩家：bf_snapshot 有窗口就动作；收到错误即失败；直到 matchFinished。"""
    snapshots = 0
    actions = 0
    handled: str | None = None
    continued: set[int] = set()
    errors: list[str] = []
    final = None
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout)
        msg = json.loads(raw)
        kind = msg.get('kind')
        if kind == 'error':
            errors.append(msg.get('code'))
            continue
        if kind != 'bf_snapshot':
            continue
        snapshots += 1
        view = msg.get('view') or {}
        if view:  # 开局前的大厅快照 view 为空，跳过形状断言
            assert {'authorityEpoch', 'roundId', 'seat', 'players', 'wallCount',
                    'jokers', 'window', 'ownActions', 'public'} <= set(view.keys())
        if msg.get('opening'):
            # 开局动画就绪回执：服务端屏障等所有在线真人确认后才开打。
            await ws.send(json.dumps({'kind': 'opening_done', 'round': msg.get('round')}))
        round_result = (view.get('public') or {}).get('roundResult')
        if round_result and (msg.get('round') or 0) not in continued:
            # 局间过场回执：结算页确认下一局（末局由 matchFinished 收尾，不需回执）。
            continued.add(msg.get('round') or 0)
            await ws.send(json.dumps({'kind': 'continue', 'round': msg.get('round')}))
        if view.get('window') and view.get('ownActions'):
            window_id = view['window']['id']
            if window_id != handled:
                handled = window_id
                await ws.send(json.dumps({
                    'kind': 'action',
                    'windowId': window_id,
                    'stateVersion': view['window']['version'],
                    'action': choose(view),
                }))
                actions += 1
        if msg.get('matchFinished') and msg.get('roundResult'):
            final = msg['roundResult']
            return {'snapshots': snapshots, 'actions': actions, 'errors': errors, 'final': final}


@pytest.mark.asyncio
async def test_blood_flow_two_clients_full_east_match(server, fresh_rooms):
    base_http, base_ws = server['http'], server['ws']

    def cookie(index: int) -> dict:
        return {'cookies': {'lgm_wakudemo_session': f'bf-{index}'}}

    async with httpx.AsyncClient(base_url=base_http) as http:
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2,
                                                   'rulesetId': 'lotus-blood-flow'}, **cookie(0))
        assert resp.status_code == 200, resp.text
        rid = resp.json()['roomId']
        joins = []
        for index, name in enumerate(('甲', '乙')):
            j = (await http.post(f'/api/rooms/{rid}/join',
                                 json={'nickname': name}, **cookie(index))).json()
            assert 'rejoinCode' in j, j
            joins.append(j)
            await http.post(f'/api/rooms/{rid}/ready',
                            json={'seat': j['seat'], 'rejoinCode': j['rejoinCode']}, **cookie(index))
        room = rooms.get(rid)
        assert room is not None and room.ruleset_id == 'lotus-blood-flow'
        room.pace = 0
        ws = [await websockets.asyncio.client.connect(
            f'{base_ws}/ws/room/{rid}?rejoin_code={quote(j["rejoinCode"])}') for j in joins]
        try:
            await http.post(f'/api/rooms/{rid}/start', **cookie(0))
            results = await asyncio.wait_for(
                asyncio.gather(*(auto_player(w) for w in ws)), timeout=300)
        finally:
            for w in ws:
                try:
                    await w.close()
                except Exception:
                    pass

    final = results[0]['final']
    for result in results:
        assert result['errors'] == [], f'对局中出现错误消息: {result["errors"]}'
        assert result['snapshots'] > 30, f'快照数量异常: {result["snapshots"]}'
        assert result['actions'] > 30, f'客户端未参与对局: {result["actions"]}'
    assert final['reason'] == 'wall-exhausted'
    assert len(final['endingScores']) == 4
    assert sum(final['endingScores']) == BLOOD_FLOW_CONFIG.initial_score * 4
    assert sum(final['winCounts']) > 0, '整场没有任何胡记录'
    assert sum(final['openingScores']) == BLOOD_FLOW_CONFIG.initial_score * 4  # 末局承接分同样守恒
