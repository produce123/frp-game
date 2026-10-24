"""开杠价值（第 3 步）后端镜像测试 —— 对齐前端 kongSelfLoss.test.ts。

    开杠价值 = 杠收益 − 防守风险 − 自手牌型损失
    自手牌型损失 = ① 七对/豪华七对潜力损失 + ② 明杠破坏门清平胡 + ③ 向听恶化

这条规则**不是**"检测到七对就禁杠"：路线越接近（对子越多、越接近四张）扣得越多；
路线还没成形（对子不够，seven_pairs_potential = 0）时扣减为 0，该杠照杠。
"""

import pytest

from app.core.blood_flow.ai import decide_blood_flow_action_ev, kong_evaluator_for
from app.core.blood_flow.config import (BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG,
                                        BLOOD_FLOW_KONG_VALUE, BloodFlowAiConfig,
                                        KongValueConfig)
from app.core.blood_flow.kong_value import (kong_candidate_value, kong_gain,
                                            kong_self_loss, seven_pairs_route_value)
from app.core.hand_progress import hand_shanten
from app.game.blood_flow_engine import BloodFlowEngine
from app.game.blood_flow_room import BloodFlowRoomSession
from app.rules.blood_flow import BloodFlowRuleSet
from tests.test_blood_flow_engine import make_opening

JOKERS = ['red']

# 和别人打出的 m3 能大明杠：手里 3 张 m3 + 4 对 + 2 散张（七对差两对，刻子可成四张）。
LUXURY_ROUTE = ['m3', 'm3', 'm3', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 's3', 's3', 'p7', 's8']
# 七对路线已废：只有 3 对。
SEVEN_PAIRS_DEAD = ['m5', 'm5', 'm5', 'm1', 'm1', 'm2', 'm2', 'p4', 'p5', 'p6', 's7', 's9', 'east']
# 门清听牌：四副面子 + 单张 east。
CONCEALED_TENPAI = ['m5', 'm5', 'm5', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east']

_DUMMY_HANDS = [
    ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p4', 'm5'],
    ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
    ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
    ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north'],
]


def claim_window(tile: str = 'm3') -> dict:
    return {'id': 'w', 'version': 1, 'kind': 'meld', 'deadlineAt': 0, 'opensAt': 0,
            'source': {'id': 's', 'kind': 'discard', 'tile': tile, 'seat': 3}}


def turn_window(tile: str = 'm3') -> dict:
    return {'id': 'w', 'version': 1, 'kind': 'turn', 'deadlineAt': 0, 'opensAt': 0,
            'source': {'id': 's', 'kind': 'draw', 'tile': tile, 'seat': 0}}


def seat_view(hand, melds=None, own_actions=None, window=None, jokers=JOKERS):
    """真实引擎视图 + 覆盖本家手牌/副露/候选，保证防线政策等字段齐全。"""
    engine = BloodFlowEngine(authority_epoch='kv', round_id='kong-value',
                             rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=[list(h) for h in _DUMMY_HANDS],
                                                  wall_front=['north']))
    room = BloodFlowRoomSession('KV-T', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.engine = engine
    view = room._seat_view(0)
    view['players'][0]['hand'] = list(hand)
    view['players'][0]['melds'] = list(melds or [])
    view['jokers'] = list(jokers)
    view['wallCount'] = 40
    view['ownScore'] = None
    view['ownActions'] = own_actions if own_actions is not None else [
        {'kind': 'discard', 'index': index} for index in range(len(hand))]
    if window:
        view['window'] = window
    return view


def claim_view(hand, melds=None, tile='m3'):
    return seat_view(hand, melds=melds, window=claim_window(tile),
                     own_actions=[{'kind': 'pass'}, {'kind': 'gang'}, {'kind': 'peng'}])


# ── ① 豪华七对 / 七对路线成立 → 不杠 ────────────────────────

def test_luxury_route_rejects_discard_gang():
    value = kong_candidate_value('discard-gang', LUXURY_ROUTE, [], JOKERS, tile='m3')
    assert value['gain'] == kong_gain('discard-gang')
    assert value['selfLoss']['sevenPairs'] > value['gain']
    assert value['net'] < 0
    assert '七对' in ''.join(value['selfLoss']['reasons'])
    # 决策层：血流 EV 路径确实选择「过」（候选里没有碰 → 过）。
    assert decide_blood_flow_action_ev(claim_view(LUXURY_ROUTE), BLOOD_FLOW_AI) == {'kind': 'pass'}


def test_luxury_win_rejects_concealed_kong():
    """四张在手（暗杠会拆掉豪华七对）→ 不暗杠（对齐前端 kongSelfLoss.test.ts 同用例）。"""
    hand = ['m3', 'm3', 'm3', 'm3', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 's3', 's3', 'p7', 's8']
    actions = [*({'kind': 'discard', 'index': index} for index in range(len(hand))),
               {'kind': 'concealed-kong', 'tile': 'm3'}]
    view = seat_view(hand, own_actions=actions, window=turn_window('m3'))
    loss = kong_self_loss('concealed-kong', hand, [], JOKERS, tile='m3')
    # 2026-09-18 豪华七对 12 → 6 番：七对/豪华那一项由约 147 降到约 73.5，**已低于**暗杠即时收益 80；
    # 但自手总损失还含门清/向听等项（≈83.5），仍然压过杠收益，所以「为保路线不暗杠」的行为未被翻转。
    assert loss['sevenPairs'] < kong_gain('concealed-kong')
    assert loss['total'] > kong_gain('concealed-kong')
    assert decide_blood_flow_action_ev(view, BLOOD_FLOW_AI)['kind'] == 'discard'


def test_route_value_is_monotone_and_zeroed_by_melds():
    fewer = kong_self_loss('discard-gang',
                           ['m3', 'm3', 'm3', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 'p7', 's8', 's9', 'east'],
                           [], JOKERS, tile='m3')
    more = kong_self_loss('discard-gang', LUXURY_ROUTE, [], JOKERS, tile='m3')
    assert more['sevenPairs'] > fewer['sevenPairs']
    melded = [{'type': 'peng', 'tile': 'm1', 'tiles': ['m1', 'm1', 'm1']}]
    assert seven_pairs_route_value(LUXURY_ROUTE, [], JOKERS) > 0
    assert seven_pairs_route_value(LUXURY_ROUTE, melded, JOKERS) == 0


# ── ② 七对路线已废 → 仍杠 ──────────────────────────────────

def test_dead_seven_pairs_still_kongs():
    value = kong_candidate_value('discard-gang', SEVEN_PAIRS_DEAD, [], JOKERS, tile='m5')
    assert value['selfLoss']['sevenPairs'] == 0
    assert value['net'] > 0
    assert decide_blood_flow_action_ev(claim_view(SEVEN_PAIRS_DEAD, tile='m5'), BLOOD_FLOW_AI) == {'kind': 'gang'}


def test_melded_hand_has_no_route_or_concealed_loss():
    melds = [{'type': 'peng', 'tile': 'm5', 'tiles': ['m5', 'm5', 'm5']}]
    hand = ['m5', 'm1', 'm4', 'p7', 's2']
    loss = kong_self_loss('added-kong', hand, melds, JOKERS, meld_index=0)
    assert loss['sevenPairs'] == 0
    assert loss['concealedHand'] == 0
    assert kong_gain('added-kong') > 0


# ── ③ 明杠破坏门清平胡 → 计入损失 ───────────────────────────

def test_concealed_pinghu_loss_is_counted():
    value = kong_candidate_value('discard-gang', CONCEALED_TENPAI, [], JOKERS, tile='m5')
    assert value['selfLoss']['concealedHand'] > 0
    assert '破坏门清' in ''.join(value['selfLoss']['reasons'])
    assert value['net'] == pytest.approx(
        value['gain'] - value['risk'] - value['selfLoss']['total'], abs=1e-9)
    assert value['net'] < value['gain']


def test_melded_hand_skips_concealed_pinghu_loss():
    melds = [{'type': 'peng', 'tile': 'east', 'tiles': ['east', 'east', 'east']}]
    with_melds = kong_candidate_value('discard-gang', CONCEALED_TENPAI, melds, JOKERS, tile='m5')
    without = kong_candidate_value('discard-gang', CONCEALED_TENPAI, [], JOKERS, tile='m5')
    assert with_melds['selfLoss']['concealedHand'] == 0
    assert with_melds['selfLoss']['total'] < without['selfLoss']['total']


def test_concealed_loss_alone_does_not_block_kong():
    value = kong_candidate_value('discard-gang', CONCEALED_TENPAI, [], JOKERS, tile='m5')
    assert value['net'] > 0
    assert decide_blood_flow_action_ev(claim_view(CONCEALED_TENPAI, tile='m5'), BLOOD_FLOW_AI) == {'kind': 'gang'}


# ── 补杠抢杠风险 / 开关 / 跨语言数值护栏 ────────────────────

def test_rob_kong_risk_follows_public_tile_count():
    melds = [{'type': 'peng', 'tile': 'm5', 'tiles': ['m5', 'm5', 'm5']}]
    hand = ['m5', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9']
    unseen = kong_candidate_value('added-kong', hand, melds, JOKERS, meld_index=0, tile='m5', public_tiles=[])
    once = kong_candidate_value('added-kong', hand, melds, JOKERS, meld_index=0, tile='m5', public_tiles=['m5'])
    twice = kong_candidate_value('added-kong', hand, melds, JOKERS, meld_index=0, tile='m5',
                                 public_tiles=['m5', 'm5'])
    assert unseen['risk'] > once['risk'] > twice['risk']


def test_mode_off_falls_back_to_legacy_gang():
    legacy = BloodFlowAiConfig(kong_value=KongValueConfig(mode='off'))
    assert kong_evaluator_for(legacy) is None
    assert decide_blood_flow_action_ev(claim_view(LUXURY_ROUTE), legacy) == {'kind': 'gang'}
    assert kong_evaluator_for(BLOOD_FLOW_AI) is not None


def test_kong_value_matches_ts_engine_numbers():
    """跨语言护栏：与前端 kongValue.ts 打印的示例数字一致（见设计文档「具体数字」表）。

    数值取自前端实测（同 fixtures 的前端护栏：
    src/game/variants/lotus/bloodFlow/crossLanguageNumbers.test.ts；2026-09-18
    豪华七对 12 → 6 番后重取，前端 kongSelfLoss.test.ts 已先改口径）。
    """
    base = BLOOD_FLOW_CONFIG.base_points
    assert base == 10
    assert kong_gain('discard-gang') == 20
    assert kong_gain('added-kong') == 40
    assert kong_gain('concealed-kong') == 80
    # 风杠 2026-09-15 起加成与明杠同档（+1）→ 即时 60 + 加成 10 = 70（原 80）
    assert kong_gain('wind-kong') == 70

    route = kong_candidate_value('discard-gang', LUXURY_ROUTE, [], JOKERS, tile='m3')
    # 2026-09-15：门清平胡拆成门清(1番)+平胡(1番)，"破坏门清"的自损项随之减半；
    # 2026-09-18：豪华七对 12 → 6 番，七对/豪华项 42.4 → 31.43，net 随之上移 -35.45 → -24.43。
    assert route['selfLoss']['sevenPairs'] == pytest.approx(31.43, abs=0.05)
    assert route['net'] == pytest.approx(-24.43, abs=0.05)

    luxury_win = ['m3', 'm3', 'm3', 'm3', 'm1', 'm1', 'm2', 'm2', 'p1', 'p1', 's3', 's3', 'p7', 'p7']
    win = kong_candidate_value('concealed-kong', luxury_win, [], JOKERS, tile='m3')
    # 已成形的豪华七对：整项由 12 番时代的 160 降到 100，net -90 → -30。
    assert win['selfLoss']['sevenPairs'] == pytest.approx(100.0, abs=0.05)
    # 2026-09-15：暗杠保留门清 → 不再计入"破坏门清"自损。
    assert win['selfLoss']['concealedHand'] == pytest.approx(0.0, abs=0.05)
    assert win['net'] == pytest.approx(-30.0, abs=0.05)

    tenpai = kong_candidate_value('discard-gang', CONCEALED_TENPAI, [], JOKERS, tile='m5')
    assert tenpai['selfLoss']['concealedHand'] == pytest.approx(5.0, abs=0.05)
    assert tenpai['net'] == pytest.approx(15.0, abs=0.05)

    dead = kong_candidate_value('discard-gang', SEVEN_PAIRS_DEAD, [], JOKERS, tile='m5')
    assert dead['selfLoss']['sevenPairs'] == 0
    assert dead['selfLoss']['concealedHand'] == pytest.approx(3.0, abs=0.05)


def test_llm_candidate_carries_kong_value_feature():
    """LLM 候选带 features.kongValue 拆解与摘要行（对齐前端 features.kongValue）。"""
    from app.llm.blood_flow_candidates import (_candidate_summary,
                                               build_blood_flow_candidates)
    built = build_blood_flow_candidates(claim_view(LUXURY_ROUTE, tile='m3'), 'req-kong')
    gang = next((c for c in built['candidates'] if c['action']['kind'] == 'gang'), None)
    assert gang is not None, [c['action'] for c in built['candidates']]
    kong = gang['features']['kongValue']
    assert kong['net'] < 0
    assert kong['selfLoss']['sevenPairs'] > kong['gain']
    assert '七对' in ''.join(kong['reasons'])
    assert '开杠价值' in _candidate_summary(gang)
    assert '开杠代价' in _candidate_summary(gang)
    # 七对路线已废的那手：净值仍为正，AI 决策与默认建议都是杠。
    dead_view = claim_view(SEVEN_PAIRS_DEAD, tile='m5')
    suggestion = decide_blood_flow_action_ev(dead_view, BLOOD_FLOW_AI)
    assert suggestion == {'kind': 'gang'}
    dead = build_blood_flow_candidates(dead_view, 'req-kong-dead', suggestion=suggestion)
    dead_gang = next(c for c in dead['candidates'] if c['action']['kind'] == 'gang')
    assert dead_gang['features']['kongValue']['selfLoss']['sevenPairs'] == 0
    assert dead_gang['features']['kongValue']['net'] > 0
    assert dead['engineSuggestion'] == dead_gang['id']


def test_hand_shanten_matches_evaluate_hand_progress():
    from app.core.blood_flow.ai import waiting_tiles_cached
    hand = ['m1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east', 'm9', 'p9']
    shanten = hand_shanten(hand, 0, waiting_fn=lambda tiles, exposed: waiting_tiles_cached(tiles, exposed, JOKERS),
                           wildcard_tiles=['red', 'white'], special_hands=True)
    assert shanten >= 0
    assert isinstance(shanten, int)
