"""文档删除影响分析与级联删除(规格 7.6、13.6、17.4)。

- 直接引用(quiz_record_documents)或间接引用(该文档所在 ExtractionJob 的考点被
  试卷引用)存在时,can_delete=false 并列出全部阻止的 QuizRecord ID。
- 允许删除时级联:上传文件、SourceBlock、ParseJob、包含该文档的 ExtractionJob、
  其未冻结候选考点与事件。
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import timedelta
from typing import Any

from app import config
from app.db.engine import get_session_factory, utcnow
from app.models import (
    DeletionConfirmation,
    Document,
    Job,
    JobDocument,
    JobEvent,
    JobType,
    KnowledgePoint,
    Question,
    QuizRecordDocument,
    QuizRecordPoint,
    SourceBlock,
)

TOKEN_TTL = timedelta(seconds=config.DELETION_TOKEN_TTL_SECONDS)


def _document_impact(document_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        document = session.get(Document, document_id)
        if document is None:
            return {}

        direct_ids = {
            row.quiz_record_id
            for row in session.query(QuizRecordDocument)
            .filter(QuizRecordDocument.document_id == document_id)
            .all()
        }

        # 间接:包含该文档的 ExtractionJob → 其产出的考点被试卷引用。
        extraction_job_ids = {
            row.job_id
            for row in session.query(JobDocument)
            .filter(JobDocument.document_id == document_id)
            .all()
        } | {
            row.id
            for row in session.query(Job)
            .filter(Job.job_type == JobType.extraction, Job.document_id == document_id)
            .all()
        }
        related_jobs = list(
            session.query(Job).filter(Job.id.in_(extraction_job_ids or {"__none__"})).all()
        )
        extraction_job_ids = {
            j.id for j in related_jobs if j.job_type == JobType.extraction
        }

        frozen_point_ids = {
            row.knowledge_point_id
            for row in session.query(QuizRecordPoint).all()
        } | {
            row.knowledge_point_id
            for row in session.query(Question)
            .filter(Question.knowledge_point_id.isnot(None))
            .all()
        }

        indirect_ids: set[str] = set()
        frozen_points_kept = 0
        if extraction_job_ids:
            points = (
                session.query(KnowledgePoint)
                .filter(
                    KnowledgePoint.extraction_job_id.in_(extraction_job_ids)
                )
                .all()
            )
            frozen_job_point_ids = {p.id for p in points} & frozen_point_ids
            if frozen_job_point_ids:
                # 引用这些考点的试卷(直接点选或题目使用)
                indirect_ids |= {
                    row.quiz_record_id
                    for row in session.query(QuizRecordPoint)
                    .filter(QuizRecordPoint.knowledge_point_id.in_(frozen_job_point_ids))
                    .all()
                } | {
                    q.quiz_record_id
                    for q in session.query(Question)
                    .filter(Question.knowledge_point_id.in_(frozen_job_point_ids))
                    .all()
                }
            frozen_points_kept = len(frozen_job_point_ids)

        parse_jobs = (
            session.query(Job)
            .filter(Job.job_type == JobType.parse, Job.document_id == document_id)
            .all()
        )
        blocks = (
            session.query(SourceBlock)
            .filter(SourceBlock.document_id == document_id)
            .count()
        )
        unfrozen_points = 0
        if extraction_job_ids:
            unfrozen_points = (
                session.query(KnowledgePoint)
                .filter(
                    KnowledgePoint.extraction_job_id.in_(extraction_job_ids),
                    ~KnowledgePoint.id.in_(frozen_point_ids or {"__none__"}),
                )
                .count()
            )

        blocking_ids = sorted(direct_ids | indirect_ids)
        can_delete = not blocking_ids
        impact = {
            "can_delete": can_delete,
            "blocking_quiz_record_ids": blocking_ids,
            "counts": {
                "source_blocks": blocks,
                "parse_jobs": len(parse_jobs),
                "extraction_jobs": len(extraction_job_ids),
                "unfrozen_knowledge_points": unfrozen_points,
                "frozen_knowledge_points_kept": frozen_points_kept,
                "upload_file": 1,
            },
        }
        return impact
    finally:
        session.close()


def _impact_hash(impact: dict[str, Any]) -> str:
    canonical = json.dumps(impact, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def issue_token(resource_id: str, impact: dict[str, Any]) -> str:
    token = secrets.token_urlsafe(32)
    session = get_session_factory()()
    try:
        session.add(
            DeletionConfirmation(
                token=token,
                resource_type="document",
                resource_id=resource_id,
                impact_hash=_impact_hash(impact),
                expires_at=utcnow() + TOKEN_TTL,
            )
        )
        session.commit()
    finally:
        session.close()
    return token


def consume_token(token: str, resource_id: str, impact: dict[str, Any]) -> bool:
    """一次性消费 token:未过期、未使用且 impact_hash 匹配才有效。"""
    session = get_session_factory()()
    try:
        row = (
            session.query(DeletionConfirmation)
            .filter(DeletionConfirmation.token == token)
            .one_or_none()
        )
        if (
            row is None
            or row.used_at is not None
            or row.expires_at < utcnow()
            or row.resource_id != resource_id
            or row.resource_type != "document"
            or row.impact_hash != _impact_hash(impact)
        ):
            return False
        row.used_at = utcnow()
        session.commit()
        return True
    finally:
        session.close()


def deletion_impact(document_id: str) -> dict[str, Any]:
    impact = _document_impact(document_id)
    if not impact:
        return {}
    if impact["can_delete"]:
        impact["deletion_token"] = issue_token(document_id, impact)
    return impact


def delete_document(document_id: str, token: str) -> dict[str, Any] | None:
    """执行删除;影响范围变化(token 失配)返回 None 表示需重新预检。"""
    impact = _document_impact(document_id)
    if not impact:
        return None
    if not impact["can_delete"]:
        return impact  # 调用方转 DOCUMENT_IN_USE
    if not consume_token(token, document_id, impact):
        return None
    return _cascade_delete(document_id)


def _cascade_delete(document_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        document = session.get(Document, document_id)
        if document is None:
            return {"deleted": False}
        upload_path = config.UPLOADS_DIR / document.stored_name

        session.query(SourceBlock).filter(
            SourceBlock.document_id == document_id
        ).delete(synchronize_session=False)

        parse_job_ids = [
            j.id
            for j in session.query(Job)
            .filter(Job.job_type == JobType.parse, Job.document_id == document_id)
            .all()
        ]
        extraction_job_ids = {
            row.job_id
            for row in session.query(JobDocument)
            .filter(JobDocument.document_id == document_id)
            .all()
        } | {
            j.id
            for j in session.query(Job)
            .filter(Job.job_type == JobType.extraction, Job.document_id == document_id)
            .all()
        }
        extraction_job_ids = {
            j.id
            for jid in extraction_job_ids
            if (j := session.get(Job, jid)) is not None
            and j.job_type == JobType.extraction
        }

        frozen_point_ids = {
            row.knowledge_point_id for row in session.query(QuizRecordPoint).all()
        } | {
            q.knowledge_point_id
            for q in session.query(Question)
            .filter(Question.knowledge_point_id.isnot(None))
            .all()
        }

        removed_points = 0
        if extraction_job_ids:
            jobs_points = (
                session.query(KnowledgePoint)
                .filter(KnowledgePoint.extraction_job_id.in_(extraction_job_ids))
                .all()
            )
            for point in jobs_points:
                if point.id not in frozen_point_ids:
                    session.delete(point)
                    removed_points += 1

        all_job_ids = list(set(parse_job_ids) | extraction_job_ids)
        if all_job_ids:
            session.query(JobEvent).filter(
                JobEvent.job_id.in_(all_job_ids)
            ).delete(synchronize_session=False)
            from app.models import JobUnit

            session.query(JobUnit).filter(
                JobUnit.job_id.in_(all_job_ids)
            ).delete(synchronize_session=False)
            session.query(JobDocument).filter(
                JobDocument.job_id.in_(all_job_ids)
            ).delete(synchronize_session=False)
            session.query(Job).filter(Job.id.in_(all_job_ids)).delete(
                synchronize_session=False
            )

        session.delete(document)
        session.commit()

        if upload_path.exists():
            upload_path.unlink()
        return {"deleted": True, "removed_points": removed_points}
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
