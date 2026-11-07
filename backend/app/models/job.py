"""Job 统一模型:ParseJob / ExtractionJob / GenerationJob(规格 7.4、7.7)。"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import (
    JSON,
    DateTime,
    Enum,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.engine import utcnow
from app.models.base import Base, JobStatus, JobType, UnitStatus, new_uuid


class Job(Base):
    __tablename__ = "jobs"
    __table_args__ = (
        Index("ix_jobs_type_status", "job_type", "status"),
        Index("ix_jobs_quiz_record", "quiz_record_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    job_type: Mapped[JobType] = mapped_column(Enum(JobType, native_enum=False))
    status: Mapped[JobStatus] = mapped_column(
        Enum(JobStatus, native_enum=False), default=JobStatus.queued
    )
    # 关联资源:ParseJob 的 document_id;GenerationJob 的 quiz_record_id。
    document_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    quiz_record_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    ai_profile_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    ai_profile_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    base_url_host: Mapped[str | None] = mapped_column(String(256), nullable=True)
    consent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    profile_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    prompt_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    config_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    stage: Mapped[str] = mapped_column(String(64), default="")
    current: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    cancel_requested: Mapped[bool] = mapped_column(default=False)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    logical_calls: Mapped[int] = mapped_column(Integer, default=0)
    http_attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)


class JobEvent(Base):
    __tablename__ = "job_events"
    __table_args__ = (
        UniqueConstraint("job_id", "sequence", name="uq_job_event_sequence"),
        Index("ix_job_events_job", "job_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[str] = mapped_column(String(36), index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(32))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class JobUnit(Base):
    __tablename__ = "job_units"
    __table_args__ = (
        UniqueConstraint("job_id", "unit_key", name="uq_job_unit_key"),
        Index("ix_job_units_job", "job_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[str] = mapped_column(String(36))
    unit_key: Mapped[str] = mapped_column(String(128))
    status: Mapped[UnitStatus] = mapped_column(
        Enum(UnitStatus, native_enum=False), default=UnitStatus.pending
    )
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    payload_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class JobDocument(Base):
    __tablename__ = "job_documents"
    __table_args__ = (
        UniqueConstraint("job_id", "document_id", "ordinal", name="uq_job_document"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[str] = mapped_column(String(36), index=True)
    document_id: Mapped[str] = mapped_column(String(36), index=True)
    ordinal: Mapped[int] = mapped_column(Integer)
