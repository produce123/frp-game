"""莲花麻将（旧版翻精规则）规则集。"""

from dataclasses import dataclass

from app.core.lotus_rules import (
    chi_options,
    evaluate_pattern,
    is_winning_hand,
    matching_count,
    waiting_tiles,
)
from app.core.lotus_wall import build_lotus_wall, compute_jokers
from app.core.tiles import TILE_TYPES, create_wall
from app.models.game import GamePlayer, Meld, TileType
from app.rules.base import ClaimCapabilities
from app.rules.fans import FanContext


BASE_SCORE = 100

# 天胡/地胡固定番数：三家各付「底分 × 10」，不计庄家 ×2、不计点炮者 ×2。
OPENING_WIN_FAN = 10


@dataclass
class LotusRoundState:
    flip_tile: TileType | None = None
    joker_tiles: list[TileType] | None = None
    wildcard_tiles: list[TileType] | None = None
    flip_stack: int | None = None
    opening_stack: int | None = None
    wall_break_index: int = 0
    first_dice: list[int] | None = None
    second_dice: list[int] | None = None

    @property
    def jokers(self) -> list[TileType]:
        return self.joker_tiles or []

    @property
    def wildcards(self) -> list[TileType]:
        return self.wildcard_tiles or ['white']


class LotusLegacyRuleSet:
    code = 'lotus-legacy'
    base_score = BASE_SCORE
    horse_count = 0
    supports_chi = True
    supports_flowers = False

    def __init__(self):
        self.round_state = LotusRoundState(wildcard_tiles=['white'])

    def create_wall(self) -> list[TileType]:
        return create_wall()

    def begin_round(self, *, dealer: int, dice: list[int], second_dice: list[int],
                    random=None, ring: list[TileType] | None = None) -> dict:
        result = build_lotus_wall(
            dealer=dealer, dice=dice, second_dice=second_dice,
            random=random, ring=ring,
        )
        self.round_state = LotusRoundState(
            flip_tile=result['flipTile'],
            joker_tiles=result['jokers'],
            wildcard_tiles=['white'],
            flip_stack=result['flipStack'],
            opening_stack=result['openingStack'],
            wall_break_index=result['wallBreakIndex'],
            first_dice=list(dice),
            second_dice=list(second_dice),
        )
        return result

    def is_flower_tile(self, tile: TileType) -> bool:
        return False

    def is_joker_tile(self, tile: TileType) -> bool:
        return tile in self.round_state.jokers

    def is_claimable_tile(self, tile: TileType) -> bool:
        return True

    def should_auto_win_on_flowers(self, count: int) -> bool:
        return False

    def resolve_win_tile(self, winner: GamePlayer, options: dict) -> TileType:
        if options.get('winTile'):
            return options['winTile']
        if winner.drawnTileIndex >= 0:
            return winner.hand[winner.drawnTileIndex]
        return winner.hand[-1]

    def _ordinary_jokers(self, options: dict | None = None) -> list[TileType]:
        tile = (options or {}).get('winTile')
        return [tile] if tile in self.round_state.jokers or tile == 'white' else []

    def is_winning_hand(self, tiles: list[TileType], exposed_meld_count: int = 0,
                        ordinary_jokers: list[TileType] | None = None) -> bool:
        return is_winning_hand(
            tiles, exposed_meld_count, self.round_state.jokers, ordinary_jokers)

    def waiting_tiles(self, tiles: list[TileType], exposed_meld_count: int = 0) -> list[TileType]:
        return waiting_tiles(tiles, exposed_meld_count, self.round_state.jokers)

    def is_any_wait(self, tiles: list[TileType], exposed_meld_count: int = 0) -> bool:
        """听任意：听口覆盖全部 34 种牌（典型形态是单吊精牌）。

        产品规则（2026-10 确认）：听任意只能自摸——点炮胡（含地胡）与抢杠胡
        均不成立，只有摸牌成胡（杠上开花属自摸，保留）。与前端
        lotusRules.isAnyWait 同口径：听牌面板显示「听任意」时即不提供吃胡。
        """
        return len(self.waiting_tiles(tiles, exposed_meld_count)) == len(TILE_TYPES)

    def matching_count(self, tiles: list[TileType], tile: TileType) -> int:
        return matching_count(tiles, tile)

    def concealed_kongs(self, tiles: list[TileType]) -> list[TileType]:
        # 精牌按牌面使用；白板不应被当作万能牌开暗杠。
        return [tile for tile in set(tiles) if matching_count(tiles, tile) == 4]

    def can_added_kong(self, hand: list[TileType], melds: list[Meld], tile: TileType) -> bool:
        return tile in hand and any(m.type == 'peng' and m.tile == tile for m in melds)

    def can_rob_kong(self, tiles: list[TileType], tile: TileType,
                     exposed_meld_count: int = 0) -> bool:
        ordinary = [tile] if tile in self.round_state.jokers or tile == 'white' else []
        if not is_winning_hand(
                [*tiles, tile], exposed_meld_count, self.round_state.jokers, ordinary):
            return False
        # 听任意只能自摸：抢杠胡一并不提供（manager.find_robbers 与
        # remote_player 的抢杠意图校验都走这里，单点封锁）。
        return not self.is_any_wait(tiles, exposed_meld_count)

    def wind_kong(self, hand: list[TileType]) -> bool:
        return all(wind in hand for wind in ('east', 'south', 'west', 'north'))

    def claim_capabilities(self, hand: list[TileType], tile: TileType) -> ClaimCapabilities:
        count = matching_count(hand, tile)
        return ClaimCapabilities(can_peng=count >= 2, can_gang=count >= 3)

    def chi_options(self, hand: list[TileType], tile: TileType) -> list[dict]:
        return chi_options(hand, tile)

    def draw_horses(self, wall: list[TileType], amount: int | None = None, seat: int = 0) -> dict:
        return {'horses': [], 'hits': 0}

    def evaluate_fans(self, context: FanContext):
        # 保持 GameRuleSet 兼容；通用接口只承载状态番，完整牌型请调用
        # score_legacy_hand（它需要具体手牌）。
        # FanContext 没有 self_draw 字段，故不在此推断自摸——否则会把点炮误加成自摸；
        # 抢杠胡 / 杠上开花 / 自摸的「加计自摸」由 score_legacy_hand 统一计算。
        from app.rules.fans import FanEvaluation, FanHit
        hits = []
        if context.robbed_kong:
            hits.append(FanHit(code='robbed_kong', label='抢杠胡', multiplier=2))
        if context.kong_bloom:
            hits.append(FanHit(code='kong_bloom', label='杠上开花', multiplier=2))
        if context.dealer:
            hits.append(FanHit(code='dealer', label='庄家', multiplier=2))
        multiplier = 1
        for hit in hits:
            multiplier *= hit.multiplier
        return FanEvaluation(tuple(hits), multiplier, 0, multiplier, multiplier * BASE_SCORE)

    def score_hand(self, context: FanContext) -> dict:
        return self._legacy_evaluation(context, None)

    def score_legacy_hand(self, hand: list[TileType], exposed_meld_count: int,
                          *, dealer: bool = False, self_draw: bool = False,
                          robbed_kong: bool = False, kong_bloom: bool = False,
                          tianhu: bool = False, dihu: bool = False,
                          win_tile: TileType | None = None,
                          discarder_is_dealer: bool = False) -> dict:
        if tianhu or dihu:
            base_fan = OPENING_WIN_FAN
            patterns = [{'label': '天胡' if tianhu else '地胡', 'multiplier': OPENING_WIN_FAN}]
            self_draw_style = True
        else:
            pattern = evaluate_pattern(
                hand, exposed_meld_count, self.round_state.jokers,
                [win_tile] if win_tile in self.round_state.jokers or win_tile == 'white' else [],
            )
            if pattern is None:
                raise ValueError('INVALID_WIN_HAND')
            base_fan = pattern['fan']
            patterns = [{'label': pattern['label'], 'multiplier': base_fan}]
            self_draw_style = self_draw or robbed_kong or kong_bloom
            if self_draw_style:
                patterns.append({'label': '自摸', 'multiplier': 2})
            if robbed_kong:
                patterns.append({'label': '抢杠胡', 'multiplier': 2})
            if kong_bloom:
                patterns.append({'label': '杠上开花', 'multiplier': 2})
            if dealer:
                patterns.append({'label': '庄家', 'multiplier': 2})
        fan = 1
        for item in patterns:
            fan *= item.get('multiplier', 1)
        h = BASE_SCORE * base_fan
        if tianhu or dihu:
            # 天地胡（10 番）平收：三家等额各付 底分×10，赢家实收 3H。
            # 地胡虽是庄家点炮，庄家那一笔同样不翻倍（对齐前端 openingWinPayments）。
            settlement = {'H': h, 'dealerPays': h, 'nonDealerPays': h, 'total': 3 * h}
        elif not dealer and not self_draw_style:
            settlement = {
                'H': h, 'dealerPays': 2 * h, 'nonDealerPays': h,
                'total': (6 if discarder_is_dealer else 5) * h,
            }
        elif dealer and not self_draw_style:
            settlement = {'H': h, 'dealerPays': 0, 'nonDealerPays': 2 * h, 'total': 8 * h}
        elif not dealer:
            settlement = {'H': h, 'dealerPays': 4 * h, 'nonDealerPays': 2 * h, 'total': 8 * h}
        else:
            settlement = {'H': h, 'dealerPays': 0, 'nonDealerPays': 4 * h, 'total': 12 * h}
        return {
            'fan': fan,
            'baseFan': base_fan,
            'patterns': patterns,
            'settlement': settlement,
            'multiplier': fan,
            'totalMultiplier': fan,
            'points': h,
            'details': patterns,
        }

    def _legacy_evaluation(self, context: FanContext, _pattern) -> dict:
        evaluation = self.evaluate_fans(context)
        return evaluation.to_legacy_dict()
