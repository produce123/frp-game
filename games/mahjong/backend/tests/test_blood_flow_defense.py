"""兜/弃政策（v3）测试 —— 镜像前端 ``defensePolicy.test.ts``（11 项）与 ``defenseFold.test.ts``（8 项）。

覆盖：任意听 → push、我方上限 ≥ 对手 → push、未听牌 + 威胁 → fold、能听牌不折叠、
硬约束撤吃碰杠且只留安全档、两个出口不受限、公开番型让锁手家重新有分辨力。
"""

import pytest

from app.core.blood_flow.ai import (blood_flow_ai_actions, blood_flow_defense_policy,
                                    blood_flow_known_wins, blood_flow_opponent_risk,
                                    blood_flow_safety_exposure, decide_blood_flow_action_ev,
                                    narrow_routes_for_bot)
from app.core.blood_flow.config import BLOOD_FLOW_AI, BLOOD_FLOW_DEFENSE
from app.core.blood_flow.defense_policy import (decide_defense_policy, multiplier_of_tier,
                                               own_hand_facts)

SEATS = (0, 1, 2, 3)

# 前端 defenseFold.test.ts 的同名样本。
ORPHANS_RIVER = ['m2', 'm3', 'm5', 'm6', 'm7', 'p3', 'p4', 'p5', 'p6', 'p7', 's2', 's3']
# 未听牌、听口极窄，手上同时有孤张幺九/字牌（危险）与中张（对十三幺安全）。
HAND = ['m1', 'm1', 'm4', 'm4', 'm7', 'm7', 'p2', 'p2', 'p5', 'p8', 's3', 's9', 'east', 'red']
# 本家自己就是十三幺/字一色形态（上限 16 倍）→ 按规则③可以赌。
RACING_HAND = ['m1', 'm9', 'p1', 'p9', 's1', 's9', 'east', 'south', 'west', 'north',
               'red', 'green', 'white', 'm5']
# 4 面子 + 单张精：打一张即精吊任意听（34 种全胡）。
ANY_WAIT_HAND = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p1', 'p1',
                 's7', 'white']
# 单骑听牌：可达听口只有 1 种、任意听不可及。
SINGLE_WAIT_HAND = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p1', 'p1',
                    's7', 's9']
# 散手：打任何一张都听不上。
SCATTERED_HAND = ['m1', 'm1', 'm4', 'm4', 'm7', 'm7', 'p2', 'p2', 'p5', 'p8', 's3', 's9',
                  'east', 'red']


def win_batch(winner: int, tile: str, items: list, multiplier: int) -> dict:
    """一个最小可用的公开胡牌批次（形状对齐引擎 public_state 的 batches）。"""
    return {
        'authorityEpoch': 'e', 'roundId': '1', 'sequence': 1,
        'ruleVersion': 'lotus-blood-flow-v1', 'batchId': 'b1', 'windowId': 'w1',
        'source': {'id': 's1', 'kind': 'draw', 'tile': tile, 'seat': winner},
        'winners': [{
            'id': 'r1', 'batchId': 'b1', 'winner': winner, 'ordinal': 1, 'sourceEventId': 's1',
            'score': {'items': items, 'excluded': [], 'hardWin': True, 'source': 'self-draw',
                      'opening': None, 'patternMultiplier': multiplier, 'eventMultiplier': 2,
                      'openingApplied': False, 'uncappedMultiplier': multiplier * 2,
                      'finalMultiplier': min(multiplier * 2, 64), 'capped': False,
                      'paymentPerPayer': 10 * min(multiplier * 2, 64)},
        }],
        'nextAction': {'kind': 'draw', 'seat': (winner + 1) % 4},
    }


THIRTEEN_ORPHANS_ITEMS = [{'id': 'thirteenOrphans', 'label': '十三幺', 'weight': 32}]
BIG_THREE_DRAGONS_ITEMS = [{'id': 'big-three-dragons', 'label': '大三元', 'weight': 8}]


def make_view(hand: list, options: dict = None) -> dict:
    """手工构造 BloodFlowSeatView 同构 dict（本家座位 0）。

    options: ``known_win`` / ``batches`` / ``claim`` / ``discards`` / ``win_count`` /
    ``locked`` / ``own_actions`` / ``wall_count`` / ``jokers``。
    """
    settings = dict(options or {})
    discards = list(settings.get('discards') or [])
    players = [
        {'seat': index, 'score': 2000, 'hand': list(hand) if index == 0 else [],
         'discards': list(discards) if index == 1 else [], 'melds': [],
         'concealedTileCount': 13, 'drawnTileIndex': len(hand) - 1 if index == 0 else -1}
        for index in SEATS
    ]
    win_count = settings.get('win_count', 2 if settings.get('known_win') else 0)
    locked = settings.get('locked', bool(settings.get('known_win')))
    claim = bool(settings.get('claim'))
    own_actions = settings.get('own_actions')
    if own_actions is None:
        own_actions = [{'kind': 'pass'}, {'kind': 'peng'}] if claim \
            else [{'kind': 'discard', 'index': index} for index in range(len(hand))]
    if 'batches' in settings:
        batches = list(settings['batches'] or [])
    elif settings.get('known_win'):
        batches = [win_batch(1, 'north', THIRTEEN_ORPHANS_ITEMS, 32)]
    else:
        batches = []
    return {
        'seat': 0, 'wallCount': settings.get('wall_count', 30), 'flipTile': 'red',
        'jokers': list(settings.get('jokers', ['white'])), 'version': 1, 'players': players,
        'public': {
            'seats': [{'winCount': win_count if index == 1 else 0,
                       'locked': locked if index == 1 else False} for index in SEATS],
            'batches': batches,
        },
        'ownActions': own_actions,
        'actionEvents': [],
        'window': {
            'id': 'w', 'version': 1, 'kind': 'meld' if claim else 'turn',
            'deadlineAt': 0, 'opensAt': 0,
            'source': {'id': 's', 'kind': 'discard' if claim else 'draw',
                       'tile': hand[-1], 'seat': 1},
        },
    }


def config_with(**overrides):
    """BLOOD_FLOW_AI 的覆盖副本；``defense={...}`` 额外覆盖兜/弃政策字段。"""
    from dataclasses import replace
    defense = overrides.pop('defense', None)
    config = replace(BLOOD_FLOW_AI, **overrides)
    if defense is None:
        return config
    return replace(config, defense=replace(BLOOD_FLOW_AI.defense, **defense))


# ── 政策层（镜像 defensePolicy.test.ts） ──

def threat(**overrides) -> dict:
    base = {'tier': 3, 'locked': True, 'knownMultiplier': 16,
            'signals': ['已胡十三幺', '已胡3次仍听']}
    base.update(overrides)
    return base


def own(**overrides) -> dict:
    base = {'canTenpai': False, 'bestWaitRemaining': 0, 'anyWaitReachable': False,
            'ceilingMultiplier': 1, 'ceilingLabel': None}
    base.update(overrides)
    return base


def test_rule_one_any_wait_pushes_even_against_sixteen_times():
    """规则①：打一张即精吊任意听 → 继续走（哪怕对上是十六倍级）。"""
    result = decide_defense_policy(own(anyWaitReachable=True, canTenpai=True), [threat()])
    assert result.mode == 'push'
    assert '任意听' in result.reasons[0]
    assert (result.threat_tier, result.threat_multiplier) == (3, 16)


def test_rule_three_own_ceiling_not_below_opponent_pushes():
    """规则③：我方上限不低于对手 → 可以赌。"""
    result = decide_defense_policy(own(ceilingMultiplier=16, ceilingLabel='九莲宝灯'), [threat()])
    assert result.mode == 'push'
    assert '可以赌' in result.reasons[0]
    assert '九莲宝灯' in result.reasons[0]


def test_rule_two_unready_hand_against_sixteen_times_folds():
    """规则②：未听牌（打任何一张都听不上）+ 对手十六倍级 → 弃胡兜安全张。"""
    result = decide_defense_policy(own(canTenpai=False), [threat()])
    assert result.mode == 'fold'
    assert '弃胡' in ''.join(result.reasons)
    assert '已锁手' in result.reasons[0]
    assert '已胡十三幺、已胡3次仍听' in result.reasons[0]


def test_ready_hand_never_folds_even_with_narrow_waits():
    """能听牌就不弃胡（窄听也一样）：遵守「未听牌才弃」的前提。"""
    result = decide_defense_policy(own(canTenpai=True, bestWaitRemaining=1), [threat()])
    assert result.mode == 'normal'


def test_threat_below_threshold_does_not_fold():
    """威胁不到门槛（tier 1/2）不兜：不因为对手胡过就乱防。"""
    weak = decide_defense_policy(own(), [threat(tier=2, knownMultiplier=4,
                                                 signals=['副露染手嫌疑'])])
    assert weak.mode == 'normal'
    assert BLOOD_FLOW_DEFENSE.fold_threat_tier == 3


def test_no_opponent_threat_is_always_normal():
    result = decide_defense_policy(own(), [])
    assert result.mode == 'normal'
    assert result.threat_multiplier == 0


def test_threat_multiplier_takes_max_of_known_and_tier_scale():
    assert decide_defense_policy(own(), [threat(tier=1, knownMultiplier=0)]).threat_multiplier == 4
    assert decide_defense_policy(own(), [threat(tier=2, knownMultiplier=0)]).threat_multiplier == 8
    assert decide_defense_policy(own(), [threat(tier=3, knownMultiplier=0)]).threat_multiplier == 16
    # 已公开番型倍率高于档位量级时以公开番型为准。
    assert decide_defense_policy(own(), [threat(tier=1, knownMultiplier=32)]).threat_multiplier == 32


def test_tier_to_multiplier_matches_opponent_pattern_risk_scale():
    """档位 → 倍率映射与 opponent_pattern_risk 的 ×1/4/16/32 对齐。"""
    assert [multiplier_of_tier(tier) for tier in (0, 1, 2, 3)] == [1, 4, 8, 16]


def test_own_hand_facts_any_wait_reachable_with_joker():
    """own_hand_facts：4 面子 + 单张精 → 打一张即任意听可及。"""
    facts = own_hand_facts(ANY_WAIT_HAND, [], ['white'], ANY_WAIT_HAND)
    assert facts.any_wait_reachable is True
    assert facts.can_tenpai is True


def test_own_hand_facts_single_wait_is_not_any_wait():
    """own_hand_facts：单骑听牌 → 可达听口只有 1 种、任意听不可及。"""
    facts = own_hand_facts(SINGLE_WAIT_HAND, [], [], SINGLE_WAIT_HAND)
    assert facts.any_wait_reachable is False
    assert facts.can_tenpai is True          # 打掉 s9 就是单骑听牌
    assert 0 < facts.best_wait_remaining <= 4


def test_own_hand_facts_scattered_hand_cannot_tenpai():
    """own_hand_facts：散手（打任何一张都听不上）→ can_tenpai=False。"""
    facts = own_hand_facts(SCATTERED_HAND, [], [], SCATTERED_HAND)
    assert facts.can_tenpai is False
    assert facts.best_wait_remaining == 0


def test_own_hand_facts_ceiling_respects_progress_threshold():
    """own_hand_facts：上限取「真有机会做成」的番型方向（接近度门槛生效）。"""
    hand = ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west',
            'north', 'red']
    facts = own_hand_facts(hand, [], [], hand, directions=[
        {'weight': 32, 'progress': 0.4, 'label': '十三幺'},
        {'weight': 2, 'progress': 0.9, 'label': '七对'}])
    assert facts.ceiling_multiplier == 32      # 接近度 0.4 ≥ 0.35
    assert facts.ceiling_label == '十三幺'
    conservative = own_hand_facts(hand, [], [], hand, directions=[
        {'weight': 32, 'progress': 0.2, 'label': '十三幺'},
        {'weight': 2, 'progress': 0.9, 'label': '七对'}])
    assert conservative.ceiling_multiplier == 2


# ── 候选层硬约束与引擎效果（镜像 defenseFold.test.ts） ──

def test_fold_policy_lands_on_the_engine_view():
    """未听牌 + 已知十六倍级锁手家 → fold，且带公开番型信号。"""
    view = make_view(HAND, {'discards': ORPHANS_RIVER, 'known_win': True})
    policy = blood_flow_defense_policy(view, BLOOD_FLOW_AI)
    assert policy['result'].mode == 'fold'
    assert policy['own'].can_tenpai is False
    assert policy['own'].any_wait_reachable is False
    assert policy['result'].threat_tier == 3
    # 已知番型是十三幺 → 2026-09-15 起 32 番，威胁倍率随公开番型抬到 32（档位仍是最高的 3 档）
    assert policy['result'].threat_multiplier == 32
    # 头条原因是「已锁手大牌（…）」；两条信号取前两条，公开番型信号在同一档位的 signals 里。
    assert '对手已锁手大牌' in policy['result'].reasons[0]
    signals = blood_flow_opponent_risk(view, BLOOD_FLOW_AI)[0]['signals']
    assert '已胡十三幺' in signals


def test_without_public_pattern_locked_opponent_is_priced_flat():
    """对照（镜像 defenseFold.test.ts 第 2 项）：只有牌河推断、没有公开番型时，
    锁手家一律同价 —— 这正是「公开番型」补上的分辨力。"""
    view = make_view(HAND, {'discards': ORPHANS_RIVER, 'win_count': 2, 'locked': True})
    assert not view['public']['batches']
    profiles = blood_flow_opponent_risk(view, BLOOD_FLOW_AI)
    assert profiles[0]['locked'] is True
    assert profiles[0]['axisSource'] == 'inferred'
    assert profiles[0]['signals'][-1] == '已胡2次仍听'
    exposure = blood_flow_safety_exposure(view, BLOOD_FLOW_AI)
    costs = {exposure(tile) for tile in HAND}
    assert costs == {320}                    # 全候选同价：0.25 × 40 × 32（现物折扣不适用）


def test_engine_fold_picks_the_cheapest_discard():
    """规则②落地：fold 时改打全场最小赔付张。"""
    view = make_view(HAND, {'discards': ORPHANS_RIVER, 'known_win': True})
    exposure = blood_flow_safety_exposure(view, BLOOD_FLOW_AI)
    decision = decide_blood_flow_action_ev(view, BLOOD_FLOW_AI)
    assert decision is not None and decision['kind'] == 'discard'
    cost = exposure(HAND[decision['index']])
    assert cost == min(exposure(tile) for tile in HAND)
    assert cost < 320                        # 有分辨力：至少不是字牌/幺九的 320 点
    assert HAND[decision['index']] in ('m4', 'm7', 'p2', 'p5', 'p8', 's3')


def test_engine_fold_picks_a_middle_tile_under_the_known_axis():
    """公开番型（十三幺，known 轴对锁手家成立）让兜牌挑得出中张，而不是一律 320。"""
    river = ['m1', 'p9', 'm4', 'm5', 'p4', 'p5', 's4', 's5', 'east', 'south']
    view = make_view(HAND, {'discards': river, 'known_win': True})
    exposure = blood_flow_safety_exposure(view, BLOOD_FLOW_AI, [])
    assert exposure('north') == 320
    assert exposure('m4') == 80
    policy = blood_flow_defense_policy(view, BLOOD_FLOW_AI)
    assert policy['result'].mode == 'fold'
    decision = decide_blood_flow_action_ev(view, BLOOD_FLOW_AI)
    assert decision is not None and decision['kind'] == 'discard'
    assert exposure(HAND[decision['index']]) == 80
    assert HAND[decision['index']] in ('m4', 'm7', 'p2', 'p5', 'p8', 's3')


def test_racing_hand_pushes_and_keeps_ev_choice():
    """规则③落地：我方上限 16 倍（十三幺形态）→ 不兜，继续赌。"""
    view = make_view(RACING_HAND, {'discards': ORPHANS_RIVER, 'known_win': True})
    policy = blood_flow_defense_policy(view, BLOOD_FLOW_AI)
    assert policy['result'].mode == 'push'
    assert policy['own'].ceiling_multiplier >= 16
    legal = blood_flow_ai_actions(view, BLOOD_FLOW_AI)
    route_plan = narrow_routes_for_bot(view, legal, BLOOD_FLOW_AI)
    assert route_plan['collapsed'] is True
    assert route_plan['route']['id'] == 'thirteenOrphans'
    assert [RACING_HAND[action['index']] for action in route_plan['actions']
            if action['kind'] == 'discard'] == ['m5']
    decision = decide_blood_flow_action_ev(view, BLOOD_FLOW_AI)
    assert decision is not None and decision['kind'] == 'discard'
    assert RACING_HAND[decision['index']] == 'm5'


def test_hard_constraint_strips_claims_and_keeps_only_the_safe_discard_band():
    """兜牌硬约束：候选层撤掉吃碰杠、弃牌只留最小赔付档（引擎与 LLM 共用）。"""
    turn = make_view(HAND, {'discards': ORPHANS_RIVER, 'known_win': True})
    actions = blood_flow_ai_actions(turn, BLOOD_FLOW_AI)
    assert actions, '兜牌候选不应为空'
    assert all(action['kind'] in ('discard', 'win', 'pass') for action in actions)
    exposure = blood_flow_safety_exposure(turn, BLOOD_FLOW_AI)
    costs = [exposure(HAND[action['index']]) for action in actions
             if action['kind'] == 'discard']
    assert costs
    assert set(costs) == {min(costs)}        # 全部落在安全档
    distinct = len({tile for tile in HAND})
    assert len(costs) < distinct             # 确实收窄了

    claim = make_view(HAND, {'discards': ORPHANS_RIVER, 'known_win': True, 'claim': True})
    assert not any(action['kind'] == 'peng'
                   for action in blood_flow_ai_actions(claim, BLOOD_FLOW_AI))

    # 关掉硬约束（= 只做引擎侧最小赔付）时候选不再收窄，用于对照。
    loose = config_with(defense={'mode': 'off'})
    assert any(action['kind'] == 'peng' for action in blood_flow_ai_actions(claim, loose))


def test_hard_constraint_keeps_the_win_action():
    """胡永远保留：兜牌不会放过已经能胡的牌。"""
    actions = [{'kind': 'win'}, {'kind': 'pass'}] \
        + [{'kind': 'discard', 'index': index} for index in range(len(HAND))]
    view = make_view(HAND, {'discards': ORPHANS_RIVER, 'known_win': True,
                            'own_actions': actions})
    assert any(action['kind'] == 'win' for action in blood_flow_ai_actions(view, BLOOD_FLOW_AI))
    assert decide_blood_flow_action_ev(view, BLOOD_FLOW_AI) == {'kind': 'win'}


def test_hard_constraint_stops_claims_on_a_claim_window():
    """兜牌模式下停吃碰杠：拿到碰的窗口也返回过。"""
    view = make_view(HAND, {'discards': ORPHANS_RIVER, 'known_win': True, 'claim': True})
    assert blood_flow_defense_policy(view, BLOOD_FLOW_AI)['result'].mode == 'fold'
    assert decide_blood_flow_action_ev(view, BLOOD_FLOW_AI) == {'kind': 'pass'}


def test_any_wait_exit_is_not_restricted():
    """兜牌硬约束的出口①：能打一张即任意听时不做任何收窄。"""
    racing = make_view(ANY_WAIT_HAND, {'discards': ORPHANS_RIVER, 'known_win': True})
    assert blood_flow_defense_policy(racing, BLOOD_FLOW_AI)['result'].mode == 'push'
    loose = config_with(defense={'mode': 'off'})
    assert blood_flow_ai_actions(racing, BLOOD_FLOW_AI) == blood_flow_ai_actions(racing, loose)


def test_own_ceiling_exit_is_not_restricted():
    """兜牌硬约束的出口②：我方上限不低于对手时不收窄。"""
    racing = make_view(RACING_HAND, {'discards': ORPHANS_RIVER, 'known_win': True})
    assert blood_flow_defense_policy(racing, BLOOD_FLOW_AI)['result'].mode == 'push'
    loose = config_with(defense={'mode': 'off'})
    assert blood_flow_ai_actions(racing, BLOOD_FLOW_AI) == blood_flow_ai_actions(racing, loose)


def test_switch_off_keeps_the_full_candidate_set():
    """mode='off'（对照臂）：只在引擎侧选最小赔付张，候选不收敛。"""
    turn = make_view(HAND, {'discards': ORPHANS_RIVER, 'known_win': True})
    loose = config_with(defense={'mode': 'off'})
    assert len(blood_flow_ai_actions(turn, loose)) == len(turn['ownActions'])
    # 引擎仍走兜牌路径（政策照算，只是不做候选层收窄）。
    decision = decide_blood_flow_action_ev(turn, loose)
    exposure = blood_flow_safety_exposure(turn, loose)
    assert decision is not None and decision['kind'] == 'discard'
    assert exposure(HAND[decision['index']]) == min(exposure(tile) for tile in HAND)


def test_fold_discard_tolerance_widens_the_safe_band():
    """fold_discard_tolerance：0 = 只留最小赔付档；放宽后容纳更宽的档位。"""
    view = make_view(HAND, {'discards': ORPHANS_RIVER, 'known_win': True})
    strict = blood_flow_ai_actions(view, BLOOD_FLOW_AI)
    wide = blood_flow_ai_actions(view, config_with(defense={'fold_discard_tolerance': 1_000}))
    assert len(wide) >= len(strict)
    assert len(wide) == len(view['ownActions'])


def test_config_is_threaded_into_the_candidate_layer():
    """前端曾有的 bug：config 没传下去导致 'off' 对照臂被默认政策过滤。

    判别式：把 fold_threat_tier 抬到 99（视为无威胁）时候选不再收窄。
    """
    view = make_view(HAND, {'discards': ORPHANS_RIVER, 'known_win': True, 'claim': True})
    assert not any(action['kind'] == 'peng'
                   for action in blood_flow_ai_actions(view, BLOOD_FLOW_AI))
    no_threat = config_with(defense={'fold_threat_tier': 99})
    assert any(action['kind'] == 'peng' for action in blood_flow_ai_actions(view, no_threat))


def test_known_wins_helper_lists_only_seats_that_have_won():
    """blood_flow_known_wins：每座位的公开番型（label + multiplier），只保留已胡过的座位。"""
    view = make_view(HAND, {'discards': ORPHANS_RIVER, 'known_win': True})
    assert blood_flow_known_wins(view) == [
        {'seat': 1, 'patterns': [{'label': '十三幺', 'multiplier': 32}]}]
    quiet = make_view(HAND, {'discards': ORPHANS_RIVER, 'known_win': False})
    assert blood_flow_known_wins(quiet) == []


def test_known_wins_feed_the_risk_profile_and_sharpen_pricing():
    """接线：公开番型 → 威胁档下限 + known 轴 + 锁手家仍有分辨力。"""
    river = ['m1', 'p9', 'm4', 'm5', 'p4', 'p5', 's4', 's5', 'east', 'south']
    view = make_view(HAND, {'discards': river, 'known_win': True})
    profile = blood_flow_opponent_risk(view, BLOOD_FLOW_AI)[0]
    assert profile['seat'] == 1
    assert profile['tier'] == 3 and profile['factor'] == 32
    assert profile['signals'][0] == '已胡十三幺'
    assert profile['axisSource'] == 'known'
    assert profile['avoidsHonorTerminals'] is True

    dragons = make_view(HAND, {'discards': river,
                               'batches': [win_batch(1, 'red', BIG_THREE_DRAGONS_ITEMS, 8)]})
    dragons['public']['seats'][1] = {'winCount': 1, 'locked': True}
    profile = blood_flow_opponent_risk(dragons, BLOOD_FLOW_AI)[0]
    assert (profile['tier'], profile['factor']) == (2, 16)
    assert profile['axisSource'] == 'known' and profile['honorEmphasis'] is True
    assert profile['signals'] == ['已胡大三元', '已胡1次仍听']
    exposure = blood_flow_safety_exposure(dragons, BLOOD_FLOW_AI, [])
    assert exposure('east') == 160
    assert exposure('m5') == 80


def test_defense_defaults_match_frontend_config():
    """政策默认值与前端 BLOOD_FLOW_DEFENSE 同值（3 / 0.35 / 4 / 'hard' / 0）。"""
    assert (BLOOD_FLOW_DEFENSE.fold_threat_tier, BLOOD_FLOW_DEFENSE.ceiling_progress,
            BLOOD_FLOW_DEFENSE.ceiling_weight_floor, BLOOD_FLOW_DEFENSE.mode,
            BLOOD_FLOW_DEFENSE.fold_discard_tolerance) == (3, 0.35, 4, 'hard', 0)
    assert BLOOD_FLOW_AI.defense is BLOOD_FLOW_DEFENSE


@pytest.mark.parametrize('hand', [HAND, RACING_HAND, ANY_WAIT_HAND, SINGLE_WAIT_HAND])
def test_own_hand_facts_is_deterministic(hand):
    first = own_hand_facts(hand, [], ['white'], hand)
    second = own_hand_facts(hand, [], ['white'], hand)
    assert (first.can_tenpai, first.best_wait_remaining, first.any_wait_reachable,
            first.ceiling_multiplier) == (second.can_tenpai, second.best_wait_remaining,
                                          second.any_wait_reachable, second.ceiling_multiplier)


def test_own_hand_facts_does_not_run_a_per_tile_shanten_search(monkeypatch):
    """性能守卫：听口判定只走 waiting_tiles_cached，且调用次数 ≤ 手牌去重张数。

    前端踩过性能坑：把这里的判定换成完整向听搜索会让 12 种子整场从 ~50s 涨到 123s。
    本测试把「每张牌一次听口查询」的调用次数钉死，防止有人改成逐张向听搜索后悄悄回归。
    """
    from app.core.blood_flow import ai as blood_ai

    calls = []

    def spy(hand, exposed, jokers):
        calls.append((tuple(hand), exposed))
        return []

    monkeypatch.setattr(blood_ai, 'waiting_tiles_cached', spy)
    facts = own_hand_facts(HAND, [], ['white'], HAND)
    assert facts.can_tenpai is False
    assert calls, '听口判定必须走 waiting_tiles_cached'
    assert len(calls) <= len(set(HAND))          # 每张不同牌一次，不是每张牌一次向听搜索
    assert len(calls) == len(set(HAND))


# ── 能大明杠时不给"碰"候选（方案 A；对齐前端 dropDominatedPeng） ──────────────────────────

THREE_COPIES = ['m5', 'm5', 'm5', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east']
TWO_COPIES = ['m5', 'm5', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east', 'north']
KONG_OR_PENG = [{'kind': 'pass'}, {'kind': 'gang'}, {'kind': 'peng'}]


def test_kong_available_drops_peng_candidate():
    """手上三张、别人打出第四张：能给大明杠时"碰"不再进候选（原来 LLM 会挑碰再打掉那张）。"""
    view = make_view(THREE_COPIES, {'claim': True, 'own_actions': KONG_OR_PENG})
    moves = blood_flow_ai_actions(view)
    kinds = [action['kind'] for action in moves]
    assert 'gang' in kinds
    assert 'peng' not in kinds


def test_kong_available_engine_still_gangs():
    """本地 AI 行为不变：能杠必杠。"""
    view = make_view(THREE_COPIES, {'claim': True, 'own_actions': KONG_OR_PENG})
    assert decide_blood_flow_action_ev(view) == {'kind': 'gang'}


def test_two_copies_keeps_peng_candidate():
    """只有两张时碰照常保留，不受这条约束影响。"""
    view = make_view(TWO_COPIES, {'claim': True, 'own_actions': [{'kind': 'pass'}, {'kind': 'peng'}]})
    kinds = [action['kind'] for action in blood_flow_ai_actions(view)]
    assert 'peng' in kinds
