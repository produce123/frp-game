"""动作执行层单元测试 —— 逐条对照 src/game/actions.test.ts 翻译"""

from types import SimpleNamespace

from app.core.actions import perform_discard_gang, perform_peng, remove_last_discard, remove_matches
from app.models.game import GamePlayer, Meld


def player(hand=None, seat=0) -> GamePlayer:
    return GamePlayer(
        name='P', avatar='', score=1000, seat=seat,
        hand=hand or [], discards=[], melds=[], redCount=0, drawnTileIndex=1,
    )


class FakeContext:
    """对应 TS 端 context() helper：记录事件字符串便于断言"""

    def __init__(self, players, current_player=0):
        self.players = players
        self.current_player = SimpleNamespace(value=current_player)
        self.events: list[str] = []

    def show_table_action(self, type_, actor_index, _source_index, tile, meld_index):
        self.events.append(f'action:{type_}:{actor_index}:{tile}:{meld_index}')

    def show_score_flow(self, deltas):
        self.events.append('score:' + ','.join(f'{d["playerIndex"]}:{d["amount"]}' for d in deltas))

    def play_sound(self, name, volume=None):
        self.events.append(f'sound:{name}')


class TestRemoveMatches:
    """对应 actions.test.ts 'removeMatches / removeLastDiscard'"""

    def test_remove_matches_and_keep_original(self):
        """移除指定张数并保持原数组不变"""
        hand = ['m1', 'm2', 'm1', 'm3']
        assert remove_matches(hand, 'm1', 2) == ['m2', 'm3']
        assert hand == ['m1', 'm2', 'm1', 'm3']

    def test_remove_last_discard_only_when_match(self):
        """只移除最后一张且匹配才移除"""
        pile = ['m1', 'east']
        remove_last_discard(pile, 'east')
        assert pile == ['m1']
        remove_last_discard(pile, 'm9')  # 末张不匹配，不动
        assert pile == ['m1']


class TestPerformPeng:
    """对应 actions.test.ts 'performPeng 共享碰执行'"""

    def test_remove_two_hand_tiles_discard_pile_and_set_current(self):
        """移除手牌 2 张、消掉弃牌、组成碰副露并轮到本家"""
        players = [
            player(['east', 'east', 'm1', 'm2']),
            player(['m1', 'm2'], 1),
            player([], 2),
            player([], 3),
        ]
        players[1].discards = ['s1', 'east']
        ctx = FakeContext(players)
        perform_peng(ctx, 0, 'east', 1)

        assert players[0].hand == ['m1', 'm2']
        assert players[0].drawnTileIndex == -1
        assert players[0].melds == [Meld(type='peng', tile='east', from_=1, tiles=['east', 'east', 'east'])]
        assert players[1].discards == ['s1']
        assert ctx.current_player.value == 0
        assert ctx.events == [
            'action:peng:0:east:0',
            'sound:peng.mp3',
        ]

    def test_works_for_any_seat_including_ai(self):
        """对任意座位（含 AI）同样生效"""
        players = [
            player(['east', 'm1', 'm2']),
            player([], 1),
            player(['p5', 'p5', 'm9', 'm9'], 2),
            player([], 3),
        ]
        players[0].discards = ['p5']
        ctx = FakeContext(players)
        perform_peng(ctx, 2, 'p5', 0)

        assert players[2].hand == ['m9', 'm9']
        assert players[2].melds[0] == Meld(type='peng', tile='p5', from_=0, tiles=['p5', 'p5', 'p5'])
        assert players[0].discards == []
        assert ctx.current_player.value == 2


class TestPerformDiscardGang:
    """对应 actions.test.ts 'performDiscardGang 共享点杠执行'"""

    def test_remove_three_hand_tiles_make_kong_and_score(self):
        """移除手牌 3 张、组成杠副露、结算点杠分数并轮到本家"""
        players = [
            player(['east', 'east', 'east', 'm1']),
            player(['m1'], 1),
            player([], 2),
            player([], 3),
        ]
        players[1].discards = ['s1', 'east']
        ctx = FakeContext(players)
        perform_discard_gang(ctx, 0, 'east', 1)

        assert players[0].hand == ['m1']
        assert players[0].melds[0] == Meld(type='gang', tile='east', from_=1, tiles=['east', 'east', 'east', 'east'])
        assert players[1].discards == ['s1']
        assert players[0].score == 1100
        assert players[1].score == 900
        assert ctx.current_player.value == 0
        assert 'sound:gang.mp3' in ctx.events
        assert 'score:0:100,1:-100' in ctx.events

    def test_works_for_any_seat_including_ai(self):
        """对任意座位（含 AI）同样生效"""
        players = [
            player(['s9', 'm1']),
            player([], 1),
            player(['s9', 's9', 's9', 'p2'], 2),
            player([], 3),
        ]
        players[0].discards = ['s9']
        ctx = FakeContext(players)
        perform_discard_gang(ctx, 2, 's9', 0)

        assert players[2].hand == ['p2']
        assert players[2].melds[0].type == 'gang'
        assert players[0].score == 900
        assert players[2].score == 1100
        assert ctx.current_player.value == 2
