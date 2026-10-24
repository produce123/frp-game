"""血流分解搜索 —— 对应 src/game/variants/lotus/patterns/decompose.ts 的逐行翻译。

可替代分解（精牌替任意、白板受限）与自然分解；标准形 / 七对 / 十三幺 / 七星 / 十三烂。
"""

from dataclasses import dataclass, field

from app.core.tiles import TILE_TYPES
from app.models.game import TileType

from .special_hands import DRAGONS, WINDS, is_qi_xing_shi_san_lan, is_shi_san_lan, is_thirteen_orphans
from .types import DecomposedGroup, TileAssignment, WinEvaluationInput, WinningDecomposition

PAIRS: list[dict] = [{'kind': 'pair', 'tiles': (tile, tile)} for tile in TILE_TYPES]
MELDS: list[dict] = [{'kind': 'triplet', 'tiles': (tile, tile, tile)} for tile in TILE_TYPES]
for suit in ('m', 'p', 's'):
    for n in range(1, 8):
        MELDS.append({'kind': 'sequence', 'tiles': tuple(f'{suit}{n + i}' for i in range(3))})
for excluded in WINDS:
    MELDS.append({'kind': 'sequence', 'tiles': tuple(t for t in WINDS if t != excluded)})
MELDS.append({'kind': 'sequence', 'tiles': DRAGONS})


def sorted_key(tiles) -> str:
    return ','.join(sorted(tiles))


def validate_win_input(inp: WinEvaluationInput) -> list[DecomposedGroup] | None:
    """Validate physical ownership only; virtual representatives may exceed four copies."""
    if len(inp.melds) > 4 or len(inp.concealed) + 1 + len(inp.melds) * 3 != 14:
        return None
    physical = [*inp.concealed, inp.winning_tile, *[t for m in inp.melds for t in m['tiles']]]
    if any(t not in TILE_TYPES for t in physical) or any(t not in TILE_TYPES for t in inp.jokers):
        return None
    if any(physical.count(t) > 4 for t in TILE_TYPES):
        return None
    groups: list[DecomposedGroup] = []
    for meld_index, m in enumerate(inp.melds):
        if m.get('pending') or m['type'] == 'flower':
            return None
        if m.get('windKong'):
            if m['type'] != 'angang' or sorted_key(m['tiles']) != sorted_key(WINDS):
                return None
            kind = 'wind-kong'
        elif m['type'] == 'chi':
            if not any(s['kind'] == 'sequence' and sorted_key(s['tiles']) == sorted_key(m['tiles']) for s in MELDS):
                return None
            kind = 'sequence'
        else:
            count = 3 if m['type'] == 'peng' else 4
            if m['type'] not in ('peng', 'gang', 'angang') or len(m['tiles']) != count \
                    or any(t != m['tile'] for t in m['tiles']):
                return None
            kind = 'triplet' if count == 3 else 'kong'
        groups.append(DecomposedGroup(
            kind=kind, tiles=tuple(m['tiles']),
            concealed=(m['type'] == 'angang' and not m.get('windKong')),
            origin={'kind': 'meld', 'meldIndex': meld_index},
        ))
    return groups


@dataclass
class _Bucket:
    physical: TileType
    indexes: list[int] = field(default_factory=list)
    allowed: tuple[TileType, ...] = ()


def _buckets_for(inp: WinEvaluationInput, natural: bool) -> list[_Bucket]:
    hand = [*inp.concealed, inp.winning_tile]
    buckets: list[_Bucket] = []
    for index, physical in enumerate(hand):
        winning = index == len(hand) - 1
        ordinary = natural or (winning and inp.source in ('discard', 'robbed-kong'))
        if ordinary:
            allowed = (physical,)
        elif physical in inp.jokers:
            allowed = tuple(TILE_TYPES)
        elif physical == 'white':
            allowed = tuple(dict.fromkeys(['white', *inp.jokers]))
        else:
            allowed = (physical,)
        # Winning instance remains separate even from identical physical tiles.
        same = None
        if not winning:
            same = next((b for b in buckets if sorted(b.allowed) == sorted(allowed)), None)
        if same:
            same.indexes.append(index)
        else:
            buckets.append(_Bucket(physical=physical, indexes=[index], allowed=allowed))
    buckets.sort(key=lambda b: (len(b.allowed), b.physical))
    return buckets


def visit_decompositions(inp: WinEvaluationInput, visit) -> None:
    """Streaming exhaustive search; no maximum-solutions cutoff. Count states prune dead ends."""
    exposed = validate_win_input(inp)
    if exposed is None:
        return
    winning_index = len(inp.concealed)
    external = inp.source in ('discard', 'robbed-kong')
    emitted: set[str] = set()
    physical_hand = [*inp.concealed, inp.winning_tile]

    def emit(shape, groups: list[DecomposedGroup], assignments: list[TileAssignment]) -> None:
        natural = all(a.physical == a.represented for a in assignments)
        key = f"{shape}|{natural}|{'|'.join(sorted(f'{g.kind}:{sorted_key(g.tiles)}:{g.concealed}' for g in groups))}"
        if key in emitted:
            return
        emitted.add(key)
        ordered = sorted(assignments, key=lambda a: a.input_index)
        group_index = next(
            (i for i, g in enumerate(groups)
             if g.origin.get('kind') == 'hand' and winning_index in g.origin.get('inputIndexes', [])),
            None,
        )
        visit(WinningDecomposition(
            shape=shape, groups=tuple(groups), assignments=tuple(ordered),
            winning_tile_group_index=group_index, natural=natural,
        ))

    for natural_only in (True, False):
        buckets = _buckets_for(inp, natural_only)
        if not natural_only and all(len(b.allowed) == 1 for b in buckets):
            continue
        counts = [len(b.indexes) for b in buckets]
        assignments: list[TileAssignment] = []
        groups: list[DecomposedGroup] = list(exposed)
        dead: set[str] = set()
        visited: set[str] = set()

        def fill(template: dict, anchor: int, done) -> None:
            selected: list[int] = []
            resources: list[int] = []

            def step(slot: int) -> None:
                if slot == len(template['tiles']):
                    if anchor in resources:
                        done(selected)
                    return
                represented = template['tiles'][slot]
                for b in range(len(buckets)):
                    if not counts[b] or represented not in buckets[b].allowed:
                        continue
                    # Equal represented slots are an unordered multiset of physical resources.
                    if slot and represented == template['tiles'][slot - 1] and b < resources[slot - 1]:
                        continue
                    input_index = buckets[b].indexes[len(buckets[b].indexes) - counts[b]]
                    counts[b] -= 1
                    selected.append(input_index)
                    resources.append(b)
                    assignments.append(TileAssignment(input_index=input_index,
                                                       physical=physical_hand[input_index],
                                                       represented=represented))
                    step(slot + 1)
                    assignments.pop()
                    resources.pop()
                    selected.pop()
                    counts[b] += 1

            step(0)

        def search(pairs: int, melds: int, shape) -> bool:
            if not pairs and not melds:
                emit(shape, groups, assignments)
                return True
            signature = f"{pairs}/{melds}/{','.join(map(str, counts))}"
            if signature in dead:
                return False
            state_key = f"{signature}|{'|'.join(sorted(f'{g.kind}:{sorted_key(g.tiles)}:{g.concealed}' for g in groups))}"
            if state_key in visited:
                return True
            visited.add(state_key)
            anchor = next((i for i, c in enumerate(counts) if c > 0), -1)
            if anchor < 0:
                return False
            found = False
            templates = ([*PAIRS] if pairs else []) + ([*MELDS] if melds else [])
            for template in templates:
                if not any(t in buckets[anchor].allowed for t in template['tiles']):
                    continue

                def done(indexes: list[int], template=template) -> None:
                    nonlocal found
                    groups.append(DecomposedGroup(
                        kind=template['kind'], tiles=template['tiles'],
                        concealed=not (external and template['kind'] == 'triplet' and winning_index in indexes),
                        origin={'kind': 'hand', 'inputIndexes': list(indexes)},
                    ))
                    if search(pairs - (1 if template['kind'] == 'pair' else 0),
                              melds - (0 if template['kind'] == 'pair' else 1), shape):
                        found = True
                    groups.pop()

                fill(template, anchor, done)
            if not found:
                dead.add(signature)
            return found

        search(1, 4 - len(exposed), 'standard')
        if len(exposed) == 0:
            dead.clear()
            visited.clear()
            search(7, 0, 'sevenPairs')
            for shape in ('thirteenOrphans', 'qiXing', 'shiSanLan'):
                hand = [*inp.concealed, inp.winning_tile]
                jokers = [] if natural_only else list(inp.jokers)
                ordinary = [inp.winning_tile] if external else []
                substitutes = [] if natural_only else ['white']
                predicate = (is_thirteen_orphans if shape == 'thirteenOrphans'
                             else is_qi_xing_shi_san_lan if shape == 'qiXing' else is_shi_san_lan)
                if not predicate(hand, jokers, ordinary, substitutes):
                    continue
                # Independent specials have no composable attributes. One witness per
                # natural/soft path is sufficient.
                represented: list[TileType] = []
                evidence: list[TileAssignment] = []
                slots = [{'bucket': b, 'input_index': i, 'physical': physical_hand[i]}
                         for b in buckets for i in b.indexes]
                failed: set[str] = set()

                def special(index: int) -> bool:
                    if index == len(slots):
                        if not predicate(list(represented), [], [], []):
                            return False
                        emit(shape, [], evidence)
                        return True
                    key = f"{index}:{sorted_key(represented)}"
                    if key in failed:
                        return False
                    slot = slots[index]
                    for tile in slot['bucket'].allowed:
                        if shape == 'thirteenOrphans':
                            is_honor = len(tile) != 2
                            is_terminal = len(tile) == 2 and tile[1] in ('1', '9')
                            if not is_honor and not is_terminal:
                                continue
                            if represented.count(tile) >= 2:
                                continue
                            if tile in represented and len(set(represented)) < len(represented):
                                continue
                        else:
                            conflict = any(
                                t == tile or (len(t) == 2 and len(tile) == 2 and t[0] == tile[0]
                                              and abs(int(t[1]) - int(tile[1])) < 3)
                                for t in represented
                            )
                            if conflict:
                                continue
                        represented.append(tile)
                        evidence.append(TileAssignment(input_index=slot['input_index'],
                                                       physical=slot['physical'], represented=tile))
                        if special(index + 1):
                            return True
                        evidence.pop()
                        represented.pop()
                    failed.add(key)
                    return False

                special(0)
