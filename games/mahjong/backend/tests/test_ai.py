"""AI 决策层单元测试 —— 逐条对照 src/game/ai.test.ts 翻译"""

from app.core.ai import (
    _opponent_threat,
    choose_discard_index,
    decide_claim,
    decide_rob_kong,
    decide_turn,
    make_turn_view,
)
from app.models.game import GamePlayer, Meld


def view(hand, melds=None, exposed_melds=0, kong_bloom=False) -> dict:
    return {'hand': hand, 'melds': melds or [], 'exposedMelds': exposed_melds, 'kongBloom': kong_bloom}


class TestDecideTurnWin:
    """对应 ai.test.ts 'decideTurn 自摸胡'"""

    def test_winning_hand_returns_win(self):
        """牌型可胡时返回 win"""
        hand = ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east']
        assert decide_turn(view(hand)) == {'kind': 'win'}

    def test_white_joker_as_any_tile_for_win(self):
        """白板（癞子）可当任意牌参与胡牌"""
        hand = ['m1', 'm1', 'm1', 'm2', 'm3', 'white', 'p4', 'p5', 'p6', 's7', 's7', 's7', 'east', 'east']
        assert decide_turn(view(hand)) == {'kind': 'win'}


class TestDecideTurnAddedKong:
    """对应 ai.test.ts 'decideTurn 补杠'"""

    def test_peng_with_fourth_in_hand_returns_added_kong(self):
        """已碰且有第四张在手时返回 added-kong"""
        melds = [Meld(type='peng', tile='east', from_=1, tiles=['east', 'east', 'east'])]
        hand = ['east', 'm1', 'm2']
        assert decide_turn(view(hand, melds, 1)) == {'kind': 'added-kong', 'meldIndex': 0}


class TestDecideTurnConcealedKong:
    """对应 ai.test.ts 'decideTurn 暗杠'"""

    def test_four_of_kind_returns_concealed_kong(self):
        """手牌有 4 张相同牌时返回 concealed-kong"""
        hand = ['s7', 's7', 's7', 's7', 'm1', 'm2', 'm3', 'p4', 'p5', 'east', 'east']
        assert decide_turn(view(hand)) == {'kind': 'concealed-kong', 'tile': 's7'}


class TestDecideTurnDiscard:
    """对应 ai.test.ts 'decideTurn 弃牌'"""

    def test_discard_when_no_win_or_kong(self):
        """无胡/无杠时返回 discard 且索引在合法范围"""
        hand = ['m1', 'p4', 'p5', 'p6', 'east', 's2', 's2', 's9', 's9', 'white', 'white']
        decision = decide_turn(view(hand))
        assert decision['kind'] == 'discard'
        assert 0 <= decision['handIndex'] < len(hand)


class TestChooseDiscardIndex:
    """对应 ai.test.ts 'chooseDiscardIndex 弃牌启发式'"""

    def test_discard_lone_tile_first(self):
        """优先打掉无对无靠的孤张"""
        hand = ['m1', 'm2', 'm3', 'p5', 'p5', 'east']
        index = choose_discard_index(hand, lambda: 0)
        assert hand[index] == 'east'

    def test_white_joker_kept(self):
        """癞子白板保手，优先打其它孤张"""
        hand = ['white', 's9', 's9', 'm7']
        index = choose_discard_index(hand, lambda: 0)
        assert hand[index] == 'm7'

    def test_pair_and_neighbors_discarded_last(self):
        """对子与靠张越多越靠后打"""
        hand = ['m1', 'm2', 'm3', 'p5', 'p5', 'north']
        index = choose_discard_index(hand, lambda: 0)
        assert hand[index] == 'north'

    def test_tenpai_keeps_key_tile(self):
        """已听牌时优先保留听口（不打听牌所需的关键张）"""
        hand = ['m1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east', 'east', 'north', 'white']
        index = choose_discard_index(hand, lambda: 0, exposed_melds=0)
        assert hand[index] == 'north'

    def test_same_shanten_prefers_more_live_ukeire(self):
        hand = [
            'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3',
            'east', 'east', 'south', 'west', 'north',
        ]
        visible = [*hand, 'south', 'south', 'south']
        index = choose_discard_index(
            hand, lambda: 0, exposed_melds=0,
            context={'visibleTiles': visible})
        assert hand[index] == 'south'


class TestDecideClaim:
    """对应 ai.test.ts 'decideClaim 吃碰杠响应'"""

    def test_gang_when_can_gang(self):
        assert decide_claim({'hand': ['east', 'east', 'east', 'm1'], 'canGang': True}) == 'gang'

    def test_gang_instead_of_peng_then_discarding_same_tile(self):
        hand = [
            'east', 'east', 'east',
            'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'north',
        ]
        assert decide_claim({
            'hand': hand, 'canGang': True, 'tile': 'east', 'exposedMelds': 0,
            'visibleTiles': [*hand, 'east'],
        }) == 'gang'

    def test_peng_when_not_can_gang(self):
        assert decide_claim({'hand': ['east', 'east', 'm1'], 'canGang': False}) == 'peng'

    def test_pass_when_peng_breaks_tenpai(self):
        """碰后听口未提升时 pass"""
        hand = ['east', 'east', 'm1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 'north', 'south', 'west']
        assert decide_claim({'hand': hand, 'canGang': False, 'tile': 'east', 'exposedMelds': 0}) == 'pass'

    def test_peng_when_improves_tenpai(self):
        """碰后听口更优时选择 peng"""
        hand = ['m1', 'm2', 'm3', 'p4', 'p5', 'p6', 's7', 's8', 's9', 'east', 'east', 'north', 'white']
        assert decide_claim({'hand': hand, 'canGang': False, 'tile': 'east', 'exposedMelds': 0}) == 'peng'


class TestDecideTurnKongEvaluation:
    """对应 ai.test.ts 'decideTurn 杠决策评估'"""

    def test_no_concealed_kong_when_tenpai(self):
        """已听牌时放弃暗杠（避免拆散成形手牌）"""
        hand = ['east', 'east', 'east', 'east', 'm2', 'm3', 'm4', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'north']
        assert decide_turn(view(hand))['kind'] != 'concealed-kong'

    def test_concealed_kong_when_scattered(self):
        """未听牌时仍暗杠"""
        hand = ['s7', 's7', 's7', 's7', 'm1', 'm2', 'm3', 'p4', 'p5', 'east', 'east']
        assert decide_turn(view(hand)) == {'kind': 'concealed-kong', 'tile': 's7'}

    def test_no_added_kong_when_tenpai(self):
        """已听牌时放弃补杠"""
        melds = [Meld(type='peng', tile='east', from_=1, tiles=['east', 'east', 'east'])]
        hand = ['east', 'm2', 'm3', 'm4', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'north']
        assert decide_turn(view(hand, melds, 1))['kind'] != 'added-kong'


class TestAddedKongRobRiskGate:
    """广麻补杠 gate（对应 src/game/core/controllers/ai.ts 的 addedKongRobRisk）。

    残局（墙余 ≤ 16）+ 该牌在公共牌池完全未现 + 对手最高风险档 ≥ 1 → 不补杠。
    保留既有 `_opponent_threat(view) < 10` 逻辑不变。
    """

    MELDS = [Meld(type='peng', tile='east', from_=1, tiles=['east', 'east', 'east'])]
    # 副露 1 组（东）+ 13 张手牌：补杠后 12 张 → 与 1 副露正好构成 4 组成形。
    HAND = ['east', 'm2', 'm3', 'm4', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'p4', 'p5', 'south']

    @staticmethod
    def kong_view(**overrides) -> dict:
        base = {
            'hand': list(TestAddedKongRobRiskGate.HAND),
            'melds': list(TestAddedKongRobRiskGate.MELDS),
            'exposedMelds': 1, 'kongBloom': False, 'jokers': [],
            'wallCount': 12, 'publicTiles': [], 'visibleTiles': [],
            'peers': [{'discards': [], 'melds': []} for _ in range(4)],
            'playerIndex': 0,
        }
        base.update(overrides)
        return base

    @staticmethod
    def signal_peers(discards=()) -> list[dict]:
        """带公共风险信号的对手：只用牌河 / 副露，不含暗手。

        座位 1 门清但牌河 9 张、条子只出现 1 张 → 弱信号 tier 1（`牌河未见条`）；
        该家没有副露 → 既有 `_opponent_threat` = 0（旧 gate 不命中），
        因此测试里改 publicTiles（该牌是否已现）就是唯一的自变量。
        """
        balanced = ['m1', 'm4', 'm7', 'p1', 'p4', 'p7', 's1', 's4', 's7', 'east', 'south',
                    'west', 'north', 'red', 'green']
        weak_signal = [*discards, 'm1', 'm2', 'm3', 'p2', 'p3', 'p4', 's5', 'east', 'south']
        return [
            {'discards': list(balanced), 'melds': []},
            {'discards': list(weak_signal), 'melds': []},
            {'discards': list(balanced), 'melds': []},
            {'discards': list(balanced), 'melds': []},
        ]

    def test_late_game_unseen_tile_with_opponent_signal_declines_kong(self):
        view = self.kong_view(wallCount=12, publicTiles=[],
                              peers=self.signal_peers(discards=['west']))
        assert _opponent_threat(view) < 10      # 只可能由抢杠风险 gate 拦下
        assert decide_turn(view)['kind'] == 'discard'

    def test_late_game_unseen_tile_without_signal_takes_kong(self):
        """无任何公共信号（牌河均衡、无副露）：既无风险档也无旧 threat → 补杠。"""
        balanced = ['m1', 'm4', 'm7', 'p1', 'p4', 'p7', 's1', 's4', 's7', 'east', 'south',
                    'west', 'north', 'red', 'green']
        quiet = [{'discards': list(balanced), 'melds': []} for _ in range(4)]
        view = self.kong_view(wallCount=12, publicTiles=[], peers=quiet)
        assert _opponent_threat(view) < 10
        assert decide_turn(view) == {'kind': 'added-kong', 'meldIndex': 0}

    def test_late_game_seen_tile_takes_kong(self):
        """该牌已在公共牌池出现 → 抢杠风险 gate 不成立（同一批对手牌河下补杠）。"""
        view = self.kong_view(wallCount=12, publicTiles=['east'],
                              peers=self.signal_peers(discards=['east']))
        assert _opponent_threat(view) < 10
        assert decide_turn(view) == {'kind': 'added-kong', 'meldIndex': 0}

    def test_early_round_many_walls_takes_kong(self):
        """早局（墙余 60）：对手风险档虽 ≥1，仍按既有逻辑补杠。"""
        discards = ['m1', 'm4', 'm7', 'p1', 'p4', 'p7', 's1', 's4', 's7', 'east', 'south',
                    'west', 'north', 'red', 'green']
        peers = [{'discards': [], 'melds': []},
                 {'discards': list(discards), 'melds': []},
                 {'discards': [], 'melds': []},
                 {'discards': [], 'melds': []}]
        decision = decide_turn(self.kong_view(wallCount=60, publicTiles=[], peers=peers))
        assert decision == {'kind': 'added-kong', 'meldIndex': 0}

    def test_strong_meld_threat_still_blocks_kong_without_risk_signal(self):
        """既有 `_opponent_threat >= 10` 逻辑保留：三组对手副露（12 ≥ 10）仍然不补杠。

        该牌仍在公共牌池未现（本任务新增的 gate 也会命中），断言只覆盖「仍不补杠」。
        """
        peers = [{'discards': [], 'melds': []},
                 {'discards': ['m1', 'm9', 'p1', 'p9', 's1'], 'melds': [
                     {'type': 'peng', 'tile': 'p4', 'tiles': ['p4', 'p4', 'p4']},
                     {'type': 'peng', 'tile': 'm4', 'tiles': ['m4', 'm4', 'm4']},
                     {'type': 'peng', 'tile': 's4', 'tiles': ['s4', 's4', 's4']},
                 ]},
                 {'discards': [], 'melds': []},
                 {'discards': [], 'melds': []}]
        view = self.kong_view(wallCount=12, publicTiles=[], peers=peers)
        assert _opponent_threat(view) >= 10
        assert decide_turn(view)['kind'] == 'discard'


class TestDecideRobKong:
    """对应 ai.test.ts 'decideRobKong 抢杠'"""

    def test_rob_kong_always_win(self):
        """当前 AI 能抢必抢"""
        assert decide_rob_kong({'hand': ['east', 'east', 'm1', 'm2'], 'exposedMelds': 1, 'tile': 'east', 'from': 2}) == 'win'


class TestMakeTurnView:
    """对应 ai.test.ts 'makeTurnView 快照构造'"""

    def test_only_exposes_hand_and_melds(self):
        """只暴露手牌与副露，不含分数等无关字段"""
        player = GamePlayer(
            name='AI', avatar='', score=1000, seat=1,
            hand=['m1', 'm2'], discards=[], melds=[], redCount=0, drawnTileIndex=-1,
        )
        assert make_turn_view(player, 0, True) == {
            'hand': ['m1', 'm2'],
            'melds': [],
            'exposedMelds': 0,
            'kongBloom': True,
        }
