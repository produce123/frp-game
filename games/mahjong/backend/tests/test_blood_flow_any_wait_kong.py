import pytest

from app.core.blood_flow.ai import decide_blood_flow_action_ev, preferred_any_wait_kong
from app.core.blood_flow.evaluate import evaluate_win, win_input_from_dict
from app.core.lotus_rules import waiting_tiles
from app.core.tiles import TILE_TYPES, create_wall
from app.game.blood_flow_engine import BloodFlowEngine
from app.rules.blood_flow import BloodFlowRuleSet
from tests.test_blood_flow_ai import room_for
from tests.test_blood_flow_engine import make_opening

LUXURY = ['m1','m1','m1','m1','p2','p2','p5','p5','s3','s3','s8','s8','red']
SAFE = ['m1','m1','m1','m2','m3','m4','p1','p2','p3','east','east','east','red','m1']
WINDS = ['east','south','west','m2','m3','m4','p4','p5','p6','s6','s7','s8','red','north']
SMALLER = ['m1','m1','m1','m2','m2','m3','m3','m4','m4','p5','p5','red','green','m1']
KONG = {'kind': 'concealed-kong', 'tile': 'm1'}


def scenario(hands, melds=None):
    melds = melds or [[], [], [], []]
    pool = create_wall()
    for tile in ['p9', 'white', *[t for hand in hands if hand for t in hand],
                 *[t for seat in melds for m in seat for t in m['tiles']]]:
        pool.remove(tile)
    completed = []
    for seat, hand in enumerate(hands):
        count = (14 if seat == 0 else 13) - len(melds[seat]) * 3
        completed.append(hand if hand is not None else pool[:count])
        if hand is None:
            del pool[:count]
    return BloodFlowEngine(authority_epoch='regression', round_id='1', rules=BloodFlowRuleSet(),
        opening=make_opening(hands=completed, melds=melds, wall_front=[], dealer_drawn_index=len(completed[0])-1))


def test_luxury_any_wait_is_self_draw_only_for_every_physical_tile():
    for tile in TILE_TYPES:
        data = dict(concealed=LUXURY, melds=[], jokers=['red','green'], winningTile=tile, source='self-draw')
        assert bool(evaluate_win(win_input_from_dict(data))) == (tile != 'm1')
        for source in ['discard', 'robbed-kong']:
            assert evaluate_win(win_input_from_dict({**data, 'source': source})) is None


@pytest.mark.parametrize('hand,action', [(SAFE, KONG), (WINDS, {'kind': 'wind-kong'})])
@pytest.mark.parametrize('locked', [False, True])
def test_ai_takes_safe_any_wait_kong_and_engine_scores_bloom(hand, action, locked):
    engine = scenario([hand, None, None, None])
    engine.opening_bonus = False
    engine.seats[0]['locked'] = locked
    engine.open_turn()
    view = room_for(engine)._seat_view(0)
    assert decide_blood_flow_action_ev(view) == action
    assert engine.submit(engine.command(0, action))
    assert engine.evaluation[0].score.source == 'kong-bloom'
    engine.assert_conservation()


def test_only_last_tile_allows_smaller_future_hand_for_a_profitable_bloom():
    engine = scenario([SMALLER, None, None, None])
    engine.opening_bonus = False
    engine.seats[0]['locked'] = True
    engine.open_turn()
    view = room_for(engine)._seat_view(0)
    assert preferred_any_wait_kong(view, view['ownActions']) is None
    view['wallCount'] = 1
    assert decide_blood_flow_action_ev(view) == KONG
    view['wallCount'] = 0
    view['ownActions'] = [a for a in view['ownActions'] if a['kind'] != 'concealed-kong']
    assert decide_blood_flow_action_ev(view) == {'kind': 'win'}


@pytest.mark.parametrize('locked', [False, True])
def test_discard_kong_must_preserve_locked_readiness(locked):
    hand0 = ['m7','m8','m9','p7','p8','p9','s7','s8','s9','north','west','south','p4','m5']
    pairs = ['m5','m5','m5','p2','p2','p5','p5','s3','s3','s8','s8','east','east']
    engine = scenario([hand0, pairs, None, None])
    engine.seats[1]['locked'] = locked
    assert engine.submit(engine.command(0, {'kind': 'discard', 'index': 13}))
    assert ({'kind': 'gang'} in engine.window['options'][1]) == (not locked)
    if locked:
        assert not engine.submit(engine.command(1, {'kind': 'gang'}))


@pytest.mark.parametrize('hand,melds,action', [
    ([*LUXURY, 'm7'], [], KONG),
    (['m1','m9','p1','p9','s1','s9','east','south','west','north','red','green','white','m2'], [], {'kind': 'wind-kong'}),
    (['m5','m6','p1','p2','p3','s1','s2','s3','east','east','p7'],
     [{'type': 'peng', 'tile': 'm5', 'tiles': ['m5']*3}], {'kind': 'added-kong', 'meldIndex': 0}),
])
def test_self_kongs_that_break_locked_readiness_are_not_legal(hand, melds, action):
    engine = scenario([hand, None, None, None], [melds, [], [], []])
    assert waiting_tiles(hand[:-1], len(melds), engine.jokers)
    assert action in engine.window['options'][0]
    engine.seats[0]['locked'] = True
    engine.open_turn()
    assert action not in engine.window['options'][0]
    assert not engine.submit(engine.command(0, action))
    engine.assert_conservation()
