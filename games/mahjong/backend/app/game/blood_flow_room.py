"""血流房间会话 —— 后端权威对局房间（M3）。

复用 RoomSession 的外部契约（REST 房间生命周期 + WS 重进），但驱动自己的
BloodFlowEngine：锁手/多响/抢杠/杠收付/牌墙耗尽结算。快照对齐前端
bloodFlowSeatView / network/protocol.ts 形状，前端 externalAuthority 直接消费。

本版不含观战、LLM 补位（M4）与对局落库；空座用本地规则策略代打。
"""

import asyncio
import secrets
import time
from typing import Optional

from loguru import logger

from app.core.blood_flow.config import BLOOD_FLOW_CONFIG, BLOOD_FLOW_PACE, BLOOD_FLOW_TIMING
from app.game.anime_characters import (DEFAULT_ANIME_CHARACTER_ID,
                                       resolve_anime_character_id)
from app.game.avatars import resolve_seat_avatar
from app.game.blood_flow_engine import (SEATS, BloodFlowEngine, next_seat,
                                        window_complete)
from app.game.manager import PLAYER_SEED
from app.game.room import (ROOM_LIFETIME, RoomError, _model_speech_metadata,
                           room_registry)
from app.llm.persona import avatar_url, default_nickname, display_name, provider_folder
from app.llm.speech_policy import LlmSpeechPolicy, compact_speech_text
from app.rules.blood_flow import BloodFlowRuleSet
from app.tts.service import get_tts_service
from app.ws.manager import ConnectionManager

# 供应商类型 → 本地 TTS 音色键（镜像前端 resolveLocalTtsVoiceKey：openai→gpt、
# 已知供应商用类型名、自定义按头像文件夹推断、其余策略默认）。
_TTS_FOLDERS = frozenset({'deepseek', 'qwen', 'kimi', 'doubao', 'minimax', 'glm', 'claude'})


def _voice_key(provider_type: str, folder: str) -> str:
    if provider_type == 'openai':
        return 'gpt'
    if provider_type and provider_type != 'custom':
        return provider_type
    if folder == 'gpt':
        return 'gpt'
    if folder in _TTS_FOLDERS:
        return folder
    return 'default'


def _make_rejoin_code() -> str:
    return f'{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}'


class _Controller:
    """占位控制器：api/rooms.py 只读 connected。"""

    def __init__(self):
        self.connected = False


class _Seat:
    __slots__ = ('seat', 'nickname', 'rejoin_code', 'player_id', 'character_id',
                 'controller', 'connected_at', 'ready', 'avatar')

    def __init__(self, seat: int, nickname: str, rejoin_code: str,
                 player_id: Optional[str] = None, character_id: str = 'deepseek'):
        self.seat = seat
        self.nickname = nickname
        self.rejoin_code = rejoin_code
        self.player_id = player_id
        self.character_id = character_id
        self.controller = _Controller()
        self.connected_at: Optional[float] = None
        self.ready = False
        self.avatar = ''


def _fallback_policy(engine: BloodFlowEngine, seat: int) -> dict:
    """兜底代打策略：锁手自动 + 见胡就胡 + 首张普通弃牌（EV 决策失败时使用）。"""
    window = engine.window
    options = window['options'][seat]
    win = next((a for a in options if a['kind'] == 'win'), None)
    if engine.seats[seat]['locked']:
        if win:
            return win
        # 胡后可能收到大明杠响应；只能从当前合法动作中回退，不能提交 index=-1 的弃牌。
        return next((a for a in options if a['kind'] in ('gang', 'concealed-kong', 'added-kong', 'wind-kong')),
                    next((a for a in options if a['kind'] == 'discard'), {'kind': 'pass'}))
    if win:
        return win
    discards = [a for a in options if a['kind'] == 'discard']
    if discards:
        ordinary = [a for a in discards
                    if engine.players[seat]['hand'][a['index']] not in set(engine.jokers)]
        return (ordinary or discards)[0]
    return next((a for a in options if a['kind'] == 'pass'), options[0])


def _bot_policy(room: 'BloodFlowRoomSession', engine: BloodFlowEngine, seat: int) -> dict:
    """空座代打：EV 策略翻译版（M4）；异常/空决策回退规则策略。"""
    try:
        from app.core.blood_flow.ai import decide_blood_flow_action_ev
        from app.core.blood_flow.config import BLOOD_FLOW_AI
        decision = decide_blood_flow_action_ev(room._seat_view(seat), BLOOD_FLOW_AI)
        if decision is not None and decision in engine.window['options'][seat]:
            return decision
    except Exception:
        logger.bind(room_id=room.room_id, seat=seat).warning('EV 代打异常，回退规则策略')
    return _fallback_policy(engine, seat)


class BloodFlowRoomSession:
    def __init__(self, room_id: str, mode: str = 'east', capacity: int = 4,
                 ruleset_id: str = 'lotus-blood-flow', storage=None,
                 pace: int = 0, llm_enabled: bool = False, llm_request_fn=None):
        self.room_id = room_id
        self.mode = mode
        self.capacity = capacity
        self.player_count = capacity
        self.ruleset_id = ruleset_id
        # 座位头像落库用（player_avatars）：与经典房间共用同一 player_id → 同一张头像。
        self.storage = storage
        self.table_theme = 'jade'
        # 节奏：经典房间注入的是经典节奏表（dict）→ 血流用自带节奏表；0 = 测试/无节奏。
        if isinstance(pace, dict):
            self.pace: dict[str, int] = dict(BLOOD_FLOW_PACE)
        else:
            self.pace = dict(BLOOD_FLOW_PACE) if pace else {}
        # 联机决策窗口对齐前端 remoteDecisionMs（含网络余量）。
        self.decision_ms = BLOOD_FLOW_TIMING['remoteDecisionMs']
        # 真人回合倒计时（墙钟毫秒；无真人待决策的窗口为 0 → 前端不显示读秒）。
        self._window_deadline_ms = 0
        # 开局动画：每局第一份快照带骰点，等在线真人回执 opening_done 再开打（兜底超时）。
        self.opening_timeout = 60.0
        self._round_opening: Optional[dict] = None
        self._opening_round: Optional[int] = None
        self._opening_confirmations: set[int] = set()
        # 托管座位（客户端 auto 消息）：由服务端代打，不计入真人待决策/屏障。
        self.auto_seats: set[int] = set()
        # 表现闸门截止时刻（monotonic）：演出停顿期间快照隐藏新窗口，对齐单机 transition。
        self._hold_window_until = 0.0
        # 局间过场：结算后等在线真人回执 continue 再开下一局（兜底超时）。
        # 正常流程由客户端 10s 倒计时自动回执；但血流结算面板被局末演出门控（最后一批
        # 胡牌/杠 cue + 语音闸门可达十余秒），倒计时从「面板可打开」才起算——兜底必须
        # 覆盖最坏演出尾巴 + 完整 10s，否则会在倒计时中途抢跑开局（经典 20s 锚定结算
        # 到达、其倒计时不被演出门控，故经典 20s 成立，血流不适用）。
        self.continue_timeout = 45.0
        self._continue_confirmations: set[int] = set()
        self.status = 'lobby'
        self.creator_seat: Optional[int] = None
        # 房间限时与经典房间同口径（app.game.room.ROOM_LIFETIME，默认 60 分钟）：
        # 非对局中到期回收；对局中不回收，等对局结束。
        self.lifetime = ROOM_LIFETIME
        self.llm_enabled = bool(llm_enabled)
        # LLM 席位：seat → LlmProviderConfig（baseUrl/apiKey/model/style/timeoutMs/...）。
        self.llm_seats: dict[int, dict] = {}
        # 房主显式点选模型的空位（预留）：真人不可占，开局按预留装配（与经典房间同契约）。
        # 座位范围与真人可入座一致（range(capacity)）。
        self.reserved_seats: dict[int, dict] = {}
        # 非真人座位身份（昵称/头像/二次元角色/音色）：开局按供应商推导，快照直接下发。
        self._seat_identity: dict[int, dict] = {}
        # 模型原话与语音（对齐经典房间）：llm_message 气泡 + llm_audio 服务端合成音频。
        self._llm_messages: list[dict] = []
        self._llm_message_seq = 0
        self._llm_speech_policy = LlmSpeechPolicy()
        self._tts_tasks: set[asyncio.Task] = set()
        self._tts_match_generation = 0
        self._tts_match_stats = {
            'requests': 0, 'hits': 0, 'misses': 0, 'successes': 0, 'failures': 0,
        }
        self.llm_request = llm_request_fn
        self.seats: list[Optional[_Seat]] = [None] * 4
        self.conn = ConnectionManager()
        self.engine: Optional[BloodFlowEngine] = None
        self.scores = [BLOOD_FLOW_CONFIG.initial_score] * 4
        self.round_index = -1
        self.match_started = False
        self.match_finished = False
        self.closed = False
        self.created_at = time.monotonic()
        self.deadline = self.created_at + ROOM_LIFETIME
        self._rejoin_attempts: dict[str, list[float]] = {}
        self._drive_task: Optional[asyncio.Task] = None
        self.round_result: Optional[dict] = None
        # 本场开局时刻（看门狗 ROOM_MATCH_MAX 判据，对齐经典 RoomSession）；未开局为 None。
        self.match_started_at: Optional[float] = None
        # 强制收尾幂等闸（见 force_finish）。
        self._forced_finishing = False

    # ── 生命周期（api/rooms.py 契约） ──

    def is_past_deadline(self, now: Optional[float] = None) -> bool:
        """是否已超过房间限时（默认 60 分钟，与经典房间同口径）。"""
        return (now if now is not None else time.monotonic()) >= self.deadline

    def is_expired(self, now: Optional[float] = None) -> bool:
        """房间是否可回收：对局中绝不回收（等对局结束）；非对局中超过限时即回收，
        与是否有人在座/在线无关（对齐经典 RoomSession.is_expired）。"""
        if self.status == 'playing':
            return False
        return self.is_past_deadline(now)

    def join_or_rejoin(self, nickname: str, rejoin_code: Optional[str] = None,
                       player_id: Optional[str] = None, character_id: str = 'deepseek',
                       avatar: str = ''):
        """与 RoomSession 同契约：返回 (seat, is_rejoin, state)；重进码恢复原座位。

        头像与经典房间同源（app.game.avatars.resolve_seat_avatar）：平台登录头像优先，
        否则复用该 player_id 已落库的头像，再否则取一次随机头像并落库；空串由前端回退
        座位默认头像。两个玩法共用同一 player_id，因此同一玩家在经典/血流房间是同一张脸。
        重进（重进码 / 同 player_id）与经典房间一致，只补落库/随机头像，不覆盖平台头像。
        """
        if rejoin_code:
            seat, state = self.resume_by_code(rejoin_code)
            state.nickname = nickname or state.nickname
            if not state.avatar:
                state.avatar = resolve_seat_avatar('', state.player_id, self.storage)
            return seat, True, state
        for state in self.seats:
            if state is not None and player_id is not None and state.player_id == player_id:
                if not state.avatar:
                    state.avatar = resolve_seat_avatar('', state.player_id, self.storage)
                return state.seat, True, state
        seat = next((s for s in range(self.capacity)
                     if self.seats[s] is None and s not in self.reserved_seats), None)
        if seat is None:
            # 空位都被房主预留给大模型 → 专用码（与经典房间同口径）。
            raise RoomError('SEATS_RESERVED'
                            if any(s in self.reserved_seats for s in range(self.capacity))
                            else 'ROOM_FULL')
        code = _make_rejoin_code()
        state = _Seat(seat, nickname, code, player_id, character_id)
        state.avatar = resolve_seat_avatar(avatar, player_id, self.storage)
        self.seats[seat] = state
        self.auto_seats.discard(seat)   # 新玩家接管空座：清掉上一任的托管标记
        if self.creator_seat is None:
            self.creator_seat = seat
        return seat, False, state

    def resume_by_code(self, rejoin_code: str):
        for state in self.seats:
            if state is not None and state.rejoin_code == rejoin_code:
                return state.seat, state
        raise RoomError('REJOIN_CODE_INVALID')

    def check_rejoin_rate(self, rejoin_code: str) -> bool:
        now = time.monotonic()
        attempts = [t for t in self._rejoin_attempts.get(rejoin_code, []) if now - t < 30]
        self._rejoin_attempts[rejoin_code] = attempts
        return len(attempts) < 5

    def reset_rejoin_rate(self, rejoin_code: str) -> None:
        self._rejoin_attempts.pop(rejoin_code, None)

    def release_seat(self, seat: int, rejoin_code: Optional[str] = None) -> None:
        state = self.seats[seat]
        if state is not None and (rejoin_code is None or state.rejoin_code == rejoin_code):
            self.seats[seat] = None
            self.auto_seats.discard(seat)
            self.conn.unregister(seat)
            if self.creator_seat == seat:
                self._transfer_creator()

    def _transfer_creator(self) -> None:
        """房主离房 → 房主顺延给剩余座位中编号最小者；无人在座则置空。

        与经典房间同口径（单向、不回收）：原房主重进原座位也不拿回房主身份。
        """
        self.creator_seat = next(
            (state.seat for state in self.seats if state is not None), None)

    def ready_seat(self, seat: int, ready: Optional[bool] = None) -> bool:
        state = self.seats[seat]
        if state is None:
            return False
        state.ready = ready if ready is not None else not state.ready
        return True

    def set_character(self, seat: int, character_id: str) -> str:
        state = self.seats[seat]
        if state is None:
            raise RoomError('SEAT_EMPTY')
        state.character_id = character_id
        return character_id

    def has_humans(self) -> bool:
        return any(state is not None for state in self.seats)

    @property
    def llm_available(self) -> bool:
        """服务端是否配置了大模型（与经典房间同口径：能力探测，不依赖开局）。

        此前血流房间把它当普通属性、只在开局 _resolve_llm_seats 里赋值，
        导致开局前 llmAvailable=False：房间面板不显示大模型选位、还误报「服务器未配置」。
        """
        from app.llm.config import llm_server_available
        return llm_server_available()

    @property
    def effective_llm_enabled(self) -> bool:
        """本局是否走服务端大模型：用户请求 && 注册表非空（与经典房间同口径）。"""
        return self.llm_enabled and self.llm_available

    def on_connect(self, seat: int) -> None:
        state = self.seats[seat]
        if state is None:
            return
        state.controller.connected = True
        state.connected_at = time.monotonic()

    def on_disconnect(self, seat: int) -> None:
        state = self.seats[seat]
        if state is not None:
            state.controller.connected = False

    def close(self) -> None:
        # 解散前先通知在位客户端（对齐经典 close 的 room_closed 广播）：
        # 前端据此清理本地会话回主大厅，而不是对着死房间无限重连。
        self.closed = True
        self.conn.broadcast({'kind': 'room_closed'})
        # 房间解散：取消在途 TTS，迟到音频不再广播。
        self._tts_match_generation += 1
        self._cancel_tts_tasks_nowait()
        # _drive 在「对局结束且已超限时」时也会回调本方法（当前任务即 _drive_task）：
        # 跳过自我取消，避免给已完成的整场驱动注入 CancelledError（对齐经典 room.py）。
        try:
            current = asyncio.current_task()
        except RuntimeError:
            current = None
        if self._drive_task is not None and not self._drive_task.done() \
                and current is not self._drive_task:
            self._drive_task.cancel()

    def _human_seat(self, seat: int) -> bool:
        state = self.seats[seat]
        return state is not None and state.controller.connected and seat not in self.auto_seats

    # ── 开局与驱动 ──

    async def start(self, llm_seats: Optional[list] = None, default_provider: Optional[str] = None) -> None:
        """开局（与 RoomSession 同契约）：所有已占座位 ready 后触发。

        finished 房间允许再开一场（对齐经典 room.py）：整场状态复位，旧一场已被
        新一场替换；托管（auto_seats）按座位保留。
        """
        if self._drive_task is not None and not self._drive_task.done():
            if self.status != 'finished':
                raise RoomError('ALREADY_STARTED')
            # 终局快照可能先于旧驱动任务退出；不能让两场共用同一个房间状态。
            try:
                await asyncio.wait_for(asyncio.shield(self._drive_task), timeout=30)
            except asyncio.TimeoutError as exc:
                raise RoomError('MATCH_FINISHING') from exc
            except asyncio.CancelledError:
                if not self._drive_task.cancelled():
                    raise
        if self.match_started and self.status != 'finished':
            raise RoomError('ALREADY_STARTED')
        if not all(state.ready for state in self.seats if state is not None):
            raise RoomError('NOT_ALL_READY')
        self._resolve_llm_seats(llm_seats or [], default_provider)
        # 新一场：取消上一场未完成的 TTS，重置模型原话历史与发言频率。
        await self._cancel_tts_tasks()
        self._tts_match_generation += 1
        self._llm_messages = []
        self._llm_message_seq = 0
        self._llm_speech_policy.reset()
        self._tts_match_stats = {
            'requests': 0, 'hits': 0, 'misses': 0, 'successes': 0, 'failures': 0,
        }
        self.match_started = True
        self.match_finished = False
        self.status = 'playing'
        self.round_index = -1
        self.round_result = None
        self.scores = [BLOOD_FLOW_CONFIG.initial_score] * 4
        self._continue_confirmations = set()
        self._opening_confirmations = set()
        self.engine = None
        self._hold_window_until = 0.0
        self._window_deadline_ms = 0
        # 新一场：硬上限计时重新起算，并清掉上一场的强制收尾闸（对齐经典 start）。
        self.match_started_at = time.monotonic()
        self._forced_finishing = False
        self._drive_task = asyncio.ensure_future(self._drive())

    # ── 强制收尾（看门狗）───────────────────────────────

    def force_finish(self, reason: str = 'stalled', *, cancel_task: bool = True) -> bool:
        """强制收尾当前场次，返回是否真的收尾了（幂等，非对局中返回 False）。

        与经典 RoomSession.force_finish 同契约：**纯同步、绝不 await**；
        cancel_task 只允许事件循环里的调用方传 True（Task.cancel 非线程安全）。
        血流没有 match_finished 消息，终局靠 bf_snapshot.matchFinished 下发。
        """
        if self._forced_finishing or self.status != 'playing':
            return False
        self._forced_finishing = True
        self.status = 'finished'
        self.match_finished = True
        if cancel_task and self._drive_task is not None and not self._drive_task.done():
            self._drive_task.cancel()
        # 对局已判死：在途 TTS 不再播（对齐经典）。
        self._tts_match_generation += 1
        self._cancel_tts_tasks_nowait()
        self.broadcast_snapshot()
        logger.bind(room_id=self.room_id).warning(
            f"血流对局被强制收尾 reason={reason}")
        return True

    async def finalize_forced(self) -> None:
        """血流房间不落库（无 match 记录）：善后只需按限时口径回收房间。"""
        if self.is_past_deadline():
            room_registry.remove(self.room_id)

    def set_reserved_seat(self, seat: int, provider_id: Optional[str],
                          style: Optional[str] = None) -> None:
        """房主为某个空位写 / 清大模型预留：provider_id 为空 → 取消预留（真人可占）。

        与经典房间同契约；座位范围取 range(capacity)（血流真人可入座即这一段）。
        """
        if not 0 <= seat < self.capacity:
            raise RoomError('INVALID_SEAT')
        if self.seats[seat] is not None:
            raise RoomError('SEAT_OCCUPIED')
        if provider_id:
            self.reserved_seats[seat] = {'providerId': provider_id, 'style': style or ''}
        else:
            self.reserved_seats.pop(seat, None)

    def _resolve_llm_seats(self, llm_seats: list, default_provider: Optional[str]) -> None:
        """服务端供应商解析：显式席位 providerId 优先，其余空位用默认提供商。

        与经典房间同口径（room.py 的 _seat_provider_id）：房间开了大模型时，
        未逐位点选的空位也要用服务端默认提供商补位——此前只认显式 llmSeats，
        UI 里选「自动选择」就一个 LLM 席位都没有。
        """
        from app.llm.config import default_provider_id, load_llm_providers
        # 与经典房间同口径：只有本局真的启用大模型（房间请求 + 服务端有能力）才注册席位。
        providers = load_llm_providers() if self.effective_llm_enabled else {}
        self.llm_seats = {}
        self._seat_identity = {}
        if not providers:
            # 未启用大模型：全部空位仍是本地 AI 补位，身份照样要按 PLAYER_SEED 下发。
            for seat in range(self.capacity):
                if self.seats[seat] is None:
                    seed = PLAYER_SEED[seat]
                    self._seat_identity[seat] = {
                        'name': seed['name'], 'avatar': seed['avatar'],
                        'characterId': DEFAULT_ANIME_CHARACTER_ID,
                    }
            return
        fallback_id = default_provider or default_provider_id()
        explicit = {entry.get('seat'): entry for entry in llm_seats if isinstance(entry.get('seat'), int)}
        # 房间级预留兜底：开局请求没带（房主换了客户端/字段丢失）也按预留装配。
        for seat, reserved in self.reserved_seats.items():
            explicit.setdefault(seat, reserved)
        for seat in range(self.capacity):
            if self.seats[seat] is not None:
                continue   # 真人座位不派大模型
            entry = explicit.get(seat) or {}
            provider_id = (entry.get('providerId') or '').strip().lower() or fallback_id
            provider = providers.get(provider_id)
            if provider is None:
                # 空位由本地规则 AI 补位：身份用 PLAYER_SEED（对齐经典房间 _seeds），
                # 不再下发引擎占位名「玩家N」与空头像。
                seed = PLAYER_SEED[seat]
                self._seat_identity[seat] = {
                    'name': seed['name'], 'avatar': seed['avatar'],
                    'characterId': DEFAULT_ANIME_CHARACTER_ID,
                }
                continue
            config = provider.to_config((entry.get('style') or '').strip())
            self.llm_seats[seat] = config
            # 座位身份（昵称/头像/二次元角色/音色）由服务端供应商推导，与经典房间 _seeds 同口径：
            # 前端只消费快照，不再用引擎占位名与座位默认头像，也不再按本机单机 LLM 设置选音色。
            folder = provider_folder(provider.base_url, provider.avatar_folder,
                                     provider.provider_id, provider.model, provider.provider_type)
            nickname = provider.nickname or default_nickname(
                provider.base_url, provider_id=provider.provider_id)
            self._seat_identity[seat] = {
                'name': display_name(nickname, config.style),
                'avatar': avatar_url(provider.base_url, config.style, folder, provider.provider_id),
                'characterId': resolve_anime_character_id(
                    provider_id=provider.provider_type, avatar_folder=folder),
                'style': config.style,
                'voiceKey': _voice_key(provider.provider_type, folder),
            }

    async def _drive(self) -> None:
        total = BLOOD_FLOW_CONFIG.rounds[self.mode]
        try:
            for round_index in range(total):
                self.round_index = round_index
                rules = BloodFlowRuleSet()
                engine = BloodFlowEngine(
                    authority_epoch=f'bf-{self.room_id}', round_id=f'round-{round_index}',
                    rules=rules, dealer=round_index % 4, scores=self.scores)
                self.engine = engine
                self.round_result = None
                # 开局动画：首份快照携带骰点，随后清空（后续快照不带，避免重复触发动画）。
                self._round_opening = {
                    'firstDice': list(engine.dice or [1, 1]),
                    'secondDice': list(engine.second_dice or [1, 1]),
                }
                self._opening_round = round_index
                self._opening_confirmations = set()
                self._continue_confirmations = set()
                self.broadcast_snapshot()
                self._round_opening = None
                await self._wait_for_openings()
                await self._play_round(engine)
                self.scores = list(engine.result['endingScores'])
                self.round_result = engine.result
                # 结算快照：引擎仍在位，view 带 public.roundResult（前端据此弹结算面板）。
                self.broadcast_snapshot()
                if round_index + 1 < total:
                    await self._wait_for_continues()
            self.match_finished = True
            self.status = 'finished'
            # 准备态保留（2026-09-10 用户决定：一场结束后各座位仍是「已准备」，房主可直接
            # 再开一场，不必全员重新点准备）。
            # 整场结束仍保留末局引擎：最终快照要带结算视图（否则 view 为空、前端整包丢弃）。
            self.broadcast_snapshot()
            # 对局结束时已超过房间限时 → 自动释放房间（close 内会广播 room_closed），
            # 与经典 RoomSession._drive 同口径。
            if self.is_past_deadline():
                room_registry.remove(self.room_id)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - 防御性兜底
            logger.bind(room_id=self.room_id).exception(f'血流房间驱动异常 {exc}')
            self.conn.broadcast({'kind': 'error', 'code': 'INTERNAL_ERROR'})

    async def _llm_action(self, engine: BloodFlowEngine, seat: int) -> Optional[dict]:
        """LLM 席位决策：候选 + 提示词 → 真实模型；失败/超时/非法选择返回 None（调用方回退 EV）。"""
        if self.llm_request is None:
            from app.llm.client import request_llm_decision
            self.llm_request = request_llm_decision
        cfg = self.llm_seats[seat]
        try:
            from app.core.blood_flow.ai import blood_flow_llm_safeguard, decide_blood_flow_action_ev
            from app.core.blood_flow.config import BLOOD_FLOW_LLM_AI
            from app.llm.blood_flow_candidates import (build_blood_flow_candidates,
                                                       build_blood_flow_prompt, ev_features_for)
            view = self._seat_view(seat)
            safeguarded = blood_flow_llm_safeguard(view, BLOOD_FLOW_LLM_AI)
            if safeguarded is not None:
                return safeguarded['action']
            request_id = f'llm/{self.room_id}/{engine.round_id}/{engine.window["id"]}/{seat}'
            suggestion = decide_blood_flow_action_ev(view, BLOOD_FLOW_LLM_AI)
            built = build_blood_flow_candidates(
                view, request_id, suggestion=suggestion,
                ev_by_key=ev_features_for(view, BLOOD_FLOW_LLM_AI), config=BLOOD_FLOW_LLM_AI)
            candidate_ids = [c['id'] for c in built['candidates']]
            if not candidate_ids:
                return None
            system, user = build_blood_flow_prompt(cfg.style, view, built, BLOOD_FLOW_LLM_AI)
            # 预算 = 决策窗口 − 安全余量 − 思考停顿：aiThink 前置后总耗时仍不越过 deadline。
            timeout_ms = max(2_000, min(int(cfg.timeout_s * 1000),
                                        self.decision_ms - 500 - self.pace.get('aiThink', 0)))
            choice, message = await asyncio.wait_for(
                self.llm_request(cfg, system, user, candidate_ids, False),
                timeout=timeout_ms / 1000)
            match = next((c for c in built['candidates'] if c['id'] == choice), None)
            action = match['action'] if match is not None else None
        except Exception as exc:  # noqa: BLE001 - 任何失败都回退 EV，不阻塞对局
            logger.bind(room_id=self.room_id, seat=seat).warning(f'LLM 决策失败回退 EV：{exc}')
            # 失败/超时只发问号气泡（对齐经典 _on_llm_fallback），不创建 TTS。
            self._on_llm_message(seat, '？')
            return None
        if action is not None and message:
            # 模型原话随决策即时下发：气泡 llm_message + 服务端 TTS llm_audio。
            self._on_llm_message(seat, message, action.get('kind'))
        return action

    def _on_llm_message(self, seat: int, text: str, action_kind: Optional[str] = None) -> None:
        """LLM 座位模型原话：先广播气泡，再服务端合成音频（对齐经典房间口径）。

        文本经 compact_speech_text 归一 + 发言频率过滤；TTS 不可用/合成失败只少音频，
        气泡照常下发。联机血流此前丢弃模型回复、由客户端拼模板台词，这里改为原话下发。
        """
        if not 0 <= seat < self.player_count or seat not in self.llm_seats:
            return
        text = compact_speech_text(text)
        if not text:
            return
        config = self.llm_seats[seat]
        if not self._llm_speech_policy.admit(seat, config.style, 'normal'):
            return
        self._llm_message_seq += 1
        purpose, public_action_kind = _model_speech_metadata(action_kind)
        entry = {
            'id': self._llm_message_seq, 'seat': seat, 'text': text, 'priority': 'normal',
            'purpose': purpose, 'speechSource': 'model-message',
        }
        if public_action_kind:
            entry['actionKind'] = public_action_kind
        self._llm_messages.append(entry)
        self.conn.broadcast({'kind': 'llm_message', **entry})
        service = get_tts_service()
        if not service.available:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return   # 无事件循环（同步单测）：只保留气泡
        self._tts_match_stats['requests'] += 1
        task = loop.create_task(self._synthesize_llm_audio(
            self._tts_match_generation, entry['id'], seat, text, config.style,
            config.provider_id, purpose, public_action_kind))
        self._tts_tasks.add(task)
        task.add_done_callback(self._tts_tasks.discard)

    async def _synthesize_llm_audio(self, generation: int, message_id: int, seat: int,
                                    text: str, style: str, provider_id: str,
                                    purpose: str, action_kind: Optional[str] = None) -> None:
        """服务端 TTS：合成成功后广播 llm_audio（音频 URL 由 /api/local-tts/audio 提供）。"""
        try:
            audio = await get_tts_service().ensure_audio(text, style, provider_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            audio = None
        if generation != self._tts_match_generation:
            return   # 已换场/房间关闭：丢弃迟到音频
        if audio is None:
            self._tts_match_stats['failures'] += 1
            return
        self._tts_match_stats['successes'] += 1
        self._tts_match_stats['hits' if audio.cached else 'misses'] += 1
        message = {
            'kind': 'llm_audio', 'messageId': message_id, 'seat': seat,
            'audioUrl': audio.audio_url, 'cached': audio.cached,
            'priority': 'normal', 'purpose': purpose, 'speechSource': 'model-message',
        }
        if action_kind:
            message['actionKind'] = action_kind
        self.conn.broadcast(message)

    async def _cancel_tts_tasks(self) -> None:
        tasks = list(self._tts_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tts_tasks.clear()

    def _cancel_tts_tasks_nowait(self) -> None:
        for task in list(self._tts_tasks):
            task.cancel()
        self._tts_tasks.clear()

    async def _decide_bots(self, engine: BloodFlowEngine) -> None:
        """非真人席位决策：统一 aiThink 停顿后，LLM 席位走模型（并行），其余走 EV；提交前重验窗口。"""
        window = engine.window
        if not window:
            return
        pending = [s for s in SEATS if window['options'][s] and window['decisions'][s] is None
                   and not self._human_seat(s)]
        if not pending:
            return

        async def resolve(seat: int) -> None:
            # 机器人统一思考停顿：对齐单机 schedule 的 paceMs ?? 650——出牌/响应/杠后
            # 补摸全部同档，且 LLM 座位也先等再发请求（单机 actBot 同样先等 650ms 再 decide）。
            await self._pace('aiThink')
            action: Optional[dict] = None
            if seat in self.llm_seats:
                action = await self._llm_action(engine, seat)
            if action is None:
                action = _bot_policy(self, engine, seat)
            if action is not None and engine.window and engine.window['id'] == window['id'] \
                    and engine.window['decisions'][seat] is None:
                engine.submit(engine.command(seat, action))

        await asyncio.gather(*(resolve(s) for s in pending))

    async def _pace(self, key: str) -> None:
        """节奏停顿（毫秒）；pace 为 0（测试）时直接返回。"""
        if not self.pace:
            return
        delay = self.pace.get(key, 0)
        if delay:
            await asyncio.sleep(delay / 1000)

    def _win_pause_ms(self, batch: dict) -> int:
        """胡牌表现时长：对齐前端 bloodFlowWinTiming(tier).duration + 多响引言 + 交接余量。"""
        tier = 0
        for record in batch['winners']:
            weights = [item.weight for item in record['score'].items] or [1]
            weight = max(weights)
            tier = max(tier, 3 if weight >= 16 else 2 if weight >= 8 else 1 if weight >= 4 else 0)
        if tier >= 2:
            base = self.pace.get('winEffectTop' if tier == 3 else 'winEffectLarge', 2600)
            duration = base - self.pace.get('winEffectDeduct', 620) + self.pace.get('winEffectTail', 1200)
        else:
            duration = self.pace.get('winEffectBase', 1815) + self.pace.get('winEffectTail', 1200)
        # 单机引擎只对「点炮多响」加 1500 引言；抢杠多响无额外停顿（以单机为准，
        # 不移植经典 betweenRobKongs 的逐家读感）。
        multi = self.pace.get('multiWinIntro', 0) \
            if batch['source']['kind'] == 'discard' and len(batch['winners']) > 1 else 0
        return duration + multi + self.pace.get('winHandoffMargin', 0)

    def _step_delay_ms(self, engine: BloodFlowEngine, prev_win_count: int,
                       prev_discard_count: int, prev_action_count: int, drew: bool = False) -> int:
        """新窗口开放前的停顿合计（对齐单机 engine.after(...) 的串联节奏），毫秒。

        单机的节奏是「串联」的，例如弃牌 → afterDiscardToNextTurn → 摸牌 →
        afterDraw → 出牌窗口；胡牌 → 胡牌演出 → 摸牌 → afterDraw → 出牌窗口。
        所以这里把「刚发生动作的停顿」与「刚摸牌的停顿」相加，而不是二选一。
        """
        if not self.pace:
            return 0
        window = engine.window
        delay = 0
        wins = [e['batch'] for e in engine.ledger if e['kind'] == 'win']
        if len(wins) > prev_win_count:
            delay += self._win_pause_ms(wins[-1])
        # 补杠窗口刚打开（尚未裁决）：抢杠前停顿。
        elif window is not None and window['source']['kind'] == 'added-kong' \
                and len(engine.actions) == prev_action_count:
            delay += self.pace.get('beforeRobKong', 0)
        elif len(engine.actions) > prev_action_count:
            # 单机 engine.claimMeld/performKong 不分真人与 AI：碰/吃 650、明杠 550、
            # 暗杠/补杠/风杠 600（不移植经典的真人 350 缩短）。
            latest = engine.actions[-1]
            if latest['type'] == 'discard-gang':
                delay += self.pace.get('afterClaimGang', 0)
            elif latest['type'] in ('concealed-gang', 'added-gang', 'wind-kong'):
                delay += self.pace.get('afterKongSettle', 0)
            elif latest['type'] in ('peng', 'chi'):
                delay += self.pace.get('afterClaimPeng', 0)
        elif len(engine.discard_actions) > prev_discard_count:
            delay += self.pace.get('afterDiscardToNextTurn', 0)
        # 摸牌后的停顿（单机 engine.after('draw', PACE_MS.afterDraw) → openTurn）：
        # 出牌窗口前给「摸牌」留演出时间。drew 由牌墙是否变短判定（含杠后补摸），
        # 开局首回合与吃/碰后的回合都不是摸牌，因此不叠加。
        if drew and window is not None and window['kind'] == 'turn':
            delay += self.pace.get('afterDraw', 0)
        return delay

    def _human_pending(self, window: Optional[dict]) -> bool:
        return bool(window) and any(window['options'][s] and window['decisions'][s] is None
                                    and self._human_seat(s) for s in SEATS)

    async def _play_round(self, engine: BloodFlowEngine) -> None:
        # 节奏对比基线：跨迭代持久，只在节奏评估点刷新。状态推进并不都发生在本循环内——
        # 真人动作在 WS 处理协程提交、超时兜底在 deadline 判定后裁决；若按迭代开头取基线
        # 会漏掉这些推进（真人自摸/吃胡/抢杠胡就没有停顿，胡牌动画未结束下一家已摸打）。
        paced_wins = sum(1 for e in engine.ledger if e['kind'] == 'win')
        paced_discards = len(engine.discard_actions)
        paced_actions = len(engine.actions)
        paced_wall = len(engine.wall)
        paced_window = engine.window['id'] if engine.window else None
        while not engine.result and not self.closed:
            deadline = time.monotonic() + self.decision_ms / 1000
            last_broadcast: Optional[str] = None
            while not engine.result and not self.closed:
                window = engine.window
                if window is None or window_complete(window):
                    break
                if window['id'] != last_broadcast:
                    if window['id'] != paced_window:
                        # 牌墙变短 = 本轮真的摸了牌（含杠后补摸）→ 叠加 afterDraw 停顿。
                        drew = len(engine.wall) < paced_wall
                        delay_ms = self._step_delay_ms(engine, paced_wins, paced_discards,
                                                       paced_actions, drew)
                        paced_wins = sum(1 for e in engine.ledger if e['kind'] == 'win')
                        paced_discards = len(engine.discard_actions)
                        paced_actions = len(engine.actions)
                        paced_wall = len(engine.wall)
                        paced_window = window['id']
                        if delay_ms:
                            # 表现闸门：先广播动作/胡牌流水（新窗口对客户端隐藏），停顿结束再开放窗口。
                            # 对齐单机 transition：演出期间下一家不能操作，读秒也还没开始。
                            self._hold_window_until = time.monotonic() + delay_ms / 1000
                            self.broadcast_snapshot()
                            await asyncio.sleep(delay_ms / 1000)
                            self._hold_window_until = 0.0
                    # 真人待决策的窗口：从「窗口真正出现」起重新计时，避免机器人耗时吃掉真人时间。
                    if self._human_pending(window):
                        deadline = time.monotonic() + self.decision_ms / 1000
                        self._window_deadline_ms = int(time.time() * 1000) + self.decision_ms
                    # 血流不设服务端公告（单机也没有；抢杠胡公告是经典玩法专属，2026-09-09 用户确认移除）。
                    self.broadcast_snapshot()
                    last_broadcast = window['id']
                # 机器人在新窗口广播之后再决策（逐席重读窗口：提交可能解决旧窗口并开新窗口）：
                # 演出停顿期间机器人不抢跑，对齐单机「窗口开放 → schedule(650ms) → actBot」的顺序。
                await self._decide_bots(engine)
                if engine.result is not None or engine.window is None \
                        or engine.window['id'] != last_broadcast:
                    continue   # 裁决已产生新窗口/局末结果：回到循环头做节奏评估与广播
                if time.monotonic() >= deadline:
                    engine.expire()
                    last_broadcast = None   # expire 裁决同样要过节奏评估，不能 break 绕过停顿
                    continue
                await asyncio.sleep(0.05)
            self._window_deadline_ms = 0
            self.broadcast_snapshot()

    # ── 客户端消息 ──

    async def _wait_for_openings(self) -> None:
        """开局就绪屏障：等在线真人回执 opening_done 再开打，兜底超时防卡死。"""
        humans = [s for s in range(self.capacity)
                  if self.seats[s] is not None and self.seats[s].controller.connected
                  and s not in self.auto_seats]
        if not humans:
            return
        deadline = time.monotonic() + self.opening_timeout
        while not self.closed:
            pending = [s for s in humans if s not in self._opening_confirmations
                       and self.seats[s] is not None and self.seats[s].controller.connected
                       and s not in self.auto_seats]
            if not pending:
                return
            if time.monotonic() >= deadline:
                logger.bind(room_id=self.room_id).warning(
                    f'开局动画等待超时，直接开打 pending={pending}')
                return
            await asyncio.sleep(0.05)

    def _confirm_opening(self, seat: int, round_: Optional[int]) -> tuple[bool, str]:
        """客户端「opening_done」：标记本局开局动画完成（局号 1-based）。"""
        if self._opening_round is None:
            return True, ''
        if round_ is not None and round_ != self._opening_round + 1:
            return True, ''  # 过期回执直接忽略（不报错，避免客户端噪声）
        self._opening_confirmations.add(seat)
        return True, ''

    async def _wait_for_continues(self) -> None:
        """局间过场屏障：等在线真人确认「下一局」再开新局，兜底超时防卡死。"""
        humans = [s for s in range(self.capacity)
                  if self.seats[s] is not None and self.seats[s].controller.connected
                  and s not in self.auto_seats]
        if not humans:
            return
        deadline = time.monotonic() + self.continue_timeout
        while not self.closed:
            pending = [s for s in humans if s not in self._continue_confirmations
                       and self.seats[s] is not None and self.seats[s].controller.connected
                       and s not in self.auto_seats]
            if not pending:
                return
            if time.monotonic() >= deadline:
                logger.bind(room_id=self.room_id).warning(
                    f'局间等待超时，直接开下一局 pending={pending}')
                return
            await asyncio.sleep(0.05)

    def _confirm_continue(self, seat: int, round_: Optional[int]) -> tuple[bool, str]:
        """客户端「continue」：确认进入下一局。

        按「当前局号」接纳（不依赖屏障是否已建立）：结算快照会广播多次，
        客户端可能早于屏障建立就回执，去重后不会重发。
        """
        if round_ is not None and round_ != self.round_index + 1:
            return True, ''
        if seat in self._continue_confirmations:
            return True, ''
        self._continue_confirmations.add(seat)
        # 广播就绪计数：所有客户端的「已准备，等待其他玩家（x/y）」随回执实时更新
        # （对齐经典联机结算确认的可见反馈；此前回执不广播，等待方看不到进度）。
        if self.round_result is not None:
            self.broadcast_snapshot()
        return True, ''

    def handle_client_message(self, seat: int, message: dict) -> tuple[bool, str]:
        # 心跳：前端 roomSocket 发的是 {'type': 'ping'}（经典房间同款），不是 kind。
        if message.get('type') == 'ping' or message.get('kind') == 'ping':
            # 心跳回应：客户端据此测 RTT → 信号质量（与经典房间同协议）。
            self.conn.send_to_seat_nowait(seat, {'kind': 'pong'})
            return True, ''
        if message.get('kind') == 'auto':
            enabled = message.get('enabled')
            if not isinstance(enabled, bool):
                return False, 'INVALID_AUTO'
            if self.seats[seat] is None:
                return False, 'NOT_HUMAN_SEAT'
            if enabled:
                self.auto_seats.add(seat)
            else:
                self.auto_seats.discard(seat)
            self.broadcast_snapshot()
            return True, ''
        if message.get('kind') == 'opening_done':
            return self._confirm_opening(seat, message.get('round'))
        if message.get('kind') == 'continue':
            return self._confirm_continue(seat, message.get('round'))
        if message.get('kind') != 'action':
            return False, 'INVALID_MESSAGE'
        engine = self.engine
        if engine is None or engine.window is None:
            return False, 'STALE_ACTION'
        action = message.get('action')
        if not isinstance(action, dict) or message.get('windowId') != engine.window['id'] \
                or message.get('stateVersion') != engine.window['version']:
            return False, 'STALE_ACTION'
        if engine.window['decisions'][seat] is not None \
                or not any(a == action for a in engine.window['options'][seat]):
            return False, 'INVALID_ACTION'
        window_id = engine.window['id']
        if not engine.submit(engine.command(seat, action)):
            return False, 'INVALID_ACTION'
        # 窗口未推进（多席响应窗只登记了本席决策）：立即广播刷新按钮与等待计数。
        # 窗口已推进（引擎同步裁决了胡/碰/杠并开出新窗口）：不在这里广播——交给驱动循环
        # 按节奏基线先做表现停顿与闸门；否则新窗口与刚摸的牌会在胡牌动画结束前就暴露
        # （真人自摸/吃胡/抢杠胡「动画未结束就轮到下家摸打」的根因）。
        if engine.window is not None and engine.window['id'] == window_id:
            self.broadcast_snapshot()
        return True, ''

    # ── 快照（对齐前端 bloodFlowSeatView） ──

    def _public_score(self, score) -> dict:
        return {
            'items': [{'id': p.id, 'label': p.label, 'weight': p.weight} for p in score.items],
            'excluded': [{'id': e.id, 'includedBy': e.included_by} for e in score.excluded],
            'hardWin': score.hard_win, 'source': score.source, 'opening': score.opening,
            'patternMultiplier': score.pattern_multiplier, 'eventMultiplier': score.event_multiplier,
            'kongBonus': score.kong_bonus,
            'openingApplied': score.opening_applied, 'uncappedMultiplier': score.uncapped_multiplier,
            'finalMultiplier': score.final_multiplier, 'capped': score.capped,
            'paymentPerPayer': score.payment_per_payer,
        }

    def _serializable_public(self, public: dict) -> dict:
        """public 快照深转换：批次与局末账本里的 PublicWinScore 转 JSON 字典。"""
        batches = []
        for batch in public.get('batches', []):
            clean = dict(batch)
            clean['winners'] = [{**dict(w), 'score': self._public_score(w['score'])}
                                for w in batch['winners']]
            batches.append(clean)
        result = public.get('roundResult')
        clean_result = None
        if result:
            clean_result = dict(result)
            ledger = []
            for entry in result['ledger']:
                if entry['kind'] == 'win':
                    clean_entry = dict(entry)
                    clean_batch = dict(entry['batch'])
                    clean_batch['winners'] = [
                        {**dict(w), 'score': self._public_score(w['score'])}
                        for w in entry['batch']['winners']]
                    clean_entry['batch'] = clean_batch
                    ledger.append(clean_entry)
                else:
                    ledger.append(dict(entry))
            clean_result['ledger'] = ledger
        return {
            'ruleVersion': public['ruleVersion'], 'roundId': public['roundId'],
            'status': public['status'], 'seats': public['seats'],
            'batches': batches, 'roundResult': clean_result,
        }

    def _seat_view(self, seat: int) -> dict:
        engine = self.engine
        if engine is None:
            return {}
        # 表现闸门：演出停顿期间把「新开的窗口」和「刚摸的那张牌」一起藏起来。
        # 引擎在裁决胡牌/碰杠时就立刻摸了下一家的牌，若不藏，客户端在胡牌演出期间
        # 就看到下一家手牌 +1 —— 单机是演出结束才摸牌（engine.after('win', ...) → draw）。
        holding = time.monotonic() < self._hold_window_until
        hidden_draw = holding and any(p['drawnTileIndex'] >= 0 for p in engine.players)
        players = []
        for index, p in enumerate(engine.players):
            # 座位元数据来自房间：真人用座位身份，空位用开局推导的供应商/AI 身份
            # （昵称/头像/二次元角色/音色），不再下发引擎占位名与硬编码默认角色。
            state = self.seats[index]
            identity = self._seat_identity.get(index) or {}
            is_llm = index in self.llm_seats
            hide_drawn = hidden_draw and p['drawnTileIndex'] >= 0
            hand = list(p['hand']) if (index == seat or engine.result) else []
            if hide_drawn and index == seat:
                hand = hand[:-1]
            players.append({
                'name': state.nickname if state is not None else identity.get('name', p['name']),
                'avatar': state.avatar if state is not None else identity.get('avatar', ''),
                'characterId': state.character_id if state is not None
                else identity.get('characterId', DEFAULT_ANIME_CHARACTER_ID),
                'playerKind': 'human' if state is not None else ('llm' if is_llm else 'bot'),
                'isLlm': is_llm,
                'score': p['score'], 'seat': p['seat'],
                'hand': hand,
                'concealedTileCount': len(p['hand']) - (1 if hide_drawn else 0),
                'discards': list(p['discards']),
                'melds': [{'type': m['type'], 'tile': m['tile'], 'tiles': m['tiles'],
                           **({'from': m['from']} if m.get('from') is not None else {}),
                           **({'windKong': True} if m.get('windKong') else {}),
                           **({'added': True} if m.get('added') else {})} for m in p['melds']],
                'redCount': p['redCount'], 'drawnTileIndex': -1 if hide_drawn else p['drawnTileIndex'],
                # LLM 席位的音色/策略：客户端按它调用本机 TTS（不再读本机单机 LLM 设置）。
                **({'style': identity['style'], 'voiceKey': identity['voiceKey']}
                   if state is None and identity.get('voiceKey') else {}),
            })
        window = engine.window
        # 闸门期间窗口对客户端隐藏：不开放操作、不起读秒。
        if holding:
            window = None
        view = {
            'authorityEpoch': engine.authority_epoch, 'roundId': engine.round_id,
            'version': engine.version, 'seat': seat,
            'players': players, 'currentPlayer': engine.current_player,
            'wallCount': len(engine.wall) + (1 if hidden_draw else 0),
            'headDrawn': engine.head_drawn - (1 if hidden_draw else 0),
            'flipTile': engine.flip_tiles[0], 'jokers': list(engine.jokers),
            'flipStack': engine.flip_stack, 'flipSeat': engine.flip_seat,
            'wallBreakIndex': engine.wall_break_index,
            'window': None if window is None else {
                'id': window['id'], 'version': window['version'], 'kind': window['kind'],
                # 真人待决策的窗口下发墙钟截止时间（前端读秒）；否则 0（JSON 不接受 Infinity）。
                'deadlineAt': self._window_deadline_ms if self._human_pending(window) else 0,
                'opensAt': window['opensAt'],
                'source': dict(window['source']),
            },
            'ownActions': [] if window is None or window['decisions'][seat] is not None
            else [dict(a) for a in window['options'][seat]],
            'ownScore': self._public_score(engine.evaluation[seat].score)
            if seat in engine.evaluation and window is not None and window['decisions'][seat] is None else None,
            'waitingSeats': [s for s in SEATS if window is not None and window['options'][s]
                             and window['decisions'][s] is None],
            'public': self._serializable_public(engine.public_state()),
            # 动作流水与最近弃牌：驱动前端动作字/语音、弃牌音效与牌名播报。
            'actionEvents': [dict(a) for a in engine.actions],
            'lastDiscardAction': dict(engine.discard_actions[-1]) if engine.discard_actions else None,
            'kongEvents': [e for e in engine.ledger if e['kind'] == 'kong'],
        }
        return view

    def _serializable_result(self, result: dict) -> dict:
        """局末结果深转换（ledger 批次里的 PublicWinScore → JSON 字典）。"""
        return self._serializable_public({
            'ruleVersion': result['ruleVersion'], 'roundId': result['roundId'],
            'status': 'settled', 'seats': result.get('seats', []), 'batches': [],
            'roundResult': result,
        })['roundResult']

    def _continuation(self) -> Optional[dict]:
        """局间就绪计数（结算快照下发）：前端显示「已准备，等待其他玩家（x/y）」与「重试准备」。"""
        if not self.round_result:
            return None
        required = [s for s in range(self.capacity)
                    if self.seats[s] is not None and self.seats[s].controller.connected
                    and s not in self.auto_seats]
        return {
            'requiredSeats': required,
            'readySeats': [s for s in required if s in self._continue_confirmations],
        }

    def snapshot_for(self, seat: int) -> dict:
        """单座全量快照（game_ws 重进握手用；形状同 broadcast）。"""
        continuation = self._continuation()
        return {
            'kind': 'bf_snapshot',
            'view': self._seat_view(seat),
            # 局号对玩家 1-based（东1局…）；回执按同一口径校验。
            'round': self.round_index + 1,
            'mode': self.mode,
            'dealer': self.round_index % 4,
            'opening': self._round_opening,
            'matchFinished': self.match_finished,
            'roundResult': self._serializable_result(self.round_result) if self.round_result else None,
            **({'continuation': continuation} if continuation else {}),
        }

    def broadcast_snapshot(self) -> None:
        for seat in range(self.capacity):
            state = self.seats[seat]
            if state is None or not state.controller.connected:
                continue
            self.conn.send_to_seat_nowait(seat, self.snapshot_for(seat))
