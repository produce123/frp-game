"""规则引擎 —— 从 src/game/rules.ts 翻译（★★ 整个游戏的心脏）

全部为纯函数，无框架依赖。逐条对照 rules.test.ts 翻译，保证零漂移：
- is_winning_hand：胡牌判定（白板癞子可代任意牌，递归拆解顺/刻）
- can_make_melds：记忆化递归副露拆解（内部）
- waiting_tiles / can_rob_kong / concealed_kongs / draw_horses
- score_hand：番数计算
- apply_win_score / apply_kong_score：分数结算

注意：与 TS 端保持一致，红中（red）不参与胡牌判定，从手牌中先行过滤。
"""

import re
from typing import Optional

from app.models.game import GamePlayer, Meld, TileType
from app.core.tiles import TILE_TYPES, is_horse_for_seat
from app.settlement import settlement_service

# 参与组牌的标准牌：全部 34 种减去 红中(red) 与 白板(white)
STANDARD_TILES: list[TileType] = [t for t in TILE_TYPES if t != 'white' and t != 'red']
# 听牌候选：标准牌 + 白板（不含红中，红中为花牌不可胡）
WINNING_DRAW_TILES: list[TileType] = [*STANDARD_TILES, 'white']

BASE_SCORE = 100

_SUITED_RE = re.compile(r'^([mps])([1-9])$')


def _is_integer(x) -> bool:
    """等价于 JS Number.isInteger：int 或整数值 float"""
    return isinstance(x, int) or (isinstance(x, float) and x.is_integer())


# ─── 分数结算 ─────────────────────────────────────────────

def apply_kong_score(
    players: list[GamePlayer],
    kong_player_index: int,
    type_: str,
    from_index: Optional[int] = None,
) -> list[dict]:
    """杠分结算，就地修改玩家分数并返回 ScoreDelta 列表。

    - discard（明杠/点杠）：仅放杠者支付底分
    - concealed（暗杠）：其余三家各支付底分两倍
    - added（补杠）：其余三家各支付底分
    """
    result = settlement_service.calculate_kong(
        len(players), kong_player_index, type_, BASE_SCORE, from_index)
    settlement_service.apply_deltas(players, result.deltas)
    return result.as_list()


def apply_win_score(
    players: list[GamePlayer],
    winner_index: int,
    points: int,
    payer_index: Optional[int] = None,
    dealer_index: Optional[int] = None,
) -> int:
    """胡牌结算，就地修改玩家分数并返回赢家总得分。

    庄家胡牌的倍数已计入 points；闲家胡牌时，庄家单独支付双倍。
    """
    result = settlement_service.calculate_win(
        len(players), winner_index, points, payer_index, dealer_index)
    settlement_service.apply_deltas(players, result.deltas)
    return result.total_won


# ─── 副露拆解（记忆化递归）────────────────────────────────

def _counts_for(tiles: list[TileType]) -> dict[TileType, int]:
    counts: dict[TileType, int] = {}
    for tile in tiles:
        counts[tile] = counts.get(tile, 0) + 1
    return counts


def _first_remaining(counts: dict[TileType, int]) -> Optional[TileType]:
    return next((t for t in STANDARD_TILES if (counts.get(t) or 0) > 0), None)


def _consume(counts: dict[TileType, int], tile: TileType, amount: int) -> dict[TileType, int]:
    """返回减去 amount 张 tile 后的新计数表（不修改原表）"""
    nxt = dict(counts)
    left = nxt.get(tile, 0) - amount
    if left > 0:
        nxt[tile] = left
    else:
        nxt.pop(tile, None)
    return nxt


def _can_make_melds(
    counts: dict[TileType, int],
    jokers: int,
    needed: int,
    memo: Optional[dict[str, bool]] = None,
) -> bool:
    """判断给定牌计数能否拆成 needed 组顺子/刻子，白板(jokers)可代任意牌。

    记忆化键使用 TS 端同构的签名：needed|jokers|各标准牌数量拼接字符串。
    """
    if memo is None:
        memo = {}
    signature = f'{needed}|{jokers}|' + ''.join(str(counts.get(t, 0)) for t in STANDARD_TILES)
    if signature in memo:
        return memo[signature]

    tile = _first_remaining(counts)
    if tile is None:
        result = jokers == needed * 3
        memo[signature] = result
        return result
    if needed <= 0:
        return False

    amount = counts.get(tile, 0)
    # 刻子：用已有同牌（最多 3 张）补齐，不足部分以白板替代
    triplet_real = min(3, amount)
    if 3 - triplet_real <= jokers:
        if _can_make_melds(
            _consume(counts, tile, triplet_real),
            jokers - (3 - triplet_real),
            needed - 1,
            memo,
        ):
            memo[signature] = True
            return True

    # 顺子：序数牌按起点扫描 3 连牌，缺牌以白板替代
    match = _SUITED_RE.match(tile)
    if match:
        suit, rank_s = match.groups()
        rank = int(rank_s)
        first_rank = max(1, rank - 2)
        last_rank = min(7, rank)
        for start in range(first_rank, last_rank + 1):
            sequence = [f'{suit}{start + i}' for i in range(3)]
            missing = 0
            nxt = dict(counts)
            for item in sequence:
                if (nxt.get(item) or 0) > 0:
                    nxt = _consume(nxt, item, 1)
                else:
                    missing += 1
            if missing <= jokers and _can_make_melds(nxt, jokers - missing, needed - 1, memo):
                memo[signature] = True
                return True

    memo[signature] = False
    return False


# ─── 胡牌判定 ─────────────────────────────────────────────

def is_winning_hand(tiles: list[TileType], exposed_meld_count: int = 0) -> bool:
    """胡牌判定。白板为癞子可代任意牌；红中为花牌先过滤不计入。

    exposed_meld_count：已有副露组数，从 4 组中扣除。
    """
    red_filtered = [t for t in tiles if t != 'red']
    needed_melds = 4 - exposed_meld_count
    if len(red_filtered) != needed_melds * 3 + 2:
        return False

    jokers = sum(1 for t in red_filtered if t == 'white')
    naturals = [t for t in red_filtered if t != 'white']
    counts = _counts_for(naturals)

    # 将子：两张白板作雀头
    if jokers >= 2 and _can_make_melds(counts, jokers - 2, needed_melds):
        return True

    # 雀头：任意对子（或一张 + 白板）
    for tile in STANDARD_TILES:
        amount = counts.get(tile, 0)
        if amount >= 2 and _can_make_melds(_consume(counts, tile, 2), jokers, needed_melds):
            return True
        if amount >= 1 and jokers >= 1 and _can_make_melds(_consume(counts, tile, 1), jokers - 1, needed_melds):
            return True
    return False


def waiting_tiles(tiles: list[TileType], exposed_meld_count: int = 0) -> list[TileType]:
    """计算听牌集合：加任意一张 WINNING_DRAW_TILES 后可胡的牌"""
    return [t for t in WINNING_DRAW_TILES if is_winning_hand([*tiles, t], exposed_meld_count)]


# ─── 暗杠 / 抢杠 ──────────────────────────────────────────

def matching_count(tiles: list[TileType], tile: TileType) -> int:
    return sum(1 for item in tiles if item == tile)


def concealed_kongs(tiles: list[TileType]) -> list[TileType]:
    """检测可暗杠的牌（红中/白板不能开暗杠）"""
    return [
        t for t in TILE_TYPES
        if t != 'red' and t != 'white' and matching_count(tiles, t) == 4
    ]


def can_rob_kong(tiles: list[TileType], kong_tile: TileType, exposed_meld_count: int = 0) -> bool:
    """补杠牌是否可被抢杠胡（把杠牌加入手牌后是否成胡）"""
    return is_winning_hand([*tiles, kong_tile], exposed_meld_count)


# ─── 副露来源指向 ─────────────────────────────────────────

def meld_source_tile_index(meld: Meld, player_index: int) -> int:
    """计算副露牌中来自来源玩家的牌在 meld.tiles 中的索引（用于横置展示）。

    相对座位 1（下家）→ 首张；2（对家）→ 中间；3（上家）→ 末张。
    """
    if meld.type not in ('peng', 'gang') or not _is_integer(meld.from_):
        return -1
    relative_source = (meld.from_ - player_index + 4) % 4
    if relative_source == 1:
        return 0
    if relative_source == 2:
        return min(1, len(meld.tiles) - 1)
    if relative_source == 3:
        return len(meld.tiles) - 1
    return -1


# ─── 买马 ─────────────────────────────────────────────────

def draw_horses(wall: list[TileType], amount: int = 8, seat: int = 0) -> dict:
    """从牌头摸马（原地消耗 wall），返回 {horses, hits}。中马按座位判定。"""
    n = min(amount, len(wall))
    horses = wall[:n]
    del wall[:n]
    return {'horses': horses, 'hits': sum(1 for t in horses if is_horse_for_seat(t, seat))}


# ─── 番数计算 ─────────────────────────────────────────────

def score_hand(
    dealer: bool = False,
    no_joker: bool = False,
    four_red: bool = False,
    kong_bloom: bool = False,
    horse_hits: int = 0,
    robbed_kong: bool = False,
    red_count: int = 0,
) -> dict:
    """计算胡牌番数与分数。

    底分 × 倍数 + 中马数 × 底分 + 红中数 × 底分；中马与红中按张数加底分。
    庄家倍率已取消（dealer 参数仅为兼容保留，广麻番表不再消费）。
    返回 {multiplier, totalMultiplier, horsePoints, redPoints, points, details}。
    """
    # 延迟导入避免默认规则集复用本模块结构判定函数时形成循环导入。
    from app.rules.fans import FanContext
    from app.rules.lianhua import get_default_rule_set

    return get_default_rule_set().score_hand(FanContext(
        dealer=dealer,
        no_joker=no_joker,
        four_red=four_red,
        kong_bloom=kong_bloom,
        horse_hits=horse_hits,
        robbed_kong=robbed_kong,
        red_count=red_count,
    ))
