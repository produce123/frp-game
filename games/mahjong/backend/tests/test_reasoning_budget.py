from app.llm.config import LlmServerConfig
from app.llm.reasoning import resolve_reasoning_policy
from app.llm.reasoning_budget import (
    adaptive_reasoning_budget, is_reasoning_suppressed,
    record_reasoning_length, record_reasoning_success,
    reset_reasoning_budget_for_tests,
)


def config():
    return LlmServerConfig(
        enabled=True, base_url='https://api.orcarouter.ai/v1', api_key='sk',
        model='deepseek/deepseek-v4-flash', provider_type='deepseek')


def setup_function():
    reset_reasoning_budget_for_tests()


def test_success_uses_recent_p99_plus_final_reserve():
    cfg = config()
    policy = resolve_reasoning_policy(
        cfg.provider_type, cfg.base_url, cfg.model, reasoning=True)
    assert adaptive_reasoning_budget(cfg, policy, 65536) == 65536
    record_reasoning_success(cfg, policy, 1000)
    assert adaptive_reasoning_budget(cfg, policy, 65536) == 2048


def test_length_doubles_next_floor_up_to_maximum():
    cfg = config()
    policy = resolve_reasoning_policy(
        cfg.provider_type, cfg.base_url, cfg.model, reasoning=True)
    record_reasoning_length(cfg, policy, 2048, 2000)
    assert adaptive_reasoning_budget(cfg, policy, 512) == 4096
    record_reasoning_length(cfg, policy, 40000, 39900)
    assert adaptive_reasoning_budget(cfg, policy, 512) == 65536


def test_two_max_length_failures_temporarily_suppress_reasoning():
    cfg = config()
    policy = resolve_reasoning_policy(
        cfg.provider_type, cfg.base_url, cfg.model, reasoning=True)
    record_reasoning_length(cfg, policy, 65536, 65536)
    assert not is_reasoning_suppressed(cfg, policy)
    record_reasoning_length(cfg, policy, 65536, 65536)
    assert is_reasoning_suppressed(cfg, policy)
    record_reasoning_success(cfg, policy, 1000)
    assert not is_reasoning_suppressed(cfg, policy)
