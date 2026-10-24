from app.llm.conditional_reasoning import (
    ConditionalReasoningCoordinator,
    DEFAULT_CONDITIONAL_REASONING,
    evaluate_reasoning_triggers,
)


def test_all_supported_reasoning_providers_share_40_second_budget():
    assert DEFAULT_CONDITIONAL_REASONING.deadline_ms == 40_000
    assert DEFAULT_CONDITIONAL_REASONING.min_remaining_budget_ms == 45_000
    assert DEFAULT_CONDITIONAL_REASONING.max_per_seat_per_round == 2
    assert DEFAULT_CONDITIONAL_REASONING.max_soft_per_seat_per_round == 1
    assert DEFAULT_CONDITIONAL_REASONING.max_per_match == 24
    assert DEFAULT_CONDITIONAL_REASONING.trigger.early_opponent_threat == 90


def request(round_index=0):
    features = {
        'shanten': 1, 'ukeire': 4, 'effectiveTiles': [], 'ready': False,
        'waits': 'n/a', 'effectiveRemaining': 'n/a', 'specialPattern': 'none',
        'safety': '中', 'efficiency': '中', 'risks': [],
    }
    empty = {'discards': [], 'melds': []}
    return {
        'ruleCode': 'lotus-legacy',
        'candidates': [
            {'id': 'A1', 'action': {'kind': 'discard'},
             'features': {**features, 'efficiency': '优'}},
            {'id': 'A2', 'action': {'kind': 'discard'}, 'features': features},
        ],
        'state': {
            'roundIndex': round_index, 'wallCount': 40,
            'scores': [1000, 2000, 3000, 4000],
            'snapshots': {
                'self': empty, 'upper': empty, 'opposite': empty, 'lower': empty,
            },
        },
    }


def test_soft_close_candidates_use_one_slot_and_reserve_one_for_strong_trigger():
    coordinator = ConditionalReasoningCoordinator(
        DEFAULT_CONDITIONAL_REASONING, random_fn=lambda: 1)
    assert coordinator.admit(request(), 1, 45_000)
    assert not coordinator.admit(request(), 1, 45_000)
    assert coordinator.admit(request(), 2, 45_000)
    strong = request()
    strong['candidates'][0]['features']['scoreDelta'] = 800
    assert coordinator.admit(strong, 1, 45_000)
    assert not coordinator.admit(strong, 1, 45_000)
    assert not coordinator.admit(request(1), 1, 44_999)


def test_opening_and_early_round_ignore_soft_triggers_but_keep_strong_triggers():
    opening = request()
    opening['state']['turnOrigin'] = 'opening'
    opening['state']['earlyRound'] = True
    coordinator = ConditionalReasoningCoordinator(
        DEFAULT_CONDITIONAL_REASONING, random_fn=lambda: 0)
    assert not coordinator.admit(opening, 1, 45_000)

    opening['candidates'][0]['features']['scoreDelta'] = 800
    assert coordinator.admit(opening, 1, 45_000)

    early = request()
    early['state']['turnOrigin'] = 'draw'
    early['state']['earlyRound'] = True
    reasons = evaluate_reasoning_triggers(early, random_fn=lambda: 0)
    assert 'close-candidates' not in reasons
    assert 'audit' not in reasons


def test_identical_zero_gap_candidates_are_not_a_hard_choice():
    tied = request()
    tied['candidates'][0]['features'] = dict(tied['candidates'][1]['features'])
    assert evaluate_reasoning_triggers(tied, random_fn=lambda: 1) == set()


def test_early_round_allows_distinct_ready_choices_and_ready_break_risk():
    ready = request()
    ready['state']['earlyRound'] = True
    ready['candidates'][0]['features'].update({
        'ready': True, 'waits': [{'tile': '3万', 'remaining': 2}],
        'effectiveRemaining': 2,
    })
    assert evaluate_reasoning_triggers(ready, random_fn=lambda: 1) == set()

    ready['candidates'][1]['features'].update({
        'ready': True, 'waits': [{'tile': '6筒', 'remaining': 3}],
        'effectiveRemaining': 3,
    })
    assert 'ready-choice' in evaluate_reasoning_triggers(ready, random_fn=lambda: 1)

    risky = request()
    risky['state']['earlyRound'] = True
    risky['candidates'][0]['features']['risks'] = ['碰/杠可能破坏听牌']
    assert 'ready-choice' in evaluate_reasoning_triggers(risky, random_fn=lambda: 1)


def test_early_opponent_threat_requires_three_strong_exposed_melds():
    """威胁分与放炮定价同源（档位版）：两副露=中档 70，三组箭牌=高档 100。

    早局阈值 90：只有 tier 3（三元 / 四喜系）才够，门清 / 两副露不再误触发。
    """
    value = request()
    value['state']['earlyRound'] = True
    meld = {'type': 'peng', 'tile': '2万', 'tiles': ['2万', '2万', '2万']}
    value['state']['snapshots']['upper'] = {
        'discards': ['东风'], 'melds': [meld, meld],
    }
    assert 'opponent-threat' not in evaluate_reasoning_triggers(value, random_fn=lambda: 1)
    value['state']['snapshots']['upper']['melds'].append(meld)
    assert 'opponent-threat' not in evaluate_reasoning_triggers(value, random_fn=lambda: 1)

    dragons = [{'type': 'peng', 'tile': name, 'tiles': [name] * 3}
               for name in ('红中', '发财', '白板')]
    value['state']['snapshots']['upper'] = {'discards': [], 'melds': dragons}
    assert 'opponent-threat' in evaluate_reasoning_triggers(value, random_fn=lambda: 1)


def test_opponent_threat_uses_tier_mapping_with_late_wall_bonus():
    """档位→威胁分：tier3=90 / tier2=70 / tier1=40；墙余 ≤ 24 再 +10（上限 100）。"""
    from app.llm.conditional_reasoning import _opponent_threat

    def request_with(melds, discards=(), wall_count=60):
        value = request()
        value['state']['wallCount'] = wall_count
        value['state']['snapshots']['upper'] = {'discards': list(discards), 'melds': melds}
        return value

    flush = [{'type': 'peng', 'tile': '4筒', 'tiles': ['4筒', '4筒', '4筒']},
             {'type': 'peng', 'tile': '7筒', 'tiles': ['7筒', '7筒', '7筒']}]
    dragons = [{'type': 'peng', 'tile': name, 'tiles': [name] * 3}
               for name in ('红中', '发财', '白板')]
    assert _opponent_threat(request_with([], wall_count=60)) == 0
    assert _opponent_threat(request_with(flush, wall_count=60)) == 70
    assert _opponent_threat(request_with(flush, wall_count=20)) == 80
    assert _opponent_threat(request_with(dragons, wall_count=60)) == 90
    assert _opponent_threat(request_with(dragons, wall_count=20)) == 100
    # lotus-classic（广麻无普通点炮）恒为 0。
    classic = request_with(dragons, wall_count=60)
    classic['ruleCode'] = 'lotus-classic'
    assert _opponent_threat(classic) == 0


def test_opponent_threat_drops_unknown_tile_names():
    """快照里未知牌名一律丢弃，不猜测：丢掉后副露数/花色集中度一起下降 = 威胁分下降。"""
    from app.llm.conditional_reasoning import _opponent_threat
    value = request()
    value['state']['wallCount'] = 60
    value['state']['snapshots']['upper'] = {
        'discards': ['？？'],
        'melds': [{'type': 'peng', 'tile': '4筒', 'tiles': ['4筒', '4筒', '4筒']},
                  {'type': 'peng', 'tile': '7筒', 'tiles': ['7筒', '7筒', '7筒']}],
    }
    assert _opponent_threat(value) == 70   # 两副露同花色：染手嫌疑 tier 2
    value['state']['snapshots']['upper']['melds'] = [
        {'type': 'peng', 'tile': '？', 'tiles': ['？', '？', '？']},
        {'type': 'peng', 'tile': '7筒', 'tiles': ['7筒', '7筒', '7筒']},
    ]
    assert _opponent_threat(value) == 0    # 未知牌名被丢弃 → 只剩一副露，无信号


def test_match_budget_is_shared_and_capped_at_24():
    coordinator = ConditionalReasoningCoordinator(
        DEFAULT_CONDITIONAL_REASONING, random_fn=lambda: 1)
    for round_index in range(4):
        for seat in (1, 2, 3):
            strong = request(round_index)
            strong['candidates'][0]['features']['scoreDelta'] = 800
            assert coordinator.admit(strong, seat, 45_000)
            assert coordinator.admit(strong, seat, 45_000)
    assert not coordinator.admit(request(4), 1, 45_000)
