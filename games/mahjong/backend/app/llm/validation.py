"""规范动作合法性校验 —— §8.2 表（控制器侧；引擎执行层还有二次验牌/动作执行校验）。"""

from typing import Optional

from app.core.kong_projection import has_ready_discard, project_kong_bloom
from app.rules.base import GameRuleSet


def _protected_discard_tiles(ctx, rules: GameRuleSet) -> set[str]:
    if rules.code == 'lotus-legacy':
        jokers = list(getattr(ctx, 'jokers', None) or [])
        if not jokers:
            jokers = list(getattr(getattr(rules, 'round_state', None), 'jokers', []) or [])
        return set(jokers)
    return {tile for tile in ctx.hand if rules.is_joker_tile(tile)}


def validate_action(ctx, action: dict, rules: GameRuleSet) -> bool:
    """逐类型校验 LLM 返回的动作；win 只允许引擎短路产生（这里一律拒绝）。"""
    kind = action.get('kind')
    hand = ctx.hand

    if kind == 'discard':
        index = action.get('handIndex')
        if not isinstance(index, int) or not 0 <= index < len(hand):
            return False
        protected = _protected_discard_tiles(ctx, rules)
        # LLM 策略保护：有普通牌可打时，不允许弃掉癞子/精牌；全手均为保护牌时放开。
        return not (hand[index] in protected and any(tile not in protected for tile in hand))
    if kind == 'added-kong':
        index = action.get('meldIndex')
        if not isinstance(index, int) or index < 0 or index >= len(ctx.melds):
            return False
        meld = ctx.melds[index]
        if getattr(meld, 'type', None) != 'peng' or not rules.can_added_kong(hand, ctx.melds, meld.tile):
            return False
        return True
    if kind == 'concealed-kong':
        tile = action.get('tile')
        if tile is None or tile not in rules.concealed_kongs(hand):
            return False
        if rules.code != 'lotus-legacy':
            return True
        jokers = list(getattr(ctx, 'jokers', None)
                      or getattr(rules.round_state, 'jokers', []))
        guaranteed = project_kong_bloom(
            kind='concealed-kong', hand=hand, exposed_melds=ctx.exposedMelds,
            jokers=jokers, tile=tile,
            visible_tiles=getattr(ctx, 'visibleTiles', None)).guaranteed_kong_bloom
        return guaranteed or not has_ready_discard(hand, ctx.exposedMelds, jokers)
    if kind == 'wind-kong':
        wind_kong = getattr(rules, 'wind_kong', None)
        if rules.code != 'lotus-legacy' or wind_kong is None or not wind_kong(hand):
            return False
        jokers = list(getattr(ctx, 'jokers', None)
                      or getattr(rules.round_state, 'jokers', []))
        guaranteed = project_kong_bloom(
            kind='wind-kong', hand=hand, exposed_melds=ctx.exposedMelds,
            jokers=jokers,
            visible_tiles=getattr(ctx, 'visibleTiles', None)).guaranteed_kong_bloom
        return guaranteed or not has_ready_discard(hand, ctx.exposedMelds, jokers)
    if kind == 'gang':
        capabilities = rules.claim_capabilities(hand, ctx.tile) if getattr(ctx, 'tile', None) else None
        return capabilities is not None and capabilities.can_gang
    if kind == 'peng':
        capabilities = rules.claim_capabilities(hand, ctx.tile) if getattr(ctx, 'tile', None) else None
        return capabilities is not None and capabilities.can_peng
    if kind == 'chi':
        option_index = action.get('optionIndex')
        options = list(getattr(ctx, 'chiOptions', None) or getattr(ctx, 'chi_options', None) or [])
        return isinstance(option_index, int) and 0 <= option_index < len(options)
    if kind == 'pass':
        return True
    return False
