"""供应商/模型思考能力矩阵：为已知型号追加最佳努力的请求参数。"""

import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

PROVIDER_TYPES = (
    'deepseek', 'qwen', 'kimi', 'doubao', 'minimax', 'openai', 'glm', 'claude', 'custom',
)

# 支持 enable_thinking 的千问型号（QWEN_PREFIX 吸收 `qwen/`、`dashscope/` 等供应商前缀，`^` 只锚定一次）：
# - `[.-]\d`：dot 命名与破折号尺寸（qwen3.7-plus / qwen3.8-27b / qwen3-32b / qwen3-30b-a3b）；
# - `-(?:max|plus|flash|turbo)`：连字符名字版本（qwen3-max / qwen3-max-preview）；
# - 商业系列别名（qwen-max / qwen-plus / qwen-flash / qwen-turbo）。
# 不匹配 qwen2.5-*、qwen-long、qwen350、qwen3-coder-*、qwen3-vl-* 这类已知或不认识的命名。
# 千问型号名前缀：吸收 `qwen/`、`dashscope/` 等供应商前缀，只匹配一次 `^`。
QWEN_PREFIX = r'^(?:[a-z0-9_.-]+/)*qwen-?3?'
QWEN_THINKING_TOGGLE = re.compile(
    rf'{QWEN_PREFIX}(?:[.-]\d|-(?:max|plus|flash|turbo)|$)')
# 纯思考型号：qwq、显式 thinking 变体，以及只发思考版的超大 MoE 版
# （qwen3.8-2.4t-a95b）。`-preview` 命名语义不明，仍按可切换型号显式关闭思考。
QWEN_THINKING_ONLY = re.compile(
    rf'^(?:[a-z0-9_.-]+/)*(?:qwq|qwen-?3?.*(?:thinking|reasoner)'
    rf'|qwen-?3\.\d+-[a-z0-9.]+t-a\d+b$)')


@dataclass(frozen=True)
class ReasoningPolicy:
    provider_type: str
    mode: str
    message: str
    request_body: dict = field(default_factory=dict)
    accept_reasoning_response: bool = False

# 型号名里的厂商指纹优先于地址指纹：DashScope/百炼这类聚合端点也托管别家模型
# （`glm-4.7`、`kimi-k2.6`、`deepseek-v4-flash` 等），只看地址会把它们误判成千问，
# 进而下发千问专属参数、关闭思考失效（实测 glm-4.7 因此每次都思考 2.8k 字、单次 25s）。
# 地址兜底仍保留：`dashscope|aliyuncs|qwen` 继续把纯千问接入点判成 qwen。
MODEL_PROVIDER_RULES = (
    (re.compile(r'deepseek'), 'deepseek'),
    (re.compile(r'qwen|qwq'), 'qwen'),
    (re.compile(r'moonshot|kimi'), 'kimi'),
    (re.compile(r'volces|volcengine|doubao'), 'doubao'),
    (re.compile(r'minimax'), 'minimax'),
    (re.compile(r'api\.openai\.com|\bgpt-|\bo[134](?:[.-]|\s|$)'), 'openai'),
    (re.compile(r'bigmodel|\bglm-'), 'glm'),
    (re.compile(r'anthropic|\bclaude'), 'claude'),
)


def provider_type_from_model(model: str) -> str | None:
    """A known model vendor wins over a saved aggregator preset type."""
    model_name = (model or '').lower()
    for pattern, provider_type in MODEL_PROVIDER_RULES:
        if pattern.search(model_name):
            return provider_type
    return None


def infer_provider_type(base_url: str, model: str, provider_id: str = '') -> str:
    model_name = (model or '').lower()
    from_model = provider_type_from_model(model_name)
    if from_model:
        return from_model
    source = f'{base_url} {model_name} {provider_id}'.lower()
    if re.search(r'dashscope|\.maas\.aliyuncs|qwen|qwq', source):
        return 'qwen'
    return 'custom'


def infer_provider_dialect(base_url: str) -> str:
    """官方、OrcaRouter 与未知兼容中转必须使用各自参数方言。"""
    host = (urlparse(base_url).hostname or '').lower()
    if host == 'api.orcarouter.ai':
        return 'orcarouter'
    if is_dashscope_endpoint(base_url):
        return 'official'
    if re.match(
            r'^(?:api\.deepseek\.com|dashscope\.aliyuncs\.com|'
            r'token-plan\.cn-beijing\.maas\.aliyuncs\.com|api\.moonshot\.(?:cn|ai)|'
            r'ark\.[^.]+\.volces\.com|api\.minimax\.(?:chat|io)|api\.openai\.com|'
            r'open\.bigmodel\.cn|api\.z\.ai|api\.anthropic\.com)$', host):
        return 'official'
    return 'compatible'


def is_dashscope_endpoint(base_url: str) -> bool:
    """DashScope、百炼业务空间和本项目的 token-plan 透传入口。"""
    url = urlparse(base_url)
    host = (url.hostname or '').lower()
    return bool(re.search(r'(?:^|\.)dashscope\.aliyuncs\.com$', host)
                or (re.search(r'(?:^|\.)maas\.aliyuncs\.com$', host)
                    and '/compatible-mode/' in url.path)
                or url.path.startswith('/api/llm/relay/token-plan'))


def dashscope_thinking_body(mode: str) -> dict | None:
    """DashScope 上开关思考的统一参数是 enable_thinking；各家原生参数在这里实测无效
    （glm-4.7 收到 thinking:{type:disabled} 仍思考 2.8k 字、单次 25s，换 enable_thinking:false 后 0.8s）。"""
    if mode == 'explicit-off':
        return {'enable_thinking': False}
    if mode in ('explicit-on', 'always-on'):
        return {'enable_thinking': True}
    return None


def _policy(provider_type: str, mode: str, message: str,
            request_body: dict | None = None,
            accept_reasoning_response: bool = False) -> ReasoningPolicy:
    return ReasoningPolicy(
        provider_type, mode, message, request_body or {}, accept_reasoning_response)


def resolve_reasoning_policy(provider_type: str, base_url: str, model: str,
                             provider_id: str = '', reasoning: bool = False) -> ReasoningPolicy:
    inferred_kind = infer_provider_type(base_url, model, provider_id)
    # 百炼预置换成其它厂商型号时，型号的厂商指纹优先于预置类型。
    kind = provider_type_from_model(model) or (
        inferred_kind if provider_type not in PROVIDER_TYPES or provider_type == 'custom'
        else provider_type)
    qualified_name = (model or '').strip().lower()
    name = qualified_name.rsplit('/', 1)[-1]
    dialect = infer_provider_dialect(base_url)
    dashscope = is_dashscope_endpoint(base_url)

    if kind == 'deepseek':
        if re.search(r'reasoner|(^|[-_.])r1(?:[-_.]|$)', name):
            return _policy(kind, 'reasoning-only', 'DeepSeek Reasoner/R1 无法保证关闭思考')
        # 百炼仅这两个 V4 固定版本支持 low；其它混合型号普通出牌保持非思考。
        if dashscope and re.match(r'^deepseek-v4-(?:flash-0731|pro-0813)$', name):
            return _policy(kind, 'explicit-on', '已开启 DeepSeek 思考并按场景调整强度', {
                'reasoning_effort': 'high' if reasoning else 'low',
            }, accept_reasoning_response=True)
        if reasoning:
            body = ({'reasoning_effort': 'high'}
                    if re.match(r'^deepseek-v4-(?:flash|pro)(?:[.-]|$)', name) else {}) \
                if dashscope else {'thinking': {'type': 'enabled'}, 'reasoning_effort': 'medium'}
            return _policy(kind, 'explicit-on', '已开启 DeepSeek 条件思考', body)
        return _policy(kind, 'explicit-off', '已强制关闭 DeepSeek 思考模式',
                       {} if dashscope else {'thinking': {'type': 'disabled'}})
    if kind == 'qwen':
        # 型号名漏识别 = 不下发 enable_thinking=false = 默认思考的型号只出思考、content 全空（qwen3-32b 实测）。
        if QWEN_THINKING_ONLY.match(name):
            return _policy(kind, 'reasoning-only', '该千问型号属于推理专用模型')
        # 千问 3 开源尺寸默认开启思考（qwen3-32b / qwen3-235b-a22b / qwen3.8-27b …），必须显式关闭；
        # 商业版 qwen3.x 与 qwen-max/plus/flash/turbo 系列的混合思考同样用 enable_thinking 控制。
        if QWEN_THINKING_TOGGLE.match(name):
            return _policy(kind, 'explicit-on', '已开启千问条件思考', {
                'enable_thinking': True,
            }) if reasoning else _policy(
                kind, 'explicit-off', '已强制关闭千问思考模式',
                {'enable_thinking': False})
        # qwen3-coder 与 VL/Omni 多模态不走麻将决策的思考开关，不附加供应商参数。
        if re.match(r'^qwen.*(?:coder|vl|omni)', name):
            return _policy(kind, 'naturally-off', '该千问型号按普通模型调用，不附加思考参数')
        return _policy(kind, 'unknown', '无法确认该千问型号是否支持非思考模式')
    if kind == 'kimi':
        if re.match(r'^kimi-k3(?:[.-]|$)', name):
            # 百炼 K3 只接受 max；不能传其它端点的 low/high 方言。
            return _policy(kind, 'always-on',
                           '百炼 Kimi K3 始终思考且仅支持 max，无法调低强度'
                           if dashscope else 'Kimi K3 始终思考',
                           {} if dashscope else {
                'reasoning_effort': 'high' if reasoning else 'low',
            })
        if re.match(r'^kimi-k2[.-]7-code(?:[.-]|$)', name) or 'thinking' in name:
            return _policy(kind, 'reasoning-only', '该 Kimi 型号始终思考，等待最终回复后解析动作')
        if re.match(r'^kimi-k2[.-](?:5|6)(?:[.-]|$)', name):
            return _policy(kind, 'explicit-on', '已开启 Kimi K2.5/K2.6 条件思考', {
                **({} if dashscope else {'thinking': {'type': 'enabled'}}),
                'temperature': 1.0, 'top_p': 0.95,
            }) if reasoning else _policy(
                kind, 'explicit-off', '已强制关闭 Kimi 思考模式', {
                    **({} if dashscope else {'thinking': {'type': 'disabled'}}),
                    'temperature': 0.6, 'top_p': 0.95,
                }, accept_reasoning_response=True)
        if re.match(r'^(?:kimi-k2|moonshot-v1|moonshot-kimi-k2-instruct)', name):
            return _policy(kind, 'naturally-off', '该 Kimi 型号本身不输出思考链')
        return _policy(kind, 'unknown', '无法确认该 Kimi 型号是否支持非思考模式')
    if kind == 'doubao':
        if 'thinking' in name:
            return _policy(kind, 'explicit-off', '已强制关闭豆包思考模式',
                           {'thinking': {'type': 'disabled'}})
        if re.match(r'^doubao', name):
            return _policy(kind, 'naturally-off', '该豆包型号按非思考模型调用')
        return _policy(kind, 'unknown', '无法确认该豆包接入点是否支持非思考模式')
    if kind == 'minimax':
        if dashscope and re.match(r'^minimax-m2\.(?:1|5)(?:[.-]|$)', name):
            return _policy(kind, 'reasoning-only', '百炼 MiniMax M2.1/M2.5 仅思考，未提供 low 强度档')
        if re.match(r'^minimax-m(?:1|2)(?:[.-]|$)', name):
            return _policy(kind, 'reasoning-only', 'MiniMax M1/M2 系列没有可靠关闭开关')
        if re.match(r'^minimax-(?:text|01)', name):
            return _policy(kind, 'naturally-off', '该 MiniMax 型号本身不输出思考链')
        return _policy(kind, 'unknown', '无法确认该 MiniMax 型号是否支持非思考模式')
    if kind == 'openai':
        if re.match(r'^o(?:1|3|4)(?:[.-]|$)', name):
            return _policy(kind, 'reasoning-only', 'OpenAI o 系列属于推理模型')
        if re.match(r'^gpt-5(?:[.-]|$)', name):
            return _policy(kind, 'explicit-on', '已开启 GPT 条件思考', {
                'reasoning_effort': 'medium',
            }) if reasoning else _policy(
                kind, 'explicit-off', '已将 GPT 推理强度设为 none',
                {'reasoning_effort': 'none'})
        if re.match(r'^(?:gpt-4|gpt-3\.5)', name):
            return _policy(kind, 'naturally-off', '该 GPT 型号本身不是推理模型')
        return _policy(kind, 'unknown', '无法确认该 OpenAI 型号是否能关闭推理')
    if kind == 'glm':
        if 'thinking' in name:
            return _policy(kind, 'reasoning-only', '显式 Thinking 型号始终思考，等待最终回复后解析动作')
        if re.match(r'^glm-5\.3-flashx?(?:[.-]|$)', name):
            effort = ('high' if dialect == 'official' else
                      'medium' if dialect == 'orcarouter' else 'low') \
                if reasoning else 'low'
            return _policy(kind, 'always-on', 'GLM-5.3 Flash 系列始终思考', {
                'reasoning_effort': effort,
            })
        if re.match(r'^glm-5\.3(?:[.-]|$)', name):
            effort = ('high' if dialect == 'official' else
                      'medium' if dialect == 'orcarouter' else 'low') \
                if reasoning else 'low'
            return _policy(kind, 'always-on', 'GLM-5.3 始终思考', {
                'reasoning_effort': effort,
            })
        if dashscope and re.match(r'^glm-5(?:\.(?:1|2))?(?:[.-]|$)', name):
            return _policy(kind, 'explicit-on', '百炼 GLM 默认低强度思考，疑难时提高强度', {
                'reasoning_effort': 'high' if reasoning else 'low',
            }, accept_reasoning_response=True)
        if re.match(r'^glm-(?:4\.(?:5|6|7)v?|5)(?:[.-]|$)', name):
            # GLM-4.5V/4.6V 与文本版一样支持切换；无 low 档时普通出牌保持快速模式。
            return _policy(kind, 'explicit-on', '已开启 GLM 条件思考',
                           {} if dashscope else {'thinking': {'type': 'enabled'}}) \
                if reasoning else _policy(kind, 'explicit-off', '已强制关闭 GLM 思考模式',
                                          {} if dashscope else {'thinking': {'type': 'disabled'}})
        if re.match(r'^glm-4(?:[.-]|$)', name):
            return _policy(kind, 'naturally-off', '该 GLM 型号本身不是思考模型')
        return _policy(kind, 'unknown', '无法确认该 GLM 型号是否支持非思考模式')
    if kind == 'claude':
        if re.match(r'^claude-sonnet-5(?:[.-]|$)', name):
            return _policy(kind, 'explicit-on', '已开启 Claude Sonnet 5 自适应思考', {
                'thinking': {'type': 'adaptive', 'display': 'summarized'},
                'output_config': {'effort': 'medium'},
            }) if reasoning else _policy(
                kind, 'explicit-off', '已关闭 Claude Sonnet 5 自适应思考', {
                    'thinking': {'type': 'disabled'},
                })
        return _policy(kind, 'naturally-off', 'Claude 扩展思考未显式开启')
    return _policy(kind, 'unknown', '自定义 OpenAI 兼容协议按用户配置直接请求')
