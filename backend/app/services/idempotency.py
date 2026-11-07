"""幂等创建(规格 12.4)。

创建 Parse/Extraction/Generation Job、单题重生成、fill-missing 和导出必须携带
Idempotency-Key。同 key 同 request_hash 返回原响应;同 key 不同请求 409。
记录保留 24 小时,唯一约束兜底。
"""

from __future__ import annotations

import hashlib
import json
from datetime import timedelta
from typing import Any

from fastapi import Response
from fastapi.responses import JSONResponse

from app.api.errors import ApiError
from app.db.engine import get_session_factory, utcnow
from app.models import IdempotencyKey

RETENTION = timedelta(hours=24)


def _request_hash(body: object) -> str:
    canonical = json.dumps(body, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def check(method: str, path: str, key: str | None, body: object) -> Response | None:
    """请求前置检查:返回应重放的原响应,或 None 放行。"""
    if not key:
        raise ApiError(428, "IDEMPOTENCY_KEY_REQUIRED", "缺少操作标识。",
                       "刷新页面后重新操作")
    request_hash = _request_hash(body)
    session = get_session_factory()()
    try:
        _purge_expired(session)
        row = (
            session.query(IdempotencyKey)
            .filter(
                IdempotencyKey.method == method,
                IdempotencyKey.path == path,
                IdempotencyKey.key == key,
            )
            .one_or_none()
        )
        if row is None:
            return None
        if row.request_hash != request_hash:
            raise ApiError(409, "IDEMPOTENCY_KEY_REUSED",
                           "同一操作标识被用于不同请求。", "刷新页面后重新操作")
        import json as _json

        return JSONResponse(
            status_code=row.response_status,
            content=_json.loads(row.response_body),
        )
    finally:
        session.close()


def save(method: str, path: str, key: str, body: object,
         response_status: int, response_body: dict[str, Any]) -> None:
    session = get_session_factory()()
    try:
        _purge_expired(session)
        import json as _json

        row = (
            session.query(IdempotencyKey)
            .filter(
                IdempotencyKey.method == method,
                IdempotencyKey.path == path,
                IdempotencyKey.key == key,
            )
            .one_or_none()
        )
        if row is not None:
            return
        session.add(
            IdempotencyKey(
                method=method,
                path=path,
                key=key,
                request_hash=_request_hash(body),
                response_status=response_status,
                response_body=_json.dumps(response_body, ensure_ascii=False),
            )
        )
        session.commit()
    except Exception:
        session.rollback()
        # 唯一约束兜底:并发重复保存静默放弃。
    finally:
        session.close()


def _purge_expired(session) -> None:  # type: ignore[no-untyped-def]
    cutoff = utcnow() - RETENTION
    session.query(IdempotencyKey).filter(
        IdempotencyKey.created_at < cutoff
    ).delete(synchronize_session=False)
    session.commit()
