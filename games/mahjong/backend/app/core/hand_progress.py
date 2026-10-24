"""共享 AI 牌效：标准向听、有效进张与可见剩余。"""

from functools import lru_cache
from typing import Callable

from app.core.tiles import TILE_TYPES
from app.models.game import TileType

TILE_INDEX = {tile: index for index, tile in enumerate(TILE_TYPES)}
ORPHANS = {
    'm1', 'm9', 'p1', 'p9', 's1', 's9',
    'east', 'south', 'west', 'north', 'red', 'green', 'white',
}


@lru_cache(maxsize=10_000)
def _completion_shanten(melds: int, pairs: int, taatsu: int, jokers: int) -> int:
    if melds > 4:
        return 8
    if jokers == 0:
        return 8 - melds * 2 - min(taatsu, 4 - melds) - min(1, pairs)
    best = _completion_shanten(melds, pairs, taatsu, jokers - 1)
    if pairs == 0 and jokers >= 2:
        best = min(best, _completion_shanten(melds, 1, taatsu, jokers - 2))
    if jokers >= 2:
        best = min(best, _completion_shanten(melds, pairs, taatsu + 1, jokers - 2))
    if jokers >= 3:
        best = min(best, _completion_shanten(melds + 1, pairs, taatsu, jokers - 3))
    return best


@lru_cache(maxsize=100_000)
def _standard_shanten_cached(hand_key: tuple[str, ...], exposed_melds: int,
                             wildcard_key: tuple[str, ...]) -> int:
    wildcards = set(wildcard_key)
    natural = [tile for tile in hand_key if tile not in wildcards]
    joker_count = len(hand_key) - len(natural)
    counts = [0] * len(TILE_TYPES)
    for tile in natural:
        counts[TILE_INDEX[tile]] += 1
    best = 8
    seen: set[tuple] = set()

    def finish(melds: int, pairs: int, taatsu: int, jokers: int) -> None:
        nonlocal best
        best = min(best, _completion_shanten(melds, pairs, taatsu, jokers))

    def dfs(start: int, melds: int, pairs: int, taatsu: int, jokers: int) -> None:
        while start < len(counts) and counts[start] == 0:
            start += 1
        if start >= len(counts):
            finish(melds + exposed_melds, pairs, taatsu, jokers)
            return
        signature = (tuple(counts), start, melds, pairs, taatsu, jokers)
        if signature in seen:
            return
        seen.add(signature)

        counts[start] -= 1
        dfs(start, melds, pairs, taatsu, jokers)
        counts[start] += 1

        real = min(3, counts[start])
        missing = 3 - real
        if missing <= jokers:
            counts[start] -= real
            dfs(start, melds + 1, pairs, taatsu, jokers - missing)
            counts[start] += real

        real = min(2, counts[start])
        missing = 2 - real
        if missing <= jokers:
            counts[start] -= real
            if pairs == 0:
                dfs(start, melds, 1, taatsu, jokers - missing)
            dfs(start, melds, pairs, taatsu + 1, jokers - missing)
            counts[start] += real

        if start >= 27:
            return
        rank = start % 9
        suit_base = start - rank
        for sequence_start in range(max(suit_base, start - 2), min(start, suit_base + 6) + 1):
            sequence = (sequence_start, sequence_start + 1, sequence_start + 2)
            consumed = [counts[index] > 0 for index in sequence]
            missing = consumed.count(False)
            if missing <= jokers:
                for index, used in zip(sequence, consumed):
                    if used:
                        counts[index] -= 1
                dfs(start, melds + 1, pairs, taatsu, jokers - missing)
                for index, used in zip(sequence, consumed):
                    if used:
                        counts[index] += 1

        for gap in (1, 2):
            other = start + gap
            if other >= 27 or other // 9 != start // 9:
                continue
            used_start = counts[start] > 0
            used_other = counts[other] > 0
            missing = int(not used_start) + int(not used_other)
            if missing > jokers:
                continue
            if used_start:
                counts[start] -= 1
            if used_other:
                counts[other] -= 1
            dfs(start, melds, pairs, taatsu + 1, jokers - missing)
            if used_start:
                counts[start] += 1
            if used_other:
                counts[other] += 1

    dfs(0, 0, 0, 0, joker_count)
    return max(-1, best)


def standard_shanten(hand: list[TileType], exposed_melds: int = 0,
                     wildcard_tiles: list[TileType] | None = None) -> int:
    return _standard_shanten_cached(
        tuple(sorted(hand)), exposed_melds, tuple(sorted(wildcard_tiles or [])))


def _seven_pairs_shanten(hand: list[TileType], wildcards: set[TileType]) -> int:
    counts: dict[TileType, int] = {}
    jokers = 0
    for tile in hand:
        if tile in wildcards:
            jokers += 1
        else:
            counts[tile] = counts.get(tile, 0) + 1
    pairs = sum(count // 2 for count in counts.values())
    singles = sum(count % 2 for count in counts.values())
    paired = min(singles, jokers)
    pairs += paired
    jokers -= paired
    pairs += jokers // 2
    return max(0, 6 - pairs + max(0, 7 - len(counts) - (jokers + 1) // 2))


def _orphans_shanten(hand: list[TileType], wildcards: set[TileType]) -> int:
    natural = [tile for tile in hand if tile not in wildcards]
    jokers = len(hand) - len(natural)
    unique = len(set(natural) & ORPHANS)
    has_pair = any(natural.count(tile) >= 2 for tile in ORPHANS)
    missing = max(0, 13 - unique - jokers)
    spare = max(0, jokers - (13 - unique))
    return max(0, missing + (0 if has_pair or spare > 0 else 1))


def _spaced_count(ranks: list[int]) -> int:
    unique = sorted(set(ranks))
    dp = [1] * len(unique)
    for i, rank in enumerate(unique):
        for j in range(i):
            if rank - unique[j] >= 3:
                dp[i] = max(dp[i], dp[j] + 1)
    return max(dp, default=0)


def _shi_san_lan_shanten(hand: list[TileType], wildcards: set[TileType]) -> int:
    natural = [tile for tile in hand if tile not in wildcards]
    jokers = len(hand) - len(natural)
    honors = len(set(tile for tile in natural if tile[0] not in 'mps'))
    suited = sum(_spaced_count([
        int(tile[1]) for tile in natural if tile[0] == suit and len(tile) == 2
    ]) for suit in ('m', 'p', 's'))
    return max(0, 13 - min(13, honors + suited + jokers))


def _shanten(hand: list[TileType], exposed_melds: int,
             wildcard_tiles: list[TileType], special_hands: bool) -> int:
    standard = standard_shanten(hand, exposed_melds, wildcard_tiles)
    if not special_hands or exposed_melds > 0:
        return standard
    wildcards = set(wildcard_tiles)
    return min(standard, _seven_pairs_shanten(hand, wildcards),
               _orphans_shanten(hand, wildcards),
               _shi_san_lan_shanten(hand, wildcards))


def hand_shanten(
        hand: list[TileType], exposed_melds: int,
        waiting_fn: Callable[[list[TileType], int], list[TileType]],
        wildcard_tiles: list[TileType] | None = None,
        special_hands: bool = False) -> int:
    """只要向听（含门清玩法的特殊牌型），不做进张口/进张数的 34 面枚举。

    对齐前端 ``handShanten``：用于"结构有没有变差"这类高频比较（例如开杠前的自手牌型损失），
    口径与 ``evaluate_hand_progress`` 的 shanten 一致。
    """
    if waiting_fn(list(hand), exposed_melds):
        return 0
    return max(1, _shanten(hand, exposed_melds, wildcard_tiles or [], special_hands))


def evaluate_hand_progress(
        hand: list[TileType], exposed_melds: int,
        waiting_fn: Callable[[list[TileType], int], list[TileType]],
        wildcard_tiles: list[TileType] | None = None,
        visible_tiles: list[TileType] | None = None,
        special_hands: bool = False) -> dict:
    visible = visible_tiles if visible_tiles is not None else hand
    wildcards = wildcard_tiles or []

    def remaining(tile: TileType) -> int:
        return max(0, 4 - visible.count(tile))

    waits = waiting_fn(hand, exposed_melds)
    shanten = 0 if waits else max(1, _shanten(hand, exposed_melds, wildcards, special_hands))
    effective_remaining = sum(remaining(tile) for tile in waits)
    if waits:
        effective = [{'tile': tile, 'remaining': remaining(tile)} for tile in waits]
        return {'shanten': 0, 'waits': waits, 'effectiveTiles': effective,
                'ukeire': effective_remaining, 'effectiveRemaining': effective_remaining}

    # 三向听及更远只比较精确向听；二向听以内再枚举完整有效进张，避免早巡模拟爆炸。
    if shanten > 2:
        return {'shanten': shanten, 'waits': waits, 'effectiveTiles': [],
                'ukeire': 0, 'effectiveRemaining': effective_remaining}

    effective = []
    for tile in TILE_TYPES:
        count = remaining(tile)
        if count <= 0:
            continue
        if _shanten([*hand, tile], exposed_melds, wildcards, special_hands) < shanten:
            effective.append({'tile': tile, 'remaining': count})
    return {'shanten': shanten, 'waits': waits, 'effectiveTiles': effective,
            'ukeire': sum(item['remaining'] for item in effective),
            'effectiveRemaining': effective_remaining}


def compare_hand_progress(a: dict, b: dict) -> int:
    if a['shanten'] != b['shanten']:
        return b['shanten'] - a['shanten']
    if a['ukeire'] != b['ukeire']:
        return a['ukeire'] - b['ukeire']
    if a['effectiveRemaining'] != b['effectiveRemaining']:
        return a['effectiveRemaining'] - b['effectiveRemaining']
    return len(a['waits']) - len(b['waits'])


def clear_hand_progress_caches() -> None:
    """新比赛重置跨局缓存，避免上一场热缓存改变下一场的节奏基线。"""
    _standard_shanten_cached.cache_clear()
    _completion_shanten.cache_clear()
