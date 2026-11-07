"""Document 与 SourceBlock(规格 7.1、7.2)。"""

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
from app.models.base import Base, MediaType, ParseStatus, new_uuid


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    original_name: Mapped[str] = mapped_column(String(512))
    stored_name: Mapped[str] = mapped_column(String(64))
    media_type: Mapped[MediaType] = mapped_column(Enum(MediaType, native_enum=False))
    sha256: Mapped[str] = mapped_column(String(64))
    size_bytes: Mapped[int] = mapped_column(Integer)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    block_count: Mapped[int] = mapped_column(Integer, default=0)
    parse_status: Mapped[ParseStatus] = mapped_column(
        Enum(ParseStatus, native_enum=False), default=ParseStatus.pending
    )
    parse_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    parser_version: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=utcnow)


class SourceBlock(Base):
    __tablename__ = "source_blocks"
    __table_args__ = (
        UniqueConstraint("document_id", "ordinal", name="uq_source_block_doc_ordinal"),
        Index("ix_source_blocks_document", "document_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    document_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer)
    locator_kind: Mapped[str] = mapped_column(String(32))
    locator_label: Mapped[str] = mapped_column(String(512))
    page_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    heading_path: Mapped[list[Any] | None] = mapped_column(JSON, nullable=True)
    paragraph_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    text: Mapped[str] = mapped_column(Text)
    normalized_text: Mapped[str] = mapped_column(Text)
    estimated_tokens: Mapped[int] = mapped_column(Integer)
    text_sha256: Mapped[str] = mapped_column(String(64))
