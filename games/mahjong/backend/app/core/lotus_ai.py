"""莲花麻将（lotus-legacy）AI 决策层 —— 从 src/game/variants/lotus/lotusAi.ts 翻译。

与 core/ai.py 的差异：
- 副露决策（decide_claim）按「动作后听牌质量」与现状比较，不提升则 pass，
  而非无脑 gang>peng>chi；
- 弃牌启发式（choose_discard_index）按听口数/剩余可见张/特殊牌型分/安全度打分，
  而非只按同牌数+靠张+癞子罚分；
- 杠决策（补杠/暗杠/风杠）评估是否破坏听牌/被抢杠，而非无脑杠。

纯决策：只看状态给动作命令，不改任何状态、不触发表现副作用。
"""

import random as _random
import re
from collections import Counter
from functools import cmp_to_key, lru_cache
from typing import Callable, Optional

from app.core.actions import remove_matches
from app.core.kong_projection import has_ready_discard, project_kong_bloom
from app.core.lotus_rules import matching_count, waiting_tiles
from app.core.tiles import HONORS
from app.core.hand_progress import compare_hand_progress, evaluate_hand_progress
from app.models.game import TileType

_SUITED_RE = re.compile(r'^([mps])([1-9])$')

_ORPHAN_TERMINALS = (
    'm1', 'm9', 'p1', 'p9', 's1', 's9',
    'east', 'south', 'west', 'north', 'red', 'green', 'white',
)


def _wildcard_set(jokers: list[TileType]) -> set[TileType]:
    """癞子集合 = 精牌 + 白板（白板可替补精牌及白板本身）。"""
    return set(jokers) | {'white'}


@lru_cache(maxsize=20_000)
def _cached_waiting_tiles(hand_key: tuple[str, ...], exposed_melds: int,
                          joker_key: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(waiting_tiles(list(hand_key), exposed_melds, list(joker_key)))


def _ai_waiting_tiles(hand: list[TileType], exposed_melds: int,
                      jokers: list[TileType]) -> list[TileType]:
    return list(_cached_waiting_tiles(
        tuple(sorted(hand)), exposed_melds, tuple(sorted(jokers))))


# ── 听牌质量打分 ─────────────────────────────────────────────

def _remaining_count(tile: TileType, visible_tiles: list[TileType]) -> int:
    """剩余可见张 = 4 - 可见牌中该牌张数（他人暗手不计）。"""
    return max(0, 4 - matching_count(visible_tiles, tile))


def _lotus_progress(hand: list[TileType], exposed_melds: int,
                    jokers: list[TileType], visible_tiles=None) -> dict:
    return evaluate_hand_progress(
        hand, exposed_melds,
        lambda tiles, exposed: _ai_waiting_tiles(tiles, exposed, jokers),
        list(_wildcard_set(jokers)), visible_tiles or hand, special_hands=True)


def _hand_quality_attack_score(waits: list[TileType], effective_remaining: int,
                               special_score: int, late_game: bool = False) -> int:
    ready_bonus = 80 if len(waits) > 0 else 0
    late_bonus = 20 if late_game and len(waits) > 0 else 0
    return ready_bonus + late_bonus + len(waits) * 10 \
        + effective_remaining * 2 + special_score * 3


def _public_safety_score(tile: TileType, public_tiles: list[TileType],
                         upper_last_discard: Optional[TileType]) -> int:
    """按公开可见的该牌数量评估安全度；上家刚打的牌优先跟打。"""
    public_count = matching_count(public_tiles, tile)
    score = 24 if public_count >= 3 else 12 if public_count >= 2 else 4 if public_count >= 1 else 0
    if upper_last_discard == tile:
        score += 12
    match = _SUITED_RE.match(tile)
    if match and match.group(2) in ('1', '7'):
        middle = f'{match.group(1)}4'
        if middle in public_tiles:
            score += 5
    return score


def _special_pattern_score(hand: list[TileType], exposed_melds: int,
                           jokers: list[TileType]) -> int:
    """门清时对十三烂/十三幺/七对潜力的加分；副露后不再追求特殊牌型。"""
    if exposed_melds > 0:
        return -20
    effective_jokers = _wildcard_set(jokers)
    return max(
        _shi_san_lan_potential(hand, effective_jokers),
        _thirteen_orphans_potential(hand, effective_jokers),
        _seven_pairs_potential(hand, effective_jokers),
    )


def _shi_san_lan_potential(hand: list[TileType], jokers: set[TileType]) -> int:
    """十三烂/七星十三烂潜力：缺陷越少、字牌越齐、精牌越多越接近。"""
    natural = [tile for tile in hand if tile not in jokers]
    defects = len(natural) - len(set(natural))
    for suit in ('m', 'p', 's'):
        ranks: list[int] = []
        for tile in natural:
            match = _SUITED_RE.match(tile)
            if match and match.group(1) == suit:
                ranks.append(int(match.group(2)))
        ranks.sort()
        for index in range(1, len(ranks)):
            if ranks[index] - ranks[index - 1] < 3:
                defects += 1
    honors_held = sum(1 for honor in HONORS if honor in natural)
    joker_count = len(hand) - len(natural)
    honor_shortfall = max(0, 7 - honors_held)
    jokers_after_honors = max(0, joker_count - honor_shortfall)
    defects_after_jokers = max(0, defects - jokers_after_honors)
    if defects_after_jokers > 3:
        return 0
    return (4 - defects_after_jokers) * 4 + honors_held + joker_count


def _thirteen_orphans_potential(hand: list[TileType], jokers: set[TileType]) -> int:
    """十三幺潜力：13 种幺九/字牌持有进度 + 精牌可替补 + 对子可成。"""
    natural = [tile for tile in hand if tile not in jokers]
    held_kinds = sum(1 for tile in _ORPHAN_TERMINALS if tile in natural)
    joker_count = len(hand) - len(natural)
    kinds_after_jokers = held_kinds + joker_count
    if kinds_after_jokers < 10:
        return 0
    has_pair = any(matching_count(natural, tile) >= 2 for tile in _ORPHAN_TERMINALS)
    pair_score = 8 if has_pair or joker_count >= 2 else 0
    return (kinds_after_jokers - 10) * 3 + pair_score


def _seven_pairs_potential(hand: list[TileType], jokers: set[TileType]) -> int:
    """七对子潜力：已有对子数 + 精牌可补单张成对。"""
    counts: Counter[TileType] = Counter()
    joker_count = 0
    for tile in hand:
        if tile in jokers:
            joker_count += 1
        else:
            counts[tile] += 1
    pairs = 0
    singles = 0
    for count in counts.values():
        pairs += count // 2
        singles += count % 2
    near_seven = pairs + min(singles, joker_count)
    if near_seven < 5:
        return 0
    return near_seven * 4


def _discard_heuristic(hand: list[TileType], discarded: TileType,
                       jokers: list[TileType], early_round: bool) -> int:
    """弃牌启发式（质量打分里的 tie-break 分量）。"""
    same = matching_count(hand, discarded) - 1
    match = _SUITED_RE.match(discarded)
    neighbors = 0
    edge_penalty = 0
    if match:
        rank = int(match.group(2))
        suit = match.group(1)
        neighbors += 1 if f'{suit}{rank - 1}' in hand else 0
        neighbors += 1 if f'{suit}{rank + 1}' in hand else 0
        edge_penalty = 0 if rank in (1, 9) else 1
    honor_penalty = 0 if match else (12 if early_round else 3)
    joker_penalty = 100 if discarded in jokers else 2 if discarded == 'white' else 0
    return same * 4 + neighbors * 2 + edge_penalty + honor_penalty + joker_penalty


def _discard_quality(after_discard: list[TileType], discarded: TileType,
                     exposed_melds: int, jokers: list[TileType],
                     visible_tiles: list[TileType], early_round: bool,
                     public_tiles: list[TileType],
                     upper_last_discard: Optional[TileType],
                     wall_count: Optional[int] = None,
                     include_progress: bool = True,
                     pattern_bonus: Optional[Callable[[list[TileType], list], float]] = None,
                     safety_exposure: Optional[Callable[[TileType], float]] = None,
                     melds: Optional[list] = None,
                     extras: Optional[dict] = None) -> dict:
    """弃牌质量：攻击分 + 安全加权 + 番型潜力 − 放炮成本（后两项由血流策略注入）。

    对齐前端 lotusAi.ts 的 discardQuality：
    ``netScore = attackScore + safetyScore × (lateGame且已听 ? 4 : 2) + patternBonus − safetyExposure``。
    经典调用不传 extras / 两个回调，行为与改动前逐位一致。
    """
    if extras:
        pattern_bonus = extras.get('patternBonus') or pattern_bonus
        safety_exposure = extras.get('safetyExposure') or safety_exposure
        melds = extras.get('melds') if extras.get('melds') is not None else melds
    waits = _ai_waiting_tiles(after_discard, exposed_melds, jokers)
    effective_remaining = sum(_remaining_count(tile, visible_tiles) for tile in waits)
    progress = _lotus_progress(after_discard, exposed_melds, jokers, visible_tiles) \
        if include_progress else {
            'shanten': 0 if waits else 8, 'waits': waits, 'effectiveTiles': [],
            'ukeire': effective_remaining, 'effectiveRemaining': effective_remaining,
        }
    special_score = _special_pattern_score(after_discard, exposed_melds, jokers)
    safety_score = _public_safety_score(discarded, public_tiles, upper_last_discard)
    late_game = (wall_count if wall_count is not None else 99) <= 8
    attack_score = _hand_quality_attack_score(waits, effective_remaining, special_score, late_game)
    safety_weight = 4 if late_game and len(waits) > 0 else 2
    bonus = pattern_bonus(after_discard, melds or []) if pattern_bonus else 0
    exposure = safety_exposure(discarded) if safety_exposure else 0
    return {
        'ready': len(waits) > 0,
        'waits': waits,
        'effectiveRemaining': effective_remaining,
        'specialScore': special_score,
        'heuristic': _discard_heuristic(after_discard, discarded, jokers, early_round),
        'safetyScore': safety_score,
        'patternBonus': bonus,
        'safetyExposure': exposure,
        'netScore': attack_score + safety_score * safety_weight + bonus - exposure,
        'progress': progress,
    }


def _current_hand_quality(hand: list[TileType], exposed_melds: int,
                          jokers: list[TileType],
                          visible_tiles: Optional[list[TileType]] = None,
                          wall_count: Optional[int] = None,
                          pattern_bonus: Optional[Callable[[list[TileType], list], float]] = None,
                          melds: Optional[list] = None,
                          extras: Optional[dict] = None) -> dict:
    if extras:
        pattern_bonus = extras.get('patternBonus') or pattern_bonus
        melds = extras.get('melds') if extras.get('melds') is not None else melds
    if visible_tiles is None:
        visible_tiles = hand
    progress = _lotus_progress(hand, exposed_melds, jokers, visible_tiles)
    waits = progress['waits']
    special_score = _special_pattern_score(hand, exposed_melds, jokers)
    effective_remaining = sum(_remaining_count(tile, visible_tiles) for tile in waits)
    late_game = (wall_count if wall_count is not None else 99) <= 8
    attack_score = _hand_quality_attack_score(waits, effective_remaining, special_score, late_game)
    bonus = pattern_bonus(hand, melds or []) if pattern_bonus else 0
    return {
        'ready': len(waits) > 0,
        'waits': waits,
        'effectiveRemaining': effective_remaining,
        'specialScore': special_score,
        'heuristic': 0,
        'safetyScore': 0,
        'patternBonus': bonus,
        'safetyExposure': 0,
        'netScore': attack_score + bonus,
        'progress': progress,
    }


def _compare_quality(a: dict, b: dict) -> int:
    if a['ready'] != b['ready']:
        return 1 if a['ready'] else -1
    if a['netScore'] != b['netScore']:
        return a['netScore'] - b['netScore']
    if not a['ready'] and a['specialScore'] != b['specialScore']:
        return a['specialScore'] - b['specialScore']
    progress = compare_hand_progress(a['progress'], b['progress'])
    if progress:
        return progress
    if a['effectiveRemaining'] != b['effectiveRemaining']:
        return a['effectiveRemaining'] - b['effectiveRemaining']
    if len(a['waits']) != len(b['waits']):
        return len(a['waits']) - len(b['waits'])
    if a['specialScore'] != b['specialScore']:
        return a['specialScore'] - b['specialScore']
    if a['safetyScore'] != b['safetyScore']:
        return a['safetyScore'] - b['safetyScore']
    return b['heuristic'] - a['heuristic']


def _best_discard_after_claim(hand: list[TileType], exposed_melds: int,
                              jokers: list[TileType],
                              visible_tiles: Optional[list[TileType]] = None,
                              early_round: bool = False,
                              public_tiles: Optional[list[TileType]] = None,
                              upper_last_discard: Optional[TileType] = None,
                              wall_count: Optional[int] = None,
                              pattern_bonus: Optional[Callable[[list[TileType], list], float]] = None,
                              safety_exposure: Optional[Callable[[TileType], float]] = None,
                              melds: Optional[list] = None,
                              extras: Optional[dict] = None):
    if not hand:
        return None
    if visible_tiles is None:
        visible_tiles = hand
    if public_tiles is None:
        public_tiles = []
    joker_set = set(jokers)
    has_natural = any(tile not in joker_set for tile in hand)
    candidates = []
    for index, tile in enumerate(hand):
        if has_natural and tile in joker_set:
            continue
        after_discard = hand[:index] + hand[index + 1:]
        candidates.append({
            'index': index,
            'tile': tile,
            'quality': _discard_quality(after_discard, tile, exposed_melds, jokers,
                                        visible_tiles, early_round, public_tiles,
                                        upper_last_discard, wall_count, True,
                                        pattern_bonus, safety_exposure, melds, extras),
        })
    candidates.sort(key=cmp_to_key(
        lambda a, b: _compare_quality(b['quality'], a['quality']) or (a['index'] - b['index'])))
    return candidates[0] if candidates else None


def is_tenpai(hand: list[TileType], exposed_melds: int,
              jokers: list[TileType]) -> bool:
    """当前手牌是否已听牌（存在打出某张后听口非空）。"""
    return has_ready_discard(hand, exposed_melds, jokers)


def _meld_attr(meld, name: str):
    """Meld 对象或 dict 都按字段取值。"""
    return meld[name] if isinstance(meld, dict) else getattr(meld, name)


def should_take_added_kong(view: dict) -> bool:
    """补杠：把第 4 张亮出后别家可抢杠胡。牌河该牌出现越少，别家听它的可能性越高；
    若手牌已听牌，补杠会破坏手牌结构且暴露被抢风险 → 放弃。"""
    meld = next((item for item in view.get('melds', [])
                 if _meld_attr(item, 'type') == 'peng'), None)
    if not meld:
        return True
    public_count = matching_count(view.get('publicTiles') or [], _meld_attr(meld, 'tile'))
    if public_count >= 1:
        return True
    return not is_tenpai(view['hand'], view.get('exposedMelds', 0), view.get('jokers', []))


def should_take_concealed_kong(view: dict) -> bool:
    """暗杠：移除 4 张后结构大变；已听牌时杠会破坏听牌 → 放弃，未听牌则杠（+6B 收益）。"""
    return not is_tenpai(view['hand'], view.get('exposedMelds', 0), view.get('jokers', []))


def should_take_wind_kong(view: dict) -> bool:
    """风杠：同样移除 4 张；已听牌时放弃（血流注入 kongEvaluator 后由开杠价值定价）。"""
    return not is_tenpai(view['hand'], view.get('exposedMelds', 0), view.get('jokers', []))


def _accepts_kong(view: dict, context: dict, legacy: Callable[[dict], bool]) -> bool:
    """开杠是否值得（第 3 步，对齐前端 ``acceptsKong``）。

    注入 ``kongEvaluator`` 时按净值 ``杠收益 − 防守风险 − 自手牌型损失`` 判断——净值为正才压过
    "不杠"（保留手牌继续打）；没注入（经典玩法）时回退旧启发式，行为不变。
    """
    evaluator = view.get('kongEvaluator')
    if not evaluator:
        return legacy(view)
    payload = {
        'hand': list(view['hand']),
        'jokers': list(view.get('jokers', [])),
        'publicTiles': view.get('publicTiles'),
        **context,
    }
    value = evaluator(payload) or {}
    return value.get('net', 0) > 0


def decide_turn(view: dict, jokers: list[TileType] | None = None,
                rules=None) -> dict:
    """回合决策：杠后全听特例 → 自摸胡 → 补杠 → 暗杠 → 乱风杠 → 弃牌。"""
    from app.core.lotus_rules import is_winning_hand as lotus_is_winning_hand
    effective_jokers = list(jokers if jokers is not None else view.get('jokers', []))
    kongs = [tile for tile in set(view['hand'])
             if matching_count(view['hand'], tile) == 4]
    for tile in kongs:
        if project_kong_bloom(
                kind='concealed-kong', hand=view['hand'],
                exposed_melds=view.get('exposedMelds', 0), jokers=effective_jokers,
                tile=tile, visible_tiles=view.get('visibleTiles')).guaranteed_kong_bloom:
            return {'kind': 'concealed-kong', 'tile': tile}

    has_wind_kong = all(wind in view['hand']
                        for wind in ('east', 'south', 'west', 'north'))
    if has_wind_kong and project_kong_bloom(
            kind='wind-kong', hand=view['hand'],
            exposed_melds=view.get('exposedMelds', 0), jokers=effective_jokers,
            visible_tiles=view.get('visibleTiles')).guaranteed_kong_bloom:
        return {'kind': 'wind-kong'}

    if lotus_is_winning_hand(view['hand'], view.get('exposedMelds', 0), effective_jokers):
        return {'kind': 'win'}

    meld_index = -1
    for i, meld in enumerate(view.get('melds', [])):
        # melds 可能是 Meld 对象（player.py 传入）或 dict（单测传入），兼容两者。
        if _meld_attr(meld, 'type') == 'peng' and _meld_attr(meld, 'tile') in view['hand']:
            meld_index = i
            break
    if meld_index >= 0 and _accepts_kong(view, {
            'kind': 'added-kong', 'melds': list(view.get('melds', [])),
            'tile': _meld_attr(view['melds'][meld_index], 'tile'), 'meldIndex': meld_index,
    }, should_take_added_kong):
        return {'kind': 'added-kong', 'meldIndex': meld_index}

    if kongs and _accepts_kong(view, {
            'kind': 'concealed-kong', 'melds': list(view.get('melds', [])), 'tile': kongs[0],
    }, should_take_concealed_kong):
        return {'kind': 'concealed-kong', 'tile': kongs[0]}

    if has_wind_kong and _accepts_kong(view, {
            'kind': 'wind-kong', 'melds': list(view.get('melds', [])),
    }, should_take_wind_kong):
        return {'kind': 'wind-kong'}

    return {'kind': 'discard', 'handIndex': choose_discard_index(
        view['hand'], effective_jokers, random=view.get('_random'),
        options={
            'exposedMelds': view.get('exposedMelds'),
            'visibleTiles': view.get('visibleTiles'),
            'publicTiles': view.get('publicTiles'),
            'upperLastDiscard': view.get('upperLastDiscard'),
            'earlyRound': view.get('earlyRound'),
            'wallCount': view.get('wallCount'),
            'patternBonus': view.get('patternBonus'),
            'safetyExposure': view.get('safetyExposure'),
            'melds': view.get('melds'),
        })}


# ── 副露决策 ────────────────────────────────────────────────

def _claim_action_priority(action: dict) -> int:
    return 0 if action['kind'] == 'peng' else 1


def _extras(view: dict) -> dict:
    """可选扩展（血流策略注入；经典调用不传，行为不变）——对齐前端 DiscardExtras。"""
    return {
        'melds': view.get('melds'),
        'patternBonus': view.get('patternBonus'),
        'safetyExposure': view.get('safetyExposure'),
    }


def _remove_claimed_meld_tiles(hand: list[TileType], meld: dict, tile: TileType):
    """吃牌落地：从手牌移除除弃牌外的两张搭子；缺牌返回 None。"""
    remaining = list(hand)
    for meld_tile in meld['tiles']:
        if meld_tile == tile:
            continue
        try:
            index = remaining.index(meld_tile)
        except ValueError:
            return None
        remaining.pop(index)
    return remaining


def decide_claim(view: dict) -> dict:
    """面对弃牌：能杠必杠；碰/吃按动作后听牌质量与现状比较，不提升则 pass。

    第 3 步（2026-09-13，对齐前端 decideClaim）：注入 ``kongEvaluator`` 后明杠也变成"计分开杠"——
    明杠会造出一副露（门清平胡没了）并拆掉手上的三张（七对/豪华七对路线没了），
    这些损失按点折算后与"不杠"（保留手牌，即最佳非杠候选：碰/吃/过）比较，净值为正才杠。
    """
    if view.get('canGang'):
        evaluator = view.get('kongEvaluator')
        if not evaluator:
            return {'kind': 'gang'}
        value = evaluator({
            'kind': 'discard-gang', 'hand': list(view['hand']),
            'melds': list(view.get('melds') or []), 'jokers': list(view.get('jokers', [])),
            'tile': view.get('tile'), 'publicTiles': view.get('publicTiles'),
        }) or {}
        if value.get('net', 0) > 0:
            return {'kind': 'gang'}

    extras = _extras(view)

    def after_claim_extras(kind: str, tiles: list[TileType]) -> dict:
        if view.get('claimMeldProjection', True) is False:
            return extras
        meld = {'type': kind, 'tile': view['tile'], 'tiles': list(tiles),
                'from': view.get('from')}
        return {**extras, 'melds': [*(view.get('melds') or []), meld]}

    baseline = _current_hand_quality(
        view['hand'], view['exposedMelds'], view['jokers'], view.get('visibleTiles'),
        view.get('wallCount'), extras=extras)
    candidates = []

    if view.get('canPeng') and matching_count(view['hand'], view['tile']) >= 2:
        after_peng = remove_matches(list(view['hand']), view['tile'], 2)
        discard = _best_discard_after_claim(
            after_peng, view['exposedMelds'] + 1, view['jokers'],
            view.get('visibleTiles'), view.get('earlyRound', False),
            view.get('publicTiles'), view.get('upperLastDiscard'), view.get('wallCount'),
            extras=after_claim_extras('peng', [view['tile']] * 3))
        if discard:
            candidates.append({
                'action': {'kind': 'peng', 'discardIndex': discard['index']},
                'quality': discard['quality'],
            })

    for meld in view.get('chiOptions', []):
        after_chi = _remove_claimed_meld_tiles(view['hand'], meld, view['tile'])
        if not after_chi:
            continue
        discard = _best_discard_after_claim(
            after_chi, view['exposedMelds'] + 1, view['jokers'],
            view.get('visibleTiles'), view.get('earlyRound', False),
            view.get('publicTiles'), view.get('upperLastDiscard'), view.get('wallCount'),
            extras=after_claim_extras('chi', list(meld['tiles'])))
        if discard:
            candidates.append({
                'action': {'kind': 'chi', 'meld': meld},
                'quality': discard['quality'],
            })

    improving = [c for c in candidates
                 if (c['quality']['ready'] or baseline['ready'])
                 and (not view.get('claimReadyNetGuard') or baseline['ready']
                      or c['quality']['netScore'] > baseline['netScore'])
                 and _compare_quality(c['quality'], baseline) > 0]
    if not improving:
        return {'kind': 'pass'}
    improving.sort(key=cmp_to_key(
        lambda a, b: _compare_quality(b['quality'], a['quality'])
        or (_claim_action_priority(a['action']) - _claim_action_priority(b['action']))))
    return improving[0]['action']


# ── 弃牌决策 ────────────────────────────────────────────────

def choose_discard_index(hand: list[TileType], jokers: list[TileType],
                         random: Optional[Callable[[], float]] = None,
                         options: Optional[dict] = None) -> int:
    """弃牌启发式：优先打孤张/字牌；精牌默认保留。带质量打分时按听口质量选牌。"""
    if random is None:
        random = _random.random
    options = options or {}
    joker_set = set(jokers)
    has_natural = any(tile not in joker_set for tile in hand)
    extras = {
        'melds': options.get('melds'),
        'patternBonus': options.get('patternBonus'),
        'safetyExposure': options.get('safetyExposure'),
    }

    candidates = []
    for index, tile in enumerate(hand):
        if has_natural and tile in joker_set:
            continue
        same = matching_count(hand, tile) - 1
        match = _SUITED_RE.match(tile)
        neighbors = 0
        if match:
            rank = int(match.group(2))
            suit = match.group(1)
            neighbors += 1 if f'{suit}{rank - 1}' in hand else 0
            neighbors += 1 if f'{suit}{rank + 1}' in hand else 0
        honor = 0 if match else 6
        score = same * 4 + neighbors * 2 + honor + random()
        quality = None
        if options.get('exposedMelds') is not None:
            after_discard = hand[:index] + hand[index + 1:]
            quality = _discard_quality(
                after_discard, tile, options['exposedMelds'], jokers,
                options.get('visibleTiles') or hand,
                options.get('earlyRound', False),
                options.get('publicTiles') or [],
                options.get('upperLastDiscard'),
                options.get('wallCount'), False, extras=extras)
        candidates.append({'index': index, 'score': score, 'quality': quality})

    def cmp(a: dict, b: dict) -> int:
        if a['quality'] is not None and b['quality'] is not None:
            return _compare_quality(b['quality'], a['quality']) or (a['score'] - b['score'])
        return a['score'] - b['score']

    candidates.sort(key=cmp_to_key(cmp))
    if options.get('exposedMelds') is None:
        return candidates[0]['index'] if candidates else 0
    if options.get('wallCount') is not None and options['wallCount'] > 60:
        return candidates[0]['index'] if candidates else 0
    shortlist = candidates[:3]
    for candidate in shortlist:
        index = candidate['index']
        tile = hand[index]
        candidate['quality'] = _discard_quality(
            hand[:index] + hand[index + 1:], tile, options['exposedMelds'], jokers,
            options.get('visibleTiles') or hand, options.get('earlyRound', False),
            options.get('publicTiles') or [], options.get('upperLastDiscard'),
            options.get('wallCount'), extras=extras)
    shortlist.sort(key=cmp_to_key(cmp))
    return shortlist[0]['index'] if shortlist else 0
