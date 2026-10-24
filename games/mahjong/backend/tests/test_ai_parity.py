"""Fixed visible-seat cases shared with the frontend AI regression tests."""

import pytest

from app.core.ai import choose_discard_index
from app.llm.candidates import build_request, inferior_classic_discard
from app.models.game import Meld
from app.rules.registry import get_rule_set
from tests.test_llm import make_llm_player, run, turn_ctx


CLASSIC_HAND = [
    'm2', 'm2', 'm5', 'm5', 'm7', 'p2', 'p3', 'p4', 'p7', 's8',
    'west', 'green', 'white', 'white',
]
LEGACY_HAND = [
    'm1', 'm1', 'p3', 'p7', 'p9', 'p9', 's1', 's2', 's2', 's4',
    'north', 'red', 'white', 'east',
]


def classic_context():
    ctx = turn_ctx(hand=CLASSIC_HAND)
    ctx.wallCount = 79
    ctx.visibleTiles = list(CLASSIC_HAND)
    return ctx


def legacy_context():
    ctx = turn_ctx(hand=LEGACY_HAND)
    public = ['p1', 's8', 'm4', 's8', 'north', 'm4']
    ctx.visibleTiles = [*LEGACY_HAND, *public]
    ctx.publicTiles = public
    ctx.wallCount = 75
    ctx.earlyRound = True
    ctx.jokers = ['m2', 'm3']
    ctx.upperLastDiscard = 'm4'
    return ctx


def test_classic_local_and_llm_recommend_singleton_honor():
    rules = get_rule_set('lotus-classic')
    index = choose_discard_index(
        CLASSIC_HAND, random=lambda: 0.0, rule_set=rules,
        context={'wallCount': 79, 'visibleTiles': CLASSIC_HAND})
    assert CLASSIC_HAND[index] == 'west'
    built = build_request(classic_context(), rules, 'classic', '1', 'turn')
    request = built['request']
    assert CLASSIC_HAND[built['fallbackAction']['handIndex']] == 'west'
    assert next(c for c in request['candidates']
                if c['id'] == request['engineSuggestion'])['features']['efficiency'] == '优'
    assert inferior_classic_discard(request, request['candidates'][0])


def test_classic_model_dominated_choice_uses_this_request_fallback(monkeypatch):
    player, _ = make_llm_player(monkeypatch, ['{"choice":"A1","message":"先打。"}'])
    action = run(player.request_turn(classic_context()))
    assert CLASSIC_HAND[action['handIndex']] == 'west'
    assert player.stats['fallbacks'] == 1
    assert player.stats['successes'] == 0


def test_classic_ready_discard_beats_the_shape_shortlist():
    hand = ['p3', 'p3', 'p8', 'p9', 's3', 's4', 's5', 's6', 's7', 's8', 's5']
    index = choose_discard_index(
        hand, random=lambda: 0.0, rule_set=get_rule_set('lotus-classic'),
        exposed_melds=1, context={'wallCount': 38, 'visibleTiles': hand})
    assert hand[index] == 's8'


def test_legacy_early_recommendation_uses_evaluated_candidates():
    built = build_request(legacy_context(), get_rule_set('lotus-legacy'),
                          'legacy', '1', 'turn')
    request = built['request']
    chosen = next(c for c in request['candidates']
                  if c['id'] == request['engineSuggestion'])
    assert LEGACY_HAND[built['fallbackAction']['handIndex']] == 'north'
    assert chosen['features']['shanten'] <= 2
    assert chosen['features']['ukeire'] > 0


def test_legacy_model_error_keeps_the_recorded_recommendation(monkeypatch):
    player, _ = make_llm_player(monkeypatch, [RuntimeError('provider down')])
    player.set_rule_set(get_rule_set('lotus-legacy'))
    action = run(player.request_turn(legacy_context()))
    assert LEGACY_HAND[action['handIndex']] == 'north'
    assert player.stats['fallbacks'] == 1


@pytest.mark.parametrize('ruleset_id, hand, meld', [
    ('lotus-classic', ['p3', 'p3', 'p8', 'p9', 's3', 's4', 's5', 's6', 's7', 's8', 's5'],
     Meld(type='peng', tile='m9', from_=2, tiles=['m9'] * 3)),
    ('lotus-legacy', ['m7', 'm9', 'p7', 'p8', 's4', 's5', 'west', 'north',
                      'red', 'red', 'white'],
     Meld(type='chi', tile='s8', from_=1, tiles=['s7', 's8', 's9'])),
])
def test_skip_draw_recommends_only_a_legal_discard(ruleset_id, hand, meld):
    ctx = turn_ctx(hand=hand, melds=[meld], exposed_melds=1, skip_draw=True)
    ctx.visibleTiles = list(hand)
    ctx.wallCount = 38 if ruleset_id == 'lotus-classic' else 72
    ctx.jokers = ['m5', 'm6'] if ruleset_id == 'lotus-legacy' else []
    built = build_request(ctx, get_rule_set(ruleset_id), 'skip', '1', 'turn')
    assert all(c['action']['kind'] == 'discard' for c in built['request']['candidates'])
    assert built['fallbackAction']['kind'] == 'discard'
    assert any(c['id'] == built['request']['engineSuggestion']
               and c['action'] == built['fallbackAction']
               for c in built['request']['candidates'])
