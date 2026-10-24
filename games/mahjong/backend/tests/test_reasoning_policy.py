import pytest

from app.llm.reasoning import (
    dashscope_thinking_body, infer_provider_dialect, infer_provider_type,
    is_dashscope_endpoint, resolve_reasoning_policy,
)


@pytest.mark.parametrize(('provider_type', 'model', 'expected'), [
    ('deepseek', 'deepseek-v4-flash', {'thinking': {'type': 'disabled'}}),
    ('qwen', 'qwen3.7-plus', {'enable_thinking': False}),
    ('kimi', 'kimi-k2.6', {'thinking': {'type': 'disabled'}, 'temperature': 0.6, 'top_p': 0.95}),
    ('doubao', 'doubao-1.5-thinking-pro', {'thinking': {'type': 'disabled'}}),
    ('openai', 'gpt-5.6', {'reasoning_effort': 'none'}),
    ('glm', 'glm-4.7-flash', {'thinking': {'type': 'disabled'}}),
])
def test_switchable_models_force_non_reasoning(provider_type, model, expected):
    result = resolve_reasoning_policy(provider_type, 'https://proxy.example.com/v1', model)
    assert result.mode == 'explicit-off'
    assert result.request_body == expected


@pytest.mark.parametrize(('provider_type', 'model'), [
    ('deepseek', 'deepseek-reasoner'), ('qwen', 'qwq-plus'),
    ('kimi', 'kimi-k2-thinking'), ('minimax', 'MiniMax-M2.7'),
    ('openai', 'o3-mini'), ('glm', 'glm-4.1v-thinking-flash'),
])
def test_reasoning_only_models_are_identified_without_request_precheck(provider_type, model):
    result = resolve_reasoning_policy(provider_type, 'https://proxy.example.com/v1', model)
    assert result.mode == 'reasoning-only'


def test_glm_5_3_flash_uses_official_and_orcarouter_dialects():
    official = resolve_reasoning_policy(
        'glm', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3-flash', reasoning=True)
    orca = resolve_reasoning_policy(
        'custom', 'https://api.orcarouter.ai/v1', 'z-ai/glm-5.3-flash', reasoning=True)
    relay = resolve_reasoning_policy(
        'custom', 'https://proxy.example.com/v1', 'z-ai/glm-5.3-flash', reasoning=True)
    assert official.mode == orca.mode == relay.mode == 'always-on'
    assert official.request_body == {'reasoning_effort': 'high'}
    assert orca.request_body == {'reasoning_effort': 'medium'}
    assert relay.request_body == {'reasoning_effort': 'low'}


def test_full_glm_5_3_official_uses_high_and_orcarouter_uses_medium():
    official = resolve_reasoning_policy(
        'glm', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', reasoning=True)
    orca = resolve_reasoning_policy(
        'glm', 'https://api.orcarouter.ai/v1', 'z-ai/glm-5.3', reasoning=True)
    assert official.mode == orca.mode == 'always-on'
    assert official.request_body == {'reasoning_effort': 'high'}
    assert orca.request_body == {'reasoning_effort': 'medium'}


def test_provider_dialect_inference():
    assert infer_provider_dialect('https://open.bigmodel.cn/api/paas/v4') == 'official'
    assert infer_provider_dialect('https://api.orcarouter.ai/v1') == 'orcarouter'
    assert infer_provider_dialect('https://proxy.example.com/v1') == 'compatible'


def test_kimi_k3_qualified_model_uses_effort_without_sampling_parameters():
    result = resolve_reasoning_policy(
        'kimi', 'https://api.orcarouter.ai/v1', 'kimi/kimi-k3')
    assert result.provider_type == 'kimi'
    assert result.mode == 'always-on'
    assert result.request_body == {'reasoning_effort': 'low'}
    assert resolve_reasoning_policy(
        'kimi', 'https://api.orcarouter.ai/v1', 'kimi/kimi-k3',
        reasoning=True).request_body == {'reasoning_effort': 'high'}


@pytest.mark.parametrize('model', ['kimi/kimi-k2.5', 'kimi/kimi-k2.6'])
def test_kimi_k2_switchable_qualified_models_keep_non_reasoning_parameters(model):
    result = resolve_reasoning_policy(
        'kimi', 'https://api.orcarouter.ai/v1', model)
    assert result.provider_type == 'kimi'
    assert result.mode == 'explicit-off'
    assert result.accept_reasoning_response
    assert result.request_body == {
        'thinking': {'type': 'disabled'}, 'temperature': 0.6, 'top_p': 0.95}
    enabled = resolve_reasoning_policy(
        'kimi', 'https://api.orcarouter.ai/v1', model, reasoning=True)
    assert enabled.mode == 'explicit-on'
    assert enabled.request_body == {
        'thinking': {'type': 'enabled'}, 'temperature': 1.0, 'top_p': 0.95}


def test_claude_sonnet_5_disables_default_thinking_then_enables_medium_adaptive():
    quick = resolve_reasoning_policy(
        'custom', 'https://api.orcarouter.ai/v1', 'anthropic/claude-sonnet-5')
    deep = resolve_reasoning_policy(
        'custom', 'https://api.orcarouter.ai/v1', 'anthropic/claude-sonnet-5',
        reasoning=True)
    assert quick.request_body == {'thinking': {'type': 'disabled'}}
    assert deep.request_body == {
        'thinking': {'type': 'adaptive', 'display': 'summarized'},
        'output_config': {'effort': 'medium'},
    }


def test_kimi_k2_base_alias_remains_naturally_non_reasoning():
    result = resolve_reasoning_policy(
        'kimi', 'https://proxy.example.com/v1', 'kimi/kimi-k2')
    assert result.mode == 'naturally-off'
    assert result.request_body == {}


@pytest.mark.parametrize(('provider_type', 'model', 'expected'), [
    ('deepseek', 'deepseek-v4-flash', {
        'thinking': {'type': 'enabled'}, 'reasoning_effort': 'medium'}),
    ('qwen', 'qwen3.8-flash', {'enable_thinking': True}),
    ('openai', 'gpt-5.6-sol', {'reasoning_effort': 'medium'}),
])
def test_conditional_reasoning_explicitly_enables_supported_models(
        provider_type, model, expected):
    result = resolve_reasoning_policy(
        provider_type, 'https://proxy.example.com/v1', model, reasoning=True)
    assert result.mode == 'explicit-on'
    assert result.request_body == expected


@pytest.mark.parametrize('model', [
    'qwen3-32b', 'qwen3-235b-a22b', 'qwen3-30b-a3b', 'qwen3-14b', 'qwen3-8b', 'qwen3-0.6b',
    'qwen3.8-27b', 'qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-35b-a3b', 'qwen3.5-flash',
    'qwen3-max', 'qwen3-max-preview', 'qwen3.7-max-preview', 'qwen-max', 'qwen-plus',
    'qwen-flash', 'qwen-turbo', 'qwen-plus-2025-04-28',
])
def test_thinking_by_default_qwen_models_force_enable_thinking_false(model):
    """型号名漏识别时不下发 enable_thinking=false，正文会全空（2026-09-16 实测 qwen3-32b）。

    qwen3.x 商业版（qwen3-max 等）文档上默认关闭，但混合开关同样归零风险，一并显式下发。
    """
    result = resolve_reasoning_policy(
        'qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', model)
    assert result.mode == 'explicit-off'
    assert result.request_body == {'enable_thinking': False}


@pytest.mark.parametrize('model', ['qwen3-32b', 'qwen3-235b-a22b', 'qwen3.8-27b', 'qwen-max', 'qwen3-max'])
def test_qwen_open_source_and_commercial_families_can_still_enable_thinking(model):
    result = resolve_reasoning_policy(
        'qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', model, reasoning=True)
    assert result.mode == 'explicit-on'
    assert result.request_body == {'enable_thinking': True}


@pytest.mark.parametrize('model', [
    'qwen3-coder-plus', 'qwen3-coder-480b-a35b', 'qwen3-vl-plus', 'qwen2.5-vl-72b',
    'qwen3-omni-flash',
])
def test_non_thinking_qwen_models_keep_plain_request(model):
    result = resolve_reasoning_policy('qwen', 'https://proxy.example.com/v1', model)
    assert result.mode == 'naturally-off'
    assert result.request_body == {}


@pytest.mark.parametrize('model', [
    'qwen3.8-2.4t-a95b', 'qwen3-235b-a22b-thinking-2507',
    'qwen3-next-80b-a3b-thinking', 'qwq-plus',
])
def test_thinking_only_qwen_models_are_identified(model):
    result = resolve_reasoning_policy('qwen', 'https://proxy.example.com/v1', model)
    assert result.mode == 'reasoning-only'
    assert result.request_body == {}


def test_dashscope_hosted_third_party_models_infer_by_model_name():
    """DashScope 也托管别家模型：型号名优先，避免被地址带成千问后下发无效参数。"""
    dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    assert infer_provider_type(dash, 'glm-4.7') == 'glm'
    assert infer_provider_type(dash, 'kimi-k2.6') == 'kimi'
    assert infer_provider_type(dash, 'deepseek-v4-flash') == 'deepseek'
    assert infer_provider_type(dash, 'qwen3-32b') == 'qwen'
    assert infer_provider_type(dash, 'some-new-model') == 'qwen'
    # token-plan 是百炼的另一个接入点，与 dashscope 同方言
    assert is_dashscope_endpoint(dash)
    assert is_dashscope_endpoint('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
    assert not is_dashscope_endpoint('https://open.bigmodel.cn/api/paas/v4')


def test_dashscope_endpoint_switches_native_thinking_params_to_enable_thinking():
    """实测 glm-4.7 在 DashScope 收 thinking:{type:disabled} 仍思考 2.8k 字、单次 25s。"""
    dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    quick = resolve_reasoning_policy('glm', dash, 'glm-4.7')
    deep = resolve_reasoning_policy('glm', dash, 'glm-4.7', reasoning=True)
    assert quick.mode == 'explicit-off' and deep.mode == 'explicit-on'
    assert dashscope_thinking_body(quick.mode) == {'enable_thinking': False}
    assert dashscope_thinking_body(deep.mode) == {'enable_thinking': True}
    # 原生端点保留各家方言
    native = resolve_reasoning_policy('glm', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4.7')
    assert native.request_body == {'thinking': {'type': 'disabled'}}


def test_legacy_provider_type_inference():
    assert infer_provider_type('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus') == 'qwen'
    assert infer_provider_type('https://proxy.local/v1', 'kimi-k2.6') == 'kimi'
    assert infer_provider_type('https://api.example.com/v1', 'mystery-model') == 'custom'
    # 能力矩阵外的千问老型号保持未知，不误报为可切换。
    assert resolve_reasoning_policy(
        'qwen', 'https://proxy.local/v1', 'qwen-long').mode == 'unknown'


@pytest.mark.parametrize('model', [
    'glm-4.5v', 'glm-4.6v', 'glm-4.6v-flash', 'glm-4.6v-flashx',
])
def test_dashscope_glm_vision_models_are_switchable(model):
    dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    quick = resolve_reasoning_policy('qwen', dash, model)
    deep = resolve_reasoning_policy('qwen', dash, model, reasoning=True)
    assert quick.provider_type == deep.provider_type == 'glm'
    assert quick.mode == 'explicit-off'
    assert deep.mode == 'explicit-on'
    assert dashscope_thinking_body(quick.mode) == {'enable_thinking': False}
    assert dashscope_thinking_body(deep.mode) == {'enable_thinking': True}


@pytest.mark.parametrize('model', [
    'glm-5', 'glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx',
])
def test_dashscope_glm_low_quick_high_conditional(model):
    dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    quick = resolve_reasoning_policy('qwen', dash, model)
    deep = resolve_reasoning_policy('qwen', dash, model, reasoning=True)
    assert quick.provider_type == deep.provider_type == 'glm'
    assert quick.request_body == {'reasoning_effort': 'low'}
    assert deep.request_body == {'reasoning_effort': 'high'}
    assert dashscope_thinking_body(quick.mode) == {'enable_thinking': True}


@pytest.mark.parametrize('model', ['deepseek-v4-flash-0731', 'deepseek-v4-pro-0813'])
def test_dashscope_deepseek_versions_support_low_and_high(model):
    dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    quick = resolve_reasoning_policy('qwen', dash, model)
    deep = resolve_reasoning_policy('qwen', dash, model, reasoning=True)
    assert quick.provider_type == deep.provider_type == 'deepseek'
    assert quick.mode == deep.mode == 'explicit-on'
    assert quick.request_body == {'reasoning_effort': 'low'}
    assert deep.request_body == {'reasoning_effort': 'high'}


def test_dashscope_thinking_only_models_avoid_unsupported_low_effort():
    dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    for model, provider, mode in [
        ('deepseek-r1', 'deepseek', 'reasoning-only'),
        ('kimi-k3', 'kimi', 'always-on'),
        ('kimi-k2.7-code', 'kimi', 'reasoning-only'),
        ('kimi-k2-thinking', 'kimi', 'reasoning-only'),
        ('Moonshot-Kimi-K2-Instruct', 'kimi', 'naturally-off'),
    ]:
        policy = resolve_reasoning_policy('qwen', dash, model)
        assert (policy.provider_type, policy.mode, policy.request_body) == (provider, mode, {})


def test_dashscope_workspace_and_token_plan_relay_are_detected():
    maas = 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
    relay = 'https://www.bestguo.top:58000/api/llm/relay/token-plan'
    assert is_dashscope_endpoint(maas)
    assert is_dashscope_endpoint(relay)
    assert infer_provider_dialect(maas) == 'official'


@pytest.mark.parametrize(('model', 'provider', 'mode'), [
    ('glm-5', 'glm', 'explicit-on'), ('glm-4.5-air', 'glm', 'explicit-off'),
    ('glm-5.1', 'glm', 'explicit-on'), ('glm-5.2', 'glm', 'explicit-on'),
    ('glm-5.3', 'glm', 'always-on'), ('glm-4.5', 'glm', 'explicit-off'),
    ('glm-4.6', 'glm', 'explicit-off'), ('glm-4.7', 'glm', 'explicit-off'),
    ('deepseek-r1-distill-qwen-7b', 'deepseek', 'reasoning-only'),
    ('deepseek-r1-distill-qwen-32b', 'deepseek', 'reasoning-only'),
    ('deepseek-v4-flash-0731', 'deepseek', 'explicit-on'),
    ('deepseek-r1', 'deepseek', 'reasoning-only'),
    ('deepseek-v4-pro', 'deepseek', 'explicit-off'),
    ('deepseek-r1-distill-qwen-14b', 'deepseek', 'reasoning-only'),
    ('deepseek-v4-pro-0813', 'deepseek', 'explicit-on'),
    ('deepseek-v3.1', 'deepseek', 'explicit-off'),
    ('deepseek-v3.2', 'deepseek', 'explicit-off'),
    ('deepseek-v4-flash', 'deepseek', 'explicit-off'),
    ('kimi-k2.5', 'kimi', 'explicit-off'),
    ('kimi-k2-thinking', 'kimi', 'reasoning-only'),
    ('kimi-k2.7-code', 'kimi', 'reasoning-only'),
    ('Moonshot-Kimi-K2-Instruct', 'kimi', 'naturally-off'),
    ('kimi-k3', 'kimi', 'always-on'),
    ('MiniMax-M2.5', 'minimax', 'reasoning-only'),
    ('MiniMax-M2.1', 'minimax', 'reasoning-only'),
])
def test_all_screenshot_models_are_classified(model, provider, mode):
    dash = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    policy = resolve_reasoning_policy('qwen', dash, model)
    assert (policy.provider_type, policy.mode) == (provider, mode)


@pytest.mark.parametrize('model', [
    'glm-4.5v', 'glm-4.6v', 'glm-4.6v-flash', 'glm-4.6v-flashx',
])
def test_glm_vision_official_endpoint_uses_native_toggle(model):
    quick = resolve_reasoning_policy('glm', 'https://api.z.ai/api/paas/v4', model)
    deep = resolve_reasoning_policy('glm', 'https://api.z.ai/api/paas/v4', model, reasoning=True)
    assert quick.request_body == {'thinking': {'type': 'disabled'}}
    assert deep.request_body == {'thinking': {'type': 'enabled'}}
