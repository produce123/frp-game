"""血流数据类型 —— 对应 src/game/variants/lotus/patterns/types.ts 与 bloodFlow/types.ts。"""

from dataclasses import dataclass, field
from typing import Literal, Optional

from app.models.game import TileType

RegularPatternId = Literal[
    'pure-suit', 'mixed-suit', 'all-triplets',
    'little-three-dragons', 'big-three-dragons',
    'little-four-winds', 'big-four-winds', 'nine-gates',
    'all-green', 'pure-terminals', 'mixed-terminals',
    'three-concealed-triplets', 'four-concealed-triplets',
    'all-honors', 'three-kongs', 'four-kongs',
    # 2026-09-12 第二版番种表新增：路线牌型（数牌/刻子/幺九三条路线）
    # 门清：**仅标准四面子一将型生效**（特殊结构不计）
    'all-simples', 'concealed-hand', 'all-with-terminals',
    'one-suit-three-steps', 'one-suit-four-steps', 'pure-straight',
    'one-suit-three-joints', 'one-suit-four-joints',
]
SpecialPatternId = Literal['pinghu', 'sevenPairs', 'luxury-seven-pairs', 'shiSanLan', 'qiXing', 'thirteenOrphans']
PatternId = str  # 保持宽松以便共享夹具 JSON 直接使用
HandShape = Literal['standard', 'sevenPairs', 'shiSanLan', 'qiXing', 'thirteenOrphans']
WinSource = Literal['discard', 'self-draw', 'robbed-kong', 'kong-bloom']


@dataclass(frozen=True)
class PatternDefinition:
    id: str
    label: str
    weight: int
    excludes: tuple[str, ...] = ()


@dataclass(frozen=True)
class TileAssignment:
    input_index: int
    physical: TileType
    represented: TileType


@dataclass(frozen=True)
class DecomposedGroup:
    kind: Literal['pair', 'sequence', 'triplet', 'kong', 'wind-kong']
    tiles: tuple[TileType, ...]
    concealed: bool
    # origin: {'kind': 'hand', 'inputIndexes': [...]} | {'kind': 'meld', 'meldIndex': int}
    origin: dict


@dataclass(frozen=True)
class WinningDecomposition:
    shape: HandShape
    groups: tuple[DecomposedGroup, ...]
    assignments: tuple[TileAssignment, ...]
    winning_tile_group_index: Optional[int]
    natural: bool


@dataclass(frozen=True)
class KongCounts:
    """杠加成统计 —— 对应 patterns/score.ts 的 KongCounts。

    风杠（字牌杠，`kind == 'wind-kong'`）单列；其余按是否暗成区分明杠 / 暗杠。
    """
    exposed: int = 0
    concealed: int = 0
    wind: int = 0


@dataclass(frozen=True)
class ScoringItem:
    id: str
    label: str
    weight: int


@dataclass(frozen=True)
class ExcludedPattern:
    id: str
    included_by: str


@dataclass(frozen=True)
class WinEvaluationInput:
    """concealed 不含胡牌张；外部胡时 winning_tile 失去万能身份。"""
    concealed: tuple[TileType, ...]
    melds: tuple[dict, ...]
    winning_tile: TileType
    source: WinSource
    jokers: tuple[TileType, ...]
    opening: Optional[Literal['heaven', 'earth']]


@dataclass(frozen=True)
class PublicWinScore:
    items: tuple[ScoringItem, ...]
    excluded: tuple[ExcludedPattern, ...]
    hard_win: bool
    source: WinSource
    opening: Optional[Literal['heaven', 'earth']]
    pattern_multiplier: int
    event_multiplier: int
    opening_applied: bool
    uncapped_multiplier: int
    final_multiplier: int
    capped: bool
    payment_per_payer: int
    # 杠加成（明杠 +1 / 暗杠·风杠 +2 每个，2026-09-12 新增），已计入 pattern_multiplier。
    # 末位给默认值：保持可选，不破坏既有构造点。
    kong_bonus: int = 0
    # 支付减半（2026-09-15 新增）：只有鸡胡（0.5 番）时为 True；倍率保持整数，"半番"落在点数上。
    half_payment: bool = False


@dataclass(frozen=True)
class WinEvaluation:
    rule_version: str
    decomposition: WinningDecomposition
    natural_evidence: dict
    score: PublicWinScore


@dataclass(frozen=True)
class SourceTileEvent:
    id: str
    tile: TileType
    seat: int
    kind: Literal['draw', 'discard', 'added-kong']
