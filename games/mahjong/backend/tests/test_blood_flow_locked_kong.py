"""胡后开杠：Python 权威动作、多人窗口时间与客户端提交。"""
import asyncio
from contextlib import suppress
import time

import pytest

from app.core.tiles import create_wall
from app.game.blood_flow_engine import BloodFlowEngine
from app.game.blood_flow_room import BloodFlowRoomSession, _fallback_policy
from app.rules.blood_flow import BloodFlowRuleSet
from tests.test_blood_flow_engine import make_opening


def locked_engine(kind):
    melds = [[], [], [], []]
    seat = 1 if kind == 'gang' else 0
    if kind == 'gang':
        hand = ['m3','m4','m5','m5','m5','p1','p2','p3','s1','s2','s3','east','east']
        action = {'kind': 'gang'}
    elif kind == 'concealed-kong':
        hand = ['m1','m1','m1','m1','m2','m3','p1','p2','p3','s1','s2','s3','east','east']
        action = {'kind': kind, 'tile': 'm1'}
    elif kind == 'added-kong':
        hand = ['m1','m2','m3','m4','p1','p2','p3','s1','s2','s3','east']
        melds[0] = [{'type': 'peng', 'tile': 'm1', 'tiles': ['m1'] * 3, 'from': 1}]
        action = {'kind': kind, 'meldIndex': 0}
    else:
        hand = ['east','south','west','north','m1','m2','m3','p1','p2','p3','s1','s2','s3','east']
        action = {'kind': 'wind-kong'}
    pool = create_wall()
    reserved = ['p9', 'white', *hand, *[t for m in melds[0] for t in m['tiles']]]
    if kind == 'gang':
        reserved.append('m5')
    for tile in reserved:
        pool.remove(tile)
    hands = []
    for s in range(4):
        if s == seat:
            hands.append(hand)
        else:
            count = 13 if s or kind == 'gang' else 14
            hands.append(pool[:count]); del pool[:count]
            if s == 0 and kind == 'gang':
                hands[-1].append('m5')
    engine = BloodFlowEngine(authority_epoch='locked-kong', round_id='1', rules=BloodFlowRuleSet(),
        opening=make_opening(hands=hands, melds=melds, wall_front=[], dealer_drawn_index=len(hands[0])-1))
    engine.seats[seat]['locked'] = True
    engine.seats[seat]['winCount'] = 1
    if kind == 'gang':
        assert engine.submit(engine.command(0, {'kind': 'discard', 'index': 13}))
    else:
        engine.open_turn()
    return engine, seat, action


@pytest.mark.parametrize('kind', ['gang', 'concealed-kong', 'added-kong', 'wind-kong'])
def test_locked_kongs_are_legal_and_preserve_tiles(kind):
    engine, seat, action = locked_engine(kind)
    options = engine.window['options'][seat]
    assert action in options
    assert not any(a['kind'] in ('peng', 'chi') for a in options)
    assert engine.submit(engine.command(seat, action))
    # Finish other seats' responses; a manual kong wins any simultaneous hu competition.
    if engine.window and engine.window['kind'] != 'turn':
        engine.expire()
    assert any(m['type'] in ('gang', 'angang') for m in engine.players[seat]['melds'])
    assert engine.seats[seat]['locked']
    engine.assert_conservation()


def test_deadline_prefers_kong_over_win_for_a_locked_player():
    engine, seat, action = locked_engine('concealed-kong')
    assert {'kind': 'win'} in engine.window['options'][seat]
    engine.expire()
    assert engine.players[seat]['melds'][0]['type'] == 'angang'
    engine.assert_conservation()


def test_locked_discard_kong_fallback_is_a_legal_response():
    engine, seat, action = locked_engine('gang')
    # The response fallback must never try to discard the nonexistent drawn tile.
    assert _fallback_policy(engine, seat) in engine.window['options'][seat]


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', ['gang', 'concealed-kong', 'added-kong', 'wind-kong'])
async def test_connected_human_keeps_twelve_seconds_and_can_submit_kong(kind):
    engine, seat, action = locked_engine(kind)
    room = BloodFlowRoomSession('LOCKED-KONG', mode='east', capacity=4,
                               ruleset_id='lotus-blood-flow', pace=0)
    room.engine = engine
    for s in range(4):
        room.join_or_rejoin(f'玩家{s}', None, f'p{s}')
        room.on_connect(s)
    snapshots = []
    room.broadcast_snapshot = lambda: snapshots.append(room.snapshot_for(seat))
    task = asyncio.create_task(room._play_round(engine))
    try:
        for _ in range(100):
            if snapshots:
                break
            await asyncio.sleep(.01)
        assert snapshots
        view = snapshots[-1]['view']
        window_id = engine.window['id']
        assert action in view['ownActions']
        assert 11_000 <= view['window']['deadlineAt'] - time.time() * 1000 <= 12_000
        await asyncio.sleep(.9)
        assert engine.window['id'] == window_id
        assert engine.window['decisions'][seat] is None
        assert room._human_pending(engine.window)
        assert room.handle_client_message(seat, {
            'kind': 'action', 'windowId': window_id, 'stateVersion': engine.window['version'], 'action': action,
        }) == (True, '')
    finally:
        room.closed = True
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
