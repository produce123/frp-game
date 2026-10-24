"""OpenAI 兼容客户端 —— §7.2/§7.3/§10（异步 httpx，共享实例，总预算）。

仅语义错误（JSON 解析失败 / choice 不在白名单）允许一次反馈重试；
超时 / 网络 / HTTP 错误直接抛错（由调用方回退启发式）。
"""

import asyncio
import json
import re
import time
from typing import Callable, Optional

import httpx
from loguru import logger

from app.llm.config import LlmServerConfig, llm_semaphore
from app.llm.reasoning_budget import (
    adaptive_reasoning_budget, record_reasoning_length, record_reasoning_success,
)
from app.llm.reasoning import (
    dashscope_thinking_body, infer_provider_dialect, is_dashscope_endpoint,
    resolve_reasoning_policy,
)


class LlmClientError(Exception):
    KIND_HTTP = 'http'
    KIND_TIMEOUT = 'timeout'
    KIND_NETWORK = 'network'
    KIND_PARSE = 'parse'
    KIND_REASONING = 'reasoning'
    KIND_LENGTH = 'length'

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


# 共享 client：进程级单例，应用退出时显式关闭（§9.6）。
_shared: Optional[httpx.AsyncClient] = None


def get_llm_client() -> httpx.AsyncClient:
    global _shared
    if _shared is None:
        _shared = httpx.AsyncClient(timeout=httpx.Timeout(60.0), limits=httpx.Limits(max_connections=8))
    return _shared


async def close_llm_client() -> None:
    global _shared
    if _shared is not None:
        await _shared.aclose()
        _shared = None


def _is_anthropic(base_url: str) -> bool:
    return re.match(r'^https://api\.anthropic\.com', base_url.strip(), re.I) is not None


def _normalize_endpoint(base_url: str) -> Optional[str]:
    """规范化：拒绝 userinfo / 非 https（localhost 除外）；只能追加一次 /chat/completions。"""
    value = base_url.strip()
    if not value:
        return None
    if re.match(r'^[a-z][a-z0-9+.-]*://[^/@]*@', value, re.I):
        return None
    m = re.match(r'^(https?)://([^/]+)(/.*)?$', value)
    if not m:
        return None
    host = m.group(2).rsplit(':', 1)[0]  # 去掉端口再比对 localhost 白名单
    if host not in ('localhost', '127.0.0.1') and m.group(1) != 'https':
        return None
    trimmed = value.rstrip('/')
    return trimmed if trimmed.endswith('/chat/completions') else trimmed + '/chat/completions'


def extract_json_object(text: str) -> Optional[str]:
    """平衡括号扫描：必须跳过字符串字面量内的 { } 与转义（§7.2）。"""
    start = text.find('{')
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        ch = text[index]
        if in_string:
            if escaped:
                escaped = False
                continue
            if ch == '\\':
                escaped = True
                continue
            if ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return None


def _clean_message(text: str) -> str:
    import unicodedata
    cleaned = ''.join(ch for ch in text if not (unicodedata.category(ch).startswith('C')))
    return cleaned[:30].strip()


def parse_llm_output(raw: str, candidate_ids: list[str]) -> tuple[str, str]:
    """解析 LLM 回复 → (choice, message)；任意失败抛 parse 错误（触发一次语义重试）。"""
    text = (raw or '').strip()
    if not text:
        raise LlmClientError(LlmClientError.KIND_PARSE, '回复为空')
    text = re.sub(r'^```[a-zA-Z]*\s*', '', text)
    text = re.sub(r'```\s*$', '', text)
    obj = None
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            obj = parsed
    except ValueError:
        extracted = extract_json_object(text)
        if extracted is not None:
            try:
                parsed = json.loads(extracted)
                if isinstance(parsed, dict):
                    obj = parsed
            except ValueError:
                obj = None
    if not obj:
        raise LlmClientError(LlmClientError.KIND_PARSE, '未找到有效 JSON 对象')
    choice = obj.get('choice')
    if not isinstance(choice, str) or not choice:
        raise LlmClientError(LlmClientError.KIND_PARSE, 'choice 缺失或非字符串')
    if choice not in candidate_ids:
        raise LlmClientError(LlmClientError.KIND_PARSE, f'choice "{choice}" 不在合法候选列表')
    message = _clean_message(obj['message']) if isinstance(obj.get('message'), str) else ''
    return choice, message


def _has_reasoning_value(value) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    return isinstance(value, (dict, list)) and bool(value)


def _emit_reasoning_progress(callback: Optional[Callable[[], None]]) -> None:
    if callback is None:
        return
    try:
        callback()
    except Exception:
        pass


async def _read_sse_response(response: httpx.Response,
                             on_reasoning_progress: Optional[Callable[[], None]]):
    """读取 OpenAI 兼容 SSE；只发进度脉冲，不保留或暴露原始推理文本。"""
    content_parts: list[str] = []
    finish_reason = None
    usage: dict = {}
    saw_data = False
    saw_reasoning = False
    async for raw_line in response.aiter_lines():
        line = raw_line.strip()
        if not line or not line.startswith('data:'):
            continue
        data = line[5:].strip()
        if data == '[DONE]':
            break
        try:
            event = json.loads(data)
        except ValueError:
            continue
        saw_data = True
        if isinstance(event.get('usage'), dict):
            usage = event['usage']
        event_reasoning = _has_reasoning_value(event.get('reasoning'))
        choices = event.get('choices') or []
        if choices:
            choice = choices[0] or {}
            delta = choice.get('delta') or choice.get('message') or {}
            chunk = delta.get('content')
            if isinstance(chunk, str):
                content_parts.append(chunk)
            event_reasoning = event_reasoning or any(
                _has_reasoning_value(delta.get(key))
                for key in ('reasoning_content', 'reasoning', 'thinking')
            )
            if choice.get('finish_reason') is not None:
                finish_reason = choice.get('finish_reason')
        if event_reasoning:
            saw_reasoning = True
            _emit_reasoning_progress(on_reasoning_progress)
    if not saw_data:
        raise LlmClientError(LlmClientError.KIND_PARSE, 'API 流式响应没有有效数据')
    return ''.join(content_parts), finish_reason, usage, saw_reasoning


async def _call_once(cfg: LlmServerConfig, system: str, user: str,
                     budget_s: Optional[float], max_tokens: Optional[int] = None,
                     strict_length: bool = True, attempt_no: int = 1,
                     reasoning: bool = False,
                     on_reasoning_progress: Optional[Callable[[], None]] = None) -> str:
    endpoint = _normalize_endpoint(cfg.base_url)
    if endpoint is None:
        raise LlmClientError(LlmClientError.KIND_PARSE, 'baseUrl 非法（userinfo 或协议不支持）')
    headers = {
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {cfg.api_key}',
    }
    if _is_anthropic(cfg.base_url):
        headers['anthropic-dangerous-direct-browser-access'] = 'true'
    payload = {
        'model': cfg.model,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'temperature': 0.4,
        'top_p': 1,
        'stream': True,
        'n': 1,
    }
    reasoning_policy = resolve_reasoning_policy(
        getattr(cfg, 'provider_type', ''), cfg.base_url, cfg.model,
        getattr(cfg, 'provider_id', ''), reasoning=reasoning)
    always_thinking = reasoning_policy.mode in ('always-on', 'reasoning-only')
    model_name = (cfg.model or '').strip().lower().rsplit('/', 1)[-1]
    kimi_k3 = reasoning_policy.provider_type == 'kimi' \
        and re.match(r'^kimi-k3(?:[.-]|$)', model_name)
    kimi_k2_switchable = reasoning_policy.provider_type == 'kimi' \
        and re.match(r'^kimi-k2[.-](?:5|6)(?:[.-]|$)', model_name)
    glm_5_3_flash = reasoning_policy.provider_type == 'glm' \
        and re.match(r'^glm-5\.3-flashx?(?:[.-]|$)', model_name)
    dialect = infer_provider_dialect(cfg.base_url)
    if reasoning_policy.provider_type == 'claude' \
            and re.match(r'^claude-sonnet-5(?:[.-]|$)', model_name):
        payload.pop('temperature', None)
        payload.pop('top_p', None)
    if (kimi_k3 or (reasoning_policy.provider_type == 'kimi' and
                    re.match(r'^(?:kimi-k2[.-]7-code|kimi-k2-thinking)(?:[.-]|$)', model_name))
            or (reasoning_policy.provider_type == 'minimax' and
                re.match(r'^minimax-m(?:1|2)(?:[.-]|$)', model_name))):
        payload.pop('temperature', None)
        payload.pop('top_p', None)
    relay_kimi_thinking = reasoning and kimi_k2_switchable and dialect != 'official'
    orca_long_reasoning = reasoning and dialect == 'orcarouter' \
        and reasoning_policy.provider_type in ('deepseek', 'qwen', 'kimi')
    if reasoning:
        max_tokens = max_tokens or 512
        if orca_long_reasoning:
            max_tokens = max(max_tokens, 65536)
        elif relay_kimi_thinking:
            max_tokens = max(max_tokens, 2048)
        elif glm_5_3_flash:
            max_tokens = max(max_tokens, 1024)
        max_tokens = adaptive_reasoning_budget(cfg, reasoning_policy, max_tokens)
    payload.update(reasoning_policy.request_body)
    # DashScope 上别家模型（glm / kimi / deepseek…）的原生思考参数无效，统一改用 enable_thinking。
    if is_dashscope_endpoint(cfg.base_url):
        dashscope_body = dashscope_thinking_body(reasoning_policy.mode)
        if dashscope_body:
            payload.update(dashscope_body)
    if max_tokens is not None:
        if reasoning and reasoning_policy.provider_type == 'openai':
            payload['max_completion_tokens'] = max_tokens
        else:
            payload['max_tokens'] = max_tokens
    # DashScope 兼容模式：千问「JSON 模式 + 思考」同开时返回空正文
    # （finish=stop、content 与 reasoning_content 均为空），千问深思路径不带 response_format。
    qwen_deep_reasoning = reasoning and reasoning_policy.provider_type == 'qwen'
    if not qwen_deep_reasoning and (
            reasoning_policy.provider_type == 'qwen' or glm_5_3_flash or relay_kimi_thinking):
        payload['response_format'] = {'type': 'json_object'}
    client = get_llm_client()
    request_started = time.monotonic()
    try:
        async with llm_semaphore():
            async with client.stream(
                    'POST', endpoint, headers=headers, json=payload,
                    timeout=budget_s) as response:
                if response.status_code != 200:
                    detail = (await response.aread()).decode(errors='replace')[:200]
                    raise LlmClientError(
                        LlmClientError.KIND_HTTP,
                        f'HTTP {response.status_code}: {detail}')
                content_type = response.headers.get('content-type', '')
                if 'application/json' in content_type.lower():
                    await response.aread()
                    try:
                        body = response.json()
                    except ValueError as exc:
                        raise LlmClientError(
                            LlmClientError.KIND_PARSE, 'API 响应非 JSON') from exc
                    choices = body.get('choices') or []
                    if not choices:
                        raise LlmClientError(
                            LlmClientError.KIND_PARSE, 'API 响应格式无效或无内容')
                    first = choices[0]
                    message_obj = first.get('message') or {}
                    message = message_obj.get('content')
                    finish_reason = first.get('finish_reason')
                    usage = body.get('usage') if isinstance(body.get('usage'), dict) else {}
                    leaked_reasoning = any(
                        _has_reasoning_value(message_obj.get(key))
                        for key in ('reasoning_content', 'reasoning', 'thinking')
                    ) or _has_reasoning_value(body.get('reasoning'))
                    if leaked_reasoning:
                        _emit_reasoning_progress(on_reasoning_progress)
                else:
                    message, finish_reason, usage, leaked_reasoning = \
                        await _read_sse_response(response, on_reasoning_progress)
    except httpx.TimeoutException as exc:
        elapsed_ms = round((time.monotonic() - request_started) * 1000, 1)
        logger.bind(
            llm_provider=cfg.provider_id or 'default', llm_model=cfg.model,
            llm_attempt=attempt_no,
            llm_elapsed_ms=elapsed_ms,
            llm_error='timeout',
        ).warning(
            f'LLM 请求失败 provider={cfg.provider_id or "default"} model={cfg.model} '
            f'attempt={attempt_no} elapsed={elapsed_ms}ms kind=timeout')
        raise LlmClientError(LlmClientError.KIND_TIMEOUT, '请求超时') from exc
    except LlmClientError:
        raise
    except httpx.HTTPError as exc:
        elapsed_ms = round((time.monotonic() - request_started) * 1000, 1)
        logger.bind(
            llm_provider=cfg.provider_id or 'default', llm_model=cfg.model,
            llm_attempt=attempt_no,
            llm_elapsed_ms=elapsed_ms,
            llm_error='network',
        ).warning(
            f'LLM 请求失败 provider={cfg.provider_id or "default"} model={cfg.model} '
            f'attempt={attempt_no} elapsed={elapsed_ms}ms kind=network')
        raise LlmClientError(LlmClientError.KIND_NETWORK, f'网络错误: {exc}') from exc
    details = usage.get('completion_tokens_details') \
        if isinstance(usage.get('completion_tokens_details'), dict) else {}
    reasoning_tokens = details.get('reasoning_tokens')
    reasoning_token_count = int(reasoning_tokens) \
        if isinstance(reasoning_tokens, (int, float)) and reasoning_tokens > 0 else 0
    if finish_reason == 'length' and strict_length:
        if reasoning:
            record_reasoning_length(
                cfg, reasoning_policy, max_tokens, reasoning_token_count)
        raise LlmClientError(LlmClientError.KIND_LENGTH, 'finish_reason=length（输出被截断）')
    if not isinstance(message, str) or not message:
        raise LlmClientError(LlmClientError.KIND_PARSE, 'API 响应格式无效或无内容')
    leaked_reasoning = leaked_reasoning or isinstance(reasoning_tokens, (int, float)) and reasoning_tokens > 0
    if leaked_reasoning and not reasoning and not always_thinking \
            and not reasoning_policy.accept_reasoning_response:
        raise LlmClientError(
            LlmClientError.KIND_REASONING,
            '供应商仍返回思考内容，非思考模式验证失败')
    if reasoning:
        record_reasoning_success(cfg, reasoning_policy, reasoning_token_count)
    elapsed_ms = round((time.monotonic() - request_started) * 1000, 1)
    logger.bind(
        llm_provider=cfg.provider_id or 'default', llm_model=cfg.model,
        llm_attempt=attempt_no,
        llm_elapsed_ms=elapsed_ms,
        llm_finish_reason=finish_reason,
        llm_completion_tokens=usage.get('completion_tokens'),
        llm_reasoning_tokens=details.get('reasoning_tokens'),
    ).info(
        f'LLM 请求完成 provider={cfg.provider_id or "default"} model={cfg.model} '
        f'attempt={attempt_no} elapsed={elapsed_ms}ms '
        f'finish={finish_reason} '
        f'completionTokens={usage.get("completion_tokens")} '
        f'reasoningTokens={details.get("reasoning_tokens")}')
    return message


def _feedback_retry(user: str, error: str, legal_ids: list[str]) -> str:
    return user + '\n\n【上次你选错了】\n' + error + '\n' \
        + f'合法候选编号（只能从中选择）：{"、".join(legal_ids)}\n请重新输出一个合法编号。\n'


async def request_llm_decision(cfg: LlmServerConfig, system: str, user: str,
                               candidate_ids: list[str], reasoning: bool = False,
                               deadline_ms: Optional[int] = None,
                               on_reasoning_progress: Optional[Callable[[], None]] = None,
                               ) -> tuple[str, str]:
    """快速路径使用 cfg.timeout_s；条件深思使用独立 deadline_ms（均含语义重试）。"""
    started = time.monotonic()
    timeout_enabled = getattr(cfg, 'timeout_enabled', True)
    total_budget_s = (deadline_ms / 1000.0
                      if reasoning and deadline_ms is not None else cfg.timeout_s) \
        if timeout_enabled else float('inf')
    error_for_retry: Optional[str] = None

    async def attempt(messages_http_user: str) -> tuple[str, str]:
        left = total_budget_s - (time.monotonic() - started)
        if left <= 0:
            raise LlmClientError(LlmClientError.KIND_TIMEOUT, '总预算耗尽')
        request_timeout = left if timeout_enabled else None
        try:
            call = _call_once(
                cfg, system, messages_http_user, budget_s=request_timeout,
                max_tokens=512 if reasoning else None,
                attempt_no=2 if error_for_retry is not None else 1,
                reasoning=reasoning,
                on_reasoning_progress=on_reasoning_progress)
            raw = await asyncio.wait_for(call, timeout=left) \
                if timeout_enabled else await call
        except asyncio.TimeoutError as exc:
            raise LlmClientError(
                LlmClientError.KIND_TIMEOUT, '总预算耗尽') from exc
        try:
            return parse_llm_output(raw, candidate_ids)
        except LlmClientError as exc:
            if exc.kind == LlmClientError.KIND_PARSE and error_for_retry is None:
                pass  # 交给外层做一次语义重试
            raise

    try:
        return await attempt(user)
    except LlmClientError as exc:
        if exc.kind != LlmClientError.KIND_PARSE or error_for_retry is not None:
            raise
        error_for_retry = exc.args[0] if exc.args else '解析失败'
        logger.bind(
            llm_provider=cfg.provider_id or 'default', llm_model=cfg.model,
            llm_retry_reason=error_for_retry,
        ).info(
            f'LLM 语义重试 provider={cfg.provider_id or "default"} '
            f'model={cfg.model} reason={error_for_retry}')
        return await attempt(_feedback_retry(user, error_for_retry, candidate_ids))
