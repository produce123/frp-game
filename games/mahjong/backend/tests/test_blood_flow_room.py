"""血流房间会话测试 —— REST 生命周期契约 + 快照对齐前端 seatView 形状 + 真人动作回路。"""

import asyncio
import time

import pytest

from app.core.blood_flow.config import BLOOD_FLOW_CONFIG, BLOOD_FLOW_PACE
from app.game.anime_characters import DEFAULT_ANIME_CHARACTER_ID
from app.game.blood_flow_engine import BloodFlowEngine
from app.game.manager import PLAYER_SEED
from app.game.room import RoomError, room_registry
from app.rules.blood_flow import BloodFlowRuleSet
from tests.test_blood_flow_engine import make_opening


def choose(view: dict) -> dict:
    """按快照 ownActions 选择动作（测试驱动，等价前端玩家可提交的合法动作）。

    响应窗口优先副露（碰/吃/杠）：动作流水依赖随机发牌，若真人只出牌/过，
    某些发牌下整场可能一次碰杠都不发生，断言会变成 flake。
    """
    actions = view.get('ownActions') or []
    win = next((a for a in actions if a['kind'] == 'win'), None)
    if win:
        return win
    locked = view['public']['seats'][view['seat']]['locked']
    if locked:
        # 胡后也可收到杠响应；测试客户端必须按当前合法动作提交。
        return next((a for a in actions if a['kind'] in ('gang', 'concealed-kong', 'added-kong', 'wind-kong')),
                    next((a for a in actions if a['kind'] == 'discard'), {'kind': 'pass'}))
    discards = [a for a in actions if a['kind'] == 'discard']
    if discards:
        hand = view['players'][view['seat']]['hand']
        ordinary = [a for a in discards if hand[a['index']] not in {*view['jokers'], 'white'}]
        return (ordinary or discards)[0]
    melds = [a for a in actions if a['kind'] in ('peng', 'gang', 'chi')]
    if melds:
        return melds[0]
    return {'kind': 'pass'}


@pytest.fixture(autouse=True)
def _clear_registry():
    room_registry.clear()
    yield
    room_registry.clear()


@pytest.mark.asyncio
async def test_all_bot_match_settles_four_rounds():
    room = room_registry.create('BF-BOT', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    await room.start()
    for _ in range(2400):  # 最多 120s
        if room.match_finished:
            break
        await asyncio.sleep(0.05)
    assert room.match_finished is True
    assert sum(room.scores) == BLOOD_FLOW_CONFIG.initial_score * 4
    assert room.round_result is not None
    assert room.round_result['reason'] == 'wall-exhausted'
    assert room.status == 'finished'
    # 整场结束后仍保留末局引擎视图：否则最终快照 view 为空、前端整包丢弃。
    final = room.snapshot_for(0)
    assert final['matchFinished'] is True
    assert final['view'] != {}
    assert final['view']['public']['roundResult'] is not None


def test_llm_available_is_server_capability_before_start(monkeypatch):
    """血流房间与经典房间同口径：开局前 llmAvailable 就是服务端能力。

    否则房间面板不显示大模型选位，还误报「服务器未配置」（空位只能普通 AI 代打）。
    """
    monkeypatch.setattr('app.llm.config.llm_server_available', lambda: True)
    room = room_registry.create('BF-LLM', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    assert room.llm_available is True
    assert room.effective_llm_enabled is False   # 未请求大模型时本局不启用
    with_llm = room_registry.create('BF-LLM2', mode='east', capacity=4,
                                    ruleset_id='lotus-blood-flow', pace=0, llm_enabled=True)
    assert with_llm.effective_llm_enabled is True   # 请求了 + 服务端有能力 → 面板可选手位
    monkeypatch.setattr('app.llm.config.llm_server_available', lambda: False)
    assert room.llm_available is False
    assert with_llm.effective_llm_enabled is False


def test_empty_seats_get_default_server_llm(monkeypatch):
    """房间开了大模型时，未逐位点选的空位也用服务端默认提供商（与经典房间同口径）。"""
    from app.llm.config import LlmProvider
    monkeypatch.setattr('app.llm.config.load_llm_providers',
                        lambda: {'default': LlmProvider('default', '服务器默认', 'https://x/v1', 'k', 'm', '稳健')})
    monkeypatch.setattr('app.llm.config.default_provider_id', lambda: 'default')
    room = room_registry.create('BF-LLM-SEATS', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0, llm_enabled=True)
    room.join_or_rejoin('玩家1', None, 'p1')   # 座位 0 是真人
    room._resolve_llm_seats([], None)
    assert set(room.llm_seats) == {1, 2, 3}
    # 显式点选覆盖默认提供商。
    room._resolve_llm_seats([{'seat': 2, 'providerId': 'default', 'style': '高冷'}], None)
    assert set(room.llm_seats) == {1, 2, 3}


def test_llm_seat_identity_flows_into_snapshot(monkeypatch):
    """LLM 空位的昵称/头像/二次元角色/音色由服务端供应商推导并随快照下发（对齐经典 _seeds）。

    此前血流房间只发引擎占位名「玩家N」+ 空头像 + 硬编码角色，前端又按本机单机 LLM
    设置选音色——房间开了大模型却看到/听到别的形象与声音。
    """
    from app.llm.config import LlmProvider
    monkeypatch.setattr('app.llm.config.load_llm_providers', lambda: {
        'qwen': LlmProvider('qwen', '千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                            'k', 'qwen3.7-plus', '稳健')})
    monkeypatch.setattr('app.llm.config.default_provider_id', lambda: 'qwen')
    room = room_registry.create('BF-LLM-ID', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0, llm_enabled=True)
    room.join_or_rejoin('阿甲', None, 'p1')
    room._resolve_llm_seats([{'seat': 1, 'providerId': 'qwen', 'style': '高冷'}], None)

    identity = room._seat_identity[1]
    assert identity['name'] == '千问（高冷）'
    assert identity['avatar'] == 'img/llm/qwen/llm-avatar-gaoleng.png'
    assert identity['characterId'] == 'qwen'
    assert identity['style'] == '高冷'
    assert identity['voiceKey'] == 'qwen'

    hands = [
        ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 's1', 's2', 's3', 's4', 'p5'],
        ['p5', 'p5', 'p6', 'p7', 'p8', 'p9', 's5', 's6', 's7', 'east', 'south', 'west', 'north'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'red', 'green', 'white', 'north'],
        ['m2', 'm5', 'm8', 'p3', 'p6', 'p9', 's1', 's4', 's7', 'east', 'south', 'west', 'green'],
    ]
    room.engine = BloodFlowEngine(authority_epoch='t', round_id='id', rules=BloodFlowRuleSet(),
                                  opening=make_opening(hands=hands, wall_front=['north', 'south', 'west']))
    players = room._seat_view(0)['players']
    # 真人座位：房间昵称/角色，且不带 LLM 音色字段。
    assert players[0]['name'] == '阿甲' and 'voiceKey' not in players[0]
    # LLM 座位：供应商身份 + 音色，供前端直接调用本机 TTS。
    assert players[1]['name'] == '千问（高冷）'
    assert players[1]['avatar'] == 'img/llm/qwen/llm-avatar-gaoleng.png'
    assert players[1]['characterId'] == 'qwen'
    assert players[1]['playerKind'] == 'llm' and players[1]['isLlm'] is True
    assert players[1]['style'] == '高冷' and players[1]['voiceKey'] == 'qwen'


def test_ai_seat_identity_uses_player_seed_without_llm():
    """未开大模型时，空位身份来自 PLAYER_SEED（与经典房间同口径），不是引擎占位名。"""
    room = room_registry.create('BF-AI-ID', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('阿甲', None, 'p1')
    room._resolve_llm_seats([], None)
    assert room._seat_identity[1] == {
        'name': PLAYER_SEED[1]['name'], 'avatar': PLAYER_SEED[1]['avatar'],
        'characterId': DEFAULT_ANIME_CHARACTER_ID}


def test_step_delay_chains_discard_pause_and_draw_pause():
    """节奏串联（对齐单机 engine.after）：弃牌停顿 + 摸牌停顿 afterDraw，而不是二选一。"""
    room = room_registry.create('BF-PACE', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace={'enabled': 1})
    room.join_or_rejoin('玩家1', None, 'p1')
    room.on_connect(0)
    hands = [
        ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 's1', 's2', 's3', 's4', 'p5'],
        ['p5', 'p5', 'p6', 'p7', 'p8', 'p9', 's5', 's6', 's7', 'east', 'south', 'west', 'north'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'red', 'green', 'white', 'north'],
        ['m2', 'm5', 'm8', 'p3', 'p6', 'p9', 's1', 's4', 's7', 'east', 'south', 'west', 'green'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='pace', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['north', 'south', 'west']))
    room.engine = engine

    engine.discard(13)   # 庄家打出 p5 → 座位 1 可碰
    assert engine.window['kind'] == 'meld'
    # 响应窗口不摸牌：只等弃牌停顿。
    assert room._step_delay_ms(engine, 0, 0, 0) == BLOOD_FLOW_PACE['afterDiscardToNextTurn']

    assert engine.submit(engine.command(1, {'kind': 'pass'}))
    assert engine.window['kind'] == 'turn' and engine.window['source']['kind'] == 'draw'
    # 下一家的出牌窗口：弃牌停顿已在上一轮消费，这里只叠加摸牌停顿。
    assert room._step_delay_ms(engine, 0, len(engine.discard_actions), 0, drew=True) == BLOOD_FLOW_PACE['afterDraw']


def test_settled_snapshot_carries_continuation():
    """结算快照下发局间就绪计数：前端显示「已准备，等待其他玩家（x/y）」与「重试准备」。"""
    room = room_registry.create('BF-CONT', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('玩家1', None, 'p1')
    room.on_connect(0)
    room.round_result = {'ruleVersion': 'x', 'roundId': 'round-0', 'reason': 'wall-exhausted',
                         'ledger': [], 'seats': []}
    room._continue_confirmations = {0}
    assert room.snapshot_for(0)['continuation'] == {'requiredSeats': [0], 'readySeats': [0]}

    # 托管座位不计入待确认真人。
    room.auto_seats.add(0)
    assert room.snapshot_for(0)['continuation'] == {'requiredSeats': [], 'readySeats': []}

    # 未结算时不带该字段。
    room.round_result = None
    assert 'continuation' not in room.snapshot_for(0)


@pytest.mark.asyncio
async def test_auto_message_toggles_server_side_play():
    """托管消息：合法开关生效、非法载荷被拒、心跳有 pong。"""
    room = room_registry.create('BF-AUTO-MSG', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('玩家1', None, 'p1')
    queue: asyncio.Queue = asyncio.Queue()
    room.conn.register(0, queue, None)
    room.on_connect(0)

    assert room.handle_client_message(0, {'kind': 'auto', 'enabled': True}) == (True, '')
    assert 0 in room.auto_seats
    assert room._human_seat(0) is False        # 托管座位不再算真人待决策
    assert room.handle_client_message(0, {'kind': 'auto', 'enabled': False}) == (True, '')
    assert 0 not in room.auto_seats
    assert room._human_seat(0) is True
    ok, err = room.handle_client_message(0, {'kind': 'auto', 'enabled': 'yes'})
    assert ok is False and err == 'INVALID_AUTO'

    # 心跳：前端 roomSocket 发的是 {'type': 'ping'}（真实线上形状）；kind 形式一并兼容。
    for ping in ({'type': 'ping', 't': 1}, {'kind': 'ping'}):
        assert room.handle_client_message(0, ping) == (True, '')
        pong = None
        for _ in range(10):
            message = await asyncio.wait_for(queue.get(), timeout=5)
            if message.get('kind') == 'pong':
                pong = message
                break
        assert pong is not None


@pytest.mark.asyncio
async def test_auto_seat_finishes_match_without_client_actions():
    """托管座位由服务端代打：客户端不提交任何动作也能打完整场。"""
    room = room_registry.create('BF-AUTO-PLAY', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('玩家1', None, 'p1')
    room.ready_seat(0, True)
    queue: asyncio.Queue = asyncio.Queue()
    room.conn.register(0, queue, None)
    room.on_connect(0)
    assert room.handle_client_message(0, {'kind': 'auto', 'enabled': True}) == (True, '')
    await room.start()
    while not room.match_finished:
        message = await asyncio.wait_for(queue.get(), timeout=90)
        if message.get('kind') == 'bf_snapshot' and message.get('opening'):
            room.handle_client_message(0, {'kind': 'opening_done', 'round': message['round']})
    assert room.match_finished is True
    assert sum(room.scores) == BLOOD_FLOW_CONFIG.initial_score * 4


@pytest.mark.asyncio
async def test_presentation_hold_hides_window_during_animation_pause():
    """表现闸门：演出停顿期间快照隐藏窗口（对齐单机 transition，下一家不能操作/不起读秒）。"""
    room = room_registry.create('BF-HOLD', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('玩家1', None, 'p1')
    room.on_connect(0)
    hands = [
        ['m1', 'm2', 'm3', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east', 'm9'],
        ['m4', 'm6', 'm7', 'p4', 'p5', 'p6', 's4', 's5', 's6', 'north', 'west', 'south', 'red'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'red', 'green', 'white', 'north'],
        ['m2', 'm5', 'm8', 'p3', 'p6', 'p9', 's1', 's4', 's7', 'east', 'south', 'west', 'green'],
    ]
    room.engine = BloodFlowEngine(authority_epoch='t', round_id='hold', rules=BloodFlowRuleSet(),
                                  opening=make_opening(hands=hands, wall_front=['north']))
    assert room._seat_view(0)['window'] is not None
    room._hold_window_until = time.monotonic() + 5
    held = room._seat_view(0)
    assert held['window'] is None
    assert held['ownActions'] == []
    assert held['waitingSeats'] == []
    assert held['ownScore'] is None
    room._hold_window_until = 0.0
    assert room._seat_view(0)['window'] is not None


@pytest.mark.asyncio
async def test_presentation_hold_hides_the_drawn_tile():
    """闸门期间连「刚摸的那张牌」一起藏：单机是演出结束才摸牌，联机不能让下一家手牌先 +1。"""
    room = room_registry.create('BF-HOLD-DRAW', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('玩家1', None, 'p1')
    room.on_connect(0)
    hands = [
        ['m1', 'm2', 'm3', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east', 'm9'],
        ['m4', 'm6', 'm7', 'p4', 'p5', 'p6', 's4', 's5', 's6', 'north', 'west', 'south', 'red'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'red', 'green', 'white', 'north'],
        ['m2', 'm5', 'm8', 'p3', 'p6', 'p9', 's1', 's4', 's7', 'east', 'south', 'west', 'green'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='hold-draw', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['north', 'south', 'west']))
    room.engine = engine
    engine.draw(1)   # 模拟「胡牌裁决时引擎已替下一家摸牌」
    assert engine.players[1]['drawnTileIndex'] >= 0
    drawn_hand = len(engine.players[1]['hand'])
    wall_after = len(engine.wall)
    head_after = engine.head_drawn

    room._hold_window_until = time.monotonic() + 5
    held = room._seat_view(0)
    assert held['players'][1]['drawnTileIndex'] == -1
    assert held['players'][1]['concealedTileCount'] == drawn_hand - 1
    assert held['wallCount'] == wall_after + 1
    assert held['headDrawn'] == head_after - 1

    # 本家自己刚摸的那张也要藏（否则自己的手牌先多一张）。
    engine.draw(0)
    held0 = room._seat_view(0)
    assert len(held0['players'][0]['hand']) == len(engine.players[0]['hand']) - 1
    assert held0['players'][0]['drawnTileIndex'] == -1
    wall_after2 = len(engine.wall)
    head_after2 = engine.head_drawn

    room._hold_window_until = 0.0
    released = room._seat_view(0)
    assert released['players'][1]['drawnTileIndex'] >= 0
    assert released['players'][1]['concealedTileCount'] == drawn_hand
    assert released['wallCount'] == wall_after2
    assert released['headDrawn'] == head_after2


@pytest.mark.asyncio
async def test_human_action_loop_over_snapshot_contract():
    room = room_registry.create('BF-HUM', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    state = None
    seat, is_rejoin, state = room.join_or_rejoin('玩家1', None, 'p1')
    assert seat == 0 and is_rejoin is False
    assert room.ready_seat(0, True)

    queue: asyncio.Queue = asyncio.Queue()
    room.conn.register(0, queue, None)
    room.on_connect(0)
    room.decision_ms = 60_000  # 负载下避免 15s 窗口过期与提交竞态（慢机回归 flake）
    await room.start()
    actions = 0
    snapshots = 0
    seen_fields: set[str] = set()
    action_types: set[str] = set()
    saw_discard = False
    handled_window: str | None = None
    while not room.match_finished:
        message = await asyncio.wait_for(queue.get(), timeout=90)
        if message.get('kind') != 'bf_snapshot':
            continue
        snapshots += 1
        view = message['view']
        seen_fields.update(view.keys())
        assert message['mode'] == 'east'
        if view.get('lastDiscardAction'):
            saw_discard = True
        action_types.update(a['type'] for a in view.get('actionEvents') or [])
        if message.get('opening'):
            ok, err = room.handle_client_message(0, {
                'kind': 'opening_done', 'round': message['round'],
            })
            assert ok, err
        if view.get('window') and view.get('ownActions'):
            window_id = view['window']['id']
            if window_id == handled_window:
                continue  # 同一窗口的重复快照（提交后与驱动循环各广播一次）
            handled_window = window_id
            action = choose(view)
            ok, err = room.handle_client_message(0, {
                'kind': 'action',
                'windowId': window_id,
                'stateVersion': view['window']['version'],
                'action': action,
            })
            assert ok, err
            actions += 1
    assert actions > 40
    assert snapshots > 40
    # 局内过场数据齐备：弃牌流水 + 碰/杠/胡等动作流水（前端据此播动作字/语音/牌名播报）。
    assert saw_discard is True
    assert action_types & {'peng', 'chi', 'discard-gang', 'concealed-gang', 'added-gang', 'wind-kong'}
    assert action_types & {'self-draw', 'discard-win', 'robbed-kong-win'}
    assert {'authorityEpoch', 'roundId', 'version', 'seat', 'players', 'currentPlayer',
            'wallCount', 'headDrawn', 'flipTile', 'jokers', 'flipStack', 'flipSeat',
            'wallBreakIndex', 'window', 'ownActions', 'ownScore', 'waitingSeats',
            'public', 'actionEvents', 'lastDiscardAction', 'kongEvents'} <= seen_fields
    assert room.match_finished is True
    assert sum(room.scores) == BLOOD_FLOW_CONFIG.initial_score * 4


@pytest.mark.asyncio
async def test_round_opening_payload_and_ready_barrier():
    """每局首份快照带骰点；真人未回执 opening_done 前不开打（回执后放行，超时兜底）。"""
    room = room_registry.create('BF-OPEN', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('玩家1', None, 'p1')
    room.ready_seat(0, True)
    queue: asyncio.Queue = asyncio.Queue()
    room.conn.register(0, queue, None)
    room.on_connect(0)
    room.opening_timeout = 5.0
    room.decision_ms = 1_000  # 屏障放行后靠过期推进窗口，测试不必等 15s
    await room.start()

    first = await asyncio.wait_for(queue.get(), timeout=10)
    assert first['kind'] == 'bf_snapshot'
    assert first['round'] == 1, '局号对玩家应为 1-based（东1局）'
    assert first['opening'] is not None, '首份快照必须携带开局骰点'
    for key in ('firstDice', 'secondDice'):
        dice = first['opening'][key]
        assert len(dice) == 2 and all(1 <= n <= 6 for n in dice), first['opening']
    window_id = first['view']['window']['id']

    # 未回执：屏障期内窗口不推进（机器人不下手、也不过期）。
    await asyncio.sleep(0.6)
    assert room.engine is not None
    assert room.engine.window['id'] == window_id
    assert room.engine.window['decisions'][0] is None

    # 过期回执不报错也不放行。
    ok, _ = room.handle_client_message(0, {'kind': 'opening_done', 'round': 99})
    assert ok is True
    assert room._opening_confirmations == set()

    # 正确回执：屏障放行，窗口推进。
    ok, err = room.handle_client_message(0, {'kind': 'opening_done', 'round': 1})
    assert ok, err
    for _ in range(200):
        if room.engine and room.engine.window['id'] != window_id:
            break
        await asyncio.sleep(0.05)
    assert room.engine is not None and room.engine.window['id'] != window_id


@pytest.mark.asyncio
async def test_opening_barrier_times_out_without_confirmation():
    room = room_registry.create('BF-OPEN-TO', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('玩家1', None, 'p1')
    room.ready_seat(0, True)
    room.conn.register(0, asyncio.Queue(), None)
    room.on_connect(0)
    room.opening_timeout = 0.2
    room.decision_ms = 500
    await room.start()
    for _ in range(100):  # 等引擎建立，记下屏障期的窗口
        if room.engine is not None:
            break
        await asyncio.sleep(0.05)
    assert room.engine is not None
    window_id = room.engine.window['id']
    for _ in range(200):  # 兜底超时后照常开打：窗口推进
        if room.engine is not None and room.engine.window['id'] != window_id:
            break
        await asyncio.sleep(0.05)
    assert room.engine is not None and room.engine.window['id'] != window_id


@pytest.mark.asyncio
async def test_inter_round_continue_barrier():
    """局末结算后等在线真人回执 continue 再开下一局；过期回执忽略，超时兜底。"""
    room = room_registry.create('BF-CONT', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('玩家1', None, 'p1')
    room.ready_seat(0, True)
    queue: asyncio.Queue = asyncio.Queue()
    room.conn.register(0, queue, None)
    room.on_connect(0)
    room.opening_timeout = 0.2
    room.decision_ms = 300
    room.continue_timeout = 5.0
    await room.start()

    settlement = None
    for _ in range(6000):  # 最多 ~120s 打完第一局
        try:
            message = queue.get_nowait()
        except asyncio.QueueEmpty:
            await asyncio.sleep(0.02)
            continue
        if message.get('kind') != 'bf_snapshot':
            continue
        if message.get('opening'):
            room.handle_client_message(0, {'kind': 'opening_done', 'round': message['round']})
        if (message.get('view') or {}).get('public', {}).get('roundResult'):
            settlement = message
            break
    assert settlement is not None, '未收到局末结算快照'
    assert room.round_index == 0

    # 屏障期：未回执不进下一局。
    await asyncio.sleep(0.6)
    assert room.round_index == 0

    # 过期回执忽略（不报错、不放行）。
    ok, _ = room.handle_client_message(0, {'kind': 'continue', 'round': 99})
    assert ok is True
    assert room._continue_confirmations == set()

    ok, err = room.handle_client_message(0, {'kind': 'continue', 'round': 1})
    assert ok, err
    for _ in range(400):
        if room.round_index == 1:
            break
        await asyncio.sleep(0.05)
    assert room.round_index == 1, '回执后应进入下一局'


@pytest.mark.asyncio
async def test_inter_round_barrier_times_out_without_confirmation():
    room = room_registry.create('BF-CONT-TO', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('玩家1', None, 'p1')
    room.ready_seat(0, True)
    queue: asyncio.Queue = asyncio.Queue()
    room.conn.register(0, queue, None)
    room.on_connect(0)
    room.opening_timeout = 0.2
    room.decision_ms = 200
    room.continue_timeout = 0.2  # 局间兜底极短
    await room.start()
    for _ in range(6000):
        try:
            message = queue.get_nowait()
        except asyncio.QueueEmpty:
            await asyncio.sleep(0.02)
            continue
        if message.get('kind') == 'bf_snapshot' and message.get('opening'):
            room.handle_client_message(0, {'kind': 'opening_done', 'round': message['round']})
        if room.round_index >= 1:
            break
    assert room.round_index >= 1, '局间超时后应自动进入下一局'


def test_pace_table_wired_for_real_rooms():
    """REST 建房注入的经典节奏表（dict）→ 血流用自带节奏表；测试用 0 → 无节奏。"""
    room = room_registry.create('BF-PACE', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow',
                                pace={'afterDiscardToNextTurn': 450})
    assert room.pace == BLOOD_FLOW_PACE
    assert set(BLOOD_FLOW_PACE) >= {'aiThink', 'afterDraw', 'afterDiscardToNextTurn',
                                    'afterClaimPeng', 'afterClaimGang', 'afterKongSettle',
                                    'beforeRobKong', 'winEffectBase', 'winEffectLarge',
                                    'winEffectTop', 'multiWinIntro'}
    # 以单机血流为基准：无分档思考/真人缩短/多响抢杠额外停顿（这些是经典联机专属档位）。
    assert 'aiThinkTurn' not in BLOOD_FLOW_PACE
    assert 'aiThinkClaim' not in BLOOD_FLOW_PACE
    assert 'aiThinkKong' not in BLOOD_FLOW_PACE
    assert 'afterClaimPengHuman' not in BLOOD_FLOW_PACE
    assert 'afterClaimGangHuman' not in BLOOD_FLOW_PACE
    assert 'betweenRobKongs' not in BLOOD_FLOW_PACE
    assert BLOOD_FLOW_PACE['aiThink'] == 650
    quiet = room_registry.create('BF-PACE-0', mode='east', capacity=4,
                                 ruleset_id='lotus-blood-flow', pace=0)
    assert quiet.pace == {}


def test_step_delay_matches_local_timing():
    room = room_registry.create('BF-PACE-K', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=BLOOD_FLOW_PACE)
    # 真人占座 0/1：单机引擎不分真人与 AI，碰/明杠停顿不得走经典 350 缩短档。
    room.join_or_rejoin('真人甲', None, 'p1')
    room.join_or_rejoin('真人乙', None, 'p2')
    room.on_connect(0)
    room.on_connect(1)
    hands = [
        ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p4', 'm5'],
        ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
        ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='pace', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['north']))
    # 开局首个窗口：庄家跳牌视作已摸（牌墙无变化），无额外停顿，机器人由 aiThink 650 覆盖。
    assert room._step_delay_ms(engine, 0, 0, 0) == 0
    assert engine.submit(engine.command(0, {'kind': 'discard', 'index': 13}))
    assert engine.submit(engine.command(1, {'kind': 'peng'}))
    # 真人碰：仍是 650 afterClaimPeng（对齐单机，不再取经典 skipDrawPengDelay 350）。
    assert room._human_seat(1)
    assert room._step_delay_ms(engine, 0, 0, 0) == BLOOD_FLOW_PACE['afterClaimPeng']

    gang_engine = BloodFlowEngine(authority_epoch='t', round_id='pace-gang', rules=BloodFlowRuleSet(),
                                  opening=make_opening(hands=hands, wall_front=['north']))
    assert gang_engine.submit(gang_engine.command(0, {'kind': 'discard', 'index': 13}))
    assert gang_engine.submit(gang_engine.command(1, {'kind': 'gang'}))
    # 真人明杠：550 + 杠后补摸 450 串联（对齐单机 afterClaimGang + afterDraw，不取经典真人 350）。
    assert room._step_delay_ms(gang_engine, 0, 0, 0, drew=True) \
        == BLOOD_FLOW_PACE['afterClaimGang'] + BLOOD_FLOW_PACE['afterDraw']

    win_engine = BloodFlowEngine(authority_epoch='t', round_id='pace-win', rules=BloodFlowRuleSet(),
                                 opening=make_opening(hands=hands, wall_front=['north']))
    assert win_engine.submit(win_engine.command(0, {'kind': 'discard', 'index': 13}))
    assert win_engine.submit(win_engine.command(1, {'kind': 'win'}))
    # 平胡档：1815 + 1200 尾量 + 100 交接余量（对齐前端 bloodFlowWinTiming）。
    assert room._step_delay_ms(win_engine, 0, 0, 0) == 1815 + 1200 + 100


def test_win_pause_matches_local_engine_tiers():
    """胡牌停顿对齐单机 engine.after('win')：档位 3015/3180/3480 + 点炮多响 1500 引言 + 100 交接。"""
    from types import SimpleNamespace
    room = room_registry.create('BF-WIN-PAUSE', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace={'enabled': 1})

    def batch(source_kind: str, winners: int, weight: int) -> dict:
        # 真实 WinRecord 的 score 是对象（.items 属性），不是 dict。
        return {'source': {'kind': source_kind},
                'winners': [{'score': SimpleNamespace(items=[SimpleNamespace(weight=weight)])}
                            for _ in range(winners)]}

    assert room._win_pause_ms(batch('discard', 1, 1)) == 3015 + 100    # 普通胡 1815+1200
    assert room._win_pause_ms(batch('discard', 1, 4)) == 3015 + 100    # tier1 与普通同档
    assert room._win_pause_ms(batch('discard', 1, 8)) == 3180 + 100    # 大番 2600-620+1200
    assert room._win_pause_ms(batch('draw', 1, 16)) == 3480 + 100      # 顶级 2900-620+1200
    # 点炮多响加 1500 引言；抢杠多响无额外停顿（单机引擎口径，不含经典 betweenRobKongs）。
    assert room._win_pause_ms(batch('discard', 2, 1)) == 3015 + 1500 + 100
    assert room._win_pause_ms(batch('added-kong', 2, 1)) == 3015 + 100


@pytest.mark.asyncio
async def test_snapshot_players_carry_room_identity_and_fresh_deadline():
    """玩家信息来自房间座位（昵称/角色/人类或 AI）；真人窗口的倒计时从窗口出现起算。"""
    room = room_registry.create('BF-ID', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('阿甲', None, 'p1')
    room.ready_seat(0, True)
    queue: asyncio.Queue = asyncio.Queue()
    room.conn.register(0, queue, None)
    room.on_connect(0)
    room.decision_ms = 5_000
    await room.start()

    human_view = None
    for _ in range(80):
        message = await asyncio.wait_for(queue.get(), timeout=10)
        if message.get('opening'):
            room.handle_client_message(0, {'kind': 'opening_done', 'round': message['round']})
        view = message['view']
        # 开局动画期间窗口尚未计时（deadlineAt=0）；屏障放行后驱动重播快照才带读秒。
        if view.get('window') and view.get('ownActions') and view['window'].get('deadlineAt'):
            human_view = view
            break
    assert human_view is not None, '未等到带读秒的真人窗口'
    players = human_view['players']
    assert players[0]['name'] == '阿甲'
    assert players[0]['playerKind'] == 'human'
    assert players[0]['characterId'] == 'deepseek'
    assert players[1]['playerKind'] == 'bot'
    assert players[1]['isLlm'] is False
    remaining = human_view['window']['deadlineAt'] - int(time.time() * 1000)
    assert 0 < remaining <= 5_000, f'真人窗口剩余时间应从窗口出现起算: {remaining}'


def test_stale_and_invalid_actions_rejected():
    room = room_registry.create('BF-ERR', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('玩家1', None, 'p1')
    room.ready_seat(0, True)
    ok, err = room.handle_client_message(0, {'kind': 'action', 'windowId': 'x', 'action': {'kind': 'pass'}})
    assert not ok and err == 'STALE_ACTION'
    ok, err = room.handle_client_message(0, {'kind': 'action', 'windowId': 'x', 'stateVersion': 0,
                                             'action': {'kind': 'win'}})
    assert not ok and err in ('STALE_ACTION', 'INVALID_ACTION')
    ok, err = room.handle_client_message(0, {'kind': 'nonsense'})
    assert not ok and err == 'INVALID_MESSAGE'


# ── 真人胡牌的表现闸门回归（问题1：胡牌动画未结束就轮到下家摸打）──
#
# 根因：真人动作在 WS 处理协程里提交，引擎同步裁决并立刻摸下一家的牌；旧驱动循环
# 按「迭代开头」取节奏基线，醒来时推进已发生 → 停顿为 0，且 handler 立即广播把
# 新窗口与新摸的牌同帧暴露。修复后：handler 对已推进的窗口不广播，驱动循环用跨
# 迭代基线补上停顿与闸门。以下用两个真人座位（0/1）走真实 handle_client_message
# 路径，覆盖自摸 / 吃胡 / 抢杠胡三种胡。

FAST_PACE = {
    'aiThink': 10, 'afterDraw': 0, 'afterDiscardToNextTurn': 20,
    'afterClaimPeng': 20, 'afterClaimGang': 20, 'afterKongSettle': 20,
    'beforeRobKong': 20, 'winEffectBase': 300, 'winEffectLarge': 300,
    'winEffectTop': 300, 'winEffectDeduct': 0, 'winEffectTail': 0,
    'winHandoffMargin': 50, 'multiWinIntro': 0,
}
FAST_WIN_PAUSE_S = 0.35   # winEffectBase 300 + tail 0 + margin 50


def _make_two_human_room(room_id: str):
    """两真人（0=真人甲、1=真人乙）+ 快速节奏表 + 独立快照队列。"""
    room = room_registry.create(room_id, mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.pace = dict(FAST_PACE)
    room.join_or_rejoin('真人甲', None, 'p1')
    room.join_or_rejoin('真人乙', None, 'p2')
    queues: dict[int, asyncio.Queue] = {}
    for seat in (0, 1):
        queue: asyncio.Queue = asyncio.Queue()
        queues[seat] = queue
        room.conn.register(seat, queue, None)
        room.on_connect(seat)
    return room, queues


def _view(message: dict) -> dict:
    return message.get('view') or {}


def _batches(message: dict) -> list:
    return (_view(message).get('public') or {}).get('batches') or []


async def _next_snapshot(queue: asyncio.Queue, predicate, timeout: float = 10.0):
    """逐帧取快照直到 predicate 命中；返回 (到达时刻 monotonic, 消息)。"""
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError('等待目标快照超时')
        message = await asyncio.wait_for(queue.get(), timeout=remaining)
        if message.get('kind') != 'bf_snapshot':
            continue
        if predicate(message):
            return time.monotonic(), message


def _submit(room, seat: int, frame: dict, action: dict) -> None:
    window = _view(frame)['window']
    ok, err = room.handle_client_message(seat, {
        'kind': 'action', 'windowId': window['id'],
        'stateVersion': window['version'], 'action': action})
    assert ok, err


def _has_action(kind: str):
    return lambda m: any(a.get('kind') == kind for a in _view(m).get('ownActions') or [])


async def _assert_win_gate(queues, observe_seat: int, expected_source: str) -> None:
    """真人胡提交后的共享断言：批次帧仍在闸门内 → 停顿结束后才重新开放窗口。"""
    observe = queues[observe_seat]
    at_batch, batch_message = await _next_snapshot(observe, lambda m: len(_batches(m)) > 0)
    batch_view = _view(batch_message)
    assert batch_view['window'] is None, '胡牌批次帧提前暴露了窗口（动画未结束下家已可摸打）'
    assert batch_view['ownActions'] == []
    assert all(p['drawnTileIndex'] == -1 for p in batch_view['players']), \
        '胡牌批次帧提前暴露了刚摸的牌'
    assert batch_view['public']['batches'][-1]['source']['kind'] == expected_source
    at_reveal, reveal_message = await _next_snapshot(
        observe, lambda m: _view(m).get('window') is not None)
    gap = at_reveal - at_batch
    assert gap >= FAST_WIN_PAUSE_S - 0.05, f'胡牌演出停顿过短: {gap:.3f}s'
    assert gap < 2.0, f'胡牌演出停顿异常过长: {gap:.3f}s'
    # 血流不设服务端公告（单机也没有；抢杠胡红字公告是经典玩法专属，已按用户要求移除）。
    assert 'announcement' not in batch_view
    assert 'announcement' not in _view(reveal_message)


@pytest.mark.asyncio
async def test_human_self_draw_win_holds_animation_gate():
    """自摸：真人庄家首窗即胡（天胡档），批次帧藏窗口/藏摸牌，停顿后才开放下家窗口。"""
    room, queues = _make_two_human_room('BF-WIN-ZIMO')
    hands = [
        ['m1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'p1', 'p2', 'p3', 's1', 's2', 's3'],
        ['p4', 'p5', 'p6', 'p7', 'p8', 's4', 's5', 's6', 's7', 's8', 'm8', 'm9', 'east'],
        ['south', 'west', 'north', 'white', 'p1', 'p4', 's1', 's4', 'm8', 'east', 'south', 'west', 'north'],
        ['east', 'south', 'west', 'north', 'white', 'p2', 'p5', 's2', 's5', 'm9', 'east', 'south', 'west'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='win-zimo', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['p9']))
    room.engine = engine
    task = asyncio.ensure_future(room._play_round(engine))
    try:
        _, first = await _next_snapshot(queues[0], _has_action('win'))
        win = next(a for a in _view(first)['ownActions'] if a['kind'] == 'win')
        _submit(room, 0, first, win)
        await _assert_win_gate(queues, 1, 'draw')
    finally:
        task.cancel()


@pytest.mark.asyncio
async def test_human_discard_win_holds_animation_gate():
    """吃胡：真人甲首巡打 m5，真人乙点炮窗胡牌；闸门对真人提交同样生效。"""
    room, queues = _make_two_human_room('BF-WIN-DIANPAO')
    hands = [
        ['m5', 'm9', 'm9', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 's1', 's2', 's3', 's4', 's6'],
        ['m1', 'm1', 'm2', 'm3', 'm4', 'm6', 'm7', 'p7', 'p8', 'p9', 's7', 's8', 's9'],
        ['east', 'east', 'south', 'south', 'west', 'west', 'north', 'north', 'white', 'p1', 'p4', 's1', 's4'],
        ['east', 'east', 'south', 'south', 'west', 'west', 'north', 'white', 'p2', 'p5', 's2', 's5', 'm8'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='win-dianpao', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['north']))
    room.engine = engine
    task = asyncio.ensure_future(room._play_round(engine))
    try:
        # 真人甲首窗：按牌找 m5 的弃牌选项（不依赖排序）。
        _, first = await _next_snapshot(
            queues[0], lambda m: _view(m).get('window', None) is not None
            and _view(m)['window'].get('kind') == 'turn' and bool(_view(m).get('ownActions')))
        view0 = _view(first)
        hand0 = view0['players'][0]['hand']
        discard = next(a for a in view0['ownActions']
                       if a['kind'] == 'discard' and hand0[a['index']] == 'm5')
        _submit(room, 0, first, discard)
        # 弃牌停顿期间：带弃牌流水的首帧同样处于闸门（窗口隐藏、刚摸的牌隐藏）。
        _, gated = await _next_snapshot(
            queues[1], lambda m: (_view(m).get('lastDiscardAction') or {}).get('tile') == 'm5')
        assert _view(gated)['window'] is None
        assert all(p['drawnTileIndex'] == -1 for p in _view(gated)['players'])
        # 真人乙响应窗：可胡 → 提交。
        _, claim = await _next_snapshot(queues[1], _has_action('win'))
        win = next(a for a in _view(claim)['ownActions'] if a['kind'] == 'win')
        _submit(room, 1, claim, win)
        await _assert_win_gate(queues, 0, 'discard')
    finally:
        task.cancel()


@pytest.mark.asyncio
async def test_human_robbed_kong_win_holds_animation_gate():
    """抢杠胡：真人甲补杠 p4，真人乙抢杠胡；闸门生效，且血流不下发抢杠胡公告（经典专属，已移除）。"""
    room, queues = _make_two_human_room('BF-WIN-QIANGGANG')
    hands = [
        ['p4', 'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east'],
        ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p5', 'p6', 's4', 's5', 's6', 'east', 'east'],
        ['p1', 'p2', 'p7', 'p8', 's1', 's2', 's7', 's8', 'm7', 'm8', 'south', 'west', 'north'],
        ['p1', 'p2', 'p7', 'p8', 's1', 's2', 's7', 's8', 'm7', 'm8', 'south', 'west', 'north'],
    ]
    melds = [[{'type': 'peng', 'tile': 'p4', 'tiles': ['p4', 'p4', 'p4'], 'from': 1}], [], [], []]
    engine = BloodFlowEngine(authority_epoch='t', round_id='win-rob', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, melds=melds, wall_front=['m9'],
                                                  dealer_drawn_index=10))
    room.engine = engine
    task = asyncio.ensure_future(room._play_round(engine))
    try:
        _, first = await _next_snapshot(queues[0], _has_action('added-kong'))
        added = next(a for a in _view(first)['ownActions'] if a['kind'] == 'added-kong')
        _submit(room, 0, first, added)
        _, rob = await _next_snapshot(queues[1], _has_action('win'))
        win = next(a for a in _view(rob)['ownActions'] if a['kind'] == 'win')
        _submit(room, 1, rob, win)
        await _assert_win_gate(queues, 0, 'added-kong')
    finally:
        task.cancel()


@pytest.mark.asyncio
async def test_continue_confirmation_broadcasts_ready_count():
    """问题2回归：真人回执「下一局」立即广播就绪计数（两端同步看到 x/y），重复回执不重复广播。"""
    room, queues = _make_two_human_room('BF-CONT-BC')
    # 局间兜底 45s：血流结算面板被局末演出门控（尾巴可达十余秒），客户端 10s 倒计时
    # 从面板可打开才起算；兜底必须覆盖「演出尾巴 + 完整倒计时」，只防客户端无响应。
    assert room.continue_timeout == 45.0
    room.round_index = 0   # 第 0 局（东1局）已打完
    room.round_result = {'ruleVersion': 'x', 'roundId': 'round-0', 'reason': 'wall-exhausted',
                         'ledger': [], 'seats': []}

    ok, err = room.handle_client_message(0, {'kind': 'continue', 'round': 1})
    assert ok, err
    for seat in (0, 1):
        message = await asyncio.wait_for(queues[seat].get(), timeout=5)
        assert message['kind'] == 'bf_snapshot'
        assert message['continuation'] == {'requiredSeats': [0, 1], 'readySeats': [0]}

    # 重复回执：幂等且不再广播。
    ok, _ = room.handle_client_message(0, {'kind': 'continue', 'round': 1})
    assert ok
    assert queues[1].empty()


@pytest.mark.asyncio
async def test_finished_room_is_kept_and_supports_rematch():
    """整场结束房间不自动解散：注册表仍在、**准备态保留**（可直接再开一场）；
    close 广播 room_closed 让剩余客户端清理会话。"""
    room = room_registry.create('BF-REMATCH', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('玩家1', None, 'p1')
    room.ready_seat(0, True)
    queue: asyncio.Queue = asyncio.Queue()
    room.conn.register(0, queue, None)
    room.on_connect(0)
    assert room.handle_client_message(0, {'kind': 'auto', 'enabled': True}) == (True, '')
    await room.start()
    while not room.match_finished:
        message = await asyncio.wait_for(queue.get(), timeout=90)
        if message.get('kind') == 'bf_snapshot' and message.get('opening'):
            room.handle_client_message(0, {'kind': 'opening_done', 'round': message['round']})
    assert room.status == 'finished'
    # 房间保留（不解散）：注册表仍能查到；准备态保留 → 立刻可以再开一场。
    assert room_registry.get('BF-REMATCH') is room
    assert room.seats[0].ready is True
    await room.start()
    assert room.status == 'playing'
    assert room.match_finished is False
    assert sum(room.scores) == BLOOD_FLOW_CONFIG.initial_score * 4
    await asyncio.sleep(0.2)
    assert room.round_index >= 0   # 新一场已开始驱动
    room.close()
    # close 广播 room_closed（对齐经典）：客户端据此清理本地会话，不再对着死房间重连。
    closed = None
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and closed is None:
        try:
            message = await asyncio.wait_for(queue.get(), timeout=0.5)
        except asyncio.TimeoutError:
            break
        if message.get('kind') == 'room_closed':
            closed = message
    assert closed is not None


def test_creator_leave_transfers_creator_one_way():
    """房主离座 → 房主顺延给剩余座位中编号最小者；单向不回收（对齐经典房间）。"""
    room = room_registry.create('BF-CREATOR', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    seat_a, _, state_a = room.join_or_rejoin('甲', None, 'p1')
    seat_b, _, _ = room.join_or_rejoin('乙', None, 'p2')
    assert room.creator_seat == seat_a

    room.release_seat(seat_a, state_a.rejoin_code)
    assert room.creator_seat == seat_b        # 顺延给在场的最小编号座位
    # 原房主重进（原座位已释放，只能占空座）也不拿回房主身份。
    room.join_or_rejoin('甲', None, 'p1')
    assert room.creator_seat == seat_b


def test_room_lifetime_matches_classic_and_expires_by_deadline():
    """房间限时与经典房间同口径（ROOM_LIFETIME）：非对局中到期回收、对局中不回收。"""
    from app.game.room import ROOM_LIFETIME

    classic = room_registry.create('BF-TTL-CLASSIC', mode='east', capacity=4)
    room = room_registry.create('BF-TTL', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    # REST 契约字段 lifetime 随房间下发给前端大厅提示，必须与经典房间一致。
    assert room.lifetime == classic.lifetime == ROOM_LIFETIME
    assert room.is_past_deadline() is False
    assert room.is_expired() is False
    # 非对局中超过限时 → 可回收（与是否有人在座无关）
    room.deadline = time.monotonic() - 1
    assert room.is_past_deadline() is True
    assert room.is_expired() is True
    # 对局中绝不回收：等对局结束（_drive 收尾按同一 deadline 释放）
    room.status = 'playing'
    assert room.is_expired() is False


@pytest.mark.asyncio
async def test_expired_room_released_after_match_without_self_cancel():
    """对局结束时已超限时 → 自动释放房间（对齐经典 _drive），且不自我取消驱动任务。"""
    room = room_registry.create('BF-EXPIRED', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.join_or_rejoin('玩家1', None, 'p1')
    room.ready_seat(0, True)
    # 托管座位不占开局/局间屏障，整场由服务端代打跑完。
    assert room.handle_client_message(0, {'kind': 'auto', 'enabled': True}) == (True, '')
    room.deadline = time.monotonic() - 1
    await room.start()
    task = room._drive_task
    assert task is not None
    for _ in range(2400):  # 最多 120s
        if task.done():
            break
        await asyncio.sleep(0.05)
    assert task.done(), '整场驱动未在限时内结束'
    # 自我取消守卫：close() 由 _drive 自身回调时不得注入 CancelledError。
    assert task.cancelled() is False
    assert room.closed is True
    assert room.status == 'finished'
    assert room_registry.get('BF-EXPIRED') is None
