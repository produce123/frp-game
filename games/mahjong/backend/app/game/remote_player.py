"""远程玩家控制器 —— 把 HumanController 接到 WebSocket 通道

RemotePlayer 在 GameManager 视角中就是「人类玩家」：request_turn / request_claim /
request_rob_kong 通过 ConnectionManager 下发请求并 await 用户动作（asyncio.Future）。

防卡死策略（对应产品决策：超时代打 + 断线托管）：
- 超时：单回合 12s（可注入），asyncio.wait_for 超时 → AIPlayer 自动代打
- 断线：on_disconnect → 投递 _DISCONNECTED 哨兵 → 立即 AI 代打，不等超时
- 重连：set_connected(True) → 后续请求重新等待真人动作，控制权归还
- 过期动作：请求已结算/超时后再来的客户端动作一律拒绝（STALE_ACTION）

动作校验：按当前请求类型（turn/claim/rob_kong）白名单校验客户端「意图」，
非法 / 过期动作返回错误码，由 WS 层回传客户端。
"""

import asyncio
from typing import Optional

from loguru import logger

from app.game.player import AIPlayer, ClaimContext, RobKongContext, TurnContext
from app.rules.base import GameRuleSet
from app.rules.lianhua import get_default_rule_set

# on_disconnect 投递给 pending future 的哨兵：收到后走 AI 代打
_DISCONNECTED = object()


class RemotePlayer:
    """人类远程玩家控制器。"""

    def __init__(self, seat: int, conn, timeout: float = 12.0, ai_delays: Optional[dict] = None,
                 room_id: Optional[str] = None, rule_set: Optional[GameRuleSet] = None):
        self.seat = seat
        self.conn = conn          # ConnectionManager（按座位路由出站）
        self.timeout = timeout    # 单回合超时秒数（超时 AI 代打）
        self.room_id = room_id    # 房间号：超时/断线/动作拒绝日志带上下文
        # 断线/超时代打用 AI 的思考速度：真人联机房间注入 AI_DELAYS（人类节奏），测试保持即用即答
        self.rules = rule_set or get_default_rule_set()
        self._ai = AIPlayer(delays=ai_delays, rule_set=self.rules)
        self._pending: Optional[asyncio.Future] = None
        self._pending_kind: Optional[str] = None   # 'turn' | 'claim' | 'rob_kong'
        self._last_ctx = None     # 最近一次请求上下文（added-kong 需查 melds）
        self.connected = False

    # ── 连接状态 ─────────────────────────────────────────

    def set_connected(self, connected: bool) -> None:
        """WS 层在连接建立/断开时调用。断开即把 pending 请求改为 AI 代打。"""
        self.connected = connected
        if not connected:
            self._disconnect_pending()

    # ── GameManager 侧：发起请求并等待动作 ─────────────────

    async def request_turn(self, ctx: TurnContext) -> dict:
        self._last_ctx = ctx
        if not self.connected:
            return await self._ai.request_turn(ctx)
        await self.conn.send_to_seat(
            self.seat, {'kind': 'turn_request', 'ctx': ctx.model_dump(by_alias=True)})
        return await self._wait('turn', ctx)

    async def request_claim(self, ctx: ClaimContext) -> dict:
        self._last_ctx = ctx
        if not self.connected:
            return await self._ai.request_claim(ctx)
        await self.conn.send_to_seat(
            self.seat, {'kind': 'claim_request', 'ctx': ctx.model_dump(by_alias=True)})
        return await self._wait('claim', ctx)

    async def request_rob_kong(self, ctx: RobKongContext) -> str:
        self._last_ctx = ctx
        if not self.connected:
            return await self._ai.request_rob_kong(ctx)
        await self.conn.send_to_seat(
            self.seat, {'kind': 'rob_kong_request', 'ctx': ctx.model_dump(by_alias=True)})
        return await self._wait('rob_kong', ctx)

    async def _wait(self, kind: str, ctx):
        """挂起等待客户端动作；超时 / 断线 → AI 代打。"""
        future = asyncio.get_event_loop().create_future()
        self._pending = future
        self._pending_kind = kind
        try:
            result = await asyncio.wait_for(future, self.timeout)
            self._pending = None
            self._pending_kind = None
            if result is _DISCONNECTED:
                return await self._fallback(kind, ctx)
            return result
        except asyncio.TimeoutError:
            self._pending = None
            self._pending_kind = None
            logger.bind(room_id=self.room_id, seat=self.seat).warning(
                f"回合超时，AI 代打 (kind={kind})")
            return await self._fallback(kind, ctx)

    async def _fallback(self, kind: str, ctx):
        """超时 / 断线自动代打：复用 AIPlayer 的决策（含碰后无牌可打 → pass 的修复）。"""
        if kind == 'turn':
            return await self._ai.request_turn(ctx)
        if kind == 'claim':
            return await self._ai.request_claim(ctx)
        return await self._ai.request_rob_kong(ctx)

    # ── WS 层侧：收到客户端动作 ──────────────────────────

    def handle_action(self, message: dict) -> tuple[bool, str]:
        """投递客户端动作。返回 (是否受理, 错误码)。"""
        if self._pending is None:
            logger.bind(room_id=self.room_id, seat=self.seat).warning(
                f"动作被拒 code=STALE_ACTION type={message.get('type')}")
            return False, 'STALE_ACTION'
        action, err = self._validate(message)
        if action is None:
            logger.bind(room_id=self.room_id, seat=self.seat).warning(
                f"动作被拒 code={err} type={message.get('type')}")
            return False, err
        future = self._pending
        self._pending = None
        self._pending_kind = None
        if not future.done():
            future.set_result(action)
        return True, ''

    def _validate(self, message: dict) -> tuple[Optional[object], str]:
        """按当前请求类型校验并规整客户端动作。返回 (action, 错误码)。

        反作弊：以服务端权威上下文（_last_ctx，由 request_* 下发）为准校验
        「意图」合法性，不信任客户端传来的牌面：
        - 胡（turn/rob_kong）：用 is_winning_hand / can_rob_kong 校验当前手牌
        - 碰/杠（claim）：校验手牌中确实够该副露所需张数
        - 暗杠（turn）：校验手牌中确实有 4 张
        校验失败返回错误码且不消费 pending，玩家仍可提交合法动作。
        """
        kind = self._pending_kind
        mtype = message.get('type')
        ctx = self._last_ctx

        if kind == 'turn':
            # 碰/吃后未摸牌的窗口只能弃牌；庄家开局跳摸另按已摸牌处理。
            if ctx is not None and ctx.skipDraw and ctx.turnOrigin != 'opening' \
                    and mtype != 'discard':
                return None, 'INVALID_ACTION'
            if mtype == 'discard':
                hi = message.get('handIndex')
                hand = getattr(ctx, 'hand', None) if ctx is not None else None
                if not isinstance(hi, int) or isinstance(hi, bool) or not isinstance(hand, list) \
                        or not 0 <= hi < len(hand):
                    return None, 'INVALID_ACTION'
                return {'kind': 'discard', 'handIndex': hi}, ''
            if mtype == 'hu':
                # 自摸胡：手牌（含刚摸的牌）须已成形
                if ctx is not None and ctx.canHu \
                        and self.rules.is_winning_hand(ctx.hand, ctx.exposedMelds):
                    return {'kind': 'win'}, ''
                return None, 'INVALID_ACTION'
            if mtype == 'gang':
                gk = message.get('kind')
                if gk == 'concealed':
                    tile = message.get('tile')
                    if not tile or ctx is None or tile not in self.rules.concealed_kongs(ctx.hand):
                        return None, 'INVALID_ACTION'
                    return {'kind': 'concealed-kong', 'tile': tile}, ''
                if gk == 'wind':
                    if ctx is not None and getattr(ctx, 'canWindKong', False):
                        return {'kind': 'wind-kong'}, ''
                    return None, 'INVALID_ACTION'
                if gk == 'added':
                    tile = message.get('tile')
                    meld_index = self._find_peng_meld_index(tile)
                    if meld_index < 0:
                        return None, 'INVALID_ACTION'
                    return {'kind': 'added-kong', 'meldIndex': meld_index}, ''
                return None, 'INVALID_ACTION'
            return None, 'INVALID_ACTION'

        if kind == 'claim':
            if mtype == 'hu':
                if ctx is not None and getattr(ctx, 'canHu', False):
                    return {'kind': 'win'}, ''
                return None, 'INVALID_ACTION'
            if mtype == 'claim':
                a = message.get('action')
                if a == 'pass':
                    return {'kind': 'pass'}, ''
                if a == 'chi':
                    option = message.get('optionIndex')
                    if not isinstance(option, int) or ctx is None:
                        return None, 'INVALID_ACTION'
                    options = getattr(ctx, 'chiOptions', [])
                    if 0 <= option < len(options):
                        return {'kind': 'chi', 'optionIndex': option}, ''
                    return None, 'INVALID_ACTION'
                if a in ('peng', 'gang'):
                    # 以服务端权威手牌校验副露张数，防止客户端声明不存在的碰/杠
                    capabilities = (
                        self.rules.claim_capabilities(ctx.hand, ctx.tile) if ctx is not None else None
                    )
                    allowed = capabilities and (
                        capabilities.can_gang if a == 'gang' else capabilities.can_peng
                    )
                    if allowed:
                        return {'kind': a}, ''
                return None, 'INVALID_ACTION'
            if mtype == 'pass':
                return {'kind': 'pass'}, ''
            return None, 'INVALID_ACTION'

        if kind == 'rob_kong':
            if mtype == 'hu':
                # 抢杠胡：杠牌加入手牌后须成胡
                if ctx is not None and self.rules.can_rob_kong(
                    ctx.hand, ctx.tile, ctx.exposedMelds
                ):
                    return 'win', ''
                return None, 'INVALID_ACTION'
            if mtype == 'pass':
                return 'pass', ''
            return None, 'INVALID_ACTION'

        return None, 'INVALID_ACTION'

    def _find_peng_meld_index(self, tile) -> int:
        """补杠时由牌找碰副露索引（客户端只发牌，服务端定位副露）。"""
        ctx = self._last_ctx
        if ctx is None or not self.rules.can_added_kong(ctx.hand, ctx.melds, tile):
            return -1
        for i, meld in enumerate(ctx.melds):
            if meld.type == 'peng' and meld.tile == tile:
                return i
        return -1

    def _disconnect_pending(self) -> None:
        future = self._pending
        self._pending = None
        self._pending_kind = None
        if future is not None:
            logger.bind(room_id=self.room_id, seat=self.seat).info("断线，AI 代打接管")
            if not future.done():
                future.set_result(_DISCONNECTED)

    # ── PlayerController 其余协议方法 ────────────────────

    def set_ai_delays(self, delays: Optional[dict]) -> None:
        """设置断线/超时代打 AI 的思考速度。

        开局时由 RoomSession 统一按房间节奏注入（真人联机房间用 AI_DELAYS 人类节奏，
        测试路径置 None 保持即用即答）。放在开局而非 join 时注入，保证以「开局瞬间」
        的房间节奏为准（测试可能在 join 后再改 pace）。
        """
        self._ai = AIPlayer(delays=delays, rule_set=self.rules)

    def set_rule_set(self, rule_set: GameRuleSet) -> None:
        self.rules = rule_set
        self._ai.set_rule_set(rule_set)

    def on_discarded(self) -> None:
        pass

    def reset(self) -> None:
        self._disconnect_pending()
