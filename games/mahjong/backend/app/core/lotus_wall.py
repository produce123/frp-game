"""莲花麻将（旧版翻精规则）的牌墙纯函数。

牌墙逻辑与牌局状态机分离，方便和前端 lotusWall.ts 做逐项对照测试。
"""

from typing import Callable, Sequence

from app.core.tiles import create_wall, shuffle
from app.models.game import TileType

WALL_STACKS = 68
FLIP_STACK_REMOVED = 2
WALL_TOTAL_WITHOUT_FLIP = WALL_STACKS * 2 - FLIP_STACK_REMOVED


def seat_segment_start(seat: int) -> int:
    return [0, 51, 34, 17][seat % 4]


def next_in_sequence(tile: TileType) -> TileType:
    if len(tile) == 2 and tile[0] in 'mps':
        rank = int(tile[1])
        return f'{tile[0]}{1 if rank == 9 else rank + 1}'  # type: ignore[return-value]
    winds = ['east', 'south', 'west', 'north']
    if tile in winds:
        return winds[(winds.index(tile) + 1) % 4]  # type: ignore[return-value]
    dragons = ['red', 'green', 'white']
    if tile in dragons:
        return dragons[(dragons.index(tile) + 1) % 3]  # type: ignore[return-value]
    return tile


def compute_jokers(flip_tile: TileType) -> list[TileType]:
    """本局癞子 = [指示牌, 同序下一张]（恰 2 张，二者不同）。

    白板翻精：指示牌是白板 → 精牌 = [白板, 红中]（箭循环白→中），白板本身作为精
    （可替代任意牌）；发财翻精同理 → [发财, 白板]。此前把白板从精牌里过滤掉
    （只留同序下一张），导致白板翻精/发翻精时白板不作精（与前端 lotusRules.ts
    的 computeJokers 对齐后修复）。
    """
    result = []
    for tile in (flip_tile, next_in_sequence(flip_tile)):
        if tile not in result:
            result.append(tile)
    return result


def resolve_flip(ring: Sequence[TileType], dealer: int,
                 dice: Sequence[int]) -> dict:
    total = dice[0] + dice[1]
    flip_seat = (dealer + total - 1) % 4
    flip_stack = seat_segment_start(flip_seat) + total - 1
    flip_tile = ring[flip_stack * 2]
    return {
        'flipSeat': flip_seat,
        'flipStack': flip_stack,
        'flipTile': flip_tile,
        'jokers': compute_jokers(flip_tile),
    }


def resolve_opening_stack(flip_stack: int, dice: Sequence[int]) -> int:
    return (flip_stack + dice[0] + dice[1] + 1) % WALL_STACKS


def wall_break_index(opening_stack: int, flip_stack: int | None = None) -> int:
    opening = opening_stack % WALL_STACKS
    flip = None if flip_stack is None else flip_stack % WALL_STACKS
    first = (opening + 1) % WALL_STACKS if flip == opening else opening
    return first * 2


def build_draw_order_wall(ring: Sequence[TileType], opening_stack: int,
                          flip_stack: int) -> list[TileType]:
    wall: list[TileType] = []
    for step in range(WALL_STACKS):
        stack = (opening_stack + step) % WALL_STACKS
        if stack == flip_stack:
            continue
        wall.extend((ring[stack * 2], ring[stack * 2 + 1]))
    return wall


def build_lotus_wall(*, dealer: int, dice: Sequence[int],
                     second_dice: Sequence[int], random: Callable[[], float] | None = None,
                     ring: Sequence[TileType] | None = None) -> dict:
    ring_tiles = list(ring) if ring is not None else shuffle(create_wall(), random)
    flip = resolve_flip(ring_tiles, dealer, dice)
    opening_stack = resolve_opening_stack(flip['flipStack'], second_dice)
    return {
        'wall': build_draw_order_wall(ring_tiles, opening_stack, flip['flipStack']),
        'flipTile': flip['flipTile'],
        'jokers': flip['jokers'],
        'flipStack': flip['flipStack'],
        'openingStack': opening_stack,
        'wallBreakIndex': wall_break_index(opening_stack, flip['flipStack']),
        'flipSeat': flip['flipSeat'],
    }


def take_tail_tile(wall: list[TileType], head_drawn: int) -> TileType | None:
    if not wall:
        return None
    tail_drawn = max(0, WALL_TOTAL_WITHOUT_FLIP - head_drawn - len(wall))
    index = -2 if tail_drawn % 2 == 0 and len(wall) >= 2 else -1
    return wall.pop(index)
