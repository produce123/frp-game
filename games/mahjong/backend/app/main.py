"""莲花广麻 · 联网麻将后端 — FastAPI 入口"""

# 日志最先配置：storage 等模块导入时即可输出（见 app/logging_config.py）
import asyncio
from contextlib import asynccontextmanager, suppress
import os
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from app.logging_config import (
    _patch_uvicorn_loggers,
    configure_logging,
    redact_sensitive_data,
)

configure_logging()

from app.api.rooms import router as rooms_router
from app.api.matches import router as matches_router
from app.api.moderation import router as moderation_router
from app.api.account import router as account_router
from app.api.auth import router as auth_router
from app.api.tts import router as tts_router
from app.api.local_tts import router as local_tts_router
from app.api.llm_relay import (
    close_relay_client,
    load_relay_upstreams,
    router as llm_relay_router,
)
from app.auth.wakudemo import WakuDemoOAuthConfig
from app.game.room import start_room_watchdog
from app.ws.game_ws import router as ws_router
from app.storage.db import storage
from app.tts.service import get_tts_service
from app.local_tts.service import get_local_tts_service

DOCS_SHOW = os.getenv('DOCS_SHOW', 'False') == 'True'
logger.info(f"api文档开启: {DOCS_SHOW}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # uvicorn 启动时用默认 dictConfig 覆盖了日志配置，这里重新接管 uvicorn 日志到 loguru
    _patch_uvicorn_loggers()
    tts = get_tts_service()
    local_tts = get_local_tts_service()
    providers = ','.join(tts.available_providers) or 'none'
    logger.info(
        f"TTS 服务 available={tts.available} providers={providers} "
        f"route={'->'.join(tts.config.provider_names)}")
    logger.info(
        f"单机 TTS 网关 available={local_tts.available} providers={providers}")
    # 无 CORS 的供应商（千问 Token Plan / Coding Plan 等）走自家透传通道：
    # 上游白名单在服务端，客户端只能传 id。
    logger.info(
        f"单机 LLM 透传网关 upstreams={','.join(load_relay_upstreams()) or 'none'}")
    # 常驻看门狗：收尾僵尸/卡死对局（对局中的房间对 TTL 豁免，只能靠它兜底）。
    # ROOM_WATCHDOG_INTERVAL<=0 时返回 None = 关闭。
    watchdog = start_room_watchdog()
    yield
    # 先停看门狗再关下游服务：它正在广播收尾消息 / 落库，不能与停机交错。
    if watchdog is not None:
        watchdog.cancel()
        with suppress(asyncio.CancelledError):
            await watchdog
    await tts.close()
    await local_tts.close()
    await close_relay_client()


app = FastAPI(title="莲花广麻 Backend", version="0.2.0",
              docs_url="/docs" if DOCS_SHOW else None, lifespan=lifespan)

# 开发期跨域：Vite dev server (:4173) → 后端 REST。生产同源部署时由网关收窄。
# 注意：allow_origins 为精确匹配（浏览器 Origin 头不含路径也不带尾斜杠）；
# vibehub 部署在平台域名下的任意子域，用 allow_origin_regex 覆盖，避免换域名/子域后失效。
# 2026-09-14：平台域名从 *.lumigrav.space 迁到 gamesvibe.app（用户决定**旧域名彻底弃用**）；
# 此前只认旧域名，让大模型主题的 TTS（浏览器 → 网关 /api/local-tts/synthesize）被 CORS 拦掉、
# 静默没有语音。现在只放行新域名。
_cors_origins = [
    'https://lianhuaguangdongmahjong.guoguo-labs.online',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
    # e2e 冒烟用独立前端端口（避免与正在运行的 dev :4173 冲突）
    'http://localhost:4174',
    'http://127.0.0.1:4174',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
]
_wakudemo_frontend_origin = WakuDemoOAuthConfig.from_env().frontend_origin
if _wakudemo_frontend_origin and _wakudemo_frontend_origin not in _cors_origins:
    _cors_origins.append(_wakudemo_frontend_origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=(
        r'^(?:https://([\w-]+\.)*gamesvibe\.app'
        r'|http://(?:localhost|127\.0\.0\.1):\d+)$'
    ),
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


def _redact_query(query: str) -> str:
    """query 中 rejoin_code 为座位凭据，落日志时打码，避免凭据泄漏进日志文件。"""
    return redact_sensitive_data(query)


@app.middleware('http')
async def access_log_middleware(request: Request, call_next):
    """HTTP 访问日志：方法 / 路径 / 状态 / 耗时 / 来源 IP / request_id。"""
    start = time.perf_counter()
    request_id = uuid.uuid4().hex[:12]
    # 上下文变量：随 async 任务传播，sync 路由跑在线程池时 anyio 也会拷贝上下文
    with logger.contextualize(request_id=request_id):
        client_ip = request.client.host if request.client else '-'
        # HTTP query 先脱敏；Uvicorn 的 WS 请求行由 InterceptHandler 统一脱敏。
        query = _redact_query(request.url.query)
        try:
            response = await call_next(request)
        except Exception:
            duration_ms = (time.perf_counter() - start) * 1000
            logger.exception(
                f"HTTP 未处理异常 {request.method} {request.url.path} "
                f"状态=500 耗时={duration_ms:.1f}ms 来源={client_ip} 参数={query}")
            raise
        duration_ms = (time.perf_counter() - start) * 1000
        log = logger.debug if request.url.path == '/api/health' else logger.info
        log(
            f"HTTP {request.method} {request.url.path} 状态={response.status_code} "
            f"耗时={duration_ms:.1f}ms 来源={client_ip} 参数={query}")
        return response


# 启动即按已配置的存储后端建表（幂等）
storage.init()

app.include_router(rooms_router)
app.include_router(matches_router)
app.include_router(moderation_router)
app.include_router(account_router)
app.include_router(auth_router)
app.include_router(tts_router)
app.include_router(local_tts_router)
app.include_router(llm_relay_router)
app.include_router(ws_router)


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}
