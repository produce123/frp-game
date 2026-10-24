"""跟庄规则：开局第一圈庄家首弃后三家各出一张同牌 → 庄家向三家各付一个底分。"""

from app.game.manager import GameManager
from app.game.player import AIPlayer
from app.rules.lianhua import LianhuaGuangmaRuleSet
from app.rules.lotus_legacy import LotusLegacyRuleSet
from app.settlement import settlement_service


def test_calculate_follow_dealer_deltas():
    result = settlement_service.calculate_follow_dealer(player_count=4, dealer_index=0, base_score=100)
    assert result.as_list() == [
        {'playerIndex': 0, 'amount': -300},
        {'playerIndex': 1, 'amount': 100},
        {'playerIndex': 2, 'amount': 100},
        {'playerIndex': 3, 'amount': 100},
    ]


def test_follow_dealer_triggers_after_three_followers():
    rules = LotusLegacyRuleSet()
    rules.round_state.joker_tiles = []
    manager = GameManager(controllers=[AIPlayer() for _ in range(4)], rule_set=rules)
    manager._reset_players()
    before = [p.score for p in manager.players]

    # 庄家（座位 0）首弃 north，三家依次跟打 north。
    manager._check_follow_dealer(0, 'north')
    manager._check_follow_dealer(1, 'north')
    manager._check_follow_dealer(2, 'north')
    manager._check_follow_dealer(3, 'north')

    after = [p.score for p in manager.players]
    assert after[0] == before[0] - 300
    assert after[1] == before[1] + 100
    assert after[2] == before[2] + 100
    assert after[3] == before[3] + 100
    assert manager.announcement['text'] == '跟庄'


def test_follow_dealer_invalidated_by_different_tile():
    rules = LotusLegacyRuleSet()
    rules.round_state.joker_tiles = []
    manager = GameManager(controllers=[AIPlayer() for _ in range(4)], rule_set=rules)
    manager._reset_players()
    before = [p.score for p in manager.players]

    manager._check_follow_dealer(0, 'north')
    manager._check_follow_dealer(1, 'south')  # 不同牌 → 失效
    manager._check_follow_dealer(2, 'north')
    manager._check_follow_dealer(3, 'north')

    assert [p.score for p in manager.players] == before
    assert manager.announcement is None


def test_follow_dealer_invalidated_by_interrupt():
    rules = LotusLegacyRuleSet()
    rules.round_state.joker_tiles = []
    manager = GameManager(controllers=[AIPlayer() for _ in range(4)], rule_set=rules)
    manager._reset_players()
    before = [p.score for p in manager.players]

    manager._check_follow_dealer(0, 'north')
    manager._check_follow_dealer(1, 'north')
    manager._interrupt_follow_dealer()  # 碰/杠/吃
    manager._check_follow_dealer(2, 'north')
    manager._check_follow_dealer(3, 'north')

    assert [p.score for p in manager.players] == before


def test_follow_dealer_applies_to_guangma_ruleset():
    rules = LianhuaGuangmaRuleSet()
    manager = GameManager(controllers=[AIPlayer() for _ in range(4)], rule_set=rules)
    manager._reset_players()
    before = [p.score for p in manager.players]

    manager._check_follow_dealer(0, 'north')
    manager._check_follow_dealer(1, 'north')
    manager._check_follow_dealer(2, 'north')
    manager._check_follow_dealer(3, 'north')

    assert manager.players[0].score == before[0] - 300
    assert manager.players[1].score == before[1] + 100
    assert manager.players[2].score == before[2] + 100
    assert manager.players[3].score == before[3] + 100
