"""战绩 REST API —— 对局查询 / 玩家统计

- GET  /api/matches/{id}           单场详情（含各局 round_results）
- GET  /api/rooms/{id}/matches     房间历史对局列表（概览）
- GET  /api/players/{nickname}/stats 个人统计（首版简化）

路由全部定义为同步函数 → FastAPI 自动放线程池，不阻塞事件循环。
"""

from fastapi import APIRouter, Depends, HTTPException
from loguru import logger

from app.api.deps import AuthenticatedUser, require_wakudemo_login
from app.game.room import room_registry
from app.storage.db import storage

router = APIRouter(tags=['matches'])


@router.get('/api/matches/{match_id}')
def get_match(match_id: str) -> dict:
    """单场详情：对局元数据 + finalScores + 每局结算明细。"""
    match = storage.get_match(match_id)
    if match is None:
        logger.bind(match_id=match_id).warning("对局不存在")
        raise HTTPException(status_code=404, detail={'code': 'MATCH_NOT_FOUND'})
    return match


@router.get('/api/rooms/{room_id}/matches')
def list_room_matches(room_id: str) -> dict:
    """房间历史对局列表。"""
    if room_registry.get(room_id) is None:
        logger.bind(room_id=room_id).warning("房间不存在")
        raise HTTPException(status_code=404, detail={'code': 'ROOM_NOT_FOUND'})
    return {
        'roomId': room_id,
        'matches': storage.list_room_matches(room_id),
    }


@router.get('/api/players/{nickname}/stats')
def get_player_stats(nickname: str) -> dict:
    """个人统计（按昵称，旧版）：场次 / 参与局数 / 胡牌局数 / 总净胜分。"""
    logger.bind(nickname=nickname).debug("查询战绩")
    return storage.get_player_stats(nickname)


@router.get('/api/players/by-id/{player_id}/stats')
def get_player_stats_by_id(player_id: str) -> dict:
    """个人统计（按匿名身份 player_id / guestId，单机）：改名不丢历史、重名不混。"""
    logger.bind(player_id=player_id).debug("查询战绩")
    return storage.get_player_stats_by_id(player_id)


@router.get('/api/me/stats')
def get_my_stats(user: AuthenticatedUser = Depends(require_wakudemo_login)) -> dict:
    """当前登录玩家的个人统计（按 wakudemo-<uid>）：联机战绩绑定登录身份。"""
    logger.bind(player_id=user.player_id).debug("查询我的战绩")
    return storage.get_player_stats_by_id(user.player_id)
