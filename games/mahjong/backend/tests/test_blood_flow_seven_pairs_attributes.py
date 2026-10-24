"""七对与豪华七对的牌种属性及支付镜像验收。"""
import pytest

from app.core.blood_flow.evaluate import evaluate_win, win_input_from_dict


def pairs(*tiles):
    return [tile for tile in tiles for _ in range(2)]


CASES = [
    ('seven-simples', pairs('m2', 'm4', 'p3', 'p5', 's2', 's6', 's8'), [], ['sevenPairs', 'all-simples'], 7, True),
    ('luxury-simples', pairs('m2', 'm2', 'p3', 'p5', 's2', 's6', 's8'), [], ['luxury-seven-pairs', 'all-simples'], 9, True),
    ('seven-pure-suit', pairs('m1', 'm2', 'm4', 'm5', 'm6', 'm8', 'm9'), [], ['sevenPairs', 'pure-suit'], 13, True),
    ('luxury-pure-suit', pairs('m1', 'm1', 'm3', 'm5', 'm7', 'm8', 'm9'), [], ['luxury-seven-pairs', 'pure-suit'], 15, True),
    ('seven-mixed-suit', pairs('m1', 'm3', 'm5', 'm7', 'm9', 'east', 'south'), [], ['sevenPairs', 'mixed-suit'], 9, True),
    ('luxury-mixed-suit', pairs('m1', 'm1', 'm3', 'm5', 'm7', 'east', 'south'), [], ['luxury-seven-pairs', 'mixed-suit'], 11, True),
    ('seven-mixed-terminals', pairs('m1', 'm9', 'p1', 'p9', 's1', 's9', 'east'), [], ['sevenPairs', 'mixed-terminals'], 17, True),
    ('luxury-mixed-terminals', pairs('m1', 'm1', 'm9', 'p1', 'p9', 'east', 'south'), [], ['luxury-seven-pairs', 'mixed-terminals'], 19, True),
    ('luxury-pure-terminals', pairs('m1', 'm1', 'm9', 'p1', 'p9', 's1', 's9'), [], ['luxury-seven-pairs', 'pure-terminals'], 31, True),
    ('luxury-mixed-terminals-suit', pairs('m1', 'm1', 'm9', 'east', 'south', 'west', 'north'), [], ['luxury-seven-pairs', 'mixed-terminals', 'mixed-suit'], 23, True),
    ('luxury-simples-pure-suit', pairs('m2', 'm2', 'm4', 'm5', 'm6', 'm7', 'm8'), [], ['luxury-seven-pairs', 'all-simples', 'pure-suit'], 17, True),
    ('joker-seven-mixed-terminals', pairs('m1', 'm9', 'p1', 'p9', 's1') + ['s9', 'red'] + pairs('east'), ['red'], ['sevenPairs', 'mixed-terminals'], 17, False),
    ('joker-luxury-mixed-terminals', ['m1', 'm1', 'm1', 'red'] + pairs('m9', 'p1', 'p9', 'east', 'south'), ['red'], ['luxury-seven-pairs', 'mixed-terminals'], 19, False),
    ('joker-luxury-pure-terminals', pairs('m1', 'm1', 'm9', 'p1', 'p9', 's1') + ['red', 's9'], ['red'], ['luxury-seven-pairs', 'pure-terminals'], 31, False),
]


@pytest.mark.parametrize('name,hand,jokers,patterns,multiplier,natural', CASES, ids=[row[0] for row in CASES])
@pytest.mark.parametrize('source', ['discard', 'self-draw'])
def test_seven_pairs_attributes_and_payments(name, hand, jokers, patterns, multiplier, natural, source):
    win = evaluate_win(win_input_from_dict(dict(concealed=hand[:-1], winningTile=hand[-1],
                                               melds=[], jokers=jokers, source=source, opening=None)))
    # 六对加一张精牌听任意，清幺九也不能突破只能自摸的限制。
    if name == 'joker-luxury-pure-terminals' and source == 'discard':
        assert win is None
        return
    assert win is not None
    assert win.decomposition.shape == 'sevenPairs'
    assert sorted(item.id for item in win.score.items) == sorted(['concealed-hand', *patterns])
    assert win.score.pattern_multiplier == multiplier
    assert win.score.hard_win is natural
    assert win.score.payment_per_payer == 10 * multiplier * (2 if source == 'self-draw' else 1) * (2 if natural else 1)
    assert 'all-triplets' not in [item.id for item in win.score.items]
    if 'luxury-seven-pairs' in patterns:
        assert any(item.id == 'sevenPairs' and item.included_by == 'luxury-seven-pairs' for item in win.score.excluded)


@pytest.mark.parametrize('hand,multiplier', [
    (pairs('m1', 'm9', 'p1', 'p9', 's1', 's2', 'east'), 5),
    (pairs('east', 'south', 'west', 'north', 'red', 'green', 'white'), 29),
    (pairs('east', 'east', 'south', 'west', 'north', 'red', 'green'), 31),
], ids=['middle-tile', 'all-honors-seven', 'all-honors-luxury'])
def test_seven_pairs_terminal_attribute_negatives(hand, multiplier):
    win = evaluate_win(win_input_from_dict(dict(concealed=hand[:-1], winningTile=hand[-1],
                                               melds=[], jokers=[], source='discard', opening=None)))
    assert win.decomposition.shape == 'sevenPairs'
    ids = [item.id for item in win.score.items]
    assert not set(ids).intersection(['mixed-terminals', 'pure-terminals', 'all-simples', 'pure-suit', 'mixed-suit'])
    assert win.score.pattern_multiplier == multiplier
