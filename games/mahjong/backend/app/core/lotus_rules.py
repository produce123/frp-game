"""莲花麻将旧版翻精规则的纯判定函数。"""

from collections import Counter
import re

from app.core.tiles import HONORS, SUITS, TILE_TYPES
from app.models.game import TileType

SUITED = re.compile(r'^([mps])([1-9])$')
WINDS: tuple[TileType, ...] = ('east', 'south', 'west', 'north')
DRAGONS: tuple[TileType, ...] = ('red', 'green', 'white')
ORPHANS: tuple[TileType, ...] = (
    'm1', 'm9', 'p1', 'p9', 's1', 's9',
    'east', 'south', 'west', 'north', 'red', 'green', 'white',
)


def matching_count(hand: list[TileType], tile: TileType) -> int:
    return hand.count(tile)


def _natural_tiles(hand: list[TileType], jokers: list[TileType],
                   ordinary_jokers: list[TileType] = ()) -> tuple[list[TileType], int, int]:
    joker_set = set(jokers)
    natural: list[TileType] = []
    unrestricted = 0
    limited = 0
    ordinary = Counter(ordinary_jokers)
    for tile in hand:
        if tile in ordinary and ordinary[tile] > 0:
            ordinary[tile] -= 1
            natural.append(tile)
        elif tile in joker_set:
            unrestricted += 1
        elif tile == 'white':
            limited += 1
        else:
            natural.append(tile)
    return natural, unrestricted, limited


def _consume(counts: Counter, tile: TileType, amount: int) -> Counter:
    result = counts.copy()
    result[tile] -= amount
    if result[tile] <= 0:
        del result[tile]
    return result


def _first(counts: Counter) -> TileType | None:
    return next((tile for tile in TILE_TYPES if counts.get(tile, 0)), None)


def _can_melds(counts: Counter, jokers: int, limited: int, needed: int,
               joker_tiles: set[TileType], memo: dict[tuple, bool]) -> bool:
    key = (needed, jokers, limited, tuple(counts.get(tile, 0) for tile in TILE_TYPES))
    if key in memo:
        return memo[key]
    tile = _first(counts)
    if tile is None:
        result = jokers + limited == needed * 3
        memo[key] = result
        return result
    if needed <= 0:
        memo[key] = False
        return False

    amount = counts[tile]
    missing = max(0, 3 - min(3, amount))
    if _fill_missing(
        _consume(counts, tile, min(3, amount)),
        [tile] * missing, jokers, limited, needed, joker_tiles, memo,
    ):
        memo[key] = True
        return True

    match = SUITED.match(tile)
    if match:
        suit, rank_text = match.groups()
        rank = int(rank_text)
        for start in range(max(1, rank - 2), min(7, rank) + 1):
            sequence = [f'{suit}{start + offset}' for offset in range(3)]
            next_counts = counts.copy()
            missing_tiles: list[TileType] = []
            for candidate in sequence:
                candidate = candidate  # narrow for mypy / type checkers
                if next_counts.get(candidate, 0):
                    next_counts = _consume(next_counts, candidate, 1)
                else:
                    missing_tiles.append(candidate)  # type: ignore[arg-type]
            if _fill_missing(next_counts, missing_tiles, jokers, limited, needed,
                             joker_tiles, memo):
                memo[key] = True
                return True

    if tile in WINDS:
        others = [wind for wind in WINDS if wind != tile]
        for a in range(len(others)):
            for b in range(a + 1, len(others)):
                sequence = [tile, others[a], others[b]]
                next_counts = counts.copy()
                missing_tiles = []
                for candidate in sequence:
                    if next_counts.get(candidate, 0):
                        next_counts = _consume(next_counts, candidate, 1)
                    else:
                        missing_tiles.append(candidate)
                if _fill_missing(next_counts, missing_tiles, jokers, limited, needed,
                                 joker_tiles, memo):
                    memo[key] = True
                    return True

    if tile in DRAGONS:
        next_counts = counts.copy()
        missing_tiles = []
        for candidate in DRAGONS:
            if next_counts.get(candidate, 0):
                next_counts = _consume(next_counts, candidate, 1)
            else:
                missing_tiles.append(candidate)
        if _fill_missing(next_counts, missing_tiles, jokers, limited, needed,
                         joker_tiles, memo):
            memo[key] = True
            return True

    memo[key] = False
    return False


def _fill_missing(counts: Counter, missing: list[TileType], jokers: int, limited: int,
                  needed: int, joker_tiles: set[TileType], memo: dict[tuple, bool]) -> bool:
    if len(missing) > jokers + limited:
        return False
    limited_candidates = sum(tile in joker_tiles or tile == 'white' for tile in missing)
    minimum_limited = max(0, len(missing) - jokers)
    for used_limited in range(minimum_limited, min(limited, limited_candidates) + 1):
        used_jokers = len(missing) - used_limited
        if _can_melds(counts, jokers - used_jokers, limited - used_limited,
                      needed - 1, joker_tiles, memo):
            return True
    return False


def _pinghu(natural: list[TileType], jokers: int, limited: int,
            needed_melds: int, joker_tiles: set[TileType]) -> bool:
    counts = Counter(natural)
    for tile in TILE_TYPES:
        pair_count = min(2, counts.get(tile, 0))
        missing = 2 - pair_count
        limited_for_pair = min(missing, limited) if tile in joker_tiles or tile == 'white' else 0
        unrestricted_for_pair = missing - limited_for_pair
        if unrestricted_for_pair > jokers:
            continue
        if _can_melds(
            _consume(counts, tile, pair_count),
            jokers - unrestricted_for_pair,
            limited - limited_for_pair,
            needed_melds,
            joker_tiles,
            {},
        ):
            return True
    return False


def is_seven_pairs(hand: list[TileType], jokers: list[TileType],
                   ordinary_jokers: list[TileType] = ()) -> bool:
    if len(hand) != 14:
        return False
    natural, unrestricted, limited = _natural_tiles(hand, jokers, ordinary_jokers)
    counts = Counter(natural)
    singles = sum(1 for count in counts.values() if count in (1, 3))
    pairs = sum(2 if count == 4 else 1 for count in counts.values() if count in (2, 3, 4))
    if pairs < 0:  # documents intent; pairs is otherwise useful during debugging
        return False
    eligible = sum(1 for tile, count in counts.items()
                   if count in (1, 3) and (tile in jokers or tile == 'white'))
    for limited_for_singles in range(min(limited, eligible) + 1):
        required = singles - limited_for_singles
        if required > unrestricted:
            continue
        remaining = unrestricted - required + limited - limited_for_singles
        if remaining % 2 == 0 and not (unrestricted - required == 0 and limited - limited_for_singles == 1):
            return True
    return False


def _spacing(tiles: list[TileType]) -> bool:
    if len(set(tiles)) != len(tiles):
        return False
    for suit in SUITS:
        ranks = sorted(int(match.group(1)) for tile in tiles
                       if (match := re.match(rf'^{suit}([1-9])$', tile)))
        if any(b - a < 3 for a, b in zip(ranks, ranks[1:])):
            return False
    return True


def is_thirteen_lan(hand: list[TileType], jokers: list[TileType],
                    ordinary_jokers: list[TileType] = (),
                    require_seven_honors: bool = False) -> bool:
    if len(hand) != 14:
        return False
    natural, unrestricted, limited = _natural_tiles(hand, jokers, ordinary_jokers)
    used = set(natural)
    if not _spacing(natural):
        return False
    joker_candidates = [*jokers, 'white']
    memo: set[tuple] = set()

    def fill(unrestricted_left: int, limited_left: int) -> bool:
        if unrestricted_left == 0 and limited_left == 0:
            # 七星十三烂：七字允许精牌替补，最终 14 张须包含东南西北中发白。
            return True if not require_seven_honors else all(h in used for h in HONORS)
        key = (unrestricted_left, limited_left, tuple(sorted(used)))
        if key in memo:
            return False
        memo.add(key)
        candidates = joker_candidates if limited_left else list(TILE_TYPES)
        for candidate in candidates:
            if candidate in used:
                continue
            used.add(candidate)
            if _spacing(list(used)) and fill(
                unrestricted_left - (0 if limited_left else 1),
                limited_left - (1 if limited_left else 0),
            ):
                return True
            used.remove(candidate)
        return False

    return fill(unrestricted, limited)


def is_thirteen_orphans(hand: list[TileType], jokers: list[TileType],
                        ordinary_jokers: list[TileType] = ()) -> bool:
    """十三幺：门前清，13 种幺九/字牌全有且其一成对（14 张内唯一重复）。
    精牌可替补缺失的幺九牌；白板（limited）只能替补精牌面或白板本身。"""
    if len(hand) != 14:
        return False
    natural, unrestricted, limited = _natural_tiles(hand, jokers, ordinary_jokers)
    # 非幺九牌不能混入；每种幺九牌最多 2 张（唯一一对）。
    if any(tile not in ORPHANS for tile in natural):
        return False
    counts = Counter(natural)
    if any(counts[tile] > 2 for tile in ORPHANS):
        return False
    limited_candidates = [tile for tile in ORPHANS if tile in [*jokers, 'white']]

    # 缺失的幺九牌种类必须由精牌补齐。
    missing = [tile for tile in ORPHANS if counts[tile] == 0]
    # 已有成对（count == 2）时，精牌只需补缺；否则还需一张精牌补成对子。
    already_paired = any(counts[tile] == 2 for tile in ORPHANS)
    total_wildcards = unrestricted + limited
    if len(missing) > total_wildcards:
        return False
    spare = total_wildcards - len(missing)
    if spare != (0 if already_paired else 1):
        return False

    # limited 只能补 limited_candidates 中的种类：缺字中不属于 limited_candidates 的必须用 unrestricted。
    missing_limited_eligible = sum(1 for tile in missing if tile in limited_candidates)
    missing_unrestricted_only = len(missing) - missing_limited_eligible
    if missing_unrestricted_only > unrestricted:
        return False
    # 成对那张：unrestricted 补缺后仍有余量可直接补任意已有 1 张的种类；
    # 否则需 limited 补缺后仍有余量，且该 limited 能补到某个最终为 1 张的 limited_candidates 种类。
    if already_paired:
        return True
    if unrestricted - missing_unrestricted_only >= 1:
        return True
    return limited >= missing_limited_eligible + 1 and (
        missing_limited_eligible >= 1
        or any(counts[tile] == 1 for tile in limited_candidates)
    )


def evaluate_pattern(hand: list[TileType], exposed_meld_count: int,
                     jokers: list[TileType], ordinary_jokers: list[TileType] = ()) -> dict | None:
    if exposed_meld_count == 0 and len(hand) == 14:
        # 与前端保持一致：十三幺允许精牌替补缺失的幺九牌。
        if is_thirteen_orphans(hand, jokers, ordinary_jokers):
            return {'pattern': 'thirteenOrphans', 'fan': 8, 'label': '十三幺'}
        # 与前端保持一致：七星十三烂允许精牌替补，七字由精牌凑齐即可（不要求物理齐全）。
        if is_thirteen_lan(hand, jokers, ordinary_jokers, require_seven_honors=True):
            return {'pattern': 'qiXing', 'fan': 4, 'label': '七星十三烂'}
        if is_thirteen_lan(hand, jokers, ordinary_jokers):
            return {'pattern': 'shiSanLan', 'fan': 2, 'label': '十三烂'}
        if is_seven_pairs(hand, jokers, ordinary_jokers):
            return {'pattern': 'sevenPairs', 'fan': 2, 'label': '七对子'}
    needed = 4 - exposed_meld_count
    if len(hand) != needed * 3 + 2:
        return None
    natural, unrestricted, limited = _natural_tiles(hand, jokers, ordinary_jokers)
    if _pinghu(natural, unrestricted, limited, needed, set(jokers)):
        return {'pattern': 'pinghu', 'fan': 1, 'label': '平胡'}
    return None


def is_winning_hand(hand: list[TileType], exposed_meld_count: int,
                    jokers: list[TileType], ordinary_jokers: list[TileType] = ()) -> bool:
    return evaluate_pattern(hand, exposed_meld_count, jokers, ordinary_jokers) is not None


def waiting_tiles(hand: list[TileType], exposed_meld_count: int,
                  jokers: list[TileType]) -> list[TileType]:
    # 候选牌补入后按癞子处理（精牌增加万能牌、白板增加受限万能牌），
    # 与前端 lotusRules.waitingTiles 一致——精牌面/白板本身就是听口。
    return [tile for tile in TILE_TYPES
            if is_winning_hand([*hand, tile], exposed_meld_count, jokers)]


def chi_options(hand: list[TileType], tile: TileType) -> list[dict]:
    result: list[dict] = []
    count = Counter(hand)
    match = SUITED.match(tile)
    if match:
        suit, rank_text = match.groups()
        rank = int(rank_text)
        for start in range(max(1, rank - 2), min(7, rank) + 1):
            sequence = [f'{suit}{start + offset}' for offset in range(3)]
            companions = [candidate for candidate in sequence if candidate != tile]
            if all(count[companion] >= 1 for companion in companions):
                result.append({'tile': tile, 'tiles': sequence, 'kind': 'sequence'})
    if tile in WINDS:
        for a in range(len(WINDS)):
            for b in range(a + 1, len(WINDS)):
                sequence = [tile, WINDS[a], WINDS[b]]
                if len(set(sequence)) == 3 and all(candidate == tile or count[candidate] >= 1 for candidate in sequence):
                    result.append({'tile': tile, 'tiles': sequence, 'kind': 'wind'})
    if tile in DRAGONS and all(candidate == tile or count[candidate] >= 1 for candidate in DRAGONS):
        result.append({'tile': tile, 'tiles': list(DRAGONS), 'kind': 'dragon'})
    return result
