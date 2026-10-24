"""房间 REST API —— 房间生命周期管理（创建 / 加入 / 离开 / 准备 / 开局）

Phase 6 起房间生命周期由本层接管：
- POST   /api/rooms            创建房间（mode / capacity），签发 6 位房间码
- GET    /api/rooms/meta       服务器房间容量（active 在册数 / max 上限，大厅「剩余房间」用）
- GET    /api/rooms/{id}       房间详情 + 座位表 + 准备状态
- POST   /api/rooms/{id}/join  加入（占座 + 签发 rejoinCode，写 room_seats 落库）
- POST   /api/rooms/{id}/leave 离开（释放座位）
- POST   /api/rooms/{id}/ready 切换准备态
- POST   /api/rooms/{id}/start 开局（所有已占真人座位 ready 后触发）

认证（首版轻量）：座位级操作带 rejoinCode 校验，防止误操作他人座位。
路由全部定义为同步函数 → FastAPI 自动放线程池，不阻塞事件循环。
"""

import os
import secrets
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from loguru import logger
from pydantic import BaseModel, Field

from app.api.deps import AuthenticatedUser, require_wakudemo_login
from app.game.anime_characters import resolve_anime_character_id
from app.game.manager import PLAY_PACE
from app.game.room import (
    RoomError,
    RoomSession,
    match_finished_of,
    match_id_of,
    match_phase_of,
    room_registry,
)
from app.llm.config import (LLM_STYLES, default_provider_id,
                            llm_server_available, load_llm_providers)
from app.llm.persona import avatar_url, default_nickname
from app.storage.db import storage

router = APIRouter(prefix='/api/rooms', tags=['rooms'])

# 本服务器最多同时存在的房间数（可环境变量覆盖）
MAX_ROOMS = int(os.environ.get('ROOM_MAX', '4'))

# 6 位房间码字母表：去掉易混淆字符（0/O、1/I、U）
_ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'


def _new_room_id() -> str:
    while True:
        code = ''.join(secrets.choice(_ROOM_ALPHABET) for _ in range(6))
        if room_registry.get(code) is None:
            return code


def _room_or_404(room_id: str) -> RoomSession:
    room = room_registry.get(room_id)
    if room is None:
        raise HTTPException(status_code=404, detail={'code': 'ROOM_NOT_FOUND'})
    return room


def _safe_avatar_url(value: str | None) -> str:
    """只接受 http(s) 头像 URL（平台头像字段未在审核期定稿，防御性校验）。"""
    if not value or len(value) > 2048:
        return ''
    if not value.startswith(('https://', 'http://')):
        return ''
    return value


def _llm_providers_public() -> list[dict]:
    """服务端提供商公开信息（不含 key）：房主选择用的 id/名称/模型/风格/昵称/头像。"""
    result = []
    for provider in load_llm_providers().values():
        result.append({
            'id': provider.provider_id,
            'name': provider.name,
            'model': provider.model,
            'style': provider.style,
            'styles': list(LLM_STYLES),
            'nickname': provider.nickname or default_nickname(
                provider.base_url, provider_id=provider.provider_id),
            'avatar': avatar_url(provider.base_url, provider.style,
                                 provider.avatar_folder, provider.provider_id),
        })
    return result


def _verify_seat(room: RoomSession, seat: int, rejoin_code: str) -> None:
    """座位级操作身份校验：该座位存在且重进码匹配。"""
    state = room.seats[seat] if 0 <= seat < room.player_count else None
    if state is None:
        raise HTTPException(status_code=404, detail={'code': 'SEAT_EMPTY'})
    if state.rejoin_code != rejoin_code:
        raise HTTPException(status_code=403, detail={'code': 'INVALID_REJOIN_CODE'})


def _reserved_seats_payload(room: RoomSession) -> list[dict]:
    """房主预留的空位（大模型专属，真人不可占）：只下发 providerId/style，不含任何 key。"""
    return [
        {'seat': seat, 'providerId': item['providerId'], 'style': item.get('style') or None}
        for seat, item in sorted(room.reserved_seats.items())
    ]


def _room_response(room: RoomSession) -> dict:
    return {
        'roomId': room.room_id,
        'mode': room.mode,
        'rulesetId': room.ruleset_id,
        'capacity': room.capacity,
        'status': room.status,
        # 场次身份：客户端据此判断「房间里正进行的是不是我等的那一场」。
        # matchId 是内存真源（会被下一场覆盖），本人那场以 WS rejoin_ok 的 matchId 为准。
        'matchId': match_id_of(room),
        'matchFinished': match_finished_of(room),
        'phase': match_phase_of(room),
        'creatorSeat': room.creator_seat,
        'timeLimitSeconds': room.lifetime,  # 房间限时（前端静态提示用）
        'llmEnabled': room.llm_enabled,
        'effectiveLlmEnabled': room.effective_llm_enabled,
        'llmAvailable': room.llm_available,
        'seats': [
            None if state is None else {
                'seat': state.seat,
                'nickname': state.nickname,
                'characterId': state.character_id,
                'ready': state.ready,
                'connected': state.controller.connected,
            }
            for state in room.seats
        ],
        # 房主预留的空位（真人不可占）；其余空位「自动选择」= 真人可占、空着由默认提供商补位。
        'reservedSeats': _reserved_seats_payload(room),
    }


# ─── 请求 / 响应模型 ─────────────────────────────────────

class CreateRoomRequest(BaseModel):
    mode: Literal['east', 'hanchan'] = 'east'
    capacity: int = Field(default=4, ge=2, le=4)
    playerId: Optional[str] = Field(default=None, max_length=64)  # 已废弃：联机身份由登录会话推导
    rulesetId: Literal['lotus-classic', 'lotus-legacy', 'lotus-blood-flow'] = 'lotus-classic'
    # 空座 AI 补位是否使用大模型（服务端未配置时静默降级为 False）
    llmEnabled: bool = False


class JoinRequest(BaseModel):
    nickname: str = Field(min_length=1, max_length=20)
    playerId: Optional[str] = Field(default=None, max_length=64)  # 已废弃：联机身份由登录会话推导
    # 只做长度边界；未知/非法值由角色白名单归一化为 DeepSeek，而不是返回 422。
    characterId: Optional[str] = Field(default=None, max_length=64)


class SeatActionRequest(BaseModel):
    seat: int = Field(ge=0, le=3)
    rejoinCode: str
    ready: Optional[bool] = None  # ready 动作可选显式指定


class CharacterUpdateRequest(BaseModel):
    seat: int = Field(ge=0, le=3)
    rejoinCode: str
    characterId: Optional[str] = Field(default=None, max_length=64)


class SeatLlmRequest(BaseModel):
    """每座位引用的服务端提供商（只带 id；key 不下发/不携带）。"""
    seat: int = Field(ge=0, le=3)
    providerId: str = Field(min_length=1, max_length=32)
    style: Optional[Literal['激进', '稳健', '话痨', '高冷']] = None


class StartRoomRequest(BaseModel):
    llmSeats: list[SeatLlmRequest] = Field(default_factory=list)


class LlmSeatReservationRequest(BaseModel):
    """房主为某个空位写/清大模型预留：省略 providerId = 取消预留（改回「自动选择」）。"""
    seat: int = Field(ge=0, le=3)            # 房主自己的座位（身份校验）
    rejoinCode: str
    reserveSeat: int = Field(ge=0, le=3)     # 要预留 / 取消预留的空位
    providerId: Optional[str] = Field(default=None, max_length=32)
    style: Optional[Literal['激进', '稳健', '话痨', '高冷']] = None


# ─── 路由 ────────────────────────────────────────────────

@router.post('')
def create_room(body: CreateRoomRequest,
                user: AuthenticatedUser = Depends(require_wakudemo_login)) -> dict:
    """创建房间（需登录）。同一房间码唯一，重复创建 → ROOM_EXISTS。

    联机身份由登录会话推导（wakudemo-<uid>），客户端 playerId 不再参与身份判定。
    防重复占房：该登录身份已在某个房间占座（含对局中）→ ALREADY_IN_ROOM，
    阻止跨标签页/绕过前端守卫再开新房。
    房间数上限：先清扫到期房间（绕过惰性节流，确保到期房释放槽位），
    在册房间已达 MAX_ROOMS → ROOM_LIMIT_REACHED（客户端提示「房间已满」）。
    """
    if room_registry.find_room_by_player(user.player_id) is not None:
        raise HTTPException(status_code=409, detail={'code': 'ALREADY_IN_ROOM'})
    room_registry.sweep_expired()
    # 顺带收尾「任务已死」的僵尸对局房：否则它们既不参与 TTL 回收（playing 豁免）
    # 又会把槽位占满，玩家看到的是 ROOM_LIMIT_REACHED 而实际一个活房间都没有。
    # 这里在 REST 线程池里跑 ⇒ 不传 allow_cancel（卡死类交给事件循环的看门狗）。
    room_registry.sweep_stalled()
    # 收尾后 status 不再是 playing ⇒ 过期的那些随即被 TTL 通道回收（真正释放槽位）。
    # 未过期的僵尸房变成普通 finished 房：座位上的人可重开或关闭，不再两头堵死。
    room_registry.sweep_expired()
    if room_registry.count() >= MAX_ROOMS:
        raise HTTPException(status_code=409, detail={'code': 'ROOM_LIMIT_REACHED'})
    room_id = _new_room_id()
    try:
        # 真人联机房间注入视觉节奏（AI 出牌/碰杠有可读延迟，对齐前端 PACE_MS）；
        # 测试直接构造 RoomSession 不经此路径，保持默认 0 加速
        room = room_registry.create(
        room_id, mode=body.mode, capacity=body.capacity, storage=storage,
            pace=PLAY_PACE, ruleset_id=body.rulesetId, llm_enabled=body.llmEnabled)
    except RoomError as exc:
        logger.bind(room_id=room_id).warning(f"创建房间失败 {exc}")
        raise HTTPException(status_code=409, detail={'code': str(exc)})
    storage.create_room(room_id, body.mode, body.capacity, body.rulesetId)
    storage.update_room_status(room_id, 'lobby')
    logger.bind(room_id=room_id).info(f"创建房间 mode={body.mode} capacity={body.capacity}")
    return _room_response(room)


@router.get('/meta')
def get_room_meta(_: AuthenticatedUser = Depends(require_wakudemo_login)) -> dict:
    """服务器房间容量（需登录）：active = 当前在册房间数，max = 上限。

    客户端大厅展示「剩余房间」用。先清扫到期房间，保证计数与实际可建槽位一致
    （对齐 create_room 的 ROOM_LIMIT_REACHED 判定）。定义在 /{room_id} 之前，
    避免「meta」被当作房间码匹配。
    llmProviders：服务端注册的提供商（不含 key），房主建房时按 id 选择。
    """
    room_registry.sweep_expired()
    return {'active': room_registry.count(), 'max': MAX_ROOMS,
            'llmAvailable': llm_server_available(),
            'llmProviders': _llm_providers_public()}


@router.get('/{room_id}')
def get_room(room_id: str,
             _: AuthenticatedUser = Depends(require_wakudemo_login)) -> dict:
    return _room_response(_room_or_404(room_id))


@router.post('/{room_id}/join')
def join_room(room_id: str, body: JoinRequest,
              user: AuthenticatedUser = Depends(require_wakudemo_login)) -> dict:
    """加入（需登录）：占第一个空座并签发 rejoinCode（写 room_seats / players 落库）。

    联机身份由登录会话推导（wakudemo-<uid>），客户端 playerId 忽略。
    头像优先级：登录会话携带平台头像（http/https URL）→ 直接用并落库；
    否则回退服务端随机头像（按身份持久化）。
    新玩家仅可加入大厅（lobby）与已结束（finished）房间；原账号可在
    对局中（playing）取回已有座位与重进码，不会重复占座。
    """
    room = _room_or_404(room_id)
    # 同一账号回到原房间时取回原座位与重进码；仍禁止跨房占座。
    occupied_room = room_registry.find_room_by_player(user.player_id)
    if occupied_room is not None and occupied_room is not room:
        raise HTTPException(status_code=409, detail={'code': 'ALREADY_IN_ROOM'})
    if room.status not in ('lobby', 'finished') and not (
            occupied_room is room and room.status == 'playing'):
        raise HTTPException(status_code=409, detail={'code': 'ROOM_CLOSED'})
    preferred_avatar = _safe_avatar_url(user.avatar_url)
    try:
        character_id = resolve_anime_character_id(body.characterId)
        seat, is_rejoin, state = room.join_or_rejoin(
            body.nickname, player_id=user.player_id, character_id=character_id,
            avatar=preferred_avatar)
    except RoomError as exc:
        logger.bind(room_id=room_id).warning(f"加入房间失败 {exc}")
        raise HTTPException(status_code=409, detail={'code': str(exc)})
    logger.bind(room_id=room_id, seat=seat).info(
        f"加入房间 昵称={state.nickname} 重进={is_rejoin} player_id={state.player_id}")
    return {
        'roomId': room.room_id,
        'seat': seat,
        'nickname': state.nickname,
        'characterId': state.character_id,
        'rejoinCode': state.rejoin_code,
        'playerId': state.player_id,
        'rejoin': is_rejoin,
    }


@router.post('/{room_id}/character')
def update_character(room_id: str, body: CharacterUpdateRequest) -> dict:
    """加入后更新本家二次元角色：仅大厅/已结束状态、开局前可改。

    角色只影响表现层（头像、立绘、TTS 台词、结算强调色），开局后由快照锁定，
    因此 playing 状态拒绝更新。
    """
    room = _room_or_404(room_id)
    _verify_seat(room, body.seat, body.rejoinCode)
    try:
        character_id = room.set_character(body.seat, resolve_anime_character_id(body.characterId))
    except RoomError as exc:
        logger.bind(room_id=room_id, seat=body.seat).warning(f"更新角色失败 {exc}")
        raise HTTPException(status_code=409, detail={'code': str(exc)})
    return {'roomId': room.room_id, 'seat': body.seat, 'characterId': character_id}


@router.post('/{room_id}/leave')
def leave_room(room_id: str, body: SeatActionRequest) -> dict:
    """离开：释放座位（带 rejoinCode 身份校验）。

    释放后若房间已无任何真人座位 → 立即解散（无论对局状态）：避免全员离开后
    空房间一直占着注册表槽位（对局中全员退出时同样生效，取消这场没人看的对局）。
    房主离开但仍有其他真人 → 房间保留、房主顺延给下一座位（`release_seat` 内转移）；
    解散只来自房主显式「关闭房间」、全员离开或房间限时回收——2026-09-10 用户决定
    去掉「非对局中房主离开即解散」，否则「返回大厅」的暂离/退出会误解散整间房。
    """
    room = _room_or_404(room_id)
    _verify_seat(room, body.seat, body.rejoinCode)
    room.release_seat(body.seat)
    if not room.has_humans():
        room_registry.remove(room_id)
    logger.bind(room_id=room_id, seat=body.seat).info("离开房间")
    return {'roomId': room.room_id, 'seat': body.seat, 'left': True}


@router.post('/{room_id}/ready')
def ready_room(room_id: str, body: SeatActionRequest) -> dict:
    """准备 / 取消准备：返回该座位当前准备态。"""
    room = _room_or_404(room_id)
    _verify_seat(room, body.seat, body.rejoinCode)
    ready = room.ready_seat(body.seat, body.ready)
    logger.bind(room_id=room_id, seat=body.seat).debug(f"准备态 ready={ready}")
    return {'roomId': room.room_id, 'seat': body.seat, 'ready': ready}


@router.post('/{room_id}/start')
async def start_room(room_id: str, body: Optional[StartRoomRequest] = None) -> dict:
    """开局：所有已占（真人）座位 ready 后触发，独立 game_task 驱动整场。

    async 以便 game_task 创建在事件循环线程（与 WS 处理器一致）。
    body.llmSeats：每座位引用服务端提供商 id + 策略（空 = 用服务端默认）；
    未知 id / 重复座位 → 409 INVALID_LLM_SEATS（key 全在服务端，不涉及回显）。
    """
    room = _room_or_404(room_id)
    entries = [
        {
            'seat': item.seat,
            'providerId': item.providerId.strip().lower(),
            'style': item.style,
        }
        for item in (body.llmSeats if body else [])
    ]
    if entries:
        providers = load_llm_providers()
        seats = [entry['seat'] for entry in entries]
        if len(set(seats)) != len(seats) \
                or not all(entry['providerId'] in providers for entry in entries):
            raise HTTPException(status_code=409, detail={'code': 'INVALID_LLM_SEATS'})
    try:
        await room.start(llm_seats=entries, default_provider=default_provider_id())
    except RoomError as exc:
        logger.bind(room_id=room_id).warning(f"开局失败 {exc}")
        raise HTTPException(status_code=409, detail={'code': str(exc)})
    logger.bind(room_id=room_id).info(f"开局触发 status={room.status}")
    return {'roomId': room.room_id, 'status': room.status}


@router.post('/{room_id}/llm-seats')
def reserve_llm_seat(room_id: str, body: LlmSeatReservationRequest) -> dict:
    """房主为某个空位写 / 清大模型预留（该座位真人不可入，开局按预留装配）。

    语义：房主在房间面板为某空位**显式选择**模型 = 该座预留给大模型；
    改回「自动选择」（省略 providerId）= 取消预留，真人可占、空着仍由默认提供商补位。
    预留是房间级状态：房主刷新 / 换人 / 开下一局都保留，随房间信息 reservedSeats 下发。
    """
    room = _room_or_404(room_id)
    _verify_seat(room, body.seat, body.rejoinCode)
    if room.creator_seat != body.seat:
        raise HTTPException(status_code=403, detail={'code': 'NOT_CREATOR'})
    if room.status not in ('lobby', 'finished'):
        raise HTTPException(status_code=409, detail={'code': 'ROOM_CLOSED'})
    provider_id = (body.providerId or '').strip().lower()
    if provider_id:
        if not room.effective_llm_enabled:
            raise HTTPException(status_code=409, detail={'code': 'LLM_NOT_ENABLED'})
        if provider_id not in load_llm_providers():
            raise HTTPException(status_code=409, detail={'code': 'INVALID_LLM_SEATS'})
    try:
        room.set_reserved_seat(body.reserveSeat, provider_id or None, body.style)
    except RoomError as exc:
        logger.bind(room_id=room_id, seat=body.reserveSeat).warning(f"预留设置失败 {exc}")
        raise HTTPException(status_code=409, detail={'code': str(exc)})
    logger.bind(room_id=room_id, seat=body.reserveSeat).info(
        f"预留座位更新 provider={provider_id or '取消预留'}")
    return {'roomId': room.room_id, 'reservedSeats': _reserved_seats_payload(room)}


@router.delete('/{room_id}')
def close_room(room_id: str, body: SeatActionRequest) -> dict:
    """关闭房间：仅创建者可执行（带 rejoinCode 身份校验），解散房间并取消对局任务。

    对局中（playing）不允许关闭 —— 创建者可先「退出对局」释放座位。
    """
    room = _room_or_404(room_id)
    _verify_seat(room, body.seat, body.rejoinCode)
    if room.creator_seat != body.seat:
        raise HTTPException(status_code=403, detail={'code': 'NOT_CREATOR'})
    if room.status == 'playing':
        raise HTTPException(status_code=409, detail={'code': 'ROOM_PLAYING'})
    logger.bind(room_id=room_id, seat=body.seat).info("关闭房间")
    room_registry.remove(room_id)
    return {'roomId': room_id, 'closed': True}
