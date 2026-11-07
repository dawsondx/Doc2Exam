"""考点任务与考点选择 API(规格 13.3)。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Query, Response
from pydantic import BaseModel, Field

from app.api.errors import ApiError
from app.api.jobs import job_to_dto
from app.db.engine import get_session_factory, to_iso
from app.models import Job, KnowledgePoint, SourceBlock
from app.schemas.common import ListEnvelope, normalize_paging, page_bounds
from app.services import idempotency
from app.services.extraction_job import (
    create_extraction_job,
)
from app.services.extraction_job import (
    run as run_extraction_job,
)
from app.services.jobs import runner as job_runner

router = APIRouter(tags=["extraction"])


class ExtractionCreate(BaseModel):
    document_ids: list[str] = Field(min_length=1)
    ai_profile_id: str
    consent_id: str
    target_question_count: int = Field(ge=1, le=200)


@router.post("/api/extraction-jobs", status_code=202, response_model=None)
def create_extraction(
    body: ExtractionCreate,
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict[str, Any] | Response:
    replay = idempotency.check("POST", "/api/extraction-jobs", idempotency_key,
                               body.model_dump())
    if replay is not None:
        return replay
    try:
        job_id = create_extraction_job(
            document_ids=body.document_ids,
            ai_profile_id=body.ai_profile_id,
            consent_id=body.consent_id,
            target_question_count=body.target_question_count,
        )
    except ApiError as exc:
        from app.api.errors import error_body

        body_out = error_body(exc.code)
        idempotency.save("POST", "/api/extraction-jobs", idempotency_key or "",
                         body.model_dump(), exc.status_code, body_out)
        raise
    job_runner.submit(job_id, lambda: run_extraction_job(job_id))
    response = {"job_id": job_id, "status": "queued"}
    idempotency.save("POST", "/api/extraction-jobs", idempotency_key or "",
                     body.model_dump(), 202, response)
    return response


@router.get("/api/extraction-jobs/{job_id}")
def get_extraction_job(job_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        if job is None or job.job_type.value != "extraction":
            raise ApiError(404, "JOB_NOT_FOUND", "任务不存在。", "返回任务列表")
        return job_to_dto(job)
    finally:
        session.close()


def point_dto(point: KnowledgePoint, *, block_text: str | None = None) -> dict[str, Any]:
    dto: dict[str, Any] = {
        "id": point.id,
        "extraction_job_id": point.extraction_job_id,
        "document_id": point.document_id,
        "source_block_id": point.source_block_id,
        "content": point.content,
        "bloom_level": point.bloom_level,
        "category": point.category,
        "eligible_types": point.eligible_types,
        "selected": point.selected,
        "selectable": point.selectable,
        "requires_source_review": point.requires_source_review,
        "created_at": to_iso(point.created_at),
    }
    if block_text is not None:
        dto["source_text"] = block_text
    return dto


@router.get("/api/extraction-jobs/{job_id}/points")
def list_points(
    job_id: str,
    page: int | None = Query(None, ge=1),
    page_size: int | None = Query(None, ge=1),
) -> ListEnvelope[dict[str, Any]]:
    p, ps = normalize_paging(page, page_size)
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        if job is None or job.job_type.value != "extraction":
            raise ApiError(404, "JOB_NOT_FOUND", "任务不存在。", "返回任务列表")
        rows = (
            session.query(KnowledgePoint)
            .filter(KnowledgePoint.extraction_job_id == job_id)
            .order_by(KnowledgePoint.created_at, KnowledgePoint.id)
            .all()
        )
        start, end = page_bounds(p, ps, len(rows))
        items = []
        for row in rows[start:end]:
            block = session.get(SourceBlock, row.source_block_id)
            items.append(point_dto(row, block_text=block.text if block else None))
        return ListEnvelope(items=items, total=len(rows), page=p, page_size=ps)
    finally:
        session.close()


class PointSelection(BaseModel):
    selected: bool


@router.patch("/api/knowledge-points/{point_id}")
def patch_point(point_id: str, body: PointSelection) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        point = session.get(KnowledgePoint, point_id)
        if point is None:
            raise ApiError(404, "POINT_NOT_FOUND", "考点不存在。", "返回考点列表")
        if body.selected and not point.selectable:
            raise ApiError(409, "POINT_NOT_SELECTABLE",
                           "该考点所属任务未完整成功,不可选择。", "重新抽取考点")
        point.selected = body.selected
        session.commit()
        block = session.get(SourceBlock, point.source_block_id)
        return point_dto(point, block_text=block.text if block else None)
    finally:
        session.close()


class BulkSelection(BaseModel):
    point_ids: list[str]
    selected: bool


@router.post("/api/knowledge-points/bulk-selection")
def bulk_selection(body: BulkSelection) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        updated: list[str] = []
        for point_id in body.point_ids:
            point = session.get(KnowledgePoint, point_id)
            if point is None:
                continue
            if body.selected and not point.selectable:
                continue
            point.selected = body.selected
            updated.append(point_id)
        session.commit()
        return {"updated": len(updated), "point_ids": updated}
    finally:
        session.close()
