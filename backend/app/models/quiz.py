"""KnowledgePoint、QuizRecord、Question 与冻结关联表(规格 7.5–7.7)。"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import (
    JSON,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.engine import utcnow
from app.models.base import Base, QuestionType, QuizStatus, new_uuid


class KnowledgePoint(Base):
    __tablename__ = "knowledge_points"
    __table_args__ = (
        UniqueConstraint(
            "extraction_job_id", "source_block_id", "dedupe_key", name="uq_kp_dedupe"
        ),
        Index("ix_kp_document", "document_id"),
        Index("ix_kp_extraction", "extraction_job_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    extraction_job_id: Mapped[str] = mapped_column(String(36))
    document_id: Mapped[str] = mapped_column(String(36))
    source_block_id: Mapped[str] = mapped_column(String(36), index=True)
    content: Mapped[str] = mapped_column(Text)
    bloom_level: Mapped[str] = mapped_column(String(16))
    category: Mapped[str] = mapped_column(String(64))
    eligible_types: Mapped[list[Any]] = mapped_column(JSON, nullable=False, default=list)
    selected: Mapped[bool] = mapped_column(default=False)
    selectable: Mapped[bool] = mapped_column(default=False)
    requires_source_review: Mapped[bool] = mapped_column(default=False)
    dedupe_key: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class QuizRecord(Base):
    __tablename__ = "quiz_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    status: Mapped[QuizStatus] = mapped_column(
        Enum(QuizStatus, native_enum=False), default=QuizStatus.draft
    )
    question_config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    ai_profile_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    ai_profile_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    base_url_host: Mapped[str | None] = mapped_column(String(256), nullable=True)
    model_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    prompt_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    seed: Mapped[int] = mapped_column(Integer)
    consent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    profile_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Question(Base):
    __tablename__ = "questions"
    __table_args__ = (
        UniqueConstraint("quiz_record_id", "slot_number", name="uq_question_slot"),
        Index("ix_questions_quiz", "quiz_record_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    quiz_record_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("quiz_records.id", ondelete="CASCADE")
    )
    slot_number: Mapped[int] = mapped_column(Integer)
    question_type: Mapped[QuestionType] = mapped_column(Enum(QuestionType, native_enum=False))
    knowledge_point_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    stem: Mapped[str | None] = mapped_column(Text, nullable=True)
    options: Mapped[list[Any] | None] = mapped_column(JSON, nullable=True)
    answer: Mapped[str | None] = mapped_column(Text, nullable=True)
    acceptable_answers: Mapped[list[Any] | None] = mapped_column(JSON, nullable=True)
    explanation: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_block_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    validation_state: Mapped[str] = mapped_column(String(16), default="pending")
    validation_issues: Mapped[list[Any]] = mapped_column(JSON, nullable=False, default=list)
    review_state: Mapped[str] = mapped_column(String(16), default="unreviewed")
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class QuizRecordDocument(Base):
    __tablename__ = "quiz_record_documents"
    __table_args__ = (
        UniqueConstraint("quiz_record_id", "document_id", "ordinal", name="uq_qrd"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    quiz_record_id: Mapped[str] = mapped_column(String(36), index=True)
    document_id: Mapped[str] = mapped_column(String(36), index=True)
    ordinal: Mapped[int] = mapped_column(Integer)


class QuizRecordPoint(Base):
    __tablename__ = "quiz_record_points"
    __table_args__ = (
        UniqueConstraint("quiz_record_id", "knowledge_point_id", name="uq_qrp"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    quiz_record_id: Mapped[str] = mapped_column(String(36), index=True)
    knowledge_point_id: Mapped[str] = mapped_column(String(36), index=True)
    selection_order: Mapped[int] = mapped_column(Integer)
