"""大明杠/暗杠/风杠的杠后全听策略回归。"""

import asyncio
from types import SimpleNamespace

import pytest

from app.core.kong_projection import project_kong_bloom
from app.core.tiles import TILE_TYPES
from app.game.llm_player import LLMPlayer
from app.game.player import ClaimContext, TurnContext
from app.rules.registry import get_rule_set

JOKERS = ['m3', 'm4']
POST_KONG_ALL_WAIT = [
    'm1', 'm2', 'm3',
    'p1', 'p2', 'p3',
    'red', 'red', 'red',
    'white',
]
STYLES = ('激进', '稳健', '话痨', '高冷')


def projection_input(kind):
    if kind == 'discard-gang':
        hand = [*POST_KONG_ALL_WAIT, 's9', 's9', 's9']
        return dict(kind=kind, hand=hand, exposed_melds=0, jokers=JOKERS,
                    tile='s9', visible_tiles=[*hand, 's9'])
    if kind == 'concealed-kong':
        hand = [*POST_KONG_ALL_WAIT, 's9', 's9', 's9', 's9']
        return dict(kind=kind, hand=hand, exposed_melds=0, jokers=JOKERS,
                    tile='s9', visible_tiles=hand)
    hand = [*POST_KONG_ALL_WAIT, 'east', 'south', 'west', 'north']
    return dict(kind=kind, hand=hand, exposed_melds=0, jokers=JOKERS,
                visible_tiles=hand)


def run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize('kind', ('discard-gang', 'concealed-kong', 'wind-kong'))
def test_three_kongs_project_to_all_34_waits(kind):
    result = project_kong_bloom(**projection_input(kind))
    assert result.legal
    assert result.post_kong_hand == POST_KONG_ALL_WAIT
    assert len(result.waits) == len(TILE_TYPES)
    assert result.guaranteed_kong_bloom


@pytest.mark.parametrize('style', STYLES)
def test_all_styles_force_three_guaranteed_kong_blooms(style, monkeypatch):
    config = SimpleNamespace(
        enabled=True, base_url='https://example.com/v1', api_key='unused',
        model='test', style=style, timeout_s=20.0, pool_timeout_s=1.0,
        concurrency=1, max_requests_per_room=0,
    )
    player = LLMPlayer(delays={'turn': 0, 'after_kong': 0, 'claim': 0}, config=config)
    rules = get_rule_set('lotus-legacy')
    rules.round_state.joker_tiles = list(JOKERS)
    player.set_rule_set(rules)

    async def forbidden_decide(*_args, **_kwargs):
        raise AssertionError('杠后全听强制策略不应请求 LLM')

    monkeypatch.setattr(player, '_decide', forbidden_decide)
    concealed = projection_input('concealed-kong')
    wind = projection_input('wind-kong')
    exposed = projection_input('discard-gang')

    concealed_action = run(player.request_turn(TurnContext(
        hand=concealed['hand'], melds=[], exposedMelds=0, kongBloom=False,
        skipDraw=False, afterKong=False, jokers=JOKERS,
        visibleTiles=concealed['visible_tiles'],
    )))
    wind_action = run(player.request_turn(TurnContext(
        hand=wind['hand'], melds=[], exposedMelds=0, kongBloom=False,
        skipDraw=False, afterKong=False, jokers=JOKERS,
        visibleTiles=wind['visible_tiles'],
    )))
    discard_action = run(player.request_claim(ClaimContext(
        hand=exposed['hand'], exposedMelds=0, canPeng=True, canGang=True,
        canHu=True, tile='s9', **{'from': 1}, jokers=JOKERS,
        visibleTiles=exposed['visible_tiles'],
    )))

    assert concealed_action == {'kind': 'concealed-kong', 'tile': 's9'}
    assert wind_action == {'kind': 'wind-kong'}
    assert discard_action == {'kind': 'gang'}
    assert player.stats['requests'] == 0
