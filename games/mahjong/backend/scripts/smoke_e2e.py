"""端到端冒烟（Phase 8 验收）：生产构建前端 + 真实后端起完整东风场

对应开发计划 Phase 8「端到端冒烟：本地起后端，前端 vite preview 联调完整东风场」。
headless 版本：
1. 以 VITE_API_BASE=<backend_port> 构建前端生产包（临时 outDir，不污染 dist）
2. 后台线程起真实 uvicorn（backend_port，默认 8010）
3. 以 python http.server 临时服务前端产物（frontend_port，默认 4174）
4. 校验前端产物可访问（GET / 返回 app 根节点 + 引用 JS bundle）
5. 真实 WS 双客户端在后端完整打完一场东风场（创建 → join×2 → 准备 → 开局 → 结算 → 终局）
6. 打印 PASS / FAIL

不占用 8000 / 4173（用户本地 dev/preview 可能正在运行）。退出码 0 = 通过。

用法：
    cd backend
    PYTHONIOENCODING=utf-8 .venv/Scripts/python scripts/smoke_e2e.py
"""

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import quote

# 脚本位于 backend/scripts/ → backend/ 一级 → 仓库根
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_ROOT = os.path.dirname(BACKEND_DIR)
sys.path.insert(0, BACKEND_DIR)

import httpx
import uvicorn
import websockets
import websockets.asyncio.client

from app.main import app
from app.game.room import room_registry as rooms

BACKEND_PORT = int(os.environ.get('SMOKE_BACKEND_PORT', '8010'))
FRONTEND_PORT = int(os.environ.get('SMOKE_FRONTEND_PORT', '4174'))


# ─── 后端：后台线程 uvicorn ───────────────────────────────

def start_backend() -> None:
    config = uvicorn.Config(app, host='127.0.0.1', port=BACKEND_PORT, log_level='warning')
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not getattr(server, 'started', False):
        if time.time() > deadline:
            raise RuntimeError('uvicorn 启动超时')
        time.sleep(0.02)


# ─── 前端：构建到临时目录 + http.server 服务 ───────────────

def build_frontend(out_dir: str) -> None:
    env = dict(os.environ, VITE_API_BASE=f'http://127.0.0.1:{BACKEND_PORT}')
    result = subprocess.run(
        ['npx', 'vite', 'build', '--outDir', out_dir, '--emptyOutDir'],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace', shell=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f'前端构建失败:\n{result.stdout}\n{result.stderr}')


def serve_frontend(out_dir: str) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, '-m', 'http.server', str(FRONTEND_PORT), '--bind', '127.0.0.1', '-d', out_dir],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


# ─── WS 客户端：完整打完一场 ───────────────────────────────

async def auto_player(ws) -> None:
    """自动玩家：turn → 弃 0；claim/rob → pass；结算确认以 continue_prompt 为准；直到 match_finished。

    冒烟对局以快速节奏跑（REST 创建注入的 PLAY_PACE 在 play_full_match 中被提速），
    避免开局/结算屏障的长等待让 headless 客户端超时。真实节奏的容量验证见
    scripts/benchmark_rooms.py。
    """
    while True:
        raw = await asyncio.wait_for(ws.recv(), 10.0)
        msg = json.loads(raw)
        kind = msg.get('kind')
        if kind == 'turn_request':
            await ws.send(json.dumps({'type': 'discard', 'handIndex': 0}))
        elif kind in ('claim_request', 'rob_kong_request'):
            await ws.send(json.dumps({'type': 'pass'}))
        elif kind == 'continue_prompt':
            await ws.send(json.dumps({'type': 'continue'}))
        elif kind == 'match_finished':
            return msg   # 返回 match_finished 消息（含 finalScores）


async def play_full_match(base_http: str, base_ws: str) -> dict:
    """创建 → join×2 → 准备 → WS 连接 → 开局 → 打完一场，返回最终分数。"""
    async with httpx.AsyncClient(base_url=base_http) as http:
        resp = await http.post('/api/rooms', json={'mode': 'east', 'capacity': 2})
        assert resp.status_code == 200, resp.text
        rid = resp.json()['roomId']
        joins = []
        for name in ('甲', '乙'):
            j = (await http.post(f'/api/rooms/{rid}/join', json={'nickname': name})).json()
            joins.append(j)
            await http.post(f'/api/rooms/{rid}/ready',
                            json={'seat': j['seat'], 'rejoinCode': j['rejoinCode']})
        # REST 创建注入 PLAY_PACE；冒烟只验证 E2E 链路 → 提速跳过动画/确认屏障的长等待
        room = rooms.get(rid)
        if room is not None:
            room.pace = {}
        ws = [await websockets.asyncio.client.connect(
            f'{base_ws}/ws/room/{rid}?rejoin_code={quote(j["rejoinCode"])}') for j in joins]
        try:
            await http.post(f'/api/rooms/{rid}/start')
            results = await asyncio.wait_for(
                asyncio.gather(*(auto_player(w) for w in ws)), timeout=60)
            finals = [r['finalScores'] for r in results if r]
            return {'roomId': rid, 'finalScores': finals[0] if finals else None}
        finally:
            for w in ws:
                try:
                    await w.close()
                except Exception:
                    pass


# ─── 主流程 ───────────────────────────────────────────────

async def main() -> int:
    tmp = tempfile.mkdtemp(prefix='smoke-dist-')
    out_dir = os.path.join(tmp, 'dist')
    try:
        print(f'[1/5] 构建前端（VITE_API_BASE=http://127.0.0.1:{BACKEND_PORT}）→ {out_dir}')
        build_frontend(out_dir)
        print('[2/5] 启动后端 uvicorn :%d' % BACKEND_PORT)
        start_backend()
        base_http, base_ws = f'http://127.0.0.1:{BACKEND_PORT}', f'ws://127.0.0.1:{BACKEND_PORT}'
        print('[3/5] 启动前端静态服务 :%d' % FRONTEND_PORT)
        server = serve_frontend(out_dir)
        try:
            # 等后端就绪
            async with httpx.AsyncClient(base_url=base_http) as http:
                deadline = time.time() + 10
                while True:
                    try:
                        if (await http.get('/api/health')).json().get('status') == 'ok':
                            break
                    except Exception:
                        pass
                    if time.time() > deadline:
                        raise RuntimeError('后端健康检查超时')
                    await asyncio.sleep(0.1)

                # 校验前端产物可访问
                html = (await http.get(f'http://127.0.0.1:{FRONTEND_PORT}/')).text
                assert 'id="app"' in html, 'index.html 缺少 #app 根节点'
                import re
                bundle = re.search(r'<script[^>]+src="([^"]+)"', html)
                assert bundle, 'index.html 未引用 JS bundle'
                js_url = f'http://127.0.0.1:{FRONTEND_PORT}{bundle.group(1)}'
                js = (await http.get(js_url)).text
                assert f'127.0.0.1:{BACKEND_PORT}' in js, 'bundle 未嵌入 API_BASE'
                print('      前端产物 OK：index.html + JS bundle 正常，API_BASE 已指向后端')

            print('[4/5] 端到端对局：双 WS 客户端打完整东风场')
            result = await play_full_match(base_http, base_ws)
            assert result['finalScores'], '未收到 match_finished / finalScores'
            scores = result['finalScores']
            assert len(scores) == 4 and sum(s['score'] for s in scores) == 4000, '分数不守恒'
            print(f'      对局完成 room={result["roomId"]}  finalScores={[(s["name"], s["score"]) for s in scores]}')

            print('[5/5] 收尾')
            print('\n端到端冒烟通过：生产构建前端可访问 + 真实后端完整东风场无异常')
            return 0
        finally:
            server.terminate()
            server.wait(timeout=5)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception as exc:
        import traceback
        traceback.print_exc()
        print(f'\n端到端冒烟失败：{exc}')
        raise SystemExit(1)
