from dataclasses import replace
import json

import pytest

from app.core import lotus_ai
from app.core.blood_flow import ai as blood_flow_ai
from app.core.blood_flow.big_hand_route import (
    THIRTEEN_ORPHANS,
    detect_big_hand_route,
    narrow_actions_to_route,
)
from app.core.blood_flow.config import (
    BLOOD_FLOW_AI,
    BLOOD_FLOW_BIG_HAND_ROUTE_WIDE,
    BLOOD_FLOW_CONFIG,
    BLOOD_FLOW_DEFENSE,
    BLOOD_FLOW_LLM_AI,
)
from app.core.blood_flow.evaluate import evaluate_win
from app.core.blood_flow.types import WinEvaluationInput
from app.llm.blood_flow_candidates import (
    _big_hand_route_advice, build_blood_flow_candidates,
    build_blood_flow_prompt, candidate_actions,
)


WINNING_WAIT = [
    'm1', 'm2', 'm3', 'm4', 'm5', 'm6',
    'p2', 'p3', 'p4', 's7', 's7', 's7', 'east',
]
ORPHANS_12 = [tile for tile in THIRTEEN_ORPHANS if tile != 'white']
ROUTE_HAND = [*ORPHANS_12, 'm4', 'p4']


def route_view():
    actions = [
        {'kind': 'win'},
        {'kind': 'discard', 'index': 12},
        {'kind': 'discard', 'index': 13},
        {'kind': 'discard', 'index': 0},
    ]
    players = [
        {'seat': seat, 'score': 1000 if seat == 0 else (1500 if seat == 1 else 900),
         'hand': list(ROUTE_HAND) if seat == 0 else [], 'melds': [], 'discards': []}
        for seat in range(4)
    ]
    return {
        'seat': 0, 'players': players, 'jokers': [], 'flipTile': 'white',
        'wallCount': 19, 'ownScore': {'paymentPerPayer': 20, 'source': 'self-draw'},
        'ownActions': actions,
        'window': {'id': 'window-1', 'kind': 'turn', 'source': {'kind': 'draw', 'seat': 0}},
        'public': {'seats': [{'locked': False, 'winCount': 0} for _ in range(4)],
                   'batches': []},
        'ruleVersion': 'lotus-blood-flow-v1',
    }


def test_profiles_match_frontend_local_and_llm_split():
    assert BLOOD_FLOW_AI.chain_forecast == 'source-v2'
    assert BLOOD_FLOW_AI.opportunity_calibration.draw_scale == pytest.approx(0.9975786924939467)
    assert BLOOD_FLOW_AI.route_opportunity_guard is True
    assert BLOOD_FLOW_AI.claim_meld_projection is True
    assert BLOOD_FLOW_AI.claim_ready_net_guard is True
    assert BLOOD_FLOW_AI.big_hand_route.mode == 'bot'
    assert set(BLOOD_FLOW_AI.big_hand_route.enabled) == {
        'thirteenOrphans', 'nineGates', 'pureSuit', 'mixedSuit', 'allTriplets',
    }

    assert BLOOD_FLOW_LLM_AI.chain_forecast == 'legacy'
    assert BLOOD_FLOW_LLM_AI.opportunity_calibration is None
    assert BLOOD_FLOW_LLM_AI.route_opportunity_guard is False
    assert BLOOD_FLOW_LLM_AI.claim_meld_projection is False
    assert BLOOD_FLOW_LLM_AI.claim_ready_net_guard is False
    assert BLOOD_FLOW_LLM_AI.route_advice_only is True
    assert BLOOD_FLOW_LLM_AI.win_opportunity_guards is True
    assert BLOOD_FLOW_LLM_AI.big_hand_route.mode == 'llm'


def test_source_v2_canonical_income_matches_the_rules_evaluator():
    discard = evaluate_win(WinEvaluationInput(
        concealed=tuple(WINNING_WAIT), melds=(), winning_tile='east',
        source='discard', jokers=(), opening=None,
    ), BLOOD_FLOW_CONFIG)
    self_draw = evaluate_win(WinEvaluationInput(
        concealed=tuple(WINNING_WAIT), melds=(), winning_tile='east',
        source='self-draw', jokers=(), opening=None,
    ), BLOOD_FLOW_CONFIG)

    assert discard is not None and self_draw is not None
    assert blood_flow_ai.forecast_win_income(
        WINNING_WAIT, [], [], 'east', 'discard') == discard.score.payment_per_payer
    assert blood_flow_ai.forecast_win_income(
        WINNING_WAIT, [], [], 'east', 'self-draw') == self_draw.score.payment_per_payer * 3


def test_wait_cache_matches_canonical_scorer_waits_for_standard_and_orphans():
    cases = [
        (WINNING_WAIT, []),
        (list(THIRTEEN_ORPHANS), []),
    ]
    for hand, jokers in cases:
        expected = set()
        for tile in blood_flow_ai.TILE_TYPES:
            for source in ('self-draw', 'discard'):
                result = evaluate_win(WinEvaluationInput(
                    concealed=tuple(hand), melds=(), winning_tile=tile,
                    source=source, jokers=tuple(jokers), opening=None,
                ), BLOOD_FLOW_CONFIG)
                if result is not None:
                    expected.add(tile)
                    break
        assert set(blood_flow_ai.waiting_tiles_cached(hand, 0, jokers)) == expected


def test_source_v2_opportunity_counts_match_frontend_rotation_model():
    assert blood_flow_ai.own_draw_opportunities(60, 8, 4) == 8
    assert blood_flow_ai.own_draw_opportunities(10, 2, 1) == 2
    assert blood_flow_ai.own_draw_opportunities(3, 2, 4) == 0
    assert blood_flow_ai.normal_opportunities(10, 2, 1) == {'own': 2, 'opponent': 6}


def test_chain_forecast_profile_selects_the_configured_model(monkeypatch):
    monkeypatch.setattr(blood_flow_ai, 'forecast_calibrated_income',
                        lambda *_args, **_kwargs: 123.0)
    monkeypatch.setattr(blood_flow_ai, '_chain_ev_legacy',
                        lambda *_args, **_kwargs: 45.0)
    assert blood_flow_ai.chain_ev_est(
        [], [], [], [], 10, config=BLOOD_FLOW_AI) == 123.0
    assert blood_flow_ai.chain_ev_est(
        [], [], [], [], 10, config=BLOOD_FLOW_LLM_AI) == 45.0


def test_last_opportunity_ron_guard_is_profile_scoped():
    view = {
        'seat': 1,
        'players': [{'seat': seat} for seat in range(4)],
        'wallCount': 4,
        'ownScore': {'source': 'discard', 'paymentPerPayer': 20},
        'ownActions': [{'kind': 'win'}, {'kind': 'pass'}],
        'window': {'kind': 'win', 'source': {'kind': 'discard', 'seat': 0}},
        'public': {'seats': [{'locked': False} for _ in range(4)]},
    }
    assert blood_flow_ai._is_last_opportunity_ron(view, BLOOD_FLOW_LLM_AI)
    assert not blood_flow_ai._is_last_opportunity_ron(view, BLOOD_FLOW_AI)

    view['ownActions'].append({'kind': 'peng'})
    assert not blood_flow_ai._is_last_opportunity_ron(view, BLOOD_FLOW_LLM_AI)


def test_wide_route_commitment_preserves_only_route_safe_discards():
    route = detect_big_hand_route(ROUTE_HAND, [], [], BLOOD_FLOW_BIG_HAND_ROUTE_WIDE)
    assert route is not None
    assert route['id'] == 'thirteenOrphans'
    actions = [
        {'kind': 'win'},
        {'kind': 'discard', 'index': 12},
        {'kind': 'discard', 'index': 13},
        {'kind': 'discard', 'index': 0},
        {'kind': 'pass'},
    ]
    plan = narrow_actions_to_route(
        ROUTE_HAND, [], [], actions, config=BLOOD_FLOW_BIG_HAND_ROUTE_WIDE,
        base_points=BLOOD_FLOW_CONFIG.base_points, immediate_win_payment=20,
        wall_count=30, score_deficit=0,
    )
    assert plan['collapsed'] is True
    assert not any(action['kind'] == 'win' for action in plan['actions'])
    assert {'kind': 'discard', 'index': 12} in plan['actions']
    assert {'kind': 'discard', 'index': 13} in plan['actions']
    assert {'kind': 'discard', 'index': 0} not in plan['actions']


def test_route_opportunity_guard_restores_last_cheap_self_draw():
    view = route_view()
    guarded = blood_flow_ai.narrow_routes_for_bot(view, view['ownActions'], BLOOD_FLOW_AI)
    assert guarded['collapsed'] is False
    assert guarded['actions'] == view['ownActions']

    unguarded_config = replace(BLOOD_FLOW_AI, route_opportunity_guard=False)
    unguarded = blood_flow_ai.narrow_routes_for_bot(view, view['ownActions'], unguarded_config)
    assert unguarded['collapsed'] is True
    assert not any(action['kind'] == 'win' for action in unguarded['actions'])


def test_llm_route_is_advice_only_and_does_not_prune_actions():
    view = route_view()
    config = replace(
        BLOOD_FLOW_LLM_AI,
        defense=replace(BLOOD_FLOW_DEFENSE, mode='off'),
    )
    route = _big_hand_route_advice(view, config)
    assert route is not None and route['id'] == 'thirteenOrphans'
    assert candidate_actions(view, config) == view['ownActions']
    built = build_blood_flow_candidates(view, 'route-advice', config=config)
    assert built['bigHandRoute']['id'] == 'thirteenOrphans'
    assert len(built['candidates']) == len(view['ownActions'])
    _system, user = build_blood_flow_prompt('稳健', view, built, config)
    assert json.loads(user)['bigHandRoute']['id'] == 'thirteenOrphans'


def test_claim_meld_projection_passes_the_new_meld_to_pattern_ev(monkeypatch):
    observed = []

    def current_quality(*_args, **_kwargs):
        return {'ready': False, 'netScore': 0}

    def best_discard(_hand, *_args, extras=None, **_kwargs):
        observed.append(list((extras or {}).get('melds') or []))
        return None

    monkeypatch.setattr(lotus_ai, '_current_hand_quality', current_quality)
    monkeypatch.setattr(lotus_ai, '_best_discard_after_claim', best_discard)
    base = {
        'hand': ['m1', 'm1', 'm2'], 'exposedMelds': 0, 'jokers': [],
        'tile': 'm1', 'canGang': False, 'canPeng': True, 'chiOptions': [],
        'melds': [], 'patternBonus': lambda _hand, _melds: 0,
    }

    lotus_ai.decide_claim({**base, 'claimMeldProjection': True})
    assert observed[-1][-1]['type'] == 'peng'
    assert observed[-1][-1]['tiles'] == ['m1', 'm1', 'm1']

    lotus_ai.decide_claim({**base, 'claimMeldProjection': False})
    assert observed[-1] == []


@pytest.mark.parametrize(('guard', 'expected'), [(False, 'peng'), (True, 'pass')])
def test_claim_ready_net_guard_requires_net_gain_when_claim_creates_tenpai(
        monkeypatch, guard, expected):
    monkeypatch.setattr(lotus_ai, '_current_hand_quality',
                        lambda *_args, **_kwargs: {'ready': False, 'netScore': 10})
    monkeypatch.setattr(
        lotus_ai, '_best_discard_after_claim',
        lambda *_args, **_kwargs: {
            'index': 0, 'quality': {'ready': True, 'netScore': 10},
        },
    )
    monkeypatch.setattr(lotus_ai, '_compare_quality', lambda _candidate, _baseline: 1)
    result = lotus_ai.decide_claim({
        'hand': ['m1', 'm1', 'm2'], 'exposedMelds': 0, 'jokers': [],
        'tile': 'm1', 'canGang': False, 'canPeng': True, 'chiOptions': [],
        'claimReadyNetGuard': guard,
    })
    assert result['kind'] == expected
