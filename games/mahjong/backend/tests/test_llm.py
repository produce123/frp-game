"""LLM 后端接入单元测试 —— 文档 §13（无网络：mock 供应商调用）。

覆盖：规范/解析、候选与特征、合法性校验、LLMPlayer 三路径（成功/非法/异常回退、
胡短路、skipDraw 约束）、房间装配（llmEnabled/能力探测）、局况元数据。
"""

import asyncio
import json
import os
from types import SimpleNamespace

import httpx
import pytest

from app.game.llm_player import LLMPlayer
from app.game.player import ClaimContext, TurnContext
from app.llm.candidates import build_request
from app.llm.client import extract_json_object, parse_llm_output
from app.llm.prompt import build_prompt
from app.llm.schema import TILE_NAMES, tile_name
from app.llm.validation import validate_action
from app.models.game import Meld
from app.rules.registry import get_rule_set
from app.settlement import settlement_service


# ── 基础上下文工厂 ───────────────────────────────────────────

def run(coro):
    """在独立事件循环中执行协程（不依赖 pytest-asyncio 的全局循环状态）。"""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def turn_ctx(hand=None, melds=None, exposed_melds=0, skip_draw=False, **overrides):
    data = dict(
        hand=hand or ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9',
                      'p1', 'p2', 'p3', 'p4', 'white'],
        melds=melds or [],
        exposedMelds=exposed_melds,
        kongBloom=False,
        skipDraw=skip_draw,
        afterKong=False,
        playerIndex=0,
        visibleTiles=[],
        publicTiles=[],
        wallCount=60,
        scores=[1000, 1000, 1000, 1000],
        peers=[{'discards': [], 'melds': []} for _ in range(4)],
        seatWind='东', roundWind='东', dealerIndex=0, roundIndex=1,
        requestId='turn-0-1', stateVersion='1:drawing:60:0:0:13',
        **overrides,
    )
    return TurnContext(**data)


def claim_ctx(hand=None, tile='m3', can_peng=True, can_gang=False, chi_options=None,
              can_hu=False, **overrides):
    data = dict(
        hand=hand or ['m3', 'm3', 'm5', 'm6', 'm7', 'm8', 'p2', 'p3', 'p4',
                      's1', 's2', 's3', 'east'],
        canGang=can_gang,
        canHu=can_hu,
        canPeng=can_peng,
        chiOptions=chi_options or [],
        tile=tile,
        from_=1,
        exposedMelds=0,
        playerIndex=0,
        visibleTiles=[],
        publicTiles=[],
        wallCount=60,
        scores=[1000, 1000, 1000, 1000],
        peers=[{'discards': [], 'melds': []} for _ in range(4)],
        seatWind='东', roundWind='东', dealerIndex=0, roundIndex=1,
        requestId='claim-1-2', stateVersion='1:checking:60:0:0:13',
        **overrides,
    )
    return ClaimContext(**data)


# ── 解析器 ───────────────────────────────────────────────────

class TestParsing:
    def test_balanced_brace_scanner_skips_strings(self):
        text = '好的 {"choice":"A1","message":"大{括}号"} 完毕'
        assert extract_json_object(text) == '{"choice":"A1","message":"大{括}号"}'

    def test_parse_valid_and_whitelist(self):
        assert parse_llm_output('{"choice":"A1","message":"哈哈哈"}', ['A1', 'A2']) == ('A1', '哈哈哈')
        with pytest.raises(Exception):
            parse_llm_output('{"choice":"A9"}', ['A1', 'A2'])


# ── 端点规范化（§7.2 安全约束）──────────────────────────────

class TestEndpoint:
    def test_remote_https_accepted(self):
        # 回归：远端 https 曾被误判为「协议不支持」（group(1) 不带冒号却比 'https:'）
        from app.llm.client import _normalize_endpoint
        assert _normalize_endpoint('https://api.deepseek.com/v1') == \
            'https://api.deepseek.com/v1/chat/completions'
        assert _normalize_endpoint('https://api.anthropic.com/v1/') == \
            'https://api.anthropic.com/v1/chat/completions'
        assert _normalize_endpoint('https://x.com/chat/completions') == \
            'https://x.com/chat/completions'

    def test_remote_http_rejected(self):
        from app.llm.client import _normalize_endpoint
        assert _normalize_endpoint('http://api.deepseek.com/v1') is None

    def test_localhost_http_allowed(self):
        from app.llm.client import _normalize_endpoint
        assert _normalize_endpoint('http://127.0.0.1:8000/v1') == \
            'http://127.0.0.1:8000/v1/chat/completions'
        assert _normalize_endpoint('http://localhost:4321') == \
            'http://localhost:4321/chat/completions'

    def test_userinfo_and_empty_rejected(self):
        from app.llm.client import _normalize_endpoint
        assert _normalize_endpoint('https://user:pass@host.com/v1') is None
        assert _normalize_endpoint('') is None
        assert _normalize_endpoint('ftp://host.com') is None


# ── 候选枚举 ─────────────────────────────────────────────────

class TestCandidates:
    def test_full_unique_honor_names_keep_green_and_white_actions_distinct(self):
        honors = ('east', 'south', 'west', 'north', 'red', 'green', 'white')
        names = [tile_name(tile) for tile in honors]
        assert names == ['东风', '南风', '西风', '北风', '红中', '发财', '白板']
        assert len(set(names)) == len(names)
        assert TILE_NAMES['green'] != TILE_NAMES['white']

        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = ['green', 'white']
        ctx = turn_ctx(hand=['green', 'white'], jokers=['green', 'white'])
        ctx.visibleTiles = list(ctx.hand)
        built = build_request(ctx, rules, 'r1', 'v1', 'turn')
        discards = [c for c in built['request']['candidates']
                    if c['action']['kind'] == 'discard']
        assert [(c['label'], c['action']) for c in discards] == [
            ('出发财', {'kind': 'discard', 'handIndex': 0}),
            ('出白板', {'kind': 'discard', 'handIndex': 1}),
        ]

    def test_turn_discard_dedupe(self):
        ctx = turn_ctx(hand=['m3', 'm3', 'm5'])
        built = build_request(ctx, get_rule_set(), 'r1', 'v1', 'turn')
        labels = [c['label'] for c in built['request']['candidates'] if c['action']['kind'] == 'discard']
        assert labels == ['出3万', '出5万']
        assert built['engineSuggestion'] is not None

    def test_skip_draw_only_discard(self):
        ctx = turn_ctx(hand=['m3', 'm3', 'm3', 'm3'], melds=[], exposed_melds=0, skip_draw=True)
        built = build_request(ctx, get_rule_set(), 'r1', 'v1', 'turn')
        assert all(c['action']['kind'] == 'discard' for c in built['request']['candidates'])

    def test_claim_candidates_pass_gang_peng(self):
        ctx = claim_ctx(tile='m3', can_peng=True, can_gang=True)
        built = build_request(ctx, get_rule_set(), 'r1', 'v1', 'claim')
        assert [c['id'] for c in built['request']['candidates']] == ['Z', 'G', 'P']
        assert next(c for c in built['request']['candidates'] if c['id'] == 'G')['label'] == '大明杠3万'

    def test_claim_omits_peng_when_it_would_discard_the_claimed_tile(self):
        hand = [
            'east', 'east', 'east',
            'm1', 'm2', 'm3', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'north',
        ]
        ctx = claim_ctx(hand=hand, tile='east', can_peng=True, can_gang=True)
        ctx.visibleTiles = [*hand, 'east']
        ctx.publicTiles = ['east']
        built = build_request(ctx, get_rule_set(), 'r1', 'v1', 'claim')

        assert [candidate['id'] for candidate in built['request']['candidates']] == ['Z', 'G']
        assert built['engineSuggestion'] == 'G'

    def test_lotus_wind_kong(self):
        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = []
        ctx = turn_ctx(hand=['east', 'south', 'west', 'north', 'm3', 'm3', 'm5'],
                       exposed_melds=0)
        built = build_request(ctx, rules, 'r1', 'v1', 'turn')
        kinds = [c['action']['kind'] for c in built['request']['candidates']]
        assert 'wind-kong' in kinds

    def test_lotus_four_wind_wait_omits_destructive_wind_kong(self):
        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = []
        hand = ['s3', 's4', 's5', 'east', 'south', 'west', 'north', 'p9']
        ctx = turn_ctx(hand=hand, exposed_melds=2, jokers=[])
        ctx.visibleTiles = hand
        built = build_request(ctx, rules, 'r1', 'v1', 'turn')
        candidates = built['request']['candidates']
        assert not any(c['action']['kind'] == 'wind-kong' for c in candidates)
        discard_p9 = next(c for c in candidates if c['label'] == '出9筒')
        assert discard_p9['features']['ready'] is True

    def test_claim_chi_options(self):
        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = []
        ctx = claim_ctx(hand=['m4', 'm5', 'east'], tile='m3', can_peng=False,
                        chi_options=[{'tiles': ['m3', 'm4', 'm5'], 'kind': 'sequence'}])
        built = build_request(ctx, rules, 'r1', 'v1', 'claim')
        ids = [c['id'] for c in built['request']['candidates']]
        assert 'C1' in ids

    def test_classic_white_joker_is_not_discard_candidate_while_natural_tiles_exist(self):
        ctx = turn_ctx(hand=['white', 'm1', 'm2'])
        built = build_request(ctx, get_rule_set(), 'r1', 'v1', 'turn')
        discards = [c for c in built['request']['candidates']
                    if c['action']['kind'] == 'discard']
        assert [c['label'] for c in discards] == ['出1万', '出2万']
        assert built['request']['state']['jokerTiles'] == ['白板']

    def test_lotus_protects_jokers_but_allows_substitute_white(self):
        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = ['m5', 'm6']
        ctx = turn_ctx(hand=['m5', 'm6', 'white', 'm1'], jokers=['m5', 'm6'])
        built = build_request(ctx, rules, 'r1', 'v1', 'turn')
        discards = [c for c in built['request']['candidates']
                    if c['action']['kind'] == 'discard']
        assert [c['label'] for c in discards] == ['出白板', '出1万']

    def test_all_wildcards_still_produce_discard_candidates_with_warning(self):
        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = ['m5', 'm6']
        ctx = turn_ctx(hand=['m5', 'm6'], jokers=['m5', 'm6'])
        built = build_request(ctx, rules, 'r1', 'v1', 'turn')
        discards = [c for c in built['request']['candidates']
                    if c['action']['kind'] == 'discard']
        assert [c['label'] for c in discards] == ['出5万', '出6万']
        assert all(any('癞子/精牌' in risk for risk in c['features']['risks'])
                   for c in discards)

    def test_lotus_special_ready_pattern_is_labeled_by_rule_engine(self):
        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = []
        hand = ['m1', 'm1', 'm2', 'm2', 'm3', 'm3', 'p1', 'p1',
                'p2', 'p2', 's1', 's1', 'east', 'south']
        ctx = turn_ctx(hand=hand, jokers=[])
        built = build_request(ctx, rules, 'r1', 'v1', 'turn')
        discard_south = next(c for c in built['request']['candidates']
                             if c['label'] == '出南风')
        assert '七对子听牌' in discard_south['features']['specialPattern']


# ── 合法性校验（§8.2）──────────────────────────────────────

class TestValidation:
    def test_discard_out_of_range(self):
        ctx = turn_ctx(hand=['m1', 'm2'])
        rules = get_rule_set()
        assert validate_action(ctx, {'kind': 'discard', 'handIndex': 0}, rules)
        assert not validate_action(ctx, {'kind': 'discard', 'handIndex': 2}, rules)

    def test_win_rejected(self):
        ctx = turn_ctx()
        assert not validate_action(ctx, {'kind': 'win'}, get_rule_set())

    def test_chi_out_of_range(self):
        ctx = claim_ctx(chi_options=[{'tiles': ['m3', 'm4', 'm5'], 'kind': 'sequence'}])
        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = []
        assert validate_action(ctx, {'kind': 'chi', 'optionIndex': 0}, rules)
        assert not validate_action(ctx, {'kind': 'chi', 'optionIndex': 1}, rules)

    def test_rejects_joker_discard_when_natural_tile_exists(self):
        classic = get_rule_set()
        classic_ctx = turn_ctx(hand=['white', 'm1'], jokers=['white'])
        assert not validate_action(classic_ctx, {'kind': 'discard', 'handIndex': 0}, classic)
        assert validate_action(classic_ctx, {'kind': 'discard', 'handIndex': 1}, classic)

        lotus = get_rule_set('lotus-legacy')
        lotus.round_state.joker_tiles = ['m5', 'm6']
        lotus_ctx = turn_ctx(hand=['m5', 'white', 'm1'], jokers=['m5', 'm6'])
        assert not validate_action(lotus_ctx, {'kind': 'discard', 'handIndex': 0}, lotus)
        assert validate_action(lotus_ctx, {'kind': 'discard', 'handIndex': 1}, lotus)
        assert validate_action(lotus_ctx, {'kind': 'discard', 'handIndex': 2}, lotus)

    def test_all_wildcards_can_discard_to_avoid_empty_action_set(self):
        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = ['m5', 'm6']
        ctx = turn_ctx(hand=['m5', 'm6'], jokers=['m5', 'm6'])
        assert validate_action(ctx, {'kind': 'discard', 'handIndex': 0}, rules)

    def test_rejects_wind_kong_that_breaks_four_wind_wait(self):
        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = []
        hand = ['s3', 's4', 's5', 'east', 'south', 'west', 'north', 'p9']
        ctx = turn_ctx(hand=hand, exposed_melds=2, jokers=[])
        ctx.visibleTiles = hand
        assert not validate_action(ctx, {'kind': 'wind-kong'}, rules)


class TestOpponentRiskFeatures:
    """对手牌型风险定价进入候选与 prompt —— 对齐前端 candidates.ts。

    莲花麻将（lotus-legacy）每个弃牌候选带 features.opponentRisk；
    广麻（属 lotus-classic）与无信号局面都不产出该键（保持旧形状）。
    """

    RISK_HAND = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'p1', 'p2', 'p3', 's7', 's7', 's7', 'white', 'm9']
    FLUSH_MELDS = [{'type': 'peng', 'tile': 'p4', 'tiles': ['p4', 'p4', 'p4']},
                   {'type': 'peng', 'tile': 'p7', 'tiles': ['p7', 'p7', 'p7']}]
    BALANCED = ['m1', 'm4', 'm7', 'p1', 'p4', 'p7', 's1', 's4', 's7', 'east', 'south',
                'west', 'north', 'red', 'green']

    def lotus_ctx(self, peer_melds=None, peer_discards=None):
        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = ['red', 'green']
        peers = [{'discards': [], 'melds': []} for _ in range(4)]
        peers[1] = {'discards': list(peer_discards or ['m1']),
                    'melds': [dict(meld) for meld in (peer_melds or [])]}
        ctx = turn_ctx(hand=list(self.RISK_HAND), jokers=['red', 'green'])
        ctx.peers = peers
        ctx.visibleTiles = list(ctx.hand) + ['m1']
        ctx.publicTiles = ['m1']
        ctx.wallCount = 40
        return ctx, rules

    def discard_features(self, built: dict) -> dict:
        return {c['label']: c['features']
                for c in built['request']['candidates']
                if c['action']['kind'] == 'discard'}

    def test_lotus_discard_candidates_carry_opponent_risk(self):
        ctx, rules = self.lotus_ctx(self.FLUSH_MELDS)
        built = build_request(ctx, rules, 'r1', 'v1', 'turn')
        features = self.discard_features(built)
        assert features, '莲花麻将应有弃牌候选'
        assert all(f.get('opponentRisk') for f in features.values())
        payment = {label: f['opponentRisk']['payment'] for label, f in features.items()}
        # 公开张数口径含自家暗手（与前端 input.visibleTiles 同源）：
        # 本家手牌持有的牌面 = 公开 1 张（×0.1）；对手牌河 m1 = 再加 1 张。
        assert payment['出1筒'] == 64          # 40 × 16 × 0.1（嫌疑花色 p）
        assert payment['出9万'] == 32          # 40 × 16 × 0.1 × 0.5（非嫌疑花色、本家持有 m9）
        assert payment['出1万'] == 0           # 本家 1 张 + 对手牌河 1 张 = 现物 → 0
        assert features['出1筒']['opponentRisk']['tier'] == '中'
        assert features['出1筒']['opponentRisk']['signals']

    def test_lotus_prompt_renders_risk_payment_line(self):
        ctx, rules = self.lotus_ctx(self.FLUSH_MELDS)
        built = build_request(ctx, rules, 'r1', 'v1', 'turn')
        _, user = build_prompt('稳健', built['request'])
        assert '风险赔付：约64点（中·' in user
        assert '出1筒' in user

    def test_no_signal_keeps_old_candidate_shape(self):
        """对手没有大牌信号时不产生该特征（保持旧行为）。"""
        ctx, rules = self.lotus_ctx([])
        built = build_request(ctx, rules, 'r1', 'v1', 'turn')
        for features in self.discard_features(built).values():
            assert 'opponentRisk' not in features
        _, user = build_prompt('稳健', built['request'])
        assert '风险赔付' not in user

    def test_classic_rule_never_produces_opponent_risk(self):
        """广麻没有普通点炮 → 候选恒不带风险定价。"""
        peers = [{'discards': [], 'melds': []} for _ in range(4)]
        peers[1] = {'discards': ['m1'], 'melds': [dict(m) for m in self.FLUSH_MELDS]}
        ctx = turn_ctx(hand=list(self.RISK_HAND))
        ctx.peers = peers
        ctx.visibleTiles = list(ctx.hand) + ['m1']
        ctx.publicTiles = ['m1']
        built = build_request(ctx, get_rule_set(), 'r1', 'v1', 'turn')
        candidates = built['request']['candidates']
        assert all('opponentRisk' not in c['features'] for c in candidates)

    KONG_HAND = ['east', 'm2', 'm3', 'm4', 'p1', 'p2', 'p3', 's1', 's2', 's3', 'p4', 'p5', 'south']

    def kong_ctx(self, peers, public_tiles):
        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = ['red', 'green']
        hand = list(self.KONG_HAND)
        ctx = turn_ctx(hand=hand, melds=[Meld(type='peng', tile='east', from_=1,
                                              tiles=['east', 'east', 'east'])],
                       exposed_melds=1, jokers=['red', 'green'])
        ctx.peers = peers
        ctx.visibleTiles = list(hand)
        ctx.publicTiles = list(public_tiles)
        ctx.wallCount = 12
        return ctx, rules

    def added_kong_risks(self, ctx, rules) -> str:
        built = build_request(ctx, rules, 'r1', 'v1', 'turn')
        kong = next(c for c in built['request']['candidates']
                    if c['action']['kind'] == 'added-kong')
        return '；'.join(kong['features']['risks'])

    def test_added_kong_risk_mentions_suspect_big_hand_tier(self):
        """补杠 + 该牌完全未现 + 对手染手副露 → risks 带档位文案。"""
        peers = [{'discards': [], 'melds': []} for _ in range(4)]
        peers[1] = {'discards': [], 'melds': [dict(m) for m in self.FLUSH_MELDS]}
        ctx, rules = self.kong_ctx(peers, [])
        risks = self.added_kong_risks(ctx, rules)
        assert '被抢杠概率较高' in risks
        assert '疑似大牌（中档）' in risks
        assert '抢杠赔付远高于平胡' in risks

    def test_added_kong_risk_stays_plain_without_signal(self):
        peers = [{'discards': list(self.BALANCED), 'melds': []} for _ in range(4)]
        ctx, rules = self.kong_ctx(peers, [])
        risks = self.added_kong_risks(ctx, rules)
        assert '被抢杠概率较高' in risks
        assert '疑似大牌' not in risks

    def test_added_kong_seen_tile_has_no_rob_risk_line(self):
        peers = [{'discards': [], 'melds': []} for _ in range(4)]
        peers[1] = {'discards': ['east'], 'melds': [dict(m) for m in self.FLUSH_MELDS]}
        ctx, rules = self.kong_ctx(peers, ['east'])
        risks = self.added_kong_risks(ctx, rules)
        assert '被抢杠' not in risks


class TestPromptRules:
    def test_classic_prompt_marks_white_and_forbids_other_variant_patterns(self):
        built = build_request(turn_ctx(hand=['white', 'm1', 'm2']), get_rule_set(),
                              'r1', 'v1', 'turn')
        system, user = build_prompt('稳健', built['request'])
        assert '规则摘要未列出的特殊牌型一律视为不支持' in system
        assert '响应别人弃牌只能是大明杠' in system
        assert '不支持七对、十三幺、十三烂、七星十三烂' in user
        assert '【癞子规则】白板是本玩法的万能牌' in user
        assert '出白板' not in user
        assert '只可自摸或抢杠胡' in user
        assert '决策优先级' in system
        assert '【默认参考】' in user
        assert '游戏引擎' not in system
        assert '烟雾弹' in system
        assert '不要求公开真实意图' in system
        assert '公开事实必须如实' in system
        assert '你是庄家' in user
        assert '不要使用“稳稳”一词' not in system
        assert '"message": "有点意思。"' in user
        assert 'message 必须非空' in user
        assert '【你的暗手（不含副露/杠组）】' in user
        assert '默认优先' in user

    def test_non_dealer_is_told_identity_without_guessing_absolute_seat(self):
        ctx = turn_ctx()
        ctx.playerIndex = 2
        ctx.dealerIndex = 0
        ctx.seatWind = '西'
        built = build_request(ctx, get_rule_set(), 'r1', 'v1', 'turn')
        _, user = build_prompt('激进', built['request'])
        assert built['request']['state']['dealerIndex'] == 0
        assert built['request']['state']['isDealer'] is False
        assert '你是「西」家｜你不是庄家' in user
        assert '庄家座位「0」' not in user

    def test_prompt_distinguishes_draw_claim_and_post_claim_turns(self):
        drawn_ctx = turn_ctx()
        drawn_ctx.turnOrigin = 'draw'
        drawn_ctx.drawnTile = 'p5'
        drawn = build_request(drawn_ctx, get_rule_set(), 'r1', 'v1', 'turn')
        assert '【刚摸到】「5筒」' in build_prompt('稳健', drawn['request'])[1]

        peng_ctx = turn_ctx()
        peng_ctx.turnOrigin = 'peng'
        peng_ctx.drawnTile = None
        peng = build_request(peng_ctx, get_rule_set(), 'r1', 'v1', 'turn')
        peng_user = build_prompt('稳健', peng['request'])[1]
        assert '碰后直接出牌（本回合没有摸牌）' in peng_user
        assert '【刚摸到】' not in peng_user

        claim_ctx_value = claim_ctx(tile='m3', can_peng=True)
        claim_ctx_value.from_ = 3
        claim = build_request(claim_ctx_value, get_rule_set(), 'r1', 'v1', 'claim')
        claim_user = build_prompt('稳健', claim['request'])[1]
        assert '【当前弃牌】「上家」打出「3万」' in claim_user
        assert '{"choice": "Z", "message": "有点意思。"}' in claim_user
        assert '{"choice": "A1"' not in claim_user

    def test_prompt_labels_peng_and_does_not_merge_fourth_discard_into_meld(self):
        ctx = claim_ctx(tile='m7', can_peng=True)
        ctx.from_ = 3
        ctx.peers[1] = {
            'discards': ['p9'],
            'melds': [{'type': 'peng', 'tile': 'm7', 'tiles': ['m7', 'm7', 'm7']}],
        }
        built = build_request(ctx, get_rule_set(), 'r1', 'v1', 'claim')
        _, user = build_prompt('稳健', built['request'])
        assert '下家：「碰：7万×3」' in user
        assert '下家：「9筒」' in user
        assert '【当前弃牌】「上家」打出「7万」' in user
        assert '不会自动并入任何玩家已有的碰组' in user
        assert '下家：「明杠：7万×4」' not in user

    def test_lotus_prompt_uses_double_joker_and_limited_white_rule(self):
        rules = get_rule_set('lotus-legacy')
        rules.round_state.joker_tiles = ['m5', 'm6']
        ctx = turn_ctx(hand=['m5', 'm6', 'white', 'm1'], jokers=['m5', 'm6'])
        built = build_request(ctx, rules, 'r1', 'v1', 'turn')
        _, user = build_prompt('稳健', built['request'])
        assert '翻出的牌面及其同序下一张均为精牌' in user
        assert '精牌「5万、6万」可代任意牌' in user
        assert '白板只能替代上述精牌面或白板本身' in user
        assert '出5万' not in user
        assert '出6万' not in user
        assert '出白板' in user


# ── LLMPlayer（mock 供应商）──────────────────────────────────

class FakeResponse:
    def __init__(self, text, status=200):
        self.text = text
        self.status_code = status
        self._payload = None

    def json(self):
        if self._payload is None:
            self._payload = {'choices': [{'message': {'content': self.text},
                                          'finish_reason': 'stop'}]}
        return self._payload


class FakeClient:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

    async def post(self, url, headers=None, json=None, timeout=None):
        self.calls += 1
        item = self._responses.pop(0) if self._responses else self._responses[-1]
        if callable(item):
            return item()
        return item


def make_llm_player(monkeypatch, responses, *, seat=-1, provider_id='', on_message=None,
                    on_fallback=None,
                    **cfg_overrides):
    cfg = dict(
        enabled=True, base_url='https://api.deepseek.com/v1', api_key='sk-x',
        model='deepseek-v4-flash', style='稳健', timeout_s=20.0,
        pool_timeout_s=1.0, concurrency=2, max_requests_per_room=0,
    )
    cfg.update(cfg_overrides)
    config = SimpleNamespace(**cfg)
    fake = FakeClient(responses)
    # LLMPlayer 直接使用 request_llm_decision —— mock 掉它（透传到假客户端）
    async def fake_decision(cfg_, system, user, candidate_ids, **_options):
        item = fake._responses.pop(0) if fake._responses else fake._responses[-1]
        if callable(item):
            item = item()
        if isinstance(item, Exception):
            raise item
        return parse_llm_output(item, candidate_ids)
    monkeypatch.setattr('app.game.llm_player.request_llm_decision', fake_decision)
    player = LLMPlayer(
        delays={'turn': 0, 'after_kong': 0, 'claim': 0},
        config=config,
        seat=seat,
        provider_id=provider_id,
        on_message=on_message,
        on_fallback=on_fallback,
    )
    return player, fake


class TestLLMPlayer:
    def test_message_callback_receives_decision_and_action_metadata(self, monkeypatch):
        messages = []

        def capture(seat, text, priority, **metadata):
            messages.append((seat, text, priority, metadata))

        player, _ = make_llm_player(
            monkeypatch, ['{"choice":"A1","message":"先打这一张。"}'],
            seat=1, on_message=capture)
        action = run(player.request_turn(turn_ctx(hand=['m3', 'm5', 'm6'])))
        assert action['kind'] == 'discard'
        assert messages[0][3] == {'decision': 'turn', 'action_kind': 'discard'}

    def test_chatter_turn_discard_marks_speech_as_mandatory_frequency(self, monkeypatch):
        messages = []
        player, _ = make_llm_player(
            monkeypatch, ['{"choice":"A1","message":"轮到我出牌啦。"}'],
            seat=1, style='话痨',
            on_message=lambda seat, text, priority: messages.append((seat, text, priority)))
        action = run(player.request_turn(turn_ctx(hand=['m3', 'm5', 'm6'])))
        assert action['kind'] == 'discard'
        assert messages == [(1, '轮到我出牌啦。', 'chatter-turn')]

    def test_always_on_low_skips_opening_speech_but_keeps_stream_progress(
            self, monkeypatch):
        from app.llm.config import LlmServerConfig

        calls = []
        statuses = []

        async def fake_decision(_cfg, _system, _user, _ids, **options):
            calls.append(options)
            options['on_reasoning_progress']()
            return 'A1', '稳住。'

        monkeypatch.setattr('app.game.llm_player.request_llm_decision', fake_decision)
        player = LLMPlayer(
            delays={'turn': 0, 'after_kong': 0, 'claim': 0},
            config=LlmServerConfig(
                enabled=True, base_url='https://api.orcarouter.ai/v1', api_key='sk',
                model='kimi/kimi-k3', provider_type='kimi', style='稳健'),
            seat=1,
            on_status=lambda *args: statuses.append(args),
        )
        opening = turn_ctx(hand=['m3', 'm5', 'm6'], turnOrigin='opening')
        assert run(player.request_turn(opening))['kind'] == 'discard'
        assert calls[0]['reasoning'] is False
        assert (1, True, '让我想想怎么打。', True) not in statuses
        assert (1, True, '思考中 · 正在观察公开牌局', False) in statuses
        assert statuses[-1] == (1, False, '', False)
        assert player.stats['thinkingRequests'] == 1
        assert player.stats['enhancedReasoningRequests'] == 0

        statuses.clear()
        late = turn_ctx(hand=['m3', 'm5', 'm6'], turnOrigin='draw')
        late.wallCount = 12
        assert run(player.request_turn(late))['kind'] == 'discard'
        assert calls[1]['reasoning'] is True
        assert (1, True, '让我想想怎么打。', True) in statuses
        assert (1, True, '思考中 · 正在观察公开牌局', False) in statuses
        assert player.stats['thinkingRequests'] == 2
        assert player.stats['enhancedReasoningRequests'] == 1

    def test_turn_win_short_circuit_no_llm_call(self, monkeypatch):
        player, fake = make_llm_player(monkeypatch, [])
        # 白板癞子 + 4 面子 + 一对 → 胡
        ctx = turn_ctx(hand=['m1', 'm1', 'm1', 'm2', 'm2', 'm2', 'm3', 'm3', 'm3',
                             's1', 's1', 's1', 's2', 's2'])
        action = run(player.request_turn(ctx))
        assert action['kind'] == 'win'
        assert fake.calls == 0

    def test_turn_legal_choice_executes(self, monkeypatch):
        messages = []
        player, fake = make_llm_player(
            monkeypatch, ['{"choice":"A1","message":"稳一手。"}'],
            seat=2, provider_id='deepseek',
            on_message=lambda seat, text, priority: messages.append((seat, text, priority)))
        ctx = turn_ctx(hand=['m3', 'm3', 'm5', 'm6', 'p1', 'p2', 'p3', 's1', 's2', 's3',
                             'east', 'west', 'white'])
        action = run(player.request_turn(ctx))
        assert action['kind'] == 'discard'
        assert action['handIndex'] >= 0
        assert player.stats['successes'] == 1
        assert player.stats['messages'] == 1
        assert player.message_history == ['稳一手。']
        assert messages == [(2, '稳一手。', 'normal')]

    def test_vague_model_message_is_allowed_as_table_bluff(self, monkeypatch):
        messages = []
        player, _ = make_llm_player(
            monkeypatch, ['{"choice":"A1","message":"今天手气不错。"}'],
            seat=1,
            on_message=lambda seat, text, priority: messages.append((seat, text, priority)))
        ctx = turn_ctx(hand=['m3', 'm5', 'm6'])
        action = run(player.request_turn(ctx))
        assert action['kind'] == 'discard'
        assert player.message_history == ['今天手气不错。']
        assert messages == [(1, '今天手气不错。', 'normal')]

    def test_named_discard_keep_message_falls_back(self, monkeypatch):
        messages = []
        player, _ = make_llm_player(
            monkeypatch, ['{"choice":"A1","message":"3万留着当宝，先走它！"}'],
            seat=1,
            on_message=lambda seat, text, priority: messages.append((seat, text, priority)))
        action = run(player.request_turn(turn_ctx(hand=['m3', 'm5', 'm6'])))
        assert action['kind'] == 'discard'
        assert player.message_history == ['这张先走。']
        assert messages == [(1, '这张先走。', 'normal')]

    def test_false_public_gang_message_falls_back_using_peer_meld_facts(self, monkeypatch):
        messages = []
        player, _ = make_llm_player(
            monkeypatch, ['{"choice":"A1","message":"下家杠了，我稳一手。"}'],
            seat=1,
            on_message=lambda seat, text, priority: messages.append((seat, text, priority)))
        ctx = turn_ctx(hand=['m3', 'm5', 'm6'])
        ctx.peers[1] = {
            'discards': [],
            'melds': [{'type': 'peng', 'tile': 'm7', 'tiles': ['m7', 'm7', 'm7']}],
        }
        action = run(player.request_turn(ctx))
        assert action['kind'] == 'discard'
        assert player.message_history == ['这张先走。']
        assert messages == [(1, '这张先走。', 'normal')]

    def test_turn_illegal_choice_falls_back(self, monkeypatch):
        # 返回白名单外的 choice → 解析失败 → 回退启发式（kind=discard 或杠）
        player, fake = make_llm_player(monkeypatch, [])
        ctx = turn_ctx(hand=['m3', 'm5', 'm6'])
        action = run(player.request_turn(ctx))
        assert action['kind'] == 'discard'
        assert player.stats['fallbacks'] >= 1

    def test_network_error_falls_back(self, monkeypatch):
        fallbacks = []
        player, fake = make_llm_player(
            monkeypatch, [Exception('boom')], seat=1,
            on_fallback=lambda *args: fallbacks.append(args))
        ctx = turn_ctx(hand=['m3', 'm5', 'm6'])
        action = run(player.request_turn(ctx))
        assert action['kind'] == 'discard'
        assert player.stats['fallbacks'] >= 1
        assert fallbacks == [(1, 'turn', 'discard', 'normal')]

    def test_claim_hu_short_circuit(self, monkeypatch):
        player, fake = make_llm_player(monkeypatch, [])
        ctx = claim_ctx(tile='m1', can_peng=True, can_hu=True)
        action = run(player.request_claim(ctx))
        assert action['kind'] == 'win'
        assert fake.calls == 0

    def test_claim_chi_mapping(self, monkeypatch):
        player, fake = make_llm_player(
            monkeypatch, ['{"choice":"C1","message":"吃！"}'])
        rules = get_rule_set('lotus-legacy')
        player.set_rule_set(rules)
        rules.round_state.joker_tiles = []
        ctx = claim_ctx(hand=['m4', 'm5', 'east'], tile='m3', can_peng=False,
                        chi_options=[{'tiles': ['m3', 'm4', 'm5'], 'kind': 'sequence'}])
        action = run(player.request_claim(ctx))
        assert action == {'kind': 'chi', 'optionIndex': 0}


# ── 房间装配（§9.3）───────────────────────────────────────────

class TestRoomAssembly:
    def test_llm_enabled_uses_llm_player(self, monkeypatch):
        from app.game.room import RoomSession
        monkeypatch.setattr('app.game.room.llm_server_available', lambda: True)
        monkeypatch.setattr('app.game.room.load_llm_providers', lambda: {
            'ds': deepseek_provider()})
        monkeypatch.setattr('app.game.room.default_provider_id', lambda: 'ds')
        room = RoomSession('LLMROOM', mode='east', capacity=2, llm_enabled=True)
        assert room.llm_available is True
        assert room.effective_llm_enabled is True
        # 四人桌固定 4 座；无真人占座时全部为 LLM 补位（默认提供商）
        controllers = room._controllers()
        assert sum(1 for c in controllers if isinstance(c, LLMPlayer)) == 4

    def test_llm_disabled_keeps_heuristic(self, monkeypatch):
        from app.game.player import AIPlayer
        from app.game.room import RoomSession
        monkeypatch.setattr('app.game.room.llm_server_available', lambda: True)
        room = RoomSession('HEURISTIC', mode='east', capacity=2, llm_enabled=False)
        assert room.effective_llm_enabled is False
        controllers = room._controllers()
        assert sum(1 for c in controllers if isinstance(c, AIPlayer)) == 4

    def test_server_unavailable_silently_degrades(self, monkeypatch):
        from app.game.player import AIPlayer
        from app.game.room import RoomSession
        monkeypatch.setattr('app.game.room.llm_server_available', lambda: False)
        monkeypatch.setattr('app.game.room.load_llm_providers', lambda: {})
        room = RoomSession('OFF', mode='east', capacity=2, llm_enabled=True)
        assert room.llm_available is False
        assert room.effective_llm_enabled is False
        controllers = room._controllers()
        assert sum(1 for c in controllers if isinstance(c, AIPlayer)) == 4


# ── 服务端多提供商 / 形象（§9.7）────────────────────────────────

def deepseek_provider(style='稳健', nickname=''):
    """测试用 DeepSeek 提供商（key 存服务端；客户端只引用 id）。"""
    from app.llm.config import LlmProvider
    return LlmProvider('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1',
                       'sk-server-ds', 'deepseek-chat', style, nickname)


def kimi_provider(style='稳健', nickname='小K'):
    from app.llm.config import LlmProvider
    return LlmProvider('kimi', 'Kimi', 'https://api.moonshot.cn/v1',
                       'sk-server-kimi', 'kimi-k2', style, nickname)


class TestPersona:
    def test_provider_folder_and_nickname(self):
        from app.llm.persona import avatar_url, default_nickname, display_name, provider_folder
        assert provider_folder('https://api.deepseek.com/v1') == 'deepseek'
        assert provider_folder('https://api.moonshot.cn/v1') == 'kimi'
        assert provider_folder('https://open.bigmodel.cn/api/paas/v4') == 'glm'
        assert provider_folder('https://my.proxy.local/v1') == 'custom'
        assert provider_folder('https://my.proxy.local/v1', provider_id='relay_gpt') == 'gpt'
        assert provider_folder('https://my.proxy.local/v1', avatar_folder='claude',
                               provider_id='relay_gpt') == 'claude'
        assert provider_folder(
            'https://api.orcarouter.ai/v1', provider_id='orca-router',
            model='anthropic/claude-sonnet-5', provider_type='custom') == 'claude'
        assert default_nickname('https://api.deepseek.com/v1') == '大肥鱼'
        assert default_nickname('https://x.com/v1', fallback='AI玩家') == 'AI玩家'
        assert default_nickname('https://x.com/v1', provider_id='relay_gpt') == 'GPT'
        assert avatar_url('https://api.deepseek.com/v1', '激进') == \
            'img/llm/deepseek/llm-avatar-jijin.png'
        assert avatar_url('https://my.proxy.local/v1', '稳健',
                          provider_id='relay_gpt') == \
            'img/llm/gpt/llm-avatar-wenjian.png'
        assert display_name('大肥鱼', '激进') == '大肥鱼（激进）'


class TestProviderRegistry:
    def test_reasoning_capability_matrix_matches_frontend(self):
        from app.llm.reasoning import resolve_reasoning_policy

        def policy(model, reasoning=False, provider_type='custom'):
            return resolve_reasoning_policy(
                provider_type, 'https://api.orcarouter.ai/v1', model,
                reasoning=reasoning)

        assert policy('kimi/kimi-k3').request_body['reasoning_effort'] == 'low'
        assert policy('kimi/kimi-k3', True).request_body['reasoning_effort'] == 'high'
        assert policy('z-ai/glm-5.3-flash').request_body['reasoning_effort'] == 'low'
        assert policy('z-ai/glm-5.3-flash', True).request_body['reasoning_effort'] == 'medium'
        assert policy('kimi/kimi-k2.6', provider_type='kimi').request_body == {
            'thinking': {'type': 'disabled'}, 'temperature': 0.6, 'top_p': 0.95,
        }
        assert policy(
            'kimi/kimi-k2.6', True, provider_type='kimi').request_body == {
                'thinking': {'type': 'enabled'}, 'temperature': 1.0, 'top_p': 0.95,
            }
        assert policy('anthropic/claude-sonnet-5').request_body == {
            'thinking': {'type': 'disabled'},
        }
        assert policy('anthropic/claude-sonnet-5', True).request_body == {
            'thinking': {'type': 'adaptive', 'display': 'summarized'},
            'output_config': {'effort': 'medium'},
        }
        assert policy('kimi/kimi-k2', True, provider_type='kimi').mode == 'naturally-off'

    def test_env_registry_parsing(self, monkeypatch):
        # 与开发机 backend/.env 隔离，只验证本用例声明的注册表。
        for key in list(os.environ):
            if key.startswith('LLM_PROVIDER_'):
                monkeypatch.delenv(key, raising=False)
        monkeypatch.setenv('LLM_PROVIDER_DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1')
        monkeypatch.setenv('LLM_PROVIDER_DEEPSEEK_API_KEY', 'sk-srv')
        monkeypatch.setenv('LLM_PROVIDER_DEEPSEEK_MODEL', 'deepseek-chat')
        monkeypatch.setenv('LLM_PROVIDER_KIMI_BASE_URL', 'https://api.moonshot.cn/v1')
        monkeypatch.setenv('LLM_PROVIDER_KIMI_API_KEY', 'sk-k')
        monkeypatch.setenv('LLM_PROVIDER_KIMI_MODEL', 'kimi-k2')
        monkeypatch.setenv('LLM_PROVIDER_KIMI_TYPE', 'kimi')
        monkeypatch.setenv('LLM_PROVIDER_KIMI_STYLE', '话痨')
        monkeypatch.setenv('LLM_PROVIDER_KIMI_AVATAR_FOLDER', 'kimi')
        monkeypatch.setenv('LLM_PROVIDER_KIMI_TIMEOUT_ENABLED', 'false')
        from app.llm.config import load_llm_providers
        providers = load_llm_providers()
        assert set(providers) == {'deepseek', 'kimi'}
        assert providers['kimi'].style == '话痨'
        assert providers['kimi'].name == 'kimi'
        assert providers['kimi'].avatar_folder == 'kimi'
        assert providers['kimi'].provider_type == 'kimi'
        assert providers['kimi'].timeout_enabled is False
        assert providers['kimi'].to_config().timeout_enabled is False

    def test_incomplete_provider_skipped(self, monkeypatch):
        monkeypatch.delenv('LLM_PROVIDER_X_API_KEY', raising=False)
        monkeypatch.setenv('LLM_PROVIDER_X_BASE_URL', 'https://x.com/v1')
        monkeypatch.setenv('LLM_PROVIDER_X_MODEL', 'm')  # 缺 key
        from app.llm.config import load_llm_providers
        assert 'x' not in load_llm_providers()

    def test_legacy_global_fallback_as_default(self, monkeypatch):
        from app.llm.config import load_llm_providers
        monkeypatch.setenv('LLM_ENABLED', 'true')
        monkeypatch.setenv('LLM_API_BASE', 'https://api.deepseek.com/v1')
        monkeypatch.setenv('LLM_API_KEY', 'sk-legacy')
        monkeypatch.setenv('LLM_MODEL', 'deepseek-chat')
        for key in list(os.environ):
            if key.startswith('LLM_PROVIDER_'):
                monkeypatch.delenv(key, raising=False)
        providers = load_llm_providers()
        assert 'default' in providers
        assert providers['default'].api_key == 'sk-legacy'

    def test_default_provider_id(self, monkeypatch):
        from app.llm.config import default_provider_id
        monkeypatch.setattr('app.llm.config.load_llm_providers', lambda: {
            'kimi': kimi_provider(), 'deepseek': deepseek_provider()})
        assert default_provider_id() == 'kimi'

    def test_to_config_limits(self):
        cfg = deepseek_provider(style='狂暴', nickname='').to_config()
        assert cfg.style == '稳健'
        assert cfg.api_key == 'sk-server-ds'
        assert cfg.timeout_s == 40.0
        assert deepseek_provider(style='稳健').to_config(style_override='高冷').style == '高冷'

    def test_qwen_uses_same_default_timeout_as_other_providers(self):
        from app.llm.config import LlmProvider, is_qwen_thinking_model
        provider = LlmProvider(
            'qwen', base_url='https://dashscope.aliyuncs.com/compatible-mode/v1',
            api_key='sk-qwen', model='qwen3.7-plus')
        assert is_qwen_thinking_model(provider.base_url, provider.model)
        assert provider.to_config().timeout_s == 40.0
        provider.timeout_ms = 12_000
        assert provider.to_config().timeout_s == 12.0

    def test_qwen_request_disables_thinking_and_requests_json(self, monkeypatch):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={
                'choices': [{
                    'message': {'content': '{"choice":"A1","message":"稳住"}'},
                    'finish_reason': 'stop',
                }],
                'usage': {
                    'completion_tokens': 6,
                    'completion_tokens_details': {'reasoning_tokens': 0},
                },
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True,
            base_url='https://dashscope.aliyuncs.com/compatible-mode/v1',
            api_key='sk-qwen', model='qwen3.7-plus', timeout_s=8,
            provider_id='qwen')
        assert run(request_llm_decision(cfg, 'system', 'user', ['A1'])) == ('A1', '稳住')
        assert captured['enable_thinking'] is False
        assert captured['response_format'] == {'type': 'json_object'}
        run(http.aclose())

    def test_qwen_deep_reasoning_drops_json_mode(self, monkeypatch):
        """DashScope 千问「JSON 模式 + 思考」同开时返回空正文，深思路径必须去掉 response_format。"""
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={
                'choices': [{
                    'message': {'content': '{"choice":"A1","message":"稳住"}'},
                    'finish_reason': 'stop',
                }],
                'usage': {
                    'completion_tokens': 6,
                    'completion_tokens_details': {'reasoning_tokens': 0},
                },
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True,
            base_url='https://dashscope.aliyuncs.com/compatible-mode/v1',
            api_key='sk-qwen', model='qwen3-32b', timeout_s=40,
            provider_id='qwen')
        assert run(request_llm_decision(cfg, 'system', 'user', ['A1'], reasoning=True)) \
            == ('A1', '稳住')
        assert captured['enable_thinking'] is True
        assert 'response_format' not in captured
        run(http.aclose())

    def test_kimi_custom_proxy_tolerates_reasoning_leak_and_overrides_sampling(
            self, monkeypatch):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={
                'choices': [{'message': {
                    'content': '{"choice":"A1","message":"稳住"}',
                    'reasoning_content': '中转仍返回思考',
                }, 'finish_reason': 'stop'}],
                'usage': {'completion_tokens_details': {'reasoning_tokens': 12}},
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://proxy.example.com/v1', api_key='sk-kimi',
            model='kimi-k2.6', provider_id='kimi', provider_type='kimi')
        assert run(request_llm_decision(cfg, 'system', 'user', ['A1'])) == ('A1', '稳住')
        assert captured['thinking'] == {'type': 'disabled'}
        assert captured['temperature'] == 0.6
        assert captured['top_p'] == 0.95
        run(http.aclose())

    @pytest.mark.parametrize('model', ['kimi-k2.5', 'kimi-k2.6'])
    def test_kimi_custom_relay_thinking_uses_2048_and_json_object(
            self, monkeypatch, model):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={
                'choices': [{
                    'message': {'content': '{"choice":"A1","message":"稳住"}'},
                    'finish_reason': 'stop',
                }],
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://relay.example.com/v1', api_key='sk-kimi',
            model=model, provider_type='custom')
        assert run(request_llm_decision(
            cfg, 'system', 'user', ['A1'], reasoning=True)) == ('A1', '稳住')
        assert captured['max_tokens'] == 2048
        assert captured['thinking'] == {'type': 'enabled'}
        assert captured['temperature'] == 1.0
        assert captured['top_p'] == 0.95
        assert captured['response_format'] == {'type': 'json_object'}
        run(http.aclose())

    def test_kimi_official_thinking_keeps_512_without_relay_json_override(
            self, monkeypatch):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={
                'choices': [{
                    'message': {'content': '{"choice":"A1","message":"稳住"}'},
                    'finish_reason': 'stop',
                }],
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://api.moonshot.cn/v1', api_key='sk-kimi',
            model='kimi-k2.6', provider_type='kimi')
        assert run(request_llm_decision(
            cfg, 'system', 'user', ['A1'], reasoning=True)) == ('A1', '稳住')
        assert captured['max_tokens'] == 512
        assert 'response_format' not in captured
        run(http.aclose())

    @pytest.mark.parametrize(('provider_type', 'model'), [
        ('deepseek', 'deepseek/deepseek-v4-flash'),
        ('qwen', 'qwen/qwen3.8-flash'),
        ('kimi', 'kimi/kimi-k2.5'),
    ])
    def test_orcarouter_deepseek_qwen_kimi_thinking_uses_65536(
            self, monkeypatch, provider_type, model):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={
                'choices': [{
                    'message': {'content': '{"choice":"A1","message":"稳住"}'},
                    'finish_reason': 'stop',
                }],
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://api.orcarouter.ai/v1', api_key='sk-relay',
            model=model, provider_type=provider_type)
        assert run(request_llm_decision(
            cfg, 'system', 'user', ['A1'], reasoning=True)) == ('A1', '稳住')
        assert captured['max_tokens'] == 65536
        run(http.aclose())

    def test_glm_5_3_flash_custom_proxy_uses_low_512_json_on_quick_path(
            self, monkeypatch):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={
                'choices': [{
                    'message': {
                        'content': '{"choice":"A1","message":"稳住"}',
                        'reasoning_content': '简短检查',
                    },
                    'finish_reason': 'stop',
                }],
                'usage': {'completion_tokens_details': {'reasoning_tokens': 8}},
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://api.orcarouter.ai/v1', api_key='sk-glm',
            model='z-ai/glm-5.3-flash', provider_id='glm-orca', provider_type='custom')
        assert run(request_llm_decision(cfg, 'system', 'user', ['A1'])) == ('A1', '稳住')
        assert captured['model'] == 'z-ai/glm-5.3-flash'
        assert 'max_tokens' not in captured
        assert captured['reasoning_effort'] == 'low'
        assert captured['response_format'] == {'type': 'json_object'}
        assert 'thinking' not in captured
        run(http.aclose())

    def test_glm_5_3_flash_deep_path_uses_medium_1024(self, monkeypatch):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={
                'choices': [{
                    'message': {'content': '{"choice":"A1","message":"稳住"}'},
                    'finish_reason': 'stop',
                }],
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://api.orcarouter.ai/v1', api_key='sk-glm',
            model='z-ai/glm-5.3-flash', provider_type='custom')
        assert run(request_llm_decision(
            cfg, 'system', 'user', ['A1'], reasoning=True)) == ('A1', '稳住')
        assert captured['max_tokens'] == 1024
        assert captured['reasoning_effort'] == 'medium'
        assert captured['response_format'] == {'type': 'json_object'}
        run(http.aclose())

    def test_glm_5_3_flash_official_deep_path_keeps_low_1024(self, monkeypatch):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={
                'choices': [{
                    'message': {'content': '{"choice":"A1","message":"稳住"}'},
                    'finish_reason': 'stop',
                }],
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://open.bigmodel.cn/api/paas/v4', api_key='sk-glm',
            model='glm-5.3-flash', provider_type='glm')
        assert run(request_llm_decision(
            cfg, 'system', 'user', ['A1'], reasoning=True)) == ('A1', '稳住')
        assert captured['max_tokens'] == 1024
        assert captured['reasoning_effort'] == 'high'
        assert captured['response_format'] == {'type': 'json_object'}
        run(http.aclose())

    def test_glm_5_3_flash_official_quick_path_uses_low_128(self, monkeypatch):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={
                'choices': [{
                    'message': {'content': '{"choice":"A1","message":"稳住"}'},
                    'finish_reason': 'stop',
                }],
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://open.bigmodel.cn/api/paas/v4', api_key='sk-glm',
            model='glm-5.3-flash', provider_type='glm')
        assert run(request_llm_decision(cfg, 'system', 'user', ['A1'])) == ('A1', '稳住')
        assert 'max_tokens' not in captured
        assert captured['reasoning_effort'] == 'low'
        assert captured['response_format'] == {'type': 'json_object'}
        run(http.aclose())

    def test_length_response_does_not_retry_with_wrong_choice_feedback(self, monkeypatch):
        from app.llm.client import LlmClientError, request_llm_decision
        from app.llm.config import LlmServerConfig

        calls = 0

        async def handler(_request: httpx.Request):
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={
                'choices': [{'message': {'content': ''}, 'finish_reason': 'length'}],
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://proxy.example.com/v1', api_key='sk', model='test')
        with pytest.raises(LlmClientError) as exc:
            run(request_llm_decision(cfg, 'system', 'user', ['A1']))
        assert exc.value.kind == LlmClientError.KIND_LENGTH
        assert calls == 1
        run(http.aclose())

    def test_kimi_k3_quick_uses_low_128_without_sampling_parameters(self, monkeypatch):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={
                'choices': [{
                    'message': {
                        'content': '{"choice":"A1","message":"稳住"}',
                        'reasoning_content': '先分析候选牌',
                    },
                    'finish_reason': 'stop',
                }],
                'usage': {'completion_tokens_details': {'reasoning_tokens': 160}},
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://api.orcarouter.ai/v1', api_key='sk-kimi',
            model='kimi/kimi-k3', provider_id='kimi-orca', provider_type='kimi')
        assert run(request_llm_decision(cfg, 'system', 'user', ['A1'])) == ('A1', '稳住')
        assert captured['model'] == 'kimi/kimi-k3'
        assert 'max_tokens' not in captured
        assert captured['reasoning_effort'] == 'low'
        assert 'thinking' not in captured
        assert 'temperature' not in captured
        assert 'top_p' not in captured
        run(http.aclose())

    def test_streaming_reasoning_only_emits_safe_progress_pulse(self, monkeypatch):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}
        pulses = []

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            sse = (
                'data: {"choices":[{"delta":{"reasoning_content":"private"}}]}\n\n'
                'data: {"choices":[{"delta":{"content":"{\\"choice\\":\\"A1\\","}}]}\n\n'
                'data: {"choices":[{"delta":{"content":"\\"message\\":\\"稳住\\"}"},'
                '"finish_reason":"stop"}]}\n\n'
                'data: [DONE]\n\n'
            )
            return httpx.Response(
                200, text=sse, headers={'content-type': 'text/event-stream'})

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://api.orcarouter.ai/v1', api_key='sk-kimi',
            model='kimi/kimi-k3', provider_id='kimi-orca', provider_type='kimi')
        assert run(request_llm_decision(
            cfg, 'system', 'user', ['A1'],
            on_reasoning_progress=lambda: pulses.append('progress'))) == ('A1', '稳住')
        assert captured['stream'] is True
        assert pulses == ['progress']
        run(http.aclose())

    def test_claude_sonnet_5_quick_request_disables_thinking_without_sampling(
            self, monkeypatch):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        captured = {}

        async def handler(request: httpx.Request):
            captured.update(json.loads(request.content))
            return httpx.Response(200, json={
                'choices': [{
                    'message': {'content': '{"choice":"A1","message":"稳住"}'},
                    'finish_reason': 'stop',
                }],
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://api.orcarouter.ai/v1', api_key='sk',
            model='anthropic/claude-sonnet-5', provider_type='custom')
        assert run(request_llm_decision(cfg, 'system', 'user', ['A1'])) == ('A1', '稳住')
        assert captured['thinking'] == {'type': 'disabled'}
        assert 'temperature' not in captured
        assert 'top_p' not in captured
        run(http.aclose())

    def test_disabled_timeout_passes_no_deadline_to_http_call(self, monkeypatch):
        from app.llm.client import request_llm_decision
        from app.llm.config import LlmServerConfig

        budgets = []

        async def fake_call(*_args, budget_s=None, **_kwargs):
            budgets.append(budget_s)
            return '{"choice":"A1","message":"稳住"}'

        monkeypatch.setattr('app.llm.client._call_once', fake_call)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://proxy.example.com/v1', api_key='sk',
            model='custom', timeout_s=0.01, timeout_enabled=False)
        assert run(request_llm_decision(cfg, 'system', 'user', ['A1'])) == ('A1', '稳住')
        assert budgets == [None]

    def test_reasoning_leak_is_rejected(self, monkeypatch):
        from app.llm.client import LlmClientError, request_llm_decision
        from app.llm.config import LlmServerConfig

        async def handler(_request: httpx.Request):
            return httpx.Response(200, json={
                'choices': [{
                    'message': {'content': '{"choice":"A1"}', 'reasoning_content': '仍在思考'},
                    'finish_reason': 'stop',
                }],
                'usage': {'completion_tokens_details': {'reasoning_tokens': 8}},
            })

        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
        cfg = LlmServerConfig(
            enabled=True, base_url='https://proxy.example.com/v1', api_key='sk-qwen',
            model='qwen3.7-plus', provider_id='qwen', provider_type='qwen')
        with pytest.raises(LlmClientError) as exc:
            run(request_llm_decision(cfg, 'system', 'user', ['A1']))
        assert exc.value.kind == LlmClientError.KIND_REASONING
        run(http.aclose())


class TestPerSeatAssembly:
    def test_room_fallback_question_mark_obeys_frequency_without_tts(self, monkeypatch):
        from app.game.player import AIPlayer
        from app.game.room import RoomSession

        emitted = []
        room = RoomSession('FALLBACK', mode='east', capacity=4, llm_enabled=True)
        monkeypatch.setattr(room.conn, 'broadcast', lambda message: emitted.append(message))
        controller = LLMPlayer(
            config=deepseek_provider(style='稳健').to_config(), seat=1,
            provider_id='deepseek')
        room.manager = SimpleNamespace(
            controllers=[AIPlayer(), controller, AIPlayer(), AIPlayer()])

        room._on_llm_fallback(1, 'turn', 'discard', 'normal')
        room._on_llm_fallback(1, 'turn', 'discard', 'normal')

        assert emitted == [{
            'kind': 'llm_message', 'id': 1, 'seat': 1,
            'text': '？', 'priority': 'normal',
            'purpose': 'commentary', 'actionKind': 'discard',
            'speechSource': 'model-message',
        }]
        assert room._tts_tasks == set()
        assert room._tts_match_stats['requests'] == 0

    def test_room_chatter_fallback_question_mark_is_mandatory_without_tts(self, monkeypatch):
        from app.game.player import AIPlayer
        from app.game.room import RoomSession

        emitted = []
        room = RoomSession('FALLBACK-CHATTER', mode='east', capacity=4, llm_enabled=True)
        monkeypatch.setattr(room.conn, 'broadcast', lambda message: emitted.append(message))
        controller = LLMPlayer(
            config=deepseek_provider(style='话痨').to_config(), seat=1,
            provider_id='deepseek')
        room.manager = SimpleNamespace(
            controllers=[AIPlayer(), controller, AIPlayer(), AIPlayer()])

        room._on_llm_fallback(1, 'turn', 'discard', 'chatter-turn')
        room._on_llm_fallback(1, 'turn', 'discard', 'chatter-turn')

        assert [item['text'] for item in emitted] == ['？', '？']
        assert room._tts_tasks == set()

    def test_room_delivers_every_chatter_turn_without_exposing_internal_priority(
            self, monkeypatch):
        from app.game.player import AIPlayer
        from app.game.room import RoomSession

        emitted = []
        room = RoomSession('CHATTER', mode='east', capacity=4, llm_enabled=True)
        monkeypatch.setattr(room.conn, 'broadcast', lambda message: emitted.append(message))
        controller = LLMPlayer(
            config=deepseek_provider(style='话痨').to_config(), seat=1,
            provider_id='deepseek')
        room.manager = SimpleNamespace(
            controllers=[AIPlayer(), controller, AIPlayer(), AIPlayer()])

        room._on_llm_message(1, '第一张。', 'chatter-turn')
        room._on_llm_message(1, '第二张。', 'chatter-turn')
        assert [item['text'] for item in emitted] == ['第一张。', '第二张。']
        assert all(item['priority'] == 'normal' for item in emitted)

    def test_room_broadcasts_messages_and_logs_match_summary(self, monkeypatch):
        from app.game.player import AIPlayer
        from app.game.room import RoomSession

        emitted = []
        logs = []
        room = RoomSession('LOGS', mode='east', capacity=4, llm_enabled=True)
        monkeypatch.setattr(room.conn, 'broadcast', lambda message: emitted.append(message))
        controller = LLMPlayer(
            config=deepseek_provider(style='话痨').to_config(),
            seat=1,
            provider_id='deepseek',
        )
        controller.stats.update({
            'requests': 3, 'successes': 2, 'fallbacks': 1,
            'messages': 2, 'invalid': 0,
        })
        room.manager = SimpleNamespace(controllers=[AIPlayer(), controller, AIPlayer(), AIPlayer()])
        room._on_llm_message(1, '稳住，先打这张。')
        assert emitted == [{
            'kind': 'llm_message', 'id': 1, 'seat': 1, 'text': '稳住，先打这张。', 'priority': 'normal',
            'purpose': 'commentary', 'speechSource': 'model-message',
        }]

        class BoundLogger:
            def __init__(self, context):
                self.context = context

            def info(self, message):
                logs.append((self.context, message))

        monkeypatch.setattr(
            'app.game.room.logger',
            SimpleNamespace(bind=lambda **context: BoundLogger(context)),
        )
        room._log_llm_match_summary()
        assert any('LLM 场次统计 请求=3 成功=2 回退=1 吐槽=2' in message
                   for _, message in logs)
        assert any(message == 'LLM 吐槽：稳住，先打这张。' for _, message in logs)

    def test_room_broadcasts_tts_audio_after_message(self, monkeypatch):
        from app.game.player import AIPlayer
        from app.game.room import RoomSession

        emitted = []
        room = RoomSession('AUDIO', mode='east', capacity=4, llm_enabled=True)
        monkeypatch.setattr(room.conn, 'broadcast', lambda message: emitted.append(message))
        controller = LLMPlayer(
            config=deepseek_provider(style='高冷').to_config(),
            seat=1,
            provider_id='deepseek',
        )
        room.manager = SimpleNamespace(controllers=[AIPlayer(), controller, AIPlayer(), AIPlayer()])

        class FakeTtsService:
            available = True

            async def ensure_audio(self, text, style, provider_id):
                assert (text, style, provider_id) == ('这张先放下。', '高冷', 'deepseek')
                return SimpleNamespace(
                    audio_url=f'/api/tts/audio/{"a" * 64}.mp3', cached=True)

        monkeypatch.setattr('app.game.room.get_tts_service', lambda: FakeTtsService())

        async def scenario():
            room._on_llm_message(
                1, '这张先放下。', 'important',
                decision='claim', action_kind='peng')
            await asyncio.gather(*list(room._tts_tasks))

        run(scenario())
        assert emitted[0] == {
            'kind': 'llm_message', 'id': 1, 'seat': 1, 'text': '这张先放下。', 'priority': 'important',
            'purpose': 'action', 'actionKind': 'peng', 'speechSource': 'model-message',
        }
        assert emitted[1] == {
            'kind': 'llm_audio', 'messageId': 1, 'seat': 1,
            'audioUrl': f'/api/tts/audio/{"a" * 64}.mp3', 'cached': True, 'priority': 'important',
            'purpose': 'action', 'actionKind': 'peng', 'speechSource': 'model-message',
        }
        assert room._tts_match_stats['hits'] == 1

    def test_reasoning_status_stays_separate_and_uses_tts(self, monkeypatch):
        from app.game.player import AIPlayer
        from app.game.room import RoomSession

        emitted = []
        room = RoomSession('THINK', mode='east', capacity=4, llm_enabled=True)
        monkeypatch.setattr(room.conn, 'broadcast', lambda message: emitted.append(message))
        controller = LLMPlayer(
            config=deepseek_provider(style='稳健').to_config(),
            seat=1,
            provider_id='deepseek',
        )
        room.manager = SimpleNamespace(controllers=[AIPlayer(), controller, AIPlayer(), AIPlayer()])

        class FakeTtsService:
            available = True

            async def ensure_audio(self, text, style, provider_id):
                assert (text, style, provider_id) == ('让我想想怎么打。', '稳健', 'deepseek')
                return SimpleNamespace(
                    audio_url=f'/api/tts/audio/{"b" * 64}.mp3', cached=False)

        monkeypatch.setattr('app.game.room.get_tts_service', lambda: FakeTtsService())

        async def scenario():
            room._on_llm_status(1, True, '让我想想怎么打。')
            await asyncio.gather(*list(room._tts_tasks))
            room._on_llm_status(1, False, '')
            room._on_llm_status(1, True, '思考中 · 正在观察公开牌局', False)
            room._on_llm_status(1, False, '', False)

        run(scenario())
        assert emitted[0] == {
            'kind': 'llm_status', 'seat': 1, 'active': True, 'text': '让我想想怎么打。',
        }
        assert emitted[1] == {
            'kind': 'llm_audio', 'messageId': 1, 'seat': 1,
            'audioUrl': f'/api/tts/audio/{"b" * 64}.mp3', 'cached': False,
            'priority': 'normal',
            'purpose': 'commentary', 'speechSource': 'model-message',
        }
        assert emitted[2] == {'kind': 'llm_status', 'seat': 1, 'active': False}
        assert emitted[3] == {
            'kind': 'llm_status', 'seat': 1, 'active': True,
            'text': '思考中 · 正在观察公开牌局',
        }
        assert emitted[4] == {'kind': 'llm_status', 'seat': 1, 'active': False}
        assert sum(item['kind'] == 'llm_audio' for item in emitted) == 1
        assert room._llm_messages == []

    @pytest.mark.parametrize(
        ('action_type', 'expected_text'),
        [
            ('self-draw', '自摸，水到渠成。'),
            ('discard-win', '放枪，这张正合适。'),
        ],
    )
    def test_llm_winner_reacts_after_hand_and_is_marked_in_snapshot(
            self, action_type, expected_text, monkeypatch):
        from app.game.manager import GameManager
        from app.game.player import AIPlayer
        from app.game.room import RoomSession, WSEvents, build_snapshot
        from app.models.game import GamePlayer
        from types import SimpleNamespace

        emitted = []
        room = RoomSession('WINVOICE', mode='east', capacity=4, llm_enabled=True)
        room.conn.broadcast = lambda message: emitted.append(message)
        controller = LLMPlayer(
            config=deepseek_provider(style='稳健').to_config(),
            seat=1,
            provider_id='deepseek',
        )
        controllers = [AIPlayer(), controller, AIPlayer(), AIPlayer()]
        room.manager = GameManager(controllers=controllers)
        room.manager.players = [
            GamePlayer(
                name=f'P{seat}', avatar='', score=1000, seat=seat,
                hand=[], discards=[], melds=[], redCount=0, drawnTileIndex=-1,
            )
            for seat in range(4)
        ]
        monkeypatch.setattr(
            'app.game.room.get_tts_service',
            lambda: SimpleNamespace(available=False),
        )
        WSEvents(room).show_table_action(action_type, 1, 0, 'm1', -1)

        assert emitted[0]['kind'] == 'table_action'
        assert len(emitted) == 1, '胡牌动作只负责表现，赛后感言必须等结算队列'
        result = {'winnerIndex': 1}
        if action_type == 'discard-win':
            result['sourceFrom'] = 0
        run(room._announce_llm_round_reactions(result))
        assert emitted[1] == {
            'kind': 'llm_message', 'id': 1, 'seat': 1, 'text': expected_text, 'priority': 'important',
            'purpose': 'round-reaction', 'speechSource': 'model-message',
            'hasAudio': False,
        }
        snapshot = build_snapshot(room, 0)
        assert [player['isLlm'] for player in snapshot['players']] == [False, True, False, False]

    def test_llm_round_reaction_lines_have_three_short_variants_per_style(self):
        from app.game.room import _LLM_DRAW_LINES, _LLM_LOSS_LINES, _LLM_WIN_LINES
        for styles in [*_LLM_WIN_LINES.values(), _LLM_LOSS_LINES, _LLM_DRAW_LINES]:
            for variants in styles.values():
                assert len(variants) == 3
                assert len(set(variants)) == 3
                assert all(len(line) <= 18 for line in variants)
            assert all('稳稳' not in line for line in styles['稳健'])

    def test_round_reactions_are_winner_first_clockwise_and_exclude_non_llm(self,
                                                                           monkeypatch):
        from app.game.manager import GameManager
        from app.game.player import AIPlayer
        from app.game.room import RoomSession

        room = RoomSession('REACTIONS', mode='east', capacity=4, llm_enabled=True)
        controllers = [AIPlayer()] + [
            LLMPlayer(config=deepseek_provider(style='高冷').to_config(), seat=seat,
                      provider_id='deepseek')
            for seat in (1, 2, 3)
        ]
        room.manager = GameManager(controllers=controllers)
        spoken = []

        async def fake_emit(seat, text, _controller, _targets=None):
            spoken.append((seat, text))

        monkeypatch.setattr(room, '_emit_llm_round_reaction', fake_emit)
        run(room._announce_llm_round_reactions({'winnerIndex': 2}))
        assert [seat for seat, _ in spoken] == [2, 3, 1]
        assert spoken[0][1].startswith('自摸')
        assert all('输' in text or '结果已定' in text or '一局而已' in text
                   for _, text in spoken[1:])

        spoken.clear()
        run(room._announce_llm_round_reactions({'draw': True}))
        assert [seat for seat, _ in spoken] == [1, 2, 3]
        assert all('荒庄' in text or '无人和牌' in text or '未分胜负' in text
                   for _, text in spoken)

        spoken.clear()
        run(room._announce_llm_round_reactions({'winnerIndex': 0}))
        assert [seat for seat, _ in spoken] == [1, 2, 3]
        assert all('自摸' not in text for _, text in spoken)

    def test_settled_snapshot_is_hidden_until_round_reactions_finish(self):
        from app.game.manager import GameManager
        from app.game.player import AIPlayer
        from app.game.room import RoomSession, build_snapshot
        from app.models.game import GamePlayer

        room = RoomSession('DEFERRESULT', mode='east', capacity=4)
        room.manager = GameManager(controllers=[AIPlayer() for _ in range(4)])
        room.manager.players = [
            GamePlayer(name=f'P{seat}', avatar='', score=1000, seat=seat,
                       hand=['m1'], discards=[], melds=[], redCount=0,
                       drawnTileIndex=0)
            for seat in range(4)
        ]
        room.manager.phase = 'settled'
        room.manager.result = {'winnerIndex': 1, 'winner': 'P1'}

        pending = build_snapshot(room, 0)
        assert pending['phase'] == 'revealing'
        assert pending['result'] is None
        assert pending['players'][1]['hand'] == [None]

        room._presentation_audio_modes[0] = 'anime-fixed-tts-v1'
        anime = build_snapshot(room, 0)
        assert anime['phase'] == 'settled'
        assert anime['result']['winnerIndex'] == 1
        assert anime['players'][1]['hand'] == ['m1']

        room._settlement_snapshot_released = True
        room._round_speech_pending = True
        room._presentation_audio_modes[0] = 'legacy-dynamic'
        released = build_snapshot(room, 0)
        assert released['phase'] == 'settled'
        assert released['result']['winnerIndex'] == 1
        assert released['roundSpeechPending'] is True
        assert released['players'][1]['hand'] == ['m1']
        room._presentation_audio_modes[0] = 'anime-fixed-tts-v1'
        assert build_snapshot(room, 0)['roundSpeechPending'] is False

    def test_presentation_audio_mode_is_connection_scoped_and_keeps_early_continue(self):
        from app.game.room import RoomSession

        room = RoomSession('AUDIO-MODE', mode='east', capacity=4)
        assert room.handle_client_message(0, {
            'type': 'presentation_audio_mode', 'mode': 'anime-fixed-tts-v1',
        }) == (True, '')
        assert room._presentation_audio_mode(0) == 'anime-fixed-tts-v1'
        assert room.handle_client_message(0, {
            'type': 'presentation_audio_mode', 'mode': 'invalid',
        }) == (False, 'INVALID_PRESENTATION_AUDIO_MODE')

        room.manager = SimpleNamespace(
            phase='settled', result={'winnerIndex': 0}, round=1, honba=0)
        key = room._settlement_presentation_key()
        assert room.handle_client_message(0, {
            'type': 'continue', 'presentationKey': 'stale-key',
        }) == (True, '')
        assert room._early_continue_confirmed == {}
        assert room.handle_client_message(0, {
            'type': 'continue', 'presentationKey': key,
        }) == (True, '')
        assert room._early_continue_confirmed == {key: {0}}

    @pytest.mark.parametrize(
        ('internal', 'expected'),
        [
            ('added-kong', ('action', 'gang')),
            ('concealed-kong', ('action', 'gang')),
            ('wind-kong', ('action', 'gang')),
            ('peng', ('action', 'peng')),
            ('discard', ('commentary', 'discard')),
            ('pass', ('commentary', None)),
        ],
    )
    def test_model_speech_metadata_normalizes_internal_actions(self, internal, expected):
        from app.game.room import _model_speech_metadata
        assert _model_speech_metadata(internal) == expected

    def test_settlement_presentation_key_changes_when_same_room_restarts(self):
        from app.game.room import RoomSession

        room = RoomSession('RESTART-KEY', mode='east', capacity=4)
        room.manager = SimpleNamespace(
            phase='settled', result={'winnerIndex': 2}, round=1, honba=0)
        room._tts_match_generation = 1
        first = room._settlement_presentation_key()
        room._tts_match_generation = 2
        second = room._settlement_presentation_key()
        assert first != second

    def test_all_anime_connections_skip_legacy_round_reactions(self, monkeypatch):
        from app.game.player import AIPlayer
        from app.game.room import RoomSession

        room = RoomSession('ANIME-AUDIENCE', mode='east', capacity=4, llm_enabled=True)
        controller = LLMPlayer(
            config=deepseek_provider(style='稳健').to_config(), seat=1,
            provider_id='deepseek')
        room.manager = SimpleNamespace(
            controllers=[AIPlayer(), controller, AIPlayer(), AIPlayer()])
        room.conn._queues[0] = SimpleNamespace()
        room._presentation_audio_modes[0] = 'anime-fixed-tts-v1'
        emitted = []
        monkeypatch.setattr(room, '_emit_llm_round_reaction',
                            lambda *args: emitted.append(args))

        run(room._announce_llm_round_reactions({'winnerIndex': 1}))
        assert emitted == []

    def test_all_anime_connections_skip_dynamic_action_tts(self, monkeypatch):
        from app.game.player import AIPlayer
        from app.game.room import RoomSession

        emitted = []
        room = RoomSession('ANIME-ACTION', mode='east', capacity=4, llm_enabled=True)
        controller = LLMPlayer(
            config=deepseek_provider(style='稳健').to_config(), seat=1,
            provider_id='deepseek')
        room.manager = SimpleNamespace(
            controllers=[AIPlayer(), controller, AIPlayer(), AIPlayer()])
        room.conn._queues[0] = SimpleNamespace()
        room._presentation_audio_modes[0] = 'anime-fixed-tts-v1'
        monkeypatch.setattr(room.conn, 'broadcast', lambda message: emitted.append(message))

        room._on_llm_message(
            1, '这张我碰了。', 'important', decision='claim', action_kind='peng')

        assert emitted == []
        assert room._tts_tasks == set()
        assert room._tts_match_stats['requests'] == 0

    def test_mixed_room_routes_model_actions_only_to_legacy_audience(self):
        from app.game.room import RoomSession

        room = RoomSession('MIXED-AUDIENCE', mode='east', capacity=4, llm_enabled=True)
        anime_queue = asyncio.Queue()
        legacy_queue = asyncio.Queue()
        room.conn._queues.update({0: anime_queue, 1: legacy_queue})
        room._presentation_audio_modes.update({
            0: 'anime-fixed-tts-v1',
            1: 'legacy-dynamic',
        })
        action = {
            'kind': 'llm_audio', 'purpose': 'action',
            'speechSource': 'model-message',
        }
        room._broadcast_model_speech(action, 'action')
        assert anime_queue.empty()
        assert legacy_queue.get_nowait() == action

        commentary = {
            'kind': 'llm_message', 'purpose': 'commentary',
            'speechSource': 'model-message',
        }
        room._broadcast_model_speech(commentary, 'commentary')
        assert anime_queue.get_nowait() == commentary
        assert legacy_queue.get_nowait() == commentary

        frozen_targets = ((1, legacy_queue),)
        reconnected_queue = asyncio.Queue()
        new_legacy_queue = asyncio.Queue()
        room.conn._queues.update({1: reconnected_queue, 2: new_legacy_queue})
        room._presentation_audio_modes.update({1: 'legacy-dynamic', 2: 'legacy-dynamic'})
        room._broadcast_model_speech(action, 'action', frozen_targets)
        assert legacy_queue.empty()
        assert reconnected_queue.empty(), '同座位重连的新连接不能收到旧连接的孤立音频'
        assert new_legacy_queue.empty(), '合成后新加入的 legacy 连接不能收到孤立音频'

    def test_seat_provider_ids_resolve_per_seat(self, monkeypatch):
        from app.game.player import AIPlayer
        from app.game.room import RoomSession
        monkeypatch.setattr('app.game.room.llm_server_available', lambda: True)
        monkeypatch.setattr('app.game.room.load_llm_providers', lambda: {
            'ds': deepseek_provider(style='激进'), 'kimi': kimi_provider()})
        room = RoomSession('SEATS', mode='east', capacity=4, llm_enabled=True)
        room._llm_seat_providers = {1: 'ds', 3: 'kimi'}
        room._llm_seat_styles = {1: '高冷', 3: '话痨'}
        room._llm_default_provider = 'ds'
        controllers = room._controllers()
        assert isinstance(controllers[1], LLMPlayer)
        assert controllers[1].config.api_key == 'sk-server-ds'
        assert controllers[1].config.style == '高冷'
        assert isinstance(controllers[3], LLMPlayer)
        assert controllers[3].config.api_key == 'sk-server-kimi'
        assert controllers[3].config.style == '话痨'
        # 未指定座位 → 默认提供商 ds
        assert isinstance(controllers[2], LLMPlayer)
        assert controllers[2].config.api_key == 'sk-server-ds'
        assert isinstance(controllers[0], AIPlayer)

    def test_seed_display_name_and_avatar(self, monkeypatch):
        from app.game.manager import PLAYER_SEED
        from app.game.player import AIPlayer
        from app.game.room import RoomSession
        monkeypatch.setattr('app.game.room.llm_server_available', lambda: True)
        monkeypatch.setattr('app.game.room.load_llm_providers', lambda: {
            'ds': deepseek_provider(style='话痨'), 'kimi': kimi_provider()})
        room = RoomSession('SEEDS', mode='east', capacity=4, llm_enabled=True)
        room._llm_seat_providers = {2: 'ds'}
        room._llm_seat_styles = {2: '激进'}
        room._llm_default_provider = 'kimi'
        seeds = room._seeds()
        assert seeds[2]['name'] == '大肥鱼（激进）'
        assert seeds[2]['avatar'] == 'img/llm/deepseek/llm-avatar-jijin.png'
        # 未指定座位 → 默认提供商 kimi
        assert seeds[1]['name'] == '小K（稳健）'
        assert seeds[1]['avatar'] == 'img/llm/kimi/llm-avatar-wenjian.png'
        # 无 LLM 能力时沿用 AI 种子
        monkeypatch.setattr('app.game.room.llm_server_available', lambda: False)
        room2 = RoomSession('SEEDS2', mode='east', capacity=4, llm_enabled=True)
        assert room2._seeds()[1]['name'] == PLAYER_SEED[1]['name']

    def test_custom_orcarouter_model_maps_claude_character(self, monkeypatch):
        from app.game.room import RoomSession
        from app.llm.config import LlmProvider
        monkeypatch.setattr('app.game.room.llm_server_available', lambda: True)
        provider = LlmProvider(
            provider_id='orca-claude', name='Orca Claude',
            base_url='https://api.orcarouter.ai/v1', api_key='sk-test',
            model='anthropic/claude-sonnet-5', provider_type='custom')
        monkeypatch.setattr(
            'app.game.room.load_llm_providers', lambda: {'orca-claude': provider})
        room = RoomSession('ORCA-CLAUDE', mode='east', capacity=4, llm_enabled=True)
        room._llm_default_provider = 'orca-claude'

        seed = room._seeds()[1]
        assert seed['characterId'] == 'claude'
        assert seed['avatar'] == 'img/llm/claude/llm-avatar-wenjian.png'

    def test_unknown_provider_falls_back_to_heuristic(self, monkeypatch):
        from app.game.player import AIPlayer
        from app.game.room import RoomSession
        monkeypatch.setattr('app.game.room.llm_server_available', lambda: True)
        monkeypatch.setattr('app.game.room.load_llm_providers', lambda: {'ds': deepseek_provider()})
        room = RoomSession('UNK', mode='east', capacity=4, llm_enabled=True)
        room._llm_seat_providers = {1: 'ghost'}  # 未知 id（开局校验已拦，此处兜底）
        room._llm_default_provider = 'ds'
        controllers = room._controllers()
        assert isinstance(controllers[1], AIPlayer)
        assert isinstance(controllers[2], LLMPlayer)


# ── 局况元数据（§6.2/§6.4）───────────────────────────────────

class TestMeta:
    def test_llm_meta_fields(self):
        from app.game.manager import GameManager
        manager = GameManager()
        manager.players = [SimpleNamespace(score=1000, discards=[], melds=[],
                                           hand=['m1']) for _ in range(4)]
        manager.dealer = 1
        manager.round = 2
        manager.phase = 'drawing'
        manager._head_drawn = 4
        manager.wall = ['m2']
        meta = manager._llm_meta(2, 'turn')
        assert meta['seatWind'] == '南'   # 庄家 1 座 → 座位 2 为南
        assert meta['roundWind'] == '东'
        assert meta['dealerIndex'] == 1
        assert meta['roundIndex'] == 2
        assert meta['requestId'].startswith('turn-2-')
        assert 'drawing' in meta['stateVersion']
        assert meta['scores'] == [1000, 1000, 1000, 1000]
        assert len(meta['peers']) == 4


@pytest.mark.parametrize(('model', 'reasoning', 'fields', 'absent'), [
    ('glm-5.3', False, {'enable_thinking': True, 'reasoning_effort': 'low'},
     ('max_tokens', 'thinking')),
    ('glm-5.3', True, {'enable_thinking': True, 'reasoning_effort': 'high'},
     ('thinking',)),
    ('glm-4.6v', False, {'enable_thinking': False},
     ('max_tokens', 'thinking', 'reasoning_effort')),
    ('glm-4.6v', True, {'enable_thinking': True},
     ('thinking', 'reasoning_effort')),
    ('deepseek-v4-flash-0731', False,
     {'enable_thinking': True, 'reasoning_effort': 'low'},
     ('max_tokens', 'thinking')),
    ('deepseek-v4-flash-0731', True,
     {'enable_thinking': True, 'reasoning_effort': 'high'},
     ('thinking',)),
    ('kimi-k3', False, {'enable_thinking': True},
     ('reasoning_effort', 'max_tokens', 'temperature', 'top_p')),
    ('kimi-k2.7-code', False, {},
     ('reasoning_effort', 'max_tokens', 'temperature', 'top_p')),
])
def test_dashscope_hosted_third_party_payloads(monkeypatch, model, reasoning, fields, absent):
    import httpx
    from app.llm.client import request_llm_decision
    from app.llm.config import LlmServerConfig

    captured = {}

    async def handler(request: httpx.Request):
        captured.update(json.loads(request.content))
        thinking = reasoning or model != 'glm-4.6v'
        return httpx.Response(200, json={'choices': [{
            'message': {'content': '{"choice":"A1","message":"稳住"}',
                        **({'reasoning_content': '内部思考'} if thinking else {})},
            'finish_reason': 'stop',
        }]})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
    cfg = LlmServerConfig(
        enabled=True, base_url='https://dashscope.aliyuncs.com/compatible-mode/v1',
        api_key='sk-test', model=model, provider_type='qwen')
    assert run(request_llm_decision(cfg, 'system', 'user', ['A1'], reasoning=reasoning)) == ('A1', '稳住')
    for key, value in fields.items():
        assert captured[key] == value
    for key in absent:
        assert key not in captured
    run(http.aclose())


def test_dashscope_conditional_tier_only_when_adjustable(monkeypatch):
    from app.llm.config import LlmServerConfig

    calls = []

    async def fake_decision(_cfg, _system, _user, _ids, **options):
        calls.append(options['reasoning'])
        return 'A1', '稳住。'

    monkeypatch.setattr('app.game.llm_player.request_llm_decision', fake_decision)
    for model, expected in [('kimi-k3', False), ('MiniMax-M2.5', False),
                            ('MiniMax-M2.1', False), ('glm-5.3', True)]:
        player = LLMPlayer(
            delays={'turn': 0, 'after_kong': 0, 'claim': 0},
            config=LlmServerConfig(
                enabled=True,
                base_url='https://dashscope.aliyuncs.com/compatible-mode/v1',
                api_key='sk-test', model=model, provider_type='qwen', style='稳健'),
            seat=1,
        )
        admissions = []

        def admit(*_args):
            admissions.append(True)
            return True

        monkeypatch.setattr(player.reasoning, 'admit', admit)
        ctx = turn_ctx(hand=['m3', 'm5', 'm6'], turnOrigin='draw')
        ctx.wallCount = 12
        assert run(player.request_turn(ctx))['kind'] == 'discard'
        assert calls[-1] is expected
        assert len(admissions) == (1 if expected else 0)


@pytest.mark.parametrize('model', ['MiniMax-M2.5', 'MiniMax-M2.1'])
def test_dashscope_minimax_m2_models_send_supported_fields(monkeypatch, model):
    import httpx
    from app.llm.client import request_llm_decision
    from app.llm.config import LlmServerConfig

    captured = {}

    async def handler(request: httpx.Request):
        captured.update(json.loads(request.content))
        return httpx.Response(200, json={'choices': [{
            'message': {'reasoning_content': '只供内部推理',
                        'content': '{"choice":"A1","message":"稳住"}'},
            'finish_reason': 'stop',
        }]})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr('app.llm.client.get_llm_client', lambda: http)
    cfg = LlmServerConfig(
        enabled=True, base_url='https://dashscope.aliyuncs.com/compatible-mode/v1',
        api_key='sk-test', model=model, provider_type='qwen')
    assert run(request_llm_decision(cfg, 'system', 'user', ['A1'])) == ('A1', '稳住')
    assert captured['model'] == model
    for key in ('temperature', 'top_p', 'thinking', 'enable_thinking',
                'reasoning_effort', 'response_format', 'max_tokens'):
        assert key not in captured
    run(http.aclose())
