"""导出记录、删除确认与幂等键(规格 7.7、12.4)。"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import (
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
from app.models.base import Base, ExportKind, new_uuid


class Export(Base):
    __tablename__ = "exports"
    __table_args__ = (
        UniqueConstraint("export_batch_id", "kind", name="uq_export_batch_kind"),
        Index("ix_exports_quiz_record", "quiz_record_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    export_batch_id: Mapped[str] = mapped_column(String(36))
    quiz_record_id: Mapped[str] = mapped_column(String(36))
    kind: Mapped[ExportKind] = mapped_column(Enum(ExportKind, native_enum=False))
    stored_name: Mapped[str] = mapped_column(String(64))
    download_name: Mapped[str] = mapped_column(String(256))
    sha256: Mapped[str] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(Integer)
    is_current: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class DeletionConfirmation(Base):
    __tablename__ = "deletion_confirmations"
    __table_args__ = (Index("ix_deletion_resource", "resource_type", "resource_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    token: Mapped[str] = mapped_column(String(64), unique=True)
    resource_type: Mapped[str] = mapped_column(String(32))
    resource_id: Mapped[str] = mapped_column(String(36))
    impact_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime)
    used_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class IdempotencyKey(Base):
    __tablename__ = "idempotency_keys"
    __table_args__ = (
        UniqueConstraint("method", "path", "key", name="uq_idempotency"),
        Index("ix_idempotency_created", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    method: Mapped[str] = mapped_column(String(16))
    path: Mapped[str] = mapped_column(String(256))
    key: Mapped[str] = mapped_column(String(64))
    request_hash: Mapped[str] = mapped_column(String(64))
    response_status: Mapped[int] = mapped_column(Integer)
    response_body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)
