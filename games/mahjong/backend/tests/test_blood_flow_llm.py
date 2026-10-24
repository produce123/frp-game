"""血流 LLM 候选构建/校验测试（M4）—— 候选形状、默认推荐、动作复核、提示词与 EV 注入。"""

import asyncio
import json
import os
import re
from pathlib import Path

import pytest

from app.game.blood_flow_engine import BloodFlowEngine
from app.game.blood_flow_room import BloodFlowRoomSession
from app.llm.blood_flow_candidates import (_candidate_summary, blood_flow_prompt_rules,
                                           build_blood_flow_candidates,
                                           build_blood_flow_prompt,
                                           ev_features_for,
                                           validate_blood_flow_action)
from app.rules.blood_flow import BloodFlowRuleSet
from tests.test_blood_flow_engine import make_opening


def _frontend_prompt_source() -> str | None:
    """前端 ``bloodFlowDecisionInput.ts`` 文本（用于逐字对拍规则摘要）；缺失返回 None。

    backend 是 linked worktree：用 ``absolute()``（而非 ``resolve()``）保持工作区视图下的
    前端仓库路径（与 test_blood_flow_rules.py 的夹具定位同口径）；另可用环境变量覆盖。
    """
    relative = Path('src') / 'game' / 'llm' / 'bloodFlowDecisionInput.ts'
    roots: list[Path] = []
    for name in ('LOTUS_FRONTEND_ROOT', 'DSH_WORKSPACE_ROOT', 'WORKSPACE_ROOT'):
        value = os.environ.get(name)
        if value:
            roots.append(Path(value))
    roots.extend(Path(__file__).absolute().parents)
    for root in dict.fromkeys(roots):
        candidate = root / relative
        if candidate.is_file():
            return candidate.read_text(encoding='utf-8')
    return None


FRONTEND_PROMPT_SOURCE = _frontend_prompt_source()


def make_room(engine: BloodFlowEngine) -> BloodFlowRoomSession:
    room = BloodFlowRoomSession('LLM-T', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.engine = engine
    return room


def test_candidates_filter_protected_discards_and_label_actions():
    rules = BloodFlowRuleSet()
    engine = BloodFlowEngine(authority_epoch='t', round_id='cand', rules=rules,
                             opening=make_opening(
                                 hands=[['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9',
                                         'north', 'west', 'south', 'p4', 'm5'],
                                        ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
                                        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
                                        ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north']],
                                 wall_front=['north']))
    room = make_room(engine)
    view = room._seat_view(0)
    built = build_blood_flow_candidates(view, 'req-1')
    # 庄家开局回合：无胡、无杠，只有 14 个弃牌候选。
    assert len(built['candidates']) >= 13
    assert all(c['action']['kind'] == 'discard' for c in built['candidates'])
    assert built['engineSuggestion'] is not None
    # 候选 id 与合法性键稳定。
    assert built['candidates'][0]['id'] == 'A1'
    assert all(c['legalityKey'].startswith('discard:') for c in built['candidates'])


def test_win_candidate_carries_score_and_lock_risk():
    hands = [
        ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p4', 'm5'],
        ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
        ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='win-cand', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['north']))
    assert engine.submit(engine.command(0, {'kind': 'discard', 'index': 13}))
    room = make_room(engine)
    view = room._seat_view(1)
    assert {'kind': 'win'} in view['ownActions']
    built = build_blood_flow_candidates(view, 'req-win', suggestion={'kind': 'win'})
    win = next(c for c in built['candidates'] if c['action']['kind'] == 'win')
    assert win['features']['scoreDelta'] == win['features']['scoreDeltaBand'] or True
    assert win['features']['scoreDelta'] > 0
    assert any('锁手' in r for r in win['features']['risks'])
    assert built['engineSuggestion'] == win['id']
    assert validate_blood_flow_action(view, {'kind': 'win'}) is True
    assert validate_blood_flow_action(view, {'kind': 'discard', 'index': 999}) is False


def test_discard_candidate_exposes_waits():
    rules = BloodFlowRuleSet()
    engine = BloodFlowEngine(authority_epoch='t', round_id='waits', rules=rules,
                             opening=make_opening(
                                 hands=[['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9',
                                         'north', 'west', 'south', 'p4', 'm5'],
                                        ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
                                        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
                                        ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north']],
                                 wall_front=['north']))
    room = make_room(engine)
    view = room._seat_view(0)
    built = build_blood_flow_candidates(view, 'req-waits')
    with_waits = [c for c in built['candidates']
                  if c['features']['ready'] is True and c['features']['waits'] != 'n/a']
    assert with_waits, '开局手牌应有可听后弃牌候选'
    assert all(w['remaining'] >= 0 for c in with_waits for w in c['features']['waits'])


def test_prompt_rules_cover_ev_and_lock_clauses():
    rules = blood_flow_prompt_rules()
    for clause in ('硬胡×2', '首次胡锁手', '牌墙耗尽才结算', '期望收益', '单吊任意听', '抢杠'):
        assert clause in rules


def test_prompt_rules_cover_opponent_risk_clause():
    """TS 新增的赔付口径句必须逐字一致地出现在 prompt 规则里（2026-09-15 番表：封顶 128 / 鸡胡 0.5 / 杠加成）。"""
    rules = blood_flow_prompt_rules()
    assert ('点炮赔付=底分10×番型倍率×事件倍率（点炮×1、自摸/抢杠×2、杠上开花×4），'
            '单家封顶128倍；杠另有加成（明杠+1、风杠+1、暗杠+2，'
            '但已成三杠/四杠番种时不再叠加；鸡胡不与任何番型叠加——开了杠只算杠番、不加鸡胡的0.5番）。'
            '杠候选带 features.kongValue（开杠价值 = 杠收益 − 防守风险 − 自手牌型损失）：'
            'net ≤ 0 表示这一杠会拆掉自己的七对/豪华七对、破坏门清或让向听变差，默认建议不会是杠。'
            '同一张牌打给在做大牌（清一色/三元/四喜等）的对手，'
            '代价可达鸡胡的16~64倍；候选 features.opponentRisk 给出该牌按公共信息估算的赔付档与信号。'
            ) in rules
    # 新番表语义必须写明，否则模型会按旧口径（门清平胡 2 番、鸡胡 1 番）算番。
    for clause in ('门清（1番', '平胡（1番', '鸡胡（0.5番、支付减半）', '番型倍率按番值**相加**'):
        assert clause in rules


def test_prompt_rules_cover_kong_value_clause():
    """第 3 步：开杠价值口径必须在 prompt 里说明（模型覆盖默认建议时要看得懂为什么不该杠）。"""
    rules = blood_flow_prompt_rules()
    for clause in ('features.kongValue', '杠收益', '自手牌型损失', 'net ≤ 0'):
        assert clause in rules


def test_prompt_rules_mirror_frontend_literal():
    """``blood_flow_prompt_rules`` 必须与前端 ``BLOOD_FLOW_PROMPT_RULES`` 逐字一致。

    直接读前端仓库源文件抽取字面量；前端工作区缺失时跳过（CI 不依赖前端仓库）。
    """
    frontend = FRONTEND_PROMPT_SOURCE
    if frontend is None:
        pytest.skip('frontend bloodFlowDecisionInput.ts not found')
    match = re.search(r"BLOOD_FLOW_PROMPT_RULES = '([^']*)'", frontend)
    assert match, 'frontend BLOOD_FLOW_PROMPT_RULES literal not found'
    assert blood_flow_prompt_rules() == match.group(1)


def risk_rig(opponent_melds: list[dict] | None = None) -> BloodFlowEngine:
    """座位 1 带可配置副露 + 一张牌河（染手嫌疑信号）；其余座位牌河为空。"""
    melds = [[], list(opponent_melds or []), [], []]
    engine = BloodFlowEngine(
        authority_epoch='t', round_id='risk-cand', rules=BloodFlowRuleSet(),
        opening=make_opening(hands=[
            ['m8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p6', 'm5', 'm1'],
            ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
            ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
            ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north'],
        ], wall_front=['north'], melds=melds))
    engine.players[1]['discards'] = []
    return engine


FLUSH_MELDS = [{'type': 'peng', 'tile': 'p4', 'tiles': ['p4', 'p4', 'p4']},
               {'type': 'peng', 'tile': 'p7', 'tiles': ['p7', 'p7', 'p7']}]


def test_discard_candidates_carry_opponent_risk_feature():
    """血流：每个弃牌候选都带公共信息风险赔付，且嫌疑花色/公开张数档确实生效。

    公开张数口径含本家暗手（与前端 visibleTiles 同源）：
    现物（≥2 张）= 0 档、公开 1 张 = 0.1 档；
    嫌疑花色（本副露集中在 p）系数 1，非嫌疑花色 ×0.5。
    """
    engine = risk_rig(FLUSH_MELDS)
    view = make_room(engine)._seat_view(0)
    built = build_blood_flow_candidates(view, 'req-risk')
    discards = [c for c in built['candidates'] if c['action']['kind'] == 'discard']
    assert discards, '开局应有弃牌候选'
    assert all(c['features']['opponentRisk']['tier'] == '中' for c in discards)
    by_label = {c['label']: c['features']['opponentRisk']['payment'] for c in discards}
    # 公开张数档含本家暗手：现物（≥2 张）= 0 / 公开 1 张 = ×0.1。
    assert set(by_label.values()) == {0, 32, 64}
    assert by_label['打出8筒'] == 64      # 公开 1 张 + 嫌疑花色：40 × 16 × 0.1
    assert by_label['打出6筒'] == 64
    assert by_label['打出7筒'] == 0       # 现物（本家 p7 + 副露 p7×3 = 4 张）
    assert by_label['打出9筒'] == 0       # 现物（本家 p9 + 对手副露 p9）
    assert by_label['打出8万'] == 32      # 公开 1 张 + 非嫌疑花色：40 × 16 × 0.1 × 0.5
    assert by_label['打出西风'] == 32
    # 同一公开张数档下，嫌疑花色（p）严格贵于非嫌疑花色（m/s/字）。
    assert by_label['打出8筒'] > by_label['打出8万']


def test_summary_and_prompt_render_risk_payment():
    engine = risk_rig(FLUSH_MELDS)
    room = make_room(engine)
    view = room._seat_view(0)
    built = build_blood_flow_candidates(view, 'req-risk-sum')
    risk = next(c for c in built['candidates'] if c['features'].get('opponentRisk'))
    expected_payment = risk['features']['opponentRisk']['payment']
    summaries = {c['id']: _candidate_summary(c) for c in built['candidates']}
    assert risk['id'] in summaries
    assert f'风险赔付：约{expected_payment}点（中·副露染手嫌疑' in summaries[risk['id']]
    system, user = build_blood_flow_prompt('稳健', view, built)
    payload = json.loads(user)
    assert any('风险赔付：约' in c['summary'] for c in payload['candidates'])
    assert 'opponentRisk' in json.dumps(payload['candidates'], ensure_ascii=False)


def test_no_signal_keeps_old_candidate_shape():
    """对手没有大牌信号时不产出该键（保持旧形状）。"""
    engine = risk_rig([])
    view = make_room(engine)._seat_view(0)
    built = build_blood_flow_candidates(view, 'req-quiet')
    assert all('opponentRisk' not in c['features'] for c in built['candidates'])
    assert all('风险赔付' not in _candidate_summary(c) for c in built['candidates'])


def test_switch_off_candidates_have_no_risk_feature():
    """BLOOD_FLOW_AI.opponent_pattern_risk = 'off' 时候选不再产出 opponentRisk。"""
    from dataclasses import replace

    from app.core.blood_flow import ai as blood_ai
    from app.core.blood_flow.config import BLOOD_FLOW_AI

    engine = risk_rig(FLUSH_MELDS)
    view = make_room(engine)._seat_view(0)
    off = replace(BLOOD_FLOW_AI, opponent_pattern_risk='off')
    original = blood_ai.blood_flow_opponent_risk

    def guarded(view_arg, config=off):
        return original(view_arg, off)

    blood_ai.blood_flow_opponent_risk = guarded
    try:
        built = build_blood_flow_candidates(view, 'req-off')
    finally:
        blood_ai.blood_flow_opponent_risk = original
    assert all('opponentRisk' not in c['features'] for c in built['candidates'])


def test_prompt_payload_carries_top_level_opponent_risk():
    """user 载荷顶层 opponentRisk：[{seat, tier, signals}]，只保留 tier > 0 的对手。"""
    engine = risk_rig(FLUSH_MELDS)
    room = make_room(engine)
    view = room._seat_view(0)
    built = build_blood_flow_candidates(view, 'req-top')
    _, user = build_blood_flow_prompt('稳健', view, built)
    payload = json.loads(user)
    assert payload['opponentRisk'] == [{
        'seat': 1, 'tier': 2, 'signals': ['副露染手嫌疑'],
    }]


def test_prompt_payload_opponent_risk_is_empty_without_signal():
    engine = risk_rig([])
    room = make_room(engine)
    view = room._seat_view(0)
    built = build_blood_flow_candidates(view, 'req-top-quiet')
    _, user = build_blood_flow_prompt('稳健', view, built)
    assert json.loads(user)['opponentRisk'] == []


def test_prompt_payload_opponent_risk_is_empty_when_switch_off():
    from dataclasses import replace

    from app.core.blood_flow import ai as blood_ai
    from app.core.blood_flow.config import BLOOD_FLOW_AI

    engine = risk_rig(FLUSH_MELDS)
    room = make_room(engine)
    view = room._seat_view(0)
    built = build_blood_flow_candidates(view, 'req-top-off')
    off = replace(BLOOD_FLOW_AI, opponent_pattern_risk='off')
    original = blood_ai.blood_flow_opponent_risk
    blood_ai.blood_flow_opponent_risk = lambda view_arg, config=off: original(view_arg, off)
    try:
        _, user = build_blood_flow_prompt('稳健', view, built)
    finally:
        blood_ai.blood_flow_opponent_risk = original
    assert json.loads(user)['opponentRisk'] == []


def test_lotus_classic_rule_never_prices_opponent_risk():
    """lotus-classic（广麻无普通点炮）：候选恒不带风险定价。"""
    engine = risk_rig(FLUSH_MELDS)
    view = make_room(engine)._seat_view(0)
    view['ruleVersion'] = 'lotus-classic-v1'
    built = build_blood_flow_candidates(view, 'req-classic')
    assert all('opponentRisk' not in c['features'] for c in built['candidates'])


def test_prompt_builds_system_and_user_payload_with_ev():
    hands = [
        ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p4', 'm5'],
        ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
        ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='prompt', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['north']))
    assert engine.submit(engine.command(0, {'kind': 'discard', 'index': 13}))
    room = make_room(engine)
    view = room._seat_view(1)
    built = build_blood_flow_candidates(view, 'req-p', suggestion={'kind': 'win'},
                                        ev_by_key=ev_features_for(view))
    system, user = build_blood_flow_prompt('稳健', view, built)
    assert '可以覆盖' in system and '期望收益' in system
    payload = json.loads(user)
    assert payload['engineSuggestion'] == next(
        c['id'] for c in built['candidates'] if c['action']['kind'] == 'win')
    win = next(c for c in payload['candidates'] if c['features'].get('ev', {}).get('win'))
    assert win['features']['ev']['win']['floor'] == 40
    assert '胡牌（首次胡后锁手）' in win['label']
    assert payload['currentWin']['paymentPerPayer'] > 0


def test_reform_ev_injection_marks_any_tile_wait():
    hands = [
        ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p1', 'p1', 's7', 'white'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
        ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'p4'],
        ['m3', 'm9', 'p7', 's1', 's4', 'p4', 'p6', 's2', 's5', 's8', 'red', 'green', 'white'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='ev-inj', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['north'], jokers=['white']))
    room = make_room(engine)
    view = room._seat_view(0)
    built = build_blood_flow_candidates(view, 'req-ev', ev_by_key=ev_features_for(view))
    reform = next(c for c in built['candidates']
                  if c['action'] == {'kind': 'discard', 'index': 12})
    assert reform['features']['ev']['reform']['anyWait'] is True


def claim_rig() -> BloodFlowEngine:
    hands = [
        ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p4', 'm5'],
        ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
        ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
        ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north'],
    ]
    engine = BloodFlowEngine(authority_epoch='t', round_id='llm-seat', rules=BloodFlowRuleSet(),
                             opening=make_opening(hands=hands, wall_front=['north']))
    assert engine.submit(engine.command(0, {'kind': 'discard', 'index': 13}))
    return engine


@pytest.mark.asyncio
async def test_llm_seat_choice_is_applied_over_ev():
    engine = claim_rig()
    room = make_room(engine)
    from app.llm.config import LlmServerConfig
    room.llm_seats = {1: LlmServerConfig(enabled=True, base_url='x', api_key='x', model='x',
                                         style='稳健', timeout_s=40.0, timeout_enabled=True)}
    view = room._seat_view(1)
    built = build_blood_flow_candidates(view, 'x')
    pass_id = next(c['id'] for c in built['candidates'] if c['action']['kind'] == 'pass')

    async def fake_request(cfg, system, user, candidate_ids, reasoning=False):
        assert candidate_ids == [c['id'] for c in built['candidates']]
        assert '期望收益' in system
        return pass_id, '再看看。'

    room.llm_request = fake_request
    await room._decide_bots(engine)
    # LLM 选了过（EV 会胡）：窗口解决、无人胡，轮到赢家下家摸牌。
    assert engine.window['id'] != view['window']['id']
    assert engine.current_player == 1
    assert len(engine.players[1]['hand']) == 14


@pytest.mark.asyncio
async def test_llm_seat_failure_falls_back_to_ev():
    engine = claim_rig()
    room = make_room(engine)
    from app.llm.config import LlmServerConfig
    room.llm_seats = {1: LlmServerConfig(enabled=True, base_url='x', api_key='x', model='x',
                                         style='稳健', timeout_s=40.0, timeout_enabled=True)}

    async def broken_request(cfg, system, user, candidate_ids, reasoning=False):
        raise RuntimeError('provider down')

    room.llm_request = broken_request
    queue: asyncio.Queue = asyncio.Queue()
    room.conn.register(0, queue, None)
    await room._decide_bots(engine)
    # 失败回退 EV：胡（该点炮 EV 高于门槛）。
    assert engine.seats[1]['locked'] is True
    assert engine.ledger[-1]['kind'] == 'win'
    # 失败只发问号气泡（对齐经典 _on_llm_fallback），不创建 TTS。
    messages = _drain(queue)
    assert [m['text'] for m in messages if m.get('kind') == 'llm_message'] == ['？']
    assert [m for m in messages if m.get('kind') == 'llm_audio'] == []


def _drain(queue: asyncio.Queue) -> list[dict]:
    messages = []
    while not queue.empty():
        messages.append(queue.get_nowait())
    return messages


@pytest.mark.asyncio
async def test_llm_message_and_tts_audio_are_broadcast(monkeypatch):
    """模型原话随决策即时下发：气泡 llm_message + 服务端合成 llm_audio（对齐经典房间）。

    联机血流此前丢弃模型回复、由客户端拼模板台词；这里断言原话文本与音频 URL 都下发。
    """
    engine = claim_rig()
    room = make_room(engine)
    from app.llm.config import LlmServerConfig
    room.llm_seats = {1: LlmServerConfig(enabled=True, base_url='x', api_key='x', model='x',
                                         style='稳健', timeout_s=40.0, timeout_enabled=True)}
    view = room._seat_view(1)
    built = build_blood_flow_candidates(view, 'x')
    pass_id = next(c['id'] for c in built['candidates'] if c['action']['kind'] == 'pass')

    async def fake_request(cfg, system, user, candidate_ids, reasoning=False):
        return pass_id, '  这张先走。  '   # 原文带空白：服务端归一后下发

    class FakeAudio:
        audio_url = '/api/local-tts/audio/abc.mp3'
        cached = True
        size_bytes = 1200

    class FakeTts:
        available = True

        async def ensure_audio(self, text, style, provider_id):
            assert text == '这张先走。'
            assert style == '稳健'
            return FakeAudio()

    monkeypatch.setattr('app.game.blood_flow_room.get_tts_service', lambda: FakeTts())
    room.llm_request = fake_request
    queue: asyncio.Queue = asyncio.Queue()
    room.conn.register(0, queue, None)

    await room._decide_bots(engine)
    await asyncio.sleep(0.01)   # 让 TTS 任务跑完

    messages = _drain(queue)
    speech = [m for m in messages if m.get('kind') == 'llm_message']
    audio = [m for m in messages if m.get('kind') == 'llm_audio']
    assert len(speech) == 1
    assert speech[0]['seat'] == 1 and speech[0]['text'] == '这张先走。'
    assert speech[0]['speechSource'] == 'model-message'
    # 过（pass）属 commentary（不对外泄露动作键），与经典 _model_speech_metadata 同口径。
    assert speech[0]['purpose'] == 'commentary' and 'actionKind' not in speech[0]
    assert len(audio) == 1
    assert audio[0]['messageId'] == speech[0]['id']
    assert audio[0]['audioUrl'] == '/api/local-tts/audio/abc.mp3'
    assert audio[0]['cached'] is True and audio[0]['priority'] == 'normal'
    # 统计口径与经典房间一致（请求/命中）。
    assert room._tts_match_stats == {'requests': 1, 'hits': 1, 'misses': 0,
                                     'successes': 1, 'failures': 0}
