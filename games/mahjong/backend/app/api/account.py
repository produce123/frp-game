"""账号级 REST API —— 纯娱乐声明同意记录（跨设备记住「首次确认」）

- GET /api/players/by-id/{player_id}/disclaimer-agreement  查询是否已同意（含版本号）
- PUT /api/players/by-id/{player_id}/disclaimer-agreement  记录同意（幂等）
- GET /api/me/disclaimer-agreement                         当前登录玩家的声明记录（联机）
- PUT /api/me/disclaimer-agreement                         记录当前登录玩家同意（幂等）

单机按匿名身份 player_id（guestId）存储；联机按登录身份 wakudemo-<uid> 存储：
换浏览器 / 清 localStorage 后仍能在服务端记住「已确认」。声明文案有实质修改时
把 DISCLAIMER_VERSION +1（与前端 src/content/disclaimer.ts 的 DISCLAIMER_VERSION
同步），已确认旧版的用户需重新确认。
"""

from fastapi import APIRouter, Depends
from loguru import logger
from pydantic import BaseModel, Field

from app.api.deps import AuthenticatedUser, require_wakudemo_login
from app.storage.db import storage

router = APIRouter(tags=['account'])

# 声明版本号：与前端 src/content/disclaimer.ts 的 DISCLAIMER_VERSION 保持同步。
DISCLAIMER_VERSION = 1


class DisclaimerAgreementRequest(BaseModel):
    version: int = Field(default=1, ge=1)


@router.get('/api/players/by-id/{player_id}/disclaimer-agreement')
def get_disclaimer_agreement(player_id: str) -> dict:
    """查询某玩家是否已同意声明（返回其同意的版本号，供前端比对当前版本）。"""
    row = storage.get_disclaimer_agreement(player_id)
    if row is None:
        return {'playerId': player_id, 'agreed': False}
    return {'playerId': player_id, 'agreed': True,
            'version': row['version'], 'agreedAt': row['agreed_at']}


@router.put('/api/players/by-id/{player_id}/disclaimer-agreement')
def put_disclaimer_agreement(player_id: str, body: DisclaimerAgreementRequest) -> dict:
    """记录玩家同意声明（幂等）。"""
    storage.set_disclaimer_agreement(player_id, body.version)
    logger.bind(player_id=player_id).info(f"记录声明同意 version={body.version}")
    return {'playerId': player_id, 'agreed': True, 'version': body.version}


@router.get('/api/me/disclaimer-agreement')
def get_my_disclaimer_agreement(
        user: AuthenticatedUser = Depends(require_wakudemo_login)) -> dict:
    """查询当前登录玩家是否已同意声明（联机身份 wakudemo-<uid>）。"""
    return get_disclaimer_agreement(user.player_id)


@router.put('/api/me/disclaimer-agreement')
def put_my_disclaimer_agreement(
        body: DisclaimerAgreementRequest,
        user: AuthenticatedUser = Depends(require_wakudemo_login)) -> dict:
    """记录当前登录玩家同意声明（幂等，联机身份 wakudemo-<uid>）。"""
    return put_disclaimer_agreement(user.player_id, body)
