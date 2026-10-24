"""兜/弃政策（v3）—— 逐位镜像前端 ``src/game/variants/lotus/bloodFlow/defensePolicy.ts``。

对手已做成/已知在做大牌时，本家「继续走」还是「弃胡兜安全张」。
规则来自用户定稿（2026-09-12）：
  ① 只要能在本巡转成**精吊任意听**就继续走——锁手后每张摸到的牌都能胡、从此永不弃牌，
     等于 100% 不再给对手点炮（engine 锁手家只有「胡」或「摸切」两条路，任意听时永远走胡）。
  ② 未听牌且可达听口过窄 → 立即弃胡：只打最小赔付张、停吃碰杠（本玩法没有查大叫，弃胡无期末代价）。
  ③ 我方上限不低于对手已知/推断的牌型倍率 → 可以赌（继续进攻），不吃亏。

纯函数、确定性；只读本家手牌 + 公共信息，不推断对手暗手。

性能：``own_hand_facts`` 只用「打任意一张是否有听口」（``waiting_tiles_cached``），
**不引入完整向听搜索** —— 前端实测那样会让 12 种子整场从 ~50s 涨到 123s。
"""

from dataclasses import dataclass, field
from typing import Optional, Sequence

from app.core.blood_flow.config import BLOOD_FLOW_CONFIG, BLOOD_FLOW_DEFENSE

# 与前端 defensePolicy.ts 同源的再导出，调用方无需两处 import。
__all__ = [
    'BLOOD_FLOW_DEFENSE_DEFAULT', 'DefenseMode', 'DefensePolicyConfig',
    'DefensePolicyInput', 'DefensePolicyResult', 'OpponentThreatFacts', 'OwnHandFacts',
    'decide_defense_policy', 'multiplier_of_tier', 'own_hand_facts', 'pattern_weight_of',
]

DefenseMode = str                       # 'push' | 'fold' | 'normal'

BLOOD_FLOW_DEFENSE_DEFAULT = BLOOD_FLOW_DEFENSE


@dataclass(frozen=True)
class OwnHandFacts:
    """本家手牌的兜/弃相关事实（打某张后的听口宽度、是否可及任意听、番型上限）。"""
    # 本巡打出某一张后能否进入听牌态（等价于「是否存在一张弃牌让听口非空」）。
    # False = 未听牌（用户规则②的弃胡前提）。判定只用听口，不需要跑完整向听搜索。
    can_tenpai: bool
    # 本巡打某张后能达成的最大听口有效剩余张数（含现物/公开张数折算）。
    best_wait_remaining: int
    # 是否存在「打一张即单吊任意听」（34 种全胡）的弃牌。
    any_wait_reachable: bool
    # 我方可行番型上限倍率（按接近度 ≥ ceiling_progress 的方向取最大 weight）。
    ceiling_multiplier: float
    # 上限来自哪个番型（给 prompt/日志用）。
    ceiling_label: Optional[str] = None


@dataclass
class OpponentThreatFacts:
    tier: int
    locked: bool
    # 对手已公开番型的最高倍率（无已公开番型时为 0）。
    known_multiplier: float
    signals: Sequence[str] = field(default_factory=list)


@dataclass(frozen=True)
class DefensePolicyInput:
    own: OwnHandFacts
    opponents: Sequence[OpponentThreatFacts]
    config: Optional[object] = None


@dataclass
class DefensePolicyResult:
    mode: DefenseMode
    # 全场最高威胁档与倍率（用于文案与阈值）。
    threat_tier: int
    threat_multiplier: float
    reasons: list[str]


def _attr(item, name: str, default=None):
    if isinstance(item, dict):
        return item.get(name, default)
    return getattr(item, name, default)


def _camel(name: str) -> str:
    head, *rest = name.split('_')
    return head + ''.join(part.title() for part in rest)


def _field(item, name: str, default=None):
    """读字段：接受 snake_case（本模块 dataclass）与 camelCase（前端同形 dict / TS 对象）。"""
    value = _attr(item, name, None)
    if value is None:
        value = _attr(item, _camel(name), None)
    return default if value is None else value


def decide_defense_policy(own, opponents, config=None) -> DefensePolicyResult:
    """只算「该不该兜」，不决定具体打哪张（打哪张由最小赔付规则在引擎侧算）。

    优先级：精吊任意听可及 > 我方上限不低于对手 > 未听牌且听口过窄则兜 > 否则正常。
    形参与前端 ``decideDefensePolicy({own, opponents, config})`` 同义：``own`` 可为
    OwnHandFacts / dict，``opponents`` 为 OpponentThreatFacts / dict 序列。
    """
    resolved = config if config is not None else BLOOD_FLOW_DEFENSE
    threats = list(opponents or [])

    def own_field(name: str, default=None):
        return _field(own, name, default)

    threat_tier = 0
    threat_multiplier = 0.0
    for opponent in threats:
        tier = _field(opponent, 'tier', 0) or 0
        threat_tier = max(threat_tier, tier)
        threat_multiplier = max(
            threat_multiplier,
            max(_field(opponent, 'known_multiplier', 0) or 0, multiplier_of_tier(tier))
            if tier >= 1 else 0)
    threatening = sorted(
        [opponent for opponent in threats if (_field(opponent, 'tier', 0) or 0) >= resolved.fold_threat_tier],
        key=lambda opponent: -(_field(opponent, 'tier', 0) or 0))

    own_any_wait = bool(own_field('any_wait_reachable', False))
    own_ceiling = own_field('ceiling_multiplier', 0) or 0
    own_can_tenpai = bool(own_field('can_tenpai', False))
    ceiling_label = own_field('ceiling_label')

    if own_any_wait:
        return DefensePolicyResult(
            mode='push', threat_tier=threat_tier, threat_multiplier=threat_multiplier,
            reasons=['打一张即精吊任意听：此后每巡必胡、永不弃牌，等于不再点炮'])
    if threatening and own_ceiling >= threat_multiplier \
            and own_ceiling >= resolved.ceiling_weight_floor:
        return DefensePolicyResult(
            mode='push', threat_tier=threat_tier, threat_multiplier=threat_multiplier,
            reasons=[f"我方上限{_format_multiplier(own_ceiling)}倍"
                     f"{f'（{ceiling_label}）' if ceiling_label else ''}"
                     f"不低于对手{_format_multiplier(threat_multiplier)}倍，可以赌"])
    if threatening and not own_can_tenpai:
        top = threatening[0]
        signals = list(_field(top, 'signals', None) or [])
        top_tier = _field(top, 'tier', 0) or 0
        top_reason = '、'.join(signals[:2]) or f'档位{top_tier}'
        return DefensePolicyResult(
            mode='fold', threat_tier=threat_tier, threat_multiplier=threat_multiplier,
            reasons=[
                f"对手{'已锁手' if _field(top, 'locked', False) else '疑似'}大牌（{top_reason}）",
                '本家未听牌（本巡打任何一张都听不上）→ 弃胡兜安全张',
            ])
    return DefensePolicyResult(mode='normal', threat_tier=threat_tier,
                               threat_multiplier=threat_multiplier, reasons=[])


def _format_multiplier(value) -> str:
    """倍率文案与 TS 模板字符串一致：整数不带小数点（1 / 16），非整数按最短表示。"""
    number = float(value)
    return str(int(number)) if number.is_integer() else str(number)


def multiplier_of_tier(tier: int) -> float:
    """档位 → 赔付量级倍率（与 opponent_pattern_risk 的 ×1/4/16/32 对应）。"""
    if tier >= 3:
        return 16
    if tier == 2:
        return 8
    if tier == 1:
        return 4
    return 1


def own_hand_facts(hand: Sequence[str], melds: Sequence[dict], jokers: Sequence[str],
                   visible_tiles: Sequence[str], config=None,
                   directions: Optional[Sequence[dict]] = None) -> OwnHandFacts:
    """本家手牌的兜/弃相关事实（打某张后的听口宽度、是否可及任意听、番型上限）。

    ``directions`` 为 ``[{'weight': …, 'progress': …, 'label': …}]``（由 pattern_potentials
    派生，与 TS 调用点同形）。听口判定用 ``waiting_tiles_cached``（只判听口，不跑向听搜索）。
    """
    from app.core.blood_flow.ai import waiting_tiles_cached, is_any_tile_wait
    from app.core.tiles import TILE_TYPES

    resolved = config if config is not None else BLOOD_FLOW_DEFENSE
    hand = list(hand or [])
    exposed = len(list(melds or []))
    joker_list = list(jokers or [])
    visible = list(visible_tiles or [])

    def remaining(tile: str) -> int:
        return max(0, 4 - visible.count(tile))

    best_wait_remaining = 0
    any_wait_reachable = False
    can_tenpai = False
    seen: set[str] = set()
    for index, tile in enumerate(hand):
        if tile in seen:
            continue
        seen.add(tile)
        after = [t for position, t in enumerate(hand) if position != index]
        waits = waiting_tiles_cached(after, exposed, joker_list)
        if not waits:
            continue
        can_tenpai = True
        if is_any_tile_wait(waits, after):
            any_wait_reachable = True
        effective = sum(remaining(wait) for wait in waits)
        if effective > best_wait_remaining:
            best_wait_remaining = effective

    reachable = [direction for direction in (directions or [])
                 if (_field(direction, 'progress', 0) or 0) >= resolved.ceiling_progress]
    ceiling = None
    for direction in reachable:
        weight = _field(direction, 'weight', 0) or 0
        if ceiling is None or weight > ceiling['weight']:
            ceiling = {'weight': weight, 'label': _field(direction, 'label')}
    return OwnHandFacts(
        can_tenpai=can_tenpai,
        best_wait_remaining=best_wait_remaining,
        any_wait_reachable=any_wait_reachable,
        ceiling_multiplier=ceiling['weight'] if ceiling else 0,
        ceiling_label=ceiling['label'] if ceiling else None,
    )


def pattern_weight_of(pattern_id: str) -> float:
    """我方上限用的番型权重（与 BLOOD_FLOW_CONFIG.patterns 同源）。"""
    definition = BLOOD_FLOW_CONFIG.patterns.get(pattern_id)
    return definition.weight if definition else 1
