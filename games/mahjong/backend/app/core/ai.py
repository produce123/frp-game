"""AI 决策层 —— 从 src/game/ai.ts 翻译

纯决策：只负责「看状态 → 给出动作命令」，不修改任何游戏状态、
不触发表现副作用。动作的「执行」由 actions.py / GameManager 完成。

优先级链（与原 playAI 一致）：自摸胡 → 补杠 → 暗杠 → 弃牌。
"""

import random as _random
import re
from typing import Optional

from app.core.actions import remove_matches
from app.core.opponent_pattern_risk import max_opponent_risk_tier, opponent_risk_profiles
from app.models.game import GamePlayer, Meld, TileType
from app.rules.base import GameRuleSet
from app.rules.lianhua import get_default_rule_set
from app.core.hand_progress import compare_hand_progress, evaluate_hand_progress

# ─── 决策类型（对应 TS 端联合类型，用 dict 表示）────────────────

TurnDecision = dict
ClaimDecision = str
RobKongDecision = str

_SUITED_RE = re.compile(r'^([mps])([1-9])$')

# 补杠被抢杠的残局窗口：墙余 ≤ 该值视为残局（与既有 lateBonus 口径一致）。
ADDED_KONG_LATE_WALL = 16


def decide_turn(view: dict, rule_set: Optional[GameRuleSet] = None, random=None) -> dict:
    """决策当前 AI 回合的动作。

    view: {hand, melds, exposedMelds, kongBloom}（见 make_turn_view）
    优先级：自摸胡 → 补杠 → 暗杠 → 弃牌。杠前评估是否破坏听牌。
    random 注入以便引擎建议（LLM 兜底）确定性化；默认 None 维持既有行为。
    """
    rules = rule_set or get_default_rule_set()
    if rules.code == 'lotus-legacy':
        # 莲花麻将：杠决策评估（破坏听牌/被抢杠风险）+ 听口质量弃牌（对齐前端 lotusAi）。
        from app.core.lotus_ai import decide_turn as lotus_decide_turn
        return lotus_decide_turn(view, view.get('jokers', []), rules)

    if rules.is_winning_hand(view['hand'], view['exposedMelds']):
        return {'kind': 'win'}

    meld_index = -1
    for i, meld in enumerate(view['melds']):
        if meld.type == 'peng' and rules.can_added_kong(view['hand'], view['melds'], meld.tile):
            meld_index = i
            break
    # 补杠：已听牌时放弃（避免破坏手牌结构 + 被抢杠风险）
    if meld_index >= 0 and _should_take_added_kong(view, meld_index, rules):
        return {'kind': 'added-kong', 'meldIndex': meld_index}

    kongs = rules.concealed_kongs(view['hand'])
    # 暗杠：已听牌时放弃（拆散成形手牌得不偿失）
    if kongs and _should_take_concealed_kong(view, kongs[0], rules):
        return {'kind': 'concealed-kong', 'tile': kongs[0]}

    if getattr(rules, 'wind_kong', lambda _hand: False)(view['hand']) \
            and not _is_tenpai(view['hand'], view['exposedMelds'], rules):
        return {'kind': 'wind-kong'}

    return {'kind': 'discard', 'handIndex': choose_discard_index(
        view['hand'], random=random, rule_set=rules, exposed_melds=view.get('exposedMelds', 0),
        context=view)}


def _progress(hand: list[TileType], exposed_melds: int, rules: GameRuleSet,
              visible_tiles: Optional[list[TileType]] = None) -> dict:
    return evaluate_hand_progress(
        hand, exposed_melds, rules.waiting_tiles, ['white'], visible_tiles or hand)


def _best_discard_progress(hand: list[TileType], exposed_melds: int,
                           rules: GameRuleSet, visible_tiles=None):
    best = None
    seen = set()
    for index, tile in enumerate(hand):
        if tile in seen:
            continue
        seen.add(tile)
        progress = _progress(hand[:index] + hand[index + 1:], exposed_melds,
                             rules, visible_tiles or hand)
        if best is None or compare_hand_progress(progress, best) > 0:
            best = progress
    return best


def _opponent_threat(view: dict) -> int:
    late_bonus = 2 if view.get('wallCount', 99) <= 16 else 0
    own = view.get('playerIndex', -1)
    total = 0
    for index, peer in enumerate(view.get('peers') or []):
        if index == own:
            continue
        melds = peer.get('melds', []) if isinstance(peer, dict) else getattr(peer, 'melds', [])
        total += len(melds) * 3 + late_bonus
    return total


def _peer_discards(peer) -> list[TileType]:
    discards = peer.get('discards', []) if isinstance(peer, dict) \
        else getattr(peer, 'discards', [])
    return list(discards or [])


def _opponent_risk_profiles(view: dict):
    """其他座位的公开风险档（只用牌河 / 副露；对手暗手始终不参与计算）。"""
    own = view.get('playerIndex', -1)
    opponents = []
    for index, peer in enumerate(view.get('peers') or []):
        if index == own:
            continue
        melds = peer.get('melds', []) if isinstance(peer, dict) \
            else getattr(peer, 'melds', [])
        opponents.append({'discards': _peer_discards(peer), 'melds': list(melds or [])})
    return opponent_risk_profiles(opponents, view.get('wallCount', 99))


def _added_kong_rob_risk(view: dict, tile: TileType) -> bool:
    """补杠被抢杠的残局窗口：墙余 ≤ 该值视为残局（与既有 lateBonus 口径一致）。"""
    if view.get('wallCount', 99) > ADDED_KONG_LATE_WALL:
        return False
    if (view.get('publicTiles') or []).count(tile) > 0:
        return False
    return max_opponent_risk_tier(_opponent_risk_profiles(view)) >= 1


def _should_take_added_kong(view: dict, meld_index: int, rules: GameRuleSet) -> bool:
    if _is_tenpai(view['hand'], view['exposedMelds'], rules):
        return False
    meld = view['melds'][meld_index]
    tile = meld.tile if hasattr(meld, 'tile') else meld['tile']
    after = list(view['hand'])
    after.remove(tile)
    current = _best_discard_progress(view['hand'], view['exposedMelds'], rules,
                                     view.get('visibleTiles'))
    projected = _progress(after, view['exposedMelds'], rules, view.get('visibleTiles'))
    if _opponent_threat(view) >= 10:
        return False
    if _added_kong_rob_risk(view, tile):
        return False
    return current is None or projected['shanten'] <= current['shanten'] + 1


def _should_take_concealed_kong(view: dict, tile: TileType, rules: GameRuleSet) -> bool:
    if _is_tenpai(view['hand'], view['exposedMelds'], rules):
        return False
    after = [item for item in view['hand'] if item != tile]
    current = _best_discard_progress(view['hand'], view['exposedMelds'], rules,
                                     view.get('visibleTiles'))
    projected = _progress(after, view['exposedMelds'] + 1, rules, view.get('visibleTiles'))
    return current is None or projected['shanten'] <= current['shanten'] + 1


def _can_be_tenpai(after_length: int, exposed_melds: int) -> bool:
    """打出/当前手牌长度是否可能听牌（= 3n+1，补 1 张即胡）。"""
    needed_melds = 4 - exposed_melds
    return after_length == needed_melds * 3 + 1


def _is_tenpai(hand: list[TileType], exposed_melds: int, rules: GameRuleSet) -> bool:
    """当前手牌是否已听牌（打出 1 张后为 3n+1 听牌态且听口非空）。散手直接返回 False。"""
    if not _can_be_tenpai(len(hand) - 1, exposed_melds):
        return False
    for index in range(len(hand)):
        after = hand[:index] + hand[index + 1:]
        if rules.waiting_tiles(after, exposed_melds):
            return True
    return False


def _discard_quality(hand: list[TileType], index: int, exposed_melds: int,
                     rules: GameRuleSet, visible_tiles=None) -> tuple[bool, int, int, dict | None]:
    """打出某张后的听口质量：(是否听牌, 听口数, 质量分)。散手跳过重计算。"""
    after = hand[:index] + hand[index + 1:]
    if not _can_be_tenpai(len(after), exposed_melds):
        return (False, 0, -1, None)
    progress = _progress(after, exposed_melds, rules, visible_tiles or hand)
    score = (6 - progress['shanten']) * 1000 + progress['ukeire'] * 10 \
        + progress['effectiveRemaining']
    return (progress['shanten'] == 0, len(progress['waits']), score, progress)


def _best_discard_quality(hand: list[TileType], exposed_melds: int,
                          rules: GameRuleSet, visible_tiles=None) -> tuple:
    """当前手牌的最佳弃牌听口质量。"""
    best: tuple = (False, 0, -1, None, None)
    for index in range(len(hand)):
        quality = _discard_quality(hand, index, exposed_melds, rules, visible_tiles)
        candidate = (*quality, hand[index])
        if _better_quality(candidate, best):
            best = candidate
    return best


def _current_tenpai(hand: list[TileType], exposed_melds: int,
                    rules: GameRuleSet, visible_tiles=None) -> tuple:
    """当前手牌（未打出）的听口：直接 waiting_tiles，手牌为 3n+1 听牌态时才计算。"""
    if not _can_be_tenpai(len(hand), exposed_melds):
        return (False, 0, -1, None, None)
    progress = _progress(hand, exposed_melds, rules, visible_tiles or hand)
    score = (6 - progress['shanten']) * 1000 + progress['ukeire'] * 10 \
        + progress['effectiveRemaining']
    return (progress['shanten'] == 0, len(progress['waits']), score, progress, None)


def _better_quality(a: tuple, b: tuple) -> bool:
    if a[0] != b[0]:
        return a[0]
    if a[0] and a[3] is not None and b[3] is not None:
        compared = compare_hand_progress(a[3], b[3])
        if compared:
            return compared > 0
    if not a[0]:
        return False
    return a[2] > b[2]


def decide_claim(view: dict, rule_set: Optional[GameRuleSet] = None) -> str:
    """面对弃牌：能杠必杠；碰需评估碰后听口是否优于现状，不提升则 pass。"""
    rules = rule_set or get_default_rule_set()
    if view['canGang']:
        if not view.get('tile'):
            return 'gang'
        if rules.matching_count(view['hand'], view['tile']) < 3:
            return 'gang'
        baseline = _current_tenpai(view['hand'], view.get('exposedMelds', 0), rules,
                                   view.get('visibleTiles'))
        after_gang = remove_matches(list(view['hand']), view.get('tile'), 3)
        projected = _progress(after_gang, view.get('exposedMelds', 0) + 1,
                              rules, view.get('visibleTiles'))
        if baseline[3] is None or projected['shanten'] <= baseline[3]['shanten'] + 1:
            return 'gang'
    if not view.get('tile'):
        return 'peng'
    if rules.matching_count(view['hand'], view['tile']) < 2:
        return 'pass'
    # 现状：当前手牌（未碰）的听口（13 张 exposed=0 / 10 张 exposed=1 为听牌态）
    baseline = _current_tenpai(view['hand'], view.get('exposedMelds', 0), rules,
                               view.get('visibleTiles'))
    after_peng = remove_matches(list(view['hand']), view['tile'], 2)
    if not after_peng:
        return 'pass'
    after_quality = _best_discard_quality(after_peng, view.get('exposedMelds', 0) + 1,
                                          rules, view.get('visibleTiles'))
    if not _better_quality(after_quality, baseline):
        return 'pass'
    # 碰后若最佳动作是把手中第 3 张同牌原样打回，大明杠以同等结构额外获得
    # 杠分和尾牌补摸，严格支配该碰法。
    if view.get('canGang') and after_quality[4] == view.get('tile'):
        return 'gang'
    return 'peng'


def decide_rob_kong(_view: dict) -> str:
    """面对加杠：当前 AI 能抢必抢；未来可按听牌风险权衡后返回 'pass'。"""
    return 'win'


def _feed_risk(tile: TileType, context: dict) -> float:
    match = _SUITED_RE.match(tile)
    risk = 0.0
    own = context.get('playerIndex', -1)
    for index, peer in enumerate(context.get('peers') or []):
        if index == own:
            continue
        melds = peer.get('melds', []) if isinstance(peer, dict) else getattr(peer, 'melds', [])
        discards = peer.get('discards', []) if isinstance(peer, dict) else getattr(peer, 'discards', [])
        melds = [meld for meld in melds
                 if (meld.get('type') if isinstance(meld, dict) else getattr(meld, 'type', '')) != 'flower']
        if not melds:
            continue
        risk += len(melds) * 2
        if match:
            suit = match.group(1)
            same_suit = sum(1 for meld in melds
                            if (meld.get('tile') if isinstance(meld, dict) else getattr(meld, 'tile', ''))[0] == suit)
            off_suit = sum(1 for discard in discards
                           if _SUITED_RE.match(discard) and discard[0] != suit)
            risk += same_suit * 3 + min(3, off_suit)
        if tile in discards:
            risk = max(0, risk - 2)
    if context.get('wallCount', 99) <= 16:
        risk *= 1.5
    return risk


def choose_discard_index(
    hand: list[TileType],
    random=None,
    rule_set: Optional[GameRuleSet] = None,
    exposed_melds: int = 0,
    context: Optional[dict] = None,
) -> int:
    """弃牌启发式：优先打掉「孤张」——同牌少、无相邻靠张的牌；
    白板（癞子）加罚分保手。有 exposed_melds 时叠加听口质量：
    打出后听口越多越后打，已听牌优先保留。random 注入以便测试确定化。

    分数 = 同牌数×4 + 相邻靠张数×2 + 白板罚分10 + 随机抖动 - 听口加分，取最小者。
    """
    rules = rule_set or get_default_rule_set()
    context = context or {}
    _rand = random if random is not None else _random.random
    preliminary = []
    for index, tile in enumerate(hand):
        same = rules.matching_count(hand, tile) - 1
        neighbors = 0
        match = _SUITED_RE.match(tile)
        if match:
            suit, rank_s = match.groups()
            number = int(rank_s)
            if f'{suit}{number - 1}' in hand:
                neighbors += 1
            if f'{suit}{number + 1}' in hand:
                neighbors += 1
        ordinary_singleton_honor = (rules.code in ('lotus-classic', 'lianhua_guangma') and same == 0
                                    and tile in ('east', 'south', 'west', 'north', 'green'))
        penalty = 10 if tile == 'white' else -6 if ordinary_singleton_honor else 0
        base = same * 4 + neighbors * 2 + penalty + _rand()
        risk = _feed_risk(tile, context)
        preliminary.append((base + risk, index, tile))
    structural = _can_be_tenpai(len(hand) - 1, exposed_melds)
    if structural:
        visible = context.get('visibleTiles')
        if visible is None:
            visible = hand
        visible_counts = {tile: visible.count(tile) for tile in set(visible)}
        seen = set()
        ready = []
        for shape, index, tile in preliminary:
            if tile in seen:
                continue
            seen.add(tile)
            after = hand[:index] + hand[index + 1:]
            waits = rules.waiting_tiles(after, exposed_melds)
            if not waits:
                continue
            remaining = sum(max(0, 4 - visible_counts.get(wait, 0)) for wait in set(waits))
            if remaining > 0:
                ready.append((remaining, len(waits), shape, index, tile))
        if ready:
            ordinary = [item for item in ready if item[4] != 'white']
            choices = ordinary or ready
            choices.sort(key=lambda item: (-item[0], -item[1], item[2], item[3]))
            return choices[0][3]
    shortlist = set()
    shortlisted_tiles = set()
    for _, index, tile in sorted(preliminary):
        if tile in shortlisted_tiles:
            continue
        shortlisted_tiles.add(tile)
        shortlist.add(index)
        if len(shortlist) >= 2:
            break
    scored = []
    for base, index, _tile in preliminary:
        if index not in shortlist or not structural or context.get('wallCount', 60) > 60:
            scored.append((base, index))
            continue
        _, _, _, progress = _discard_quality(
            hand, index, exposed_melds, rules, context.get('visibleTiles') or hand)
        progress_score = (6 - progress['shanten']) * 10_000 \
            + progress['ukeire'] * 100 + progress['effectiveRemaining'] * 10 if progress else 0
        scored.append((base - progress_score, index))
    # 稳定排序：同分保持原手牌顺序（与 TS 端 Array.sort 一致）
    scored.sort(key=lambda pair: pair[0])
    return scored[0][1] if scored else 0


def make_turn_view(player: GamePlayer, exposed_melds: int, kong_bloom: bool) -> dict:
    """构造 AI 回合决策快照，只暴露决策需要的只读信息。"""
    return {
        'hand': player.hand,
        'melds': player.melds,
        'exposedMelds': exposed_melds,
        'kongBloom': kong_bloom,
    }
