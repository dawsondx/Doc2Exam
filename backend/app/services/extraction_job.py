"""ExtractionJob 执行:组块 → 抽考点 → 校验 → 去重 → 持久化(规格 9.5、12.3)。

- unit = chunk 序号;每完成一个 chunk 提交。
- 每个 chunk 最多 3 个 logical call(首次 + 2 次携带错误修复)。
- 每个 logical call 前重新校验 AIProfile 活动状态、指纹与 Consent(规格 2.2)。
- 任一 chunk 三次仍失败 → Job failed,候选保留但 selectable=false。
- Mock AI(测试模式)按块内容确定性生成候选,不访问网络。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app import config
from app.api.errors import ApiError
from app.db.engine import get_session_factory
from app.models import (
    AIProfile,
    DataSharingConsent,
    Document,
    Job,
    JobDocument,
    JobStatus,
    JobType,
    KnowledgePoint,
    ParseStatus,
    SourceBlock,
    UnitStatus,
)
from app.schemas.ai_dtos import ExtractionResponse
from app.services import credentials, prompts
from app.services import profiles as profile_service
from app.services.ai_adapter.client import AIClient, structured_call
from app.services.extraction import chunker, dedupe
from app.services.jobs import events, runner
from app.services.profiles import mock_ai_enabled

logger = logging.getLogger("ai_quiz")


def create_extraction_job(
    *,
    document_ids: list[str],
    ai_profile_id: str,
    consent_id: str,
    target_question_count: int,
) -> str:
    session = get_session_factory()()
    try:
        profile = session.get(AIProfile, ai_profile_id)
        if profile is None or profile.deleted_at is not None:
            raise ApiError(404, "PROFILE_NOT_FOUND", "AI 配置不存在。", "返回配置列表")
        consent = session.get(DataSharingConsent, consent_id)
        fingerprint = profile_service.current_fingerprint(profile)
        if (
            consent is None
            or consent.revoked_at is not None
            or consent.profile_fingerprint != fingerprint
        ):
            raise ApiError(409, "AI_CONSENT_REQUIRED",
                           "当前 AI 配置尚未获得业务数据发送确认。",
                           "查看发送范围并确认")

        ready_docs: list[Document] = []
        for document_id in document_ids:
            document = session.get(Document, document_id)
            if document is None:
                raise ApiError(404, "DOCUMENT_NOT_FOUND", "文档不存在。", "返回文档列表")
            if document.parse_status != ParseStatus.ready:
                raise ApiError(409, "DOCUMENT_NOT_PARSED", "文档尚未完成解析。",
                               "等待解析完成后重试")
            ready_docs.append(document)

        job = Job(
            job_type=JobType.extraction,
            ai_profile_id=ai_profile_id,
            consent_id=consent_id,
            profile_fingerprint=fingerprint,
            model_name=profile.model,
            prompt_version=prompts.PROMPT_VERSION,
            config_snapshot={
                "document_ids": document_ids,
                "target_question_count": target_question_count,
            },
        )
        session.add(job)
        session.flush()
        for order, document in enumerate(ready_docs, start=1):
            session.add(JobDocument(job_id=job.id, document_id=document.id, ordinal=order))
        session.commit()
        return job.id
    finally:
        session.close()


def _load_blocks(session, document_ids: list[str]) -> list[chunker.ChunkBlock]:  # type: ignore[no-untyped-def]
    blocks: list[chunker.ChunkBlock] = []
    for document_id in document_ids:
        rows = (
            session.query(SourceBlock)
            .filter(SourceBlock.document_id == document_id)
            .order_by(SourceBlock.ordinal)
            .all()
        )
        blocks.extend(
            chunker.ChunkBlock(r.id, r.ordinal, r.text, r.estimated_tokens) for r in rows
        )
    return blocks


def _make_ai_client(profile: AIProfile) -> AIClient:
    api_key = (
        credentials.load_credential(profile.credential_key)
        if profile.credential_key
        else ""
    )
    caps = profile.capabilities or {}
    return AIClient(
        base_url=profile.base_url,
        model=profile.model,
        api_key=api_key or "mock-key",
        api_mode=profile.api_mode.value,
        preferred_mode=caps.get("preferred_output_mode") or "json_schema",
        max_output_tokens=min(profile.max_output_tokens, 4096),
        mock=mock_ai_enabled(),
    )


def _guard(profile_id: str, fingerprint: str, consent_id: str) -> None:
    """每个 logical call 前重新校验(规格 2.2)。"""
    session = get_session_factory()()
    try:
        profile = session.get(AIProfile, profile_id)
        if profile is None or profile.deleted_at is not None:
            raise runner.JobFailed("AI_JOB_PROFILE_CHANGED",
                                   "AI 配置已删除,任务停止。")
        if profile_service.current_fingerprint(profile) != fingerprint:
            raise runner.JobFailed("AI_JOB_PROFILE_CHANGED",
                                   "AI 配置已修改,任务停止。")
        consent = session.get(DataSharingConsent, consent_id)
        if consent is None or consent.revoked_at is not None:
            raise runner.JobCancelled()
    finally:
        session.close()


def _mock_candidates_for_chunk(blocks: list[chunker.ChunkBlock],
                               quota: int) -> list[dict[str, Any]]:
    """测试模式:从块内容按语义片段确定性合成考点(不访问网络,界面标记测试模式)。

    片段按句读符号切分并保证 10–200 字符(通过程序校验下限),
    同块最多取 6 个,片段间相似度低于近似去重阈值。
    """
    import re

    candidates: list[dict[str, Any]] = []
    max_per_block = 6
    for block in blocks:
        produced = 0
        segments = re.split(r"[。!?!?;;,,、::]+", block.text)
        for segment in segments:
            segment = segment.strip()
            if len(segment) < 10 or produced >= max_per_block:
                continue
            candidates.append(
                {
                    "source_block_id": block.block_id,
                    "content": segment[:200],
                    "bloom_level": "remember",
                    "category": "制度要求",
                    "eligible_types": ["single_choice", "true_false", "fill_blank"],
                }
            )
            produced += 1
            if len(candidates) >= max(2, quota):
                return candidates
    return candidates


async def run(job_id: str) -> None:
    runner.begin(job_id)
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        assert job is not None
        snapshot = job.config_snapshot or {}
        document_ids: list[str] = snapshot.get("document_ids", [])
        target_questions: int = snapshot.get("target_question_count", 20)

        profile = session.get(AIProfile, job.ai_profile_id)
        if profile is None or profile.deleted_at is not None:
            raise runner.JobFailed("AI_JOB_PROFILE_CHANGED", "AI 配置不存在。")
        fingerprint = job.profile_fingerprint or profile_service.current_fingerprint(profile)

        blocks = _load_blocks(session, document_ids)
        if not blocks:
            raise runner.JobFailed("DOCUMENT_NO_TEXT", "没有可用的文本块。")

        doc_tokens: list[tuple[str, int]] = []
        for document_id in document_ids:
            tokens = sum(
                b.estimated_tokens for b in blocks
                if _doc_of(session, b.block_id) == document_id
            )
            doc_tokens.append((document_id, tokens))
        quotas = chunker.distribute_quota(doc_tokens, target_questions)
        quota_by_doc = {q.document_id: q.quota for q in quotas}
        total_quota = sum(quota_by_doc.values())

        chunks = chunker.assemble_chunks(
            blocks,
            context_window=profile.context_window,
            max_output_tokens=profile.max_output_tokens,
        )
        job.total = len(chunks)
        job.stage = "extracting"
        session.commit()

        from app.models import JobUnit

        done_units = {
            u.unit_key
            for u in session.query(JobUnit)
            .filter(JobUnit.job_id == job_id, JobUnit.status == UnitStatus.done)
            .all()
        }

        client = _make_ai_client(profile)
        failed_chunks = 0
        try:
            for chunk in chunks:
                unit_key = f"chunk:{chunk.index}"
                if unit_key in done_units:
                    job.current = chunk.index
                    session.commit()
                    continue
                runner.check_cancelled(job_id)
                _guard(profile.id, fingerprint, job.consent_id or "")

                per_chunk_quota = max(1, round(total_quota / len(chunks)))
                ok = await _process_chunk(
                    session, job, chunk, per_chunk_quota, client, fingerprint,
                )
                if ok:
                    runner.upsert_unit(job_id, unit_key, status=UnitStatus.done)
                else:
                    failed_chunks += 1
                    runner.upsert_unit(job_id, unit_key, status=UnitStatus.failed)
                job.current = chunk.index
                job.logical_calls = client.stats.logical_calls
                job.http_attempts = client.stats.http_attempts
                job.input_tokens = client.stats.input_tokens
                job.output_tokens = client.stats.output_tokens
                session.commit()
                events.emit(
                    job_id, "progress", stage="extracting",
                    current=chunk.index, total=len(chunks),
                    message=f"已抽取 {chunk.index}/{len(chunks)} 组",
                )
        finally:
            await client.close()

        _finalize_points(session, job, selectable=(failed_chunks == 0))
        if failed_chunks:
            raise runner.JobFailed(
                "AI_RETRY_EXHAUSTED",
                f"{failed_chunks} 组考点抽取在限定次数内失败,已保存候选仅供诊断。",
            )
        runner.mark_completed(job_id, message="考点抽取完成。")
    except ApiError as exc:
        session.rollback()
        _fail(session, job_id, exc.code, exc.message)
        raise runner.JobFailed(exc.code, exc.message) from exc
    finally:
        session.close()


def _doc_of(session, block_id: str) -> str:  # type: ignore[no-untyped-def]
    block = session.get(SourceBlock, block_id)
    return block.document_id if block else ""


async def _process_chunk(
    session: Session,
    job: Job,
    chunk: chunker.Chunk,
    per_chunk_quota: int,
    client: AIClient,
    fingerprint: str,
) -> bool:
    """单 chunk:≤3 个 logical call,失败原因回传修复(规格 9.5)。"""
    allowed = {b.block_id for b in chunk.blocks}
    blocks_by_id = {b.block_id: b for b in chunk.blocks}
    repair_errors: str | None = None
    saved_any = False

    for _attempt in range(1, config.AI_LOGICAL_CALLS_PER_CHUNK + 1):
        runner.check_cancelled(job.id)
        _guard(job.ai_profile_id or "", fingerprint, job.consent_id or "")

        system = prompts.extraction_system(per_chunk_quota)
        user = prompts.extraction_user(
            [(b.block_id, b.text) for b in chunk.blocks],
            repair_errors=repair_errors,
        )
        try:
            if client.mock:
                data = ExtractionResponse.model_validate(
                    {"points": _mock_candidates_for_chunk(chunk.blocks, per_chunk_quota)}
                )
                client.stats.logical_calls += 1
            else:
                response = await structured_call(client, system, user, ExtractionResponse)
                data = response
        except ApiError as exc:
            if exc.code == "AI_STRUCTURED_OUTPUT_UNSUPPORTED":
                repair_errors = exc.message
                continue
            raise

        verdict_errors: list[str] = []
        valid_items: list[dict[str, Any]] = []
        for candidate in data.points:
            verdict = dedupe.validate_candidate(candidate, allowed)
            if not verdict.ok:
                verdict_errors.extend(verdict.errors)
                continue
            block = blocks_by_id[candidate.source_block_id]
            valid_items.append(
                {
                    "source_block_id": candidate.source_block_id,
                    "content": candidate.content.strip(),
                    "bloom_level": candidate.bloom_level,
                    "category": candidate.category.strip(),
                    "eligible_types": candidate.eligible_types,
                    "block_ordinal": block.ordinal,
                    "document_order": 1,
                }
            )
        if verdict_errors:
            repair_errors = ";".join(verdict_errors[:10])
            continue

        saved_any = _persist_candidates(job, valid_items)
        for item in valid_items:
            events.emit(job.id, "point_created", resource_id=item["source_block_id"],
                        message="新考点已保存")
        return saved_any or not verdict_errors

    return False


def _persist_candidates(job: Job, valid_items: list[dict[str, Any]]) -> bool:
    """确定性读 + 幂等 upsert + 提交;整体可重试(并发锁下重跑同一批)。"""
    import time

    from sqlalchemy.exc import OperationalError

    for _try in range(1, 21):
        session = get_session_factory()()
        try:
            saved_any = False
            for item in dedupe.dedupe_candidates(valid_items):
                block = session.get(SourceBlock, item["source_block_id"])
                if block is None:
                    continue
                key = dedupe.dedupe_key_for(item["content"])
                existing = (
                    session.query(KnowledgePoint)
                    .filter(
                        KnowledgePoint.extraction_job_id == job.id,
                        KnowledgePoint.source_block_id == item["source_block_id"],
                        KnowledgePoint.dedupe_key == key,
                    )
                    .one_or_none()
                )
                if existing is not None:
                    continue
                session.add(
                    KnowledgePoint(
                        extraction_job_id=job.id,
                        document_id=block.document_id,
                        source_block_id=item["source_block_id"],
                        content=item["content"],
                        bloom_level=item["bloom_level"],
                        category=item["category"],
                        eligible_types=item["eligible_types"],
                        selected=False,
                        selectable=False,
                        requires_source_review=not dedupe.entails_source(
                            item["content"], dedupe.semantic_normalize(block.text)
                        ),
                        dedupe_key=key,
                    )
                )
                saved_any = True
            session.commit()
            return saved_any
        except OperationalError as exc:
            session.rollback()
            if _try == 20 or "locked" not in str(exc).lower():
                raise
            time.sleep(0.25)
        finally:
            session.close()
    raise RuntimeError("unreachable")


def _block_normalized(session, block_id: str) -> str:  # type: ignore[no-untyped-def]
    block = session.get(SourceBlock, block_id)
    return dedupe.semantic_normalize(block.text) if block else ""


def _finalize_points(session, job: Job, *, selectable: bool) -> None:  # type: ignore[no-untyped-def]
    """仅任务完整成功时考点 selectable(规格 7.5)。"""
    points = (
        session.query(KnowledgePoint)
        .filter(KnowledgePoint.extraction_job_id == job.id)
        .all()
    )
    for point in points:
        point.selectable = selectable
    session.commit()


def _fail(session, job_id: str, code: str, message: str) -> None:  # type: ignore[no-untyped-def]
    job = session.get(Job, job_id)
    if job is not None:
        job.status = JobStatus.failed
        job.error_code = code
        job.error_message = message
        session.commit()
    events.emit(job_id, "job_failed", error={"code": code, "message": message})


def resume(job_id: str, consent_id: str | None) -> dict[str, str]:
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        assert job is not None
        profile = session.get(AIProfile, job.ai_profile_id)
        if profile is None or profile.deleted_at is not None:
            raise ApiError(409, "AI_JOB_PROFILE_CHANGED",
                           "原任务的 AI 配置已修改或删除。",
                           "改回原配置或创建新任务")
        if profile_service.current_fingerprint(profile) != job.profile_fingerprint:
            raise ApiError(409, "AI_JOB_PROFILE_CHANGED",
                           "原任务的 AI 配置已修改或删除。",
                           "改回原配置或创建新任务")
        if consent_id:
            consent = session.get(DataSharingConsent, consent_id)
            if (
                consent is None
                or consent.revoked_at is not None
                or consent.profile_fingerprint != job.profile_fingerprint
            ):
                raise ApiError(409, "AI_CONSENT_REQUIRED",
                               "需对相同配置重新确认后才能继续。",
                               "查看发送范围并确认")
            job.consent_id = consent_id
            session.commit()
        else:
            consent = session.get(DataSharingConsent, job.consent_id)
            if consent is None or consent.revoked_at is not None:
                raise ApiError(409, "AI_CONSENT_REQUIRED",
                               "原确认已撤销,需重新确认后继续。",
                               "查看发送范围并确认")
        runner.submit(job_id, lambda: run(job_id))
        return {"status": "running"}


    finally:
        session.close()


from app.services.jobs.resume_dispatcher import register  # noqa: E402

register(JobType.extraction, resume)




