"""M1 对拍校验：读取前端 TS 引擎采集的胡窗口评估输入（work/blood-flow-pair-inputs.json），
用 Python 计分层逐笔重算并比对。输入文件缺失时跳过（CI 不依赖前端仓库）。"""

import json
import os
from pathlib import Path

import pytest

from app.core.blood_flow.config import BLOOD_FLOW_CONFIG
from app.core.blood_flow.evaluate import evaluate_win, win_input_from_dict

PAIR_INPUT = Path(os.environ.get(
    'BLOOD_FLOW_PAIR_INPUT',
    Path(__file__).absolute().parents[2] / 'work' / 'blood-flow-pair-inputs.json',
))


def _load_cases():
    if not PAIR_INPUT.exists():
        return None
    payload = json.loads(PAIR_INPUT.read_text(encoding='utf-8'))
    return payload['cases']


CASES = _load_cases()


@pytest.mark.skipif(CASES is None, reason='pair inputs not generated; run work/blood-flow-pair-harness.test.ts')
def test_pair_diff_scoring_matches_ts_engine():
    mismatches: list[dict] = []
    checked = 0
    for case in CASES:
        result = evaluate_win(win_input_from_dict(case['input']), BLOOD_FLOW_CONFIG)
        expected = case['expected']
        checked += 1
        if expected is None:
            if result is not None:
                mismatches.append({**case, 'reason': 'python accepted a forbidden win'})
            continue
        if result is None:
            mismatches.append({**case, 'reason': 'python evaluated to not-winning', 'got': None})
            continue
        got = {
            'paymentPerPayer': result.score.payment_per_payer,
            'hardWin': result.score.hard_win,
            'items': [p.id for p in result.score.items],
            'shape': result.decomposition.shape,
            'natural': result.decomposition.natural,
        }
        if got != expected:
            mismatches.append({**case, 'reason': 'field mismatch', 'got': got})
    summary = {
        'checked': checked,
        'mismatches': len(mismatches),
        'samples': mismatches[:5],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    assert not mismatches, f'{len(mismatches)}/{checked} pair cases mismatch'
