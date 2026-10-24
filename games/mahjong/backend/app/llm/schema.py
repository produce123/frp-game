"""规范协议类型与牌名映射 —— docs/llm-ai-design.md §2.1/§6.4（Python 侧）。"""

from typing import Optional

# 内部牌面 → 中文牌名（§6.1）
TILE_NAMES: dict[str, str] = {
    'm1': '1万', 'm2': '2万', 'm3': '3万', 'm4': '4万', 'm5': '5万',
    'm6': '6万', 'm7': '7万', 'm8': '8万', 'm9': '9万',
    'p1': '1筒', 'p2': '2筒', 'p3': '3筒', 'p4': '4筒', 'p5': '5筒',
    'p6': '6筒', 'p7': '7筒', 'p8': '8筒', 'p9': '9筒',
    's1': '1条', 's2': '2条', 's3': '3条', 's4': '4条', 's5': '5条',
    's6': '6条', 's7': '7条', 's8': '8条', 's9': '9条',
    'east': '东风', 'south': '南风', 'west': '西风', 'north': '北风',
    'red': '红中', 'green': '发财', 'white': '白板',
}


def tile_name(tile: str) -> str:
    return TILE_NAMES.get(tile, tile)


def rule_code_for(rules_code: str) -> str:
    """后端内部规则代码 → 线协议规则 ID（§6.2：仅 lotus-classic / lotus-legacy）。"""
    return 'lotus-legacy' if rules_code == 'lotus-legacy' else 'lotus-classic'


# 风格（与前端一致）
STYLES = ('激进', '稳健', '话痨', '高冷')

# 规范动作（§6.4）：kind ∈ win/added-kong/concealed-kong/wind-kong/discard/gang/peng/chi/pass
ACTION_KINDS = frozenset({
    'win', 'added-kong', 'concealed-kong', 'wind-kong', 'discard',
    'gang', 'peng', 'chi', 'pass',
})


def canonical_action(kind: str, **kwargs) -> dict:
    return {'kind': kind, **kwargs}


def action_key(action: dict) -> str:
    """规范动作的合法性键（用于候选去重/匹配）。"""
    kind = action['kind']
    if kind == 'added-kong':
        return f'added-kong:{action["meldIndex"]}'
    if kind == 'concealed-kong':
        return f'concealed-kong:{action["tile"]}'
    if kind == 'wind-kong':
        return 'wind-kong'
    if kind == 'discard':
        return f'discard:{action["handIndex"]}'
    if kind == 'chi':
        return f'chi:{action["optionIndex"]}'
    return kind


def actions_match(a: dict, b: dict) -> bool:
    if a['kind'] != b['kind']:
        return False
    if a['kind'] == 'discard' or a['kind'] == 'added-kong':
        return a.get('meldIndex') == b.get('meldIndex') if a['kind'] == 'added-kong' else True
    if a['kind'] == 'concealed-kong':
        return a['tile'] == b['tile']
    return True


# 特征档位常量（§5）
BANDS = ('高', '中', '低')


def empty_features() -> dict:
    return {
        'shanten': 'n/a',
        'ukeire': 'n/a',
        'effectiveTiles': 'n/a',
        'ready': 'unknown',
        'waits': 'n/a',
        'effectiveRemaining': 'n/a',
        'specialPattern': 'n/a',
        'safety': 'unknown',
        'efficiency': 'unknown',
        'risks': [],
    }
