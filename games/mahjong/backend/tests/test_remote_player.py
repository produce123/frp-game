"""RemotePlayer 反作弊校验单测 —— 服务端权威校验客户端「意图」

覆盖 Phase 8 反作弊加固（此前服务端无条件信任客户端的 hu / 碰 / 杠意图）：
- 自摸胡：手牌未成形 → INVALID_ACTION；成形 → 受理
- 暗杠：手牌不足 4 张 → 拒绝
- 碰/杠（claim）：手牌张数不足 → 拒绝
- 抢杠胡：杠牌加入手牌不成胡 → 拒绝；成胡 → 受理
- 校验失败不消费 pending：玩家仍可提交合法动作

不依赖 WebSocket：直接构造 RemotePlayer，伪造 pending future，验证 handle_action 的分支。
"""

from app.core.rules import is_winning_hand
from app.game.player import ClaimContext, RobKongContext, TurnContext
from app.game.remote_player import RemotePlayer


class _FakeFuture:
    """最简 pending future：仅需 done() / set_result()（handle_action 只用这两者）。"""

    def done(self):
        return False

    def set_result(self, value):
        self._value = value


class _FakeConn:
    """RemotePlayer 构造所需的最小 conn 桩（本测试不触发 request_* 出站）。"""


def _pending_turn_player(hand: list, exposed_melds: int = 0) -> RemotePlayer:
    """构造一个挂起回合请求的 RemotePlayer：pending 存活、_last_ctx 为服务端权威手牌。"""
    player = RemotePlayer(0, _FakeConn())
    player._pending = _FakeFuture()
    player._pending_kind = 'turn'
    player._last_ctx = TurnContext(
        hand=hand, melds=[], exposedMelds=exposed_melds,
        kongBloom=False, skipDraw=False, afterKong=False,
        canHu=is_winning_hand(hand, exposed_melds),
    )
    return player


def _pending_claim_player(hand: list, tile: str) -> RemotePlayer:
    player = RemotePlayer(0, _FakeConn())
    player._pending = _FakeFuture()
    player._pending_kind = 'claim'
    player._last_ctx = ClaimContext(hand=hand, canGang=False, tile=tile, from_=1)
    return player


def _pending_rob_kong_player(hand: list, tile: str, exposed_melds: int = 0) -> RemotePlayer:
    player = RemotePlayer(0, _FakeConn())
    player._pending = _FakeFuture()
    player._pending_kind = 'rob_kong'
    player._last_ctx = RobKongContext(tile=tile, from_=1, hand=hand, exposedMelds=exposed_melds)
    return player


# 14 张成形手牌：m1/m2/m3 三刻 + s1 三张 + s2 一对（exposedMelds=0）
WINNING_HAND = ['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3',
                's1', 's1', 's1', 's2', 's2']
# 14 张全单张（无对子、无三张、无顺子）：必不成胡
NOT_WINNING_HAND = ['m1', 'm2', 'm4', 'm5', 'm7', 'm8',
                    'p1', 'p2', 'p4', 'p5', 'p7', 'p8', 's1', 's2']


def test_winning_hand_is_valid():
    assert is_winning_hand(WINNING_HAND, 0) is True
    assert is_winning_hand(NOT_WINNING_HAND, 0) is False


def test_turn_hu_rejected_when_not_winning():
    player = _pending_turn_player(NOT_WINNING_HAND)
    ok, err = player.handle_action({'type': 'hu'})
    assert ok is False
    assert err == 'INVALID_ACTION'
    # 校验失败不消费 pending：玩家仍可合法出牌
    assert player._pending is not None


def test_turn_discard_rejects_negative_and_out_of_range_indices():
    player = _pending_turn_player(['m1', 'm2'])
    for index in (-1, 2, True):
        ok, err = player.handle_action({'type': 'discard', 'handIndex': index})
        assert ok is False
        assert err == 'INVALID_ACTION'
        assert player._pending is not None


def test_turn_discard_accepts_an_in_range_index():
    player = _pending_turn_player(['m1', 'm2'])
    ok, err = player.handle_action({'type': 'discard', 'handIndex': 1})
    assert ok is True
    assert err == ''
    assert player._pending is None


def test_turn_hu_accepted_when_winning():
    player = _pending_turn_player(WINNING_HAND)
    ok, err = player.handle_action({'type': 'hu'})
    assert ok is True
    assert err == ''
    # 受理后 pending 被消费，动作转发为 win
    assert player._pending is None


def test_concealed_kong_rejected_without_4_tiles():
    hand = WINNING_HAND[:-1]  # 去掉一张，剩余手牌里 s2 只有 1 张
    player = _pending_turn_player(hand)
    ok, err = player.handle_action({'type': 'gang', 'kind': 'concealed', 'tile': 's2'})
    assert ok is False
    assert err == 'INVALID_ACTION'


def test_concealed_kong_accepted_with_4_tiles():
    hand = ['m1', 'm1', 'm1', 'm1', 'm2', 'm2', 'm3', 'm3',
            's1', 's1', 's2', 's2', 's3', 's3']
    player = _pending_turn_player(hand)
    ok, err = player.handle_action({'type': 'gang', 'kind': 'concealed', 'tile': 'm1'})
    assert ok is True
    assert err == ''
    assert player._pending is None


def test_claim_peng_rejected_without_pair():
    # 手牌只有 1 张弃牌同牌，声明碰 → 拒绝
    player = _pending_claim_player(['m1', 'm2', 'm3', 's1', 's2', 's3'], 'm1')
    ok, err = player.handle_action({'type': 'claim', 'action': 'peng'})
    assert ok is False
    assert err == 'INVALID_ACTION'


def test_claim_gang_rejected_without_triplet():
    # 只有 2 张同牌，声明杠 → 拒绝
    player = _pending_claim_player(['m1', 'm1', 'm2', 'm3', 's1', 's2'], 'm1')
    ok, err = player.handle_action({'type': 'claim', 'action': 'gang'})
    assert ok is False
    assert err == 'INVALID_ACTION'


def test_claim_peng_accepted_with_pair():
    player = _pending_claim_player(['m1', 'm1', 'm2', 'm3', 's1', 's2'], 'm1')
    ok, err = player.handle_action({'type': 'claim', 'action': 'peng'})
    assert ok is True
    assert err == ''


def test_rob_kong_hu_rejected_when_not_winning():
    # 13 张全单张：加 s2 后仍全单张，不成胡
    player = _pending_rob_kong_player(
        ['m1', 'm2', 'm4', 'm5', 'm7', 'm8', 'p1', 'p2', 'p4', 'p5', 'p7', 'p8', 's1'], 's2')
    ok, err = player.handle_action({'type': 'hu'})
    assert ok is False
    assert err == 'INVALID_ACTION'


def test_rob_kong_hu_accepted_when_winning():
    # 13 张听 s1（刻子 + 对子齐）：加 s1 成胡
    player = _pending_rob_kong_player(['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3',
                                       'm3', 's1', 's1', 's2', 's2'], 's1')
    ok, err = player.handle_action({'type': 'hu'})
    assert ok is True
    assert err == ''
