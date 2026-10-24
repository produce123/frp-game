"""``llmAnime`` 角色白名单与固定语音合同。

Wave 0 只冻结纯数据和解析函数，不接入现有房间或 TTS 调用链。客户端传入的
值永远不会用于拼接路径；未知、非法或缺失值统一回退 DeepSeek 角色。
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from types import MappingProxyType
from typing import Final, Literal, Mapping, TypeAlias, cast
import unicodedata


ANIME_CHARACTER_SCHEMA_VERSION: Final = 2
DEFAULT_ANIME_CHARACTER_ID: Final = 'deepseek'
ANIME_TTS_STYLE: Final = '稳健'

CharacterId: TypeAlias = Literal[
    'claude', 'deepseek', 'doubao', 'gemini', 'glm', 'gpt',
    'grok', 'kimi', 'minimax', 'mistral', 'muse', 'qwen',
]
AnimeVoiceLineKey: TypeAlias = Literal[
    'chi', 'peng', 'gang', 'hu', 'zimo', 'qiangganghu',
    'hu-2', 'zimo-2', 'qiangganghu-2',
    'win-self-draw', 'win-discard', 'win-robbed-kong', 'loss', 'draw',
]
AnimeTtsVoiceKey: TypeAlias = Literal[
    'default', 'deepseek', 'qwen', 'kimi', 'doubao',
    'minimax', 'gpt', 'relay_gpt', 'glm', 'claude',
]

CHARACTER_IDS: Final[tuple[CharacterId, ...]] = (
    'claude', 'deepseek', 'doubao', 'gemini', 'glm', 'gpt',
    'grok', 'kimi', 'minimax', 'mistral', 'muse', 'qwen',
)
# 动作键 = 血流高频赢家瞬间 + 吃碰杠；结果键 = 局末感言。顺序即合同顺序（前端同序）。
ANIME_ACTION_LINE_KEYS: Final[tuple[AnimeVoiceLineKey, ...]] = (
    'chi', 'peng', 'gang', 'hu', 'zimo', 'qiangganghu',
    'hu-2', 'zimo-2', 'qiangganghu-2',
)
ANIME_RESULT_LINE_KEYS: Final[tuple[AnimeVoiceLineKey, ...]] = (
    'win-self-draw', 'win-discard', 'win-robbed-kong', 'loss', 'draw',
)
ANIME_VOICE_LINE_KEYS: Final[tuple[AnimeVoiceLineKey, ...]] = (
    ANIME_ACTION_LINE_KEYS + ANIME_RESULT_LINE_KEYS
)
ANIME_TTS_VOICE_KEYS: Final[tuple[AnimeTtsVoiceKey, ...]] = (
    'default', 'deepseek', 'qwen', 'kimi', 'doubao',
    'minimax', 'gpt', 'relay_gpt', 'glm', 'claude',
)

ANIME_TTS_SPEAKERS: Final[Mapping[AnimeTtsVoiceKey, str]] = MappingProxyType({
    'default': 'ICL_uranus_zh_female_chunzhenshaonv_tob',
    'deepseek': 'ICL_uranus_zh_female_tianmeijiaoqiao_tob',
    'qwen': 'ICL_uranus_zh_female_wenrouwenya_tob',
    'kimi': 'ICL_uranus_zh_female_aojiaonvyou_tob',
    'doubao': 'zh_female_tianmeitaozi_uranus_bigtts',
    'minimax': 'ICL_uranus_zh_female_qinglenggaoya_tob',
    'gpt': 'ICL_uranus_zh_female_tiexinnvyou_tob',
    'relay_gpt': 'ICL_uranus_zh_female_tiexinnvyou_tob',
    'glm': 'zh_female_vv_uranus_bigtts',
    'claude': 'ICL_uranus_zh_female_chengshujiejie_tob',
})

_SAFE_TOKEN = re.compile(r'[a-z0-9._-]{1,64}')


@dataclass(frozen=True, slots=True)
class AnimeCharacterProfile:
    """可与前端 manifest 对照的单个角色合同。"""

    id: CharacterId
    label: str
    provider_aliases: tuple[str, ...]
    voice_key: AnimeTtsVoiceKey
    speaker: str
    fallback_voice_key: AnimeTtsVoiceKey
    lines: Mapping[AnimeVoiceLineKey, str]
    tts_style: Literal['稳健'] = ANIME_TTS_STYLE


def _lines(**values: str) -> Mapping[AnimeVoiceLineKey, str]:
    """创建只读文案表；键名中的下划线会转换为合同中的连字符。"""

    normalized = {key.replace('_', '-'): value for key, value in values.items()}
    if set(normalized) != set(ANIME_VOICE_LINE_KEYS):
        raise ValueError('anime character lines must contain exactly 14 fixed slots')
    return MappingProxyType(cast(dict[AnimeVoiceLineKey, str], normalized))


def _profile(
    id_: CharacterId,
    label: str,
    provider_aliases: tuple[str, ...],
    voice_key: AnimeTtsVoiceKey,
    fallback_voice_key: AnimeTtsVoiceKey,
    lines: Mapping[AnimeVoiceLineKey, str],
) -> AnimeCharacterProfile:
    return AnimeCharacterProfile(
        id=id_,
        label=label,
        provider_aliases=provider_aliases,
        voice_key=voice_key,
        speaker=ANIME_TTS_SPEAKERS[voice_key],
        fallback_voice_key=fallback_voice_key,
        lines=lines,
    )


# 与前端 ``src/game/llm/animeCharacters.ts`` 的 schemaVersion=1 合同逐项一致。
# 合成请求只发送 voiceKey；speaker 是当前部署示例的冻结审计记录。
ANIME_CHARACTER_CATALOG: Final[tuple[AnimeCharacterProfile, ...]] = (
    _profile('claude', '克劳德书姬', ('claude', 'anthropic'), 'claude', 'default', _lines(
        chi='这一页，我吃。', peng='线索碰上了。', gang='这杠记下了。',
        hu='这一章，胡了。', zimo='答案自己来了。', qiangganghu='这杠，我读到了。',
        hu_2='这一段，我收尾。', zimo_2='这一页，到我了。', qiangganghu_2='你开杠，我读牌。',
        win_self_draw='自摸收尾，这一章圆满了。', win_discard='借你一牌，写下本局结尾。',
        win_robbed_kong='识破杠意，这一章由我收尾。', loss='这页失手，翻篇再读。',
        draw='本局留白，下一章再续。',
    )),
    _profile('deepseek', '大肥鱼', ('deepseek',), 'deepseek', 'default', _lines(
        chi='吃一口！', peng='碰上了！', gang='杠起来！', hu='胡啦！', zimo='自摸啦！',
        qiangganghu='这杠我抢啦！', hu_2='胡到嘴里啦！', zimo_2='又摸到一条！',
        qiangganghu_2='这杠归我啦！', win_self_draw='自摸到手，大肥鱼也会翻身！',
        win_discard='接得漂亮，这一局我赢啦！', win_robbed_kong='杠上开花？这张我先胡啦！',
        loss='这局没吃饱，下局再来！', draw='荒庄也稳住，下一局见！',
    )),
    _profile('doubao', '豆包学妹', ('doubao', 'volcengine', 'volcano-ark'), 'doubao', 'default', _lines(
        chi='好耶，我吃！', peng='碰到啦！', gang='看我开杠！', hu='胡啦胡啦！', zimo='自摸到啦！',
        qiangganghu='抢杠成功！', hu_2='胡啦，超开心！', zimo_2='自己摸到啦！',
        qiangganghu_2='诶，抢到了！', win_self_draw='自摸成功，今天手气真甜！',
        win_discard='谢谢这张牌，我就胡啦！', win_robbed_kong='嘿嘿，这个杠我抢到啦！',
        loss='差一点点，下局继续加油！', draw='荒庄啦，大家下一局再见！',
    )),
    _profile('gemini', '双子星姬', ('gemini', 'google-ai'), 'qwen', 'default', _lines(
        chi='双星来吃！', peng='双星相碰！', gang='星轨开杠！', hu='两星合胡！', zimo='双星自摸！',
        qiangganghu='星隙抢杠胡！', hu_2='星轨对上了！', zimo_2='星光归我。',
        qiangganghu_2='星隙里截胡！', win_self_draw='双星汇聚，自摸落定。',
        win_discard='借你一张，让星局完整。', win_robbed_kong='看见杠隙，双星先胡一步。',
        loss='星轨偏了一点，下局重来。', draw='星河未决，下一局再会。',
    )),
    _profile('glm', '智谱狐姬', ('glm', 'zhipu', 'bigmodel'), 'glm', 'default', _lines(
        chi='算到了，我吃。', peng='碰，正好凑齐。', gang='这一杠，算到了。', hu='胡了，正如我算。',
        zimo='自摸，全在算中。', qiangganghu='抢杠，早算到了。',
        hu_2='这一步，算准了。', zimo_2='自己摸的，更准。', qiangganghu_2='杠一响，我出手。',
        win_self_draw='推演命中，自摸到手。', win_discard='关键牌到了，这一局归我。',
        win_robbed_kong='杠中有隙，我先胡一步。', loss='这局算漏了，下局补上。',
        draw='这局没算完，下一局继续。',
    )),
    _profile('gpt', 'GPT龙姬', ('gpt', 'openai'), 'gpt', 'relay_gpt', _lines(
        chi='这张，我吃。', peng='好牌，碰了。', gang='机会正好，杠。', hu='胡了，稳稳的。',
        zimo='自摸，漂亮。', qiangganghu='抢杠胡，拿下。',
        hu_2='这一手，成了。', zimo_2='手到牌来，不错。', qiangganghu_2='杠口我收了。',
        win_self_draw='自摸到手，这轮稳了。', win_discard='感谢关键牌，胜局已经锁定。',
        win_robbed_kong='抓住杠口，这局由我拿下。', loss='这次判断失误，下局调整。',
        draw='牌局未分胜负，继续下一轮。',
    )),
    _profile('grok', 'Grok小恶魔', ('grok', 'xai'), 'kimi', 'default', _lines(
        chi='这张归我！', peng='碰！逮到你了。', gang='开杠，别眨眼！', hu='胡了，惊喜吧！',
        zimo='自摸，气不气？', qiangganghu='敢杠？我抢胡！',
        hu_2='胡了，没想到吧？', zimo_2='手气在我这边。', qiangganghu_2='这杠，我截啦！',
        win_self_draw='自摸登场，今天我就是运气。', win_discard='送牌这么客气，那我收下啦！',
        win_robbed_kong='当面开杠？当然要抢胡啦！', loss='哼，这局先让你得意一下。',
        draw='没分胜负？那就再闹一局。',
    )),
    _profile('kimi', 'Kimi月姬', ('kimi', 'moonshot'), 'kimi', 'default', _lines(
        chi='月光引牌，吃。', peng='碰，月色正好。', gang='月下开杠。', hu='月光落到手边。',
        zimo='月来了，自摸。', qiangganghu='月影一闪，抢。',
        hu_2='这一张，月光送。', zimo_2='月下悄悄自摸。', qiangganghu_2='趁月色抢了。',
        win_self_draw='月光送来好牌，自摸到手。', win_discard='借你一张牌，今晚月色正好。',
        win_robbed_kong='杠影一闪，正好让我抢胡。', loss='今夜月色稍淡，下局再来。',
        draw='月落无果，且等下一轮。',
    )),
    _profile('minimax', 'MiniMax导演', ('minimax',), 'minimax', 'default', _lines(
        chi='素材到手，吃。', peng='镜头碰上！', gang='开杠，开机！', hu='胡了，收工！',
        zimo='自摸，一条过！', qiangganghu='抢杠胡，卡！',
        hu_2='这条，我留下！', zimo_2='自摸，正好一条。', qiangganghu_2='这杠，我抢镜。',
        win_self_draw='一条自摸，这局完美收工。', win_discard='接住这张，胜利镜头拍好了。',
        win_robbed_kong='抢杠成功，这段就是高光。', loss='这一条不够好，下局重拍。',
        draw='本局没有结尾，下一条继续。',
    )),
    _profile('mistral', '米斯特拉风狐', ('mistral',), 'minimax', 'default', _lines(
        chi='顺风吃牌。', peng='风起，碰。', gang='乘风开杠。', hu='风定，胡了。',
        zimo='好风自摸。', qiangganghu='风口抢杠胡。',
        hu_2='借风胡一张。', zimo_2='风送来的，收。', qiangganghu_2='乘风截这一杠。',
        win_self_draw='顺风自摸，胜局自然抵达。', win_discard='借一阵东风，这张正好。',
        win_robbed_kong='杠风露隙，我便顺势抢胡。', loss='风向有变，下一局再追。',
        draw='风停牌尽，来局再起。',
    )),
    _profile('muse', '缪斯梦姬', ('muse',), 'claude', 'default', _lines(
        chi='灵感来了，吃。', peng='碰出灵感！', gang='灵感开杠。', hu='这一曲，胡了。',
        zimo='自摸如歌。', qiangganghu='杠声起，我接上。',
        hu_2='灵感到了，胡。', zimo_2='这一摸，合拍。', qiangganghu_2='抢一个高音。',
        win_self_draw='灵感自来，这一局写成了。', win_discard='借你一音，正好谱成胜曲。',
        win_robbed_kong='杠声未落，这一节归我。', loss='这一曲有遗憾，下局再写。',
        draw='余音未定，下一局续篇。',
    )),
    _profile('qwen', '千问大小姐', ('qwen', 'qwq', 'dashscope', 'tongyi'), 'qwen', 'default', _lines(
        chi='这张我吃。', peng='碰，正合我意。', gang='杠，机会来了。', hu='胡了，请承让。',
        zimo='自摸，刚刚好。', qiangganghu='抢杠胡，失礼了。',
        hu_2='这一张，我收下。', zimo_2='自摸，恰好如意。', qiangganghu_2='失礼，我先胡。',
        win_self_draw='自摸如期而至，承让了。', win_discard='一张定局，多谢你的好牌。',
        win_robbed_kong='此杠有隙，我便收下胜局。', loss='胜负寻常，我会再算一局。',
        draw='牌山已尽，且待下一局。',
    )),
)


def normalize_anime_catalog_token(value: object) -> str | None:
    """严格归一化外部 token：NFKC、去首尾空白、小写，再验证安全字符集。"""

    if not isinstance(value, str):
        return None
    normalized = unicodedata.normalize('NFKC', value).strip().lower()
    return normalized if _SAFE_TOKEN.fullmatch(normalized) else None


_PROFILE_BY_ID: Final[dict[CharacterId, AnimeCharacterProfile]] = {
    profile.id: profile for profile in ANIME_CHARACTER_CATALOG
}
_CHARACTER_BY_ALIAS: Final[dict[str, CharacterId]] = {
    alias: profile.id
    for profile in ANIME_CHARACTER_CATALOG
    for alias in profile.provider_aliases
}


def requested_anime_character_id(value: object) -> CharacterId | None:
    """只接受 12 个 canonical CharacterId；provider alias 不能冒充请求角色 ID。"""

    normalized = normalize_anime_catalog_token(value)
    return cast(CharacterId, normalized) if normalized in _PROFILE_BY_ID else None


def is_anime_character_id(value: object) -> bool:
    """判断值是否已经是 canonical CharacterId，不执行宽松归一化。"""

    return isinstance(value, str) and value in _PROFILE_BY_ID


def anime_character_id_for_provider(value: object) -> CharacterId | None:
    """将严格归一化后的 provider id 或 avatar folder 映射到角色。"""

    normalized = normalize_anime_catalog_token(value)
    return _CHARACTER_BY_ALIAS.get(normalized) if normalized is not None else None


def resolve_anime_character_id_for_provider(value: object) -> CharacterId:
    """解析 provider id；未知或非法值统一回退 DeepSeek。"""

    return anime_character_id_for_provider(value) or DEFAULT_ANIME_CHARACTER_ID


def resolve_anime_character_id_for_avatar_folder(value: object) -> CharacterId:
    """解析 avatar folder 白名单别名；绝不接受或拼接任意路径。"""

    return anime_character_id_for_provider(value) or DEFAULT_ANIME_CHARACTER_ID


def resolve_anime_character_id(
    requested_id: object = None,
    *,
    provider_id: object = None,
    avatar_folder: object = None,
) -> CharacterId:
    """按 request > provider id > avatar folder > DeepSeek 的固定顺序解析。"""

    return (
        requested_anime_character_id(requested_id)
        or anime_character_id_for_provider(provider_id)
        or anime_character_id_for_provider(avatar_folder)
        or DEFAULT_ANIME_CHARACTER_ID
    )


def anime_character_profile(character_id: object) -> AnimeCharacterProfile:
    """取得安全角色档案；未知值返回 DeepSeek 档案。"""

    resolved = requested_anime_character_id(character_id) or DEFAULT_ANIME_CHARACTER_ID
    return _PROFILE_BY_ID[resolved]


def anime_fixed_line(character_id: object, line_key: AnimeVoiceLineKey) -> str:
    """取得固定动作/赛后文案；非法语音槽位抛出 KeyError，不接受任意文案。"""

    if line_key not in ANIME_VOICE_LINE_KEYS:
        raise KeyError(line_key)
    return anime_character_profile(character_id).lines[line_key]


def anime_character_catalog_contract() -> dict[str, object]:
    """返回可序列化的新副本，供前后端 schemaVersion 合同测试与审计。"""

    return {
        'schemaVersion': ANIME_CHARACTER_SCHEMA_VERSION,
        'defaultCharacter': DEFAULT_ANIME_CHARACTER_ID,
        'ttsStyle': ANIME_TTS_STYLE,
        'voiceLineKeys': list(ANIME_VOICE_LINE_KEYS),
        'characters': [
            {
                'id': profile.id,
                'label': profile.label,
                'providerAliases': list(profile.provider_aliases),
                'voiceKey': profile.voice_key,
                'speaker': profile.speaker,
                'fallbackVoiceKey': profile.fallback_voice_key,
                'lines': dict(profile.lines),
                'ttsStyle': profile.tts_style,
            }
            for profile in ANIME_CHARACTER_CATALOG
        ],
    }
