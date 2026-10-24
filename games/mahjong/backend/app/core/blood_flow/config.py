"""血流规则配置 —— 对应 src/game/variants/lotus/bloodFlow/config.ts 的 BLOOD_FLOW_CONFIG。"""

from dataclasses import dataclass, field, replace
from typing import Literal

from app.core.blood_flow.types import PatternDefinition
# 番种表（权重与排除关系与前端 src/game/variants/lotus/bloodFlow/config.ts 完全一致）。
# 2026-09-12 **第二版完整番种表**（用户定稿）：梯度 1 → 2 → 4 → 6 → 8 → 12 → 16 → 24 → 32，
# 新增“路线牌型”——数牌路线（断幺九 → 三步高 → 清龙/四步高）、刻子路线（碰碰胡 → 三暗刻/三节高 →
# 四暗刻/四节高）、花色路线（混一色 → 清一色 → 九莲）、幺九路线（全带幺 → 混幺九 → 清幺九/字一色）、
# 七对路线（七对 → 豪华七对）。覆盖关系用 excludes 表达（存在高位番种时剔除低位）。
PATTERNS: dict[str, PatternDefinition] = {
    # 顶级
    'big-four-winds': PatternDefinition('big-four-winds', '大四喜', 32, ('all-triplets', 'little-four-winds')),
    # 四杠只覆盖三杠（新表 §7：杠牌系列“四杠 → 三杠”）；四杠手必然也是四刻子+将，可与碰碰胡叠加。
    'four-kongs': PatternDefinition('four-kongs', '四杠', 32, ('three-kongs',)),
    'nine-gates': PatternDefinition('nine-gates', '九莲宝灯', 32, ('pure-suit',)),
    # 极高番
    'big-three-dragons': PatternDefinition('big-three-dragons', '大三元', 24, ('little-three-dragons',)),
    'all-honors': PatternDefinition('all-honors', '字一色', 24,
                                    ('mixed-terminals', 'all-with-terminals', 'all-triplets')),
    'pure-terminals': PatternDefinition('pure-terminals', '清幺九', 24,
                                        ('mixed-terminals', 'all-with-terminals', 'all-triplets')),
    'all-green': PatternDefinition('all-green', '绿一色', 24),
    # 大牌
    'little-three-dragons': PatternDefinition('little-three-dragons', '小三元', 16),
    'little-four-winds': PatternDefinition('little-four-winds', '小四喜', 16),
    'four-concealed-triplets': PatternDefinition('four-concealed-triplets', '四暗刻', 16,
                                                 ('three-concealed-triplets', 'all-triplets')),
    # 十三幺：2026-09-15 由 16 → 32（用户定案：实测 1200 局 45,637 次胡牌里只出现 4 次，
    # 全表最稀有的会出现的番种，单次最高赔付却只有 320/家，低于豪华七对(12 番)的 480）。
    'thirteenOrphans': PatternDefinition('thirteenOrphans', '十三幺', 32,
                                         ('all-with-terminals', 'mixed-terminals',
                                          'sevenPairs', 'all-triplets')),
    'one-suit-four-joints': PatternDefinition('one-suit-four-joints', '一色四节高', 16,
                                              ('one-suit-three-joints', 'all-triplets')),
    # 高番
    'mixed-terminals': PatternDefinition('mixed-terminals', '混幺九', 12, ('all-with-terminals', 'all-triplets')),
    'three-kongs': PatternDefinition('three-kongs', '三杠', 12),
    # 豪华七对 2026-09-18 由 12 → 6 番（暂定，与前端 config.ts 同步）
    'luxury-seven-pairs': PatternDefinition('luxury-seven-pairs', '豪华七对', 6,
                                            ('sevenPairs', 'all-triplets', 'three-concealed-triplets',
                                             'four-concealed-triplets', 'one-suit-three-joints',
                                             'one-suit-four-joints')),
    # 中高番
    'pure-suit': PatternDefinition('pure-suit', '清一色', 8, ('mixed-suit',)),
    'one-suit-three-joints': PatternDefinition('one-suit-three-joints', '一色三节高', 8),
    'one-suit-four-steps': PatternDefinition('one-suit-four-steps', '一色四步高', 8, ('one-suit-three-steps',)),
    # 中番
    'three-concealed-triplets': PatternDefinition('three-concealed-triplets', '三暗刻', 6),
    'qiXing': PatternDefinition('qiXing', '七星十三烂', 6, ('shiSanLan',)),
    'pure-straight': PatternDefinition('pure-straight', '清龙', 6),
    # 中低番
    'mixed-suit': PatternDefinition('mixed-suit', '混一色', 4),
    'all-triplets': PatternDefinition('all-triplets', '碰碰胡', 4),
    'sevenPairs': PatternDefinition('sevenPairs', '七对', 4,
                                    ('all-triplets', 'three-concealed-triplets', 'four-concealed-triplets',
                                     'one-suit-three-joints', 'one-suit-four-joints')),
    'one-suit-three-steps': PatternDefinition('one-suit-three-steps', '一色三步高', 4),
    'all-with-terminals': PatternDefinition('all-with-terminals', '全带幺', 4),
    # 低番 / 基础
    'shiSanLan': PatternDefinition('shiSanLan', '十三烂', 2),
    'all-simples': PatternDefinition('all-simples', '断幺九', 2,
                                     ('all-with-terminals', 'mixed-terminals', 'pure-terminals', 'all-honors')),
    # —— 2026-09-15 用户定案：拆掉「门清平胡」这个 2 番合并番种，换成两个独立番种（与前端 config.ts 一致）——
    # 门清（1 番）：只看无副露（不排除用精牌），**与任何番种叠加**（因此四暗刻的 excludes 里已移除它）。
    # 平胡（1 番）：存在一种拆解 = 4 顺子 + 1 将、无刻子；可副露、字牌也可成顺；精牌只能补顺不能补刻。
    # 鸡胡（0.5 番）：完全没有任何计分番种时的兜底体；**不与任何番种叠加**。
    # 合成口径同时改为 Σ(番值) + 杠加成（原 1 + Σ(番值−1)）：原口径下"1 番"等于"不加成"，
    # 会让门清/平胡完全失效；且倍率必须保持整数（协议校验），所以鸡胡的半番落在**支付减半**上。
    'concealed-hand': PatternDefinition('concealed-hand', '门清', 1),
    'pinghu': PatternDefinition('pinghu', '平胡', 1),
    'chicken': PatternDefinition('chicken', '鸡胡', 0.5),
}

EVENT_MULTIPLIERS: dict[str, int] = {'discard': 1, 'self-draw': 2, 'robbed-kong': 2, 'kong-bloom': 4}

KONG_PAYMENTS: dict[str, int] = {'discard': 1, 'added': 1, 'concealed': 2, 'wind': 2}

# 杠加成（2026-09-12 新增；2026-09-15 用户定案把风杠降到与明杠同档）：
# 每个**明杠 +1**、每个**风杠 +1**、每个**暗杠 +2**，直接加到基础倍率上。
# 风杠为什么降：实测 150 局 / 5,021 次胡牌里风杠出现率 10.7%（每局），是暗杠（5.3%）的 2 倍、
# 只比明杠（15.3%）稀有 30%，此前却与暗杠同为 +2。风杠的**即时杠分不动**（KONG_PAYMENTS.wind = 2）。
# 此前杠没有任何番型加成，“胡后可开杠”也就没有收益——这是三杠/四杠这类牌型做不出来的根因之一。
KONG_BONUS: dict[str, int] = {'exposed': 1, 'concealed': 2, 'wind': 1}

ROUNDS: dict[str, int] = {'east': 4, 'hanchan': 8}


@dataclass(frozen=True)
class BloodFlowConfig:
    id: str = 'lotus-blood-flow'
    version: str = 'lotus-blood-flow-v1'
    label: str = '莲花麻将·血流'
    base_points: int = 10
    initial_score: int = 2000
    max_multiplier_per_payer: int = 128
    hard_win_multiplier: int = 2
    patterns: dict[str, PatternDefinition] = field(default_factory=lambda: dict(PATTERNS))
    event_multipliers: dict[str, int] = field(default_factory=lambda: dict(EVENT_MULTIPLIERS))
    opening_minimum_multiplier: int = 8
    kong_payments: dict[str, int] = field(default_factory=lambda: dict(KONG_PAYMENTS))
    # 杠加成权重（每个明杠 / 暗杠 / 风杠给基础倍率加多少），对齐前端 BLOOD_FLOW_CONFIG.kongBonus。
    kong_bonus: dict[str, int] = field(default_factory=lambda: dict(KONG_BONUS))
    rounds: dict[str, int] = field(default_factory=lambda: dict(ROUNDS))
    lock_after_first_win: bool = True
    multiple_winners: bool = True
    allow_negative_scores: bool = True
    already_won_players_pay: bool = True
    dealer_multiplier: int = 1
    dealer_rotation: Literal['every-round'] = 'every-round'
    cross_window_pass_restriction: bool = False


BLOOD_FLOW_CONFIG = BloodFlowConfig()


@dataclass(frozen=True)
class DefensePolicyConfig:
    """兜/弃政策阈值（v3）—— 对齐前端 config.ts 的 DefensePolicyConfig。

    规则来自用户定稿（2026-09-12）：
      ① 只要能在本巡转成**精吊任意听**就继续走（锁手后每张摸到的牌都能胡、永不弃牌）；
      ② 未听牌且可达听口过窄 → 立即弃胡：只打最小赔付张、停吃碰杠；
      ③ 我方上限不低于对手已知/推断的牌型倍率 → 可以赌（继续进攻）。
    """
    # 触发「兜」的最低对手威胁档（3 = 十六倍级 / 门清大牌）。
    fold_threat_tier: int = 3
    # 我方上限认定：番型方向接近度 ≥ 该值才算「真有机会做成」。
    ceiling_progress: float = 0.35
    # 我方上限认定：该方向的番型倍率权重下限（与对手对比用）。
    ceiling_weight_floor: float = 4
    # 兜牌硬约束：'hard' = 候选层撤掉吃碰杠 + 弃牌只留安全档（引擎与 LLM 共用同一份候选）；
    # 'off' = 只在引擎侧选择最小赔付张，候选不收敛。
    mode: str = 'hard'
    # 兜牌时允许的弃牌安全档容差（0 = 只留放炮成本最小档）。
    fold_discard_tolerance: float = 0


# 兜/弃政策默认值（v3；与前端 BLOOD_FLOW_DEFENSE 同名同值）。
BLOOD_FLOW_DEFENSE = DefensePolicyConfig()


@dataclass(frozen=True)
class KongValueConfig:
    """开杠价值配置（2026-09-13，对齐前端 KongValueConfig / BLOOD_FLOW_KONG_VALUE）。

    血流 AI 的开杠候选不再"能杠必杠"，而是按 ``杠收益 − 防守风险 − 自手牌型损失`` 计分
    （见 app/core/blood_flow/kong_value.py），净值为正才压过"不杠"。
    ``mode='off'`` 用于 A/B 对照（回退到旧的"能杠必杠 + 已听牌才放弃"口径）。
    """
    mode: str = 'ev'
    # 倍率加成的折算权重（× 底分）：1 = 按单家一份计（杠加成只在胡牌时兑现，这里不按胡牌概率再折）。
    bonus_weight: float = 1
    # 补杠抢杠风险（点，未见张时）。
    rob_risk: float = 60
    # 向听每恶化一档的折算损失（点）＝ 1 番底分。
    shanten_step_loss: float = 10
    # 门清平胡作为"兜底本体"的折价：只有在别的番种都不成立时才兑现，因此不按全额计。
    concealed_hand_fallback: float = 0.5


BLOOD_FLOW_KONG_VALUE = KongValueConfig()


@dataclass(frozen=True)
class OpportunityCalibration:
    """Calibrated normal-rotation opportunity rates used by source-v2."""
    draw_scale: float = 0.9975786924939467
    discard_scale: float = 0.8990627253064167
    self_yield: float = 0.8478712071537614
    ron_yield: float = 0.9877357078236184


@dataclass(frozen=True)
class BigHandRouteConfig:
    """Commitment thresholds mirrored from bloodFlow/bigHandRoute.ts."""
    mode: Literal['off', 'llm', 'bot', 'all'] = 'off'
    enabled: tuple[str, ...] = ('thirteenOrphans', 'nineGates')
    min_orphan_kinds: int = 12
    min_suit_ranks: int = 9
    min_suit_tiles: int = 12
    pure_suit_min_tiles: int = 10
    pure_suit_max_foreign: int = 2
    mixed_suit_min_tiles: int = 10
    mixed_suit_max_foreign: int = 1
    all_triplets_min_units: int = 4
    decline_win_ratio: float = 2.0
    min_wall_for_commit: int = 20
    min_deficit_for_commit: int = 300
    min_wall_for_commit_with_jokers: int = 15
    joker_relief_count: int = 2


BLOOD_FLOW_BIG_HAND_ROUTE = BigHandRouteConfig()
BLOOD_FLOW_BIG_HAND_ROUTE_WIDE = replace(
    BLOOD_FLOW_BIG_HAND_ROUTE,
    mode='bot',
    enabled=('thirteenOrphans', 'nineGates', 'pureSuit', 'mixedSuit', 'allTriplets'),
)
SOURCE_V2_OPPORTUNITY_CALIBRATION = OpportunityCalibration()


@dataclass(frozen=True)
class BloodFlowAiConfig:
    """血流本地 AI 贪婪 EV 参数（对齐前端 config.ts BLOOD_FLOW_AI）。"""
    strategy: str = 'ev'
    minimum_first_payment: int = 0
    self_draw_weight: int = 6
    first_win_floor_early: int = 40
    first_win_floor_mid: int = 20
    first_win_floor_late: int = 10
    late_game_wall_count: int = 15
    early_game_wall_count: int = 40
    potential_floor: float = 2.0
    reform_gain_ratio: float = 1.2
    chain_horizon: int = 8
    chain_forecast: Literal['legacy', 'self-draw-v1', 'source-v2'] = 'source-v2'
    opportunity_calibration: OpportunityCalibration | None = SOURCE_V2_OPPORTUNITY_CALIBRATION
    safety_cost_none: float = 0.25
    safety_cost_one: float = 0.1
    safety_cost_safe: float = 0.0
    # 对手牌型（大牌）风险定价：'off' = 只看公开张数的旧口径，
    # 'tier' = 档位版（见 app/core/opponent_pattern_risk.py，前端同源 shared/ai/opponentPatternRisk.ts）。
    opponent_pattern_risk: str = 'tier'
    # 档位倍率：1 = 平胡量级；4/16/32 ≈ 混一色 / 清一色 / 十六倍级硬胡点炮的单家赔付量级。
    risk_factor_tier1: float = 4
    risk_factor_tier2: float = 16
    risk_factor_tier3: float = 32
    # 染手（花色集中）嫌疑对手：非嫌疑花色牌的系数。
    risk_off_suit_factor: float = 0.5
    # 兜/弃政策阈值（v3）。
    defense: DefensePolicyConfig = BLOOD_FLOW_DEFENSE
    llm_ev_features: bool = True
    # 开杠价值（第 3 步）：杠候选按 收益 − 防守风险 − 自手牌型损失 计分。
    kong_value: KongValueConfig = BLOOD_FLOW_KONG_VALUE
    # 七对潜力模型（2026-09-13 追加）：'off' = 旧口径（七对只按 4 番估、多余精牌丢掉）；
    # 'ev' = 对齐引擎 is_seven_pairs 的记账 + 豪华七对方向（豪华七对 2026-09-18 由 12 → 6 番 暂定）。
    seven_pairs_model: str = 'ev'
    big_hand_route: BigHandRouteConfig = BLOOD_FLOW_BIG_HAND_ROUTE_WIDE
    route_opportunity_guard: bool = True
    claim_meld_projection: bool = True
    claim_ready_net_guard: bool = True
    route_advice_only: bool = False
    win_opportunity_guards: bool = False


BLOOD_FLOW_AI = BloodFlowAiConfig()
BLOOD_FLOW_LLM_AI = replace(
    BLOOD_FLOW_AI,
    chain_forecast='legacy',
    opportunity_calibration=None,
    big_hand_route=replace(BLOOD_FLOW_BIG_HAND_ROUTE_WIDE, mode='llm'),
    route_opportunity_guard=False,
    claim_meld_projection=False,
    claim_ready_net_guard=False,
    route_advice_only=True,
    win_opportunity_guards=True,
)

# 计时（毫秒）：对齐经典联机（非血流）与前端 config.ts。
BLOOD_FLOW_TIMING: dict[str, int] = {
    'normalDecisionMs': 15_000,
    'remoteDecisionMs': 12_000,   # 联机回合决策窗口：对齐经典房间 turn_timeout=12s
    'winBeatMs': 450,
    'recoveryGraceMs': 12_000,
}

# 真人联机房间的视觉节奏（毫秒）：以单机血流为基准逐项对齐——前端引擎 engine.ts
# 消费共享 PACE_MS，机器人思考是 useBloodFlowGame.schedule 的统一 650ms（不分窗口类型）。
# 不再对齐经典联机的以下专属档位：claim 500 / after_kong 550 分档、真人碰/明杠 350
# 缩短（skipDrawPengDelay 等）、多响抢杠 betweenRobKongs 450（单机引擎无此停顿）。
BLOOD_FLOW_PACE: dict[str, int] = {
    'aiThink': 650,                # 机器人决策前统一停顿（LLM 座位也先等再发请求，同单机 actBot）
    'afterDraw': 450,              # 摸牌到出牌窗口（对齐单机 PACE_MS.afterDraw）
    'afterDiscardToNextTurn': 450,  # 弃牌到下家
    'afterClaimPeng': 650,          # 碰/吃后（单机不分真人/AI）
    'afterClaimGang': 550,          # 明杠后（单机不分真人/AI）
    'afterKongSettle': 600,         # 暗杠/补杠/乱风杠后
    'beforeRobKong': 650,           # 补杠到抢杠窗口
    # 胡牌表现：血流本地 bloodFlowWinTiming（经典单胡无此档位，取本地为准）
    'winEffectBase': 1815,
    'winEffectLarge': 2600,
    'winEffectTop': 2900,
    'winEffectDeduct': 620,
    'winEffectTail': 1200,
    'winHandoffMargin': 100,
    'multiWinIntro': 1500,
}
