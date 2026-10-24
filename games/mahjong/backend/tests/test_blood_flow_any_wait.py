import pytest

from app.core.tiles import TILE_TYPES
from app.core.blood_flow.evaluate import evaluate_win, evaluate_waits
from app.core.blood_flow.types import WinEvaluationInput
from app.core.blood_flow.ai import (chain_ev_est, forecast_source_components,
                                     forecast_self_draw_income)
from app.core.blood_flow.config import BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI
from app.llm.blood_flow_candidates import blood_flow_prompt_rules

HAND = 'm1 m2 m3 s1 s2 s3 p1 p2 p3 east east east m5'.split()
JOKERS = ['m5', 'm6']


def inp(source, tile='s7', hand=None, melds=(), opening=None):
    return WinEvaluationInput(concealed=tuple(HAND if hand is None else hand),
                              melds=tuple(melds), jokers=tuple(JOKERS),
                              winning_tile=tile, source=source, opening=opening)


@pytest.mark.parametrize('source', ['discard', 'robbed-kong'])
def test_any_wait_forbids_every_external_tile_and_earth_win(source):
    for tile in TILE_TYPES:
        assert evaluate_win(inp(source, tile)) is None
    assert evaluate_win(inp(source, opening='earth')) is None


@pytest.mark.parametrize('source', ['self-draw', 'kong-bloom'])
def test_any_wait_retains_all_self_draw_tiles(source):
    for tile in TILE_TYPES:
        assert evaluate_win(inp(source, tile)).score.source == source


def test_melds_and_ordinary_wait_boundary():
    melds = ({'type': 'chi', 'tile': 'm1', 'tiles': ['m1', 'm2', 'm3']},)
    assert evaluate_win(inp('discard', hand=HAND[3:], melds=melds)) is None
    assert evaluate_win(inp('kong-bloom', hand=HAND[3:], melds=melds)) is not None
    narrow = [*HAND[:12], 's7']
    assert evaluate_win(inp('discard', hand=narrow)) is not None
    assert evaluate_win(inp('robbed-kong', hand=narrow)) is not None


def test_wait_previews_and_both_ai_profiles_use_only_available_self_draws():
    waits = evaluate_waits(inp('self-draw'))
    assert len(waits) == 34
    assert all(w['selfDraw'] and w['discard'] is None for w in waits)
    c = forecast_source_components(HAND, [], JOKERS, HAND, 32, 8)
    assert c['selfPerDraw'] > 0 and c['ronPerDiscard'] == 0
    for config in (BLOOD_FLOW_AI, BLOOD_FLOW_LLM_AI):
        assert chain_ev_est(HAND, [], JOKERS, HAND, 3, 'ev', config) == 0
        assert chain_ev_est(HAND, [], JOKERS, HAND, 3, 'ev', config, 1) > 0
    assert chain_ev_est(HAND, [], JOKERS, HAND, 8, 'ev', BLOOD_FLOW_LLM_AI) == pytest.approx(
        forecast_self_draw_income(HAND, [], JOKERS, HAND, 8, 8))
    assert '吃胡（含地胡）与抢杠均禁止，杠上开花保留' in blood_flow_prompt_rules()


def test_llm_compares_both_choices_on_one_self_draw_horizon():
    from tests.test_blood_flow_policy_alignment import route_view
    from app.core.blood_flow.ai import blood_flow_ev_context
    from app.llm.blood_flow_candidates import build_blood_flow_candidates, ev_features_for
    view = route_view()
    view['jokers'] = JOKERS
    view['players'][0]['hand'] = [*HAND[:12], 's7', 'm5']
    view['players'][0]['drawnTileIndex'] = 13
    view['wallCount'] = 3
    view['ownActions'] = [{'kind': 'win'}, {'kind': 'pass'},
                          *({'kind': 'discard', 'index': i} for i in range(14))]
    ctx = blood_flow_ev_context(view, BLOOD_FLOW_LLM_AI)
    assert ctx['incomeModel'] == 'self-draw-v1'
    assert ctx['chainAfterWin'] == 0
    assert any(c['anyWait'] and c['ev'] == 0 for c in ctx['reformCandidates'])
    built = build_blood_flow_candidates(view, 'self-only', ev_by_key=ev_features_for(view))
    incomes = [c['features']['ev']['income'] for c in built['candidates']
               if c['features'].get('ev', {}).get('income')]
    assert incomes and all(i['model'] == 'self-draw-v1' and i['future'] == 0 for i in incomes)
    assert all('discard-wins' in i['excludes'] for i in incomes)
