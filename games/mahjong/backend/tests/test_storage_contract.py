"""存储后端公共契约。

测试只依赖 Storage 对外方法；同一组断言后续可复用于 PostgreSQL 集成环境。
"""

import json

import psycopg
import pytest

from app.storage.base import BaseStorage, aggregate_player_stats
from app.storage.db import PostgresStorage, Storage


@pytest.fixture()
def backend(tmp_path):
    storage = Storage(str(tmp_path / 'contract.db'))
    storage.init()
    return storage


def test_avatar_disclaimer_and_ban_upserts(backend):
    backend.set_player_avatar('guest-1', 'https://example.com/one.png')
    backend.set_player_avatar('guest-1', 'https://example.com/two.png')
    assert backend.get_player_avatar('guest-1') == 'https://example.com/two.png'

    backend.set_disclaimer_agreement('guest-1', 1)
    backend.set_disclaimer_agreement('guest-1', 2)
    agreement = backend.get_disclaimer_agreement('guest-1')
    assert agreement['version'] == 2
    assert agreement['agreed_at']

    backend.ban_target('player', 'guest-1', 'first', 'admin-a')
    backend.ban_target('player', 'guest-1', 'updated', 'admin-b')
    assert backend.is_banned('player', 'guest-1') is True
    backend.unban('player', 'guest-1')
    assert backend.is_banned('player', 'guest-1') is False


def test_match_round_mapping_and_player_stats_contract(backend):
    backend.create_room('ROOM01', 'east', 4)
    match_id = backend.create_match('ROOM01', 'east')
    backend.upsert_match_players(match_id, [
        {'seat': 0, 'player_id': 'guest-a', 'nickname': 'Alice'},
        {'seat': 1, 'player_id': 'guest-b', 'nickname': 'Bob'},
    ])
    # 同一比赛座位重复写入必须更新，而不是产生重复参赛者。
    backend.upsert_match_players(match_id, [
        {'seat': 0, 'player_id': 'guest-a', 'nickname': 'Alice-New'},
        {'seat': 1, 'player_id': 'guest-b', 'nickname': 'Bob'},
    ])
    backend.insert_round_result(match_id, {
        'round': '东1局',
        'winner_index': 0,
        'deltas': [
            {'playerIndex': 0, 'amount': 300},
            {'playerIndex': 1, 'amount': -300},
        ],
    })
    backend.insert_round_result(match_id, {
        'round': '东2局',
        'winner_index': 1,
        'deltas': [
            {'playerIndex': 0, 'amount': -100},
            {'playerIndex': 1, 'amount': 100},
        ],
    })
    backend.finish_match(match_id, [
        {'seat': 0, 'name': 'Alice-New', 'score': 1200},
        {'seat': 1, 'name': 'Bob', 'score': 800},
    ])

    match = backend.get_match(match_id)
    assert match['roomId'] == 'ROOM01'
    assert match['mode'] == 'east'
    assert [item['round'] for item in match['rounds']] == ['东1局', '东2局']
    assert match['rounds'][0]['result']['winner_index'] == 0
    assert match['finalScores'][0]['score'] == 1200

    summaries = backend.list_room_matches('ROOM01')
    assert len(summaries) == 1
    assert summaries[0]['id'] == match_id
    assert summaries[0]['finalScores'][1]['name'] == 'Bob'

    assert backend.get_player_stats('Alice') == {
        'nickname': 'Alice', 'matches': 0, 'hands': 0, 'wins': 0, 'totalDelta': 0,
    }
    assert backend.get_player_stats('Alice-New') == {
        'nickname': 'Alice-New', 'matches': 1, 'hands': 2,
        'wins': 1, 'totalDelta': 200,
    }
    assert backend.get_player_stats_by_id('guest-b') == {
        'playerId': 'guest-b', 'matches': 1, 'hands': 2,
        'wins': 1, 'totalDelta': -200,
    }


def test_room_seat_and_report_writes_remain_idempotent(backend):
    backend.create_room('ROOM02', 'east', 4)
    backend.upsert_room_seat('ROOM02', 0, 'Before', 'CODE-1', 'guest-1')
    backend.upsert_room_seat('ROOM02', 0, 'After', 'CODE-2', 'guest-2')
    backend.add_report('ROOM02', 'reporter', 'guest-2', 'After', 'reason')

    with backend._conn() as conn:
        seat = conn.execute(
            'SELECT nickname, rejoin_code, player_id FROM room_seats '
            'WHERE room_id = ? AND seat = ?', ('ROOM02', 0)).fetchone()
        reports = conn.execute('SELECT COUNT(*) AS n FROM reports').fetchone()
    assert dict(seat) == {
        'nickname': 'After', 'rejoin_code': 'CODE-2', 'player_id': 'guest-2',
    }
    assert reports['n'] == 1

    backend.remove_room_seat('ROOM02', 0)
    with backend._conn() as conn:
        remaining = conn.execute(
            'SELECT COUNT(*) AS n FROM room_seats WHERE room_id = ?', ('ROOM02',)
        ).fetchone()
    assert remaining['n'] == 0


def test_adapters_share_crud_and_only_translate_parameter_markers(tmp_path):
    sqlite = Storage(str(tmp_path / 'dialect.db'))
    postgres = PostgresStorage('postgresql://unused')

    assert Storage.create_room is BaseStorage.create_room
    assert PostgresStorage.create_room is BaseStorage.create_room
    assert sqlite._sql('VALUES (:p, :p)') == 'VALUES (?, ?)'
    assert postgres._sql('VALUES (:p, :p)') == 'VALUES (%s, %s)'


def test_stats_aggregation_is_pure_and_skips_missing_seat_delta():
    rows = [
        {
            'match_id': 'match-1',
            'result_json': json.dumps({
                'winner_index': 1,
                'deltas': [{'playerIndex': 1, 'amount': 200}],
            }),
        },
        {
            'match_id': 'match-1',
            'result_json': json.dumps({
                'winner_index': 0,
                'deltas': [{'playerIndex': 0, 'amount': 100}],
            }),
        },
    ]

    assert aggregate_player_stats(rows, {'match-1': 1}) == {
        'matches': 1,
        'hands': 1,
        'wins': 1,
        'totalDelta': 200,
    }


def test_postgres_connect_retries_after_transient_failure(monkeypatch):
    """建连阶段瞬时失败（如 pooler DNS 抖动）应自动重试并恢复。"""
    calls = []

    def flaky(dsn, **kwargs):
        calls.append(dsn)
        if len(calls) == 1:
            raise psycopg.OperationalError(
                "failed to resolve host: "
                "Temporary failure in name resolution")
        return object()

    monkeypatch.setattr('app.storage.postgres.psycopg.connect', flaky)
    monkeypatch.setattr('app.storage.postgres.time.sleep', lambda _s: None)

    storage = PostgresStorage('postgresql://unused')
    assert storage._conn() is not None
    assert len(calls) == 2


def test_postgres_connect_gives_up_after_max_attempts(monkeypatch):
    """连续失败达到上限后应抛出，而不是无限重试。"""
    calls = []

    def always_fail(dsn, **kwargs):
        calls.append(dsn)
        raise psycopg.OperationalError("connection refused")

    monkeypatch.setattr('app.storage.postgres.psycopg.connect', always_fail)
    monkeypatch.setattr('app.storage.postgres.time.sleep', lambda _s: None)

    storage = PostgresStorage('postgresql://unused')
    with pytest.raises(psycopg.OperationalError):
        storage._conn()
    assert len(calls) == 3
