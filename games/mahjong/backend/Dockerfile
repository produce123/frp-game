# 莲花广麻 · 后端镜像
#
# 行为由环境变量决定（与本地运行一致，见 app/storage/db.py）：
#   - 设置了 PG_PASSWORD → 走 PostgreSQL（可再覆盖 PG_HOST/PG_PORT/PG_USER/PG_DATABASE）
#   - 未设置 → 回退 SQLite，数据落在 /app/data（docker-compose 挂 mahjong_data 卷持久化）
#
# 构建并启动：docker compose up --build
# 若直接使用 Docker CLI：
#   docker build -t lianhua-backend .
#   docker run --rm --env-file .env -p 8000:8000 -v mahjong_data:/app/data lianhua-backend
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 先拷依赖声明与源码，再 `pip install .`（PEP 517 构建 wheel，
# setuptools 配置见 pyproject.toml；storage/*.sql 作为 package-data 一并打包）
COPY pyproject.toml ./
COPY app ./app
RUN pip install -i https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple --no-cache-dir .

# 单 worker 即开发计划 §8 性能基准口径（瓶颈在 WS 连接数而非 CPU）
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
