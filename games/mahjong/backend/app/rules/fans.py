"""注册式番型引擎。

番型判断器只描述「是否命中」及其计分分量；引擎负责稳定排序、覆盖关系和汇总。
乘法番与附加分分开累计，以兼容莲花广麻“番数累乘、买马按底分加算”的规则。
"""

from dataclasses import dataclass, field
from typing import Callable, Iterable, Protocol


@dataclass(frozen=True)
class FanContext:
    dealer: bool = False
    no_joker: bool = False
    four_red: bool = False
    kong_bloom: bool = False
    horse_hits: int = 0
    robbed_kong: bool = False
    # 赢家已亮出的红中张数：每张按一份底分加算（莲花广麻 2026-09 定案）。
    red_count: int = 0


@dataclass(frozen=True)
class FanHit:
    code: str
    label: str
    multiplier: int = 1
    points: int = 0
    equivalent_multiplier: int = 0
    suppresses: frozenset[str] = field(default_factory=frozenset)


class FanEvaluator(Protocol):
    code: str

    def evaluate(self, context: FanContext) -> FanHit | None: ...


@dataclass(frozen=True)
class PredicateFan:
    """以谓词定义的轻量番型，适合状态番和配置番。"""

    code: str
    label: str
    predicate: Callable[[FanContext], bool]
    multiplier: int = 1
    points: Callable[[FanContext], int] | None = None
    equivalent_multiplier: Callable[[FanContext], int] | None = None
    suppresses: frozenset[str] = field(default_factory=frozenset)

    def evaluate(self, context: FanContext) -> FanHit | None:
        if not self.predicate(context):
            return None
        return FanHit(
            code=self.code,
            label=self.label,
            multiplier=self.multiplier,
            points=self.points(context) if self.points else 0,
            equivalent_multiplier=(
                self.equivalent_multiplier(context) if self.equivalent_multiplier else 0
            ),
            suppresses=self.suppresses,
        )


@dataclass(frozen=True)
class FanEvaluation:
    hits: tuple[FanHit, ...]
    multiplier: int
    additive_points: int
    total_multiplier: int
    points: int

    def to_legacy_dict(self) -> dict:
        details = []
        for hit in self.hits:
            if hit.points:
                details.append({'label': hit.label, 'points': hit.points})
            else:
                details.append({'label': hit.label, 'multiplier': hit.multiplier})
        # red_bonus 是莲花广麻的红中逐张加成分；单独拆出以保持 horsePoints 只含中马分。
        red_points = sum(hit.points for hit in self.hits if hit.code == 'red_bonus')
        return {
            'multiplier': self.multiplier,
            'totalMultiplier': self.total_multiplier,
            'horsePoints': self.additive_points - red_points,
            'redPoints': red_points,
            'points': self.points,
            'details': details,
        }


class FanEngine:
    """按注册顺序识别番型，并应用单向覆盖关系。"""

    def __init__(self, evaluators: Iterable[FanEvaluator], base_score: int):
        self.evaluators = tuple(evaluators)
        self.base_score = base_score
        codes = [e.code for e in self.evaluators]
        duplicates = sorted({code for code in codes if codes.count(code) > 1})
        if duplicates:
            raise ValueError(f'duplicate fan codes: {", ".join(duplicates)}')

    def evaluate(self, context: FanContext) -> FanEvaluation:
        matched = tuple(
            hit for evaluator in self.evaluators
            if (hit := evaluator.evaluate(context)) is not None
        )
        suppressed = frozenset(code for hit in matched for code in hit.suppresses)
        hits = tuple(hit for hit in matched if hit.code not in suppressed)

        multiplier = 1
        for hit in hits:
            multiplier *= hit.multiplier
        additive_points = sum(hit.points for hit in hits)
        total_multiplier = multiplier + sum(hit.equivalent_multiplier for hit in hits)
        return FanEvaluation(
            hits=hits,
            multiplier=multiplier,
            additive_points=additive_points,
            total_multiplier=total_multiplier,
            points=multiplier * self.base_score + additive_points,
        )
