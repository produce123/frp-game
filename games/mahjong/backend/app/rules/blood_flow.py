"""血流规则集 —— 后端权威实现，翻译自前端 bloodFlow/config.ts + patterns/* + winBatch.ts。

M1 只承载规则/计分/批次；对局流程（锁手/多响/牌墙耗尽）在 game/blood_flow_manager.py（M2）。
"""

from app.core.lotus_wall import build_lotus_wall
from app.core.tiles import create_wall
from app.models.game import GamePlayer, Meld, TileType

from app.core.blood_flow.config import BLOOD_FLOW_CONFIG
from app.core.blood_flow.evaluate import evaluate_waits, evaluate_win, win_input_from_dict
from app.core.blood_flow.types import WinEvaluation
from app.core.blood_flow.win_batch import resolve_win_batch


class BloodFlowRoundState:
    def __init__(self):
        self.flip_tile: TileType | None = None
        self.joker_tiles: list[TileType] = []
        self.wildcard_tiles: list[TileType] = ['white']
        self.flip_stack: int | None = None
        self.opening_stack: int | None = None
        self.wall_break_index: int = 0
        self.first_dice: list[int] = []
        self.second_dice: list[int] = []

    @property
    def jokers(self) -> list[TileType]:
        return self.joker_tiles

    @property
    def wildcards(self) -> list[TileType]:
        return self.wildcard_tiles or ['white']


class BloodFlowRuleSet:
    code = 'lotus-blood-flow'
    base_score = BLOOD_FLOW_CONFIG.base_points
    horse_count = 0
    supports_chi = True
    supports_flowers = False

    def __init__(self):
        self.round_state = BloodFlowRoundState()

    # ── 牌墙与开局（复用莲花麻将外壳：双骰、翻精、双精、白板受限替代） ──

    def create_wall(self) -> list[TileType]:
        return create_wall()

    def begin_round(self, *, dealer: int, dice: list[int], second_dice: list[int],
                    random=None, ring: list[TileType] | None = None) -> dict:
        from app.core.tiles import shuffle as shuffle_tiles
        ring_tiles = list(ring) if ring is not None else shuffle_tiles(create_wall(), random)
        result = build_lotus_wall(dealer=dealer, dice=dice, second_dice=second_dice,
                                  random=random, ring=ring_tiles)
        self.round_state = BloodFlowRoundState()
        self.round_state.flip_tile = result['flipTile']
        self.round_state.joker_tiles = result['jokers']
        self.round_state.wildcard_tiles = ['white']
        self.round_state.flip_stack = result['flipStack']
        self.round_state.opening_stack = result['openingStack']
        self.round_state.wall_break_index = result['wallBreakIndex']
        self.round_state.first_dice = list(dice)
        self.round_state.second_dice = list(second_dice)
        # 指示牌 + 底张（不公开）：与前端 flipTiles 同口径，参与 136 张守恒。
        result['flipTiles'] = [result['flipTile'], ring_tiles[result['flipStack'] * 2 + 1]]
        return result

    # ── 旧 GameRuleSet 兼容桩 ──

    def is_flower_tile(self, tile: TileType) -> bool:
        return False

    def is_joker_tile(self, tile: TileType) -> bool:
        return tile in self.round_state.jokers

    def is_claimable_tile(self, tile: TileType) -> bool:
        return True

    def should_auto_win_on_flowers(self, count: int) -> bool:
        return False

    def resolve_win_tile(self, winner: GamePlayer, options: dict) -> TileType:
        if options.get('winTile'):
            return options['winTile']
        if winner.drawnTileIndex >= 0:
            return winner.hand[winner.drawnTileIndex]
        return winner.hand[-1]

    def draw_horses(self, wall: list[TileType], amount: int | None = None, seat: int = 0) -> dict:
        return {'horses': [], 'hits': 0}

    # ── 血流评估入口（权威计分） ──

    def evaluate_win(self, input: dict) -> WinEvaluation | None:
        """input 与前端 WinEvaluationInput 同构（camelCase JSON）。"""
        return evaluate_win(win_input_from_dict(input), BLOOD_FLOW_CONFIG)

    def evaluate_waits(self, concealed: list[TileType], melds: list[Meld],
                       jokers: list[TileType]) -> list[dict]:
        from app.core.blood_flow.types import WinEvaluationInput
        return evaluate_waits(WinEvaluationInput(
            concealed=tuple(concealed),
            melds=tuple({'type': m.type, 'tile': m.tile, 'tiles': m.tiles,
                         **({'windKong': True} if m.windKong else {})} for m in melds),
            winning_tile=concealed[-1] if concealed else 'm1',  # evaluate_waits 逐牌覆盖，仅占位
            source='self-draw', jokers=tuple(jokers), opening=None,
        ), BLOOD_FLOW_CONFIG)

    def resolve_win_batch(self, *, authority_epoch: str, round_id: str, sequence: int,
                          window_id: str, source: dict, winners: list[dict],
                          scores: list[int], wall_empty: bool) -> dict:
        return resolve_win_batch(
            authority_epoch=authority_epoch, round_id=round_id, sequence=sequence,
            rule_version=BLOOD_FLOW_CONFIG.version, window_id=window_id,
            source=source, winners=winners, scores=scores, wall_empty=wall_empty,
        )
