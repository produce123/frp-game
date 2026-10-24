"""LLM 玩家控制器 —— §2/§3/§8（联机空座补位）。

LLMPlayer(AIPlayer)：覆盖 request_turn / request_claim；
- 胡由引擎短路（v1 不放给 LLM）；唯一例外是杠后全听时先杠，确定性博杠上开花；
- skipDraw 只允许出牌（候选枚举不含杠/胡）；
- LLM 决定 → validate_action（§8.2，逐类型）→ 失败/超时/网络/HTTP → 本次候选的确定性回退动作；
- request_rob_kong 继承 AIPlayer（能抢必抢）。
"""

import asyncio
import inspect
from typing import Callable, Optional

from app.game.player import AIPlayer, ClaimContext, TurnContext
from app.core.kong_projection import project_kong_bloom
from app.llm.candidates import build_request, inferior_classic_discard
from app.llm.client import request_llm_decision
from app.llm.config import LlmServerConfig, load_llm_config
from app.llm.prompt import build_prompt
from app.llm.decision_speech import (
    reasoning_status_speech, resolve_decision_speech, safe_reasoning_status,
)
from app.llm.validation import validate_action
from app.llm.conditional_reasoning import ConditionalReasoningCoordinator
from app.llm.reasoning import resolve_reasoning_policy
from app.llm.reasoning_budget import is_reasoning_suppressed
from app.rules.base import GameRuleSet


IMPORTANT_SPEECH_ACTIONS = {
    'gang', 'peng', 'chi', 'added-kong', 'concealed-kong', 'wind-kong',
}


def _accepts_message_metadata(callback: Callable[..., None] | None) -> bool:
    if callback is None:
        return False
    try:
        parameters = inspect.signature(callback).parameters.values()
    except (TypeError, ValueError):
        return False
    return any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters) \
        or {'decision', 'action_kind'}.issubset(
            inspect.signature(callback).parameters)


class LLMPlayer(AIPlayer):
    """LLM 驱动的 AI 玩家（联机空座补位用；超时/断线代打仍用 AIPlayer）。"""

    def __init__(self, delays: Optional[dict] = None, random=None,
                 rule_set: Optional[GameRuleSet] = None,
                 config: Optional[LlmServerConfig] = None,
                 stats: Optional[dict] = None,
                 seat: int = -1,
                 provider_id: str = '',
                 on_message: Optional[Callable[..., None]] = None,
                 on_fallback: Optional[Callable[..., None]] = None,
                 on_status: Optional[Callable[..., None]] = None,
                 reasoning: Optional[ConditionalReasoningCoordinator] = None):
        super().__init__(delays=delays, random=random, rule_set=rule_set)
        self.config = config or load_llm_config()
        self.stats = stats if stats is not None else {
            'requests': 0, 'successes': 0, 'fallbacks': 0, 'messages': 0,
            'invalid': 0, 'reasoningRequests': 0,
            'thinkingRequests': 0, 'enhancedReasoningRequests': 0,
        }
        self.requests = 0  # 本座位自建以来请求数（房间预算近似：每座位独立计数）
        self.seat = seat
        self.provider_id = provider_id
        self.on_message = on_message
        self._on_message_accepts_metadata = _accepts_message_metadata(on_message)
        self.on_fallback = on_fallback
        self.on_status = on_status
        self.reasoning = reasoning or ConditionalReasoningCoordinator()
        self.reasoning_status_sequence = 0
        self.message_history: list[str] = []

    async def request_turn(self, ctx: TurnContext) -> dict:
        ms = self.delays['after_kong'] if ctx.afterKong else self.delays['turn']
        if ms:
            await asyncio.sleep(ms / 1000)
        rules = self.rules
        if rules.code == 'lotus-legacy' and not ctx.skipDraw:
            jokers = list(ctx.jokers or getattr(rules.round_state, 'jokers', []))
            for tile in rules.concealed_kongs(ctx.hand):
                if project_kong_bloom(
                        kind='concealed-kong', hand=ctx.hand,
                        exposed_melds=ctx.exposedMelds, jokers=jokers, tile=tile,
                        visible_tiles=ctx.visibleTiles).guaranteed_kong_bloom:
                    return {'kind': 'concealed-kong', 'tile': tile}
            wind_kong = getattr(rules, 'wind_kong', None)
            if wind_kong and wind_kong(ctx.hand) and project_kong_bloom(
                    kind='wind-kong', hand=ctx.hand,
                    exposed_melds=ctx.exposedMelds, jokers=jokers,
                    visible_tiles=ctx.visibleTiles).guaranteed_kong_bloom:
                return {'kind': 'wind-kong'}
        # 普通胡短路：只有杠后全听这一确定性加番特例可先杠。
        if not ctx.skipDraw and rules.is_winning_hand(ctx.hand, ctx.exposedMelds):
            return {'kind': 'win'}
        built = build_request(ctx, rules, getattr(ctx, 'requestId', '') or '',
                              getattr(ctx, 'stateVersion', '') or '', 'turn')
        action = await self._decide(built, ctx)
        if action is None:
            return await super().request_turn(ctx)
        return action

    async def request_claim(self, ctx: ClaimContext) -> dict:
        ms = self.delays['claim']
        if ms:
            await asyncio.sleep(ms / 1000)
        if self.rules.code == 'lotus-legacy' and ctx.canGang:
            jokers = list(ctx.jokers or getattr(self.rules.round_state, 'jokers', []))
            if project_kong_bloom(
                    kind='discard-gang', hand=ctx.hand,
                    exposed_melds=ctx.exposedMelds, jokers=jokers, tile=ctx.tile,
                    visible_tiles=ctx.visibleTiles).guaranteed_kong_bloom:
                return {'kind': 'gang'}
        # 点炮胡引擎短路：除杠后全听特例外，canHu → win。
        if ctx.canHu:
            return {'kind': 'win'}
        chi_options = list(getattr(ctx, 'chiOptions', None) or getattr(ctx, 'chi_options', None) or [])
        if not ctx.canGang and not ctx.canPeng and not chi_options:
            return {'kind': 'pass'}
        built = build_request(ctx, self.rules, getattr(ctx, 'requestId', '') or '',
                              getattr(ctx, 'stateVersion', '') or '', 'claim')
        action = await self._decide(built, ctx)
        if action is None:
            return await super().request_claim(ctx)
        return action

    async def _decide(self, built: Optional[dict], ctx) -> Optional[dict]:
        """LLM 决定 → 候选动作；失败/非法 → 本次请求已验证的回退候选。"""
        if built is None or len(built['request']['candidates']) <= 1:
            return built['fallbackAction'] if built else None
        request = built['request']

        def notify_fallback():
            action = built.get('fallbackAction')
            if not action or self.on_fallback is None:
                return
            kind = action.get('kind', 'discard')
            priority = 'important' if kind in IMPORTANT_SPEECH_ACTIONS else \
                'chatter-turn' if self.config.style == '话痨' \
                and request.get('decision') == 'turn' and kind == 'discard' else 'normal'
            try:
                self.on_fallback(
                    self.seat, request.get('decision', ''), kind, priority)
            except Exception:
                pass
        # 房间预算：超出后直接执行本次已计算的候选回退（不阻塞游戏循环）
        if self.config.max_requests_per_room > 0 \
                and self.requests >= self.config.max_requests_per_room:
            notify_fallback()
            return built['fallbackAction']
        self.requests += 1
        ids = [candidate['id'] for candidate in request['candidates']]
        system, user = build_prompt(self.config.style, request)
        quick_policy = resolve_reasoning_policy(
            getattr(self.config, 'provider_type', ''), self.config.base_url, self.config.model,
            getattr(self.config, 'provider_id', ''))
        reasoning_policy = resolve_reasoning_policy(
            getattr(self.config, 'provider_type', ''), self.config.base_url, self.config.model,
            getattr(self.config, 'provider_id', ''), reasoning=True)
        always_thinking = quick_policy.mode in ('always-on', 'reasoning-only')
        # 百炼 Kimi K3 等没有可调强度，不能把普通请求误升为更短的深思请求。
        adjustable = quick_policy.mode != reasoning_policy.mode or \
            quick_policy.request_body != reasoning_policy.request_body
        supports_reasoning = (reasoning_policy.mode in ('explicit-on', 'always-on')
                              and adjustable
                              and not is_reasoning_suppressed(self.config, reasoning_policy))
        use_reasoning = supports_reasoning and self.reasoning.admit(
            request, self.seat, self.reasoning.config.min_remaining_budget_ms)
        reasoning_status_active = use_reasoning
        reasoning_progress_sequence = 0
        thinking_counted = False

        def count_thinking():
            nonlocal thinking_counted
            if thinking_counted:
                return
            thinking_counted = True
            self.stats['thinkingRequests'] = self.stats.get('thinkingRequests', 0) + 1

        def on_reasoning_progress():
            nonlocal reasoning_status_active, reasoning_progress_sequence
            count_thinking()
            reasoning_progress_sequence += 1
            reasoning_status_active = True
            if self.on_status is not None:
                try:
                    self.on_status(
                        self.seat, True,
                        safe_reasoning_status(reasoning_progress_sequence), False)
                except Exception:
                    pass

        self.stats['requests'] += 1
        if always_thinking:
            count_thinking()
        if use_reasoning:
            self.stats['reasoningRequests'] = self.stats.get('reasoningRequests', 0) + 1
            self.stats['enhancedReasoningRequests'] = \
                self.stats.get('enhancedReasoningRequests', 0) + 1
            count_thinking()
            if self.on_status is not None:
                try:
                    status_text = reasoning_status_speech(
                        self.config.style, self.reasoning_status_sequence)
                    self.reasoning_status_sequence += 1
                    self.on_status(self.seat, True, status_text, True)
                except Exception:
                    pass
        try:
            choice, message = await request_llm_decision(
                self.config, system, user, ids, reasoning=use_reasoning,
                deadline_ms=self.reasoning.config.deadline_ms if use_reasoning else None,
                on_reasoning_progress=on_reasoning_progress)
        except Exception:
            self.stats['fallbacks'] += 1
            notify_fallback()
            return built['fallbackAction']
        finally:
            if reasoning_status_active and self.on_status is not None:
                try:
                    self.on_status(self.seat, False, '', False)
                except Exception:
                    pass
        candidate = next((item for item in request['candidates'] if item['id'] == choice), None)
        if candidate is None:
            self.stats['fallbacks'] += 1
            notify_fallback()
            return built['fallbackAction']
        # §8.2 自校验：对照请求时刻的 ctx 复核（引擎执行层还会再复核一次）
        if not validate_action(ctx, candidate['action'], self.rules):
            self.stats['invalid'] += 1
            self.stats['fallbacks'] += 1
            notify_fallback()
            return built['fallbackAction']
        if inferior_classic_discard(request, candidate):
            self.stats['fallbacks'] += 1
            notify_fallback()
            return built['fallbackAction']
        self.stats['successes'] += 1
        # choice 决定真实动作；message 可作牌桌闲聊/烟雾弹，不要求与动作一致。
        # 缺失或含幕后词时才回退当前程序台词。
        speech = resolve_decision_speech(
            message, candidate['action'], self.config.style, self.stats['messages'],
            self._speech_facts(request['state'], candidate['action']))
        self.stats['messages'] += 1
        self.message_history.append(speech)
        if self.on_message is not None:
            try:
                action_kind = candidate['action']['kind']
                priority = 'important' if action_kind in IMPORTANT_SPEECH_ACTIONS else \
                    'chatter-turn' if self.config.style == '话痨' \
                    and request.get('decision') == 'turn' and action_kind == 'discard' else 'normal'
                if self._on_message_accepts_metadata:
                    self.on_message(
                        self.seat, speech, priority,
                        decision=request.get('decision'), action_kind=action_kind)
                else:
                    self.on_message(self.seat, speech, priority)
            except Exception:
                # 吐槽属于表现副作用；广播失败不能影响动作执行和对局推进。
                pass
        return self._map_action(candidate['action'])

    @staticmethod
    def _speech_facts(state: dict, action: dict) -> dict:
        snapshots = state.get('snapshots') or {}

        def meld_types(name: str) -> list[str]:
            return [meld.get('type', '') for meld in (snapshots.get(name) or {}).get('melds', [])]

        claim_tile = state.get('claimTile')
        claim_from = state.get('claimFrom')
        return {
            'isDealer': bool(state.get('isDealer')),
            'publicMeldTypes': {
                '上家': meld_types('upper'),
                '对家': meld_types('opposite'),
                '下家': meld_types('lower'),
            },
            'currentDiscard': {
                'from': claim_from, 'tile': claim_tile,
            } if claim_tile and claim_from else None,
            'discardedTile': state['hand'][action['handIndex']]
            if action.get('kind') == 'discard' else None,
        }

    def _map_action(self, action: dict) -> dict:
        kind = action['kind']
        if kind == 'win':
            return {'kind': 'win'}
        if kind == 'added-kong':
            return {'kind': 'added-kong', 'meldIndex': action['meldIndex']}
        if kind == 'concealed-kong':
            return {'kind': 'concealed-kong', 'tile': action['tile']}
        if kind == 'wind-kong':
            return {'kind': 'wind-kong'}
        if kind == 'discard':
            return {'kind': 'discard', 'handIndex': action['handIndex']}
        if kind == 'gang':
            return {'kind': 'gang'}
        if kind == 'peng':
            # §4.3：两步决策，不带 discardIndex
            return {'kind': 'peng'}
        if kind == 'chi':
            return {'kind': 'chi', 'optionIndex': action['optionIndex']}
        return {'kind': 'pass'}
