"""对手牌型（大牌）风险定价的单元测试 —— 与 TS 测试一一对应。

参照 `src/game/shared/ai/opponentPatternRisk.test.ts`；核心断言：只用公共信息，
且无信号时结果与旧口径逐位一致。
"""

from app.core.blood_flow.config import BLOOD_FLOW_AI
from app.core.opponent_pattern_risk import (OPPONENT_RISK, is_honor_tile,
                                            is_middle_tile, is_terminal_tile,
                                            max_opponent_risk_tier,
                                            opponent_pattern_exposure,
                                            opponent_pattern_feature,
                                            opponent_risk_profiles,
                                            opponent_threat_score, suit_of_tile,
                                            tuning_of)


def meld(tile: str, type_: str = 'peng') -> dict:
    return {'type': type_, 'tile': tile, 'tiles': [tile, tile, tile]}


QUIET = {'discards': [], 'melds': []}

# 十三幺 / 字一色教科书牌河：只打中张，一张字牌与幺九都没打（12 张）。
THIRTEEN_ORPHANS_RIVER = ['m3', 'm4', 'm5', 'm6', 'm7',
                          'p3', 'p4', 'p5', 'p6', 'p7', 's3', 's4']


def discards(count: int, tile: str) -> list[str]:
    return [tile] * count


def exposure_of(profiles, visible=()):
    return opponent_pattern_exposure(profiles, list(visible))


def test_default_tuning_matches_blood_flow_config():
    assert OPPONENT_RISK.factor_tier1 == 4
    assert OPPONENT_RISK.factor_tier2 == 16
    assert OPPONENT_RISK.factor_tier3 == 32
    assert OPPONENT_RISK.off_suit_factor == 0.5
    assert OPPONENT_RISK.exposure_unit == 40
    assert (OPPONENT_RISK.safety_cost_none, OPPONENT_RISK.safety_cost_one,
            OPPONENT_RISK.safety_cost_safe) == (0.25, 0.1, 0)
    assert OPPONENT_RISK.locked_tier == 2
    assert OPPONENT_RISK.late_game_wall_count == BLOOD_FLOW_AI.late_game_wall_count == 15
    assert OPPONENT_RISK.late_threat_wall_count == 24
    # v2 门清读牌调参（与 TS OPPONENT_RISK 同名同值）。
    assert OPPONENT_RISK.concealed_river_min == 8
    assert OPPONENT_RISK.honor_terminal_quiet == 1
    assert OPPONENT_RISK.honor_terminal_zero_river == 10
    assert OPPONENT_RISK.honor_terminal_middle_factor == 0.25
    assert OPPONENT_RISK.honor_terminal_ladder_floor == 0.1
    assert OPPONENT_RISK.suit_avoid_share == 0.1
    assert OPPONENT_RISK.suit_zero_river == 12
    assert OPPONENT_RISK.middle_heavy_share == 0.75
    # v3 公开番型调参（与 TS OPPONENT_RISK 同名同值）。
    assert OPPONENT_RISK.honor_emphasis_number_factor == 0.5
    assert (OPPONENT_RISK.known_tier1_multiplier, OPPONENT_RISK.known_tier2_multiplier,
            OPPONENT_RISK.known_tier3_multiplier) == (4, 8, 16)
    assert (BLOOD_FLOW_AI.risk_factor_tier1, BLOOD_FLOW_AI.risk_factor_tier2,
            BLOOD_FLOW_AI.risk_factor_tier3) == (4, 16, 32)
    assert BLOOD_FLOW_AI.risk_off_suit_factor == 0.5
    assert BLOOD_FLOW_AI.opponent_pattern_risk == 'tier'


def test_tuning_of_is_partial_override():
    tuned = tuning_of({'factor_tier2': 8})
    assert tuned.factor_tier2 == 8
    assert tuned.factor_tier1 == OPPONENT_RISK.factor_tier1
    assert tuned.exposure_unit == OPPONENT_RISK.exposure_unit
    assert tuning_of() is OPPONENT_RISK
    assert tuning_of({}) is OPPONENT_RISK


def test_suit_of_tile_only_for_suited_tiles():
    assert suit_of_tile('m1') == 'm'
    assert suit_of_tile('p9') == 'p'
    assert suit_of_tile('s5') == 's'
    assert suit_of_tile('east') is None
    assert suit_of_tile('red') is None
    assert suit_of_tile('white') is None


def test_tile_predicates_capture_the_number_digit():
    """判定正则必须自己捕获数字位（否则所有数牌都会被判成中张、幺九永远判不出）。"""
    assert is_middle_tile('m1') is False
    assert is_terminal_tile('m1') is True
    assert is_honor_tile('east') is True
    assert is_middle_tile('m5') is True
    assert is_terminal_tile('m5') is False
    assert is_middle_tile('p9') is False and is_terminal_tile('p9') is True
    assert is_middle_tile('s2') is True and is_terminal_tile('s2') is False
    assert is_honor_tile('red') is True and is_honor_tile('m1') is False
    assert is_middle_tile('east') is False and is_terminal_tile('east') is False
    assert is_middle_tile('white') is False and is_terminal_tile('white') is False


def test_no_public_signal_is_bit_identical_to_legacy_ladder():
    profiles = opponent_risk_profiles([QUIET, QUIET, QUIET], 60)
    assert [p.tier for p in profiles] == [0, 0, 0]
    assert all(p.factor == 1 and p.signals == [] for p in profiles)
    exposure = exposure_of(profiles, ['p3', 'p3', 's1'])
    assert exposure('p3') == 0        # 公开 ≥2 张
    assert exposure('s1') == 4        # 公开 1 张
    assert exposure('m5') == 10       # 生张


def test_empty_profile_table_is_bit_identical_to_legacy_ladder():
    exposure = exposure_of([], ['p3', 'p3', 's1'])
    assert exposure('p3') == 0
    assert exposure('s1') == 4
    assert exposure('m5') == 10


def test_two_same_suit_melds_suspect_flush_tier2():
    opponent = {'discards': ['m1', 'm2'], 'melds': [meld('p4'), meld('p7')]}
    profiles = opponent_risk_profiles([opponent], 60)
    assert profiles[0].tier == 2
    assert '副露染手嫌疑' in profiles[0].signals
    assert profiles[0].suspect_suit == 'p'
    exposure = exposure_of(profiles)
    assert exposure('p3') == 160        # 40 × 16 × 0.25
    assert exposure('m5') == 80         # 非嫌疑花色 × 0.5
    safe = exposure_of(profiles, ['p3', 'p3'])
    assert safe('p3') == 0              # 现物 / 公开 ≥2 张仍是 0


def test_three_melds_and_dragon_pairs_raise_tier_step_by_step():
    three_melds = opponent_risk_profiles(
        [{'discards': [], 'melds': [meld('m2'), meld('p3'), meld('s4')]}], 60)
    assert three_melds[0].tier == 2
    assert '副露3组' in three_melds[0].signals
    two_dragons = opponent_risk_profiles(
        [{'discards': [], 'melds': [meld('red'), meld('green')]}], 60)
    assert two_dragons[0].tier == 2
    assert '副露含两组箭牌' in two_dragons[0].signals
    three_dragons = opponent_risk_profiles(
        [{'discards': [], 'melds': [meld('red'), meld('green'), meld('white')]}], 60)
    assert three_dragons[0].tier == 3
    assert three_dragons[0].factor == OPPONENT_RISK.factor_tier3
    three_winds = opponent_risk_profiles(
        [{'discards': [], 'melds': [meld('east'), meld('south'), meld('west')]}], 60)
    assert three_winds[0].tier == 3


def test_concealed_suit_avoidance_prices_suspect_suit_higher():
    """门清花色回避：整局几乎不打某花色 → 九莲/清一色嫌疑（tier 2），嫌疑花色更贵。"""
    opponent = {'discards': [*discards(6, 'm1'), 'p2', 'p3', 'white', 'east'], 'melds': []}
    profiles = opponent_risk_profiles([opponent], 60)
    assert profiles[0].tier == 2
    assert '牌河几乎未打条' in profiles[0].signals
    assert profiles[0].suspect_suit == 's'
    assert profiles[0].avoids_honor_terminals is False   # 牌河有 m1/white/east → 不是字牌幺九轴
    exposure = exposure_of(profiles)
    assert exposure('s5') == 160    # 40 × 16 × 0.25（嫌疑花色）
    assert exposure('m5') == 80     # 非嫌疑花色 × 0.5


def test_concealed_thirteen_orphans_axis_tier3():
    """十三幺/字一色读牌：牌河零字牌幺九 → tier 3，字牌幺九照价 320、中张只要 80。"""
    opponent = {'discards': list(THIRTEEN_ORPHANS_RIVER), 'melds': []}
    profiles = opponent_risk_profiles([opponent], 30)
    assert profiles[0].tier == 3
    assert profiles[0].factor == OPPONENT_RISK.factor_tier3
    assert profiles[0].avoids_honor_terminals is True
    assert '牌河零字牌幺九' in profiles[0].signals
    assert '牌河中张密集' in profiles[0].signals
    assert profiles[0].suspect_suit is None      # 三花色均衡 → 无花色嫌疑
    exposure = exposure_of(profiles)
    assert exposure('north') == 320   # 字牌：真实十六倍级硬胡点炮量级
    assert exposure('east') == 320
    assert exposure('m1') == 320      # 幺九
    assert exposure('m9') == 320
    assert exposure('p5') == 80       # 中张：十三幺几乎不需要 → 损失最小化的落点
    assert exposure('m2') == 80


def test_concealed_flush_zero_river_tier3():
    """门清单花色零牌河 → tier 3（九莲/清一色量级）；嫌疑花色中张照价、其他花色便宜。"""
    river = ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'p2', 'p3', 'p4', 'p5', 'p6']
    profiles = opponent_risk_profiles([{'discards': river, 'melds': []}], 30)
    assert profiles[0].tier == 3
    assert '牌河未打条' in profiles[0].signals
    assert profiles[0].signals == ['牌河零字牌幺九', '牌河未打条', '牌河中张密集']
    assert profiles[0].suspect_suit == 's'
    exposure = exposure_of(profiles)
    assert exposure('s5') == 320      # 40 × 32 × 0.25（嫌疑花色中张不打折）
    assert exposure('m5') == 40       # 非嫌疑花色中张：×0.5 ×0.25 → 40 × 4 × 0.25
    assert exposure('north') == 160   # 非嫌疑花色字牌：×0.5 → 40 × 16 × 0.25（字牌轴上保留下限）


def test_thirteen_orphans_axis_two_copies_is_not_safe():
    """十三幺轴：手里两张字牌也不算安全（多现 ≠ 安全，保留下限 0.1）。"""
    profiles = opponent_risk_profiles(
        [{'discards': list(THIRTEEN_ORPHANS_RIVER), 'melds': []}], 30)
    exposure = exposure_of(profiles, ['east', 'east'])
    assert exposure('east') == 128    # 40 × 32 × 0.1（下限），不是 0
    assert exposure('north') == 320


def test_concealed_short_river_never_misreads():
    """门清短牌河不误判：长度不足只给弱信号，且不产生危险轴。"""
    profiles = opponent_risk_profiles([{'discards': ['m2', 'm3', 'm4'], 'melds': []}], 60)
    assert profiles[0].tier == 0
    assert profiles[0].signals == []
    assert profiles[0].avoids_honor_terminals is False
    assert profiles[0].suspect_suit is None


def test_seven_pairs_middle_heavy_is_only_a_weak_signal():
    """七对嫌疑（牌河中张密集）只是弱信号 tier 1。"""
    river = ['m2', 'm3', 'm4', 'p3', 'p4', 'p5', 's3', 's4', 's5', 'east', 'south', 'north']
    profiles = opponent_risk_profiles([{'discards': river, 'melds': []}], 60)
    assert '牌河中张密集' in profiles[0].signals
    assert profiles[0].tier == 1
    assert profiles[0].avoids_honor_terminals is False
    assert profiles[0].suspect_suit is None      # 弱信号不带花色嫌疑


def test_locked_opponent_loses_both_discounts():
    opponent = {'discards': ['m1'], 'melds': [meld('p4'), meld('p7')],
                'winCount': 12, 'locked': True}
    profiles = opponent_risk_profiles([opponent], 40)
    assert profiles[0].tier == 2
    assert profiles[0].locked is True
    assert '已胡12次仍听' in profiles[0].signals
    exposure = exposure_of(profiles, ['p4', 'p4'])
    assert exposure('p4') > 0
    assert exposure('p4') == exposure('m9')
    # 40 × 16 × 0.25：现物不再按 ladder 归零（生张同价），非嫌疑花色也不再 ×0.5。
    assert exposure('p4') == 160


def test_locked_without_wins_keeps_discounts():
    """只锁手、没胡过（winCount=0）不算「已胡仍听」：档位来自副露，折扣照旧。"""
    opponent = {'discards': [], 'melds': [meld('p4'), meld('p7')],
                'winCount': 0, 'locked': True}
    profiles = opponent_risk_profiles([opponent], 60)
    assert profiles[0].locked is False
    assert profiles[0].tier == 2
    exposure = exposure_of(profiles, ['p4', 'p4'])
    assert exposure('p4') == 0


def test_takes_the_highest_weight_single_opponent_not_the_sum():
    flush = {'discards': [], 'melds': [meld('p4'), meld('p7')]}
    profiles = opponent_risk_profiles([flush, flush, flush], 60)
    assert max_opponent_risk_tier(profiles) == 2
    assert exposure_of(profiles)('p3') == 160      # 相加会得到 480


def test_only_public_information_is_used():
    opponent = {'discards': ['m1', 'm2'], 'melds': [meld('s5'), meld('s8')]}
    assert opponent_risk_profiles([opponent], 60)[0].tier == 2


def test_half_flush_counts_every_tile_of_every_meld():
    """副露按 tiles 逐张计花色（chi 三张不同 / gang 四张），不是只看 meld.tile。"""
    opponent = {'discards': ['p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east', 'east'],
                'melds': [{'type': 'chi', 'tile': 'p4', 'tiles': ['p3', 'p4', 'p5']},
                          {'type': 'gang', 'tile': 'm7', 'tiles': ['m7'] * 4}]}
    profiles = opponent_risk_profiles([opponent], 60)
    assert profiles[0].tier == 1
    assert profiles[0].signals == ['副露半染手']
    assert profiles[0].suspect_suit == 'm'
    exposure = exposure_of(profiles)
    assert exposure('m5') == 40     # 40 × 4 × 0.25（嫌疑花色）
    assert exposure('p5') == 20     # 40 × 4 × 0.5 × 0.25（非嫌疑花色）


def test_no_discards_never_raises_short_discard_signal():
    """`副露少牌河快听` 要求牌河至少有 1 张（与 TS 的 `discards.length >= 1` 守卫一致）。"""
    flush_profiles = opponent_risk_profiles(
        [{'discards': [], 'melds': [meld('p4'), meld('p7')]}], 60)
    feature = opponent_pattern_feature(flush_profiles, [], 'p3')
    assert (feature.tier, feature.payment) == ('中', 160)
    assert feature.signals == ['副露染手嫌疑']
    assert opponent_pattern_feature(flush_profiles, [], 'm3').payment == 80
    with_discard = opponent_risk_profiles(
        [{'discards': ['m1'], 'melds': [meld('p4'), meld('p7')]}], 60)
    assert with_discard[0].signals == ['副露染手嫌疑', '副露少牌河快听']


def test_candidate_feature_and_reasoning_threat_score():
    quiet_profiles = opponent_risk_profiles([QUIET], 60)
    assert opponent_pattern_feature(quiet_profiles, [], 'm5') is None
    flush_profiles = opponent_risk_profiles(
        [{'discards': [], 'melds': [meld('p4'), meld('p7')]}], 60)
    assert opponent_threat_score(quiet_profiles, 60) == 0
    assert opponent_threat_score(flush_profiles, 60) == 70
    assert opponent_threat_score(flush_profiles, 20) == 80
    dragons = opponent_risk_profiles(
        [{'discards': [], 'melds': [meld('red'), meld('green'), meld('white')]}], 60)
    assert opponent_threat_score(dragons, 60) == 90
    assert opponent_threat_score(dragons, 20) == 100


def test_feature_signals_are_capped_at_three_and_deduplicated():
    opponent = {'discards': [], 'melds': [meld('red'), meld('green'), meld('white')],
                'winCount': 3, 'locked': True}
    profiles = opponent_risk_profiles([opponent], 60)
    feature = opponent_pattern_feature(profiles, [], 'm5')
    assert len(feature.signals) == 3
    assert feature.signals == ['副露含三组箭牌', '副露字牌成组', '副露3组']


def test_deterministic_repeated_calls():
    opponent = {'discards': ['m1', 'm2'], 'melds': [meld('p4'), meld('p7')]}

    def fields(profile):
        return (profile.tier, profile.factor, profile.signals, profile.suspect_suit,
                profile.locked, profile.avoids_honor_terminals, profile.axis_source,
                profile.honors_in_flush, profile.honor_emphasis)

    first = opponent_risk_profiles([opponent], 60)
    second = opponent_risk_profiles([opponent], 60)
    assert [fields(p) for p in first] == [fields(p) for p in second]


# ── v3：已公开番型（OpponentKnownWin 等价结构） ──

def known_win(pattern_id: str, label: str, multiplier: float, tile: str = None) -> dict:
    return {'id': pattern_id, 'label': label, 'multiplier': multiplier, 'tile': tile}


def test_known_wins_lower_bounds_the_threat_tier():
    """已公开番型的倍率 4/8/16 → 威胁档下限 tier1/2/3，signal 文案为「已胡{label}」。"""
    light = opponent_risk_profiles(
        [{'discards': [], 'melds': [], 'knownWins': [known_win('mixed-suit', '混一色', 4)]}], 60)[0]
    assert (light.tier, light.factor) == (1, 4)
    assert light.signals == ['已胡混一色']
    mid = opponent_risk_profiles(
        [{'discards': [], 'melds': [],
          'knownWins': [known_win('big-three-dragons', '大三元', 8)]}], 60)[0]
    assert (mid.tier, mid.factor) == (2, 16)
    assert mid.signals == ['已胡大三元']
    top = opponent_risk_profiles(
        [{'discards': [], 'melds': [],
          'knownWins': [known_win('nine-gates', '九莲宝灯', 16)]}], 60)[0]
    assert (top.tier, top.factor) == (3, 32)
    assert top.signals == ['已胡九莲宝灯']


def test_known_wins_take_the_strongest_multiplier_only_for_the_bound():
    """档位下限取最强的那次已胡番型，但 honorEmphasis 等轴判定看整份 knownWins。"""
    profile = opponent_risk_profiles(
        [{'discards': [], 'melds': [], 'knownWins': [
            known_win('pinghu', '平胡', 1), known_win('big-four-winds', '大四喜', 16)]}], 60)[0]
    assert (profile.tier, profile.factor) == (3, 32)
    assert profile.signals == ['已胡大四喜']
    assert (profile.axis_source, profile.honor_emphasis) == ('known', True)


def test_known_win_below_threshold_keeps_signal_out_and_no_axis():
    """倍率低于 4（平胡量级）不设档、也不产生 known 轴。"""
    profile = opponent_risk_profiles(
        [{'discards': [], 'melds': [], 'knownWins': [known_win('pinghu', '平胡', 1)]}], 60)[0]
    assert (profile.tier, profile.factor) == (0, 1)
    assert profile.signals == []
    assert profile.axis_source is None


def test_known_honor_terminal_axis_applies_to_locked_opponent():
    """v3 核心：已公开十三幺 → known 轴对锁手家同样成立（字牌幺九贵、中张便宜）。"""
    locked = opponent_risk_profiles([{
        'discards': ['m1', 'p9', 'm4', 'm5', 'p4', 'p5', 's4', 's5', 'east', 'south'],
        'melds': [], 'winCount': 3, 'locked': True,
        'knownWins': [known_win('thirteenOrphans', '十三幺', 16)]}], 40)[0]
    assert (locked.tier, locked.factor) == (3, 32)
    assert locked.signals == ['已胡十三幺', '已胡3次仍听']
    assert locked.locked is True
    assert (locked.axis_source, locked.avoids_honor_terminals) == ('known', True)
    assert locked.suspect_suit is None
    exposure = exposure_of([locked])
    assert exposure('north') == 320
    assert exposure('m9') == 320
    assert exposure('p5') == 80

    # 对照：同一牌河但没有公开番型 → inferred 轴对锁手家不可用，一律同价（160）。
    inferred = opponent_risk_profiles([{
        'discards': ['m1', 'p9', 'm4', 'm5', 'p4', 'p5', 's4', 's5', 'east', 'south'],
        'melds': [], 'winCount': 3, 'locked': True}], 40)[0]
    costs = [exposure_of([inferred])(tile) for tile in ('north', 'm9', 'p5', 'east')]
    assert set(costs) == {160}


def test_known_honor_emphasis_axis_prices_honors_higher():
    """v3 字牌刻子轴：大三元（8 倍）→ 字牌照价 160、普通数牌 ×0.5 = 80。"""
    profile = opponent_risk_profiles([{
        'discards': ['m1', 'p9', 'm4', 'm5', 'p4', 'p5', 's4', 's5', 'east', 'south'],
        'melds': [], 'winCount': 1, 'locked': True,
        'knownWins': [known_win('big-three-dragons', '大三元', 8, tile='red')]}], 40)[0]
    assert (profile.tier, profile.factor) == (2, 16)
    assert profile.signals == ['已胡大三元', '已胡1次仍听']
    assert (profile.axis_source, profile.honor_emphasis) == ('known', True)
    assert profile.avoids_honor_terminals is False
    exposure = exposure_of([profile])
    assert exposure('east') == 160
    assert exposure('m5') == 80
    assert exposure('north') == 160


def test_known_flush_axis_uses_the_winning_tile_suit():
    """v3 花色轴：九莲宝灯（tile=s9）→ 嫌疑花色由公开胡牌牌面确定（比牌河推断可靠）。

    注意：``off_suit`` 折扣要求轴「可用」——已知花色轴对锁手家成立（s 仍最贵），
    但锁手家的非嫌疑花色折扣不生效（锁手可能停在单吊任意听），与 TS 逐位一致。
    """
    locked = opponent_risk_profiles([{
        'discards': ['m1', 'p9', 'm4', 'm5', 'p4', 'p5', 's4', 's5', 'east', 'south'],
        'melds': [], 'winCount': 2, 'locked': True,
        'knownWins': [known_win('nine-gates', '九莲宝灯', 16, tile='s9')]}], 40)[0]
    assert (locked.tier, locked.factor) == (3, 32)
    assert locked.suspect_suit == 's'
    assert locked.axis_source == 'known'
    assert locked.honors_in_flush is False
    exposure = exposure_of([locked])
    assert exposure('s5') == 320    # 嫌疑花色中张照价（锁手但 known 轴成立）
    assert exposure('m5') == 32     # 轴外（非嫌疑花色）：known 轴压到 0.1 倍
    assert exposure('north') == 32

    # 未锁手（同牌河同公开番型）：非嫌疑花色 ×0.5 生效 → 中张 80、字牌 160。
    unlocked = opponent_risk_profiles([{
        'discards': ['m1', 'p9', 'm4', 'm5', 'p4', 'p5', 's4', 's5', 'east', 'south'],
        'melds': [], 'knownWins': [known_win('nine-gates', '九莲宝灯', 16, tile='s9')]}], 40)[0]
    assert unlocked.locked is False
    exposure = exposure_of([unlocked])
    assert exposure('s5') == 320
    assert exposure('m5') == 32     # 非嫌疑花色：已知番型 → 权重 32 × 0.1（实测该轴外牌对锁手清一色是"不能胡"）
    assert exposure('north') == 32  # 非嫌疑花色字牌：同样走 known 轴的轴外系数 0.1

def test_known_mixed_suit_counts_honors_as_the_same_suit():
    """v3 混一色：honorsInFlush 为真 → 字牌算「本门」，不享受非嫌疑花色折扣。

    该牌河的推断部分是「牌河几乎未打条」（tier 2 / 嫌疑条），随后被公开番型改写：
    axisSource = known、honorsInFlush = true、嫌疑花色由胡牌牌面确定为 m。
    """
    profile = opponent_risk_profiles([{
        'discards': ['m1', 'p9', 'm4', 'm5', 'p4', 'p5', 's4', 's5', 'east', 'south'],
        'melds': [], 'winCount': 1, 'locked': True,
        'knownWins': [known_win('mixed-suit', '混一色', 2, tile='m3')]}], 40)[0]
    assert (profile.tier, profile.factor) == (2, 16)     # 2 倍低于 knownTier1Multiplier=4 → 档位来自读牌河
    assert profile.axis_source == 'known'
    assert profile.honors_in_flush is True
    assert profile.suspect_suit == 'm'
    exposure = exposure_of([profile])
    assert exposure('north') == 160   # 字牌算本门：不 ×0.5（16 × 0.25 × 40）
    assert exposure('m5') == 160      # 嫌疑花色：16 × 0.25 × 40（中张不在字牌幺九轴上）
    assert exposure('s5') == 16       # 轴外（非本门且非字牌）：已知番型压到 0.1 倍

    unlocked = opponent_risk_profiles([{
        'discards': ['m1', 'p9', 'm4', 'm5', 'p4', 'p5', 's4', 's5', 'east', 'south'],
        'melds': [], 'knownWins': [known_win('mixed-suit', '混一色', 2, tile='m3')]}], 40)[0]
    exposure = exposure_of([unlocked])
    assert exposure('north') == 10    # 未锁手且只有 known 轴（无档位）→ 字牌算本门：不 ×0.5（1 × 0.25 × 40）
    assert exposure('m5') == 10       # 嫌疑花色
    assert exposure('s5') == 10       # 无档位权重 1 → ×0.5 后仍不过基线，保持 40 × 0.25


def test_known_flush_without_tile_falls_back_to_river_inference():
    """公开胡牌牌面拿不到时，花色轴退回牌河推断（不硬造嫌疑花色）。"""
    profile = opponent_risk_profiles([{
        'discards': ['m1', 'm2', 'm3', 'm4', 'p1', 'p2', 'p3', 'p4', 'east', 'south'],
        'melds': [], 'knownWins': [known_win('pure-suit', '清一色', 4)]}], 60)[0]
    assert profile.axis_source == 'known'
    assert profile.suspect_suit == 's'        # 牌河一张条子没打 → 退回推断
    assert profile.tier == 2


def test_known_wins_accept_opponent_known_win_objects():
    """``OpponentKnownWin`` 等价结构：dataclass 与 dict 都可作为 knownWins 输入。"""
    from app.core.opponent_pattern_risk import OpponentKnownWin
    profile = opponent_risk_profiles([{
        'discards': [], 'melds': [],
        'knownWins': [OpponentKnownWin(id='big-three-dragons', label='大三元',
                                       multiplier=8, tile='red')]}], 60)[0]
    assert (profile.tier, profile.axis_source, profile.honor_emphasis) == (2, 'known', True)
    assert profile.signals == ['已胡大三元']


def test_known_wins_are_deterministic_and_public_only():
    """只读公共信息：同样的输入两次结果逐位一致。"""
    opponent = {'discards': ['m1', 'p9', 'm4', 'm5'], 'melds': [],
                'winCount': 1, 'locked': True,
                'knownWins': [known_win('thirteenOrphans', '十三幺', 16)]}

    def fields(profile):
        return (profile.tier, profile.factor, profile.signals, profile.axis_source,
                profile.honors_in_flush, profile.honor_emphasis, profile.suspect_suit)

    assert [fields(p) for p in opponent_risk_profiles([opponent], 40)] == \
        [fields(p) for p in opponent_risk_profiles([opponent], 40)]
