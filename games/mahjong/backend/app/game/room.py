"""房间会话 —— 座位管理 / 重进码 / 开局驱动 / AI 托管 / 事件广播

单个 RoomSession = 一个房间码对应的内存态：GameManager + 座位表 + 连接表。
对应开发计划 §4.3 的重连/断线流程（Phase 6 起 REST 接管生命周期）：
- REST join → join_or_rejoin 占座并签发重进码（写 room_seats / players 落库）
- WS 重连 → resume_by_code 按重进码恢复原座位（无重进码不占座）
- 真人占座用 RemotePlayer（挂起等待 WS 动作）；空座位用 AIPlayer 补位
- REST start → 所有已占（真人）座位 ready 后开局，独立 game_task 驱动整场
- 断线 → on_disconnect → RemotePlayer 立即 AI 托管；重连 → on_connect 归还控制权
- 落库钩子：storage 注入时，开局/每局结算/终局分别写 matches/round_results/rooms

WSEvents 是 GameManager 的 GameEvents 真实实现：表动作/分数/公告广播到房间。
"""

import asyncio
import os
import secrets
import time
from typing import Optional

from loguru import logger

from app.game.anime_characters import (
    DEFAULT_ANIME_CHARACTER_ID,
    resolve_anime_character_id,
)
from app.game.avatars import resolve_seat_avatar
from app.game.manager import GameManager, PLAYER_SEED
from app.game.player import AI_DELAYS, AIPlayer
from app.game.llm_player import LLMPlayer
from app.game.remote_player import RemotePlayer
from app.llm.config import (default_provider_id, llm_server_available,
                            load_llm_providers)
from app.llm.persona import avatar_url, default_nickname, display_name, provider_folder
from app.llm.speech_policy import LlmSpeechPolicy, compact_speech_text
from app.llm.conditional_reasoning import ConditionalReasoningCoordinator
from app.tts.service import get_tts_service
from app.rules.base import GameRuleSet
from app.rules.lianhua import get_default_rule_set
from app.rules.registry import get_rule_set
from app.ws.manager import ConnectionManager


class RoomError(Exception):
    """房间层业务错误（错误码直接作为 rejoin_err / error 消息的 code 返回）。"""


# ─── 房间限时（Phase 8：创建起 60 分钟）────
# 非对局中超过限时 → 自动解散；对局中超过限时 → 等对局结束自动释放。
# 可用环境变量覆盖（秒）。
ROOM_LIFETIME = float(os.environ.get('ROOM_LIFETIME', str(60 * 60)))

# ─── 对局硬上限与常驻看门狗（防僵尸房间占槽）────────────────
# 对局中的房间对 TTL 永久豁免（见 is_expired），而 _drive 在极端情况下可能既推不动
# 也不会结束（例：任务提前死掉但 status 仍是 playing）。这类房间既不能 start
# （ALREADY_STARTED）也不能 close（ROOM_PLAYING），并长期占用 MAX_ROOMS 槽位。
# ROOM_MATCH_MAX：单场对局的绝对硬上限（默认 90 分钟），超过即判定卡死。
# ROOM_WATCHDOG_INTERVAL：看门狗扫描间隔；<=0 = 整机关闭（免重启的紧急开关）。
ROOM_MATCH_MAX = float(os.environ.get('ROOM_MATCH_MAX', str(90 * 60)))
ROOM_WATCHDOG_INTERVAL = float(os.environ.get('ROOM_WATCHDOG_INTERVAL', '30'))

# ─── 落库韧性 ─────────────────────────────────────────────
# 落库失败不中断对局驱动：失败项入队，等下次落库机会按序补写；终局时带退避
# 多次尝试，仍失败仅告警（数据留在内存，不抛异常中止整场）。
_FLUSH_RETRY_DELAY = 0.5   # 秒，终局补写重试间隔
_FLUSH_RETRY_ATTEMPTS = 5  # 终局补写最大尝试次数

# 胡牌由规则引擎直接判定，不再为唯一合法动作额外请求一次 LLM。这里按策略提供
# 保底获胜台词，确保大模型座位的自摸/放枪始终通过同一气泡 + TTS 链路播报。
_LLM_WIN_LINES = {
    'self-draw': {
        '激进': ('自摸，这桌归我管！', '牌到手了，全都坐好！', '自摸拿下，谁还不服！'),
        '稳健': ('自摸，水到渠成。', '牌路算准了，承让。', '自摸到手，不急不躁。'),
        '话痨': ('自摸啦，终于等到你！', '好家伙，这都能自摸！', '这一摸，快乐来得突然！'),
        '高冷': ('自摸，意料之中。', '牌到了，仅此而已。', '自摸，刚刚好。'),
    },
    'discard-win': {
        '激进': ('放枪，就等你这张！', '送上门了，我可不客气！', '敢打这张，那我胡了！'),
        '稳健': ('放枪，这张正合适。', '等到了，多谢配合。', '牌送得巧，承让。'),
        '话痨': ('放枪啦，你真懂我！', '这张来得也太及时了！', '缘分到了，挡都挡不住！'),
        '高冷': ('放枪，这张我收了。', '牌不错，归我了。', '正合我意，放枪。'),
    },
    'robbed-kong-win': {
        '激进': ('抢杠胡，这杠你开不了！', '想补杠，先问过我！', '这张敢杠，我就敢胡！'),
        '稳健': ('抢杠胡，时机正好。', '这步杠牌，我算到了。', '杠得很巧，正中下怀。'),
        '话痨': ('抢杠胡啦，惊不惊喜！', '这杠一亮，我可精神了！', '等的就是你这一杠！'),
        '高冷': ('抢杠胡，别挣扎。', '这杠，不成立。', '时机到了，抢杠胡。'),
    },
}

_LLM_LOSS_LINES = {
    '激进': ('这局算你们走运，下局再来！', '输一局而已，我马上打回来！', '先让一局，下一把见真章！'),
    '稳健': ('这局承让，我再复盘一下。', '胜负常事，下一局稳住。', '这局判断有偏差，下局调整。'),
    '话痨': ('哎呀这局没接住，下局继续！', '输了输了，容我喝口水再战！', '这把牌有自己的想法，下局来过！'),
    '高冷': ('这局输了，仅此而已。', '结果已定，下一局。', '一局而已，继续。'),
}

_LLM_DRAW_LINES = {
    '激进': ('荒庄？下一局别再躲了！', '没人拿下，那就下局决胜！', '这局没分胜负，继续来！'),
    '稳健': ('荒庄收场，下一局再寻机会。', '这局无人和牌，重新来过。', '牌局未定，下一局继续。'),
    '话痨': ('荒庄啦，大家都藏得挺深！', '谁也没胡成，这局真能憋！', '好嘛，全员陪跑，下一局继续！'),
    '高冷': ('荒庄，下一局。', '无人和牌，继续。', '未分胜负，仅此而已。'),
}

_ROUND_REACTION_TEXT_SECONDS = 1.5
_SpeechTarget = tuple[int, object]

_GANG_SPEECH_ACTIONS = frozenset({'gang', 'added-kong', 'concealed-kong', 'wind-kong'})


def _model_speech_metadata(action_kind: str | None) -> tuple[str, str | None]:
    """把内部候选动作归一到稳定 wire 合同；pass 属于 commentary 且不外泄动作键。"""
    if action_kind in _GANG_SPEECH_ACTIONS:
        return 'action', 'gang'
    if action_kind in ('chi', 'peng', 'win'):
        return 'action', action_kind
    if action_kind == 'discard':
        return 'commentary', 'discard'
    return 'commentary', None


def _make_rejoin_code() -> str:
    """8 位重进码：4+4 随机 hex，大写带连字符（如 'K7Q3-M9XP'）。"""
    return f'{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}'


class SeatState:
    """座位会话元数据：真人占座后的身份 / 重进码 / 头像 / 控制器 / 准备态。"""

    __slots__ = ('seat', 'nickname', 'rejoin_code', 'player_id', 'character_id', 'avatar',
                 'controller', 'connected_at', 'ready')

    def __init__(self, seat: int, nickname: str, rejoin_code: str, controller: RemotePlayer,
                 player_id: Optional[str] = None,
                 character_id: str = DEFAULT_ANIME_CHARACTER_ID):
        self.seat = seat
        self.nickname = nickname
        self.rejoin_code = rejoin_code
        self.player_id = player_id
        self.character_id = resolve_anime_character_id(character_id)
        self.avatar = ''   # 头像 URL：join 时按 player_id 持久化分配；空串 → 前端座位默认
        self.controller = controller
        self.connected_at: Optional[float] = None
        self.ready = False


class WSEvents:
    """GameEvents 真实广播实现：表动作/分数/公告 → 房间内所有连接。"""

    def __init__(self, room: 'RoomSession'):
        self.room = room
        self._id = 0

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def show_table_action(self, type_, actor_index, source_index, tile, meld_index) -> None:
        self.room.conn.broadcast({
            'kind': 'table_action',
            'event': {
                'id': self._next_id(),
                'type': type_,
                'actorIndex': actor_index,
                'sourceIndex': source_index,
                'tile': tile,
                'meldIndex': meld_index,
            },
        })

    def show_score_flow(self, deltas) -> None:
        self.room.conn.broadcast({'kind': 'score_flow', 'deltas': deltas})

    def announce(self, text, tone='gold', id=None) -> None:
        # id 来自 manager._announce 的 _id_counter：客户端按 id 去重，避免重复弹出
        self.room.conn.broadcast({'kind': 'announcement', 'text': text, 'tone': tone, 'id': id})

    def play_sound(self, name, volume=None) -> None:
        # 音效由客户端依据 table_action / score_flow 事件自行播放，服务端不推送
        pass

    async def play_sound_and_wait(self, name, volume=None) -> None:
        # 服务端无 UI 等待，直接返回
        pass

    def snapshot(self) -> None:
        # 状态变更后广播全量快照：per-seat 差异化（本人手牌可见，他座隐藏）
        self.room.broadcast_snapshot()

    def round_start(self, match_started, round_, dealer, honba, dice, second_dice=None,
                    flip_tile=None, flip_stack=None, flip_seat=None) -> None:
        # 每局开局广播：客户端据此播放开局序列（对局开始 + 骰子 + 翻精）
        message = {
            'kind': 'round_start',
            'matchStarted': match_started,
            'round': round_,
            'dealer': dealer,
            'honba': honba,
            'dice': dice,
        }
        if second_dice is not None:
            message['secondDice'] = second_dice
        if flip_tile is not None:
            message['flipTile'] = flip_tile
        if flip_stack is not None:
            message['flipStack'] = flip_stack
        if flip_seat is not None:
            message['flipSeat'] = flip_seat
        self.room.conn.broadcast(message)

    async def wait_for_opening(self) -> None:
        # 开局就绪屏障：等所有在线真人客户端发牌动画结束（opening_done）再开始首回合
        await self.room._wait_for_opening()


# ─── 场次身份（唯一真源）─────────────────────────────────
# 前端要区分「我参与的那场」与「房间里正进行的新一场」：REST 的 matchId 会被下一场
# 覆盖，只有 WS rejoin_ok 携带的 matchId 能锚定本人那场。血流房间没有 manager /
# match_id（靠 match_finished + status），因此三个 helper 全部按 getattr 兜底，
# 经典与血流共用同一口径。

def match_id_of(room) -> Optional[str]:
    """房间当前（或最近一场）场次 id；血流/未落库房间为 None。"""
    return getattr(room, 'match_id', None)


def match_finished_of(room) -> bool:
    """整场是否已结束：经典取 manager.match_finished（权威），血流取房间标记。"""
    mgr = getattr(room, 'manager', None)
    if mgr is not None:
        return bool(getattr(mgr, 'match_finished', False))
    return bool(getattr(room, 'match_finished', False))


def match_phase_of(room) -> str:
    """场次阶段：经典取 manager.phase，无 manager（lobby / 血流）回退房间 status。"""
    mgr = getattr(room, 'manager', None)
    if mgr is not None:
        return mgr.phase
    return getattr(room, 'status', 'lobby')


# ─── 僵尸 / 卡死判定（经典与血流共用，故不做成方法）───────
# 血流的驱动任务叫 _drive_task、经典的叫 game_task，判定按属性名鸭子类型探测，
# 测试也可以传只有 done() 的假任务。

def match_is_driving(room) -> bool:
    """是否还有活着的对局驱动任务：有 ⇒ 对局理论上仍能被推进。"""
    for name in ('game_task', '_drive_task'):
        task = getattr(room, name, None)
        if task is not None and not task.done():
            return True
    return False


def is_match_stalled(room, now: Optional[float] = None) -> bool:
    """对局是否已「无人推进」或「卡死超时」——看门狗的收尾判据。

    两个判据必需同时存在：
    - 判据一（任务已死）：没有任何任务能再推进 ⇒ 僵尸，早些收尾就能早释放槽位；
    - 判据二（超过 ROOM_MATCH_MAX）：任务「活着」也可能永不结束——_drive 在
      非结算分支会 `await asyncio.sleep(0)` 忙等自旋（见 _drive 的 else 分支），
      任务状态正常但整场推不动，只能靠绝对上限兜底。
    """
    if getattr(room, 'status', None) != 'playing':
        return False
    if not match_is_driving(room):
        return True
    started_at = getattr(room, 'match_started_at', None)
    if started_at is None:
        return False   # 未记录开局时刻（非 start() 路径造的测试房间）⇒ 不按上限判
    now = now if now is not None else time.monotonic()
    return now - started_at >= ROOM_MATCH_MAX


def build_snapshot(room: 'RoomSession', seat: int) -> dict:
    """构造全量 state_snapshot：对请求座位隐藏其他玩家手牌（防作弊）。"""
    mgr = room.manager
    players = []
    if mgr is not None:
        for p in mgr.players:
            data = p.model_dump(mode='json', by_alias=True)
            # 结算快照亮出全部手牌（局已结束，赢牌翻牌需要展示三家手牌）；
            # 进行中只对本人显示手牌，他人用 null 占位（防作弊）。
            settlement_visible = mgr.phase != 'settled' \
                or room._settlement_snapshot_released \
                or room._presentation_audio_mode(seat) == 'anime-fixed-tts-v1'
            reveal = settlement_visible and mgr.phase == 'settled' and mgr.result is not None
            if p.seat != seat and not reveal:
                data['hand'] = [None] * len(data['hand'])
            # 前端只对大模型座位抑制牌名/吃碰杠/胡牌原始音效；普通 AI 与真人不变。
            data['isLlm'] = isinstance(mgr.controllers[p.seat], LLMPlayer)
            players.append(data)
    phase = match_phase_of(room)
    if mgr is not None and not (
            phase != 'settled' or room._settlement_snapshot_released
            or room._presentation_audio_mode(seat) == 'anime-fixed-tts-v1'):
        phase = 'revealing'   # 结算快照未放行：按座位降级为 revealing
    return {
        'kind': 'state_snapshot',
        'roomId': room.room_id,
        'mode': room.mode,
        'rulesetId': room.ruleset_id,
        'matchId': match_id_of(room),
        'phase': phase,
        'round': mgr.round if mgr else 1,
        'dealer': mgr.dealer if mgr else 0,
        'honba': mgr.honba if mgr else 0,
        'dice': mgr.dice if mgr else [1, 1],
        'wallCount': len(mgr.wall) if mgr else 0,
        'secondDice': getattr(mgr, 'second_dice', [1, 1]) if mgr else [1, 1],
        'flipTile': getattr(mgr, 'flip_tile', None) if mgr else None,
        'jokerTiles': list(getattr(mgr, 'joker_tiles', [])) if mgr else [],
        'wildcardTiles': list(getattr(mgr, 'wildcard_tiles', [])) if mgr else [],
        'flipStack': getattr(mgr, 'flip_stack', None) if mgr else None,
        'openingStack': getattr(mgr, 'opening_stack', None) if mgr else None,
        'wallBreakIndex': getattr(mgr, 'wall_break_index', 0) if mgr else 0,
        # 仅下发牌墙长度对应的统一背面占位，禁止客户端读取未摸牌牌序。
        'wall': ['white'] * len(mgr.wall) if mgr else [],
        # 牌头已摸走张数：供 3D 牌山区分「牌头消耗」与「牌尾补杠/红中补张」。
        'headDrawn': getattr(mgr, '_head_drawn', 0) if mgr else 0,
        'currentPlayer': mgr.current_player if mgr else -1,
        'players': players,
        'seat': seat,
        'result': room._result_with_presentation_key()
        if mgr and (mgr.phase != 'settled' or room._settlement_snapshot_released
                    or room._presentation_audio_mode(seat) == 'anime-fixed-tts-v1') else None,
        'roundSpeechPending': bool(mgr and mgr.phase == 'settled'
                                   and room._round_speech_pending
                                   and room._presentation_audio_mode(seat) != 'anime-fixed-tts-v1'),
        'announcement': mgr.announcement if mgr else None,
        'matchFinished': match_finished_of(room),
        'lastDiscard': mgr.last_discard if mgr else None,
        'winPresentation': mgr.win_presentation if mgr else None,
        'winningPlayerIndex': mgr.winning_player_index if mgr else -1,
    }


class RoomSession:
    """单房间会话：座位 / 重进码 / 开局驱动 / 断线托管。

    capacity 决定座位数与玩家数（2/3/4 人桌）。开局由 REST start 显式触发
    （Phase 6），不再按真人到齐自动开局。
    """

    def __init__(self, room_id: str, mode: str = 'east', capacity: int = 4,
                 turn_timeout: float = 12.0, random=None, storage=None,
                 pace: Optional[dict] = None, rule_set: Optional[GameRuleSet] = None,
                 ruleset_id: str = 'lotus-classic', llm_enabled: bool = False):
        self.room_id = room_id
        self.mode = mode
        self.ruleset_id = ruleset_id
        # 用户请求的 LLM 开关；实际生效值 effective_llm_enabled 还需服务端能力可用（§9.3）
        self.llm_enabled = llm_enabled
        # capacity = 真人座位上限（2/3/4）；麻将桌固定 4 人，空位由 AI 补足
        self.capacity = capacity
        self.player_count = 4
        self.turn_timeout = turn_timeout
        self._random = random
        self.rules = rule_set or get_rule_set(ruleset_id)
        self.storage = storage  # 可选 app.storage.db.Storage；为 None 时纯内存态（测试/单机）
        self.pace = pace  # 视觉节奏注入；None → GameManager 默认 0（测试/单机即用即答）
        self.status = 'lobby'  # lobby / playing / finished / error / closed
        self.seats: list[Optional[SeatState]] = [None] * self.player_count
        # 创建者座位（REST 创建房间后第一个 join 者）；创建者离房后转移给下一座位
        self.creator_seat: Optional[int] = None
        # 限时：创建起 60 分钟（deadline）。非对局中到期清扫回收；对局中到期由 _drive 在对局结束释放
        self.lifetime = ROOM_LIFETIME
        self.created_at: float = time.monotonic()
        self.deadline: float = self.created_at + ROOM_LIFETIME
        # 重进码握手限速：30s 窗口内最多 5 次（成功 resume 后清零，正常重连不受影响）
        self._rejoin_attempts: dict[str, list[float]] = {}
        self._rejoin_window = 30.0
        self._rejoin_limit = 5
        self.conn = ConnectionManager()
        self.manager: Optional[GameManager] = None
        self.game_task: Optional[asyncio.Task] = None
        self.match_id: Optional[str] = None  # 落库用；storage 为 None 时保持 None
        # 本场开局时刻（看门狗的 ROOM_MATCH_MAX 判据）；未开局为 None。
        self.match_started_at: Optional[float] = None
        # 强制收尾幂等闸：一次对局只允许被判死收尾一次（见 force_finish）。
        self._forced_finishing = False
        # 每座位引用的服务端提供商 id（开局携带 {seat: providerId}，key 全在服务端）；
        # 空 → 使用服务端默认提供商。仅会话内存，不落库/日志/响应。
        self._llm_seat_providers: dict[int, str] = {}
        # 每座位策略覆盖（激进/稳健/话痨/高冷）；未指定时使用 provider 默认策略。
        self._llm_seat_styles: dict[int, str] = {}
        # 房主显式点选模型的空位（预留）：真人不可占，开局按预留的 provider/style 装配 LLM。
        # 与 _llm_seat_providers 的区别：后者是开局一次性入参，这里是房间级持续状态
        # （房主刷新/换人/开下一局都保留；房主把该位改回「自动选择」即清除）。
        self.reserved_seats: dict[int, dict] = {}
        # 开局时传入的服务端默认提供商 id（未指定座位时使用）
        self._llm_default_provider: Optional[str] = None
        # 当前场次 LLM 吐槽：即时广播给前端，整场结束后逐条写日志。
        self._llm_messages: list[dict] = []
        self._llm_message_seq = 0
        self._llm_speech_policy = LlmSpeechPolicy()
        self._tts_tasks: set[asyncio.Task] = set()
        self._tts_match_generation = 0
        self._tts_match_stats = {
            'requests': 0, 'hits': 0, 'misses': 0,
            'successes': 0, 'failures': 0,
        }
        # 每条 WS 连接独立声明表现音频模式；缺失/重连前一律按旧客户端处理。
        self._presentation_audio_modes: dict[int, str] = {}
        # 房间权威牌桌主题：房主大厅阶段可改，开局后锁定；广播给全房。
        self.table_theme: str = 'jade'
        # 胡牌演出立即下发；局末 LLM 发言完成前由客户端暂缓打开结算面板。
        self._settlement_snapshot_released = False
        self._round_speech_pending = False
        # 落库韧性：待补写队列（按序执行，任一失败即停）。开局/每局/终局落库失败
        # 不再中断整场驱动，数据留在队列等下次落库机会重试。
        self._pending_writes: list = []
        # 结算确认屏障：一局结算后等所有已连真人确认（客户端「继续」按钮）再推进下一局。
        # 兜底超时防止某客户端完全不响应导致整场卡死；正常流程客户端 10s 倒计时自动确认。
        self._continue_timeout = 20.0
        self._continue: Optional[dict] = None
        self._continue_event: Optional[asyncio.Event] = None
        self._early_continue_confirmed: dict[str, set[int]] = {}
        # 开局就绪屏障：等所有在线真人客户端发牌动画结束（opening_done）再开始首回合。
        # 消除固定 openingDelay 在慢设备上的「服务端抢跑」；兜底超时防客户端不响应卡死。
        # 远端莲花开局包含开始音效、两次骰子、翻精展示和发牌动画；
        # 浏览器音频最坏情况下每个等待最多 4s，15s 会在最后一批发牌前抢跑。
        # 远端开局包含开始/两次骰子音效与完整发牌动画；真实双窗口的 Canvas
        # 渲染可能显著拖慢定时器，60 秒覆盖慢浏览器的完整时间线，仍保留兜底。
        self._opening_timeout = 60.0
        self._opening: Optional[dict] = None
        self._opening_event: Optional[asyncio.Event] = None

    # ── 限时（60 分钟）─────────────────────────────────

    def is_past_deadline(self, now: Optional[float] = None) -> bool:
        """是否已超过 60 分钟限时。"""
        return (now if now is not None else time.monotonic()) >= self.deadline

    def is_expired(self, now: Optional[float] = None) -> bool:
        """房间是否可回收：对局中绝不回收（等对局结束自动释放）；
        超过限时（deadline）即回收，与是否有人在座/在线无关。"""
        if self.status == 'playing':
            return False
        return self.is_past_deadline(now)

    # ── 座位 / 重进码 ────────────────────────────────────

    def _ensure_seat_avatar(self, state: SeatState, preferred: str = '') -> None:
        """确保座位带持久化头像：优先平台登录头像（preferred），否则按 player_id
        首次进房从外部 API 取一次并落库，之后跨房间/场次复用（同一玩家头像稳定）。
        无 player_id / 无存储 / 取图失败时保持空串，由前端回退座位默认头像。

        解析规则与血流房间共用同一个实现（app.game.avatars.resolve_seat_avatar）。
        """
        if state.avatar:
            return
        state.avatar = resolve_seat_avatar(preferred, state.player_id, self.storage)

    def join_or_rejoin(self, nickname: str, rejoin_code: Optional[str] = None,
                       player_id: Optional[str] = None,
                       character_id: str = DEFAULT_ANIME_CHARACTER_ID,
                       avatar: str = ''):
        """REST join：占第一个空座并签发重进码（is_rejoin=False）。失败抛 RoomError。

        真人占座受 capacity 上限约束（超出 → ROOM_FULL）；AI 座位不在此列。
        昵称查重：房间内已有同名玩家占座 → NICKNAME_TAKEN（重进码路径不受此限）。
        首个占座者为创建者（REST 创建房间后 creator 自己 join）。
        反赌博风控：player_id 命中黑名单 → BANNED（重进码路径在 resume_by_code 内查禁）。
        """
        if player_id and self.storage is not None and self.storage.is_banned('player', player_id):
            logger.bind(room_id=self.room_id).warning(f"加入被拒 BANNED player_id={player_id}")
            raise RoomError('BANNED')
        if rejoin_code:
            return self.resume_by_code(rejoin_code)
        for state in self.seats:
            if state is not None and player_id is not None and state.player_id == player_id:
                self._ensure_seat_avatar(state, preferred=avatar)
                return state.seat, True, state
        if sum(1 for s in self.seats if s is not None) >= self.capacity:
            raise RoomError('ROOM_FULL')
        for state in self.seats:
            if state is not None and state.nickname == nickname:
                raise RoomError('NICKNAME_TAKEN')
        seat = self._first_joinable_seat()
        if seat is None:
            # 真人没占满但空位都被房主预留给大模型：用专用码给出可读原因
            # （笼统的「房间已满」会和面板上看着还有空位自相矛盾）。
            raise RoomError('SEATS_RESERVED' if self.reserved_seats else 'ROOM_FULL')
        # 断线/超时代打 AI 的思考速度在开局时由 _controllers 统一注入（_ai_delays）
        controller = RemotePlayer(seat, self.conn, timeout=self.turn_timeout,
                                  room_id=self.room_id, rule_set=self.rules)
        state = SeatState(seat, nickname, _make_rejoin_code(), controller,
                          player_id=player_id, character_id=character_id)
        self.seats[seat] = state
        self._ensure_seat_avatar(state, preferred=avatar)
        if self.creator_seat is None:
            self.creator_seat = seat
        self._persist_seat(seat)
        return seat, False, state

    def _first_joinable_seat(self) -> Optional[int]:
        """第一个可被真人占用的座位：空且未被房主预留给大模型。"""
        return next((seat for seat, state in enumerate(self.seats)
                     if state is None and seat not in self.reserved_seats), None)

    def set_reserved_seat(self, seat: int, provider_id: Optional[str],
                          style: Optional[str] = None) -> None:
        """房主为某个空位写 / 清大模型预留：provider_id 为空 → 取消预留（真人可占）。

        预留只作用于空位——真人已坐的座位不给预留，避免出现「把真人挤走」的语义。
        """
        if not 0 <= seat < self.player_count:
            raise RoomError('INVALID_SEAT')
        if self.seats[seat] is not None:
            raise RoomError('SEAT_OCCUPIED')
        if provider_id:
            self.reserved_seats[seat] = {'providerId': provider_id, 'style': style or ''}
        else:
            self.reserved_seats.pop(seat, None)

    def resume_by_code(self, rejoin_code: str):
        """WS 重连：持有原重进码者可接管尚未被检测为断线的旧连接。"""
        for seat, state in enumerate(self.seats):
            if state is not None and state.rejoin_code == rejoin_code:
                if self.storage is not None and state.player_id \
                        and self.storage.is_banned('player', state.player_id):
                    logger.bind(room_id=self.room_id).warning("重连被拒 BANNED")
                    raise RoomError('BANNED')
                self._ensure_seat_avatar(state)   # 服务重启后内存头像丢失，按 player_id 恢复
                return seat, state
        logger.bind(room_id=self.room_id).warning("重连被拒 INVALID_REJOIN_CODE")
        raise RoomError('INVALID_REJOIN_CODE')

    # ── 重进码握手限速 ───────────────────────────────────

    def check_rejoin_rate(self, rejoin_code: str) -> bool:
        """重进码握手限速：30s 窗口内最多 5 次。

        成功 resume 后由 reset_rejoin_rate 清零 → 正常断线重连的客户端不会因
        指数退避下的多次重试被锁；失败尝试（错误码 / 顶号）持续累积以触发限速。
        """
        now = time.monotonic()
        window = [t for t in self._rejoin_attempts.get(rejoin_code, [])
                  if now - t < self._rejoin_window]
        if len(window) >= self._rejoin_limit:
            self._rejoin_attempts[rejoin_code] = window
            return False
        window.append(now)
        self._rejoin_attempts[rejoin_code] = window
        return True

    def reset_rejoin_rate(self, rejoin_code: str) -> None:
        """成功恢复座位后清零该码的失败计数（正常重连不被限速）。"""
        self._rejoin_attempts.pop(rejoin_code, None)

    def release_seat(self, seat: int, rejoin_code: Optional[str] = None) -> None:
        """REST leave：释放座位。带 rejoin_code 时校验身份，防止误释放他人座位。"""
        state = self.seats[seat]
        if state is None:
            raise RoomError('SEAT_EMPTY')
        if rejoin_code is not None and rejoin_code != state.rejoin_code:
            raise RoomError('INVALID_REJOIN_CODE')
        state.controller.set_connected(False)  # 断开 pending，转 AI 代打
        self.seats[seat] = None
        self.conn.unregister(seat)
        if self.creator_seat == seat:
            self._transfer_creator()
        if self.storage is not None:
            self.storage.remove_room_seat(self.room_id, seat)

    def _transfer_creator(self) -> None:
        """创建者离房 → 房主转移给剩余座位中编号最小者；无人在座则置空。"""
        self.creator_seat = next(
            (s.seat for s in self.seats if s is not None), None)

    def has_humans(self) -> bool:
        """是否还有真人占座（seat 表即真人座位；全空则房间无意义，可立即释放）。"""
        return any(s is not None for s in self.seats)

    def ready_seat(self, seat: int, ready: Optional[bool] = None) -> bool:
        """REST ready：设置座位准备态（缺省 toggle）。返回新状态。"""
        state = self.seats[seat]
        if state is None:
            raise RoomError('SEAT_EMPTY')
        state.ready = not state.ready if ready is None else ready
        return state.ready

    def set_character(self, seat: int, character_id: str) -> str:
        """REST 更新本家二次元角色：仅开局前可改；返回规范化后的角色 id。

        角色只影响表现层，开局后由快照锁定，因此 playing 状态拒绝更新。
        """
        if self.status == 'playing':
            raise RoomError('ROOM_PLAYING')
        state = self.seats[seat]
        if state is None:
            raise RoomError('SEAT_EMPTY')
        state.character_id = resolve_anime_character_id(character_id)
        self._ensure_seat_avatar(state)
        self._persist_seat(seat)
        return state.character_id

    # ── 连接生命周期 ─────────────────────────────────────

    def on_connect(self, seat: int) -> None:
        state = self.seats[seat]
        if state is not None:
            state.controller.set_connected(True)
            state.connected_at = time.time()
            self._presentation_audio_modes[seat] = 'legacy-dynamic'

    def on_disconnect(self, seat: int) -> None:
        state = self.seats[seat]
        if state is not None:
            state.controller.set_connected(False)
        self._presentation_audio_modes.pop(seat, None)

    def _presentation_audio_mode(self, seat: int) -> str:
        return self._presentation_audio_modes.get(seat, 'legacy-dynamic')

    def _settlement_presentation_key(self) -> str | None:
        if self.manager is None or self.manager.phase != 'settled':
            return None
        result = self.manager.result or {}
        winner = result.get('winnerIndex')
        outcome = 'draw' if result.get('draw') else f'winner:{winner}'
        return (
            f'{self.room_id}:match:{self._tts_match_generation}:'
            f'{self.manager.round}:{self.manager.honba}:{outcome}'
        )

    def _result_with_presentation_key(self) -> dict | None:
        if self.manager is None or self.manager.result is None:
            return None
        result = dict(self.manager.result)
        key = self._settlement_presentation_key()
        if key:
            result['presentationKey'] = key
        return result

    def _anime_fixed_connected_seats(self) -> list[int]:
        return [
            seat for seat in self.conn.connected_seats
            if self._presentation_audio_mode(seat) == 'anime-fixed-tts-v1'
        ]

    def _has_legacy_audio_audience(self) -> bool:
        connected = self.conn.connected_seats
        # 无连接的无头测试/维护路径沿用 legacy；真实房间按每连接能力判断。
        return not connected or any(
            self._presentation_audio_mode(seat) != 'anime-fixed-tts-v1'
            for seat in connected
        )

    def _model_speech_targets(self, purpose: str) -> tuple[_SpeechTarget, ...]:
        connected = tuple(self.conn.connected_seats)
        return tuple(
            (seat, self.conn.connection_token(seat)) for seat in connected
            if self.conn.connection_token(seat) is not None
            and (purpose == 'commentary'
                 or self._presentation_audio_mode(seat) != 'anime-fixed-tts-v1')
        )

    def _broadcast_model_speech(
        self,
        message: dict,
        purpose: str,
        targets: tuple[_SpeechTarget, ...] | None = None,
    ) -> None:
        """动作/赛后模型语音只投 legacy；普通吐槽仍投所有连接。"""
        connected = self.conn.connected_seats
        if not connected:
            # 保留无头测试/维护脚本的历史广播可观察性。
            self.conn.broadcast(message)
            return
        audience = targets if targets is not None else self._model_speech_targets(purpose)
        for target, token in audience:
            if not self.conn.is_current_connection(target, token):
                continue
            if purpose != 'commentary' \
                    and self._presentation_audio_mode(target) == 'anime-fixed-tts-v1':
                continue
            self.conn.send_to_seat_nowait(target, message)

    def broadcast_snapshot(self) -> None:
        """向所有在位连接广播 per-seat 快照（本人手牌可见，他座隐藏）。"""
        if self.manager is not None:
            if self.manager.phase == 'settled' and not self._settlement_snapshot_released:
                # 等 _drive 建立局末发言闸门后统一下发，避免二次元客户端收到重复结算快照。
                return
            if self.manager.phase != 'settled':
                self._settlement_snapshot_released = False
        for seat in self.conn.connected_seats:
            self.conn.send_to_seat_nowait(seat, build_snapshot(self, seat))

    def handle_client_message(self, seat: int, message: dict) -> tuple[bool, str]:
        """客户端动作 → 投递给该座位控制器。返回 (是否受理, 错误码)。"""
        if message.get('type') == 'ping':
            # 回应 pong：客户端据此测 RTT → 信号质量显示（signal-N）
            self.conn.send_to_seat_nowait(seat, {'kind': 'pong'})
            return True, ''
        if message.get('type') == 'continue':
            return self._confirm_continue(seat, message.get('presentationKey'))
        if message.get('type') == 'opening_done':
            return self._confirm_opening(seat, message.get('round'))
        if message.get('type') == 'presentation_audio_mode':
            mode = message.get('mode')
            if mode not in ('legacy-dynamic', 'anime-fixed-tts-v1'):
                return False, 'INVALID_PRESENTATION_AUDIO_MODE'
            self._presentation_audio_modes[seat] = mode
            # 已结算但 legacy 感言尚未结束时，新切换的 anime 客户端立即拿到结算。
            if self.manager is not None and self.manager.phase == 'settled' \
                    and not self._settlement_snapshot_released:
                self.conn.send_to_seat_nowait(seat, build_snapshot(self, seat))
            return True, ''
        if message.get('type') == 'set_table_theme':
            theme = message.get('theme')
            if theme not in ('jade', 'majsoul', 'happyMahjong', 'rosewood', 'llm', 'llmAnime'):
                return False, 'INVALID_TABLE_THEME'
            if seat != self.creator_seat:
                return False, 'NOT_CREATOR'
            if self.status == 'playing':
                return False, 'ROOM_PLAYING'
            self.table_theme = theme
            self.conn.broadcast({'kind': 'table_theme', 'theme': theme})
            return True, ''
        state = self.seats[seat]
        if state is None or not isinstance(state.controller, RemotePlayer):
            return False, 'NOT_HUMAN_SEAT'
        return state.controller.handle_action(message)

    # ── 结算确认屏障 ─────────────────────────────────────

    def _human_connected_seats(self) -> list[int]:
        """当前在线（WS 已连）的真人座位列表。断线座位由 AI 托管，不参与确认。"""
        return [s.seat for s in self.seats if s is not None and s.controller.connected]

    def _confirm_continue(self, seat: int, presentation_key: object = None) -> tuple[bool, str]:
        """客户端「继续」：把座位标记为已确认（仅在确认屏障激活时生效）。"""
        if self._continue is None:
            current_key = self._settlement_presentation_key()
            if self._presentation_audio_mode(seat) == 'anime-fixed-tts-v1' \
                    and isinstance(presentation_key, str) \
                    and presentation_key == current_key:
                self._early_continue_confirmed.setdefault(current_key, set()).add(seat)
            return True, ''   # 非结算期间：幂等忽略（结算窗早于到达的 continue 不算错）
        if isinstance(presentation_key, str) \
                and presentation_key != self._continue.get('presentationKey'):
            return True, ''
        confirmed = self._continue['confirmed']
        if seat not in confirmed:
            confirmed.add(seat)
        if self._continue_event is not None:
            self._continue_event.set()
        return True, ''

    def _confirm_opening(self, seat: int, round_: Optional[int] = None) -> tuple[bool, str]:
        """客户端「opening_done」：标记当前局开局动画已完成。

        round 是可选的，兼容旧客户端；新客户端带 round 时拒绝迟到的上一局确认。
        """
        if self._opening is None:
            return True, ''   # 非开局等待期间：幂等忽略
        opening_round = self._opening.get('round')
        if round_ is not None and opening_round is not None and round_ != opening_round:
            return True, ''   # 迟到的旧局确认：幂等忽略，不污染当前屏障
        confirmed = self._opening['confirmed']
        if seat not in confirmed:
            confirmed.add(seat)
        if self._opening_event is not None:
            self._opening_event.set()
        return True, ''

    async def _wait_for_opening(self) -> None:
        """开局就绪屏障：等所有在线真人客户端发牌动画结束（opening_done）再开始首回合。

        测试路径（pace 为空）不等待：客户端不做开局动画，直接即用即答。
        兜底超时（_opening_timeout）防客户端完全不响应导致整场卡死。
        """
        if not self.pace:
            return
        seats = self._human_connected_seats()
        if not seats:
            return   # 全 AI / 全员断线 → 无需等待
        self._opening = {
            'round': self.manager.round if self.manager is not None else None,
            'deadline': time.monotonic() + self._opening_timeout,
            'confirmed': set(),
        }
        self._opening_event = asyncio.Event()
        try:
            while True:
                current = self._human_connected_seats()
                confirmed = self._opening['confirmed']
                # 无在线真人（全员断线）或所有在线真人都已就绪 → 开始首回合
                if not current or all(s in confirmed for s in current):
                    break
                remaining = self._opening['deadline'] - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    await asyncio.wait_for(self._opening_event.wait(), timeout=remaining)
                    self._opening_event.clear()
                except asyncio.TimeoutError:
                    logger.bind(room_id=self.room_id).warning("开局就绪等待超时，继续推进")
                    break
        finally:
            self._opening = None
            self._opening_event = None

    async def _wait_for_continue(self) -> None:
        """结算后等所有已连真人确认再推进。全部断线 / 无真人 → 直接通过。

        客户端在「继续」按钮显示后自动倒计时 10s 并发送 continue；此处的兜底
        超时（_continue_timeout）只防客户端完全不响应导致整场卡死。
        """
        seats = self._human_connected_seats()
        if not seats:
            self._early_continue_confirmed.clear()
            return
        presentation_key = self._settlement_presentation_key()
        early = self._early_continue_confirmed.get(presentation_key or '', set()).intersection(seats)
        self._early_continue_confirmed.clear()
        self._continue = {
            'deadline': time.monotonic() + self._continue_timeout,
            'confirmed': set(early),
            'presentationKey': presentation_key,
        }
        self._continue_event = asyncio.Event()
        self.conn.broadcast({'kind': 'continue_prompt', 'total': len(seats)})
        try:
            while True:
                current = self._human_connected_seats()
                confirmed = self._continue['confirmed']
                # 无在线真人（全员断线）或所有在线真人都已确认 → 推进
                if not current or all(s in confirmed for s in current):
                    break
                remaining = self._continue['deadline'] - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    await asyncio.wait_for(self._continue_event.wait(), timeout=remaining)
                    self._continue_event.clear()
                except asyncio.TimeoutError:
                    logger.bind(room_id=self.room_id).warning("结算确认等待超时，继续推进")
                    break
        finally:
            self._continue = None
            self._continue_event = None

    # ── 开局驱动 ─────────────────────────────────────────

    async def start(self, llm_seats: Optional[list] = None,
                    default_provider: Optional[str] = None) -> None:
        """REST start：所有已占（真人）座位 ready 后开局，独立 game_task 驱动整场。

        必须 await（async）以便 game_task 创建在当前事件循环 —— 即 uvicorn 的
        事件循环，与 WS 处理器一致。否则跨循环入队/唤醒会死锁。
        对局已结束（game_task 完成、status=finished）的房间允许再开一局：旧
        manager / match 被新一场替换（旧 match 已落库为 finished 历史）。
        llm_seats：每座位引用服务端提供商与策略（{seat, providerId, style}，key 全在服务端）；
        default_provider：未指定座位时的默认提供商 id；均为会话内存状态。
        """
        if self.game_task is not None and not self.game_task.done():
            if self.status != 'finished':
                raise RoomError('ALREADY_STARTED')
            # 客户端已看到终局，但落库和旧任务收尾仍在途；重开须等它真正退出。
            try:
                await asyncio.wait_for(asyncio.shield(self.game_task), timeout=30)
            except asyncio.TimeoutError as exc:
                raise RoomError('MATCH_FINISHING') from exc
            except asyncio.CancelledError:
                if not self.game_task.cancelled():
                    raise
        if self.status not in ('lobby', 'finished'):
            raise RoomError('ROOM_CLOSED')
        for seat, state in enumerate(self.seats):
            if state is not None and not state.ready:
                raise RoomError('NOT_ALL_READY')
        if not any(s is not None for s in self.seats):
            raise RoomError('ROOM_EMPTY')
        if llm_seats and not self.effective_llm_enabled:
            # 联机 LLM 是房间级服务端功能，不能由开局参数暗中开启，也不能静默忽略。
            # 单机浏览器 provider/Key 与这里完全无关。
            raise RoomError('LLM_NOT_ENABLED')
        await self._cancel_tts_tasks()
        self._round_speech_pending = False
        self._tts_match_generation += 1
        # 预留座位先行、开局入参覆盖：房主换机器/刷新/换客户端都不丢预留，
        # 而入参是房主此刻的最新意图（刚清掉预留时以入参为准）。
        providers = {seat: item['providerId'] for seat, item in self.reserved_seats.items()}
        providers.update({item['seat']: item['providerId'] for item in (llm_seats or [])})
        styles = {seat: item['style'] for seat, item in self.reserved_seats.items()
                  if item.get('style')}
        styles.update({item['seat']: item['style'] for item in (llm_seats or [])
                       if item.get('style')})
        self._llm_seat_providers = providers
        self._llm_seat_styles = styles
        self._llm_default_provider = default_provider
        self._llm_messages = []
        self._llm_message_seq = 0
        self._llm_speech_policy.reset()
        self._early_continue_confirmed.clear()
        self._tts_match_stats = {
            'requests': 0, 'hits': 0, 'misses': 0,
            'successes': 0, 'failures': 0,
        }
        self.manager = GameManager(
            mode=self.mode,
            controllers=self._controllers(),
            player_seeds=self._seeds(),
            random=self._random,
            events=WSEvents(self),
            pace=self.pace,
            room_id=self.room_id,
            rule_set=self.rules,
        )
        self.status = 'playing'
        # 新一场：硬上限计时重新起算，并清掉上一场的强制收尾闸（否则再被判死时不收尾）。
        self.match_started_at = time.monotonic()
        self._forced_finishing = False
        self.game_task = asyncio.create_task(self._drive())
        logger.bind(room_id=self.room_id).info("开局已触发，游戏任务启动")

    def _ai_delays(self) -> Optional[dict]:
        """真人联机房间（注入 PLAY_PACE）的 AI 用人类思考速度；测试路径保持即用即答。"""
        return AI_DELAYS if self.pace else None

    @property
    def llm_available(self) -> bool:
        """服务端是否配置了大模型（§9.3 能力探测；服务端多提供商注册表非空）。"""
        return llm_server_available()

    @property
    def effective_llm_enabled(self) -> bool:
        """本局实际是否使用 LLM：用户请求 && 服务端注册表非空。"""
        return self.llm_enabled and self.llm_available

    def _seat_provider_id(self, seat: int) -> Optional[str]:
        """该空位的提供商 id：座位显式指定优先，否则服务端默认。"""
        provider_id = self._llm_seat_providers.get(seat)
        if provider_id:
            return provider_id
        if self._llm_default_provider:
            return self._llm_default_provider
        return default_provider_id()

    def _seat_style(self, seat: int, provider) -> str:
        """座位显式策略优先；自动选择座位沿用服务端 provider 默认策略。"""
        return self._llm_seat_styles.get(seat) or provider.style

    def _controllers(self) -> list:
        """装配控制器：空座位 AI 补位（LLM 开关生效时用 LLMPlayer）；真人座位 RemotePlayer。

        每座位可引用不同服务端提供商并覆盖策略（开局携带 providerId/style，key 全在服务端）；
        未指定 → 服务端默认提供商；注册表为空 → 启发式 AIPlayer（静默降级）。
        AI 思考速度按「开局瞬间」的房间节奏注入（_ai_delays）：真人房间用
        AI_DELAYS 人类节奏，测试路径（pace 为空）保持即用即答。
        """
        ai_delays = self._ai_delays()
        providers = load_llm_providers() if self.effective_llm_enabled else {}
        conditional_reasoning = ConditionalReasoningCoordinator()
        controllers = []
        for seat_index, seat in enumerate(self.seats):
            if seat is not None:
                seat.controller.set_ai_delays(ai_delays)
                controllers.append(seat.controller)
            else:
                provider = providers.get(self._seat_provider_id(seat_index))
                if provider is not None:
                    style = self._seat_style(seat_index, provider)
                    controllers.append(LLMPlayer(delays=ai_delays, rule_set=self.rules,
                                                 config=provider.to_config(style_override=style),
                                                 seat=seat_index,
                                                 provider_id=provider.provider_id,
                                                 on_message=self._on_llm_message,
                                                 on_fallback=self._on_llm_fallback,
                                                 on_status=self._on_llm_status,
                                                 reasoning=conditional_reasoning))
                else:
                    controllers.append(AIPlayer(delays=ai_delays, rule_set=self.rules))
        return controllers

    def _seeds(self) -> list:
        seeds = []
        providers = load_llm_providers() if self.effective_llm_enabled else {}
        for seat, state in enumerate(self.seats):
            if state is not None:
                # 真人头像 = join 时按 player_id 持久化分配的 URL（空串 → 前端座位默认）
                seeds.append({
                    'name': state.nickname,
                    'avatar': state.avatar,
                    'score': 1000,
                    'characterId': state.character_id,
                    'playerKind': 'human',
                })
            else:
                provider = providers.get(self._seat_provider_id(seat))
                if provider is not None:
                    # LLM 空位：按提供商/策略给出头像与显示名（「昵称（策略）」，
                    # 昵称缺省按供应商推导：DeepSeek=大肥鱼等）
                    style = self._seat_style(seat, provider)
                    avatar_folder = provider_folder(
                        provider.base_url,
                        provider.avatar_folder,
                        provider.provider_id,
                        provider.model,
                        provider.provider_type,
                    )
                    seeds.append({
                        'name': display_name(provider.nickname or default_nickname(
                                                 provider.base_url,
                                                 provider_id=provider.provider_id),
                                             style),
                        'avatar': avatar_url(
                            provider.base_url, style, avatar_folder, provider.provider_id),
                        'score': 1000,
                        'characterId': resolve_anime_character_id(
                            provider_id=provider.provider_type,
                            avatar_folder=avatar_folder,
                        ),
                        'playerKind': 'llm',
                    })
                else:
                    # AI 空座：固定种子头像，不随用户变化
                    seeds.append({
                        **PLAYER_SEED[seat],
                        'characterId': DEFAULT_ANIME_CHARACTER_ID,
                        'playerKind': 'bot',
                    })
        return seeds

    def _on_llm_message(self, seat: int, text: str,
                        priority: str = 'normal', *,
                        decision: str | None = None,
                        action_kind: str | None = None) -> None:
        """LLM 吐槽：记录本场历史并实时广播；失败不影响出牌动作。"""
        if not text or not 0 <= seat < self.player_count:
            return
        controller = None
        if self.manager is not None and 0 <= seat < len(self.manager.controllers):
            controller = self.manager.controllers[seat]
        style = controller.config.style if isinstance(controller, LLMPlayer) else '稳健'
        mandatory = priority == 'chatter-turn'
        priority = 'important' if priority == 'important' else 'normal'
        text = compact_speech_text(text)
        if not text:
            return
        if not self._llm_speech_policy.admit(
                seat, style, priority, mandatory=mandatory):
            return
        self._llm_message_seq += 1
        purpose, public_action_kind = _model_speech_metadata(action_kind)
        entry = {
            'id': self._llm_message_seq, 'seat': seat, 'text': text,
            'priority': priority, 'purpose': purpose,
            'speechSource': 'model-message',
        }
        if public_action_kind:
            entry['actionKind'] = public_action_kind
        self._llm_messages.append(entry)
        speech_targets = self._model_speech_targets(purpose)
        self._broadcast_model_speech(
            {'kind': 'llm_message', **entry}, purpose, speech_targets)
        if purpose == 'action' and self.conn.connected_seats and not speech_targets:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # 同步单测/维护脚本没有事件循环：保留文字广播，不启动装饰性 TTS。
            return
        service = get_tts_service()
        if not service.available or self.manager is None:
            return
        if not isinstance(controller, LLMPlayer):
            return
        self._tts_match_stats['requests'] += 1
        generation = self._tts_match_generation
        task = loop.create_task(self._synthesize_llm_audio(
            generation, entry['id'], seat, text, controller.config.style,
            controller.provider_id, priority, purpose, public_action_kind,
            speech_targets))
        self._tts_tasks.add(task)
        task.add_done_callback(self._tts_tasks.discard)

    def _on_llm_fallback(self, seat: int, decision: str, action_kind: str,
                         priority: str = 'normal') -> None:
        """LLM 转交引擎：服从发言频率，只广播问号气泡，绝不创建 TTS。"""
        if not 0 <= seat < self.player_count:
            return
        controller = None
        if self.manager is not None and 0 <= seat < len(self.manager.controllers):
            controller = self.manager.controllers[seat]
        style = controller.config.style if isinstance(controller, LLMPlayer) else '稳健'
        mandatory = priority == 'chatter-turn' \
            or style == '话痨' and decision == 'turn' and action_kind == 'discard'
        public_priority = 'important' if priority == 'important' else 'normal'
        if not self._llm_speech_policy.admit(
                seat, style, public_priority, mandatory=mandatory):
            return
        self._llm_message_seq += 1
        purpose, public_action_kind = _model_speech_metadata(action_kind)
        entry = {
            'id': self._llm_message_seq, 'seat': seat, 'text': '？',
            'priority': public_priority,
            'purpose': purpose,
            'speechSource': 'model-message',
        }
        if public_action_kind:
            entry['actionKind'] = public_action_kind
        self._llm_messages.append(entry)
        self._broadcast_model_speech({'kind': 'llm_message', **entry}, purpose)

    def _on_llm_status(self, seat: int, active: bool, text: str = '',
                       speak: bool = True) -> None:
        """思考状态不进历史/限流；开场台词可 TTS，安全流式进度只显示气泡。"""
        if not 0 <= seat < self.player_count:
            return
        if not active:
            self.conn.broadcast({'kind': 'llm_status', 'seat': seat, 'active': False})
            return
        text = compact_speech_text(text)
        if not text:
            text = '让我想想怎么打。'
        self.conn.broadcast({
            'kind': 'llm_status', 'seat': seat, 'active': True, 'text': text,
        })
        if not speak:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        controller = None
        if self.manager is not None and 0 <= seat < len(self.manager.controllers):
            controller = self.manager.controllers[seat]
        service = get_tts_service()
        if not service.available or not isinstance(controller, LLMPlayer):
            return
        self._llm_message_seq += 1
        message_id = self._llm_message_seq
        self._tts_match_stats['requests'] += 1
        generation = self._tts_match_generation
        task = loop.create_task(self._synthesize_llm_audio(
            generation, message_id, seat, text, controller.config.style,
            controller.provider_id, 'normal'))
        self._tts_tasks.add(task)
        task.add_done_callback(self._tts_tasks.discard)

    async def _emit_llm_round_reaction(
        self,
        seat: int,
        text: str,
        controller: LLMPlayer,
        speech_targets: tuple[_SpeechTarget, ...] | None = None,
    ) -> None:
        """合成后同时广播气泡和音频，并等待本句预计播放完再轮到下一位。"""
        text = compact_speech_text(text)
        if not text:
            return
        service = get_tts_service()
        audio = None
        if service.available:
            self._tts_match_stats['requests'] += 1
            try:
                audio = await asyncio.wait_for(
                    service.ensure_audio(text, controller.config.style, controller.provider_id),
                    timeout=4.0)
            except asyncio.CancelledError:
                raise
            except Exception:
                audio = None
            if audio is None:
                self._tts_match_stats['failures'] += 1
            else:
                self._tts_match_stats['successes'] += 1
                self._tts_match_stats['hits' if audio.cached else 'misses'] += 1

        self._llm_message_seq += 1
        message_id = self._llm_message_seq
        entry = {
            'id': message_id, 'seat': seat, 'text': text, 'priority': 'important',
            'purpose': 'round-reaction', 'speechSource': 'model-message',
            'hasAudio': audio is not None,
        }
        self._llm_messages.append(entry)
        self._broadcast_model_speech(
            {'kind': 'llm_message', **entry}, 'round-reaction', speech_targets)
        if audio is not None:
            self._broadcast_model_speech({
                'kind': 'llm_audio', 'messageId': message_id, 'seat': seat,
                'audioUrl': audio.audio_url, 'cached': audio.cached,
                'priority': 'important',
                'purpose': 'round-reaction', 'speechSource': 'model-message',
            }, 'round-reaction', speech_targets)

        active_targets = tuple(
            (target, token) for target, token in (speech_targets or ())
            if self.conn.is_current_connection(target, token)
            and self._presentation_audio_mode(target) != 'anime-fixed-tts-v1'
        )
        if not self.conn.connected_seats:
            return
        if speech_targets is not None and not active_targets:
            return
        # 有音频时由各客户端自己的播放队列串行，并在实际播完后放行结算。
        # 服务端不再按文件大小猜播放时长，否则慢设备会在台词中途弹面板。
        if audio is None:
            await asyncio.sleep(_ROUND_REACTION_TEXT_SECONDS)

    async def _announce_llm_round_reactions(self, result: dict) -> None:
        """赢家先说，其余 LLM AI 顺时针依次说；荒庄按座位顺序，真人永不入队。"""
        if self.manager is None or not self._has_legacy_audio_audience():
            return
        llm_seats = [
            seat for seat, controller in enumerate(self.manager.controllers)
            if isinstance(controller, LLMPlayer)
        ]
        if not llm_seats:
            return
        draw = bool(result.get('draw'))
        raw_winner = result.get('winnerIndex')
        winner = raw_winner if isinstance(raw_winner, int) and not draw else None
        if winner is not None and winner in llm_seats:
            order = [winner, *sorted(
                (seat for seat in llm_seats if seat != winner),
                key=lambda seat: (seat - winner) % self.player_count,
            )]
        else:
            order = sorted(llm_seats)

        if result.get('robbedKong') or result.get('winType') == 'robbed-kong':
            win_type = 'robbed-kong-win'
        elif result.get('sourceFrom') is not None or result.get('winType') in ('discard', 'dihu'):
            win_type = 'discard-win'
        else:
            win_type = 'self-draw'

        base_sequence = self._llm_message_seq
        for queue_index, seat in enumerate(order):
            speech_targets = self._model_speech_targets('round-reaction')
            if self.conn.connected_seats and not speech_targets:
                break
            controller = self.manager.controllers[seat]
            if not isinstance(controller, LLMPlayer):
                continue
            if draw:
                lines = _LLM_DRAW_LINES
            elif seat == winner:
                lines = _LLM_WIN_LINES[win_type]
            else:
                lines = _LLM_LOSS_LINES
            variants = lines.get(controller.config.style, lines['稳健'])
            line = variants[(base_sequence + queue_index) % len(variants)]
            await self._emit_llm_round_reaction(
                seat, line, controller, speech_targets)

    async def _synthesize_llm_audio(self, generation: int, message_id: int,
                                    seat: int, text: str, style: str,
                                    provider_id: str, priority: str,
                                    purpose: str = 'commentary',
                                    action_kind: str | None = None,
                                    speech_targets: tuple[_SpeechTarget, ...] | None = None) -> None:
        try:
            audio = await get_tts_service().ensure_audio(text, style, provider_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            audio = None
        if generation != self._tts_match_generation:
            return
        if audio is None:
            self._tts_match_stats['failures'] += 1
            return
        self._tts_match_stats['successes'] += 1
        self._tts_match_stats['hits' if audio.cached else 'misses'] += 1
        message = {
            'kind': 'llm_audio',
            'messageId': message_id,
            'seat': seat,
            'audioUrl': audio.audio_url,
            'cached': audio.cached,
            'priority': priority,
            'purpose': purpose,
            'speechSource': 'model-message',
        }
        if action_kind:
            message['actionKind'] = action_kind
        self._broadcast_model_speech(
            message, purpose, speech_targets)

    async def _cancel_tts_tasks(self) -> None:
        tasks = list(self._tts_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._tts_tasks.clear()

    async def _drain_tts_tasks(self, timeout: float = 2.0) -> None:
        tasks = list(self._tts_tasks)
        if not tasks:
            return
        done, pending = await asyncio.wait(tasks, timeout=timeout)
        for task in pending:
            task.cancel()
            self._tts_match_stats['failures'] += 1
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        self._tts_tasks.difference_update(done | pending)

    def _log_llm_match_summary(self) -> None:
        """整场结束写 LLM 统计，并逐条记录各 AI 的吐槽文本。"""
        if self.manager is None:
            return
        reports = []
        for seat, controller in enumerate(self.manager.controllers):
            if not isinstance(controller, LLMPlayer):
                continue
            stats = dict(controller.stats)
            reports.append({
                'seat': seat,
                'providerId': controller.provider_id,
                'model': controller.config.model,
                'style': controller.config.style,
                **stats,
            })
            logger.bind(
                room_id=self.room_id,
                seat=seat,
                provider_id=controller.provider_id,
                model=controller.config.model,
                style=controller.config.style,
                llm_stats=stats,
            ).info(
                'LLM 场次统计 '
                f'请求={stats.get("requests", 0)} 成功={stats.get("successes", 0)} '
                f'回退={stats.get("fallbacks", 0)} 吐槽={stats.get("messages", 0)} '
                f'思考={stats.get("thinkingRequests", 0)} '
                f'升级={stats.get("enhancedReasoningRequests", stats.get("reasoningRequests", 0))} '
                f'非法={stats.get("invalid", 0)}')
        if not reports:
            return
        logger.bind(room_id=self.room_id, llm_seats=reports).info(
            f'LLM 场次汇总 AI座位={len(reports)} 吐槽总数={len(self._llm_messages)}')
        logger.bind(room_id=self.room_id, tts_stats=dict(self._tts_match_stats)).info(
            'TTS 场次统计 '
            f'请求={self._tts_match_stats["requests"]} '
            f'命中={self._tts_match_stats["hits"]} '
            f'未命中={self._tts_match_stats["misses"]} '
            f'成功={self._tts_match_stats["successes"]} '
            f'失败={self._tts_match_stats["failures"]}')
        for entry in self._llm_messages:
            controller = self.manager.controllers[entry['seat']]
            identity = {
                'provider_id': controller.provider_id,
                'model': controller.config.model,
                'style': controller.config.style,
            } if isinstance(controller, LLMPlayer) else {}
            logger.bind(
                room_id=self.room_id,
                seat=entry['seat'],
                llm_message_id=entry['id'],
                **identity,
            ).info(f'LLM 吐槽：{entry["text"]}')

    # ── 落库（storage 注入时生效；纯内存态为空操作）─────────
    # 韧性约定：`_persist_*` 全部"入队 + 尝试补写"，落库失败绝不向上抛——
    # 数据库抖动不中断整场对局，失败项留队列等下次落库机会按序重试。

    def _persist_seat(self, seat: int) -> None:
        """join 后写 room_seats / players 表（同步 sqlite 小操作，调用方在请求线程）。"""
        if self.storage is None:
            return
        state = self.seats[seat]
        self.storage.create_player(state.nickname)
        self.storage.upsert_room_seat(self.room_id, seat, state.nickname, state.rejoin_code,
                                      state.player_id)

    async def _flush_writes(self) -> None:
        """按序补写积压落库；任一失败即停（后续依赖其成功），失败项留待下次。"""
        while self._pending_writes:
            write = self._pending_writes[0]
            try:
                await asyncio.to_thread(write)
            except Exception as exc:
                logger.bind(room_id=self.room_id).warning(
                    f"落库失败，{len(self._pending_writes)} 项待下次补写: {exc}")
                return
            self._pending_writes.pop(0)

    async def _flush_writes_final(self) -> None:
        """终局补写：带退避多次尝试，仍失败只告警（对局已结束，不中断收尾）。"""
        for _ in range(_FLUSH_RETRY_ATTEMPTS):
            await self._flush_writes()
            if not self._pending_writes:
                return
            await asyncio.sleep(_FLUSH_RETRY_DELAY)
        logger.bind(room_id=self.room_id).error(
            f"终局落库未完成，{len(self._pending_writes)} 项数据留在内存")

    async def _persist_match_start(self) -> None:
        if self.storage is None:
            return
        players = [
            {'seat': seat, 'player_id': state.player_id, 'nickname': state.nickname}
            if (state := self.seats[seat]) is not None else
            {'seat': seat, 'player_id': None, 'nickname': PLAYER_SEED[seat]['name']}
            for seat in range(len(self.seats))
        ]

        def write():
            self.match_id = self.storage.create_match(
                self.room_id, self.mode, self.ruleset_id)
            self.storage.update_room_status(self.room_id, 'playing')
            # 记录参赛者身份（战绩真源；room_seats 离房即删，不能作为战绩依据）
            self.storage.upsert_match_players(self.match_id, players)

        self._pending_writes.append(write)
        await self._flush_writes()

    async def _persist_round(self, result: dict) -> None:
        if self.storage is None:
            return
        round_data = self._map_round_result(result)

        def write():
            self.storage.insert_round_result(self.match_id, round_data)

        self._pending_writes.append(write)
        await self._flush_writes()

    async def _persist_match_end(self, final_scores: list) -> None:
        if self.storage is None:
            return

        def write():
            if self.match_id is not None:
                self.storage.finish_match(self.match_id, final_scores)
            self.storage.update_room_status(
                self.room_id, 'finished' if self.status == 'finished' else self.status)

        self._pending_writes.append(write)
        await self._flush_writes_final()

    @staticmethod
    def _map_round_result(result: dict) -> dict:
        """把 manager.make_round_result 的 result 映射为 round_results 表所需的单行 dict。"""
        changes = result.get('scoreChanges', [])
        return {
            'round': result.get('roundLabel', ''),
            'dealer': result.get('dealer', 0),
            'honba': result.get('honba', 0),
            'winner_index': result.get('winnerIndex'),
            'points': result.get('points'),
            'multiplier': result.get('multiplier'),
            'horse_hits': result.get('hits', 0),
            'horses': result.get('horses', []),
            'deltas': [{'playerIndex': c['playerIndex'], 'amount': c['delta']}
                       for c in changes],
            'scores_after': [{'playerIndex': c['playerIndex'], 'score': c['score']}
                             for c in changes],
            'opts': {k: result.get(k) for k in ('fourRed', 'kongBloom', 'robbedKong')},
            'draw': bool(result.get('draw')),
            'winner': result.get('winner'),
        }

    async def _drive(self) -> None:
        """整场对局驱动循环：开局 → 每局结算广播 → 推进 → 终局。"""
        try:
            logger.bind(room_id=self.room_id).info(f"整场开始 mode={self.mode}")
            await self._persist_match_start()
            await self.manager.start_game(self.mode)
            while not self.manager.match_finished:
                if self.manager.phase == 'settled':
                    # 先下发完整结算事实，客户端立即播胡牌演出；发言队列与演出并行，
                    # 只把结算面板挡到发言完成（对齐单机的视觉和语音顺序）。
                    presentation_key = self._settlement_presentation_key()
                    self._round_speech_pending = self._has_legacy_audio_audience() and any(
                        isinstance(controller, LLMPlayer) for controller in self.manager.controllers)
                    speech_pending = self._round_speech_pending
                    self._settlement_snapshot_released = True
                    self.broadcast_snapshot()
                    try:
                        await self._announce_llm_round_reactions(self.manager.result or {})
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        logger.exception('赛后 AI 感言队列失败，直接放行结算')
                    finally:
                        self._round_speech_pending = False
                        if speech_pending and presentation_key:
                            self.conn.broadcast({
                                'kind': 'round_speech_done',
                                'presentationKey': presentation_key,
                            })
                    self.conn.broadcast({
                        'kind': 'hand_result',
                        'result': self._result_with_presentation_key(),
                    })
                    await self._persist_round(self.manager.result)
                    logger.bind(room_id=self.room_id).info(f"第{self.manager.round}局结算")
                    # 确认屏障：等所有在线真人点「继续」（10s 倒计时 / 兜底超时）再进下一局
                    await self._wait_for_continue()
                    self._settlement_snapshot_released = False
                    await self.manager.next_round()
                elif self.manager.phase == 'lobby':
                    break
                else:
                    await asyncio.sleep(0)
            if self.manager.phase == 'finished':
                self.status = 'finished'
            final_scores = [
                {'seat': p.seat, 'name': p.name, 'score': p.score}
                for p in self.manager.players
            ]
            await self._drain_tts_tasks()
            self._log_llm_match_summary()
            self.conn.broadcast({
                'kind': 'match_finished',
                'roomId': self.room_id,
                'mode': self.mode,
                'rulesetId': self.ruleset_id,
                'finalScores': final_scores,
            })
            await self._persist_match_end(final_scores)
            # 准备态保留（2026-09-10 用户决定：一场结束后各座位仍是「已准备」，房主可
            # 直接再开一场，不必全员重新点准备）。不回 lobby 状态，保留 finished 供记录/重连快照展示。
            # 对局结束时已超过 60 分钟限时 → 自动释放房间（close 内会广播 room_closed）
            if self.is_past_deadline():
                room_registry.remove(self.room_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.status = 'error'
            self.conn.broadcast({'kind': 'error', 'code': 'INTERNAL_ERROR'})
            logger.bind(room_id=self.room_id).exception("对局驱动异常，整场终止")
            raise

    def _final_scores(self) -> list:
        """终局分数列表（无 manager 时为空：强制收尾可能发生在任何阶段）。"""
        if self.manager is None:
            return []
        return [{'seat': p.seat, 'name': p.name, 'score': p.score} for p in self.manager.players]

    # ── 强制收尾（看门狗）───────────────────────────────

    def force_finish(self, reason: str = 'stalled', *, cancel_task: bool = True) -> bool:
        """强制收尾当前场次，返回是否真的收尾了（幂等，非对局中返回 False）。

        **纯同步、绝不 await**：与 _drive 的收尾路径存在竞态——_drive 可能在任意
        await 点被取消，此刻再 await 什么就可能互相等待或重复收尾。所以这里只做
        状态切换 + 广播；落库与房间回收交给 finalize_forced()（由调用方 await）。

        cancel_task：asyncio.Task.cancel() **不是线程安全的**。只有事件循环里的
        看门狗可以传 True；REST 线程池触发的清扫只处理「任务已死」类，一律 False。
        """
        if self._forced_finishing or self.status != 'playing':
            return False
        self._forced_finishing = True
        self.status = 'finished'
        # 令 manager 的口径与房间一致：正常终局由 _drive→next_round 成对设置
        # match_finished 与 phase='finished'，强制收尾绕过了那条路径，不补这两步会让
        # REST 的 matchFinished / phase 与 status='finished' 互相矛盾（房间已结束却仍
        # 报着对局中的阶段，例如 'thinking'）。
        if self.manager is not None:
            self.manager.match_finished = True
            self.manager.phase = 'finished'
        # _drive 的 `except asyncio.CancelledError: raise` 不会误把取消当异常置 error。
        if cancel_task and self.game_task is not None and not self.game_task.done():
            self.game_task.cancel()
        # 对局已判死：在途 TTS 不再播（正常路径由 _drain_tts_tasks 收口）。
        for task in list(self._tts_tasks):
            task.cancel()
        self._tts_tasks.clear()
        final_scores = self._final_scores()
        # 与 _drive 正常终局同一字段形状；forced 让前端/日志能区分强制与打完。
        self.conn.broadcast({
            'kind': 'match_finished',
            'roomId': self.room_id,
            'mode': self.mode,
            'rulesetId': self.ruleset_id,
            'finalScores': final_scores,
            'forced': True,
        })
        logger.bind(room_id=self.room_id).warning(
            f"对局被强制收尾 reason={reason} 场次={self.match_id}")
        return True

    async def finalize_forced(self) -> None:
        """强制收尾后的善后：落库收口 + 按限时口径回收房间（不新写 DB 路径）。"""
        await self._persist_match_end(self._final_scores())
        # 与 _drive 同一口径：收尾时已超过房间限时 → 释放房间（close 内广播 room_closed）
        if self.is_past_deadline():
            room_registry.remove(self.room_id)

    def close(self) -> None:
        """关闭房间：通知在位客户端后取消游戏任务，落库 closed 状态。

        _drive 在对局结束超时释放房间时会回调（当前任务即 game_task），
        此时跳过自我取消，避免对已近完成的整场驱动注入 CancelledError。
        无事件循环线程（REST 同步路由线程池 / 测试清理）里 current_task() 抛错，
        此时一律正常取消游戏任务。
        """
        self.status = 'closed'
        for task in list(self._tts_tasks):
            task.cancel()
        self._tts_tasks.clear()
        self.conn.broadcast({'kind': 'room_closed'})
        logger.bind(room_id=self.room_id).info("房间关闭")
        try:
            current = asyncio.current_task()
        except RuntimeError:
            current = None
        if self.game_task is not None and not self.game_task.done() \
                and current is not self.game_task:
            self.game_task.cancel()
        if self.storage is not None:
            self.storage.update_room_status(self.room_id, 'closed')


class RoomRegistry:
    """内存房间注册表（Phase 6 由 REST 层接管创建；当前供 WS 端点与测试使用）。

    限时清扫：get/create 时惰性清扫超过 60 分钟限时的房间（带节流）；
    对局中的房间不回收，由 _drive 在对局结束超时时释放。
    """

    def __init__(self) -> None:
        self._rooms: dict[str, RoomSession] = {}
        self._last_sweep = 0.0
        self._sweep_interval = 60.0   # 惰性清扫节流：至少间隔 60s 才真正遍历

    def create(self, room_id: str, **kwargs) -> RoomSession:
        self._maybe_sweep()
        if room_id in self._rooms:
            raise RoomError('ROOM_EXISTS')
        if kwargs.get('ruleset_id') == 'lotus-blood-flow':
            from app.game.blood_flow_room import BloodFlowRoomSession
            room = BloodFlowRoomSession(room_id, **kwargs)
        else:
            room = RoomSession(room_id, **kwargs)
        self._rooms[room_id] = room
        return room

    def get(self, room_id: str) -> Optional[RoomSession]:
        self._maybe_sweep()
        return self._rooms.get(room_id)

    def count(self) -> int:
        """当前在册房间数（房间数上限检查用）。"""
        return len(self._rooms)

    def find_room_by_player(self, player_id: str) -> Optional[RoomSession]:
        """按匿名身份（guestId）定位其所在房间：该 player_id 是否已在某房间占座。

        用于阻止「已在房间/对局中的玩家再开新房」（跨标签页 / 绕过前端守卫）。
        """
        for room in self._rooms.values():
            for state in room.seats:
                if state is not None and state.player_id == player_id:
                    return room
        return None

    def _maybe_sweep(self) -> None:
        now = time.monotonic()
        if now - self._last_sweep < self._sweep_interval:
            return
        self._last_sweep = now
        self.sweep_expired(now)

    def peek(self, room_id: str) -> Optional[RoomSession]:
        """按房间码取会话，**不触发任何惰性清扫**。

        看门狗收尾用：get() 会顺带 sweep_expired，而收尾正需要「读一下房间」这个
        动作不产生「读一下就杀房间」的副作用。
        """
        return self._rooms.get(room_id)

    def sweep_stalled(self, now: Optional[float] = None, *,
                      allow_cancel: bool = False) -> list[str]:
        """强制收尾僵尸/卡死对局，返回被收尾的房间码列表。

        allow_cancel=False（REST 线程池等非事件循环线程）时只处理「任务已死」的
        僵尸房间——它们没有任何任务要取消，pure 同步收尾是安全的；而卡死类
        （任务仍活着）必须由事件循环里的看门狗带着 allow_cancel=True 处理，
        因为 asyncio.Task.cancel() 不是线程安全的。

        **不接进 _maybe_sweep**：那会让 rooms.get() 产生「读一下就杀房间」的副作用，
        也会让只做查询的测试变得 flaky。看门狗与 create_room 显式调用本方法。
        """
        finished: list[str] = []
        for rid, room in list(self._rooms.items()):
            if not is_match_stalled(room, now):
                continue
            if not allow_cancel and match_is_driving(room):
                continue
            if room.force_finish('stalled', cancel_task=allow_cancel):
                finished.append(rid)
        return finished

    def sweep_expired(self, now: Optional[float] = None) -> list[str]:
        """回收所有过期的空房间，返回被回收的房间码列表（供测试直接触发）。"""
        now = now if now is not None else time.monotonic()
        expired = [rid for rid, room in list(self._rooms.items()) if room.is_expired(now)]
        for rid in expired:
            logger.bind(room_id=rid).info("房间到期回收")
            self.remove(rid)
        return expired

    def remove(self, room_id: str) -> None:
        room = self._rooms.pop(room_id, None)
        if room is not None:
            room.close()

    def clear(self) -> None:
        for room_id in list(self._rooms):
            self.remove(room_id)


# 共享房间注册表（Phase 6 起由 REST 层创建，WS 层读取；测试通过它注入/清理房间）
room_registry = RoomRegistry()


# ─── 常驻看门狗 ──────────────────────────────────────────
# 僵尸房间既不能 start（ALREADY_STARTED）也不能 close（ROOM_PLAYING），并长期
# 占着 MAX_ROOMS 槽位，所以必须有事件循环里的常驻兜底，而不是只靠惰性清扫。

async def _room_watchdog_loop(registry: RoomRegistry) -> None:
    """定期收尾僵尸/卡死对局。单次清扫失败只记日志，绝不退出循环。"""
    logger.info(
        f"房间看门狗启动 interval={ROOM_WATCHDOG_INTERVAL}s match_max={ROOM_MATCH_MAX}s")
    while True:
        await asyncio.sleep(ROOM_WATCHDOG_INTERVAL)
        try:
            finished = registry.sweep_stalled(allow_cancel=True)
            for room_id in finished:
                room = registry.peek(room_id)
                if room is not None:
                    await room.finalize_forced()
        except asyncio.CancelledError:
            raise
        except Exception:
            # 落库/回收失败不能带走整个看门狗：下个周期继续兜底。
            logger.exception("房间看门狗清扫异常（已跳过，继续运行）")


def start_room_watchdog(registry: Optional[RoomRegistry] = None) -> Optional[asyncio.Task]:
    """启动常驻看门狗任务；ROOM_WATCHDOG_INTERVAL<=0 → 返回 None（关闭）。

    必须在事件循环里调用（uvicorn lifespan），任务随之绑定该循环。
    """
    if ROOM_WATCHDOG_INTERVAL <= 0:
        logger.info("房间看门狗未启动（ROOM_WATCHDOG_INTERVAL<=0）")
        return None
    return asyncio.create_task(_room_watchdog_loop(registry or room_registry))
