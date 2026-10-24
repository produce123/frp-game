"""Necessary pattern constraints from fixed melds (frontend patternReachability.ts)."""

GREEN = {'s2', 's3', 's4', 's6', 's8', 'green'}
DRAGONS = ('red', 'green', 'white')
WINDS = ('east', 'south', 'west', 'north')


def _honor(tile: str) -> bool:
    return len(tile) != 2


def _terminal(tile: str) -> bool:
    return len(tile) == 2 and tile[0] in 'mps' and tile[1] in '19'


def _triplet(meld: dict) -> bool:
    return not meld.get('windKong') and meld.get('type') in ('peng', 'gang', 'angang')


def can_develop_pattern_with_melds(pattern_id: str, melds: list[dict]) -> bool:
    """Declared groups cannot be dismantled or reinterpreted as another pattern."""
    if not melds:
        return True
    free = max(0, 4 - len(melds))
    fixed = [tile for meld in melds for tile in meld.get('tiles', [])]

    def honor_groups_fit(tiles: tuple[str, ...], required: int, needs_pair: bool) -> bool:
        held = {meld['tile'] for meld in melds
                if _triplet(meld) and meld.get('tile') in tiles}
        return (len(held) + free >= required
                and (not needs_pair or len(held) <= required and len(held) < len(tiles)))

    if pattern_id in ('sevenPairs', 'luxury-seven-pairs', 'shiSanLan', 'qiXing',
                      'thirteenOrphans', 'nine-gates'):
        return False
    if pattern_id == 'big-three-dragons':
        return honor_groups_fit(DRAGONS, 3, False)
    if pattern_id == 'little-three-dragons':
        return honor_groups_fit(DRAGONS, 2, True)
    if pattern_id == 'big-four-winds':
        return honor_groups_fit(WINDS, 4, False)
    if pattern_id == 'little-four-winds':
        return honor_groups_fit(WINDS, 3, True)
    if pattern_id in ('three-concealed-triplets', 'four-concealed-triplets'):
        maximum = free + sum(meld.get('type') == 'angang' and not meld.get('windKong')
                             for meld in melds)
        return maximum >= (3 if pattern_id == 'three-concealed-triplets' else 4)
    if pattern_id in ('three-kongs', 'four-kongs'):
        return free + sum(_triplet(meld) for meld in melds) >= (
            3 if pattern_id == 'three-kongs' else 4)
    if pattern_id == 'all-triplets':
        return all(_triplet(meld) for meld in melds)
    if pattern_id == 'pure-terminals':
        return all(_triplet(meld) for meld in melds) and all(_terminal(t) for t in fixed)
    if pattern_id == 'mixed-terminals':
        return all(_triplet(meld) for meld in melds) and all(
            _honor(t) or _terminal(t) for t in fixed)
    if pattern_id == 'all-honors':
        return all(_honor(t) for t in fixed)
    if pattern_id == 'all-green':
        return all(t in GREEN for t in fixed)
    if pattern_id == 'pure-suit':
        return not any(_honor(t) for t in fixed) and len({t[0] for t in fixed}) <= 1
    if pattern_id == 'mixed-suit':
        return len({t[0] for t in fixed if not _honor(t)}) <= 1
    if pattern_id == 'all-simples':
        return all(not _honor(t) and not _terminal(t) for t in fixed)
    if pattern_id == 'all-with-terminals':
        return all(any(_honor(t) or _terminal(t) for t in meld.get('tiles', []))
                   for meld in melds)
    if pattern_id == 'concealed-hand':
        return all(meld.get('type') == 'angang' for meld in melds)
    if pattern_id == 'pinghu':
        return all(meld.get('type') == 'chi' for meld in melds)
    return True
