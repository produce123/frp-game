"""血流计分黄金验收 —— 直接读前端仓库的共享夹具 golden.json / scoring.json（同源）。"""

import json
import os
from pathlib import Path

import pytest

from app.core.blood_flow.config import BLOOD_FLOW_CONFIG
from app.core.blood_flow.evaluate import evaluate_win, win_input_from_dict
from app.core.blood_flow.score import compare_scores, score_patterns

# backend 是 linked worktree：absolute() 不解析链接，保持工作区视图下的前端仓库路径；
# 独立部署时可用环境变量 BLOOD_FLOW_FIXTURES 覆盖夹具目录。
FIXTURES = Path(os.environ.get(
    'BLOOD_FLOW_FIXTURES',
    Path(__file__).absolute().parents[2] / 'src' / 'game' / 'variants' / 'lotus' / 'patterns' / 'fixtures',
))

golden_cases = json.loads((FIXTURES / 'golden.json').read_text(encoding='utf-8'))['cases']
scoring_cases = json.loads((FIXTURES / 'scoring.json').read_text(encoding='utf-8'))['cases']


@pytest.mark.parametrize('case', golden_cases, ids=[c['id'] for c in golden_cases])
def test_golden_win_case(case):
    input_data = case['input']
    expected = case['expected']
    result = evaluate_win(win_input_from_dict(input_data), BLOOD_FLOW_CONFIG)
    assert bool(result) == expected['winning']
    if not expected['winning']:
        return
    ids = [p.id for p in result.score.items]
    for pattern_id in expected.get('includes', []):
        assert pattern_id in ids, f'{pattern_id} not in {ids}'
    for pattern_id in expected.get('excludes', []):
        assert pattern_id not in ids, f'{pattern_id} should be excluded from {ids}'
    if expected.get('shape'):
        assert result.decomposition.shape == expected['shape']
    if 'hardWin' in expected:
        assert result.score.hard_win == expected['hardWin']
    if expected.get('paymentPerPayer') is not None:
        assert result.score.payment_per_payer == expected['paymentPerPayer']
    assignments = result.decomposition.assignments
    assert sorted(a.input_index for a in assignments) == list(range(len(input_data['concealed']) + 1))
    assert [a.physical for a in assignments] == [*input_data['concealed'], input_data['winningTile']]
    assert result.score.hard_win == all(a.physical == a.represented for a in assignments)


@pytest.mark.parametrize('case', scoring_cases, ids=[c['id'] for c in scoring_cases])
def test_golden_score_case(case):
    scored = [score_patterns(c['patterns'], c['natural'], c['source'],
                             'heaven' if c['opening'] else None, BLOOD_FLOW_CONFIG)
              for c in case['candidates']]

    def cmp(a: int, b: int) -> int:
        return compare_scores(scored[a], scored[b])

    from functools import cmp_to_key
    indexes = sorted(range(len(scored)), key=cmp_to_key(cmp))
    expected = case['expected']
    assert indexes[0] == expected['candidateIndex']
    best = scored[indexes[0]]
    assert best.final_multiplier == expected['finalMultiplier']
    assert best.payment_per_payer == expected['paymentPerPayer']
    payers = 3 if best.source in ('self-draw', 'kong-bloom') else 1
    assert best.payment_per_payer * payers == expected['totalWon']


# ── 边界用例（黄金夹具之外的固定断言） ──

def evaluate(case: dict):
    return evaluate_win(win_input_from_dict(case), BLOOD_FLOW_CONFIG)


def test_external_joker_identity_does_not_bypass_any_wait_rule():
    # 点炮胡来的精牌只按本张使用（外来精不保留万能身份）；
    # 手中精仍能替东风与真东风成对，但这副暗手属于任意听，吃胡被规则禁止。
    case = {
        'concealed': ['red', 'red', 'red', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east'],
        'melds': [], 'winningTile': 'red', 'source': 'discard', 'jokers': ['red'], 'opening': None,
    }
    # 结构分解仍保持外来精牌按本张使用；任意听规则在胡牌入口禁止吃胡。
    from app.core.blood_flow.decompose import visit_decompositions
    assert evaluate(case) is None
    decompositions = []
    visit_decompositions(win_input_from_dict(case), decompositions.append)
    assert decompositions
    assert all(d.assignments[-1].represented == 'red' for d in decompositions)
    assert any(any(a.physical == 'red' and a.represented == 'east'
                   for a in d.assignments[:-1]) for d in decompositions)


def test_winning_joker_stays_wild_on_self_draw():
    # 自摸精牌：精牌保留万能身份，可替 s7 成对。
    case = {
        'concealed': ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p9', 'p9', 'p9', 's7'],
        'melds': [], 'winningTile': 'white', 'source': 'self-draw', 'jokers': ['white'], 'opening': None,
    }
    result = evaluate(case)
    assert result is not None
    assert result.score.hard_win is False


def test_physical_conservation_rejects_five_copies():
    case = {
        'concealed': ['m1', 'm1', 'm1', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east'],
        'melds': [], 'winningTile': 'm1', 'source': 'discard', 'jokers': [], 'opening': None,
    }
    assert evaluate(case) is None


def test_batch_aggregates_multi_win_zero_sum():
    from app.core.blood_flow.types import SourceTileEvent
    from app.core.blood_flow.win_batch import resolve_win_batch
    source = SourceTileEvent(id='s1', tile='east', seat=1, kind='discard')
    ev = evaluate({
        'concealed': ['m1', 'm2', 'm3', 'p2', 'p3', 'p4', 's4', 's5', 's6', 'm6', 'm7', 'm8', 'east'],
        'melds': [], 'winningTile': 'east', 'source': 'discard', 'jokers': [], 'opening': None,
    })
    batch = resolve_win_batch(
        authority_epoch='e', round_id='r', sequence=1, rule_version=BLOOD_FLOW_CONFIG.version,
        window_id='w', source=source,
        winners=[{'seat': 0, 'evaluation': ev, 'ordinal': 1},
                 {'seat': 2, 'evaluation': ev, 'ordinal': 1}],
        scores=[2000, 2000, 2000, 2000], wall_empty=False,
    )
    payment = ev.score.payment_per_payer
    # 两家各收一份，来源座位付两份。
    assert batch['deltas'] == [payment, -2 * payment, payment, 0]
    assert sum(batch['deltas']) == 0
    assert batch['nextAction']['kind'] == 'draw'
    assert batch['nextAction']['seat'] == 2
    assert batch['scoresAfter'] == [2000 + batch['deltas'][s] for s in range(4)]
