"""Play three concurrent east matches through REST + real local WebSockets.

Each room has two connected human clients and two ordinary bots. The process
refuses to start unless PostgreSQL and local login bypass are configured.
"""

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import threading
import time
from urllib.parse import quote
from uuid import uuid4

import httpx
from dotenv import load_dotenv
import uvicorn
import websockets.asyncio.client


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


RULESETS = ('lotus-classic', 'lotus-legacy', 'lotus-blood-flow')


def choose_blood_flow(view: dict) -> dict:
    actions = view.get('ownActions') or []
    win = next((action for action in actions if action['kind'] == 'win'), None)
    if win:
        return win
    if view['public']['seats'][view['seat']]['locked']:
        return next((action for action in actions if action['kind'] in (
            'gang', 'concealed-kong', 'added-kong', 'wind-kong')),
            next((action for action in actions if action['kind'] == 'discard'),
                 {'kind': 'pass'}))
    discards = [action for action in actions if action['kind'] == 'discard']
    if discards:
        hand = view['players'][view['seat']]['hand']
        protected = {*view['jokers'], 'white'}
        ordinary = [action for action in discards if hand[action['index']] not in protected]
        return (ordinary or discards)[0]
    return {'kind': 'pass'}


async def play_client(ws, ruleset: str) -> dict:
    counts = {'messages': 0, 'actions': 0, 'rounds': 0, 'snapshots': 0}
    errors = []
    handled_window = None
    continued = set()
    seat = None
    while True:
        message = json.loads(await asyncio.wait_for(ws.recv(), timeout=45))
        counts['messages'] += 1
        kind = message.get('kind')
        if kind == 'error':
            errors.append(message.get('code'))
            continue
        if kind == 'rejoin_ok':
            seat = message.get('seat')
        if ruleset != 'lotus-blood-flow':
            if kind == 'turn_request':
                await ws.send(json.dumps({'type': 'discard', 'handIndex': 0}))
                counts['actions'] += 1
            elif kind in ('claim_request', 'rob_kong_request'):
                await ws.send(json.dumps({'type': 'pass'}))
                counts['actions'] += 1
            elif kind == 'hand_result':
                counts['rounds'] += 1
            elif kind == 'continue_prompt':
                await ws.send(json.dumps({'type': 'continue'}))
            elif kind == 'match_finished':
                return {**counts, 'seat': seat, 'errors': errors,
                        'finalScores': message.get('finalScores'),
                        'rulesetId': message.get('rulesetId')}
            continue

        if kind != 'bf_snapshot':
            continue
        counts['snapshots'] += 1
        view = message.get('view') or {}
        if view:
            seat = view['seat']
        if message.get('opening'):
            await ws.send(json.dumps({'kind': 'opening_done', 'round': message.get('round')}))
        round_result = message.get('roundResult')
        round_number = message.get('round') or 0
        if round_result and round_number not in continued:
            continued.add(round_number)
            counts['rounds'] += 1
            await ws.send(json.dumps({'kind': 'continue', 'round': round_number}))
        if view.get('window') and view.get('ownActions'):
            window_id = view['window']['id']
            if window_id != handled_window:
                handled_window = window_id
                await ws.send(json.dumps({
                    'kind': 'action', 'windowId': window_id,
                    'stateVersion': view['window']['version'],
                    'action': choose_blood_flow(view),
                }))
                counts['actions'] += 1
        if message.get('matchFinished') and round_result:
            return {**counts, 'seat': seat, 'errors': errors,
                    'final': {key: round_result[key] for key in (
                        'reason', 'endingScores', 'openingScores', 'winCounts')},
                    'rulesetId': 'lotus-blood-flow'}


async def setup_room(http: httpx.AsyncClient, base_ws: str, ruleset: str,
                     room_registry, run_id: str) -> dict:
    creator = f'{run_id}-{ruleset}-creator'
    response = await http.post('/api/rooms', json={
        'mode': 'east', 'capacity': 2, 'rulesetId': ruleset,
        'llmEnabled': False, 'playerId': creator,
    })
    assert response.status_code == 200, (ruleset, response.status_code, response.text)
    room_id = response.json()['roomId']
    joins = []
    for index in range(2):
        player_id = f'{run_id}-{ruleset}-{index}'
        joined = await http.post(f'/api/rooms/{room_id}/join', json={
            'nickname': f'{ruleset}-{index}', 'playerId': player_id,
        })
        assert joined.status_code == 200, (ruleset, joined.status_code, joined.text)
        entry = joined.json()
        joins.append(entry)
        ready = await http.post(f'/api/rooms/{room_id}/ready', json={
            'seat': entry['seat'], 'rejoinCode': entry['rejoinCode'],
        })
        assert ready.status_code == 200 and ready.json()['ready'] is True
    room = room_registry.get(room_id)
    assert room is not None and room.ruleset_id == ruleset
    assert not room.effective_llm_enabled
    room.pace = {}  # Preserve rules and decisions, shorten presentation delays.
    sockets = [await websockets.asyncio.client.connect(
        f'{base_ws}/ws/room/{room_id}?rejoin_code={quote(entry["rejoinCode"])}')
        for entry in joins]
    return {'ruleset': ruleset, 'roomId': room_id, 'sockets': sockets, 'room': room}


async def play_room(http: httpx.AsyncClient, ready: dict) -> dict:
    room_id = ready['roomId']
    sockets = ready['sockets']
    started = time.monotonic()
    try:
        response = await http.post(f'/api/rooms/{room_id}/start')
        assert response.status_code == 200, (room_id, response.status_code, response.text)
        clients = await asyncio.wait_for(asyncio.gather(*(
            play_client(ws, ready['ruleset']) for ws in sockets)), timeout=600)
    finally:
        await asyncio.gather(*(ws.close() for ws in sockets), return_exceptions=True)
    assert {client['seat'] for client in clients} == {0, 1}
    assert all(not client['errors'] and client['actions'] > 0 for client in clients), clients
    assert ready['room'].status == 'finished'
    if ready['ruleset'] == 'lotus-blood-flow':
        assert ready['room'].match_finished
        final = clients[0]['final']
        assert final['reason'] == 'wall-exhausted'
        assert sum(final['endingScores']) == 8000
        assert sum(final['winCounts']) > 0
        assert all(client['snapshots'] > 30 and client['actions'] > 30 for client in clients)
        summary = {'endingScores': final['endingScores'], 'winCounts': final['winCounts']}
    else:
        assert ready['room'].manager.match_finished
        scores = clients[0]['finalScores']
        assert clients[0]['rulesetId'] == ready['ruleset']
        expected_total = 8000 if ready['ruleset'] == 'lotus-legacy' else 4000
        assert scores is not None and sum(player['score'] for player in scores) == expected_total
        assert all(client['rounds'] > 0 for client in clients)
        summary = {'endingScores': [player['score'] for player in scores]}
    return {'rulesetId': ready['ruleset'], 'roomId': room_id,
            'durationSeconds': round(time.monotonic() - started, 2),
            'clients': clients, **summary}


async def play_all(app, room_registry) -> dict:
    server = uvicorn.Server(uvicorn.Config(
        app, host='127.0.0.1', port=0, log_level='warning', access_log=False))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 15
        while not server.started:
            assert time.monotonic() < deadline, 'Local WS service did not start'
            await asyncio.sleep(0.02)
        port = server.servers[0].sockets[0].getsockname()[1]
        run_id = uuid4().hex[:8]
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}',
                                     trust_env=False, timeout=20) as http:
            ready = await asyncio.gather(*(
                setup_room(http, f'ws://127.0.0.1:{port}', ruleset,
                           room_registry, run_id) for ruleset in RULESETS))
            results = await asyncio.gather(*(play_room(http, room) for room in ready))
        return {'storage': 'PostgresStorage', 'mode': 'east',
                'concurrentRooms': len(ready),
                'rooms': results}
    finally:
        server.should_exit = True
        thread.join(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, help='PostgreSQL development env file')
    parser.add_argument('--out', type=Path, help='Write JSON evidence to this path')
    args = parser.parse_args()
    if args.env_file:
        assert args.env_file.is_file(), args.env_file
        load_dotenv(args.env_file)
    else:
        load_dotenv()
    os.environ['LOG_TO_FILE'] = '0'
    os.environ['LOG_LEVEL'] = 'WARNING'
    assert os.environ.get('PG_PASSWORD'), 'PG_PASSWORD is required; SQLite is not used'
    assert os.environ.get('WAKUDEMO_LOGIN_BYPASS', '').lower() in (
        '1', 'true', 'yes', 'on'), 'Local login bypass is required'
    from app.storage.db import storage
    assert type(storage).__name__ == 'PostgresStorage'
    from app.main import app
    from app.game.room import room_registry
    result = asyncio.run(play_all(app, room_registry))
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n',
                            encoding='utf-8')
    print(json.dumps({
        'storage': result['storage'], 'mode': result['mode'],
        'concurrentRooms': result['concurrentRooms'],
        'rooms': [{key: room[key] for key in (
            'rulesetId', 'roomId', 'durationSeconds', 'endingScores')}
            | {'roundMessages': [client['rounds'] for client in room['clients']],
               'clientActions': [client['actions'] for client in room['clients']],
               'errors': [client['errors'] for client in room['clients']]}
            | ({'winCounts': room['winCounts']} if 'winCounts' in room else {})
            for room in result['rooms']],
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
