"""resume 分发:按 job_type 找到对应服务层的恢复实现。

各里程碑注册自己的恢复函数;未注册时返回明确错误,不留静默占位。
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from app.api.errors import ApiError
from app.models import JobType

ResumeFn = Callable[[str, str | None], dict[str, Any]]

_registry: dict[str, ResumeFn] = {}


def register(job_type: JobType, fn: ResumeFn) -> None:
    _registry[job_type.value] = fn


def dispatch(job_id: str, *, consent_id: str | None = None) -> dict[str, Any]:
    from app.db.engine import get_session_factory
    from app.models import Job

    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        if job is None:
            raise ApiError(404, "JOB_NOT_FOUND", "任务不存在。", "返回任务列表")
        job_type = job.job_type.value
    finally:
        session.close()

    fn = _registry.get(job_type)
    if fn is None:
        raise ApiError(
            409, "JOB_NOT_RESUMABLE", "该任务类型不支持继续。", "返回任务列表"
        )
    return fn(job_id, consent_id)
