"""LLM safeguards against the frontend's public-seat regression view."""

from copy import deepcopy
from dataclasses import replace
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.core.blood_flow.ai import (blood_flow_ev_context, blood_flow_llm_safeguard,
                                    decide_blood_flow_action_ev, pattern_potential_ev)
from app.core.blood_flow.config import BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI
from app.game.blood_flow_room import BloodFlowRoomSession
from app.llm.blood_flow_candidates import build_blood_flow_candidates, ev_features_for
from app.llm.config import LlmServerConfig
from tests.test_blood_flow_llm import claim_rig, make_room


REFORM_VIEW = json.loads((Path(__file__).parent / 'fixtures' /
                          'blood_flow_reform_view.json').read_text(encoding='utf-8'))
MELD_VIEW = json.loads((Path(__file__).parent / 'fixtures' /
                        'blood_flow_meld_reachability_view.json').read_text(encoding='utf-8'))


def view_for(kind: str) -> dict:
    view = deepcopy(REFORM_VIEW)
    if kind == 'terminal':
        view['wallCount'] = 0
    elif kind == 'last-ron':
        view['wallCount'] = 4
        view['window'] = {'id': 'last-ron', 'kind': 'win',
                          'source': {'kind': 'discard', 'seat': 1, 'tile': 'm1'}}
        view['ownScore']['source'] = 'discard'
        view['ownActions'] = [{'kind': 'win'}, {'kind': 'pass'}]
    return view


@pytest.mark.parametrize('kind,expected,reason', [
    ('reform', {'kind': 'discard', 'index': 1}, 'verified-any-wait-reform'),
    ('terminal', {'kind': 'win'}, 'terminal-self-draw'),
    ('last-ron', {'kind': 'win'}, 'last-ron-opportunity'),
])
@pytest.mark.asyncio
async def test_proven_action_skips_the_model(kind, expected, reason):
    view = view_for(kind)
    assert blood_flow_llm_safeguard(view, BLOOD_FLOW_LLM_AI) == {
        'action': expected, 'reason': reason}
    room = BloodFlowRoomSession('parity', pace=0)
    room.llm_seats = {view['seat']: LlmServerConfig(
        enabled=True, base_url='x', api_key='x', model='x',
        style='稳健', timeout_s=40.0, timeout_enabled=True)}
    room._seat_view = lambda seat: view
    calls = []

    async def fake_request(*args, **kwargs):
        calls.append((args, kwargs))
        return 'A1', '先看看。'

    room.llm_request = fake_request
    engine = SimpleNamespace(round_id='r', window={'id': 'w'})
    assert await room._llm_action(engine, view['seat']) == expected
    assert calls == []


def test_guards_preserve_adjacent_choices():
    one_draw = view_for('reform')
    one_draw['wallCount'] = 4
    assert blood_flow_llm_safeguard(one_draw, BLOOD_FLOW_LLM_AI) is None
    rich_win = view_for('reform')
    rich_win['ownScore']['paymentPerPayer'] = 1280
    assert blood_flow_llm_safeguard(rich_win, BLOOD_FLOW_LLM_AI) is None
    locked = view_for('reform')
    locked['public']['seats'][locked['seat']]['locked'] = True
    assert blood_flow_llm_safeguard(locked, BLOOD_FLOW_LLM_AI) is None
    competing = view_for('last-ron')
    competing['ownActions'].append({'kind': 'peng'})
    assert blood_flow_llm_safeguard(competing, BLOOD_FLOW_LLM_AI) is None


def test_terminal_candidates_explain_zero_future_income():
    view = view_for('terminal')
    built = build_blood_flow_candidates(view, 'last-draw',
                                        ev_by_key=ev_features_for(view))
    win = next(c for c in built['candidates'] if c['action']['kind'] == 'win')
    assert '末张自摸' in ' '.join(win['features']['risks'])
    assert win['features']['ev']['income'] == {
        'immediate': view['ownScore']['paymentPerPayer'] * 3,
        'future': 0, 'total': view['ownScore']['paymentPerPayer'] * 3,
        'horizonOwnDraws': BLOOD_FLOW_LLM_AI.chain_horizon,
        'model': 'self-draw-v1', 'scope': 'fixed-hand-gross',
        'excludes': ['opponent-payments', 'future-hand-improvements', 'discard-wins'],
    }
    assert 'declinedReason' not in win['features']['ev']['win']


def test_reform_income_matches_the_frontend_recorded_view():
    view = view_for('reform')
    built = build_blood_flow_candidates(view, 'reform',
                                        ev_by_key=ev_features_for(view))
    win = next(c for c in built['candidates'] if c['action']['kind'] == 'win')
    reform = next(c for c in built['candidates']
                  if c['action'] == {'kind': 'discard', 'index': 1})
    assert win['features']['ev']['income']['total'] == 65
    assert reform['features']['ev']['income']['total'] == 240
    assert reform['features']['ukeire'] == 102
    assert decide_blood_flow_action_ev(view, BLOOD_FLOW_AI) == {
        'kind': 'discard', 'index': 4}


def test_fixed_chi_melds_cannot_be_counted_as_triplet_or_special_hand_potential():
    view = deepcopy(MELD_VIEW)
    assert [meld['type'] for meld in view['players'][view['seat']]['melds']] == ['chi'] * 3
    context = blood_flow_ev_context(view, BLOOD_FLOW_AI)
    assert context['potentialTotal'] == 0
    assert context['developEv'] == 0
    assert decide_blood_flow_action_ev(view, BLOOD_FLOW_AI) == {'kind': 'win'}


def test_pattern_potential_uses_the_active_wall_threshold():
    view = view_for('reform')
    player = view['players'][view['seat']]
    args = (player['hand'], player['melds'], view['jokers'], 20, BLOOD_FLOW_AI.seven_pairs_model)
    normal = pattern_potential_ev(*args, BLOOD_FLOW_AI)
    later = pattern_potential_ev(*args, replace(BLOOD_FLOW_AI, late_game_wall_count=25))
    assert normal > 0
    assert later == pytest.approx(normal * 0.4)


@pytest.mark.parametrize('folder,name,local,llm', [
    ('bloodFlow-2c926534', 'round-1-window-73-1.json', {'kind': 'win'}, {'kind': 'win'}),
    ('bloodFlow-2c926534', 'round-2-window-63-2.json',
     {'kind': 'discard', 'index': 4}, {'kind': 'discard', 'index': 1}),
    ('bloodFlow-2c926534', 'round-4-window-316-1.json', {'kind': 'pass'}, {'kind': 'win'}),
    ('bloodFlow-2c926534', 'round-4-window-321-1.json', {'kind': 'pass'}, {'kind': 'win'}),
    ('bloodFlow-c93b3ed8', 'round-1-window-83-2.json',
     {'kind': 'discard', 'index': 3}, {'kind': 'discard', 'index': 3}),
    ('bloodFlow-c93b3ed8', 'round-3-window-130-1.json', {'kind': 'win'}, {'kind': 'win'}),
    ('bloodFlow-c93b3ed8', 'round-3-window-173-2.json', {'kind': 'win'}, {'kind': 'win'}),
    ('bloodFlow-c93b3ed8', 'round-4-window-263-3.json', {'kind': 'pass'}, {'kind': 'pass'}),
])
def test_frontend_recorded_actions_match(folder, name, local, llm):
    frontend = os.environ.get('LOTUS_FRONTEND_ROOT')
    if not frontend:
        pytest.skip('Frontend checkout not supplied for cross-language fixtures')
    path = Path(frontend) / 'src' / 'game' / 'llm' / 'fixtures' / folder / name
    view = json.loads(path.read_text(encoding='utf-8'))
    assert all(not player['hand'] for player in view['players'] if player['seat'] != view['seat'])
    assert decide_blood_flow_action_ev(view, BLOOD_FLOW_AI) == local
    assert decide_blood_flow_action_ev(view, BLOOD_FLOW_LLM_AI) == llm


def test_far_hand_does_not_present_unenumerated_ukeire_as_zero():
    view = view_for('reform')
    hand = ['m2', 'm2', 'm4', 'm4', 'm6', 'm6', 'p2', 'p4', 'p6',
            's2', 's4', 's6', 'east', 'green']
    player = view['players'][view['seat']]
    player['hand'] = hand
    player['melds'] = []
    player['drawnTileIndex'] = 13
    view['jokers'] = ['m1', 'm9']
    view['ownScore'] = None
    view['ownActions'] = [{'kind': 'discard', 'index': i} for i in range(len(hand))]
    built = build_blood_flow_candidates(view, 'far-hand')
    first = built['candidates'][0]['features']
    assert first['shanten'] > 2
    assert first['ukeire'] == 'n/a'
    assert first['effectiveTiles'] == 'n/a'
    assert 'effectiveTotal' not in first
    assert any('未枚举有效进张' in risk for risk in first['risks'])


@pytest.mark.parametrize('failure', ['invalid-choice', 'timeout'])
@pytest.mark.asyncio
async def test_model_failure_returns_to_the_legal_ev_action(failure):
    engine = claim_rig()
    room = make_room(engine)
    room.llm_seats = {1: LlmServerConfig(
        enabled=True, base_url='x', api_key='x', model='x',
        style='稳健', timeout_s=40.0, timeout_enabled=True)}

    async def fake_request(*_args, **_kwargs):
        if failure == 'timeout':
            raise TimeoutError('deadline')
        return 'not-a-candidate', ''

    room.llm_request = fake_request
    await room._decide_bots(engine)
    assert engine.seats[1]['locked'] is True
    assert engine.ledger[-1]['kind'] == 'win'
