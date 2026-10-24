"""对手牌型风险定价的前后端 golden fixture 对拍。

读同一份 JSON（前端 `src/game/llm/fixtures/opponent-risk.json`），逐 case 断言 Python 镜像
（app/core/opponent_pattern_risk.py）与 TS 实现（src/game/shared/ai/opponentPatternRisk.ts）
产出完全相同的 profiles / exposure / feature。TS 侧参照测试见
`src/game/llm/opponentRiskFixture.test.ts`。
"""

import json
import os
from pathlib import Path

import pytest

from app.core.opponent_pattern_risk import (opponent_pattern_exposure,
                                            opponent_pattern_feature,
                                            opponent_risk_profiles)

_FIXTURE_REL = Path('src') / 'game' / 'llm' / 'fixtures' / 'opponent-risk.json'


def _candidate_roots() -> list[Path]:
    """前端工作区根候选。

    正常布局下 backend/ 在前端工作区内，`parents[2]` 即工作区根；但当 backend 是
    `D:/PycharmProjects/linahua-mahjong-backend` 的 linked worktree 时（AGENTS.md 所述），
    `parents[2]` 指向 `D:/PycharmProjects`。因此再补充：环境变量、工作区会话路径、
    以及从本文件逐级向上的祖先目录。
    """
    roots: list[Path] = []
    for name in ('LOTUS_FRONTEND_ROOT', 'DSH_WORKSPACE_ROOT', 'WORKSPACE_ROOT'):
        value = os.environ.get(name)
        if value:
            roots.append(Path(value))
    session_jsonl = os.environ.get('DSH_SESSION_JSONL')
    if session_jsonl:
        # ...\.dsh\sessions\--D-vueprojects-lianhua_guangma--\<id>\session.jsonl.zstd
        # → D:\vueprojects\lianhua_guangma（会话路径各层深度可能变化，逐层找工作区 slug）
        for part in Path(session_jsonl).parts:
            if part.startswith('--') and part.endswith('--'):
                windows_path = part[2:-2].replace('-', '\\')
                drive, _, rest = windows_path.partition('\\')
                if len(drive) == 1 and rest:
                    roots.append(Path(f'{drive}:\\{rest}'))
                break
    here = Path(__file__).resolve()
    for parent in here.parents:
        roots.append(parent)
    roots.append(here.parents[2])
    seen: list[Path] = []
    for root in roots:
        if root not in seen:
            seen.append(root)
    return seen


def _fixture_path() -> Path:
    for root in _candidate_roots():
        candidate = root / _FIXTURE_REL
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        f'未找到 {_FIXTURE_REL}（已尝试：{[str(root) for root in _candidate_roots()]}）')


FIXTURE = _fixture_path()

CASES = json.loads(FIXTURE.read_text(encoding='utf-8'))['cases']


def _profiles_of(case: dict):
    return opponent_risk_profiles(case['opponents'], case['wallCount'])


@pytest.mark.parametrize('case', CASES, ids=[case['id'] for case in CASES])
def test_fixture_case_matches_ts_expectation(case: dict):
    profiles = _profiles_of(case)
    summary = [{'tier': p.tier, 'factor': p.factor, 'signals': list(p.signals),
                'suspectSuit': p.suspect_suit, 'locked': p.locked,
                'avoidsHonorTerminals': p.avoids_honor_terminals,
                'axisSource': p.axis_source, 'honorsInFlush': p.honors_in_flush,
                'honorEmphasis': p.honor_emphasis} for p in profiles]
    assert summary == case['expectedProfiles'], f"{case['id']} profiles"

    visible = case['visibleTiles']
    exposure = opponent_pattern_exposure(profiles, visible)
    for tile, expected in case['expectedExposure'].items():
        assert exposure(tile) == pytest.approx(expected, rel=1e-9), \
            f"{case['id']} 赔付 {tile}"

    for tile, expected in case['expectedFeature'].items():
        actual = opponent_pattern_feature(profiles, visible, tile)
        if expected is None:
            assert actual is None, f"{case['id']} 特征 {tile} 应为 undefined/None"
            continue
        assert {'tier': actual.tier, 'payment': actual.payment, 'signals': actual.signals} == expected, \
            f"{case['id']} 特征 {tile}"


@pytest.mark.parametrize('case', CASES, ids=[case['id'] for case in CASES])
def test_fixture_payment_is_integer_points(case: dict):
    """赔付必须四舍五入成整数点（对齐 TS Math.round）。"""
    profiles = _profiles_of(case)
    exposure = opponent_pattern_exposure(profiles, case['visibleTiles'])
    for tile in case['visibleTiles']:
        assert float(exposure(tile)).is_integer(), f"{case['id']} 赔付 {tile} 非整数"


def test_fixture_ids_cover_the_required_scenarios():
    """十个 case 覆盖：无信号等价旧口径 / 染手+锁手 / 三组箭牌 tier3 / 半染手 / 门清短牌河弱信号 /
    门清十三幺（v2 危险轴 + 多现不归零）/ 门清九莲清一色（v2 嫌疑花色）/
    已公开十三幺（v3 known 轴对锁手家成立）/ 已公开大三元（v3 字牌刻子轴）/
    已公开清一色 + 锁手（v3 known 花色轴的轴外牌压到 0.1 倍，对应实测"对非本门牌根本不能胡 0 点"）。"""
    assert [case['id'] for case in CASES] == \
        ['quiet', 'flush-and-locked', 'three-dragons', 'half-flush', 'sparse-suit',
         'concealed-thirteen-orphans', 'concealed-flush',
         'known-thirteen-orphans', 'known-big-three-dragons', 'known-pure-suit-locked']


def _case(case_id: str) -> dict:
    return next(case for case in CASES if case['id'] == case_id)


def test_known_wins_fixture_drives_axis_source_and_honor_emphasis():
    """v3：已公开番型必须真的进入 fixture 的 opponents 并驱动轴字段（不是空断言）。"""
    orphans = _case('known-thirteen-orphans')
    assert orphans['opponents'][0]['knownWins'] == [
        {'id': 'thirteenOrphans', 'label': '十三幺', 'multiplier': 16}]
    profile = _profiles_of(orphans)[0]
    assert (profile.tier, profile.factor) == (3, 32)
    assert profile.signals == ['已胡十三幺', '已胡3次仍听']
    assert (profile.axis_source, profile.avoids_honor_terminals) == ('known', True)
    assert (profile.honors_in_flush, profile.honor_emphasis) == (False, False)

    dragons = _case('known-big-three-dragons')
    assert dragons['opponents'][0]['knownWins'][0]['id'] == 'big-three-dragons'
    profile = _profiles_of(dragons)[0]
    assert (profile.tier, profile.factor) == (2, 16)
    assert profile.signals == ['已胡大三元', '已胡1次仍听']
    assert (profile.axis_source, profile.honor_emphasis) == ('known', True)
    assert profile.avoids_honor_terminals is False


def test_v3_numeric_anchors_match_ts():
    """v3 数值锚点（与 TS 侧 fixture 断言同源）：known 轴对锁手家成立、字牌刻子轴字牌更贵。

    known-thirteen-orphans：锁手（inferred 轴本会一律同价）但轴来自已公开番型 →
    字牌/幺九 320、中张 80，仍有分辨力。
    known-big-three-dragons：字牌刻子轴 → 字牌 160、普通数牌 80。
    sparse-suit（v1/v2 回归）：嫌疑花色 40、非嫌疑花色 20。
    """
    orphans = _case('known-thirteen-orphans')
    exposure = opponent_pattern_exposure(_profiles_of(orphans), orphans['visibleTiles'])
    assert (exposure('north'), exposure('m9'), exposure('p5')) == (320, 320, 80)
    assert orphans['expectedExposure'] == {'north': 320, 'm9': 320, 'p5': 80}

    dragons = _case('known-big-three-dragons')
    exposure = opponent_pattern_exposure(_profiles_of(dragons), dragons['visibleTiles'])
    assert (exposure('east'), exposure('m5')) == (160, 80)
    assert dragons['expectedExposure'] == {'east': 160, 'm5': 80}

    sparse = _case('sparse-suit')
    exposure = opponent_pattern_exposure(_profiles_of(sparse), sparse['visibleTiles'])
    assert (exposure('s5'), exposure('m5')) == (40, 20)
