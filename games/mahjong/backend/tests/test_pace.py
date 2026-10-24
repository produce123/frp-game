"""视觉节奏（pace）注入测试 —— 真人联机房间有可读节奏，测试路径保持即用即答

问题背景：REST 房间 pace=0，AI 出牌/碰杠瞬间完成，真人体验像快进。
修复：REST create_room 注入 PLAY_PACE（对齐前端 PACE_MS）；直接构造 RoomSession
（测试/单机）保持 None → GameManager 默认全 0，后端测试套件不拖慢。
"""

import asyncio
import random
import time

import httpx
import pytest

from app.game.manager import GameManager, PLAY_PACE
from app.game.player import AI_DELAYS, AIPlayer
from app.game.remote_player import RemotePlayer
from app.game.room import RoomSession, SeatState, room_registry as rooms


async def run_until(manager: GameManager, phase: str, max_steps: int = 4000) -> None:
    steps = 0
    while manager.phase != phase and steps < max_steps:
        steps += 1
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_rest_create_injects_play_pace(server, fresh_rooms):
    """REST 创建的房间注入真人节奏 PLAY_PACE（AI 出牌有可读延迟）。"""
    async with httpx.AsyncClient(base_url=server['http']) as http:
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2})
        assert resp.status_code == 200, resp.text
    room = rooms.get(resp.json()['roomId'])
    assert room is not None
    assert room.pace == PLAY_PACE
    # 常量本身非空：至少一个关键节奏点有延迟（否则问题 1 回归）
    assert PLAY_PACE['afterDiscardToNextTurn'] > 0
    # 开局表现等待：对齐客户端开局动画，防止 AI 在动画期间推进
    assert PLAY_PACE['openingDelayStart'] > 0
    assert PLAY_PACE['openingDelay'] > 0


@pytest.mark.asyncio
async def test_real_room_ai_uses_human_think_delays(server, fresh_rooms):
    """真人联机房间的 AI 用人类思考速度（对齐前端 AI_DELAYS）；测试路径保持即用即答。"""
    # REST 创建的房间（注入 PLAY_PACE）→ AI 补位座位有 think 延迟
    async with httpx.AsyncClient(base_url=server['http']) as http:
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2})
        assert resp.status_code == 200, resp.text
    room = rooms.get(resp.json()['roomId'])
    controllers = room._controllers()
    ai_controllers = [c for s, c in zip(room.seats, controllers) if s is None]
    assert ai_controllers, '应存在 AI 补位座位'
    assert all(c.delays == AI_DELAYS for c in ai_controllers), \
        f'真人房间 AI 应为人类思考速度: {[c.delays for c in ai_controllers]}'

    # 真人座位的断线/超时代打 AI 同样使用人类思考速度
    remote = RemotePlayer(0, room.conn, ai_delays=AI_DELAYS)
    assert remote._ai.delays == AI_DELAYS, f'断线代打 AI 应为人类思考速度: {remote._ai.delays}'

    # 直接构造的测试房间（pace=None）→ AI 即用即答（不拖慢测试套件）
    test_room = RoomSession('AI-SPEED-TEST', capacity=2)
    test_ai = [c for s, c in zip(test_room.seats, test_room._controllers()) if s is None][0]
    assert test_ai.delays['turn'] == 0 and test_ai.delays['claim'] == 0
    # AI_DELAYS 本身与前端 playerController.ts 的 AI_DELAYS 一致（人类正常思考速度）
    assert AI_DELAYS == {'turn': 650, 'after_kong': 550, 'claim': 500}


def test_room_session_default_pace_is_none():
    """直接构造 RoomSession（测试路径）pace=None → GameManager 默认全 0。"""
    room = RoomSession('PACE-TEST', capacity=2)
    assert room.pace is None


@pytest.mark.asyncio
async def test_injected_pace_slows_first_round():
    """注入节奏后整局时长显著变慢；默认 0 保持即用即答。"""
    async def first_round_seconds(pace=None) -> float:
        # 快慢两组必须使用相同牌墙/骰子，否则随机局长差异会淹没注入的 20ms 节奏。
        seeded = random.Random(20260828)
        manager = GameManager(mode='east', controllers=[AIPlayer() for _ in range(4)],
                              pace=pace, random=seeded.random)
        t0 = time.perf_counter()
        await manager.start_game('east')
        await run_until(manager, 'settled')
        return time.perf_counter() - t0

    fast = await first_round_seconds()
    slow = await first_round_seconds({'afterDiscardToNextTurn': 20})

    # 一局约 15+ 次弃牌 × 20ms ≈ 300ms 的节奏量；留 200ms 判定余量
    assert slow - fast >= 0.2, f'节奏注入未生效: fast={fast:.3f}s slow={slow:.3f}s'


@pytest.mark.asyncio
async def test_start_game_with_barrier_events_still_finishes():
    """Manager 经 wait_for_opening 事件（默认空实现）开局仍能正常打完，不卡死。"""
    from app.game.player import AIPlayer

    manager = GameManager(mode='east', controllers=[AIPlayer() for _ in range(4)])
    t0 = time.perf_counter()
    await manager.start_game('east')
    assert manager.phase == 'settled'
    assert time.perf_counter() - t0 < 5, '空实现屏障不应阻塞开局'


def _room_with_humans(room_id: str, pace=None, count: int = 2) -> RoomSession:
    """构造一个带 count 个已连真人座位的房间（REST 真实房间 pace=PLAY_PACE）。"""
    room = RoomSession(room_id, capacity=count, pace=pace)
    for i in range(count):
        controller = RemotePlayer(i, room.conn)
        controller.set_connected(True)
        room.seats[i] = SeatState(i, f'P{i}', f'code-{i}', controller)
    return room


class TestOpeningReadyBarrier:
    """开局就绪屏障：服务端等所有在线真人发牌动画结束（opening_done）再开局，防止抢跑"""

    @pytest.mark.asyncio
    async def test_all_confirm_proceeds_immediately(self):
        """所有在线真人确认 opening_done 后，屏障立即通过开始首回合。"""
        room = _room_with_humans('OPN-ALL', pace=PLAY_PACE)
        room._opening_timeout = 2.0
        task = asyncio.create_task(room._wait_for_opening())
        while room._opening is None:
            await asyncio.sleep(0)   # 等屏障激活（_opening 建立）
        # 未全部确认 → 仍在等待
        room._confirm_opening(0)
        await asyncio.sleep(0)
        assert not task.done(), '还有真人未确认，屏障不应通过'
        room._confirm_opening(1)
        await asyncio.wait_for(task, timeout=1)
        assert task.done(), '全部确认后应立即通过'

    @pytest.mark.asyncio
    async def test_backstop_timeout_proceeds(self):
        """客户端不响应时兜底超时后仍推进，不卡死整场。"""
        room = _room_with_humans('OPN-TIMEOUT', pace=PLAY_PACE, count=1)
        room._opening_timeout = 0.05
        t0 = time.monotonic()
        await asyncio.wait_for(room._wait_for_opening(), timeout=1)
        assert time.monotonic() - t0 >= 0.04, '应等待至少到兜底超时'

    @pytest.mark.asyncio
    async def test_skipped_without_pace(self):
        """测试路径（pace=None）不等待：开局即用即答，不拖慢套件。"""
        room = _room_with_humans('OPN-NOPACE', pace=None, count=1)
        await asyncio.wait_for(room._wait_for_opening(), timeout=0.2)

    @pytest.mark.asyncio
    async def test_no_humans_passes_immediately(self):
        """无在线真人（全 AI）时屏障直接通过。"""
        room = RoomSession('OPN-AI', capacity=4, pace=PLAY_PACE)   # 无座位 → 无真人
        await asyncio.wait_for(room._wait_for_opening(), timeout=0.2)

    def test_confirm_opening_outside_barrier_is_idempotent(self):
        """非开局等待期间到达的 opening_done 幂等忽略，不算错。"""
        room = RoomSession('OPN-IDLE', capacity=4, pace=PLAY_PACE)
        assert room._confirm_opening(0) == (True, '')

    def test_stale_round_confirmation_does_not_pollute_current_barrier(self):
        """上一局迟到的 opening_done 不能确认当前局。"""
        room = RoomSession('OPN-ROUND', capacity=4, pace=PLAY_PACE)
        room._opening = {'round': 2, 'confirmed': set()}
        room._opening_event = asyncio.Event()

        assert room._confirm_opening(0, 1) == (True, '')
        assert room._opening['confirmed'] == set()
        assert room._confirm_opening(0, 2) == (True, '')
        assert room._opening['confirmed'] == {0}
