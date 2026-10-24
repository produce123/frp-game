"""注册式番型引擎与当前广麻计分兼容性。"""

import pytest

from app.core.rules import score_hand
from app.rules.fans import FanContext, FanEngine, PredicateFan
from app.rules.lianhua import get_default_rule_set


def test_fan_engine_keeps_registration_order_and_sums_components():
    engine = FanEngine([
        PredicateFan('base', '基础', lambda _: True, multiplier=2),
        PredicateFan('extra', '附加', lambda _: True, points=lambda _: 30,
                     equivalent_multiplier=lambda _: 3),
    ], base_score=10)

    result = engine.evaluate(FanContext())

    assert [hit.code for hit in result.hits] == ['base', 'extra']
    assert result.multiplier == 2
    assert result.additive_points == 30
    assert result.total_multiplier == 5
    assert result.points == 50


def test_fan_engine_rejects_duplicate_codes():
    with pytest.raises(ValueError, match='duplicate fan codes: same'):
        FanEngine([
            PredicateFan('same', 'A', lambda _: True),
            PredicateFan('same', 'B', lambda _: True),
        ], base_score=100)


def test_fan_engine_applies_one_way_override():
    engine = FanEngine([
        PredicateFan('small', '小番', lambda _: True, multiplier=2),
        PredicateFan('large', '大番', lambda _: True, multiplier=4,
                     suppresses=frozenset({'small'})),
    ], base_score=100)

    result = engine.evaluate(FanContext())

    assert [hit.code for hit in result.hits] == ['large']
    assert result.multiplier == 4
    assert result.points == 400


def test_lianhua_four_red_is_flat_base_plus_additives():
    """四红中固定 ×1：压掉自摸/无癞子/杠开，红中与中马逐张加底分（庄家番已删除）。"""
    context = FanContext(
        dealer=True,
        no_joker=True,
        four_red=True,
        kong_bloom=True,
        horse_hits=2,
        red_count=4,
    )
    expected = {
        'multiplier': 1,
        'totalMultiplier': 7,
        'horsePoints': 200,
        'redPoints': 400,
        'points': 700,
        'details': [
            {'label': '四红中', 'multiplier': 1},
            {'label': '中马 2 张', 'points': 200},
            {'label': '红中 4 张', 'points': 400},
        ],
    }

    assert get_default_rule_set().score_hand(context) == expected
    assert score_hand(
        dealer=True, no_joker=True, four_red=True, kong_bloom=True,
        horse_hits=2, red_count=4,
    ) == expected


def test_lianhua_normal_win_ignores_dealer_and_adds_red_bonus():
    """普通自摸：庄家倍率已取消，无癞子 ×2，红中/中马按张数加底分。"""
    context = FanContext(dealer=True, no_joker=True, horse_hits=3, red_count=2)
    expected = {
        'multiplier': 2,
        'totalMultiplier': 7,
        'horsePoints': 300,
        'redPoints': 200,
        'points': 700,
        'details': [
            {'label': '自摸', 'multiplier': 1},
            {'label': '无癞子', 'multiplier': 2},
            {'label': '中马 3 张', 'points': 300},
            {'label': '红中 2 张', 'points': 200},
        ],
    }

    assert get_default_rule_set().score_hand(context) == expected
