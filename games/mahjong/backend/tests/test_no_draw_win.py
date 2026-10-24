"""A peng/chi turn has no new self-draw win opportunity, even with a winning shape."""

import pytest

from app.game.manager import GameManager
from app.game.player import AIPlayer
from app.game.remote_player import RemotePlayer
from app.llm.candidates import build_request
from app.models.game import GamePlayer, Meld
from app.rules.registry import get_rule_set
from tests.test_llm import make_llm_player, run, turn_ctx


AFTER_PENG = ['m1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'm5', 'm5']
PENG = Meld(type='peng', tile='east', from_=0, tiles=['east'] * 3)
OPENING_WIN = ['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3',
               's1', 's1', 's1', 's2', 's2']


def after_peng_context():
    ctx = turn_ctx(hand=AFTER_PENG, melds=[PENG], exposed_melds=1,
                   skip_draw=True, turnOrigin='peng')
    ctx.canHu = False
    return ctx


def test_classic_bot_and_llm_only_discard_after_peng(monkeypatch):
    rules = get_rule_set('lotus-classic')
    ctx = after_peng_context()
    assert rules.is_winning_hand(ctx.hand, ctx.exposedMelds)
    assert run(AIPlayer(rule_set=rules).request_turn(ctx))['kind'] == 'discard'
    built = build_request(ctx, rules, 'peng', '1', 'turn')
    assert all(candidate['action']['kind'] == 'discard'
               for candidate in built['request']['candidates'])
    llm, _ = make_llm_player(monkeypatch, ['{"choice":"A1","message":"先打。"}'])
    assert run(llm.request_turn(ctx))['kind'] == 'discard'
    invalid_llm, _ = make_llm_player(monkeypatch, ['{"choice":"WIN","message":"胡！"}'])
    assert run(invalid_llm.request_turn(ctx))['kind'] == 'discard'
    failed_llm, _ = make_llm_player(monkeypatch, [RuntimeError('provider down')])
    assert run(failed_llm.request_turn(ctx))['kind'] == 'discard'


def test_ws_turn_validation_rejects_hu_and_kong_after_peng():
    ctx = after_peng_context()
    remote = RemotePlayer(1, None, rule_set=get_rule_set('lotus-classic'))
    remote._pending_kind = 'turn'
    remote._last_ctx = ctx
    assert remote._validate({'type': 'hu'}) == (None, 'INVALID_ACTION')
    assert remote._validate({'type': 'gang', 'kind': 'concealed', 'tile': 'm1'}) == (
        None, 'INVALID_ACTION')
    assert remote._validate({'type': 'discard', 'handIndex': 0}) == (
        {'kind': 'discard', 'handIndex': 0}, '')


@pytest.mark.asyncio
async def test_authority_refuses_a_faulty_win_after_peng():
    captured = {}

    class FaultyController:
        async def request_turn(self, ctx):
            captured['ctx'] = ctx
            return {'kind': 'win'}

    manager = GameManager(mode='east', controllers=[FaultyController() for _ in range(4)])
    manager.players = [
        GamePlayer(name=f'P{seat}', avatar='', score=1000, seat=seat,
                   hand=list(AFTER_PENG if seat == 1 else ['p9'] * 13),
                   discards=[], melds=[PENG] if seat == 1 else [],
                   redCount=0, drawnTileIndex=-1)
        for seat in range(4)
    ]
    manager._table_context.players = manager.players
    manager.wall = ['m9'] * 30

    async def record_discard(seat, index):
        captured['discard'] = (seat, index)

    manager.discard_tile = record_discard
    await manager.begin_turn(1, skip_draw=True, after_claim='peng')
    assert captured['ctx'].canHu is False
    assert captured['discard'] == (1, 0)
    assert manager.phase != 'settled'


def test_dealer_opening_still_allows_a_valid_win():
    ctx = turn_ctx(hand=OPENING_WIN, skip_draw=True, turnOrigin='opening')
    ctx.canHu = True
    rules = get_rule_set('lotus-classic')
    assert run(AIPlayer(rule_set=rules).request_turn(ctx)) == {'kind': 'win'}
    remote = RemotePlayer(0, None, rule_set=rules)
    remote._pending_kind = 'turn'
    remote._last_ctx = ctx
    assert remote._validate({'type': 'hu'}) == ({'kind': 'win'}, '')
