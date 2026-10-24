"""声明同意 REST API 测试 —— 首次确认落库 / 重复确认幂等 / 按身份隔离

- GET  /api/players/by-id/{player_id}/disclaimer-agreement  未同意 → agreed:false
- PUT  .../disclaimer-agreement                             记录同意（幂等）
- 版本号随同意落库，供前端比对当前声明版本
"""

import pytest
import httpx

from app.api.account import DISCLAIMER_VERSION


@pytest.fixture()
def temp_storage(tmp_path, monkeypatch):
    """临时 SQLite 库，替换 account 层全局 storage（写盘隔离）。"""
    from app.storage.db import Storage
    s = Storage(str(tmp_path / 'test.db'))
    s.init()
    import app.api.account as account_api
    monkeypatch.setattr(account_api, 'storage', s)
    return s


@pytest.mark.asyncio
async def test_disclaimer_agreement_flow(server, fresh_rooms, temp_storage):
    async with httpx.AsyncClient(base_url=server['http']) as http:
        pid = 'guest-A'
        # 初始未同意
        resp = await http.get(f'/api/players/by-id/{pid}/disclaimer-agreement')
        assert resp.status_code == 200
        assert resp.json() == {'playerId': pid, 'agreed': False}

        # 记录同意（带当前版本号）
        resp = await http.put(f'/api/players/by-id/{pid}/disclaimer-agreement',
                              json={'version': DISCLAIMER_VERSION})
        assert resp.status_code == 200
        assert resp.json()['agreed'] is True
        assert resp.json()['version'] == DISCLAIMER_VERSION

        # 再次查询 → 已同意且版本、时间齐全
        resp = await http.get(f'/api/players/by-id/{pid}/disclaimer-agreement')
        data = resp.json()
        assert data['agreed'] is True
        assert data['version'] == DISCLAIMER_VERSION
        assert data['agreedAt']

        # 重复同意（幂等）不报错，版本仍保留
        resp = await http.put(f'/api/players/by-id/{pid}/disclaimer-agreement',
                              json={'version': DISCLAIMER_VERSION})
        assert resp.status_code == 200

        # 不同玩家互不影响（按匿名身份隔离）
        resp = await http.get('/api/players/by-id/guest-B/disclaimer-agreement')
        assert resp.json()['agreed'] is False
