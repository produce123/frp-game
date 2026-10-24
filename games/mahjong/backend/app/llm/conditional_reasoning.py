"""基于公开局面的条件深度思考触发器；不保存或展示模型思考过程。"""

from dataclasses import dataclass, field
import random as random_module

from app.core.opponent_pattern_risk import opponent_risk_profiles, opponent_threat_score
from app.llm.schema import TILE_NAMES


@dataclass(frozen=True)
class TriggerConfig:
    candidate_score_gap: float = 8
    late_wall_count: int = 12
    opponent_threat: int = 70
    early_opponent_threat: int = 90
    score_swing: int = 800


@dataclass(frozen=True)
class ConditionalReasoningConfig:
    enabled: bool = True
    max_per_seat_per_round: int = 2
    max_soft_per_seat_per_round: int = 1
    max_per_match: int = 24
    deadline_ms: int = 40000
    min_remaining_budget_ms: int = 45000
    trigger: TriggerConfig = field(default_factory=TriggerConfig)
    audit_sample_rate: float = 0.02


DEFAULT_CONDITIONAL_REASONING = ConditionalReasoningConfig()


def _band(value, high, medium, low=0):
    if value in ('高', '优'):
        return high
    if value == '中':
        return medium
    return low


def candidate_score(candidate: dict, rule_code: str) -> float:
    feat = candidate.get('features') or {}
    score = 50.0
    if isinstance(feat.get('shanten'), (int, float)):
        score -= feat['shanten'] * 14
    if isinstance(feat.get('ukeire'), (int, float)):
        score += min(24, feat['ukeire'] * 2)
    if isinstance(feat.get('effectiveRemaining'), (int, float)):
        score += min(20, feat['effectiveRemaining'])
    score += _band(feat.get('efficiency'), 12, 4, -8)
    if rule_code != 'lotus-classic':
        score += _band(feat.get('safety'), 10, 2, -8)
    score += _band(feat.get('scoreDeltaBand'), 14, 7)
    if feat.get('ready') is True:
        score += 18
    score -= len(feat.get('risks') or []) * 8
    if (candidate.get('action') or {}).get('kind') == 'pass':
        score -= 2
    return score


def _candidate_gap(request: dict) -> float:
    scores = sorted((candidate_score(c, request.get('ruleCode', ''))
                     for c in request.get('candidates', [])), reverse=True)
    return abs(scores[0] - scores[1]) if len(scores) >= 2 else float('inf')


def _feature_signature(candidate: dict) -> tuple:
    feat = candidate.get('features') or {}

    def tile_values(value):
        if not isinstance(value, list):
            return value
        return tuple(sorted((item.get('tile'), item.get('remaining'))
                            for item in value if isinstance(item, dict)))

    return (
        (candidate.get('action') or {}).get('kind'),
        feat.get('shanten'), feat.get('ukeire'),
        tile_values(feat.get('effectiveTiles')),
        feat.get('ready'), tile_values(feat.get('waits')),
        feat.get('effectiveRemaining'), feat.get('specialPattern'),
        feat.get('safety'), feat.get('efficiency'),
        feat.get('scoreDeltaBand'), feat.get('scoreDelta'),
        tuple(sorted(feat.get('risks') or [])),
    )


def _has_distinct_contender(candidates: list[dict], rule_code: str,
                            max_gap: float) -> bool:
    ranked = sorted(((candidate_score(candidate, rule_code), candidate)
                     for candidate in candidates), key=lambda item: item[0], reverse=True)
    if not ranked:
        return False
    best_score, best = ranked[0]
    best_signature = _feature_signature(best)
    return any(best_score - score <= max_gap
               and _feature_signature(candidate) != best_signature
               for score, candidate in ranked[1:])


def _meaningful_close_choice(request: dict, max_gap: float) -> bool:
    return _has_distinct_contender(
        request.get('candidates') or [], request.get('ruleCode', ''), max_gap)


def _ready_decision_tradeoff(request: dict, max_gap: float) -> bool:
    candidates = request.get('candidates') or []
    ready_candidates = [candidate for candidate in candidates
                        if (candidate.get('features') or {}).get('ready') is True]
    may_break_ready = any(
        '破坏听牌' in risk
        for candidate in candidates
        for risk in ((candidate.get('features') or {}).get('risks') or [])
    )
    return may_break_ready or (
        len(ready_candidates) >= 2
        and _has_distinct_contender(
            ready_candidates, request.get('ruleCode', ''), max_gap)
    )


_TILE_BY_NAME: dict[str, str] = {name: tile for tile, name in TILE_NAMES.items()}


def _internal_tiles(names) -> list[str]:
    """规范快照（中文牌名）→ 风险模块（内部牌面）。未知牌名一律丢弃，不猜测。"""
    tiles: list[str] = []
    for name in names or []:
        tile = _TILE_BY_NAME.get(name)
        if tile:
            tiles.append(tile)
    return tiles


def _snapshot_opponents(state: dict) -> list[dict]:
    """上家 / 对家 / 下家的公开副露与牌河（顺序与前端 snapshotOpponents 一致）。"""
    snapshots = state.get('snapshots') or {}
    opponents: list[dict] = []
    for key in ('upper', 'opposite', 'lower'):
        view = snapshots.get(key) or {}
        melds: list[dict] = []
        for meld in view.get('melds') or []:
            tiles = _internal_tiles(meld.get('tiles'))
            tile = _TILE_BY_NAME.get(meld.get('tile')) or (tiles[0] if tiles else None)
            if tile:
                melds.append({'type': meld.get('type'), 'tile': tile, 'tiles': tiles})
        opponents.append({'discards': _internal_tiles(view.get('discards')), 'melds': melds})
    return opponents


def _opponent_threat(request: dict) -> int:
    """公开信息威胁值：与放炮定价同源（app/core/opponent_pattern_risk.py）。

    副露为主，叠加染手集中度、三元 / 四喜 / 字牌成组、后段与短牌河异常。
    局限：门清大牌无法识别，只作弱信号（tier 1）。档位→威胁分：3=90 / 2=70 / 1=40，
    墙余 ≤ 24 再 +10（上限 100）；lotus-classic 规则恒为 0。
    """
    if request.get('ruleCode') == 'lotus-classic':
        return 0
    state = request.get('state') or {}
    wall_count = state.get('wallCount', 99)
    profiles = opponent_risk_profiles(_snapshot_opponents(state), wall_count)
    return opponent_threat_score(profiles, wall_count)


def _score_swing(request: dict) -> int:
    candidates = request.get('candidates') or []
    return max(((c.get('features') or {}).get('scoreDelta') or 0
                for c in candidates), default=0)


def evaluate_reasoning_triggers(request: dict, config=DEFAULT_CONDITIONAL_REASONING,
                                random_fn=None) -> set[str]:
    random_value = random_fn or random_module.random
    state = request.get('state') or {}
    opening = state.get('turnOrigin') == 'opening'
    early = opening or bool(state.get('earlyRound'))
    gap = _candidate_gap(request)
    threat = _opponent_threat(request)
    reasons: set[str] = set()
    if _ready_decision_tradeoff(request, config.trigger.candidate_score_gap):
        reasons.add('ready-choice')
    if not early and gap <= config.trigger.candidate_score_gap \
            and _meaningful_close_choice(request, config.trigger.candidate_score_gap):
        reasons.add('close-candidates')
    if state.get('wallCount', 99) <= config.trigger.late_wall_count:
        reasons.add('late-wall')
    threat_threshold = config.trigger.early_opponent_threat \
        if early else config.trigger.opponent_threat
    if threat >= threat_threshold:
        reasons.add('opponent-threat')
    if _score_swing(request) >= config.trigger.score_swing:
        reasons.add('score-swing')
    if not early and random_value() < config.audit_sample_rate:
        reasons.add('audit')
    return reasons


class ConditionalReasoningCoordinator:
    def __init__(self, config=DEFAULT_CONDITIONAL_REASONING, random_fn=None):
        self.config = config
        self.random = random_fn or random_module.random
        self.match_uses = 0
        self.round_seat_uses = {}
        self.round_seat_soft_uses = {}

    def admit(self, request: dict, seat: int, remaining_budget_ms: float) -> bool:
        cfg = self.config
        state = request.get('state') or {}
        round_index = int(state.get('roundIndex') or 0)
        round_seat_key = (round_index, seat)
        reasons = evaluate_reasoning_triggers(request, cfg, self.random)
        strong = any(reason not in ('close-candidates', 'audit') for reason in reasons)
        allowed = (cfg.enabled and bool(reasons)
                   and remaining_budget_ms >= cfg.min_remaining_budget_ms
                   and self.match_uses < cfg.max_per_match
                   and self.round_seat_uses.get(round_seat_key, 0)
                   < cfg.max_per_seat_per_round
                   and (strong or self.round_seat_soft_uses.get(round_seat_key, 0)
                        < cfg.max_soft_per_seat_per_round))
        if allowed:
            self.match_uses += 1
            self.round_seat_uses[round_seat_key] = \
                self.round_seat_uses.get(round_seat_key, 0) + 1
            if not strong:
                self.round_seat_soft_uses[round_seat_key] = \
                    self.round_seat_soft_uses.get(round_seat_key, 0) + 1
        return allowed

    def reset(self):
        self.match_uses = 0
        self.round_seat_uses.clear()
        self.round_seat_soft_uses.clear()
