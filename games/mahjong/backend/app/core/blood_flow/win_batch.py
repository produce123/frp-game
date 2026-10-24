"""血流胡牌批次结算 —— 对应 bloodFlow/winBatch.ts。"""

from .types import SourceTileEvent, WinEvaluation


def _assert_zero_sum(deltas: list[int]) -> None:
    if sum(deltas) != 0:
        raise ValueError(f'Non-zero win batch deltas: {deltas}')


def resolve_win_batch(*, authority_epoch: str, round_id: str, sequence: int, rule_version: str,
                      window_id: str, source: SourceTileEvent,
                      winners: list[dict], scores: list[int], wall_empty: bool) -> dict:
    """winners: [{seat, evaluation, ordinal}]；多响聚合为零和向量。"""
    if not winners or len({w['seat'] for w in winners}) != len(winners):
        raise ValueError('Invalid winner batch')
    batch_id = f'{authority_epoch}/{round_id}/batch/{sequence}'
    totals = [0, 0, 0, 0]
    records: list[dict] = []
    for w in winners:
        evaluation: WinEvaluation = w['evaluation']
        score = evaluation.score
        self_draw = score.source in ('self-draw', 'kong-bloom')
        if self_draw:
            if w['seat'] != source.seat:
                raise ValueError('Invalid winner source')
            payers = [s for s in range(4) if s != w['seat']]
        else:
            if w['seat'] == source.seat:
                raise ValueError('Invalid winner source')
            payers = [source.seat]
        deltas = [0, 0, 0, 0]
        for payer in payers:
            deltas[payer] -= score.payment_per_payer
            deltas[w['seat']] += score.payment_per_payer
        _assert_zero_sum(deltas)
        for index, n in enumerate(deltas):
            totals[index] += n
        records.append({
            'id': f'{batch_id}/seat/{w["seat"]}',
            'batchId': batch_id,
            'winner': w['seat'],
            'ordinal': w['ordinal'],
            'sourceEventId': source.id,
            'score': score,
            'deltas': deltas,
        })
    _assert_zero_sum(totals)
    scores_after = [scores[s] + totals[s] for s in range(4)]
    next_action = ({'kind': 'finish-round', 'reason': 'wall-exhausted'} if wall_empty
                   else {'kind': 'draw', 'seat': (source.seat + 1) % 4})
    return {
        'authorityEpoch': authority_epoch, 'roundId': round_id, 'sequence': sequence,
        'ruleVersion': rule_version, 'batchId': batch_id, 'windowId': window_id,
        'source': {'id': source.id, 'tile': source.tile, 'seat': source.seat, 'kind': source.kind},
        'winners': records, 'deltas': totals, 'scoresAfter': scores_after,
        'nextAction': next_action,
    }
