"""房间限时（60 分钟）清理单测 —— 超过限时的房间自动解散

规则（RoomSession.is_expired）：
- 对局中（playing）不参与 TTL 回收（长局不该被腰斩）→ 等 _drive 在对局结束超时时
  自动释放；僵尸/卡死另走 sweep_stalled（看门狗，见 test_room_watchdog.py）
- 非对局中且超过限时（deadline）→ 回收，与是否有人在座/在线无关

直接操作注册表 + 回拨 deadline，无需真实服务。
"""

import time

from app.game.room import room_registry as rooms


def _backdate(room, seconds: float) -> None:
    """把房间限时（deadline）拨到过去，模拟超时。"""
    room.deadline = time.monotonic() - seconds


def test_expired_lobby_room_dissolves(fresh_rooms):
    """非对局房间超过限时 → 自动解散。"""
    room = rooms.create('EXP1', mode='east', capacity=2)
    _backdate(room, 1)
    assert rooms.sweep_expired() == ['EXP1']
    assert rooms.get('EXP1') is None


def test_room_kept_within_deadline(fresh_rooms):
    """未超限时的房间 → 保留。"""
    room = rooms.create('EXP2', mode='east', capacity=2)
    assert rooms.sweep_expired() == []
    assert rooms.get('EXP2') is not None


def test_connected_room_expires_after_deadline(fresh_rooms):
    """有人在座且在线、已超限时 → 仍回收（限时优先于在线）。"""
    room = rooms.create('EXP3', mode='east', capacity=2)
    seat, _, _ = room.join_or_rejoin('甲')
    room.on_connect(seat)
    _backdate(room, 1)
    assert rooms.sweep_expired() == ['EXP3']


def test_playing_room_not_swept_past_deadline(fresh_rooms):
    """对局中的房间不参与 TTL 回收（长局不该被 60 分钟腰斩）。

    僵尸/卡死交给另一条通道：sweep_stalled（看门狗）。本房没有驱动任务
    ⇒ 判为僵尸 ⇒ 被强制收尾，但**不被 TTL 回收**——两条通道职责不重叠。
    """
    room = rooms.create('EXP4', mode='east', capacity=2)
    room.status = 'playing'
    _backdate(room, 1)
    assert rooms.sweep_expired() == []

    # 新语义锚点：playing 不再是「无人管」，僵尸由 sweep_stalled 收尾。
    assert rooms.sweep_stalled() == ['EXP4']
    assert room.status == 'finished'
    assert rooms.get('EXP4') is not None


def test_finished_room_expires_after_deadline(fresh_rooms):
    """场次结束（finished）不立即释放，超限时才回收。"""
    room = rooms.create('EXP5', mode='east', capacity=2)
    room.status = 'finished'
    _backdate(room, 1)
    assert rooms.sweep_expired() == ['EXP5']


def test_get_prunes_expired_lazily(fresh_rooms):
    """get() 惰性清扫：超时房间在下次访问时被移除。"""
    room = rooms.create('EXP6', mode='east', capacity=2)
    _backdate(room, 1)
    rooms._last_sweep = 0.0   # 绕过节流，强制本次 get 触发清扫
    assert rooms.get('EXP6') is None


def test_creator_leave_during_playing_transfers_and_keeps_room(fresh_rooms):
    """对局中房主 release_seat → 房主转移给下一座位，且注册表保留房间（AI 代打）。"""
    room = rooms.create('EXP7', mode='east', capacity=2)
    seat_a, _, state_a = room.join_or_rejoin('甲')
    seat_b, _, _ = room.join_or_rejoin('乙')
    assert room.creator_seat == seat_a
    room.status = 'playing'
    room.release_seat(seat_a, state_a.rejoin_code)
    assert room.creator_seat == seat_b   # 房主转移
    assert rooms.get('EXP7') is not None  # 房间保留
