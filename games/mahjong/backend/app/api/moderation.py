"""风控 API —— 封禁 / 举报（Phase 8 P1：反赌博风控，见开发计划 §10）

- POST   /api/admin/bans                   封禁（player/room/device，含原因/操作者）
- DELETE /api/admin/bans/{scope}/{target}   解封
- POST   /api/reports                      玩家举报（记录举报人/被举报人/房间/原因）

封禁即时生效：join 与 WS 重连握手处查禁（room.py 的 join_or_rejoin / resume_by_code），
命中返回 BANNED。首版无管理端鉴权（内部工具）；上真账号体系后再收紧。
"""

from typing import Literal

from fastapi import APIRouter, Depends
from loguru import logger
from pydantic import BaseModel, Field

from app.api.deps import AuthenticatedUser, require_wakudemo_login
from app.game.room import room_registry
from app.storage.db import storage

router = APIRouter(tags=['moderation'])


class BanRequest(BaseModel):
    scope: Literal['player', 'room', 'device'] = 'player'
    target: str = Field(min_length=1, max_length=64)
    reason: str = ''
    bannedBy: str = ''


class ReportRequest(BaseModel):
    roomId: str = ''
    reporterPlayerId: str = Field(default='', max_length=64)  # 已废弃：举报人由登录会话推导
    targetPlayerId: str = Field(default='', max_length=64)   # 可选：不传则由昵称反查
    targetName: str = ''
    reason: str = ''


@router.post('/api/admin/bans')
def ban(body: BanRequest) -> dict:
    storage.ban_target(body.scope, body.target, body.reason, body.bannedBy)
    logger.bind(scope=body.scope, target=body.target).info(
        f"封禁 reason={body.reason} by={body.bannedBy}")
    return {'banned': True, 'scope': body.scope, 'target': body.target}


@router.delete('/api/admin/bans/{scope}/{target}')
def unban(scope: Literal['player', 'room', 'device'], target: str) -> dict:
    storage.unban(scope, target)
    logger.bind(scope=scope, target=target).info("解封")
    return {'banned': False, 'scope': scope, 'target': target}


@router.post('/api/reports')
def report(body: ReportRequest,
           user: AuthenticatedUser = Depends(require_wakudemo_login)) -> dict:
    # 举报人身份由登录会话推导；目标优先用前端提供的 playerId，
    # 否则按房间内昵称反查座位 player_id（便于封禁落地）
    reporter_id = user.player_id
    target_id = body.targetPlayerId
    if not target_id and body.roomId:
        room = room_registry.get(body.roomId)
        if room is not None:
            target_id = next(
                (s.player_id for s in room.seats
                 if s is not None and s.nickname == body.targetName), '')
    storage.add_report(body.roomId, reporter_id,
                       target_id, body.targetName, body.reason)
    logger.bind(room_id=body.roomId, reporter=reporter_id).info(
        f"举报 target={target_id} targetName={body.targetName} reason={body.reason}")
    return {'reported': True}
