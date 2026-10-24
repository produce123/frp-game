"""与前端 handProgress.test.ts 对照的共享牌效回归。"""

from app.core.hand_progress import evaluate_hand_progress, standard_shanten
from app.core.rules import waiting_tiles


def test_standard_shanten_distinguishes_win_ready_and_one_away():
    winning = [
        'm1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p4', 'p5', 'p6',
        's7', 's8', 's9', 'east', 'east',
    ]
    assert standard_shanten(winning, 0, ['white']) == -1
    assert standard_shanten(winning[:-1], 0, ['white']) == 0
    one_away = [
        'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3',
        'east', 'east', 'south', 'west',
    ]
    assert standard_shanten(one_away, 0, ['white']) == 1


def test_ukeire_uses_visible_remaining_counts():
    hand = [
        'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3',
        'east', 'east', 'south', 'west',
    ]
    base = evaluate_hand_progress(hand, 0, waiting_tiles, ['white'], hand)
    depleted = evaluate_hand_progress(
        hand, 0, waiting_tiles, ['white'],
        [*hand, 'south', 'south', 'south', 'west', 'west', 'west'])
    assert base['shanten'] == 1
    assert base['ukeire'] > depleted['ukeire']
