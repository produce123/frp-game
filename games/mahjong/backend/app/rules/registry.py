"""玩法规则集注册表。每个房间独立创建规则集，避免翻精状态跨房间污染。"""

from app.rules.base import GameRuleSet
from app.rules.blood_flow import BloodFlowRuleSet
from app.rules.lianhua import LianhuaGuangmaRuleSet
from app.rules.lotus_legacy import LotusLegacyRuleSet

RULESET_IDS = ('lotus-classic', 'lotus-legacy', 'lotus-blood-flow')


def get_rule_set(ruleset_id: str | None = None) -> GameRuleSet:
    if ruleset_id in (None, '', 'lotus-classic', 'lianhua_guangma'):
        return LianhuaGuangmaRuleSet()
    if ruleset_id == 'lotus-legacy':
        return LotusLegacyRuleSet()
    if ruleset_id == 'lotus-blood-flow':
        return BloodFlowRuleSet()
    raise ValueError(f'UNKNOWN_RULESET:{ruleset_id}')
