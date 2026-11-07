"""人工复核服务:编辑、通过、驳回、删除、批量通过与补位(规格 11.6、13.5)。"""

from __future__ import annotations

from typing import Any, cast

from sqlalchemy.orm import Session

from app.api.errors import ApiError
from app.db.engine import get_session_factory, utcnow
from app.models import (
    AIProfile,
    DataSharingConsent,
    Job,
    JobStatus,
    JobType,
    KnowledgePoint,
    Question,
    QuizRecord,
    QuizRecordPoint,
    SourceBlock,
)
from app.services import profiles as profile_service
from app.services.generation import allocation
from app.services.generation_job import (
    recompute_quiz_status,
)
from app.services.jobs import runner
from app.services.prompts import PROMPT_VERSION
from app.services.validation import validator


def _get_quiz(session: Session, quiz_record_id: str) -> QuizRecord:
    quiz = cast(QuizRecord, session.get(QuizRecord, quiz_record_id))
    if quiz is None:
        raise ApiError(404, "QUIZ_NOT_FOUND", "试卷不存在。", "返回历史列表")
    return quiz


def question_dto(session: Session, question: Question, *,
                 include_source: bool = True) -> dict[str, Any]:
    dto: dict[str, Any] = {
        "id": question.id,
        "quiz_record_id": question.quiz_record_id,
        "slot_number": question.slot_number,
        "question_type": question.question_type.value,
        "knowledge_point_id": question.knowledge_point_id,
        "stem": question.stem,
        "options": question.options,
        "answer": question.answer,
        "acceptable_answers": question.acceptable_answers,
        "explanation": question.explanation,
        "validation_state": question.validation_state,
        "validation_issues": question.validation_issues,
        "review_state": question.review_state,
        "attempt_count": question.attempt_count,
    }
    if include_source:
        point = (
            session.get(KnowledgePoint, question.knowledge_point_id)
            if question.knowledge_point_id
            else None
        )
        block = (
            session.get(SourceBlock, question.source_block_id)
            if question.source_block_id
            else None
        )
        dto["source"] = (
            {
                "point_content": point.content if point else None,
                "locator_label": block.locator_label if block else None,
                "block_text": block.text if block else None,
                "page_number": block.page_number if block else None,
            }
            if (point or block)
            else None
        )
    return dto


def edit_question(question_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """编辑并重新校验,重置为 unreviewed(规格 11.6、13.5)。"""
    session = get_session_factory()()
    try:
        question = session.get(Question, question_id)
        if question is None:
            raise ApiError(404, "QUESTION_NOT_FOUND", "题目不存在。", "返回复核页")
        quiz = _get_quiz(session, question.quiz_record_id)

        point_id = body.get("knowledge_point_id") or question.knowledge_point_id
        if question.stem is None and not point_id:
            # 空槽位手动填写必须选择本试卷冻结的考点(规格 11.6)
            raise ApiError(422, "KNOWLEDGE_POINT_REQUIRED",
                           "空槽位手动填写必须选择一个考点。",
                           "从试卷考点池中选择")

        point = None
        if point_id:
            frozen = (
                session.query(QuizRecordPoint)
                .filter(
                    QuizRecordPoint.quiz_record_id == quiz.id,
                    QuizRecordPoint.knowledge_point_id == point_id,
                )
                .one_or_none()
            )
            if frozen is None:
                raise ApiError(422, "POINT_NOT_FROZEN",
                               "只能选择本试卷冻结的考点。",
                               "从试卷考点池中选择")
            point = session.get(KnowledgePoint, point_id)

        stem = body.get("stem", question.stem)
        explanation = body.get("explanation", question.explanation)

        qtype = question.question_type.value
        if qtype == "single_choice":
            options = body.get("options", question.options or [])
            answer_content = body.get("answer_content")
            if not answer_content:
                current_options = question.options or []
                idx = allocation.SLOT_PLAN_LETTERS.index(question.answer or "A")
                answer_content = (
                    current_options[idx] if idx < len(current_options) else None
                )
            if not isinstance(options, list) or answer_content is None:
                raise ApiError(422, "EDIT_FIELDS_INVALID",
                               "单选编辑需要 options 和 answer_content。",
                               "补全编辑字段")
            report = validator.validate_single_choice(
                stem=stem, options=options, answer_content=answer_content,
                explanation=explanation,
                point_content=point.content if point else "",
                block_text=_block_text(session, point),
            )
            if report.passed:
                plan = allocation.build_slots(quiz.question_config, quiz.seed)
                slot_plan = next(
                    (p for p in plan if p.slot_number == question.slot_number), None
                )
                letter = slot_plan.answer_letter if slot_plan else "A"
                ordered = _reorder_options(
                    options, answer_content, question.answer or letter
                )
                question.options = ordered
                question.answer = _letter_for(ordered, answer_content)
        elif qtype == "true_false":
            answer = body.get("answer", question.answer)
            plan = allocation.build_slots(quiz.question_config, quiz.seed)
            slot_plan = next(
                (p for p in plan if p.slot_number == question.slot_number), None
            )
            report = validator.validate_true_false(
                stem=stem, answer=answer,
                target_answer=slot_plan.target_answer if slot_plan else None,
                explanation=explanation,
                point_content=point.content if point else "",
                block_text=_block_text(session, point),
            )
            if report.passed:
                question.answer = answer
        else:
            answer = body.get("answer", question.answer)
            acceptable = body.get("acceptable_answers", question.acceptable_answers or [])
            report = validator.validate_fill_blank(
                stem=stem, answer=answer, acceptable_answers=acceptable,
                explanation=explanation,
                point_content=point.content if point else "",
                block_text=_block_text(session, point),
            )
            if report.passed:
                question.answer = answer
                question.acceptable_answers = [a for a in acceptable if a and a.strip()]

        question.stem = stem
        question.explanation = explanation
        if point is not None:
            question.knowledge_point_id = point.id
            question.source_block_id = point.source_block_id
        question.validation_issues = report.all_issues()
        question.validation_state = "passed" if report.passed else "failed"
        question.review_state = "unreviewed"
        question.updated_at = utcnow()
        session.commit()
        recompute_quiz_status(session, quiz.id)
        session.refresh(question)
        return question_dto(session, question)
    finally:
        session.close()


def _block_text(session, point) -> str:  # type: ignore[no-untyped-def]
    if point is None:
        return ""
    block = session.get(SourceBlock, point.source_block_id)
    return block.text if block else ""


def _reorder_options(options: list[str], answer_content: str,
                     current_letter: str | None) -> list[str]:
    """保持当前答案字母:把 answer_content 放到 current_letter 位置。"""
    from app.services.validation.validator import normalize

    others = [o for o in options if normalize(o) != normalize(answer_content)]
    index = allocation.SLOT_PLAN_LETTERS.index(current_letter)
    result: list[str] = []
    rest = list(others)
    for i in range(4):
        if i == index:
            result.append(answer_content)
        else:
            result.append(rest.pop(0) if rest else answer_content)
    return result


def _letter_for(options: list[str], answer_content: str) -> str:
    from app.services.validation.validator import normalize

    for i, opt in enumerate(options):
        if normalize(opt) == normalize(answer_content):
            return allocation.SLOT_PLAN_LETTERS[i]
    return "A"


def review_question(question_id: str, decision: str) -> dict[str, Any]:
    session = get_session_factory()()
    try:
        question = session.get(Question, question_id)
        if question is None:
            raise ApiError(404, "QUESTION_NOT_FOUND", "题目不存在。", "返回复核页")
        if decision not in ("approve", "reject"):
            raise ApiError(422, "REVIEW_DECISION_INVALID",
                           "复核动作只能是 approve 或 reject。", "检查请求")
        if decision == "approve" and question.validation_state != "passed":
            raise ApiError(409, "QUESTION_NOT_PASSED",
                           "只有通过程序校验的题目才能人工通过。",
                           "先修复校验问题")
        question.review_state = "approved" if decision == "approve" else "rejected"
        session.commit()
        recompute_quiz_status(session, question.quiz_record_id)
        session.refresh(question)
        return question_dto(session, question)
    finally:
        session.close()


def delete_question(question_id: str) -> dict[str, Any]:
    """清空生成字段但保留固定槽位行和 ID(规格 13.5)。"""
    session = get_session_factory()()
    try:
        question = session.get(Question, question_id)
        if question is None:
            raise ApiError(404, "QUESTION_NOT_FOUND", "题目不存在。", "返回复核页")
        question.stem = None
        question.options = None
        question.answer = None
        question.acceptable_answers = None
        question.explanation = None
        question.knowledge_point_id = None
        question.source_block_id = None
        question.validation_state = "pending"
        question.validation_issues = []
        question.review_state = "unreviewed"
        question.updated_at = utcnow()
        session.commit()
        recompute_quiz_status(session, question.quiz_record_id)
        session.refresh(question)
        return question_dto(session, question, include_source=False)
    finally:
        session.close()


def bulk_approve(quiz_record_id: str, question_ids: list[str]) -> dict[str, Any]:
    """事务式批量通过:任一不合格则 409 且一个也不修改(规格 13.5)。"""
    session = get_session_factory()()
    try:
        _get_quiz(session, quiz_record_id)
        questions = []
        for question_id in question_ids:
            question = session.get(Question, question_id)
            if (
                question is None
                or question.quiz_record_id != quiz_record_id
                or question.validation_state != "passed"
            ):
                raise ApiError(409, "BULK_REVIEW_INVALID",
                               "存在未通过程序校验的题目,批量通过已取消。",
                               "先处理未通过校验的题目")
            questions.append(question)
        for question in questions:
            question.review_state = "approved"
        session.commit()
        recompute_quiz_status(session, quiz_record_id)
        return {"approved": len(questions)}
    except ApiError:
        session.rollback()
        raise
    finally:
        session.close()


def _new_generation_job(
    session: Session,
    quiz: QuizRecord,
    profile: AIProfile,
    consent: DataSharingConsent,
    *,
    question_ids: list[str] | None,
    mode: str,
) -> Job:
    job = Job(
        job_type=JobType.generation,
        quiz_record_id=quiz.id,
        ai_profile_id=profile.id,
        ai_profile_name=profile.name,
        base_url_host=quiz.base_url_host,
        consent_id=consent.id,
        profile_fingerprint=quiz.profile_fingerprint,
        model_name=profile.model,
        prompt_version=PROMPT_VERSION,
        seed=quiz.seed,
        config_snapshot={
            "document_ids": _quiz_document_ids(session, quiz.id),
            "question_config": quiz.question_config,
            "seed": quiz.seed,
            "mode": mode,
            "question_ids": question_ids,
        },
        total=len(question_ids) if question_ids else 0,
    )
    session.add(job)
    return job


def _quiz_document_ids(session, quiz_record_id: str) -> list[str]:  # type: ignore[no-untyped-def]
    from app.models import QuizRecordDocument

    return [
        row.document_id
        for row in session.query(QuizRecordDocument)
        .filter(QuizRecordDocument.quiz_record_id == quiz_record_id)
        .order_by(QuizRecordDocument.ordinal)
        .all()
    ]


def _verify_active_consent(session: Session, quiz: QuizRecord,
                           consent_id: str) -> DataSharingConsent:
    consent = cast(DataSharingConsent, session.get(DataSharingConsent, consent_id))
    if (
        consent is None
        or consent.revoked_at is not None
        or consent.profile_fingerprint != quiz.profile_fingerprint
    ):
        raise ApiError(409, "AI_CONSENT_REQUIRED",
                       "当前 AI 配置尚未获得业务数据发送确认。",
                       "查看发送范围并确认")
    return consent


def regenerate_question(question_id: str, consent_id: str) -> dict[str, str]:
    """保持槽位重新生成:总是新建 GenerationJob(规格 13.5)。"""
    session = get_session_factory()()
    try:
        question = session.get(Question, question_id)
        if question is None:
            raise ApiError(404, "QUESTION_NOT_FOUND", "题目不存在。", "返回复核页")
        quiz = _get_quiz(session, question.quiz_record_id)
        profile = session.get(AIProfile, quiz.ai_profile_id)
        if profile is None or profile.deleted_at is not None:
            raise ApiError(409, "AI_JOB_PROFILE_CHANGED",
                           "原任务的 AI 配置已修改或删除。",
                           "改回原配置或创建新任务")
        if profile_service.current_fingerprint(profile) != quiz.profile_fingerprint:
            raise ApiError(409, "AI_JOB_PROFILE_CHANGED",
                           "原任务的 AI 配置已修改或删除。",
                           "改回原配置或创建新任务")
        consent = _verify_active_consent(session, quiz, consent_id)

        active = (
            session.query(Job)
            .filter(
                Job.quiz_record_id == quiz.id,
                Job.job_type == JobType.generation,
                Job.status.in_([JobStatus.queued, JobStatus.running,
                                JobStatus.interrupted]),
            )
            .first()
        )
        if active:
            raise ApiError(409, "GENERATION_JOB_ACTIVE",
                           "该试卷已有进行中的生成任务。",
                           "等待完成或取消后再试")

        # 清空槽位并回到 unreviewed
        question.stem = None
        question.options = None
        question.answer = None
        question.acceptable_answers = None
        question.explanation = None
        question.knowledge_point_id = None
        question.source_block_id = None
        question.validation_state = "pending"
        question.validation_issues = []
        question.review_state = "unreviewed"

        job = _new_generation_job(session, quiz, profile, consent,
                                  question_ids=[question.id], mode="regenerate")
        session.commit()

        from app.services.generation_job import run as run_generation

        runner.submit(job.id, lambda: run_generation(job.id))
        return {"job_id": job.id, "quiz_record_id": quiz.id}
    finally:
        session.close()


def fill_missing(quiz_record_id: str, consent_id: str) -> dict[str, str]:
    """为缺失槽位创建新任务,重新运行全局匹配(规格 13.5)。"""
    session = get_session_factory()()
    try:
        quiz = _get_quiz(session, quiz_record_id)
        profile = session.get(AIProfile, quiz.ai_profile_id)
        if profile is None or profile.deleted_at is not None:
            raise ApiError(409, "AI_JOB_PROFILE_CHANGED",
                           "原任务的 AI 配置已修改或删除。",
                           "改回原配置或创建新任务")
        if profile_service.current_fingerprint(profile) != quiz.profile_fingerprint:
            raise ApiError(409, "AI_JOB_PROFILE_CHANGED",
                           "原任务的 AI 配置已修改或删除。",
                           "改回原配置或创建新任务")
        consent = _verify_active_consent(session, quiz, consent_id)

        active = (
            session.query(Job)
            .filter(
                Job.quiz_record_id == quiz.id,
                Job.job_type == JobType.generation,
                Job.status.in_([JobStatus.queued, JobStatus.running,
                                JobStatus.interrupted]),
            )
            .first()
        )
        if active:
            raise ApiError(409, "GENERATION_JOB_ACTIVE",
                           "该试卷已有进行中的生成任务。",
                           "等待完成或取消后再试")

        questions = (
            session.query(Question)
            .filter(Question.quiz_record_id == quiz.id)
            .order_by(Question.slot_number)
            .all()
        )
        missing = [
            q for q in questions
            if q.validation_state != "passed" or not q.stem
        ]
        if not missing:
            raise ApiError(409, "NO_MISSING_SLOTS", "当前没有缺失槽位。",
                           "返回复核页")
        job = _new_generation_job(session, quiz, profile, consent,
                                  question_ids=[q.id for q in missing],
                                  mode="fill_missing")
        session.commit()

        from app.services.generation_job import run as run_generation

        runner.submit(job.id, lambda: run_generation(job.id))
        return {"job_id": job.id, "quiz_record_id": quiz.id}
    finally:
        session.close()
