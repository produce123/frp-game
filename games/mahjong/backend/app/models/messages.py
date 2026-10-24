"""WebSocket 消息协议 —— 从开发计划 §4 草案落地为 Pydantic 模型

消息格式：JSON 对象。两类消息方向：
- 客户端 → 服务端（`ClientAction`）：动作「意图」，由服务端校验后执行，防作弊
- 服务端 → 客户端（`ServerMessage` 各 kind）：请求 / 广播 / 快照

与现有代码对应关系（见开发计划 §4.2）：
- turn_request / claim_request / rob_kong_request ← PlayerController.request_*
- table_action ← show_table_action() 的 TableActionEvent
- score_flow ← show_score_flow() 的 ScoreFlowEvent
- state_snapshot ← useGame 暴露的响应式状态
- hand_result ← finalizeWin() 的 result
"""

from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.models.game import TileType
from app.game.player import ClaimContext, RobKongContext, TurnContext

# ─── 客户端 → 服务端 ─────────────────────────────────────

# 客户端动作类型（协议 §4.1）
ClientActionType = Literal['discard', 'claim', 'gang', 'hu', 'pass', 'ping']


class ClientAction(BaseModel):
    """客户端动作意图。校验在 RemotePlayer.handle_action 按当前请求类型进行，
    这里只做形状描述（字段全可选，避免误拒客户端格式变体）。"""
    type: ClientActionType
    handIndex: Optional[int] = None          # discard
    action: Optional[Literal['peng', 'gang', 'chi', 'pass']] = None   # claim
    optionIndex: Optional[int] = None
    kind: Optional[Literal['added', 'concealed', 'wind', 'self_draw', 'rob_kong']] = None  # gang / hu
    tile: Optional[TileType] = None          # gang / hu


# ─── 服务端 → 客户端：请求（定向）────────────────────────

def turn_request(ctx: TurnContext) -> dict:
    """回合请求（定向）：轮到某玩家摸牌后，请求其出牌/胡/杠。"""
    return {'kind': 'turn_request', 'ctx': ctx.model_dump(by_alias=True)}


def claim_request(ctx: ClaimContext) -> dict:
    """碰/杠响应请求（定向）：他家弃牌后，询问本家是否碰/杠/过。"""
    return {'kind': 'claim_request', 'ctx': ctx.model_dump(by_alias=True)}


def rob_kong_request(ctx: RobKongContext) -> dict:
    """抢杠响应请求（定向）：他家补杠后，询问本家是否抢杠胡/过。"""
    return {'kind': 'rob_kong_request', 'ctx': ctx.model_dump(by_alias=True)}


# ─── 服务端 → 客户端：广播 / 快照 ────────────────────────

def table_action_message(event: dict) -> dict:
    """桌面动作事件（全房间广播）。event 为 TableActionEvent 的 dict。"""
    return {'kind': 'table_action', 'event': event}


def score_flow_message(deltas: list) -> dict:
    """分数流水事件（全房间广播）。"""
    return {'kind': 'score_flow', 'deltas': deltas}


def announcement_message(text: str, tone: str = 'gold', id: Optional[int] = None) -> dict:
    """播报（全房间广播）。id 供客户端去重（公告随快照重复携带）。"""
    return {'kind': 'announcement', 'text': text, 'tone': tone, 'id': id}


def state_snapshot_message(**state) -> dict:
    """全量状态快照（rejoin / 阶段切换时下发，客户端以其为唯一真源）。"""
    return {'kind': 'state_snapshot', **state}


def hand_result_message(result: dict) -> dict:
    """单局结算（全房间广播）。"""
    return {'kind': 'hand_result', 'result': result}


def match_finished_message(final_scores: list, room_id: str, mode: str) -> dict:
    """整场结束（全房间广播）。"""
    return {'kind': 'match_finished', 'roomId': room_id, 'mode': mode, 'finalScores': final_scores}


# ─── 服务端 → 客户端：连接 / 错误 ────────────────────────

def rejoin_ok_message(*, seat: int, rejoin: bool, room_id: str, mode: str,
                      nickname: str, rejoin_code: str) -> dict:
    """重连/加入成功。rejoin=True 表示通过重进码恢复原座位。"""
    return {
        'kind': 'rejoin_ok',
        'seat': seat,
        'rejoin': rejoin,
        'roomId': room_id,
        'mode': mode,
        'nickname': nickname,
        'rejoinCode': rejoin_code,
    }


def rejoin_err_message(code: str) -> dict:
    """重连/加入失败。"""
    return {'kind': 'rejoin_err', 'code': code}


def error_message(code: str) -> dict:
    """动作被拒。"""
    return {'kind': 'error', 'code': code}
