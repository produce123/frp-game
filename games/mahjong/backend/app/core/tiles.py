"""牌系统 —— 从 src/game/tiles.ts 翻译

纯函数，无框架依赖。提供：
- 34 种牌定义（SUITS / HONORS / TILE_TYPES）
- 牌墙创建（136 张，每牌 × 4）
- 洗牌（Fisher-Yates，注入 random）
- 排序、牌名、中马判定

tileFaceFile / tileOrder（前端 3D 专用）不翻译，仅保留排序所需的位置映射。
"""

import re
from typing import Callable, TypeVar

from app.models.game import Suit, HonorTile, TileType

T = TypeVar('T')

# ─── 基础定义 ─────────────────────────────────────────────

SUITS: list[Suit] = ['m', 'p', 's']
HONORS: list[HonorTile] = ['east', 'south', 'west', 'north', 'red', 'green', 'white']

# 牌名映射（来自 TS 端 TILE_META.name）
# 格式：{ tile: name }
TILE_META: dict[str, str] = {
    'back': '牌背',
    'm1': '一万', 'm2': '二万', 'm3': '三万', 'm4': '四万', 'm5': '五万',
    'm6': '六万', 'm7': '七万', 'm8': '八万', 'm9': '九万',
    'p1': '一筒', 'p2': '二筒', 'p3': '三筒', 'p4': '四筒', 'p5': '五筒',
    'p6': '六筒', 'p7': '七筒', 'p8': '八筒', 'p9': '九筒',
    's1': '一条', 's2': '二条', 's3': '三条', 's4': '四条', 's5': '五条',
    's6': '六条', 's7': '七条', 's8': '八条', 's9': '九条',
    'east': '东风', 'south': '南风', 'west': '西风', 'north': '北风',
    'red': '红中', 'green': '发财', 'white': '白板（癞子）',
}

# 全部 34 种牌（按 TS 端 TILE_TYPES 顺序：万 m1-m9, 筒 p1-p9, 条 s1-s9, 字牌）
TILE_TYPES: list[TileType] = [
    *[f'{s}{r}' for s in SUITS for r in range(1, 10)],  # type: ignore
    *HONORS,
]

# 牌排序位置映射（对应 TS 端 tileOrder），供 sortTiles 使用
_TILE_ORDER: dict[TileType, int] = {t: i for i, t in enumerate(TILE_TYPES)}


# ─── 牌墙 ─────────────────────────────────────────────────

def create_wall() -> list[TileType]:
    """生成 136 张牌墙（34 种牌 × 各 4 张）"""
    return [tile for tile in TILE_TYPES for _ in range(4)]


# ─── 洗牌 ─────────────────────────────────────────────────

def shuffle(items: list[T], random: Callable[[], float] = None) -> list[T]:
    """Fisher-Yates 洗牌，可注入 random 函数以支持测试确定性

    Args:
        items: 待洗牌列表
        random: 可选随机数生成函数，返回 [0, 1) 区间的浮点数。
                默认使用 Python random.random。
    """
    import random as _random_mod
    _rand = random if random is not None else _random_mod.random
    copy = list(items)
    for i in range(len(copy) - 1, 0, -1):
        j = int(_rand() * (i + 1))
        copy[i], copy[j] = copy[j], copy[i]
    return copy


# ─── 排序 ─────────────────────────────────────────────────

def sort_tiles(tiles: list[TileType]) -> list[TileType]:
    """按牌序整理手牌（返回新列表，不修改原列表）"""
    return sorted(tiles, key=lambda t: _TILE_ORDER.get(t, 99))


def sort_tiles_with_jokers(tiles: list[TileType], jokers) -> list[TileType]:
    """莲花麻将手牌排序：精牌保持牌面顺序，但整体固定排在最左侧（对齐前端 sortTilesWithJokers）。"""
    joker_set = set(jokers)
    return sorted(tiles, key=lambda t: (0 if t in joker_set else 1, _TILE_ORDER.get(t, 99)))


# ─── 牌名 ─────────────────────────────────────────────────

def tile_name(tile: TileType) -> str:
    """获取牌的中文名称，如 '一万'、'东风'"""
    return TILE_META.get(tile, tile)


# ─── 中马判定 ─────────────────────────────────────────────

# 广东麻将买马：以庄家为起点逆时针，各座位对应的中马牌固定。
# 数字覆盖万/筒/条三色；字牌按位置分配。
_HORSE_RANK_SETS = (
    (1, 5, 9),   # A 庄家
    (2, 6),      # B 下家
    (3, 7),      # C 对家
    (4, 8),      # D 上家
)
_HORSE_HONOR_SETS = (
    ('east',),              # A 庄家
    ('red', 'south'),       # B 下家
    ('green', 'west'),      # C 对家
    ('white', 'north'),     # D 上家
)


def is_horse_for_seat(tile: TileType, seat: int) -> bool:
    """判断某张牌是否对应该座位（0=庄家/1=下家/2=对家/3=上家）的中马。"""
    suited = re.match(r'^([mps])([1-9])$', tile)
    if suited:
        return int(suited.group(2)) in _HORSE_RANK_SETS[seat]
    return tile in _HORSE_HONOR_SETS[seat]
