"""血流特殊手判定 —— 对应 lotusRules.ts 的 naturalTiles / wildcardCounts / 十三烂 / 十三幺。"""

from collections import Counter

from app.core.tiles import HONORS, TILE_TYPES
from app.models.game import TileType

WINDS: tuple[TileType, ...] = ('east', 'south', 'west', 'north')
DRAGONS: tuple[TileType, ...] = ('red', 'green', 'white')
THIRTEEN_ORPHAN_TILES: tuple[TileType, ...] = (
    'm1', 'm9', 'p1', 'p9', 's1', 's9',
    'east', 'south', 'west', 'north', 'red', 'green', 'white',
)


def _is_joker(tile: TileType, all_jokers: list[TileType]) -> bool:
    return tile in all_jokers


def effective_jokers(jokers: list[TileType], joker_substitutes: list[TileType]) -> list[TileType]:
    return list(dict.fromkeys([*jokers, *joker_substitutes]))


def count_available_tiles(hand: list[TileType], candidates: list[TileType],
                          ordinary_jokers: list[TileType] = []) -> int:
    ordinary_counts = Counter(ordinary_jokers)
    count = 0
    for index in range(len(hand) - 1, -1, -1):
        tile = hand[index]
        if ordinary_counts.get(tile, 0) > 0:
            ordinary_counts[tile] -= 1
        elif tile in candidates:
            count += 1
    return count


def wildcard_counts(hand: list[TileType], jokers: list[TileType],
                    ordinary_jokers: list[TileType], joker_substitutes: list[TileType]) -> dict:
    physical_substitutes = [tile for tile in joker_substitutes if tile not in jokers]
    return {
        'unrestricted': count_available_tiles(hand, jokers, ordinary_jokers),
        'limited': count_available_tiles(hand, physical_substitutes, ordinary_jokers),
        # 白板可替代两张精牌及白板本身；精牌自身仍由 unrestricted 处理。
        'limited_tiles': list(dict.fromkeys([*jokers, *physical_substitutes])),
    }


def natural_tiles(hand: list[TileType], jokers: list[TileType],
                  ordinary_jokers: list[TileType] = [], joker_substitutes: list[TileType] = []) -> list[TileType]:
    """Keep selected joker instances as natural tiles (for a discard/robbed-kong tile)."""
    all_jokers = effective_jokers(jokers, joker_substitutes)
    ordinary_counts = Counter(ordinary_jokers)
    ordinary_indexes: set[int] = set()
    # 外部加入的牌在 winHand 末尾，倒序消费才能保留手牌中原有精牌的万能身份。
    for index in range(len(hand) - 1, -1, -1):
        tile = hand[index]
        if not _is_joker(tile, all_jokers):
            continue
        remaining = ordinary_counts.get(tile, 0)
        if remaining <= 0:
            continue
        ordinary_counts[tile] = remaining - 1
        ordinary_indexes.add(index)
    return [tile for index, tile in enumerate(hand)
            if not _is_joker(tile, all_jokers) or index in ordinary_indexes]


def has_shi_san_lan_spacing(tiles: list[TileType]) -> bool:
    seen: set[TileType] = set()
    for tile in tiles:
        if tile in seen:
            return False
        seen.add(tile)
    for suit in ('m', 'p', 's'):
        # 必须精确匹配数牌（2 字符且首字为花色）：startswith('s') 会误把 'south' 当数牌。
        ranks = sorted(int(tile[1]) for tile in tiles if len(tile) == 2 and tile[0] == suit)
        for index in range(1, len(ranks)):
            if ranks[index] - ranks[index - 1] < 3:
                return False
    return True


def has_shi_san_lan_shape(hand: list[TileType], jokers: list[TileType],
                          ordinary_jokers: list[TileType], joker_substitutes: list[TileType],
                          require_seven_honors: bool) -> bool:
    if len(hand) != 14:
        return False
    naturals = natural_tiles(hand, jokers, ordinary_jokers, joker_substitutes)
    if not has_shi_san_lan_spacing(naturals):
        return False
    counts = wildcard_counts(hand, jokers, ordinary_jokers, joker_substitutes)
    unrestricted = counts['unrestricted']
    limited = counts['limited']
    limited_tiles = counts['limited_tiles']
    used: set[TileType] = set(naturals)
    memo: set[str] = set()

    def fill_jokers(unrestricted_remaining: int, limited_remaining: int) -> bool:
        if unrestricted_remaining == 0 and limited_remaining == 0:
            return (not require_seven_honors) or all(honor in used for honor in HONORS)
        key = f"{unrestricted_remaining}:{limited_remaining}:{','.join(sorted(used))}"
        if key in memo:
            return False
        memo.add(key)
        candidates = limited_tiles if limited_remaining > 0 else TILE_TYPES
        for candidate in candidates:
            if candidate in used:
                continue
            used.add(candidate)
            if has_shi_san_lan_spacing(list(used)) and fill_jokers(
                unrestricted_remaining - (0 if limited_remaining > 0 else 1),
                limited_remaining - (1 if limited_remaining > 0 else 0),
            ):
                return True
            used.remove(candidate)
        return False

    # Limited whiteboards are tried first; unrestricted jokers can still fill any remaining slot.
    return fill_jokers(unrestricted, limited)


def is_shi_san_lan(hand: list[TileType], jokers: list[TileType] = [],
                   ordinary_jokers: list[TileType] = [], joker_substitutes: list[TileType] = []) -> bool:
    return has_shi_san_lan_shape(hand, jokers, ordinary_jokers, joker_substitutes, False)


def is_qi_xing_shi_san_lan(hand: list[TileType], jokers: list[TileType] = [],
                           ordinary_jokers: list[TileType] = [], joker_substitutes: list[TileType] = []) -> bool:
    """七星十三烂 = 十三烂 + 东南西北中发白七字全有（七字允许精牌替补）。"""
    return has_shi_san_lan_shape(hand, jokers, ordinary_jokers, joker_substitutes, True)


def is_thirteen_orphans(hand: list[TileType], jokers: list[TileType] = [],
                        ordinary_jokers: list[TileType] = [], joker_substitutes: list[TileType] = []) -> bool:
    """十三幺：门前清，13 种幺九/字牌全有且其一成对（14 张内唯一重复）。"""
    if len(hand) != 14:
        return False
    naturals = natural_tiles(hand, jokers, ordinary_jokers, joker_substitutes)
    if any(tile not in THIRTEEN_ORPHAN_TILES for tile in naturals):
        return False
    counts = Counter(naturals)
    if any(counts.get(tile, 0) > 2 for tile in THIRTEEN_ORPHAN_TILES):
        return False
    wild = wildcard_counts(hand, jokers, ordinary_jokers, joker_substitutes)
    unrestricted = wild['unrestricted']
    limited = wild['limited']
    limited_tiles = wild['limited_tiles']
    limited_candidates = [tile for tile in limited_tiles if tile in THIRTEEN_ORPHAN_TILES]
    missing = [tile for tile in THIRTEEN_ORPHAN_TILES if counts.get(tile, 0) == 0]
    already_paired = any(counts.get(tile, 0) == 2 for tile in THIRTEEN_ORPHAN_TILES)
    total_wildcards = unrestricted + limited
    if len(missing) > total_wildcards:
        return False
    spare = total_wildcards - len(missing)
    if (already_paired and spare != 0) or (not already_paired and spare != 1):
        return False
    missing_limited_eligible = sum(1 for tile in missing if tile in limited_candidates)
    missing_unrestricted_only = len(missing) - missing_limited_eligible
    if missing_unrestricted_only > unrestricted:
        return False
    if already_paired:
        return True
    if unrestricted - missing_unrestricted_only >= 1:
        return True
    return (limited >= missing_limited_eligible + 1
            and (missing_limited_eligible >= 1 or any(counts.get(tile, 0) == 1 for tile in limited_candidates)))
