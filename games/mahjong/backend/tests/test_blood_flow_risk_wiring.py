"""血流对手风险定价接线测试 —— 对齐前端 bloodFlow ai.ts 的定价接线。

覆盖：等价性回归（无信号 = 旧口径逐位一致）、'off' 开关回退、染手嫌疑花色更贵、
非嫌疑花色 ×0.5、已锁手家现物不再折扣、以及 V1 分叉修复（upperLastDiscard /
earlyRound / patternBonus / safetyExposure 真的传进 lotus_decide_turn / lotus_decide_claim）。
"""

from dataclasses import replace

import pytest

from app.core.blood_flow.ai import (_exposure_visible_tiles, _safety_exposure_for,
                                    _visible_tiles, blood_flow_ev_context,
                                    blood_flow_opponent_risk, blood_flow_risk_tuning,
                                    blood_flow_safety_exposure,
                                    decide_blood_flow_action_ev)
from app.core.blood_flow.config import BLOOD_FLOW_AI
from app.core.opponent_pattern_risk import OPPONENT_RISK
from app.game.blood_flow_engine import BloodFlowEngine
from app.game.blood_flow_room import BloodFlowRoomSession
from app.rules.blood_flow import BloodFlowRuleSet
from tests.test_blood_flow_engine import make_opening

HANDS = [
    ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p4', 'm5'],
    ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
    ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
    ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north'],
]

# 花色均衡、牌型不集中：用于构造「无任何公共信号」的对手牌河。
BALANCED = ['m1', 'm4', 'm7', 'p1', 'p4', 'p7', 's1', 's4', 's7', 'east', 'south',
            'west', 'north', 'red', 'green']
# v2 门清弱信号：12 张牌河里 9 张中张（占比 0.75）→ tier 1「牌河中张密集」（七对嫌疑），
# 三花色均衡且带 3 张字牌 → 既不触发字牌/幺九回避，也不带花色嫌疑。
MIDDLE_HEAVY = ['m3', 'm4', 'm5', 'p3', 'p4', 'p5', 's3', 's4', 's5', 'east', 'south', 'north']
# v2 门清花色回避（tier 3）：12 张牌河、条子一张没打 → 九莲/清一色量级嫌疑。
CONCEALED_FLUSH = ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'p2', 'p3', 'p4', 'p5', 'p6']


def room_for(engine: BloodFlowEngine) -> BloodFlowRoomSession:
    room = BloodFlowRoomSession('RISK-T', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.engine = engine
    return room


def make_rig(round_id: str = 'risk', melds=None) -> BloodFlowEngine:
    """固定开局；牌河在构造后单独注入（开局校验禁用牌河，避免 136 张守恒失败）。"""
    return BloodFlowEngine(authority_epoch='t', round_id=round_id, rules=BloodFlowRuleSet(),
                           opening=make_opening(hands=HANDS, wall_front=['north'],
                                                melds=melds))


def seat_discards(engine: BloodFlowEngine, seat: int, tiles: list[str]) -> None:
    engine.players[seat]['discards'] = list(tiles)


def flush_melds() -> list[list[dict]]:
    return [[], [{'type': 'peng', 'tile': 'p4', 'tiles': ['p4', 'p4', 'p4']},
                 {'type': 'peng', 'tile': 'p7', 'tiles': ['p7', 'p7', 'p7']}], [], []]


def sig_rig() -> BloodFlowEngine:
    """座位 1 两组同花色副露（染手嫌疑）+ 一张牌河；其余座位无副露。"""
    engine = make_rig('risk-flush', melds=flush_melds())
    seat_discards(engine, 1, ['m1'])
    return engine


def quiet_rig() -> BloodFlowEngine:
    """全桌牌河花色均衡、无副露 → 无任何风险信号。"""
    engine = make_rig('risk-quiet')
    for seat in range(4):
        seat_discards(engine, seat, list(BALANCED))
    return engine


def lock_seat(engine: BloodFlowEngine, seat: int, wins: int) -> None:
    """直接把该座位标成「已胡 wins 次且已锁手」（公开状态，不涉及暗手）。"""
    engine.seats[seat] = {'winCount': wins, 'locked': True,
                          'firstWinSequence': 1, 'recordIds': []}


def test_risk_tuning_mirrors_config_and_module_defaults():
    tuning = blood_flow_risk_tuning(BLOOD_FLOW_AI)
    assert tuning['exposure_unit'] == OPPONENT_RISK.exposure_unit == 40
    assert tuning['factor_tier1'] == OPPONENT_RISK.factor_tier1 == 4
    assert tuning['factor_tier2'] == OPPONENT_RISK.factor_tier2 == 16
    assert tuning['factor_tier3'] == OPPONENT_RISK.factor_tier3 == 32
    assert tuning['off_suit_factor'] == OPPONENT_RISK.off_suit_factor == 0.5
    assert tuning['safety_cost_none'] == OPPONENT_RISK.safety_cost_none == 0.25
    assert tuning['safety_cost_one'] == OPPONENT_RISK.safety_cost_one == 0.1
    assert tuning['safety_cost_safe'] == OPPONENT_RISK.safety_cost_safe == 0
    assert tuning['late_game_wall_count'] == OPPONENT_RISK.late_game_wall_count == 15


def test_opponent_risk_profiles_use_public_evidence_only():
    view = room_for(sig_rig())._seat_view(0)
    profiles = blood_flow_opponent_risk(view)
    assert [p['seat'] for p in profiles] == [1, 2, 3]
    assert profiles[0]['tier'] == 2
    assert profiles[0]['signals'] == ['副露染手嫌疑', '副露少牌河快听']
    assert profiles[0]['suspectSuit'] == 'p'
    assert profiles[0]['locked'] is False
    assert profiles[0]['avoidsHonorTerminals'] is False
    assert [p['tier'] for p in profiles[1:]] == [0, 0]


def test_opponent_risk_reads_win_count_and_lock_from_public_seats():
    engine = sig_rig()
    lock_seat(engine, 1, 4)
    view = room_for(engine)._seat_view(0)
    profiles = blood_flow_opponent_risk(view)
    assert profiles[0]['locked'] is True
    assert profiles[0]['tier'] == 2
    assert '已胡4次仍听' in profiles[0]['signals']


def test_switch_off_returns_no_profiles_and_legacy_pricing():
    view = room_for(sig_rig())._seat_view(0)
    config = replace(BLOOD_FLOW_AI, opponent_pattern_risk='off')
    assert blood_flow_opponent_risk(view, config) == []
    visible = [view['flipTile'], 'p3', 'p3', 's1']
    exposure = blood_flow_safety_exposure(view, config, visible)
    legacy = _safety_exposure_for(config, visible)
    for tile in ('p3', 's1', 'm5', 'east'):
        assert exposure(tile) == legacy(tile)


def test_no_signal_is_bit_identical_to_legacy_exposure():
    """等价性回归：全桌无信号时新旧口径逐位一致。"""
    view = room_for(quiet_rig())._seat_view(0)
    visible = [view['flipTile'], *BALANCED]
    exposure = blood_flow_safety_exposure(view, BLOOD_FLOW_AI, visible)
    legacy = _safety_exposure_for(BLOOD_FLOW_AI, visible)
    for tile in ('m1', 'p4', 's7', 'east', 'red', 'green', 'white'):
        assert exposure(tile) == legacy(tile)


def test_single_concealed_weak_signal_scales_every_suit():
    """v2 门清弱信号（牌河中张密集）：只有档位 ×4，三花色与字牌同价（无嫌疑花色）。"""
    engine = make_rig('risk-weak')
    seat_discards(engine, 1, list(MIDDLE_HEAVY))
    view = room_for(engine)._seat_view(0)
    profiles = blood_flow_opponent_risk(view)
    assert profiles[0]['tier'] == 1
    assert profiles[0]['signals'] == ['牌河中张密集']
    assert profiles[0]['suspectSuit'] is None
    assert profiles[0]['avoidsHonorTerminals'] is False
    exposure = blood_flow_safety_exposure(view, BLOOD_FLOW_AI, [])
    assert exposure('s9') == 40      # 40 × 4 × 0.25（生张）
    assert exposure('m9') == 40
    assert exposure('east') == 40


def test_concealed_flush_river_prices_suspect_suit_higher():
    """v2 门清读牌接线：12 张牌河、条子一张没打 → tier 3（九莲/清一色），嫌疑花色 = 条。"""
    engine = make_rig('risk-concealed-flush')
    seat_discards(engine, 1, list(CONCEALED_FLUSH))
    view = room_for(engine)._seat_view(0)
    profiles = blood_flow_opponent_risk(view)
    assert profiles[0]['tier'] == 3
    assert profiles[0]['suspectSuit'] == 's'
    assert profiles[0]['avoidsHonorTerminals'] is True
    assert '牌河未打条' in profiles[0]['signals']
    exposure = blood_flow_safety_exposure(view, BLOOD_FLOW_AI, [])
    assert exposure('s5') == 320     # 40 × 32 × 0.25（嫌疑花色中张不打折）
    assert exposure('m5') == 40      # 非嫌疑花色中张：×0.5 ×0.25 → 40 × 4 × 0.25
    assert exposure('north') == 160  # 非嫌疑花色字牌：×0.5（该轴现物折扣保留下限，见下一条）
    assert blood_flow_safety_exposure(view, BLOOD_FLOW_AI, ['s5', 's5'])('s5') == 0


def test_exposure_legacy_ladder_values():
    """旧口径本体：公开 ≥2 张 0 点、1 张 4 点、生张 10 点（40 × 0.25）。"""
    exposure = _safety_exposure_for(BLOOD_FLOW_AI, ['p3', 'p3', 's1'])
    assert exposure('p3') == 0
    assert exposure('s1') == 4
    assert exposure('m5') == 10


def test_flush_suspect_suit_costs_more_and_off_suit_halves():
    view = room_for(sig_rig())._seat_view(0)
    exposure = blood_flow_safety_exposure(view, BLOOD_FLOW_AI, [])
    # 40 × 16 × 0.25 = 160（嫌疑花色），非嫌疑花色再 ×0.5 = 80。
    assert exposure('p3') == 160
    assert exposure('m5') == 80
    assert exposure('east') == 80       # 字牌按非嫌疑花色处理（染手副露在 p）
    # 现物 / 公开多张仍按 ladder 归零（对手未锁手）。
    safe = blood_flow_safety_exposure(view, BLOOD_FLOW_AI, ['p3', 'p3'])
    assert safe('p3') == 0


def test_locked_opponent_loses_safe_tile_discount():
    engine = sig_rig()
    lock_seat(engine, 1, 4)
    view = room_for(engine)._seat_view(0)
    exposure = blood_flow_safety_exposure(view, BLOOD_FLOW_AI, ['p4', 'p4'])
    # 已锁手：现物不再归零，与生张同价（40 × 16 × 0.25 = 160）。
    assert exposure('p4') == exposure('m9') == 160


def test_ev_decision_uses_tier_pricing_for_discards():
    """弃牌路径接上定价：染手对手在场时，本地 EV 决策仍返回合法候选。"""
    view = room_for(sig_rig())._seat_view(0)
    decision = decide_blood_flow_action_ev(view, BLOOD_FLOW_AI)
    assert decision is not None
    assert any(a == decision for a in view['ownActions'])


def test_ev_decision_with_switch_off_uses_legacy_exposure(monkeypatch):
    """'off' 开关回退：接线的 safetyExposure 必须退化为旧口径（公开张数档位 × 40）。"""
    from app.core.blood_flow import ai as blood_ai

    view = room_for(sig_rig())._seat_view(0)
    config = replace(BLOOD_FLOW_AI, opponent_pattern_risk='off')

    captured = {}
    original = blood_ai.lotus_decide_turn

    def spy(turn_view, jokers, *args, **kwargs):
        captured['turn_view'] = turn_view
        return original(turn_view, jokers, *args, **kwargs)

    monkeypatch.setattr(blood_ai, 'lotus_decide_turn', spy)
    decision = decide_blood_flow_action_ev(view, config)
    assert decision is not None
    assert any(a == decision for a in view['ownActions'])
    turn_view = captured['turn_view']
    legacy = _safety_exposure_for(config, _exposure_visible_tiles(view))
    for tile in ('p3', 'm5', 'east'):
        assert turn_view['safetyExposure'](tile) == legacy(tile)
    assert turn_view['safetyExposure']('p3') == 10    # 0 张公开 × 40 × 0.25（染手不加价）
    assert turn_view['patternBonus'] is not None      # 番型潜力仍注入（与 TS 一致）


def test_discard_and_claim_pass_upper_last_discard_and_early_round(monkeypatch):
    """V1 分叉修复：上家牌河最后一张与 earlyRound 必须真的传下去（不再写死 None/False）。"""
    from app.core.blood_flow import ai as blood_ai

    engine = sig_rig()
    seat_discards(engine, 3, ['m3'])       # 座位 0 的上家（(0+3)%4 = 3）最后一张 m3
    view = room_for(engine)._seat_view(0)
    assert view['players'][3]['discards'][-1] == 'm3'
    assert view['players'][0]['discards'] == []

    captured = {}
    original_turn = blood_ai.lotus_decide_turn
    original_claim = blood_ai.lotus_decide_claim

    def spy_turn(turn_view, jokers, *args, **kwargs):
        captured['turn'] = turn_view
        return original_turn(turn_view, jokers, *args, **kwargs)

    def spy_claim(claim_view, *args, **kwargs):
        captured['claim'] = claim_view
        return original_claim(claim_view, *args, **kwargs)

    monkeypatch.setattr(blood_ai, 'lotus_decide_turn', spy_turn)
    monkeypatch.setattr(blood_ai, 'lotus_decide_claim', spy_claim)

    decide_blood_flow_action_ev(view, BLOOD_FLOW_AI)
    turn_view = captured.get('turn') or captured['claim']
    assert turn_view['upperLastDiscard'] == 'm3'
    assert turn_view['earlyRound'] is True        # 自己牌河 0 张 < 2
    assert turn_view['melds'] is not None
    assert callable(turn_view['patternBonus'])
    assert callable(turn_view['safetyExposure'])
    assert turn_view['safetyExposure']('p3') == 160


def test_early_round_flag_follows_own_discards(monkeypatch):
    """自己牌河 ≥ 2 张 → earlyRound 为 False（与 TS 的 player.discards.length < 2 同口径）。"""
    from app.core.blood_flow import ai as blood_ai

    engine = sig_rig()
    seat_discards(engine, 0, ['m2', 'm6'])
    view = room_for(engine)._seat_view(0)
    assert len(view['players'][0]['discards']) == 2

    captured = {}
    original = blood_ai.lotus_decide_turn

    def spy(turn_view, jokers, *args, **kwargs):
        captured['turn'] = turn_view
        return original(turn_view, jokers, *args, **kwargs)

    monkeypatch.setattr(blood_ai, 'lotus_decide_turn', spy)
    decide_blood_flow_action_ev(view, BLOOD_FLOW_AI)
    turn_view = captured.get('turn') or captured.get('claim')
    if turn_view is not None:
        assert turn_view['earlyRound'] is False


def test_ev_context_exposes_melds_for_pattern_bonus():
    view = room_for(sig_rig())._seat_view(0)
    ctx = blood_flow_ev_context(view, BLOOD_FLOW_AI)
    assert ctx['melds'] == view['players'][0]['melds']


@pytest.mark.parametrize('wall_count', [60, 12])
def test_exposure_for_draw_tile_is_flat_in_quiet_table(wall_count):
    """生张（公开 0 张）在无信号局面恒为 40 × 0.25 = 10 点，与墙余无关。"""
    view = room_for(quiet_rig())._seat_view(0)
    view['wallCount'] = wall_count
    exposure = blood_flow_safety_exposure(view, BLOOD_FLOW_AI, [])
    assert exposure('m5') == 10


def test_exposure_visible_tiles_include_own_concealed_hand():
    """放炮成本的公开张数口径含本家暗手（等价前端 seatView.visibleTiles）。"""
    view = room_for(quiet_rig())._seat_view(0)
    visible = _exposure_visible_tiles(view)
    hand = view['players'][0]['hand']
    for tile in hand:
        assert visible.count(tile) >= hand.count(tile)
    assert visible.count('s9') == 1     # 本家手里那张
    assert 's9' not in _visible_tiles(view)


def test_exposure_counts_own_hand_as_public_one_copy():
    """本家手上有 1 张 s9 → 0.1 档（4 点）；生张 m3 → 0.25 档（10 点）。"""
    view = room_for(quiet_rig())._seat_view(0)
    exposure = blood_flow_safety_exposure(view, BLOOD_FLOW_AI)
    assert exposure('s9') == 4
    assert exposure('m3') == 10


def test_exposure_with_switch_off_uses_same_visible_basis():
    """'off' 回退分支与档位分支共用同一份可见牌口径（含本家暗手）。"""
    view = room_for(quiet_rig())._seat_view(0)
    config = replace(BLOOD_FLOW_AI, opponent_pattern_risk='off')
    exposure = blood_flow_safety_exposure(view, config)
    assert exposure('s9') == 4
    assert exposure('m3') == 10


def test_tiered_exposure_keeps_relative_ladder_ratio():
    """档位版同口径：tier 1（×4）下「公开 1 张档 / 现物档」与生张档仍保持既有比例。"""
    engine = make_rig('risk-weak-hand')
    seat_discards(engine, 1, list(MIDDLE_HEAVY))
    view = room_for(engine)._seat_view(0)
    assert blood_flow_opponent_risk(view)[0]['tier'] == 1
    visible = ['m9', 'm9', 's1']
    exposure = blood_flow_safety_exposure(view, BLOOD_FLOW_AI, visible)
    assert exposure('m9') == 0      # 公开 ≥2 张 → 现物档 0
    assert exposure('s1') == 16     # 40 × 4 × 0.1（公开 1 张）
    assert exposure('p5') == 40     # 40 × 4 × 0.25（生张，与墙余无关）
    assert exposure('p5') / exposure('s1') == pytest.approx(0.25 / 0.1, rel=1e-9)


def test_concealed_orphans_axis_keeps_a_floor_on_honors_and_terminals():
    """v2 十三幺/字一色轴：字牌与幺九「多现 ≠ 安全」（现物折扣有下限），中张照常归零。"""
    engine = make_rig('risk-concealed-orphans')
    orphans_river = ['m3', 'm4', 'm5', 'm6', 'm7', 'p3', 'p4', 'p5', 'p6', 'p7', 's3', 's4']
    seat_discards(engine, 1, orphans_river)
    view = room_for(engine)._seat_view(0)
    profiles = blood_flow_opponent_risk(view)
    assert profiles[0]['tier'] == 3
    assert profiles[0]['avoidsHonorTerminals'] is True
    assert '牌河零字牌幺九' in profiles[0]['signals']
    exposure = blood_flow_safety_exposure(view, BLOOD_FLOW_AI, ['north', 'north'])
    assert exposure('north') == 128   # 40 × 32 × 0.1（下限），不是 0
    assert exposure('m1') == 320      # 幺九照价：40 × 32 × 0.25（该轴保留下限 ≥ 生张档）
    assert exposure('m7') == 80       # 中张打折：40 × 32 × 0.25 × 0.25
    mid = blood_flow_safety_exposure(view, BLOOD_FLOW_AI, ['p5', 'p5'])
    assert mid('p5') == 0             # 中张不在该轴上：现物折扣照常归零
