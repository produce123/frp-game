"""僵尸 / 卡死对局收尾单测 —— 看门狗的判据与强制收尾

背景（2026-09-20 事故）：`status == 'playing'` 的房间对 TTL 永久豁免，而对局驱动
在极端情况下可能既推不动也不会结束。这类房间既不能 `start`（ALREADY_STARTED）
也不能 `close`（ROOM_PLAYING），并长期占用 MAX_ROOMS 槽位。

规则（app/game/room.py）：
- `match_is_driving`：还有活着的驱动任务（经典 game_task / 血流 _drive_task）
- `is_match_stalled`：playing 且（无任务 ⇒ 僵尸）或（超过 ROOM_MATCH_MAX ⇒ 卡死）
- `sweep_stalled(allow_cancel=...)`：只有事件循环里的调用方允许 cancel 活任务
- `start_room_watchdog()`：ROOM_WATCHDOG_INTERVAL<=0 ⇒ None（关闭）

直接操作注册表 + 回拨 match_started_at，无需真实服务。
"""

import asyncio
import time

import pytest

from app.game.room import (
    ROOM_MATCH_MAX,
    ROOM_WATCHDOG_INTERVAL,
    is_match_stalled,
    match_is_driving,
    match_phase_of,
    room_registry as rooms,
    start_room_watchdog,
)


class _LiveTask:
    """鸭类型「活任务」：只看 done()。"

    用假任务而非真 asyncio.Task：本文件不跑事件循环，且 cancel() 语义由
    force_finish 的调用契约（allow_cancel）覆盖，不需要真的取消。
    """

    def __init__(self):
        self.cancelled = False

    def done(self) -> bool:
        return False

    def cancel(self) -> None:
        self.cancelled = True


class _DeadTask(_LiveTask):
    def done(self) -> bool:
        return True


class _Collector:
    """替代 asyncio.Queue 的同步收集器（ConnectionManager 只用到 put_nowait）。"""

    def __init__(self):
        self.messages: list[dict] = []

    def put_nowait(self, message: dict) -> None:
        self.messages.append(message)


def _backdate_match(room, seconds: float) -> None:
    """把本场开局时刻拨到过去，模拟超过硬上限。"""
    room.match_started_at = time.monotonic() - seconds


def _playing_zombie(room_id: str, *, task=None):
    """造一个 playing 房间：任务默认不存在（僵尸），可选挂活/死任务。"""
    room = rooms.create(room_id, mode='east', capacity=2)
    room.status = 'playing'
    if task is not None:
        room.game_task = task
    return room


# ─── 判据 ────────────────────────────────────────────────

def test_stalled_when_playing_without_any_task(fresh_rooms):
    """playing 且没有任何驱动任务 ⇒ 僵尸（判据一）。"""
    room = _playing_zombie('WDG1')
    assert match_is_driving(room) is False
    assert is_match_stalled(room) is True


def test_not_stalled_when_playing_with_live_task(fresh_rooms):
    """playing 且任务活着、未超上限 ⇒ 活对局，不得误杀。"""
    room = _playing_zombie('WDG2', task=_LiveTask())
    assert match_is_driving(room) is True
    assert is_match_stalled(room) is False


def test_stalled_when_past_the_hard_cap_even_with_live_task(fresh_rooms):
    """任务「活着」也可能永不结束（_drive 的 sleep(0) 忙等自旋）⇒ 硬上限兜底（判据二）。"""
    task = _LiveTask()
    room = _playing_zombie('WDG3', task=task)
    _backdate_match(room, ROOM_MATCH_MAX + 1)
    assert is_match_stalled(room) is True


def test_live_task_within_hard_cap_is_not_stalled(fresh_rooms):
    """开局时刻已记录但未到上限 ⇒ 不动它。"""
    room = _playing_zombie('WDG4', task=_LiveTask())
    _backdate_match(room, ROOM_MATCH_MAX - 60)
    assert is_match_stalled(room) is False


def test_dead_task_counts_as_not_driving(fresh_rooms):
    """任务已完成（done()）等于没人推进 ⇒ 僵尸。"""
    room = _playing_zombie('WDG5', task=_DeadTask())
    assert match_is_driving(room) is False
    assert is_match_stalled(room) is True


def test_blood_flow_drive_task_name_is_recognised(fresh_rooms):
    """血流的驱动任务叫 _drive_task：同名判定不能漏。"""
    room = _playing_zombie('WDG6')
    room._drive_task = _LiveTask()
    assert match_is_driving(room) is True
    assert is_match_stalled(room) is False


@pytest.mark.parametrize('status', ['lobby', 'finished', 'closed', 'error'])
def test_non_playing_rooms_are_never_touched(fresh_rooms, status):
    """非 playing 的房间完全不在看门狗职责内（TTL 已经很会收它们）。"""
    room = rooms.create(f'WDG-{status}', mode='east', capacity=2)
    room.status = status
    # 连硬上限都不需要看：status 不是 playing 就直接 False
    _backdate_match(room, ROOM_MATCH_MAX + 1)
    assert is_match_stalled(room) is False
    assert rooms.sweep_stalled() == []


# ─── 清扫 ────────────────────────────────────────────────

def test_sweep_finishes_a_zombie_room(fresh_rooms):
    """僵尸房间被收尾：status=finished，广播 forced 的 match_finished。"""
    room = _playing_zombie('WDG7')
    room.join_or_rejoin('甲')
    assert rooms.sweep_stalled() == ['WDG7']
    assert room.status == 'finished'
    # 幂等：再扫一次不会重复收尾
    assert rooms.sweep_stalled() == []


def test_sweep_broadcasts_forced_match_finished(fresh_rooms):
    """广播形状与 _drive 正常终局一致，另带 forced=True 供前端/日志区分。"""
    room = _playing_zombie('WDG8')
    seat, _, _ = room.join_or_rejoin('甲')
    collector = _Collector()
    room.conn.register(seat, collector, sender_task=None)

    rooms.sweep_stalled()

    finished = [m for m in collector.messages if m.get('kind') == 'match_finished']
    assert len(finished) == 1
    assert finished[0]['forced'] is True
    assert finished[0]['roomId'] == 'WDG8'
    assert 'finalScores' in finished[0]


def test_sweep_keeps_a_live_match_by_default(fresh_rooms):
    """默认（REST 线程池口径）：卡死类不碰 —— 任务还活着，取消它不是线程安全的。"""
    task = _LiveTask()
    room = _playing_zombie('WDG9', task=task)
    _backdate_match(room, ROOM_MATCH_MAX + 1)

    assert rooms.sweep_stalled() == []
    assert room.status == 'playing'
    assert task.cancelled is False


def test_sweep_cancels_a_stuck_match_only_when_allowed(fresh_rooms):
    """allow_cancel=True（事件循环口径）：卡死类被收尾且任务被取消。"""
    task = _LiveTask()
    room = _playing_zombie('WDG10', task=task)
    _backdate_match(room, ROOM_MATCH_MAX + 1)

    assert rooms.sweep_stalled(allow_cancel=True) == ['WDG10']
    assert room.status == 'finished'
    assert task.cancelled is True


def test_force_finish_is_idempotent_and_ignores_non_playing(fresh_rooms):
    """force_finish 幂等；非 playing 直接返回 False（不重复广播）。"""
    room = _playing_zombie('WDG11')
    assert room.force_finish() is True
    assert room.force_finish() is False

    lobby = rooms.create('WDG12', mode='east', capacity=2)
    assert lobby.force_finish() is False


def test_force_finish_marks_manager_phase_finished(fresh_rooms):
    """强制收尾必须把 manager 的口径也补齐（phase='finished'）。

    正常终局里 match_finished 与 phase='finished' 由 next_round 成对设置；强制收尾
    绕过了 _drive，只补 match_finished 会让「已结束」的房间继续报出对局中的阶段
    （真实服务上曾观察到 status=finished 而 phase=thinking），REST 与快照自相矛盾。
    """
    room = rooms.create('WDG15', mode='east', capacity=2)
    seat, _, _ = room.join_or_rejoin('甲')
    room.ready_seat(seat)

    async def _start_then_finish():
        await room.start()
        assert room.manager is not None
        # 模拟「对局正打到一半被判死」——真实场景就是此刻被看门狗收尾。
        room.manager.phase = 'thinking'
        assert room.force_finish('test') is True
        room.game_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await room.game_task

    asyncio.run(_start_then_finish())

    assert room.status == 'finished'
    assert room.manager.match_finished is True
    assert room.manager.phase == 'finished'
    # REST / 快照读的正是这个 helper：阶段不许再留在对局中
    assert match_phase_of(room) == 'finished'


def test_new_match_clears_the_forced_finish_gate(fresh_rooms):
    """收尾后房间回到可用状态（此前僵尸房永远 ALREADY_STARTED），且闸门随新一场清掉。

    闸门不清会让「收尾一次之后再被判死」永久失效，所以这是关键的复位点。
    """
    room = _playing_zombie('WDG13')
    seat, _, _ = room.join_or_rejoin('甲')
    room.ready_seat(seat)
    assert room.force_finish() is True
    assert room._forced_finishing is True

    async def _start_then_stop():
        await room.start()
        assert room.status == 'playing'
        assert room.game_task is not None
        # 让任务真正跑起来再取消：避免留下 pending task 警告。
        room.game_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await room.game_task

    asyncio.run(_start_then_stop())

    assert room.status == 'playing'
    assert room._forced_finishing is False
    assert room.match_started_at is not None


def test_finished_zombie_can_be_closed(fresh_rooms):
    """收尾后 close 不再 409 ROOM_PLAYING 的前提：status 已不是 playing。"""
    room = _playing_zombie('WDG14')
    rooms.sweep_stalled()
    assert room.status != 'playing'


# ─── 看门狗开关 ──────────────────────────────────────────

def test_watchdog_disabled_by_env(fresh_rooms):
    """conftest 设 ROOM_WATCHDOG_INTERVAL=0 ⇒ 看门狗根本不启动（免重启的紧急开关）。"""
    assert ROOM_WATCHDOG_INTERVAL <= 0
    assert start_room_watchdog() is None