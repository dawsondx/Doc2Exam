"""健康检查(规格 5.3)。

200 响应固定为:
{"status":"ok","app":"AI出题精灵","version":"1.1.0","database":"ok"}

数据库不可查询或迁移未到 head 时返回 503 + DATABASE_UNAVAILABLE,绝不返回 status=ok。
"""

from __future__ import annotations

import os

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app import config
from app.api.errors import error_body
from app.db.engine import get_engine

router = APIRouter(prefix="/api", tags=["health"])


def _latest_revision() -> str | None:
    """读取 alembic_version 当前值;表不存在时返回 None。"""
    with get_engine().connect() as conn:
        if not conn.dialect.has_table(conn, "alembic_version"):
            return None
        return conn.execute(text("SELECT version_num FROM alembic_version")).scalar()


def _head_revision() -> str | None:
    """读取 Alembic 脚本目录的最新 head。"""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    ini = config.BACKEND_DIR / "alembic.ini"
    if not ini.exists():
        return None
    alembic_cfg = Config(str(ini))
    script = ScriptDirectory.from_config(alembic_cfg)
    return script.get_current_head()


@router.get("/health")
def health() -> JSONResponse:
    database = "ok"
    try:
        with get_engine().connect() as conn:
            conn.execute(text("SELECT 1"))
        current = _latest_revision()
        head = _head_revision()
        if current is None or head is None or current != head:
            database = "mismatch"
    except Exception:
        database = "unavailable"

    if database != "ok":
        return JSONResponse(status_code=503, content=error_body("DATABASE_UNAVAILABLE"))

    return JSONResponse(
        content={
            "status": "ok",
            "app": config.APP_NAME,
            "version": config.__version__,
            "database": "ok",
        },
        headers={
            "X-AI-Quiz-Mock": (
                "1" if os.environ.get("AI_QUIZ_MOCK_AI", "").strip()
                not in ("", "0", "false", "False") else "0"
            )
        },
    )
