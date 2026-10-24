"""可替换麻将规则集与番型引擎。"""

from app.rules.base import ClaimCapabilities, GameRuleSet
from app.rules.fans import FanContext, FanEngine, FanEvaluation, FanHit, PredicateFan
from app.rules.lianhua import LianhuaGuangmaRuleSet, get_default_rule_set
from app.rules.lotus_legacy import LotusLegacyRuleSet
from app.rules.registry import get_rule_set

__all__ = [
    'ClaimCapabilities',
    'FanContext',
    'FanEngine',
    'FanEvaluation',
    'FanHit',
    'GameRuleSet',
    'LianhuaGuangmaRuleSet',
    'PredicateFan',
    'get_default_rule_set',
    'LotusLegacyRuleSet',
    'get_rule_set',
]
