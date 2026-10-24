"""数据模型 —— 从 src/game/types.ts 翻译为 Pydantic 模型

所有类型与 TS 端保持精确对应，用于：
- 网络协议序列化/反序列化
- 服务端内部状态管理
- API 请求/响应校验
"""

from typing import Literal, Optional
from pydantic import BaseModel, Field

# ─── 牌类型 ───────────────────────────────────────────────

Suit = Literal['m', 'p', 's']
Rank = Literal[1, 2, 3, 4, 5, 6, 7, 8, 9]

# 27 张序数牌（万/筒/条 × 1-9）
SuitedTile = Literal[
    'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9',
    'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9',
    's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9',
]

# 7 张字牌
HonorTile = Literal['east', 'south', 'west', 'north', 'red', 'green', 'white']

# 全部 34 种牌
TileType = Literal[
    'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9',
    'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9',
    's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9',
    'east', 'south', 'west', 'north', 'red', 'green', 'white',
]

# 场次类型
MatchType = Literal['east', 'hanchan']
PlayerKind = Literal['human', 'llm', 'bot']

# ─── 副露 ─────────────────────────────────────────────────

class Meld(BaseModel):
    """副露：碰/杠/暗杠/花杠"""
    type: Literal['peng', 'gang', 'angang', 'flower', 'chi']
    tile: TileType
    tiles: list[TileType]
    from_: Optional[int] = Field(default=None, alias='from')
    added: Optional[bool] = None
    pending: Optional[bool] = None
    windKong: Optional[bool] = None

    model_config = {'populate_by_name': True}


# ─── 玩家状态 ─────────────────────────────────────────────

class GamePlayer(BaseModel):
    """玩家完整状态（用于快照传输）"""
    name: str
    avatar: str
    score: int
    seat: int
    hand: list[TileType]
    discards: list[TileType]
    melds: list[Meld]
    redCount: int
    drawnTileIndex: int
    # llmAnime 表现身份；旧构造方/旧快照不提供时保持兼容。
    characterId: Optional[str] = None
    playerKind: Optional[PlayerKind] = None


# ─── 桌面动作 ─────────────────────────────────────────────

TableActionType = Literal[
    'peng',
    'chi',
    'discard-gang',
    'concealed-gang',
    'added-gang',
    'flower-gang',
    'self-draw',
    'robbed-kong-win',
    'discard-win',
]


class TableActionEvent(BaseModel):
    """桌面动作事件（广播给全房间）"""
    id: int
    type: TableActionType
    actorIndex: int
    sourceIndex: Optional[int] = None
    tile: TileType
    meldIndex: int


# ─── 分数流水 ─────────────────────────────────────────────

class ScoreDelta(BaseModel):
    """单条分数变动"""
    playerIndex: int
    amount: int


class ScoreFlowEvent(BaseModel):
    """分数流水事件（广播给全房间）"""
    id: int
    deltas: list[ScoreDelta]


# ─── 和牌展示 ─────────────────────────────────────────────

class WinPresentation(BaseModel):
    """和牌展示信息"""
    winnerIndex: int
    tile: TileType
    sourceIndex: int
    robbedKong: bool
    robbedKongPlayerIndex: int
    robbedKongMeldIndex: int
    discardWin: bool = False


# ─── 结算选项 ─────────────────────────────────────────────

class EndGameOptions(BaseModel):
    """和牌结束选项"""
    winTile: Optional[TileType] = None
    fourRed: Optional[bool] = None
    kongBloom: Optional[bool] = None
    robbedKong: Optional[bool] = None
    robbedKongPlayerIndex: Optional[int] = None
    sourceFrom: Optional[int] = None
    tianhu: Optional[bool] = None
    dihu: Optional[bool] = None
    selfDraw: Optional[bool] = None
    winHand: Optional[list[TileType]] = None
