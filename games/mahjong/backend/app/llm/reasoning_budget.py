"""按端点、模型和思考档位追踪近期 token，用于自适应预算与满额截断熔断。"""

from dataclasses import dataclass, field
import math
import time
from urllib.parse import urlparse

MAX_REASONING_TOKENS = 65_536
FINAL_RESPONSE_RESERVE = 96
MAX_SAMPLES = 32
MAX_LENGTH_FAILURES = 2
SUPPRESSION_S = 30 * 60


@dataclass
class _BudgetState:
    samples: list[int] = field(default_factory=list)
    next_floor: int = 0
    max_length_failures: int = 0
    suppressed_until: float = 0.0


_states: dict[tuple[str, str, str], _BudgetState] = {}


def _key(cfg, policy) -> tuple[str, str, str]:
    endpoint = (urlparse(cfg.base_url).hostname or cfg.base_url).lower().rstrip('/')
    effort = policy.request_body.get('reasoning_effort') \
        or repr(policy.request_body.get('thinking', 'thinking'))
    return endpoint, cfg.model.strip().lower(), str(effort)


def _state(cfg, policy) -> _BudgetState:
    return _states.setdefault(_key(cfg, policy), _BudgetState())


def _round_up(value: int) -> int:
    result = 128
    while result < value and result < MAX_REASONING_TOKENS:
        result *= 2
    return min(MAX_REASONING_TOKENS, result)


def adaptive_reasoning_budget(cfg, policy, initial_budget: int,
                              minimum_budget: int = 512) -> int:
    state = _state(cfg, policy)
    if not state.samples:
        return min(MAX_REASONING_TOKENS, max(minimum_budget, initial_budget))
    ordered = sorted(state.samples)
    index = max(0, math.ceil(len(ordered) * .99) - 1)
    observed = ordered[index] + FINAL_RESPONSE_RESERVE
    return _round_up(max(minimum_budget, observed, state.next_floor))


def record_reasoning_success(cfg, policy, reasoning_tokens: int) -> None:
    state = _state(cfg, policy)
    if reasoning_tokens > 0:
        state.samples.append(int(reasoning_tokens))
        del state.samples[:-MAX_SAMPLES]
    state.next_floor = 0
    state.max_length_failures = 0
    state.suppressed_until = 0.0


def record_reasoning_length(cfg, policy, attempted_budget: int,
                            reasoning_tokens: int = 0) -> None:
    state = _state(cfg, policy)
    observed = reasoning_tokens if reasoning_tokens > 0 else attempted_budget
    state.samples.append(min(MAX_REASONING_TOKENS, int(observed)))
    del state.samples[:-MAX_SAMPLES]
    state.next_floor = min(
        MAX_REASONING_TOKENS, max(state.next_floor, attempted_budget * 2))
    if attempted_budget >= MAX_REASONING_TOKENS:
        state.max_length_failures += 1
        if state.max_length_failures >= MAX_LENGTH_FAILURES:
            state.suppressed_until = time.monotonic() + SUPPRESSION_S


def is_reasoning_suppressed(cfg, policy) -> bool:
    state = _states.get(_key(cfg, policy))
    if state is None or state.suppressed_until <= 0:
        return False
    if state.suppressed_until <= time.monotonic():
        state.suppressed_until = 0.0
        state.max_length_failures = 0
        return False
    return True


def reset_reasoning_budget_for_tests() -> None:
    _states.clear()
