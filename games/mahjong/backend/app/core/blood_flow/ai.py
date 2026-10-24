"""血流本地 AI 贪婪 EV 策略 —— 翻译自前端 patternPotentials.ts / evContext.ts / ai.ts 的 decideBloodFlowActionEv。

view 为前端 BloodFlowSeatView 同构 dict（room._seat_view 输出）。
EV 决策、source-v2 收益预测和大牌路线策略与前端 bloodFlow AI 保持同口径。
"""

from functools import cmp_to_key, lru_cache
from typing import Callable, Optional

from app.core.lotus_ai import decide_claim as lotus_decide_claim
from app.core.lotus_ai import decide_turn as lotus_decide_turn
from app.core.lotus_rules import waiting_tiles as lotus_waiting_tiles
from app.core.blood_flow.evaluate import evaluate_win
from app.core.blood_flow.types import WinEvaluationInput
from app.core.opponent_pattern_risk import (OPPONENT_RISK, OpponentRiskProfile,
                                            max_opponent_risk_tier,
                                            opponent_pattern_exposure,
                                            opponent_risk_profiles)
from app.core.tiles import TILE_TYPES
from app.models.game import TileType

from .config import (BLOOD_FLOW_AI, BLOOD_FLOW_CONFIG, BLOOD_FLOW_DEFENSE,
                     BLOOD_FLOW_KONG_VALUE, BloodFlowAiConfig, KongValueConfig)
from .defense_policy import decide_defense_policy, own_hand_facts
from .kong_value import kong_candidate_value
from .big_hand_route import narrow_actions_to_route
from .pattern_reachability import can_develop_pattern_with_melds

HONORS: tuple[str, ...] = ('east', 'south', 'west', 'north', 'red', 'green', 'white')
DRAGONS: tuple[str, ...] = ('red', 'green', 'white')
WINDS: tuple[str, ...] = ('east', 'south', 'west', 'north')
GREEN_TILES = {'s2', 's3', 's4', 's6', 's8', 'green'}
TERMINAL_TILES = {'m1', 'm9', 'p1', 'p9', 's1', 's9'}
THIRTEEN_ORPHAN_TILES = ('m1', 'm9', 'p1', 'p9', 's1', 's9', *WINDS, *DRAGONS)


def wildcard_set(jokers: list[str]) -> set[str]:
    return {*jokers, 'white'}


# ── 特殊手潜力（与前端 patternPotentials.ts 同口径） ──

def _shi_san_lan_potential(hand: list[str], jokers: list[str]) -> int:
    joker_set = set(jokers)
    natural = [t for t in hand if t not in joker_set]
    defects = len(natural) - len(set(natural))
    for suit in ('m', 'p', 's'):
        ranks = sorted(int(t[1]) for t in natural if len(t) == 2 and t[0] == suit)
        for i in range(1, len(ranks)):
            if ranks[i] - ranks[i - 1] < 3:
                defects += 1
    honors_held = sum(1 for h in HONORS if h in natural)
    joker_count = len(hand) - len(natural)
    honor_shortfall = max(0, 7 - honors_held)
    jokers_after_honors = max(0, joker_count - honor_shortfall)
    defects_after_jokers = max(0, defects - jokers_after_honors)
    if defects_after_jokers > 3:
        return 0
    return (4 - defects_after_jokers) * 4 + honors_held + joker_count


def _thirteen_orphans_potential(hand: list[str], jokers: list[str]) -> int:
    joker_set = set(jokers)
    natural = [t for t in hand if t not in joker_set]
    held_kinds = sum(1 for t in THIRTEEN_ORPHAN_TILES if t in natural)
    joker_count = len(hand) - len(natural)
    kinds_after_jokers = held_kinds + joker_count
    if kinds_after_jokers < 10:
        return 0
    has_pair = any(natural.count(t) >= 2 for t in THIRTEEN_ORPHAN_TILES)
    pair_score = 8 if (has_pair or joker_count >= 2) else 0
    return (kinds_after_jokers - 10) * 3 + pair_score


def _seven_pairs_account(hand: list[str], jokers: list[str]) -> dict:
    """七对账目（2026-09-13 追加，对齐引擎 is_seven_pairs 的记账）。

    c=2 → 1 对；c=4 → 2 对；c=3 → 1 对 + 1 单；精牌先补单张，剩余精牌两两成对。
    旧口径（_seven_pairs_potential）只算到第一步，多余精牌直接丢掉。
    """
    joker_set = set(jokers)
    counts: dict[str, int] = {}
    jokers_in_hand = 0
    for tile in hand:
        if tile in joker_set:
            jokers_in_hand += 1
        else:
            counts[tile] = counts.get(tile, 0) + 1
    pairs = singles = 0
    for count in counts.values():
        pairs += count // 2
        singles += count % 2
    paired_by_jokers = min(singles, jokers_in_hand)
    leftovers = jokers_in_hand - paired_by_jokers
    return {
        'pairs': pairs, 'singles': singles, 'jokers': jokers_in_hand,
        'effectivePairs': pairs + paired_by_jokers + leftovers // 2,
        'counts': counts,
    }


def _seven_pairs_progress(hand: list[str], jokers: list[str]) -> float:
    """七对进度 0..1（有效对子数 / 7）。"""
    return max(0.0, min(1.0, _seven_pairs_account(hand, jokers)['effectivePairs'] / 7))


def _quad_availability(hand: list[str], jokers: list[str]) -> float:
    """四张可达性 0..1（豪华七对的第二半）：精牌能直接补成四张（刻子+精 / 对子+2 精 / 单张+3 精）。"""
    account = _seven_pairs_account(hand, jokers)
    available = account['jokers']
    best = 0.0
    for count in account['counts'].values():
        reach = count + available
        if reach >= 4:
            best = max(best, 1.0)
        elif count >= 3:
            best = max(best, 0.6)
        elif reach == 3:
            best = max(best, 0.5)
        elif count == 2:
            best = max(best, 0.2)
    return best


def _luxury_seven_pairs_progress(hand: list[str], jokers: list[str]) -> float:
    """豪华七对进度 0..1 = 七对进度 × 四张可达性。"""
    return _seven_pairs_progress(hand, jokers) * _quad_availability(hand, jokers)


def _seven_pairs_potential(hand: list[str], jokers: list[str]) -> int:
    """七对子潜力（旧口径，仅供经典玩法与旧 A/B 臂使用）：多余精牌被丢掉。"""
    account = _seven_pairs_account(hand, jokers)
    near_seven = account['pairs'] + min(account['singles'], account['jokers'])
    if near_seven < 5:
        return 0
    return near_seven * 4


# ── 番型潜力（翻译 patternPotentials.ts） ──

def _triplet_melds(melds: list[dict]) -> list[dict]:
    return [m for m in melds if m.get('type') != 'chi' and not m.get('windKong')]


def _declared_gang_count(melds: list[dict]) -> int:
    return sum(1 for m in melds if m.get('type') in ('gang', 'angang') and not m.get('windKong'))


def _shape(hand: list[str], melds: list[dict], jokers: list[str]) -> dict:
    wild = wildcard_set(jokers)
    natural = [t for t in hand if t not in wild]
    counts: dict[str, int] = {}
    for t in natural:
        counts[t] = counts.get(t, 0) + 1
    meld_tiles = [t for m in melds for t in m.get('tiles', [])]
    return {'natural': natural, 'counts': counts, 'joker_count': len(hand) - len(natural),
            'suited': [t for t in natural if len(t) == 2],
            'honors': [t for t in natural if len(t) != 2],
            'meld_tiles': meld_tiles}


def pattern_potentials(hand: list[str], melds: list[dict], jokers: list[str],
                       model: str = 'off') -> list[dict]:
    """每种方向的接近度。

    ``model``（2026-09-13 追加，默认 'off' 保持旧口径逐位不变）：
    'off' = 七对方向用旧 _seven_pairs_potential；'ev' = 对齐引擎记账 + 新增豪华七对（12 番）方向。
    """
    s = _shape(hand, melds, jokers)
    effective = len(hand) + 3 * len(melds)
    directions: list[dict] = []

    def add(pattern_id: str, progress: float) -> None:
        if progress <= 0 or not can_develop_pattern_with_melds(pattern_id, melds):
            return
        progress = min(1.0, progress)
        weight = BLOOD_FLOW_CONFIG.patterns[pattern_id].weight
        directions.append({'id': pattern_id, 'weight': weight, 'progress': progress,
                           'score': weight * progress ** 2})

    meld_tiles = s['meld_tiles']
    suit_counts: dict[str, int] = {}
    for tile in s['suited']:
        suit_counts[tile[0]] = suit_counts.get(tile[0], 0) + 1
    meld_honors = sum(1 for t in meld_tiles if len(t) != 2)
    meld_suits = {t[0] for t in meld_tiles if len(t) == 2}
    main_suit = max(suit_counts, key=suit_counts.get) if suit_counts else None
    main_count = suit_counts.get(main_suit, 0) if main_suit else 0
    single_suit_melds = len(meld_suits) <= 1 and (main_suit is None or not meld_suits or main_suit in meld_suits)
    if not s['honors'] and not meld_honors and single_suit_melds and (main_count + s['joker_count']) > 0:
        add('pure-suit', (main_count + s['joker_count']) / effective)
    honors_or_joker = len(s['honors']) + meld_honors + s['joker_count']
    if single_suit_melds and (main_count + s['joker_count']) > 0 and honors_or_joker > 0 \
            and (len(s['honors']) + meld_honors > 0 or s['joker_count'] > 0):
        add('mixed-suit', (main_count + s['joker_count'] + len(s['honors']) + meld_honors) / effective)

    has_chi_meld = any(m.get('type') == 'chi' for m in melds)
    if not has_chi_meld:
        triplet_units = len(_triplet_melds(melds))
        for count in s['counts'].values():
            triplet_units += count // 3 + (1 if count % 3 == 2 else 0)
        add('all-triplets', (triplet_units + s['joker_count']) / 5)

    for pattern_id, tile_set, need, pair_need in (
        ('little-three-dragons', DRAGONS, 2, 1), ('big-three-dragons', DRAGONS, 3, 0),
        ('little-four-winds', WINDS, 3, 1), ('big-four-winds', WINDS, 4, 0),
    ):
        units = pairs = 0
        for tile in tile_set:
            count = s['counts'].get(tile, 0)
            units += 1 if count >= 3 or any(m.get('tile') == tile for m in _triplet_melds(melds)) else 0
            pairs += 1 if count == 2 else 0
        jk = s['joker_count']
        with_jokers = min(need, units + max(0, jk - pair_need))
        add(pattern_id, (with_jokers + min(pair_need, pairs + min(jk, pair_need))) / (need + pair_need))

    if not melds and not s['honors'] and len(suit_counts) <= 1:
        need = (3, 1, 1, 1, 1, 1, 1, 1, 3)
        satisfied = 0
        for rank in range(1, 10):
            satisfied += min(s['counts'].get(f'{main_suit or "m"}{rank}', 0), need[rank - 1])
        add('nine-gates', min(1.0, (satisfied + s['joker_count']) / 14) * (1 if len(suit_counts) <= 1 else 0))

    # 绿一色：副露必须已经全绿（含精牌），手牌部分只算接近度——对齐前端 patternPotentials.ts。
    # 注意不是"整手都必须已经全绿"：那是判定（certainPatterns），不是潜力方向。
    if all(t in GREEN_TILES or t in wildcard_set(jokers) for t in meld_tiles):
        in_set = sum(1 for t in s['natural'] if t in GREEN_TILES)
        add('all-green', (in_set + s['joker_count']) / effective)

    if not has_chi_meld:
        all_natural = [*s['natural'], *meld_tiles]
        restricted = all(t in TERMINAL_TILES or len(t) != 2 for t in all_natural)
        if restricted and len(s['honors']) + meld_honors == 0:
            units = len(_triplet_melds(melds))
            units += sum(c // 3 for c in s['counts'].values())
            add('pure-terminals', (units + s['joker_count']) / 5)
        if restricted and (len(s['suited']) > 0 or s['joker_count'] > 0) \
                and (len(s['honors']) + meld_honors > 0 or s['joker_count'] > 0):
            units = len(_triplet_melds(melds))
            units += sum(c // 3 for c in s['counts'].values())
            add('mixed-terminals', (units + s['joker_count']) / 5)

    concealed_units = sum(1 for m in melds if m.get('type') == 'angang')
    concealed_units += sum(1 for c in s['counts'].values() if c >= 3)
    add('three-concealed-triplets', (concealed_units + s['joker_count']) / 3)
    add('four-concealed-triplets', (concealed_units + s['joker_count']) / 4)

    if not s['suited'] and all(len(t) != 2 for t in meld_tiles):
        add('all-honors', (len(s['honors']) + s['joker_count']) / effective)

    gangs = _declared_gang_count(melds)
    if gangs > 0:
        add('three-kongs', gangs / 3)
        add('four-kongs', gangs / 4)

    wild = list(wildcard_set(jokers))
    shi_san = _shi_san_lan_potential(hand, wild)
    if shi_san > 0:
        honors_held = sum(1 for h in HONORS if h in s['natural'])
        add('shiSanLan', min(1.0, shi_san / 24))
        if honors_held == 7 and s['joker_count'] == 0:
            add('qiXing', min(1.0, shi_san / 24))
    orphans = _thirteen_orphans_potential(hand, wild)
    if orphans > 0:
        add('thirteenOrphans', min(1.0, orphans / 17))
    if model == 'ev':
        # 对齐引擎记账：多余精牌两两成对不再丢掉；精牌能补成四张时同时给出 12 番的豪华七对方向。
        account = _seven_pairs_account(hand, wild)
        if account['effectivePairs'] >= 5:
            add('sevenPairs', min(1.0, account['effectivePairs'] / 7))
            add('luxury-seven-pairs', _luxury_seven_pairs_progress(hand, wild))
    else:
        seven = _seven_pairs_potential(hand, wild)
        if seven > 0:
            add('sevenPairs', min(1.0, seven / 28))
    return directions


def pattern_potential_total(hand: list[str], melds: list[dict], jokers: list[str],
                            model: str = 'off') -> float:
    return sum(d['score'] for d in pattern_potentials(hand, melds, jokers, model))


def pattern_potential_ev(hand: list[str], melds: list[dict], jokers: list[str], wall_count: int,
                         model: str = 'off',
                         config: BloodFlowAiConfig = BLOOD_FLOW_AI) -> float:
    late = 0.4 if wall_count <= config.late_game_wall_count else 1.0
    return pattern_potential_total(hand, melds, jokers, model) * BLOOD_FLOW_CONFIG.base_points * late


# ── 收益估算（翻译 estimateWinIncome / certainPatterns） ──

def _certain_patterns(hand: list[str], melds: list[dict], jokers: list[str],
                      model: str = 'off') -> set[str]:
    s = _shape(hand, melds, jokers)
    certain: set[str] = set()
    meld_tiles = s['meld_tiles']
    suits = {t[0] for t in s['suited']}
    honors = len(s['honors']) + sum(1 for t in meld_tiles if len(t) != 2)
    joker_count = s['joker_count']
    has_chi_meld = any(m.get('type') == 'chi' for m in melds)

    if honors == 0 and len(suits) <= 1 and len(s['suited']) + joker_count > 0:
        certain.add('pure-suit')
    if len(suits) <= 1 and honors > 0 and len(s['suited']) + joker_count > 0:
        certain.add('mixed-suit')

    if not has_chi_meld:
        joker_demand = 0
        pair_found = False
        for count in s['counts'].values():
            rest = count % 3
            if rest == 1:
                joker_demand += 2
            if rest == 2:
                pair_found = True
        if not pair_found:
            joker_demand += max(0, 2 - joker_count)
        if joker_demand <= joker_count:
            certain.add('all-triplets')

    concealed_units = sum(1 for m in melds if m.get('type') == 'angang')
    concealed_units += sum(1 for c in s['counts'].values() if c >= 3)
    if concealed_units >= 3:
        certain.add('three-concealed-triplets')
    if concealed_units >= 4:
        certain.add('four-concealed-triplets')

    triplets = _triplet_melds(melds)
    dragon_units = [t for t in DRAGONS if s['counts'].get(t, 0) >= 3 or any(m.get('tile') == t for m in triplets)]
    dragon_pairs = [t for t in DRAGONS if s['counts'].get(t, 0) == 2]
    if len(dragon_units) == 3:
        certain.add('big-three-dragons')
    elif len(dragon_units) == 2 and (dragon_pairs or joker_count > 0):
        certain.add('little-three-dragons')
    wind_units = [t for t in WINDS if s['counts'].get(t, 0) >= 3 or any(m.get('tile') == t for m in triplets)]
    wind_pairs = [t for t in WINDS if s['counts'].get(t, 0) == 2]
    if len(wind_units) == 4:
        certain.add('big-four-winds')
    elif len(wind_units) == 3 and (wind_pairs or joker_count > 0):
        certain.add('little-four-winds')

    if not melds and honors == 0 and len(suits) <= 1:
        need = (3, 1, 1, 1, 1, 1, 1, 1, 3)
        suit = next(iter(suits)) if suits else 'm'
        deficit = 0
        for rank in range(1, 10):
            deficit += max(0, need[rank - 1] - s['counts'].get(f'{suit}{rank}', 0))
        if deficit <= joker_count:
            certain.add('nine-gates')

    wild = wildcard_set(jokers)
    if all(t in GREEN_TILES or t in wild for t in [*hand, *meld_tiles]):
        certain.add('all-green')

    restricted = all(t in TERMINAL_TILES or len(t) != 2 or t in wild for t in [*hand, *meld_tiles])
    if restricted and honors == 0 and not has_chi_meld:
        certain.add('pure-terminals')
    if restricted and honors > 0 and len(s['suited']) + joker_count > 0 and not has_chi_meld:
        certain.add('mixed-terminals')

    if not s['suited'] and all(len(t) != 2 for t in meld_tiles):
        certain.add('all-honors')

    gangs = _declared_gang_count(melds)
    if gangs >= 3:
        certain.add('three-kongs')
    if gangs >= 4:
        certain.add('four-kongs')

    if model == 'ev':
        # 模型开启时用对齐引擎的记账：完整手牌里"七对里含四张相同"就是豪华七对（精牌顶替后计入）。
        account = _seven_pairs_account(hand, list(wild))
        if account['effectivePairs'] >= 7:
            certain.add('luxury-seven-pairs' if _quad_availability(hand, list(wild)) >= 1 else 'sevenPairs')
    elif _seven_pairs_potential(hand, list(wild)) >= 28:
        certain.add('sevenPairs')
    shi_san = _shi_san_lan_potential(hand, list(wild))
    honors_held = sum(1 for h in HONORS if h in s['natural'])
    if shi_san > 0 and _shi_san_lan_defect_free(hand, list(wild)):
        certain.add('qiXing' if (honors_held == 7 and joker_count == 0) else 'shiSanLan')
    orphans = _thirteen_orphans_potential(hand, list(wild))
    if orphans >= 17:
        certain.add('thirteenOrphans')

    for pattern_id in list(certain):
        for excluded in BLOOD_FLOW_CONFIG.patterns[pattern_id].excludes:
            certain.discard(excluded)
    return certain


def _shi_san_lan_defect_free(hand: list[str], jokers: list[str]) -> bool:
    joker_set = set(jokers)
    natural = [t for t in hand if t not in joker_set]
    defects = len(natural) - len(set(natural))
    for suit in ('m', 'p', 's'):
        ranks = sorted(int(t[1]) for t in natural if len(t) == 2 and t[0] == suit)
        for i in range(1, len(ranks)):
            if ranks[i] - ranks[i - 1] < 3:
                defects += 1
    honors_held = sum(1 for h in HONORS if h in natural)
    joker_count = len(hand) - len(natural)
    honor_shortfall = max(0, 7 - honors_held)
    jokers_after_honors = max(0, joker_count - honor_shortfall)
    return max(0, defects - jokers_after_honors) == 0


def estimate_win_income(hand: list[str], melds: list[dict], jokers: list[str], source: str,
                        model: str = 'off') -> dict:
    patterns = _certain_patterns(hand, melds, jokers, model)
    # 2026-09-15 与 score.py 同口径：倍率 = Σ(番值)；无番种时取 1，鸡胡的半番落在支付减半上。
    raw_sum = sum(BLOOD_FLOW_CONFIG.patterns[pattern_id].weight for pattern_id in patterns)
    half_payment = len(patterns) == 1 and 'chicken' in patterns
    multiplier = max(1, raw_sum)
    hard_likely = not any(t in wildcard_set(jokers) for t in hand)
    event_multiplier = BLOOD_FLOW_CONFIG.event_multipliers[source]
    final_multiplier = min(multiplier * event_multiplier * (2 if hard_likely else 1),
                           BLOOD_FLOW_CONFIG.max_multiplier_per_payer)
    payment_per_payer = (BLOOD_FLOW_CONFIG.base_points * final_multiplier) // (2 if half_payment else 1)
    payers = 3 if source in ('self-draw', 'kong-bloom') else 1
    return {'paymentPerPayer': payment_per_payer, 'total': payment_per_payer * payers,
            'multiplier': final_multiplier, 'hardLikely': hard_likely}


# ── 连锁期望与听口缓存 ──

_waiting_cache: dict[str, list[str]] = {}


def waiting_tiles_cached(hand: list[str], exposed_melds: int, jokers: list[str]) -> list[str]:
    key = f"{exposed_melds}|{','.join(sorted(jokers))}|{','.join(sorted(hand))}"
    if key in _waiting_cache:
        return _waiting_cache[key]
    waits = list(lotus_waiting_tiles(list(hand), exposed_melds, list(jokers)))
    if len(_waiting_cache) >= 20_000:
        _waiting_cache.pop(next(iter(_waiting_cache)))
    _waiting_cache[key] = waits
    return waits


def _remaining_count(tile: str, visible: list[str]) -> int:
    return max(0, 4 - visible.count(tile))


def _forecast_meld_key(melds: list) -> tuple:
    result = []
    for meld in melds:
        if isinstance(meld, dict):
            field = meld.get
        else:
            field = lambda name, default=None: getattr(meld, name, default)
        result.append((field('type', ''), field('tile', ''),
                       tuple(field('tiles', []) or []), bool(field('windKong', False))))
    return tuple(result)


@lru_cache(maxsize=20_000)
def _canonical_forecast_win_income(concealed: tuple[str, ...], meld_key: tuple,
                                   jokers: tuple[str, ...], winning_tile: str,
                                   source: str) -> float:
    melds = tuple({
        'type': kind, 'tile': tile, 'tiles': list(tiles),
        **({'windKong': True} if wind_kong else {}),
    } for kind, tile, tiles, wind_kong in meld_key)
    evaluation = evaluate_win(WinEvaluationInput(
        concealed=concealed, melds=melds, winning_tile=winning_tile,
        source=source, jokers=jokers, opening=None,
    ), BLOOD_FLOW_CONFIG)
    if evaluation is None:
        return 0.0
    payers = 3 if source in ('self-draw', 'kong-bloom') else 1
    return float(evaluation.score.payment_per_payer * payers)


def forecast_win_income(concealed: list[str], melds: list[dict], jokers: list[str],
                        winning_tile: str, source: str) -> float:
    """Gross income from the canonical scorer for one physical winning tile."""
    return _canonical_forecast_win_income(
        tuple(concealed), _forecast_meld_key(melds), tuple(jokers), winning_tile, source)


def unseen_counts(visible: list[str]) -> list[tuple[str, int]]:
    return [(tile, max(0, 4 - visible.count(tile))) for tile in TILE_TYPES]


def own_draw_opportunities(wall: int, horizon: int, offset: int = 4) -> int:
    """Normal-turn opportunities before the horizon-th own draw is passed."""
    if wall < offset or horizon <= 0:
        return 0
    return min(horizon, 1 + (wall - offset) // 4)


def normal_opportunities(wall: int, horizon: int, offset: int = 4) -> dict:
    if wall <= 0 or horizon <= 0:
        return {'own': 0, 'opponent': 0}
    own = own_draw_opportunities(wall, horizon, offset)
    consumed = max(0, min(wall, offset + 4 * horizon - 1))
    return {'own': own, 'opponent': max(0, consumed - own)}


def forecast_source_components(hand: list[str], melds: list[dict], jokers: list[str],
                               visible: list[str], wall: int, horizon: int,
                               offset: int = 4) -> dict:
    counts = unseen_counts(visible)
    unseen = sum(count for _tile, count in counts)
    opportunities = normal_opportunities(wall, horizon, offset)
    waits = set(waiting_tiles_cached(hand, len(melds), jokers))
    self_per_draw = 0.0
    ron_per_discard = 0.0
    if (opportunities['own'] or opportunities['opponent']) and unseen:
        for tile, count in counts:
            if not count or tile not in waits:
                continue
            self_per_draw += count / unseen * forecast_win_income(
                hand, melds, jokers, tile, 'self-draw')
            ron_per_discard += count / unseen * forecast_win_income(
                hand, melds, jokers, tile, 'discard')
    return {
        **opportunities,
        'selfPerDraw': self_per_draw,
        'ronPerDiscard': ron_per_discard,
    }


def forecast_calibrated_income(hand: list[str], melds: list[dict], jokers: list[str],
                               visible: list[str], wall: int, horizon: int,
                               offset: int, calibration) -> float:
    components = forecast_source_components(hand, melds, jokers, visible, wall, horizon, offset)
    own = min(horizon, wall, components['own'] * calibration.draw_scale)
    discards = components['opponent'] * calibration.discard_scale
    return (own * components['selfPerDraw'] * calibration.self_yield
            + discards * components['ronPerDiscard'] * calibration.ron_yield)


def forecast_self_draw_income(hand: list[str], melds: list[dict], jokers: list[str],
                              visible: list[str], wall: int, horizon: int,
                              offset: int = 4) -> float:
    draws = own_draw_opportunities(wall, horizon, offset)
    if not draws:
        return 0.0
    counts = unseen_counts(visible)
    unseen = sum(count for _tile, count in counts)
    if not unseen:
        return 0.0
    per_draw = sum(count / unseen * forecast_win_income(
        hand, melds, jokers, tile, 'self-draw') for tile, count in counts if count)
    return min(draws, unseen) * per_draw


def _chain_ev_legacy(hand: list[str], melds: list[dict], jokers: list[str],
                     visible: list[str], wall_count: int, model: str,
                     config: BloodFlowAiConfig, offset: int = 4) -> float:
    if not hand:
        return 0.0
    waits = waiting_tiles_cached(hand, len(melds), jokers)
    if not waits:
        return 0.0
    if is_any_tile_wait(waits, hand):
        return forecast_self_draw_income(
            hand, melds, jokers, visible, wall_count, config.chain_horizon, offset)
    chain_factor = min(1.0, config.chain_horizon / max(1, wall_count / 4))
    total = 0.0
    for tile in waits:
        remaining = _remaining_count(tile, visible)
        if not remaining:
            continue
        self_income = estimate_win_income([*hand, tile], melds, jokers, 'self-draw', model)
        discard_income = estimate_win_income([*hand, tile], melds, jokers, 'discard', model)
        average = (config.self_draw_weight * self_income['total'] + discard_income['total']) \
            / (config.self_draw_weight + 1)
        total += remaining * average * chain_factor
    return total


def chain_ev_est(hand: list[str], melds: list[dict], jokers: list[str],
                 visible: list[str], wall_count: int, model: str = 'off',
                 config: BloodFlowAiConfig = BLOOD_FLOW_AI, offset: int = 4) -> float:
    if wall_count <= 0:
        return 0.0
    if config.chain_forecast == 'source-v2' and config.opportunity_calibration is not None:
        return forecast_calibrated_income(
            hand, melds, jokers, visible, wall_count, config.chain_horizon,
            offset, config.opportunity_calibration)
    if config.chain_forecast == 'self-draw-v1':
        return forecast_self_draw_income(
            hand, melds, jokers, visible, wall_count, config.chain_horizon, offset)
    return _chain_ev_legacy(hand, melds, jokers, visible, wall_count, model, config, offset)



def is_any_tile_wait(waits: list[str], owned: list[str] | None = None) -> bool:
    owned = owned or []
    return bool(waits) and all(tile in waits or owned.count(tile) >= 4 for tile in TILE_TYPES)


# ── 对手牌型（大牌）风险定价（前后端同源；见 core/opponent_pattern_risk.py） ──

def _safety_exposure_for(config: BloodFlowAiConfig,
                         visible: list[str]) -> Callable[[str], float]:
    """放炮成本（旧口径）：牌河公开张数档位 × 按 4 倍级单家支付（40 点）估算的暴露。"""
    def exposure(tile: str) -> float:
        count = sum(1 for visible_tile in visible if visible_tile == tile)
        ladder = config.safety_cost_safe if count >= 2 else \
            config.safety_cost_one if count == 1 else config.safety_cost_none
        return ladder * 40

    return exposure


def blood_flow_risk_tuning(config: BloodFlowAiConfig = BLOOD_FLOW_AI) -> dict:
    """config → 风险模块调参（前后端同源，见 core/opponent_pattern_risk.py）。"""
    return {
        'factor_tier1': config.risk_factor_tier1,
        'factor_tier2': config.risk_factor_tier2,
        'factor_tier3': config.risk_factor_tier3,
        'off_suit_factor': config.risk_off_suit_factor,
        'exposure_unit': 40,
        'safety_cost_none': config.safety_cost_none,
        'safety_cost_one': config.safety_cost_one,
        'safety_cost_safe': config.safety_cost_safe,
        'late_game_wall_count': config.late_game_wall_count,
        'known_tier1_multiplier': OPPONENT_RISK.known_tier1_multiplier,
        'known_tier2_multiplier': OPPONENT_RISK.known_tier2_multiplier,
        'known_tier3_multiplier': OPPONENT_RISK.known_tier3_multiplier,
    }


def _known_wins_of(view: dict, seat: int) -> list[dict]:
    """从公共批次里取某座位的历次胡牌番型（PublicWinScore.items + patternMultiplier）。

    与前端 ``knownWinsOf`` 逐项同源：每个 item 展开成 ``{id, label, multiplier, tile}``，
    ``multiplier`` 取该次胡的 ``patternMultiplier``，``tile`` 取该批次来源牌（公共信息）。
    """
    wins: list[dict] = []
    batches = (view.get('public') or {}).get('batches') or []
    for batch in batches:
        source_tile = (batch.get('source') or {}).get('tile')
        for win in batch.get('winners') or []:
            if win.get('winner') != seat:
                continue
            score = win.get('score') or {}
            for item in score.get('items') or []:
                wins.append({'id': item.get('id'), 'label': item.get('label'),
                             'multiplier': score.get('patternMultiplier'),
                             'tile': source_tile})
    return wins


def _known_wins_by_seat(view: dict) -> dict:
    """一次性把每个座位的公开番型摊平（``_known_wins_of`` 的批处理版）。"""
    return {player.get('seat'): _known_wins_of(view, player.get('seat'))
            for player in (view.get('players') or [])}


def blood_flow_known_wins(view: dict, known_wins: Optional[dict] = None) -> list[dict]:
    """每座位的公开番型（供 prompt、政策与后端镜像共用）。

    对齐前端 ``bloodFlowKnownWins``：``[{'seat': …, 'patterns': [{'label', 'multiplier'}]}]``；
    只保留已胡过（patterns 非空）的座位。``known_wins`` 可传入 ``_known_wins_by_seat`` 的结果复用。
    """
    known: list[dict] = []
    if known_wins is None:
        known_wins = _known_wins_by_seat(view)
    for player in view.get('players') or []:
        seat = player.get('seat')
        patterns = [{'label': win['label'], 'multiplier': win['multiplier']}
                    for win in known_wins.get(seat) or []]
        if patterns:
            known.append({'seat': seat, 'patterns': patterns})
    return known


def _seat_field(view: dict, seat: int, name: str, default=None):
    seats = (view.get('public') or {}).get('seats') or []
    if 0 <= seat < len(seats):
        state = seats[seat]
        value = state.get(name, default) if isinstance(state, dict) \
            else getattr(state, name, default)
        return default if value is None else value
    return default


def blood_flow_opponent_risk(view: dict,
                             config: BloodFlowAiConfig = BLOOD_FLOW_AI) -> list[dict]:
    """对手牌型风险档（只用公共信息）。血流额外带入已胡次数、锁手与**已公开番型**。

    ``opponent_pattern_risk == 'off'`` 时返回空列表，调用方回退旧口径（对齐前端
    bloodFlowOpponentRisk）。返回 dict 列表：风险档字段 + ``seat``（绝对座位）。
    """
    if config.opponent_pattern_risk == 'off':
        return []
    seat = view['seat']
    players = view.get('players') or []
    seats = [p.get('seat', index) for index, p in enumerate(players) if index != seat]
    known_wins = _known_wins_by_seat(view)
    opponents = []
    for index in range(len(players)):
        if index == seat:
            continue
        player = players[index] or {}
        opponents.append({
            'discards': player.get('discards') or [],
            'melds': player.get('melds') or [],
            'winCount': _seat_field(view, index, 'winCount', 0),
            'locked': _seat_field(view, index, 'locked', False),
            'knownWins': known_wins.get(index) or [],
        })
    profiles = opponent_risk_profiles(opponents, view.get('wallCount', 0),
                                      blood_flow_risk_tuning(config))
    result: list[dict] = []
    for profile in profiles:
        position = profile.index
        result.append({
            'index': profile.index, 'tier': profile.tier, 'factor': profile.factor,
            'signals': list(profile.signals), 'suspectSuit': profile.suspect_suit,
            'locked': profile.locked,
            'avoidsHonorTerminals': profile.avoids_honor_terminals,
            'axisSource': profile.axis_source,
            'honorsInFlush': profile.honors_in_flush,
            'honorEmphasis': profile.honor_emphasis,
            'seat': seats[position] if position < len(seats) else position,
        })
    return result


def _profiles_of(profiles: list[dict]) -> list[OpponentRiskProfile]:
    """dict 形态 → 风险模块档案（字段同名映射，含 v2 危险轴与 v3 公开番型轴）。"""
    return [OpponentRiskProfile(index=p['index'], tier=p['tier'], factor=p['factor'],
                                signals=list(p['signals']), suspect_suit=p.get('suspectSuit'),
                                locked=p['locked'],
                                avoids_honor_terminals=bool(p.get('avoidsHonorTerminals', False)),
                                axis_source=p.get('axisSource'),
                                honors_in_flush=bool(p.get('honorsInFlush', False)),
                                honor_emphasis=bool(p.get('honorEmphasis', False)))
            for p in profiles]


def blood_flow_safety_exposure(view: dict, config: BloodFlowAiConfig = BLOOD_FLOW_AI,
                               visible: Optional[list[str]] = None) -> Callable[[str], float]:
    """弃牌放炮成本：无风险信号时与旧口径逐位一致。

    公开张数口径用 `_exposure_visible_tiles`（含本家暗手，与前端 visibleTiles 同源）；
    'off' 回退分支与档位分支共用同一份可见牌，保证两个分支内部自洽。
    """
    tiles = list(visible) if visible is not None else _exposure_visible_tiles(view)
    profiles = blood_flow_opponent_risk(view, config)
    if not profiles:
        return _safety_exposure_for(config, tiles)
    return opponent_pattern_exposure(_profiles_of(profiles), tiles,
                                     blood_flow_risk_tuning(config))


def blood_flow_defense_policy(view: dict,
                              config: BloodFlowAiConfig = BLOOD_FLOW_AI) -> dict:
    """兜/弃政策（v3）：对手已做成大牌时本家「继续走」还是「弃胡兜安全张」。

    规则见 defense_policy.py 顶部注释（用户定稿的两条兜牌法 + 一条赌的出口）。
    返回 ``{'own': OwnHandFacts, 'result': DefensePolicyResult}``（对齐前端
    ``bloodFlowDefensePolicy``）。
    """
    seat = view['seat']
    player = (view.get('players') or [])[seat]
    visible = _exposure_visible_tiles(view)
    profiles = blood_flow_opponent_risk(view, config)
    known_wins = _known_wins_by_seat(view)
    own = own_hand_facts(
        player.get('hand') or [], player.get('melds') or [], list(view.get('jokers') or []),
        visible, config.defense,
        directions=[{'weight': d['weight'], 'progress': d['progress'],
                     'label': BLOOD_FLOW_CONFIG.patterns[d['id']].label}
                    for d in pattern_potentials(player.get('hand') or [],
                                                player.get('melds') or [],
                                                list(view.get('jokers') or []),
                                                config.seven_pairs_model)])
    opponents = []
    for index in range(len(view.get('players') or [])):
        if index == seat:
            continue
        profile = next((p for p in profiles if p['seat'] == index), None)
        opponents.append({
            'tier': profile['tier'] if profile else 0,
            'locked': _seat_field(view, index, 'locked', False),
            'knownMultiplier': max((win['multiplier'] or 0
                                    for win in known_wins.get(index) or []), default=0),
            'signals': list(profile['signals']) if profile else [],
        })
    return {'own': own, 'result': decide_defense_policy(own, opponents, config.defense)}


CLAIM_KINDS: frozenset[str] = frozenset(
    ('peng', 'chi', 'gang', 'added-kong', 'concealed-kong', 'wind-kong'))


def _apply_defense_constraint(view: dict, actions: list[dict], config: BloodFlowAiConfig,
                              precomputed: Optional[dict] = None) -> list[dict]:
    """兜牌模式的硬约束（v3，用户定稿方案 c）：候选层直接收窄，引擎与 LLM 共用同一份候选——

      ① 撤掉全部吃碰杠候选（不给自己制造「必须打危险张」的局面）；
      ② 弃牌候选只保留放炮成本最小档的那些（让模型只能在安全张里挑怎么打）；
      ③ 两个出口不受限：能打一张即精吊任意听、或我方上限不低于对手时，政策本身就是 push，
         不触发约束。胡永远保留（不会因为兜牌而放过已经能胡的牌）。
    """
    if config.defense.mode == 'off':
        return actions
    defense = precomputed if precomputed is not None else blood_flow_defense_policy(view, config)
    if defense['result'].mode != 'fold':
        return actions

    def keep_win_pass(action: dict) -> bool:
        return action['kind'] in ('win', 'pass')

    discards = [action for action in actions if action['kind'] == 'discard']
    if not discards:
        return [action for action in actions if keep_win_pass(action)]
    exposure = blood_flow_safety_exposure(view, config, _exposure_visible_tiles(view))
    hand = (view.get('players') or [])[view['seat']].get('hand') or []
    costs = [exposure(hand[action['index']]) for action in discards]
    floor = min(costs)
    safe = {action['index'] for position, action in enumerate(discards)
            if costs[position] <= floor + config.defense.fold_discard_tolerance}
    return [action for action in actions
            if (action['index'] in safe if action['kind'] == 'discard'
                else keep_win_pass(action))]


# ── EV 上下文与决策 ──

def _is_last_opportunity_ron(view: dict, config: BloodFlowAiConfig) -> bool:
    if not config.win_opportunity_guards:
        return False
    seat = view['seat']
    if view['public']['seats'][seat]['locked']:
        return False
    window = view.get('window') or {}
    source = window.get('source') or {}
    score = view.get('ownScore') or {}
    actions = view.get('ownActions') or []
    if (window.get('kind') == 'turn' or source.get('kind') != 'discard'
            or source.get('seat') == seat or score.get('source') != 'discard'
            or score.get('paymentPerPayer', 0) <= 0
            or view.get('wallCount', 0) > config.late_game_wall_count
            or not any(action.get('kind') == 'win' for action in actions)
            or any(action.get('kind') not in ('win', 'pass') for action in actions)):
        return False
    players = view.get('players') or []
    offset = ((seat - source.get('seat', seat) + len(players)) % max(1, len(players))) or 4
    return own_draw_opportunities(view.get('wallCount', 0), 2, offset) <= 1


def first_win_floor(wall_count: int, config: BloodFlowAiConfig = BLOOD_FLOW_AI) -> int:
    if wall_count <= config.late_game_wall_count:
        return config.first_win_floor_late
    if wall_count > config.early_game_wall_count:
        return config.first_win_floor_early
    return config.first_win_floor_mid


def _visible_tiles(view: dict) -> list[str]:
    tiles = [view.get('flipTile')]
    for p in view.get('players', []):
        tiles.extend(p.get('discards') or [])
        tiles.extend(t for m in (p.get('melds') or []) for t in m.get('tiles', []))
    tiles.extend(b['source']['tile'] for b in view.get('public', {}).get('batches', []))
    return [t for t in tiles if t]


def _exposure_visible_tiles(view: dict) -> list[str]:
    """放炮成本专用口径：等价于前端 seatView.visibleTiles（**含本家暗手**）。

    前端 `visibleTiles(view)` = [flipTile, 本家 hand, 各家 discards+melds, 胡牌来源牌]；
    后端 `_visible_tiles` 不含本家 hand（听口 / 剩余张数仍按既有口径使用，不在本次范围）。
    为与前端放炮定价逐位一致，本函数只服务放炮成本链路（localai 与 LLM 候选特征）。
    """
    seat = view.get('seat')
    players = view.get('players') or []
    tiles = [view.get('flipTile')]
    if isinstance(seat, int) and 0 <= seat < len(players):
        tiles.extend(players[seat].get('hand') or [])
    for p in players:
        tiles.extend(p.get('discards') or [])
        tiles.extend(t for m in (p.get('melds') or []) for t in m.get('tiles', []))
    tiles.extend(b['source']['tile'] for b in view.get('public', {}).get('batches', []))
    return [t for t in tiles if t]


def blood_flow_ev_context(view: dict, config: BloodFlowAiConfig = BLOOD_FLOW_AI) -> dict:
    seat = view['seat']
    player = view['players'][seat]
    locked = view['public']['seats'][seat]['locked']
    hand = player.get('hand') or []
    melds = player.get('melds') or []
    jokers = list(view.get('jokers') or [])
    visible = _exposure_visible_tiles(view)
    wall_count = view.get('wallCount', 0)
    drawn_index = player.get('drawnTileIndex', -1)
    window = view.get('window')
    source = (window or {}).get('source') or {}
    source_seat = source.get('seat', seat)
    player_count = max(1, len(view.get('players') or []))
    draw_offset = ((seat - source_seat + player_count) % player_count) or player_count

    own_actions = view.get('ownActions') or []
    win_offered = any(a['kind'] == 'win' for a in own_actions)
    score = view.get('ownScore')
    payers = 3 if score and score.get('source') in ('self-draw', 'kong-bloom') else 1
    immediate_total = (score or {}).get('paymentPerPayer', 0) * payers
    locked_hand = [t for i, t in enumerate(hand) if i != drawn_index] \
        if (window and window.get('kind') == 'turn' and drawn_index >= 0) else list(hand)
    reform_hands = [[t for i, t in enumerate(hand) if i != action['index']]
                    for action in own_actions
                    if action['kind'] == 'discard' and action['index'] != drawn_index] \
        if not locked and window and window['kind'] == 'turn' and source.get('kind') == 'draw' \
        and drawn_index >= 0 and win_offered else []
    income_model = 'self-draw-v1' if config.chain_forecast == 'legacy' and any(
        is_any_tile_wait(waiting_tiles_cached(tiles, len(melds), jokers), tiles)
        for tiles in [locked_hand, *reform_hands]) else config.chain_forecast

    def chain(tiles: list[str], offset: int = draw_offset) -> float:
        if income_model == 'self-draw-v1':
            return forecast_self_draw_income(tiles, melds, jokers, visible, wall_count,
                                             config.chain_horizon, offset)
        return chain_ev_est(tiles, melds, jokers, visible, wall_count,
                            config.seven_pairs_model, config, offset)
    chain_after_win = chain(locked_hand) if win_offered else 0.0
    win_ev = immediate_total + chain_after_win
    floor_waived = _is_last_opportunity_ron(view, config)
    floor = 0 if floor_waived else first_win_floor(wall_count, config)
    floor_stage = 'late' if wall_count <= config.late_game_wall_count else \
        'early' if wall_count > config.early_game_wall_count else 'mid'
    potential_total = pattern_potential_total(locked_hand, melds, jokers, config.seven_pairs_model)
    top_directions = sorted(pattern_potentials(locked_hand, melds, jokers, config.seven_pairs_model),
                            key=lambda d: -d['score'])[:3]
    develop_ev = pattern_potential_ev(locked_hand, melds, jokers, wall_count,
                                      config.seven_pairs_model, config)

    reform_candidates: list[dict] = []
    if not locked and window and window.get('kind') == 'turn' \
            and (window.get('source') or {}).get('kind') == 'draw' and drawn_index >= 0 and win_offered:
        for action in own_actions:
            if action['kind'] != 'discard' or action['index'] == drawn_index:
                continue
            after = [t for i, t in enumerate(hand) if i != action['index']]
            waits = waiting_tiles_cached(after, len(melds), jokers)
            if not waits:
                continue
            reform_candidates.append({
                'index': action['index'], 'tile': hand[action['index']],
                'ev': chain(after),
                'anyWait': is_any_tile_wait(waits, after), 'waitCount': len(waits),
                'patterns': [BLOOD_FLOW_CONFIG.patterns[d['id']].label
                             for d in sorted(pattern_potentials(after, melds, jokers, config.seven_pairs_model),
                                             key=lambda x: -x['score'])[:3]],
            })
        reform_candidates.sort(key=lambda c: -c['ev'])

    rob_ev = None
    if not locked and window and window.get('kind') != 'turn' \
            and (window.get('source') or {}).get('kind') == 'added-kong' and win_offered:
        kong_fee = BLOOD_FLOW_CONFIG.base_points * BLOOD_FLOW_CONFIG.kong_payments['added']
        rob_ev = {
            'winEv': win_ev,
            'passEv': -kong_fee + chain(hand, draw_offset + 1)
            + pattern_potential_ev(hand, melds, jokers, wall_count,
                                   config.seven_pairs_model, config),
        }

    return {
        'locked': locked, 'incomeModel': income_model, 'wallCount': wall_count, 'drawnIndex': drawn_index,
        'hand': hand, 'melds': melds, 'jokers': jokers, 'winOffered': win_offered,
        'immediateTotal': immediate_total, 'chainAfterWin': chain_after_win, 'winEv': win_ev,
        'floor': floor, 'floorWaived': floor_waived, 'floorStage': floor_stage, 'potentialTotal': potential_total,
        'topDirections': top_directions, 'developEv': develop_ev,
        'reformCandidates': reform_candidates, 'robEv': rob_ev,
    }


def _legal_actions(view: dict) -> list[dict]:
    actions = [dict(a) for a in (view.get('ownActions') or [])]
    if view['public']['seats'][view['seat']]['locked']:
        return actions
    protected = set(view.get('jokers', []))
    hand = view['players'][view['seat']].get('hand') or []
    discards = [a for a in actions if a['kind'] == 'discard']
    ordinary = [a for a in discards if hand[a['index']] not in protected]
    allowed = ordinary or discards
    keys = {('discard', a['index']) for a in allowed}
    return [a for a in actions if a['kind'] != 'discard' or ('discard', a['index']) in keys]


def _fallback_discard(hand: list[str], jokers: list[str], discards: list[dict]) -> dict:
    # Same bounded shape fallback as frontend lotusAi.chooseFallbackDiscardIndex.
    # The EV route can remove "win" after lotus_decide_turn has already returned it.
    allowed = {a['index']: a for a in discards if 0 <= a['index'] < len(hand)}
    candidates = list(allowed.values())
    protected = set(jokers)
    ordinary = [a for a in candidates if hand[a['index']] not in protected]
    choices = ordinary or candidates

    def shape(action: dict) -> tuple[int, int]:
        index = action['index']
        tile = hand[index]
        same = hand.count(tile) - 1
        suited = len(tile) == 2 and tile[0] in 'mps' and tile[1] in '123456789'
        neighbors = int(suited and f'{tile[0]}{int(tile[1]) - 1}' in hand) \
            + int(suited and f'{tile[0]}{int(tile[1]) + 1}' in hand)
        return same * 4 + neighbors * 2 + (0 if suited else 6), index

    return min(choices, key=shape) if choices else {'kind': 'pass'}


def blood_flow_ai_actions(view: dict, config: BloodFlowAiConfig = BLOOD_FLOW_AI,
                          defense: Optional[dict] = None) -> list[dict]:
    """血流合法/锁手动作的候选层（对齐前端 ``bloodFlowAiActions(view, config, defense)``）。

    只适配血流合法/锁手动作；牌型策略属于 lotus_ai。``defense`` 为调用方已算过的政策
    （避免一次决策里重复算全手牌型 / 听口）。兜牌硬约束在此收窄候选，引擎与 LLM 共用同一份。
    """
    if view['public']['seats'][view['seat']]['locked']:
        return [dict(a) for a in (view.get('ownActions') or [])]
    legal = _legal_actions(view)
    return _apply_defense_constraint(view, _drop_dominated_peng(legal), config, defense)


def _is_final_self_draw_win(view: dict) -> bool:
    window = view.get('window') or {}
    source = window.get('source') or {}
    return (view.get('wallCount', 0) <= 0 and window.get('kind') == 'turn'
            and source.get('kind') == 'draw' and source.get('seat') == view.get('seat')
            and any(action.get('kind') == 'win' for action in view.get('ownActions') or []))


def narrow_routes_for_bot(view: dict, actions: list[dict],
                          config: BloodFlowAiConfig = BLOOD_FLOW_AI) -> dict:
    """Apply the route commitment only to profiles configured for ordinary bots."""
    route_config = config.big_hand_route
    if _is_final_self_draw_win(view) or route_config.mode not in ('bot', 'all'):
        return {'route': None, 'actions': actions, 'collapsed': False}
    seat = view['seat']
    player = view['players'][seat]
    opponents = [p.get('score', 0) for p in view.get('players', []) if p.get('seat') != seat]
    top_score = max(opponents, default=player.get('score', 0))
    source = ((view.get('window') or {}).get('source') or {})
    plan = narrow_actions_to_route(
        player.get('hand') or [], player.get('melds') or [], view.get('jokers') or [], actions,
        config=route_config, base_points=BLOOD_FLOW_CONFIG.base_points,
        immediate_win_payment=(view.get('ownScore') or {}).get('paymentPerPayer', 0),
        wall_count=view.get('wallCount'),
        score_deficit=max(0, top_score - player.get('score', 0)),
        claimed_tile=source.get('tile') if source.get('kind') == 'discard' else None,
    )
    if (config.route_opportunity_guard and plan['collapsed']
            and not view['public']['seats'][seat]['locked']
            and (view.get('window') or {}).get('kind') == 'turn'
            and source.get('kind') == 'draw'
            and any(action.get('kind') == 'win' for action in actions)
            and not any(action.get('kind') == 'win' for action in plan['actions'])):
        wildcards = {*view.get('jokers', []), 'white'}
        held = sum(tile in wildcards for tile in player.get('hand') or [])
        wall_floor = (route_config.min_wall_for_commit_with_jokers
                      if held >= route_config.joker_relief_count
                      else route_config.min_wall_for_commit)
        if view.get('wallCount', 0) < wall_floor:
            return {**plan, 'actions': actions, 'collapsed': False}
    return plan


def kong_evaluator_for(config: BloodFlowAiConfig = BLOOD_FLOW_AI):
    """开杠价值钩子（第 3 步）：注入给 lotus_ai 的 decide_turn / decide_claim（对齐前端 kongEvaluatorFor）。

    ``kong_value.mode == 'off'`` 时返回 None → 回退旧口径（能杠必杠 + 已听牌才放弃）。
    """
    kong_config: KongValueConfig = getattr(config, 'kong_value', None) or BLOOD_FLOW_KONG_VALUE
    if kong_config.mode == 'off':
        return None

    def evaluate(context: dict) -> dict:
        return kong_candidate_value(
            kind=context.get('kind'), hand=list(context.get('hand') or []),
            melds=list(context.get('melds') or []), jokers=list(context.get('jokers') or []),
            tile=context.get('tile'), meld_index=context.get('meldIndex'),
            public_tiles=list(context.get('publicTiles') or []), config=kong_config)

    return evaluate


def _drop_dominated_peng(actions: list[dict]) -> list[dict]:
    """能大明杠时不给"碰"候选（对齐前端 ``dropDominatedPeng``）。

    响应别人弃牌时手上必然是 3 张（第四张在弃牌里）：碰会拆成"副露 2 张 + 手里 1 张死牌"，
    杠是同一副露 + 杠分 + 补牌机会且不可被抢，所以杠严格优于碰。修的是"本来能开大明杠、
    结果碰牌 + 打出要碰的牌"（LLM 座位；本地 AI 本来就是能杠必杠）。
    """
    if not any(action.get('kind') == 'gang' for action in actions):
        return actions
    return [action for action in actions if action.get('kind') != 'peng']


def preferred_any_wait_kong(view: dict, actions: list[dict]) -> Optional[dict]:
    """只用本座可见牌，比较任意听开杠的常规收益与补牌杠开收益。"""
    from .kong_value import post_kong_state
    window = view.get('window') or {}
    source = window.get('source') or {}
    if window.get('kind') != 'turn' or source.get('kind') != 'draw' or view.get('wallCount', 0) <= 0:
        return None
    actions = [a for a in actions if a['kind'] in ('concealed-kong', 'wind-kong')]
    if not actions:
        return None
    player = view['players'][view['seat']]
    hand, melds, jokers = player['hand'], player['melds'], view['jokers']
    before = [tile for index, tile in enumerate(hand) if index != player.get('drawnTileIndex', -1)]
    counts = [(tile, count) for tile, count in unseen_counts(_exposure_visible_tiles(view)) if count > 0]
    unseen = sum(count for _, count in counts)
    if not unseen:
        return None
    current = view.get('ownScore') if any(a['kind'] == 'win' for a in view.get('ownActions', [])) else None
    immediate = (current or {}).get('paymentPerPayer', 0) * 3
    normal = forecast_win_income(before, melds, jokers, source['tile'], 'self-draw') if current else 0
    best, best_income = None, float('-inf')
    for action in actions:
        kind = action['kind']
        if kind not in ('concealed-kong', 'wind-kong'):
            continue
        post = post_kong_state(kind, hand, melds, action.get('tile'))
        if post is None:
            continue
        owned = [*post['hand'], *[tile for meld in post['melds'] for tile in meld['tiles']]]
        waits = waiting_tiles_cached(post['hand'], len(post['melds']), jokers)
        if not waits or not all(tile in waits or owned.count(tile) >= 4 for tile in TILE_TYPES):
            continue
        bloom, safe = 0.0, True
        for tile, count in counts:
            after = forecast_win_income(post['hand'], post['melds'], jokers, tile, 'self-draw')
            replacement = forecast_win_income(post['hand'], post['melds'], jokers, tile, 'kong-bloom')
            baseline = max(normal, forecast_win_income(before, melds, jokers, tile, 'self-draw'))
            if not replacement or (view['wallCount'] > 1 and after < baseline):
                safe = False
                break
            bloom += count / unseen * replacement
        if not safe:
            continue
        payment = 'wind' if kind == 'wind-kong' else 'concealed'
        income = bloom + BLOOD_FLOW_CONFIG.base_points * BLOOD_FLOW_CONFIG.kong_payments[payment] * 3
        if income >= immediate and income > best_income:
            best, best_income = action, income
    return best


def decide_blood_flow_action_ev(view: dict, config: BloodFlowAiConfig = BLOOD_FLOW_AI) -> Optional[dict]:
    # 政策一次决策只算一遍；候选构造与兜牌分支共用（硬约束下候选必须用同一份 config）。
    defense = None if config.defense.mode == 'off' else blood_flow_defense_policy(view, config)
    legal = blood_flow_ai_actions(view, config, defense)
    bloom = preferred_any_wait_kong(view, legal)
    if bloom:
        return bloom
    route_plan = narrow_routes_for_bot(view, legal, config)
    moves = route_plan['actions']
    if not moves:
        return None
    if len(moves) == 1:
        return moves[0]
    seat = view['seat']
    locked = view['public']['seats'][seat]['locked']
    win = next((a for a in moves if a['kind'] == 'win'), None)
    if locked:
        return win or next((a for a in moves if a['kind'] == 'pass'), None) or moves[0]

    hand = view['players'][seat].get('hand') or []
    melds = view['players'][seat].get('melds') or []
    jokers = list(view.get('jokers') or [])
    visible = _exposure_visible_tiles(view)
    discards = [a for a in moves if a['kind'] == 'discard']
    wall_count = view.get('wallCount', 0)
    upper_seat = (seat + 3) % len(view['players'])
    upper_discards = view['players'][upper_seat].get('discards') or []
    extras = {
        'melds': melds,
        'patternBonus': lambda tiles, current_melds: pattern_potential_ev(
            tiles, current_melds, jokers, wall_count, config.seven_pairs_model, config),
        # 放炮成本用含本家暗手的可见牌口径（前端 visibleTiles 等价物）。
        'safetyExposure': blood_flow_safety_exposure(view, config, _exposure_visible_tiles(view)),
        # 开杠价值（第 3 步）：lotus_ai 的 decide_turn / decide_claim 用它给杠候选计分。
        'kongEvaluator': kong_evaluator_for(config),
    }
    context = {
        'hand': hand, 'jokers': jokers, 'exposedMelds': len(melds),
        'visibleTiles': visible, 'wallCount': wall_count,
        'upperLastDiscard': upper_discards[-1] if upper_discards else None,
        'earlyRound': len(view['players'][seat].get('discards') or []) < 2,
        'publicTiles': _visible_tiles(view),
    }

    def offered(action: dict) -> Optional[dict]:
        return next((a for a in moves if a == action), None)

    def decide_discard() -> Optional[dict]:
        try:
            turn_view = {**context, 'melds': melds, 'kongBloom': False, **extras}
            decision = lotus_decide_turn(turn_view, jokers)
            if decision['kind'] == 'discard':
                action = {'kind': 'discard', 'index': decision['handIndex']}
            elif decision['kind'] == 'added-kong':
                action = {'kind': 'added-kong', 'meldIndex': decision['meldIndex']}
            else:
                action = dict(decision)
            return offered(action) or _fallback_discard(hand, jokers, discards)
        except Exception:
            return _fallback_discard(hand, jokers, discards)

    def decide_claim_turn() -> Optional[dict]:
        pass_action = next((a for a in moves if a['kind'] == 'pass'), None)
        window = view.get('window') or {}
        source = window.get('source') or {}
        if source.get('kind') != 'discard':
            return pass_action
        try:
            claim_view = {
                **context, **extras,
                'tile': source['tile'], 'from': source.get('seat', 0),
                'canGang': any(a['kind'] == 'gang' for a in moves),
                'canPeng': any(a['kind'] == 'peng' for a in moves),
                'chiOptions': [a for a in moves if a['kind'] == 'chi'],
                'claimMeldProjection': config.claim_meld_projection,
                'claimReadyNetGuard': config.claim_ready_net_guard,
            }
            decision = lotus_decide_claim(claim_view)
            if decision['kind'] == 'chi':
                action = {'kind': 'chi', 'tiles': decision['meld']['tiles']}
            else:
                action = dict(decision)
            return offered(action) or pass_action
        except Exception:
            return pass_action

    if win:
        if _is_final_self_draw_win(view):
            return win
        ctx = blood_flow_ev_context(view, config)
        window = view.get('window') or {}
        source = window.get('source') or {}
        drawn_index = view['players'][seat].get('drawnTileIndex', -1)
        # 自摸窗口：改张优先于门槛，再决定胡或继续发育。
        if window.get('kind') == 'turn' and source.get('kind') == 'draw' and drawn_index >= 0:
            best = next((c for c in ctx['reformCandidates']
                         if any(d['index'] == c['index'] for d in discards)), None)
            if best and best['ev'] >= ctx['winEv'] * config.reform_gain_ratio:
                return next(d for d in discards if d['index'] == best['index']) or win
            below_floor = bool(view.get('ownScore')
                               and view['ownScore']['paymentPerPayer'] < ctx['floor'])
            if below_floor and ctx['potentialTotal'] >= config.potential_floor:
                return decide_discard() or next((a for a in moves if a['kind'] == 'pass'), None) or win
            return win
        # 抢杠窗口：胡 / 过的贪婪比较。
        if window.get('kind') != 'turn' and source.get('kind') == 'added-kong':
            rob = ctx['robEv']
            if rob and rob['winEv'] >= rob['passEv']:
                return win
            return next((a for a in moves if a['kind'] == 'pass'), None) or win
        # 点炮窗口：低于首胡门槛且手牌有潜力 → 不胡。
        if view.get('ownScore') and view['ownScore']['paymentPerPayer'] < ctx['floor'] \
                and ctx['potentialTotal'] >= config.potential_floor:
            return decide_claim_turn() or next((a for a in moves if a['kind'] == 'pass'), None) or win
        return win

    if discards:
        # 兜/弃政策（v3）：对手已做成十六倍级大牌、本家未听牌且可达听口过窄 → 弃胡，改打最小赔付张。
        # 有胡的窗口在前面就返回了，所以这里不会「放过已经能胡的牌」。
        if defense and defense['result'].mode == 'fold':
            exposure = extras['safetyExposure']
            return sorted(discards, key=lambda a: (exposure(hand[a['index']]), a['index']))[0]
        return decide_discard()
    # 兜牌模式下停吃碰杠（不给自己制造必须打危险张的局面）。
    if defense and defense['result'].mode == 'fold':
        return next((a for a in moves if a['kind'] == 'pass'), None) or moves[0]
    return decide_claim_turn()


def blood_flow_llm_safeguard(view: dict, config: BloodFlowAiConfig) -> Optional[dict]:
    """Return a proven local choice before asking a model, using only this seat's view."""
    seat = view['seat']
    actions = view.get('ownActions') or []
    score = view.get('ownScore') or {}
    win = next((action for action in actions if action.get('kind') == 'win'), None)
    if (_is_final_self_draw_win(view) and score.get('paymentPerPayer', 0) > 0
            and all(action.get('kind') in ('win', 'pass', 'discard') for action in actions)):
        return {'action': win, 'reason': 'terminal-self-draw'}
    if not config.win_opportunity_guards or view['public']['seats'][seat]['locked'] or not score:
        return None
    if win is None or not any(action.get('kind') == 'win'
                              for action in blood_flow_ai_actions(view, config)):
        return None
    if _is_last_opportunity_ron(view, config):
        return {'action': win, 'reason': 'last-ron-opportunity'}

    window = view.get('window') or {}
    source = window.get('source') or {}
    player = view['players'][seat]
    drawn_index = player.get('drawnTileIndex', -1)
    if (window.get('kind') != 'turn' or source.get('kind') != 'draw'
            or source.get('seat') != seat or drawn_index < 0
            or own_draw_opportunities(view.get('wallCount', 0), config.chain_horizon, 4) < 2):
        return None
    recommended = decide_blood_flow_action_ev(view, config)
    if (recommended is None or recommended.get('kind') != 'discard'
            or recommended['index'] == drawn_index):
        return None
    hand = player.get('hand') or []
    if not 0 <= recommended['index'] < len(hand):
        return None
    visible = _exposure_visible_tiles(view)
    risk = blood_flow_safety_exposure(view, config, visible)(hand[recommended['index']])
    if risk > config.safety_cost_none:
        return None
    melds = player.get('melds') or []
    jokers = view.get('jokers') or []
    locked_hand = [tile for index, tile in enumerate(hand) if index != drawn_index]
    reformed = [tile for index, tile in enumerate(hand) if index != recommended['index']]
    before = [forecast_win_income(locked_hand, melds, jokers, tile, 'self-draw')
              for tile in TILE_TYPES]
    after = [forecast_win_income(reformed, melds, jokers, tile, 'self-draw')
             for tile in TILE_TYPES]
    if not all(value > 0 for value in after) or all(value > 0 for value in before) \
            or any(value < previous for value, previous in zip(after, before)):
        return None
    wall_count = view.get('wallCount', 0)
    future = lambda tiles: forecast_self_draw_income(
        tiles, melds, jokers, visible, wall_count, config.chain_horizon, 4)
    take_win = score['paymentPerPayer'] * 3 + future(locked_hand)
    reform = future(reformed) - risk
    if reform < take_win * config.reform_gain_ratio \
            or reform - take_win < BLOOD_FLOW_CONFIG.base_points:
        return None
    return {'action': recommended, 'reason': 'verified-any-wait-reform'}
