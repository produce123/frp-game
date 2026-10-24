import pytest

from app.core.lotus_rules import (
    chi_options,
    evaluate_pattern,
    is_seven_pairs,
    is_thirteen_lan,
    is_thirteen_orphans,
)
from app.core.lotus_wall import build_lotus_wall, compute_jokers, next_in_sequence
from app.models.game import Meld
from app.rules.lotus_legacy import LotusLegacyRuleSet
from app.settlement import settlement_service
from app.game.manager import GameManager
from app.game.player import AIPlayer


def test_lotus_wall_removes_flip_stack_and_computes_jokers():
    result = build_lotus_wall(
        dealer=0, dice=(2, 3), second_dice=(4, 4), random=lambda: 0,
    )
    assert len(result['wall']) == 134
    assert result['jokers'] == compute_jokers(result['flipTile'])
    assert next_in_sequence('m9') == 'm1'
    assert next_in_sequence('north') == 'east'


def test_lotus_compute_jokers_keeps_white_when_flip_is_white_or_green():
    # 白板翻精：精牌 = [白板, 红中]（白板本身作精，可替代任意牌）
    assert compute_jokers('white') == ['white', 'red']
    # 发财翻精：同序下一张是白板 → 白板也是精
    assert compute_jokers('green') == ['green', 'white']
    # 普通翻精：指示牌 + 同序下一张
    assert compute_jokers('m5') == ['m5', 'm6']


def test_lotus_special_patterns():
    seven_pairs = [
        'm1', 'm1', 'm2', 'm2', 'm3', 'm3', 'm4', 'm4',
        'p1', 'p1', 'p2', 'p2', 's1', 's1',
    ]
    orphans = [
        'm1', 'm9', 'p1', 'p9', 's1', 's9',
        'east', 'south', 'west', 'north', 'red', 'green', 'white', 'white',
    ]
    lan = ['m1', 'm4', 'm7', 'p2', 'p5', 'p8', 's3', 's6', 's9',
           'east', 'south', 'red', 'green', 'white', 'north']
    assert is_seven_pairs(seven_pairs, [])
    assert is_thirteen_orphans(orphans, [])
    assert is_thirteen_lan(lan[:14], [])


def test_lotus_qi_xing_allows_joker_to_substitute_missing_honor():
    # 物理缺 white；精牌 m2 替补成 white → 仍成立七星十三烂（七字允许精牌替补）。
    hand = ['east', 'south', 'west', 'north', 'red', 'green',
            'm1', 'm4', 'm7', 'p2', 'p5', 'p8', 's1', 'm2']
    result = evaluate_pattern(hand, 0, ['m2', 'm3'])
    assert result == {'pattern': 'qiXing', 'fan': 4, 'label': '七星十三烂'}


def test_lotus_qi_xing_requires_usable_joker_for_missing_honor():
    # 物理缺 white，且无精可替补 → 只算十三烂（2 番）。
    hand = ['east', 'south', 'west', 'north', 'red', 'green',
            'm1', 'm4', 'm7', 'p2', 'p5', 'p8', 's1', 's4']
    result = evaluate_pattern(hand, 0, [])
    assert result == {'pattern': 'shiSanLan', 'fan': 2, 'label': '十三烂'}


def test_lotus_thirteen_orphans_allows_joker_substitution():
    # 缺 s9，由精牌 m2/m3 替补（m2→s9、m3→成对）→ 仍成立十三幺。
    terminals = ['m1', 'm9', 'p1', 'p9', 's1', 's9',
                 'east', 'south', 'west', 'north', 'red', 'green', 'white']
    hand = [tile for tile in terminals if tile != 's9'] + ['m2', 'm3']
    result = evaluate_pattern(hand, 0, ['m2', 'm3'])
    assert result == {'pattern': 'thirteenOrphans', 'fan': 8, 'label': '十三幺'}


def test_lotus_thirteen_orphans_rejects_non_terminal_pair():
    # 重复的是非幺九牌 m2 → 不成立。
    terminals = ['m1', 'm9', 'p1', 'p9', 's1', 's9',
                 'east', 'south', 'west', 'north', 'red', 'green', 'white']
    assert evaluate_pattern(terminals + ['m2'], 0, []) is None


def test_lotus_chi():
    assert chi_options(['m4', 'm6'], 'm5') == [
        {'tile': 'm5', 'tiles': ['m4', 'm5', 'm6'], 'kind': 'sequence'}
    ]


@pytest.mark.parametrize(
    ('winner_index', 'self_draw_style', 'discarder_index', 'expected'),
    [
        (0, True, None, {0: 1200, 1: -400, 2: -400, 3: -400}),
        (1, False, 0, {0: -400, 1: 600, 2: -100, 3: -100}),
        (1, True, None, {0: -400, 1: 800, 2: -200, 3: -200}),
        (0, False, 1, {0: 800, 1: -400, 2: -200, 3: -200}),
        (2, False, 1, {0: -200, 1: -200, 2: 500, 3: -100}),
    ],
)
def test_lotus_pinghu_settlement_five_cases(
    winner_index, self_draw_style, discarder_index, expected,
):
    result = settlement_service.calculate_lotus_win(
        player_count=4, winner_index=winner_index, base_fan=1,
        winner_is_dealer=winner_index == 0,
        self_draw_style=self_draw_style, dealer_index=0,
        discarder_index=discarder_index,
    )
    assert result.total_won == expected[winner_index]
    assert {item['playerIndex']: item['amount'] for item in result.deltas} == expected


def test_lotus_ruleset_score_has_base_and_display_fan():
    rules = LotusLegacyRuleSet()
    rules.round_state.joker_tiles = []
    hand = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9',
            'p1', 'p2', 'p3', 's1', 's1']
    result = rules.score_legacy_hand(hand, 0, dealer=False, self_draw=False)
    assert result['baseFan'] == 1
    assert result['settlement']['total'] == 500


def test_lotus_tianhu_and_dihu_are_ten_fan_and_pay_flat():
    """天地胡：10 番，三家各付 底分×10，不计庄家 ×2、不计点炮者 ×2。"""
    rules = LotusLegacyRuleSet()
    rules.round_state.joker_tiles = []
    hand = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9',
            'p1', 'p2', 'p3', 's1', 's1']
    tianhu = rules.score_legacy_hand(hand, 0, dealer=True, self_draw=True, tianhu=True)
    assert tianhu['baseFan'] == 10
    assert tianhu['fan'] == 10
    assert tianhu['patterns'] == [{'label': '天胡', 'multiplier': 10}]
    assert tianhu['settlement'] == {
        'H': 1000, 'dealerPays': 1000, 'nonDealerPays': 1000, 'total': 3000,
    }
    # 地胡是庄家点炮，但庄家那一笔同样不翻倍。
    dihu = rules.score_legacy_hand(
        hand, 0, dealer=False, self_draw=False, dihu=True,
        win_tile='s1', discarder_is_dealer=True,
    )
    assert dihu['baseFan'] == 10
    assert dihu['patterns'] == [{'label': '地胡', 'multiplier': 10}]
    assert dihu['settlement'] == {
        'H': 1000, 'dealerPays': 1000, 'nonDealerPays': 1000, 'total': 3000,
    }


@pytest.mark.parametrize(
    ('winner_index', 'discarder_index'),
    [(0, None), (1, 0)],
)
def test_lotus_opening_win_pays_flat_one_share_per_player(winner_index, discarder_index):
    """天胡（庄家自摸）与地胡（闲家胡庄家首弃）都是三家各付 1000。"""
    result = settlement_service.calculate_lotus_win(
        player_count=4, winner_index=winner_index, base_fan=10,
        winner_is_dealer=winner_index == 0, self_draw_style=True,
        dealer_index=0, discarder_index=discarder_index, equal_payment=True,
    )
    expected = {index: (3000 if index == winner_index else -1000) for index in range(4)}
    assert result.total_won == 3000
    assert {item['playerIndex']: item['amount'] for item in result.deltas} == expected


def test_lotus_dihu_dealer_discarder_pays_one_share_only():
    """地胡走完整对局路径：庄家既是庄又是点炮者，也只付一份 1000。"""
    rules = LotusLegacyRuleSet()
    rules.round_state.joker_tiles = []
    manager = GameManager(
        controllers=[AIPlayer() for _ in range(4)],
        rule_set=rules,
    )
    manager._reset_players()
    manager.phase = 'checking'
    manager.players[0].discards = ['m3']
    manager.players[1].hand = [
        'm1', 'm2', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9',
        'p1', 'p2', 'p3', 's1', 's1',
    ]

    manager.end_game(1, {'winTile': 'm3', 'dihu': True, 'sourceFrom': 0})

    assert manager.phase == 'settled'
    assert manager.result['winType'] == 'dihu'
    assert manager.result['multiplier'] == 10
    assert manager.result['points'] == 1000
    assert manager.result['totalWon'] == 3000
    assert [player.score for player in manager.players] == [1000, 5000, 1000, 1000]


def test_lotus_discard_win_uses_the_physical_discard_tile():
    rules = LotusLegacyRuleSet()
    rules.round_state.joker_tiles = []
    manager = GameManager(
        controllers=[AIPlayer() for _ in range(4)],
        rule_set=rules,
    )
    manager._reset_players()
    manager.phase = 'checking'
    manager.players[0].discards = ['m3']
    manager.players[1].hand = [
        'm1', 'm2', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9',
        'p1', 'p2', 'p3', 's1', 's1',
    ]
    manager.end_game(1, {'winTile': 'm3', 'sourceFrom': 0})
    assert manager.phase == 'settled'
    assert manager.players[0].discards == []
    assert manager.result['winnerIndex'] == 1
    assert manager.result['totalWon'] == 600
    assert [player.score for player in manager.players] == [1600, 2600, 1900, 1900]
    # 点炮胡：赢家手牌保持 13 张，和牌由 winTile 单独携带（不再追加进手牌）。
    assert len(manager.players[1].hand) == 13
    assert 'm3' not in manager.players[1].hand


def test_lotus_robbed_kong_win_conserves_the_robbed_tile():
    rules = LotusLegacyRuleSet()
    rules.round_state.joker_tiles = []
    manager = GameManager(
        controllers=[AIPlayer() for _ in range(4)],
        rule_set=rules,
    )
    manager._reset_players()
    # 补杠副露（pending gang）供抢杠还原
    manager.players[0].melds = [
        Meld(type='gang', tile='m3', tiles=['m3', 'm3', 'm3', 'm3'],
             added=True, pending=True),
    ]
    manager.players[1].hand = [
        'm1', 'm2', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9',
        'p1', 'p2', 'p3', 's1', 's1',
    ]

    manager.end_game(1, {
        'winTile': 'm3',
        'robbedKong': True,
        'robbedKongPlayerIndex': 0,
    })

    assert manager.phase == 'settled'
    assert manager.result['winnerIndex'] == 1
    # 杠副露还原为碰（3 张），被抢的杠牌进入抢杠者手牌，牌数守恒（14 张）。
    assert manager.players[0].melds[0].type == 'peng'
    assert manager.players[0].melds[0].tiles == ['m3', 'm3', 'm3']
    assert len(manager.players[1].hand) == 14
    assert manager.players[1].hand.count('m3') == 1


def test_lotus_waiting_tiles_reports_joker_face_as_wait():
    rules = LotusLegacyRuleSet()
    rules.round_state.joker_tiles = ['red']
    hand = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'east']
    waits = rules.waiting_tiles(hand, 0)
    assert 'east' in waits
    # 精牌面本身是听口：补入后作为癞子与 east 成对。
    assert 'red' in waits


def test_find_claims_priority_gang_over_peng_over_chi():
    """弃牌响应全局优先级：杠 > 碰 > 吃（与座位距离无关），对齐前端 findClaims。"""
    rules = LotusLegacyRuleSet()
    rules.round_state.joker_tiles = []
    manager = GameManager(
        controllers=[AIPlayer() for _ in range(4)],
        rule_set=rules,
    )
    manager._reset_players()
    manager.phase = 'checking'
    # 0 号弃牌（from_=0）
    manager.players[0].hand = []
    # 1 号（距离1）：能吃 m5（m3+m4+m5），不能碰/杠
    manager.players[1].hand = ['m3', 'm4', 'p9']
    # 2 号（距离2）：能碰 m5
    manager.players[2].hand = ['m5', 'm5', 'p9']
    # 3 号（距离3）：能明杠 m5
    manager.players[3].hand = ['m5', 'm5', 'm5', 'p9']

    claimants = manager.find_claims(0, 'm5')

    # 远家杠 > 近家碰 > 下家吃，与座位距离无关
    assert [c['playerIndex'] for c in claimants] == [3, 2, 1]
    assert claimants[0]['canGang'] is True
    assert claimants[1]['canPeng'] is True and claimants[1]['canGang'] is False
    assert claimants[2]['chiOptions'] == [
        {'tile': 'm5', 'tiles': ['m3', 'm4', 'm5'], 'kind': 'sequence'}
    ]


def test_find_claims_priority_hu_first():
    """胡 > 杠：能胡的远家优先于能明杠的近家。"""
    rules = LotusLegacyRuleSet()
    rules.round_state.joker_tiles = []
    manager = GameManager(
        controllers=[AIPlayer() for _ in range(4)],
        rule_set=rules,
    )
    manager._reset_players()
    manager.phase = 'checking'
    # 0 号弃牌（from_=0）弃 s1
    manager.players[0].hand = []
    # 1 号：无响应能力
    manager.players[1].hand = ['p9', 'p9', 'p9']
    # 2 号（距离2）：能明杠 s1
    manager.players[2].hand = ['s1', 's1', 's1', 'm1']
    # 3 号（距离3）：听 s1（123m 456m 789m 123p s1s1）
    manager.players[3].hand = [
        'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9',
        'p1', 'p2', 'p3', 's1',
    ]

    claimants = manager.find_claims(0, 's1')

    assert [c['playerIndex'] for c in claimants] == [3, 2]
    assert claimants[0]['canHu'] is True
    assert claimants[1]['canGang'] is True and claimants[1]['canHu'] is False


# ── 听任意只能自摸（2026-10 规则）──────────────────────────────
# 听任意 = 听口覆盖全部 34 种牌（典型形态：单吊精牌）。此时点炮胡（含地胡）
# 与抢杠胡均不成立，只有自摸（含杠上开花）可胡。

ANY_WAIT_JOKERS = ['m5']
ANY_WAIT_HAND = [
    'm1', 'm2', 'm3', 's1', 's2', 's3', 'p1', 'p2', 'p3',
    'east', 'east', 'east', 'm5',   # 4 面子 + 单吊精牌 m5 → 补任意牌都能与精成对
]
PLAIN_TENPAI_HAND = [
    'm1', 'm2', 'm3', 's1', 's2', 's3', 'p1', 'p2', 'p3',
    'east', 'east', 'east', 's7',   # 单骑 s7：普通听口，点炮/抢杠照旧
]


def _any_wait_rules() -> LotusLegacyRuleSet:
    rules = LotusLegacyRuleSet()
    rules.round_state.joker_tiles = list(ANY_WAIT_JOKERS)
    return rules


def test_any_wait_covers_every_tile():
    rules = _any_wait_rules()
    assert rules.is_any_wait(ANY_WAIT_HAND, 0)
    assert len(rules.waiting_tiles(ANY_WAIT_HAND, 0)) == 34
    assert not rules.is_any_wait(PLAIN_TENPAI_HAND, 0)
    # 单骑 s7：听口 = s7 + 精牌面 m5（摸到精也能与 s7 成对），远未覆盖 34 种。
    assert set(rules.waiting_tiles(PLAIN_TENPAI_HAND, 0)) == {'s7', 'm5'}


def test_any_wait_blocks_discard_hu_but_keeps_self_draw():
    """听任意时 find_claims 不再给出 canHu（地胡依附 canHu 一并失效）；自摸判定不受影响。"""
    rules = _any_wait_rules()
    # 自摸仍成立：补任意牌都成胡
    assert rules.is_winning_hand([*ANY_WAIT_HAND, 's7'], 0)
    assert rules.is_winning_hand([*ANY_WAIT_HAND, 'white'], 0)
    manager = GameManager(
        controllers=[AIPlayer() for _ in range(4)],
        rule_set=rules,
    )
    manager._reset_players()
    manager.phase = 'checking'
    manager.players[0].hand = []
    manager.players[1].hand = ['p9', 'p9', 'p9']
    manager.players[2].hand = ['p8', 'p8', 'p8']
    manager.players[3].hand = list(ANY_WAIT_HAND)
    # s7 补进 3 号手牌成胡，但听任意 → 不提供点炮响应（无碰/杠/吃可响应时整列为空）
    assert manager.find_claims(0, 's7') == []
    # 对照：换成普通单骑听 s7 → 点炮胡照常提供
    manager.players[3].hand = list(PLAIN_TENPAI_HAND)
    claimants = manager.find_claims(0, 's7')
    assert [c['playerIndex'] for c in claimants] == [3]
    assert claimants[0]['canHu'] is True


def test_any_wait_keeps_peng_gang_on_discard():
    """听任意封的是胡，不封碰/杠/吃：精牌按自身牌面仍可参与副露响应。"""
    rules = _any_wait_rules()
    manager = GameManager(
        controllers=[AIPlayer() for _ in range(4)],
        rule_set=rules,
    )
    manager._reset_players()
    manager.phase = 'checking'
    manager.players[0].hand = []
    manager.players[1].hand = ['s8', 's8', 's8']   # 与 p9 无碰/杠/吃关联
    manager.players[2].hand = ['p8', 'p8', 'p8']
    # 3 号：3 顺 + p9 刻 + 单吊精 m5 → 仍是听任意，同时手里有三张 p9。
    manager.players[3].hand = [
        'm1', 'm2', 'm3', 's1', 's2', 's3', 'p1', 'p2', 'p3',
        'p9', 'p9', 'p9', 'm5',
    ]
    assert rules.is_any_wait(manager.players[3].hand, 0)
    claimants = manager.find_claims(0, 'p9')
    assert [c['playerIndex'] for c in claimants] == [3]
    assert claimants[0]['canPeng'] is True
    assert claimants[0]['canGang'] is True
    assert claimants[0]['canHu'] is False   # p9 补进也成胡，但听任意被封锁


def test_any_wait_blocks_rob_kong():
    """听任意不可抢杠胡（只能自摸口径含抢杠）；普通听口抢杠照旧。"""
    rules = _any_wait_rules()
    assert rules.can_rob_kong(ANY_WAIT_HAND, 's7', 0) is False
    assert rules.can_rob_kong(ANY_WAIT_HAND, 'm5', 0) is False
    assert rules.can_rob_kong(PLAIN_TENPAI_HAND, 's7', 0) is True
    assert rules.can_rob_kong(PLAIN_TENPAI_HAND, 'p4', 0) is False
