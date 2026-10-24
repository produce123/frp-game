"""纯结算服务：计算与状态写入分离。"""

from app.core.rules import apply_kong_score, apply_win_score
from app.models.game import GamePlayer
from app.settlement import SettlementService


def players() -> list[GamePlayer]:
    return [
        GamePlayer(
            name=f'P{i}', avatar='', score=1000, seat=i,
            hand=[], discards=[], melds=[], redCount=0, drawnTileIndex=-1,
        )
        for i in range(4)
    ]


def test_calculate_win_is_pure_then_apply_preserves_total_score():
    service = SettlementService()
    table = players()

    # 庄家倍率已取消：闲家胡牌三家同额支付。
    result = service.calculate_win(4, winner_index=1, points=100, dealer_index=0)

    assert [p.score for p in table] == [1000, 1000, 1000, 1000]
    assert result.total_won == 300
    assert result.as_list() == [
        {'playerIndex': 1, 'amount': 300},
        {'playerIndex': 0, 'amount': -100},
        {'playerIndex': 2, 'amount': -100},
        {'playerIndex': 3, 'amount': -100},
    ]
    service.apply_deltas(table, result.deltas)
    assert [p.score for p in table] == [900, 1300, 900, 900]
    assert sum(p.score for p in table) == 4000


def test_calculate_discard_and_robbed_kong_win_has_one_payer():
    service = SettlementService()
    result = service.calculate_win(4, winner_index=2, points=300, payer_index=3,
                                   dealer_index=0)
    assert result.total_won == 300
    assert result.as_list() == [
        {'playerIndex': 2, 'amount': 300},
        {'playerIndex': 3, 'amount': -300},
    ]


def test_calculate_all_kong_types_without_mutating_players():
    service = SettlementService()
    table = players()

    assert service.calculate_kong(4, 0, 'discard', 100, 2).as_list() == [
        {'playerIndex': 0, 'amount': 100},
        {'playerIndex': 2, 'amount': -100},
    ]
    assert service.calculate_kong(4, 0, 'concealed', 100).as_list() == [
        {'playerIndex': 0, 'amount': 600},
        {'playerIndex': 1, 'amount': -200},
        {'playerIndex': 2, 'amount': -200},
        {'playerIndex': 3, 'amount': -200},
    ]
    assert service.calculate_kong(4, 0, 'added', 100).as_list() == [
        {'playerIndex': 0, 'amount': 300},
        {'playerIndex': 1, 'amount': -100},
        {'playerIndex': 2, 'amount': -100},
        {'playerIndex': 3, 'amount': -100},
    ]
    assert [p.score for p in table] == [1000, 1000, 1000, 1000]


def test_legacy_score_helpers_delegate_and_keep_mutating_contract():
    win_players = players()
    kong_players = players()

    assert apply_win_score(win_players, 1, 100, None, 0) == 300
    assert [p.score for p in win_players] == [900, 1300, 900, 900]
    assert apply_kong_score(kong_players, 0, 'added') == [
        {'playerIndex': 0, 'amount': 300},
        {'playerIndex': 1, 'amount': -100},
        {'playerIndex': 2, 'amount': -100},
        {'playerIndex': 3, 'amount': -100},
    ]
