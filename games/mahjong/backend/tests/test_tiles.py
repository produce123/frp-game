"""牌系统单元测试 —— 对照 src/game/tiles.ts 语义

覆盖：
- 牌墙 136 张，各牌恰好 4 张
- 洗牌确定性（注入 random）
- 牌名字典覆盖全部 34 种牌
- 排序（按牌型有序）
- 中马判定
"""

import pytest
from collections import Counter

from app.core.tiles import (
    SUITS,
    HONORS,
    TILE_META,
    TILE_TYPES,
    create_wall,
    shuffle,
    sort_tiles,
    sort_tiles_with_jokers,
    tile_name,
    is_horse_for_seat,
)


# ─── 常量校验 ─────────────────────────────────────────────

class TestConstants:
    def test_suits(self):
        assert SUITS == ['m', 'p', 's']

    def test_honors(self):
        assert HONORS == ['east', 'south', 'west', 'north', 'red', 'green', 'white']


# ─── 牌墙 ─────────────────────────────────────────────────

class TestCreateWall:
    def test_total_count(self):
        """create_wall 返回 136 张牌"""
        wall = create_wall()
        assert len(wall) == 136

    def test_each_tile_four_copies(self):
        """每种牌恰好 4 张"""
        wall = create_wall()
        counts = Counter(wall)
        assert len(counts) == 34  # 共 34 种牌
        for tile, count in counts.items():
            assert count == 4, f'{tile} 出现 {count} 次，应为 4 次'

    def test_only_valid_tile_types(self):
        """牌墙只包含合法牌值"""
        wall = create_wall()
        for tile in wall:
            assert tile in TILE_TYPES, f'{tile} 不在 TILE_TYPES 中'

    def test_independent_copies(self):
        """每次调用返回独立列表"""
        w1 = create_wall()
        w2 = create_wall()
        assert w1 == w2  # 内容相同
        assert w1 is not w2  # 但是不同对象

    def test_modify_wall_does_not_affect_others(self):
        w1 = create_wall()
        w2 = create_wall()
        w1[0] = 'm2'
        assert w2[0] != 'm2'


# ─── 洗牌 ─────────────────────────────────────────────────

class TestShuffle:
    def test_same_length(self):
        """洗牌后长度不变"""
        items = [1, 2, 3, 4, 5]
        result = shuffle(items)
        assert len(result) == len(items)

    def test_contains_same_elements(self):
        """洗牌后包含相同元素"""
        items = [1, 2, 3, 4, 5]
        result = shuffle(items)
        assert sorted(result) == sorted(items)

    def test_original_unmodified(self):
        """原列表不被修改"""
        items = [1, 2, 3, 4, 5]
        shuffle(items)
        assert items == [1, 2, 3, 4, 5]

    def test_deterministic_with_fixed_random(self):
        """注入固定的 random 函数，结果应该可复现"""
        items = list(range(10))
        # 始终返回 0.0 → int(0.0 * (i+1)) = 0 → 每次 i 位置与位置 0 交换
        # Fisher-Yates 在该输入下把最后一个元素（9）一路搬到位置 0，
        # 0 最后落到末尾 → [1,2,...,9,0]（与 TS 端 shuffle 行为一致）
        result = shuffle(items, random=lambda: 0.0)
        assert result == [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]

    def test_deterministic_with_specific_random(self):
        """注入返回固定值的 random，验证确定性"""
        items = [1, 2, 3, 4, 5]
        # 始终返回 0.5 → int(0.5 * (i+1)) ≈ 中间位置
        result = shuffle(items, random=lambda: 0.5)
        # 用相同的 random 再跑一次，应该得到相同结果
        result2 = shuffle(items, random=lambda: 0.5)
        assert result == result2

    def test_random_is_passed_index(self):
        """random 被调用时接收当前步信息（通过返回值控制每次交换位置）"""
        items = [1, 2, 3, 4, 5]
        call_count = [0]

        def pseudo_random():
            call_count[0] += 1
            return 0.3

        shuffle(items, random=pseudo_random)
        # Fisher-Yates 对 n=5 执行 4 次交换（i=4,3,2,1）
        assert call_count[0] == 4

    def test_wall_shuffle_maintains_composition(self):
        """牌墙洗牌后每牌仍是 4 张"""
        wall = create_wall()
        shuffled = shuffle(wall)
        counts = Counter(shuffled)
        for tile, count in counts.items():
            assert count == 4, f'{tile} 出现 {count} 次，应为 4 次'


# ─── 牌名字典 ─────────────────────────────────────────────

class TestTileNames:
    def test_all_34_tiles_have_name(self):
        """全部 34 种牌都有中文名"""
        for tile in TILE_TYPES:
            name = tile_name(tile)
            assert name, f'{tile} 缺少牌名'
            assert name != tile, f'{tile} 返回的是 tile 本身而非牌名'

    def test_specific_tile_names(self):
        """验证具体牌名"""
        assert tile_name('m1') == '一万'
        assert tile_name('m9') == '九万'
        assert tile_name('p1') == '一筒'
        assert tile_name('p5') == '五筒'
        assert tile_name('s1') == '一条'
        assert tile_name('s9') == '九条'
        assert tile_name('east') == '东风'
        assert tile_name('south') == '南风'
        assert tile_name('west') == '西风'
        assert tile_name('north') == '北风'
        assert tile_name('red') == '红中'
        assert tile_name('green') == '发财'
        assert tile_name('white') == '白板（癞子）'

    def test_back_tile_name(self):
        """牌背名称"""
        assert TILE_META['back'] == '牌背'

    def test_unknown_tile_returns_itself(self):
        """未知牌返回自身（降级处理）"""
        assert tile_name('nonexistent') == 'nonexistent'  # type: ignore


# ─── 排序 ─────────────────────────────────────────────────

class TestSortTiles:
    def test_sort_empty(self):
        assert sort_tiles([]) == []

    def test_sort_single(self):
        assert sort_tiles(['m1']) == ['m1']

    def test_sort_already_sorted(self):
        tiles = ['m1', 'm2', 'm3', 'p1', 's1']
        assert sort_tiles(tiles) == tiles

    def test_sort_reversed(self):
        """逆序手牌应被整理为正序"""
        reversed_tiles = ['s9', 'p1', 'm1']
        expected = ['m1', 'p1', 's9']
        assert sort_tiles(reversed_tiles) == expected

    def test_sort_with_jokers_puts_jokers_first(self):
        """莲花麻将：精牌保持牌面顺序，但整体固定排在最左侧。"""
        hand = ['m3', 'east', 'm7', 'p2', 'white']
        assert sort_tiles_with_jokers(hand, ['m7', 'white']) == ['m7', 'white', 'm3', 'p2', 'east']

    def test_sort_mixed(self):
        """混合牌型排序：万 < 筒 < 条 < 字（同花色内按点数）"""
        tiles = ['white', 'm5', 'east', 'm1', 's1', 'p9']
        result = sort_tiles(tiles)
        # 预期顺序：m1 < m5 < p9 < s1 < east < white
        assert result == ['m1', 'm5', 'p9', 's1', 'east', 'white']

    def test_original_unmodified(self):
        """原列表不被修改"""
        tiles = ['s9', 'p1', 'm1']
        sort_tiles(tiles)
        assert tiles == ['s9', 'p1', 'm1']

    def test_duplicates_preserved(self):
        """重复牌保留"""
        tiles = ['m1', 'm1', 'm3', 'm2']
        result = sort_tiles(tiles)
        assert result == ['m1', 'm1', 'm2', 'm3']


# ─── 中马判定 ─────────────────────────────────────────────

class TestHorseForSeat:
    def test_dealer_seat_a(self):
        """庄家(A)：1/5/9 三色 + 东 是中马"""
        for tile in ['m1', 'p1', 's1', 'm5', 'p5', 's5', 'm9', 'p9', 's9', 'east']:
            assert is_horse_for_seat(tile, 0) is True, f'{tile} 应是庄家中马'

    def test_next_seat_b(self):
        """下家(B)：2/6 三色 + 红中 + 南 是中马"""
        for tile in ['m2', 'p2', 's2', 'm6', 'p6', 's6', 'red', 'south']:
            assert is_horse_for_seat(tile, 1) is True, f'{tile} 应是下家中马'

    def test_opposite_seat_c(self):
        """对家(C)：3/7 三色 + 发 + 西 是中马"""
        for tile in ['m3', 'p3', 's3', 'm7', 'p7', 's7', 'green', 'west']:
            assert is_horse_for_seat(tile, 2) is True, f'{tile} 应是对家中马'

    def test_upper_seat_d(self):
        """上家(D)：4/8 三色 + 白 + 北 是中马"""
        for tile in ['m4', 'p4', 's4', 'm8', 'p8', 's8', 'white', 'north']:
            assert is_horse_for_seat(tile, 3) is True, f'{tile} 应是上家中马'

    def test_seat_specificity(self):
        """同一张牌只在对应座位算中马"""
        assert is_horse_for_seat('m1', 1) is False   # 1 只归庄家
        assert is_horse_for_seat('red', 0) is False  # 红中只归下家
        assert is_horse_for_seat('east', 3) is False  # 东只归庄家
        assert is_horse_for_seat('white', 2) is False  # 白只归上家


# ─── TILE_TYPES 完整性 ────────────────────────────────────

class TestTileTypes:
    def test_count_34(self):
        """TILE_TYPES 应为 34 种牌"""
        assert len(TILE_TYPES) == 34

    def test_contains_all_suits(self):
        """应包含全部 3 花色 × 9 点数 = 27 张序数牌"""
        for suit in SUITS:
            for rank in range(1, 10):
                tile = f'{suit}{rank}'
                assert tile in TILE_TYPES, f'{tile} 不在 TILE_TYPES 中'

    def test_contains_all_honors(self):
        """应包含全部 7 张字牌"""
        for honor in HONORS:
            assert honor in TILE_TYPES, f'{honor} 不在 TILE_TYPES 中'

    def test_no_duplicates(self):
        """TILE_TYPES 中无重复"""
        assert len(TILE_TYPES) == len(set(TILE_TYPES))

    def test_ordering_suits_before_honors(self):
        """序数牌（万/筒/条）在字牌之前"""
        suited_count = 27
        for tile in TILE_TYPES[:suited_count]:
            assert tile[0] in ['m', 'p', 's'], f'{tile} 应在序数牌区'
        for tile in TILE_TYPES[suited_count:]:
            assert tile in HONORS, f'{tile} 应在字牌区'
