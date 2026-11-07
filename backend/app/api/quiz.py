"""试卷、复核、历史与导出 API(规格 13.5、13.6)。"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Header, Query, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import config
from app.api.errors import ApiError
from app.db.engine import get_session_factory, to_iso, utcnow
from app.models import (
    DeletionConfirmation,
    Document,
    Export,
    Job,
    KnowledgePoint,
    Question,
    QuizRecord,
    QuizRecordDocument,
    QuizRecordPoint,
)
from app.schemas.common import ListEnvelope, normalize_paging, page_bounds
from app.services import idempotency, review_service
from app.services.export import service as export_service

router = APIRouter(tags=["quiz"])


def quiz_summary(quiz: QuizRecord) -> dict[str, Any]:
    return {
        "id": quiz.id,
        "status": quiz.status.value,
        "question_config": quiz.question_config,
        "ai_profile_name": quiz.ai_profile_name,
        "model_name": quiz.model_name,
        "seed": quiz.seed,
        "created_at": to_iso(quiz.created_at),
        "updated_at": to_iso(quiz.updated_at),
    }


def quiz_detail(session, quiz: QuizRecord) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    questions = (
        session.query(Question)
        .filter(Question.quiz_record_id == quiz.id)
        .order_by(Question.slot_number)
        .all()
    )
    documents = (
        session.query(QuizRecordDocument)
        .filter(QuizRecordDocument.quiz_record_id == quiz.id)
        .order_by(QuizRecordDocument.ordinal)
        .all()
    )
    doc_names = []
    for rel in documents:
        document = session.get(Document, rel.document_id)
        if document:
            doc_names.append(document.original_name)

    approved = sum(
        1 for q in questions
        if q.validation_state == "passed" and q.review_state == "approved"
    )
    unreviewed = sum(
        1 for q in questions
        if q.validation_state == "passed" and q.review_state == "unreviewed"
    )
    rejected = sum(1 for q in questions if q.review_state == "rejected")
    # 缺失 = 未通过校验、被驳回或空槽位(驳回在导出计数中视为缺失,规格 4.3)
    missing = sum(
        1 for q in questions
        if q.validation_state != "passed"
        or q.review_state == "rejected"
        or not q.stem
    )

    detail = quiz_summary(quiz)
    detail.update({
        "documents": doc_names,
        "questions": [review_service.question_dto(session, q) for q in questions],
        "progress": {
            "target": len(questions),
            "approved": approved,
            "unreviewed": unreviewed,
            "rejected": rejected,
            "missing": missing,
            "export_ready": (
                quiz.status.value in ("ready", "exported")
            ),
        },
        "frozen_points": _frozen_points(session, quiz.id),
    })
    return detail


def _frozen_points(session, quiz_record_id: str) -> list[dict[str, Any]]:  # type: ignore[no-untyped-def]
    rows = (
        session.query(QuizRecordPoint)
        .filter(QuizRecordPoint.quiz_record_id == quiz_record_id)
        .order_by(QuizRecordPoint.selection_order)
        .all()
    )
    result = []
    for row in rows:
        point = session.get(KnowledgePoint, row.knowledge_point_id)
        if point is None:
            continue
        result.append({
            "id": point.id,
            "content": point.content,
            "category": point.category,
            "bloom_level": point.bloom_level,
            "eligible_types": point.eligible_types,
            "used": _point_used(session, quiz_record_id, point.id),
        })
    return result


def _point_used(session, quiz_record_id: str, point_id: str) -> bool:  # type: ignore[no-untyped-def]
    return (
        session.query(Question)
        .filter(
            Question.quiz_record_id == quiz_record_id,
            Question.knowledge_point_id == point_id,
        )
        .first()
        is not None
    )


@router.get("/api/quiz-records")
def list_quiz_records(
    page: int | None = Query(None, ge=1),
    page_size: int | None = Query(None, ge=1),
) -> ListEnvelope[dict[str, Any]]:
    p, ps = normalize_paging(page, page_size)
    session = get_session_factory()()
    try:
        rows = session.query(QuizRecord).order_by(QuizRecord.created_at.desc()).all()
        start, end = page_bounds(p, ps, len(rows))
        return ListEnvelope(
            items=[quiz_summary(r) for r in rows[start:end]],
            total=len(rows), page=p, page_size=ps,
        )
    finally:
        session.close()


@router.get("/api/quiz-records/{quiz_record_id}")
def get_quiz_record(quiz_record_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        quiz = session.get(QuizRecord, quiz_record_id)
        if quiz is None:
            raise ApiError(404, "QUIZ_NOT_FOUND", "试卷不存在。", "返回历史列表")
        return quiz_detail(session, quiz)
    finally:
        session.close()


# --- 题目复核(规格 13.5)---


class QuestionPatch(BaseModel):
    stem: str | None = None
    options: list[str] | None = None
    answer_content: str | None = None
    answer: str | None = None
    acceptable_answers: list[str] | None = None
    explanation: str | None = None
    knowledge_point_id: str | None = None


@router.patch("/api/questions/{question_id}")
def patch_question(question_id: str, body: QuestionPatch) -> dict[str, Any]:
    return review_service.edit_question(question_id, body.model_dump(exclude_unset=True))


class ReviewBody(BaseModel):
    decision: str


@router.post("/api/questions/{question_id}/review")
def review_question(question_id: str, body: ReviewBody) -> dict[str, Any]:
    return review_service.review_question(question_id, body.decision)


@router.delete("/api/questions/{question_id}", status_code=204)
def delete_question(question_id: str) -> None:
    review_service.delete_question(question_id)


class ConsentBody(BaseModel):
    consent_id: str


@router.post("/api/questions/{question_id}/regenerate", status_code=202, response_model=None)
def regenerate_question(
    question_id: str,
    body: ConsentBody,
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict[str, Any] | Response:
    replay = idempotency.check("POST", f"/api/questions/{question_id}/regenerate",
                               idempotency_key, body.model_dump())
    if replay is not None:
        return replay
    result = review_service.regenerate_question(question_id, body.consent_id)
    idempotency.save("POST", f"/api/questions/{question_id}/regenerate",
                     idempotency_key or "", body.model_dump(), 202, result)
    return result


class BulkReviewBody(BaseModel):
    question_ids: list[str]


@router.post("/api/quiz-records/{quiz_record_id}/reviews/bulk")
def bulk_review(quiz_record_id: str, body: BulkReviewBody) -> dict[str, Any]:
    return review_service.bulk_approve(quiz_record_id, body.question_ids)


@router.post(
    "/api/quiz-records/{quiz_record_id}/fill-missing",
    status_code=202,
    response_model=None,
)
def fill_missing(
    quiz_record_id: str,
    body: ConsentBody,
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict[str, Any] | Response:
    replay = idempotency.check("POST", f"/api/quiz-records/{quiz_record_id}/fill-missing",
                               idempotency_key, body.model_dump())
    if replay is not None:
        return replay
    result = review_service.fill_missing(quiz_record_id, body.consent_id)
    idempotency.save("POST", f"/api/quiz-records/{quiz_record_id}/fill-missing",
                     idempotency_key or "", body.model_dump(), 202, result)
    return result


# --- 导出与历史(规格 13.6)---


@router.get("/api/quiz-records/{quiz_record_id}/exports")
def list_exports(quiz_record_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        quiz = session.get(QuizRecord, quiz_record_id)
        if quiz is None:
            raise ApiError(404, "QUIZ_NOT_FOUND", "试卷不存在。", "返回历史列表")
        rows = (
            session.query(Export)
            .filter(Export.quiz_record_id == quiz_record_id)
            .order_by(Export.created_at.desc())
            .all()
        )
        batches: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            batches.setdefault(row.export_batch_id, []).append({
                "id": row.id,
                "kind": row.kind.value,
                "filename": row.download_name,
                "download_url": f"/api/exports/{row.id}/download",
                "is_current": row.is_current,
                "created_at": to_iso(row.created_at),
            })
        return {
            "items": [
                {"batch_id": batch_id, "files": files,
                 "is_current": any(f["is_current"] for f in files)}
                for batch_id, files in batches.items()
            ],
            "total": len(batches),
        }
    finally:
        session.close()


@router.post("/api/quiz-records/{quiz_record_id}/exports", status_code=201, response_model=None)
def create_exports(
    quiz_record_id: str,
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict[str, Any] | Response:
    replay = idempotency.check("POST", f"/api/quiz-records/{quiz_record_id}/exports",
                               idempotency_key, {})
    if replay is not None:
        return replay
    result = export_service.generate_exports(quiz_record_id)
    response = {
        "student": {"id": result.student["id"],
                    "filename": result.student["filename"],
                    "download_url": result.student["download_url"]},
        "answer": {"id": result.answer["id"],
                   "filename": result.answer["filename"],
                   "download_url": result.answer["download_url"]},
    }
    idempotency.save("POST", f"/api/quiz-records/{quiz_record_id}/exports",
                     idempotency_key or "", {}, 201, response)
    return response


@router.get("/api/exports/{export_id}/download")
def download_export(export_id: str) -> FileResponse:
    session = get_session_factory()()
    try:
        row = session.get(Export, export_id)
        if row is None:
            raise ApiError(404, "EXPORT_NOT_FOUND", "导出文件不存在。", "返回历史列表")
        path = config.EXPORTS_DIR / row.stored_name
        if not path.exists():
            raise ApiError(404, "EXPORT_NOT_FOUND", "导出文件不存在。", "返回历史列表")
        return FileResponse(
            path,
            filename=row.download_name,
            media_type=(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ),
        )
    finally:
        session.close()


# --- 试卷删除(规格 13.6、17.4)---


def _quiz_impact(session, quiz: QuizRecord) -> dict[str, Any]:  # type: ignore[no-untyped-def]
    questions = (
        session.query(Question).filter(Question.quiz_record_id == quiz.id).count()
    )
    exports_count = (
        session.query(Export).filter(Export.quiz_record_id == quiz.id).count()
    )
    jobs = session.query(Job).filter(Job.quiz_record_id == quiz.id).count()
    from app.models import JobEvent, JobUnit

    events = (
        session.query(JobEvent)
        .filter(JobEvent.job_id.in_(
            [j.id for j in session.query(Job).filter(Job.quiz_record_id == quiz.id).all()]
        ))
        .count()
    )
    units = (
        session.query(JobUnit)
        .filter(JobUnit.job_id.in_(
            [j.id for j in session.query(Job).filter(Job.quiz_record_id == quiz.id).all()]
        ))
        .count()
    )
    return {
        "can_delete": True,
        "counts": {
            "questions": questions,
            "jobs": jobs,
            "job_events": events,
            "job_units": units,
            "exports": exports_count,
            "export_files": exports_count,
        },
    }


@router.get("/api/quiz-records/{quiz_record_id}/deletion-impact")
def quiz_deletion_impact(quiz_record_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        quiz = session.get(QuizRecord, quiz_record_id)
        if quiz is None:
            raise ApiError(404, "QUIZ_NOT_FOUND", "试卷不存在。", "返回历史列表")
        impact = _quiz_impact(session, quiz)
        impact_hash = hashlib.sha256(
            json.dumps(impact, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        token = secrets.token_urlsafe(32)
        session.add(DeletionConfirmation(
            token=token,
            resource_type="quiz_record",
            resource_id=quiz_record_id,
            impact_hash=impact_hash,
            expires_at=utcnow() + timedelta(seconds=config.DELETION_TOKEN_TTL_SECONDS),
        ))
        session.commit()
        impact["deletion_token"] = token
        impact["message"] = "删除试卷会移除其题目、任务、事件和导出文件,不可恢复。"
        return impact
    finally:
        session.close()


@router.delete("/api/quiz-records/{quiz_record_id}", status_code=204)
def delete_quiz_record(
    quiz_record_id: str,
    x_deletion_token: str = Header(..., alias="X-Deletion-Token"),
) -> None:
    session = get_session_factory()()
    try:
        quiz = session.get(QuizRecord, quiz_record_id)
        if quiz is None:
            raise ApiError(404, "QUIZ_NOT_FOUND", "试卷不存在。", "返回历史列表")
        impact = _quiz_impact(session, quiz)
        impact_hash = hashlib.sha256(
            json.dumps(impact, sort_keys=True, ensure_ascii=False).encode("utf-8")
        ).hexdigest()
        row = (
            session.query(DeletionConfirmation)
            .filter(DeletionConfirmation.token == x_deletion_token)
            .one_or_none()
        )
        if (
            row is None
            or row.used_at is not None
            or row.expires_at < utcnow()
            or row.resource_id != quiz_record_id
            or row.resource_type != "quiz_record"
            or row.impact_hash != impact_hash
        ):
            raise ApiError(409, "DELETE_CONFIRMATION_REQUIRED",
                           "删除前需要查看最新影响范围。", "重新打开删除确认")
        row.used_at = utcnow()

        exports = (
            session.query(Export).filter(Export.quiz_record_id == quiz_record_id).all()
        )
        job_ids = [
            j.id for j in session.query(Job).filter(Job.quiz_record_id == quiz_record_id).all()
        ]
        if job_ids:
            from app.models import JobEvent, JobUnit

            session.query(JobEvent).filter(
                JobEvent.job_id.in_(job_ids)).delete(synchronize_session=False)
            session.query(JobUnit).filter(
                JobUnit.job_id.in_(job_ids)).delete(synchronize_session=False)
            session.query(Job).filter(Job.id.in_(job_ids)).delete(
                synchronize_session=False)
        session.query(Question).filter(
            Question.quiz_record_id == quiz_record_id).delete(synchronize_session=False)
        session.query(QuizRecordPoint).filter(
            QuizRecordPoint.quiz_record_id == quiz_record_id).delete(
            synchronize_session=False)
        session.query(QuizRecordDocument).filter(
            QuizRecordDocument.quiz_record_id == quiz_record_id).delete(
            synchronize_session=False)
        session.query(Export).filter(
            Export.quiz_record_id == quiz_record_id).delete(synchronize_session=False)
        session.delete(quiz)
        session.commit()

        for export in exports:
            (config.EXPORTS_DIR / export.stored_name).unlink(missing_ok=True)
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
