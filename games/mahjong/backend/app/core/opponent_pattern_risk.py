"""对手牌型（大牌）风险的公共信息估算 —— 档位版。

前端同源实现见 ``src/game/shared/ai/opponentPatternRisk.ts``；本文件是逐位等价的 Python 镜像，
数值、档位规则与信号中文文案（会进入 prompt）必须与 TS 保持一致。

目的：把「点炮给在做大牌的对手」从「与番型无关的常数价格」改成按公共证据分档的价格。
只用公共牌：对手牌河、副露明细、已胡次数 / 锁手、墙余、公开牌池。
严禁读取对手暗手：本模块不接收、不推断任何未公开手牌（bloodFlowSeatView 只向本家暴露 hand）。
纯函数、确定性、无 IO；未提供任何信号时结果与旧口径逐位一致（见 opponent_pattern_exposure）。
"""

from dataclasses import dataclass, field
import re
from typing import Callable, Optional, Sequence

OpponentRiskTier = int          # 0 | 1 | 2 | 3
SuitKey = str                   # 'm' | 'p' | 's'
Tile = str                      # 内部牌面（'m1' / 'east' / 'red' / 'white' …）

_SUIT_TILE = re.compile(r'^([mps])[1-9]$')
# 数牌判定必须自己捕获数字位（前端踩过的坑：只有一个捕获组时 matched[2] 恒为 undefined，
# 所有数牌都会被判成中张、幺九永远判不出；TS 已修成两组捕获，Python 与之一致）。
_NUMBERED_TILE = re.compile(r'^([mps])([1-9])$')
_DRAGONS: tuple[Tile, ...] = ('red', 'green', 'white')
_WINDS: tuple[Tile, ...] = ('east', 'south', 'west', 'north')
_SUIT_ORDER: tuple[SuitKey, ...] = ('m', 'p', 's')
_SUIT_LABELS: dict[SuitKey, str] = {'m': '万', 'p': '筒', 's': '条'}


@dataclass(frozen=True)
class OpponentRiskTuning:
    """风险模块调参（默认值 = 前端 OPPONENT_RISK）。"""

    # 档位倍率：1 = 平胡量级，4/16/32 ≈ 混一色 / 清一色 / 十六倍级硬胡点炮。
    factor_tier1: float = 4
    factor_tier2: float = 16
    factor_tier3: float = 32
    # 染手（花色集中）嫌疑对手：非嫌疑花色牌的系数。
    off_suit_factor: float = 0.5
    # 与既有 safetyCostLadder 一致的基准单价（点）。
    exposure_unit: float = 40
    # 公开张数档位（0 张 / 1 张 / ≥2 张）。
    safety_cost_none: float = 0.25
    safety_cost_one: float = 0.1
    safety_cost_safe: float = 0
    # 锁手家的倍率档（已胡仍在听，现物不再享受折扣）。
    locked_tier: OpponentRiskTier = 2
    # 残局墙余阈值（沿用 BLOOD_FLOW_AI.lateGameWallCount）。
    late_game_wall_count: int = 15
    # 残局提速墙余阈值（原 estimateOpponentThreat 的 24）。
    late_threat_wall_count: int = 24
    # 门清读牌：牌河长度下限（低于此长度不做门清大牌读牌）。
    concealed_river_min: int = 8
    # 字牌/幺九回避：牌河 ≥ concealed_river_min 且字牌+幺九张数 ≤ 该值 → 十三幺 / 字一色 / 混清幺九嫌疑。
    honor_terminal_quiet: int = 1
    # 字牌/幺九为 0 且牌河 ≥ 该长度 → 高倍级（十六倍级）嫌疑。
    honor_terminal_zero_river: int = 10
    # 逐张危险轴：十三幺 / 字一色嫌疑下中张（2-8 数牌）的系数（它们几乎不吃中张）。
    honor_terminal_middle_factor: float = 0.25
    # 十三幺 / 字一色轴上字牌与幺九的公开张数下限：这类牌型每种只需要一张，
    # 「我手里有两张」只降低概率、不等于安全，所以现物折扣不得归零。
    honor_terminal_ladder_floor: float = 0.1
    # 字牌刻子轴（三元 / 四喜 / 字一色）：非字牌数牌的系数（字牌照价）。
    honor_emphasis_number_factor: float = 0.5
    # 已公开番型（axis_source='known'）时，该番型「用不到的那一类牌」的系数。
    # 实测：锁手清一色对手对非本门牌根本不能胡（0 点）、对本门牌 80 点，因此轴外应压到接近 0，
    # 而不是只打五折。注意十三幺轴的轴外牌（中张）仍能以七星十三烂胡 80 点，所以那条轴不用这个系数。
    known_off_axis_factor: float = 0.1
    # 花色回避：牌河 ≥ concealed_river_min 且该花色占比 ≤ 该值 → 九莲 / 门清清一色嫌疑。
    suit_avoid_share: float = 0.1
    # 短牌河兜底：某花色张数 ≤ 该值（占比可能高于 suit_avoid_share）→ 弱信号（v1 灵敏度）。
    # 与前端 OpponentRiskTuning.suitSparseCount 一一对应（TS 是唯一事实来源）。
    suit_sparse_count: int = 1
    # 某花色一张没打且牌河 ≥ 该长度 → 高倍级（十六倍级）嫌疑。
    suit_zero_river: int = 12
    # 七对嫌疑（弱信号）：中张占牌河 ≥ 该比例。
    middle_heavy_share: float = 0.75
    # v3：已公开番型的倍率下限 → 威胁档下限（4 / 8 / 16 对应 tier1 / tier2 / tier3）。
    known_tier1_multiplier: float = 4
    known_tier2_multiplier: float = 8
    known_tier3_multiplier: float = 16
    # 档位 → 中文标签（1/2/3）。
    tier_labels: dict[int, str] = field(
        default_factory=lambda: {1: '低', 2: '中', 3: '高'})


OPPONENT_RISK = OpponentRiskTuning()

# 调参字段名（tuning_of 用；与前端 OpponentRiskTuning 一一对应）。
TUNING_FIELDS: tuple[str, ...] = (
    'factor_tier1', 'factor_tier2', 'factor_tier3', 'off_suit_factor', 'exposure_unit',
    'safety_cost_none', 'safety_cost_one', 'safety_cost_safe', 'locked_tier',
    'late_game_wall_count', 'late_threat_wall_count', 'tier_labels',
    'concealed_river_min', 'honor_terminal_quiet', 'honor_terminal_zero_river',
    'honor_terminal_middle_factor', 'honor_terminal_ladder_floor',
    'honor_emphasis_number_factor', 'known_off_axis_factor',
    'suit_avoid_share', 'suit_sparse_count', 'suit_zero_river', 'middle_heavy_share',
    'known_tier1_multiplier', 'known_tier2_multiplier', 'known_tier3_multiplier',
)

RISK_TIER_LABELS: dict[int, str] = {1: '低', 2: '中', 3: '高'}

# 已公开番型 → 逐张危险轴（与 TS 的 HONOR_TERMINAL_PATTERNS / FLUSH_PATTERNS /
# HONORS_IN_FLUSH / HONOR_EMPHASIS_PATTERNS 逐项一致）。
# 只吃字牌与幺九（十三幺 / 字一色 / 清幺九 / 混幺九）→ 中张便宜。
HONOR_TERMINAL_PATTERNS: frozenset[str] = frozenset(
    ('thirteenOrphans', 'all-honors', 'pure-terminals', 'mixed-terminals'))
# 单花色轴：非嫌疑花色便宜（其中混一色的字牌仍算「本门」）。
FLUSH_PATTERNS: frozenset[str] = frozenset(
    ('pure-suit', 'nine-gates', 'all-green', 'mixed-suit'))
HONORS_IN_FLUSH: frozenset[str] = frozenset(('mixed-suit',))
# 字牌刻子轴：三元 / 四喜 / 字一色一类，字牌才是他要的，普通数牌相对便宜。
HONOR_EMPHASIS_PATTERNS: frozenset[str] = frozenset(
    ('little-three-dragons', 'big-three-dragons', 'little-four-winds',
     'big-four-winds', 'all-honors'))

AxisSource = str                # 'inferred' | 'known'


def tuning_of(partial=None) -> OpponentRiskTuning:
    """部分覆盖 → 完整调参表（前端 ``tuningOf``）。"""
    if not partial:
        return OPPONENT_RISK
    if isinstance(partial, OpponentRiskTuning):
        return partial
    values = {**{name: getattr(OPPONENT_RISK, name) for name in TUNING_FIELDS}, **partial}
    return OpponentRiskTuning(**values)


def suit_of_tile(tile: Tile) -> Optional[SuitKey]:
    matched = _SUIT_TILE.match(tile) if tile else None
    return matched.group(1) if matched else None


def is_terminal_tile(tile: Tile) -> bool:
    """幺九牌（数牌 1/9）。"""
    matched = _NUMBERED_TILE.match(tile) if tile else None
    return bool(matched and matched.group(2) in ('1', '9'))


def is_honor_tile(tile: Tile) -> bool:
    """字牌（风 + 箭）。"""
    return tile in _DRAGONS or tile in _WINDS


def is_middle_tile(tile: Tile) -> bool:
    """中张（数牌 2-8）：十三幺 / 字一色这类牌型几乎不需要它们。"""
    matched = _NUMBERED_TILE.match(tile) if tile else None
    return bool(matched and matched.group(2) not in ('1', '9'))


def _factor_for(tier: OpponentRiskTier, tuning: OpponentRiskTuning) -> float:
    if tier == 3:
        return tuning.factor_tier3
    if tier == 2:
        return tuning.factor_tier2
    if tier == 1:
        return tuning.factor_tier1
    return 1


def _meld_attr(meld, name: str, default=None):
    if isinstance(meld, dict):
        return meld.get(name, default)
    return getattr(meld, name, default)


@dataclass
class MeldFacts:
    groups: int
    suit_counts: dict[SuitKey, int]
    dominant_suit: Optional[SuitKey]
    max_share: float
    dragon_groups: int
    wind_groups: int
    honor_groups: int


def meld_facts(melds: Optional[Sequence]) -> MeldFacts:
    """副露明细统计：组数、花色集中度、箭/风/字成组数（只读公开副露）。"""
    suit_counts: dict[SuitKey, int] = {}
    groups = dragon_groups = wind_groups = honor_groups = 0
    for meld in melds or []:
        if _meld_attr(meld, 'type') == 'flower':
            continue
        tiles = list(_meld_attr(meld, 'tiles', None) or [])
        groups += 1
        tile = _meld_attr(meld, 'tile', None)
        if not tile and tiles:
            tile = tiles[0]
        if tile in _DRAGONS:
            dragon_groups += 1
            honor_groups += 1
            continue
        if tile in _WINDS:
            wind_groups += 1
            honor_groups += 1
            continue
        for item in tiles:
            suit = suit_of_tile(item)
            if suit:
                suit_counts[suit] = suit_counts.get(suit, 0) + 1
    suited_total = sum(suit_counts.values())
    dominant_suit: Optional[SuitKey] = None
    max_count = 0
    for suit, count in suit_counts.items():
        if count > max_count:
            max_count = count
            dominant_suit = suit
    return MeldFacts(
        groups=groups, suit_counts=suit_counts, dominant_suit=dominant_suit,
        max_share=(max_count / suited_total) if suited_total else 0,
        dragon_groups=dragon_groups, wind_groups=wind_groups, honor_groups=honor_groups,
    )


def _suit_discard_counts(discards: Sequence[Tile]) -> dict[SuitKey, int]:
    counts: dict[SuitKey, int] = {}
    for tile in discards or []:
        suit = suit_of_tile(tile)
        if suit:
            counts[suit] = counts.get(suit, 0) + 1
    return counts


def _weakest_suit(counts: dict[SuitKey, int]) -> Optional[SuitKey]:
    weakest: Optional[SuitKey] = None
    least = float('inf')
    for suit in _SUIT_ORDER:
        count = counts.get(suit, 0)
        if count < least:
            least = count
            weakest = suit
    return weakest


@dataclass
class OpponentKnownWin:
    """对手已公开的胡牌番型（来自 PublicWinScore.items + patternMultiplier，玩家视角本就公开）。

    与 TS 的 ``OpponentKnownWin`` 同形；也接受同名字段的 dict（``_known_win_attr`` 读取）。
    """
    id: str
    label: str
    multiplier: float
    tile: Optional[Tile] = None


def _known_win_attr(win, name: str, default=None):
    if isinstance(win, dict):
        return win.get(name, default)
    return getattr(win, name, default)


@dataclass
class OpponentRiskProfile:
    """逐家风险档。``index`` 为传入数组下标；调用方负责映射到座位 / 相对方位。"""
    index: int
    tier: OpponentRiskTier
    factor: float
    signals: list[str]
    suspect_suit: Optional[SuitKey]
    locked: bool
    # 十三幺 / 字一色 / 混清幺九嫌疑：该家几乎不打字牌与幺九 → 中张反而便宜。
    avoids_honor_terminals: bool = False
    # v3 危险轴来源：'inferred' = 由牌河读牌推断（对锁手家不适用，锁手可能是单吊任意听）；
    # 'known' = 由对手已公开番型确定（已公开番型限定了牌型，锁手后同样适用）。
    axis_source: Optional[AxisSource] = None
    # 混一色：字牌也算「本门」，不享受非嫌疑花色折扣。
    honors_in_flush: bool = False
    # 三元 / 四喜 / 字一色一类：字牌照价，普通数牌相对便宜（字牌刻子轴）。
    honor_emphasis: bool = False


def opponent_risk_profiles(opponents: Optional[Sequence[dict]] = None,
                           wall_count: Optional[int] = None,
                           tuning=None) -> list[OpponentRiskProfile]:
    """逐家估算对手牌型风险档。所有信号都来自公共牌；``tier`` 取各项信号的最大值。

    档位含义：1 = 弱信号（门清染手 / 残局快听 / 半染手），2 = 染手或三副露或已锁手仍在听，
    3 = 三元 / 四喜系或十六倍级嫌疑。
    """
    resolved = tuning_of(tuning)
    wall = 99 if wall_count is None else wall_count
    profiles: list[OpponentRiskProfile] = []
    for index, opponent in enumerate(opponents or []):
        facts = meld_facts(_meld_attr(opponent, 'melds', None))
        discards = list(_meld_attr(opponent, 'discards', None) or [])
        signals: list[str] = []
        tier = 0
        suspect_suit: Optional[SuitKey] = None
        avoids_honor_terminals = False

        def raise_tier(next_tier: int, signal: Optional[str] = None) -> None:
            nonlocal tier
            if next_tier > tier:
                tier = next_tier
            if signal:
                signals.append(signal)

        if facts.dragon_groups >= 3:
            raise_tier(3, '副露含三组箭牌')
        elif facts.dragon_groups == 2:
            raise_tier(2, '副露含两组箭牌')
        if facts.wind_groups >= 3:
            raise_tier(3, '副露含三组风牌')
        elif facts.wind_groups == 2:
            raise_tier(2, '副露含两组风牌')
        if facts.honor_groups >= 3:
            raise_tier(2, '副露字牌成组')
        if facts.groups >= 3:
            raise_tier(2, f'副露{facts.groups}组')
        if facts.groups >= 2 and facts.max_share >= 0.75:
            raise_tier(2, '副露染手嫌疑')
            suspect_suit = facts.dominant_suit
        elif facts.groups >= 2 and facts.max_share >= 0.5:
            raise_tier(1, '副露半染手')
            suspect_suit = facts.dominant_suit
        if facts.groups >= 2 and 1 <= len(discards) <= 7 and wall > resolved.late_threat_wall_count:
            raise_tier(1, '副露少牌河快听')
        # 门清大牌读牌（这是 tier3 唯一的来源）：牌河指纹——整局不打字牌/幺九 = 十三幺 / 字一色；
        # 某花色几乎不打 = 九莲 / 门清清一色；牌河几乎全是中张 = 七对弱信号。
        # 顺序必须与 TS 一致（字牌/幺九回避 → 花色回避 → 七对弱信号），signals 会被逐字比对。
        river_length = len(discards)
        if facts.groups == 0 and river_length >= resolved.concealed_river_min:
            honor_terminals = sum(1 for tile in discards
                                  if is_honor_tile(tile) or is_terminal_tile(tile))
            if honor_terminals == 0 and river_length >= resolved.honor_terminal_zero_river:
                raise_tier(3, '牌河零字牌幺九')
                avoids_honor_terminals = True
            elif honor_terminals <= resolved.honor_terminal_quiet:
                raise_tier(2, '牌河无字牌幺九')
                avoids_honor_terminals = True
            counts = _suit_discard_counts(discards)
            weakest = _weakest_suit(counts)
            weakest_count = counts.get(weakest, 0) if weakest else 0
            if weakest and weakest_count == 0 and river_length >= resolved.suit_zero_river:
                raise_tier(3, f'牌河未打{_SUIT_LABELS[weakest]}')
                if suspect_suit is None:
                    suspect_suit = weakest
            elif weakest and weakest_count / river_length <= resolved.suit_avoid_share:
                raise_tier(2, f'牌河几乎未打{_SUIT_LABELS[weakest]}')
                if suspect_suit is None:
                    suspect_suit = weakest
            elif weakest and weakest_count <= resolved.suit_sparse_count:
                # 短牌河（8-11 张）里某花色只有 ≤1 张：占比够不上 tier2，但仍是一档弱信号（v1 灵敏度）。
                raise_tier(1, f'牌河少打{_SUIT_LABELS[weakest]}')
                if suspect_suit is None:
                    suspect_suit = weakest
            middles = sum(1 for tile in discards if is_middle_tile(tile))
            if middles / river_length >= resolved.middle_heavy_share:
                raise_tier(1, '牌河中张密集')
        if wall <= resolved.late_game_wall_count and 1 <= len(discards) <= 7:
            raise_tier(1, '残局少牌河')
        # 已公开番型（比读牌河更确定）：给威胁档设下限，并按牌型选定逐张危险轴。
        # 轴判定顺序必须与 TS 一致：字牌幺九轴 → 花色轴（花色由 tile 的 suit 确定）→ 字牌刻子轴。
        known_wins = list(_meld_attr(opponent, 'knownWins', None) or [])
        axis_source: Optional[AxisSource] = None
        honors_in_flush = False
        honor_emphasis = False
        if known_wins:
            strongest = known_wins[0]
            for win in known_wins:
                if (_known_win_attr(win, 'multiplier', 0) or 0) > \
                        (_known_win_attr(strongest, 'multiplier', 0) or 0):
                    strongest = win
            strongest_multiplier = _known_win_attr(strongest, 'multiplier', 0) or 0
            pattern_tier = 3 if strongest_multiplier >= resolved.known_tier3_multiplier else \
                2 if strongest_multiplier >= resolved.known_tier2_multiplier else \
                1 if strongest_multiplier >= resolved.known_tier1_multiplier else 0
            if pattern_tier > 0:
                raise_tier(pattern_tier, f"已胡{_known_win_attr(strongest, 'label', '')}")
            honor_emphasis = any(_known_win_attr(win, 'id') in HONOR_EMPHASIS_PATTERNS
                                 for win in known_wins)
            if any(_known_win_attr(win, 'id') in HONOR_TERMINAL_PATTERNS for win in known_wins):
                avoids_honor_terminals = True
                axis_source = 'known'
            elif any(_known_win_attr(win, 'id') in FLUSH_PATTERNS for win in known_wins):
                axis_source = 'known'
                honors_in_flush = any(_known_win_attr(win, 'id') in HONORS_IN_FLUSH
                                      for win in known_wins)
                # 哪一门由公开的胡牌牌面确定（比牌河推断可靠）；拿不到就退回牌河推断。
                for win in known_wins:
                    if _known_win_attr(win, 'id') not in FLUSH_PATTERNS:
                        continue
                    tile = _known_win_attr(win, 'tile')
                    flush_suit = suit_of_tile(tile) if tile else None
                    if flush_suit:
                        suspect_suit = flush_suit
                        break
            elif honor_emphasis:
                axis_source = 'known'
        if axis_source is None and (avoids_honor_terminals or suspect_suit is not None):
            axis_source = 'inferred'
        win_count = _meld_attr(opponent, 'winCount', 0) or 0
        locked = bool(_meld_attr(opponent, 'locked', False) and win_count > 0)
        if locked:
            raise_tier(resolved.locked_tier, f'已胡{win_count}次仍听')
        profiles.append(OpponentRiskProfile(
            index=index, tier=tier, factor=_factor_for(tier, resolved),
            signals=list(dict.fromkeys(signals)), suspect_suit=suspect_suit, locked=locked,
            avoids_honor_terminals=avoids_honor_terminals, axis_source=axis_source,
            honors_in_flush=honors_in_flush, honor_emphasis=honor_emphasis,
        ))
    return profiles


def max_opponent_risk_tier(profiles: Optional[Sequence[OpponentRiskProfile]]) -> OpponentRiskTier:
    best = 0
    for profile in profiles or []:
        if profile.tier > best:
            best = profile.tier
    return best


def _visible_counts(visible_tiles: Sequence[Tile]) -> dict[Tile, int]:
    counts: dict[Tile, int] = {}
    for tile in visible_tiles or []:
        counts[tile] = counts.get(tile, 0) + 1
    return counts


def opponent_pattern_exposure(profiles: Optional[Sequence[OpponentRiskProfile]],
                              visible_tiles: Sequence[Tile],
                              tuning=None) -> Callable[[Tile], float]:
    """每张牌的估算点炮赔付（点）。

    口径：一次弃牌最多被一家胡，所以取「权重最高的那一家」的赔付，而不是各家相加
    （相加会把三家都危险的局面高估 3 倍，也会破坏与旧口径的等价性）。

    与旧口径的等价性：无任何信号（全部 tier=0、无锁手）时权重恒为 1，退化为
    ``exposure_unit × ladder(公开张数)``，即改动前 ``safetyExposureFor`` 的逐位相同结果。
    """
    resolved = tuning_of(tuning)
    counts = _visible_counts(visible_tiles)
    active = list(profiles or [])

    def ladder_ratio(tile: Tile) -> float:
        count = counts.get(tile, 0)
        if count >= 2:
            return resolved.safety_cost_safe
        if count == 1:
            return resolved.safety_cost_one
        return resolved.safety_cost_none

    def exposure(tile: Tile) -> float:
        ladder = ladder_ratio(tile)
        if not active:
            return resolved.exposure_unit * ladder
        suit = suit_of_tile(tile)
        middle = is_middle_tile(tile)
        honor = is_honor_tile(tile)
        weight = 1
        chosen: Optional[OpponentRiskProfile] = None
        for profile in active:
            # 危险轴是否可用：'known'（已公开番型）对锁手家同样成立——已公开番型限定了牌型；
            # 'inferred'（读牌河）对锁手家不可用，因为锁手可能是单吊任意听（任何一张都能胡）。
            axis_applies = profile.axis_source == 'known' or not profile.locked
            # 混一色的字牌算「本门」：不享受非嫌疑花色折扣。
            honor_on_off_suit_axis = profile.honors_in_flush and honor
            off_suit = (axis_applies and profile.suspect_suit is not None
                        and suit != profile.suspect_suit and not honor_on_off_suit_axis)
            in_suspect_suit = profile.suspect_suit is not None and suit == profile.suspect_suit
            # 已知番型的轴外牌压到接近 0（实测：锁手清一色对非本门牌 0 点）；推断出来的轴仍只打五折。
            off_axis_factor = (resolved.known_off_axis_factor if profile.axis_source == 'known'
                               else resolved.off_suit_factor)
            tile_factor = off_axis_factor if off_suit else 1
            # 逐张危险轴：十三幺 / 字一色嫌疑下中张几乎不被需要 → 便宜；但嫌疑花色内的中张
            # 照价（九莲要同一花色 1-9）。
            if axis_applies and profile.avoids_honor_terminals and middle and not in_suspect_suit:
                tile_factor *= resolved.honor_terminal_middle_factor
            # 字牌刻子轴（三元 / 四喜 / 字一色）：字牌照价，普通数牌便宜。
            if axis_applies and profile.honor_emphasis and not honor:
                tile_factor *= resolved.honor_emphasis_number_factor
            candidate = profile.factor * tile_factor
            if candidate > weight:
                weight = candidate
                chosen = profile
        # 一次弃牌最多被一家胡：取权重最高的一家的口径。
        chosen_axis = chosen is not None and (chosen.axis_source == 'known' or not chosen.locked)
        if chosen is None:
            ratio = ladder
        elif chosen.locked and chosen.axis_source != 'known':
            # 已锁手的家可能停在单吊任意听：现物折扣不适用。
            ratio = resolved.safety_cost_none
        elif chosen.avoids_honor_terminals and chosen_axis and not middle:
            # 十三幺/字一色轴上字牌与幺九保留下限：多现 ≠ 安全（该牌型每种只要一张）。
            ratio = max(ladder, resolved.honor_terminal_ladder_floor)
        else:
            ratio = ladder
        return resolved.exposure_unit * weight * ratio

    return exposure


@dataclass
class OpponentRiskFeature:
    """该张牌的对手风险特征（供候选特征 / prompt 使用）。"""
    tier: str
    payment: int
    signals: list[str]


def opponent_pattern_feature(profiles: Optional[Sequence[OpponentRiskProfile]],
                             visible_tiles: Sequence[Tile], tile: Tile,
                             tuning=None) -> Optional[OpponentRiskFeature]:
    """该张牌的对手风险特征；无信号返回 None（保持旧形状）。"""
    tier = max_opponent_risk_tier(profiles)
    if tier == 0:
        return None
    top = next((p for p in (profiles or []) if p.tier == tier), None)
    payment = round(opponent_pattern_exposure(profiles, visible_tiles, tuning)(tile))
    signals = list(top.signals[:3]) if top else []
    return OpponentRiskFeature(tier=RISK_TIER_LABELS[tier], payment=int(payment),
                               signals=signals)


def opponent_threat_score(profiles: Optional[Sequence[OpponentRiskProfile]],
                          wall_count: int) -> int:
    """深思门槛口径：把档位换算成 0～100 的公开威胁分（与原 estimateOpponentThreat 同量纲）。"""
    tier = max_opponent_risk_tier(profiles)
    base = 90 if tier == 3 else 70 if tier == 2 else 40 if tier == 1 else 0
    if not base:
        return 0
    late = 10 if wall_count <= OPPONENT_RISK.late_threat_wall_count else 0
    return min(100, base + late)
