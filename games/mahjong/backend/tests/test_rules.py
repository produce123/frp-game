"""规则引擎单元测试 —— 逐条对照 src/game/rules.test.ts 翻译

每个 TS 用例 → 至少一个等价 Python 用例，保证规则翻译零漂移。
"""

from app.core.rules import (
    BASE_SCORE,
    apply_kong_score,
    apply_win_score,
    can_rob_kong,
    concealed_kongs,
    draw_horses,
    is_winning_hand,
    meld_source_tile_index,
    score_hand,
    waiting_tiles,
)
from app.models.game import GamePlayer, Meld


def make_players() -> list[GamePlayer]:
    """构造 4 名初始 1000 分的玩家（对应 TS 端 players() helper）"""
    return [
        GamePlayer(name=f'测试玩家{i + 1}', avatar='', score=1000, seat=i,
                   hand=[], discards=[], melds=[], redCount=0, drawnTileIndex=-1)
        for i in range(4)
    ]


class TestWinningHand:
    """对应 rules.test.ts '莲花广麻胡牌规则'"""

    def test_standard_self_draw_hand(self):
        """识别标准自摸牌型"""
        assert is_winning_hand([
            'm1', 'm2', 'm3',
            'm4', 'm5', 'm6',
            'p2', 'p3', 'p4',
            's7', 's7', 's7',
            'east', 'east',
        ]) is True

    def test_white_joker_replaces_missing_tile(self):
        """白板可代替任意缺牌"""
        assert is_winning_hand([
            'm1', 'm2', 'white',
            'm4', 'm5', 'm6',
            'p2', 'p3', 'p4',
            's7', 's7', 's7',
            'east', 'white',
        ]) is True

    def test_normal_discard_not_win_but_kong_tile_triggers_rob(self):
        """普通弃牌不胡但补杠牌可触发抢杠胡判定"""
        waiting = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east']
        assert can_rob_kong(waiting, 'east') is True

    def test_one_exposed_meld_eleven_tiles(self):
        """有一组副露时按十一张牌判断"""
        assert is_winning_hand(['m1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east'], 1) is True

    def test_one_exposed_meld_three_white_jokers(self):
        """一组副露且三张白板补齐牌型时可以胡牌"""
        assert is_winning_hand([
            'm4', 'm6', 'p3', 'p5', 'p8',
            's4', 's5', 's6',
            'white', 'white', 'white',
        ], 1) is True

    def test_waiting_tiles_contains_east(self):
        """列出听牌时可胡的牌"""
        assert 'east' in waiting_tiles([
            'm1', 'm2', 'm3',
            'm4', 'm5', 'm6',
            'p2', 'p3', 'p4',
            's7', 's7', 's7',
            'east',
        ])

    def test_waiting_tiles_p3_p6_after_discarding_p5(self):
        """打出多余五筒后提示三筒和六筒"""
        hand = ['m2', 'm2', 'm5', 'm6', 'm7', 'p1', 'p2', 'p3', 'p4', 'p5', 's2', 's3', 's4']
        waits = waiting_tiles(hand)
        assert 'p3' in waits
        assert 'p6' in waits

    def test_joker_fills_sequence_front_with_all_waits(self):
        """癞子可补顺子前端，并列出截图手牌的全部听口"""
        hand = ['m7', 'm7', 'p8', 'p9', 's3', 's3', 'north', 'north', 'white', 'white']
        waits = waiting_tiles(hand, 1)
        for tile in ['m7', 'p7', 's3', 'north', 'white']:
            assert tile in waits

    def test_white_joker_cannot_concealed_kong(self):
        """白板作为癞子不能开暗杠"""
        assert concealed_kongs(['white', 'white', 'white', 'white', 'm1']) == []
        assert concealed_kongs(['m1', 'm1', 'm1', 'm1', 'white']) == ['m1']


class TestHorseAndScore:
    """对应 rules.test.ts '买马与计分'"""

    def test_draw_from_wall_head_by_seat(self):
        """从牌头摸马，中马按庄家座位判定"""
        wall = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'p1']
        result = draw_horses(wall, amount=8, seat=0)
        assert result['horses'] == ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']
        assert wall == ['m9', 'p1']  # 原地消耗牌头
        assert result['hits'] == 2  # m1、m5 是庄家(1/5/9)中马

    def test_four_red_flat_then_horses_and_reds_add(self):
        """四红中固定 ×1，中马与红中按张数乘底分加算（庄家倍率已取消）"""
        score = score_hand(dealer=True, no_joker=True, four_red=True, horse_hits=2, red_count=4)
        assert score['multiplier'] == 1
        assert score['totalMultiplier'] == 7
        assert score['horsePoints'] == 200
        assert score['redPoints'] == 400
        assert score['points'] == 700

    def test_kong_bloom_doubles_and_records_detail(self):
        """杠上开花翻倍并写入计分明细"""
        score = score_hand(kong_bloom=True)
        assert score['multiplier'] == 2
        assert score['points'] == 200
        assert {'label': '杠上开花', 'multiplier': 2} in score['details']

    def test_points_strictly_base_times_multiplier_plus_horses_and_reds(self):
        """总分 = 底分 × 倍数 + 中马底分 + 红中底分（庄家倍率已取消）"""
        score = score_hand(dealer=True, no_joker=True, horse_hits=3, red_count=2)
        assert score['multiplier'] == 2
        assert score['totalMultiplier'] == 7
        assert score['redPoints'] == 200
        assert score['points'] == 700
        assert {'label': '庄家', 'multiplier': 2} not in score['details']
        assert {'label': '红中 2 张', 'points': 200} in score['details']


class TestKongAndWinScore:
    """对应 rules.test.ts '开杠与抢杠计分'"""

    def test_concealed_kong_three_payers_double_base(self):
        """暗杠由其余三家各支付底分两倍"""
        players = make_players()
        deltas = apply_kong_score(players, 0, 'concealed')
        assert [p.score for p in players] == [1600, 800, 800, 800]
        assert deltas == [
            {'playerIndex': 0, 'amount': 600},
            {'playerIndex': 1, 'amount': -200},
            {'playerIndex': 2, 'amount': -200},
            {'playerIndex': 3, 'amount': -200},
        ]

    def test_discard_kong_only_source_pays(self):
        """明杠只由被杠者支付底分"""
        players = make_players()
        deltas = apply_kong_score(players, 0, 'discard', 2)
        assert [p.score for p in players] == [1100, 1000, 900, 1000]
        assert deltas == [
            {'playerIndex': 0, 'amount': 100},
            {'playerIndex': 2, 'amount': -100},
        ]

    def test_added_kong_three_payers_base(self):
        """补杠由其余三家各支付底分"""
        players = make_players()
        deltas = apply_kong_score(players, 0, 'added')
        assert [p.score for p in players] == [1300, 900, 900, 900]
        assert deltas == [
            {'playerIndex': 0, 'amount': 300},
            {'playerIndex': 1, 'amount': -100},
            {'playerIndex': 2, 'amount': -100},
            {'playerIndex': 3, 'amount': -100},
        ]

    def test_robbed_kong_win_only_kong_payer_pays(self):
        """抢杠胡只由补杠者支付胡牌分"""
        players = make_players()
        assert apply_win_score(players, 1, 180, 3) == 180
        assert [p.score for p in players] == [1000, 1180, 1000, 820]

    def test_non_dealer_win_dealer_multiplier_removed(self):
        """庄家倍率已取消：闲家胡牌时三家同额支付"""
        players = make_players()
        assert apply_win_score(players, 1, 100, None, 0) == 300
        assert [p.score for p in players] == [900, 1300, 900, 900]

    def test_dealer_win_each_other_pays_same_points(self):
        """庄家胡牌时每位闲家同额支付胡牌分（无庄家翻倍）"""
        players = make_players()
        assert apply_win_score(players, 0, 200, None, 0) == 600
        assert [p.score for p in players] == [1600, 800, 800, 800]


class TestMeldSourceIndex:
    """对应 rules.test.ts '副露来源指向'"""

    def make_peng(self, from_seat: int) -> Meld:
        return Meld(type='peng', tile='p3', from_=from_seat, tiles=['p3', 'p3', 'p3'])

    def test_four_seats_map_to_first_middle_last(self):
        """四个座位均按右侧、对家、左侧来源映射到首张、中间和末张"""
        for player_index in range(4):
            assert meld_source_tile_index(self.make_peng((player_index + 1) % 4), player_index) == 0
            assert meld_source_tile_index(self.make_peng((player_index + 2) % 4), player_index) == 1
            assert meld_source_tile_index(self.make_peng((player_index + 3) % 4), player_index) == 2

    def test_right_player_peng_top_player_first_tile(self):
        """右侧玩家碰顶部玩家的牌时横置靠顶部的第一张"""
        assert meld_source_tile_index(self.make_peng(2), 1) == 0


class TestConstants:
    def test_base_score(self):
        assert BASE_SCORE == 100
