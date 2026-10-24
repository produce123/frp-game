"""血流胡牌评估 —— 对应 patterns/evaluate.ts。"""

from functools import lru_cache

from app.core.tiles import TILE_TYPES
from app.core.lotus_rules import is_winning_hand

from .catalog import match_patterns
from .config import BLOOD_FLOW_CONFIG, BloodFlowConfig
from .decompose import validate_win_input, visit_decompositions
from .score import compare_scores, score_patterns
from .types import KongCounts, WinEvaluation, WinEvaluationInput, WinningDecomposition


def kong_counts_of(decomposition: WinningDecomposition) -> KongCounts:
    """杠加成统计：风杠（字牌杠）单列；其余按是否暗成区分（对应 TS 的 kongCountsOf）。"""
    exposed = concealed = wind = 0
    for group in decomposition.groups:
        if group.kind == 'wind-kong':
            wind += 1
        elif group.kind == 'kong':
            if group.concealed:
                concealed += 1
            else:
                exposed += 1
    return KongCounts(exposed=exposed, concealed=concealed, wind=wind)


def win_input_from_dict(data: dict) -> WinEvaluationInput:
    """共享夹具 golden.json 的输入 → 内部类型（camelCase 键）。"""
    return WinEvaluationInput(
        concealed=tuple(data['concealed']),
        melds=tuple(data['melds']),
        winning_tile=data['winningTile'],
        source=data['source'],
        jokers=tuple(data.get('jokers') or []),
        opening=data.get('opening'),
    )


@lru_cache(maxsize=20_000)
def _self_draw_only(concealed: tuple[str, ...], exposed: int, jokers: tuple[str, ...]) -> bool:
    # 手中已持有四张的牌面无需再等第五张；普通窄听找到一个不能胡的真实牌面即可停止。
    return all(concealed.count(tile) >= 4 or is_winning_hand([*concealed, tile], exposed, list(jokers))
               for tile in TILE_TYPES)


def evaluate_win(inp: WinEvaluationInput, config: BloodFlowConfig = BLOOD_FLOW_CONFIG) -> WinEvaluation | None:
    if validate_win_input(inp) is None:
        return None
    # 任意听禁止吃胡（含地胡）与抢杠，保留自摸和杠开。
    if inp.source in ('discard', 'robbed-kong') and _self_draw_only(
            tuple(sorted(inp.concealed)), len(inp.melds), tuple(sorted(inp.jokers))):
        return None
    best: WinEvaluation | None = None

    def visit(decomposition) -> None:
        nonlocal best
        score = score_patterns(match_patterns(decomposition), decomposition.natural,
                               inp.source, inp.opening, config, kong_counts_of(decomposition))
        if best is None or compare_scores(score, best.score) < 0:
            best = WinEvaluation(
                rule_version=config.version,
                decomposition=decomposition,
                natural_evidence={'allAssignmentsIdentity': decomposition.natural},
                score=score,
            )

    visit_decompositions(inp, visit)
    return best


def evaluate_waits(inp: WinEvaluationInput, config: BloodFlowConfig = BLOOD_FLOW_CONFIG) -> list[dict]:
    """听口：每张牌的 self-draw / discard 精确分（含任意听 34 种）。"""
    results: list[dict] = []
    for tile in TILE_TYPES:
        self_draw = evaluate_win(WinEvaluationInput(
            concealed=inp.concealed, melds=inp.melds, winning_tile=tile,
            source='self-draw', jokers=inp.jokers, opening=None,
        ), config)
        discard = evaluate_win(WinEvaluationInput(
            concealed=inp.concealed, melds=inp.melds, winning_tile=tile,
            source='discard', jokers=inp.jokers, opening=None,
        ), config)
        if self_draw or discard:
            results.append({
                'tile': tile,
                'selfDraw': self_draw.score if self_draw else None,
                'discard': discard.score if discard else None,
            })
    return results
