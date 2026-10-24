from app.llm.speech_policy import LlmSpeechPolicy, compact_speech_text


def test_global_and_style_cooldowns_are_deterministic():
    current = [10.0]
    policy = LlmSpeechPolicy(lambda: current[0])
    assert policy.admit(1, '话痨') is True
    current[0] += 5.9
    assert policy.admit(2, '话痨') is False
    current[0] += 0.1
    assert policy.admit(2, '话痨') is True
    current[0] += 23.9
    assert policy.admit(1, '高冷') is False
    assert policy.admit(1, '高冷', 'important') is True


def test_normal_speech_is_deterministically_thinned_by_style():
    current = [10.0]
    policy = LlmSpeechPolicy(lambda: current[0])
    assert policy.admit(1, '稳健') is True
    current[0] += 16.0
    assert policy.admit(1, '稳健') is False
    assert policy.admit(1, '稳健') is False
    assert policy.admit(1, '稳健') is False
    assert policy.admit(1, '稳健') is True


def test_chatter_turn_speech_is_mandatory_without_consuming_normal_cooldown():
    policy = LlmSpeechPolicy(now=lambda: 10.0)
    assert policy.admit(1, '话痨', mandatory=True)
    assert policy.admit(1, '话痨', mandatory=True)
    assert policy.admit(1, '话痨', mandatory=True)
    assert policy.admit(2, '稳健')


def test_compact_speech_keeps_first_short_sentence():
    assert compact_speech_text('  先稳住这一手。后面不用念。 ') == '先稳住这一手。'
    assert len(compact_speech_text('这是一句明显超过十六个汉字的超长牌桌吐槽文本')) == 16


def test_compact_speech_drops_backstage_terms_and_internal_ids():
    assert compact_speech_text('跟引擎走，稳。') == ''
    assert compact_speech_text('候选A1最合适。') == ''
    assert compact_speech_text('AI建议这么打。') == ''
    assert compact_speech_text('wait一下，先看牌。') == 'wait一下，先看牌。'
    assert compact_speech_text('这张先打，稳住。') == '这张先打，稳住。'
