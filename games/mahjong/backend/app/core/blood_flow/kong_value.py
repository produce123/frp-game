"""开杠价值（2026-09-13，对齐前端 src/game/variants/lotus/bloodFlow/kongValue.ts）。

   开杠价值 = 杠收益 − 防守风险 − 自手牌型损失

  · 杠收益：即时杠分（底分 × kong_payments × 付款家数）+ 倍率加成（底分 × kong_bonus × 折算权重）。
  · 防守风险：补杠是血流唯一会把第 4 张亮出去给人抢杠的动作（明杠/暗杠/风杠不可抢）。
  · 自手牌型损失（selfLoss，三项，全部换算成"点"与其它 EV 同口径）：
      ① 七对 / 豪华七对潜力损失：杠会把这门路线的对子拆成副露，七对从此不可能；
      ② 明杠破坏门清平胡的损失：门清平胡（2 番，方案B 兜底本体）要求不副露；
      ③ 向听恶化：含七对/十三幺/十三烂的整车向听，杠后必然有副露，特殊路线随之消失。

净值为正才压过"不杠"（保留手牌继续打）；调用方再与最佳非杠候选（胡/碰/吃/弃牌）比较。
只服务血流本地 AI 与 LLM 候选；经典玩法不注入本钩子，行为完全不变。
"""

from typing import Optional

from app.core.hand_progress import hand_shanten
from app.models.game import TileType

from .config import (BLOOD_FLOW_CONFIG, BLOOD_FLOW_KONG_VALUE, KongValueConfig)

KongValueKind = str

# 与 config.kong_payments / kong_bonus 的键映射（补杠按明杠计：牌面已亮，抢杠可抢）。
_KONG_KEYS: dict[str, dict[str, str]] = {
    'discard-gang': {'payment': 'discard', 'bonus': 'exposed'},
    'added-kong': {'payment': 'added', 'bonus': 'exposed'},
    'concealed-kong': {'payment': 'concealed', 'bonus': 'concealed'},
    'wind-kong': {'payment': 'wind', 'bonus': 'wind'},
}

# 即时杠分的付款家数：大明杠只由打出者付，其余三家各付。
_KONG_PAYERS: dict[str, int] = {
    'discard-gang': 1, 'added-kong': 3, 'concealed-kong': 3, 'wind-kong': 3,
}

_WINDS = ('east', 'south', 'west', 'north')


def wildcard_set(jokers: list[TileType]) -> set[TileType]:
    """精牌（翻精 + 白板）——与 patternPotentials.ts 的 wildcardSet 同口径。"""
    return {*jokers, 'white'}


def _matching_count(tiles: list[TileType], tile: TileType) -> int:
    return sum(1 for item in tiles if item == tile)


def _remove_copies(tiles: list[TileType], tile: TileType, amount: int) -> Optional[list[TileType]]:
    result = list(tiles)
    for _ in range(amount):
        try:
            result.remove(tile)
        except ValueError:
            return None
    return result


def _meld_field(meld, name: str, default=None):
    """melds 可能是 Meld 对象（引擎传入）或 dict（单测传入），兼容两者。"""
    if isinstance(meld, dict):
        return meld.get(name, default)
    return getattr(meld, name, default)


def post_kong_state(kind: str, hand: list[TileType], melds: list,
                    tile: Optional[TileType] = None,
                    meld_index: Optional[int] = None
                    ) -> Optional[dict]:
    """杠后的（手牌、副露）。牌面按实体牌移除（与引擎 perform_kong 同口径）。"""
    result_melds = [dict(m) if isinstance(m, dict) else m for m in melds]
    if kind == 'discard-gang':
        if not tile:
            return None
        post_hand = _remove_copies(hand, tile, 3)
        if post_hand is None:
            return None
        result_melds.append({'type': 'gang', 'tile': tile, 'tiles': [tile] * 4})
        return {'hand': post_hand, 'melds': result_melds}
    if kind == 'concealed-kong':
        if not tile:
            return None
        post_hand = _remove_copies(hand, tile, 4)
        if post_hand is None:
            return None
        result_melds.append({'type': 'angang', 'tile': tile, 'tiles': [tile] * 4})
        return {'hand': post_hand, 'melds': result_melds}
    if kind == 'wind-kong':
        post_hand: Optional[list[TileType]] = list(hand)
        for wind in _WINDS:
            post_hand = _remove_copies(post_hand, wind, 1) if post_hand is not None else None
        if post_hand is None:
            return None
        result_melds.append({'type': 'angang', 'tile': _WINDS[0], 'tiles': list(_WINDS), 'windKong': True})
        return {'hand': post_hand, 'melds': result_melds}
    # added-kong：被补的那副碰
    index = meld_index
    if index is None:
        index = next((i for i, meld in enumerate(result_melds)
                      if _meld_field(meld, 'type') == 'peng' and _meld_field(meld, 'tile') in hand), -1)
    if index < 0 or index >= len(result_melds):
        return None
    meld = result_melds[index]
    meld_tile = _meld_field(meld, 'tile')
    post_hand = _remove_copies(hand, meld_tile, 1)
    if post_hand is None:
        return None
    tiles = [*_meld_field(meld, 'tiles', []), meld_tile]
    if isinstance(meld, dict):
        result_melds[index] = {**meld, 'type': 'gang', 'added': True, 'tiles': tiles}
    else:  # 引擎对象：改为等价的 dict 形态（只用于结构计算，不回写状态）
        result_melds[index] = {'type': 'gang', 'tile': meld_tile, 'added': True, 'tiles': tiles}
    return {'hand': post_hand, 'melds': result_melds}


def _quad_progress(hand: list[TileType], wild: list[TileType]) -> float:
    """豪华七对的"四张"进度：0 = 没有刻子；0.6 = 已有刻子；1 = 已四张或精牌可补成四张。"""
    wild_set = set(wild)
    counts: dict[TileType, int] = {}
    jokers = 0
    for tile in hand:
        if tile in wild_set:
            jokers += 1
        else:
            counts[tile] = counts.get(tile, 0) + 1
    triplet = False
    for count in counts.values():
        if count >= 4:
            return 1.0
        if count == 3:
            triplet = True
    if triplet and jokers >= 1:
        return 1.0
    return 0.6 if triplet else 0.0


def seven_pairs_route_value(hand: list[TileType], melds: list, jokers: list[TileType]) -> float:
    """七对 / 豪华七对路线价值（番 × 接近度²）。任何副露都会让七对不可能，因此副露非空时恒为 0。"""
    if len(melds) > 0:
        return 0.0
    from .ai import _seven_pairs_potential  # 延迟导入：ai.py 在模块级导入本模块（避免循环导入）
    wild = list(wildcard_set(jokers))
    potential = _seven_pairs_potential(list(hand), wild)
    if potential <= 0:
        return 0.0
    pairs = min(1.0, potential / 28)
    luxury = pairs * _quad_progress(hand, wild)
    patterns = BLOOD_FLOW_CONFIG.patterns
    return (patterns['sevenPairs'].weight * pairs ** 2
            + patterns['luxury-seven-pairs'].weight * luxury ** 2)


def _route_shanten(hand: list[TileType], exposed_melds: int, jokers: list[TileType]) -> int:
    """含特殊牌型（七对/十三幺/十三烂）的向听：与 AI 的 evaluate_hand_progress 同口径。"""
    from .ai import waiting_tiles_cached
    return hand_shanten(list(hand), exposed_melds,
                        waiting_fn=lambda tiles, exposed: waiting_tiles_cached(tiles, exposed, list(jokers)),
                        wildcard_tiles=list(wildcard_set(jokers)), special_hands=True)


def _concealed_hand_loss(hand: list[TileType], jokers: list[TileType], config: KongValueConfig) -> float:
    """门清平胡只是"兜底本体"（有别的番种时不算），因此按接近度再折一个兜底价。"""
    shanten = _route_shanten(hand, 0, jokers)
    progress = 1.0 if shanten <= 0 else 0.6 if shanten == 1 else 0.35 if shanten == 2 else 0.15
    return (BLOOD_FLOW_CONFIG.patterns['concealed-hand'].weight * BLOOD_FLOW_CONFIG.base_points
            * progress * config.concealed_hand_fallback)


def kong_gain(kind: str, config: KongValueConfig = BLOOD_FLOW_KONG_VALUE) -> float:
    """杠收益（点）：即时杠分 + 倍率加成折算。"""
    keys = _KONG_KEYS[kind]
    kong_bonus = BLOOD_FLOW_CONFIG.kong_bonus
    return (BLOOD_FLOW_CONFIG.base_points * BLOOD_FLOW_CONFIG.kong_payments[keys['payment']] * _KONG_PAYERS[kind]
            + BLOOD_FLOW_CONFIG.base_points * kong_bonus[keys['bonus']] * config.bonus_weight)


def _rob_kong_risk(public_count: int, config: KongValueConfig) -> float:
    """补杠抢杠风险（点）：未见张最贵，公开越多越安全（与旧 should_take_added_kong 的档位一致）。"""
    factor = 1.0 if public_count <= 0 else 0.35 if public_count == 1 else 0.15
    return config.rob_risk * factor


def kong_self_loss(kind: str, hand: list[TileType], melds: list, jokers: list[TileType],
                   tile: Optional[TileType] = None, meld_index: Optional[int] = None,
                   config: KongValueConfig = BLOOD_FLOW_KONG_VALUE) -> dict:
    """自手牌型损失（三项之和，单位点）。"""
    post = post_kong_state(kind, hand, melds, tile, meld_index)
    reasons: list[str] = []

    # ① 七对 / 豪华七对
    before = seven_pairs_route_value(hand, melds, jokers)
    after = seven_pairs_route_value(post['hand'], post['melds'], jokers) if post else 0.0
    seven_pairs = max(0.0, before - after) * BLOOD_FLOW_CONFIG.base_points
    if seven_pairs > 0:
        reasons.append(f'拆掉七对/豪华七对路线（-{round(seven_pairs)}）')

    # ② 门清（2026-09-15 用户定案后：只有**明杠**会破门清）
    # 暗杠与风杠都取自手牌、都不能被抢杠，规则上保留门清 → 不再计入"破坏门清"的自损；
    # 补杠是碰之后补第 4 张（碰的时候门清早就没了），天然不计。
    breaks_concealed = kind == 'discard-gang'
    exposed_before = len(melds) == 0
    exposed_after = len(post['melds']) > 0 if post else len(melds) > 0
    concealed_hand = (_concealed_hand_loss(hand, jokers, config)
                      if breaks_concealed and exposed_before and exposed_after else 0.0)
    if concealed_hand > 0:
        reasons.append(f'破坏门清（-{round(concealed_hand)}）')

    # ③ 向听恶化（含特殊路线的整车向听）
    shanten_before = _route_shanten(hand, len(melds), jokers)
    shanten_after = _route_shanten(post['hand'], len(post['melds']), jokers) if post else shanten_before
    shanten_step = max(0, shanten_after - shanten_before)
    shanten = shanten_step * config.shanten_step_loss
    if shanten > 0:
        reasons.append(f'向听恶化 {shanten_step} 档（-{round(shanten)}）')

    return {'total': seven_pairs + concealed_hand + shanten, 'sevenPairs': seven_pairs,
            'concealedHand': concealed_hand, 'shanten': shanten, 'reasons': reasons}


def kong_candidate_value(kind: str, hand: list[TileType], melds: list, jokers: list[TileType],
                         tile: Optional[TileType] = None, meld_index: Optional[int] = None,
                         public_tiles: Optional[list[TileType]] = None,
                         config: KongValueConfig = BLOOD_FLOW_KONG_VALUE) -> dict:
    """开杠候选的完整估值：杠收益 − 防守风险 − 自手牌型损失。"""
    gain = kong_gain(kind, config)
    public_count = _matching_count(list(public_tiles or []), tile) if tile else 0
    risk = _rob_kong_risk(public_count, config) if kind == 'added-kong' else 0.0
    self_loss = kong_self_loss(kind, hand, melds, jokers, tile, meld_index, config)
    return {'kind': kind, 'gain': gain, 'risk': risk, 'selfLoss': self_loss,
            'net': gain - risk - self_loss['total']}
