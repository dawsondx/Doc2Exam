"""GenerationJob 执行:固定槽位、分配、生成、有界重试与补位(规格 10、12.3)。

- QuizRecord + QuestionSlot 先于 AI 建立;题型不可被 AI 改写。
- 每槽位最多 5 个 logical call:首次 + 2 次修复 + 换考点 + 最后重试(规格 10.6)。
- 并发完成顺序不改变 slot_number;取消/恢复具备幂等保护。
- Mock AI(测试模式)按考点确定性生成题目,不访问网络。
"""

from __future__ import annotations

import asyncio
import logging
import random

from sqlalchemy.orm import Session

from app import config
from app.api.errors import ApiError
from app.db.engine import get_session_factory
from app.models import (
    AIProfile,
    DataSharingConsent,
    Document,
    Job,
    JobStatus,
    JobType,
    KnowledgePoint,
    Question,
    QuestionType,
    QuizRecord,
    QuizRecordDocument,
    QuizRecordPoint,
    QuizStatus,
    SourceBlock,
    UnitStatus,
)
from app.schemas.ai_dtos import (
    FillBlankDraft,
    SingleChoiceDraft,
    TrueFalseDraft,
)
from app.services import credentials, prompts
from app.services import profiles as profile_service
from app.services.ai_adapter.client import AIClient, structured_call
from app.services.generation import allocation
from app.services.jobs import events, runner
from app.services.profiles import mock_ai_enabled
from app.services.validation import validator

logger = logging.getLogger("ai_quiz")

QUESTION_TYPE_VALUES = ("single_choice", "true_false", "fill_blank")


class GenerationError(ApiError):
    pass


def _validate_question_config(question_config: dict[str, int]) -> int:
    total = 0
    for key in QUESTION_TYPE_VALUES:
        value = question_config.get(key, 0)
        if not isinstance(value, int) or not 0 <= value <= 100:
            raise ApiError(422, "INVALID_QUESTION_CONFIG",
                           "三种题型数量都必须是 0–100 的整数。", "调整题型数量")
        total += value
    if not 1 <= total <= 200:
        raise ApiError(422, "INVALID_QUESTION_CONFIG",
                       "总题数必须在 1–200 之间。", "调整题型数量")
    return total


def _selected_points(session, point_ids: list[str]) -> list[KnowledgePoint]:  # type: ignore[no-untyped-def]
    points: list[KnowledgePoint] = []
    for point_id in point_ids:
        point = session.get(KnowledgePoint, point_id)
        if point is None:
            raise ApiError(404, "POINT_NOT_FOUND", "所选考点不存在。", "返回考点选择")
        if not point.selectable:
            raise ApiError(409, "POINT_NOT_SELECTABLE",
                           "存在未成功任务产出的考点。", "重新抽取考点")
        points.append(point)
    return points


def _verify_matching(
    points: list[KnowledgePoint],
    question_config: dict[str, int],
    seed: int,
) -> dict[int, str]:
    slots = allocation.build_slots(question_config, seed)
    candidates: dict[int, list[str]] = {}
    for slot in slots:
        candidates[slot.slot_number] = [
            p.id for p in points if slot.question_type in (p.eligible_types or [])
        ]
    match = allocation.bipartite_match(
        [s.slot_number for s in slots], candidates, seed
    )
    if match is None:
        raise ApiError(
            409,
            "INSUFFICIENT_POINT_MATCHING",
            "当前考点无法一对一覆盖全部题型槽位。",
            "增选兼容题型的考点",
        )
    return match


def create_generation_job(
    *,
    document_ids: list[str],
    selected_point_ids: list[str],
    ai_profile_id: str,
    consent_id: str,
    question_config: dict[str, int],
    seed: int | None = None,
) -> dict[str, str]:
    """创建 QuizRecord、固定槽位和 GenerationJob(规格 10.1、10.2)。"""
    total = _validate_question_config(question_config)
    if len(selected_point_ids) < total:
        raise ApiError(409, "INSUFFICIENT_POINTS",
                       "所选考点不足以覆盖题型配置。", "增选考点或减少题数")

    session = get_session_factory()()
    try:
        profile = session.get(AIProfile, ai_profile_id)
        if profile is None or profile.deleted_at is not None:
            raise ApiError(404, "PROFILE_NOT_FOUND", "AI 配置不存在。", "返回配置列表")
        if not profile_service.compatible(profile):
            raise ApiError(409, "AI_NOT_COMPATIBLE",
                           "AI 配置最近一次测试不兼容。", "先测试连接")
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

        points = _selected_points(session, selected_point_ids)
        if seed is None:
            seed = random.randint(0, 2**31 - 1)

        _verify_matching(points, question_config, seed)

        quiz = QuizRecord(
            question_config=question_config,
            ai_profile_id=ai_profile_id,
            ai_profile_name=profile.name,
            base_url_host=profile.base_url.split("//")[-1].split("/")[0],
            model_name=profile.model,
            prompt_version=prompts.PROMPT_VERSION,
            seed=seed,
            consent_id=consent_id,
            profile_fingerprint=fingerprint,
        )
        session.add(quiz)
        session.flush()

        for order, document_id in enumerate(document_ids, start=1):
            document = session.get(Document, document_id)
            if document is None:
                raise ApiError(404, "DOCUMENT_NOT_FOUND", "文档不存在。", "返回文档列表")
            session.add(
                QuizRecordDocument(
                    quiz_record_id=quiz.id, document_id=document_id, ordinal=order
                )
            )
        for order, point in enumerate(points, start=1):
            session.add(
                QuizRecordPoint(
                    quiz_record_id=quiz.id,
                    knowledge_point_id=point.id,
                    selection_order=order,
                )
            )

        slot_plans = allocation.build_slots(question_config, seed)
        for plan in slot_plans:
            session.add(
                Question(
                    quiz_record_id=quiz.id,
                    slot_number=plan.slot_number,
                    question_type=QuestionType(plan.question_type),
                    answer=plan.answer_letter if plan.question_type == "single_choice" else None,
                )
            )

        # 同一 QuizRecord 同时只能有一个活动 GenerationJob
        active = (
            session.query(Job)
            .filter(
                Job.job_type == JobType.generation,
                Job.quiz_record_id == quiz.id,
                Job.status.in_([JobStatus.queued, JobStatus.running, JobStatus.interrupted]),
            )
            .first()
        )
        if active:
            raise ApiError(409, "GENERATION_JOB_ACTIVE",
                           "该试卷已有进行中的生成任务。", "等待完成或取消后再试")

        job = Job(
            job_type=JobType.generation,
            quiz_record_id=quiz.id,
            ai_profile_id=ai_profile_id,
            ai_profile_name=profile.name,
            base_url_host=quiz.base_url_host,
            consent_id=consent_id,
            profile_fingerprint=fingerprint,
            model_name=profile.model,
            prompt_version=prompts.PROMPT_VERSION,
            config_snapshot={
                "document_ids": document_ids,
                "question_config": question_config,
                "seed": seed,
                "mode": "full",
            },
            seed=seed,
            total=len(slot_plans),
        )
        session.add(job)
        session.commit()
        return {"job_id": job.id, "quiz_record_id": quiz.id}
    finally:
        session.close()


def recompute_quiz_status(session, quiz_record_id: str) -> None:  # type: ignore[no-untyped-def]
    """draft/ready/exported 状态迁移(规格 13.6)。"""
    from app.models import Export

    quiz = session.get(QuizRecord, quiz_record_id)
    if quiz is None:
        return
    questions = (
        session.query(Question)
        .filter(Question.quiz_record_id == quiz_record_id)
        .order_by(Question.slot_number)
        .all()
    )
    config_total = sum(quiz.question_config.get(k, 0) for k in QUESTION_TYPE_VALUES)
    complete = (
        len(questions) == config_total
        and all(
            q.validation_state == "passed" and q.review_state == "approved"
            for q in questions
        )
    )
    if complete:
        quiz.status = (
            QuizStatus.ready if quiz.status != QuizStatus.exported else QuizStatus.exported
        )
    else:
        if quiz.status == QuizStatus.exported:
            session.query(Export).filter(
                Export.quiz_record_id == quiz_record_id
            ).update({"is_current": False}, synchronize_session=False)
        quiz.status = QuizStatus.draft
    session.commit()


async def run(job_id: str) -> None:
    runner.begin(job_id)
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        assert job is not None
        quiz = session.get(QuizRecord, job.quiz_record_id)
        assert quiz is not None
        seed = quiz.seed

        profile = session.get(AIProfile, job.ai_profile_id)
        if profile is None or profile.deleted_at is not None:
            raise runner.JobFailed("AI_JOB_PROFILE_CHANGED", "AI 配置不存在。")
        fingerprint = job.profile_fingerprint or profile_service.current_fingerprint(profile)

        questions = (
            session.query(Question)
            .filter(Question.quiz_record_id == quiz.id)
            .order_by(Question.slot_number)
            .all()
        )
        frozen_points = (
            session.query(QuizRecordPoint)
            .filter(QuizRecordPoint.quiz_record_id == quiz.id)
            .order_by(QuizRecordPoint.selection_order)
            .all()
        )
        points_by_id = {
            p.id: p
            for p in session.query(KnowledgePoint)
            .filter(
                KnowledgePoint.id.in_([fp.knowledge_point_id for fp in frozen_points])
            )
            .all()
        }

        job.total = len(questions)
        job.stage = "generating"
        session.commit()

        question_ids = [q.id for q in questions]
        used_points = {q.knowledge_point_id for q in questions if q.knowledge_point_id}
        quiz_id = quiz.id
        quiz_config = dict(quiz.question_config)
        profile_id = profile.id
        profile_concurrency = profile.max_concurrency
    finally:
        session.close()

    # 重新运行全局匹配(与创建时同 seed,确定一致)
    slots = allocation.build_slots(quiz_config, seed)
    candidates: dict[int, list[str]] = {}
    for slot in slots:
        candidates[slot.slot_number] = [
            fp_kid
            for fp_kid in points_by_id
            if slot.question_type in (points_by_id[fp_kid].eligible_types or [])
            and fp_kid not in used_points
        ]
    session = get_session_factory()()
    try:
        for q in (
            session.query(Question)
            .filter(Question.quiz_record_id == quiz_id)
            .all()
        ):
            if q.knowledge_point_id:
                candidates.setdefault(q.slot_number, [])
                if q.knowledge_point_id not in candidates[q.slot_number]:
                    candidates[q.slot_number].append(q.knowledge_point_id)
    finally:
        session.close()
    match = allocation.bipartite_match(
        [s.slot_number for s in slots], candidates, seed
    ) or {}

    client = _make_client_by_id(profile_id)
    semaphore = asyncio.Semaphore(max(1, min(8, profile_concurrency)))
    results: dict[str, bool] = {}
    progress = {"done": 0}

    async def _one(question_id: str) -> None:
        async with semaphore:
            ok = await _generate_question(
                job_id, quiz_id, question_id, match, client, fingerprint,
            )
            results[question_id] = ok
            progress["done"] += 1
            _bump_progress(job_id, progress["done"], len(question_ids))

    try:
        await asyncio.gather(*[_one(qid) for qid in question_ids])
    finally:
        await client.close()

    _record_stats(job_id, client)
    missing = sum(1 for ok in results.values() if not ok)
    if missing:
        runner.mark_completed(
            job_id, partial=True,
            message=f"仍有 {missing} 个槽位未完成,可继续补题。",
        )
    else:
        runner.mark_completed(job_id, message="全部题目生成完成。")


def _make_client(profile: AIProfile) -> AIClient:
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


def _fail(session, job_id: str, code: str, message: str) -> None:  # type: ignore[no-untyped-def]
    job = session.get(Job, job_id)
    if job is not None:
        job.status = JobStatus.failed
        job.error_code = code
        job.error_message = message
        session.commit()
    events.emit(job_id, "job_failed", error={"code": code, "message": message})


def _make_client_by_id(profile_id: str) -> AIClient:
    session = get_session_factory()()
    try:
        profile = session.get(AIProfile, profile_id)
        assert profile is not None
        return _make_client(profile)
    finally:
        session.close()


def _bump_progress(job_id: str, done: int, total: int) -> None:
    import time

    from sqlalchemy.exc import OperationalError

    for attempt in range(1, 6):
        session = get_session_factory()()
        try:
            job = session.get(Job, job_id)
            if job is not None:
                job.current = done
                session.commit()
            return
        except OperationalError as exc:
            session.rollback()
            if attempt == 5 or "locked" not in str(exc).lower():
                return
            time.sleep(0.2)
        finally:
            session.close()


def _record_stats(job_id: str, client: AIClient) -> None:
    import time

    from sqlalchemy.exc import OperationalError

    for attempt in range(1, 6):
        session = get_session_factory()()
        try:
            job = session.get(Job, job_id)
            if job is not None:
                job.logical_calls = client.stats.logical_calls
                job.http_attempts = client.stats.http_attempts
                job.input_tokens = client.stats.input_tokens
                job.output_tokens = client.stats.output_tokens
                session.commit()
            return
        except OperationalError as exc:
            session.rollback()
            if attempt == 5 or "locked" not in str(exc).lower():
                return
            time.sleep(0.2)
        finally:
            session.close()


async def _generate_question(
    job_id: str,
    quiz_id: str,
    question_id: str,
    match: dict[int, str],
    client: AIClient,
    fingerprint: str,
) -> bool:
    """单槽位生成:独立 session,5 个 logical call 预算 + 结构化修复(规格 10.6)。"""
    session = get_session_factory()()
    try:
        job = session.get(Job, job_id)
        question = session.get(Question, question_id)
        quiz = session.get(QuizRecord, quiz_id)
        if job is None or question is None or quiz is None:
            return False

        if question.validation_state == "passed":
            return True

        runner.check_cancelled(job_id)
        plan = allocation.build_slots(quiz.question_config, quiz.seed)
        slot_plan = next(
            (p for p in plan if p.slot_number == question.slot_number), None
        )
        if slot_plan is None:
            events.emit(job_id, "question_failed", resource_id=question_id,
                        error={"code": "SLOT_PLAN_MISSING", "message": "槽位计划缺失。"})
            return False

        primary_id = match.get(question.slot_number)
        point = session.get(KnowledgePoint, primary_id) if primary_id else None
        if point is None:
            events.emit(job_id, "question_failed", resource_id=question_id,
                        error={"code": "NO_POINT", "message": "没有可分配的考点。"})
            return False

        used_ids = set(match.values())
        alternates = [
            pid
            for pid in (
                session.query(KnowledgePoint.id)
                .filter(KnowledgePoint.id.in_(_frozen_point_ids(session, quiz_id)))
                .all()
            )
            for pid in [pid[0]]
            if pid != primary_id and pid not in used_ids
            and question.question_type.value in _eligible_types(session, pid)
        ]

        block = session.get(SourceBlock, point.source_block_id)
        block_text = block.text if block else ""
        session.commit()  # 结束读事务,避免跨 AI 调用持有读快照

        repair_errors: str | None = None
        current_point = point
        current_block = block_text

        for call_index in range(1, config.AI_LOGICAL_CALLS_PER_SLOT + 1):
            runner.check_cancelled(job_id)
            _guard(job_id, job.ai_profile_id or "", job.consent_id, fingerprint)

            if call_index == 4 and alternates:
                alternate_id = alternates[0]
                current_point = session.get(KnowledgePoint, alternate_id) or current_point
                alt_block = session.get(SourceBlock, current_point.source_block_id)
                current_block = alt_block.text if alt_block else ""
                repair_errors = None  # 换考点后重新开始
                session.commit()
            elif call_index == 4:
                repair_errors = repair_errors or "请调整题目结构。"

            try:
                draft = await _call_for_type(
                    client, question, slot_plan, current_point, current_block,
                    repair_errors,
                )
            except ApiError as exc:
                if exc.code == "AI_STRUCTURED_OUTPUT_UNSUPPORTED":
                    repair_errors = exc.message
                    continue
                raise

            report = _validate_draft(question, slot_plan, draft, current_point,
                                     current_block)
            if report.passed:
                _save_question(session, question, slot_plan, draft, current_point)
                runner.upsert_unit(job_id, f"slot:{question.id}",
                                   status=UnitStatus.done,
                                   payload_hash=draft.model_dump_json()[:64])
                question.attempt_count += 1
                _commit_with_retry(session)
                recompute_quiz_status(session, quiz_id)
                events.emit(job_id, "question_ready", resource_id=question.id,
                            message=f"第 {question.slot_number} 题已生成。")
                return True
            repair_errors = ";".join(
                f"[{i['severity']}] {i['code']}: {i['message']}" for i in report.all_issues()
            )
            question.attempt_count += 1
            _commit_with_retry(session)

        events.emit(job_id, "question_failed", resource_id=question.id,
                    error={"code": "AI_RETRY_EXHAUSTED",
                           "message": "该槽位在限定次数内未生成成功。"})
        return False
    finally:
        session.close()


def _commit_with_retry(session, *, attempts: int = 10) -> None:  # type: ignore[no-untyped-def]
    import time

    from sqlalchemy.exc import OperationalError

    for attempt in range(1, attempts + 1):
        try:
            session.commit()
            return
        except OperationalError as exc:
            session.rollback()
            if attempt == attempts or "locked" not in str(exc).lower():
                raise
            time.sleep(0.25)


def _frozen_point_ids(session, quiz_id: str) -> list[str]:  # type: ignore[no-untyped-def]
    return [
        row[0]
        for row in session.query(QuizRecordPoint.knowledge_point_id)
        .filter(QuizRecordPoint.quiz_record_id == quiz_id)
        .all()
    ]


def _eligible_types(session: Session, point_id: str) -> list[str]:
    point = session.get(KnowledgePoint, point_id)
    return (point.eligible_types or []) if point else []


def _guard(job_id: str, profile_id: str, consent_id: str | None,
           fingerprint: str) -> None:
    session = get_session_factory()()
    try:
        profile = session.get(AIProfile, profile_id)
        if profile is None or profile.deleted_at is not None:
            raise runner.JobFailed("AI_JOB_PROFILE_CHANGED", "AI 配置已删除。")
        if profile_service.current_fingerprint(profile) != fingerprint:
            raise runner.JobFailed("AI_JOB_PROFILE_CHANGED", "AI 配置已修改。")
        consent = session.get(DataSharingConsent, consent_id)
        if consent is None or consent.revoked_at is not None:
            raise runner.JobCancelled()
    finally:
        session.close()


async def _call_for_type(
    client: AIClient,
    question: Question,
    slot_plan: allocation.SlotPlan,
    point: KnowledgePoint,
    block_text: str,
    repair_errors: str | None,
) -> (
    SingleChoiceDraft | TrueFalseDraft | FillBlankDraft
):
    qtype = question.question_type.value
    user = prompts.generation_user(point.content, block_text,
                                   repair_errors=repair_errors)
    if client.mock:
        client.stats.logical_calls += 1
        return _mock_draft(qtype, slot_plan, point, block_text)
    if qtype == "single_choice":
        return await structured_call(
            client, prompts.single_choice_system(), user, SingleChoiceDraft
        )
    if qtype == "true_false":
        return await structured_call(
            client, prompts.true_false_system(bool(slot_plan.target_answer)), user,
            TrueFalseDraft,
        )
    return await structured_call(client, prompts.fill_blank_system(), user,
                                 FillBlankDraft)


def _mock_draft(qtype: str, slot_plan: allocation.SlotPlan, point: KnowledgePoint,
                block_text: str) -> (
        SingleChoiceDraft | TrueFalseDraft | FillBlankDraft):
    """测试模式:从考点确定性合成可通过结构校验的题目(不访问网络)。"""
    content = point.content.strip()
    if qtype == "single_choice":
        answer = content[:20] if len(content) >= 8 else content.ljust(8, "规定")
        # 干扰项长度与答案接近,避免触发最长/最短 1.8 比例校验
        def _distractor(seed_text: str) -> str:
            target_len = max(6, len(answer))
            base = (seed_text * 3)[:target_len]
            return base.ljust(target_len, "项")

        options = [
            answer, _distractor("其他做法"), _distractor("无关表述"), _distractor("常见误区"),
        ]
        return SingleChoiceDraft(
            stem="根据规定,以下哪一项表述是正确的?",
            options=options,
            answer_content=answer,
            explanation=f"该表述来自原文:{content[:80]}",
        )
    if qtype == "true_false":
        target = "正确" if slot_plan.target_answer else "错误"
        if target == "正确":
            stem = content if len(content) >= 8 else f"规定要求:{content}"
        else:
            stem = (content + "(此说法与原文不符)") if len(content) >= 8 else f"错误说法:{content}"
        return TrueFalseDraft(stem=stem, answer=target,
                              explanation=f"原文表述:{content[:80]}")
    # fill_blank:答案取考点中(归一化后)仅出现一次的前缀,保证挖空后不残留
    from app.services.validation.validator import normalize as _norm

    normalized_content = _norm(content)
    fill_answer: str | None = None
    for n in range(min(8, len(content)), 1, -1):
        candidate = content[:n]
        if normalized_content.count(_norm(candidate)) == 1:
            fill_answer = candidate
            break
    if fill_answer is None:
        for n in range(min(6, len(content)), 1, -1):
            candidate = content[-n:]
            if normalized_content.count(_norm(candidate)) == 1:
                fill_answer = candidate
                break
    if fill_answer is None:
        fill_answer = content[:1]
    stem = content.replace(fill_answer, "____", 1)
    if "____" not in stem:
        stem = f"{content} 的关键内容是 ____。"
    if len(stem) < 8:
        stem = f"{stem}(请填写原文关键内容)"
    if fill_answer not in block_text:
        # 兜底:取考点与原文的共同前缀
        common = ""
        for a, b in zip(content, block_text, strict=False):
            if a == b:
                common += a
            else:
                break
        common_answer = common[:6] or content[:2]
        fill_answer = common_answer
        stem = content.replace(common_answer, "____", 1) if common_answer in content else (
            f"{content} 的关键内容是 ____。"
        )
    return FillBlankDraft(
        stem=stem, answer=fill_answer, acceptable_answers=[],
        explanation=f"原文规定的关键内容:{fill_answer}",
    )


def _validate_draft(question: Question, slot_plan: allocation.SlotPlan,
                    draft: SingleChoiceDraft | TrueFalseDraft | FillBlankDraft,
                    point: KnowledgePoint, block_text: str) -> validator.ValidationReport:
    qtype = question.question_type.value
    if qtype == "single_choice":
        assert isinstance(draft, SingleChoiceDraft)
        return validator.validate_single_choice(
            stem=draft.stem, options=draft.options,
            answer_content=draft.answer_content, explanation=draft.explanation,
            point_content=point.content, block_text=block_text,
        )
    if qtype == "true_false":
        assert isinstance(draft, TrueFalseDraft)
        return validator.validate_true_false(
            stem=draft.stem, answer=draft.answer,
            target_answer=slot_plan.target_answer, explanation=draft.explanation,
            point_content=point.content, block_text=block_text,
        )
    assert isinstance(draft, FillBlankDraft)
    return validator.validate_fill_blank(
        stem=draft.stem, answer=draft.answer,
        acceptable_answers=draft.acceptable_answers, explanation=draft.explanation,
        point_content=point.content, block_text=block_text,
    )


def _save_question(session, question: Question, slot_plan, draft,  # type: ignore[no-untyped-def]
                   point: KnowledgePoint) -> None:
    question.knowledge_point_id = point.id
    question.source_block_id = point.source_block_id
    question.stem = draft.stem
    question.explanation = draft.explanation
    if question.question_type.value == "single_choice":
        question.options = list(draft.options)
        # 程序按预定位置排列选项并计算字母(规格 10.3)
        ordered = _place_answer_at(
            draft.options, draft.answer_content, slot_plan.answer_letter or "A"
        )
        question.options = ordered
        question.answer = slot_plan.answer_letter or "A"
    elif question.question_type.value == "true_false":
        question.answer = draft.answer
    else:
        question.answer = draft.answer
        question.acceptable_answers = [
            a for a in (draft.acceptable_answers or []) if a and a.strip()
        ]
    question.validation_state = "passed"
    question.validation_issues = []
    question.review_state = "unreviewed"


def _place_answer_at(options: list[str], answer_content: str, letter: str) -> list[str]:
    """把答案选项放到预定字母位置,其余保持原序(规格 10.3)。"""
    from app.services.validation.validator import normalize

    others = [o for o in options if normalize(o) != normalize(answer_content)]
    index = allocation.SLOT_PLAN_LETTERS.index(letter)
    result: list[str] = []
    rest = list(others)
    for i in range(4):
        if i == index:
            result.append(answer_content)
        else:
            result.append(rest.pop(0) if rest else answer_content)
    return result


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

register(JobType.generation, resume)




