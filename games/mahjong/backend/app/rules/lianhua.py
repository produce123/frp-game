"""当前莲花广麻规则集。"""

from dataclasses import replace
from functools import lru_cache

from app.core.rules import (
    can_rob_kong as _can_rob_kong,
    concealed_kongs as _concealed_kongs,
    draw_horses as _draw_horses,
    is_winning_hand as _is_winning_hand,
    matching_count as _matching_count,
    waiting_tiles as _waiting_tiles,
)
from app.core.tiles import create_wall
from app.models.game import GamePlayer, Meld, TileType
from app.rules.base import ClaimCapabilities
from app.rules.fans import FanContext, FanEngine, FanEvaluation, PredicateFan


BASE_SCORE = 100


def _build_fan_engine() -> FanEngine:
    return FanEngine([
        PredicateFan(
            code='win_method', label='抢杠胡',
            predicate=lambda ctx: ctx.robbed_kong,
        ),
        PredicateFan(
            code='self_draw', label='自摸',
            predicate=lambda ctx: not ctx.robbed_kong,
        ),
        # 2026-09 用户定案（对齐《江西莲花广麻》文档）：取消庄家倍率；
        # 四红中固定 ×1（摸到即胡，不计自摸/无癞子/杠开），红中改为逐张加算底分。
        PredicateFan(
            code='no_joker', label='无癞子', multiplier=2,
            predicate=lambda ctx: ctx.no_joker,
        ),
        PredicateFan(
            code='four_red', label='四红中', multiplier=1,
            predicate=lambda ctx: ctx.four_red,
            suppresses=frozenset({'self_draw', 'no_joker', 'kong_bloom'}),
        ),
        PredicateFan(
            code='kong_bloom', label='杠上开花', multiplier=2,
            predicate=lambda ctx: ctx.kong_bloom,
        ),
        PredicateFan(
            code='horse', label='',
            predicate=lambda ctx: ctx.horse_hits > 0,
            points=lambda ctx: ctx.horse_hits * BASE_SCORE,
            equivalent_multiplier=lambda ctx: ctx.horse_hits,
        ),
        PredicateFan(
            code='red_bonus', label='',
            predicate=lambda ctx: ctx.red_count > 0,
            points=lambda ctx: ctx.red_count * BASE_SCORE,
            equivalent_multiplier=lambda ctx: ctx.red_count,
        ),
    ], base_score=BASE_SCORE)


class LianhuaGuangmaRuleSet:
    code = 'lianhua_guangma'
    base_score = BASE_SCORE
    horse_count = 8
    supports_chi = False

    def __init__(self, fan_engine: FanEngine | None = None):
        self.fan_engine = fan_engine or _build_fan_engine()

    def create_wall(self) -> list[TileType]:
        return create_wall()

    def is_flower_tile(self, tile: TileType) -> bool:
        return tile == 'red'

    def is_joker_tile(self, tile: TileType) -> bool:
        return tile == 'white'

    def is_claimable_tile(self, tile: TileType) -> bool:
        return not self.is_flower_tile(tile) and not self.is_joker_tile(tile)

    def should_auto_win_on_flowers(self, count: int) -> bool:
        return count >= 4

    def resolve_win_tile(self, winner: GamePlayer, options: dict) -> TileType:
        if options.get('fourRed'):
            return 'red'
        if options.get('winTile'):
            return options['winTile']
        if winner.drawnTileIndex >= 0:
            return winner.hand[winner.drawnTileIndex]
        return winner.hand[-1]

    def is_winning_hand(self, tiles: list[TileType], exposed_meld_count: int = 0) -> bool:
        return _is_winning_hand(tiles, exposed_meld_count)

    def waiting_tiles(self, tiles: list[TileType], exposed_meld_count: int = 0) -> list[TileType]:
        return _waiting_tiles(tiles, exposed_meld_count)

    def matching_count(self, tiles: list[TileType], tile: TileType) -> int:
        return _matching_count(tiles, tile)

    def concealed_kongs(self, tiles: list[TileType]) -> list[TileType]:
        return _concealed_kongs(tiles)

    def can_added_kong(self, hand: list[TileType], melds: list[Meld], tile: TileType) -> bool:
        return tile in hand and any(meld.type == 'peng' and meld.tile == tile for meld in melds)

    def can_rob_kong(self, tiles: list[TileType], tile: TileType,
                     exposed_meld_count: int = 0) -> bool:
        return _can_rob_kong(tiles, tile, exposed_meld_count)

    def claim_capabilities(self, hand: list[TileType], tile: TileType) -> ClaimCapabilities:
        if not self.is_claimable_tile(tile):
            return ClaimCapabilities()
        count = self.matching_count(hand, tile)
        return ClaimCapabilities(can_peng=count >= 2, can_gang=count >= 3)

    def draw_horses(self, wall: list[TileType], amount: int | None = None, seat: int = 0) -> dict:
        return _draw_horses(wall, self.horse_count if amount is None else amount, seat)

    def evaluate_fans(self, context: FanContext) -> FanEvaluation:
        evaluation = self.fan_engine.evaluate(context)
        # 马与红中的展示文字带命中张数；番型定义本身保持无状态。
        if context.horse_hits <= 0 and context.red_count <= 0:
            return evaluation
        hits = tuple(
            replace(hit, label=f'中马 {context.horse_hits} 张')
            if hit.code == 'horse'
            else replace(hit, label=f'红中 {context.red_count} 张')
            if hit.code == 'red_bonus' else hit
            for hit in evaluation.hits
        )
        return replace(evaluation, hits=hits)

    def score_hand(self, context: FanContext) -> dict:
        return self.evaluate_fans(context).to_legacy_dict()


@lru_cache(maxsize=1)
def get_default_rule_set() -> LianhuaGuangmaRuleSet:
    return LianhuaGuangmaRuleSet()
