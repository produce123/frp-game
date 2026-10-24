"""规则实例在流程、AI 与真人校验之间保持一致。"""

from app.game.manager import GameManager
from app.game.player import AIPlayer, TurnContext
from app.game.remote_player import RemotePlayer
from app.game.room import RoomSession
from app.models.game import GamePlayer
from app.rules.fans import FanEngine, PredicateFan
from app.rules.lianhua import LianhuaGuangmaRuleSet


WINNING_HAND = [
    'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4',
    's7', 's7', 's7', 'east', 'east',
]


class DenyWinRules(LianhuaGuangmaRuleSet):
    code = 'test_deny_win'

    def is_winning_hand(self, tiles, exposed_meld_count=0):
        return False


class FakeConnection:
    async def send_to_seat(self, *_args, **_kwargs):
        pass


def turn_context() -> TurnContext:
    return TurnContext(
        hand=WINNING_HAND, melds=[], exposedMelds=0,
        kongBloom=False, skipDraw=False, afterKong=False,
    )


async def test_ai_uses_injected_rule_set_for_win_legality():
    rules = DenyWinRules()
    ai = AIPlayer(rule_set=rules, random=lambda: 0)

    action = await ai.request_turn(turn_context())

    assert action['kind'] == 'discard'


def test_remote_validation_uses_injected_rule_set():
    rules = DenyWinRules()
    remote = RemotePlayer(0, FakeConnection(), rule_set=rules)
    remote._pending_kind = 'turn'
    remote._last_ctx = turn_context()

    action, error = remote._validate({'type': 'hu', 'kind': 'self_draw'})

    assert action is None
    assert error == 'INVALID_ACTION'


def test_manager_propagates_one_rule_instance_to_controllers_and_actions():
    rules = DenyWinRules()
    controllers = [AIPlayer() for _ in range(4)]

    manager = GameManager(controllers=controllers, rule_set=rules)

    assert manager.rules is rules
    assert manager._table_context.rules is rules
    assert all(controller.rules is rules for controller in controllers)


def test_manager_uses_injected_fan_engine_and_kong_base_score():
    fan_engine = FanEngine([
        PredicateFan('custom', '测试番', lambda _: True, multiplier=3),
    ], base_score=100)
    rules = LianhuaGuangmaRuleSet(fan_engine=fan_engine)
    rules.base_score = 25
    manager = GameManager(rule_set=rules, controllers=[AIPlayer() for _ in range(4)])
    manager.players = [
        GamePlayer(
            name=f'P{i}', avatar='', score=1000, seat=i,
            hand=[], discards=[], melds=[], redCount=0, drawnTileIndex=-1,
        )
        for i in range(4)
    ]
    manager._table_context.players = manager.players

    kong_deltas = manager._apply_kong_score(0, 'added')
    manager.finalize_win(1, {})

    assert kong_deltas[0] == {'playerIndex': 0, 'amount': 75}
    assert manager.result['points'] == 300
    # 庄家倍率已取消（2026-09 定案）：三家同额各付 300，不再由庄家双付。
    assert manager.result['totalWon'] == 900


def test_room_propagates_rule_instance_to_human_and_ai_controllers():
    rules = DenyWinRules()
    room = RoomSession('RULE01', capacity=1, rule_set=rules)
    _, _, state = room.join_or_rejoin('Tester')

    controllers = room._controllers()

    assert state.controller.rules is rules
    assert all(controller.rules is rules for controller in controllers)
