"""血流 prompt 顶层 `opponentRisk` 字段（与 TS `bloodFlowDecisionPrompt` 同形状）。

契约：只保留 tier > 0 的对手，字段始终存在（无信号时为空数组）；
数据源与候选级 `features.opponentRisk` 同源（同一份公共信息风险档）。
"""

import json

from tests.test_blood_flow_llm import FLUSH_MELDS, make_room, risk_rig

from app.llm.blood_flow_candidates import build_blood_flow_candidates, build_blood_flow_prompt


def _payload(opponent_melds):
    view = make_room(risk_rig(opponent_melds))._seat_view(0)
    built = build_blood_flow_candidates(view, 'req-payload')
    _system, user = build_blood_flow_prompt('稳健', view, built)
    return json.loads(user)


def test_payload_carries_top_level_opponent_risk():
    """对手副露染手 → 顶层数组带该座位的档位与信号（与 TS 同形状、同字段名）。"""
    payload = _payload(FLUSH_MELDS)
    assert payload['opponentRisk'] == [{'seat': 1, 'tier': 2, 'signals': ['副露染手嫌疑']}]


def test_payload_keeps_empty_array_without_signal():
    """无任何信号时字段存在但为空数组（保持与 TS 相同的形状，不删键）。"""
    payload = _payload([])
    assert 'opponentRisk' in payload
    assert payload['opponentRisk'] == []


def test_top_level_matches_candidate_feature_source():
    """顶层档位与候选级 features.opponentRisk 同源（同一份 profiles）。"""
    payload = _payload(FLUSH_MELDS)
    tiers = {c['features']['opponentRisk']['tier'] for c in payload['candidates'] if c['features'].get('opponentRisk')}
    assert tiers == {'中'}
    assert {entry['tier'] for entry in payload['opponentRisk']} == {2}
