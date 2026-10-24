"""日志配置 —— 接入 loguru 统一日志出口

职责：
- 拦截标准库 logging 记录（uvicorn / fastapi access、第三方库 warning）转发到 loguru
- 控制台 sink：TTY 自动着色，非 TTY（Docker / 管道重定向）自动关闭颜色
- 滚动文件 sink（env: LOG_DIR / LOG_ROTATION / LOG_RETENTION / LOG_TO_FILE / LOG_LEVEL）
- 格式统一：时间戳 | 级别 | 模块:函数:行号 | 消息 | 绑定字段(room_id / seat / request_id)
幂等：重复调用（测试多次导入 app.main / 多个 uvicorn server）不会重复添加 sink。
"""

import logging
import os
import re
import sys
from pathlib import Path

from loguru import logger

# 已配置标记：保证 setup 只执行一次（同进程内多个 uvicorn server 共用同一套 sink）
_CONFIGURED = False

# Uvicorn 的 WebSocket 握手日志包含完整查询串；重进码是座位凭据，任何日志出口
# 都只能保留参数名和掩码。兼容 REST 的 snake_case 与 JSON 风格 camelCase。
_REJOIN_CODE_PATTERN = re.compile(
    r'(rejoin_?code=)[^&\s"\']*',
    flags=re.IGNORECASE,
)

# OAuth 授权码、state、PKCE 和 token 都是凭据；不得进入任何日志出口。
_OAUTH_QUERY_SECRET_PATTERN = re.compile(
    r'((?:^|[?&\s])(?:code|state|code_verifier|code_challenge|access_token|'
    r'refresh_token|id_token)=)[^&\s"\']*',
    flags=re.IGNORECASE,
)
_BEARER_TOKEN_PATTERN = re.compile(
    r'(\bBearer\s+)[A-Za-z0-9._~+/=-]+',
    flags=re.IGNORECASE,
)


def redact_sensitive_data(message: str) -> str:
    """脱敏可能出现在 HTTP/WS 请求行或第三方异常中的凭据。"""
    message = _REJOIN_CODE_PATTERN.sub(r'\1***', message)
    message = _OAUTH_QUERY_SECRET_PATTERN.sub(r'\1***', message)
    return _BEARER_TOKEN_PATTERN.sub(r'\1***', message)


def _fmt(record: dict) -> str:
    """动态格式：有绑定字段时追加，异常记录附完整 traceback。"""
    base = ("{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | "
            "{name}:{function}:{line} | {message}")
    extras = record['extra']
    if extras:
        base += ' | ' + ' '.join(f'{k}={v}' for k, v in extras.items())
    if record['exception']:
        base += '\n{exception}'
    return base + '\n'


class InterceptHandler(logging.Handler):
    """把标准库 logging 记录转发到 loguru（调用位置取自原始调用者帧）。

    从 emit 自身向上回溯，跳过标准库 logging 内部帧（handle / callHandlers / ...），
    定位到第三方库或业务代码的真实调用位置（如 uvicorn/server.py）。
    """

    def emit(self, record: logging.LogRecord) -> None:
        try:
            level = logger.level(record.levelname).name
        except ValueError:
            level = record.levelno
        # loguru depth 从 .log() 的调用者（emit）起算（emit=0）；向上跳过 logging 内部帧。
        # 实测 depth=D 对应调用链第 D 帧：emit(0) → handle(1) → callHandlers(2) →
        # handle(3) → _log(4) → info(5) → 原始调用者(6)。
        frame = sys._getframe(0)
        depth = 0
        while frame is not None:
            frame = frame.f_back
            if frame is None:
                break
            depth += 1
            if frame.f_code.co_filename == logging.__file__:
                continue            # 继续向上找真实调用者
            break
        message = redact_sensitive_data(record.getMessage())
        logger.opt(depth=depth, exception=record.exc_info).log(level, message)


def _patch_uvicorn_loggers() -> None:
    """把 uvicorn 相关 logger 的 handler 换成 InterceptHandler（propagate=False 防重复）。

    必须在 uvicorn 应用默认 dictConfig 之后再调用一次（见 app.main 的 lifespan 启动钩子），
    否则 uvicorn 启动时会覆盖 import 阶段挂上的 handler。
    """
    for name in ('uvicorn', 'uvicorn.error', 'uvicorn.access'):
        lg = logging.getLogger(name)
        lg.handlers = [InterceptHandler()]
        lg.propagate = False
    # uvicorn.access 的请求日志由 HTTP 访问日志中间件替代（更丰富：耗时/request_id/参数），
    # 把默认 INFO 降为 WARNING，避免每个请求打两行重复日志。
    logging.getLogger('uvicorn.access').setLevel(logging.WARNING)


def configure_logging() -> None:
    """配置 loguru（幂等）。入口模块（app.main）导入时最先调用。"""
    global _CONFIGURED
    if _CONFIGURED:
        return
    _CONFIGURED = True

    level = os.environ.get('LOG_LEVEL', 'INFO').upper()
    logger.remove()  # 清掉默认 stderr sink，按需重建

    # 控制台：colorize=None 交给 loguru 自动检测（TTY 着色，非 TTY 无颜色）
    logger.add(
        sys.stderr,
        format=_fmt,
        level=level,
        colorize=None,
        backtrace=False,
        diagnose=False,
    )

    # 滚动文件：默认开启；测试 / CI 可用 LOG_TO_FILE=0 关闭。
    # 目录不可写（只读文件系统 / 权限）时降级为仅控制台，绝不崩进程。
    if os.environ.get('LOG_TO_FILE', '1') != '0':
        log_dir = os.environ.get('LOG_DIR', 'logs')
        rotation = os.environ.get('LOG_ROTATION', '10 MB')
        retention = os.environ.get('LOG_RETENTION', '30 days')
        try:
            Path(log_dir).mkdir(parents=True, exist_ok=True)
            logger.add(
                os.path.join(log_dir, 'app_{time}.log'),
                format=_fmt,
                level=level,
                rotation=rotation,
                retention=retention,
                encoding='utf-8',      # 中文消息在 Windows 上也正确落盘
                backtrace=False,
                diagnose=False,        # 诊断信息只进文件的话反而增加开销，保留最简
            )
        except OSError as exc:
            logger.warning('日志目录不可写，本次仅控制台输出: {} ({})', log_dir, exc)

    # 标准库 → loguru：根 logger 挂 InterceptHandler，第三方 warning 一并收拢
    logging.basicConfig(handlers=[InterceptHandler()], level=0, force=True)
    _patch_uvicorn_loggers()
