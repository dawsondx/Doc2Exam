"""文档 API:上传、列表、详情、删除预检与删除(规格 13.2)。"""

from __future__ import annotations

import hashlib
import re
import uuid
from functools import partial
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, File, Header, Query, Response, UploadFile

from app import config
from app.api.errors import ApiError
from app.db.engine import get_session_factory, to_iso
from app.models import Document, MediaType, ParseStatus, SourceBlock
from app.schemas.common import ListEnvelope, normalize_paging, page_bounds
from app.services import documents as documents_service
from app.services import idempotency
from app.services.jobs import runner as job_runner
from app.services.parse_job import create_parse_job
from app.services.parse_job import run as run_parse_job

router = APIRouter(prefix="/api/documents", tags=["documents"])

PDF_MIME = "application/pdf"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_SAFE_NAME = re.compile(r"[^\w\u4e00-\u9fff.\-() ]+")


def _validate_file_meta(filename: str | None, content_type: str | None,
                        signature: bytes) -> MediaType:
    ext = Path(filename or "").suffix.lower()
    is_pdf_sig = signature.startswith(b"%PDF-")
    is_zip_sig = signature.startswith(b"PK\x03\x04")
    pdf_mime = (content_type or "").lower() in (
        PDF_MIME, "application/x-pdf", "application/acrobat",
    )
    docx_mime = (content_type or "").lower() in (DOCX_MIME, "application/zip", "")
    if ext == ".pdf" and (pdf_mime or is_pdf_sig) and is_pdf_sig:
        return MediaType.pdf
    if ext == ".docx" and (docx_mime or is_zip_sig) and is_zip_sig:
        return MediaType.docx
    raise ApiError(422, "UNSUPPORTED_FILE_TYPE", "仅支持 PDF 和 DOCX。", "重新选择文件")


async def _stream_to_temp(upload: UploadFile, budget: int) -> tuple[Path, int, bytes, str]:
    """流式落盘并计数,返回 (临时路径, 大小, 文件头, sha256)。"""
    temp_path = config.TEMP_DIR / f"{uuid.uuid4()}.tmp"
    hasher = hashlib.sha256()
    size = 0
    head = b""
    with open(temp_path, "wb") as out:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > budget:
                out.close()
                temp_path.unlink(missing_ok=True)
                raise ApiError(422, "FILE_TOO_LARGE", "单个文件不能超过 50 MB。",
                               "选择更小文件")
            if not head:
                head = chunk[:8]
            hasher.update(chunk)
            out.write(chunk)
    return temp_path, size, head, hasher.hexdigest()


@router.post("", status_code=202, response_model=None)
async def upload_documents(
    files: Annotated[list[UploadFile], File()],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict[str, Any] | Response:
    body_hint = {"file_count": len(files), "names": [f.filename for f in files]}
    replay = idempotency.check("POST", "/api/documents", idempotency_key, body_hint)
    if replay is not None:
        return replay

    if not files or len(files) > config.UPLOAD_MAX_FILES:
        raise ApiError(422, "BATCH_FILE_COUNT_EXCEEDED", "一次最多上传 10 个文件。",
                       "减少文件后重试")

    staged: list[dict[str, Any]] = []
    total = 0
    for upload in files:
        temp_path, size, head, sha256 = await _stream_to_temp(
            upload, config.UPLOAD_MAX_FILE_BYTES
        )
        total += size
        if total > config.UPLOAD_MAX_TOTAL_BYTES:
            for item in staged:
                Path(item["path"]).unlink(missing_ok=True)
            temp_path.unlink(missing_ok=True)
            raise ApiError(422, "BATCH_TOO_LARGE", "本次文件总大小超过 200 MB。",
                           "减少文件")
        try:
            media_type = _validate_file_meta(upload.filename, upload.content_type, head)
        except ApiError:
            for item in staged:
                Path(item["path"]).unlink(missing_ok=True)
            temp_path.unlink(missing_ok=True)
            raise
        staged.append(
            {
                "path": str(temp_path),
                "original_name": upload.filename or "未命名文件",
                "media_type": media_type,
                "size": size,
                "sha256": sha256,
            }
        )

    from app.services.parsers.common import PARSER_VERSION

    items: list[dict[str, Any]] = []
    session = get_session_factory()()
    try:
        for item in staged:
            stored_name = f"{uuid.uuid4()}.bin"
            final_path = config.UPLOADS_DIR / stored_name
            Path(item["path"]).replace(final_path)
            document = Document(
                original_name=item["original_name"],
                stored_name=stored_name,
                media_type=item["media_type"],
                sha256=item["sha256"],
                size_bytes=item["size"],
                parse_status=ParseStatus.pending,
                parser_version=PARSER_VERSION,
            )
            session.add(document)
            session.commit()
            job_id = create_parse_job(document.id)
            items.append(
                {
                    "document": _document_dto(document),
                    "job_id": job_id,
                }
            )
            job_runner.submit(job_id, partial(run_parse_job, job_id))
        session.commit()
    finally:
        session.close()

    response = {"items": items}
    idempotency.save("POST", "/api/documents", idempotency_key or "", body_hint, 202, response)
    return response


def _document_dto(document: Document, preview: str | None = None) -> dict[str, Any]:
    dto: dict[str, Any] = {
        "id": document.id,
        "original_name": document.original_name,
        "media_type": document.media_type.value,
        "size_bytes": document.size_bytes,
        "page_count": document.page_count,
        "block_count": document.block_count,
        "parse_status": document.parse_status.value,
        "parse_error": document.parse_error,
        "created_at": to_iso(document.created_at),
    }
    if preview is not None:
        dto["preview"] = preview
    return dto


@router.get("")
def list_documents(
    page: int | None = Query(None, ge=1),
    page_size: int | None = Query(None, ge=1),
) -> ListEnvelope[dict[str, Any]]:
    p, ps = normalize_paging(page, page_size)
    session = get_session_factory()()
    try:
        rows = (
            session.query(Document)
            .order_by(Document.created_at.desc())
            .all()
        )
        start, end = page_bounds(p, ps, len(rows))
        return ListEnvelope(
            items=[_document_dto(r) for r in rows[start:end]],
            total=len(rows), page=p, page_size=ps,
        )
    finally:
        session.close()


@router.get("/{document_id}")
def get_document(document_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        document = session.get(Document, document_id)
        if document is None:
            raise ApiError(404, "DOCUMENT_NOT_FOUND", "文档不存在。", "返回文档列表")
        blocks = (
            session.query(SourceBlock)
            .filter(SourceBlock.document_id == document_id)
            .order_by(SourceBlock.ordinal)
            .all()
        )
        preview = blocks[0].text[:300] if blocks else ""
        dto = _document_dto(document, preview=preview)
        dto["blocks"] = [
            {
                "id": b.id,
                "ordinal": b.ordinal,
                "locator_kind": b.locator_kind,
                "locator_label": b.locator_label,
                "page_number": b.page_number,
                "estimated_tokens": b.estimated_tokens,
            }
            for b in blocks[:100]
        ]
        dto["block_total"] = len(blocks)
        return dto
    finally:
        session.close()


@router.get("/{document_id}/deletion-impact")
def deletion_impact(document_id: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        if session.get(Document, document_id) is None:
            raise ApiError(404, "DOCUMENT_NOT_FOUND", "文档不存在。", "返回文档列表")
    finally:
        session.close()
    impact = documents_service.deletion_impact(document_id)
    if not impact:
        raise ApiError(404, "DOCUMENT_NOT_FOUND", "文档不存在。", "返回文档列表")
    if impact["can_delete"]:
        impact["message"] = "删除后将移除该文档的原始文件、文本块和未冻结考点。"
    else:
        impact["message"] = "文档仍被历史试卷引用,需先删除列出的试卷。"
    return impact


@router.delete("/{document_id}", status_code=204)
def delete_document(
    document_id: str,
    x_deletion_token: str = Header(..., alias="X-Deletion-Token"),
) -> None:
    session = get_session_factory()()
    try:
        if session.get(Document, document_id) is None:
            raise ApiError(404, "DOCUMENT_NOT_FOUND", "文档不存在。", "返回文档列表")
    finally:
        session.close()
    result = documents_service.delete_document(document_id, x_deletion_token)
    if result is None:
        raise ApiError(409, "DELETE_CONFIRMATION_REQUIRED",
                       "删除前需要查看最新影响范围。", "重新打开删除确认")
    if not result.get("deleted") and result.get("blocking_quiz_record_ids") is not None:
        raise ApiError(409, "DOCUMENT_IN_USE", "文档仍被历史试卷引用。",
                       "先删除列出的试卷")
