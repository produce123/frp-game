"""Big-hand commitment route detection and candidate narrowing.

This mirrors front-end bloodFlow/bigHandRoute.ts. Route progress is public,
deterministic tile coverage; it is not a win-probability estimate.
"""
import re
from typing import Optional

from app.core.blood_flow.config import BLOOD_FLOW_BIG_HAND_ROUTE, BLOOD_FLOW_CONFIG, BigHandRouteConfig

THIRTEEN_ORPHANS = (
    'm1', 'm9', 'p1', 'p9', 's1', 's9',
    'east', 'south', 'west', 'north', 'red', 'green', 'white',
)
_ORPHAN_SET = frozenset(THIRTEEN_ORPHANS)
_NUMERIC = re.compile(r'^[mps][1-9]$')
_NO_CLAIMS = {'chi': False, 'peng': False, 'gang': False, 'tile': 'none'}


def _meld_field(meld, name: str, default=None):
    if isinstance(meld, dict):
        return meld.get(name, default)
    return getattr(meld, name, default)


def _is_suited(tile: str) -> bool:
    return bool(_NUMERIC.fullmatch(tile))


def covered_route_tiles(hand: list[str], targets: list[str], jokers: list[str]) -> int:
    """Each physical tile covers at most one route slot, in natural/joker order."""
    remaining = list(targets)

    def take(allowed) -> None:
        index = next((i for i, target in enumerate(remaining) if allowed(target)), -1)
        if index >= 0:
            remaining.pop(index)

    for tile in hand:
        if tile not in jokers and tile != 'white':
            take(lambda target, tile=tile: target == tile)
    for tile in hand:
        if tile == 'white' and tile not in jokers:
            take(lambda target: target == 'white' or target in jokers)
    for tile in hand:
        if tile in jokers:
            take(lambda _target: True)
    return len(targets) - len(remaining)


def detect_big_hand_route(hand: list[str], melds: list, jokers: list[str],
                          config: BigHandRouteConfig = BLOOD_FLOW_BIG_HAND_ROUTE
                          ) -> Optional[dict]:
    if config.mode == 'off':
        return None
    candidates: list[dict] = []
    wildcards = {*jokers, 'white'}
    joker_count = sum(tile in wildcards for tile in hand)

    if not melds:
        natural_orphan_kinds = sum(tile in hand for tile in THIRTEEN_ORPHANS)
        covered = covered_route_tiles(hand, list(THIRTEEN_ORPHANS), jokers)
        if covered >= config.min_orphan_kinds:
            candidates.append({
                'id': 'thirteenOrphans',
                'label': BLOOD_FLOW_CONFIG.patterns['thirteenOrphans'].label,
                'weight': BLOOD_FLOW_CONFIG.patterns['thirteenOrphans'].weight,
                'progress': covered / 13,
                'need': [tile for tile in THIRTEEN_ORPHANS if tile not in hand],
                'keepers': [tile for tile in hand if tile in _ORPHAN_SET],
                'naturalOnly': natural_orphan_kinds >= 13,
                'claims': dict(_NO_CLAIMS),
            })

        for suit in ('m', 'p', 's'):
            tiles = [tile for tile in hand if tile.startswith(suit)]
            natural_tiles = [tile for tile in tiles if tile not in wildcards]
            ranks = {tile[1] for tile in natural_tiles}
            rank_targets = [f'{suit}{rank}' for rank in range(1, 10)]
            covered_ranks = covered_route_tiles(hand, rank_targets, jokers)
            shape_targets = [rank_targets[0], rank_targets[0], *rank_targets,
                             rank_targets[8], rank_targets[8]]
            covered_shape = covered_route_tiles(hand, shape_targets, jokers)
            if covered_ranks >= config.min_suit_ranks and covered_shape >= config.min_suit_tiles:
                candidates.append({
                    'id': 'nineGates',
                    'label': BLOOD_FLOW_CONFIG.patterns['nine-gates'].label,
                    'weight': BLOOD_FLOW_CONFIG.patterns['nine-gates'].weight,
                    'progress': covered_ranks / 9,
                    'need': [f'{suit}{rank}' for rank in range(1, 10)
                             if str(rank) not in ranks],
                    'keepers': tiles,
                    'naturalOnly': len(ranks) >= 9 and len(natural_tiles) >= 13,
                    'claims': dict(_NO_CLAIMS),
                    'mainSuit': suit,
                })

    enabled = set(config.enabled)
    meld_tiles = [tile for meld in melds for tile in (_meld_field(meld, 'tiles', []) or [])]
    natural_hand = [tile for tile in hand if tile not in wildcards]
    natural_all = [*natural_hand,
                   *(tile for tile in meld_tiles if tile not in wildcards)]
    effective = len(hand) + 3 * len(melds)
    has_chi = any(_meld_field(meld, 'type') == 'chi' for meld in melds)
    natural_only = joker_count == 0

    if {'pureSuit', 'mixedSuit'} & enabled:
        for suit in ('m', 'p', 's'):
            suited_all = [tile for tile in natural_all if _is_suited(tile)]
            main_tiles = sum(tile.startswith(suit) for tile in suited_all) + joker_count
            foreign_suits = sum(not tile.startswith(suit) for tile in suited_all)
            honors_all = sum(not _is_suited(tile) for tile in natural_all)
            suit_meld_ok = all(tile in wildcards or tile.startswith(suit) for tile in meld_tiles)
            honor_meld_ok = all(tile in wildcards or tile.startswith(suit) or not _is_suited(tile)
                                for tile in meld_tiles)
            if ('pureSuit' in enabled and suit_meld_ok
                    and main_tiles >= config.pure_suit_min_tiles
                    and foreign_suits + honors_all <= config.pure_suit_max_foreign):
                candidates.append({
                    'id': 'pureSuit',
                    'label': BLOOD_FLOW_CONFIG.patterns['pure-suit'].label,
                    'weight': BLOOD_FLOW_CONFIG.patterns['pure-suit'].weight,
                    'progress': min(1.0, main_tiles / max(1, effective)),
                    'need': [f'{suit} 门任意牌'],
                    'keepers': [tile for tile in hand if tile.startswith(suit)],
                    'naturalOnly': natural_only,
                    'claims': {'chi': True, 'peng': True, 'gang': True, 'tile': 'mainSuit'},
                    'mainSuit': suit,
                })
            if ('mixedSuit' in enabled and honor_meld_ok
                    and main_tiles >= config.mixed_suit_min_tiles
                    and foreign_suits <= config.mixed_suit_max_foreign):
                candidates.append({
                    'id': 'mixedSuit',
                    'label': BLOOD_FLOW_CONFIG.patterns['mixed-suit'].label,
                    'weight': BLOOD_FLOW_CONFIG.patterns['mixed-suit'].weight,
                    'progress': min(1.0, (main_tiles + honors_all) / max(1, effective)),
                    'need': [f'{suit} 门或字牌'],
                    'keepers': [tile for tile in hand if tile.startswith(suit) or not _is_suited(tile)],
                    'naturalOnly': natural_only,
                    'claims': {'chi': True, 'peng': True, 'gang': True, 'tile': 'mainSuitOrHonor'},
                    'mainSuit': suit,
                })

    if 'allTriplets' in enabled and not has_chi:
        counts: dict[str, int] = {}
        for tile in natural_hand:
            counts[tile] = counts.get(tile, 0) + 1
        real_triplets = sum(
            1 for meld in melds
            if _meld_field(meld, 'type') != 'chi' and not _meld_field(meld, 'windKong', False)
        )
        pair_units = 0
        for count in counts.values():
            real_triplets += count // 3
            if count % 3 == 2:
                pair_units += 1
        effective_triplets = real_triplets + min(joker_count, pair_units)
        units_with_jokers = real_triplets + pair_units + joker_count
        if effective_triplets >= 2 and units_with_jokers >= config.all_triplets_min_units:
            candidates.append({
                'id': 'allTriplets',
                'label': BLOOD_FLOW_CONFIG.patterns['all-triplets'].label,
                'weight': BLOOD_FLOW_CONFIG.patterns['all-triplets'].weight,
                'progress': min(1.0, units_with_jokers / 5),
                'need': ['刻子/杠（不要顺子）'],
                'keepers': [tile for tile in hand if counts.get(tile, 0) >= 2],
                'naturalOnly': natural_only,
                'claims': {'chi': False, 'peng': True, 'gang': True, 'tile': 'any'},
            })

    if not candidates:
        return None
    return max(candidates, key=lambda route: route['weight'] * route['progress'] ** 2)


def route_keeps_progress(hand: list[str], melds: list, jokers: list[str],
                         route: dict, config: BigHandRouteConfig) -> bool:
    following = detect_big_hand_route(hand, melds, jokers, config)
    return bool(following and following['id'] == route['id']
                and following['progress'] + 1e-9 >= route['progress'])


def route_payoff(route: dict, base_points: int, hard_win_multiplier: int = 2) -> int:
    return int(base_points * route['weight'] * (hard_win_multiplier if route['naturalOnly'] else 1))


def claim_keeps_route(route: dict, action: dict, claimed_tile: Optional[str],
                      wildcards: set[str]) -> bool:
    claims = route['claims']
    kind = action.get('kind')
    if kind == 'chi' and not claims['chi']:
        return False
    if kind == 'peng' and not claims['peng']:
        return False
    if kind in ('gang', 'added-kong', 'concealed-kong', 'wind-kong') and not claims['gang']:
        return False
    if claims['tile'] == 'none':
        return False
    if claims['tile'] == 'any':
        return True
    tiles = action.get('tiles') or ([claimed_tile] if claimed_tile else [])
    if not tiles:
        return True
    for tile in tiles:
        if tile in wildcards:
            continue
        suited = _is_suited(tile)
        if claims['tile'] == 'mainSuitOrHonor':
            if suited and not tile.startswith(route.get('mainSuit', '')):
                return False
        elif not suited or not tile.startswith(route.get('mainSuit', '')):
            return False
    return True


def narrow_actions_to_route(hand: list[str], melds: list, jokers: list[str],
                            actions: list[dict], *, config: BigHandRouteConfig,
                            base_points: int, immediate_win_payment: int = 0,
                            wall_count: Optional[int] = None, score_deficit: float = 0,
                            claimed_tile: Optional[str] = None) -> dict:
    route = detect_big_hand_route(hand, melds, jokers, config)
    if route is None:
        return {'route': None, 'actions': actions, 'collapsed': False}
    held_jokers = sum(tile in {*jokers, 'white'} for tile in hand)
    wall_floor = (config.min_wall_for_commit_with_jokers
                  if held_jokers >= config.joker_relief_count else config.min_wall_for_commit)
    wall_ok = wall_count is None or wall_count >= wall_floor
    deficit_ok = score_deficit >= config.min_deficit_for_commit
    if not wall_ok and not deficit_ok:
        return {'route': route, 'actions': actions, 'collapsed': False}
    chase_worth = route_payoff(route, base_points) >= immediate_win_payment * config.decline_win_ratio
    wildcards = {*jokers, 'white'}
    kept = []
    for action in actions:
        kind = action.get('kind')
        if kind == 'discard' and isinstance(action.get('index'), int):
            after = [tile for index, tile in enumerate(hand) if index != action['index']]
            if route_keeps_progress(after, melds, jokers, route, config):
                kept.append(action)
        elif kind == 'win':
            if not chase_worth:
                kept.append(action)
        elif kind == 'pass':
            kept.append(action)
        elif claim_keeps_route(route, action, claimed_tile, wildcards):
            kept.append(action)
    if not kept:
        return {'route': route, 'actions': actions, 'collapsed': False}
    return {'route': route, 'actions': kept, 'collapsed': True}
