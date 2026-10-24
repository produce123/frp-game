"""游戏状态机 —— 从 src/game/useGame.ts 翻译

GameManager 是房间内的权威状态机，房间内异步串行执行（asyncio 驱动）。
与 useGame 的差异：
- ref()/reactive()/computed() → 普通 Python 类属性
- later()/setTimeout → 可配置 PACE 延迟（默认 0 加速模拟），asyncio.sleep
- playSound/showTableAction/showScoreFlow/announce → GameEvents 广播（默认空实现，
  Phase 5 由 WebSocket 层注入）
- HumanController → RemotePlayer（Phase 5）
- 开局/和牌动画阶段（dealing/win-effect/revealing）保留为内部流转，
  由 begin_turn/end_game 同步推进到 settled，无需 UI 定时器

对外关键接口：
- start_game(mode) / next_round() / return_to_lobby()
- 状态：phase / players / wall / current_player / round / dealer / honba / result / match_finished

注意：TS 端用定时器调度回合（调用栈恒定浅），本实现用 async 递归串联整局
（begin_turn → discard_tile → begin_turn），深度 O(每局动作数) 约几千层，
单场对局结束即释放，因此提高递归限制以容纳整场对局的调用链。
"""

import asyncio
import random
import sys
from types import SimpleNamespace
from typing import Optional, Protocol

from loguru import logger

# 容纳整场对局（东风 4 局 ≈ 数千次动作）的 async 递归调用链
sys.setrecursionlimit(10000)

from app.models.game import GamePlayer, Meld, TileType
from app.core.tiles import shuffle, sort_tiles, sort_tiles_with_jokers
from app.core.actions import perform_chi, perform_discard_gang, perform_peng, remove_matches
from app.core.hand_progress import clear_hand_progress_caches
from app.game.player import AI_DELAYS, AIPlayer, ClaimContext, RobKongContext, TurnContext
from app.rules.base import GameRuleSet
from app.rules.fans import FanContext
from app.rules.lianhua import get_default_rule_set
from app.settlement import SettlementService, settlement_service

# ─── 场次常量（对应 useGame.ts MATCH_HANDS / MATCH_NAMES）────────

MATCH_HANDS = {'east': 4, 'hanchan': 8}
MATCH_NAMES = {'east': '东风场', 'hanchan': '半庄场'}

# 默认玩家种子（对应 PLAYER_SEED）
PLAYER_SEED = [
    {'name': '北冥重生', 'avatar': 'avatars/lotus.svg', 'score': 1000},
    {'name': '南粤阿乐', 'avatar': 'avatars/ah-lok.svg', 'score': 1000},
    {'name': '西关十三姨', 'avatar': 'avatars/shisan.svg', 'score': 1000},
    {'name': '东山少爷', 'avatar': 'avatars/young-master.svg', 'score': 1000},
]

# 视觉节奏延迟（动画展示用；后端默认 0 以加速模拟，可注入覆盖）
DEFAULT_PACE = {
    'afterDiscardToNextTurn': 0,
    'afterClaimGang': 0,
    'afterClaimPeng': 0,
    'afterKongSettle': 0,
    'beforeRobKong': 0,
    'betweenRobKongs': 0,
    'skipDrawPengDelay': 0,
    'openingDelayStart': 0,   # 首局开局表现等待（对局开始 + 骰子 + 发牌动画）
    'openingDelay': 0,        # 后续局开局表现等待（骰子 + 发牌动画）
    'redKongDraw': 0,         # 红中花杠亮杠后到补摸的停顿（人类节奏）
}

# 真人联机房间的视觉节奏（REST create 注入，对齐前端 PACE_MS：动画可读、AI 不瞬移）
PLAY_PACE = {
    'afterDiscardToNextTurn': 450,
    'afterClaimGang': 550,
    'afterClaimPeng': 650,
    'afterKongSettle': 600,
    'beforeRobKong': 650,
    'betweenRobKongs': 450,
    'skipDrawPengDelay': 350,
    # 开局表现等待：对齐前端 useRemoteGame 的开局动画时长
    # （每局都播 start 1250 + 骰子 1150 + 发牌 3720 ≈ 6120ms；客户端逐局展示「xx场·xx局」提示）
    # 服务端在此窗口暂停推进，避免 AI 在客户端动画期间先行，导致客户端追状态 / 回合计时错位。
    'openingDelayStart': 6400,
    'openingDelay': 6400,
    # 红中花杠：亮杠（动画 + 音效）后停顿再补摸，人类正常速度
    'redKongDraw': 600,
}


# ─── 表现副作用接口（Phase 5 由 WebSocket 层实现广播）────────

class GameEvents(Protocol):
    def show_table_action(self, type_: str, actor_index: int, source_index: Optional[int],
                          tile: TileType, meld_index: int) -> None: ...
    def show_score_flow(self, deltas: list[dict]) -> None: ...
    def announce(self, text: str, tone: str = 'gold', id: Optional[int] = None) -> None: ...
    def play_sound(self, name: str, volume: Optional[float] = None) -> None: ...
    async def play_sound_and_wait(self, name: str, volume: Optional[float] = None) -> None: ...
    def snapshot(self) -> None: ...
    def round_start(self, match_started: bool, round_: int, dealer: int,
                    honba: int, dice: list[int], second_dice: Optional[list[int]],
                    flip_tile: Optional[TileType] = None,
                    flip_stack: Optional[int] = None,
                    flip_seat: Optional[int] = None) -> None: ...
    async def wait_for_opening(self) -> None: ...


class NullEvents:
    """默认空实现：测试 / 无 WebSocket 时使用"""

    def show_table_action(self, *a, **k) -> None:
        pass

    def show_score_flow(self, *a, **k) -> None:
        pass

    def announce(self, *a, **k) -> None:
        pass

    def play_sound(self, *a, **k) -> None:
        pass

    async def play_sound_and_wait(self, *a, **k) -> None:
        pass

    def snapshot(self) -> None:
        pass

    def round_start(self, *a, **k) -> None:
        pass

    async def wait_for_opening(self) -> None:
        pass


# ─── 场次推进（对应 useGame.ts advanceMatchState，纯函数）──────

def advance_match_state(*, round_, dealer, honba, match_type, result, scores=None, player_count=4) -> dict:
    """庄家连庄 + 本场累加 / 轮庄推进 → 终局判断。

    连庄规则：胡牌且赢家为庄家 → 连庄；流局且庄家听牌 → 连庄；否则下庄。
    """
    draw = bool(result.get('draw'))
    dealer_keeps_seat = (
        (not draw and result.get('winnerIndex') == dealer)
        or (draw and result.get('dealerTenpai'))
    )
    if dealer_keeps_seat:
        next_state = {'round': round_, 'dealer': dealer, 'honba': honba + 1}
    else:
        next_state = {'round': round_ + 1, 'dealer': (dealer + 1) % player_count, 'honba': 0}
    return {
        **next_state,
        'finished': next_state['round'] > MATCH_HANDS[match_type],
    }


# ─── 和牌关键牌解析（对应 useGame.ts resolveWinTile）────────

def resolve_win_tile(
    winner: GamePlayer,
    options: Optional[dict] = None,
    rule_set: Optional[GameRuleSet] = None,
) -> TileType:
    """四红中 → red；否则 options.winTile → 刚摸到的牌 → 手牌末张。"""
    return (rule_set or get_default_rule_set()).resolve_win_tile(winner, options or {})


def structural_meld_count(player: GamePlayer) -> int:
    """公开副露数（结构性，不含花杠），用于胡牌判断。"""
    return sum(1 for meld in player.melds if meld.type != 'flower')


# ─── GameManager ───────────────────────────────────────────

class GameManager:
    """单房间游戏状态机。房间内所有流程串行 await 执行，无并发竞态。"""

    def __init__(self, mode: str = 'east', controllers: Optional[list] = None,
                 player_count: int = 4, random=None, events: Optional[GameEvents] = None,
                 pace: Optional[dict] = None, player_seeds: Optional[list] = None,
                 room_id: Optional[str] = None, rule_set: Optional[GameRuleSet] = None,
                 settlements: Optional[SettlementService] = None):
        self.match_type = mode
        self.player_count = player_count
        # 房间级日志上下文：RoomSession 注入 room_id 后，对局日志带房间号便于查错
        self.room_id = room_id
        self._log = logger.bind(room_id=room_id) if room_id else logger
        self.rules = rule_set or get_default_rule_set()
        self.settlements = settlements or settlement_service
        # 默认控制器对齐前端 AiController 的 AI_DELAYS（人类思考速度）；
        # 测试路径显式传入 0 延迟 AIPlayer，不受此默认影响。
        self.controllers = controllers or [
            AIPlayer(delays=AI_DELAYS, rule_set=self.rules) for _ in range(player_count)
        ]
        for controller in self.controllers:
            if hasattr(controller, 'set_rule_set'):
                controller.set_rule_set(self.rules)
        # 玩家种子：联网房间用「座位昵称」覆盖默认种子（AI 座位保留 PLAYER_SEED）
        self.seeds = player_seeds or PLAYER_SEED
        self._random = random
        self.events: GameEvents = events or NullEvents()
        self.pace = {**DEFAULT_PACE, **(pace or {})}

        # 当前玩家可变引用 box：与 actions.py 的 ActionContext.current_player 共享
        self.phase = 'lobby'
        self.players: list[GamePlayer] = []
        self._cp_box = SimpleNamespace(value=-1)
        self._table_context = SimpleNamespace(
            players=self.players,
            current_player=self._cp_box,
            show_table_action=self.events.show_table_action,
            show_score_flow=self.events.show_score_flow,
            play_sound=self.events.play_sound,
            rules=self.rules,
            settlements=self.settlements,
        )
        self._id_counter = 0
        self._llm_seq = 0

        # 状态
        self.wall: list[TileType] = []
        self._head_drawn = 0   # 从牌头累计摸走的张数（区别于牌尾 pop 的杠/红中补张）
        self.kong_draw_player_index = -1
        self.selected_index = -1
        self.last_discard: Optional[dict] = None
        self.first_discard_pending = False
        # 跟庄：开局第一圈，庄家首弃后三家各出一张同牌 → 庄家付三家各一底分。
        # 与 first_discard_pending 一样在 __init__ 初始化，begin_round 每局复位。
        self.follow_dealer: dict = {'active': False, 'started': False, 'tile': None, 'followed': []}
        self.action_prompt: Optional[dict] = None
        self.pending_kong: Optional[dict] = None
        self.announcement: Optional[dict] = None
        self.result: Optional[dict] = None
        self.win_presentation: Optional[dict] = None
        self.winning_player_index = -1
        self.round = 1
        self.dealer = 0
        self.honba = 0
        self.dice = [1, 1]
        self.second_dice = [1, 1]
        self.flip_tile: Optional[TileType] = None
        self.joker_tiles: list[TileType] = []
        self.wildcard_tiles: list[TileType] = []
        self.flip_stack: Optional[int] = None
        self.opening_stack: Optional[int] = None
        self.wall_break_index = 0
        self.match_finished = False
        self.user_drew_this_turn = False

    # ── current_player：property 读写共享 box，与 actions.py 保持一致 ──

    @property
    def current_player(self) -> int:
        return self._cp_box.value

    @current_player.setter
    def current_player(self, value: int) -> None:
        self._cp_box.value = value

    # ── 座位工具 ──

    def seat_distance(self, from_: int, to: int) -> int:
        return (to - from_ + len(self.players)) % len(self.players)

    def _is_human(self, player_index: int) -> bool:
        """该座位是否为真人（RemotePlayer）；空座位/代打为 AIPlayer。

        控制器只有 RemotePlayer（真人）与 AIPlayer（AI 补位）两种，故用
        `not isinstance(..., AIPlayer)` 判定，避免在这里 import RemotePlayer。
        """
        return not isinstance(self.controllers[player_index], AIPlayer)

    def _sort_hand(self, hand: list[TileType]) -> list[TileType]:
        """整理手牌：莲花麻将把精牌固定排最左侧（对齐前端 sortTilesWithJokers）。"""
        if self.rules.code == 'lotus-legacy':
            return sort_tiles_with_jokers(hand, self.joker_tiles)
        return sort_tiles(hand)

    def _visible_tiles_for(self, player_index: int) -> list[TileType]:
        """该玩家的可见牌：自己手牌+副露+弃牌，他人只算弃牌+副露（对齐前端 visibleTilesFor）。"""
        result: list[TileType] = []
        for index, player in enumerate(self.players):
            if index == player_index:
                result.extend(player.hand)
            result.extend(player.discards)
            for meld in player.melds:
                result.extend(meld.tiles)
        return result

    def _public_tiles_for(self) -> list[TileType]:
        """公开可见牌：所有玩家的弃牌 + 副露（对齐前端 publicTilesFor）。"""
        result: list[TileType] = []
        for player in self.players:
            result.extend(player.discards)
            for meld in player.melds:
                result.extend(meld.tiles)
        return result

    def _upper_last_discard_for(self, player_index: int) -> Optional[TileType]:
        """该玩家上家最近一张弃牌（用于安全度评估）。"""
        upper_index = (player_index - 1 + len(self.players)) % len(self.players)
        discards = self.players[upper_index].discards
        return discards[-1] if discards else None

    # ── LLM 局况/版本（§6.2/§6.4）───────────────────────────────

    _SEAT_WINDS = ('东', '南', '西', '北')
    ROUND_LAPS = {'east': '东', 'hanchan': '东', 'hanchan2': '南'}

    def _seat_wind(self, player_index: int) -> str:
        winds = self._SEAT_WINDS
        return winds[(player_index - self.dealer) % len(winds)]

    def _round_wind(self) -> str:
        if self.match_type == 'hanchan' and self.round > 4:
            return '南'
        return '东'

    def _peers_snapshot(self) -> list[dict]:
        """各座位公开弃牌与副露（按座位绝对索引；只读副本）。"""
        return [
            {
                'discards': list(player.discards),
                'melds': [{'type': meld.type, 'tile': meld.tile, 'tiles': list(meld.tiles)}
                          for meld in player.melds],
            }
            for player in self.players
        ]

    def _next_request_id(self, kind: str, player_index: int) -> str:
        self._llm_seq += 1
        return f'{kind}-{player_index}-{self._llm_seq}'

    def _state_version(self) -> str:
        tile_count = sum(
            len(player.hand) + len(player.discards)
            + sum(len(meld.tiles) for meld in player.melds)
            for player in self.players
        )
        return ':'.join(str(part) for part in (
            self.round, self.phase, len(self.wall), self._head_drawn,
            self.current_player, tile_count,
        ))

    def _llm_meta(self, player_index: int, kind: str, dihu: bool = False) -> dict:
        """LLM 局况/可见/版本（与前端 llmContext 同构）。"""
        return {
            'playerIndex': player_index,
            'scores': [player.score for player in self.players],
            'peers': self._peers_snapshot(),
            'seatWind': self._seat_wind(player_index),
            'roundWind': self._round_wind(),
            'dealerIndex': self.dealer,
            'roundIndex': self.round,
            'dihu': dihu,
            'requestId': self._next_request_id(kind, player_index),
            'stateVersion': self._state_version(),
        }

    def _early_round_for(self, player_index: int) -> bool:
        """是否早局（弃牌 < 2 张，用于字牌惩罚调权）。"""
        return len(self.players[player_index].discards) < 2

    # ── 表现副作用转发 ──

    def _show_table_action(self, type_, actor_index, source_index, tile, meld_index) -> None:
        self.events.show_table_action(type_, actor_index, source_index, tile, meld_index)

    def _show_score_flow(self, deltas) -> None:
        self.events.show_score_flow(deltas)

    def _announce(self, text, tone='gold') -> None:
        self._id_counter += 1
        self.announcement = {'text': text, 'tone': tone, 'id': self._id_counter}
        # id 随广播下发：客户端按 id 去重（公告随快照重复携带，不能重复弹出）
        self.events.announce(text, tone, id=self._id_counter)

    def _play_sound(self, name, volume=None) -> None:
        self.events.play_sound(name, volume)

    async def _play_sound_and_wait(self, name, volume=None) -> None:
        await self.events.play_sound_and_wait(name, volume)

    def _broadcast_snapshot(self) -> None:
        """每次状态变更后广播全量快照（客户端以快照为唯一真源）。"""
        self.events.snapshot()

    async def _sleep(self, ms: int) -> None:
        if ms and ms > 0:
            await asyncio.sleep(ms / 1000)

    def _apply_kong_score(
        self,
        player_index: int,
        type_: str,
        from_index: Optional[int] = None,
    ) -> list[dict]:
        settlement = self.settlements.calculate_kong(
            len(self.players), player_index, type_, self.rules.base_score, from_index)
        self.settlements.apply_deltas(self.players, settlement.deltas)
        return settlement.as_list()

    # ── 跟庄（开局第一圈跟打同牌） ──

    def _interrupt_follow_dealer(self) -> None:
        """吃/碰/杠/胡等打断第一圈的动作发生时，跟庄窗口立即失效。"""
        fd = self.follow_dealer
        if fd:
            fd['active'] = False

    def _check_follow_dealer(self, player_index: int, tile: TileType) -> None:
        """出牌落定后检测跟庄；触发时庄家向三家各付一个底分（不影响牌局进行）。"""
        fd = self.follow_dealer
        if not fd or not self.players:
            return
        if not fd['started']:
            # 开局第一张出牌者必须是庄家（首弃），进入跟庄窗口。
            if player_index != self.dealer:
                return
            fd['started'] = True
            fd['active'] = True
            fd['tile'] = tile
            fd['followed'] = []
            return
        if not fd['active']:
            return
        if (player_index == self.dealer or player_index in fd['followed']
                or tile != fd['tile']):
            fd['active'] = False
            return
        fd['followed'].append(player_index)
        if len(fd['followed']) == 3:
            fd['active'] = False
            settlement = self.settlements.calculate_follow_dealer(
                len(self.players), self.dealer, self.rules.base_score)
            self.settlements.apply_deltas(self.players, settlement.deltas)
            self._show_score_flow(settlement.as_list())
            self._announce('跟庄')

    # ── 发牌与牌墙 ──

    def _reset_players(self) -> None:
        previous = self.players
        self.players = []
        for index, seed in enumerate(self.seeds):
            prior = previous[index] if index < len(previous) else None
            score = prior.score if prior is not None else seed['score']
            if self.rules.code == 'lotus-legacy' and index >= len(previous):
                score = 2000
            self.players.append(GamePlayer(
                name=seed['name'], avatar=seed['avatar'], score=score, seat=index,
                hand=[], discards=[], melds=[], redCount=0, drawnTileIndex=-1,
                characterId=seed.get(
                    'characterId', prior.characterId if prior is not None else None),
                playerKind=seed.get(
                    'playerKind', prior.playerKind if prior is not None else None),
            ))
        self._table_context.players = self.players

    def _take_tile(self, from_tail: bool = False) -> Optional[TileType]:
        if not self.wall:
            return None
        if not from_tail:
            self._head_drawn += 1   # 牌头摸走计数（区别于牌尾 pop 的杠/红中补张）
            return self.wall.pop(0)
        # 每墩在 wall 中按「上层、下层」排列；补摸先取当前尾墩上层（倒数第二张），
        # 再取同墩底层。只剩一张时照常取完，不设置王牌区。
        wall_total = 134 if self.rules.code == 'lotus-legacy' else 136
        tail_drawn = max(0, wall_total - self._head_drawn - len(self.wall))
        tail_index = -2 if tail_drawn % 2 == 0 and len(self.wall) >= 2 else -1
        return self.wall.pop(tail_index)

    def _receive_dealt_tile(self, player: GamePlayer, tile: TileType) -> None:
        """发牌收牌：红中先入正常手牌，发完牌后统一从牌墙尾补杠（见 _resolve_dealt_reds），
        避免发牌过程中牌山就因红中补张而少牌。"""
        player.hand.append(tile)

    def _resolve_dealt_reds(self, seat_order: list) -> None:
        """发完牌后处理红中：若手牌有红中，依次逆时针（庄家起）从牌墙尾补张。"""
        for player_index in seat_order:
            player = self.players[player_index]
            while True:
                flower = next((tile for tile in player.hand if self.rules.is_flower_tile(tile)), None)
                if flower is None:
                    break
                # 已有 3 张红中亮花杠，再发到第 4 张 → 四红中：红中留手牌作胡牌牌，不再亮花杠/补张
                if player.redCount >= 3:
                    player.redCount += 1
                    break
                player.hand.remove(flower)
                player.redCount += 1
                player.melds.append(Meld(type='flower', tile=flower, tiles=[flower]))
                replacement = self._take_tile(True)
                if replacement is None:
                    break
                player.hand.append(replacement)  # 补到红中则由 while 继续转

    def _deal(self, player_index: int, count: int) -> None:
        for _ in range(count):
            tile = self._take_tile(False)
            if tile:
                self._receive_dealt_tile(self.players[player_index], tile)

    def _break_wall_by_dice(self) -> None:
        """骰子决定拆墙点（莲花广麻规则）：
        点数和决定拆哪家墙（5/9→庄，2/6/10→下，3/7/11→对，4/8/12→上，即 (sum-1)%4）；
        较小的点数 n 决定从该墙右起第 n+1 列开始抓（一墩=2 张）。
        各玩家墙段起点对应 3D 环四边：庄=近(0)、下=右(102)、对=远(68)、上=左(34)。
        旋转列表让拆墙处成为前端。与前端 useGame / wallBreakIndex 保持一致（本地/远程同规则）。
        牌已洗乱，从哪拆不影响公平，只为还原真实麻将的「骰子拆墙」观感。不设王牌。
        """
        if not self.wall:
            return
        d1, d2 = self.dice[0], self.dice[1]
        s = d1 + d2
        n = min(d1, d2)
        wall_player = (s - 1) % 4
        segment_start = [0, 102, 68, 34][wall_player]
        break_index = (segment_start + n * 2) % len(self.wall)
        self.wall_break_index = break_index
        self.opening_stack = None
        self.wall = self.wall[break_index:] + self.wall[:break_index]

    # ── 开局 ──

    async def start_game(self, mode: Optional[str] = None) -> None:
        """洗牌 → 发牌（红中花牌补摸）→ 四红中判定 → begin_turn。"""
        if mode and mode in MATCH_HANDS:
            clear_hand_progress_caches()
            self.match_type = mode
            self.round = 1
            self.dealer = 0
            self.honba = 0
            self.match_finished = False
            self.players = []
        self._reset_players()
        self.wall = shuffle(self.rules.create_wall(), self._random)
        self._head_drawn = 0
        self.result = None
        self.win_presentation = None
        self.action_prompt = None
        self.pending_kong = None
        self.user_drew_this_turn = False
        self.selected_index = -1
        self.last_discard = None
        self.first_discard_pending = True
        # 跟庄：开局第一圈，庄家首弃后三家各出一张同牌 → 庄家付三家各一底分。
        self.follow_dealer = {'active': False, 'started': False, 'tile': None, 'followed': []}
        self.phase = 'dealing'

        # 第一骰服务于旧版翻精规则；经典广麻仍只使用一组骰子。
        if self._random is None:
            self.dice = [random.randint(1, 6), random.randint(1, 6)]
        else:
            self.dice = [1 + int(self._random() * 6), 1 + int(self._random() * 6)]
        if self.rules.code == 'lotus-legacy':
            self.second_dice = [
                random.randint(1, 6) if self._random is None else 1 + int(self._random() * 6),
                random.randint(1, 6) if self._random is None else 1 + int(self._random() * 6),
            ]
        else:
            self.second_dice = [1, 1]
        opening = None
        if self.rules.code == 'lotus-legacy':
            opening = self.rules.begin_round(
                dealer=self.dealer, dice=self.dice, second_dice=self.second_dice,
                random=self._random,
            )
            self.wall = opening['wall']
            self.flip_tile = opening['flipTile']
            self.joker_tiles = opening['jokers']
            self.wildcard_tiles = ['white']
            self.flip_stack = opening['flipStack']
            self.opening_stack = opening['openingStack']
            self.wall_break_index = opening['wallBreakIndex']
        else:
            self._break_wall_by_dice()   # 骰子决定拆墙点（本地/远程同规则）

        match_started = (self.round == 1 and self.dealer == 0 and self.honba == 0)
        self.events.round_start(
            match_started, self.round, self.dealer, self.honba, self.dice,
            self.second_dice if self.rules.code == 'lotus-legacy' else None,
            self.flip_tile if opening else None,
            self.flip_stack if opening else None,
            opening['flipSeat'] if opening else None,
        )
        # 「翻精」公告改由客户端在翻精阶段用中文牌名播报（服务端 round_start 阶段的
        # 公告会因 opening.isRunning 被客户端丢弃，且此处只有原始牌码 5m 无中文名）。

        seat_order = [(self.dealer + offset) % len(self.players) for offset in range(len(self.players))]
        for _ in range(3):
            for player_index in seat_order:
                self._deal(player_index, 4)
        # 庄家跳牌：其余三家各补一张之前，庄家先抓上层两张（隔一墩）。
        # 依次从墙头取 5 张：第 1、5 张给庄家（隔开中间），第 2、3、4 张给下家/对家/上家。
        jump_tiles = [self._take_tile(False) for _ in range(5)]
        jump_order = [self.dealer, seat_order[1], seat_order[2], seat_order[3], self.dealer]
        for player_index, tile in zip(jump_order, jump_tiles):
            if tile is not None:
                self._receive_dealt_tile(self.players[player_index], tile)
        # 发完牌后统一处理红中补杠（逆时针从牌墙尾补张），避免发牌中牌山就少牌
        if self.rules.code != 'lotus-legacy':
            self._resolve_dealt_reds(seat_order)

        self.phase = 'opening'
        for player in self.players:
            player.hand = self._sort_hand(player.hand)
        self._broadcast_snapshot()
        self._log.info(f"对局开始 mode={self.match_type} 第{self.round}局 庄家={self.dealer}")

        four_red_winner = next((
            i for i, p in enumerate(self.players)
            if self.rules.should_auto_win_on_flowers(p.redCount)
        ), -1)
        if four_red_winner >= 0 and self.rules.code != 'lotus-legacy':
            self.end_game(four_red_winner, {'fourRed': True})
            return

        if self.rules.code == 'lotus-legacy':
            dealer_hand = self.players[self.dealer].hand
            if self.rules.is_winning_hand(dealer_hand, 0):
                self.end_game(self.dealer, {
                    'tianhu': True, 'selfDraw': True,
                    'winHand': list(dealer_hand),
                    'winTile': dealer_hand[-1],
                })
                return

        self._announce(f'{self.round_label()} · 开牌')
        # 开局就绪屏障：等所有在线真人客户端发牌动画结束（发送 opening_done）再开始首回合，
        # 消除固定延时在慢设备上的「服务端抢跑」（AI 已出牌/副露/胡牌而用户没反应过来）。
        # 无真人（全 AI）或测试路径（NullEvents / pace=None）直接通过，即用即答。
        await self.events.wait_for_opening()
        # 庄家已因跳牌持有 14 张：首回合跳过摸牌直接出牌
        await self.begin_turn(self.dealer, skip_draw=True)

    def round_label(self) -> str:
        wind = '南' if self.round > 4 else '东'
        hand_number = ((self.round - 1) % 4) + 1
        return f'{wind}{hand_number}局'

    # ── 摸牌 ──

    async def draw_for(self, player_index: int, from_tail: bool = False) -> bool:
        """摸牌：红中 → 亮花杠 → 牌墙尾补摸（递归 draw_for）。"""
        player = self.players[player_index]
        self.kong_draw_player_index = player_index if from_tail else -1
        tile = self._take_tile(from_tail)
        if not tile:
            self.end_draw()
            return False
        if self.rules.is_flower_tile(tile):
            player.redCount += 1
            if self.rules.should_auto_win_on_flowers(player.redCount):
                # 四红中：第 4 张红中直接作为胡牌牌进手牌（不再亮花杠/补张），
                # 位置随摸牌最右端，由胡牌展示 splitWinningTile 抽到赢牌位置。
                player.hand = [*player.hand, tile]
                player.drawnTileIndex = len(player.hand) - 1
                self._play_sound('give.mp3', 0.7)
                self.end_game(player_index, {'fourRed': True})
                return False
            player.melds.append(Meld(type='flower', tile=tile, tiles=[tile]))
            self._show_table_action('flower-gang', player_index, None, tile, len(player.melds) - 1)
            await self._play_sound_and_wait('gang.mp3')
            # 亮杠后停顿再补摸：给花杠动画与报杠音效留出人类正常节奏，避免补摸瞬移
            await self._sleep(self.pace['redKongDraw'])
            if self.phase == 'settled':
                return False
            return await self.draw_for(player_index, True)
        # 保留刚摸到的牌在最右端，出牌前不要混入已整理的手牌
        player.hand = [*player.hand, tile]
        player.drawnTileIndex = len(player.hand) - 1
        self._play_sound('give.mp3', 0.7)
        return True

    # ── 回合流转 ──

    async def begin_turn(self, player_index: int, skip_draw: bool = False,
                         from_tail: bool = False, after_claim: Optional[str] = None) -> None:
        """摸牌（draw_for）→ request_turn → 执行动作（胡/补杠/暗杠/弃牌）。"""
        if self.phase == 'settled':
            return
        if not self.wall:
            self.end_draw()
            return
        self.current_player = player_index
        self.user_drew_this_turn = False
        self.phase = 'drawing'
        self.selected_index = -1
        self.action_prompt = None
        if skip_draw:
            self.kong_draw_player_index = -1
        drawn = True if skip_draw else await self.draw_for(player_index, from_tail)
        if not drawn or self.phase == 'settled':
            return
        # 摸牌后立即广播快照：客户端看到刚摸到的牌，再等待该玩家的回合请求
        self._broadcast_snapshot()

        self.phase = 'thinking'
        player = self.players[player_index]
        turn_origin = 'kong-draw' if from_tail else (after_claim or ('opening' if skip_draw else 'draw'))
        # 庄家开局首回合：引擎跳摸，但庄家已持 14 张（跳牌），视作「已摸牌」——
        # 与单机 localTurnOrchestrator 的 preDrawn 同口径（天胡可胡、暗杠/风杠可用）。
        drawn_turn = not skip_draw or turn_origin == 'opening'
        ctx = TurnContext(
            hand=player.hand,
            melds=player.melds,
            exposedMelds=structural_meld_count(player),
            kongBloom=self.kong_draw_player_index == player_index,
            skipDraw=skip_draw,
            afterKong=from_tail,
            turnOrigin=turn_origin,
            drawnTile=(player.hand[player.drawnTileIndex]
                       if not skip_draw and player.drawnTileIndex >= 0 else None),
            jokers=list(getattr(self.rules, 'round_state', None).jokers)
            if self.rules.code == 'lotus-legacy' else ['white'],
            visibleTiles=self._visible_tiles_for(player_index),
            publicTiles=self._public_tiles_for(),
            upperLastDiscard=self._upper_last_discard_for(player_index),
            earlyRound=self._early_round_for(player_index),
            wallCount=len(self.wall),
            canHu=(drawn_turn and self.rules.is_winning_hand(
                player.hand, structural_meld_count(player))),
            canWindKong=bool(
                self.rules.code == 'lotus-legacy'
                and getattr(self.rules, 'wind_kong', lambda _hand: False)(player.hand)
                and drawn_turn
            ),
            **self._llm_meta(player_index, 'turn'),
        )
        action = await self.controllers[player_index].request_turn(ctx)
        # 守卫：游戏可能已在 await 期间结束或轮次已转移
        if self.phase == 'settled' or self.current_player != player_index:
            return

        kind = action['kind']
        # 权威边界：碰/吃后跳摸回合不产生新的自摸/杠机会。即使控制器
        # （含超时代打或旧客户端）错误返回了 win，也不能据此结算。
        if not drawn_turn and kind != 'discard':
            self._log.warning(f'无摸牌回合拒绝动作 seat={player_index} kind={kind}')
            return await self.discard_tile(player_index, 0)
        if kind == 'win':
            self.end_game(player_index, {
                'kongBloom': self.kong_draw_player_index == player_index,
                'selfDraw': True,
            })
            return
        if kind == 'added-kong':
            meld_index = action['meldIndex']
            return await self.request_added_kong(player_index, meld_index, player.melds[meld_index].tile)
        if kind == 'concealed-kong':
            await self.perform_concealed_kong(player_index, action['tile'], no_continue=True)
            if self.phase == 'settled':
                return
            # 真人暗杠后停顿 350ms（对齐单机 kongActionExecutor），AI 直接补摸。
            if self._is_human(player_index):
                await self._sleep(350)
            return await self.begin_turn(player_index, from_tail=True)
        if kind == 'wind-kong':
            await self.perform_wind_kong(player_index)
            if self.phase == 'settled':
                return
            return await self.begin_turn(player_index, from_tail=True)
        if kind == 'discard':
            return await self.discard_tile(player_index, action['handIndex'])

    async def discard_tile(self, player_index: int, hand_index: int) -> None:
        """弃牌 → 找碰/杠候选 → offer_next_claim / 下一家回合。"""
        player = self.players[player_index]
        if not player.hand or not isinstance(hand_index, int) or isinstance(hand_index, bool):
            return
        if not 0 <= hand_index < len(player.hand):
            return
        tile = player.hand.pop(hand_index)
        player.hand = self._sort_hand(player.hand)
        player.drawnTileIndex = -1
        self.kong_draw_player_index = -1
        player.discards.append(tile)
        self._log.debug(f"出牌 seat={player_index} 牌={tile}")
        controller = self.controllers[player_index]
        if hasattr(controller, 'on_discarded'):
            controller.on_discarded()
        self._id_counter += 1
        first_discard = self.first_discard_pending
        self.first_discard_pending = False
        self.last_discard = {
            'tile': tile, 'from': player_index, 'id': self._id_counter,
            'firstDiscard': first_discard,
        }
        self._play_sound('dapai.mp3', 0.8)
        self.phase = 'checking'
        # 跟庄检测（可能触发庄家向三家各付一底分），随后统一广播快照。
        self._check_follow_dealer(player_index, tile)
        self._broadcast_snapshot()

        claimants = self.find_claims(player_index, tile)
        if claimants:
            return await self.offer_next_claim(claimants, tile, player_index)
        await self._sleep(self.pace['afterDiscardToNextTurn'])
        return await self.begin_turn((player_index + 1) % len(self.players))

    # ── 碰/杠候选 ──

    def find_claims(self, from_: int, tile: TileType) -> list[dict]:
        """找可以响应该弃牌的玩家；旧版莲花麻将按胡、杠、碰、吃优先。"""
        if not self.rules.is_claimable_tile(tile):
            return []
        claimants = []
        for player_index, player in enumerate(self.players):
            if player_index == from_:
                continue
            capabilities = self.rules.claim_capabilities(player.hand, tile)
            round_state = getattr(self.rules, 'round_state', None)
            ordinary_jokers = (
                [tile]
                if self.rules.code == 'lotus-legacy'
                and round_state is not None
                and (tile in round_state.jokers or tile == 'white')
                else []
            )
            can_hu = self.rules.code == 'lotus-legacy' and self.rules.is_winning_hand(
                [*player.hand, tile], structural_meld_count(player), ordinary_jokers=ordinary_jokers)
            if can_hu and self.rules.is_any_wait(player.hand, structural_meld_count(player)):
                # 听任意（听口覆盖全部 34 种，典型是单吊精）只能自摸：不提供点炮胡，
                # 地胡依附 can_hu 一并失效（2026-10 规则，前端 lotusRules 同口径）。
                can_hu = False
            options = self.rules.chi_options(player.hand, tile) \
                if self.rules.code == 'lotus-legacy' and self.seat_distance(from_, player_index) == 1 else []
            if can_hu or capabilities.can_peng or capabilities.can_gang or options:
                claimants.append({
                    'playerIndex': player_index,
                    'canHu': can_hu,
                    'dihu': (
                        self.rules.code == 'lotus-legacy'
                        and bool(self.last_discard and self.last_discard.get('firstDiscard'))
                        and from_ == self.dealer
                        and player_index != self.dealer
                        and can_hu
                    ),
                    'canPeng': capabilities.can_peng,
                    'canGang': capabilities.can_gang,
                    'chiOptions': options,
                    'distance': self.seat_distance(from_, player_index),
                })
        claimants.sort(key=lambda item: (
            0 if item.get('canHu')
            else 1 if item.get('canGang')
            else 2 if item.get('canPeng')
            else 3,
            item['distance'],
        ))
        return [
            {'playerIndex': claimant['playerIndex'], 'canHu': claimant.get('canHu', False),
             'dihu': claimant.get('dihu', False),
             'canPeng': claimant.get('canPeng', False),
             'canGang': claimant['canGang'], 'chiOptions': claimant.get('chiOptions', [])}
            for claimant in claimants
        ]

    async def offer_next_claim(self, claimants: list[dict], tile: TileType, from_: int) -> None:
        """按座位顺序询问碰/杠。AI 单次碰+出牌闭环由 ClaimAction.discardIndex 完成。"""
        if not claimants:
            await self._sleep(self.pace['afterDiscardToNextTurn'])
            return await self.begin_turn((from_ + 1) % len(self.players))

        claimant = claimants[0]
        remaining = claimants[1:]
        player = self.players[claimant['playerIndex']]
        ctx = ClaimContext(
            hand=player.hand,
            canGang=claimant['canGang'],
            canPeng=claimant.get('canPeng', False),
            tile=tile,
            from_=from_,
            canHu=claimant.get('canHu', False),
            chiOptions=claimant.get('chiOptions', []),
            exposedMelds=structural_meld_count(player),
            jokers=list(getattr(self.rules, 'round_state', None).jokers)
            if self.rules.code == 'lotus-legacy' else ['white'],
            visibleTiles=self._visible_tiles_for(claimant['playerIndex']),
            publicTiles=self._public_tiles_for(),
            upperLastDiscard=self._upper_last_discard_for(claimant['playerIndex']),
            earlyRound=self._early_round_for(claimant['playerIndex']),
            wallCount=len(self.wall),
            **self._llm_meta(claimant['playerIndex'], 'claim', dihu=claimant.get('dihu', False)),
        )
        action = await self.controllers[claimant['playerIndex']].request_claim(ctx)
        if self.phase == 'settled':
            return

        kind = action['kind']
        if kind == 'pass':
            return await self.offer_next_claim(remaining, tile, from_)
        if kind == 'win':
            self._interrupt_follow_dealer()
            return self.end_game(claimant['playerIndex'], {
                'winTile': tile, 'sourceFrom': from_, 'selfDraw': False,
                'dihu': claimant.get('dihu', False),
            })
        if kind == 'chi':
            self._interrupt_follow_dealer()
            option = claimant['chiOptions'][action.get('optionIndex', 0)]
            perform_chi(self._table_context, claimant['playerIndex'], option, from_)
            self._broadcast_snapshot()
            # 吃牌后停顿对齐单机 PACE_MS.afterClaimPeng（650ms），而非 skipDrawPengDelay（350ms）。
            await self._sleep(self.pace['afterClaimPeng'])
            return await self.begin_turn(claimant['playerIndex'], skip_draw=True, after_claim='chi')
        if kind == 'gang':
            self._interrupt_follow_dealer()
            perform_discard_gang(self._table_context, claimant['playerIndex'], tile, from_)
            self._log.debug(f"座位{claimant['playerIndex']} 杠 {tile}")
            self._broadcast_snapshot()
            # 杠后补摸只由 begin_turn(from_tail) 完成：这里不能再 draw_for，
            # 否则点杠会连摸两张（补摸 + 回合摸），四副露时手牌多一张，不再是单骑。
            # 真人明杠停顿 350ms（对齐单机 lotusHuman），AI 明杠用 afterClaimGang 550ms。
            gang_pause = 350 if self._is_human(claimant['playerIndex']) else self.pace['afterClaimGang']
            await self._sleep(gang_pause)
            return await self.begin_turn(claimant['playerIndex'], from_tail=True)
        # peng
        self._interrupt_follow_dealer()
        perform_peng(self._table_context, claimant['playerIndex'], tile, from_)
        self._log.debug(f"座位{claimant['playerIndex']} 碰 {tile}")
        self._broadcast_snapshot()
        if action.get('discardIndex') is not None:
            await self._sleep(self.pace['afterClaimPeng'])
            return await self.discard_tile(claimant['playerIndex'], action['discardIndex'])
        # 人类：碰后需要互动选弃牌 → 跳过摸牌直接出牌
        await self._sleep(self.pace['skipDrawPengDelay'])
        return await self.begin_turn(claimant['playerIndex'], skip_draw=True, after_claim='peng')

    # ── 杠 ──

    async def perform_concealed_kong(self, player_index: int, tile: TileType, no_continue: bool = False) -> None:
        """暗杠：移除 4 张手牌 → 杠副露 → 结算（其余三家各付底分两倍）。"""
        self._interrupt_follow_dealer()
        player = self.players[player_index]
        player.hand = remove_matches(player.hand, tile, 4)
        player.drawnTileIndex = -1
        player.melds.append(Meld(type='angang', tile=tile, tiles=[tile, tile, tile, tile]))
        score_deltas = self._apply_kong_score(player_index, 'concealed')
        self._show_table_action('concealed-gang', player_index, None, tile, len(player.melds) - 1)
        self._show_score_flow(score_deltas)
        self._play_sound('gang.mp3')
        self._log.debug(f"座位{player_index} 暗杠 {tile}")
        self._broadcast_snapshot()
        if no_continue:
            return
        await self._sleep(self.pace['afterKongSettle'])
        return await self.begin_turn(player_index, from_tail=True)

    async def perform_wind_kong(self, player_index: int) -> None:
        """乱风杠：东南西北各一张，按暗杠结算但四张牌全部明示。"""
        self._interrupt_follow_dealer()
        player = self.players[player_index]
        winds = ['east', 'south', 'west', 'north']
        if not all(wind in player.hand for wind in winds):
            return
        for wind in winds:
            player.hand.remove(wind)
        player.drawnTileIndex = -1
        player.melds.append(Meld(type='angang', tile='east', tiles=winds, windKong=True))
        score_deltas = self._apply_kong_score(player_index, 'concealed')
        self._show_table_action('concealed-gang', player_index, None, 'east', len(player.melds) - 1)
        self._show_score_flow(score_deltas)
        self._play_sound('gang.mp3')
        self._broadcast_snapshot()

    def declare_added_kong(self, player_index: int, meld_index: int, tile: TileType) -> None:
        """声明补杠：碰副露 → 杠副露（pending），等待抢杠询问。"""
        self._interrupt_follow_dealer()
        player = self.players[player_index]
        player.hand = remove_matches(player.hand, tile, 1)
        player.drawnTileIndex = -1
        meld = player.melds[meld_index]
        meld.type = 'gang'
        meld.added = True
        meld.pending = True
        meld.tile = tile
        meld.tiles = [tile, tile, tile, tile]
        self.phase = 'kong'
        self._show_table_action('added-gang', player_index, None, tile, meld_index)
        self._play_sound('gang.mp3')
        self._broadcast_snapshot()

    async def settle_added_kong(self, player_index: int) -> None:
        """补杠结算（其余三家各付底分）→ 补摸回合。"""
        player = self.players[player_index]
        for meld in player.melds:
            if meld.type == 'gang' and meld.added and meld.pending:
                meld.pending = False
                break
        score_deltas = self._apply_kong_score(player_index, 'added')
        self._show_score_flow(score_deltas)
        self._log.debug(f"座位{player_index} 补杠结算")
        self._broadcast_snapshot()
        await self._sleep(self.pace['afterKongSettle'])
        return await self.begin_turn(player_index, from_tail=True)

    def find_robbers(self, kong_player_index: int, tile: TileType) -> list[int]:
        """找可以抢杠的玩家（按距离排序）。"""
        robbers = []
        for player_index, player in enumerate(self.players):
            if player_index != kong_player_index and self.rules.can_rob_kong(
                player.hand, tile, structural_meld_count(player)
            ):
                robbers.append((self.seat_distance(kong_player_index, player_index), player_index))
        robbers.sort(key=lambda item: item[0])
        return [item[1] for item in robbers]

    async def request_added_kong(self, player_index: int, meld_index: int, tile: TileType) -> None:
        """声明补杠 → 依次询问抢杠（找到则 end_game）→ 无抢则补杠结算。"""
        robbers = self.find_robbers(player_index, tile)
        self.declare_added_kong(player_index, meld_index, tile)
        if not robbers:
            await self._sleep(self.pace['beforeRobKong'])
            return await self.settle_added_kong(player_index)

        self.pending_kong = {
            'playerIndex': player_index,
            'meldIndex': meld_index,
            'tile': tile,
            'remainingRobbers': robbers[1:],
        }
        await self._sleep(self.pace['beforeRobKong'])
        return await self.offer_rob_kong(robbers[0])

    async def offer_rob_kong(self, robber_index: int) -> None:
        """询问单个玩家抢杠：抢 → end_game；过 → 下一抢杠候选或补杠结算。"""
        kong = self.pending_kong
        if not kong or self.phase == 'settled':
            return

        robber = self.players[robber_index]
        ctx = RobKongContext(
            tile=kong['tile'],
            from_=kong['playerIndex'],
            hand=robber.hand,
            exposedMelds=structural_meld_count(robber),
        )
        action = await self.controllers[robber_index].request_rob_kong(ctx)
        # 守卫：await 期间游戏可能已结束或 kong 已被处理
        if self.phase == 'settled' or self.pending_kong is not kong:
            return

        if action == 'pass':
            remaining = kong['remainingRobbers']
            if not remaining:
                return await self.settle_added_kong(kong['playerIndex'])
            kong['remainingRobbers'] = remaining[1:]
            await self._sleep(self.pace['betweenRobKongs'])
            return await self.offer_rob_kong(remaining[0])

        self._announce(f'{self.players[robber_index].name} 抢杠胡', 'red')
        self.pending_kong = None
        await self._sleep(self.pace['betweenRobKongs'])
        # end_game 是同步函数（TS 端用 later 调度），直接调用
        return self.end_game(robber_index, {
            'robbedKong': True,
            'robbedKongPlayerIndex': kong['playerIndex'],
            'winTile': kong['tile'],
        })

    # ── 和牌结算 ──

    def take_robbed_kong_tile(self, player_index: int, tile: TileType, winner_index: int) -> int:
        """抢杠后把加杠副露还原为碰副露（取走 3 张），并把被抢的杠牌加入抢杠者手牌，
        保持 134 张牌数守恒（对应前端 lotusSettlement.takeRobbedKongTile）。返回副露索引。"""
        player = self.players[player_index]
        meld_index = -1
        for i, meld in enumerate(player.melds):
            if meld.type == 'gang' and meld.added and meld.pending and meld.tile == tile:
                meld_index = i
                break
        if meld_index < 0:
            return -1
        meld = player.melds[meld_index]
        player.melds[meld_index] = Meld(
            type='peng', tile=meld.tile, from_=meld.from_,
            tiles=meld.tiles[:3], added=None, pending=None,
        )
        self.players[winner_index].hand.append(tile)
        return meld_index

    def end_game(self, winner_index: int, options: Optional[dict] = None) -> None:
        """和牌结束：设置展示信息 → finalize_win（同步推进到 settled）。"""
        if self.phase in ('win-effect', 'revealing', 'settled', 'finished'):
            return
        options = options or {}
        self.phase = 'win-effect'
        self.current_player = -1
        self.user_drew_this_turn = False
        self.action_prompt = None
        self.pending_kong = None
        winner = self.players[winner_index]
        self.winning_player_index = winner_index

        win_tile = resolve_win_tile(winner, options, self.rules)
        robbed_kong_meld_index = (
            self.take_robbed_kong_tile(options['robbedKongPlayerIndex'], win_tile, winner_index)
            if options.get('robbedKong') else -1
        )
        if options.get('robbedKong') or options.get('fourRed'):
            source_index = -1
        elif options.get('sourceFrom') is not None:
            source_index = options['sourceFrom']
        elif winner.drawnTileIndex >= 0:
            source_index = winner.drawnTileIndex
        else:
            source_index = len(winner.hand) - 1 - winner.hand[::-1].index(win_tile) if win_tile in winner.hand else -1

        self.win_presentation = {
            'winnerIndex': winner_index,
            'tile': win_tile,
            'sourceIndex': source_index,
            'robbedKong': bool(options.get('robbedKong')),
            'robbedKongPlayerIndex': options.get('robbedKongPlayerIndex') or -1,
            'robbedKongMeldIndex': robbed_kong_meld_index,
            'discardWin': options.get('sourceFrom') is not None,
        }
        self._show_table_action(
            'robbed-kong-win' if options.get('robbedKong') else (
                'discard-win' if options.get('sourceFrom') is not None else 'self-draw'),
            winner_index,
            options.get('robbedKongPlayerIndex') if options.get('robbedKong')
            else options.get('sourceFrom'),
            win_tile,
            -1,
        )
        self._play_sound('hu.mp3' if options.get('sourceFrom') is not None or options.get('robbedKong') else 'zimo.mp3')
        self.finalize_win(winner_index, options)
        self._log.info(f"和牌 赢家={winner.name} 牌={win_tile} 第{self.round}局")
        self._broadcast_snapshot()

    def finalize_win(self, winner_index: int, options: dict) -> None:
        """胡牌结算：买马 + 算分 + 收付 → result → settled。"""
        winner = self.players[winner_index]
        scores_before = [p.score for p in self.players]
        if self.rules.code == 'lotus-legacy':
            scores_before = [p.score for p in self.players]
            if options.get('sourceFrom') is not None and options.get('winTile'):
                source = self.players[options['sourceFrom']]
                if source.discards and source.discards[-1] == options['winTile']:
                    source.discards.pop()
                # 点炮胡：赢家手牌保持 13 张，第 14 张（和牌）由 winTile 单独携带，
                # 与前端参考实现一致，避免亮牌时对和牌重复计数。
            win_hand = options.get('winHand')
            if win_hand is None:
                win_hand = list(winner.hand)
                # 点炮胡的和牌尚未进入赢家手牌；评分需补入和牌形成完整 14 张手牌。
                # 抢杠胡的和牌已由 take_robbed_kong_tile 推入赢家手牌（14 张），无需再补。
                if options.get('sourceFrom') is not None and options.get('winTile'):
                    win_hand.append(options['winTile'])
            score = self.rules.score_legacy_hand(
                win_hand, structural_meld_count(winner),
                dealer=winner_index == self.dealer,
                self_draw=bool(options.get('selfDraw')),
                robbed_kong=bool(options.get('robbedKong')),
                kong_bloom=bool(options.get('kongBloom')),
                tianhu=bool(options.get('tianhu')),
                dihu=bool(options.get('dihu')),
                win_tile=options.get('winTile'),
                discarder_is_dealer=options.get('sourceFrom') == self.dealer,
            )
            # 天胡/地胡（10 番）走平收：三家等额各付 底分×10，不计庄家/点炮者翻倍。
            opening_win = bool(options.get('tianhu') or options.get('dihu'))
            settlement = self.settlements.calculate_lotus_win(
                len(self.players), winner_index, score['baseFan'],
                winner_index == self.dealer,
                bool(options.get('selfDraw') or options.get('robbedKong') or options.get('kongBloom') or opening_win),
                dealer_index=self.dealer,
                discarder_index=options.get('sourceFrom'),
                equal_payment=opening_win,
            )
            self.settlements.apply_deltas(self.players, settlement.deltas)
            win_type = (
                'tianhu' if options.get('tianhu')
                else 'dihu' if options.get('dihu')
                else 'robbed-kong' if options.get('robbedKong')
                else 'self-draw' if options.get('selfDraw')
                else 'discard'
            )
            self.result = self.make_round_result({
                'winnerIndex': winner_index, 'winner': winner.name,
                'horses': [], 'hits': 0, **score,
                'totalWon': settlement.total_won, 'winType': win_type, **options,
            }, scores_before)
            self.phase = 'settled'
            return

        relative_seat = (winner_index - self.dealer) % len(self.players)
        horses_draw = self.rules.draw_horses(self.wall, seat=relative_seat)
        horses = horses_draw['horses']
        hits = horses_draw['hits']
        # 买马从牌头摸走：头部物理消耗，推进牌头计数（对齐前端从牌头摸）。
        self._head_drawn += len(horses)
        score = self.rules.score_hand(FanContext(
            no_joker=not any(self.rules.is_joker_tile(tile) for tile in winner.hand),
            four_red=bool(options.get('fourRed')),
            kong_bloom=bool(options.get('kongBloom')),
            horse_hits=hits,
            robbed_kong=bool(options.get('robbedKong')),
            # 红中逐张加算：redCount 在摸到红中亮出时已累加（四红中时为 4）。
            red_count=winner.redCount,
        ))
        settlement = self.settlements.calculate_win(
            len(self.players), winner_index, score['points'],
            options.get('robbedKongPlayerIndex') if options.get('robbedKong') else None,
            self.dealer)
        self.settlements.apply_deltas(self.players, settlement.deltas)
        base = {
            'winnerIndex': winner_index,
            'winner': winner.name,
            'horses': horses,
            'hits': hits,
            **score,
            'totalWon': settlement.total_won,
            **options,
        }
        self.result = self.make_round_result(base, scores_before)
        self.phase = 'settled'

    def end_draw(self) -> None:
        """流局：荒庄。各家是否听牌（连庄判断 + 结算展示）；不付点数。

        连庄规则见 advance_match_state：流局庄家听牌 → 连庄，否则下庄。
        """
        self.phase = 'settled'
        self.current_player = -1
        # 与前端 endDraw 对齐：清理可能残留的展示态（快照不会再携带陈旧 winPresentation）
        self.user_drew_this_turn = False
        self.action_prompt = None
        self.win_presentation = None
        self.winning_player_index = -1
        scores_before = [p.score for p in self.players]
        # 听牌：手牌加任意一张可成胡（waiting_tiles 非空）
        tenpai = [i for i, p in enumerate(self.players)
                  if self.rules.waiting_tiles(p.hand, structural_meld_count(p))]
        self._log.info(f"流局 听牌座位={tenpai}")
        self.result = self.make_round_result(
            {'draw': True, 'winner': '荒庄', 'horses': [], 'hits': 0,
             'multiplier': 0, 'points': 0, 'details': [],
             'tenpai': tenpai,
             'dealerTenpai': self.dealer in tenpai,
            },
            scores_before,
        )
        self._broadcast_snapshot()

    def make_round_result(self, base: dict, scores_before: list[int]) -> dict:
        """组装局结果：排名 + 各家分数变化。"""
        ranking = sorted(
            enumerate(self.players),
            key=lambda item: (-item[1].score, item[0]),
        )
        ranks = {player_index: rank for rank, (player_index, _) in enumerate(ranking, start=1)}
        return {
            **base,
            'roundLabel': self.round_label(),
            'honba': self.honba,
            'scoreChanges': [
                {
                    'playerIndex': index,
                    'name': player.name,
                    'avatar': player.avatar,
                    'characterId': player.characterId,
                    'playerKind': player.playerKind,
                    'score': player.score,
                    'delta': player.score - scores_before[index],
                    'rank': ranks.get(index),
                }
                for index, player in enumerate(self.players)
            ],
        }

    # ── 场次推进 ──

    async def next_round(self) -> None:
        """推进场次：庄连庄 + 本场 / 轮庄 → 终局判断 → 下一局。"""
        if not self.result or self.match_finished:
            return
        nxt = advance_match_state(
            round_=self.round,
            dealer=self.dealer,
            honba=self.honba,
            match_type=self.match_type,
            result=self.result,
            player_count=len(self.players),
        )
        self.round = nxt['round']
        self.dealer = nxt['dealer']
        self.honba = nxt['honba']
        if nxt['finished']:
            self.match_finished = True
            self.phase = 'finished'
            self._log.info(f"整场结束 {self.match_type}")
            self._broadcast_snapshot()
            return
        await self.start_game()

    def return_to_lobby(self) -> None:
        self.phase = 'lobby'
        self.result = None
        self.win_presentation = None
        self.winning_player_index = -1
        self.match_finished = False
        self.players = []
        self._broadcast_snapshot()
