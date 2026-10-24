"""座位头像解析单测 —— app.game.avatars.resolve_seat_avatar 的优先级与降级。

经典房间与血流房间共用这一个实现，因此这里锁定：「平台头像 → 落库头像 → 随机头像 →
空串」的顺序，以及每个分支的落库副作用。
"""

from app.game.avatars import resolve_seat_avatar


class _FakeStorage:
    def __init__(self, stored: str = ''):
        self.stored = stored
        self.writes: list[tuple[str, str]] = []

    def get_player_avatar(self, player_id: str) -> str:
        return self.stored

    def set_player_avatar(self, player_id: str, avatar: str) -> None:
        self.stored = avatar
        self.writes.append((player_id, avatar))


def _counting_fetcher() -> tuple[dict, callable]:
    """返回 (调用计数, 随机头像取图桩)：每次调用返回不同的固定 URL。"""
    calls = {'n': 0}

    def fetch() -> str:
        calls['n'] += 1
        return f'https://random/{calls["n"]}.jpg'

    return calls, fetch


def test_platform_avatar_wins_and_is_persisted():
    storage = _FakeStorage('https://example.com/old.jpg')
    calls, fetch = _counting_fetcher()

    avatar = resolve_seat_avatar('https://cdn.wakudemo.cn/a.png', 'wakudemo-1', storage,
                                 fetch_random=fetch)

    assert avatar == 'https://cdn.wakudemo.cn/a.png'
    assert storage.writes == [('wakudemo-1', 'https://cdn.wakudemo.cn/a.png')]
    assert calls['n'] == 0   # 平台头像不再取随机图


def test_persisted_avatar_is_reused_without_fetch():
    storage = _FakeStorage('https://example.com/stored.jpg')
    calls, fetch = _counting_fetcher()

    avatar = resolve_seat_avatar('', 'wakudemo-1', storage, fetch_random=fetch)

    assert avatar == 'https://example.com/stored.jpg'
    assert storage.writes == []
    assert calls['n'] == 0


def test_random_avatar_is_fetched_once_and_persisted():
    storage = _FakeStorage()
    calls, fetch = _counting_fetcher()

    assert resolve_seat_avatar('', 'wakudemo-1', storage, fetch_random=fetch) == 'https://random/1.jpg'
    assert storage.writes == [('wakudemo-1', 'https://random/1.jpg')]
    # 第二次解析（换房间/换玩法）复用落库头像，不再取图
    assert resolve_seat_avatar('', 'wakudemo-1', storage, fetch_random=fetch) == 'https://random/1.jpg'
    assert calls['n'] == 1


def test_memory_only_seat_stays_empty_without_network():
    calls, fetch = _counting_fetcher()

    # 无 storage（纯内存态）或无 player_id：不触网，返回空串由前端回退座位默认头像
    assert resolve_seat_avatar('', 'wakudemo-1', None, fetch_random=fetch) == ''
    assert resolve_seat_avatar('', None, _FakeStorage(), fetch_random=fetch) == ''
    assert calls['n'] == 0


def test_fetch_failure_keeps_seat_avatar_empty():
    storage = _FakeStorage()

    assert resolve_seat_avatar('', 'wakudemo-1', storage, fetch_random=lambda: '') == ''
    assert storage.writes == []
