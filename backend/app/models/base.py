"""ORM 基类与统一枚举。"""

from __future__ import annotations

import enum
import uuid

from sqlalchemy.orm import DeclarativeBase, Mapped


def new_uuid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


class MediaType(enum.StrEnum):
    pdf = "pdf"
    docx = "docx"


class ParseStatus(enum.StrEnum):
    pending = "pending"
    running = "running"
    ready = "ready"
    failed = "failed"


class JobType(enum.StrEnum):
    parse = "parse"
    extraction = "extraction"
    generation = "generation"


class JobStatus(enum.StrEnum):
    queued = "queued"
    running = "running"
    completed = "completed"
    partial = "partial"
    failed = "failed"
    cancelled = "cancelled"
    interrupted = "interrupted"


class UnitStatus(enum.StrEnum):
    pending = "pending"
    running = "running"
    done = "done"
    failed = "failed"


class ApiMode(enum.StrEnum):
    chat_completions = "chat_completions"
    responses = "responses"


class CapabilityState(enum.StrEnum):
    supported = "supported"
    unsupported = "unsupported"
    not_tested = "not_tested"
    unknown = "unknown"


class BloomLevel(enum.StrEnum):
    remember = "remember"
    understand = "understand"
    apply = "apply"
    analyze = "analyze"


class QuestionType(enum.StrEnum):
    single_choice = "single_choice"
    true_false = "true_false"
    fill_blank = "fill_blank"


class ValidationState(enum.StrEnum):
    pending = "pending"
    passed = "passed"
    failed = "failed"


class ReviewState(enum.StrEnum):
    unreviewed = "unreviewed"
    approved = "approved"
    rejected = "rejected"


class QuizStatus(enum.StrEnum):
    draft = "draft"
    ready = "ready"
    exported = "exported"


class ExportKind(enum.StrEnum):
    student = "student"
    answer = "answer"


class DeletionResourceType(enum.StrEnum):
    document = "document"
    quiz_record = "quiz_record"
    ai_profile = "ai_profile"


class UuidPk(Mapped[str]):
    """类型别名:36 字符 UUID 主键。"""
