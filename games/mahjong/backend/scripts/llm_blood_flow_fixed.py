"""血流 LLM 席位固定输入验收（本地一次性脚本，不提交密钥、不回显）。

用前端仓库 tmp/test-api-key.json 的 activeId 供应商（默认 DeepSeek）对四条固定局面
走真实请求循环的同一路径（候选+EV 提示词 → requestLlmDecision），断言选择合法并记录
台词与耗时。结果写 work/llm_blood_flow_fixed_results.json（不含密钥）。

用法：
    cd backend
    PYTHONIOENCODING=utf-8 .venv/Scripts/python python scripts/llm_blood_flow_fixed.py
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)

from app.game.blood_flow_engine import BloodFlowEngine
from app.game.blood_flow_room import BloodFlowRoomSession
from app.llm.blood_flow_candidates import (build_blood_flow_candidates,
                                           build_blood_flow_prompt, ev_features_for)
from app.llm.client import request_llm_decision
from app.llm.config import LlmServerConfig
from app.rules.blood_flow import BloodFlowRuleSet

KEY_FILE = Path(BACKEND_DIR) / '..' / 'tmp' / 'test-api-key.json'

CLAIM_HANDS = [
    ['m7', 'm8', 'm9', 'p7', 'p8', 'p9', 's7', 's8', 's9', 'north', 'west', 'south', 'p4', 'm5'],
    ['m3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east', 'east'],
    ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
    ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'north'],
]
REFORM_HANDS = [
    ['m1', 'm1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm5', 'p1', 'p1', 'p1', 's7', 'white'],
    ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9', 'east', 'south', 'west', 'north'],
    ['m2', 'm6', 'm8', 'p3', 'p6', 'p9', 's2', 's5', 's8', 'red', 'green', 'white', 'p4'],
    ['m3', 'm9', 'p7', 's1', 's4', 'p4', 'p6', 's2', 's5', 's8', 'red', 'green', 'white'],
]
NEAR_BIG = ['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3', 'm4', 'm4', 'm4', 'east']


def make_opening(*, hands, wall_front, jokers=None):
    from tests.test_blood_flow_engine import make_opening as _make_opening
    return _make_opening(hands=hands, wall_front=wall_front, jokers=jokers)


def room_for(engine: BloodFlowEngine) -> BloodFlowRoomSession:
    room = BloodFlowRoomSession('FIXED', mode='east', capacity=4,
                                ruleset_id='lotus-blood-flow', pace=0)
    room.engine = engine
    return room


def scenarios() -> list[dict]:
    from tests.test_blood_flow_engine import make_opening as _make_opening
    # ① 摸精改张单吊任意听
    engine1 = BloodFlowEngine(authority_epoch='fixed', round_id='r1', rules=BloodFlowRuleSet(),
                              opening=_make_opening(hands=REFORM_HANDS, wall_front=['north'], jokers=['white']))
    view1 = room_for(engine1)._seat_view(0)
    # ② 早局低番高潜力拒胡
    engine2 = BloodFlowEngine(authority_epoch='fixed', round_id='r2', rules=BloodFlowRuleSet(),
                              opening=_make_opening(hands=CLAIM_HANDS, wall_front=['north']))
    engine2.submit(engine2.command(0, {'kind': 'discard', 'index': 13}))
    view2 = room_for(engine2)._seat_view(1)
    view2['wallCount'] = 60
    view2['ownScore'] = {'paymentPerPayer': 10, 'source': 'discard', 'items': [], 'hardWin': False}
    # ③④ 抢杠低番过 / 高番胡（④用普通手牌：无潜力时 EV 应胡）
    engine3 = BloodFlowEngine(authority_epoch='fixed', round_id='r3', rules=BloodFlowRuleSet(),
                              opening=_make_opening(hands=CLAIM_HANDS, wall_front=['north']))
    engine3.submit(engine3.command(0, {'kind': 'discard', 'index': 13}))
    room3 = room_for(engine3)
    view3 = room3._seat_view(1)
    view3['players'][1]['hand'] = list(NEAR_BIG)
    view3['players'][1]['melds'] = []
    view3['jokers'] = []
    view3['ownActions'] = [{'kind': 'win'}, {'kind': 'pass'}]
    view3['window'] = {'id': 'w3', 'version': 1, 'kind': 'win',
                       'source': {'id': 's', 'kind': 'added-kong', 'tile': 'east', 'seat': 0},
                       'deadlineAt': 0, 'opensAt': 0}
    view3['ownScore'] = {'paymentPerPayer': 20, 'source': 'robbed-kong', 'items': [], 'hardWin': False}
    view4 = room3._seat_view(1)  # 普通手牌（原 rig），无大番潜力
    view4['ownActions'] = [{'kind': 'win'}, {'kind': 'pass'}]
    view4['window'] = {'id': 'w4', 'version': 1, 'kind': 'win',
                       'source': {'id': 's', 'kind': 'added-kong', 'tile': 'm5', 'seat': 0},
                       'deadlineAt': 0, 'opensAt': 0}
    view4['ownScore'] = {'paymentPerPayer': 40, 'source': 'robbed-kong', 'items': [], 'hardWin': False}
    return [
        {'name': '摸精改张单吊任意听', 'view': view1},
        {'name': '早局低番高潜力拒胡', 'view': view2},
        {'name': '低番抢杠距大番一张', 'view': view3},
        {'name': '抢杠收益可观', 'view': view4},
    ]


async def main() -> int:
    payload = json.loads(KEY_FILE.read_text(encoding='utf-8'))
    presets = payload.get('presets') or []
    active = payload.get('activeId')
    preset = next((p for p in presets if p.get('id') == active), None) or (presets[0] if presets else None)
    if not preset or not preset.get('apiKey'):
        print('未找到可用供应商（tmp/test-api-key.json 缺失或无 presets）')
        return 2
    config = LlmServerConfig(
        enabled=True,
        base_url=preset['baseUrl'], api_key=preset['apiKey'], model=preset['model'],
        style=preset.get('style') or '稳健',
        timeout_s=float(preset.get('timeoutMs') or 40_000) / 1000,
        timeout_enabled=preset.get('timeoutEnabled', True),
    )
    config.provider_type = preset.get('providerType') or ''
    print(f"[1/3] 供应商 {preset.get('name')} / {preset['model']}（key 不回显）")
    results = []
    for scenario in scenarios():
        view = scenario['view']
        request_id = f'fixed/{scenario["name"]}'
        from app.core.blood_flow.ai import decide_blood_flow_action_ev
        from app.core.blood_flow.config import BLOOD_FLOW_AI
        suggestion = decide_blood_flow_action_ev(view, BLOOD_FLOW_AI)
        built = build_blood_flow_candidates(view, request_id, suggestion=suggestion,
                                            ev_by_key=ev_features_for(view))
        system, user = build_blood_flow_prompt(config.style, view, built)
        candidate_ids = [c['id'] for c in built['candidates']]
        started = time.perf_counter()
        choice = message = None
        error = None
        try:
            choice, message = await asyncio.wait_for(
                request_llm_decision(config, system, user, candidate_ids, False),
                timeout=config.timeout_s)
        except Exception as exc:
            error = f'{type(exc).__name__}: {exc}'
        suggestion_candidate = next((c for c in built['candidates'] if c['id'] == built['engineSuggestion']), None)
        chosen = next((c for c in built['candidates'] if c['id'] == choice), None)
        valid = choice in candidate_ids
        results.append({
            'scenario': scenario['name'],
            'suggestionId': built['engineSuggestion'],
            'suggestion': suggestion_candidate['label'] if suggestion_candidate else None,
            'choice': choice,
            'choiceLabel': chosen['label'] if chosen else None,
            'message': message,
            'valid': valid,
            'error': error,
            'elapsedMs': round((time.perf_counter() - started) * 1000),
        })
        assert valid, f'{scenario["name"]} 选择非法: {choice}'
    print('[2/3] 四条固定输入全部合法')
    for result in results:
        print(f"      {result['scenario']}: 建议[{result['suggestion']}] → "
              f"选择[{result['choiceLabel']}] 「{result['message'] or ''}」 {result['elapsedMs']}ms")
    out = Path(BACKEND_DIR) / 'work' / 'llm_blood_flow_fixed_results.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({'ruleVersion': 'lotus-blood-flow-v1', 'provider': preset.get('name'),
                               'model': preset.get('model'), 'results': results},
                              ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[3/3] 结果落盘 {out}')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception as exc:
        import traceback
        traceback.print_exc()
        print(f'\n血流 LLM 固定输入验收失败：{exc}')
        raise SystemExit(1)
