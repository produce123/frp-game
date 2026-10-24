"""莲花麻将杠后补牌投影。

只在不修改真实牌局的前提下移除杠牌、增加一副露，并枚举牌墙中仍可能摸到的牌。
若每一种仍可摸牌都能立即胡，则该杠可确定性地博杠上开花。
"""

from dataclasses import dataclass
from typing import Literal, Optional

from app.core.lotus_rules import matching_count, waiting_tiles
from app.core.tiles import TILE_TYPES
from app.models.game import TileType

ProjectedKongKind = Literal['discard-gang', 'concealed-kong', 'wind-kong']


@dataclass(frozen=True)
class KongProjection:
    legal: bool
    post_kong_hand: list[TileType]
    waits: list[TileType]
    drawable_tiles: list[TileType]
    guaranteed_kong_bloom: bool


def _remove_copies(hand: list[TileType], tile: TileType,
                   amount: int) -> Optional[list[TileType]]:
    result = list(hand)
    for _ in range(amount):
        try:
            result.remove(tile)
        except ValueError:
            return None
    return result


def _post_kong_hand(kind: ProjectedKongKind, hand: list[TileType],
                    tile: Optional[TileType]) -> Optional[list[TileType]]:
    if kind == 'discard-gang':
        return _remove_copies(hand, tile, 3) if tile else None
    if kind == 'concealed-kong':
        return _remove_copies(hand, tile, 4) if tile else None
    result: Optional[list[TileType]] = list(hand)
    for wind in ('east', 'south', 'west', 'north'):
        result = _remove_copies(result, wind, 1) if result is not None else None
    return result


def project_kong_bloom(*, kind: ProjectedKongKind, hand: list[TileType],
                       exposed_melds: int, jokers: list[TileType],
                       tile: Optional[TileType] = None,
                       visible_tiles: Optional[list[TileType]] = None) -> KongProjection:
    """计算开杠后补入任一仍可摸牌是否都会立即胡。"""
    post_hand = _post_kong_hand(kind, hand, tile)
    if post_hand is None:
        return KongProjection(False, [], [], [], False)
    waits = waiting_tiles(post_hand, exposed_melds + 1, jokers)
    visible = visible_tiles or []
    drawable = [tile_type for tile_type in TILE_TYPES
                if 4 - matching_count(visible, tile_type) > 0]
    wait_set = set(waits)
    return KongProjection(
        legal=True,
        post_kong_hand=post_hand,
        waits=waits,
        drawable_tiles=drawable,
        guaranteed_kong_bloom=bool(drawable)
        and all(tile_type in wait_set for tile_type in drawable),
    )


def has_ready_discard(hand: list[TileType], exposed_melds: int,
                      jokers: list[TileType]) -> bool:
    """摸牌态存在一个合法弃牌可进入听牌；有普通牌时不弃精牌或白板。"""
    protected = set(jokers)
    has_natural = any(tile not in protected for tile in hand)
    for index, tile in enumerate(hand):
        if has_natural and tile in protected:
            continue
        after = hand[:index] + hand[index + 1:]
        if waiting_tiles(after, exposed_melds, jokers):
            return True
    return False
