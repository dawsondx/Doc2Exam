"""FastAPI 应用入口。

- `/api/health` 严格匹配规格 5.3;数据库不可查询或迁移未到 head 返回 503。
- 启动时把遗留 running 任务标记为 interrupted(规格 12.3)。
- 生产形态由本服务同源提供前端静态资源。
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import cast

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.types import ExceptionHandler

from app import config
from app.api import errors
from app.api.documents import router as documents_router
from app.api.estimates import router as estimates_router
from app.api.extraction import router as extraction_router
from app.api.generation import router as generation_router
from app.api.health import router as health_router
from app.api.jobs import router as jobs_router
from app.api.profiles import router as profiles_router
from app.api.quiz import router as quiz_router
from app.db.engine import get_session_factory

logger = logging.getLogger("ai_quiz")

FRONTEND_DIST = config.PROJECT_ROOT / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    config.setup_logging()
    config.ensure_dirs()
    _mark_interrupted_jobs()
    yield


def _mark_interrupted_jobs() -> None:
    """应用启动:遗留 queued/running 任务改为 interrupted(规格 12.3)。"""
    from app.models import Job, JobStatus

    session = get_session_factory()()
    try:
        rows = (
            session.query(Job)
            .filter(Job.status.in_([JobStatus.queued, JobStatus.running]))
            .all()
        )
        for job in rows:
            job.status = JobStatus.interrupted
            if not job.error_code:
                job.error_code = "JOB_INTERRUPTED"
        session.commit()
        if rows:
            logger.info("startup: %d 个遗留任务标记为 interrupted", len(rows))
    finally:
        session.close()


app = FastAPI(title=config.APP_NAME, version=config.__version__, lifespan=lifespan)

# 同源形态:开发时 Vite 代理 /api,无需跨源 CORS(规格 6.3/17.1)。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_exception_handler(
    errors.ApiError, cast(ExceptionHandler, errors.api_error_handler)
)
app.add_exception_handler(Exception, errors.unhandled_error_handler)

app.include_router(health_router)
app.include_router(documents_router)
app.include_router(jobs_router)
app.include_router(profiles_router)
app.include_router(extraction_router)
app.include_router(estimates_router)
app.include_router(generation_router)
app.include_router(quiz_router)

if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
