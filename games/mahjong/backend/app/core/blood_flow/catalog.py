"""血流番型匹配 —— 对应 patterns/catalog.ts。"""

from app.models.game import TileType

from .types import WinningDecomposition

WINDS: tuple[TileType, ...] = ('east', 'south', 'west', 'north')
DRAGONS: tuple[TileType, ...] = ('red', 'green', 'white')


def is_honor(tile: TileType) -> bool:
    return len(tile) != 2


def is_terminal(tile: TileType) -> bool:
    return len(tile) == 2 and tile[1] in ('1', '9')


def has_stepped_run(numbers: list[int], length: int, steps: tuple[int, ...] = (1, 2)) -> bool:
    """一组数字里是否存在 length 项、公差为 steps 中任一值的等差数列。

    顺子族（一色三步高/四步高）**公差取 1 或 2**：国标把“依次递增一位”（123+234+345，素三步步高）
    与“依次递增二位”（123+345+567，素三连环扣）合称一色三步高，四步高同理（123+345+567+789）。
    因此 345+567+789（起始 3/5/7）这类“宽三步”必须成立，不能只认连续起始。

    刻子族（一色三/四节高）**只有“依次递增一位”**，公差固定 1（见调用处的 (1,)）。

    同一数字重复出现只算一次：番型要的是 length 个**不同递增档位**的面子，重复档位不构成步高。
    """
    unique = sorted(set(numbers))
    if len(unique) < length:
        return False
    present = set(unique)
    for step in steps:
        for start in unique:
            if all(start + step * offset in present for offset in range(1, length)):
                return True
    return False


def _by_suit(groups) -> dict[str, list[int]]:
    """同花色分组：{花色: [每组首张的数字]}（字牌跳过，与 TS bySuit 同义）。"""
    result: dict[str, list[int]] = {}
    for group in groups:
        tile = group.tiles[0]
        if is_honor(tile):
            continue
        result.setdefault(tile[0], []).append(int(tile[1]))
    return result


def match_patterns(hand: WinningDecomposition) -> list[str]:
    # 门清（2026-09-15 定案）：只看**无副露**，不排除用精牌，**与任何番种叠加**；
    # 且**暗杠与风杠不算破门清**（两者都取自手牌、都不能被抢杠）。风杠必须亮明东南西北，
    # 但规则上与暗杠等价；`concealed` 标记对风杠是 false，因此必须显式认 'wind-kong'。
    concealed = all(g.origin.get('kind') == 'hand'
                    or g.kind == 'wind-kong'
                    or (g.kind == 'kong' and g.concealed)
                    for g in hand.groups)
    if hand.shape not in ('standard', 'sevenPairs'):
        return [hand.shape, 'concealed-hand'] if concealed else [hand.shape]
    result: list[str] = ['sevenPairs'] if hand.shape == 'sevenPairs' else []
    if concealed:
        result.append('concealed-hand')
    tiles = [t for g in hand.groups for t in g.tiles]
    suits = {t[0] for t in tiles if not is_honor(t)}
    honors = any(is_honor(t) for t in tiles)
    # 豪华七对：七对里含"四张相同"。2026-09-12 用户定案：**允许精牌替补**凑成那四张
    # （tiles 是 represented 牌面，精牌顶替后计入），因此不再要求整手全自然（hand.natural）。
    # 好处：不必真的摸到 4 张实体同牌，也不必为了它放弃开杠——豪华七对因此可达。
    if hand.shape == 'sevenPairs' and any(tiles.count(t) >= 4 for t in tiles):
        result.append('luxury-seven-pairs')
    if len(suits) == 1:
        result.append('mixed-suit' if honors else 'pure-suit')
    if all(is_honor(t) for t in tiles):
        result.append('all-honors')
    if all(t in ('s2', 's3', 's4', 's6', 's8', 'green') for t in tiles):
        result.append('all-green')
    # 断幺九只看成牌牌面，标准型与七对（含豪华七对）都可叠加。
    if all(not is_honor(t) and not is_terminal(t) for t in tiles):
        result.append('all-simples')
    melds = [g for g in hand.groups if g.kind != 'pair']
    triplets = [g for g in melds if g.kind in ('triplet', 'kong')]
    all_triplets = len(triplets) == 4
    # 幺九牌种属性适用于七对；标准型继续要求四副刻子/杠。
    terminal_shape = hand.shape == 'sevenPairs' or all_triplets
    if terminal_shape and all(is_terminal(t) for t in tiles):
        result.append('pure-terminals')
    if terminal_shape and honors and len(suits) > 0 and all(is_honor(t) or is_terminal(t) for t in tiles):
        result.append('mixed-terminals')
    if hand.shape == 'sevenPairs':
        return result
    pair = next(g for g in hand.groups if g.kind == 'pair').tiles[0]
    sequences = [g for g in melds if g.kind == 'sequence']
    if all_triplets:
        result.append('all-triplets')
    dragon_count = sum(1 for t in DRAGONS if any(g.tiles[0] == t for g in triplets))
    wind_count = sum(1 for t in WINDS if any(g.tiles[0] == t for g in triplets))
    if dragon_count == 3:
        result.append('big-three-dragons')
    if dragon_count == 2 and pair in DRAGONS and not any(g.tiles[0] == pair for g in triplets):
        result.append('little-three-dragons')
    if wind_count == 4:
        result.append('big-four-winds')
    if wind_count == 3 and pair in WINDS and not any(g.tiles[0] == pair for g in triplets):
        result.append('little-four-winds')
    concealed_triplets = sum(1 for g in triplets if g.concealed)
    if concealed_triplets >= 3:
        result.append('three-concealed-triplets')
    if concealed_triplets == 4:
        result.append('four-concealed-triplets')
    kongs = sum(1 for g in melds if g.kind == 'kong')
    if kongs >= 3:
        result.append('three-kongs')
    if kongs == 4:
        result.append('four-kongs')
    if len(suits) == 1 and not honors and all(g.origin.get('kind') == 'hand' for g in hand.groups):
        counts = [sum(1 for t in tiles if len(t) == 2 and int(t[1]) == n) for n in range(1, 10)]
        if all(count >= (3 if i in (0, 8) else 1) for i, count in enumerate(counts)):
            result.append('nine-gates')
    # —— 2026-09-12 第二版番种表新增 ——
    # 全带幺：每副面子与将牌都含幺九或字牌（允许 123 / 789 这类含幺的顺子）。
    if all(any(is_honor(t) or is_terminal(t) for t in g.tiles) for g in hand.groups):
        result.append('all-with-terminals')
    # 一色步高 / 清龙：同花色顺子的起始数字关系（步高公差 1 或 2；清龙仍是 123/456/789 的 1/4/7）。
    for starts in _by_suit(sequences).values():
        if has_stepped_run(starts, 4):
            result.append('one-suit-four-steps')
        elif has_stepped_run(starts, 3):
            result.append('one-suit-three-steps')
        if all(start in starts for start in (1, 4, 7)):
            result.append('pure-straight')
    # 一色节高：同花色刻子/杠的数字连续（节高只有“依次递增一位”，公差固定 1）。
    for numbers in _by_suit(triplets).values():
        if has_stepped_run(numbers, 4, (1,)):
            result.append('one-suit-four-joints')
        elif has_stepped_run(numbers, 3, (1,)):
            result.append('one-suit-three-joints')
    # —— 平胡（2026-09-15 定案语义）——
    # 存在一种拆解 = 4 顺子 + 1 将、**无刻子**；可副露；字牌也可成顺（乱风顺/三元顺与引擎面子规则一致）；
    # 精牌只能补顺不能补刻。判定落在当前这一种拆解上：评估器会枚举所有拆解再取最高分，
    # 因此只要存在全顺拆解，"没有刻子/杠"的那次枚举就会给出平胡。
    if all(g.kind == 'sequence' for g in melds):
        result.append('pinghu')
    # 鸡胡（2026-09-15 定案）：完全没有任何计分番种时的**兜底体**，0.5 番（支付减半），
    # 不再与任何番种叠加（有番种时连兜底一起消失）。
    return result if result else ['chicken']
