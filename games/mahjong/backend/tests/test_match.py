"""场次推进单元测试 —— 逐条对照 src/game/match.test.ts 翻译"""

from app.game.manager import advance_match_state


BASE = {'round_': 1, 'dealer': 0, 'honba': 0, 'match_type': 'east', 'scores': [1000, 1000, 1000, 1000]}


class TestAdvanceMatchState:
    """对应 match.test.ts '场次推进'"""

    def test_dealer_win_keeps_seat_and_increases_honba(self):
        """庄家和牌时连庄并增加本场"""
        assert advance_match_state(**BASE, result={'winnerIndex': 0}) == {
            'round': 1, 'dealer': 0, 'honba': 1, 'finished': False,
        }

    def test_non_dealer_win_next_round_and_dealer_shift(self):
        """闲家和牌时进入下一局并顺移庄位"""
        assert advance_match_state(**{**BASE, 'honba': 2}, result={'winnerIndex': 2}) == {
            'round': 2, 'dealer': 1, 'honba': 0, 'finished': False,
        }

    def test_east_four_ends_east_match_hanchan_continues(self):
        """东四结束后结束东风场，半庄场则进入南一"""
        east_four = {**BASE, 'round_': 4, 'dealer': 3, 'result': {'winnerIndex': 1}}
        east_result = advance_match_state(**east_four)
        assert east_result['round'] == 5
        assert east_result['dealer'] == 0
        assert east_result['finished'] is True

        hanchan_result = advance_match_state(**{**east_four, 'match_type': 'hanchan'})
        assert hanchan_result['round'] == 5
        assert hanchan_result['dealer'] == 0
        assert hanchan_result['finished'] is False

    def test_draw_dealer_noten_shifts_dealer(self):
        """流局且庄家未听牌 → 下庄（庄位轮转）"""
        result = advance_match_state(**BASE, result={'draw': True, 'dealerTenpai': False})
        assert result == {'round': 2, 'dealer': 1, 'honba': 0, 'finished': False}

    def test_draw_dealer_tenpai_keeps_seat(self):
        """流局且庄家听牌 → 连庄（round/dealer 不变，honba+1）"""
        result = advance_match_state(**BASE, result={'draw': True, 'dealerTenpai': True})
        assert result == {'round': 1, 'dealer': 0, 'honba': 1, 'finished': False}

    def test_finished_when_round_exceeds_match_hands(self):
        """局数超过场次上限时 finished"""
        # 半庄场 8 局：第 8 局结束后 finished
        result = advance_match_state(
            round_=8, dealer=3, honba=0, match_type='hanchan',
            scores=[1000] * 4, result={'winnerIndex': 1},
        )
        assert result['round'] == 9
        assert result['finished'] is True
