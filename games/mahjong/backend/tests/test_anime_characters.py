import json
import re

import pytest

from app.game.anime_characters import (
    ANIME_ACTION_LINE_KEYS,
    ANIME_CHARACTER_CATALOG,
    ANIME_CHARACTER_SCHEMA_VERSION,
    ANIME_RESULT_LINE_KEYS,
    ANIME_TTS_SPEAKERS,
    ANIME_TTS_STYLE,
    ANIME_TTS_VOICE_KEYS,
    ANIME_VOICE_LINE_KEYS,
    CHARACTER_IDS,
    DEFAULT_ANIME_CHARACTER_ID,
    anime_character_catalog_contract,
    anime_character_id_for_provider,
    anime_character_profile,
    anime_fixed_line,
    is_anime_character_id,
    normalize_anime_catalog_token,
    requested_anime_character_id,
    resolve_anime_character_id,
    resolve_anime_character_id_for_avatar_folder,
    resolve_anime_character_id_for_provider,
)
from app.tts.config import TtsConfig


EXPECTED_LABELS = {
    'claude': '克劳德书姬',
    'deepseek': '大肥鱼',
    'doubao': '豆包学妹',
    'gemini': '双子星姬',
    'glm': '智谱狐姬',
    'gpt': 'GPT龙姬',
    'grok': 'Grok小恶魔',
    'kimi': 'Kimi月姬',
    'minimax': 'MiniMax导演',
    'mistral': '米斯特拉风狐',
    'muse': '缪斯梦姬',
    'qwen': '千问大小姐',
}

EXPECTED_ALIASES = {
    'claude': ('claude', 'anthropic'),
    'deepseek': ('deepseek',),
    'doubao': ('doubao', 'volcengine', 'volcano-ark'),
    'gemini': ('gemini', 'google-ai'),
    'glm': ('glm', 'zhipu', 'bigmodel'),
    'gpt': ('gpt', 'openai'),
    'grok': ('grok', 'xai'),
    'kimi': ('kimi', 'moonshot'),
    'minimax': ('minimax',),
    'mistral': ('mistral',),
    'muse': ('muse',),
    'qwen': ('qwen', 'qwq', 'dashscope', 'tongyi'),
}

EXPECTED_VOICES = {
    'claude': ('claude', 'default'),
    'deepseek': ('deepseek', 'default'),
    'doubao': ('doubao', 'default'),
    'gemini': ('qwen', 'default'),
    'glm': ('glm', 'default'),
    'gpt': ('gpt', 'relay_gpt'),
    'grok': ('kimi', 'default'),
    'kimi': ('kimi', 'default'),
    'minimax': ('minimax', 'default'),
    'mistral': ('minimax', 'default'),
    'muse': ('claude', 'default'),
    'qwen': ('qwen', 'default'),
}


def test_catalog_freezes_twelve_ids_labels_aliases_and_schema():
    assert ANIME_CHARACTER_SCHEMA_VERSION == 2
    assert DEFAULT_ANIME_CHARACTER_ID == 'deepseek'
    assert tuple(profile.id for profile in ANIME_CHARACTER_CATALOG) == CHARACTER_IDS
    assert len(ANIME_CHARACTER_CATALOG) == len(set(CHARACTER_IDS)) == 12
    assert {profile.id: profile.label for profile in ANIME_CHARACTER_CATALOG} == EXPECTED_LABELS
    assert {profile.id: profile.provider_aliases for profile in ANIME_CHARACTER_CATALOG} == EXPECTED_ALIASES

    aliases = [alias for profile in ANIME_CHARACTER_CATALOG for alias in profile.provider_aliases]
    assert len(aliases) == len(set(aliases))
    assert all(normalize_anime_catalog_token(alias) == alias for alias in aliases)


def test_voice_contract_only_uses_backend_supported_keys_and_stable_style():
    configured_keys = TtsConfig().voice_keys
    assert set(ANIME_TTS_VOICE_KEYS) <= configured_keys
    assert set(ANIME_TTS_SPEAKERS) == set(ANIME_TTS_VOICE_KEYS)
    assert all(re.fullmatch(r'[A-Za-z0-9_.-]+', value) for value in ANIME_TTS_SPEAKERS.values())

    for profile in ANIME_CHARACTER_CATALOG:
        assert (profile.voice_key, profile.fallback_voice_key) == EXPECTED_VOICES[profile.id]
        assert profile.voice_key in configured_keys
        assert profile.fallback_voice_key in configured_keys
        assert profile.speaker == ANIME_TTS_SPEAKERS[profile.voice_key]
        assert profile.tts_style == ANIME_TTS_STYLE == '稳健'


def test_every_character_has_fourteen_bounded_fixed_lines():
    # 显式键集合，不再按位置切片（2026-09-19 加入 hu-2 / zimo-2 / qiangganghu-2 后必须同步改动）。
    action_keys = set(ANIME_ACTION_LINE_KEYS)
    result_keys = set(ANIME_RESULT_LINE_KEYS)
    assert action_keys | result_keys == set(ANIME_VOICE_LINE_KEYS)
    assert action_keys & result_keys == set()
    assert len(action_keys) == 9 and len(result_keys) == 5
    combinations: set[tuple[str, str, str, str]] = set()

    for profile in ANIME_CHARACTER_CATALOG:
        assert tuple(profile.lines) == ANIME_VOICE_LINE_KEYS
        assert set(profile.lines) == action_keys | result_keys
        assert all(1 <= len(profile.lines[key]) <= 8 for key in action_keys)
        assert all(1 <= len(profile.lines[key]) <= 24 for key in result_keys)
        for line_key, text in profile.lines.items():
            combinations.add((profile.id, line_key, text, profile.voice_key))

    assert len(combinations) == 12 * 14 == 168
    assert anime_fixed_line('deepseek', 'chi') == '吃一口！'
    assert anime_fixed_line('missing', 'draw') == ANIME_CHARACTER_CATALOG[1].lines['draw']
    with pytest.raises(KeyError):
        anime_fixed_line('deepseek', 'arbitrary')  # type: ignore[arg-type]


def test_fixed_lines_avoid_report_style_and_x_becomes_y_phrasing():
    """2026-09-19 用户评审：报告腔与「某某成某」都不像人说的话。

    `推演` / `判断失误` 属角色人设与自然口语，不在红线内；红线针对"任务汇报"用词。
    """
    report_style = re.compile(r'完成|成立|结论|验证|样本|误差|记录|最优|计算|命中率')
    x_becomes_y = re.compile(r'成(?:胡|局|杠|章|牌|和)')
    offenders = [
        (profile.id, key, text)
        for profile in ANIME_CHARACTER_CATALOG
        for key, text in profile.lines.items()
        if report_style.search(text) or x_becomes_y.search(text)
    ]
    assert offenders == []
    # 反例自检：口语化的「成了」「算准了」不在这条红线里；旧写法会被拦住。
    assert not report_style.search('这一手，成了。')
    assert not x_becomes_y.search('这一手，成了。')
    assert not report_style.search('这次判断失误，下局调整。')
    assert report_style.search('杠，推演完成。')
    assert x_becomes_y.search('这张正好成胡。')


@pytest.mark.parametrize('value', [None, 1, '', 'unknown', '../qwen', 'qwen/path', 'qwen x'])
def test_strict_token_and_requested_id_reject_unknown_or_unsafe_values(value):
    assert requested_anime_character_id(value) is None
    assert resolve_anime_character_id(value) == 'deepseek'


def test_ids_and_provider_aliases_are_normalized_without_substring_guessing():
    assert is_anime_character_id('qwen') is True
    assert is_anime_character_id(' QWEN ') is False
    assert requested_anime_character_id('  ＱＷＥＮ  ') == 'qwen'
    assert requested_anime_character_id('OpenAI') is None
    assert anime_character_id_for_provider(' OpenAI ') == 'gpt'
    assert anime_character_id_for_provider(' GOOGLE-AI ') == 'gemini'
    assert anime_character_id_for_provider('prod-qwen') is None
    assert anime_character_id_for_provider('https://api.openai.com') is None
    assert normalize_anime_catalog_token('VOLCANO-ARK') == 'volcano-ark'
    assert resolve_anime_character_id_for_provider('unknown') == 'deepseek'
    assert resolve_anime_character_id_for_avatar_folder('../qwen') == 'deepseek'
    assert resolve_anime_character_id_for_avatar_folder('qwen') == 'qwen'


def test_combined_resolution_has_frozen_priority_and_deepseek_fallback():
    assert resolve_anime_character_id(
        'claude', provider_id='qwen', avatar_folder='gpt',
    ) == 'claude'
    assert resolve_anime_character_id(
        'invalid', provider_id='qwen', avatar_folder='gpt',
    ) == 'qwen'
    assert resolve_anime_character_id(
        None, provider_id='invalid', avatar_folder='gpt',
    ) == 'gpt'
    assert resolve_anime_character_id(
        None, provider_id='../qwen', avatar_folder='../gpt',
    ) == 'deepseek'
    assert anime_character_profile('../../etc').id == 'deepseek'


def test_serializable_contract_uses_frontend_field_names_and_returns_a_copy():
    contract = anime_character_catalog_contract()
    assert contract['schemaVersion'] == 2
    assert contract['defaultCharacter'] == 'deepseek'
    assert contract['ttsStyle'] == '稳健'
    assert contract['voiceLineKeys'] == list(ANIME_VOICE_LINE_KEYS)
    assert json.loads(json.dumps(contract, ensure_ascii=False)) == contract

    characters = contract['characters']
    assert isinstance(characters, list)
    assert len(characters) == 12
    assert set(characters[0]) == {
        'id', 'label', 'providerAliases', 'voiceKey', 'speaker',
        'fallbackVoiceKey', 'lines', 'ttsStyle',
    }
    characters[0]['label'] = 'mutated'
    assert anime_character_catalog_contract()['characters'][0]['label'] == '克劳德书姬'


def test_room_seeds_classify_human_llm_and_bot_characters(monkeypatch):
    from app.game.room import RoomSession
    from app.llm.config import LlmProvider

    provider = LlmProvider(
        'private-gemini', name='Gemini', base_url='https://proxy.example/v1',
        api_key='test-key', model='gemini-pro', avatar_folder='gemini',
    )
    monkeypatch.setattr('app.game.room.load_llm_providers', lambda: {'private-gemini': provider})
    monkeypatch.setattr('app.game.room.llm_server_available', lambda: True)

    room = RoomSession('ANIME1', capacity=1, llm_enabled=True)
    _, _, human = room.join_or_rejoin('真人', character_id='qwen')
    assert human.character_id == 'qwen'
    room._llm_seat_providers = {1: 'private-gemini'}
    # 其余空位指定不存在的默认 provider，保持普通启发式 bot。
    room._llm_default_provider = 'not-configured'

    seeds = room._seeds()
    assert (seeds[0]['characterId'], seeds[0]['playerKind']) == ('qwen', 'human')
    assert (seeds[1]['characterId'], seeds[1]['playerKind']) == ('gemini', 'llm')
    assert (seeds[2]['characterId'], seeds[2]['playerKind']) == ('deepseek', 'bot')
    assert (seeds[3]['characterId'], seeds[3]['playerKind']) == ('deepseek', 'bot')


def test_game_player_identity_survives_resets_and_flows_into_snapshot():
    from app.game.manager import GameManager
    from app.game.player import AIPlayer
    from app.game.room import RoomSession, build_snapshot

    seeds = [
        {
            'name': f'P{seat}', 'avatar': '', 'score': 1000,
            'characterId': 'qwen' if seat == 0 else 'deepseek',
            'playerKind': 'human' if seat == 0 else 'bot',
        }
        for seat in range(4)
    ]
    manager = GameManager(
        controllers=[AIPlayer() for _ in range(4)], player_seeds=seeds,
    )
    manager._reset_players()
    manager.players[0].score = 1234
    manager._reset_players()

    assert manager.players[0].score == 1234
    assert manager.players[0].characterId == 'qwen'
    assert manager.players[0].playerKind == 'human'

    room = RoomSession('ANIME2')
    room.manager = manager
    snapshot = build_snapshot(room, 0)
    assert snapshot['players'][0]['characterId'] == 'qwen'
    assert snapshot['players'][0]['playerKind'] == 'human'
    assert snapshot['players'][1]['characterId'] == 'deepseek'
    assert snapshot['players'][1]['playerKind'] == 'bot'

    # 兼容旧 seeds：若 seed 不含身份字段，下一局仍保留已有 GamePlayer 身份。
    manager.seeds = [
        {'name': f'P{seat}', 'avatar': '', 'score': 1000}
        for seat in range(4)
    ]
    manager._reset_players()
    assert manager.players[0].characterId == 'qwen'
    assert manager.players[0].playerKind == 'human'
