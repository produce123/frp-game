"""候选枚举 + 引擎特征 + 确定性引擎建议 —— §4/§5（Python 侧，对齐前端 candidates.ts）。

输入为 PlayerController 上下文（Pydantic 模型，含局况/可见/版本元数据）；
输出规范 DecisionRequest（dict），LLM 只能从候选编号中选择。
"""

import re
from typing import Optional

from app.core.actions import remove_matches
from app.core.kong_projection import has_ready_discard, project_kong_bloom
from app.core.ai import decide_claim as core_decide_claim
from app.core.ai import decide_turn as core_decide_turn
from app.core.lotus_ai import decide_claim as lotus_decide_claim
from app.core.lotus_ai import decide_turn as lotus_decide_turn
from app.core.lotus_ai import choose_discard_index as lotus_choose_discard_index
from app.core.lotus_rules import evaluate_pattern
from app.core.opponent_pattern_risk import (RISK_TIER_LABELS, max_opponent_risk_tier,
                                            opponent_pattern_feature,
                                            opponent_risk_profiles)
from app.llm.schema import canonical_action, rule_code_for, tile_name
from app.rules.base import GameRuleSet
from app.settlement import settlement_service
from app.core.hand_progress import compare_hand_progress, evaluate_hand_progress

_SUITED_RE = re.compile(r'^([mps])([1-9])$')

# 进张/听口清单最多保留几张（2026-09-17 瘦身，与前端 candidates.ts 的 TOP_TILES 一致）。
_TOP_TILES = 6


def _trim_tiles(items: list) -> list:
    """按剩余张数降序取前 N 张；完整条数由调用方另存 effectiveTotal / waitsTotal。"""
    return sorted(items, key=lambda item: item.get('remaining', 0), reverse=True)[:_TOP_TILES]


def _g(ctx, name, default=None):
    """上下文主体是 pydantic 模型，peers/snapshots 等嵌套公开视图允许为 dict。"""
    if ctx is None:
        return default
    if isinstance(ctx, dict):
        return ctx.get(name, default)
    return getattr(ctx, name, default)


def _counts(tiles: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for tile in tiles:
        counts[tile] = counts.get(tile, 0) + 1
    return counts


def _remaining(ctx, tile: str) -> int:
    visible = _g(ctx, 'visibleTiles') or []
    return max(0, 4 - sum(1 for t in visible if t == tile))


def _safety_band(ctx, tile: str) -> str:
    upper = _g(ctx, 'upperLastDiscard') or _g(ctx, 'upper_last_discard')
    if upper == tile:
        return '高'
    public = _g(ctx, 'publicTiles') or []
    count = sum(1 for t in public if t == tile)
    return '高' if count >= 2 else '中' if count == 1 else '低'


def _joker_tiles(ctx, rules: GameRuleSet) -> list[str]:
    """当前规则的万能牌面；广麻固定白板，莲花读取本局双精牌。"""
    if rules.code == 'lotus-legacy':
        configured = list(_g(ctx, 'jokers') or [])
        if configured:
            return configured
        round_state = getattr(rules, 'round_state', None)
        return list(getattr(round_state, 'jokers', []) or [])
    return ['white'] if rules.code == 'lianhua_guangma' else []


def _opponent_risk_profiles(ctx, rules: GameRuleSet) -> list:
    """对手牌型风险的公共信息输入：只取其他座位的牌河 / 副露 / 已胡次数 / 锁手。

    与前端 candidates.ts 的 ``opponentRiskProfilesOf`` 同口径：广麻（lotus-classic）
    没有普通点炮 → 恒为空，候选不产出对手风险定价。
    """
    if rule_code_for(rules.code) == 'lotus-classic':
        return []
    peers = list(_g(ctx, 'peers') or [])
    own = _g(ctx, 'playerIndex', 0) or 0
    opponents = []
    for index, peer in enumerate(peers):
        if index == own:
            continue
        opponents.append({
            'discards': list(_g(peer, 'discards') or []),
            'melds': list(_g(peer, 'melds') or []),
            'winCount': _g(peer, 'winCount', 0) or 0,
            'locked': bool(_g(peer, 'locked', False)),
        })
    if not opponents:
        return []
    return opponent_risk_profiles(opponents, _g(ctx, 'wallCount', 99) or 99)


def _protected_discard_tiles(ctx, rules: GameRuleSet) -> set[str]:
    """LLM 默认必须保留的牌：广麻白板；莲花双精牌（非精白板参与评估）。"""
    protected = set(_joker_tiles(ctx, rules))
    return protected


def _heuristic_score(hand: list[str], tile: str, protected: set[str],
                     classic: bool = False) -> int:
    same = sum(1 for t in hand if t == tile) - 1
    match = _SUITED_RE.match(tile)
    neighbors = 0
    if match:
        suit, rank_s = match.groups()
        rank = int(rank_s)
        if f'{suit}{rank - 1}' in hand:
            neighbors += 1
        if f'{suit}{rank + 1}' in hand:
            neighbors += 1
    ordinary_singleton_honor = (classic and same == 0
                                and tile in ('east', 'south', 'west', 'north', 'green'))
    honor = -6 if ordinary_singleton_honor else 0 if match else 6
    # 数值越低越适合打出；癞子/精牌给高额保留惩罚，作为候选兜底保护。
    wildcard_penalty = 100 if tile in protected else 0
    return same * 4 + neighbors * 2 + honor + wildcard_penalty


def _waits(ctx, hand: list[str], rules: GameRuleSet,
           exposed_melds: Optional[int] = None) -> list[str]:
    return list(rules.waiting_tiles(
        hand, ctx.exposedMelds if exposed_melds is None else exposed_melds))


def _quality(ctx, after: list[str], rules: GameRuleSet,
             exposed_melds: Optional[int] = None) -> dict:
    exposed = ctx.exposedMelds if exposed_melds is None else exposed_melds
    wildcard_tiles = _joker_tiles(ctx, rules)
    if rules.code == 'lotus-legacy':
        wildcard_tiles = [*wildcard_tiles, 'white']
    progress = evaluate_hand_progress(
        after, exposed,
        lambda hand, melds: _waits(ctx, hand, rules, melds),
        wildcard_tiles, list(_g(ctx, 'visibleTiles') or ctx.hand),
        special_hands=rules.code == 'lotus-legacy')
    return {'ready': progress['shanten'] == 0, 'waits': progress['waits'],
            'effectiveRemaining': progress['effectiveRemaining'], 'progress': progress}


def _special_pattern(ctx, hand: list[str], waits: list[str], rules: GameRuleSet) -> str:
    """只标记规则引擎已确认的一听特殊牌型，避免用近似距离误导模型。"""
    if rules.code != 'lotus-legacy' or ctx.exposedMelds > 0 or not waits:
        return 'none'
    jokers = _joker_tiles(ctx, rules)
    labels: list[str] = []
    for wait in waits:
        result = evaluate_pattern([*hand, wait], ctx.exposedMelds, jokers)
        if result and result['pattern'] != 'pinghu':
            label = f'{result["label"]}听牌'
            if label not in labels:
                labels.append(label)
    return '、'.join(labels) if labels else 'none'


def _is_tenpai(ctx, hand: list[str], rules: GameRuleSet) -> bool:
    if rules.code == 'lotus-legacy':
        return has_ready_discard(hand, ctx.exposedMelds, _joker_tiles(ctx, rules))
    return any(_waits(ctx, hand[:idx] + hand[idx + 1:], rules)
               for idx in range(len(hand)))


def _kong_delta(ctx, action: dict, rules: GameRuleSet) -> Optional[int]:
    """杠分（即时收益）：SettlementService 结算器在克隆分数上计算。"""
    players = _g(ctx, 'players')
    scores = _g(ctx, 'scores') or ([p.score for p in players] if players else [])
    if not scores:
        return None
    kind = action['kind']
    type_ = 'concealed' if kind in ('concealed-kong', 'wind-kong') else (
        'added' if kind == 'added-kong' else 'discard')
    player_index = _g(ctx, 'playerIndex', 0) or 0
    count = len(scores)
    from_index = _g(ctx, 'from') if kind in ('gang', 'added-kong') else None
    result = settlement_service.calculate_kong(
        count, player_index, type_, rules.base_score, from_index)
    delta = sum(d['amount'] for d in result.as_list() if d['playerIndex'] == player_index)
    if delta <= 0:
        return None
    return delta


def _apply_kong_delta(feat: dict, ctx, action: dict, rules: GameRuleSet) -> None:
    delta = _kong_delta(ctx, action, rules)
    if delta is not None:
        feat['scoreDelta'] = delta
        feat['scoreDeltaBand'] = '高' if delta >= 400 else '中'


def _features_of(ctx, action: dict, efficiency: str, rules: GameRuleSet) -> dict:
    feat = {
        'shanten': 'n/a', 'ukeire': 'n/a', 'effectiveTiles': 'n/a',
        'ready': 'unknown', 'waits': 'n/a', 'effectiveRemaining': 'n/a',
        'specialPattern': 'n/a', 'safety': 'unknown', 'efficiency': efficiency,
        'risks': [],
    }
    kind = action['kind']
    if kind == 'discard':
        discarded = ctx.hand[action['handIndex']]
        after = ctx.hand[:action['handIndex']] + ctx.hand[action['handIndex'] + 1:]
        quality = _quality(ctx, after, rules)
        ready, waits, effective = quality['ready'], quality['waits'], quality['effectiveRemaining']
        feat['shanten'] = quality['progress']['shanten']
        feat['ukeire'] = quality['progress']['ukeire']
        # 进张/听口清单瘦身（2026-09-17，与前端 candidates.ts 同口径）：只保留张数最多的前 6 张，
        # 完整条数另存 effectiveTotal / waitsTotal。完整枚举是候选块最大的篇幅来源。
        feat['effectiveTiles'] = _trim_tiles([
            {'tile': tile_name(item['tile']), 'remaining': item['remaining']}
            for item in quality['progress']['effectiveTiles']])
        feat['effectiveTotal'] = len(quality['progress']['effectiveTiles'])
        feat['ready'] = ready
        feat['waits'] = _trim_tiles([{'tile': tile_name(t), 'remaining': _remaining(ctx, t)}
                                     for t in waits]) if ready else 'n/a'
        if ready and len(waits) > _TOP_TILES:
            feat['waitsTotal'] = len(waits)
        feat['effectiveRemaining'] = effective if ready else 'n/a'
        feat['specialPattern'] = _special_pattern(ctx, after, waits, rules)
        feat['safety'] = _safety_band(ctx, discarded) if rules.code == 'lotus-legacy' else 'n/a'
        # 对手牌型风险定价：同一张牌打给在做大牌的对手，赔付可能高 8~32 倍（档位版，只用公共牌）。
        profiles = _opponent_risk_profiles(ctx, rules)
        if profiles:
            risk = opponent_pattern_feature(
                profiles, list(_g(ctx, 'visibleTiles') or ctx.hand), discarded)
            if risk is not None:
                feat['opponentRisk'] = {'tier': risk.tier, 'payment': risk.payment,
                                        'signals': list(risk.signals)}
        if discarded in _protected_discard_tiles(ctx, rules):
            feat['risks'].append('癞子/精牌，通常必须保留；当前无普通牌可打')
        return feat
    if kind in ('peng', 'chi'):
        after = _remove_claimed(ctx, action)
        best = _best_quality(ctx, after, ctx.exposedMelds + 1, rules)
        if best is not None:
            ready, waits, effective = best['ready'], best['waits'], best['effectiveRemaining']
            feat['shanten'] = best['progress']['shanten']
            feat['ukeire'] = best['progress']['ukeire']
            feat['effectiveTiles'] = _trim_tiles([
                {'tile': tile_name(item['tile']), 'remaining': item['remaining']}
                for item in best['progress']['effectiveTiles']])
            feat['effectiveTotal'] = len(best['progress']['effectiveTiles'])
            feat['ready'] = ready
            feat['waits'] = _trim_tiles([{'tile': tile_name(t), 'remaining': _remaining(ctx, t)}
                                         for t in waits]) if ready else 'n/a'
            if ready and len(waits) > _TOP_TILES:
                feat['waitsTotal'] = len(waits)
            feat['effectiveRemaining'] = effective if ready else 'n/a'
        baseline = _best_quality(ctx, ctx.hand, ctx.exposedMelds, rules)
        feat['safety'] = _safety_band(ctx, ctx.tile) if ctx.tile else 'unknown'
        if best and baseline and compare_hand_progress(best['progress'], baseline['progress']) > 0:
            feat['efficiency'] = '优'
        elif best and baseline and compare_hand_progress(best['progress'], baseline['progress']) == 0:
            feat['efficiency'] = '中'
        else:
            feat['efficiency'] = '差'
        return feat
    if kind in ('added-kong', 'concealed-kong', 'wind-kong'):
        feat['ready'] = 'unknown'
        feat['specialPattern'] = 'none'
        risks = []
        if _is_tenpai(ctx, ctx.hand, rules):
            risks.append('可能破坏听牌')
        if kind == 'added-kong':
            meld = ctx.melds[action['meldIndex']]
            public = _g(ctx, 'publicTiles') or []
            if sum(1 for t in public if t == meld.tile) == 0:
                tier = max_opponent_risk_tier(_opponent_risk_profiles(ctx, rules))
                risks.append(
                    f'被抢杠概率较高，且对手疑似大牌（{RISK_TIER_LABELS[tier]}档），'
                    '抢杠赔付远高于平胡' if tier >= 2 else '被抢杠概率较高')
        feat['risks'] = risks
        _apply_kong_delta(feat, ctx, action, rules)
        return feat
    if kind == 'gang':
        feat['ready'] = 'unknown'
        feat['safety'] = _safety_band(ctx, ctx.tile) if ctx.tile else 'unknown'
        feat['risks'] = ['碰/杠可能破坏听牌'] if _is_tenpai(ctx, ctx.hand, rules) else []
        _apply_kong_delta(feat, ctx, action, rules)
        return feat
    # pass
    feat['safety'] = 'n/a'
    return feat


def _remove_claimed(ctx, action: dict) -> list[str]:
    if action['kind'] == 'peng':
        if not ctx.tile:
            return list(ctx.hand)
        removed = 0
        result = []
        for tile in ctx.hand:
            if tile == ctx.tile and removed < 2:
                removed += 1
                continue
            result.append(tile)
        return result
    options = list(_g(ctx, 'chiOptions') or _g(ctx, 'chi_options') or [])
    if action['optionIndex'] >= len(options):
        return list(ctx.hand)
    meld = options[action['optionIndex']]
    meld_tiles = meld.get('tiles') if isinstance(meld, dict) else list(meld.tiles)
    remaining = list(ctx.hand)
    for tile in meld_tiles:
        if tile == ctx.tile:
            continue
        if tile in remaining:
            remaining.remove(tile)
    return remaining


def _best_quality(ctx, hand: list[str], exposed_melds: int, rules: GameRuleSet):
    best = None
    for index in range(len(hand)):
        after = hand[:index] + hand[index + 1:]
        quality = {
            **_quality(ctx, after, rules, exposed_melds),
            'discardedTile': hand[index],
            'discardIndex': index,
        }
        if best is None or compare_hand_progress(quality['progress'], best['progress']) > 0:
            best = quality
    return best


def _peng_would_discard_claimed_tile(ctx, rules: GameRuleSet) -> bool:
    if not _g(ctx, 'tile'):
        return False
    after_peng = _remove_claimed(ctx, canonical_action('peng'))
    best = _best_quality(ctx, after_peng, ctx.exposedMelds + 1, rules)
    return bool(best and best['discardedTile'] == ctx.tile)


def _banded_efficiency(scores: list[dict]) -> dict[int, str]:
    """候选集内确定性相对档位（§5：优/中/差）。"""
    ordered = sorted(scores, key=lambda item: item['heuristic'])
    bands: dict[int, str] = {}
    total = len(ordered)
    for rank, item in enumerate(ordered):
        fraction = 0.0 if total <= 1 else rank / (total - 1)
        bands[item['index']] = '优' if fraction <= 0.34 else '中' if fraction <= 0.67 else '差'
    return bands


def _turn_candidates(ctx, rules: GameRuleSet) -> list[dict]:
    candidates: list[dict] = []
    skip_draw = bool(_g(ctx, 'skipDraw'))
    current_ready = rules.code == 'lotus-legacy' and _is_tenpai(ctx, ctx.hand, rules)
    jokers = _joker_tiles(ctx, rules)
    if not skip_draw:
        for meld_index, meld in enumerate(ctx.melds):
            if getattr(meld, 'type', None) == 'peng' and rules.can_added_kong(ctx.hand, ctx.melds, meld.tile):
                candidates.append({
                    'id': f'K{meld_index + 1}', 'label': f"补杠{tile_name(meld.tile)}",
                    'action': canonical_action('added-kong', meldIndex=meld_index),
                    'features': _features_of(ctx, canonical_action('added-kong', meldIndex=meld_index), '中', rules),
                    'legalityKey': f'added-kong:{meld_index}',
                })
        for tile in rules.concealed_kongs(ctx.hand):
            guaranteed = rules.code == 'lotus-legacy' and project_kong_bloom(
                kind='concealed-kong', hand=ctx.hand,
                exposed_melds=ctx.exposedMelds, jokers=jokers, tile=tile,
                visible_tiles=_g(ctx, 'visibleTiles')).guaranteed_kong_bloom
            if not current_ready or guaranteed:
                candidates.append({
                    'id': f'G{tile}', 'label': f"暗杠{tile_name(tile)}",
                    'action': canonical_action('concealed-kong', tile=tile),
                    'features': _features_of(ctx, canonical_action('concealed-kong', tile=tile), '中', rules),
                    'legalityKey': f'concealed-kong:{tile}',
                })
        wind_kong = getattr(rules, 'wind_kong', None)
        if rules.code == 'lotus-legacy' and wind_kong and wind_kong(ctx.hand):
            guaranteed = project_kong_bloom(
                kind='wind-kong', hand=ctx.hand,
                exposed_melds=ctx.exposedMelds, jokers=jokers,
                visible_tiles=_g(ctx, 'visibleTiles')).guaranteed_kong_bloom
            if not current_ready or guaranteed:
                candidates.append({
                    'id': 'GW', 'label': '乱风杠',
                    'action': canonical_action('wind-kong'),
                    'features': _features_of(ctx, canonical_action('wind-kong'), '中', rules),
                    'legalityKey': 'wind-kong',
                })
    protected = _protected_discard_tiles(ctx, rules)
    has_natural_discard = any(tile not in protected for tile in ctx.hand)
    seen: set[str] = set()
    discard_entries = []
    for hand_index, tile in enumerate(ctx.hand):
        # 策略硬约束：只要还有普通牌，就不把癞子/精牌交给 LLM 选择。
        # 全手只剩受保护牌时才放开，避免生成空候选导致回合卡死。
        if has_natural_discard and tile in protected:
            continue
        if tile in seen:
            continue
        seen.add(tile)
        action = canonical_action('discard', handIndex=hand_index)
        entry_index = len(candidates)
        candidates.append({
            'id': f'A{len(discard_entries) + 1}', 'label': f"出{tile_name(tile)}",
            'action': action,
            'features': {
                'ready': 'unknown', 'waits': 'n/a', 'effectiveRemaining': 'n/a',
                'specialPattern': 'none', 'safety': 'unknown', 'efficiency': '差',
                'risks': [],
            },
            'legalityKey': f'discard:{tile}',
        })
        discard_entries.append({
            'index': entry_index,
            'heuristic': _heuristic_score(ctx.hand, tile, protected,
                                          rule_code_for(rules.code) == 'lotus-classic'),
        })
    bands = _banded_efficiency(discard_entries)
    for candidate in candidates:
        if candidate['action']['kind'] != 'discard':
            continue
        idx_in_candidates = next(i for i, c in enumerate(candidates)
                                 if c['id'] == candidate['id'])
        candidate['features'] = _features_of(ctx, candidate['action'], bands.get(idx_in_candidates, '中'), rules)
    if rule_code_for(rules.code) == 'lotus-classic':
        ordered = _ordered_classic_discards(ctx, candidates, rules)
        for rank, candidate in enumerate(ordered):
            fraction = 0.0 if len(ordered) <= 1 else rank / (len(ordered) - 1)
            candidate['features']['efficiency'] = (
                '优' if fraction <= 0.34 else '中' if fraction <= 0.67 else '差')
    return candidates


def _claim_candidates(ctx, rules: GameRuleSet) -> list[dict]:
    candidates: list[dict] = []
    candidates.append({
        'id': 'Z', 'label': '过', 'action': canonical_action('pass'),
        'features': _features_of(ctx, canonical_action('pass'), 'unknown', rules),
        'legalityKey': 'pass',
    })
    if _g(ctx, 'canGang'):
        candidates.append({
            'id': 'G', 'label': f"大明杠{tile_name(ctx.tile)}",
            'action': canonical_action('gang'),
            'features': _features_of(ctx, canonical_action('gang'), '中', rules),
            'legalityKey': 'gang',
        })
    if _g(ctx, 'canPeng') and not (
            _g(ctx, 'canGang') and _peng_would_discard_claimed_tile(ctx, rules)):
        candidates.append({
            'id': 'P', 'label': f"碰{tile_name(ctx.tile)}",
            'action': canonical_action('peng'),
            'features': _features_of(ctx, canonical_action('peng'), '中', rules),
            'legalityKey': 'peng',
        })
    options = list(_g(ctx, 'chiOptions') or _g(ctx, 'chi_options') or [])
    for option_index, option in enumerate(options):
        option_tiles = option.get('tiles') if isinstance(option, dict) else list(option.tiles)
        candidates.append({
            'id': f'C{option_index + 1}', 'label': f"吃{'+'.join(tile_name(t) for t in option_tiles)}",
            'action': canonical_action('chi', optionIndex=option_index),
            'features': _features_of(ctx, canonical_action('chi', optionIndex=option_index), '中', rules),
            'legalityKey': f'chi:{option_index}',
        })
    return candidates


def _ordered_classic_discards(ctx, candidates: list[dict], rules: GameRuleSet) -> list[dict]:
    protected = _protected_discard_tiles(ctx, rules)

    def number(value, fallback):
        return value if type(value) in (int, float) else fallback

    def key(candidate: dict):
        features = candidate['features']
        index = candidate['action']['handIndex']
        return (number(features.get('shanten'), float('inf')),
                -number(features.get('ukeire'), -1),
                -number(features.get('effectiveRemaining'), -1),
                _heuristic_score(ctx.hand, ctx.hand[index], protected, True), index)

    return sorted((c for c in candidates if c['action']['kind'] == 'discard'), key=key)


def _legacy_early_discard_suggestion(ctx, candidates: list[dict], action: dict) -> dict:
    if action['kind'] != 'discard' or _g(ctx, 'wallCount') is None or ctx.wallCount <= 60:
        return action
    tile = ctx.hand[action['handIndex']]
    baseline = next((c for c in candidates if c['action']['kind'] == 'discard'
                     and ctx.hand[c['action']['handIndex']] == tile), None)
    if baseline is None:
        return action
    base_features = baseline['features']
    shanten, ukeire = base_features.get('shanten'), base_features.get('ukeire')
    if type(shanten) not in (int, float) or type(ukeire) not in (int, float):
        return action

    def safety_rank(features: dict) -> int:
        return {'高': 2, '中': 1, '低': 0}.get(features.get('safety'), -1)

    def risk_payment(features: dict) -> float:
        return (features.get('opponentRisk') or {}).get('payment', 0)

    def risk_tier(features: dict) -> int:
        return {'高': 2, '中': 1, '低': 0}.get(
            (features.get('opponentRisk') or {}).get('tier'), 0)

    alternatives = []
    for candidate in candidates:
        other = candidate['features']
        if candidate['action']['kind'] != 'discard' \
                or type(other.get('shanten')) not in (int, float) \
                or type(other.get('ukeire')) not in (int, float):
            continue
        improves = (other['shanten'] < shanten
                    or other['shanten'] == shanten and other['ukeire'] > ukeire)
        if (improves and safety_rank(other) >= safety_rank(base_features)
                and risk_payment(other) <= risk_payment(base_features)
                and risk_tier(other) <= risk_tier(base_features)
                and len(other.get('risks') or []) <= len(base_features.get('risks') or [])
                and (base_features.get('specialPattern') == 'none'
                     or other.get('specialPattern') == base_features.get('specialPattern'))):
            alternatives.append(candidate)
    alternatives.sort(key=lambda c: (c['features']['shanten'], -c['features']['ukeire'],
                                      -safety_rank(c['features']), c['action']['handIndex']))
    return alternatives[0]['action'] if alternatives else baseline['action']


def inferior_classic_discard(request: dict, selected: dict) -> bool:
    if request.get('ruleCode') != 'lotus-classic' or request.get('decision') != 'turn' \
            or selected['action']['kind'] != 'discard' or not request.get('engineSuggestion'):
        return False
    recommended = next((c for c in request['candidates']
                        if c['id'] == request['engineSuggestion']), None)
    if recommended is None or recommended['action']['kind'] != 'discard':
        return False
    chosen = selected['features']
    suggested = recommended['features']
    values = (chosen.get('shanten'), suggested.get('shanten'),
              chosen.get('ukeire'), suggested.get('ukeire'))
    return (all(type(value) in (int, float) for value in values)
            and values[0] > values[1] and values[2] <= values[3])


def _suggestion_turn(ctx, rules: GameRuleSet, candidates: list[dict]) -> Optional[dict]:
    """确定性引擎建议（random=0）：胡由控制器短路，建议只在杠/弃牌候选中。"""
    if _g(ctx, 'skipDraw', False):
        if rules.code != 'lotus-legacy':
            ordered = _ordered_classic_discards(ctx, candidates, rules)
            return ordered[0]['action'] if ordered else None
        index = lotus_choose_discard_index(
            ctx.hand, list(_g(ctx, 'jokers') or []), random=lambda: 0.0,
            options={'exposedMelds': ctx.exposedMelds,
                     'visibleTiles': _g(ctx, 'visibleTiles'),
                     'publicTiles': _g(ctx, 'publicTiles'),
                     'upperLastDiscard': _g(ctx, 'upperLastDiscard'),
                     'earlyRound': _g(ctx, 'earlyRound'),
                     'wallCount': _g(ctx, 'wallCount'), 'melds': ctx.melds})
        tile = ctx.hand[index]
        suggested = next((c['action'] for c in candidates if c['action']['kind'] == 'discard'
                          and ctx.hand[c['action']['handIndex']] == tile), None)
        if suggested is None:
            suggested = next((c['action'] for c in candidates
                              if c['action']['kind'] == 'discard'), None)
        return _legacy_early_discard_suggestion(ctx, candidates, suggested) if suggested else None
    view = {
        'hand': ctx.hand,
        'melds': ctx.melds,
        'exposedMelds': ctx.exposedMelds,
        'kongBloom': _g(ctx, 'kongBloom', False),
    }
    if rules.code == 'lotus-legacy':
        view.update({
            'jokers': list(_g(ctx, 'jokers') or []),
            'visibleTiles': _g(ctx, 'visibleTiles'),
            'publicTiles': _g(ctx, 'publicTiles'),
            'upperLastDiscard': _g(ctx, 'upperLastDiscard') or _g(ctx, 'upper_last_discard'),
            'earlyRound': _g(ctx, 'earlyRound'),
            'wallCount': _g(ctx, 'wallCount'),
            '_random': lambda: 0.0,
        })
        decision = lotus_decide_turn(view, list(_g(ctx, 'jokers') or []), rules)
        return None if decision['kind'] == 'win' else _legacy_early_discard_suggestion(
            ctx, candidates, decision)
    else:
        decision = core_decide_turn(view, rules, random=lambda: 0.0)
    if decision['kind'] == 'win':
        return None
    if decision['kind'] != 'discard':
        return decision
    ordered = _ordered_classic_discards(ctx, candidates, rules)
    return ordered[0]['action'] if ordered else decision


def _suggestion_claim(ctx, rules: GameRuleSet) -> Optional[dict]:
    if rules.code == 'lotus-legacy':
        decision = lotus_decide_claim({
            'hand': ctx.hand,
            'exposedMelds': ctx.exposedMelds,
            'jokers': list(_g(ctx, 'jokers') or []),
            'tile': ctx.tile,
            'canGang': bool(_g(ctx, 'canGang')),
            'canPeng': bool(_g(ctx, 'canPeng')),
            'chiOptions': list(_g(ctx, 'chiOptions') or _g(ctx, 'chi_options') or []),
            'visibleTiles': _g(ctx, 'visibleTiles'),
            'publicTiles': _g(ctx, 'publicTiles'),
            'upperLastDiscard': _g(ctx, 'upperLastDiscard') or _g(ctx, 'upper_last_discard'),
            'earlyRound': _g(ctx, 'earlyRound'),
            'wallCount': _g(ctx, 'wallCount'),
        })
        if decision['kind'] == 'chi':
            # 规范动作：吃用 optionIndex；这里映射回索引
            options = list(_g(ctx, 'chiOptions') or _g(ctx, 'chi_options') or [])
            for index, option in enumerate(options):
                cand = option.get('tiles') if isinstance(option, dict) else list(option.tiles)
                if list(cand) == list(decision['meld'].get('tiles') or getattr(decision['meld'], 'tiles', [])):
                    return canonical_action('chi', optionIndex=index)
            return canonical_action('pass')
        return canonical_action(decision['kind'])
    decision = core_decide_claim({
        'hand': ctx.hand,
        'canGang': bool(_g(ctx, 'canGang')),
        'tile': ctx.tile,
        'from': _g(ctx, 'from'),
        'exposedMelds': _g(ctx, 'exposedMelds', 0),
    }, rules)
    return canonical_action(decision)


def _snapshot(ctx, request_id: str, state_version: str, rules: GameRuleSet,
              decision: str) -> dict:
    from app.llm.schema import TILE_NAMES
    peers = list(_g(ctx, 'peers') or [])
    player_index = _g(ctx, 'playerIndex', 0) or 0

    def relative_source(from_index) -> str | None:
        if from_index is None:
            return None
        distance = (int(from_index) - player_index) % 4
        return '上家' if distance == 3 else '对家' if distance == 2 else '下家' if distance == 1 else None

    def rel(offset: int) -> dict:
        index = (player_index + offset) % 4
        peer = peers[index] if index < len(peers) else None
        discards = list(_g(peer, 'discards') or [])
        melds = list(_g(peer, 'melds') or [])
        return {
            'discards': [tile_name(t) for t in discards],
            'melds': [{'type': _muld_type(m), 'tile': tile_name(_muld_tile(m)),
                       'tiles': [tile_name(t) for t in _muld_tiles(m)]} for m in melds],
        }

    jokers = _joker_tiles(ctx, rules)
    wall_count = int(_g(ctx, 'wallCount') or 0)
    raw_dealer_index = _g(ctx, 'dealerIndex')
    dealer_index = int(raw_dealer_index) if raw_dealer_index is not None else -1
    own_melds = list(_g(ctx, 'melds') or [])
    return {
        'schemaVersion': 1, 'requestId': request_id, 'stateVersion': state_version,
        'ruleCode': rule_code_for(rules.code), 'decision': decision,
        'hand': [tile_name(t) for t in ctx.hand],
        'turnOrigin': 'claim-response' if decision == 'claim' else (_g(ctx, 'turnOrigin') or 'draw'),
        'drawnTile': tile_name(_g(ctx, 'drawnTile')) if _g(ctx, 'drawnTile') else None,
        'claimTile': tile_name(_g(ctx, 'tile')) if decision == 'claim' and _g(ctx, 'tile') else None,
        'claimFrom': relative_source(_g(ctx, 'from_')) if decision == 'claim' else None,
        'melds': [{'type': _muld_type(m), 'tile': tile_name(_muld_tile(m)),
                   'tiles': [tile_name(t) for t in _muld_tiles(m)]} for m in own_melds],
        'snapshots': {'self': rel(0), 'upper': rel(-1), 'opposite': rel(2), 'lower': rel(1)},
        'upperLastDiscard': tile_name(_g(ctx, 'upperLastDiscard')) if _g(ctx, 'upperLastDiscard') else None,
        'jokerTiles': [tile_name(t) for t in jokers],
        'wildcardTiles': [tile_name('white')] if rules.code == 'lotus-legacy' else [],
        'wallCount': wall_count,
        'earlyRound': bool(_g(ctx, 'earlyRound')),
        'lateGame': wall_count <= 8,
        'scores': list(_g(ctx, 'scores') or []),
        'seatWind': _g(ctx, 'seatWind') or '',
        'roundWind': _g(ctx, 'roundWind') or '',
        'dealerIndex': dealer_index,
        'isDealer': dealer_index >= 0 and player_index == dealer_index,
        'roundIndex': int(_g(ctx, 'roundIndex') or 0),
        'dihu': bool(_g(ctx, 'dihu')),
    }


def _muld_type(meld) -> str:
    return getattr(meld, 'type', None) or (meld.get('type') if isinstance(meld, dict) else '')


def _muld_tile(meld) -> str:
    return getattr(meld, 'tile', None) or (meld.get('tile') if isinstance(meld, dict) else '')


def _muld_tiles(meld) -> list:
    tiles = getattr(meld, 'tiles', None)
    if tiles is None and isinstance(meld, dict):
        tiles = meld.get('tiles')
    return list(tiles or [])


def build_request(ctx, rules: GameRuleSet, request_id: str, state_version: str,
                  decision: str) -> Optional[dict]:
    """构建规范 DecisionRequest；无候选（无需 LLM）时返回 None。

    返回结构：{request, fallbackAction, engineSuggestion}。
    """
    candidates = _turn_candidates(ctx, rules) if decision == 'turn' else _claim_candidates(ctx, rules)
    if not candidates:
        return None
    suggestion = _suggestion_turn(ctx, rules, candidates) if decision == 'turn' else _suggestion_claim(ctx, rules)
    suggestion_id = None
    fallback = candidates[0]['action']
    if suggestion is not None:
        for candidate in candidates:
            if _actions_match(candidate['action'], suggestion):
                suggestion_id = candidate['id']
                fallback = candidate['action']
                break
    return {
        'request': {
            'schemaVersion': 1, 'requestId': request_id, 'stateVersion': state_version,
            'ruleCode': rule_code_for(rules.code), 'decision': decision,
            'state': _snapshot(ctx, request_id, state_version, rules, decision),
            'candidates': candidates,
            'engineSuggestion': suggestion_id,
        },
        'fallbackAction': fallback,
        'engineSuggestion': suggestion_id,
    }


def _actions_match(a: dict, b: dict) -> bool:
    if a['kind'] != b['kind']:
        return False
    if a['kind'] == 'added-kong':
        return a.get('meldIndex') == b.get('meldIndex')
    if a['kind'] == 'concealed-kong':
        return a.get('tile') == b.get('tile')
    if a['kind'] == 'chi':
        return a.get('optionIndex') == b.get('optionIndex')
    if a['kind'] == 'discard':
        return a.get('handIndex') == b.get('handIndex')
    return True


# settlement_service 引用（manager 使用同一个服务实例；此处仅需要计算器纯函数）
from app.settlement import settlement_service as _ss  # noqa: E402,F401
