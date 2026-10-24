"""血流对局引擎 —— 从 src/game/variants/lotus/bloodFlow/engine.ts 逐行翻译（同步确定性版）。

无计时器/音频/Vue 副作用；房间层负责节拍与网络。每动作检查 136 张物理牌与零和。
"""

from dataclasses import dataclass, field
from typing import Literal, Optional

from app.core.lotus_rules import chi_options as lotus_chi_options, waiting_tiles
from app.core.blood_flow.kong_value import post_kong_state
from app.core.tiles import TILE_TYPES, sort_tiles_with_jokers
from app.core.blood_flow.config import BLOOD_FLOW_CONFIG
from app.core.blood_flow.types import SourceTileEvent, WinEvaluation
from app.rules.blood_flow import BloodFlowRuleSet

SEATS = (0, 1, 2, 3)
KONG_ACTIONS = frozenset(('gang', 'concealed-kong', 'added-kong', 'wind-kong'))


def next_seat(seat: int) -> int:
    return (seat + 1) % 4


def new_seat_states() -> list[dict]:
    return [{'winCount': 0, 'locked': False, 'firstWinSequence': None, 'recordIds': []} for _ in SEATS]


@dataclass
class BloodFlowEngine:
    authority_epoch: str
    round_id: str
    rules: BloodFlowRuleSet
    dealer: int = 0
    scores: Optional[list[int]] = None
    opening: Optional[dict] = None
    dice: Optional[list[int]] = None
    second_dice: Optional[list[int]] = None
    ring: Optional[list[str]] = None

    def __post_init__(self):
        self.dealer = self.dealer
        self.current_player = self.dealer
        opening = self.opening if self.opening is not None else self.deal()
        self.players = [dict(p) for p in opening['players']]
        self.wall = list(opening['wall'])
        self.flip_tiles = list(opening['flipTiles'])
        self.jokers = list(opening['jokers'])
        self.flip_stack = opening['flipStack']
        self.flip_seat = opening['flipSeat']
        self.wall_break_index = opening['wallBreakIndex']
        self.head_drawn = opening['headDrawn']
        # 庄家第 14 张放到最右，与普通摸牌路径一致。
        dealer = self.players[self.dealer]
        tile = dealer['hand'].pop(opening['dealerDrawnIndex'])
        dealer['hand'].append(tile)
        dealer['drawnTileIndex'] = len(dealer['hand']) - 1
        self.opening_scores = [p['score'] for p in self.players]
        self.seats = new_seat_states()
        self.archives: list[dict] = []
        self.ledger: list[dict] = []
        self.discard_actions: list[dict] = []
        # 动作流水（碰/吃/杠/补杠/暗杠/乱风杠/胡）：驱动前端动作字与语音，逐局自增 id。
        self.actions: list[dict] = []
        self.action_serial = 0
        self.window: Optional[dict] = None
        self.result: Optional[dict] = None
        self.version = 0
        self.sequence = 0
        self.interrupted = False
        self.evaluation: dict[int, WinEvaluation] = {}
        self.pending_kong: Optional[dict] = None
        self.draw_source: Optional[dict] = None
        self.opening_bonus = True
        self.first_discard = True
        self.self_passed = False
        self.kong_bloom = False
        self._source_serial = 0
        self.draw_source = self.source('draw', self.dealer, tile)
        self.open_turn()
        self.assert_conservation()

    # ── 开局 ──

    def deal(self) -> dict:
        # 骰子落定后留存于实例：房间快照需要下发开局动画用的第一/二次骰点。
        first_dice = self.dice if self.dice is not None else self._roll_pair()
        second_dice = self.second_dice if self.second_dice is not None else self._roll_pair()
        self.dice, self.second_dice = first_dice, second_dice
        result = self.rules.begin_round(
            dealer=self.dealer,
            dice=first_dice,
            second_dice=second_dice,
            random=None, ring=self.ring,
        )
        wall = result['wall']
        order = [(self.dealer + s) % 4 for s in SEATS]
        players: list[dict] = []
        for seat in range(4):
            players.append({'name': f'玩家{seat + 1}', 'avatar': '', 'seat': seat,
                            'score': (self.scores or [BLOOD_FLOW_CONFIG.initial_score] * 4)[seat],
                            'hand': [], 'melds': [], 'discards': [], 'redCount': 0, 'drawnTileIndex': -1})
        for _ in range(3):
            for seat in order:
                players[seat]['hand'].extend(wall[:4])
                del wall[:4]
        for seat in [*order, self.dealer]:
            players[seat]['hand'].append(wall.pop(0))
        last = players[self.dealer]['hand'].pop()
        for player in players:
            player['hand'] = sort_tiles_with_jokers(player['hand'], result['jokers'])
        players[self.dealer]['hand'].append(last)
        return {
            'players': players, 'wall': wall,
            'flipTiles': result['flipTiles'], 'jokers': result['jokers'],
            'headDrawn': 53, 'dealerDrawnIndex': 13,
            'flipStack': result['flipStack'], 'flipSeat': result['flipSeat'],
            'wallBreakIndex': result['wallBreakIndex'],
        }

    def _roll_pair(self) -> list[int]:
        import random as _random
        return [_random.randint(1, 6), _random.randint(1, 6)]

    # ── 来源与窗口 ──

    def source(self, kind: str, seat: int, tile: str) -> dict:
        self._source_serial += 1
        return {'kind': kind, 'seat': seat, 'tile': tile,
                'id': f'{self.authority_epoch}/{self.round_id}/tile/{self._source_serial}'}

    def open(self, kind: str, source: dict, options: list[list[dict]]) -> None:
        self.version += 1
        self.window = {
            'id': f'{self.round_id}/window/{self.version}', 'version': self.version,
            'kind': kind, 'source': source, 'opensAt': 0, 'deadlineAt': float('inf'),
            'options': options, 'decisions': [None, None, None, None],
        }

    def evaluate(self, seat: int, tile: str, source: str, opening: Optional[str] = None) -> Optional[WinEvaluation]:
        player = self.players[seat]
        concealed = list(player['hand'])
        if source in ('self-draw', 'kong-bloom'):
            concealed.pop(player['drawnTileIndex'])
        return self.rules.evaluate_win({
            'concealed': concealed,
            'melds': [{'type': m['type'], 'tile': m['tile'], 'tiles': m['tiles'],
                       **({'windKong': True} if m.get('windKong') else {})} for m in player['melds']],
            'winningTile': tile, 'source': source, 'jokers': self.jokers, 'opening': opening,
        })

    def open_turn(self) -> None:
        seat = self.current_player
        player = self.players[seat]
        moves: list[dict] = []
        self.evaluation.clear()
        if self.draw_source and not self.self_passed:
            win = self.evaluate(seat, self.draw_source['tile'],
                                'kong-bloom' if self.kong_bloom else 'self-draw',
                                'heaven' if self.opening_bonus and self.first_discard and seat == self.dealer else None)
            if win:
                self.evaluation[seat] = win
                moves.append({'kind': 'win'})
                # 锁手后不得过胡（用户确认）：自摸窗口也不给「过」，只能胡或打掉摸牌。
                if not self.seats[seat]['locked']:
                    moves.append({'kind': 'pass'})
        # 开杠（暗杠/风杠/补杠）只在「本手来自摸牌」时提供：碰/吃之后的这一手必须先出牌，
        # 与经典玩法的 userDrewThisTurn 门控同口径（此前碰完就能立刻开杠，用户报为错误）。
        # 胡后仍可开杠；吃碰后的回合仍须先出牌。
        if self.draw_source and self.wall:
            for tile in concealed_kongs(player['hand'], self.jokers):
                moves.append({'kind': 'concealed-kong', 'tile': tile})
            if wind_kong(player['hand']):
                moves.append({'kind': 'wind-kong'})
            for meld_index, m in enumerate(player['melds']):
                if m['type'] == 'peng' and m['tile'] in player['hand']:
                    moves.append({'kind': 'added-kong', 'meldIndex': meld_index})
        for index in range(len(player['hand'])):
            if not self.seats[seat]['locked'] or index == player['drawnTileIndex']:
                moves.append({'kind': 'discard', 'index': index})
        source = self.draw_source or self.source('draw', seat, player['hand'][-1])
        moves = [action for action in moves if self.kong_keeps_ready(seat, action)]
        options = [moves if s == seat else [] for s in SEATS]
        self.open('turn', source, options)

    def kong_keeps_ready(self, seat: int, action: dict, claimed_tile=None) -> bool:
        """胡后只能开杠仍听牌的组合；不依靠未知补牌修复失听。"""
        kind = action['kind']
        if not self.seats[seat]['locked'] or kind not in KONG_ACTIONS:
            return True
        player = self.players[seat]
        post = post_kong_state('discard-gang' if kind == 'gang' else kind,
                               player['hand'], player['melds'],
                               claimed_tile if kind == 'gang' else action.get('tile'),
                               action.get('meldIndex'))
        if post is None:
            return False
        owned = [*post['hand'], *[tile for meld in post['melds'] for tile in meld['tiles']]]
        return any(owned.count(tile) < 4 for tile in waiting_tiles(post['hand'], len(post['melds']), self.jokers))

    def command(self, seat: int, action: dict) -> dict:
        if not self.window:
            raise ValueError('No active action window')
        return {'authorityEpoch': self.authority_epoch, 'roundId': self.round_id,
                'windowId': self.window['id'], 'stateVersion': self.window['version'],
                'seat': seat, 'action': action}

    def submit(self, command: dict) -> bool:
        if self.interrupted or self.result or not self.window \
                or command['authorityEpoch'] != self.authority_epoch \
                or command['roundId'] != self.round_id \
                or not accept_window_decision(self.window, command):
            return False
        if window_complete(self.window):
            self.resolve_window()
        self.assert_conservation()
        return True

    def expire(self) -> None:
        """本地回退：未决定的座位 回合→摸打/兜底弃牌，其余→过；锁手座位按杠、胡的顺序兜底。"""
        window = self.window
        if self.interrupted or not window:
            return
        for seat in SEATS:
            if window['options'][seat] and window['decisions'][seat] is None:
                # 锁手后不能过胡，但可优先开杠。
                forced_win = None
                if self.seats[seat]['locked']:
                    # 与前端默认杠优先一致：仅到期后兜底，不提前替真人选择。
                    forced_win = next((a for a in window['options'][seat] if a['kind'] in KONG_ACTIONS), None)
                    forced_win = forced_win or next((a for a in window['options'][seat] if a['kind'] == 'win'), None)
                if forced_win is not None:
                    window['decisions'][seat] = forced_win
                elif window['kind'] == 'turn':
                    index = self.players[seat]['drawnTileIndex'] if self.seats[seat]['locked'] else fallback_discard(
                        self.players[seat]['hand'], self.jokers,
                        [a['index'] for a in window['options'][seat] if a['kind'] == 'discard'])
                    window['decisions'][seat] = {'kind': 'discard', 'index': index}
                else:
                    window['decisions'][seat] = {'kind': 'pass'}
        self.resolve_window()
        self.assert_conservation()

    # ── 窗口裁决 ──

    def _event(self, type_: str, actor: int, tile: str,
               source_index: Optional[int] = None, meld_index: int = -1) -> None:
        """记录一次桌面动作（与前端 engine.ts event() 同形状，id 逐局自增）。"""
        self.action_serial += 1
        self.actions.append({
            'id': self.action_serial, 'type': type_, 'actorIndex': actor,
            'sourceIndex': source_index, 'tile': tile, 'meldIndex': meld_index,
        })

    def resolve_window(self) -> None:
        window = self.window
        winners = [s for s in SEATS if window['decisions'][s] and window['decisions'][s]['kind'] == 'win']
        # 与前端默认规则对齐：同一弃牌的竞争按 杠 > 碰 > 吃 > 胡 裁决。
        if window['kind'] != 'turn':
            meld_claimants = sorted(
                (s for s in SEATS if window['decisions'][s]
                 and window['decisions'][s]['kind'] in ('gang', 'peng', 'chi')),
                key=lambda s: (claim_rank(window['decisions'][s]['kind']),
                               (s - window['source']['seat'] + 4) % 4),
            )
            if meld_claimants:
                return self.claim_meld(meld_claimants[0], window['decisions'][meld_claimants[0]], window['source'])
        if winners:
            return self.apply_win_batch(window, winners)
        if window['kind'] == 'turn':
            action = window['decisions'][self.current_player]
            if action['kind'] == 'pass':
                if self.seats[self.current_player]['locked']:
                    return self.discard(self.players[self.current_player]['drawnTileIndex'])
                self.self_passed = True
                return self.open_turn()
            if action['kind'] == 'discard':
                return self.discard(action['index'])
            return self.perform_kong(action)
        if self.pending_kong:
            return self.complete_added_kong()
        claimants = sorted(
            (s for s in SEATS if window['decisions'][s] and window['decisions'][s]['kind'] != 'pass'),
            key=lambda s: (claim_rank(window['decisions'][s]['kind']), (s - window['source']['seat'] + 4) % 4),
        )
        if not claimants:
            return self.draw(next_seat(window['source']['seat']))
        self.claim_meld(claimants[0], window['decisions'][claimants[0]], window['source'])

    def discard(self, index: int) -> None:
        seat = self.current_player
        player = self.players[seat]
        tile = player['hand'].pop(index)
        player['drawnTileIndex'] = -1
        player['discards'].append(tile)
        if not self.seats[seat]['locked']:
            player['hand'] = sort_tiles_with_jokers(player['hand'], self.jokers)
        self.draw_source = None
        source = self.source('discard', seat, tile)
        self.discard_actions.append(source)
        opening = 'earth' if self.first_discard and seat == self.dealer and self.opening_bonus else None
        self.first_discard = False
        self.open_win_claims(source, 'discard', opening)

    def open_win_claims(self, source: dict, win_source: str, opening: Optional[str] = None) -> None:
        self.evaluation.clear()
        options: list[list[dict]] = [[] for _ in SEATS]
        for seat in SEATS:
            if seat == source['seat']:
                continue
            actions: list[dict] = []
            win = self.evaluate(seat, source['tile'], win_source, opening)
            if win:
                self.evaluation[seat] = win
                actions.append({'kind': 'win'})
            if source['kind'] == 'discard' and self.wall:
                hand = self.players[seat]['hand']
                count = hand.count(source['tile'])
                if count >= 3 and self.kong_keeps_ready(seat, {'kind': 'gang'}, source['tile']):
                    actions.append({'kind': 'gang'})
                if count >= 2 and not self.seats[seat]['locked']:
                    actions.append({'kind': 'peng'})
                if seat == next_seat(source['seat']) and not self.seats[seat]['locked']:
                    for chi in lotus_chi_options(hand, source['tile']):
                        actions.append({'kind': 'chi', 'tiles': chi['tiles']})
            # 锁手后不得过胡：已胡过的座位仍可点炮/抢杠继续胡，但「过」不再是选项（用户确认）。
            if actions and not (self.seats[seat]['locked'] and win):
                actions.append({'kind': 'pass'})
            options[seat] = actions
        if any(options):
            self.open('win' if self.evaluation else 'meld', source, options)
        elif self.pending_kong:
            self.complete_added_kong()
        else:
            self.draw(next_seat(source['seat']))

    def claim_meld(self, seat: int, action: dict, source: dict) -> None:
        player = self.players[seat]
        self.players[source['seat']]['discards'].pop()
        tiles = list(action['tiles']) if action['kind'] == 'chi' else [source['tile']] * (4 if action['kind'] == 'gang' else 3)
        take = list(tiles)
        take.remove(source['tile'])
        for tile in take:
            player['hand'].remove(tile)
        meld_type = 'chi' if action['kind'] == 'chi' else 'gang' if action['kind'] == 'gang' else 'peng'
        player['melds'].append({'type': meld_type, 'tile': source['tile'], 'tiles': tiles, 'from': source['seat']})
        self._event('chi' if meld_type == 'chi' else 'discard-gang' if meld_type == 'gang' else 'peng',
                    seat, source['tile'], source['seat'], len(player['melds']) - 1)
        self.opening_bonus = False
        self.current_player = seat
        self.draw_source = None
        self.self_passed = False
        player['drawnTileIndex'] = -1
        if meld_type == 'gang':
            self.pay_kong(seat, 'discard', source['seat'])
            self.draw(seat, tail=True)
        else:
            player['hand'] = sort_tiles_with_jokers(player['hand'], self.jokers)
            self.open_turn()

    def perform_kong(self, action: dict) -> None:
        seat = self.current_player
        player = self.players[seat]
        if action['kind'] == 'added-kong':
            tile = player['melds'][action['meldIndex']]['tile']
            player['hand'].remove(tile)
            player['drawnTileIndex'] = -1
            source = self.source('added-kong', seat, tile)
            self.pending_kong = {'seat': seat, 'meldIndex': action['meldIndex'], 'source': source}
            self.draw_source = None
            return self.open_win_claims(source, 'robbed-kong')
        wind = action['kind'] == 'wind-kong'
        if not wind and action['kind'] != 'concealed-kong':
            raise ValueError('Invalid kong action')
        tiles = ['east', 'south', 'west', 'north'] if wind else [action['tile']] * 4
        for tile in tiles:
            player['hand'].remove(tile)
        player['melds'].append({'type': 'angang', 'tile': tiles[0], 'tiles': tiles,
                                **({'windKong': True} if wind else {})})
        self._event('wind-kong' if wind else 'concealed-gang', seat, tiles[0], None,
                    len(player['melds']) - 1)
        self.opening_bonus = False
        self.pay_kong(seat, 'wind' if wind else 'concealed')
        player['drawnTileIndex'] = -1
        self.draw(seat, tail=True)

    def complete_added_kong(self) -> None:
        pending = self.pending_kong
        meld = dict(self.players[pending['seat']]['melds'][pending['meldIndex']])
        meld['type'] = 'gang'
        meld['added'] = True
        meld['tiles'] = [*meld['tiles'], pending['source']['tile']]
        self.players[pending['seat']]['melds'][pending['meldIndex']] = meld
        self._event('added-gang', pending['seat'], pending['source']['tile'], None, pending['meldIndex'])
        self.pending_kong = None
        self.opening_bonus = False
        self.pay_kong(pending['seat'], 'added')
        self.draw(pending['seat'], tail=True)

    def pay_kong(self, actor: int, kong_kind: str, source_seat: Optional[int] = None) -> None:
        deltas = [0, 0, 0, 0]
        payers = [source_seat] if kong_kind == 'discard' else [s for s in SEATS if s != actor]
        amount = BLOOD_FLOW_CONFIG.base_points * BLOOD_FLOW_CONFIG.kong_payments[kong_kind]
        for payer in payers:
            deltas[payer] -= amount
            deltas[actor] += amount
        assert sum(deltas) == 0
        for i, p in enumerate(self.players):
            p['score'] += deltas[i]
        self.sequence += 1
        self.ledger.append({
            'kind': 'kong', 'authorityEpoch': self.authority_epoch, 'roundId': self.round_id,
            'sequence': self.sequence, 'id': f'{self.round_id}/kong/{self.sequence}',
            'actor': actor, 'kongKind': kong_kind, 'sourceSeat': source_seat,
            'deltas': deltas, 'scoresAfter': [p['score'] for p in self.players],
        })

    def apply_win_batch(self, window: dict, winners: list[int]) -> None:
        if any(a['id'] == window['source']['id'] for a in self.archives):
            raise ValueError('Source already archived')
        self.sequence += 1
        source = window['source']
        batch = self.rules.resolve_win_batch(
            authority_epoch=self.authority_epoch, round_id=self.round_id, sequence=self.sequence,
            window_id=window['id'], source=SourceTileEvent(
                id=source['id'], tile=source['tile'], seat=source['seat'], kind=source['kind']),
            winners=[{'seat': s, 'evaluation': self.evaluation[s],
                      'ordinal': self.seats[s]['winCount'] + 1} for s in winners],
            scores=[p['score'] for p in self.players], wall_empty=not self.wall,
        )
        if window['source']['kind'] == 'draw':
            self.players[window['source']['seat']]['hand'].pop(self.players[window['source']['seat']]['drawnTileIndex'])
        elif window['source']['kind'] == 'discard':
            self.players[window['source']['seat']]['discards'].pop()
        else:
            self.pending_kong = None
        self.players[window['source']['seat']]['drawnTileIndex'] = -1
        self.archives.append(dict(window['source']))
        for record in batch['winners']:
            previous = self.seats[record['winner']]
            self.seats[record['winner']] = {
                'winCount': record['ordinal'], 'locked': True,
                'firstWinSequence': previous['firstWinSequence'] if previous['firstWinSequence'] is not None else batch['sequence'],
                'recordIds': [*previous['recordIds'], record['id']],
            }
            win_source = record['score'].source
            self._event('self-draw' if win_source in ('self-draw', 'kong-bloom')
                        else 'robbed-kong-win' if win_source == 'robbed-kong' else 'discard-win',
                        record['winner'], window['source']['tile'],
                        None if window['source']['kind'] == 'draw' else window['source']['seat'])
        for i, p in enumerate(self.players):
            p['score'] = batch['scoresAfter'][i]
        self.ledger.append({'kind': 'win', 'batch': batch})
        self.opening_bonus = False
        self.draw_source = None
        next_action = batch['nextAction']
        if next_action['kind'] == 'finish-round':
            self.finish_round()
        else:
            self.draw(next_action['seat'])

    def draw(self, seat: int, tail: bool = False) -> None:
        if not self.wall:
            return self.finish_round()
        tile = take_lotus_tail_tile(self.wall, self.head_drawn) if tail else self.wall.pop(0)
        if not tail:
            self.head_drawn += 1
        player = self.players[seat]
        if not self.seats[seat]['locked']:
            player['hand'] = sort_tiles_with_jokers(player['hand'], self.jokers)
        player['hand'].append(tile)
        player['drawnTileIndex'] = len(player['hand']) - 1
        self.current_player = seat
        self.kong_bloom = tail
        self.self_passed = False
        self.draw_source = self.source('draw', seat, tile)
        self.open_turn()

    def finish_round(self) -> None:
        if self.result:
            return
        self.window = None
        self.version += 1
        self.result = summarize_round(BLOOD_FLOW_CONFIG.version, self.round_id, self.opening_scores,
                                      [p['score'] for p in self.players],
                                      [s['winCount'] for s in self.seats], self.ledger)

    def public_state(self) -> dict:
        return {
            'ruleVersion': BLOOD_FLOW_CONFIG.version, 'roundId': self.round_id,
            'status': 'settled' if self.result else 'interrupted' if self.interrupted else 'playing',
            'seats': self.seats,
            'batches': [e['batch'] for e in self.ledger if e['kind'] == 'win'],
            'roundResult': self.result,
        }

    def assert_conservation(self) -> None:
        physical = [*self.wall, *self.flip_tiles, *[a['tile'] for a in self.archives]]
        for p in self.players:
            physical.extend([*p['hand'], *p['discards'], *[t for m in p['melds'] for t in m['tiles']]])
        if self.pending_kong:
            physical.append(self.pending_kong['source']['tile'])
        if len(physical) != 136 or any(physical.count(t) != 4 for t in TILE_TYPES):
            raise ValueError('136-tile conservation failed')
        if any(not isinstance(p['score'], int) for p in self.players):
            raise ValueError('Invalid score')
        if sum(p['score'] for p in self.players) != sum(self.opening_scores):
            raise ValueError('Score conservation failed')


def take_lotus_tail_tile(wall: list[str], head_drawn: int) -> Optional[str]:
    """从牌尾取牌（杠后补牌）—— 与 app.core.lotus_wall.take_tail_tile 一致。"""
    from app.core.lotus_wall import take_tail_tile
    return take_tail_tile(wall, head_drawn)


def concealed_kongs(hand: list[str], jokers: list[str]) -> list[str]:
    return [tile for tile in set(hand) if hand.count(tile) == 4]


def wind_kong(hand: list[str]) -> bool:
    return all(wind in hand for wind in ('east', 'south', 'west', 'north'))


def fallback_discard(hand: list[str], jokers: list[str], allowed: list[int]) -> int:
    protected = set(jokers)
    candidates = [i for i in allowed if hand[i] not in protected]
    return (candidates or allowed)[0] if (candidates or allowed) else 0


def claim_rank(kind: str) -> int:
    return 0 if kind == 'gang' else 1 if kind == 'peng' else 2


def accept_window_decision(window: dict, command: dict) -> bool:
    seat = command['seat']
    if seat not in SEATS or window['id'] != command['windowId'] or window['version'] != command['stateVersion'] \
            or window['decisions'][seat] is not None:
        return False
    allowed = next((a for a in window['options'][seat] if a == command['action']), None)
    if allowed is None:
        return False
    window['decisions'][seat] = allowed
    return True


def window_complete(window: dict) -> bool:
    return all(not window['options'][s] or window['decisions'][s] is not None for s in SEATS)


def summarize_round(rule_version: str, round_id: str, opening: list[int], ending: list[int],
                    win_counts: list[int], ledger: list[dict]) -> dict:
    win_net = [0, 0, 0, 0]
    kong_net = [0, 0, 0, 0]
    for entry in ledger:
        if entry['kind'] == 'win':
            for s in SEATS:
                win_net[s] += entry['batch']['deltas'][s]
        else:
            for s in SEATS:
                kong_net[s] += entry['deltas'][s]
    order = sorted(SEATS, key=lambda s: (-ending[s], s))
    # 名次 1 基（与前端 roundLifecycle.summarizeRound 一致）：结算「N 名」与冠军高亮依赖它。
    ranks = [0] * 4
    for rank, seat in enumerate(order):
        ranks[seat] = rank + 1
    return {
        'ruleVersion': rule_version, 'roundId': round_id, 'reason': 'wall-exhausted',
        'openingScores': opening, 'endingScores': ending,
        'winNet': win_net, 'kongNet': kong_net, 'winCounts': win_counts,
        'ranks': ranks, 'ledger': ledger,
    }
