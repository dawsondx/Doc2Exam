"""通用 Job API:列表、详情、SSE 事件、恢复与取消(规格 13.3)。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel

from app.api.errors import ApiError
from app.db.engine import get_session_factory, to_iso
from app.models import Job, JobStatus, JobType
from app.schemas.common import ListEnvelope, normalize_paging, page_bounds
from app.services.jobs import events as job_events
from app.services.jobs import runner

router = APIRouter(prefix="/api/jobs", tags=["jobs"])

RECOVERABLE_STATUSES = {JobStatus.queued, JobStatus.running, JobStatus.interrupted}


def job_to_dto(job: Job) -> dict[str, Any]:
    return {
        "id": job.id,
        "job_type": job.job_type.value,
        "status": job.status.value,
        "document_id": job.document_id,
        "quiz_record_id": job.quiz_record_id,
        "ai_profile_id": job.ai_profile_id,
        "stage": job.stage,
        "current": job.current,
        "total": job.total,
        "error": (
            {"code": job.error_code, "message": job.error_message}
            if job.error_code
            else None
        ),
        "created_at": to_iso(job.created_at),
        "updated_at": to_iso(job.updated_at),
        "finished_at": to_iso(job.finished_at),
    }


@router.get("")
def list_jobs(
    job_type: str | None = None,
    status: str | None = None,
    resource_id: str | None = None,
    recoverable: bool | None = None,
    page: int | None = Query(None, ge=1),
    page_size: int | None = Query(None, ge=1),
) -> ListEnvelope[dict[str, Any]]:
    p, ps = normalize_paging(page, page_size)
    session = get_session_factory()()
    try:
        query = session.query(Job)
        if job_type:
            query = query.filter(Job.job_type == JobType(job_type))
        if status:
            query = query.filter(Job.status == JobStatus(status))
        if resource_id:
            query = query.filter(
                (Job.document_id == resource_id) | (Job.quiz_record_id == resource_id)
            )
        if recoverable:
            # 可继续处理:queued/running/interrupted,以及需进入 QuizRecord 补题的
            # Generation partial(规格 13.3);只有 interrupted 可调用 resume。
            query = query.filter(
                Job.status.in_(RECOVERABLE_STATUSES | {JobStatus.partial})
            )
        rows = query.order_by(Job.created_at.desc()).all()
        if recoverable:
            rows = [
                r for r in rows
                if r.status in RECOVERABLE_STATUSES
                or (r.status == JobStatus.partial and r.job_type == JobType.generation)
            ]
        start, end = page_bounds(p, ps, len(rows))
        return ListEnvelope(
            items=[job_to_dto(r) for r in rows[start:end]],
            total=len(rows),
            page=p,
            page_size=ps,
        )
    except ValueError as exc:
        raise ApiError(422, "INVALID_FILTER", "筛选参数不合法。", "检查筛选条件") from exc
    finally:
        session.close()


@router.get("/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        if job is None:
            raise ApiError(404, "JOB_NOT_FOUND", "任务不存在。", "返回任务列表")
        return job_to_dto(job)
    finally:
        session.close()


@router.get("/{job_id}/events")
async def job_events_endpoint(job_id: str, request: Request) -> Response:
    session = get_session_factory()()
    try:
        if session.get(Job, job_id) is None:
            raise ApiError(404, "JOB_NOT_FOUND", "任务不存在。", "返回任务列表")
    finally:
        session.close()
    return job_events.sse_response(job_id, request)


class ResumeBody(BaseModel):
    consent_id: str | None = None


@router.post("/{job_id}/resume", status_code=202)
def resume_job(job_id: str, body: ResumeBody | None = None) -> dict[str, Any]:
    if not runner.resume_allowed(job_id):
        raise ApiError(
            409, "JOB_NOT_RESUMABLE", "只有被中断的任务可以继续。", "返回任务列表"
        )
    # 具体恢复动作由各 Job 类型的服务层注册;此处统一分发。
    from app.services.jobs import resume_dispatcher

    result = resume_dispatcher.dispatch(job_id, consent_id=body.consent_id if body else None)
    return {"job_id": job_id, "status": result["status"]}


@router.post("/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        if job is None:
            raise ApiError(404, "JOB_NOT_FOUND", "任务不存在。", "返回任务列表")
    finally:
        session.close()
    return runner.request_cancel(job_id)
