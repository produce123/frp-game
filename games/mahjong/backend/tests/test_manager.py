"""整局模拟 —— 对照 src/game/useGame.sim.test.ts 翻译

4 个 AIPlayer 自动跑完东风场 4 局，验证：
- AI 闭环能稳定打完，不卡死、不抛错
- 分数守恒：4 名玩家起始各 1000，任意时刻总和应为 4000
"""

import asyncio

import pytest

from app.game.manager import GameManager
from app.game.player import AIPlayer
from app.models.game import GamePlayer, Meld


async def play_one_match(max_steps: int = 8000) -> dict:
    """打满一整场「东风场」：0 号座位也是 AIPlayer，纯 AI 对局。"""
    manager = GameManager(mode='east', controllers=[AIPlayer() for _ in range(4)])
    await manager.start_game('east')
    settled_rounds: list[int] = []
    steps = 0
    while steps < max_steps:
        steps += 1
        if manager.match_finished or manager.phase == 'finished':
            break
        if manager.phase == 'settled':
            settled_rounds.append(manager.round)
            await manager.next_round()
            continue
        if manager.phase == 'lobby':
            break
        await asyncio.sleep(0)
    return {
        'finished': manager.match_finished or manager.phase == 'finished',
        'steps': steps,
        'phase': manager.phase,
        'round': manager.round,
        'settled_rounds': settled_rounds,
        'scores': [p.score for p in manager.players],
    }


class TestFullEastMatch:
    """对应 useGame.sim.test.ts '整局模拟：东风场自动打完'"""

    @pytest.mark.asyncio
    async def test_three_matches_complete_without_error(self):
        """连续 3 场对局都能打完且无异常"""
        for _ in range(3):
            result = await play_one_match()
            # 每场必须完整打到「finished」，证明 AI 闭环不会卡死
            assert result['finished'] is True
            # 每场至少完成一局才证明闭环在运转
            assert len(result['settled_rounds']) > 0
            # 分数守恒：4 名玩家起始各 1000，任意时刻总和应为 4000
            assert sum(result['scores']) == 4000

    @pytest.mark.asyncio
    async def test_single_match_within_steps_no_infinite_loop(self):
        """单人场在固定步数内能到达结算或打完，不出死循环"""
        result = await play_one_match()
        assert result['steps'] < 8000
        assert result['phase'] in ('finished', 'settled')


class TestGameManagerState:
    """GameManager 状态机的额外验证"""

    @pytest.mark.asyncio
    async def test_four_rounds_settled(self):
        """东风场 4 个局号都产生结算，最后结束在 round 4（连庄时同局号多结算一次）"""
        result = await play_one_match()
        # 东风场 4 局：round 1-4 每个局号至少结算一次；连庄时同一局号可结算多次
        assert {1, 2, 3, 4} <= set(result['settled_rounds'])
        assert len(result['settled_rounds']) >= 4
        # 第 4 局结算后推进到 round 5 触发 finished（东风场最后一局为 4）
        assert result['round'] >= 4

    @pytest.mark.asyncio
    async def test_dealer_advances(self):
        """每局结束后庄位轮转（庄家胡牌 / 流局且庄家听牌时连庄）"""
        manager = GameManager(mode='east', controllers=[AIPlayer() for _ in range(4)])
        await manager.start_game('east')
        assert manager.phase == 'settled'
        # 记录第 1 局的结果与庄位（next_round 会覆盖 result 为第 2 局）
        first_result = manager.result
        dealer_before = manager.dealer
        await manager.next_round()
        # 与 TS 端 advanceMatchState 一致：庄家胡 → 连庄；流局且庄家听牌 → 连庄；否则庄位 +1。
        keeps_seat = (
            (not first_result.get('draw') and first_result.get('winnerIndex') == dealer_before)
            or (first_result.get('draw') and first_result.get('dealerTenpai'))
        )
        if keeps_seat:
            assert manager.dealer == dealer_before
        else:
            assert manager.dealer == (dealer_before + 1) % 4


class TestDiscardGangReplacement:
    """点杠（杠他人弃牌）后只补摸一张 —— 回归：曾连摸两张导致四副露手牌多一张、非单骑"""

    class _StubController:
        def __init__(self):
            self.turn_calls = 0

        async def request_claim(self, ctx):
            return {'kind': 'gang'}

        async def request_turn(self, ctx):
            self.turn_calls += 1
            return {'kind': 'discard', 'handIndex': 0}

        async def request_rob_kong(self, ctx):
            return 'pass'

        def on_discarded(self):
            pass

        def reset(self):
            pass

    def test_tail_draw_uses_top_then_bottom_without_reserving_tiles(self):
        manager = GameManager(mode='east', controllers=[self._StubController() for _ in range(4)])
        manager.wall = [f'tile-{index}' for index in range(136)]
        assert manager._take_tile(from_tail=True) == 'tile-134'
        assert manager._take_tile(from_tail=True) == 'tile-135'
        assert manager._take_tile(from_tail=True) == 'tile-132'
        assert manager._take_tile(from_tail=True) == 'tile-133'
        manager.wall = ['last-tile']
        manager._head_drawn = 135
        assert manager._take_tile(from_tail=True) == 'last-tile'
        assert manager.wall == []

    @pytest.mark.asyncio
    async def test_single_replacement_after_discard_gang(self):
        """点杠只补摸一张：杠后手牌净减 3（13 → 10），不再连摸两张（否则为 11）"""
        stub = self._StubController()
        manager = GameManager(mode='east', controllers=[stub for _ in range(4)])
        manager.players = [
            GamePlayer(name='P0', avatar='', score=1000, seat=0, hand=['m1'],
                       discards=[], melds=[], redCount=0, drawnTileIndex=-1),
            # 1 号有 3 张 m1 可点杠，其余 10 张无关联
            GamePlayer(name='P1', avatar='', score=1000, seat=1,
                       hand=['m1', 'm1', 'm1', 'p2', 'p3', 'p4', 's5', 's6', 's7',
                             'east', 'west', 'south', 'north'],
                       discards=[], melds=[], redCount=0, drawnTileIndex=-1),
            GamePlayer(name='P2', avatar='', score=1000, seat=2, hand=[],
                       discards=[], melds=[], redCount=0, drawnTileIndex=-1),
            GamePlayer(name='P3', avatar='', score=1000, seat=3, hand=[],
                       discards=[], melds=[], redCount=0, drawnTileIndex=-1),
        ]
        manager._table_context.players = manager.players
        manager.wall = ['m9']   # 恰好 1 张：杠后补摸一张后墙空 → 流局
        manager.phase = 'drawing'
        manager.current_player = 0

        # 0 号打出 m1 → 1 号点杠 → 补摸 1 张 → 出 1 张 → 墙空流局
        await manager.discard_tile(0, 0)

        p1 = manager.players[1]
        # 点杠移除 3 张 + 补摸 1 张 + 出牌 1 张 = 净 -3：13 → 10（若连摸两张则为 11）
        assert len(p1.hand) == 10, f'点杠后手牌应为 10 张（净减 3），实际 {len(p1.hand)}'
        assert any(m.type == 'gang' and m.tile == 'm1' for m in p1.melds), '应形成 m1 杠副露'
        # 手牌数守恒：hand + 副露张数 = 13 + 杠数（单骑等待结构）
        meld_tiles = sum(len(m.tiles) for m in p1.melds)
        kongs = sum(1 for m in p1.melds if m.type in ('gang', 'angang'))
        assert len(p1.hand) + meld_tiles == 13 + kongs
        assert manager.phase == 'settled'   # 墙空流局结束


class TestEndDrawCleanup:
    """流局展示态清理 —— 对齐前端 endDraw，快照不再携带陈旧 winPresentation"""

    @pytest.mark.asyncio
    async def test_end_draw_clears_presentation_state(self):
        manager = GameManager(mode='east', controllers=[AIPlayer() for _ in range(4)])
        manager.players = [
            GamePlayer(name=f'P{i}', avatar='', score=1000, seat=i, hand=[],
                       discards=[], melds=[], redCount=0, drawnTileIndex=-1)
            for i in range(4)
        ]
        manager._table_context.players = manager.players
        # 注入上一局残留的展示态
        manager.win_presentation = {'winnerIndex': 0, 'tile': 'm1'}
        manager.user_drew_this_turn = True
        manager.action_prompt = {'type': 'claim', 'tile': 'm1', 'from': 1}
        manager.phase = 'drawing'
        manager.current_player = 0

        manager.end_draw()

        assert manager.phase == 'settled'
        assert manager.win_presentation is None, '流局应清掉 win_presentation'
        assert manager.user_drew_this_turn is False, '流局应清掉 user_drew_this_turn'
        assert manager.action_prompt is None, '流局应清掉 action_prompt'
        assert manager.winning_player_index == -1
        assert manager.result is not None and manager.result.get('draw') is True


def test_break_wall_by_dice_rotates_to_break_point():
    """骰子决定拆墙点（莲花广麻规则）：和数定墙、小点数定列，旋转列表让拆墙处成为前端。"""
    manager = GameManager(mode='east', controllers=[AIPlayer() for _ in range(4)])
    manager.wall = [f't{i}' for i in range(10)]   # 10 张：索引 0-9
    manager.dice = [1, 3]   # 和=4 → 上家墙（段起点34），n=1 → (34+2)%10 = 6 起
    manager._break_wall_by_dice()
    assert manager.wall == [f't{i}' for i in range(6, 10)] + [f't{i}' for i in range(6)]


def test_break_wall_by_dice_empty_wall_noop():
    """空墙调用拆墙不报错（流局边缘等空墙场景）。"""
    manager = GameManager(mode='east', controllers=[AIPlayer() for _ in range(4)])
    manager.wall = []
    manager.dice = [6, 6]
    manager._break_wall_by_dice()
    assert manager.wall == []


def test_end_draw_records_tenpai():
    """流局结果带上各家听牌名单与庄家听牌标志（连庄判断 + 结算展示用）。"""
    from app.game.manager import GameManager as _GM
    from app.models.game import GamePlayer as _GP
    tenpai_hand = ['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3', 's1', 's1', 's1', 's2']
    noten_hand = ['m1', 'm2', 'm4', 'm5', 'm7', 'm8', 'p1', 'p2', 'p4', 'p5', 'p7', 'p8', 's1']
    manager = _GM(mode='east', controllers=[AIPlayer() for _ in range(4)])
    manager.players = [
        _GP(name='A', avatar='', score=1000, seat=i, hand=(tenpai_hand if i in (0, 2) else noten_hand),
            discards=[], melds=[], redCount=0, drawnTileIndex=-1,
            characterId=('qwen' if i == 0 else 'deepseek'),
            playerKind=('human', 'llm', 'bot', 'bot')[i])
        for i in range(4)
    ]
    manager.dealer = 0   # 庄家（seat 0）听牌
    manager.end_draw()
    assert manager.result['draw'] is True
    assert manager.result['tenpai'] == [0, 2]
    assert manager.result['dealerTenpai'] is True
    # 不付点数：各 delta 为 0
    assert all(change['delta'] == 0 for change in manager.result['scoreChanges'])
    assert [change['characterId'] for change in manager.result['scoreChanges']] == [
        'qwen', 'deepseek', 'deepseek', 'deepseek',
    ]
    assert [change['playerKind'] for change in manager.result['scoreChanges']] == [
        'human', 'llm', 'bot', 'bot',
    ]


def test_is_human_distinguishes_remote_from_ai():
    """真人座位（RemotePlayer）与 AI 补位（AIPlayer）的杠停顿区分依据。"""
    from app.game.remote_player import RemotePlayer
    from app.game.room import RoomSession

    room = RoomSession('HUMAN-TEST', capacity=2)
    human = RemotePlayer(0, room.conn)
    manager = GameManager(
        mode='east',
        controllers=[human, AIPlayer(), AIPlayer(), AIPlayer()],
    )
    assert manager._is_human(0) is True
    assert manager._is_human(1) is False
    assert manager._is_human(3) is False


@pytest.mark.asyncio
async def test_opening_turn_counts_as_drawn_for_can_hu():
    """庄家开局首回合视作已摸牌（天胡可胡）；吃碰后跳摸的回合不算已摸牌。

    对齐单机 localTurnOrchestrator 的 preDrawn：庄家开局跳摸但已持 14 张，
    此前后端 `canHu=(not skip_draw and ...)` 恒为 false，联机天胡永远没有「胡」按钮。
    """
    captured: dict = {}

    class _Capture:
        def __init__(self, action):
            self.action = action

        async def request_turn(self, ctx):
            captured[ctx.turnOrigin] = ctx
            return self.action

        async def request_claim(self, ctx):
            return {'kind': 'pass'}

        async def request_rob_kong(self, ctx):
            return 'pass'

        def on_discarded(self):
            pass

        def reset(self):
            pass

    winning14 = ['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3', 's1', 's1', 's1', 's2', 's2']
    junk13 = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 's5', 's6', 's7', 's8']
    manager = GameManager(mode='east', controllers=[
        _Capture({'kind': 'win'}),
        _Capture({'kind': 'discard', 'handIndex': 0}),
        _Capture({'kind': 'discard', 'handIndex': 0}),
        _Capture({'kind': 'discard', 'handIndex': 0}),
    ])
    manager.players = [
        GamePlayer(name=f'P{i}', avatar='', score=1000, seat=i,
                   hand=list(winning14 if i in (0, 1) else junk13),
                   discards=[], melds=[], redCount=0, drawnTileIndex=13)
        for i in range(4)
    ]
    manager._table_context.players = manager.players
    manager.dealer = 0
    manager.wall = ['m9'] * 30

    await manager.begin_turn(0, skip_draw=True)
    opening = captured['opening']
    assert opening.skipDraw is True
    assert opening.canHu is True

    captured.clear()
    manager.phase = 'drawing'   # 第一段已结算：复位阶段以便再取一次上下文
    await manager.begin_turn(1, skip_draw=True, after_claim='peng')
    after_claim = captured['peng']
    assert after_claim.skipDraw is True
    assert after_claim.canHu is False
