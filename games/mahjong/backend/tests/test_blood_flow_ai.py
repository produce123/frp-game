"""血流 EV 策略翻译测试（M4）—— 对齐前端 evStrategy.test.ts 的关键局面。"""

import pytest

from app.core.blood_flow.ai import (blood_flow_ev_context, decide_blood_flow_action_ev,
                                    pattern_potential_total)
from app.core.blood_flow.config import BLOOD_FLOW_AI
from app.game.blood_flow_engine import BloodFlowEngine, SEATS
from app.game.blood_flow_room import BloodFlowRoomSession
from app.rules.blood_flow import BloodFlowRuleSet
from tests.test_blood_flow_engine import make_opening, pass_all_claims


def room_for(engine: BloodFlowEngine) -> BloodFlowRoomSession:
    room = BloodFlowRoomSession('AI-T', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.engine = engine
    return room


def test_locked_hand_stays_fully_automatic():
    hands = [
        ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p4', 'm5'],
        ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
        ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='lock-ai', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['north']))
    assert engine.submit(engine.command(0, {'kind': 'discard', 'index': 13}))
    assert engine.submit(engine.command(1, {'kind': 'win'}))
    for seat in (2, 3):
        if engine.window and engine.window['options'][seat]:
            engine.submit(engine.command(seat, {'kind': 'pass'}))
    view = room_for(engine)._seat_view(1)
    assert view['public']['seats'][1]['locked'] is True
    decision = decide_blood_flow_action_ev(view, BLOOD_FLOW_AI)
    assert decision is not None
    assert decision['kind'] == 'discard'
    assert decision['index'] == view['players'][1]['drawnTileIndex']


def test_late_game_takes_any_win():
    hands = [
        ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p4', 'm5'],
        ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
        ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='late-ai', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['north']))
    assert engine.submit(engine.command(0, {'kind': 'discard', 'index': 13}))
    view = room_for(engine)._seat_view(1)
    view['wallCount'] = 8  # 残局：见胡就胡
    assert decide_blood_flow_action_ev(view, BLOOD_FLOW_AI) == {'kind': 'win'}


def test_early_cheap_win_declined_with_pattern_potential():
    hands = [
        ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p4', 'm5'],
        ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
        ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='early-ai', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['north']))
    assert engine.submit(engine.command(0, {'kind': 'discard', 'index': 13}))
    view = room_for(engine)._seat_view(1)
    view['wallCount'] = 60
    view['ownScore'] = {'paymentPerPayer': 10, 'source': 'discard', 'items': [], 'hardWin': False}
    decision = decide_blood_flow_action_ev(view, BLOOD_FLOW_AI)
    assert decision is not None and decision['kind'] != 'win'


def test_drawing_the_joker_reforms_into_any_tile_wait():
    hands = [
        ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p1', 'p1', 's7', 'white'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
        ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'p4'],
        ['m3', 'm9', 'p7', 's1', 's4', 'p4', 'p6', 's2', 's5', 's8', 'red', 'green', 'white'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='reform-ai', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['north'], jokers=['white']))
    view = room_for(engine)._seat_view(0)
    assert {'kind': 'win'} in view['ownActions']
    decision = decide_blood_flow_action_ev(view, BLOOD_FLOW_AI)
    assert decision == {'kind': 'discard', 'index': 12}  # 弃 s7 保 white → 单吊任意听


def test_robbed_kong_greedy_both_ways():
    base_hands = [
        ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p4', 'm5'],
        ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
        ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='rob-ai', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=base_hands, wall_front=['north']))
    view = room_for(engine)._seat_view(1)
    view['ownActions'] = [{'kind': 'win'}, {'kind': 'pass'}]
    view['window'] = {'id': 'w', 'version': 1, 'kind': 'win',
                      'source': {'id': 's', 'kind': 'added-kong', 'tile': 'east', 'seat': 0},
                      'deadlineAt': 0, 'opensAt': 0}
    # 高番抢杠：胡。
    # 注：这里用 80 而不是 40——40 点时胡/过几乎打平（winEv 708.22 vs passEv 708.56），
    # 2026-09-13 修掉绿一色镜像偏差（Python 之前要求整手全绿，前端只看副露）后潜力分上调，
    # 该手在 40 点档会按"过"结算；这与前端口径一致（前端同口径下同样判过），故抬高赔付保住两支覆盖。
    view['ownScore'] = {'paymentPerPayer': 80, 'source': 'robbed-kong', 'items': [], 'hardWin': False}
    assert decide_blood_flow_action_ev(view, BLOOD_FLOW_AI) == {'kind': 'win'}
    # 低番抢杠 + 距大番一张：过。
    near_big = ['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3', 'm4', 'm4', 'm4', 'east']
    view['players'][1]['hand'] = list(near_big)
    view['players'][1]['melds'] = []
    view['jokers'] = []
    view['ownScore'] = {'paymentPerPayer': 20, 'source': 'robbed-kong', 'items': [], 'hardWin': False}
    assert decide_blood_flow_action_ev(view, BLOOD_FLOW_AI) == {'kind': 'pass'}


def test_potential_scores_match_frontend_shapes():
    # 清一色 1-shanten：12 张同花色 + 1 杂 → pure-suit 接近度显著。
    clean = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm9', 'm9']
    directions = pattern_potential_total(clean, [], [])
    assert directions > 3
    with_honor = [*clean[:12], 'east']
    total = pattern_potential_total(with_honor, [], [])
    assert total >= BLOOD_FLOW_AI.potential_floor


def test_fixed_seed_rounds_with_ev_ai_conserve():
    import random as _random
    from app.core.tiles import create_wall
    for seed in range(1, 5):
        engine = BloodFlowEngine(
            authority_epoch='ev-ai', round_id=f'seed-{seed}', rules=BloodFlowRuleSet(),
            ring=_random.Random(seed).sample(create_wall(), 136),
            dice=[seed % 6 + 1, (seed * 2) % 6 + 1],
            second_dice=[(seed * 3) % 6 + 1, (seed * 4) % 6 + 1],
        )
        room = room_for(engine)
        steps = 0
        while not engine.result:
            steps += 1
            assert steps < 2000, f'stalled seed {seed}'
            window = engine.window
            seat = next(s for s in SEATS if window['options'][s] and window['decisions'][s] is None)
            view = room._seat_view(seat)
            action = decide_blood_flow_action_ev(view, BLOOD_FLOW_AI)
            assert action is not None
            if action is None or not engine.submit(engine.command(seat, action)):
                engine.expire()
            engine.assert_conservation()
        assert engine.result['reason'] == 'wall-exhausted'
        assert sum(p['score'] for p in engine.players) == 8000
