"""ParseJob 执行:解析上传文档并创建 SourceBlock(规格 9.1、12.3)。

unit = PDF 页或 DOCX 正文项序号;每完成一个 unit 提交数据库,恢复时只处理未完成 unit。
同一 SHA-256 + parser_version 的文件复用解析结果,但仍创建新的上传记录。
"""

from __future__ import annotations

import logging
import time
from typing import Any

from sqlalchemy.orm import Session

from app import config
from app.api.errors import ApiError
from app.db.engine import get_session_factory
from app.models import (
    Document,
    Job,
    JobDocument,
    JobStatus,
    JobType,
    ParseStatus,
    SourceBlock,
    UnitStatus,
)
from app.services.jobs import events, runner

logger = logging.getLogger("ai_quiz")


def create_parse_job(document_id: str) -> str:
    """为文档创建 ParseJob(幂等:同文档已有未完成任务时复用)。"""
    session = get_session_factory()()
    try:
        existing = (
            session.query(Job)
            .filter(
                Job.job_type == JobType.parse,
                Job.document_id == document_id,
                Job.status.in_([JobStatus.queued, JobStatus.running]),
            )
            .first()
        )
        if existing:
            return existing.id
        job = Job(job_type=JobType.parse, document_id=document_id, total=0)
        session.add(job)
        session.flush()
        session.add(JobDocument(job_id=job.id, document_id=document_id, ordinal=1))
        session.commit()
        return job.id
    finally:
        session.close()


def _parse_items(
    document: Document,
) -> tuple[list[list[dict[str, Any]]], int | None]:
    """解析全部原始项,返回 (每 unit 的 block 定义列表, 页数)。"""
    path = str(config.UPLOADS_DIR / document.stored_name)
    if document.media_type.value == "pdf":
        from app.services.parsers.pdf_parser import parse_pdf

        blocks, page_count = parse_pdf(path)
        return _group_pdf_blocks(blocks), page_count
    from app.services.parsers.docx_parser import parse_docx

    blocks, _ = parse_docx(path)
    return _group_docx_blocks(blocks), None


def _group_pdf_blocks(blocks: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    grouped: dict[int, list[dict[str, Any]]] = {}
    for block in blocks:
        grouped.setdefault(block["page_number"], []).append(block)
    return [grouped[page] for page in sorted(grouped)]


def _group_docx_blocks(blocks: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    return [[block] for block in blocks]


def _upsert_block(session: Session, document_id: str, ordinal: int,
                  block: dict[str, Any]) -> None:
    existing = (
        session.query(SourceBlock)
        .filter(SourceBlock.document_id == document_id, SourceBlock.ordinal == ordinal)
        .one_or_none()
    )
    if existing is None:
        session.add(
            SourceBlock(
                document_id=document_id,
                ordinal=ordinal,
                locator_kind=block["locator_kind"],
                locator_label=block["locator_label"],
                page_number=block["page_number"],
                heading_path=block["heading_path"],
                paragraph_index=block["paragraph_index"],
                text=block["text"],
                normalized_text=block["normalized_text"],
                estimated_tokens=block["estimated_tokens"],
                text_sha256=block["text_sha256"],
            )
        )
    else:
        existing.locator_kind = block["locator_kind"]
        existing.locator_label = block["locator_label"]
        existing.page_number = block["page_number"]
        existing.heading_path = block["heading_path"]
        existing.paragraph_index = block["paragraph_index"]
        existing.text = block["text"]
        existing.normalized_text = block["normalized_text"]
        existing.estimated_tokens = block["estimated_tokens"]
        existing.text_sha256 = block["text_sha256"]


def _try_reuse(session: Session, document: Document) -> bool:
    """同 SHA-256 + 同 parser_version 的已解析文档:复制 SourceBlock。"""
    from app.services.parsers.common import PARSER_VERSION

    source = (
        session.query(Document)
        .filter(
            Document.sha256 == document.sha256,
            Document.parser_version == PARSER_VERSION,
            Document.parse_status == ParseStatus.ready,
            Document.id != document.id,
        )
        .first()
    )
    if source is None:
        return False
    src_blocks = (
        session.query(SourceBlock)
        .filter(SourceBlock.document_id == source.id)
        .order_by(SourceBlock.ordinal)
        .all()
    )
    for block in src_blocks:
        session.add(
            SourceBlock(
                document_id=document.id,
                ordinal=block.ordinal,
                locator_kind=block.locator_kind,
                locator_label=block.locator_label,
                page_number=block.page_number,
                heading_path=block.heading_path,
                paragraph_index=block.paragraph_index,
                text=block.text,
                normalized_text=block.normalized_text,
                estimated_tokens=block.estimated_tokens,
                text_sha256=block.text_sha256,
            )
        )
    document.page_count = source.page_count
    document.block_count = len(src_blocks)
    document.parse_status = ParseStatus.ready
    document.parse_error = None
    session.commit()
    logger.info("document %s 复用 %s 的解析结果", document.id, source.id)
    return True


async def run(job_id: str) -> None:
    """ParseJob 主流程:幂等解析 + 逐 unit 提交。"""
    started = time.monotonic()
    runner.begin(job_id)
    session = get_session_factory()()
    document: Document | None = None
    try:
        job = session.get(Job, job_id)
        if job is None or job.document_id is None:
            raise runner.JobFailed("JOB_NOT_FOUND", "任务不存在。")
        document = session.get(Document, job.document_id)
        if document is None:
            raise runner.JobFailed("JOB_NOT_FOUND", "文档不存在。")

        if document.parse_status == ParseStatus.ready:
            runner.mark_completed(job_id, message="文档已解析。")
            return

        if _try_reuse(session, document):
            events.emit(job_id, "document_ready", resource_id=document.id,
                        message="已复用解析结果。")
            runner.mark_completed(job_id, message="已复用解析结果。")
            return

        document.parse_status = ParseStatus.running
        session.commit()

        unit_blocks, page_count = _parse_items(document)
        if time.monotonic() - started > config.PARSE_JOB_TIMEOUT_SECONDS:
            raise ApiError(422, "DOCUMENT_LIMIT_EXCEEDED", "解析时间超过 120 秒限制。",
                           "拆分文档后重试")

        job.total = len(unit_blocks)
        job.stage = "parsing"
        session.commit()

        # 已完成 unit 直接跳过(幂等 upsert 之上再加一层跳过,避免重复切分写入)。
        from app.models import JobUnit

        done_units = {
            unit.unit_key
            for unit in session.query(JobUnit)
            .filter(JobUnit.job_id == job_id, JobUnit.status == UnitStatus.done)
            .all()
        }
        session.commit()  # 结束读事务,避免后续并发写时快照升级失败

        ordinal = 0
        for unit_index, blocks in enumerate(unit_blocks, start=1):
            ordinal += len(blocks)
            unit_key = f"unit:{unit_index}"
            already_done = unit_key in done_units
            if not already_done:
                runner.check_cancelled(job_id)
                base_ordinal = ordinal - len(blocks)
                for offset, block in enumerate(blocks, start=1):
                    _upsert_block(session, document.id, base_ordinal + offset, block)
                # 立即提交:autoflush 已把 SourceBlock 写入发往数据库,外层连接
                # 持有未提交写锁;必须先释放,upsert_unit 的独立连接才能写入,
                # 否则 SQLite 会锁死到 busy_timeout(规格 12.3 幂等单元)。
                document.block_count = ordinal
                document.page_count = page_count if document.media_type.value == "pdf" else None
                job.current = unit_index
                session.commit()
                runner.upsert_unit(job_id, unit_key, status=UnitStatus.done)
            else:
                document.block_count = ordinal
                document.page_count = page_count if document.media_type.value == "pdf" else None
                job.current = unit_index
                session.commit()
            if not already_done:
                events.emit(job_id, "progress", stage="parsing", current=unit_index,
                            total=job.total, message=f"已解析 {unit_index}/{job.total} 单元")
            if time.monotonic() - started > config.PARSE_JOB_TIMEOUT_SECONDS:
                raise ApiError(422, "DOCUMENT_LIMIT_EXCEEDED",
                               "解析时间超过 120 秒限制。", "拆分文档后重试")

        document.parse_status = ParseStatus.ready
        document.parse_error = None
        session.commit()
        events.emit(job_id, "document_ready", resource_id=document.id,
                    message=f"解析完成:{document.block_count} 个文本块。")
        runner.mark_completed(job_id, message="解析完成。")
    except ApiError as exc:
        session.rollback()
        _fail_job(session, job_id, document, exc.code, exc.message)
        raise runner.JobFailed(exc.code, exc.message) from exc
    except runner.JobCancelled:
        session.rollback()
        if document is not None:
            document.parse_status = ParseStatus.pending
            session.commit()
        raise
    finally:
        session.close()


def _fail_job(session: Session, job_id: str, document: Document | None,
              code: str, message: str) -> None:
    try:
        job = session.get(Job, job_id)
        if job is not None:
            job.status = JobStatus.failed
            job.error_code = code
            job.error_message = message
        if document is not None:
            document.parse_status = ParseStatus.failed
            document.parse_error = message
        session.commit()
    finally:
        events.emit(job_id, "job_failed", error={"code": code, "message": message})


def resume(job_id: str, _consent_id: str | None) -> dict[str, str]:
    """恢复 interrupted 的 ParseJob:重新提交执行,跳过已完成 unit。"""
    runner.submit(job_id, lambda: run(job_id))
    return {"status": "running"}


from app.services.jobs.resume_dispatcher import register  # noqa: E402

register(JobType.parse, resume)



