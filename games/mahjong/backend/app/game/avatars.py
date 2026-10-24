"""座位头像解析 —— 经典房间与血流房间共用同一优先级。

优先级：平台登录头像（preferred）> 该 player_id 已落库头像 > 外部随机头像
（首次取图并落库）> 空串（前端回退座位默认头像）。

两个玩法共用同一 player_id，头像必须同源：否则同一玩家进血流房间时会退化成
座位默认头像，而经典房间已经按平台头像/随机头像落库（同一账号换玩法就换脸）。
"""

import json
import os
import urllib.request
from typing import Optional

from loguru import logger

# 外部随机头像 API（可环境变量覆盖；测试 monkeypatch fetch_random_avatar 不触网）。
AVATAR_API_URL = os.environ.get(
    'AVATAR_API_URL', 'https://api.ruseo.cn/api/tx?type=1&imgtype=5')


def fetch_random_avatar() -> str:
    """从外部 API 取一个随机头像图片 URL；网络/解析失败返回 ''（前端回退座位默认头像）。

    接口返回 JSON：{"code":0,"data":{"msg":"https://res.apihz.cn/img/tx/<hash>.jpg"}}。
    每次请求返回不同图片，因此必须把返回的 URL 落库（player_avatars）才能跨房间/场次稳定。
    """
    try:
        with urllib.request.urlopen(AVATAR_API_URL, timeout=3) as resp:
            payload = json.loads(resp.read().decode('utf-8'))
        url = payload.get('data', {}).get('msg', '')
        return url if isinstance(url, str) and url.startswith('http') else ''
    except Exception:
        logger.warning("随机头像获取失败，回退默认头像")
        return ''


def resolve_seat_avatar(preferred: str, player_id: Optional[str], storage,
                        fetch_random=None) -> str:
    """解析座位头像：平台头像优先（并落库），否则复用已落库头像，再否则取一次随机头像。

    无 storage / 无 player_id（纯内存态：单机与多数单测）时不触网，返回空串。
    fetch_random 可注入（默认 app.game.avatars.fetch_random_avatar，测试可打补丁）。
    """
    if preferred:
        if storage is not None and player_id:
            storage.set_player_avatar(player_id, preferred)
        return preferred
    if storage is None or not player_id:
        return ''
    avatar = storage.get_player_avatar(player_id)
    if avatar:
        return avatar
    avatar = (fetch_random or fetch_random_avatar)()
    if avatar:
        storage.set_player_avatar(player_id, avatar)
    return avatar
