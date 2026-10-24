"""莲花麻将（lotus-legacy）策略 AI 单元测试 —— 对照 src/game/variants/lotus/lotusAi.ts。

验证与经典 AI 的关键差异：副露决策按听牌质量取舍（不提升则 pass），
弃牌启发式按听口/剩余张/安全度打分（癞子保手），杠决策评估破坏听牌/被抢杠风险。
"""

from app.core.lotus_ai import (
    choose_discard_index,
    decide_claim,
    decide_turn,
    is_tenpai,
    should_take_added_kong,
    should_take_concealed_kong,
)


class TestLotusDecideTurn:
    """对应 lotusAi.ts decideTurn（回合决策，含杠评估）。"""

    def test_win_when_can_win(self):
        hand = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 's7', 's7', 's7', 'east', 'east']
        assert decide_turn({'hand': hand, 'exposedMelds': 0, 'melds': [], 'jokers': []}) == {'kind': 'win'}

    def test_added_kong_when_safe(self):
        hand = ['east', 'm5', 'm6', 'p3', 'p4', 's7', 's8', 's9', 'north', 'south', 'west']
        view = {'hand': hand, 'exposedMelds': 1, 'jokers': [],
                'melds': [{'type': 'peng', 'tile': 'east', 'tiles': ['east', 'east', 'east']}],
                'publicTiles': ['east']}
        assert decide_turn(view)['kind'] == 'added-kong'

    def test_no_concealed_kong_when_tenpai(self):
        # 已听牌（打出 east 后 13 张听 north）时放弃暗杠。
        hand = ['east', 'east', 'east', 'east', 'm2', 'm3', 'm4', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'north']
        assert is_tenpai(hand, 0, []) is True
        assert should_take_concealed_kong({'hand': hand, 'exposedMelds': 0, 'jokers': []}) is False

    def test_concealed_kong_when_scattered(self):
        hand = ['m1', 'm1', 'm1', 'm1', 'm5', 'm6', 'p3', 'p4', 's7', 's8', 'east', 'south', 'west', 'north']
        assert should_take_concealed_kong({'hand': hand, 'exposedMelds': 0, 'jokers': []}) is True

    def test_four_wind_wait_does_not_get_broken_by_wind_kong(self):
        # 两副露后的摸牌态：打出 p9 后，3条4条5条 + 东南西北听任一风牌。
        hand = ['s3', 's4', 's5', 'east', 'south', 'west', 'north', 'p9']
        decision = decide_turn({
            'hand': hand, 'exposedMelds': 2, 'melds': [], 'jokers': [],
            'visibleTiles': hand,
        })
        assert decision['kind'] == 'discard'
        assert hand[decision['handIndex']] == 'p9'


class TestLotusDecideClaim:
    """对应 lotusAi.ts decideClaim（策略副露决策）。"""

    def test_gang_when_can_gang(self):
        """能杠必杠（杠后从牌尾补牌，无法凭当前手牌准确判断，保留最高优先级）。"""
        hand = ['east', 'east', 'east', 'm1', 'm2', 'm3', 'p1', 'p2', 'p3',
                's1', 's2', 's3', 'north']
        decision = decide_claim({
            'hand': hand, 'exposedMelds': 0, 'jokers': [],
            'tile': 'east', 'canGang': True, 'canPeng': True, 'chiOptions': [],
        })
        assert decision == {'kind': 'gang'}

    def test_pass_when_peng_breaks_tenpai(self):
        """碰牌会破坏听牌时 pass（经典 AI 会无脑碰，这是关键差异）。"""
        hand = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p1', 'p2', 'p3',
                's1', 's2', 'east', 'east']
        decision = decide_claim({
            'hand': hand, 'exposedMelds': 0, 'jokers': [],
            'tile': 'east', 'canGang': False, 'canPeng': True, 'chiOptions': [],
        })
        assert decision == {'kind': 'pass'}


class TestLotusChooseDiscardIndex:
    """对应 lotusAi.ts chooseDiscardIndex（质量打分弃牌）。"""

    def test_joker_kept(self):
        """白板（癞子）保手，优先打其它孤张。"""
        hand = ['white', 's9', 's9', 'm7']
        index = choose_discard_index(hand, [], random=lambda: 0)
        assert hand[index] == 'm7'

    def test_thirteen_orphans_keeps_terminals(self):
        """13 种幺九 + 孤张 m4：应打 m4 保留十三幺方向。"""
        hand = ['m1', 'm9', 'p1', 'p9', 's1', 's9', 'east', 'south', 'west',
                'north', 'red', 'green', 'white', 'm4']
        index = choose_discard_index(hand, [], random=lambda: 0, options={
            'exposedMelds': 0,
            'visibleTiles': [*hand, 'm4'],
            'publicTiles': ['m4', 'm4', 'm4'],
        })
        assert hand[index] == 'm4'


def test_non_joker_white_is_discarded_for_two_sided_wait():
    hand = ['m1', 'm2', 'm3', 'p2', 'p3', 's5', 's5', 'white']
    for wall_count in (90, 40):
        index = choose_discard_index(hand, ['s8', 's9'], lambda: 0,
                                     {'exposedMelds': 2, 'wallCount': wall_count})
        assert hand[index] == 'white'


def test_substitute_white_is_kept_when_it_completes_a_meld():
    hand = ['s6', 's7', 'white', 'p2', 'p3', 's5', 's5', 'east']
    index = choose_discard_index(hand, ['s8', 's9'], lambda: 0, {'exposedMelds': 2})
    assert hand[index] == 'east'
