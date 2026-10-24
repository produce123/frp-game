"""玩家控制器 —— 从 src/game/playerController.ts 翻译

PlayerController 接口 + AIPlayer 实现。「人类 vs AI 解耦」的关键抽象：
useGame 的 HumanController 在联网版中被 RemotePlayer 替代（Phase 5 接入 WebSocket）。

- TurnContext / ClaimContext / RobKongContext → Pydantic 模型（服务端→客户端的状态快照）
- TurnAction / ClaimAction / RobKongAction → 客户端→服务端的动作指令（dict，网络协议）
- AIPlayer：复用 core/ai.py，request_* 去掉思考延迟、直接决策（延迟可配置为 0 以加速模拟）
"""

import asyncio
from typing import Optional, Protocol

from pydantic import BaseModel, Field

from app.models.game import Meld, TileType
from app.core.actions import remove_matches
from app.core.kong_projection import project_kong_bloom
from app.core.ai import choose_discard_index, decide_claim, decide_rob_kong, decide_turn
from app.rules.base import GameRuleSet
from app.rules.lianhua import get_default_rule_set


# ─── 上下文（服务端 → 控制器 / 客户端的只读快照）──────────────

class TurnContext(BaseModel):
    """回合决策上下文"""
    hand: list[TileType]
    playerIndex: int = -1
    melds: list[Meld]
    exposedMelds: int
    kongBloom: bool
    skipDraw: bool
    afterKong: bool
    turnOrigin: str = 'draw'
    drawnTile: Optional[TileType] = None
    jokers: list[TileType] = Field(default_factory=list)
    canHu: bool = False
    canWindKong: bool = False
    # lotus-legacy 策略 AI 需要的可见牌/安全度上下文
    visibleTiles: list[TileType] = Field(default_factory=list)
    publicTiles: list[TileType] = Field(default_factory=list)
    upperLastDiscard: Optional[TileType] = None
    earlyRound: bool = False
    wallCount: int = 0
    # ── v1.1 LLM 局况/版本（可选；现有控制器忽略）──
    scores: list[int] = Field(default_factory=list)
    peers: list = Field(default_factory=list)
    seatWind: str = ''
    roundWind: str = ''
    dealerIndex: int = -1
    roundIndex: int = 0
    dihu: bool = False
    requestId: str = ''
    stateVersion: str = ''


class ClaimContext(BaseModel):
    """吃碰杠响应上下文"""
    hand: list[TileType]
    playerIndex: int = -1
    canGang: bool
    canHu: bool = False
    canPeng: bool = False
    chiOptions: list[dict] = Field(default_factory=list)
    tile: TileType
    from_: int = Field(alias='from')
    exposedMelds: int = 0
    jokers: list[TileType] = Field(default_factory=list)
    # lotus-legacy 策略 AI 需要的可见牌/安全度上下文
    visibleTiles: list[TileType] = Field(default_factory=list)
    publicTiles: list[TileType] = Field(default_factory=list)
    upperLastDiscard: Optional[TileType] = None
    earlyRound: bool = False
    wallCount: int = 0
    # ── v1.1 LLM 局况/版本（可选）──
    scores: list[int] = Field(default_factory=list)
    peers: list = Field(default_factory=list)
    seatWind: str = ''
    roundWind: str = ''
    dealerIndex: int = -1
    roundIndex: int = 0
    dihu: bool = False
    requestId: str = ''
    stateVersion: str = ''
    model_config = {'populate_by_name': True}


class RobKongContext(BaseModel):
    """抢杠响应上下文"""
    tile: TileType
    from_: int = Field(alias='from')
    hand: list[TileType]
    exposedMelds: int
    model_config = {'populate_by_name': True}


# ─── PlayerController 协议 ─────────────────────────────────

class PlayerController(Protocol):
    """控制器接口：GameManager 只依赖此接口，不区分人类/AI。"""

    async def request_turn(self, ctx: TurnContext) -> dict: ...
    async def request_claim(self, ctx: ClaimContext) -> dict: ...
    async def request_rob_kong(self, ctx: RobKongContext) -> str: ...
    def on_discarded(self) -> None: ...
    def reset(self) -> None: ...


# ─── AI 控制器 ─────────────────────────────────────────────

# 对齐前端 src/game/playerController.ts 的 AI_DELAYS（人类正常思考速度）：
# 真人联机房间的 AI 摸牌/出牌（turn 650ms）、杠后补摸再决策（after_kong 550ms）、
# 吃碰杠响应（claim 500ms）都保持与本地 AI 一致的节奏，避免 AI 瞬移显得机械。
# 测试路径默认不注入（AIPlayer 默认全 0），保持即用即答。
AI_DELAYS = {'turn': 650, 'after_kong': 550, 'claim': 500}


def _map_turn_decision(decision: dict) -> dict:
    """把 ai.py 的 TurnDecision 映射为控制器层 TurnAction（语义一致）。"""
    kind = decision['kind']
    if kind == 'win':
        return {'kind': 'win'}
    if kind == 'added-kong':
        return {'kind': 'added-kong', 'meldIndex': decision['meldIndex']}
    if kind == 'concealed-kong':
        return {'kind': 'concealed-kong', 'tile': decision['tile']}
    if kind == 'wind-kong':
        return {'kind': 'wind-kong'}
    return {'kind': 'discard', 'handIndex': decision['handIndex']}


class AIPlayer:
    """AI 玩家控制器：封装 AI 决策的时序编排与纯函数调用。"""

    def __init__(self, delays: Optional[dict] = None, random=None,
                 rule_set: Optional[GameRuleSet] = None):
        self.delays = delays or {'turn': 0, 'after_kong': 0, 'claim': 0}
        self._random = random
        self.rules = rule_set or get_default_rule_set()

    def set_rule_set(self, rule_set: GameRuleSet) -> None:
        self.rules = rule_set

    async def request_turn(self, ctx: TurnContext) -> dict:
        ms = self.delays['after_kong'] if ctx.afterKong else self.delays['turn']
        if ms:
            await asyncio.sleep(ms / 1000)
        view = {
            'hand': list(ctx.hand),
            'melds': ctx.melds,
            'exposedMelds': ctx.exposedMelds,
            'kongBloom': ctx.kongBloom,
            'jokers': list(ctx.jokers),
            'visibleTiles': list(ctx.visibleTiles),
            'publicTiles': list(ctx.publicTiles),
            'peers': list(ctx.peers),
            'playerIndex': ctx.playerIndex,
            'wallCount': ctx.wallCount,
            '_random': self._random,
        }
        if self.rules.code == 'lotus-legacy':
            view.update({
                'visibleTiles': list(ctx.visibleTiles),
                'publicTiles': list(ctx.publicTiles),
                'upperLastDiscard': ctx.upperLastDiscard,
                'earlyRound': ctx.earlyRound,
                'wallCount': ctx.wallCount,
            })
        # 碰/吃后没有摸牌：暗手即使碰巧成胡，也只能弃牌。庄家开局跳摸
        # 已持 14 张牌，turnOrigin=opening 仍保留正常自摸/杠判断。
        if ctx.skipDraw and ctx.turnOrigin != 'opening':
            if self.rules.code == 'lotus-legacy':
                from app.core.lotus_ai import choose_discard_index as lotus_choose_discard_index
                index = lotus_choose_discard_index(
                    view['hand'], view['jokers'], random=self._random,
                    options={
                        'exposedMelds': ctx.exposedMelds,
                        'visibleTiles': view['visibleTiles'],
                        'publicTiles': view['publicTiles'],
                        'upperLastDiscard': ctx.upperLastDiscard,
                        'earlyRound': ctx.earlyRound,
                        'wallCount': ctx.wallCount,
                        'melds': view['melds'],
                    })
            else:
                index = choose_discard_index(
                    view['hand'], self._random, self.rules, ctx.exposedMelds,
                    context=view)
            return {'kind': 'discard', 'handIndex': index}
        return _map_turn_decision(decide_turn(view, self.rules))

    async def request_claim(self, ctx: ClaimContext) -> dict:
        ms = self.delays['claim']
        if ms:
            await asyncio.sleep(ms / 1000)
        if self.rules.code == 'lotus-legacy' and ctx.canGang:
            jokers = list(ctx.jokers or getattr(self.rules.round_state, 'jokers', []))
            if project_kong_bloom(
                    kind='discard-gang', hand=ctx.hand,
                    exposed_melds=ctx.exposedMelds, jokers=jokers, tile=ctx.tile,
                    visible_tiles=ctx.visibleTiles).guaranteed_kong_bloom:
                return {'kind': 'gang'}
        if ctx.canHu:
            return {'kind': 'win'}
        if self.rules.code == 'lotus-legacy':
            return self._request_lotus_claim(ctx)
        decision = decide_claim({
            'hand': list(ctx.hand),
            'canGang': ctx.canGang,
            'canPeng': ctx.canPeng,
            'tile': ctx.tile,
            'exposedMelds': ctx.exposedMelds,
            'visibleTiles': list(ctx.visibleTiles),
            'publicTiles': list(ctx.publicTiles),
            'peers': list(ctx.peers),
            'playerIndex': ctx.playerIndex,
            'wallCount': ctx.wallCount,
        }, self.rules)
        if decision == 'gang':
            return {'kind': 'gang'}
        if decision == 'peng':
            # 预计算碰后弃牌索引，实现 AI 的单次碰+出牌闭环
            after_peng = remove_matches(list(ctx.hand), ctx.tile, 2)
            if not after_peng:
                # 碰后无牌可打（手牌恰好只剩这 2 张）：真实规则下不能碰，
                # 否则出牌阶段手牌为空导致对局停滞。
                return {'kind': 'pass'}
            discard_index = choose_discard_index(
                after_peng, self._random, self.rules, ctx.exposedMelds + 1,
                context={
                    'visibleTiles': list(ctx.visibleTiles), 'publicTiles': list(ctx.publicTiles),
                    'peers': list(ctx.peers), 'wallCount': ctx.wallCount,
                    'playerIndex': ctx.playerIndex,
                })
            return {'kind': 'peng', 'discardIndex': discard_index}
        return {'kind': 'pass'}

    def _request_lotus_claim(self, ctx: ClaimContext) -> dict:
        """莲花麻将副露决策：能杠必杠；碰/吃按听牌质量与现状比较，不提升则 pass。"""
        from app.core.lotus_ai import decide_claim as lotus_decide_claim
        decision = lotus_decide_claim({
            'hand': list(ctx.hand),
            'exposedMelds': ctx.exposedMelds,
            'jokers': list(ctx.jokers),
            'tile': ctx.tile,
            'canGang': ctx.canGang,
            'canPeng': ctx.canPeng,
            'chiOptions': ctx.chiOptions,
            'visibleTiles': list(ctx.visibleTiles),
            'publicTiles': list(ctx.publicTiles),
            'upperLastDiscard': ctx.upperLastDiscard,
            'earlyRound': ctx.earlyRound,
            'wallCount': ctx.wallCount,
        })
        if decision['kind'] == 'gang':
            return {'kind': 'gang'}
        if decision['kind'] == 'peng':
            return {'kind': 'peng', 'discardIndex': decision['discardIndex']}
        if decision['kind'] == 'chi':
            for index, option in enumerate(ctx.chiOptions):
                if option is decision['meld']:
                    return {'kind': 'chi', 'optionIndex': index}
            return {'kind': 'pass'}
        return {'kind': 'pass'}

    async def request_rob_kong(self, ctx: RobKongContext) -> str:
        # 抢杠决策无需额外延迟
        return decide_rob_kong({
            'hand': list(ctx.hand),
            'exposedMelds': ctx.exposedMelds,
            'tile': ctx.tile,
            'from': ctx.from_,
        })

    def on_discarded(self) -> None:
        pass

    def reset(self) -> None:
        pass


# ─── 人类远程玩家（Phase 5 实现于 remote_player.py）────────

# RemotePlayer 已随 Phase 5 迁移到 app/game/remote_player.py（接入 WebSocket 通道，
# 含超时代打 / 断线托管 / 重连归还）。这里延迟导入并重导出，保持 `from
# app.game.player import RemotePlayer` 兼容。底部导入避免与 remote_player 的
# 上行 import 形成循环。
try:
    from app.game.remote_player import RemotePlayer  # noqa: E402,F401
except ImportError:  # pragma: no cover - 仅当 remote_player 尚未实现时
    pass
